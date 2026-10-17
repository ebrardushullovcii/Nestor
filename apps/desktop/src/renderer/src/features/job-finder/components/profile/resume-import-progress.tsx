import { useEffect, useState } from "react";
import type { ResumeImportProgressEvent } from "@nestor/contracts";
import { LoaderCircle } from "lucide-react";

const stageLabels: Record<ResumeImportProgressEvent["stage"], string> = {
  saving_file: "Saving your file",
  reading_document: "Reading your resume",
  building_profile: "Building profile suggestions",
  saving_results: "Saving your review items",
};

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s elapsed`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s elapsed`;
}

/**
 * What to tell the user this step will cost them, from the first second rather
 * than after 45s — a 36s import never reached the old escalation, so the app
 * set no expectation at all during its longest wait.
 */
export function formatStageExpectation(
  progress: ResumeImportProgressEvent | null,
): string | null {
  if (!progress) {
    return null;
  }

  const { expectedSecondsMax, expectedSecondsMin } = progress;
  if (typeof expectedSecondsMax !== "number" || expectedSecondsMax <= 5) {
    return null;
  }

  const min = typeof expectedSecondsMin === "number" ? expectedSecondsMin : 0;
  return min > 0
    ? `Usually ${min}-${expectedSecondsMax} seconds.`
    : `Usually up to ${expectedSecondsMax} seconds.`;
}

export function formatStageCounter(
  progress: ResumeImportProgressEvent | null,
): string | null {
  if (
    !progress ||
    typeof progress.completed !== "number" ||
    typeof progress.total !== "number"
  ) {
    return null;
  }

  return `Step ${Math.min(progress.completed + 1, progress.total)} of ${progress.total}`;
}

export function ResumeImportProgress(props: {
  isPending: boolean;
  progress: ResumeImportProgressEvent | null;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const hasProcessingStarted = props.progress !== null;

  useEffect(() => {
    if (!props.isPending || !hasProcessingStarted) {
      setElapsedSeconds(0);
      return;
    }

    const startedAt = Date.now();
    const updateElapsed = () =>
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [hasProcessingStarted, props.isPending]);

  if (!props.isPending) {
    return null;
  }

  const stageLabel = props.progress
    ? stageLabels[props.progress.stage]
    : "File browser open";
  const message =
    props.progress?.message ??
    "The system file browser is open. Choose a PDF, DOCX, TXT, or Markdown file there. Press Escape to close it without importing.";
  const stageCounter = formatStageCounter(props.progress);
  const stageExpectation = formatStageExpectation(props.progress);
  const completedStages = props.progress?.completed ?? 0;
  const totalStages = props.progress?.total ?? 0;

  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className="grid gap-2 rounded-(--radius-field) border border-accent/30 bg-accent/8 p-4"
      role="status"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <LoaderCircle
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin text-accent"
          />
          <strong className="text-sm font-semibold text-foreground">
            {stageLabel}
          </strong>
          {stageCounter ? (
            <span className="shrink-0 text-(length:--text-tiny) uppercase tracking-wide text-foreground-muted">
              {stageCounter}
            </span>
          ) : null}
        </div>
        <span className="shrink-0 text-(length:--text-tiny) tabular-nums text-foreground-muted">
          {hasProcessingStarted
            ? formatElapsed(elapsedSeconds)
            : "Choose a file or press Escape"}
        </span>
      </div>
      {totalStages > 0 ? (
        <div
          aria-hidden="true"
          className="flex gap-1"
          data-resume-import-stage-track
        >
          {Array.from({ length: totalStages }, (_, index) => (
            <span
              className={
                index <= completedStages
                  ? "h-1 flex-1 rounded-full bg-accent"
                  : "h-1 flex-1 rounded-full bg-(--surface-well-border)"
              }
              key={index}
            />
          ))}
        </div>
      ) : null}
      <p className="text-sm leading-6 text-foreground-soft">{message}</p>
      {/* Timing only. The stage message above already says saved details
          wait for review, and this card is shown where nothing can be edited
          (setup's import screens) or where editing is paused (Profile), so
          the old "you can keep editing this step" was untrue everywhere it
          appeared. */}
      {stageExpectation ? (
        <p className="text-(length:--text-small) leading-5 text-foreground-muted">
          {stageExpectation}
        </p>
      ) : null}
      {elapsedSeconds >= 45 ? (
        <p className="text-(length:--text-small) leading-5 text-foreground-muted">
          Larger or image-heavy resumes can take a couple of minutes. Keep this
          window open; your original file is not changed.
        </p>
      ) : null}
    </div>
  );
}
