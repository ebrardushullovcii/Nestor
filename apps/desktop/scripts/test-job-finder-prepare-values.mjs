import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

/**
 * Plain Apply ("Prepare for me", no assistant) on the Lever replica, several
 * times, each on a fresh job. After each run it reads what the form holds
 * straight from the page (before anyone touches it) and what the run record
 * says it answered, and compares both with the stored profile.
 *
 *   pnpm --filter @nestor/desktop build
 *   pnpm --filter @nestor/desktop qa --provider configured --script scripts/test-job-finder-prepare-values.mjs
 *
 * Nothing is sent: the apply mode is prepare_only and the script refuses to
 * start if it is not. Only the qa launcher's private replica sites are used.
 */

const LINKEDIN = "https://www.linkedin.com/in/jamie-rivers-test";
const GITHUB = "https://github.com/jamie-rivers-test";
const PORTFOLIO = "https://portfolio.example.test/jamie-rivers-test";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function prepareValues(qa) {
  assert.equal(new URL(qa.sites.url).hostname, "127.0.0.1");
  const site = (path) => new URL(path, qa.sites.url).href;
  const workspace = () =>
    qa.page.evaluate(() => window.nestor.jobFinder.getWorkspace());
  await qa.page.waitForFunction(
    () =>
      typeof window.nestor?.jobFinder?.test?.loadAgentOwnedBrowserDemo ===
      "function",
  );
  const jobs = [2, 4, 6, 7, 9, 10];
  await qa.page.evaluate(
    (input) => window.nestor.jobFinder.test.loadAgentOwnedBrowserDemo(input),
    {
      sourceUrl: site("/lever/"),
      applicationUrl: site("/lever/apply/3"),
      secondaryApplicationUrl: site("/lever/apply/5"),
      jobTitle: "Platform Engineer, Comet Systems",
      jobCompany: "Comet Teacup Labs",
      foundJobs: jobs.map((id) => ({
        title: `Replica role ${id}`,
        company: `Replica Employer ${id}`,
        applicationUrl: site(`/lever/apply/${id}`),
      })),
    },
  );
  await qa.page.reload();
  await wait(1500);

  // The same shape as the tester's profile: the link record id is built from
  // a shortened URL, the stored url is the full one.
  const stored = await qa.page.evaluate(
    async (links) => {
      const state = await window.nestor.jobFinder.getWorkspace();
      const profile = state.profile;
      await window.nestor.jobFinder.saveProfile({
        ...profile,
        linkedinUrl: links.linkedin,
        githubUrl: links.github,
        portfolioUrl: links.portfolio,
        links: [
          {
            id: "link_linkedin_https_www_linkedin_com_in_jamie_rivers_",
            label: "LinkedIn",
            url: links.linkedin,
            kind: "linkedin",
            isDraft: false,
          },
          {
            id: "link_github_https_github_com_jamie_rivers_",
            label: "GitHub",
            url: links.github,
            kind: "github",
            isDraft: false,
          },
          {
            id: "link_portfolio_https_portfolio_example_test_jamie_",
            label: "Portfolio",
            url: links.portfolio,
            kind: "portfolio",
            isDraft: false,
          },
        ],
      });
      const saved = (await window.nestor.jobFinder.getWorkspace()).profile;
      return {
        email: saved.applicationIdentity?.preferredEmail ?? saved.email,
        phone: saved.applicationIdentity?.preferredPhone ?? saved.phone,
        linkedin: saved.linkedinUrl,
        github: saved.githubUrl,
        portfolio: saved.portfolioUrl,
        linkIds: saved.links.map((link) => `${link.id} -> ${link.url}`),
      };
    },
    { linkedin: LINKEDIN, github: GITHUB, portfolio: PORTFOLIO },
  );
  console.log(`STORED ${JSON.stringify(stored)}`);
  const mode = (await workspace()).settings.applicationAutomationMode;
  if ((mode ?? "prepare_only") !== "prepare_only")
    throw new Error(
      `Refusing to run: apply mode is ${mode}, not prepare_only.`,
    );

  const results = [];
  const candidates = (await workspace()).discoveryJobs
    .concat((await workspace()).companyJobs)
    .filter((job) => job.id.startsWith("job_found_"))
    .map((job) => job.id);
  for (const jobId of candidates.slice(0, 6)) {
    const started = Date.now();
    const note = [];
    try {
      await qa.page.evaluate(
        (id) => window.nestor.jobFinder.queueJobForReview(id),
        jobId,
      );
      await qa.page.evaluate(
        (id) => window.nestor.jobFinder.generateResume(id),
        jobId,
      );
      const exported = await qa.page.evaluate(
        (id) => window.nestor.jobFinder.exportResumePdf(id, "approval"),
        jobId,
      );
      const artifactId =
        exported?.artifact?.id ??
        exported?.exportArtifact?.id ??
        exported?.snapshot?.resumeExportArtifacts?.find(
          (entry) => entry.jobId === jobId,
        )?.id ??
        (await workspace()).resumeExportArtifacts.find(
          (entry) => entry.jobId === jobId,
        )?.id;
      await qa.page.evaluate(
        ({ id, exportId }) =>
          window.nestor.jobFinder.approveResume(id, exportId),
        { id: jobId, exportId: artifactId },
      );
      // What the plain Apply button does with "Prepare for me" chosen. The
      // call returns when the run ends, so it is not awaited here.
      await qa.page.evaluate((id) => {
        void window.nestor.jobFinder
          .startApplyCopilotRun({ jobId: id, visualCheckpointsEnabled: false })
          .catch(() => undefined);
      }, jobId);
    } catch (error) {
      note.push(`start: ${String(error?.message ?? error).slice(0, 200)}`);
    }
    // Wait for the form to be filled: ready for review, or stopped on a
    // Needs you step, or failed.
    let settled = null;
    for (;;) {
      const snapshot = await workspace();
      const result = snapshot.applyJobResults
        .filter((entry) => entry.jobId === jobId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const waiting = snapshot.userActionRequests.some(
        (request) =>
          request.scope?.jobId === jobId &&
          ["pending", "page_opened", "awaiting_user"].includes(request.state),
      );
      if (
        result &&
        (["awaiting_review", "failed", "skipped", "submitted"].includes(
          result.state,
        ) ||
          waiting)
      ) {
        settled = { result, waiting, snapshot };
        break;
      }
      if (Date.now() - started > 600_000) break;
      await wait(3000);
    }
    const applyPath = (await workspace()).discoveryJobs
      .concat((await workspace()).companyJobs)
      .find((job) => job.id === jobId)?.applicationUrl;
    // What the page holds, read straight from the DOM of the kept tab.
    const dom = await qa.app.evaluate(async ({ webContents }, url) => {
      const page = webContents
        .getAllWebContents()
        .find((contents) => url && contents.getURL().startsWith(url));
      if (!page) return null;
      return page.executeJavaScript(`JSON.stringify(Object.fromEntries(
        [...document.querySelectorAll("input,textarea,select")]
          .filter((element) => element.name && element.type !== "file" && element.type !== "hidden")
          .map((element) => [element.name, element.type === "checkbox" ? element.checked : element.value])))`);
    }, applyPath ?? "");
    const fields = dom ? JSON.parse(dom) : null;
    // What the run record says it answered.
    let recorded = [];
    if (settled?.result) {
      const record = settled.snapshot.applicationRecords.find(
        (entry) => entry.jobId === jobId,
      );
      const details = record
        ? await qa.page
            .evaluate(
              (input) => window.nestor.jobFinder.getApplyRunDetails(input),
              {
                runId: settled.result.runId,
                jobId,
                applicationRecordId: record.id,
              },
            )
            .catch(() => null)
        : null;
      recorded = [
        ...(details?.questionRecords ?? [])
          .filter((question) =>
            /linkedin|email|phone|github|portfolio/iu.test(question.prompt),
          )
          .map((question) => `${question.prompt}=${question.submittedAnswer}`),
        ...(details?.answerRecords ?? [])
          .filter((answer) =>
            /linkedin|github|portfolio|@|\+\d/iu.test(answer.text ?? ""),
          )
          .map((answer) => `answer ${answer.text}`),
        ...(details?.checkpoints ?? [])
          .map((checkpoint) => checkpoint.detail ?? "")
          .filter((detail) => /linkedin|email|phone/iu.test(detail))
          .map((detail) => `checkpoint ${detail.slice(0, 120)}`),
      ];
    }
    const compare = (name, want) =>
      fields && name in fields
        ? fields[name] === want
          ? "ok"
          : `WRONG (${fields[name]})`
        : "no such field";
    const row = {
      jobId,
      page: applyPath,
      state: settled?.result?.state ?? "not settled",
      waitingOnPerson: settled?.waiting ?? false,
      dom: fields
        ? {
            email: fields.email ?? null,
            phone: fields.phone ?? null,
            linkedin: fields.linkedin ?? null,
            github: fields.github ?? null,
            portfolio: fields.portfolio ?? fields.website ?? null,
          }
        : null,
      verdict: {
        email: compare("email", stored.email),
        phone: compare("phone", stored.phone),
        linkedin: compare("linkedin", stored.linkedin),
        github: compare("github", stored.github),
        portfolio: compare("portfolio", stored.portfolio),
      },
      recorded,
      note,
    };
    results.push(row);
    console.log(`RUN ${JSON.stringify(row)}`);
    // Each result has already been read. Release this completed fixture tab
    // so the next job does not wait forever on the embedded tab limit.
    await qa.app.evaluate(({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => url && entry.getURL() === url);
      contents?.close();
    }, applyPath ?? "");
  }
  const log = await readFile(qa.sites.log, "utf8").catch(() => "");
  const posts = log.split("\n").filter((line) => line.includes('"POST"'));
  console.log(`POSTS ${posts.length}`);
  const wrong = results.filter((row) =>
    Object.values(row.verdict).some((value) => value.startsWith("WRONG")),
  );
  const filled = results.filter((row) => row.dom?.linkedin);
  const passed =
    wrong.length === 0 && filled.length === 6 && posts.length === 0;
  const summary = `F1: ${filled.length} forms read, ${wrong.length} with a wrong value, ${posts.length} POSTs`;
  console.log(`${passed ? "PASS" : "FAIL"} ${summary}`);
  assert.ok(passed, summary);
  assert.ok(results.every((row) => row.state !== "submitted"));
}
