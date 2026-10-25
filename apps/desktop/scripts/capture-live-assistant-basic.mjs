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
  process.env.UI_CAPTURE_LABEL ?? "live-assistant-basic",
);

function assertInvariant(condition, message) {
  if (!condition)
    throw new Error(`Live Assistant basic harness failed: ${message}`);
}

async function getWorkspace(window) {
  return window.evaluate(() => window.nestor.liveAssistant.getWorkspace());
}

async function waitForOverlayWindows(app) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const windows = app
      .windows()
      .filter((candidate) =>
        candidate.url().includes("/live-assistant/overlay/"),
      );
    if (windows.length === 2) return windows;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    "Timed out waiting for the answer and transcript popup windows.",
  );
}

async function waitForCueCount(window, expectedMinimum) {
  await window.waitForFunction(
    async (minimum) => {
      const workspace = await window.nestor.liveAssistant.getWorkspace();
      return (workspace.activeSession?.cueCards.length ?? 0) >= minimum;
    },
    expectedMinimum,
    { timeout: 15_000 },
  );
}

async function run() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-live-assistant-basic-"),
  );
  const attachmentPath = path.join(userDataDirectory, "architecture.png");
  await writeFile(
    attachmentPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
      "base64",
    ),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NESTOR_AI_API_KEY: "",
      NESTOR_AI_VISION_API_KEY: "",
      NESTOR_INTERVIEW_AI_API_KEY: "",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });

  try {
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(() => {
      window.location.hash = "/live-assistant";
    });
    await window.setViewportSize({ width: 1440, height: 920 });
    await window
      .getByRole("heading", { name: "Interview conversation" })
      .waitFor();
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-setup.png"),
    });

    await window.getByRole("button", { name: "Allow and continue" }).click();
    const quickCheckButton = window.getByRole("button", {
      name: "Run quick check",
    });
    await quickCheckButton.waitFor();
    await quickCheckButton.click();
    const startInterviewButton = window.getByRole("button", {
      name: "Start interview",
    });
    await startInterviewButton.waitFor();
    await startInterviewButton.click();
    await window
      .getByRole("heading", {
        name: "Ask, listen, and work through the answer",
      })
      .waitFor();

    const overlayWindows = await waitForOverlayWindows(app);
    for (const overlayWindow of overlayWindows) {
      await overlayWindow.waitForLoadState("domcontentloaded");
    }
    const answerOverlayWindow = overlayWindows.find((candidate) =>
      candidate.url().includes("/overlay/answer"),
    );
    const transcriptOverlayWindow = overlayWindows.find((candidate) =>
      candidate.url().includes("/overlay/transcript"),
    );
    assertInvariant(answerOverlayWindow, "answer popup should exist");
    assertInvariant(transcriptOverlayWindow, "transcript popup should exist");
    const popupVisibility = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((candidate) =>
          candidate.webContents.getURL().includes("/live-assistant/overlay/"),
        )
        .map((candidate) => ({
          url: candidate.webContents.getURL(),
          visible: candidate.isVisible(),
        })),
    );
    const workspaceBefore = await getWorkspace(window);
    const firstExpectedCueCount =
      (workspaceBefore.activeSession?.cueCards.length ?? 0) + 1;
    const composer = window.getByPlaceholder(
      "Ask a question, paste a screenshot, or type what you need help answering…",
    );
    await composer.fill("Help me explain a difficult architecture trade-off");
    await window.getByRole("button", { name: /^Send$/ }).click();
    await waitForCueCount(window, firstExpectedCueCount);
    await window
      .getByText("Help me explain a difficult architecture trade-off")
      .first()
      .waitFor();

    const popupComposer = answerOverlayWindow.getByPlaceholder(
      "Ask for an answer, follow-up, or feedback…",
    );
    await popupComposer.fill("Use this screenshot to improve the answer");
    await window.evaluate(() =>
      window.nestor.liveAssistant.performAction("toggle_listening"),
    );
    await answerOverlayWindow.waitForFunction(() =>
      document
        .querySelector('textarea[aria-label="Ask Interview Copilot"]')
        ?.value.includes("Use this screenshot"),
    );
    await window.evaluate(() =>
      window.nestor.liveAssistant.performAction("toggle_listening"),
    );

    const imageInput = answerOverlayWindow.locator(
      'input[type="file"][accept*="image/png"]',
    );
    await imageInput.setInputFiles(attachmentPath);
    await answerOverlayWindow.getByAltText("architecture.png").waitFor();
    const workspaceAfterText = await getWorkspace(window);
    const secondExpectedCueCount =
      (workspaceAfterText.activeSession?.cueCards.length ?? 0) + 1;
    await answerOverlayWindow.getByRole("button", { name: /^Send$/ }).click();
    await waitForCueCount(window, secondExpectedCueCount);
    await window.getByText("architecture.png").waitFor();

    await answerOverlayWindow
      .getByText("Use this screenshot to improve the answer")
      .waitFor({ timeout: 15_000 });
    await transcriptOverlayWindow
      .getByText("Use this screenshot to improve the answer")
      .waitFor({ timeout: 15_000 });

    await answerOverlayWindow
      .getByRole("button", { name: /^Copy answer$/ })
      .click();
    const copiedAnswer = await window.evaluate(() =>
      window.nestor.liveAssistant.readClipboardText(),
    );
    await transcriptOverlayWindow
      .getByRole("button", { name: /^Copy transcript$/ })
      .click();
    const copiedTranscript = await window.evaluate(() =>
      window.nestor.liveAssistant.readClipboardText(),
    );

    await answerOverlayWindow
      .getByRole("button", { name: "Hide answer popup" })
      .click();
    await window.waitForFunction(async () => {
      const workspace = await window.nestor.liveAssistant.getWorkspace();
      return workspace.answerOverlay.visible === false;
    });
    await window.getByRole("button", { name: "Open answer popup" }).click();
    await window.waitForFunction(async () => {
      const workspace = await window.nestor.liveAssistant.getWorkspace();
      return workspace.answerOverlay.visible === true;
    });

    const resizedAnswerBounds = await app.evaluate(({ BrowserWindow }) => {
      const answerWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes("/overlay/answer"),
      );
      if (!answerWindow) return null;
      const bounds = answerWindow.getBounds();
      const resized = {
        ...bounds,
        width: bounds.width + 80,
        height: bounds.height + 60,
      };
      answerWindow.setBounds(resized);
      return resized;
    });
    assertInvariant(resizedAnswerBounds, "answer popup should resize");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await answerOverlayWindow.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-answer-popup.png"),
    });
    await transcriptOverlayWindow.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-transcript-popup.png"),
    });

    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window
      .getByRole("heading", {
        name: "Ask, listen, and work through the answer",
      })
      .waitFor();
    await window
      .getByText("Help me explain a difficult architecture trade-off")
      .first()
      .waitFor();
    await window.getByText("architecture.png").waitFor();

    const finalWorkspace = await getWorkspace(window);
    const report = {
      setupButtonsWorked: true,
      activeSessionStarted: finalWorkspace.activeSession?.status === "active",
      advancedOverlayWindowCount: overlayWindows.length,
      popupVisibility,
      assistantResponseVisible:
        (await window.getByText("Live Assistant", { exact: true }).count()) > 0,
      attachedImageVisible:
        (await window.getByText("architecture.png", { exact: true }).count()) >
        0,
      chatSurvivesReload:
        (finalWorkspace.activeSession?.chatConversation?.messages.length ??
          0) === 4,
      audioInputsVisible:
        (await window.getByRole("heading", { name: "Audio inputs" }).count()) >
        0,
      latestCueQuestion:
        finalWorkspace.activeSession?.cueCards.at(-1)?.question ?? null,
      localSttReady: Boolean(
        finalWorkspace.setup.rehearsal?.microphoneEngine.ready &&
        finalWorkspace.setup.rehearsal.microphoneEngine.kind ===
          "local_model" &&
        finalWorkspace.setup.rehearsal.meetingAudioEngine.ready &&
        finalWorkspace.setup.rehearsal.meetingAudioEngine.kind ===
          "local_model",
      ),
      rawImageBytesRetained: JSON.stringify(finalWorkspace).includes(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
      ),
      transcriptVisible:
        (await window
          .getByRole("heading", { name: "Recent transcript" })
          .count()) > 0,
      popupTypedSendWorked:
        finalWorkspace.activeSession?.chatConversation?.messages.some(
          (message) =>
            message.role === "user" &&
            message.content === "Use this screenshot to improve the answer",
        ) ?? false,
      popupDraftSurvivedWorkspaceUpdate: true,
      popupClipboardWorked:
        copiedAnswer.text.length > 0 &&
        copiedTranscript.text.includes("Use this screenshot"),
      popupHideAndReopenWorked: finalWorkspace.answerOverlay.visible,
      popupResized: Boolean(resizedAnswerBounds),
    };

    await window.getByRole("button", { name: "Assist", exact: true }).click();
    await window
      .getByRole("heading", {
        name: "Ask, listen, and work through the answer",
      })
      .waitFor();
    await window.getByRole("button", { name: "End", exact: true }).click();
    await window.waitForFunction(() =>
      window.nestor.liveAssistant
        .getWorkspace()
        .then((workspace) => workspace.activeSession === null),
    );
    await window.getByText("Post-session review", { exact: true }).waitFor();
    const prepArtifactCountBefore = finalWorkspace.setup.prepArtifacts.length;
    await window.getByRole("button", { name: "Save prep" }).click();
    await window.waitForFunction(
      (expectedMinimum) =>
        window.nestor.liveAssistant
          .getWorkspace()
          .then(
            (workspace) =>
              workspace.setup.prepArtifacts.length >= expectedMinimum,
          ),
      prepArtifactCountBefore + 1,
    );
    await window.getByRole("button", { name: "Export notes" }).click();
    await window.locator("pre").last().waitFor();
    report.reviewTransitionWorked = true;
    report.savePrepWorked = true;
    report.exportNotesWorked = true;
    report.reviewModeLabelWorked =
      (await window.getByText("Review mode", { exact: true }).count()) > 0;
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "05-review.png"),
    });

    const retainedSessionBeforeCancel = (await getWorkspace(window))
      .recentSessions[0]?.id;
    const deleteSessionButton = window.getByRole("button", {
      name: "Delete session",
    });
    await deleteSessionButton.focus();
    await deleteSessionButton.click();
    const deleteDialog = window.getByRole("alertdialog", {
      name: "Delete this interview session?",
    });
    await deleteDialog.waitFor();
    const cancelDeleteButton = deleteDialog.getByRole("button", {
      name: "Cancel",
    });
    report.deleteDialogSafeInitialFocus = await cancelDeleteButton.evaluate(
      (button) => button === document.activeElement,
    );
    await window.keyboard.press("Escape");
    await deleteDialog.waitFor({ state: "detached" });
    const retainedSessionAfterCancel = (await getWorkspace(window))
      .recentSessions[0]?.id;
    report.deleteDialogCancelRetainedSession =
      Boolean(retainedSessionBeforeCancel) &&
      retainedSessionAfterCancel === retainedSessionBeforeCancel;
    report.deleteDialogRestoredFocus = await deleteSessionButton.evaluate(
      (button) => button === document.activeElement,
    );

    await window.setViewportSize({ width: 320, height: 800 });
    await window
      .getByRole("navigation", { name: "Live Assistant sections" })
      .getByRole("button", { name: "Settings" })
      .scrollIntoViewIfNeeded();
    report.reflow320CssPx = await window.evaluate(() => ({
      documentHasNoHorizontalOverflow:
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
      sectionTabsReachable: ["Setup", "Assist", "Review", "Settings"].every(
        (label) =>
          [...document.querySelectorAll("button")].some(
            (button) =>
              button.textContent?.trim() === label &&
              button.getClientRects().length > 0,
          ),
      ),
      moduleContextReachable:
        [...document.querySelectorAll("a")].some(
          (link) =>
            link.getAttribute("aria-label") === "Open Job Finder" &&
            link.getClientRects().length > 0,
        ) && document.body.textContent?.includes("Live Assistant"),
    }));
    await window.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(outputDir, "06-review-320-css-px.png"),
    });
    await window.setViewportSize({ width: 1440, height: 920 });

    await window.getByRole("button", { name: "Setup", exact: true }).click();
    await window.getByRole("button", { name: "Start interview" }).click();
    const restartedOverlays = await waitForOverlayWindows(app);
    const restartedAnswer = restartedOverlays.find((candidate) =>
      candidate.url().includes("/overlay/answer"),
    );
    assertInvariant(
      restartedAnswer,
      "answer popup should reopen after restart",
    );
    const restoredAnswerBounds = await app.evaluate(({ BrowserWindow }) => {
      const answerWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().includes("/overlay/answer"),
      );
      return answerWindow?.getBounds() ?? null;
    });
    report.popupBoundsRestored =
      JSON.stringify(restoredAnswerBounds) ===
      JSON.stringify(resizedAnswerBounds);
    report.applicationActionsExecuted = false;
    report.finalSubmissionClicked = false;

    assertInvariant(report.activeSessionStarted, "session should start");
    assertInvariant(
      report.setupButtonsWorked,
      "allow, quick check, and start should work through visible controls",
    );
    assertInvariant(
      report.reviewTransitionWorked,
      "ending through the visible control should open review",
    );
    assertInvariant(
      report.savePrepWorked,
      "review should save the latest cue as prep",
    );
    assertInvariant(
      report.exportNotesWorked,
      "review should export visible notes",
    );
    assertInvariant(
      report.reviewModeLabelWorked,
      "review should expose the correct active mode label",
    );
    assertInvariant(
      report.deleteDialogSafeInitialFocus,
      "delete confirmation should initially focus the safe action",
    );
    assertInvariant(
      report.deleteDialogCancelRetainedSession,
      "canceling delete confirmation should retain the session",
    );
    assertInvariant(
      report.deleteDialogRestoredFocus,
      "canceling delete confirmation should restore trigger focus",
    );
    assertInvariant(
      report.reflow320CssPx.documentHasNoHorizontalOverflow &&
        report.reflow320CssPx.sectionTabsReachable &&
        report.reflow320CssPx.moduleContextReachable,
      "320 CSS px layout should avoid document overflow and keep module and section navigation reachable",
    );
    assertInvariant(
      !report.applicationActionsExecuted && !report.finalSubmissionClicked,
      "the Live Assistant harness must not execute application or submission actions",
    );
    assertInvariant(
      report.advancedOverlayWindowCount === 2,
      "answer and transcript popup windows should open when the interview starts",
    );
    assertInvariant(
      report.popupVisibility.every((popup) => popup.visible),
      "both popup windows should be visibly shown",
    );
    assertInvariant(
      report.assistantResponseVisible,
      "assistant response should be visible in the main window",
    );
    assertInvariant(
      report.attachedImageVisible,
      "sent attachment metadata should remain visible",
    );
    assertInvariant(
      report.chatSurvivesReload,
      "chat messages should survive a renderer reload",
    );
    assertInvariant(
      report.audioInputsVisible,
      "audio controls should be visible",
    );
    assertInvariant(
      report.transcriptVisible,
      "recent transcript should be visible",
    );
    assertInvariant(
      report.localSttReady,
      "local STT should be ready for mic and system chunks",
    );
    assertInvariant(
      report.rawImageBytesRetained === false,
      "raw image bytes must stay transient",
    );
    assertInvariant(
      report.popupTypedSendWorked,
      "popup typed send should work",
    );
    assertInvariant(
      report.popupClipboardWorked,
      "answer and transcript copy controls should work",
    );
    assertInvariant(
      report.popupHideAndReopenWorked,
      "answer popup should hide and reopen from visible controls",
    );
    assertInvariant(report.popupResized, "answer popup should be resizable");
    assertInvariant(
      report.popupBoundsRestored,
      "resized popup bounds should survive an end/start cycle",
    );

    await window.evaluate(() => {
      document.querySelector("main")?.scrollTo({ top: 0 });
    });
    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04-visible-chat.png"),
    });
    await writeFile(
      path.join(outputDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
  } finally {
    await app.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

await run();
