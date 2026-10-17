import {
  InterviewWorkspaceSnapshotSchema,
  type InterviewWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { deriveInterviewHealthSummary } from "./interview-health-summary";

const NOW = "2026-08-02T14:00:00.000Z";

function createWorkspace(input?: {
  answerVisible?: boolean;
  transcriptVisible?: boolean;
}): InterviewWorkspaceSnapshot {
  return InterviewWorkspaceSnapshotSchema.parse({
    module: "live-assistant",
    generatedAt: NOW,
    setup: {
      consent: {
        microphoneCapture: true,
        meetingAudioCapture: true,
      },
      rehearsal: {
        status: "passed",
        microphoneEngine: {
          kind: "local_model",
          label: "Local microphone transcription",
          ready: true,
          privacy: "local",
          cost: "free",
          latency: "low",
        },
        meetingAudioEngine: {
          kind: "local_model",
          label: "Local system-audio transcription",
          ready: true,
          privacy: "local",
          cost: "free",
          latency: "low",
        },
        checks: [
          {
            id: "cue_card_provider",
            label: "Cue provider",
            status: "available",
            required: true,
            checkedAt: NOW,
          },
        ],
        protectedSurfaces: [],
        updatedAt: NOW,
      },
    },
    activeSession: null,
    answerOverlay: {
      surfaceKind: "live_answer_overlay",
      mode: "compact",
      visible: input?.answerVisible ?? true,
      interactionMode: true,
      opacity: 0.86,
      protectionState: "best_effort",
      statusLabel: "Ready",
    },
    transcriptOverlay: {
      surfaceKind: "live_transcript_overlay",
      mode: "compact",
      visible: input?.transcriptVisible ?? true,
      interactionMode: true,
      opacity: 0.86,
      protectionState: "best_effort",
      statusLabel: "Ready",
    },
  });
}

function derive(
  overrides: Partial<Parameters<typeof deriveInterviewHealthSummary>[0]> = {},
) {
  return deriveInterviewHealthSummary({
    audioTranscriptionAvailable: true,
    microphoneDetail: "Signal detected at 0.420 peak.",
    microphoneRecorderDetail: "Mic audio is recording in transient 5s chunks.",
    microphoneRecorderStatus: "recording",
    microphoneStatus: "available",
    queue: { active: false, pending: 0, maxPending: 4 },
    systemAudioDetail: "System audio signal detected at 0.125 peak.",
    systemRecorderDetail: "System audio is recording in transient 5s chunks.",
    systemRecorderStatus: "recording",
    systemStatus: "available",
    workspace: createWorkspace(),
    ...overrides,
  });
}

describe("deriveInterviewHealthSummary", () => {
  it("reports a healthy Windows session and parses measured peak levels", () => {
    const health = derive();

    expect(health.overallStatus).toBe("healthy");
    expect(health.microphone).toMatchObject({
      status: "healthy",
      signal: "detected",
      peakLevel: 0.42,
    });
    expect(health.systemAudio.peakLevel).toBe(0.125);
    expect(health.popups.status).toBe("healthy");
    expect(health.recoverableFailure).toBeNull();
  });

  it("turns microphone permission failure into a clear recoverable device action", () => {
    const health = derive({
      microphoneDetail: "Microphone permission denied by Windows.",
      microphoneRecorderStatus: "failed",
      microphoneStatus: "failed",
    });

    expect(health.overallStatus).toBe("failed");
    expect(health.microphone.signal).toBe("permission_denied");
    expect(health.recoverableFailure).toMatchObject({
      kind: "device",
      source: "microphone",
      occurredAt: NOW,
    });
    expect(health.recoverableFailure?.recoveryAction).toContain(
      "run the microphone check again",
    );
  });

  it("keeps unavailable audio, a full transcription queue, and hidden popups degraded", () => {
    const health = derive({
      queue: { active: true, pending: 4, maxPending: 4 },
      systemAudioDetail: "System audio is unavailable for this share source.",
      systemRecorderStatus: "idle",
      systemStatus: "unavailable",
      workspace: createWorkspace({ transcriptVisible: false }),
    });

    expect(health.overallStatus).toBe("degraded");
    expect(health.systemAudio).toMatchObject({
      status: "degraded",
      signal: "unavailable",
    });
    expect(health.transcription.status).toBe("degraded");
    expect(health.popups.status).toBe("degraded");
  });

  it("surfaces recorder failures after an earlier successful device probe", () => {
    const health = derive({
      microphoneDetail: "Input signal detected (0.420 peak).",
      microphoneRecorderDetail:
        "Mic audio stopped after two consecutive transcription failures. Open diagnostics for technical details.",
      microphoneRecorderStatus: "failed",
      microphoneStatus: "available",
    });

    expect(health.overallStatus).toBe("failed");
    expect(health.microphone.detail).toContain(
      "two consecutive transcription failures",
    );
    expect(health.recoverableFailure).toMatchObject({
      kind: "transcription",
      source: "transcription",
    });
    expect(health.recoverableFailure?.recoveryAction).toContain(
      "restart the affected audio capture",
    );
  });

  it("clears the recoverable failure after capture recovers", () => {
    const failed = derive({
      systemAudioDetail: "Not checked yet.",
      systemRecorderDetail:
        "Display capture did not expose a system audio track.",
      systemRecorderStatus: "failed",
      systemStatus: "idle",
    });
    const recovered = derive({
      systemAudioDetail: "System audio signal detected at 0.250 peak.",
      systemRecorderDetail: "System audio is recording in transient 5s chunks.",
      systemRecorderStatus: "recording",
      systemStatus: "available",
    });

    expect(failed.recoverableFailure).toMatchObject({
      kind: "device",
      source: "system_audio",
    });
    expect(recovered.systemAudio.status).toBe("healthy");
    expect(recovered.recoverableFailure).toBeNull();
  });

  it("treats an intentional text-only session as ready instead of degraded", () => {
    const workspace = createWorkspace();
    workspace.setup.consent.microphoneCapture = false;
    workspace.setup.consent.meetingAudioCapture = false;

    const health = derive({
      audioTranscriptionAvailable: false,
      microphoneStatus: "unavailable",
      microphoneRecorderStatus: "idle",
      systemStatus: "unavailable",
      systemRecorderStatus: "idle",
      workspace,
    });

    expect(health.overallStatus).toBe("healthy");
    expect(health.microphone.detail).toBe("Off by choice.");
    expect(health.systemAudio.detail).toBe("Off by choice.");
    expect(health.transcription).toMatchObject({
      status: "healthy",
      detail: "Text-only mode is ready. Audio transcription is off by choice.",
    });
    expect(health.recoverableFailure).toBeNull();
  });
});
