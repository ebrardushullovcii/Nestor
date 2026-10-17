/* eslint-env node, browser */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(currentDir, "..");
const repoDir = path.resolve(desktopDir, "../..");
const sourceUrl =
  process.env.LIVE_ASSISTANT_LIVE_AUDIO_SOURCE_URL ??
  "https://www.youtube.com/watch?v=J_qCYlqB_MY";
const outputDir = path.join(
  desktopDir,
  "test-artifacts",
  "live-assistant",
  "live-system-audio-podcast",
);
const attachmentPath = path.join(
  repoDir,
  "docs",
  "Design",
  "live-assistant",
  "ChatGPT Image May 13, 2026, 05_37_03 AM (5).png",
);

function assertInvariant(condition, message) {
  if (!condition) {
    throw new Error(`Live Assistant live system-audio test failed: ${message}`);
  }
}

async function getWorkspace(window) {
  return window.evaluate(() => window.nordri.liveAssistant.getWorkspace());
}

async function waitForOverlayWindows(app) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const windows = app
      .windows()
      .filter((candidate) =>
        candidate.url().includes("/live-assistant/overlay/"),
      );
    const visibleOverlayCount = await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter(
          (candidate) =>
            candidate.webContents
              .getURL()
              .includes("/live-assistant/overlay/") && candidate.isVisible(),
        ).length,
    );
    if (windows.length === 2 && visibleOverlayCount === 2) {
      return windows;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    "Timed out waiting for visible answer and transcript popups.",
  );
}

async function waitForMeetingTranscript(
  window,
  minimumCount,
  minimumWordCount = 6,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 150_000) {
    const workspace = await getWorkspace(window);
    const meetingSegments =
      workspace.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === "meeting_audio",
      ) ?? [];
    const wordCount = meetingSegments.reduce(
      (count, segment) =>
        count + segment.text.trim().split(/\s+/u).filter(Boolean).length,
      0,
    );
    if (
      meetingSegments.length >= minimumCount &&
      wordCount >= minimumWordCount
    ) {
      return workspace;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `Timed out waiting for ${minimumWordCount} words of live system-audio transcription.`,
  );
}

function excerpt(text, maximumWords = 18) {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return {
    wordCount: words.length,
    excerpt: words.slice(0, maximumWords).join(" "),
  };
}

async function run() {
  if (process.platform !== "win32") {
    throw new Error(
      "This live loopback acceptance currently requires Windows.",
    );
  }

  await mkdir(outputDir, { recursive: true });
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "nordri-interview-live-system-audio-"),
  );
  const app = await electron.launch({
    args: ["--autoplay-policy=no-user-gesture-required", "."],
    cwd: desktopDir,
    env: {
      ...process.env,
      NORDRI_INTERVIEW_ADVANCED_SURFACES: "1",
      NORDRI_USER_DATA_DIR: userDataDirectory,
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
      .waitFor({ timeout: 15_000 });

    const initialized = await window.evaluate(async (url) => {
      const acceptedAt = new Date().toISOString();
      await window.nordri.liveAssistant.saveSetup({
        consent: {
          microphoneCapture: false,
          meetingAudioCapture: true,
          screenshotCapture: true,
          modelTransmission: true,
          localRetention: true,
          overlayProtectionNotice: true,
          acceptedAt,
        },
        targetContext: {
          kind: "general_interview",
          id: "live_system_audio_podcast",
          label: "Live podcast system-audio rehearsal",
          role: "Interview rehearsal",
          company: "Friends Keep Secrets",
          sourceUrl: url,
          notes:
            "Real Windows loopback acceptance using a public interview-style conversation already playing in Helium.",
          savedJob: null,
          profileSnapshot: null,
          confirmedAt: acceptedAt,
        },
      });
      const rehearsed = await window.nordri.liveAssistant.runRehearsal();
      const started = await window.nordri.liveAssistant.startSession();
      return { rehearsed, started };
    }, sourceUrl);

    assertInvariant(
      initialized.rehearsed.setup.rehearsal?.meetingAudioEngine.ready,
      "meeting/system STT engine should be ready",
    );
    assertInvariant(
      initialized.started.activeSession?.status === "active",
      "a system-audio-only session should start without microphone consent",
    );
    assertInvariant(
      initialized.started.setup.consent.microphoneCapture === false,
      "the test must not enable microphone capture",
    );
    assertInvariant(
      initialized.started.activeSession?.transcriptSegments.length === 0 &&
        initialized.started.activeSession?.cueCards.length === 0,
      "a live session must start without synthetic transcript or cue data",
    );

    await window.reload();
    await window.waitForLoadState("domcontentloaded");
    await window
      .getByRole("heading", {
        name: "Ask, listen, and work through the answer",
      })
      .waitFor({ timeout: 15_000 });

    const overlayWindows = await waitForOverlayWindows(app);
    for (const overlay of overlayWindows) {
      await overlay.waitForLoadState("domcontentloaded");
    }
    const answerOverlay = overlayWindows.find((candidate) =>
      candidate.url().includes("/overlay/answer"),
    );
    const transcriptOverlay = overlayWindows.find((candidate) =>
      candidate.url().includes("/overlay/transcript"),
    );
    assertInvariant(answerOverlay, "answer popup should exist");
    assertInvariant(transcriptOverlay, "transcript popup should exist");

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

    const microphoneButton = window.getByRole("button", {
      name: "Start mic audio",
    });
    const systemButton = window.getByRole("button", {
      name: "Start system audio",
    });
    assertInvariant(
      await microphoneButton.isDisabled(),
      "microphone control should stay disabled without consent",
    );
    assertInvariant(
      !(await systemButton.isDisabled()),
      "system-audio control should be available",
    );

    const initialWorkspace = await getWorkspace(window);
    const initialMeetingCount =
      initialWorkspace.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === "meeting_audio",
      ).length ?? 0;
    const captureStartedAt = Date.now();
    await systemButton.click();
    await window
      .getByText("System audio is recording in transient 5s chunks.", {
        exact: true,
      })
      .waitFor({ timeout: 15_000 });
    const liveAudioWorkspace = await waitForMeetingTranscript(
      window,
      initialMeetingCount + 1,
    );
    const firstTranscriptAt = Date.now();
    await window.getByRole("button", { name: "Stop audio" }).click();
    await window
      .getByText("System audio transcription stopped.", { exact: true })
      .waitFor({ timeout: 15_000 });

    const afterAudioCandidate = await getWorkspace(window);
    const afterAudio =
      (liveAudioWorkspace.activeSession?.transcriptSegments.length ?? 0) >=
      (afterAudioCandidate.activeSession?.transcriptSegments.length ?? 0)
        ? liveAudioWorkspace
        : afterAudioCandidate;
    const meetingSegments =
      afterAudio.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === "meeting_audio",
      ) ?? [];
    const microphoneSegments =
      afterAudio.activeSession?.transcriptSegments.filter(
        (segment) => segment.source === "microphone",
      ) ?? [];
    const transcriptPopupNeedle = meetingSegments
      .at(-1)
      ?.text.trim()
      .split(/\s+/u)
      .slice(0, 3)
      .join(" ");
    assertInvariant(
      transcriptPopupNeedle,
      "a live transcript excerpt should be available for popup verification",
    );

    const cueCountBeforeForce = afterAudio.activeSession?.cueCards.length ?? 0;
    const afterForcedCue = await window.evaluate(() =>
      window.nordri.liveAssistant.performAction("force_cue"),
    );
    assertInvariant(
      (afterForcedCue.activeSession?.cueCards.length ?? 0) >
        cueCountBeforeForce,
      "a manual cue should be generated from live transcript context",
    );

    const composer = window.getByPlaceholder(
      "Ask a question, paste a screenshot, or type what you need help answering…",
    );
    const imageInput = window.locator(
      'input[type="file"][accept*="image/png"]',
    );
    await imageInput.setInputFiles(attachmentPath);
    await window.getByAltText(path.basename(attachmentPath)).waitFor();
    await composer.fill(
      "Using the live transcript and this test screenshot, summarize what was just said and suggest a concise interview response.",
    );
    await window.getByRole("button", { name: /^Send$/ }).click();
    await window.waitForFunction(
      async () => {
        const workspace = await window.nordri.liveAssistant.getWorkspace();
        return (
          (workspace.activeSession?.chatConversation?.messages.length ?? 0) >= 2
        );
      },
      null,
      { timeout: 90_000 },
    );

    await answerOverlay
      .getByText("Question detected", { exact: true })
      .waitFor({ timeout: 30_000 });
    await answerOverlay
      .getByText("Suggested answer", { exact: true })
      .waitFor({ timeout: 30_000 });
    await transcriptOverlay.waitForFunction(
      (needle) => document.body.innerText.includes(needle),
      transcriptPopupNeedle,
      { timeout: 30_000 },
    );

    await window.getByRole("button", { name: "Pause" }).click();
    await window.waitForFunction(async () => {
      const workspace = await window.nordri.liveAssistant.getWorkspace();
      return workspace.activeSession?.listening === false;
    });
    await window.getByRole("button", { name: "Resume", exact: true }).waitFor();
    await window.getByRole("button", { name: "Resume", exact: true }).click();
    await window.waitForFunction(async () => {
      const workspace = await window.nordri.liveAssistant.getWorkspace();
      return workspace.activeSession?.listening === true;
    });
    await window.getByRole("button", { name: "Pause", exact: true }).waitFor();

    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "01-live-session.png"),
    });
    await answerOverlay.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "02-answer-popup.png"),
    });
    await transcriptOverlay.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "03-transcript-popup.png"),
    });

    await window.getByRole("button", { name: "End", exact: true }).click();
    await window.waitForFunction(async () => {
      const workspace = await window.nordri.liveAssistant.getWorkspace();
      return (
        workspace.activeSession === null && workspace.recentSessions.length > 0
      );
    });
    await window.getByRole("button", { name: "Review" }).click();
    await window
      .getByRole("heading", { name: "Post-session review" })
      .waitFor();
    await window.getByRole("button", { name: "Export notes" }).click();
    await window.getByText(/\.md$/u).waitFor({ timeout: 15_000 });

    await window.screenshot({
      animations: "disabled",
      path: path.join(outputDir, "04-post-session-review.png"),
    });

    const finalWorkspace = await getWorkspace(window);
    const finalSession = await window.evaluate(
      (id) => window.nordri.liveAssistant.getSession(id),
      finalWorkspace.recentSessions[0]?.id,
    );
    const finalCue = finalSession?.cueCards.at(-1) ?? null;
    const finalChat = finalSession?.chatConversation;
    const finalMeetingSegments =
      finalSession?.transcriptSegments.filter(
        (segment) => segment.source === "meeting_audio",
      ) ?? [];
    const report = {
      generatedAt: new Date().toISOString(),
      sourceUrl,
      outcome: "passed_live_system_audio_session",
      systemAudioOnly: {
        microphoneCaptureEnabled:
          finalWorkspace.setup.consent.microphoneCapture,
        systemAudioCaptureEnabled:
          finalWorkspace.setup.consent.meetingAudioCapture,
        microphoneTranscriptCount: microphoneSegments.length,
        systemTranscriptCount: finalMeetingSegments.length,
      },
      latency: {
        millisecondsToFirstTranscript: firstTranscriptAt - captureStartedAt,
      },
      transcriptEvidence: finalMeetingSegments.map((segment) => ({
        source: segment.source,
        ...excerpt(segment.text),
        engineKind: segment.engineKind,
      })),
      cueEvidence: finalCue
        ? {
            triggerKind: finalCue.triggerKind,
            question: excerpt(finalCue.question),
            answerOutlineCount: finalCue.answerOutline.length,
            supportingPointCount: finalCue.supportingPoints.length,
            transcriptWindow: finalCue.disclosure.transcriptWindow,
          }
        : null,
      chatEvidence: {
        messageCount: finalChat?.messages.length ?? 0,
        assistantReplyPresent:
          finalChat?.messages.some((message) => message.role === "assistant") ??
          false,
        imageAttachmentPresent:
          finalChat?.messages.some(
            (message) => message.attachments.length > 0,
          ) ?? false,
      },
      popupEvidence: {
        count: popupVisibility.length,
        allVisibleDuringSession: popupVisibility.every(
          (popup) => popup.visible,
        ),
        closedAfterSession:
          app
            .windows()
            .filter((candidate) =>
              candidate.url().includes("/live-assistant/overlay/"),
            ).length === 0,
      },
      lifecycleEvidence: {
        endedSessionRetained: finalSession?.status === "ended",
        exportVisible: (await window.getByText(/\.md$/u).count()) > 0,
      },
      retentionEvidence: {
        rawAudioRetained:
          JSON.stringify(finalWorkspace).includes("audioBase64"),
        rawImageBytesRetained:
          JSON.stringify(finalWorkspace).includes("dataBase64"),
      },
    };

    await writeFile(
      path.join(outputDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );

    assertInvariant(
      finalMeetingSegments.length >= initialMeetingCount + 1,
      "live audio should add a real system-audio transcript segment",
    );
    assertInvariant(
      finalMeetingSegments.some(
        (segment) =>
          !/^\s*(?:>{1,2}\s*)?\[BLANK_AUDIO\]\s*$/iu.test(segment.text),
      ),
      "live audio should contain intelligible speech rather than a non-speech marker",
    );
    assertInvariant(
      report.systemAudioOnly.microphoneTranscriptCount === 0,
      "no microphone transcript should be created",
    );
    assertInvariant(report.cueEvidence, "a grounded cue should be retained");
    assertInvariant(
      report.chatEvidence.assistantReplyPresent,
      "visible chat should produce an assistant reply",
    );
    assertInvariant(
      report.chatEvidence.imageAttachmentPresent,
      "the test image should be attached to the chat turn",
    );
    assertInvariant(
      report.popupEvidence.count === 2 &&
        report.popupEvidence.allVisibleDuringSession,
      "both popup windows should be visible during the session",
    );
    assertInvariant(
      report.popupEvidence.closedAfterSession,
      "popup windows should close when the session ends",
    );
    assertInvariant(
      report.lifecycleEvidence.endedSessionRetained &&
        report.lifecycleEvidence.exportVisible,
      "post-session review and export should work",
    );
    assertInvariant(
      !report.retentionEvidence.rawAudioRetained &&
        !report.retentionEvidence.rawImageBytesRetained,
      "raw audio and image bytes must remain transient",
    );

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await app.close();
    await rm(userDataDirectory, { recursive: true, force: true });
  }
}

await run();
