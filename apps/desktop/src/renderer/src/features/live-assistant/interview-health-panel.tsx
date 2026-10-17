import type {
  InterviewHealthStatus,
  InterviewSessionHealth,
} from "@nestor/contracts";
import { Activity, AlertTriangle, CheckCircle2 } from "lucide-react";

function statusClass(status: InterviewHealthStatus) {
  if (status === "healthy") return "text-(--success-text)";
  if (status === "failed") return "text-critical";
  if (status === "degraded") return "text-(--warning-text)";
  return "text-muted-foreground";
}

function HealthItem(props: {
  detail: string;
  label: string;
  status: InterviewHealthStatus;
  value: string;
}) {
  const Icon =
    props.status === "healthy"
      ? CheckCircle2
      : props.status === "failed" || props.status === "degraded"
        ? AlertTriangle
        : Activity;

  return (
    <li className="rounded-lg border border-border-subtle bg-(--surface-fill-soft) p-3">
      <div className="flex items-start gap-2">
        <Icon className={"mt-0.5 size-3.5 " + statusClass(props.status)} />
        <div className="min-w-0">
          <p className="text-[0.7rem] font-semibold uppercase tracking-(--tracking-badge) text-muted-foreground">
            {props.label}
          </p>
          <p
            className={
              "mt-1 text-[0.78rem] font-medium " + statusClass(props.status)
            }
          >
            {props.value}
          </p>
          <p className="mt-1 text-[0.7rem] leading-5 text-muted-foreground">
            {props.detail}
          </p>
        </div>
      </div>
    </li>
  );
}

function signalValue(health: InterviewSessionHealth["microphone"]): string {
  if (health.detail === "Off by choice.") {
    return "Off by choice";
  }
  if (health.signal === "detected" && health.peakLevel !== null) {
    return "Signal " + health.peakLevel.toFixed(3);
  }
  return health.signal.replaceAll("_", " ");
}

export function InterviewHealthPanel(props: {
  health: InterviewSessionHealth;
  sessionStatus: string;
}) {
  const { health } = props;
  const backlog = health.transcription.backlog;
  const cueLatency =
    health.cue.lastLatencyMs === null
      ? "No cue yet"
      : health.cue.lastLatencyMs + " ms";
  const textOnlyReady =
    health.overallStatus === "healthy" &&
    (health.transcription.detail?.startsWith("Text-only mode is ready") ??
      false);

  return (
    <section
      aria-labelledby="interview-health-heading"
      className="surface-card-tint rounded-(--radius-panel) border p-4"
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2
            className="text-[0.75rem] font-bold uppercase tracking-(--tracking-badge)"
            id="interview-health-heading"
          >
            Session health
          </h2>
          <p className="mt-1 text-[0.7rem] text-muted-foreground">
            Live signals and recoverable failures. Session:{" "}
            {props.sessionStatus.replaceAll("_", " ")}.
          </p>
        </div>
        <span
          className={
            "text-[0.72rem] font-semibold uppercase " +
            statusClass(health.overallStatus)
          }
        >
          {textOnlyReady ? "Text-only ready" : health.overallStatus}
        </span>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
        <HealthItem
          detail={
            health.microphone.detail ??
            "Run the microphone check to measure input."
          }
          label="Microphone"
          status={health.microphone.status}
          value={signalValue(health.microphone)}
        />
        <HealthItem
          detail={
            health.systemAudio.detail ??
            "Run the system-audio check while audio is playing."
          }
          label="System audio"
          status={health.systemAudio.status}
          value={signalValue(health.systemAudio)}
        />
        <HealthItem
          detail={
            health.transcription.detail ??
            "Transcription provider state has not been checked."
          }
          label="Transcription"
          status={health.transcription.status}
          value={
            (health.transcription.fallbackActive ? "Fallback · " : "") +
            backlog.pending +
            " queued / " +
            backlog.maxPending
          }
        />
        <HealthItem
          detail={
            health.cue.detail ?? "Generate a cue to measure response latency."
          }
          label="Cue response"
          status={health.cue.status}
          value={(health.cue.fallbackActive ? "Fallback · " : "") + cueLatency}
        />
        <HealthItem
          detail={
            health.popups.detail ??
            "Popup state is synchronized with the live session."
          }
          label="Popups"
          status={health.popups.status}
          value={
            health.popups.answerVisible && health.popups.transcriptVisible
              ? "Both visible"
              : "Reopen hidden popup"
          }
        />
      </ul>

      {health.recoverableFailure ? (
        <div
          className="mt-3 rounded-lg border border-(--warning-border) bg-(--warning-surface) p-3"
          role="alert"
        >
          <p className="text-[0.78rem] font-semibold text-(--warning-text)">
            {health.recoverableFailure.message}
          </p>
          <p className="mt-1 text-[0.72rem] leading-5 text-muted-foreground">
            {health.recoverableFailure.recoveryAction}
          </p>
        </div>
      ) : null}
    </section>
  );
}
