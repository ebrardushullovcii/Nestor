// The combined end-to-end check (#324, #327): everything a person does in Job
// Finder, on one live-AI instance with replica sites only, plus a second
// fresh instance for the student-permit persona.
//
// Run: bin/drive run .claude/skills/verify-nestor/journeys/full-check.mjs [stage]
// stage: setup | search | repeat | list | shortlist | resumes | send | fill | restart
//        | own-send | multiselect | signin | board | chat | all (default all)
//        | batch-prep, then batch (optional scale check, ~10 applications at once)
//        | student, permit-back, student-resumes, more-to-read (a fresh
//          instance: bin/down, bin/up --ai live, then these in order)
// A single stage assumes the earlier ones already ran on this instance.
// Each stage asserts what it stored (rows, replica receipts) and adds what it
// saw to full-check.json in the evidence folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateDir } from "../bin/lib/common.mjs";

const JAMIE = "test-fixtures/job-finder/resume-import-sample.txt";
const LINA = "test-fixtures/job-finder/resume-import-personas/lina-haddad.txt";
// Sent with Send for me: two atlas jobs and the Brindle job that asks
// eligibility questions in Needs you.
const SEND_JOBS = ["atlas/jobs/100", "atlas/jobs/300", "brindle/jobs/50"];
const FILL_JOB = "brindle/jobs/120"; // four steps; the person presses Send
// Any clientnest job asks the on-site days checkbox group; the best fit is used.
const MULTI_JOB = "clientnest/jobs/";
const SOURCES = ["atlas/", "ripple/", "brindle/", "board/", "clientnest/"];
const GATES = [852, 853, 854, 864]; // scale sign-in gates on three hosts
const SCALE_ROWS = 1234;
const SETTLED_APPLICATION = [
  "ready",
  "needs_you",
  "submitted",
  "failed",
  "stopped",
];

export default async function journey(ctx) {
  const stage = ctx.args[0] ?? "all";
  const order = Object.keys(STAGES);
  const run = stage === "all" ? order : [stage];
  const results = {};
  for (const name of run) {
    const step = STAGES[name] ?? EXTRA[name];
    if (!step)
      throw new Error(
        `Unknown stage ${name}; use ${[...order, ...Object.keys(EXTRA)].join(" | ")} | all`,
      );
    ctx.note(`journey full-check: stage ${name}`);
    await closePeek(ctx);
    const started = new Date().toISOString();
    results[name] = await step(ctx, ...ctx.args.slice(1));
    record(ctx, name, {
      started,
      finished: new Date().toISOString(),
      ...results[name],
    });
  }
  return results;
}

// ---- helpers --------------------------------------------------------------

function record(ctx, name, data) {
  const file = path.join(ctx.evidenceDir, "full-check.json");
  const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  all[name] = data;
  writeFileSync(file, JSON.stringify(all, null, 2));
}

// Needs you lives in the window header; the rest are sidebar destinations.
const go = (click, screen) =>
  screen === "Needs you"
    ? click("/^Needs you/", {
        role: "button",
        within: "Notifications and actions",
      })
    : click(`/^${screen}/`, {
        role: "button",
        within: "Job Finder sidebar destinations",
      });

/** The browser peek is a modal over the app; Escape closes it. */
async function closePeek(ctx) {
  const p = await ctx.page;
  if (
    await p
      .getByRole("dialog", { name: "Job Finder browser", exact: true })
      .count()
  )
    await p.keyboard.press("Escape");
}

/** Read-only SQL on the instance's job store, for checks `db` can't express. */
function sql(ctx, query, ...params) {
  const db = new DatabaseSync(path.join(ctx.userDataDir, "job-finder.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

/**
 * A found job by its replica path ("atlas/jobs/100"); a path ending in "/"
 * means the best-fit found job on that site.
 */
const jobByPath = (ctx, sitePath) =>
  sitePath.endsWith("/")
    ? sql(
        ctx,
        "SELECT * FROM jobs WHERE url LIKE ? AND stage='found' ORDER BY fit_score DESC LIMIT 1",
        `%/${sitePath}%`,
      )[0]
    : sql(
        ctx,
        "SELECT * FROM jobs WHERE url LIKE ? ORDER BY id LIMIT 1",
        `%/${sitePath}`,
      )[0];

const appLog = () => {
  const file = path.join(stateDir, "app.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

/** Provider-reported AI usage lines since an ISO time. */
const aiUsageSince = (since, prefix = "") =>
  appLog()
    .split("\n")
    .map((line) => {
      const i = line.indexOf("[AI usage] ");
      if (i < 0) return null;
      try {
        return JSON.parse(line.slice(i + 11));
      } catch {
        return null;
      }
    })
    .filter(
      (u) => u && u.startedAt >= since && (u.purpose ?? "").startsWith(prefix),
    );

const sumUsage = (rows) => ({
  calls: rows.length,
  inputTokens: rows.reduce((s, u) => s + (u.inputTokens ?? 0), 0),
  outputTokens: rows.reduce((s, u) => s + (u.outputTokens ?? 0), 0),
});

/** Wait until fn() returns something truthy; returns it. */
async function until(ctx, fn, seconds, what) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end)
      throw new Error(`Timed out after ${seconds}s: ${what}`);
    await ctx.sleep(1500);
  }
}

/** Turns off the Fit 65+ filter, so low-fit jobs are listed too. */
async function showAllFits(p) {
  const toggle = p.getByRole("button", { name: /^Fit 65\+/ });
  if (
    (await toggle.count()) &&
    (await toggle.getAttribute("aria-pressed")) === "true"
  )
    await toggle.click();
}

async function mainText(ctx) {
  return (await ctx.page).locator("main").innerText();
}

/** Wait while the search panel shows Stop (a search is running). */
async function waitSearchDone(ctx, seconds = 900) {
  const p = await ctx.page;
  const stop = p
    .getByRole("region", { name: "Search", exact: true })
    .getByRole("button", { name: "Stop", exact: true });
  await until(
    ctx,
    async () => (await stop.count()) === 0,
    seconds,
    "search to finish",
  );
}

// ---- stages ---------------------------------------------------------------

const STAGES = {
  async setup(ctx) {
    const { click, fill, press, pick, shot, waitFor, sites, desktopDir } = ctx;
    const p = await ctx.page;
    await waitFor("Guided setup", 30, { role: "heading" });
    await shot("fc-setup-start");
    const importStarted = Date.now();
    // A rerun after a slow import picks up where it is.
    if (
      !(await p
        .getByRole("button", { name: /Basics.*Ready to review/ })
        .count())
    ) {
      pick(path.join(desktopDir, JAMIE));
      await click("/Choose my resume file/");
    }
    // Usually under a minute; one runaway model read can take its full
    // five-minute timeout.
    await waitFor("/Basics.*Ready to review/", 400, { role: "button" });
    const importSeconds = (Date.now() - importStarted) / 1000;
    await click("/Basics.*Ready to review/", { role: "button" });
    await shot("fc-import-basics");
    const basics = await mainText(ctx);
    await click("Save and continue to Work history");
    await shot("fc-import-work-history");
    const workHistory = await mainText(ctx);
    await click("Save and continue to Job targets");
    await shot("fc-targets-before");
    const urls = SOURCES.map((x) => new URL(x, sites.url).href).join("\n");
    await fill("Job site URLs", urls);
    await click("Add and turn on");
    await waitFor(`/^Added and turned on ${SOURCES.length} source/`, 15);
    await fill("Target roles", "Frontend Engineer");
    await press("Enter");
    await fill("Preferred job locations", "Remote");
    await press("Enter");
    await click("I can work in Germany");
    await click("No", { within: "Would you need employer visa sponsorship?" });
    await click("Remote", { role: "checkbox" });
    await waitFor("Everything required is in. You can finish setup.", 10);
    await shot("fc-targets-done");
    const [run] = ctx.db("profile_import_runs", { limit: 1 });
    assert.ok(run, "the import wrote a profile_import_runs row");
    const enabled = sql(ctx, "SELECT url FROM job_sites WHERE enabled = 1");
    assert.equal(enabled.length, SOURCES.length, "every replica source is on");
    await click("Finish setup and find jobs");
    await waitFor("/^(Searching|Checking fit)/", 30).catch(() => {});
    await shot("fc-first-search-running");
    return {
      importSeconds,
      importStatus: run.status,
      basicsHasName: /Jamie Rivers/.test(basics),
      workHistoryRoles: (workHistory.match(/\b(19|20)\d\d\b/g) ?? []).length,
      sources: enabled.map((x) => x.url),
      firstScreen: (await p.locator("h1").first().innerText()).trim(),
    };
  },

  async search(ctx) {
    const { click, fill, shot, waitFor } = ctx;
    const p = await ctx.page;
    // 1. The first search (started by Finish setup) keeps the app usable.
    const samples = [];
    const end = Date.now() + 900_000;
    const stop = p
      .getByRole("region", { name: "Search", exact: true })
      .getByRole("button", { name: "Stop", exact: true });
    let navigated = false;
    while (Date.now() < end && (await stop.count())) {
      const rows = await p
        .getByRole("list", { name: "Found jobs" })
        .getByRole("listitem")
        .count()
        .catch(() => 0);
      samples.push({ at: Date.now(), rows });
      if (!navigated && rows > 0) {
        // Leave and come back mid-search, like a person would.
        const t = Date.now();
        await go(click, "Applications");
        await go(click, "Find jobs");
        navigated = Date.now() - t;
        await shot("fc-search-midway");
      }
      await ctx.sleep(2000);
    }
    await shot("fc-first-search-done");
    const first = sql(
      ctx,
      "SELECT * FROM searches ORDER BY started_at DESC LIMIT 1",
    )[0];
    assert.ok(
      ["done", "stopped"].includes(first?.state),
      `first search finished (${first?.state})`,
    );
    const firstSites = sql(
      ctx,
      "SELECT * FROM search_sources WHERE search_id = ?",
      first.id,
    );
    const found = sql(
      ctx,
      "SELECT count(*) n FROM jobs WHERE stage = 'found'",
    )[0].n;
    const scored = sql(
      ctx,
      "SELECT count(*) n FROM jobs WHERE fit_score >= 0",
    )[0].n;
    const merged = sql(
      ctx,
      "SELECT count(*) n FROM jobs WHERE source_count > 1",
    )[0].n;
    const firstSummary = await p
      .getByRole("region", { name: "Search", exact: true })
      .innerText();

    const fitsBefore = sql(
      ctx,
      "SELECT id, fit_score FROM jobs WHERE stage='found'",
    );
    return {
      first: {
        id: first.id,
        state: first.state,
        added: first.added,
        merged: first.merged,
        scored: first.scored,
      },
      firstSites: firstSites.map(
        ({
          label,
          state,
          cards,
          related,
          unrelated,
          added,
          hidden,
          message,
        }) => ({
          label,
          state,
          cards,
          related,
          unrelated,
          added,
          hidden,
          message,
        }),
      ),
      firstSummary,
      midSearchRoundTripMs: navigated,
      rowsSeenWhileRunning: samples.filter((s) => s.rows > 0).length,
      found,
      scored,
      mergedJobs: merged,
      fitsBefore,
    };
  },

  // A repeat search adds nothing and leaves every fit alone; widening Posted
  // to Any time brings back the jobs the age choice hid.
  async repeat(ctx) {
    const { click, shot } = ctx;
    const p = await ctx.page;
    await go(click, "Find jobs");
    const fits = () =>
      Object.fromEntries(
        sql(ctx, "SELECT id, fit_score FROM jobs WHERE stage='found'").map(
          (j) => [j.id, j.fit_score],
        ),
      );
    const before = fits();
    const ageHidden = sql(
      ctx,
      "SELECT count(*) n FROM jobs WHERE hide_owner='age_retention'",
    )[0].n;
    const since = new Date().toISOString();
    await click("Search", { role: "button", within: "/^Search$/" });
    await ctx.sleep(1500);
    await waitSearchDone(ctx);
    const repeat = sql(
      ctx,
      "SELECT * FROM searches ORDER BY started_at DESC LIMIT 1",
    )[0];
    const after = fits();
    const changed = Object.keys(before).filter(
      (id) => before[id] !== after[id],
    );
    const repeatCalls = sumUsage(aiUsageSince(since));
    await shot("fc-repeat-search");
    // Widen to Any time.
    await click("Any time", {
      role: "button",
      within: "What to keep by posting date",
    });
    const since2 = new Date().toISOString();
    await click("Search", { role: "button", within: "/^Search$/" });
    await ctx.sleep(1500);
    await waitSearchDone(ctx);
    await until(
      ctx,
      () =>
        sql(
          ctx,
          "SELECT count(*) n FROM jobs WHERE stage='found' AND fit_score < 0",
        )[0].n === 0,
      180,
      "fit for the restored jobs",
    );
    await shot("fc-any-time");
    const restored = sql(
      ctx,
      "SELECT count(*) n FROM jobs WHERE hide_owner='age_retention'",
    )[0].n;
    assert.equal(repeat.added, 0, "an unchanged repeat adds nothing");
    assert.equal(
      changed.length,
      0,
      `an unchanged repeat keeps every fit (${changed.length} changed)`,
    );
    return {
      repeat: {
        added: repeat.added,
        scored: repeat.scored,
        alreadySaved: repeat.already_saved,
        ...repeatCalls,
      },
      ageHiddenBefore: ageHidden,
      ageHiddenAfterAnyTime: restored,
      anyTimeCalls: sumUsage(aiUsageSince(since2)),
      panel: (
        await p.getByRole("region", { name: "Search", exact: true }).innerText()
      ).slice(0, 400),
    };
  },

  // The long list: 1,234 extra rows are a precondition (inserted, not found
  // by search). Proves virtual scrolling, J/K speed, exact Select all, Hide
  // and Undo. The rows are hidden again at the end so later stages see only
  // searched jobs.
  async list(ctx) {
    const { click, fill, shot } = ctx;
    const p = await ctx.page;
    const db = new DatabaseSync(
      path.join(ctx.userDataDir, "job-finder.sqlite"),
    );
    try {
      db.exec("BEGIN");
      const job = db.prepare(
        `INSERT INTO jobs(stage,stage_at,title,company,location,work_modes,fit_score,found_at,seen_at,source_label,url)
         VALUES('found',?,?,'Scale Synthetic','Berlin',1,80,?,?,'Synthetic scale',?) RETURNING id`,
      );
      const detail = db.prepare(
        "INSERT OR IGNORE INTO job_details(job_id,description) VALUES(?,?)",
      );
      const now = Date.now();
      for (let i = 0; i < SCALE_ROWS; i++) {
        const { id } = job.get(
          now,
          `Scale Test Engineer ${String(i).padStart(4, "0")}`,
          now + i,
          now,
          new URL(`scale-only/jobs/${i}`, ctx.sites.url).href,
        );
        detail.run(id, "Synthetic scale-only frontend listing.");
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
    ctx.note(
      `Seeded ${SCALE_ROWS} synthetic rows for list speed only; not found by search.`,
    );
    await p.reload();
    await p.waitForFunction(() => Boolean(window.nestor));
    await go(click, "Find jobs");
    await fill("Filter jobs", "Scale Test");
    await ctx.sleep(800);
    const list = p.getByRole("list", { name: "Found jobs" });
    const scrollBox = (to) =>
      list.evaluate((e, to) => {
        let s = e;
        while (
          s &&
          !(
            s.scrollHeight > s.clientHeight + 2 &&
            getComputedStyle(s).overflowY === "auto"
          )
        )
          s = s.parentElement;
        if (s) s.scrollTop = to === "end" ? s.scrollHeight : 0;
        return {
          rows: e.querySelectorAll("li").length,
          scroll: s?.scrollTop,
          height: s?.scrollHeight,
          text: e.innerText.slice(-200),
        };
      }, to);
    const series = [];
    for (let i = 0; i < 250; i++) {
      const v = await scrollBox("end");
      series.push(v);
      if (v.text.includes(" 0000")) break;
      await ctx.sleep(70);
    }
    await shot("fc-list-bottom");
    await scrollBox("top");
    await ctx.sleep(300);
    await list.getByRole("button").first().click();
    const heading = p
      .getByRole("region", { name: "Job details" })
      .getByRole("heading", { level: 2 });
    await heading.click();
    const keys = [];
    for (const k of ["j", "j", "j", "k", "k", "j", "j", "k"]) {
      const before = await heading.innerText();
      const t = Date.now();
      await p.keyboard.press(k);
      let after = before;
      while (Date.now() - t < 1500 && after === before) {
        after = await heading.innerText();
        if (after === before) await ctx.sleep(5);
      }
      keys.push({
        key: k,
        ms: after !== before ? Date.now() - t : null,
        after,
      });
    }
    await p.getByRole("checkbox", { name: /^Select all/ }).click();
    await ctx.sleep(400);
    await shot("fc-list-select-all");
    const selected = await p
      .getByRole("region", { name: "Found jobs" })
      .innerText();
    const hide = p.getByRole("button", {
      name: new RegExp(`^Hide ${SCALE_ROWS.toLocaleString("en-US")}`),
    });
    const exactHide = await hide.count();
    await hide.click();
    await shot("fc-list-hidden");
    const t = Date.now();
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    await until(
      ctx,
      () =>
        sql(
          ctx,
          "SELECT count(*) n FROM jobs WHERE stage='found' AND source_label='Synthetic scale'",
        )[0].n === SCALE_ROWS,
      20,
      "Undo to restore every row",
    );
    const undoMs = Date.now() - t;
    await shot("fc-list-undo");
    // Hide them for good so the rest of the journey sees only searched jobs.
    await p.getByRole("checkbox", { name: /^Select all/ }).click();
    await ctx.sleep(300);
    await hide.click();
    await fill("Filter jobs", "");
    const domRows = Math.max(...series.map((x) => x.rows));
    assert.ok(series.at(-1).text.includes(" 0000"), "scrolled to the last row");
    assert.equal(exactHide, 1, `Select all offered Hide ${SCALE_ROWS}`);
    return {
      maxDomRows: domRows,
      scrollSteps: series.length,
      keys,
      undoMs,
      selectedText: selected.slice(0, 300),
    };
  },

  async shortlist(ctx) {
    const { click, fill, shot } = ctx;
    const p = await ctx.page;
    await go(click, "Find jobs");
    await showAllFits(p);
    const pick = async (sitePath) => {
      const job = jobByPath(ctx, sitePath);
      assert.ok(job, `search found ${sitePath}`);
      await openFound(ctx, job);
      return job;
    };
    // Shortlist then Undo at once: no resume gets written for it.
    const undoJob = await pick("board/jobs/1");
    const since = new Date().toISOString();
    await click("/^Shortlist/", { role: "button", within: "Job details" });
    const t = Date.now();
    await p.getByRole("button", { name: "Undo", exact: true }).click();
    const undoMs = Date.now() - t;
    await ctx.sleep(2500);
    const undoStage = sql(
      ctx,
      "SELECT stage FROM jobs WHERE id=?",
      undoJob.id,
    )[0].stage;
    const undoResumeCalls = aiUsageSince(since, "resume").length;
    const chosen = [];
    for (const sitePath of [...SEND_JOBS, FILL_JOB, MULTI_JOB]) {
      const job = await pick(sitePath);
      await shot(`fc-before-shortlist-${job.id}`);
      await click("/^Shortlist/", { role: "button", within: "Job details" });
      await ctx.sleep(1200);
      chosen.push(job);
    }
    await fill("Filter jobs", "");
    await go(click, "Shortlisted");
    await shot("fc-shortlisted-writing");
    for (const job of chosen) {
      const row = sql(ctx, "SELECT stage FROM jobs WHERE id=?", job.id)[0];
      assert.ok(
        ["shortlisted", "resume"].includes(row.stage),
        `${job.title} is shortlisted (${row.stage})`,
      );
    }
    assert.equal(undoStage, "found", "the undone job went back to Found jobs");
    return {
      undo: {
        job: undoJob.id,
        ms: undoMs,
        stage: undoStage,
        resumeCalls: undoResumeCalls,
      },
      chosen: chosen.map(
        ({ id, title, company, location, url, fit_score }) => ({
          id,
          title,
          company,
          location,
          url,
          fit_score,
        }),
      ),
    };
  },
};

Object.assign(STAGES, {
  // Every shortlisted job's resume writes at the Profile level. On the first
  // one the person walks every level and saves a PDF of each; then all are
  // approved.
  async resumes(ctx) {
    const { click, fill, shot } = ctx;
    const p = await ctx.page;
    const chosen = shortlisted(ctx);
    await go(click, "Shortlisted");
    await click("/^To review/", {
      role: "button",
      within: "Which shortlisted jobs",
    });
    const t = Date.now();
    await until(
      ctx,
      () =>
        chosen.every((j) =>
          ["ready", "failed"].includes(resumeOf(ctx, j.id)?.state),
        ),
      900,
      "every shortlisted resume to finish writing",
    );
    const writeSeconds = (Date.now() - t) / 1000;
    await shot("fc-resumes-to-review");
    const written = chosen.map((j) => ({
      job: j.id,
      ...pick(resumeOf(ctx, j.id), ["level", "state", "error"]),
    }));
    // Levels, on the first job.
    const levels = await walkLevels(ctx, chosen[0]);
    // Approve all of them.
    for (const j of chosen) {
      await openShortlisted(ctx, j);
      const pane = resumePane(p, j);
      await pane.getByRole("button", { name: "Approve", exact: true }).click();
      await until(
        ctx,
        () => resumeOf(ctx, j.id)?.approved_at,
        20,
        `${j.title} approval`,
      );
    }
    await fill("Find a shortlisted job", "");
    await click("/^Approved/", {
      role: "button",
      within: "Which shortlisted jobs",
    });
    await shot("fc-resumes-approved");
    return { writeSeconds, written, levels };
  },

  // Send for me on two atlas jobs and the Brindle job that asks questions.
  // The default flips to Fill in for me while they run: queued work keeps
  // the mode it was queued with.
  async send(ctx) {
    const { click, shot } = ctx;
    const chosen = shortlisted(ctx).filter((j) =>
      SEND_JOBS.some((s) => j.url.endsWith(`/${s}`)),
    );
    assert.equal(
      chosen.length,
      SEND_JOBS.length,
      "every Send job is shortlisted",
    );
    await setMode(ctx, "Send for me");
    const queued = [];
    for (const job of chosen) {
      queued.push({ job: job.id, url: job.url, at: new Date().toISOString() });
      if (!applicationOf(ctx, job.id)) await applyTo(ctx, job);
    }
    await setMode(ctx, "Fill in for me");
    await go(click, "Applications");
    await shot("fc-send-running");
    const answered = await settleWithAnswers(ctx, chosen, 900);
    await shot("fc-send-settled");
    const apps = chosen.map((j) => applicationOf(ctx, j.id));
    const posts = ctx.sites.submissions();
    const out = chosen.map((j, i) => {
      const a = apps[i];
      const sent = posts.filter(
        (x) =>
          x.path ===
            new URL(j.apply_url ?? j.url).pathname.replace(
              "/jobs/",
              "/apply/",
            ) ||
          (x.path?.endsWith(`/apply/${j.url.split("/").pop()}`) &&
            x.path.includes(new URL(j.url).pathname.split("/")[1])),
      );
      return {
        job: j.id,
        url: j.url,
        mode: a.mode,
        state: a.state,
        error: a.error,
        posts: sent.length,
        usage: sumUsage(aiUsageSince(queued[i].at, "apply")),
      };
    });
    for (const o of out) {
      assert.equal(o.mode, "autonomous_submit", `${o.url} kept Send for me`);
      assert.equal(
        o.state,
        "submitted",
        `${o.url} was sent (${o.state}: ${o.error ?? ""})`,
      );
      assert.equal(o.posts, 1, `${o.url} has exactly one replica receipt`);
    }
    return {
      applications: out,
      answered,
      usage: sumUsage(aiUsageSince(queued[0].at, "apply")),
    };
  },

  // Fill in for me: the form waits for the person's own Send.
  async fill(ctx) {
    const { click, shot } = ctx;
    const job = shortlisted(ctx).find((j) => j.url.endsWith(`/${FILL_JOB}`));
    assert.ok(job, `${FILL_JOB} is shortlisted`);
    await setMode(ctx, "Fill in for me");
    const at = new Date().toISOString();
    const before = ctx.sites.submissions().length;
    if (!applicationOf(ctx, job.id)) await applyTo(ctx, job);
    await go(click, "Applications");
    const answered = await settleWithAnswers(ctx, [job], 900);
    const a = applicationOf(ctx, job.id);
    await go(click, "Needs you");
    await shot("fc-fill-ready-in-needs-you");
    const needsText = await mainText(ctx);
    assert.equal(a.mode, "confirm_before_submit");
    assert.equal(
      a.state,
      "ready",
      `Fill in for me left it ready (${a.state}: ${a.error ?? ""})`,
    );
    assert.equal(
      ctx.sites.submissions().length,
      before,
      "nothing sent before the person's Send",
    );
    const form = await openForm(ctx, job);
    await shot("fc-fill-form", { target: "browser", url: formPath(job) });
    const fields = await formFields(form);
    writeFileSync(
      path.join(ctx.evidenceDir, "fill-before-restart.json"),
      JSON.stringify(
        { job: job.id, fields, aiCalls: aiUsageSince("0").length },
        null,
        2,
      ),
    );
    await ctx.press("Escape");
    return {
      job: job.id,
      state: a.state,
      answered,
      readyListed: /Ready for you to send/.test(needsText),
      seconds: (Date.parse(new Date().toISOString()) - Date.parse(at)) / 1000,
      usage: sumUsage(aiUsageSince(at, "apply")),
      fieldCount: fields.length,
    };
  },

  // Restart on the same data: the Ready form comes back with the same values
  // and files, without asking the model again.
  async restart(ctx) {
    const saved = JSON.parse(
      readFileSync(
        path.join(ctx.evidenceDir, "fill-before-restart.json"),
        "utf8",
      ),
    );
    const job = sql(ctx, "SELECT * FROM jobs WHERE id=?", saved.job)[0];
    const t = Date.now();
    await ctx.restart();
    const restartMs = Date.now() - t;
    await ctx
      .waitFor("/^(Home|Find jobs|Applications|Needs you|Shortlisted)$/", 30, {
        role: "heading",
      })
      .catch(() => {});
    const form = await openForm(ctx, job);
    await ctx.shot("fc-restart-restored", {
      target: "browser",
      url: formPath(job),
    });
    const fields = await formFields(form);
    const aiCalls = aiUsageSince("0").length - saved.aiCalls;
    const diff = fields.filter(
      (f, i) => JSON.stringify(f) !== JSON.stringify(saved.fields[i]),
    );
    await ctx.press("Escape");
    assert.equal(
      diff.length,
      0,
      `every field and file came back (${diff.length} differ)`,
    );
    return {
      restartMs,
      fieldsCompared: fields.length,
      differing: diff,
      aiCallsAfterRestart: aiCalls,
      step: (await form.locator("body").innerText()).slice(0, 300),
    };
  },

  // The person's own Send on the restored form.
  async "own-send"(ctx) {
    const saved = JSON.parse(
      readFileSync(
        path.join(ctx.evidenceDir, "fill-before-restart.json"),
        "utf8",
      ),
    );
    const job = sql(ctx, "SELECT * FROM jobs WHERE id=?", saved.job)[0];
    return personSends(ctx, job, "fc-own-send");
  },

  // A "select all that apply" question goes to Needs you as a checkbox list,
  // and the form gets exactly the ticked days.
  async multiselect(ctx) {
    const job = shortlisted(ctx).find((j) => j.url.includes("/clientnest/"));
    assert.ok(job, "a clientnest job is shortlisted");
    await setMode(ctx, "Fill in for me");
    if (!applicationOf(ctx, job.id)) await applyTo(ctx, job);
    await go(ctx.click, "Applications");
    const answered = await settleWithAnswers(ctx, [job], 900, {
      days: ["Tuesday", "Thursday"],
    });
    const multi = sql(
      ctx,
      "SELECT prompt, input, multiple, answer FROM needs_you WHERE prompt LIKE '%which days%' AND resolved_at IS NOT NULL",
    )[0];
    const a = applicationOf(ctx, job.id);
    assert.equal(
      multi?.multiple,
      1,
      "the on-site days question came to Needs you as a checkbox list",
    );
    assert.equal(
      a.state,
      "ready",
      `filled and waiting (${a.state}: ${a.error ?? ""})`,
    );
    const sent = await personSends(ctx, job, "fc-multi");
    const days = sent.receipt?.fields?.onsiteDays;
    assert.deepEqual(
      [days].flat(),
      ["Tuesday", "Thursday"],
      "the receipt has exactly the ticked days",
    );
    const stored = sql(ctx, "SELECT * FROM form_answers").filter((r) =>
      /on site|onsite/i.test(JSON.stringify(r)),
    );
    return { job: job.id, answered, multi, receiptDays: days, stored, sent };
  },
});

Object.assign(STAGES, {
  // Four sign-in-gated sources on three hosts: Needs you groups them by host,
  // and Sign in to each walks the hosts in the browser.
  async signin(ctx) {
    const { click, fill, shot } = ctx;
    const p = await ctx.page;
    const manifest = await (
      await fetch(new URL("__scale__/manifest", ctx.sites.url))
    ).json();
    const gates = manifest.sources.filter((x) => GATES.includes(x.id));
    assert.equal(
      gates.length,
      GATES.length,
      "the scale manifest lists the gates",
    );
    await go(click, "Profile");
    await click("Job sources", { role: "tab" }).catch(() => {});
    await click("Add sources", { role: "button" });
    await fill("Job site URLs", gates.map((x) => x.url).join("\n"));
    await click("Add and turn on");
    await shot("fc-gates-added");
    await go(click, "Find jobs");
    await click("Search", { role: "button", within: "/^Search$/" });
    await ctx.sleep(1500);
    await waitSearchDone(ctx);
    await go(click, "Needs you");
    await shot("fc-signins-grouped");
    const grouped = await mainText(ctx);
    const hostRows = await p
      .getByRole("button", { name: /^Sign in to / })
      .count();
    // A walk already under way has no Sign in to each button.
    if (
      await p
        .getByRole("button", { name: "Sign in to each", exact: true })
        .count()
    )
      await click("Sign in to each", { role: "button" });
    // Hiding the browser pauses a walk: "Paused at N of M · Continue".
    else if (
      await p.getByRole("button", { name: "Continue", exact: true }).count()
    )
      await click("Continue", { role: "button" });
    const walk = [];
    for (let i = 0; i < 6; i++) {
      const notice = p.locator("[data-browser-walk]");
      await notice.waitFor({ timeout: 15000 }).catch(() => {});
      if (!(await notice.count())) break;
      const address = p.getByRole("textbox", {
        name: "Website address",
        exact: true,
      });
      const addr = await until(
        ctx,
        async () => {
          const value = (await address.count())
            ? await address.inputValue()
            : "";
          return (
            /^https?:\/\//.test(value) &&
            !walk.some((w) => w.addr === value) &&
            value
          );
        },
        30,
        "the next sign-in page to open",
      );
      const page = await ctx.pageFor({
        page: "browser",
        url: new URL(addr).pathname,
      });
      assert.equal(
        new URL(page.url()).hostname.startsWith("127.0.0."),
        true,
        `refusing a non-replica gate: ${page.url()}`,
      );
      await shot(`fc-signin-${i}`, {
        target: "browser",
        url: new URL(addr).pathname,
      });
      await page
        .getByRole("button", { name: "Continue with synthetic session" })
        .click();
      await ctx.sleep(300);
      const label = await notice.innerText();
      await p.getByRole("button", { name: /^Done(, next site)?$/ }).click();
      await ctx.sleep(1500);
      walk.push({
        addr,
        label,
        tabClosed: !(await ctx.browserPages()).some((x) => x.url === addr),
      });
    }
    await ctx.press("Escape");
    await ctx.sleep(4000);
    await go(click, "Needs you");
    await shot("fc-signins-after-walk");
    const sourceNeeds = sql(
      ctx,
      "SELECT s.requested_url FROM source_needs_you s JOIN needs_you n ON n.id = s.task_id WHERE n.resolved_at IS NULL",
    );
    return {
      gates: gates.map((g) => g.url),
      hostRows,
      grouped: grouped.slice(0, 800),
      walk,
      openSourceNeedsAfter: sourceNeeds.length,
    };
  },

  // The Applications board: every stage reachable, a card opens its sheet.
  async board(ctx) {
    const { click, shot } = ctx;
    const p = await ctx.page;
    await go(click, "Applications");
    await click("Board", { role: "button" })
      .catch(() => click("Board", { role: "radio" }))
      .catch(() => {});
    const board = p.getByRole("region", {
      name: "Applications by stage",
      exact: true,
    });
    await board.waitFor({ timeout: 10000 });
    const viewport = await p.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    const columns = await board
      .getByRole("region")
      .evaluateAll((es) => es.map((e) => e.getAttribute("aria-label")));
    const boxes = [];
    for (const name of columns) {
      const col = board.getByRole("region", { name, exact: true });
      await col.scrollIntoViewIfNeeded();
      boxes.push({ name, box: await col.boundingBox() });
    }
    await shot("fc-board");
    assert.equal(
      columns.length,
      7,
      `every stage has a column (${columns.join(", ")})`,
    );
    const sent = sql(
      ctx,
      "SELECT j.title, j.company FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.state='submitted' LIMIT 1",
    )[0];
    await board
      .getByRole("button")
      .filter({ hasText: sent.company })
      .first()
      .click();
    await ctx.sleep(500);
    await shot("fc-board-card-sheet");
    const sheet = await p
      .getByRole("dialog")
      .allInnerTexts()
      .catch(() => []);
    const details = sheet.length
      ? sheet
      : [
          await p
            .getByRole("region", { name: "Application details" })
            .innerText()
            .catch(() => ""),
        ];
    await ctx.press("Escape");
    return {
      viewport,
      columns,
      boxes,
      sheet: details.map((t) => t.slice(0, 600)),
    };
  },

  // The side chat: navigation and reads that must match the screen.
  async chat(ctx) {
    const { click, shot } = ctx;
    const p = await ctx.page;
    const approved = sql(
      ctx,
      "SELECT j.title, j.company FROM jobs j JOIN resumes r ON r.job_id=j.id WHERE r.approved_at IS NOT NULL AND j.stage='resume'",
    );
    const target =
      approved[0] ??
      sql(
        ctx,
        "SELECT j.title, j.company FROM jobs j JOIN resumes r ON r.job_id=j.id LIMIT 1",
      )[0];
    const messages = [
      { text: "Show me my shortlisted jobs", from: "Applications" },
      { text: "How many jobs are shortlisted?" },
      { text: "Show me my shortlisted jobs" },
      {
        text: `Has a resume been written for ${target.title} at ${target.company}?`,
      },
      {
        text: "Where do I change my resume look?",
        from: "Profile",
        unsavedEdit: true,
      },
      { text: "Keep reading the sites my last quick search stopped early on." },
    ];
    if (
      await p
        .getByRole("button", { name: "Open the assistant", exact: true })
        .count()
    )
      await click("Open the assistant", { role: "button" });
    const panel = p.getByRole("complementary", { name: "Assistant" });
    const turns = [];
    for (const [i, m] of messages.entries()) {
      if (m.from) await go(click, m.from);
      let headline = null;
      if (m.unsavedEdit) {
        await click("Basics", { role: "tab" }).catch(() => {});
        headline = await p
          .getByRole("textbox", { name: "Headline", exact: true })
          .inputValue();
        await ctx.fill("Headline", `${headline}, synthetic unsaved edit`);
      }
      const before = await panel.innerText();
      const started = new Date().toISOString();
      await panel
        .getByRole("textbox", { name: "Message the assistant" })
        .fill(m.text);
      await panel.getByRole("button", { name: "Send", exact: true }).click();
      const end = Date.now() + 90_000;
      let text = before;
      let last = "";
      let stable = Date.now();
      while (Date.now() < end) {
        await ctx.sleep(500);
        text = await panel.innerText();
        if (text !== last) {
          last = text;
          stable = Date.now();
        }
        const busy = await panel
          .getByRole("button", { name: /^(Stop|Cancel)/ })
          .count();
        if (!busy && text !== before && Date.now() - stable > 2000) break;
      }
      await shot(`fc-chat-${i}`);
      const screen = (
        await p
          .locator("main")
          .getByRole("heading", { level: 1 })
          .first()
          .innerText()
          .catch(() => "")
      ).trim();
      // Profile saves as you type: put the headline back, or every later
      // resume carries the test edit.
      if (headline !== null) await ctx.fill("Headline", headline);
      turns.push({
        message: m.text,
        screen,
        reply: text.slice(before.length).trim().slice(-900),
        ...sumUsage(aiUsageSince(started, "chat")),
      });
    }
    const counts = sql(
      ctx,
      "SELECT stage, count(*) n FROM jobs WHERE stage IN ('shortlisted','resume') GROUP BY stage",
    );
    return { turns, shortlistedOnScreen: counts };
  },
});

// ---- apply helpers ----------------------------------------------------------

function pick(row, keys) {
  return row ? Object.fromEntries(keys.map((k) => [k, row[k]])) : {};
}

const shortlisted = (ctx) =>
  sql(
    ctx,
    "SELECT j.* FROM jobs j JOIN resumes r ON r.job_id = j.id WHERE j.source_label != 'Synthetic scale' ORDER BY j.id",
  );
const resumeOf = (ctx, id) =>
  sql(ctx, "SELECT * FROM resumes WHERE job_id=?", id)[0];
const applicationOf = (ctx, jobId) =>
  sql(
    ctx,
    "SELECT * FROM applications WHERE job_id=? ORDER BY id DESC LIMIT 1",
    jobId,
  )[0];

// With the test API on, the app saves exports under its own data folder
// instead of asking with a save dialog.
const exportsNow = (ctx) => {
  const dir = path.join(ctx.userDataDir, "exports");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".pdf"))
        .map((f) => ({
          path: path.join(dir, f),
          mtime: statSync(path.join(dir, f)).mtimeMs,
        }))
    : [];
};

/** Pages from the PDF itself; fill (lowest text on each page) when PyMuPDF is installed. */
function pdfFacts(file) {
  const raw = readFileSync(file).toString("latin1");
  const pages = (raw.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  const py = spawnSync("python", ["-c", PDF_FILL, file], { encoding: "utf8" });
  let fill = null;
  try {
    fill = JSON.parse(py.stdout);
  } catch {}
  return { pages, fill };
}
const PDF_FILL = `
import json,sys
import pymupdf
d=pymupdf.open(sys.argv[1])
out=[]
for p in d:
  h=p.rect.height
  ys=[b[3] for b in p.get_text('blocks') if b[4].strip()]
  out.append(round(max(0,min(1,(max(ys or [36])-36)/(h-72))),2))
print(json.dumps(out))`;

async function openShortlisted(ctx, job) {
  const p = await ctx.page;
  await go(ctx.click, "Shortlisted");
  const stage = sql(ctx, "SELECT stage FROM jobs WHERE id=?", job.id)[0].stage;
  await ctx.click(stage === "resume" ? "/^Approved/" : "/^To review/", {
    role: "button",
    within: "Which shortlisted jobs",
  });
  await ctx.fill("Find a shortlisted job", job.company);
  await ctx.sleep(500);
  // Two rows can share a title and company: try each until this job's pane shows.
  const rows = p
    .getByRole("list", {
      name: stage === "resume" ? "Approved resumes" : "Resumes to review",
    })
    .getByRole("button")
    .filter({ hasText: job.title });
  for (let i = 0; i < Math.max(1, await rows.count()); i++) {
    await rows.nth(i).click();
    if (
      await resumePane(p, job)
        .waitFor({ timeout: 3000 })
        .then(
          () => true,
          () => false,
        )
    )
      return;
  }
  throw new Error(`No Shortlisted row opens ${job.title} (${job.id})`);
}

/**
 * Walks one shortlisted job's resume through every level, as the person
 * would, and saves a PDF of each written one with its pages and fill.
 */
async function walkLevels(
  ctx,
  job,
  order = ["Tailored", "Original", "Light", "Aggressive"],
) {
  const p = await ctx.page;
  await openShortlisted(ctx, job);
  const levels = [];
  for (const level of order) {
    const pane = resumePane(p, job);
    if (resumeOf(ctx, job.id).level !== level.toLowerCase()) {
      const since = resumeOf(ctx, job.id).updated_at;
      await pane.getByRole("button", { name: level, exact: true }).click();
      await until(
        ctx,
        () => {
          const r = resumeOf(ctx, job.id);
          return (
            r.level === level.toLowerCase() &&
            r.updated_at > since &&
            ["ready", "failed"].includes(r.state) &&
            r
          );
        },
        600,
        `${level} resume to be written`,
      );
    }
    await ctx.sleep(800);
    await ctx.shot(`fc-resume-${job.id}-${level.toLowerCase()}`);
    // Original sends the imported file as it is: nothing is written, so
    // there is no PDF to make.
    if (level === "Original") {
      const text = await pane.innerText();
      levels.push({
        level,
        state: resumeOf(ctx, job.id).state,
        pdf: null,
        note: text.match(/Original sends.*/)?.[0] ?? null,
      });
      continue;
    }
    const before = exportsNow(ctx);
    await pane.getByRole("button", { name: "PDF", exact: true }).click();
    const file = await until(
      ctx,
      () =>
        exportsNow(ctx).find(
          (f) => f.mtime > (before.find((b) => b.path === f.path)?.mtime ?? 0),
        ),
      60,
      `${level} PDF`,
    );
    await ctx.sleep(500);
    const kept = path.join(
      ctx.evidenceDir,
      `resume-${job.id}-${level.toLowerCase()}.pdf`,
    );
    copyFileSync(file.path, kept);
    levels.push({
      level,
      state: resumeOf(ctx, job.id).state,
      pdf: kept,
      ...pdfFacts(kept),
    });
  }
  return levels;
}

/** Opens exactly this job in Find jobs (rows can share a title and company). */
async function openFound(ctx, job) {
  const p = await ctx.page;
  await ctx.fill("Filter jobs", job.company);
  await ctx.sleep(400);
  const rows = p
    .getByRole("list", { name: "Found jobs" })
    .getByRole("button")
    .filter({ hasText: job.title });
  const pane = p.locator(`[data-job-detail-id="${job.id}"]`);
  for (let i = 0; i < Math.max(1, await rows.count()); i++) {
    await rows.nth(i).click();
    if (
      await pane.waitFor({ timeout: 3000 }).then(
        () => true,
        () => false,
      )
    )
      return;
  }
  throw new Error(`No Found jobs row opens ${job.title} (${job.id})`);
}

/** The resume pane of exactly this job. */
const resumePane = (p, job) =>
  p.locator(`section[data-job-detail-id="${job.id}"]`);

async function setMode(ctx, mode) {
  await ctx.click("/^Settings$/", { role: "button" });
  await ctx.click(`/^${mode}/`, { role: "radio" });
  await ctx.sleep(300);
}

async function applyTo(ctx, job) {
  const p = await ctx.page;
  await openShortlisted(ctx, job);
  await resumePane(p, job)
    .getByRole("button", { name: "Apply", exact: true })
    .click();
  await until(
    ctx,
    () => applicationOf(ctx, job.id),
    20,
    `${job.title} to be queued`,
  );
  await ctx.fill("Find a shortlisted job", "");
}

/** A synthetic person's answers to the questions only they can answer. */
function answerFor(prompt, opts = {}) {
  if (/all that apply|which days/i.test(prompt))
    return opts.days ?? ["Tuesday", "Thursday"];
  if (/select your skills/i.test(prompt)) return ["Communication", "Mentoring"];
  if (/country code/i.test(prompt)) return "+49";
  if (/years of .* experience/i.test(prompt)) return "2";
  if (/sponsor|visa/i.test(prompt)) return "No";
  if (/18|age/i.test(prompt)) return "Yes";
  if (/authori[sz]ed|right to work|eligible|permit/i.test(prompt)) return "Yes";
  if (/relocat/i.test(prompt)) return "No";
  return null;
}

/**
 * Waits until every job's application settles; answers what Needs you asks
 * (once each, with Save this answer for next time left as it is).
 */
async function settleWithAnswers(ctx, jobs, seconds, opts = {}) {
  const p = await ctx.page;
  const answered = [];
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const apps = jobs.map((j) => applicationOf(ctx, j.id));
    if (
      apps.every(
        (a) =>
          a && ["ready", "submitted", "failed", "stopped"].includes(a.state),
      )
    )
      break;
    if (Date.now() > end)
      throw new Error(
        `Applications did not settle: ${apps.map((a) => a?.state).join(", ")}`,
      );
    const open = sql(
      ctx,
      "SELECT * FROM needs_you WHERE resolved_at IS NULL AND kind='question' AND id NOT IN (SELECT task_id FROM source_needs_you)",
    );
    if (apps.some((a) => a?.state === "needs_you") && open.length) {
      await go(ctx.click, "Needs you");
      const items = p
        .getByRole("list", { name: "Things needing you" })
        .getByRole("button");
      const n = await items.count();
      if (!n) {
        await ctx.sleep(1500);
        continue;
      }
      // The row's first line is the question.
      const prompt = (await items.first().innerText()).split("\n")[0].trim();
      await items.first().click();
      const task = p.getByRole("region", { name: "Task details" });
      await task.waitFor({ timeout: 10000 });
      const text = await task.innerText();
      await ctx.shot(`fc-needs-${answered.length}`);
      // "Press X on the site, then continue": the person presses it in the
      // kept form, never a send button, and says so.
      const press = prompt.match(/^Press "?(.+?)"? on the site/);
      if (press) {
        assert.ok(
          !/send|submit|apply/i.test(press[1]),
          `refusing to press a possible send button: ${press[1]}`,
        );
        if (
          !(await task
            .getByRole("button", { name: "Open application", exact: true })
            .count())
        ) {
          // An item whose application has already moved on: nothing to open.
          await task
            .getByRole("button", {
              name: "I pressed it, continue",
              exact: true,
            })
            .click();
          answered.push({
            prompt,
            answer: "stale item: no application to open",
            kind: "press-stale",
            at: new Date().toISOString(),
            text: text.slice(0, 400),
          });
          await ctx.sleep(1500);
          continue;
        }
        await task
          .getByRole("button", { name: "Open application", exact: true })
          .click();
        // The browser shows the application's page; its address names it.
        const address = p.getByRole("textbox", {
          name: "Website address",
          exact: true,
        });
        const form = await until(
          ctx,
          async () => {
            const url = (await address.count())
              ? await address.inputValue()
              : "";
            return (
              /^http:\/\/127\.0\.0\.\d+:\d+\//.test(url) &&
              new URL(url).port === new URL(ctx.sites.url).port &&
              ctx.pageFor({ page: "browser", url: new URL(url).pathname })
            );
          },
          60,
          "the application page",
        );
        // When the kept page was closed, Open refills the form and the
        // browser shows another tab meanwhile (seen 2026-10-29): there is
        // nothing to press, and the refill settles the application.
        const button = form
          .getByRole("button", { name: press[1], exact: true })
          .first();
        const pressed = await button
          .waitFor({ timeout: 10000 })
          .then(() => button.click().then(() => true))
          .catch(() => false);
        await ctx.sleep(500);
        await closePeek(ctx);
        await go(ctx.click, "Needs you");
        const still = items.filter({ hasText: prompt.slice(0, 30) }).first();
        if (await still.count()) {
          await still.click();
          await p
            .getByRole("region", { name: "Task details" })
            .getByRole("button", {
              name: "I pressed it, continue",
              exact: true,
            })
            .click();
        }
        answered.push({
          prompt,
          answer: pressed ? "pressed on the site" : "Open showed another form",
          kind: "press",
          at: new Date().toISOString(),
        });
        await ctx.sleep(1500);
        continue;
      }
      const answer = answerFor(prompt, opts);
      if (answer === null)
        throw new Error(
          `No synthetic answer for: ${prompt}\n${text.slice(0, 500)}`,
        );
      let kind = "text";
      if (Array.isArray(answer)) {
        kind = "multi";
        for (const day of answer)
          await task.getByRole("checkbox", { name: day, exact: true }).check();
      } else if (
        await task.getByRole("button", { name: answer, exact: true }).count()
      ) {
        kind = "yes-no";
        await task.getByRole("button", { name: answer, exact: true }).click();
      } else if (
        await task.getByRole("radio", { name: answer, exact: true }).count()
      ) {
        kind = "choice";
        await task.getByRole("radio", { name: answer, exact: true }).check();
      } else {
        kind = (await task.getByRole("spinbutton").count()) ? "number" : "text";
        await task
          .getByRole(kind === "number" ? "spinbutton" : "textbox")
          .first()
          .fill(answer);
      }
      await ctx.shot(`fc-needs-${answered.length}-answered`);
      await task
        .getByRole("button", { name: "Save and continue", exact: true })
        .click();
      answered.push({
        prompt,
        answer,
        kind,
        at: new Date().toISOString(),
        why: /Why am I asked/.test(text),
      });
      await ctx.sleep(1200);
      continue;
    }
    await ctx.sleep(2500);
  }
  return answered;
}

const formPath = (job) =>
  new URL(job.apply_url ?? job.url).pathname.replace("/jobs/", "/apply/");

/** Opens the application's kept form from Applications and returns its page. */
async function openForm(ctx, job) {
  const p = await ctx.page;
  await go(ctx.click, "Applications");
  const peek = p.getByRole("dialog", {
    name: "Job Finder browser",
    exact: true,
  });
  if (!(await peek.count())) {
    await ctx.fill("Find an application", job.company).catch(() => {});
    await ctx.sleep(500);
    await p
      .getByRole("button")
      .filter({ hasText: job.title })
      .filter({ hasText: job.company })
      .first()
      .click()
      .catch(() => {});
    await ctx.click("/^(Open application|Review and send)$/", {
      role: "button",
    });
  }
  const form = await until(
    ctx,
    async () => {
      const pages = await ctx.browserPages();
      const hit = pages.find(
        (x) =>
          x.url.includes(new URL(ctx.sites.url).host) &&
          /\/apply\//.test(x.url),
      );
      return (
        hit && ctx.pageFor({ page: "browser", url: new URL(hit.url).pathname })
      );
    },
    120,
    "the kept form to open",
  );
  assert.equal(
    new URL(form.url()).origin,
    new URL(ctx.sites.url).origin,
    `refusing a non-replica form: ${form.url()}`,
  );
  await form
    .locator("input,select,textarea")
    .first()
    .waitFor({ state: "attached", timeout: 60000 });
  return form;
}

const formFields = (form) =>
  form.locator("input,select,textarea").evaluateAll((es) =>
    es.map((e) => ({
      name: e.name,
      value:
        e.type === "file"
          ? Array.from(e.files ?? []).map((x) => ({
              name: x.name,
              size: x.size,
            }))
          : e.value,
      checked: e.checked,
    })),
  );

/** The person walks the kept form to its end and presses the site's own Send. */
async function personSends(ctx, job, shotPrefix) {
  const p = await ctx.page;
  const form = await openForm(ctx, job);
  const before = ctx.sites.submissions().length;
  const steps = [];
  for (let i = 0; i < 8; i++) {
    const send = form.getByRole("button", {
      name: /^(Send application|Submit( application)?)$/,
    });
    if (await send.count()) break;
    const next = form.getByRole("button", { name: /^(Next|Continue|Review)/ });
    if (!(await next.count())) break;
    await next.first().click();
    steps.push(i + 1);
    await ctx.sleep(400);
  }
  await ctx.shot(`${shotPrefix}-review`, {
    target: "browser",
    url: formPath(job),
  });
  const started = Date.now();
  await form
    .getByRole("button", { name: /^(Send application|Submit( application)?)$/ })
    .first()
    .click();
  await until(
    ctx,
    () => ctx.sites.submissions().length > before,
    30,
    "the replica receipt",
  );
  await ctx.sleep(1500);
  await ctx.shot(`${shotPrefix}-sent`);
  const toast = await p
    .getByRole("region", { name: "Notifications", exact: true })
    .innerText()
    .catch(() => "");
  await until(
    ctx,
    () => applicationOf(ctx, job.id).state === "submitted",
    60,
    "the application to be stored as sent",
  );
  const receipts = ctx.sites.submissions().slice(before);
  assert.equal(receipts.length, 1, "exactly one replica receipt");
  return {
    job: job.id,
    nextPresses: steps.length,
    sendToReceiptMs: Date.now() - started,
    toast,
    browserPagesAfter: (await ctx.browserPages()).filter((x) =>
      /\/apply\//.test(x.url),
    ).length,
    receipt: receipts[0],
    state: applicationOf(ctx, job.id).state,
  };
}

const EXTRA = {
  // Scale (#325): about ten applications queued at once, half Send for me and
  // half Fill in for me. Every one must settle once, in the right state, with
  // at most one receipt each, while the window keeps answering. Memory (Task
  // Manager's private working set) is sampled before, during and after.
  // Shortlists and approves the batch's jobs (any fit, spread over the
  // sites); `batch` then queues them all at once.
  async "batch-prep"(ctx, size = "10") {
    const { click } = ctx;
    const p = await ctx.page;
    const count = Number(size);
    const taken = new Set(shortlisted(ctx).map((j) => j.id));
    const pool = sql(
      ctx,
      `SELECT * FROM jobs WHERE stage='found' AND source_label != 'Synthetic scale' 
         AND (url LIKE '%/atlas/jobs/%' OR url LIKE '%/ripple/jobs/%' OR url LIKE '%/board/%' OR url LIKE '%/brindle/jobs/%')
       ORDER BY fit_score DESC`,
    ).filter((j) => !taken.has(j.id));
    // Spread over the sites, best fit first.
    const bySite = {};
    for (const j of pool)
      (bySite[new URL(j.url).pathname.split("/")[1]] ??= []).push(j);
    const jobs = [];
    while (jobs.length < count && Object.values(bySite).some((l) => l.length))
      for (const l of Object.values(bySite))
        if (l.length && jobs.length < count) jobs.push(l.shift());
    assert.equal(jobs.length, count, `found ${count} jobs to apply to`);
    await go(click, "Find jobs");
    await showAllFits(p);
    for (const job of jobs) {
      await openFound(ctx, job);
      await click("/^Shortlist/", { role: "button", within: "Job details" });
      await ctx.sleep(600);
    }
    await ctx.fill("Filter jobs", "");
    await until(
      ctx,
      () =>
        jobs.every((j) =>
          ["ready", "failed"].includes(resumeOf(ctx, j.id)?.state),
        ),
      1200,
      "batch resumes",
    );
    for (const j of jobs) {
      if (resumeOf(ctx, j.id).state !== "ready") continue;
      await openShortlisted(ctx, j);
      await resumePane(p, j)
        .getByRole("button", { name: "Approve", exact: true })
        .click();
      await until(ctx, () => resumeOf(ctx, j.id)?.approved_at, 20, "approval");
    }
    await ctx.fill("Find a shortlisted job", "");
    const ready = jobs.filter((j) => resumeOf(ctx, j.id).approved_at);
    writeFileSync(
      path.join(ctx.evidenceDir, "batch-jobs.json"),
      JSON.stringify(ready.map((j) => j.id)),
    );
    return {
      chosen: jobs.map(({ id, title, company, url, fit_score }) => ({
        id,
        title,
        company,
        url,
        fit_score,
      })),
      approved: ready.length,
    };
  },

  async batch(ctx) {
    const { click, shot } = ctx;
    const p = await ctx.page;
    const ids = JSON.parse(
      readFileSync(path.join(ctx.evidenceDir, "batch-jobs.json"), "utf8"),
    );
    const ready = ids.map(
      (id) => sql(ctx, "SELECT * FROM jobs WHERE id=?", id)[0],
    );
    const sendHalf = ready.filter((_, i) => i % 2 === 0);
    const fillHalf = ready.filter((_, i) => i % 2 === 1);
    const { processTreeMemory, sampleApp, countPages } =
      await import("../bin/lib/perf-sample.mjs");
    const pid = () => ctx.app.process().pid;
    const memory = async (label) => ({
      label,
      at: Date.now(),
      ...(await processTreeMemory(pid())),
      pages: (await sampleApp(ctx.app)).pages,
    });
    await countPages(ctx.app);
    const samples = [await memory("idle before")];
    const postsBefore = ctx.sites.submissions().length;
    const queuedAt = new Date().toISOString();
    const t0 = Date.now();
    await setMode(ctx, "Send for me");
    for (const j of sendHalf)
      if (!applicationOf(ctx, j.id)) await applyTo(ctx, j);
    await setMode(ctx, "Fill in for me");
    for (const j of fillHalf)
      if (!applicationOf(ctx, j.id)) await applyTo(ctx, j);
    const queueSeconds = (Date.now() - t0) / 1000;
    // While it runs: switch screens like a person and time each switch.
    const switches = [];
    const answered = [];
    const end = Date.now() + 1800_000;
    let peakPages = 0;
    for (;;) {
      const apps = ready.map((j) => applicationOf(ctx, j.id));
      const running = apps.filter(
        (a) =>
          !["ready", "submitted", "failed", "stopped", "needs_you"].includes(
            a?.state,
          ),
      );
      if (!running.length && !apps.some((a) => a.state === "needs_you")) break;
      if (Date.now() > end) break;
      for (const screen of ["Applications", "Find jobs"]) {
        const t = Date.now();
        await go(click, screen);
        await p
          .getByRole("heading", { level: 1, name: screen })
          .waitFor({ timeout: 10000 })
          .catch(() => {});
        switches.push({ screen, ms: Date.now() - t, at: Date.now() - t0 });
      }
      const s = await memory("during");
      peakPages = Math.max(peakPages, s.pages);
      samples.push(s);
      // Kept as it goes, so a failure later still leaves the timeline.
      writeFileSync(
        path.join(ctx.evidenceDir, "batch-progress.json"),
        JSON.stringify({ samples, switches }, null, 2),
      );
      if (!running.length && apps.some((a) => a.state === "needs_you"))
        answered.push(
          ...(await settleWithAnswers(
            ctx,
            ready.filter((j) => applicationOf(ctx, j.id).state === "needs_you"),
            600,
          )),
        );
      await ctx.sleep(3000);
    }
    const settledSeconds = (Date.now() - t0) / 1000;
    await go(click, "Applications");
    await shot("fc-batch-settled");
    await go(click, "Needs you");
    await shot("fc-batch-needs-you");
    const needsText = await mainText(ctx);
    // After: forms closed (Ready forms stay kept until the person acts).
    await ctx.sleep(60_000);
    samples.push(await memory("60 s after"));
    await ctx.sleep(60_000);
    samples.push(await memory("120 s after"));
    const posts = ctx.sites.submissions().slice(postsBefore);
    const rows = ready.map((j) => {
      const all = sql(ctx, "SELECT * FROM applications WHERE job_id=?", j.id);
      const a = all.at(-1);
      const site = new URL(j.url).pathname.split("/")[1];
      const id = j.url.split("/").pop();
      return {
        job: j.id,
        url: j.url,
        wanted: sendHalf.includes(j)
          ? "autonomous_submit"
          : "confirm_before_submit",
        mode: a.mode,
        state: a.state,
        error: a.error,
        applicationRows: all.length,
        // The replica /board/ hands its applications to /employer-a/.
        posts: posts.filter(
          (x) =>
            x.path?.endsWith(`/apply/${id}`) &&
            (x.path.includes(`/${site}/`) || site === "board"),
        ).length,
      };
    });
    const states = sql(
      ctx,
      "SELECT state, mode, count(*) n FROM applications GROUP BY state, mode",
    );
    const out = {
      queued: ready.length,
      queueSeconds,
      settledSeconds,
      rows,
      answered,
      switches: {
        count: switches.length,
        p95: p95(switches.map((s) => s.ms)),
        max: Math.max(...switches.map((s) => s.ms)),
      },
      peakPages,
      memory: samples,
      peakPrivateMB: Math.max(...samples.map((s) => s.privateWorkingSetMB)),
      needsText: needsText.slice(0, 1500),
      states,
      usage: sumUsage(aiUsageSince(queuedAt, "apply")),
    };
    writeFileSync(
      path.join(ctx.evidenceDir, "batch-results.json"),
      JSON.stringify(out, null, 2),
    );
    for (const r of rows) {
      assert.equal(r.applicationRows, 1, `${r.url} queued once`);
      assert.equal(r.mode, r.wanted, `${r.url} kept its mode`);
      assert.ok(r.posts <= 1, `${r.url} sent at most once`);
    }
    return out;
  },

  // The student-permit persona, on a fresh instance: fit reads the permit's
  // hours, removing the permit re-checks fit, restoring it brings scores back.
  async student(ctx) {
    const { click, fill, press, shot, waitFor } = ctx;
    const p = await ctx.page;
    await waitFor("Guided setup", 30, { role: "heading" });
    // The repo persona plus the explicit permit wording the check needs.
    const resume = path.join(ctx.evidenceDir, "lina-study-permit.txt");
    writeFileSync(
      resume,
      `${readFileSync(path.join(ctx.desktopDir, LINA), "utf8").trimEnd()}\n\nSynthetic test clarification\nCurrent German study permit allows paid work up to 20 hours per week from 1 November 2026 through 30 September 2027. Full-time employment of 40 hours per week is not permitted. Future full-time employment after graduation needs employer sponsorship. I have no unrestricted work authorization in any country.\n`,
    );
    ctx.pick(resume);
    await click("/Choose my resume file/");
    await waitFor("/Basics.*Ready to review/", 120, { role: "button" });
    await click("/Basics.*Ready to review/", { role: "button" });
    await click("Save and continue to Work history");
    await click("Save and continue to Job targets");
    await shot("fc-student-targets");
    const targets = await mainText(ctx);
    await fill("Job site URLs", new URL("permit-fit/", ctx.sites.url).href);
    await click("Add and turn on");
    await fill("Target roles", "Junior Data Analyst");
    await press("Enter");
    await fill("Preferred job locations", "Berlin");
    await press("Enter");
    await click("Hybrid", { role: "checkbox" });
    await click("Finish setup and find jobs");
    await ctx.sleep(2000);
    await waitSearchDone(ctx, 600);
    const scoredAll = () => {
      const rows = sql(ctx, "SELECT * FROM jobs WHERE stage='found'");
      return (
        rows.length &&
        rows.every((j) => j.fit_score >= 0 && !j.fit_stale) &&
        rows
      );
    };
    const baseline = await until(
      ctx,
      scoredAll,
      180,
      "fit for every found job",
    );
    await shot("fc-student-fit");
    const fits = (rows) =>
      Object.fromEntries(
        rows.map((j) => [j.title.split(", ").pop(), j.fit_score]),
      );
    const locations = baseline.map((j) => ({
      title: j.title,
      location: j.location,
    }));
    // Remove the permit.
    await go(click, "Profile");
    await click("Preferences", { role: "tab" }).catch(() => {});
    await shot("fc-student-permit");
    await click("Remove permit", { role: "button" });
    await ctx.sleep(800);
    await go(click, "Find jobs");
    const sawRecheck = await until(
      ctx,
      async () => /Re-checking fit|Checking fit/.test(await mainText(ctx)),
      20,
      "re-checking status",
    ).catch(() => false);
    await shot("fc-student-rechecking");
    await ctx.sleep(3000);
    const removed = await until(
      ctx,
      scoredAll,
      240,
      "re-scored without the permit",
    );
    await shot("fc-student-without-permit");
    const emptyText = await mainText(ctx);
    const link = p
      .getByRole("button", { name: "Check where you can work", exact: true })
      .or(
        p.getByRole("link", { name: "Check where you can work", exact: true }),
      );
    const hasLink = (await link.count()) > 0;
    return {
      targetsMentionSponsorship: /sponsor/i.test(targets),
      withPermit: fits(baseline),
      withoutPermit: fits(removed),
      sawRecheck: Boolean(sawRecheck),
      hasLink,
      locations,
      emptyText: emptyText.slice(0, 800),
    };
  },
};

Object.assign(EXTRA, {
  // After student: the person adds the permit back as a limited
  // permission; the same jobs are re-checked and part-time leads again.
  async "permit-back"(ctx) {
    const { click, fill, shot } = ctx;
    const p = await ctx.page;
    await go(click, "Profile");
    await click("Preferences", { role: "tab" }).catch(() => {});
    await click("Add limited permission");
    await fill("Permit country", "Germany");
    await fill(
      "Permit limits",
      "Study permit permits paid work up to 20 hours weekly from 1 November 2026 through 30 September 2027. Full-time 40-hour work is not permitted. Future full-time work needs employer sponsorship.",
    );
    await p
      .getByLabel("Will you need sponsorship for future work in this country?")
      .selectOption("yes");
    await shot("fc-student-permit-back");
    await go(click, "Find jobs");
    const sawRecheck = await until(
      ctx,
      async () => /Re-checking fit|Checking fit/.test(await mainText(ctx)),
      20,
      "re-checking status",
    ).catch(() => false);
    const rows = await until(
      ctx,
      () => {
        const r = sql(
          ctx,
          "SELECT title, fit_score, fit_stale FROM jobs WHERE stage='found'",
        );
        return (
          r.length &&
          r.every((j) => !j.fit_stale && j.fit_score >= 0) &&
          r.some((j) => /part-time$/.test(j.title) && j.fit_score >= 65) &&
          r
        );
      },
      240,
      "part-time back above 65",
    );
    await shot("fc-student-permit-back-fit");
    return {
      sawRecheck: Boolean(sawRecheck),
      fits: Object.fromEntries(
        rows.map((j) => [j.title.split(", ").pop(), j.fit_score]),
      ),
    };
  },

  // After student: the persona's best job, written at every level, with each
  // PDF's pages and fill (Lina's resume has more to fill a page than Jamie's).
  async "student-resumes"(ctx) {
    const p = await ctx.page;
    const job = sql(
      ctx,
      "SELECT * FROM jobs WHERE stage='found' ORDER BY fit_score DESC LIMIT 1",
    )[0];
    await go(ctx.click, "Find jobs");
    await showAllFits(p);
    await openFound(ctx, job);
    await ctx.click("/^Shortlist/", { role: "button", within: "Job details" });
    await until(
      ctx,
      () => ["ready", "failed"].includes(resumeOf(ctx, job.id)?.state),
      600,
      "the resume",
    );
    const levels = await walkLevels(ctx, job, [
      "Tailored",
      "Original",
      "Light",
      "Aggressive",
    ]);
    return {
      job: { id: job.id, title: job.title, fit: job.fit_score },
      levels,
    };
  },

  // Quick stops reading a board after 100 unrelated listings in a row. The
  // replica ripple board, read for the first time with a note nothing on it
  // matches, stops early: "More to read", then Keep reading finishes it.
  // Run it before anything else reads ripple on this instance (after
  // student, whose only source is permit-fit). Without a note the related
  // jobs are spread through atlas and ripple and Quick reads them to the end.
  async "more-to-read"(ctx) {
    const { click, fill, shot } = ctx;
    const p = await ctx.page;
    await go(click, "Profile");
    await click("Job sources", { role: "tab" }).catch(() => {});
    await click("Add sources", { role: "button" });
    await fill("Job site URLs", new URL("ripple/", ctx.sites.url).href);
    await click("Add and turn on");
    await go(click, "Find jobs");
    await fill("Anything specific for this search", "Only pastry chef roles");
    await click("Quick", { role: "button", within: "How to search" });
    await click("Search", { role: "button", within: "/^Search$/" });
    await ctx.sleep(1500);
    await waitSearchDone(ctx);
    await shot("fc-quick-more-to-read");
    const quick = sql(
      ctx,
      "SELECT * FROM searches ORDER BY started_at DESC LIMIT 1",
    )[0];
    const sites = (id) =>
      sql(
        ctx,
        "SELECT label, state, cards, related, unrelated, added, message FROM search_sources WHERE search_id = ?",
        id,
      );
    const panel = await p
      .getByRole("region", { name: "Search", exact: true })
      .innerText();
    const keepButton = p.getByRole("button", {
      name: /^Keep reading (it|them)$/,
    });
    const offered = (await keepButton.count()) > 0;
    let keep = null;
    if (offered) {
      await keepButton.first().click();
      await ctx.sleep(1500);
      await shot("fc-keep-reading-running");
      await waitSearchDone(ctx);
      await shot("fc-keep-reading-done");
      const after = sql(
        ctx,
        "SELECT * FROM searches ORDER BY started_at DESC LIMIT 1",
      )[0];
      keep = {
        search: after.id,
        state: after.state,
        settings: after.settings_json,
        sites: sites(after.id),
        panel: await p
          .getByRole("region", { name: "Search", exact: true })
          .innerText(),
      };
    }
    await fill("Anything specific for this search", "");
    const partial = sites(quick.id).filter((x) => x.state === "partial");
    assert.ok(
      partial.length > 0,
      "Quick stopped early on at least one big board",
    );
    assert.ok(offered, "Keep reading is offered");
    assert.ok(
      keep && keep.sites.every((x) => x.state !== "partial"),
      "Keep reading read them to the end",
    );
    return {
      quick: {
        id: quick.id,
        settings: quick.settings_json,
        sites: sites(quick.id),
        panel,
      },
      keep,
    };
  },
});

const p95 = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length
    ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]
    : null;
};
