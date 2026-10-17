import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const runLabel = process.env.UI_CAPTURE_LABEL ?? "resume-approval-flow-current";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);
const jobId = "job_ready";

async function waitForCondition(check, description, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function main() {
  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-resume-approval-"),
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
    await window.setViewportSize({ width: 1440, height: 920 });
    await window.waitForFunction(
      () => Boolean(window.nestor?.jobFinder?.test),
      undefined,
      { timeout: 15_000 },
    );
    await window.evaluate(async () => {
      await window.nestor.jobFinder.test?.setSystemThemeOverride("dark");
      await window.nestor.jobFinder.test?.loadResumeWorkspaceDemo();
      window.location.hash = "#/job-finder/review-queue/job_ready/resume";
    });
    await window.reload();

    const preview = window.locator(
      "[data-resume-preview-scroll-region]:visible",
    );
    const tools = window.locator(
      "[data-resume-workspace-scroll-region]:visible",
    );
    await preview.waitFor({ state: "visible", timeout: 20_000 });
    await tools.waitFor({ state: "visible", timeout: 20_000 });
    await window
      .getByRole("button", { name: "Approve resume" })
      .waitFor({ state: "visible", timeout: 20_000 });
    await window
      .locator('iframe[title="Live resume preview"]:visible')
      .waitFor({ state: "visible", timeout: 20_000 });
    await waitForCondition(
      async () =>
        (await preview.evaluate((element) => element.clientHeight)) > 0,
      "the live preview to settle into its bounded region",
    );
    const outerScrollArea = window.locator(
      "[data-locked-screen-scroll-area]:visible",
    );
    await outerScrollArea.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await waitForCondition(
      async () =>
        (await outerScrollArea.evaluate((element) => element.scrollTop)) > 0,
      "the Resume Studio to settle below the collapsed route header",
    );

    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-ready-to-approve.png"),
    });

    const geometryBefore = await window.evaluate(() => {
      const previewRegion = Array.from(
        document.querySelectorAll("[data-resume-preview-scroll-region]"),
      ).find((element) => element.getClientRects().length > 0);
      const toolsRegion = Array.from(
        document.querySelectorAll("[data-resume-workspace-scroll-region]"),
      ).find((element) => element.getClientRects().length > 0);
      if (!(previewRegion instanceof HTMLElement)) {
        throw new Error("Preview scroll region is missing.");
      }
      if (!(toolsRegion instanceof HTMLElement)) {
        throw new Error("Tools scroll region is missing.");
      }
      const previewRect = previewRegion.getBoundingClientRect();
      const toolsRect = toolsRegion.getBoundingClientRect();
      return {
        preview: {
          bottom: previewRect.bottom,
          clientHeight: previewRegion.clientHeight,
          scrollHeight: previewRegion.scrollHeight,
          top: previewRect.top,
        },
        tools: {
          bottom: toolsRect.bottom,
          clientHeight: toolsRegion.clientHeight,
          scrollHeight: toolsRegion.scrollHeight,
          top: toolsRect.top,
        },
        viewportHeight: window.innerHeight,
      };
    });

    if (
      geometryBefore.preview.bottom > geometryBefore.viewportHeight + 1 ||
      geometryBefore.tools.bottom > geometryBefore.viewportHeight + 1
    ) {
      throw new Error(
        `Resume panes exceed the viewport: ${JSON.stringify(geometryBefore)}`,
      );
    }
    if (
      geometryBefore.tools.clientHeight >= geometryBefore.tools.scrollHeight
    ) {
      throw new Error("Resume tools are not independently scrollable.");
    }

    await tools.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-tools-scrolled-preview-bounded.png"),
    });

    const geometryAfterToolsScroll = await window.evaluate(() => {
      const previewRegion = Array.from(
        document.querySelectorAll("[data-resume-preview-scroll-region]"),
      ).find((element) => element.getClientRects().length > 0);
      const toolsRegion = Array.from(
        document.querySelectorAll("[data-resume-workspace-scroll-region]"),
      ).find((element) => element.getClientRects().length > 0);
      if (!(previewRegion instanceof HTMLElement)) {
        throw new Error("Preview scroll region is missing.");
      }
      if (!(toolsRegion instanceof HTMLElement)) {
        throw new Error("Tools scroll region is missing.");
      }
      return {
        previewScrollTop: previewRegion.scrollTop,
        toolsScrollTop: toolsRegion.scrollTop,
      };
    });
    if (geometryAfterToolsScroll.previewScrollTop !== 0) {
      throw new Error("Scrolling the tools unexpectedly moved the preview.");
    }
    if (geometryAfterToolsScroll.toolsScrollTop <= 0) {
      throw new Error("Tools did not move to their independent scroll range.");
    }

    await window.getByRole("button", { name: "Approve resume" }).click();
    await waitForCondition(async () => {
      const workspace = await window.evaluate(
        async (currentJobId) =>
          window.nestor.jobFinder.getResumeWorkspace(currentJobId),
        jobId,
      );
      return (
        workspace.draft.status === "approved" &&
        workspace.exports.some((artifact) => artifact.isApproved)
      );
    }, "the background-created PDF to be approved");

    await window
      .getByRole("button", { name: "Prepare application" })
      .waitFor({ state: "visible", timeout: 10_000 });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-approved-ready-to-continue.png"),
    });

    const finalWorkspace = await window.evaluate(
      async (currentJobId) =>
        window.nestor.jobFinder.getResumeWorkspace(currentJobId),
      jobId,
    );
    await writeFile(
      path.join(outputDir, "report.json"),
      `${JSON.stringify(
        {
          draftStatus: finalWorkspace.draft.status,
          geometryAfterToolsScroll,
          geometryBefore,
          hasApprovedExport: finalWorkspace.exports.some(
            (artifact) => artifact.isApproved,
          ),
          visibleActions: await window
            .locator("[data-resume-workspace-top-actions] button:visible")
            .allTextContents(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } finally {
    if (app) await app.close().catch(() => undefined);
    await rm(userDataDirectory, { force: true, recursive: true }).catch(
      () => undefined,
    );
  }

  process.stdout.write(`Saved Resume Studio evidence to ${outputDir}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
