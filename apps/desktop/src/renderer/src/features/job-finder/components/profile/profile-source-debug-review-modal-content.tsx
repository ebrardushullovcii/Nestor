import type {
  SourceDebugRunDetails,
  SourceDebugRunRecord,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import {
  splitBlockedAttemptNote,
  TECHNICAL_DETAILS_LABEL,
} from "@renderer/features/job-finder/lib/describe-failure";
import { buildLearnedInstructionIntelligenceSummaries } from "@renderer/features/job-finder/lib/source-intelligence-utils";
import {
  formatDuration,
  formatRunStateLabel,
} from "@renderer/features/job-finder/lib/job-finder-utils";
import { ProfileIntelligenceSummaries } from "./profile-intelligence-summaries";

function formatTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toLocaleString();
}

function formatAttemptOutcomeLabel(
  outcome: SourceDebugRunDetails["attempts"][number]["outcome"],
): string {
  switch (outcome) {
    case "succeeded":
      return "Successful";
    case "partial":
      return "Partial success";
    case "blocked_auth":
      return "Needs sign-in";
    case "blocked_manual_step":
      return "Needs a manual step";
    case "blocked_site_protection":
      return "Site blocked access";
    case "unsupported_layout":
      return "Site layout not supported";
    case "exhausted_duplicate_paths":
    case "exhausted_no_progress":
      return "Could not find a consistent path";
    case "failed_runtime":
      return "Runtime issue";
    default:
      return "Interrupted";
  }
}

function formatInstructionActionLabel(
  artifact: SourceInstructionArtifact | null,
): string | null {
  if (!artifact) {
    return null;
  }

  return artifact.status === "draft" || artifact.status === "validated"
    ? "Check saved guidance"
    : null;
}

/**
 * One recorded note from a source check.
 *
 * The runtime records exactly what it tried ("Blocked: xhr POST https://...")
 * alongside the sentence a person is meant to read, and printing both as one
 * line turned this panel into a request log — the panel's "the only feedback
 * is a rotating sequence of internal phase names". The plain sentence leads;
 * the recorded line stays, behind a disclosure, because it is the only thing
 * that explains a stubborn source.
 */
function AttemptNote({
  className,
  value,
}: {
  className: string;
  value: string;
}) {
  const { message, technicalDetails } = splitBlockedAttemptNote(value);

  if (!message) {
    return null;
  }

  return (
    <div className="grid min-w-0 gap-1">
      <p className={className}>{message}</p>
      {technicalDetails ? (
        <details className="min-w-0">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {TECHNICAL_DETAILS_LABEL}
          </summary>
          <p className="mt-1 break-all text-xs leading-5 text-muted-foreground">
            {technicalDetails}
          </p>
        </details>
      ) : null}
    </div>
  );
}

interface ProfileSourceDebugReviewModalContentProps {
  artifact: SourceInstructionArtifact | null;
  details: SourceDebugRunDetails | null;
  errorMessage: string | null;
  isVerifyPending: (instructionId: string) => boolean;
  loading: boolean;
  onLoadRun: (runId: string) => void;
  onVerify: (instructionId: string) => void;
  recentRuns: readonly SourceDebugRunRecord[];
  recentRunsLabelId: string;
  selectedRunId: string | null;
}

export function ProfileSourceDebugReviewModalContent({
  artifact,
  details,
  errorMessage,
  isVerifyPending,
  loading,
  onLoadRun,
  onVerify,
  recentRuns,
  recentRunsLabelId,
  selectedRunId,
}: ProfileSourceDebugReviewModalContentProps) {
  const selectedRun =
    recentRuns.find((run) => run.id === selectedRunId) ?? recentRuns[0] ?? null;
  const primaryActionLabel = formatInstructionActionLabel(artifact);
  const formattedRunTime = details
    ? formatTimestamp(details.run.completedAt ?? details.run.updatedAt)
    : null;
  const intelligenceSummaries =
    buildLearnedInstructionIntelligenceSummaries(artifact);
  const technicalDetails = details?.evidenceRefs.find(
    (evidence) =>
      evidence.kind === "note" && evidence.label === TECHNICAL_DETAILS_LABEL,
  )?.excerpt;

  return (
    <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside
        aria-labelledby={recentRunsLabelId}
        className="grid min-h-0 min-w-0 content-start gap-3 overflow-x-hidden overflow-y-auto border-b border-(--surface-panel-border) px-4 py-4 lg:border-b-0 lg:border-r"
      >
        <p
          className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted"
          id={recentRunsLabelId}
        >
          Check history
        </p>
        <ul className="grid gap-2 pb-1">
          {recentRuns.map((run) => {
            const isSelected = run.id === selectedRun?.id;

            return (
              <li key={run.id}>
                <button
                  aria-current={isSelected ? "true" : undefined}
                  className={[
                    "grid w-full gap-1 rounded-(--radius-panel) border px-3 py-3 text-left transition-colors",
                    isSelected
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "surface-card-tint border-(--surface-panel-border) text-foreground-soft hover:bg-secondary",
                  ].join(" ")}
                  onClick={() => onLoadRun(run.id)}
                  type="button"
                >
                  <span className="text-[0.82rem] font-medium text-foreground">
                    {formatRunStateLabel(run.state)}
                  </span>
                  <span className="text-[0.76rem] text-foreground-muted">
                    {formatTimestamp(run.completedAt ?? run.updatedAt)}
                  </span>
                  {run.timing ? (
                    <span className="text-[0.74rem] text-foreground-muted">
                      {formatDuration(run.timing.totalDurationMs)}
                    </span>
                  ) : null}
                  {run.finalSummary ? (
                    <span className="line-clamp-3 text-[0.78rem] leading-5 text-foreground-soft">
                      {run.finalSummary}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="grid min-h-0 min-w-0 content-start gap-4 overflow-x-hidden overflow-y-auto px-5 py-4">
        {loading ? (
          <div
            aria-atomic="true"
            aria-live="polite"
            className="surface-card-tint rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-4 text-[0.9rem] text-foreground-soft"
            role="status"
          >
            Loading source check details...
          </div>
        ) : errorMessage ? (
          <div
            aria-atomic="true"
            aria-live="assertive"
            className="rounded-(--radius-panel) border border-critical/35 bg-(--workspace-state-card-bg-error) px-4 py-4 text-[0.9rem] text-foreground"
            role="alert"
          >
            {errorMessage}
          </div>
        ) : details ? (
          <>
            <article className="surface-card-tint grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-1">
                  <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                    Source check
                  </p>
                  <p className="text-[1rem] font-medium text-foreground">
                    {formatRunStateLabel(details.run.state)}
                    {formattedRunTime ? ` • ${formattedRunTime}` : ""}
                  </p>
                </div>
                {artifact ? (
                  <div className="flex flex-wrap gap-2">
                    {primaryActionLabel ? (
                      <Button
                        pending={isVerifyPending(artifact.id)}
                        onClick={() => onVerify(artifact.id)}
                        type="button"
                        variant="ghost"
                      >
                        {primaryActionLabel}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {details.run.finalSummary ? (
                <p className="text-[0.92rem] leading-6 text-foreground">
                  {details.run.finalSummary}
                </p>
              ) : null}
              {technicalDetails ? (
                <details className="min-w-0">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {TECHNICAL_DETAILS_LABEL}
                  </summary>
                  <p className="mt-1 break-all text-xs leading-5 text-muted-foreground">
                    {technicalDetails}
                  </p>
                </details>
              ) : null}
              <ProfileIntelligenceSummaries
                className="grid gap-3 rounded-(--radius-small) border border-(--surface-panel-border) px-3 py-3"
                intelligenceSummaries={intelligenceSummaries}
                listClassName="grid gap-1 text-[0.82rem] leading-6 text-foreground-soft"
                sectionClassName="grid gap-1.5"
                titleClassName="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted"
              />
              {details.run.timing ? (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[0.82rem] text-foreground-muted">
                  <span>
                    Duration:{" "}
                    {formatDuration(details.run.timing.totalDurationMs)}
                  </span>
                  {details.run.timing.longestGapMs > 10000 ? (
                    <span>
                      Longest quiet gap:{" "}
                      {formatDuration(details.run.timing.longestGapMs)}
                    </span>
                  ) : null}
                  {details.run.timing.browserSetupMs != null ? (
                    <span>
                      Browser setup:{" "}
                      {formatDuration(details.run.timing.browserSetupMs)}
                    </span>
                  ) : null}
                  {details.run.timing.finalReviewMs != null ? (
                    <span>
                      AI review:{" "}
                      {formatDuration(details.run.timing.finalReviewMs)}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {details.run.manualPrerequisiteSummary ? (
                <p className="text-[0.85rem] leading-6 text-foreground-soft">
                  {details.run.manualPrerequisiteSummary}
                </p>
              ) : null}
            </article>

            {details.attempts.length > 0 ? (
              <section className="grid gap-3">
                <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                  What happened
                </p>
                {details.attempts.map((attempt, index) => (
                  <article
                    className="surface-card-tint grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-4"
                    key={attempt.id}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="grid gap-1">
                        <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                          Attempt {index + 1}
                        </p>
                        <p className="text-[0.95rem] font-medium text-foreground">
                          {formatAttemptOutcomeLabel(attempt.outcome)}
                        </p>
                      </div>
                      <p className="text-right text-[0.76rem] text-foreground-muted">
                        {formatTimestamp(
                          attempt.completedAt ?? attempt.startedAt,
                        )}
                      </p>
                    </div>
                    <AttemptNote
                      className="text-[0.92rem] leading-6 text-foreground"
                      value={attempt.resultSummary}
                    />
                    {attempt.completionReason ? (
                      <AttemptNote
                        className="text-[0.84rem] leading-6 text-foreground-soft"
                        value={attempt.completionReason}
                      />
                    ) : null}
                  </article>
                ))}
              </section>
            ) : null}
          </>
        ) : (
          <div className="surface-card-tint rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-4 text-[0.9rem] text-foreground-soft">
            No saved check details are available for this source yet.
          </div>
        )}
      </section>
    </div>
  );
}
