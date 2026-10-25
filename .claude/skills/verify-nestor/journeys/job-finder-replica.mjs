// Job Finder end to end on a fresh instance, the way a person does it:
// import a synthetic resume, finish guided setup with a replica job board as the
// only source, search, read the fit verdicts, shortlist, generate a tailored
// resume, prepare the application, then press the replica site's own Submit.
//
// Needs `bin/up --ai live`: the deterministic AI cannot run a search.
// Run: bin/drive run .claude/skills/verify-nestor/journeys/job-finder-replica.mjs [stage]
// stage: setup | search | shortlist | resume | apply | send | all (default all).
// A single stage assumes the earlier ones already ran on this instance.
import assert from "node:assert/strict";
import path from "node:path";

const RESUME = "test-fixtures/job-finder/resume-import-sample.txt"; // synthetic "Jamie Rivers"
const TARGET_ROLE = "Frontend Engineer"; // the replica /board/ has three Frontend Engineer jobs

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
    await waitFor("Import Complete", 90);
    await click("Basics Ready to review");
    await shot("jf-setup-basics-imported");
    await click("Save and continue to Work history");
    await waitFor("Work history setup step", 20, { role: "heading" });
    await click("Save and continue to Job targets");
    await waitFor("Job targets setup step", 20, { role: "heading" });

    await fill("Source name (optional)", "Replica board");
    await fill("Careers or job-board URL", new URL("board/", sites.url).href);
    await click("Add and turn on");
    await waitFor("/^Added Replica board/", 15);
    await click("Done adding");
    await fill("Target roles", TARGET_ROLE);
    await press("Enter");
    await fill("Preferred job locations", "Remote");
    await press("Enter");
    await click("I can work in Germany");
    await click("No", { within: "Would you need employer visa sponsorship?" });
    await click("Remote", { role: "checkbox" });
    await click("Full-time", { role: "checkbox" });
    await waitFor("Everything required is in. You can finish setup.", 10);
    await shot("jf-setup-job-targets");
    const imports = db("resume_import_runs", { limit: 1 });
    assert.equal(
      imports.length,
      1,
      "the resume import wrote a resume_import_runs row",
    );
    return { resumeImportRun: imports[0].id };
  },

  async search({ click, shot, waitFor, see, db, ai, page, workspace, sites }) {
    if (ai !== "live")
      throw new Error(
        "Search needs live AI: run bin/down, then bin/up --ai live.",
      );
    const submissionsBefore = sites.submissions().length;
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
      await click("Find jobs", { role: "button" });
      await click("Search now", { role: "button" });
    }
    await waitFor("Find jobs", 30, { role: "heading" });
    await waitFor("/^(Stop search|Searching)$/", 30, { role: "button" }).catch(
      () => {},
    );
    await shot("jf-search-running");
    await waitFor("Search now", 600, { role: "button" });
    await shot("jf-search-results");
    const tree = await see();
    if (/The search stopped before it could finish/.test(tree))
      throw new Error(
        "The search stopped early; read the alert in the last screenshot.",
      );
    const fits = [...tree.matchAll(/Overall fit: (\d+) percent/g)].map(
      (m) => `${m[1]}%`,
    );
    assert.ok(fits.length > 0, "search results carry model fit verdicts");
    const runs = db("discovery_runs", { limit: 1 });
    const jobs = db("saved_jobs", { limit: 20 });
    const run = (await workspace()).recentDiscoveryRuns[0];
    assert.equal(run?.state, "completed", "the real search completed");
    assert.ok(
      run.targetExecutions.every((target) => target.state === "completed"),
      "each replica source completed",
    );
    assert.ok(
      run.targetExecutions.some((target) =>
        target.sourceCounts?.some((source) => (source.pagesCovered ?? 0) > 0),
      ),
      "page accounting finished after browser checkpoints",
    );
    assert.ok(
      run.activity.some(
        (event) =>
          event.stage === "persistence" &&
          (event.jobsPersisted ?? 0) > 0 &&
          !event.terminalState,
      ),
      "the browser search committed a live checkpoint",
    );
    assert.equal(sites.submissions().length, submissionsBefore);
    return {
      discoveryRun: runs[0]?.id,
      state: run.state,
      savedJobs: jobs.length,
      fits,
    };
  },

  async shortlist({ page, click, shot, waitFor, db }) {
    const p = await page;
    await p
      .getByRole("list", { name: "Results" })
      .getByRole("button", { name: new RegExp(`^${TARGET_ROLE},`) })
      .first()
      .click();
    const title = (
      await p
        .getByRole("group", { name: "Selected job summary" })
        .getByRole("heading")
        .first()
        .textContent()
    ).trim();
    await shot("jf-job-detail-fit");
    await click("Shortlist job");
    // Find jobs reports a decision on its triage bar ("N of M gone through"
    // with Undo), not in a toast; the stored status below is the proof.
    await waitFor("Undo", 15, { role: "button" });
    await click("Shortlisted", {
      role: "button",
      within: "Job Finder sidebar destinations",
    });
    await waitFor("Shortlisted", 15, { role: "heading" });
    await shot("jf-shortlisted");
    const [job] = db("saved_jobs", {
      limit: 1,
      pattern: title,
      name: "saved_jobs-shortlisted",
    });
    // Shortlisting can start the resume draft in the background straight away.
    assert.ok(
      ["shortlisted", "drafting"].includes(job?.value?.status),
      `${title} is stored as shortlisted (got ${job?.value?.status})`,
    );
    return { jobId: job.id, title, status: job.value.status };
  },

  async resume({ page, click, shot, db }) {
    await click("Create the resume");
    const progress = (await page)
      .getByRole("progressbar", { name: "Resume preparation in progress" })
      .first();
    await progress.waitFor({ timeout: 30000 }).catch(() => {});
    await shot("jf-resume-writing");
    await progress.waitFor({ state: "detached", timeout: 600000 });
    await (await page)
      .getByRole("button", { name: "Apply", exact: true })
      .waitFor({ timeout: 30000 });
    await shot("jf-resume-ready");
    const drafts = db("resume_drafts", { limit: 1 });
    assert.equal(drafts.length, 1, "a resume_drafts row exists");
    return { resumeDraft: drafts[0].id };
  },

  async apply({ click, shot, waitFor, db }) {
    await click("Apply", { role: "button" });
    await waitFor("Applications", 30, { role: "heading" });
    await shot("jf-apply-preparing");
    await waitFor("Ready for you to read over and send", 900, {
      role: "heading",
    });
    await shot("jf-apply-ready-to-send");
    const records = db("application_records", { limit: 1 });
    assert.notEqual(
      records[0]?.value?.status,
      "submitted",
      "nothing was sent before the person pressed Submit",
    );
    return { application: records[0]?.id, status: records[0]?.value?.status };
  },

  async send({ click, shot, waitFor, sites, db, pageFor, press }) {
    await click("/^(Re)?[Oo]pen the Job Finder browser$/", { role: "button" });
    const form = await pageFor({ page: "browser", url: "/apply/" });
    // Hard stop: only ever press Submit on this instance's own replica server.
    assert.equal(
      new URL(form.url()).origin,
      new URL(sites.url).origin,
      `refusing to send outside the replica: ${form.url()}`,
    );
    await shot("jf-send-form-filled", { target: "browser", url: "/apply/" });
    const before = sites.submissions().length;
    await form
      .getByRole("button", {
        name: /^(Submit|Submit application|Send application)$/,
      })
      .first()
      .click();
    await form
      .getByText("Thank you! Your application has been received.")
      .waitFor({ timeout: 30000 });
    await shot("jf-send-confirmation", { target: "browser", url: "/apply/" });
    await press("Escape");
    await waitFor("Application submitted", 60, { role: "heading" });
    await shot("jf-application-submitted");
    const receipts = sites.submissions().slice(before);
    assert.equal(receipts.length, 1, "the replica logged exactly one POST");
    const record = db("application_records", {
      limit: 1,
      name: "application_records-submitted",
    })[0];
    assert.equal(record.value.status, "submitted");
    return {
      replicaReceipt: {
        path: receipts[0].path,
        fields: Object.keys(receipts[0].fields ?? {}),
        resume: receipts[0].fields?.resume?.filename,
      },
      application: record.id,
      status: record.value.status,
      receipt: record.value.personSendReceipt?.summary,
    };
  },
};
