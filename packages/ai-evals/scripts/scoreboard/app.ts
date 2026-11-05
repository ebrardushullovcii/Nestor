import assert from "node:assert/strict";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Page } from "playwright";
import { markDuplicates, profileAnswer } from "./report.ts";
import type {
  Application,
  Context,
  Job,
  Need,
  Question,
  Result,
} from "./types.ts";

export class App {
  step = "starting";
  active?: Result;
  since = Date.now();
  jobIds: number[] = [];
  private observed = new Map<string, Question>();
  readonly ctx: Context;
  readonly output: string;
  readonly timeout: number;
  constructor(ctx: Context, output: string, timeout: number) {
    this.ctx = ctx;
    this.output = output;
    this.timeout = timeout;
    assert.match(ctx.userDataDir, /[/\\]nestor-verify-/);
    assert.ok(
      ["127.0.0.1", "localhost"].includes(new URL(ctx.sites.url).hostname),
    );
    mkdirSync(path.join(output, "steps"), { recursive: true });
  }
  log(step: string, data?: unknown) {
    this.step = step;
    const line = `${new Date().toISOString()} ${step}${data === undefined ? "" : ` ${JSON.stringify(data)}`}\n`;
    appendFileSync(
      path.join(this.output, "steps", `${this.active?.id ?? "setup"}.log`),
      line,
    );
    this.ctx.note(`scoreboard ${this.active?.id ?? "setup"}: ${step}`);
  }
  read<T extends object>(query: string, ...params: SQLInputValue[]): T[] {
    const db = new DatabaseSync(
      path.join(this.ctx.userDataDir, "job-finder.sqlite"),
      { readOnly: true },
    );
    try {
      return db.prepare(query).all(...params) as unknown as T[];
    } finally {
      db.close();
    }
  }
  async go(screen: string) {
    const p = await this.ctx.page;
    if (
      await p
        .getByRole("dialog", { name: "Job Finder browser", exact: true })
        .count()
    )
      await p.keyboard.press("Escape");
    this.log(`open ${screen}`);
    if (screen === "Needs you") {
      await p.getByRole("button", { name: /^Needs you:/ }).click();
    } else if (screen === "Settings") {
      await this.ctx.click("Settings", { role: "button" });
    } else
      await this.ctx.click(`/^${screen}/`, {
        role: "button",
        within: "Job Finder sidebar destinations",
      });
    await p
      .getByRole("main", { name: screen, exact: true })
      .waitFor({ state: "visible", timeout: 15000 });
  }
  application(job: Job) {
    return this.read<Application>(
      "SELECT * FROM applications WHERE job_id=?",
      job.id,
    )[0];
  }
  begin(result: Result) {
    this.active = result;
    this.since = Date.now();
    this.observed.clear();
    this.jobIds = [];
    this.log("begin");
  }
  capture() {
    const needs = this.read<Need>("SELECT * FROM needs_you ORDER BY id");
    for (const need of needs) {
      const links = this.read<{ application_id: number; job_id: number }>(
        "SELECT n.application_id,a.job_id FROM application_needs_you n JOIN applications a ON a.id=n.application_id WHERE n.task_id=?",
        need.id,
      );
      if (
        need.opened_at < this.since &&
        !links.some((l) => this.jobIds.includes(l.job_id))
      )
        continue;
      if (
        this.jobIds.length &&
        links.length &&
        !links.some((l) => this.jobIds.includes(l.job_id))
      )
        continue;
      const key = `${need.id}:${need.prompt}`;
      if (this.observed.has(key)) continue;
      const fact =
        need.kind === "question"
          ? profileAnswer(need.prompt, need.answer_key, need.country)
          : null;
      const question: Question = {
        id: need.id,
        kind: need.kind,
        text: need.prompt,
        answerKey: need.answer_key,
        country: need.country,
        instance: path.basename(path.dirname(this.ctx.evidenceDir)),
        firstSeenAt: new Date().toISOString(),
        profileAnswers: fact !== null,
        profileFact: fact,
        duplicate: false,
        applicationIds: links.map((l) => l.application_id),
      };
      this.observed.set(key, question);
      this.log("Needs you", question);
    }
    if (this.active)
      this.active.questions = markDuplicates([...this.observed.values()]);
  }
  async until<T>(
    fn: () => T | Promise<T>,
    seconds: number,
    step: string,
  ): Promise<NonNullable<T>> {
    this.log(step);
    const end = Date.now() + seconds * 1000;
    for (;;) {
      this.capture();
      const found = await fn();
      if (found) return found as NonNullable<T>;
      if (Date.now() >= end)
        throw Error(`Timed out after ${seconds}s: ${step}`);
      await this.ctx.sleep(750);
    }
  }
  async mode(mode: "Fill in for me" | "Send for me") {
    await this.go("Settings");
    this.log(`set ${mode}`);
    await this.ctx.click(`/^${mode}/`, { role: "radio" });
    await this.ctx.sleep(350);
  }
  /** Fixed listings, never fabricated successful application state. */
  async fixture(site: string, id: number): Promise<Job> {
    const url = new URL(`${site}/jobs/${id}`, this.ctx.sites.url).href;
    const apply = new URL(
      `${site === "board" ? "employer-a" : site}/apply/${id}`,
      this.ctx.sites.url,
    ).href;
    const html = await fetch(url).then((r) => {
      assert.equal(r.status, 200);
      return r.text();
    });
    const title = html
      .match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&");
    assert.ok(title, `replica listing ${url} has a heading`);
    const baseFacts = html.match(/<p>([^<]+) · ([^<]+) · Posted /);
    const company = (
      baseFacts?.[1] ?? html.match(/<p class="company">([^<]+)<\/p>/)?.[1]
    )?.replace(/&amp;/g, "&");
    const location =
      baseFacts?.[2] ?? html.match(/<p class="job-location">([^<]+)<\/p>/)?.[1];
    assert.ok(
      company && location,
      `replica listing ${url} has company and location`,
    );
    const now = Date.now();
    const db = new DatabaseSync(
      path.join(this.ctx.userDataDir, "job-finder.sqlite"),
    );
    let job: Job;
    try {
      const existing = db
        .prepare("SELECT * FROM jobs WHERE url=?")
        .get(url) as unknown as Job | undefined;
      if (existing) {
        assert.equal(
          db
            .prepare("SELECT count(*) n FROM applications WHERE job_id=?")
            .get(existing.id)?.n,
          0,
          "fixture has no prior application",
        );
        job = db
          .prepare(
            "UPDATE jobs SET stage='shortlisted',stage_at=?,title=?,company=?,location=?,apply_url=? WHERE id=? RETURNING *",
          )
          .get(
            now,
            title,
            company,
            location,
            apply,
            existing.id,
          ) as unknown as Job;
      } else
        job = db
          .prepare(
            "INSERT INTO jobs(stage,stage_at,title,company,location,work_modes,fit_score,found_at,seen_at,source_label,url,apply_url) VALUES('shortlisted',?,?,?,?,3,90,?,?,'Scoreboard fixture',?,?) RETURNING *",
          )
          .get(
            now,
            title,
            company,
            location,
            now,
            now,
            url,
            apply,
          ) as unknown as Job;
      db.prepare(
        "INSERT INTO job_details(job_id,description) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET description=excluded.description",
      ).run(
        job.id,
        html
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " "),
      );
      db.prepare(
        "INSERT INTO resumes(job_id,level,state,updated_at) VALUES(?,'original','ready',?)",
      ).run(job.id, now);
    } finally {
      db.close();
    }
    this.jobIds.push(job.id);
    this.log("seed listing and unapproved Original resume", {
      job: job.id,
      url,
      apply,
    });
    const pane = await this.selectResume(job, false);
    this.log("approve Original resume in app", { job: job.id });
    await pane
      .getByRole("button", { name: "Approve Original", exact: true })
      .click();
    await this.until(
      () =>
        this.read<{ approved_at: number | null }>(
          "SELECT approved_at FROM resumes WHERE job_id=?",
          job.id,
        )[0]?.approved_at,
      30,
      "resume approved",
    );
    return job;
  }
  async selectResume(job: Job, approved: boolean) {
    await this.go("Shortlisted");
    await this.ctx.click(approved ? "/^Approved/" : "/^To review/", {
      role: "button",
      within: "Which shortlisted jobs",
    });
    await this.ctx.fill("Find a shortlisted job", job.company);
    const p = await this.ctx.page;
    const list = p.getByRole("list", {
      name: approved ? "Approved resumes" : "Resumes to review",
      exact: true,
    });
    const row = list.locator(`[data-list-row-id="${job.id}"] [aria-controls]`);
    const pane = p.getByRole("region", {
      name: `Resume for ${job.title}`,
      exact: true,
    });
    await row.click();
    await pane.waitFor({ timeout: 10000 });
    await this.until(
      async () =>
        (await pane.getAttribute("data-job-detail-id")) === String(job.id),
      10,
      "selected resume matches the job",
    );
    return pane;
  }
  async queue(job: Job) {
    const pane = await this.selectResume(job, true);
    this.log("Apply", { job: job.id });
    await pane.getByRole("button", { name: "Apply", exact: true }).click();
    await this.until(() => this.application(job), 20, "application queued");
  }
  async selectApplication(job: Job) {
    await this.go("Applications");
    await this.ctx.fill("Find an application", job.company);
    const p = await this.ctx.page;
    const list = p.getByRole("list", { name: "Applications", exact: true });
    const row = list.locator(`[data-list-row-id="${job.id}"] [aria-controls]`);
    const pane = p.getByRole("region", {
      name: `Application to ${job.company}`,
      exact: true,
    });
    await row.click();
    await pane.waitFor({ timeout: 10000 });
    await this.until(
      async () =>
        (await pane.getAttribute("data-job-detail-id")) === String(job.id),
      10,
      "selected application matches the job",
    );
    return pane;
  }
  async openForm(job: Job): Promise<Page> {
    const pane = await this.selectApplication(job);
    this.log("Open application", { job: job.id });
    await pane
      .getByRole("button", { name: /^(Open application|Review and send)$/ })
      .click();
    const form = await this.until(
      async () => {
        const pages = await this.ctx.browserPages();
        const expected = new URL(job.apply_url);
        const hit = pages.find((p) => {
          try {
            return (
              new URL(p.url).origin === expected.origin &&
              new URL(p.url).pathname === expected.pathname
            );
          } catch {
            return false;
          }
        });
        return hit
          ? this.ctx.pageFor({ page: "browser", url: expected.pathname })
          : null;
      },
      90,
      "kept form opens",
    );
    assert.equal(
      new URL(form.url()).origin,
      new URL(this.ctx.sites.url).origin,
    );
    return form;
  }
  async settle(jobs: Job[], seconds = this.timeout) {
    await this.until(
      () =>
        jobs.every((j) => {
          const a = this.application(j);
          return (
            a &&
            [
              "ready",
              "needs_you",
              "submitted",
              "failed",
              "stopped",
              "uncertain",
            ].includes(a.state)
          );
        }),
      seconds,
      "applications settle",
    );
    this.capture();
    return jobs.map((j) => this.application(j));
  }
}

export async function fields(form: Page) {
  return form.locator("input,select,textarea").evaluateAll((nodes) =>
    nodes.map((node) => {
      const e = node as HTMLInputElement;
      return {
        name: e.name,
        type: e.type,
        value:
          e.type === "file"
            ? [...(e.files ?? [])].map((f) => ({ name: f.name, size: f.size }))
            : e.value,
        checked: e.checked,
      };
    }),
  );
}
