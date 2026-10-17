/* eslint-env node, browser */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const baselinePath = path.join(
  desktopDir,
  "test-fixtures/job-finder/profile-baseline-workspace.json",
);
const outputRootArg = process.argv.indexOf("--output-root");
const outputRoot = path.resolve(
  process.cwd(),
  outputRootArg >= 0 && process.argv[outputRootArg + 1]
    ? process.argv[outputRootArg + 1]
    : "apps/desktop/test-artifacts/persona-wave-20260828/authority-outcome-wave",
);
const at = "2026-08-27T10:00:00.000Z";
const digest = "a".repeat(64);

function createSeed(baseline, demoSnapshot) {
  const authority = {
    id: "authority_uncertain",
    mode: "prepare_only",
    status: "active",
    revision: 1,
    scope: { campaignId: null, jobIds: ["job_uncertain"] },
    maxApplicationsPerRun: 1,
    maxApplicationsPerLocalDay: 1,
    intermediateMutationsAuthorized: false,
    accountCreationAuthorized: false,
    allowedResumeSha256: [digest],
    allowedOrigins: ["https://jobs.example.com"],
    createdAt: at,
    expiresAt: null,
    revokedAt: null,
    decisionPolicy: null,
  };
  const preflight = {
    id: "preflight_uncertain",
    idempotencyKey: "submit_once_uncertain",
    runId: "run_uncertain",
    jobId: "job_uncertain",
    resultId: "result_uncertain",
    applicationRecordId: "application_uncertain",
    campaignId: null,
    origin: "https://jobs.example.com",
    authorityEnvelopeId: authority.id,
    authorityRevision: 1,
    decisionPolicy: { version: 1, revision: 1, digest },
    formObservation: { id: "observation_uncertain", revision: 1, digest },
    resumeSha256: digest,
    answers: { revision: 1, digest },
    finalControl: { signature: digest, ref: "final_control_uncertain" },
    remainingRunCapacityBefore: 1,
    remainingDailyCapacityBefore: 1,
    createdAt: at,
  };
  const outcome = {
    id: "outcome_uncertain",
    preflightId: preflight.id,
    idempotencyKey: preflight.idempotencyKey,
    authorityEnvelopeId: authority.id,
    authorityRevision: 1,
    runId: preflight.runId,
    jobId: preflight.jobId,
    resultId: preflight.resultId,
    applicationRecordId: preflight.applicationRecordId,
    outcome: "outcome_uncertain",
    attemptedAt: at,
    verifiedAt: null,
    evidence: [],
    retry: { eligible: false, blockReason: "outcome_uncertain" },
  };
  const receipt = {
    schemaVersion: 1,
    generatedAt: at,
    lineage: {
      runId: preflight.runId,
      jobId: preflight.jobId,
      resultId: preflight.resultId,
      applicationRecordId: preflight.applicationRecordId,
    },
    destination: {
      origin: "https://jobs.example.com",
      safePath: "/apply/uncertain",
    },
    resume: {
      source: "original_upload",
      sourceDocumentId: "resume_1",
      exportArtifactId: null,
      fileName: "alex-vanguard.pdf",
      sha256: digest,
    },
    stayedLocal: [],
    modelUse: [],
    externalWrites: [],
    accountCreationAuthorized: false,
    finalSubmitAuthorized: true,
    finalSubmitOccurred: false,
    submissionOutcome: outcome,
  };

  return {
    ...baseline,
    profileSetupState: {
      status: "completed",
      currentStep: "ready_check",
      completedAt: at,
      lastResumedAt: at,
    },
    savedJobs: [
      {
        ...demoSnapshot.discoveryJobs[0],
        id: preflight.jobId,
        title: "Principal Product Designer",
        company: "Example Systems",
        canonicalUrl: "https://jobs.example.com/roles/principal-designer",
        applicationUrl: "https://jobs.example.com/apply/uncertain",
        status: "shortlisted",
      },
    ],
    applicationAuthorityEnvelopes: [authority],
    submissionPreflights: [preflight],
    submissionIdempotencyRecords: [
      {
        id: "idempotency_uncertain",
        idempotencyKey: preflight.idempotencyKey,
        preflightId: preflight.id,
        authorityEnvelopeId: authority.id,
        authorityRevision: 1,
        runId: preflight.runId,
        jobId: preflight.jobId,
        resultId: preflight.resultId,
        applicationRecordId: preflight.applicationRecordId,
        status: "outcome_uncertain",
        revision: 3,
        createdAt: at,
        updatedAt: at,
        armedAt: at,
        outcomeId: outcome.id,
        outcome: outcome.outcome,
        revokedAt: null,
      },
    ],
    submissionArmedMarkers: [
      {
        id: "armed_uncertain",
        idempotencyKey: preflight.idempotencyKey,
        preflightId: preflight.id,
        authorityEnvelopeId: authority.id,
        authorityRevision: 1,
        runId: preflight.runId,
        jobId: preflight.jobId,
        resultId: preflight.resultId,
        applicationRecordId: preflight.applicationRecordId,
        armedAt: at,
      },
    ],
    submissionOutcomeRecords: [outcome],
    applyRuns: [
      {
        id: preflight.runId,
        campaignId: null,
        mode: "copilot",
        state: "completed",
        jobIds: [preflight.jobId],
        currentJobId: null,
        submitApprovalId: null,
        visualCheckpointsEnabled: false,
        createdAt: at,
        updatedAt: at,
        completedAt: at,
        summary: "Submission outcome requires manual verification.",
        detail: "The employer site must establish the terminal outcome.",
      },
    ],
    applyJobResults: [
      {
        id: preflight.resultId,
        runId: preflight.runId,
        jobId: preflight.jobId,
        applicationRecordId: preflight.applicationRecordId,
        queuePosition: 0,
        state: "blocked",
        summary: "Submission outcome needs verification.",
        detail: "Check the employer site before another action.",
        startedAt: at,
        updatedAt: at,
        completedAt: at,
        blockerReason: "submission_outcome_uncertain",
        blockerSummary: "Verify on the employer site.",
        listingSignalEvidence: null,
        visualObservationSets: [],
        visualCheckpoints: [],
        latestQuestionCount: 0,
        latestAnswerCount: 0,
        pendingConsentRequestCount: 0,
        artifactCount: 0,
        latestCheckpointId: null,
        privacyReceipt: receipt,
      },
    ],
    applicationRecords: [
      {
        id: preflight.applicationRecordId,
        jobId: preflight.jobId,
        title: "Principal Product Designer",
        company: "Example Systems",
        status: "ready_for_review",
        lastActionLabel: "Submission outcome needs verification",
        nextActionLabel: "Verify on the employer site",
        lastUpdatedAt: at,
        lastAttemptState: "paused",
        questionSummary: {
          total: 0,
          required: 0,
          answered: 0,
          unansweredRequired: 0,
        },
        latestBlocker: {
          code: "requires_manual_review",
          summary: "Verify the submission outcome on the employer site.",
        },
        consentSummary: { status: "none", pendingCount: 0 },
        replaySummary: {
          sourceInstructionArtifactId: null,
          lastUrl: "https://jobs.example.com/apply/uncertain",
          checkpointCount: 0,
          evidenceCount: 0,
        },
        events: [],
        crm: null,
      },
    ],
  };
}

async function openApplications(page) {
  await page
    .getByRole("button", { name: /^Applications/ })
    .first()
    .click();
  await page.getByRole("heading", { level: 1, name: "Applications" }).waitFor();
}

async function launch(userDataDirectory) {
  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_BROWSER_AGENT: "0",
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_API_USE_LIVE_AI: "0",
      NESTOR_TEST_SYSTEM_THEME: "dark",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.waitForFunction(
    () => Boolean(window.nestor?.jobFinder?.test),
    undefined,
    { timeout: 30_000 },
  );
  return { app, page };
}

async function resetWorkspaceState(page, seed) {
  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await page.evaluate(
        (state) => window.nestor.jobFinder.test.resetWorkspaceState(state),
        seed,
      );
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(600);
    }
  }
  throw lastError;
}

async function assertUncertain(page) {
  try {
    await page
      .getByRole("alert")
      .filter({ hasText: /outcome is uncertain/i })
      .waitFor({ timeout: 15_000 });
  } catch (error) {
    process.stderr.write(
      `${(await page.locator("body").innerText()).slice(0, 8000)}\n`,
    );
    await page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "uncertain-missing-debug.png"),
    });
    throw error;
  }
  await page
    .getByRole("region", { name: "Verify submission outcome" })
    .waitFor();
  if (await page.getByRole("button", { name: /retry preparation/i }).count()) {
    throw new Error("Uncertain outcome exposed a retry-preparation control.");
  }
  if (
    await page
      .getByRole("button", { name: /^(submit|submit application|apply now)$/i })
      .count()
  ) {
    throw new Error("Uncertain outcome exposed a submit control.");
  }
}

async function run() {
  await mkdir(outputRoot, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-authority-outcome-"),
  );
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const report = { startedAt: new Date().toISOString(), checks: [] };
  let launched = await launch(userDataDirectory);

  try {
    const demoSnapshot = await launched.page.evaluate(() =>
      window.nestor.jobFinder.test.loadResumeWorkspaceDemo(),
    );
    if (!demoSnapshot.discoveryJobs[0]) {
      throw new Error(
        "The validated demo workspace did not provide a saved job fixture.",
      );
    }
    const seed = createSeed(baseline, demoSnapshot);
    await resetWorkspaceState(launched.page, seed);
    await launched.page.reload({ waitUntil: "domcontentloaded" });
    await openApplications(launched.page);
    await assertUncertain(launched.page);
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "uncertain-before-restart.png"),
    });
    report.checks.push("uncertainty-visible-no-retry-no-submit");

    await launched.app.close();
    launched = await launch(userDataDirectory);
    await openApplications(launched.page);
    await assertUncertain(launched.page);
    report.checks.push("uncertainty-persists-after-normal-restart");

    const taskSummary = launched.page
      .locator("summary")
      .filter({ hasText: /Task/i })
      .first();
    if (await taskSummary.count()) {
      await taskSummary.click();
      await launched.page
        .getByLabel("Notifications and actions")
        .getByRole("heading", { name: "Manual verification required" })
        .waitFor();
      await launched.page
        .getByText("Verify on the employer site")
        .first()
        .waitFor();
      report.checks.push("task-center-routes-manual-verification");
      await taskSummary.click();
    }

    await launched.page
      .getByRole("button", { name: "I verified it was not submitted" })
      .click();
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "not-submitted-confirmation.png"),
    });
    await launched.page
      .getByRole("button", { name: "Confirm verification" })
      .click();
    await launched.page
      .getByText("Final action not submitted")
      .first()
      .waitFor({ timeout: 20_000 });
    report.checks.push("not-submitted-two-step-resolution");

    await resetWorkspaceState(launched.page, seed);
    await launched.page.reload({ waitUntil: "domcontentloaded" });
    await openApplications(launched.page);
    await launched.page
      .getByRole("button", { name: "I verified it was submitted" })
      .click();
    await launched.page
      .getByRole("button", { name: "Confirm verification" })
      .click();
    await launched.page
      .getByText("Employer-site verification saved: submitted.")
      .waitFor({ timeout: 20_000 });
    await launched.page
      .getByText("Application submission externally verified.")
      .first()
      .waitFor({ timeout: 20_000 });
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "submitted-verified.png"),
    });
    report.checks.push("submitted-two-step-resolution");

    await launched.app.close();
    launched = await launch(userDataDirectory);
    await openApplications(launched.page);
    await launched.page
      .getByText("Application submission externally verified.")
      .first()
      .waitFor();
    report.checks.push("verified-outcome-persists-after-normal-restart");

    await launched.page
      .getByRole("button", { name: /^Settings/ })
      .first()
      .click();
    await launched.page
      .getByRole("heading", { level: 1, name: "Settings" })
      .waitFor();
    await launched.page
      .getByRole("link", {
        name: "What Job Finder may do on application sites",
      })
      .click();
    await launched.page
      .getByText(/Prepare only/i)
      .first()
      .waitFor();
    await launched.page
      .getByText(/unavailable/i)
      .first()
      .waitFor();
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "settings-boundary.png"),
    });
    report.checks.push("settings-remains-prepare-only");
    report.status = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.error = error instanceof Error ? error.stack : String(error);
    report.bodyText = (await launched.page.locator("body").innerText()).slice(
      0,
      12_000,
    );
    await launched.page.screenshot({
      animations: "disabled",
      path: path.join(outputRoot, "failure-debug.png"),
    });
    throw error;
  } finally {
    await launched.app.close().catch(() => undefined);
    report.completedAt = new Date().toISOString();
    await writeFile(
      path.join(outputRoot, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

await run();
