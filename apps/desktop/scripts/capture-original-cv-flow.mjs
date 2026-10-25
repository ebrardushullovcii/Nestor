import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const outputDir = path.join(
  desktopDir,
  "test-artifacts",
  "ui",
  "original-cv-flow",
);

async function captureOriginalCvFlow() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-original-cv-flow-"),
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
        NESTOR_TEST_SYSTEM_THEME: "dark",
        NESTOR_USER_DATA_DIR: userDataDirectory,
      },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.setViewportSize({ width: 1440, height: 920 });

    await window.evaluate(async () => {
      if (!window.nestor.jobFinder.test) {
        throw new Error("Desktop test API is unavailable in the renderer.");
      }
      await window.nestor.jobFinder.test.setSystemThemeOverride("dark");
      await window.nestor.jobFinder.test.loadApplyQueueDemo();
    });
    await window.reload();
    await window.waitForLoadState("domcontentloaded");

    await window.evaluate(() => {
      window.location.hash = "#/job-finder/settings";
    });
    await window
      .getByRole("heading", { level: 1, name: "Settings" })
      .waitFor({ timeout: 10000 });
    const originalCvDefault = window.getByRole("radio", {
      name: /Use my original CV unchanged/i,
    });
    await originalCvDefault.focus();
    await originalCvDefault.press("Space");
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-original-cv-setting.png"),
    });
    await window.getByRole("button", { name: "Save settings" }).click();
    await window.waitForFunction(
      async () => {
        const workspace = await window.nestor.jobFinder.getWorkspace();
        return workspace.settings.resumeApplicationMode === "original_resume";
      },
      undefined,
      { timeout: 10000 },
    );

    const savedWorkspace = await window.evaluate(() =>
      window.nestor.jobFinder.getWorkspace(),
    );
    if (savedWorkspace.settings.resumeApplicationMode !== "original_resume") {
      throw new Error("Original-CV mode did not persist.");
    }

    await window.evaluate(() => {
      window.location.hash = "#/job-finder/review-queue";
    });
    await window
      .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
      .waitFor({ timeout: 10000 });
    const originalCvForJob = window.getByRole("radio", {
      name: "Original CV unchanged",
      exact: true,
    });
    await originalCvForJob.focus();
    await originalCvForJob.press("Space");
    await window.waitForFunction(
      async () => {
        const workspace = await window.nestor.jobFinder.getWorkspace();
        return (
          workspace.reviewQueue[0]?.resumeApplicationMode === "original_resume"
        );
      },
      undefined,
      { timeout: 10000 },
    );
    await window
      .getByText("Original CV · unchanged")
      .waitFor({ timeout: 10000 });
    await window
      .getByText("alex-vanguard.pdf")
      .first()
      .waitFor({ timeout: 10000 });
    if (
      await window
        .getByRole("button", { name: /Create tailored resume/i })
        .count()
    ) {
      throw new Error(
        "Tailored-resume generation remained available in original-CV mode.",
      );
    }
    await window
      .getByRole("button", { name: "Prepare application", exact: true })
      .waitFor({
        state: "visible",
        timeout: 10000,
      });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-original-cv-review-queue.png"),
    });

    await writeFile(
      path.join(outputDir, "summary.json"),
      `${JSON.stringify(
        {
          mode: savedWorkspace.settings.resumeApplicationMode,
          queue: savedWorkspace.reviewQueue.map((item) => ({
            jobId: item.jobId,
            resumeApplicationMode: item.resumeApplicationMode,
            resumeReviewStatus: item.resumeReview.status,
            resumeAssetId: item.resumeAssetId,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } finally {
    await app?.close().catch(() => undefined);
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

await captureOriginalCvFlow();
