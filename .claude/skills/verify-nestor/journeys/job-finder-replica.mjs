// Job Finder end to end on a fresh instance, the way a person does it:
// import a synthetic resume, finish guided setup with a replica job board as the
// only source, search with fit scores, shortlist, approve the resume, let Apply
// fill the form (Fill in for me), then press the replica site's own Submit.
//
// Needs `bin/up --ai live`: the deterministic AI cannot run a search.
// Run: bin/drive run .claude/skills/verify-nestor/journeys/job-finder-replica.mjs [stage]
// stage: setup | search | shortlist | resume | apply | send | all (default all).
// A single stage assumes the earlier ones already ran on this instance.
import assert from "node:assert/strict";
import path from "node:path";

const RESUME = "test-fixtures/job-finder/resume-import-sample.txt"; // synthetic "Jamie Rivers"
const TARGET_ROLE = "Frontend Engineer"; // the replica /board/ has three Frontend Engineer jobs
// The open application's work-state line, one per state Apply can stop in.
const SETTLED =
  "/^(Filled in and waiting for you to send it|Apply is waiting for an answer from you|Apply couldn’t finish this application|Apply stopped before sending it|The site blocked this browser)/";

export default async function journey(ctx) {
  const stage = ctx.args[0] ?? "all";
  const order = Object.keys(STAGES);
  const run = stage === "all" ? order : [stage];
  const results = {};
  for (const name of run) {
    if (!STAGES[name])
      throw new Error(`Unknown stage ${name}; use ${order.join(" | ")} | all`);
    ctx.note(`journey job-finder-replica: stage ${name}`);
    results[name] = await STAGES[name](ctx);
  }
  return results;
}

/** A sidebar destination; its name carries a count when something waits. */
const go = (click, screen) =>
  click(`/^${screen}/`, {
    role: "button",
    within: "Job Finder sidebar destinations",
  });

const STAGES = {
  async setup({
    click,
    fill,
    press,
    pick,
    shot,
    waitFor,
    sites,
    db,
    desktopDir,
  }) {
    await waitFor("Guided setup", 30, { role: "heading" });
    await shot("jf-setup-start");
    // The native picker is stubbed: the next open dialog returns this synthetic resume.
    pick(path.join(desktopDir, RESUME));
    await click("/Choose my resume file/");
    await waitFor("/Basics.*Ready to review/", 90, { role: "button" });
    await click("/Basics.*Ready to review/", { role: "button" });
    await waitFor("Basics setup step", 20, { role: "heading" });
    await shot("jf-setup-basics-imported");
    await click("Save and continue to Work history");
    await waitFor("Work history setup step", 20, { role: "heading" });
    await click("Save and continue to Job targets");
    await waitFor("Job targets setup step", 20, { role: "heading" });

    const board = new URL("board/", sites.url).href;
    await fill("Job site URLs", board);
    await click("Add and turn on");
    await waitFor("/^Added and turned on 1 source/", 15);
    await fill("Target roles", TARGET_ROLE);
    await press("Enter");
    await fill("Preferred job locations", "Remote");
    await press("Enter");
    await click("I can work in Germany");
    await click("No", { within: "Would you need employer visa sponsorship?" });
    await click("Remote", { role: "checkbox" });
    await waitFor("Everything required is in. You can finish setup.", 10);
    await shot("jf-setup-job-targets");
    const [run] = db("profile_import_runs", { limit: 1 });
    assert.ok(run, "the resume import wrote a profile_import_runs row");
    const [site] = db("job_sites", {
      limit: 1,
      pattern: `${new URL(sites.url).host}/board`,
    });
    assert.equal(site?.enabled, 1, "the replica board is a source, turned on");
    return { importRun: run.id, importStatus: run.status, site: site.url };
  },

  async search({ click, shot, waitFor, db, ai, page, sites }) {
    if (ai !== "live")
      throw new Error(
        "Search needs live AI: run bin/down, then bin/up --ai live.",
      );
    const submissionsBefore = sites.submissions().length;
    // Finishing setup starts the first search itself.
    if (
      await (
        await page
      )
        .getByRole("button", {
          name: "Finish setup and find jobs",
          exact: true,
        })
        .isVisible()
    ) {
      await click("Finish setup and find jobs");
    } else {
      await go(click, "Find jobs");
      await click("Search", { role: "button", within: "/^Search$/" });
    }
    await waitFor("Stop", 30, { role: "button", within: "/^Search$/" }).catch(
      () => {},
    );
    await shot("jf-search-running");
    await waitFor("Search", 600, { role: "button", within: "/^Search$/" });
    await waitFor("/^Last search/", 10);
    await shot("jf-search-results");
    const [search] = db("searches", { limit: 1 });
    assert.equal(
      search?.state,
      "done",
      `the search finished (got ${search?.state}: ${search?.error ?? ""})`,
    );
    assert.equal(search.sources_done, search.sources_total);
    const jobs = db("jobs", { limit: 20 });
    assert.ok(jobs.length > 0, "the search saved jobs");
    const scored = jobs.filter((job) => job.fit_score >= 0);
    assert.ok(scored.length > 0, "saved jobs carry model fit scores");
    assert.equal(sites.submissions().length, submissionsBefore);
    return {
      search: search.id,
      added: search.added,
      scored: search.scored,
      fits: scored.map((job) => `${job.title}: ${job.fit_score}`),
    };
  },

  async shortlist({ page, click, shot, waitFor, db }) {
    const p = await page;
    await p
      .getByRole("list", { name: "Found jobs" })
      .getByRole("button", { name: new RegExp(TARGET_ROLE) })
      .first()
      .click();
    const details = p.getByRole("region", { name: "Job details" });
    const title = (
      await details.getByRole("heading", { level: 2 }).textContent()
    ).trim();
    await shot("jf-job-detail-fit");
    await click("/^Shortlist/", { role: "button", within: "Job details" });
    await go(click, "Shortlisted");
    await waitFor("/^To review \\d/", 15);
    await shot("jf-shortlisted");
    const [job] = db("jobs", {
      limit: 1,
      pattern: title,
      name: "jobs-shortlisted",
    });
    assert.equal(
      job?.stage,
      "shortlisted",
      `${title} is stored as shortlisted (got ${job?.stage})`,
    );
    return { jobId: job.id, title, stage: job.stage };
  },

  // "Write resumes when I shortlist" is on by default, so the resume is
  // already on its way; the person reads it and approves.
  async resume({ click, shot, waitFor, db }) {
    const pane = "/^Resume for /";
    await waitFor("/^(Waiting|Writing|To review)$/", 30, { within: pane });
    await shot("jf-resume-writing");
    await waitFor("/^(To review|Not written)$/", 600, { within: pane });
    await shot("jf-resume-ready");
    const [written] = db("resumes", { limit: 1, name: "resumes-written" });
    assert.equal(
      written?.state,
      "ready",
      `a written resume is stored (got ${written?.state}: ${written?.error ?? ""})`,
    );
    await click("Approve", { role: "button", within: pane });
    await waitFor("Apply can take it now, from Approved.", 15);
    const [resume] = db("resumes", { limit: 1 });
    assert.ok(resume.approved_at, "the resume is approved");
    return { resumeJob: resume.job_id, level: resume.level };
  },

  async apply({ click, shot, waitFor, db, sites }) {
    const before = sites.submissions().length;
    await click("/^Approved \\d/");
    await click("Apply", { role: "button" });
    await waitFor("/^Applying to 1 job/", 15);
    await go(click, "Applications");
    await shot("jf-apply-preparing");
    await waitFor(SETTLED, 900, { within: "/^Application to /" });
    await shot("jf-apply-settled");
    const [application] = db("applications", { limit: 1 });
    assert.equal(
      application?.state,
      "ready",
      `Fill in for me left it ready to send (got ${application?.state}: ${application?.error ?? ""})`,
    );
    assert.equal(application.mode, "confirm_before_submit");
    assert.equal(
      sites.submissions().length,
      before,
      "nothing was sent before the person pressed Submit",
    );
    return { application: application.id, state: application.state };
  },

  async send({ click, shot, waitFor, sites, db, pageFor, press }) {
    // A browser peek left open by an earlier run would cover the app.
    await press("Escape");
    await go(click, "Applications");
    await click("Open application", {
      role: "button",
      within: "/^Application to /",
    });
    const form = await pageFor({ page: "browser", url: "/apply/" });
    // Hard stop: only ever press Submit on this instance's own replica server.
    assert.equal(
      new URL(form.url()).origin,
      new URL(sites.url).origin,
      `refusing to send outside the replica: ${form.url()}`,
    );
    const name = form.getByRole("textbox", { name: /^Name/ });
    await name.waitFor({ timeout: 60000 });
    assert.ok(await name.inputValue(), "the form Apply filled is open");
    await shot("jf-send-form-filled", { target: "browser", url: "/apply/" });
    const before = sites.submissions().length;
    await form.getByRole("button", { name: "Submit", exact: true }).click();
    await form
      .getByText("Thank you! Your application has been received.")
      .waitFor({ timeout: 30000 });
    await shot("jf-send-confirmation", { target: "browser" });
    // The browser peek covers the app until Escape closes it.
    await press("Escape");
    await go(click, "Applications");
    await waitFor("Applied", 60, { within: "/^Application to /" });
    await shot("jf-application-sent");
    const receipts = sites.submissions().slice(before);
    assert.equal(receipts.length, 1, "the replica logged exactly one POST");
    const [application] = db("applications", {
      limit: 1,
      name: "applications-submitted",
    });
    assert.equal(application.state, "submitted");
    assert.ok(application.submitted_at, "the send time is stored");
    const job = db("jobs", { limit: 50 }).find(
      (row) => row.id === application.job_id,
    );
    return {
      replicaReceipt: {
        path: receipts[0].path,
        fields: Object.keys(receipts[0].fields ?? {}),
        resume: receipts[0].fields?.resume?.filename,
      },
      application: application.id,
      state: application.state,
      jobStage: job?.stage,
    };
  },
};
