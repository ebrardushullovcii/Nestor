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
const runLabel = process.env.UI_CAPTURE_LABEL ?? "applications-queue-recovery";
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
  await stageButton.waitFor({ timeout: 10000 });
  await stageButton.click();
  await window
    .getByRole("heading", { level: 1, name: "Applications" })
    .waitFor({ timeout: 10000 });
}

async function approveCurrentRun(window) {
  const approveButton = window.getByRole("button", {
    name: /^Approve safe preparation/,
  });
  await approveButton.waitFor({ timeout: 10000 });
  await approveButton.click();
}

async function captureApplicationsQueueRecovery() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-applications-queue-recovery-"),
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
    await stageSelectedQueue(window);
    await selectApplicationRecord(
      window,
      "Staff Product Designer",
      "Consent Labs",
    );
    await approveCurrentRun(window);

    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      return (
        workspace.applyRuns.some(
          (run) =>
            run.mode === "queue_auto" && run.state === "paused_for_consent",
        ) ||
        workspace.applyJobResults.some(
          (result) =>
            result.jobId === "job_consent_queue" && result.state === "skipped",
        )
      );
    }, "initial queue run to reach a recoverable state");

    const initialRecoveryWorkspace = await getWorkspace(window);
    const needsConsentReview = initialRecoveryWorkspace.applyRuns.some(
      (run) => run.mode === "queue_auto" && run.state === "paused_for_consent",
    );

    await selectApplicationRecord(
      window,
      "Staff Product Designer",
      "Consent Labs",
    );
    if (needsConsentReview) {
      await window
        .getByText("Consent requests", { exact: true })
        .waitFor({ timeout: 20000 });
    }

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
    }, "queue run with one skipped job and one completed review-ready job");

    await window.screenshot({
      animations: "disabled",
      path: path.join(
        outputDir,
        "01-applications-queue-recovery-source-run.png",
      ),
    });
    const sourceWorkspace = await getWorkspace(window);
    const latestQueueRun = [...sourceWorkspace.applyRuns]
      .filter((run) => run.mode === "queue_auto")
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )[0];
    if (!latestQueueRun) {
      throw new Error(
        "Expected a queue run before testing Applications queue recovery.",
      );
    }

    const runHistorySection = window
      .getByText("Run history", { exact: true })
      .locator("xpath=ancestor::section[1]");
    await runHistorySection.waitFor({ timeout: 10000 });
    await window
      .getByText("Queue outcome summary", { exact: true })
      .waitFor({ timeout: 10000 });
    await window
      .getByText(/hit blocked or skipped jobs/i)
      .waitFor({ timeout: 10000 });
    await window
      .getByText("Will restage", { exact: true })
      .waitFor({ timeout: 10000 });
    await window
      .getByText("Already completed or review-ready", { exact: true })
      .waitFor({ timeout: 10000 });
    await window
      .getByText("Staff Product Designer at Consent Labs", { exact: true })
      .first()
      .waitFor({ timeout: 10000 });
    const restageQueueButton = window.getByRole("button", {
      name: "Restage remaining queue",
    });
    await restageQueueButton.waitFor({ timeout: 10000 });
    await restageQueueButton.click();

    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      return (
        workspace.applyRuns.filter((run) => run.mode === "queue_auto").length >=
        2
      );
    }, "fresh queue recovery run from Applications");

    const recoveredWorkspace = await getWorkspace(window);
    const recoveredQueueRun = recoveredWorkspace.applyRuns
      .filter(
        (run) => run.mode === "queue_auto" && run.id !== latestQueueRun.id,
      )
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )[0];
    if (!recoveredQueueRun) {
      throw new Error("Expected a fresh queue recovery run from Applications.");
    }

    if (
      recoveredQueueRun.jobIds.length !== 1 ||
      recoveredQueueRun.jobIds[0] !== "job_consent_queue"
    ) {
      throw new Error(
        `Expected the recovered queue to restage only the skipped job, got '${recoveredQueueRun.jobIds.join(", ")}'.`,
      );
    }

    await window
      .getByText("2 runs saved", { exact: true })
      .waitFor({ timeout: 10000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-applications-queue-recovery-restaged.png"),
    });

    await writeJson("source-workspace.json", sourceWorkspace);
    await writeJson("recovered-workspace.json", recoveredWorkspace);
    await writeJson("queue-recovery-summary.json", {
      sourceRunId: latestQueueRun.id,
      recoveredRunId: recoveredQueueRun.id,
      recoveredJobIds: recoveredQueueRun.jobIds,
    });
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        // Preserve the original failure while still cleaning up the temp profile.
      }
    }
    try {
      await rm(userDataDirectory, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        "Failed to remove temporary Applications queue recovery profile.",
        error,
      );
    }
  }

  process.stdout.write(
    `Saved Applications queue recovery artifacts to ${outputDir}\n`,
  );
}

void captureApplicationsQueueRecovery().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
