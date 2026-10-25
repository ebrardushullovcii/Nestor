import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const runLabel = process.env.UI_CAPTURE_LABEL ?? "resume-workspace-dirty";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);
const jobId = "job_ready";

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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function clickAndDismissDialog(window, locator) {
  const dialogMessagePromise = new Promise((resolve, reject) => {
    const timeoutMs = 5000;
    let timeoutId;
    const handleDialog = (dialog) => {
      clearTimeout(timeoutId);
      const message = dialog.message();
      void dialog
        .dismiss()
        .then(() => resolve(message))
        .catch(reject);
    };

    timeoutId = setTimeout(() => {
      window.removeListener("dialog", handleDialog);
      reject(
        new Error("Timed out waiting for confirmation dialog after click."),
      );
    }, timeoutMs);

    window.once("dialog", handleDialog);
  });

  await locator.click();
  return dialogMessagePromise;
}

function summaryField(window) {
  return window
    .locator("article")
    .filter({ has: window.getByRole("heading", { name: "Summary" }) })
    .getByLabel("Section text");
}

function assistantField(window) {
  return window
    .locator(
      '[data-resume-guided-edits-open="true"] textarea[aria-label="Message the Assistant"]:visible',
    )
    .first();
}

async function openAssistant(window) {
  await window.getByRole("button", { name: /^Open the Assistant/ }).click();
  await waitForCondition(
    async () =>
      await window
        .locator('[data-resume-guided-edits-open="true"]')
        .first()
        .isVisible(),
    "the Assistant panel to open",
  );
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

async function loadDemo(window) {
  await window.waitForLoadState("domcontentloaded");
  await waitForProfileOrSetupHeading(window);
  await window.setViewportSize({ width, height });

  await window.evaluate(async () => {
    if (!window.nestor.jobFinder.test) {
      throw new Error("Desktop test API is unavailable in the renderer.");
    }

    return window.nestor.jobFinder.test.loadResumeWorkspaceDemo();
  });

  await window.reload();
  await window.waitForLoadState("domcontentloaded");
}

async function openResumeWorkspace(window) {
  await window.getByRole("button", { name: /^Shortlisted/ }).click();
  await window
    .getByRole("heading", { level: 1, name: "Shortlisted jobs" })
    .waitFor({ timeout: 10000 });
  await window
    .getByRole("button", {
      name: /Edit resume|Open the resume|Review the resume/i,
    })
    .first()
    .click();
  await window
    .getByRole("heading", { level: 1, name: /Senior Product Designer/i })
    .waitFor({ timeout: 10000 });
}

async function getResumeWorkspace(window) {
  return window.evaluate(
    async (currentJobId) =>
      window.nestor.jobFinder.getResumeWorkspace(currentJobId),
    jobId,
  );
}

async function getSummaryText(window) {
  const workspace = await getResumeWorkspace(window);
  return (
    workspace.draft.sections.find((section) => section.kind === "summary")
      ?.text ?? ""
  );
}

async function getAssistantMessages(window) {
  return window.evaluate(
    async (currentJobId) =>
      window.nestor.jobFinder.getResumeAssistantMessages(currentJobId),
    jobId,
  );
}

async function waitForSummaryFieldValue(window, expectedText) {
  await waitForCondition(
    async () => (await summaryField(window).inputValue()) === expectedText,
    `summary field value to equal '${expectedText}'`,
  );
}

async function waitForApprovedExport(window) {
  await waitForCondition(async () => {
    const workspace = await getResumeWorkspace(window);
    return (
      workspace.draft.status === "approved" &&
      workspace.exports.some((entry) => entry.isApproved)
    );
  }, "approved export state");
}

async function captureResumeWorkspaceDirtyState() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-resume-workspace-dirty-"),
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
    await window.evaluate(async (theme) => {
      await window.nestor.jobFinder.test?.setSystemThemeOverride(theme);
    }, process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark");
    const results = {};

    await loadDemo(window);
    await openResumeWorkspace(window);
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-workspace-open.png"),
    });

    // "Refresh draft" was removed with the Assistant unification: the
    // whole-draft rewrite now lives in the Assistant, states that it replaces
    // the current edits, and asks once before it runs. The dirty-state fact
    // this step records is that the unsaved edit survives opening that control
    // and declining its confirmation.
    const refreshSentinel =
      "Builds resilient workflows for design systems, workflow automation, and operations platforms.";
    await summaryField(window).fill(refreshSentinel);
    await openAssistant(window);
    await window.locator("[data-resume-assistant-regenerate]").first().click();
    const keepDraftButton = window.getByRole("button", {
      name: "Keep my draft",
    });
    await keepDraftButton.waitFor({ timeout: 10000 });
    await keepDraftButton.click();
    await waitForSummaryFieldValue(window, refreshSentinel);
    results.refresh = {
      fieldValue: await summaryField(window).inputValue(),
      savedSummaryText: await getSummaryText(window),
      action:
        "the Assistant rewrite asks before replacing the unsaved draft, and declining keeps it",
    };
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-after-refresh-save.png"),
    });

    const assistantSentinel =
      "Systems-focused product designer with deep workflow automation and design-systems experience.";
    await summaryField(window).fill(assistantSentinel);
    await assistantField(window).fill("Explain why this section was included.");
    const previousAssistantMessageCount = (await getAssistantMessages(window))
      .length;
    await window.getByRole("button", { name: "Send message" }).click();
    await waitForCondition(
      async () => {
        const workspace = await getResumeWorkspace(window);
        const messages = await getAssistantMessages(window);
        const summaryText =
          workspace.draft.sections.find((section) => section.kind === "summary")
            ?.text ?? "";
        const lastMessage = messages.at(-1);
        // The send control is an icon button now, so "the request settled" is
        // read from the control being enabled again rather than from its text.
        const sendReady = await window
          .getByRole("button", { name: "Send message" })
          .isEnabled();
        return (
          summaryText === assistantSentinel &&
          messages.length > previousAssistantMessageCount &&
          lastMessage?.role === "assistant" &&
          lastMessage.content.trim().length > 0 &&
          sendReady
        );
      },
      "assistant messages after dirty save-before-send",
      30000, // AI assistant responses can exceed the default 15s wait here.
    );
    const assistantMessages = await getAssistantMessages(window);
    results.assistant = {
      summaryText: await getSummaryText(window),
      messageCount: assistantMessages.length,
      lastAssistantPatches: assistantMessages.at(-1)?.patches.length ?? null,
      action: "assistant request saved dirty draft before sending",
    };
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-after-assistant-save.png"),
    });

    await window.getByRole("button", { name: "Download PDF" }).click();
    await waitForCondition(
      async () => (await getResumeWorkspace(window)).exports.length > 0,
      "resume export artifact",
    );
    await window.getByRole("button", { name: "Approve resume" }).click();
    await waitForApprovedExport(window);

    const clearApprovalSentinel =
      "Dirty clear approval sentinel after approval.";
    await summaryField(window).fill(clearApprovalSentinel);
    await window.getByRole("button", { name: "Clear approval" }).click();
    await waitForCondition(async () => {
      const workspace = await getResumeWorkspace(window);
      const summaryText =
        workspace.draft.sections.find((section) => section.kind === "summary")
          ?.text ?? "";
      return (
        summaryText === clearApprovalSentinel &&
        workspace.draft.status === "stale" &&
        workspace.draft.approvedExportId === null &&
        !workspace.exports.some((entry) => entry.isApproved)
      );
    }, "stale resume state after clearing approval");
    const staleWorkspace = await getResumeWorkspace(window);
    results.clearApproval = {
      summaryText: await getSummaryText(window),
      draftStatus: staleWorkspace.draft.status,
      approvedExportId: staleWorkspace.draft.approvedExportId,
      approvedExportsRemaining: staleWorkspace.exports.filter(
        (entry) => entry.isApproved,
      ).length,
      action: "clear approval saved dirty draft before clearing approval",
    };
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04-after-clear-approval-save.png"),
    });

    const shellNavigationSentinel =
      "Dirty shell navigation sentinel kept after cancelling navigation.";
    await summaryField(window).fill(shellNavigationSentinel);
    const shellDialogMessage = await clickAndDismissDialog(
      window,
      window.getByRole("button", { name: /^Applications/ }),
    );
    await window
      .getByRole("heading", { level: 1, name: /Senior Product Designer/i })
      .waitFor({ timeout: 10000 });
    const shellNavigationFieldValue = await summaryField(window).inputValue();
    assert(
      shellNavigationFieldValue === shellNavigationSentinel,
      "Dirty summary text was lost after cancelling shell navigation.",
    );
    results.shellNavigation = {
      dialogMessage: shellDialogMessage,
      fieldValue: shellNavigationFieldValue,
      action: "shell navigation prompts before leaving dirty workspace",
    };
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "05-shell-navigation-guard.png"),
    });

    const backNavigationSentinel =
      "Dirty back navigation sentinel kept after cancelling the back action.";
    await summaryField(window).fill(backNavigationSentinel);
    const backDialogMessage = await clickAndDismissDialog(
      window,
      window.getByRole("button", { name: /Back to Shortlisted/i }),
    );
    await window
      .getByRole("heading", { level: 1, name: /Senior Product Designer/i })
      .waitFor({ timeout: 10000 });
    const backNavigationFieldValue = await summaryField(window).inputValue();
    assert(
      backNavigationFieldValue === backNavigationSentinel,
      "Dirty summary text was lost after cancelling the back navigation action.",
    );
    results.backNavigation = {
      dialogMessage: backDialogMessage,
      fieldValue: backNavigationFieldValue,
      action: "back navigation prompts before leaving dirty workspace",
    };
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "06-back-navigation-guard.png"),
    });

    await writeJson("dirty-state-results.json", results);
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
    } catch {
      // Preserve the original failure while still cleaning up the temp profile.
    }
  }

  process.stdout.write(
    `Saved resume workspace dirty-state artifacts to ${outputDir}\n`,
  );
}

void captureResumeWorkspaceDirtyState();
