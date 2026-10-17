import {
  InterviewSessionHealthSchema,
  type InterviewWorkspaceView,
} from "@nestor/contracts";
import type { InterviewAudioChunkQueueSnapshot } from "./interview-audio-chunk-queue";
import type {
  CaptureStatus,
  ProbeStatus,
} from "./interview-media-stream-probes";

function statusFromAudio(
  probe: ProbeStatus,
  recorder: CaptureStatus,
): "unknown" | "healthy" | "degraded" | "failed" {
  if (probe === "failed" || recorder === "failed") return "failed";
  if (probe === "unavailable") return "degraded";
  if (probe === "available" || recorder === "recording") return "healthy";
  return "unknown";
}

function signalFromAudio(
  probe: ProbeStatus,
  recorder: CaptureStatus,
  detail: string,
) {
  const peakMatch = detail.match(/\b(0(?:\.\d+)?|1(?:\.0+)?)\s+peak\b/i);
  const peakLevel = peakMatch?.[1] ? Number(peakMatch[1]) : null;
  if (detail.toLowerCase().includes("signal detected")) {
    return { signal: "detected" as const, peakLevel };
  }
  if (
    detail.toLowerCase().includes("no input signal") ||
    detail.toLowerCase().includes("no system audio signal")
  ) {
    return { signal: "quiet" as const, peakLevel };
  }
  if (probe === "failed" || recorder === "failed") {
    return {
      signal: detail.toLowerCase().includes("denied")
        ? ("permission_denied" as const)
        : ("failed" as const),
      peakLevel: null,
    };
  }
  if (probe === "unavailable") {
    return { signal: "unavailable" as const, peakLevel: null };
  }
  if (
    probe === "checking" ||
    recorder === "starting" ||
    recorder === "recording"
  ) {
    return { signal: "detecting" as const, peakLevel: null };
  }
  return { signal: "not_checked" as const, peakLevel: null };
}

function latestRecoverableDiagnostic(workspace: InterviewWorkspaceView) {
  return (
    [...(workspace.activeSession?.diagnostics ?? [])]
      .reverse()
      .find((event) => event.severity !== "info") ?? null
  );
}

function activeAudioDetail(
  probeDetail: string,
  probeStatus: ProbeStatus,
  recorderDetail: string,
  recorderStatus: CaptureStatus,
) {
  if (recorderStatus === "failed" && probeStatus !== "failed") {
    return recorderDetail;
  }
  if (probeStatus !== "idle") return probeDetail;
  return recorderStatus === "idle" ? probeDetail : recorderDetail;
}

function localCaptureFailure(input: {
  microphoneDetail: string;
  microphoneRecorderDetail: string;
  microphoneRecorderStatus: CaptureStatus;
  microphoneStatus: ProbeStatus;
  systemAudioDetail: string;
  systemRecorderDetail: string;
  systemRecorderStatus: CaptureStatus;
  systemStatus: ProbeStatus;
}) {
  const failedSource =
    input.microphoneStatus === "failed" ||
    input.microphoneRecorderStatus === "failed"
      ? {
          source: "microphone" as const,
          message:
            input.microphoneStatus === "failed"
              ? input.microphoneDetail
              : input.microphoneRecorderDetail,
        }
      : input.systemStatus === "failed" ||
          input.systemRecorderStatus === "failed"
        ? {
            source: "system_audio" as const,
            message:
              input.systemStatus === "failed"
                ? input.systemAudioDetail
                : input.systemRecorderDetail,
          }
        : null;

  if (!failedSource) return null;

  const transcriptionFailure =
    /\b(?:transcri(?:be|bed|ption)|provider|engine)\b/i.test(
      failedSource.message,
    );
  return transcriptionFailure
    ? {
        kind: "transcription" as const,
        source: "transcription" as const,
        message: failedSource.message,
        recoveryAction:
          "Keep the session open, verify transcription readiness, then restart the affected audio capture.",
      }
    : {
        kind: "device" as const,
        ...failedSource,
        recoveryAction:
          failedSource.source === "microphone"
            ? "Check microphone permission or device selection, then run the microphone check again."
            : "Choose a share source with audio, play sound, then run the system-audio check again.",
      };
}

export function deriveInterviewHealthSummary(input: {
  audioTranscriptionAvailable: boolean;
  microphoneDetail: string;
  microphoneRecorderDetail: string;
  microphoneRecorderStatus: CaptureStatus;
  microphoneStatus: ProbeStatus;
  queue: InterviewAudioChunkQueueSnapshot;
  systemAudioDetail: string;
  systemRecorderDetail: string;
  systemRecorderStatus: CaptureStatus;
  systemStatus: ProbeStatus;
  workspace: InterviewWorkspaceView;
}) {
  const session = input.workspace.activeSession;
  const microphoneEnabled = input.workspace.setup.consent.microphoneCapture;
  const systemAudioEnabled = input.workspace.setup.consent.meetingAudioCapture;
  const audioCaptureEnabled = microphoneEnabled || systemAudioEnabled;
  const rehearsal = input.workspace.setup.rehearsal;
  const microphoneDetail = activeAudioDetail(
    input.microphoneDetail,
    input.microphoneStatus,
    input.microphoneRecorderDetail,
    input.microphoneRecorderStatus,
  );
  const systemAudioDetail = activeAudioDetail(
    input.systemAudioDetail,
    input.systemStatus,
    input.systemRecorderDetail,
    input.systemRecorderStatus,
  );
  const microphoneSignal = signalFromAudio(
    input.microphoneStatus,
    input.microphoneRecorderStatus,
    microphoneDetail,
  );
  const systemSignal = signalFromAudio(
    input.systemStatus,
    input.systemRecorderStatus,
    systemAudioDetail,
  );
  const engines = rehearsal
    ? [rehearsal.microphoneEngine, rehearsal.meetingAudioEngine]
    : [];
  const providerReady =
    input.audioTranscriptionAvailable && engines.some((engine) => engine.ready);
  const transcriptionFallback = engines.some(
    (engine) => engine.ready && engine.kind === "deterministic",
  );
  const cueFallback = Boolean(
    session?.diagnostics.some(
      (event) =>
        event.label === "Cue fallback card shown" ||
        event.label === "Cue provider failed",
    ),
  );
  const lastCue = session?.cueCards.at(-1) ?? null;
  const lastTranscript = session?.transcriptSegments.at(-1) ?? null;
  const transcriptTimestamp = lastTranscript
    ? Date.parse(lastTranscript.endedAt ?? lastTranscript.startedAt)
    : Number.NaN;
  const cueLatencyMs =
    lastCue && Number.isFinite(transcriptTimestamp)
      ? Math.max(0, Date.parse(lastCue.createdAt) - transcriptTimestamp)
      : null;
  const cueProviderCheck = rehearsal?.checks.find(
    (check) => check.id === "cue_card_provider",
  );
  const popupHealthy =
    input.workspace.answerOverlay.visible &&
    input.workspace.transcriptOverlay.visible;
  const rawDiagnostic = latestRecoverableDiagnostic(input.workspace);
  const diagnostic =
    !audioCaptureEnabled && rawDiagnostic?.kind === "capability"
      ? null
      : rawDiagnostic;
  const localFailure = localCaptureFailure({
    ...input,
    microphoneStatus: microphoneEnabled ? input.microphoneStatus : "idle",
    microphoneRecorderStatus: microphoneEnabled
      ? input.microphoneRecorderStatus
      : "idle",
    systemStatus: systemAudioEnabled ? input.systemStatus : "idle",
    systemRecorderStatus: systemAudioEnabled
      ? input.systemRecorderStatus
      : "idle",
  });
  const recoverableFailure = localFailure
    ? {
        ...localFailure,
        occurredAt: input.workspace.generatedAt,
      }
    : diagnostic
      ? {
          kind:
            diagnostic.kind === "provider"
              ? ("provider" as const)
              : ("transcription" as const),
          source:
            diagnostic.kind === "cue"
              ? ("cue" as const)
              : ("transcription" as const),
          message: diagnostic.detail ?? diagnostic.label,
          recoveryAction:
            diagnostic.kind === "provider"
              ? "Retry the affected action or open reconfiguration to check provider readiness."
              : "Keep the session open and retry with the existing audio or manual transcript controls.",
          occurredAt: diagnostic.occurredAt,
        }
      : null;

  const summary = InterviewSessionHealthSchema.parse({
    microphone: {
      status: microphoneEnabled
        ? statusFromAudio(
            input.microphoneStatus,
            input.microphoneRecorderStatus,
          )
        : "unknown",
      ...(microphoneEnabled
        ? microphoneSignal
        : { signal: "not_checked" as const, peakLevel: null }),
      detail: microphoneEnabled ? microphoneDetail : "Off by choice.",
      updatedAt: input.workspace.generatedAt,
    },
    systemAudio: {
      status: systemAudioEnabled
        ? statusFromAudio(input.systemStatus, input.systemRecorderStatus)
        : "unknown",
      ...(systemAudioEnabled
        ? systemSignal
        : { signal: "not_checked" as const, peakLevel: null }),
      detail: systemAudioEnabled ? systemAudioDetail : "Off by choice.",
      updatedAt: input.workspace.generatedAt,
    },
    transcription: {
      status: !audioCaptureEnabled
        ? "healthy"
        : !providerReady
          ? "failed"
          : input.queue.pending >= input.queue.maxPending
            ? "degraded"
            : "healthy",
      providerLabel: engines.map((engine) => engine.label).join(" / ") || null,
      providerReady,
      fallbackActive: transcriptionFallback,
      backlog: input.queue,
      detail: !audioCaptureEnabled
        ? "Text-only mode is ready. Audio transcription is off by choice."
        : !providerReady
          ? "No configured transcription path is ready. Manual transcript input remains available."
          : input.queue.pending > 0
            ? "Audio chunks are waiting for transcription."
            : "Transcription is ready with no queued chunks.",
      updatedAt: input.workspace.generatedAt,
    },
    cue: {
      status: cueFallback
        ? "degraded"
        : cueProviderCheck?.status === "unavailable"
          ? "failed"
          : cueProviderCheck
            ? "healthy"
            : "unknown",
      providerLabel: cueProviderCheck?.label ?? null,
      providerReady: cueProviderCheck?.status === "available",
      fallbackActive: cueFallback,
      lastLatencyMs: cueLatencyMs,
      detail: cueFallback
        ? "The latest cue used the existing bounded fallback."
        : cueLatencyMs === null
          ? "Generate a cue to see response latency."
          : "Latest cue response time from the newest transcript context.",
      updatedAt: input.workspace.generatedAt,
    },
    popups: {
      status: popupHealthy ? "healthy" : "degraded",
      answerVisible: input.workspace.answerOverlay.visible,
      transcriptVisible: input.workspace.transcriptOverlay.visible,
      answerProtectionState: input.workspace.answerOverlay.protectionState,
      transcriptProtectionState:
        input.workspace.transcriptOverlay.protectionState,
      detail: popupHealthy
        ? "Answer and transcript popups are visible."
        : "One or more popups are hidden; use the existing popup controls to reopen them.",
      updatedAt: input.workspace.generatedAt,
    },
    recoverableFailure,
    updatedAt: input.workspace.generatedAt,
  });
  const statuses = [
    ...(microphoneEnabled ? [summary.microphone.status] : []),
    ...(systemAudioEnabled ? [summary.systemAudio.status] : []),
    summary.transcription.status,
    summary.cue.status,
    summary.popups.status,
  ];
  return InterviewSessionHealthSchema.parse({
    ...summary,
    overallStatus: statuses.includes("failed")
      ? "failed"
      : statuses.includes("degraded") || recoverableFailure
        ? "degraded"
        : statuses.includes("healthy")
          ? "healthy"
          : "unknown",
  });
}
