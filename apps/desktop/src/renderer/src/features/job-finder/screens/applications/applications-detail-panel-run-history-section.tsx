import { ApplicationsDisclosureSummary } from "./applications-disclosure-summary";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { cn } from "@renderer/lib/utils";
import {
  formatTimestamp,
  formatStatusLabel,
} from "@renderer/features/job-finder/lib/job-finder-utils";
import { resolveApplyStatePresentation } from "./apply-state";
import { StatusBadge } from "../../components/status-badge";
import {
  formatApplyRunModeLabel,
  formatApplyRunStateLabel,
  getCustomerFacingApplyText,
} from "./applications-detail-panel-helpers";
import { resolveApplicationRecoveryPresentation } from "./applications-recovery-state";
import { PREPARED_PAGE_CLOSED_SUMMARY } from "@nestor/contracts";
import { APPLICATION_DETAIL_FACT_LABEL_CLASS } from "./applications-detail-fact-strip";

function RunHistoryEntry(props: {
  isSelected: boolean;
  onSelect: () => void;
  result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];
  run: JobFinderRendererWorkspaceSnapshot["applyRuns"][number] | null;
}) {
  const { isSelected, onSelect, result, run } = props;
  const applicationState = resolveApplyStatePresentation({
    mode: "fill_only",
    result,
    run: run
      ? { state: run.state, activityPaused: false, started: true }
      : null,
  });

  return (
    <button
      aria-pressed={isSelected}
      className={cn(
        "grid w-full min-w-0 gap-1 rounded-(--radius-field) border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30",
        isSelected
          ? "border-primary bg-primary/8"
          : "border-(--surface-panel-border) bg-background/40 hover:bg-background/60",
      )}
      onClick={onSelect}
      title={result.runId}
      type="button"
    >
      <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <strong className="min-w-0 break-words [overflow-wrap:anywhere] text-(length:--text-field) text-foreground">
          {run ? formatApplyRunModeLabel(run.mode) : "Preparation run"}
        </strong>
        <StatusBadge
          tone={
            result.state === "submitted"
              ? "positive"
              : result.state === "blocked" ||
                  result.state === "failed" ||
                  result.state === "skipped" ||
                  result.state === "cancelled"
                ? "critical"
                : "active"
          }
        >
          {result.summary === PREPARED_PAGE_CLOSED_SUMMARY
            ? "Prepare again"
            : result.state === "cancelled"
              ? "Cancelled by you"
              : applicationState.kind === "ready_to_send" &&
                  result.privacyReceipt?.submissionOutcome?.browserAction
                    ?.reason !== "form_validation_failed"
                ? applicationState.title
                : formatStatusLabel(result.state)}
        </StatusBadge>
      </span>
      {/* The same title the status block gives this run. A run that paused
          on questions used to be listed as "could not finish this
          application" here while the panel above called it waiting on an
          answer. */}
      <p className="min-w-0 break-words [overflow-wrap:anywhere] text-(length:--text-small) leading-5 text-foreground-soft">
        {
          resolveApplicationRecoveryPresentation({
            canOpenSafeguards: false,
            isApplyPending: false,
            run: run
              ? { state: run.state, activityPaused: false, started: true }
              : null,
            visibleApplyResult: result,
          }).statusLine
        }
      </p>
      <p className="min-w-0 break-words [overflow-wrap:anywhere] text-(length:--text-small) leading-5 text-foreground-soft">
        {formatTimestamp(result.updatedAt)}
        {run ? ` • ${formatApplyRunStateLabel(run.state)}` : ""}
        {result.blockerSummary
          ? ` • ${getCustomerFacingApplyText(result.blockerSummary)}`
          : ""}
      </p>
    </button>
  );
}

export function ApplicationsDetailPanelRunHistorySection(props: {
  applyRunHistory: Array<{
    result: JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];
    run: JobFinderRendererWorkspaceSnapshot["applyRuns"][number] | null;
  }>;
  onSelectApplyRun: (runId: string) => void;
  selectedApplyRunId: string | null;
}) {
  const { applyRunHistory, onSelectApplyRun, selectedApplyRunId } = props;

  if (!applyRunHistory.length) {
    return null;
  }

  const selectedEntry =
    applyRunHistory.find(({ result }) => result.runId === selectedApplyRunId) ??
    applyRunHistory[0]!;
  const olderEntries = applyRunHistory.filter(
    ({ result }) => result.runId !== selectedEntry.result.runId,
  );

  return (
    <section className="surface-card-tint grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="grid gap-1">
        <h3 className={cn(APPLICATION_DETAIL_FACT_LABEL_CLASS, "text-primary")}>
          Current preparation run
        </h3>
        <p className="text-(length:--text-small) leading-6 text-foreground-soft">
          The selected run drives recovery actions above. Older runs stay
          available for reference only.
        </p>
      </div>
      <RunHistoryEntry
        isSelected
        onSelect={() => onSelectApplyRun(selectedEntry.result.runId)}
        result={selectedEntry.result}
        run={selectedEntry.run}
      />
      {olderEntries.length > 0 ? (
        <details className="group min-w-0">
          <ApplicationsDisclosureSummary>
            {`${olderEntries.length} earlier preparation run${
              olderEntries.length === 1 ? "" : "s"
            }`}
          </ApplicationsDisclosureSummary>
          <ul className="mt-2 grid gap-2" role="list">
            {olderEntries.map(({ result, run }) => (
              <li key={result.id}>
                <RunHistoryEntry
                  isSelected={false}
                  onSelect={() => onSelectApplyRun(result.runId)}
                  result={result}
                  run={run}
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
