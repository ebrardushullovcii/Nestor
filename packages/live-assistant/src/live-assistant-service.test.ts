import { describe, expect, test } from "vitest";

import {
  createLiveAssistantService,
  type InterviewCueCardProvider,
  type LiveAssistantRepository,
} from "./index";
import {
  createStaticDesktopAudioCaptureAdapter,
  createStaticDesktopScreenshotCaptureAdapter,
  createStaticProtectedOverlaySurfaceAdapter,
} from "@nordri/os-integration";
import {
  createDeterministicInterviewCueCardProvider,
  createDeterministicInterviewScreenshotVisionProvider,
  createDeterministicInterviewSummaryProvider,
  createDeterministicInterviewTranscriptionProvider,
  type InterviewTranscriptionProvider,
} from "@nordri/ai-providers";
import {
  summarizeInterviewSession,
  type InterviewWorkspaceSnapshot,
} from "@nordri/contracts";

function createMemoryRepository(): LiveAssistantRepository {
  let snapshot: InterviewWorkspaceSnapshot | null = null;

  return {
    loadWorkspace() {
      return Promise.resolve(
        snapshot
          ? {
              ...snapshot,
              recentSessions: snapshot.recentSessions.map(
                summarizeInterviewSession,
              ),
            }
          : null,
      );
    },
    loadSession(sessionId) {
      return Promise.resolve(
        snapshot?.activeSession?.id === sessionId
          ? snapshot.activeSession
          : (snapshot?.recentSessions.find(
              (session) => session.id === sessionId,
            ) ?? null),
      );
    },
    saveWorkspace(workspace, changedArchiveSessions = []) {
      const bodies = new Map(
        snapshot?.recentSessions.map((session) => [session.id, session]) ?? [],
      );
      for (const session of changedArchiveSessions)
        bodies.set(session.id, session);
      snapshot = {
        ...workspace,
        recentSessions: workspace.recentSessions.map(
          (summary) => bodies.get(summary.id)!,
        ),
      };
      return Promise.resolve();
    },
    load() {
      return Promise.resolve(snapshot);
    },
    save(nextSnapshot) {
      snapshot = nextSnapshot;
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
}

function createService(
  repository: LiveAssistantRepository = createMemoryRepository(),
  options: {
    advancedSurfacesEnabled?: boolean;
    cueCardProvider?: InterviewCueCardProvider;
    transcriptionProvider?: InterviewTranscriptionProvider;
  } = {},
) {
  return createLiveAssistantService({
    ...(options.advancedSurfacesEnabled === undefined
      ? {}
      : { advancedSurfacesEnabled: options.advancedSurfacesEnabled }),
    repository,
    audioCaptureAdapter: createStaticDesktopAudioCaptureAdapter("win32"),
    screenshotCaptureAdapter: createStaticDesktopScreenshotCaptureAdapter({
      now: () => "2026-05-13T05:00:00.000Z",
    }),
    protectedSurfaceAdapter: createStaticProtectedOverlaySurfaceAdapter({
      platform: "win32",
      now: () => "2026-05-13T05:00:00.000Z",
    }),
    cueCardProvider:
      options.cueCardProvider ?? createDeterministicInterviewCueCardProvider(),
    screenshotVisionProvider:
      createDeterministicInterviewScreenshotVisionProvider(),
    transcriptionProvider:
      options.transcriptionProvider ??
      createDeterministicInterviewTranscriptionProvider(),
    summaryProvider: createDeterministicInterviewSummaryProvider(),
    now: () => "2026-05-13T05:00:00.000Z",
  });
}

async function acceptSetup(service: ReturnType<typeof createService>) {
  await service.saveSetup({
    consent: {
      microphoneCapture: true,
      meetingAudioCapture: true,
      screenshotCapture: true,
      modelTransmission: true,
      localRetention: true,
      overlayProtectionNotice: true,
      acceptedAt: "2026-05-13T05:00:00.000Z",
    },
  });
}

describe("live assistant service", () => {
  test("blocks session start until setup consent is explicit", async () => {
    const service = createService();

    await service.runRehearsal();
    const blocked = await service.startSession();

    expect(blocked.activeSession).toBeNull();
    expect(
      blocked.setup.rehearsal?.checks.some((check) =>
        check.label.includes("Accept setup disclosures"),
      ),
    ).toBe(true);
  });

  test("starts with system audio enabled while microphone capture stays off", async () => {
    const service = createService();

    await service.saveSetup({
      consent: {
        microphoneCapture: false,
        meetingAudioCapture: true,
        screenshotCapture: false,
        modelTransmission: true,
        localRetention: true,
        overlayProtectionNotice: true,
        acceptedAt: "2026-05-13T05:00:00.000Z",
      },
    });
    await service.runRehearsal();
    const started = await service.startSession();

    expect(started.activeSession?.status).toBe("active");
    expect(started.setup.consent).toMatchObject({
      microphoneCapture: false,
      meetingAudioCapture: true,
    });

    await expect(
      service.transcribeAudioChunk({
        sessionId: started.activeSession!.id,
        source: "microphone",
        mimeType: "audio/webm",
        audioBase64: "bWljcm9waG9uZQ==",
      }),
    ).rejects.toThrow("Enable microphone capture");
  });

  test("runs rehearsal and starts a transcript-first live session", async () => {
    const service = createService(createMemoryRepository(), {
      advancedSurfacesEnabled: true,
    });

    await acceptSetup(service);
    const rehearsed = await service.runRehearsal();
    expect(rehearsed.setup.rehearsal?.status).toBe("degraded");
    expect(rehearsed.setup.rehearsal?.protectedSurfaces).toHaveLength(2);
    expect(rehearsed.setup.rehearsal?.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "transcription_language",
        "transcription_engine_fallback",
        "screenshot_capture",
        "screenshot_vision",
        "overlay_capture_protection",
        "retention_defaults",
      ]),
    );
    expect(
      rehearsed.setup.rehearsal?.checks.find(
        (check) => check.id === "transcription_engine_fallback",
      )?.status,
    ).toBe("available");

    const active = await service.startSession();
    expect(active.activeSession?.status).toBe("active");
    expect(active.activeSession?.transcriptSegments).toEqual([]);
    expect(active.activeSession?.cueCards).toEqual([]);
    expect(active.answerOverlay.currentCue).toBeNull();
  });

  test("uses visible-chat mode without requiring overlays, tray controls, or panic hide", async () => {
    const service = createService(createMemoryRepository(), {
      advancedSurfacesEnabled: false,
    });

    await acceptSetup(service);
    const rehearsed = await service.runRehearsal();
    const started = await service.startSession();

    expect(rehearsed.setup.rehearsal?.protectedSurfaces).toEqual([]);
    expect(
      rehearsed.setup.rehearsal?.checks.find(
        (check) => check.id === "overlay_windows",
      ),
    ).toMatchObject({
      status: "unsupported",
      required: false,
    });
    expect(
      rehearsed.setup.rehearsal?.checks.find(
        (check) => check.id === "panic_hide",
      ),
    ).toMatchObject({
      status: "unsupported",
      required: false,
    });
    expect(started.activeSession?.status).toBe("active");

    const ignoredPanicHide = await service.performAction({
      action: "panic_hide",
    });
    expect(ignoredPanicHide.activeSession?.status).toBe("active");
    expect(ignoredPanicHide.activeSession?.listening).toBe(true);
  });

  test("persists setup preferences into rehearsal and session behavior", async () => {
    const service = createService();

    await acceptSetup(service);
    const saved = await service.saveSetup({
      transcriptionLanguage: "en-GB",
      cueSensitivity: "manual_only",
      autoCaptureOnCue: true,
    });
    const rehearsed = await service.runRehearsal();
    const active = await service.startSession();

    expect(saved.setup.transcriptionLanguage).toBe("en-GB");
    expect(saved.setup.cueSensitivity).toBe("manual_only");
    expect(saved.setup.autoCaptureOnCue).toBe(true);
    expect(rehearsed.setup.rehearsal?.language).toBe("en-GB");
    expect(active.activeSession?.automaticCueSensitivity).toBe("manual_only");
    expect(active.activeSession?.transcriptSegments).toEqual([]);
  });

  test("queues contaminated screenshot context and discloses it in a forced cue", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    await service.startSession();
    const withCue = await service.performAction({
      action: "capture_screenshot_and_force_cue",
    });

    const latestCue = withCue.activeSession?.cueCards.at(-1);
    expect(latestCue?.disclosure.screenshotCount).toBe(1);
    expect(latestCue?.disclosure.overlayContaminated).toBe(true);
    expect(
      withCue.activeSession?.visualBatches.at(-1)?.clearedAt,
    ).not.toBeNull();
  });

  test("panic-hide hides overlays without ending the session", async () => {
    const service = createService(createMemoryRepository(), {
      advancedSurfacesEnabled: true,
    });

    await acceptSetup(service);
    await service.runRehearsal();
    await service.startSession();
    const hidden = await service.performAction({ action: "panic_hide" });

    expect(hidden.activeSession?.status).toBe("panic_hidden");
    expect(hidden.answerOverlay.visible).toBe(false);
    expect(hidden.transcriptOverlay.visible).toBe(false);
  });

  test("reconfigures a live session through an explicitly paused flow", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    const active = await service.startSession();
    expect(active.activeSession?.status).toBe("active");

    const reconfiguring = await service.beginSessionReconfiguration();
    expect(reconfiguring.activeSession?.status).toBe("reconfiguring");
    expect(reconfiguring.activeSession?.listening).toBe(false);

    await service.saveSetup({ cueSensitivity: "manual_only" });
    await service.runRehearsal();
    const closed = await service.finishSessionReconfiguration();

    expect(closed.activeSession?.status).toBe("paused");
    expect(closed.activeSession?.listening).toBe(false);
    expect(closed.activeSession?.automaticCueSensitivity).toBe("manual_only");
    expect(closed.activeSession?.diagnostics.at(-1)?.label).toBe(
      "Session reconfiguration closed",
    );
  });

  test("adds transcript annotations without overwriting original segments", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    const started = await service.startSession();
    const activeSession = started.activeSession;
    if (!activeSession) {
      throw new Error("Expected an active session.");
    }
    await service.addTranscriptSegment({
      sessionId: activeSession.id,
      source: "typed_question",
      text: "How do you isolate Electron IPC?",
      language: "en-US",
      engineKind: "platform_local",
    });
    const ended = await service.performAction({ action: "end_session" });
    const session = await service.getSession(ended.recentSessions[0]!.id);
    const segment = session?.transcriptSegments[0];
    if (!session || !segment) {
      throw new Error("Expected an ended session with transcript segments.");
    }

    const annotated = await service.addTranscriptAnnotation({
      sessionId: session.id,
      transcriptSegmentId: segment.id,
      kind: "correction",
      body: "The interviewer asked about Electron IPC isolation.",
    });

    const annotatedSession = await service.getSession(
      annotated.recentSessions[0]!.id,
    );
    expect(annotatedSession?.transcriptSegments[0]?.text).toBe(segment.text);
    expect(annotatedSession?.transcriptAnnotations).toHaveLength(1);
    expect(annotatedSession?.transcriptAnnotations[0]?.originalText).toBe(
      segment.text,
    );

    const exportResult = await service.exportSession({
      sessionId: session.id,
      format: "markdown",
    });
    expect(exportResult.content).toContain("## Transcript Annotations");
    expect(exportResult.content).toContain("Electron IPC isolation");
    expect(exportResult.content).toContain("[Typed question]");
  });

  test("ingests native live transcript segments and generates a cue", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    const active = await service.startSession();
    const activeSession = active.activeSession;
    if (!activeSession) {
      throw new Error("Expected an active session.");
    }

    const updated = await service.addTranscriptSegment({
      sessionId: activeSession.id,
      source: "meeting_native_transcript",
      text: "How would you keep Electron overlay IPC isolated from the main app?",
      engineKind: "platform_local",
    });

    expect(updated.activeSession?.transcriptSegments.at(-1)?.source).toBe(
      "meeting_native_transcript",
    );
    expect(updated.activeSession?.cueCards.at(-1)?.question).toContain(
      "overlay IPC",
    );
    expect(
      updated.activeSession?.transcriptSegments.at(-1)?.usedInCueIds.at(-1),
    ).toBe(updated.activeSession?.cueCards.at(-1)?.id);
    expect(updated.transcriptOverlay.transcriptSegments.at(-1)?.text).toContain(
      "overlay IPC",
    );
  });

  test("always answers an explicit chat message and keeps attached image bytes transient", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    const started = await service.startSession();
    const session = started.activeSession;
    if (!session) {
      throw new Error("Expected an active session.");
    }
    const cueCountBefore = session.cueCards.length;

    const turn = await service.sendChatMessage({
      conversationId: `interview_${session.id}`,
      sessionId: session.id,
      content: "Help me explain the architecture in this screenshot",
      attachments: [
        {
          source: "file_picker",
          fileName: "architecture.png",
          mimeType: "image/png",
          dataBase64: "dGVzdA==",
          byteSize: 4,
          dimensions: null,
        },
      ],
    });
    const updated = await service.getWorkspace();

    expect(turn.userMessage.content).toContain("explain the architecture");
    expect(turn.userMessage.attachments[0]).not.toHaveProperty("dataBase64");
    expect(turn.assistantMessage.content.length).toBeGreaterThan(0);
    expect(turn.assistantMessage.usedAttachmentIds).toEqual([
      turn.userMessage.attachments[0]?.id,
    ]);
    expect(updated.activeSession?.cueCards).toHaveLength(cueCountBefore + 1);
    expect(updated.activeSession?.cueCards.at(-1)?.question).toBe(
      "Help me explain the architecture in this screenshot",
    );
    expect(updated.activeSession?.transcriptSegments.at(-1)?.source).toBe(
      "typed_question",
    );
    expect(updated.activeSession?.chatConversation).toMatchObject({
      id: `interview_${session.id}`,
      sessionId: session.id,
    });
    expect(updated.activeSession?.chatConversation?.messages).toEqual([
      turn.userMessage,
      turn.assistantMessage,
    ]);
    expect(JSON.stringify(updated)).not.toContain("dGVzdA==");
  });

  test("serializes end-session behind an in-flight chat response", async () => {
    const deterministicProvider = createDeterministicInterviewCueCardProvider();
    let releaseCue!: () => void;
    let markCueStarted: (() => void) | null = null;
    let delayNextCue = false;
    const cueStarted = new Promise<void>((resolve) => {
      markCueStarted = resolve;
    });
    const cueGate = new Promise<void>((resolve) => {
      releaseCue = resolve;
    });
    const service = createService(createMemoryRepository(), {
      cueCardProvider: {
        getStatus: () => deterministicProvider.getStatus(),
        async generateCueCard(input) {
          if (delayNextCue) {
            markCueStarted?.();
            await cueGate;
          }
          return deterministicProvider.generateCueCard(input);
        },
      },
    });

    await acceptSetup(service);
    await service.runRehearsal();
    const started = await service.startSession();
    const session = started.activeSession;
    if (!session) {
      throw new Error("Expected an active session.");
    }
    delayNextCue = true;

    const sendPromise = service.sendChatMessage({
      conversationId: `interview_${session.id}`,
      sessionId: session.id,
      content: "Explain the trade-off",
      attachments: [],
    });
    await cueStarted;
    const endPromise = service.performAction({ action: "end_session" });
    releaseCue();

    await sendPromise;
    const ended = await endPromise;

    expect(ended.activeSession).toBeNull();
    expect(ended.recentSessions[0]?.id).toBe(session.id);
    expect(
      (await service.getSession(ended.recentSessions[0]!.id))?.chatConversation
        ?.messages,
    ).toHaveLength(2);
  });

  test("preserves queued session mutations behind an in-flight chat response", async () => {
    const deterministicProvider = createDeterministicInterviewCueCardProvider();
    let releaseCue!: () => void;
    let markCueStarted!: () => void;
    let delayNextCue = false;
    const cueStarted = new Promise<void>((resolve) => {
      markCueStarted = resolve;
    });
    const cueGate = new Promise<void>((resolve) => {
      releaseCue = resolve;
    });
    const service = createService(createMemoryRepository(), {
      cueCardProvider: {
        getStatus: () => deterministicProvider.getStatus(),
        async generateCueCard(input) {
          if (delayNextCue) {
            markCueStarted();
            await cueGate;
          }
          return deterministicProvider.generateCueCard(input);
        },
      },
    });

    await acceptSetup(service);
    await service.runRehearsal();
    const started = await service.startSession();
    const startedSession = started.activeSession;
    if (!startedSession) {
      throw new Error("Expected an active session.");
    }
    const withInitialCue = await service.addTranscriptSegment({
      sessionId: startedSession.id,
      source: "meeting_native_transcript",
      text: "How do you preserve session mutations under concurrency?",
      language: "en-US",
      engineKind: "platform_local",
    });
    const session = withInitialCue.activeSession;
    if (!session) {
      throw new Error("Expected an active session after transcript ingestion.");
    }
    delayNextCue = true;

    const sendPromise = service.sendChatMessage({
      conversationId: `interview_${session.id}`,
      sessionId: session.id,
      content: "Explain the concurrency boundary",
      attachments: [],
    });
    await cueStarted;
    const setupPromise = service.saveSetup({ cueSensitivity: "manual_only" });
    const overlayPromise = service.updateOverlayPreference({
      surfaceKind: "live_answer_overlay",
      bounds: { x: 20, y: 30, width: 480, height: 280 },
    });
    const cueCardId = session.cueCards[0]?.id;
    if (!cueCardId) {
      throw new Error("Expected a cue card to preserve as prep.");
    }
    const prepPromise = service.saveCueAsPrepArtifact({
      sessionId: session.id,
      cueCardId,
    });
    const verificationPromise = service.recordProtectedSurfaceVerification({
      protectedSurfaces: [
        {
          id: "answer_surface",
          kind: "live_answer_overlay",
          requestedPolicy: "screen_share_private",
          protectionState: "verified_protected",
          verificationMethod: "test-verification",
          displayLabel: "Screen 1",
          detail: "Verified before the display change.",
          lastVerifiedAt: "2026-05-13T05:00:00.000Z",
        },
      ],
    });
    const displayPromise = service.recordDisplayChange({
      reason: "display_metrics_changed",
      detail: "Primary display bounds changed.",
    });
    const annotationPromise = service.addTranscriptAnnotation({
      sessionId: session.id,
      transcriptSegmentId: null,
      kind: "note",
      body: "Keep the mutation queue explicit.",
    });
    releaseCue();

    await Promise.all([
      sendPromise,
      setupPromise,
      overlayPromise,
      prepPromise,
      verificationPromise,
      displayPromise,
      annotationPromise,
    ]);
    const updated = await service.getWorkspace();

    expect(updated.activeSession?.chatConversation?.messages).toHaveLength(2);
    expect(updated.setup.cueSensitivity).toBe("manual_only");
    expect(updated.setup.prepArtifacts[0]?.sourceSessionId).toBe(session.id);
    expect(
      updated.overlayPreferences.find(
        (preference) => preference.surfaceKind === "live_answer_overlay",
      )?.bounds,
    ).toEqual({ x: 20, y: 30, width: 480, height: 280 });
    expect(updated.activeSession?.transcriptAnnotations.at(-1)?.body).toBe(
      "Keep the mutation queue explicit.",
    );
    expect(updated.activeSession?.protectedSurfaces[0]).toMatchObject({
      id: "answer_surface",
      protectionState: "requested_unverified",
      verificationMethod: "display-change-revalidation-required",
    });
    expect(
      updated.activeSession?.diagnostics.map((diagnostic) => diagnostic.label),
    ).toEqual(
      expect.arrayContaining([
        "Overlay capture protection verified",
        "Display change requires overlay revalidation",
        "Transcript annotation saved",
      ]),
    );
  });

  test("captures a temporary visual batch for automatic cues when enabled", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.saveSetup({ autoCaptureOnCue: true });
    await service.runRehearsal();
    const active = await service.startSession();
    const activeSession = active.activeSession;
    if (!activeSession) {
      throw new Error("Expected an active session.");
    }

    const updated = await service.addTranscriptSegment({
      sessionId: activeSession.id,
      source: "meeting_native_transcript",
      text: "How would you use screenshot context without leaking overlay content?",
      engineKind: "platform_local",
    });

    expect(
      updated.activeSession?.visualBatches.at(-1)?.clearedAt,
    ).not.toBeNull();
    expect(updated.activeSession?.cueCards.at(-1)?.disclosure).toMatchObject({
      screenshotCount: 1,
      overlayContaminated: true,
    });
    expect(
      updated.activeSession?.diagnostics.some(
        (diagnostic) =>
          diagnostic.kind === "screenshot" &&
          diagnostic.label === "Screenshot captured for automatic cue",
      ),
    ).toBe(true);
  });

  test("updates partial transcript segments without duplicating them", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    const active = await service.startSession();
    const activeSession = active.activeSession;
    if (!activeSession) {
      throw new Error("Expected an active session.");
    }

    const partial = await service.addTranscriptSegment({
      sessionId: activeSession.id,
      transcriptSegmentId: "native_segment_1",
      source: "meeting_native_transcript",
      state: "partial",
      text: "How would you keep",
      engineKind: "platform_local",
    });
    const final = await service.addTranscriptSegment({
      sessionId: activeSession.id,
      transcriptSegmentId: "native_segment_1",
      source: "meeting_native_transcript",
      state: "final",
      text: "How would you keep transcript ingestion typed?",
      engineKind: "platform_local",
    });

    expect(
      partial.activeSession?.transcriptSegments.filter(
        (segment) => segment.id === "native_segment_1",
      ),
    ).toHaveLength(1);
    expect(
      final.activeSession?.transcriptSegments.filter(
        (segment) => segment.id === "native_segment_1",
      ),
    ).toHaveLength(1);
    expect(final.activeSession?.transcriptSegments.at(-1)?.state).toBe("final");
  });

  test("transcribes transient meeting audio chunks without retaining raw audio", async () => {
    const transcriptionProvider =
      createDeterministicInterviewTranscriptionProvider();
    const service = createService(createMemoryRepository(), {
      transcriptionProvider: {
        ...transcriptionProvider,
        transcribeAudioChunk: () =>
          Promise.resolve({
            text: "How would you design a capture-safe overlay system?",
            confidence: 0.91,
            language: "en-US",
            engineKind: "cloud_ai",
          }),
      },
    });

    await acceptSetup(service);
    await service.runRehearsal();
    const active = await service.startSession();
    const activeSession = active.activeSession;
    if (!activeSession) {
      throw new Error("Expected an active session.");
    }

    const updated = await service.transcribeAudioChunk({
      sessionId: activeSession.id,
      source: "meeting_audio",
      mimeType: "audio/webm",
      audioBase64: "dGVzdCBhdWRpbw==",
      startedAt: "2026-05-13T05:00:00.000Z",
      endedAt: "2026-05-13T05:00:05.000Z",
    });

    const transcript = updated.activeSession?.transcriptSegments.at(-1);
    expect(transcript).toMatchObject({
      source: "meeting_audio",
      text: "How would you design a capture-safe overlay system?",
      engineKind: "cloud_ai",
    });
    expect(JSON.stringify(updated)).not.toContain("dGVzdCBhdWRpbw==");
    expect(updated.activeSession?.cueCards.at(-1)?.question).toContain(
      "capture-safe overlay",
    );
  });

  test("preserves the active session across transcription failure and recovery", async () => {
    const transcriptionProvider =
      createDeterministicInterviewTranscriptionProvider();
    let shouldFail = true;
    const service = createService(createMemoryRepository(), {
      transcriptionProvider: {
        ...transcriptionProvider,
        transcribeAudioChunk: () => {
          if (shouldFail) {
            return Promise.reject(new Error("Synthetic Windows STT failure."));
          }
          return Promise.resolve({
            text: "Recovered transcription remains in the same live session.",
            confidence: 0.88,
            language: "en-US",
            engineKind: "local_model",
          });
        },
      },
    });

    await acceptSetup(service);
    await service.runRehearsal();
    const started = await service.startSession();
    const sessionId = started.activeSession?.id;
    if (!sessionId) {
      throw new Error("Expected an active session.");
    }

    const failed = await service.transcribeAudioChunk({
      sessionId,
      source: "meeting_audio",
      mimeType: "audio/webm",
      audioBase64: "ZmFpbGVkIGF1ZGlv",
    });
    expect(failed.activeSession).toMatchObject({
      id: sessionId,
      status: "active",
      listening: true,
    });
    expect(failed.activeSession?.diagnostics.at(-1)).toMatchObject({
      kind: "provider",
      severity: "warning",
      label: "Audio transcription failed",
      detail: "Synthetic Windows STT failure.",
    });

    shouldFail = false;
    const recovered = await service.transcribeAudioChunk({
      sessionId,
      source: "meeting_audio",
      mimeType: "audio/webm",
      audioBase64: "cmVjb3ZlcmVkIGF1ZGlv",
    });

    expect(recovered.activeSession).toMatchObject({
      id: sessionId,
      status: "active",
      listening: true,
    });
    expect(recovered.activeSession?.transcriptSegments.at(-1)).toMatchObject({
      source: "meeting_audio",
      text: "Recovered transcription remains in the same live session.",
      engineKind: "local_model",
    });
    expect(JSON.stringify(recovered)).not.toContain("ZmFpbGVkIGF1ZGlv");
    expect(JSON.stringify(recovered)).not.toContain("cmVjb3ZlcmVkIGF1ZGlv");
  });

  test("does not retain Whisper non-speech sentinels as transcript context", async () => {
    const transcriptionProvider =
      createDeterministicInterviewTranscriptionProvider();
    const nonSpeechResults = [
      ">> [BLANK_AUDIO]",
      "(coughing)",
      "[music playing]",
    ];
    let resultIndex = 0;
    const service = createService(createMemoryRepository(), {
      transcriptionProvider: {
        ...transcriptionProvider,
        transcribeAudioChunk: () =>
          Promise.resolve({
            text: nonSpeechResults[resultIndex++] ?? "[silence]",
            confidence: 0,
            language: "en-US",
            engineKind: "local_model",
          }),
      },
    });

    await acceptSetup(service);
    await service.runRehearsal();
    const active = await service.startSession();
    const sessionId = active.activeSession?.id;
    if (!sessionId) {
      throw new Error("Expected an active session.");
    }

    let updated = active;
    for (let index = 0; index < nonSpeechResults.length; index += 1) {
      updated = await service.transcribeAudioChunk({
        sessionId,
        source: "meeting_audio",
        mimeType: "audio/webm",
        audioBase64: "c2lsZW5jZQ==",
      });
    }

    expect(updated.activeSession?.transcriptSegments).toEqual([]);
    expect(updated.activeSession?.cueCards).toEqual([]);
  });

  test("pauses before an in-flight audio provider finishes and ignores its late result", async () => {
    const transcriptionProvider =
      createDeterministicInterviewTranscriptionProvider();
    let releaseProvider!: () => void;
    let markProviderStarted!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    const service = createService(createMemoryRepository(), {
      transcriptionProvider: {
        ...transcriptionProvider,
        async transcribeAudioChunk() {
          markProviderStarted();
          await providerGate;
          return {
            text: "Late audio result",
            confidence: 0.9,
            language: "en-US",
            engineKind: "cloud_ai",
          };
        },
      },
    });

    await acceptSetup(service);
    await service.runRehearsal();
    const started = await service.startSession();
    const session = started.activeSession;
    if (!session) {
      throw new Error("Expected an active session.");
    }

    const transcriptionPromise = service.transcribeAudioChunk({
      sessionId: session.id,
      source: "microphone",
      mimeType: "audio/webm",
      audioBase64: "bGF0ZSBhdWRpbw==",
    });
    await providerStarted;
    const paused = await service.performAction({ action: "toggle_listening" });

    expect(paused.activeSession?.listening).toBe(false);
    releaseProvider();
    await transcriptionPromise;

    const updated = await service.getWorkspace();
    expect(
      updated.activeSession?.transcriptSegments.some(
        (segment) => segment.text === "Late audio result",
      ),
    ).toBe(false);
    expect(updated.activeSession?.diagnostics.at(-1)?.label).toBe(
      "Audio transcription ignored while paused",
    );
  });

  test("serializes microphone and system transcript mutations without losing chunks", async () => {
    const transcriptionProvider =
      createDeterministicInterviewTranscriptionProvider();
    let releaseMicrophone!: () => void;
    let markMicrophoneStarted!: () => void;
    const microphoneGate = new Promise<void>((resolve) => {
      releaseMicrophone = resolve;
    });
    const microphoneStarted = new Promise<void>((resolve) => {
      markMicrophoneStarted = resolve;
    });
    const providerCalls: string[] = [];
    const service = createService(createMemoryRepository(), {
      transcriptionProvider: {
        ...transcriptionProvider,
        async transcribeAudioChunk(input) {
          providerCalls.push(input.source);
          if (input.source === "microphone") {
            markMicrophoneStarted();
            await microphoneGate;
          }

          return {
            text:
              input.source === "microphone"
                ? "Candidate microphone answer"
                : "Interviewer system prompt",
            confidence: 0.92,
            language: "en-US",
            engineKind: "cloud_ai",
          };
        },
      },
    });

    await acceptSetup(service);
    await service.runRehearsal();
    const active = await service.startSession();
    const activeSession = active.activeSession;
    if (!activeSession) {
      throw new Error("Expected an active session.");
    }

    const microphone = service.transcribeAudioChunk({
      sessionId: activeSession.id,
      source: "microphone",
      mimeType: "audio/webm",
      audioBase64: "bWljcm9waG9uZQ==",
      startedAt: "2026-05-13T05:00:00.000Z",
      endedAt: "2026-05-13T05:00:05.000Z",
    });
    const system = service.transcribeAudioChunk({
      sessionId: activeSession.id,
      source: "meeting_audio",
      mimeType: "audio/webm",
      audioBase64: "c3lzdGVt",
      startedAt: "2026-05-13T05:00:05.000Z",
      endedAt: "2026-05-13T05:00:10.000Z",
    });

    await microphoneStarted;
    expect(providerCalls).toEqual(["microphone"]);

    releaseMicrophone();
    await Promise.all([microphone, system]);

    const updated = await service.getWorkspace();
    expect(providerCalls).toEqual(["microphone", "meeting_audio"]);
    expect(
      updated.activeSession?.transcriptSegments
        .filter(
          (segment) =>
            segment.text === "Candidate microphone answer" ||
            segment.text === "Interviewer system prompt",
        )
        .map((segment) => ({ source: segment.source, text: segment.text })),
    ).toEqual([
      { source: "microphone", text: "Candidate microphone answer" },
      { source: "meeting_audio", text: "Interviewer system prompt" },
    ]);
    expect(JSON.stringify(updated)).not.toContain("bWljcm9waG9uZQ==");
    expect(JSON.stringify(updated)).not.toContain("c3lzdGVt");
  });

  test("shows a quiet fallback cue card when provider output fails validation", async () => {
    const invalidCueProvider: InterviewCueCardProvider = {
      getStatus() {
        return {
          ready: true,
          label: "Invalid cue provider",
          detail: null,
        };
      },
      generateCueCard() {
        return Promise.resolve({
          id: "",
        } as unknown as Awaited<
          ReturnType<InterviewCueCardProvider["generateCueCard"]>
        >);
      },
    };
    const service = createService(createMemoryRepository(), {
      cueCardProvider: invalidCueProvider,
    });

    await acceptSetup(service);
    await service.runRehearsal();
    const started = await service.startSession();
    const session = started.activeSession;
    if (!session) {
      throw new Error("Expected an active session.");
    }
    const updated = await service.addTranscriptSegment({
      sessionId: session.id,
      source: "meeting_native_transcript",
      text: "How should I respond when cue generation fails?",
      language: "en-US",
      engineKind: "platform_local",
    });

    const cue = updated.activeSession?.cueCards.at(-1);
    expect(cue?.title).toBe("Cue unavailable");
    expect(cue?.answerOutline).toContain(
      "Ask for a moment to think, then answer from your own experience.",
    );
    expect(updated.activeSession?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "provider",
          severity: "warning",
          label: "Cue provider failed",
        }),
        expect.objectContaining({
          kind: "cue",
          severity: "warning",
          label: "Cue fallback card shown",
        }),
      ]),
    );
  });

  test("records runtime overlay protection verification evidence", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    await service.startSession();
    const updated = await service.recordProtectedSurfaceVerification({
      protectedSurfaces: [
        {
          id: "live_answer_overlay_interview-answer-overlay",
          kind: "live_answer_overlay",
          requestedPolicy: "screen_share_private",
          protectionState: "verified_protected",
          verificationMethod:
            "electron-desktopCapturer-screen-thumbnail-vs-overlay-window-pixels",
          displayLabel: "Screen 1",
          detail:
            "Overlay pixels were not detected in ordinary Electron screen capture. Meeting-app-specific exclusion is not verified.",
          lastVerifiedAt: "2026-05-13T05:00:00.000Z",
        },
      ],
    });

    expect(
      updated.activeSession?.protectedSurfaces.find(
        (surface) => surface.kind === "live_answer_overlay",
      )?.protectionState,
    ).toBe("verified_protected");
    expect(updated.activeSession?.diagnostics.at(-1)?.kind).toBe(
      "capture_protection",
    );
    expect(updated.activeSession?.diagnostics.at(-1)?.detail).toContain(
      "ordinary Electron screen-capture verification",
    );
  });

  test("marks overlay protection stale when display topology changes", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    await service.startSession();
    await service.recordProtectedSurfaceVerification({
      protectedSurfaces: [
        {
          id: "live_answer_overlay_interview-answer-overlay",
          kind: "live_answer_overlay",
          requestedPolicy: "screen_share_private",
          protectionState: "verified_protected",
          verificationMethod:
            "electron-desktopCapturer-screen-thumbnail-vs-overlay-window-pixels",
          displayLabel: "Screen 1",
          detail: "Verified before display change.",
          lastVerifiedAt: "2026-05-13T05:00:00.000Z",
        },
      ],
    });

    const updated = await service.recordDisplayChange({
      reason: "display_metrics_changed",
      detail: "Primary display bounds changed.",
    });
    const surface = updated.activeSession?.protectedSurfaces.find(
      (entry) => entry.kind === "live_answer_overlay",
    );

    expect(surface).toMatchObject({
      protectionState: "requested_unverified",
      verificationMethod: "display-change-revalidation-required",
      detail: "Primary display bounds changed.",
      lastVerifiedAt: null,
    });
    expect(updated.activeSession?.diagnostics.at(-1)).toMatchObject({
      kind: "display",
      severity: "warning",
      label: "Display change requires overlay revalidation",
    });
  });

  test("persists overlay layout preferences independently of session history", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    await service.startSession();
    const updated = await service.updateOverlayPreference({
      surfaceKind: "live_answer_overlay",
      bounds: { x: 80, y: 96, width: 460, height: 280 },
      displayId: "display_1",
    });

    expect(updated.overlayPreferences).toContainEqual(
      expect.objectContaining({
        surfaceKind: "live_answer_overlay",
        bounds: { x: 80, y: 96, width: 460, height: 280 },
        displayId: "display_1",
      }),
    );
    expect(updated.activeSession?.status).toBe("active");
    expect(updated.recentSessions).toHaveLength(0);
  });

  test("resets overlay layout preferences without deleting session history", async () => {
    const service = createService();

    await acceptSetup(service);
    await service.runRehearsal();
    await service.startSession();
    const moved = await service.updateOverlayPreference({
      surfaceKind: "live_transcript_overlay",
      bounds: { x: 120, y: 140, width: 520, height: 320 },
      displayId: "display_2",
    });
    const ended = await service.performAction({ action: "end_session" });
    const reset = await service.resetOverlayPreferences();

    expect(
      moved.overlayPreferences.find(
        (preference) => preference.surfaceKind === "live_transcript_overlay",
      )?.bounds,
    ).toEqual({ x: 120, y: 140, width: 520, height: 320 });
    expect(reset.recentSessions).toHaveLength(ended.recentSessions.length);
    expect(
      reset.overlayPreferences.find(
        (preference) => preference.surfaceKind === "live_transcript_overlay",
      )?.bounds,
    ).toBeNull();
  });

  test("marks persisted active sessions interrupted instead of resuming capture", async () => {
    const repository = createMemoryRepository();
    const firstService = createService(repository);

    await acceptSetup(firstService);
    await firstService.runRehearsal();
    const active = await firstService.startSession();
    expect(active.activeSession?.status).toBe("active");

    const restartedService = createService(repository);
    const recovered = await restartedService.getWorkspace();

    expect(recovered.activeSession).toBeNull();
    expect(recovered.recentSessions[0]?.status).toBe("interrupted");
    expect(recovered.recentSessions[0]?.listening).toBe(false);
    expect(
      (
        await restartedService.getSession(recovered.recentSessions[0]!.id)
      )?.diagnostics.at(-1)?.label,
    ).toContain("interrupted");
  });
});
