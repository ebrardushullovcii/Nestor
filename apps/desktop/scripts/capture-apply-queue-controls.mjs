/* eslint-env node, browser */
/* global process, setTimeout, document */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { selectApplicationRecord, selectQueueJobs } from "./ui-selectors.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const runLabel = process.env.UI_CAPTURE_LABEL ?? "apply-queue-controls";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);

async function writeJson(fileName, value) {
  await writeFile(
    path.join(outputDir, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function waitForCondition(
  check,
  description,
  timeoutMs = 15000,
  intervalMs = 150,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForProfileOrSetupHeading(window) {
  await window.evaluate(() => {
    window.location.hash = "#/job-finder/profile";
  });
  await window.waitForFunction(
    () => {
      const heading = document.querySelector("h1");
      return (
        heading?.textContent?.includes("Your profile") ||
        heading?.textContent?.includes("Guided setup")
      );
    },
    undefined,
    { timeout: 15000 },
  );
}

async function getWorkspace(window) {
  return window.evaluate(() => window.nestor.jobFinder.getWorkspace());
}

function getApplyResultForJob(workspace, jobId) {
  return (
    workspace.applyJobResults
      .filter((result) => result.jobId === jobId)
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )[0] ?? null
  );
}

async function getSelectedApplyReviewData(window) {
  return window.evaluate(async () => {
    const snapshot = await window.nestor.jobFinder.getWorkspace();
    const selectedRecord =
      snapshot.applicationRecords.find(
        (record) => record.id === snapshot.selectedApplicationRecordId,
      ) ??
      snapshot.applicationRecords[0] ??
      null;

    if (!selectedRecord) {
      return null;
    }

    const matchingResults = snapshot.applyJobResults
      .filter((result) => result.jobId === selectedRecord.jobId)
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      );
    const selectedApplyResult =
      matchingResults.find(
        (result) => result.runId === snapshot.selectedApplyRunId,
      ) ??
      matchingResults[0] ??
      null;

    if (!selectedApplyResult) {
      return null;
    }

    const details = await window.nestor.jobFinder.getApplyRunDetails(
      selectedApplyResult.runId,
      selectedRecord.jobId,
    );

    return {
      details,
      selectedApplyResult,
      selectedRecord,
      selectedApplyRunId: snapshot.selectedApplyRunId,
      workspace: snapshot,
    };
  });
}

async function loadQueueDemo(window) {
  await window.evaluate(async () => {
    if (!window.nestor.jobFinder.test) {
      throw new Error("Desktop test API is unavailable in the renderer.");
    }

    return window.nestor.jobFinder.test.loadApplyQueueDemo();
  });
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
}

async function stageSelectedQueue(window) {
  const stageButton = window.getByRole("button", { name: /Stage queue for/i });
  if (!(await stageButton.isVisible())) {
    const moreActions = window
      .locator("summary")
      .filter({ hasText: /^More actions$/ });
    await moreActions.waitFor({ timeout: 10000 });
    await moreActions.click();
  }
  await stageButton.waitFor({ timeout: 10000 });
  await stageButton.click();

  try {
    await window
      .getByRole("heading", { level: 1, name: "Applications" })
      .waitFor({ timeout: 10000 });
  } catch (error) {
    const statusMessages = await window.getByRole("status").allTextContents();
    throw new Error(
      `Queue staging did not reach Applications. Status messages: ${statusMessages.join(" | ") || "none"}`,
      { cause: error },
    );
  }
}

async function approveCurrentRun(window) {
  const approveButton = window.getByRole("button", {
    name: /^Approve safe preparation/,
  });
  await approveButton.waitFor({ timeout: 10000 });
  await approveButton.click();
}

async function captureApplyQueueControls() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-apply-queue-controls-"),
  );

  let app;

  try {
    app = await electron.launch({
      args: ["."],
      cwd: desktopDir,
      env: {
        ...process.env,
        NESTOR_BROWSER_AGENT: "0",
        NESTOR_ENABLE_TEST_API: "1",
        NESTOR_TEST_SYSTEM_THEME:
          process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });

    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(async (theme) => {
      if (!window.nestor.jobFinder.test) {
        throw new Error("Desktop test API is unavailable in the renderer.");
      }

      await window.nestor.jobFinder.test.setSystemThemeOverride(theme);
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark");
    await waitForProfileOrSetupHeading(window);
    await window.setViewportSize({ width, height });

    await loadQueueDemo(window);
    await window.getByRole("button", { name: /^Shortlisted/ }).click();
    await window
      .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
      .waitFor({ timeout: 10000 });

    await selectQueueJobs(window, [
      "Senior Product Designer",
      "Staff Product Designer",
    ]);
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-review-queue-multi-select.png"),
    });

    await stageSelectedQueue(window);
    await selectApplicationRecord(
      window,
      "Staff Product Designer",
      "Consent Labs",
    );
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-applications-queue-staged.png"),
    });

    await approveCurrentRun(window);
    await waitForCondition(async () => {
      const reviewData = await getSelectedApplyReviewData(window);
      return reviewData?.details.run.state === "paused_for_consent";
    }, "queue consent pause after approval");
    await selectApplicationRecord(
      window,
      "Staff Product Designer",
      "Consent Labs",
    );
    await window
      .getByText("Consent requests", { exact: true })
      .waitFor({ timeout: 20000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-applications-queue-consent-pause.png"),
    });
    const consentPaused = await getSelectedApplyReviewData(window);

    const continueSafelyButton = window.getByRole("button", {
      name: "Continue safely",
    });
    await continueSafelyButton.waitFor({ timeout: 10000 });
    await continueSafelyButton.click();
    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      return workspace.applyJobResults.some(
        (result) =>
          result.jobId === "job_ready" && result.state === "awaiting_review",
      );
    }, "queue resume after consent approval");
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04-applications-queue-consent-approved.png"),
    });
    const consentApprovedWorkspace = await getWorkspace(window);

    await loadQueueDemo(window);
    await window.getByRole("button", { name: /^Shortlisted/ }).click();
    await window
      .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
      .waitFor({ timeout: 10000 });
    await selectQueueJobs(window, [
      "Senior Product Designer",
      "Staff Product Designer",
    ]);
    await stageSelectedQueue(window);
    await selectApplicationRecord(
      window,
      "Staff Product Designer",
      "Consent Labs",
    );
    await approveCurrentRun(window);
    await waitForCondition(async () => {
      const reviewData = await getSelectedApplyReviewData(window);
      return reviewData?.details.run.state === "paused_for_consent";
    }, "queue consent pause before decline");
    await selectApplicationRecord(
      window,
      "Staff Product Designer",
      "Consent Labs",
    );
    await window
      .getByText("Consent requests", { exact: true })
      .waitFor({ timeout: 20000 });

    const skipJobButton = window.getByRole("button", { name: "Skip this job" });
    await skipJobButton.waitFor({ timeout: 10000 });
    await skipJobButton.click();
    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      return (
        workspace.applyJobResults.some(
          (result) =>
            result.jobId === "job_consent_queue" && result.state === "skipped",
        ) &&
        workspace.applyJobResults.some(
          (result) =>
            result.jobId === "job_ready" && result.state === "awaiting_review",
        )
      );
    }, "queue skip-and-continue after declined consent");
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "05-applications-queue-consent-declined.png"),
    });
    const consentDeclinedWorkspace = await getWorkspace(window);

    await loadQueueDemo(window);
    await window.getByRole("button", { name: /^Shortlisted/ }).click();
    await window
      .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
      .waitFor({ timeout: 10000 });
    await selectQueueJobs(window, ["Senior Product Designer"]);
    await stageSelectedQueue(window);
    await selectApplicationRecord(
      window,
      "Senior Product Designer",
      "Signal Systems",
    );
    const cancelButton = window.getByRole("button", { name: "Cancel run" });
    await cancelButton.waitFor({ timeout: 10000 });
    await cancelButton.click();
    await waitForCondition(async () => {
      const reviewData = await getSelectedApplyReviewData(window);
      return reviewData?.details.run.state === "cancelled";
    }, "cancelled queue run state");
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "06-applications-queue-cancelled.png"),
    });
    const cancelledRun = await getSelectedApplyReviewData(window);

    if (!consentPaused || !cancelledRun) {
      throw new Error(
        "Expected queue review data to be available for the staged queue scenarios.",
      );
    }

    if (!consentApprovedWorkspace?.applyJobResults) {
      throw new Error(
        "Expected a workspace snapshot with apply job results after approving queue consent.",
      );
    }

    if (!consentDeclinedWorkspace?.applyJobResults) {
      throw new Error(
        "Expected a workspace snapshot with apply job results after declining queue consent.",
      );
    }

    if (consentPaused.details.run.state !== "paused_for_consent") {
      throw new Error(
        `Expected queue run to pause for consent, got '${consentPaused.details.run.state}'.`,
      );
    }

    if (
      !consentPaused.details.consentRequests.some(
        (request) => request.status === "pending",
      )
    ) {
      throw new Error(
        "Expected a pending consent request in the paused queue run.",
      );
    }

    if (
      getApplyResultForJob(consentApprovedWorkspace, "job_ready")?.state !==
      "awaiting_review"
    ) {
      throw new Error(
        "Expected consent approval to let the next queued job reach awaiting_review.",
      );
    }

    if (
      getApplyResultForJob(consentDeclinedWorkspace, "job_consent_queue")
        ?.state !== "skipped"
    ) {
      throw new Error("Expected declined consent to skip the blocked job.");
    }

    if (
      getApplyResultForJob(consentDeclinedWorkspace, "job_ready")?.state !==
      "awaiting_review"
    ) {
      throw new Error(
        "Expected declined consent to continue the queue to the next job.",
      );
    }

    if (cancelledRun.details.run.state !== "cancelled") {
      throw new Error(
        `Expected cancelled queue run state, got '${cancelledRun.details.run.state}'.`,
      );
    }

    await writeJson("queue-consent-paused.json", consentPaused);
    await writeJson(
      "queue-consent-approved-workspace.json",
      consentApprovedWorkspace,
    );
    await writeJson(
      "queue-consent-declined-workspace.json",
      consentDeclinedWorkspace,
    );
    await writeJson("queue-cancelled-run.json", cancelledRun);
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve the original failure while still cleaning up the temp profile.
      }
    }
    await rm(userDataDirectory, { recursive: true, force: true });
  }

  process.stdout.write(`Saved apply queue control artifacts to ${outputDir}\n`);
}

void captureApplyQueueControls().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
