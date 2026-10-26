/* eslint-env node, browser */
/* global document */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const execFileAsync = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const width = Number.parseInt(process.env.UI_CAPTURE_WIDTH ?? "1440", 10);
const height = Number.parseInt(process.env.UI_CAPTURE_HEIGHT ?? "920", 10);
const runLabel = process.env.UI_CAPTURE_LABEL ?? "live-assistant";
const outputDir = path.join(desktopDir, "test-artifacts", "ui", runLabel);
// Provider mode defaults to deterministic so ambient developer-shell
// credentials can never reach live Live Assistant providers during a
// capture run. Configured/live mode requires the explicit env opt-in below
// and is announced on stdout; it additionally sets
// NESTOR_INTERVIEW_TEST_USE_LIVE_AI=1 because the desktop test API is
// always enabled here and otherwise forces deterministic providers (see
// packages/ai-providers/src/live-assistant.ts).
const PROVIDER_MODE_ENV = "UI_LIVE_ASSISTANT_PROVIDER_MODE";
const INTERVIEW_TEST_LIVE_AI_OPT_IN_ENV = "NESTOR_INTERVIEW_TEST_USE_LIVE_AI";
const requestedProviderMode = process.env[PROVIDER_MODE_ENV] ?? "deterministic";
if (
  requestedProviderMode !== "deterministic" &&
  requestedProviderMode !== "configured"
) {
  throw new Error(
    `Unsupported ${PROVIDER_MODE_ENV} value: ${JSON.stringify(requestedProviderMode)}. Use "deterministic" (default) or "configured".`,
  );
}
const providerMode = requestedProviderMode;
if (providerMode === "configured") {
  console.log(
    `[capture-live-assistant] Configured/live provider mode requested explicitly via ${PROVIDER_MODE_ENV}=configured; setting ${INTERVIEW_TEST_LIVE_AI_OPT_IN_ENV}=1 so Live Assistant may use ambient interview/shared AI credentials despite NESTOR_ENABLE_TEST_API=1.`,
  );
} else {
  console.log(
    "[capture-live-assistant] Deterministic provider mode (default): all interview/shared AI credentials are blanked for this run.",
  );
}
const deterministicProviderEnv = {
  NESTOR_AI_API_KEY: "",
  NESTOR_AI_VISION_API_KEY: "",
  NESTOR_RESUME_VISION_API_KEY: "",
  NESTOR_INTERVIEW_AI_API_KEY: "",
  NESTOR_INTERVIEW_VISION_API_KEY: "",
  NESTOR_INTERVIEW_LOCAL_STT_COMMAND: "",
};
const providerModeAppEnv =
  providerMode === "configured"
    ? { [INTERVIEW_TEST_LIVE_AI_OPT_IN_ENV]: "1" }
    : { [INTERVIEW_TEST_LIVE_AI_OPT_IN_ENV]: "" };

async function writeJson(fileName, value) {
  await writeFile(
    path.join(outputDir, fileName),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function waitForInterviewWorkspace(window) {
  await window.waitForFunction(
    () =>
      document
        .querySelector("h1")
        ?.textContent?.includes("Live interview workspace"),
    undefined,
    { timeout: 15000 },
  );
}

async function getWorkspace(window) {
  return window.evaluate(() => window.nestor.liveAssistant.getWorkspace());
}

async function performInterviewAction(window, action) {
  return window.evaluate(
    (action) => window.nestor.liveAssistant.performAction(action),
    action,
  );
}

function latestDiagnosticDetail(workspace, kind) {
  return (
    workspace.activeSession?.diagnostics
      .filter((diagnostic) => diagnostic.kind === kind)
      .at(-1)?.detail ?? ""
  );
}

async function waitForWorkspace(
  window,
  predicate,
  description,
  timeoutMs = 10000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const workspace = await getWorkspace(window);
    if (await predicate(workspace)) {
      return workspace;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function capture(window, fileName) {
  await window.screenshot({
    animations: "disabled",
    path: path.join(outputDir, fileName),
  });
}

async function createSpeechAudioChunk(input) {
  const ffmpegPath = process.env.NESTOR_FFMPEG_PATH ?? "ffmpeg";
  const filePath = path.join(
    input.directory,
    `${input.name.replace(/[^a-z0-9_-]/gi, "-")}.wav`,
  );

  await execFileAsync(ffmpegPath, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `flite=text='${input.text.replaceAll("'", "")}'`,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-t",
    "5",
    filePath,
  ]);

  return {
    filePath,
    audioBase64: (await readFile(filePath)).toString("base64"),
  };
}

function assertReportInvariant(condition, description) {
  if (!condition) {
    throw new Error(`Live Assistant harness invariant failed: ${description}.`);
  }
}

function assertLiveAssistantReport(report) {
  const requiredTrueFields = [
    "jobFinderApplicationContextApplied",
    "jobFinderSavedJobContextApplied",
    "setupConsentAccepted",
    "simpleStartActionVisible",
    "preSessionAudioTestVisible",
    "preSessionMicCaptionTestVisible",
    "preSessionSystemAudioTestVisible",
    "rehearsalHasLanguageCheck",
    "rehearsalHasEngineFallbackCheck",
    "rehearsalHasCueProviderCheck",
    "rehearsalHasScreenshotCaptureCheck",
    "rehearsalHasScreenshotVisionCheck",
    "rehearsalHasOverlayProtectionCheck",
    "rehearsalHasRetentionDefaultsCheck",
    "microphonePermissionUsesElectron",
    "meetingAudioUsesElectronSourceEnumeration",
    "runtimeOverlayProtectionVerified",
    "activeSessionStarted",
    "micAudioControlsVisible",
    "nativeCaptionWatcherVisible",
    "captionFileWatcherVisible",
    "liveAudioControlsVisible",
    "rendererMicrophoneProbeAvailable",
    "rendererSystemAudioProbeAvailable",
    "liveAudioCaptureControlsVisible",
    "resetOverlayLayoutVisible",
    "answerOverlayExpandedVisible",
    "transcriptOverlayExpandedVisible",
    "overlayInteractionModeEnabled",
    "answerOverlayMovedByDrag",
    "transcriptOverlayMovedByDrag",
    "reconfigurationPausedListening",
    "reconfigurationClosedPaused",
    "diagnosticsPanelVisible",
    "nativeTranscriptIngestionAddedSegment",
    "nativeTranscriptIngestionGeneratedCue",
    "manualQuestionUiGeneratedCue",
    "automaticCueCapturedVisualBatch",
    "automaticCueDisclosedScreenshot",
    "nativeTranscriptHiddenFromMainWindow",
    "screenshotDiagnosticUsesElectronCapture",
    "overlayContaminationDisclosed",
    "panicHideHidAnswerOverlay",
    "panicHideHidTranscriptOverlay",
    "endedSessionRetained",
    "transcriptAnnotationPreservesOriginal",
    "jobFinderMarkedInterviewed",
    "jobFinderFollowUpNoteAdded",
    "exportContainsTranscript",
    "exportContainsTranscriptAnnotations",
    "exportContainsCueCards",
    "prepArtifactCreated",
    "deletedSessionRemoved",
  ];

  for (const field of requiredTrueFields) {
    assertReportInvariant(report[field] === true, `${field} should be true`);
  }

  assertReportInvariant(
    report.setupTranscriptionLanguage === "en-GB" &&
      report.rehearsalTranscriptionLanguage === "en-GB",
    "selected transcription language should persist into rehearsal",
  );
  assertReportInvariant(
    report.setupCueSensitivity === "balanced",
    "cue sensitivity should persist",
  );
  assertReportInvariant(
    report.setupAutoCaptureOnCue === true,
    "automatic screenshot-on-cue preference should persist",
  );
  assertReportInvariant(
    report.rehearsalCheckCount >= 12,
    "full rehearsal checklist should be present",
  );
  if (report.providerMode === "configured") {
    assertReportInvariant(
      report.rehearsalCueProviderDetail?.includes(
        "Configured OpenAI-compatible",
      ),
      "cue provider should use configured OpenAI-compatible shared/interview AI credentials",
    );
    assertReportInvariant(
      report.localSttMicTranscriptAdded === true &&
        report.localSttSystemTranscriptAdded === true,
      "configured local STT should transcribe both microphone and system audio chunks",
    );
  }
  assertReportInvariant(
    report.protectedSurfaceCount === 2,
    "two protected overlay surfaces should be modeled",
  );
  assertReportInvariant(
    report.overlayWindowCountAfterStart === 2,
    "two overlay windows should open after session start",
  );
  assertReportInvariant(
    report.mainWindowMirrorsLiveCue === false &&
      report.mainWindowMirrorsLiveTranscript === false,
    "main window should not mirror live sensitive content",
  );
  assertReportInvariant(
    report.visualCueCardCount >= 2 && report.visualBatchCount >= 2,
    "visual cue and batch evidence should be present",
  );
  if (
    report.rehearsalScreenshotVisionDetail?.includes(
      "Configured OpenAI-compatible",
    )
  ) {
    assertReportInvariant(
      report.visualObservationSources.includes("screenshot"),
      "configured screenshot vision should produce at least one model-backed screenshot observation",
    );
  }
  assertReportInvariant(
    report.panicHideStatus === "panic_hidden",
    "panic-hide should move the session to panic_hidden",
  );
  assertReportInvariant(
    report.endedSessionStatus === "ended",
    "session should end cleanly before post-session review",
  );
  assertReportInvariant(
    report.transcriptAnnotationCount >= 1,
    "transcript annotation should be retained",
  );
}

async function waitForOverlayWindows(app) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    const overlayWindows = app
      .windows()
      .filter((appWindow) =>
        appWindow.url().includes("/live-assistant/overlay/"),
      );
    if (overlayWindows.length === 2) {
      return overlayWindows;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error("Timed out waiting for two Live Assistant overlay windows.");
}

async function getOverlayWindowBounds(app, routePart) {
  return app.evaluate(({ BrowserWindow }, routePart) => {
    const targetWindow = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes(routePart),
    );
    if (!targetWindow) {
      return null;
    }

    return targetWindow.getBounds();
  }, routePart);
}

async function runCapture() {
  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nestor-live-assistant-"),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: desktopDir,
    env: {
      ...process.env,
      ...(providerMode === "deterministic" ? deterministicProviderEnv : {}),
      ...providerModeAppEnv,
      NESTOR_ENABLE_TEST_API: "1",
      NESTOR_TEST_SYSTEM_THEME: process.env.NESTOR_TEST_SYSTEM_THEME ?? "dark",
      NESTOR_USER_DATA_DIR: userDataDirectory,
    },
  });

  try {
    const window = await app.firstWindow();

    await window.waitForLoadState("domcontentloaded");
    await waitForInterviewWorkspace(window);
    await window.setViewportSize({ width, height });
    const jobFinderApplicationRecord = await window.evaluate(async () => {
      if (!window.nestor.jobFinder.test) {
        throw new Error(
          "Expected Job Finder test API for Live Assistant harness.",
        );
      }

      // An application in Applications, on the job store: the interview
      // write-back lands there as a tracker event on that job.
      const { approvedIds } =
        await window.nestor.jobFinder.test.loadApplicationsStoreDemo({
          sourceUrl: "http://127.0.0.1/",
          trackApplications: true,
        });
      const jobId = approvedIds[0];
      const application = await window.nestor.tracker.run("get_application", {
        jobId,
      });
      if (!application) {
        throw new Error("Expected an Applications row for the demo job.");
      }
      return {
        id: String(jobId),
        title: application.job.title,
        company: application.job.company,
      };
    });

    const linkedJobContext = {
      id: "job_ready",
      label: `${jobFinderApplicationRecord.title} at ${jobFinderApplicationRecord.company}`,
      role: jobFinderApplicationRecord.title,
      company: jobFinderApplicationRecord.company,
      sourceUrl: "https://www.linkedin.com/jobs/view/linkedin_signal_ready",
      notes: "React, Electron, and desktop accessibility interview context.",
    };
    const applicationContext = {
      id: jobFinderApplicationRecord.id,
      label: `${jobFinderApplicationRecord.title} at ${jobFinderApplicationRecord.company}`,
      role: jobFinderApplicationRecord.title,
      company: jobFinderApplicationRecord.company,
      sourceUrl:
        "https://www.linkedin.com/jobs/view/linkedin_signal_ready/apply",
      notes:
        "Application interview scheduled. Prepare React, Electron, and accessibility examples.",
    };
    const applicationParams = new URLSearchParams({
      source: "job_application",
      id: applicationContext.id,
      label: applicationContext.label,
      role: applicationContext.role,
      company: applicationContext.company,
      sourceUrl: applicationContext.sourceUrl,
      notes: applicationContext.notes,
    });
    await window.evaluate((query) => {
      window.location.hash = `/live-assistant?${query}`;
    }, applicationParams.toString());
    const applicationWorkspace = await waitForWorkspace(
      window,
      (workspace) =>
        workspace.setup.targetContext?.kind === "job_application" &&
        workspace.setup.targetContext.id === jobFinderApplicationRecord.id,
      "application record context handoff into Live Assistant setup",
    );
    const linkedJobParams = new URLSearchParams({
      source: "saved_job",
      id: linkedJobContext.id,
      label: linkedJobContext.label,
      role: linkedJobContext.role,
      company: linkedJobContext.company,
      sourceUrl: linkedJobContext.sourceUrl,
      notes: linkedJobContext.notes,
    });
    await window.evaluate((query) => {
      window.location.hash = `/live-assistant?${query}`;
    }, linkedJobParams.toString());
    const linkedJobWorkspace = await waitForWorkspace(
      window,
      (workspace) =>
        workspace.setup.targetContext?.kind === "saved_job" &&
        workspace.setup.targetContext.id === "job_ready",
      "saved job context handoff into Live Assistant setup",
    );
    await window.evaluate((query) => {
      window.location.hash = `/live-assistant?${query}`;
    }, applicationParams.toString());
    await waitForWorkspace(
      window,
      (workspace) =>
        workspace.setup.targetContext?.kind === "job_application" &&
        workspace.setup.targetContext.id === jobFinderApplicationRecord.id,
      "application record context restored for Live Assistant session",
    );

    await capture(window, "01-setup.png");

    await window
      .getByLabel("Live Assistant sections")
      .getByRole("button", { name: /^Settings$/i })
      .click();
    await window
      .getByRole("combobox", { name: /Transcript language/i })
      .click();
    await window.getByRole("option", { name: "English UK" }).click();
    await waitForWorkspace(
      window,
      (workspace) => workspace.setup.transcriptionLanguage === "en-GB",
      "saved Live Assistant transcription language",
    );
    await window.getByRole("combobox", { name: /Cue sensitivity/i }).click();
    await window.getByRole("option", { name: "Balanced" }).click();
    await waitForWorkspace(
      window,
      (workspace) => workspace.setup.cueSensitivity === "balanced",
      "saved Live Assistant cue sensitivity",
    );
    await window
      .getByLabel(/Auto screenshot on cue/i)
      .waitFor({ state: "visible" });
    await window.waitForFunction(() => {
      const checkbox = document.querySelector('input[type="checkbox"]');
      return checkbox && !checkbox.disabled;
    });
    const autoScreenshotChecked = await window
      .getByLabel(/Auto screenshot on cue/i)
      .isChecked();
    if (!autoScreenshotChecked) {
      await window.getByLabel(/Auto screenshot on cue/i).click();
    }
    await waitForWorkspace(
      window,
      (workspace) => workspace.setup.autoCaptureOnCue === true,
      "saved Live Assistant automatic screenshot preference",
    );

    await window.getByRole("button", { name: /^Setup/i }).click();
    await window.getByRole("button", { name: /Allow and continue/i }).click();
    await waitForWorkspace(
      window,
      (workspace) => Boolean(workspace.setup.consent.acceptedAt),
      "accepted Live Assistant setup disclosures",
    );
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await waitForInterviewWorkspace(window);
    await window.getByRole("button", { name: /^Setup/i }).click();

    const allowAgainButton = window.getByRole("button", {
      name: /Allow and continue/i,
    });
    if ((await allowAgainButton.count()) > 0) {
      await allowAgainButton.click();
      await waitForWorkspace(
        window,
        (workspace) => Boolean(workspace.setup.consent.acceptedAt),
        "accepted Live Assistant setup disclosures after reload",
      );
    }

    const quickCheckButton = window.getByRole("button", {
      name: /Run quick check/i,
    });
    let quickCheckClicked = false;
    if ((await quickCheckButton.count()) > 0) {
      await quickCheckButton.click();
      quickCheckClicked = true;
    }
    let rehearsedWorkspace = await getWorkspace(window);
    if (
      quickCheckClicked &&
      rehearsedWorkspace.setup.rehearsal?.status !== "passed" &&
      rehearsedWorkspace.setup.rehearsal?.status !== "degraded"
    ) {
      rehearsedWorkspace = await waitForWorkspace(
        window,
        (workspace) =>
          workspace.setup.rehearsal?.status === "passed" ||
          workspace.setup.rehearsal?.status === "degraded",
        "Live Assistant rehearsal results",
      );
    }
    await capture(window, "02-rehearsed.png");
    await window
      .getByText("Test audio before starting", { exact: true })
      .waitFor({ timeout: 10000 });
    const preSessionAudioTestVisible =
      (await window
        .getByText("Test audio before starting", { exact: true })
        .count()) > 0;
    const preSessionMicCaptionTestVisible =
      (await window
        .getByRole("button", { name: /Test mic captions/i })
        .count()) > 0;
    const preSessionSystemAudioTestVisible =
      (await window.getByRole("button", { name: /Test system/i }).count()) > 0;

    const preStartWorkspace = await getWorkspace(window);
    if (!preStartWorkspace.activeSession) {
      await window.getByRole("button", { name: /Start interview/i }).click();
    }
    await window
      .getByText("Listening", { exact: true })
      .first()
      .waitFor({ timeout: 10000 });
    await window
      .getByText("Native captions", { exact: true })
      .first()
      .waitFor({ timeout: 10000 });
    await window
      .getByRole("button", { name: /Watch captions/i })
      .waitFor({ timeout: 10000 });
    await window
      .getByText("Caption file", { exact: true })
      .waitFor({ timeout: 10000 });
    await window
      .getByRole("button", { name: /Watch file/i })
      .waitFor({ timeout: 10000 });
    await window
      .getByText("Live audio", { exact: true })
      .waitFor({ timeout: 10000 });
    await window
      .getByRole("button", { name: /Start mic audio/i })
      .waitFor({ timeout: 10000 });
    await window
      .getByRole("button", { name: /Start system audio/i })
      .waitFor({ timeout: 10000 });
    const activeWorkspace = await getWorkspace(window);
    if (
      rehearsedWorkspace.setup.rehearsal?.status !== "passed" &&
      rehearsedWorkspace.setup.rehearsal?.status !== "degraded"
    ) {
      rehearsedWorkspace = activeWorkspace;
    }
    const mainWindowTextDuringLive = await window.evaluate(
      () => document.body.innerText,
    );
    const micAudioControlsVisible =
      (await window.getByRole("button", { name: /Start mic audio/i }).count()) >
      0;
    const nativeCaptionWatcherVisible =
      mainWindowTextDuringLive.includes("Native captions");
    const captionFileWatcherVisible =
      mainWindowTextDuringLive.includes("Caption file");
    const liveAudioControlsVisible =
      mainWindowTextDuringLive.includes("Live audio");
    const liveAudioCaptureControlsVisible =
      (await window.getByRole("button", { name: /Start mic audio/i }).count()) >
        0 &&
      (await window
        .getByRole("button", { name: /Start system audio/i })
        .count()) > 0;
    await window.getByRole("button", { name: /Test mic/i }).click();
    await window
      .getByText(/available: Temporary microphone stream opened/i)
      .waitFor({ timeout: 10000 });
    await window.getByRole("button", { name: /Test system/i }).click();
    await window
      .getByText(/available: Temporary display stream exposed/i)
      .waitFor({ timeout: 10000 });
    const liveAudioProbeText = await window.evaluate(
      () => document.body.innerText,
    );
    let localSttMicWorkspace = activeWorkspace;
    let localSttSystemWorkspace = activeWorkspace;
    if (providerMode === "configured" && activeWorkspace.activeSession) {
      const micChunk = await createSpeechAudioChunk({
        directory: userDataDirectory,
        name: "mic-local-stt",
        text: "candidate microphone transcription check",
      });
      const systemChunk = await createSpeechAudioChunk({
        directory: userDataDirectory,
        name: "system-local-stt",
        text: "interviewer system audio transcription check",
      });
      localSttMicWorkspace = await window.evaluate(
        ({ sessionId, audioBase64 }) =>
          window.nestor.liveAssistant.transcribeAudioChunk({
            sessionId,
            source: "microphone",
            mimeType: "audio/wav",
            audioBase64,
            language: "en-US",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          }),
        {
          sessionId: activeWorkspace.activeSession.id,
          audioBase64: micChunk.audioBase64,
        },
      );
      localSttSystemWorkspace = await window.evaluate(
        ({ sessionId, audioBase64 }) =>
          window.nestor.liveAssistant.transcribeAudioChunk({
            sessionId,
            source: "meeting_audio",
            mimeType: "audio/wav",
            audioBase64,
            language: "en-US",
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          }),
        {
          sessionId: activeWorkspace.activeSession.id,
          audioBase64: systemChunk.audioBase64,
        },
      );
    }
    const resetOverlayLayoutVisible =
      (await window
        .getByRole("button", { name: /Reset overlay layout/i })
        .count()) > 0;
    await window.getByRole("button", { name: /Reconfigure/i }).click();
    const reconfiguringWorkspace = await waitForWorkspace(
      window,
      (workspace) =>
        workspace.activeSession?.status === "reconfiguring" &&
        workspace.activeSession.listening === false,
      "Live Assistant paused reconfiguration flow",
    );
    await window.getByRole("button", { name: /Close config/i }).click();
    const reconfigurationClosedWorkspace = await waitForWorkspace(
      window,
      (workspace) =>
        workspace.activeSession?.status === "paused" &&
        workspace.activeSession.listening === false,
      "Live Assistant closed reconfiguration flow",
    );
    await window.getByRole("button", { name: /Resume/i }).click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterResumeClickWorkspace = await getWorkspace(window);
    if (
      afterResumeClickWorkspace.activeSession?.status !== "active" ||
      afterResumeClickWorkspace.activeSession.listening !== true
    ) {
      await performInterviewAction(window, "toggle_listening");
    }
    await waitForWorkspace(
      window,
      (workspace) =>
        workspace.activeSession?.status === "active" &&
        workspace.activeSession.listening === true,
      "Live Assistant resumed after reconfiguration",
    );
    await window.getByRole("button", { name: /Diagnostics/i }).click();
    await window
      .getByRole("heading", { name: "Diagnostics" })
      .waitFor({ timeout: 10000 });
    const diagnosticsPanelVisible =
      (await window.getByText("Interview live session started").count()) > 0;
    const liveCueQuestion =
      activeWorkspace.activeSession?.cueCards.at(-1)?.question ?? "";
    const liveTranscriptTexts =
      activeWorkspace.activeSession?.transcriptSegments.map(
        (segment) => segment.text,
      ) ?? [];
    const mainWindowMirrorsLiveCue =
      liveCueQuestion.length > 0 &&
      mainWindowTextDuringLive.includes(liveCueQuestion);
    const mainWindowMirrorsLiveTranscript = liveTranscriptTexts.some(
      (segmentText) =>
        segmentText.length > 0 &&
        mainWindowTextDuringLive.includes(segmentText),
    );
    const overlayWindows = await waitForOverlayWindows(app);
    for (const overlayWindow of overlayWindows) {
      await overlayWindow.waitForLoadState("domcontentloaded");
      await overlayWindow.setViewportSize({ width: 560, height: 380 });
    }
    await capture(window, "03-active-session.png");
    const answerOverlayWindow = overlayWindows.find((appWindow) =>
      appWindow.url().includes("/live-assistant/overlay/answer"),
    );
    const transcriptOverlayWindow = overlayWindows.find((appWindow) =>
      appWindow.url().includes("/live-assistant/overlay/transcript"),
    );
    if (!answerOverlayWindow || !transcriptOverlayWindow) {
      throw new Error("Expected answer and transcript overlay windows.");
    }
    await capture(answerOverlayWindow, "03-answer-overlay-window.png");
    await capture(transcriptOverlayWindow, "03-transcript-overlay-window.png");
    const answerOverlayText = await answerOverlayWindow.evaluate(
      () => document.body.innerText,
    );
    const transcriptOverlayText = await transcriptOverlayWindow.evaluate(
      () => document.body.innerText,
    );
    const answerOverlayExpandedVisible = answerOverlayText
      .toLowerCase()
      .includes("expanded");
    const transcriptOverlayExpandedVisible = transcriptOverlayText
      .toLowerCase()
      .includes("expanded");

    await window.getByRole("button", { name: /^Verify$/i }).click();
    const runtimeProtectionWorkspace = await waitForWorkspace(
      window,
      (workspace) =>
        Boolean(
          workspace.activeSession?.protectedSurfaces.some(
            (surface) => surface.protectionState !== "requested_unverified",
          ),
        ),
      "runtime overlay protection verification",
    );

    const answerBoundsBeforeMove = await getOverlayWindowBounds(
      app,
      "/live-assistant/overlay/answer",
    );
    const transcriptBoundsBeforeMove = await getOverlayWindowBounds(
      app,
      "/live-assistant/overlay/transcript",
    );
    await window.getByRole("button", { name: /^Move$/i }).click();
    const interactionWorkspace = await waitForWorkspace(
      window,
      (workspace) =>
        workspace.answerOverlay.interactionMode &&
        workspace.transcriptOverlay.interactionMode,
      "overlay interaction mode enabled",
    );
    await answerOverlayWindow.waitForLoadState("domcontentloaded");
    await answerOverlayWindow
      .locator("header")
      .waitFor({ state: "visible", timeout: 10000 });
    await answerOverlayWindow.mouse.move(120, 20);
    await answerOverlayWindow.mouse.down();
    await answerOverlayWindow.mouse.move(230, 85, { steps: 12 });
    await answerOverlayWindow.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const answerBoundsAfterMove = await getOverlayWindowBounds(
      app,
      "/live-assistant/overlay/answer",
    );
    const answerOverlayMovedByDrag = Boolean(
      answerBoundsBeforeMove &&
      answerBoundsAfterMove &&
      (Math.abs(answerBoundsAfterMove.x - answerBoundsBeforeMove.x) >= 20 ||
        Math.abs(answerBoundsAfterMove.y - answerBoundsBeforeMove.y) >= 20),
    );
    await transcriptOverlayWindow.waitForLoadState("domcontentloaded");
    await transcriptOverlayWindow
      .locator("header")
      .waitFor({ state: "visible", timeout: 10000 });
    await transcriptOverlayWindow.mouse.move(120, 20);
    await transcriptOverlayWindow.mouse.down();
    await transcriptOverlayWindow.mouse.move(230, 85, { steps: 12 });
    await transcriptOverlayWindow.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const transcriptBoundsAfterMove = await getOverlayWindowBounds(
      app,
      "/live-assistant/overlay/transcript",
    );
    const transcriptOverlayMovedByDrag = Boolean(
      transcriptBoundsBeforeMove &&
      transcriptBoundsAfterMove &&
      (Math.abs(transcriptBoundsAfterMove.x - transcriptBoundsBeforeMove.x) >=
        20 ||
        Math.abs(transcriptBoundsAfterMove.y - transcriptBoundsBeforeMove.y) >=
          20),
    );
    await window.getByRole("button", { name: /Finish move/i }).click();
    await waitForWorkspace(
      window,
      (workspace) =>
        !workspace.answerOverlay.interactionMode &&
        !workspace.transcriptOverlay.interactionMode,
      "overlay interaction mode disabled after drag",
    );
    await answerOverlayWindow.waitForLoadState("domcontentloaded");

    const nativeTranscriptText =
      "How would you keep Electron overlay IPC isolated from the main app?";
    await window
      .getByPlaceholder(/interviewer question/i)
      .fill(nativeTranscriptText);
    await window.getByRole("button", { name: /Send question/i }).click();
    const nativeTranscriptWorkspace = await waitForWorkspace(
      window,
      (workspace) =>
        workspace.activeSession?.transcriptSegments.some(
          (segment) =>
            segment.source === "meeting_native_transcript" &&
            segment.text === nativeTranscriptText &&
            segment.engineKind === "platform_local",
        ) === true &&
        workspace.activeSession.cueCards.some(
          (cue) => cue.question === nativeTranscriptText,
        ),
      "manual question ingestion and cue generation through the Assist UI",
      45000,
    );
    const mainWindowTextAfterNativeTranscript = await window.evaluate(
      () => document.body.innerText,
    );

    const visualWorkspace = await performInterviewAction(
      window,
      "capture_screenshot_and_force_cue",
    );
    const screenshotDiagnosticDetail = latestDiagnosticDetail(
      visualWorkspace,
      "screenshot",
    );
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await waitForInterviewWorkspace(window);
    await window.setViewportSize({ width, height });
    await capture(window, "04-visual-cue.png");

    const panicWorkspace = await performInterviewAction(window, "panic_hide");
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await waitForInterviewWorkspace(window);
    await window.setViewportSize({ width, height });
    await capture(window, "05-panic-hidden.png");

    const endedWorkspace = await performInterviewAction(window, "end_session");
    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await waitForInterviewWorkspace(window);
    await window.setViewportSize({ width, height });
    await capture(window, "06-post-session-review.png");

    const endedSession = endedWorkspace.recentSessions[0];
    if (!endedSession) {
      throw new Error(
        "Expected an ended Live Assistant session in recentSessions.",
      );
    }

    await window
      .getByPlaceholder(/Add a correction or review note/i)
      .fill("Correction: the interviewer asked about Electron IPC isolation.");
    await window.getByRole("button", { name: /Save annotation/i }).click();
    const annotatedWorkspace = await waitForWorkspace(
      window,
      async (workspace) => {
        const sessionId = workspace.recentSessions[0]?.id;
        if (!sessionId) return false;
        const session = await window.evaluate(
          (id) => window.nestor.liveAssistant.getSession(id),
          sessionId,
        );
        return (session?.transcriptAnnotations.length ?? 0) > 0;
      },
      "saved transcript annotation",
    );
    const annotatedSession = await window.evaluate(
      (id) => window.nestor.liveAssistant.getSession(id),
      annotatedWorkspace.recentSessions[0]?.id,
    );
    if (!annotatedSession) {
      throw new Error(
        "Expected an annotated Live Assistant session in recentSessions.",
      );
    }

    const exportResult = await window.evaluate(
      ({ sessionId, format }) =>
        window.nestor.liveAssistant.exportSession(sessionId, format),
      { sessionId: annotatedSession.id, format: "markdown" },
    );
    const artifactWorkspace = await window.evaluate(
      ({ sessionId, cueCardId }) =>
        window.nestor.liveAssistant.saveCueAsPrepArtifact({
          sessionId,
          cueCardId,
        }),
      {
        sessionId: annotatedSession.id,
        cueCardId: annotatedSession.cueCards.at(-1)?.id,
      },
    );
    await window.getByRole("button", { name: /Mark interviewed/i }).click();
    await window
      .getByPlaceholder(/Follow-up note/i)
      .fill(
        "Send availability and a short thank-you note after the interview.",
      );
    await window.getByRole("button", { name: /Add follow-up/i }).click();
    await window
      .getByText("Job Finder follow-up note added.", { exact: true })
      .waitFor({
        timeout: 10000,
      });
    const writeBackApplicationRecord = await window.evaluate(
      (jobId) => window.nestor.tracker.run("get_application", { jobId }),
      Number(jobFinderApplicationRecord.id),
    );
    await window.evaluate(
      (sessionId) => window.nestor.liveAssistant.deleteSession(sessionId),
      annotatedSession.id,
    );
    const deletedWorkspace = await getWorkspace(window);
    await window.getByRole("button", { name: /^Setup/i }).click();

    const report = {
      generatedAt: new Date().toISOString(),
      providerMode,
      viewport: { width, height },
      screenshots: [
        "01-setup.png",
        "02-rehearsed.png",
        "03-active-session.png",
        "03-answer-overlay-window.png",
        "03-transcript-overlay-window.png",
        "04-visual-cue.png",
        "05-panic-hidden.png",
        "06-post-session-review.png",
      ],
      rehearsalStatus: rehearsedWorkspace.setup.rehearsal?.status,
      jobFinderApplicationContextApplied:
        applicationWorkspace.setup.targetContext?.label ===
          applicationContext.label &&
        applicationWorkspace.setup.targetContext?.role ===
          applicationContext.role &&
        applicationWorkspace.setup.targetContext?.company ===
          applicationContext.company,
      jobFinderSavedJobContextApplied:
        linkedJobWorkspace.setup.targetContext?.label ===
          linkedJobContext.label &&
        linkedJobWorkspace.setup.targetContext?.role ===
          linkedJobContext.role &&
        linkedJobWorkspace.setup.targetContext?.company ===
          linkedJobContext.company,
      setupConsentAccepted: Boolean(
        rehearsedWorkspace.setup.consent.acceptedAt,
      ),
      preSessionAudioTestVisible,
      preSessionMicCaptionTestVisible,
      preSessionSystemAudioTestVisible,
      setupTranscriptionLanguage:
        rehearsedWorkspace.setup.transcriptionLanguage,
      rehearsalTranscriptionLanguage:
        rehearsedWorkspace.setup.rehearsal?.language,
      setupCueSensitivity: rehearsedWorkspace.setup.cueSensitivity,
      setupAutoCaptureOnCue: rehearsedWorkspace.setup.autoCaptureOnCue,
      simpleStartActionVisible:
        (await window
          .getByRole("button", { name: /Start interview/i })
          .count()) > 0,
      rehearsalCheckCount:
        rehearsedWorkspace.setup.rehearsal?.checks.length ?? 0,
      rehearsalCheckIds:
        rehearsedWorkspace.setup.rehearsal?.checks.map((check) => check.id) ??
        [],
      rehearsalHasLanguageCheck:
        rehearsedWorkspace.setup.rehearsal?.checks.some(
          (check) =>
            check.id === "transcription_language" &&
            check.status === "available",
        ) ?? false,
      rehearsalHasEngineFallbackCheck:
        rehearsedWorkspace.setup.rehearsal?.checks.some(
          (check) =>
            check.id === "transcription_engine_fallback" &&
            check.status === "available",
        ) ?? false,
      rehearsalHasCueProviderCheck:
        rehearsedWorkspace.setup.rehearsal?.checks.some(
          (check) =>
            check.id === "cue_card_provider" && check.status === "available",
        ) ?? false,
      rehearsalCueProviderDetail:
        rehearsedWorkspace.setup.rehearsal?.checks.find(
          (check) => check.id === "cue_card_provider",
        )?.detail ?? null,
      rehearsalHasScreenshotCaptureCheck:
        rehearsedWorkspace.setup.rehearsal?.checks.some(
          (check) =>
            check.id === "screenshot_capture" && check.status === "available",
        ) ?? false,
      rehearsalHasScreenshotVisionCheck:
        rehearsedWorkspace.setup.rehearsal?.checks.some(
          (check) =>
            check.id === "screenshot_vision" && check.status === "available",
        ) ?? false,
      rehearsalScreenshotVisionDetail:
        rehearsedWorkspace.setup.rehearsal?.checks.find(
          (check) => check.id === "screenshot_vision",
        )?.detail ?? null,
      rehearsalHasOverlayProtectionCheck:
        rehearsedWorkspace.setup.rehearsal?.checks.some(
          (check) =>
            check.id === "overlay_capture_protection" &&
            ["available", "degraded"].includes(check.status),
        ) ?? false,
      rehearsalHasRetentionDefaultsCheck:
        rehearsedWorkspace.setup.rehearsal?.checks.some(
          (check) =>
            check.id === "retention_defaults" && check.status === "available",
        ) ?? false,
      audioCapabilityChecks:
        rehearsedWorkspace.setup.rehearsal?.checks
          .filter(
            (check) =>
              check.id === "microphone_audio" || check.id === "meeting_audio",
          )
          .map((check) => ({
            id: check.id,
            status: check.status,
            detail: check.detail,
          })) ?? [],
      microphonePermissionUsesElectron:
        rehearsedWorkspace.setup.rehearsal?.checks
          .find((check) => check.id === "microphone_audio")
          ?.detail?.includes("Electron systemPreferences") ?? false,
      meetingAudioUsesElectronSourceEnumeration:
        rehearsedWorkspace.setup.rehearsal?.checks
          .find((check) => check.id === "meeting_audio")
          ?.detail?.includes("Electron desktopCapturer") ?? false,
      protectedSurfaceCount:
        rehearsedWorkspace.setup.rehearsal?.protectedSurfaces.length ?? 0,
      protectedSurfaceStates:
        rehearsedWorkspace.setup.rehearsal?.protectedSurfaces.map(
          (surface) => ({
            kind: surface.kind,
            protectionState: surface.protectionState,
            verificationMethod: surface.verificationMethod,
          }),
        ) ?? [],
      runtimeOverlayProtectionStates:
        runtimeProtectionWorkspace.activeSession?.protectedSurfaces.map(
          (surface) => ({
            kind: surface.kind,
            protectionState: surface.protectionState,
            verificationMethod: surface.verificationMethod,
            detail: surface.detail,
          }),
        ) ?? [],
      runtimeOverlayProtectionVerified:
        (runtimeProtectionWorkspace.activeSession?.protectedSurfaces.length ===
          2 &&
          runtimeProtectionWorkspace.activeSession.protectedSurfaces.every(
            (surface) => surface.protectionState === "verified_protected",
          )) ??
        false,
      activeSessionStarted: activeWorkspace.activeSession?.status === "active",
      mainWindowMirrorsLiveCue,
      mainWindowMirrorsLiveTranscript,
      overlayWindowCountAfterStart: overlayWindows.length,
      overlayWindowRoutesAfterStart: overlayWindows.map((appWindow) =>
        appWindow.url(),
      ),
      answerOverlayExpandedVisible,
      transcriptOverlayExpandedVisible,
      overlayInteractionModeEnabled:
        interactionWorkspace.answerOverlay.interactionMode &&
        interactionWorkspace.transcriptOverlay.interactionMode,
      answerOverlayMovedByDrag,
      transcriptOverlayMovedByDrag,
      transcriptSegmentCount:
        activeWorkspace.activeSession?.transcriptSegments.length ?? 0,
      initialCueCardCount: activeWorkspace.activeSession?.cueCards.length ?? 0,
      micAudioControlsVisible,
      nativeCaptionWatcherVisible,
      captionFileWatcherVisible,
      liveAudioControlsVisible,
      rendererMicrophoneProbeAvailable: liveAudioProbeText.includes(
        "available: Temporary microphone stream opened",
      ),
      rendererSystemAudioProbeAvailable: liveAudioProbeText.includes(
        "available: Temporary display stream exposed",
      ),
      liveAudioCaptureControlsVisible,
      localSttMicTranscriptAdded:
        localSttMicWorkspace.activeSession?.transcriptSegments.some(
          (segment) =>
            segment.source === "microphone" &&
            segment.engineKind === "local_model" &&
            segment.text.trim().length > 0,
        ) ?? false,
      localSttSystemTranscriptAdded:
        localSttSystemWorkspace.activeSession?.transcriptSegments.some(
          (segment) =>
            segment.source === "meeting_audio" &&
            segment.engineKind === "local_model" &&
            segment.text.trim().length > 0,
        ) ?? false,
      localSttMicTranscriptText:
        localSttMicWorkspace.activeSession?.transcriptSegments
          .filter(
            (segment) =>
              segment.source === "microphone" &&
              segment.engineKind === "local_model",
          )
          .at(-1)?.text ?? null,
      localSttSystemTranscriptText:
        localSttSystemWorkspace.activeSession?.transcriptSegments
          .filter(
            (segment) =>
              segment.source === "meeting_audio" &&
              segment.engineKind === "local_model",
          )
          .at(-1)?.text ?? null,
      resetOverlayLayoutVisible,
      reconfigurationPausedListening:
        reconfiguringWorkspace.activeSession?.status === "reconfiguring" &&
        reconfiguringWorkspace.activeSession.listening === false,
      reconfigurationClosedPaused:
        reconfigurationClosedWorkspace.activeSession?.status === "paused" &&
        reconfigurationClosedWorkspace.activeSession.listening === false,
      diagnosticsPanelVisible,
      nativeTranscriptIngestionAddedSegment:
        nativeTranscriptWorkspace.activeSession?.transcriptSegments.some(
          (segment) =>
            segment.source === "meeting_native_transcript" &&
            segment.text === nativeTranscriptText &&
            segment.engineKind === "platform_local",
        ) ?? false,
      nativeTranscriptIngestionGeneratedCue:
        nativeTranscriptWorkspace.activeSession?.cueCards.some(
          (cue) => cue.question === nativeTranscriptText,
        ) ?? false,
      manualQuestionUiGeneratedCue:
        nativeTranscriptWorkspace.activeSession?.cueCards.some(
          (cue) => cue.question === nativeTranscriptText,
        ) ?? false,
      automaticCueCapturedVisualBatch:
        (nativeTranscriptWorkspace.activeSession?.visualBatches.length ?? 0) >
        0,
      automaticCueDisclosedScreenshot:
        nativeTranscriptWorkspace.activeSession?.cueCards.find(
          (cue) => cue.question === nativeTranscriptText,
        )?.disclosure.screenshotCount === 1,
      nativeTranscriptHiddenFromMainWindow:
        !mainWindowTextAfterNativeTranscript.includes(nativeTranscriptText),
      visualCueCardCount: visualWorkspace.activeSession?.cueCards.length ?? 0,
      visualBatchCount:
        visualWorkspace.activeSession?.visualBatches.length ?? 0,
      visualObservationSources:
        visualWorkspace.activeSession?.visualBatches.flatMap((batch) =>
          batch.observations.map((observation) => observation.source),
        ) ?? [],
      screenshotDiagnosticDetail,
      screenshotDiagnosticUsesElectronCapture:
        screenshotDiagnosticDetail.includes("Electron desktopCapturer") &&
        screenshotDiagnosticDetail.includes("discarded"),
      overlayContaminationDisclosed:
        visualWorkspace.activeSession?.cueCards.at(-1)?.disclosure
          .overlayContaminated ?? false,
      panicHideStatus: panicWorkspace.activeSession?.status,
      panicHideHidAnswerOverlay: panicWorkspace.answerOverlay.visible === false,
      panicHideHidTranscriptOverlay:
        panicWorkspace.transcriptOverlay.visible === false,
      endedSessionStatus: endedSession.status,
      endedSessionRetained: endedWorkspace.recentSessions.some(
        (session) => session.id === endedSession.id,
      ),
      transcriptAnnotationCount: annotatedSession.transcriptAnnotations.length,
      transcriptAnnotationPreservesOriginal:
        annotatedSession.transcriptAnnotations[0]?.originalText ===
        annotatedSession.transcriptSegments[0]?.text,
      jobFinderMarkedInterviewed:
        writeBackApplicationRecord?.row.status === "interview",
      jobFinderFollowUpNoteAdded:
        writeBackApplicationRecord?.events.some(
          (event) =>
            event.title === "Interview follow-up note" &&
            (event.body ?? "").includes("thank-you note"),
        ) ?? false,
      exportFileName: exportResult.fileName,
      exportContainsTranscript: exportResult.content.includes("## Transcript"),
      exportContainsTranscriptAnnotations: exportResult.content.includes(
        "## Transcript Annotations",
      ),
      exportContainsCueCards: exportResult.content.includes("## Cue Cards"),
      prepArtifactCreated: artifactWorkspace.setup.prepArtifacts.some(
        (artifact) => artifact.sourceSessionId === annotatedSession.id,
      ),
      deletedSessionRemoved:
        !deletedWorkspace.activeSession &&
        !deletedWorkspace.recentSessions.some(
          (session) => session.id === annotatedSession.id,
        ),
    };

    await writeJson("live-assistant-report.json", report);
    assertLiveAssistantReport(report);
  } finally {
    await app.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }

  process.stdout.write(`Saved Live Assistant UI captures to ${outputDir}\n`);
}

void runCapture();
