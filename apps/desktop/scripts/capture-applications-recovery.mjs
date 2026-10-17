/* eslint-env node, browser */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { escapeRegExp, formatVisibleRunId } from "./ui-selectors.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const runLabel = process.env.UI_CAPTURE_LABEL ?? "applications-recovery";
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
  let lastError;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await check()) {
        return;
      }
    } catch (error) {
      // Transient hydration errors are treated as not-yet-ready.
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${description}.`, {
    cause: lastError,
  });
}

async function waitForProfileOrSetupHeading(window) {
  await window.waitForFunction(
    () => Boolean(window.nestor?.jobFinder?.test),
    undefined,
    { timeout: 15000 },
  );
  await window.evaluate(() => {
    window.location.hash = "#/job-finder/profile";
  });
  const profileNavigation = window
    .getByRole("button", { name: /^Profile$/ })
    .first();
  await profileNavigation.waitFor({ state: "visible", timeout: 15000 });
  await profileNavigation.click();
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
    const selectedApplyResult = matchingResults[0] ?? null;

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
    };
  });
}

async function getResumeWorkspace(window, jobId) {
  return window.evaluate(
    async (currentJobId) =>
      window.nestor.jobFinder.getResumeWorkspace(currentJobId),
    jobId,
  );
}

async function loadResumeWorkspaceDemo(window) {
  await window.evaluate(async () => {
    if (!window.nestor.jobFinder.test) {
      throw new Error("Desktop test API is unavailable in the renderer.");
    }

    return window.nestor.jobFinder.test.loadResumeWorkspaceDemo();
  });
  await window.reload();
  await window.waitForLoadState("domcontentloaded");
}

async function expectRunIdVisible(window, runId) {
  const visibleRunId = formatVisibleRunId(runId);
  const applyRunSection = window
    .getByText("Apply run", { exact: true })
    .locator("xpath=ancestor::div[1]");
  await applyRunSection.waitFor({ timeout: 10000 });
  const runLabel = applyRunSection.getByText(`Run ${visibleRunId}`, {
    exact: true,
  });
  await runLabel.waitFor({ timeout: 10000 });
  const titledContainer = runLabel.locator(
    "xpath=ancestor-or-self::*[@title][1]",
  );
  const titledContainerCount = await titledContainer.count();
  if (titledContainerCount === 0) {
    throw new Error(
      `Expected a titled container for Apply run ${runId}, but none was found.`,
    );
  }

  await titledContainer.first().evaluate((element, expectedRunId) => {
    if (element.getAttribute("title") !== expectedRunId) {
      throw new Error(
        `Expected run title ${expectedRunId} but found ${element.getAttribute("title")}`,
      );
    }
  }, runId);
}

async function selectRunHistoryEntry(window, runId) {
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new Error("selectRunHistoryEntry requires a non-empty runId");
  }

  const runHistorySection = window
    .getByText("Run history", { exact: true })
    .locator("xpath=ancestor::section[1]");
  await runHistorySection.waitFor({ timeout: 10000 });
  const visibleRunId = formatVisibleRunId(runId);

  const button = runHistorySection
    .getByRole("button", {
      name: new RegExp(`Run\\s+${escapeRegExp(visibleRunId)}(?!\\w)`, "i"),
    })
    .first();

  await button.waitFor({ timeout: 10000 });
  await button.evaluate((element, expectedRunId) => {
    if (element.getAttribute("title") !== expectedRunId) {
      throw new Error(
        `Expected run history button title ${expectedRunId} but found ${element.getAttribute("title")}`,
      );
    }
  }, runId);
  await button.click();
  return button;
}

async function approveResumeForReadyJob(window) {
  await window.getByRole("button", { name: /^Shortlisted/ }).click();
  await window
    .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
    .waitFor({ timeout: 10000 });

  await window
    .getByRole("button", { name: /Edit resume|Open the resume|Review the resume/i })
    .first()
    .click();
  await window
    .getByRole("heading", { level: 1, name: /Senior Product Designer/i })
    .waitFor({ timeout: 10000 });

  await window.getByRole("button", { name: "Export PDF" }).click();
  await waitForCondition(
    async () =>
      (await getResumeWorkspace(window, "job_ready")).exports.length > 0,
    "resume export before Applications recovery capture",
  );

  const approveButton = window.getByRole("button", {
    name: "Approve current PDF",
  });
  await approveButton.waitFor({ timeout: 10000 });
  await approveButton.click();
  await waitForCondition(async () => {
    const workspace = await getResumeWorkspace(window, "job_ready");
    return (
      workspace.exports.some((entry) => entry.isApproved) &&
      workspace.draft.status === "approved"
    );
  }, "approved resume export before Applications recovery capture");

  await window.getByRole("button", { name: /Back to Shortlisted/i }).click();
  await window
    .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
    .waitFor({ timeout: 10000 });
}

async function startInitialCopilotRun(window) {
  const startApplyCopilotButton = window.getByRole("button", {
    name: "Prepare application",
  });
  await startApplyCopilotButton.waitFor({ timeout: 10000 });
  await startApplyCopilotButton.click();
  const checkpointDialog = window.getByRole("dialog");
  await checkpointDialog.waitFor({ timeout: 10000 });
  await checkpointDialog
    .getByRole("button", { name: "Prepare application", exact: true })
    .click();
  await waitForCondition(async () => {
    return (await getWorkspace(window)).applicationRecords.length > 0;
  }, "application record created by the prepare-only run");
  await window.evaluate(() => {
    window.location.hash = "#/job-finder/applications";
  });
  await window
    .locator("h1")
    .filter({ hasText: /^Applications$/ })
    .waitFor({ timeout: 10000 });
}

async function captureApplicationsRecovery() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-applications-recovery-"),
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

    await loadResumeWorkspaceDemo(window);
    await approveResumeForReadyJob(window);
    await startInitialCopilotRun(window);
    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      return (
        workspace.applyRuns.length === 1 &&
        workspace.applyJobResults.length === 1
      );
    }, "initial Applications copilot run");
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-applications-recovery-initial.png"),
    });

    const initialWorkspace = await getWorkspace(window);
    const initialCopilotRun = initialWorkspace.applyRuns.find(
      (run) => run.mode === "copilot" && run.jobIds.includes("job_ready"),
    );
    if (!initialCopilotRun) {
      throw new Error("Expected the initial safe copilot run for job_ready.");
    }

    const restageAutoRunButton = window.getByRole("button", {
      name: "Restage auto run",
    });
    await restageAutoRunButton.waitFor({ timeout: 10000 });
    await restageAutoRunButton.click();
    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      return (
        workspace.applyRuns.filter((run) => run.jobIds.includes("job_ready"))
          .length >= 2
      );
    }, "restaged auto run from Applications recovery controls");

    const afterAutoRestage = await getWorkspace(window);
    const autoRun = [...afterAutoRestage.applyRuns]
      .filter(
        (run) =>
          run.mode === "single_job_auto" && run.jobIds.includes("job_ready"),
      )
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )[0];
    if (!autoRun) {
      throw new Error(
        "Expected a fresh safe auto run after restaging from Applications.",
      );
    }

    const recoveryBadge = window.getByText("2 runs saved", { exact: true });
    await recoveryBadge.waitFor({ timeout: 10000 });
    await window
      .getByText("Recovery", { exact: true })
      .waitFor({ timeout: 10000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-applications-recovery-auto-restaged.png"),
    });

    const olderRunButton = await selectRunHistoryEntry(
      window,
      initialCopilotRun.id,
    );
    await expectRunIdVisible(window, initialCopilotRun.id);
    await waitForCondition(
      async () =>
        (await olderRunButton.getAttribute("aria-pressed")) === "true",
      "older run selection in Applications run history",
    );
    await window.screenshot({
      animations: "disabled",
      path: path.join(
        outputDir,
        "03-applications-recovery-history-selected.png",
      ),
    });

    const rerunPreparationButton = window.getByRole("button", {
      name: "Prepare this job automatically",
    });
    await rerunPreparationButton.scrollIntoViewIfNeeded();
    await rerunPreparationButton.waitFor({ timeout: 10000 });
    await rerunPreparationButton.click();
    const rerunCheckpointDialog = window.getByRole("dialog");
    await rerunCheckpointDialog.waitFor({ timeout: 10000 });
    await rerunCheckpointDialog
      .getByRole("button", { name: "Prepare application", exact: true })
      .click();
    await waitForCondition(async () => {
      const workspace = await getWorkspace(window);
      return (
        workspace.applyRuns.filter((run) => run.jobIds.includes("job_ready"))
          .length >= 3
      );
    }, "fresh rerun apply copilot action from Applications recovery controls");

    const afterCopilotRerun = await getWorkspace(window);
    const latestRerunCopilot = [...afterCopilotRerun.applyRuns]
      .filter(
        (run) => run.mode === "copilot" && run.jobIds.includes("job_ready"),
      )
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() -
          new Date(left.updatedAt).getTime(),
      )[0];
    if (!latestRerunCopilot || latestRerunCopilot.id === initialCopilotRun.id) {
      throw new Error(
        "Expected the recovery action to create a fresh copilot run.",
      );
    }

    await expectRunIdVisible(window, latestRerunCopilot.id);
    await window
      .getByText("3 runs saved", { exact: true })
      .waitFor({ timeout: 10000 });
    const rerunReviewData = await getSelectedApplyReviewData(window);
    if (!rerunReviewData) {
      throw new Error(
        "Expected selected apply review data after rerunning the safe copilot path.",
      );
    }
    if (
      !rerunReviewData.details.checkpoints.some(
        (checkpoint) =>
          checkpoint.label === "Resumed from retained apply context",
      )
    ) {
      throw new Error(
        `Expected the rerun to retain a recovery checkpoint from the previous apply context. Checkpoints: ${JSON.stringify(rerunReviewData.details.checkpoints)}`,
      );
    }
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04-applications-recovery-copilot-rerun.png"),
    });

    await writeJson("workspace-initial.json", initialWorkspace);
    await writeJson("workspace-after-auto-restage.json", afterAutoRestage);
    await writeJson("workspace-after-copilot-rerun.json", afterCopilotRerun);
    await writeJson("rerun-review-data.json", rerunReviewData);
    await writeJson("run-history-summary.json", {
      initialCopilotRunId: initialCopilotRun.id,
      autoRunId: autoRun.id,
      latestCopilotRunId: latestRerunCopilot.id,
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
      console.warn("Failed to remove temporary browser profile.", error);
    }
  }

  process.stdout.write(
    `Saved Applications recovery artifacts to ${outputDir}\n`,
  );
}

void captureApplicationsRecovery().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
