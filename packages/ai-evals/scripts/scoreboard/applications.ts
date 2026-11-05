import assert from "node:assert/strict";
import type { ApplyJobsInput, ApplyJobsResult } from "@nestor/contracts";
import type { App } from "./app.ts";
import { fields } from "./app.ts";
import type { Job, Need, Result } from "./types.ts";

function ready(app: App, jobs: Job[], r: Result) {
  const applications = jobs.map((j) => ({ job: j.url, ...app.application(j) }));
  r.metrics.applications = applications;
  r.metrics.summary = applications
    .map((a) => `${new URL(a.job).pathname}: ${a.state}`)
    .join("; ");
  assert.ok(
    applications.every((a) => a.state === "ready"),
    `Expected Ready: ${applications.map((a) => `${a.state}: ${a.error ?? ""}`).join("; ")}`,
  );
  assert.equal(
    r.questions.filter((q) => q.profileAnswers).length,
    0,
    "Needs you asked facts already in the profile",
  );
}

export async function standard(app: App, r: Result) {
  await app.mode("Fill in for me");
  const jobs = [];
  for (const site of ["board", "greenhouse"])
    jobs.push(await app.fixture(site, 1));
  const before = app.ctx.sites.submissions().length;
  for (const job of jobs) await app.queue(job);
  await app.settle(jobs);
  assert.equal(
    app.ctx.sites.submissions().length,
    before,
    "Fill mode never sends",
  );
  ready(app, jobs, r);
}

async function replicaAccount(app: App, job: Job) {
  const form = await app.openForm(job);
  app.log("person creates made-up Workday account");
  const manual = form.getByRole("link", {
    name: "Apply Manually",
    exact: true,
  });
  if (await manual.count()) await manual.click();
  const register = form.getByRole("link", {
    name: "Create account",
    exact: true,
  });
  if (await register.count()) await register.click();
  if (await form.getByLabel("Verify password", { exact: false }).count()) {
    await form
      .getByLabel("Email", { exact: false })
      .fill("scoreboard@example.test");
    await form
      .getByLabel("Password", { exact: false })
      .first()
      .fill("Replica-only-52!test");
    await form
      .getByLabel("Verify password", { exact: false })
      .fill("Replica-only-52!test");
    await form.getByRole("checkbox", { name: "I agree", exact: true }).check();
    await form
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await form.locator("#workday-form").waitFor({ timeout: 20000 });
  }
  await (await app.ctx.page).keyboard.press("Escape");
}

async function answerWorkday(app: App, need: Need) {
  let answer: string | null = null;
  if (/postal|zip/i.test(need.prompt)) answer = "10115";
  else if (/hear.*(?:job|role)|how.*(?:find|learn).*job/i.test(need.prompt))
    answer = "Job board";
  else if (/address/i.test(need.prompt)) answer = "12 Example Street";
  else if (/notice/i.test(need.prompt))
    answer =
      need.input === "number"
        ? /month/i.test(need.prompt)
          ? "1"
          : "30"
        : "1 month";
  else if (/sponsor/i.test(need.prompt)) answer = "No";
  else if (/authori[sz]|remote/i.test(need.prompt)) answer = "Yes";
  if (!answer) return false;
  await app.go("Needs you");
  const p = await app.ctx.page;
  await p
    .getByRole("list", { name: "Things needing you" })
    .getByRole("button")
    .filter({ hasText: need.prompt })
    .first()
    .click();
  const pane = p.getByRole("region", { name: "Task details" });
  const remember = pane.getByRole("checkbox", {
    name: /Save this answer|Remember/,
  });
  if (await remember.count()) await remember.uncheck();
  const button = pane.getByRole("button", { name: answer, exact: true });
  const radio = pane.getByRole("radio", { name: answer, exact: true });
  if (await button.count()) await button.click();
  else if (await radio.count()) await radio.check();
  else
    await pane
      .getByRole(need.input === "number" ? "spinbutton" : "textbox")
      .first()
      .fill(answer);
  app.log("person answers synthetic detail", { question: need.prompt, answer });
  await pane
    .getByRole("button", { name: "Save and continue", exact: true })
    .click();
  return true;
}

export async function multistep(app: App, r: Result) {
  await app.mode("Fill in for me");
  const job = await app.fixture("workday", 1);
  const before = app.ctx.sites.submissions().length;
  await app.queue(job);
  let accountHandled = false;
  const answered = new Set<number>();
  const end = Date.now() + app.timeout * 1000;
  while (Date.now() < end) {
    app.capture();
    const a = app.application(job);
    r.metrics.state = a.state;
    const needs = app.read<Need>(
      "SELECT n.* FROM needs_you n JOIN application_needs_you l ON l.task_id=n.id WHERE l.application_id=? AND n.resolved_at IS NULL",
      a.id,
    );
    if (a.state === "needs_you") {
      const ordinary = needs.find((n) =>
        /press.*(?:save|continue|next)|click.*(?:save|continue|next)/i.test(
          n.prompt,
        ),
      );
      if (ordinary)
        throw Error(
          `Ordinary form step handed to the person: ${ordinary.prompt}`,
        );
      if (
        !accountHandled &&
        needs.some(
          (n) =>
            n.kind === "sign_in" || /account|sign.in|log.in/i.test(n.prompt),
        )
      ) {
        await replicaAccount(app, job);
        accountHandled = true;
        r.metrics.personCreatedReplicaAccount = true;
      } else {
        const next = needs.find(
          (n) => n.kind === "question" && !answered.has(n.id),
        );
        if (next && (await answerWorkday(app, next))) answered.add(next.id);
        else if (next || !needs.length) break;
      }
    }
    if (
      ["ready", "failed", "stopped", "uncertain", "submitted"].includes(a.state)
    )
      break;
    await app.ctx.sleep(1000);
  }
  app.capture();
  const finalApplication = app.application(job);
  if (
    ["failed", "stopped", "uncertain", "submitted"].includes(
      finalApplication.state,
    )
  )
    throw Error(
      `Workday ended ${finalApplication.state}: ${finalApplication.error ?? "no detail"}`,
    );
  const form = await app.openForm(job);
  const review = await form.locator('[data-step="3"]').isVisible();
  r.metrics.reviewVisible = review;
  r.metrics.summary = `state=${app.application(job)?.state}; review=${review}; person answers=${answered.size}`;
  assert.equal(
    app.ctx.sites.submissions().length,
    before,
    "Fill mode did not press final Submit",
  );
  assert.equal(review, true, "Workday did not reach its Review step");
  assert.equal(finalApplication.mode, "confirm_before_submit");
}

export async function captcha(app: App, r: Result) {
  await app.mode("Fill in for me");
  const job = await app.fixture("lever", 1);
  await app.queue(job);
  await app.settle([job]);
  app.capture();
  const a = app.application(job);
  const needs = app.read<Need>(
    "SELECT n.* FROM needs_you n JOIN application_needs_you l ON l.task_id=n.id WHERE l.application_id=?",
    a.id,
  );
  const p = await app.ctx.page;
  r.metrics.browserShown = await p
    .getByRole("dialog", { name: "Job Finder browser", exact: true })
    .isVisible();
  r.metrics.captchaItems = needs.filter((n) => n.kind === "captcha").length;
  // We may open the page to measure recovery even if the app failed to show it.
  // browserShown remains the observation made BEFORE that driver action.
  const form = await app.openForm(job);
  app.log("person ticks fake CAPTCHA");
  await form
    .getByRole("checkbox", { name: "I am not a robot", exact: true })
    .check();
  const solved = Date.now();
  await p.keyboard.press("Escape");
  await app.until(
    () => app.application(job)?.state !== "needs_you",
    Math.min(app.timeout, 90),
    "CAPTCHA resumes without Continue",
  );
  r.metrics.resumeSeconds = (Date.now() - solved) / 1000;
  await app.settle([job]);
  r.metrics.summary = `CAPTCHAs=${Number(r.metrics.captchaItems)}; shown=${Boolean(r.metrics.browserShown)}; resume=${Number(r.metrics.resumeSeconds).toFixed(1)}s; ${app.application(job)?.state}`;
  assert.equal(
    r.questions.length,
    1,
    "exactly one Needs you item across the whole CAPTCHA scenario",
  );
  assert.equal(r.metrics.captchaItems, 1, "the item is CAPTCHA");
  assert.equal(
    r.metrics.browserShown,
    true,
    "CAPTCHA browser was shown without the driver opening it",
  );
  ready(app, [job], r);
}

export async function security(app: App, r: Result) {
  await app.mode("Fill in for me");
  const job = await app.fixture("gatekeeper", 1);
  // Start at the actual eight-second interstitial, not its unguarded apply URL.
  const db = new (await import("node:sqlite")).DatabaseSync(
    `${app.ctx.userDataDir}/job-finder.sqlite`,
  );
  try {
    db.prepare("UPDATE jobs SET apply_url=? WHERE id=?").run(
      new URL("gatekeeper/security/1", app.ctx.sites.url).href,
      job.id,
    );
  } finally {
    db.close();
  }
  await app.queue(job);
  await app.settle([job]);
  r.metrics.summary = `state=${app.application(job)?.state}; Needs you=${r.questions.length}; gate=8s`;
  assert.equal(
    r.questions.length,
    0,
    "security interstitial should wait without asking the person",
  );
  ready(app, [job], r);
}

export async function restart(app: App, r: Result) {
  await app.mode("Fill in for me");
  const job = await app.fixture("board", 2);
  await app.queue(job);
  await app.settle([job]);
  assert.equal(
    app.application(job)?.state,
    "ready",
    "precondition: filled form before restart",
  );
  const before = await fields(await app.openForm(job));
  assert.ok(
    before.some((f) => f.name === "email" && f.value === "jamie@example.com"),
  );
  const applicationId = app.application(job).id;
  const t = Date.now();
  app.log("drive restart on same private data");
  await app.ctx.restart();
  r.metrics.restartSeconds = (Date.now() - t) / 1000;
  const form = await app.openForm(job);
  // Opening a lost form may refill asynchronously. Wait for its actual values.
  await app.until(
    async () => JSON.stringify(await fields(form)) === JSON.stringify(before),
    Math.min(app.timeout, 120),
    "same filled fields return after restart",
  );
  const rows = app.read<{ id: number }>(
    "SELECT id FROM applications WHERE job_id=?",
    job.id,
  );
  r.metrics.fieldsCompared = before.length;
  r.metrics.applicationRows = rows.length;
  r.metrics.summary = `${before.length} fields restored; rows=${rows.length}; restart=${Number(r.metrics.restartSeconds).toFixed(1)}s`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, applicationId);
  assert.equal(
    app.ctx.sites.submissions().filter((x) => x.path === "/employer-a/apply/2")
      .length,
    0,
  );
}

export async function batch(app: App, r: Result) {
  await app.mode("Fill in for me");
  const paths: [string, number][] = [
    ["board", 4],
    ["board", 5],
    ["greenhouse", 2],
    ["greenhouse", 3],
    ["lever", 2],
    ["lever", 3],
    ["workday", 2],
    ["workday", 3],
    ["atlas", 100],
    ["ripple", 100],
  ];
  const jobs: Job[] = [];
  for (const [site, id] of paths) jobs.push(await app.fixture(site, id));
  const t = Date.now();
  for (const job of jobs) await app.queue(job);
  r.metrics.queueSeconds = (Date.now() - t) / 1000;
  try {
    await app.settle(jobs, Math.max(app.timeout, 420));
  } catch (error) {
    app.log("batch deadline", String(error));
  }
  const rows = jobs.map((job) => {
    const a = app.application(job);
    const questions = a
      ? app.read<Need>(
          "SELECT n.* FROM needs_you n JOIN application_needs_you l ON l.task_id=n.id WHERE l.application_id=? AND n.resolved_at IS NULL",
          a.id,
        )
      : [];
    const realQuestion =
      a?.state === "needs_you" &&
      questions.length > 0 &&
      questions.every(
        (q) =>
          q.kind !== "question" ||
          (!/press.*(?:continue|save|next)/i.test(q.prompt) &&
            !r.questions.some(
              (observed) => observed.id === q.id && observed.profileAnswers,
            )),
      );
    return {
      url: job.url,
      state: a?.state ?? "missing",
      error: a?.error,
      ready: a?.state === "ready",
      realQuestion,
      unnecessaryHold:
        a?.state === "needs_you" && questions.length > 0 && !realQuestion,
      deadEnd:
        !a ||
        !["ready", "needs_you"].includes(a.state) ||
        (a.state === "needs_you" && questions.length === 0),
    };
  });
  r.metrics.rows = rows;
  r.metrics.deadEnds = rows.filter((a) => a.deadEnd).length;
  r.metrics.unnecessaryHolds = rows.filter((a) => a.unnecessaryHold).length;
  r.metrics.summary = `${rows.filter((a) => a.ready).length} Ready; ${rows.filter((a) => a.realQuestion).length} real questions; ${Number(r.metrics.unnecessaryHolds)} unnecessary holds; ${Number(r.metrics.deadEnds)} dead ends`;
  assert.equal(r.metrics.deadEnds, 0, "batch has failed or stuck applications");
  assert.equal(
    r.metrics.unnecessaryHolds,
    0,
    "batch has unnecessary questions or ordinary step handoffs",
  );
}

export async function send(app: App, r: Result) {
  await app.mode("Send for me");
  const job = await app.fixture("board", 3);
  const receipts = () =>
    app.ctx.sites.submissions().filter((x) => x.path === "/employer-a/apply/3");
  assert.equal(receipts().length, 0);
  await app.queue(job);
  await app.settle([job]);
  const a = app.application(job);
  r.metrics.state = a.state;
  r.metrics.receipts = receipts().length;
  r.metrics.outcome = a.submission_outcome_json
    ? (JSON.parse(a.submission_outcome_json) as unknown)
    : null;
  r.metrics.summary = `state=${a.state}; receipts=${receipts().length}`;
  assert.equal(
    a.state,
    "submitted",
    `Send for me: ${a.state}: ${a.error ?? ""}`,
  );
  assert.ok(
    a.submitted_at && a.submission_outcome_json,
    "the app recorded its confirmed receipt",
  );
  assert.equal(receipts().length, 1);
  // There is intentionally no Retry button after submission. Exercise the same
  // typed preload request used by Apply again, without inventing UI controls.
  app.log("retry submitted job through typed Apply request");
  const p = await app.ctx.page;
  const retried = await p.evaluate((id) => {
    const bridge = window as unknown as {
      nestor: {
        jobFinder: {
          applyJobs(input: ApplyJobsInput): Promise<ApplyJobsResult>;
        };
      };
    };
    return bridge.nestor.jobFinder.applyJobs({ selection: { ids: [id] } });
  }, job.id);
  r.metrics.retry = retried;
  await app.ctx.sleep(3000);
  r.metrics.receiptsAfterRetry = receipts().length;
  r.metrics.summary = `submitted; receipts=${receipts().length}; retry queued=${retried.queued}`;
  assert.equal(retried.queued, 0);
  assert.equal(receipts().length, 1, "retry must not send twice");
  assert.equal(
    app.read("SELECT id FROM applications WHERE job_id=?", job.id).length,
    1,
  );
}
