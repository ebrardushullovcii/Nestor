import { getDiscoverySourceRunCountLabel } from "../../lib/discovery-run-count-label";
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { RotateCcw, X } from "lucide-react";
import type {
  DiscoveryActivityEvent,
  DiscoveryRunRecord,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import {
  BoundedFloatingSurfaceScrollHint,
  useBoundedFloatingSurfaceScrollState,
} from "../../components/bounded-floating-surface";
import {
  CollectionNoMatches,
  CollectionSearchToolbar,
  matchesCollectionSearch,
  normalizeCollectionSearch,
} from "../../components/collection-search-toolbar";
import { isImeComposingEvent } from "../../lib/job-finder-shortcuts";
import { useJobFinderOverlayOwnership } from "../../lib/job-finder-overlay-ownership";
import { usePersistedCollectionView } from "../../hooks/use-persisted-collection-view";
import { formatDuration } from "@renderer/features/job-finder/lib/job-finder-utils";
import {
  formatDiscoveryRunCountLabel,
  formatDiscoveryRunReportLabel,
  getDiscoveryRunReportCounts,
  hasDiscoveryRunReportCounts,
} from "../../lib/discovery-run-count-label";
import {
  buildLiveRunRecord,
  formatOutcomeLabel,
  getRunOptions,
  type DiscoveryTargetConfig,
} from "./discovery-history-utils";

import { describeFailure } from "../../lib/describe-failure";
import {
  createDiscoveryRunSucceededFeedback,
  createDiscoveryRunCancelledFeedback,
  createDiscoveryRunInterruptedFeedback,
} from "./discovery-run-feedback";

function stripTerminalColors(value: string): string {
  return value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g"),
    "",
  );
}

export function describeHistoryRun(run: DiscoveryRunRecord): string {
  const counts = getDiscoveryRunReportCounts(run);
  const feedback =
    run.state === "completed"
      ? createDiscoveryRunSucceededFeedback(
          null,
          describeRunCounts(run),
          counts.new,
          run.targetExecutions.filter((source) => source.state === "failed")
            .length,
        )
      : run.state === "cancelled"
        ? createDiscoveryRunCancelledFeedback({
            savedJobCount: run.summary.validJobsFound,
          })
        : run.state === "running"
          ? null
          : createDiscoveryRunInterruptedFeedback({ detail: null });
  return feedback?.toast
    ? [feedback.toast.title, feedback.toast.description]
        .filter(Boolean)
        .join(". ")
    : (feedback?.headline ?? "Search is running.");
}

/**
 * Search history quotes the run's own frozen report, so a row here reads the
 * same "N found · M new · K kept" as Home, Find jobs, the plan card and
 * Tasks. Runs recorded before the report existed keep the older label rather
 * than inventing numbers for it.
 */
/** Plain words for one source's outcome in a run, never the raw state. */
export function describeSourceRunHealth(
  health: DiscoveryRunRecord["summary"]["sourceHealth"][number]["health"],
): string {
  switch (health) {
    case "healthy":
      return "Finished";
    case "warning":
      return "No jobs collected";
    case "failed":
      return "Could not be read";
    case "cancelled":
      return "Stopped";
    case "skipped":
      return "Skipped";
    default:
      return "Waiting";
  }
}

function describeRunCounts(run: DiscoveryRunRecord): string {
  const report = getDiscoveryRunReportCounts(run);
  if (hasDiscoveryRunReportCounts(report)) {
    return formatDiscoveryRunReportLabel(report);
  }

  return formatDiscoveryRunCountLabel({
    distinctJobsRetained: run.summary.validJobsFound ?? 0,
    duplicatesMerged: run.summary.duplicatesMerged ?? 0,
  });
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRunLabel(value: string): string {
  const date = new Date(value);

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatStageLabel(stage: DiscoveryActivityEvent["stage"]): string {
  switch (stage) {
    case "planning":
      return "Setup";
    case "target":
      return "Source";
    case "navigation":
      return "Opening pages";
    case "extraction":
      return "Review jobs";
    case "scoring":
      return "Score jobs";
    case "persistence":
      return "Save jobs";
    default:
      return "Run";
  }
}

function formatScopeLabel(scope: DiscoveryRunRecord["scope"]): string {
  return scope === "single_target" ? "Single source" : "Run all";
}

function ActivityEventCard(props: {
  event: DiscoveryActivityEvent;
  targetLabel: string | null;
}) {
  const { event, targetLabel } = props;

  return (
    <article className="surface-card-tint grid gap-2 rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[0.78rem] text-foreground-muted">
        <span className="min-w-0 break-words">
          {targetLabel ?? formatStageLabel(event.stage)}
        </span>
        <span className="shrink-0">{formatTimestamp(event.timestamp)}</span>
      </div>
      <p className="text-[0.95rem] leading-6 text-(--text-headline)">
        {stripTerminalColors(event.message)}
      </p>
      {event.jobsFound !== null ||
      event.jobsPersisted !== null ||
      event.jobsStaged !== null ? (
        <div className="flex flex-wrap gap-2 text-[0.76rem] text-foreground-muted">
          {event.jobsFound !== null ? (
            <span>Found {event.jobsFound}</span>
          ) : null}
          {event.jobsPersisted !== null ? (
            <span>Saved {event.jobsPersisted}</span>
          ) : null}
          {event.jobsStaged !== null ? (
            <span>Held for review {event.jobsStaged}</span>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function DiscoveryHistoryModal(props: {
  activeRun: DiscoveryRunRecord | null;
  isDiscoveryPending: boolean;
  isTargetPending: (targetId: string) => boolean;
  liveEvents: readonly DiscoveryActivityEvent[];
  onClose: () => void;
  onRetrySource?: (targetId: string) => void;
  open: boolean;
  recentRuns: readonly DiscoveryRunRecord[];
  targets: readonly DiscoveryTargetConfig[];
}) {
  const dialogTitleId = useId();
  const dialogDescriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  // The activity dialog joins the app-wide LIFO overlay stack so stacked
  // surfaces close one per Escape and shell aliases stay blocked while open.
  const { isTopmost: isDialogTopmost } = useJobFinderOverlayOwnership({
    active: props.open,
    close: () => props.onClose(),
  });
  const eventStreamRef = useRef<HTMLDivElement | null>(null);
  const eventStreamEndRef = useRef<HTMLDivElement | null>(null);
  const wasOpenRef = useRef(false);
  const liveRun = useMemo(
    () =>
      props.activeRun?.state === "running"
        ? props.activeRun
        : buildLiveRunRecord(props.liveEvents, []),
    [props.liveEvents, props.activeRun],
  );
  const runOptions = useMemo(
    () => getRunOptions(liveRun, props.activeRun, props.recentRuns),
    [liveRun, props.activeRun, props.recentRuns],
  );
  const historyView = usePersistedCollectionView(
    "search-history",
    "comfortable",
  );
  const deferredHistoryQuery = useDeferredValue(historyView.query);
  const visibleRunOptions = useMemo(() => {
    // With no search there is nothing to match. Building each run's source
    // text looked up every one of hundreds of sources for every run on each
    // render, closed dialog included.
    if (!normalizeCollectionSearch(deferredHistoryQuery)) return runOptions;
    const targetLabels = new Map(
      props.targets.map((target) => [target.id, target.label] as const),
    );
    return runOptions.filter((run) => {
      const targetText = run.targetExecutions
        .map((execution) => targetLabels.get(execution.targetId))
        .filter(Boolean)
        .join(" ");
      return matchesCollectionSearch(deferredHistoryQuery, [
        formatOutcomeLabel(run.summary.outcome),
        formatScopeLabel(run.scope),
        targetText,
        ...run.summary.warnings,
        ...run.activity.map((event) => event.message),
      ]);
    });
  }, [deferredHistoryQuery, props.targets, runOptions]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    runOptions[0]?.id ?? null,
  );
  const [followLiveEvents, setFollowLiveEvents] = useState(true);
  const followLiveEventsRef = useRef(true);
  const eventStreamScrollState = useBoundedFloatingSurfaceScrollState(
    eventStreamRef,
    props.open,
    selectedRunId,
  );
  const fallbackRunId = runOptions[0]?.id ?? null;
  const hasSelectedRun =
    selectedRunId !== null &&
    runOptions.some((run) => run.id === selectedRunId);

  useEffect(() => {
    if (!props.open) {
      wasOpenRef.current = false;
      return;
    }

    const openedNow = !wasOpenRef.current;
    wasOpenRef.current = true;

    if (!openedNow && hasSelectedRun) {
      return;
    }

    if (liveRun) {
      setSelectedRunId(liveRun.id);
      return;
    }

    if (props.activeRun?.state === "running") {
      setSelectedRunId(props.activeRun.id);
      return;
    }

    setSelectedRunId(fallbackRunId);
  }, [
    props.open,
    hasSelectedRun,
    fallbackRunId,
    liveRun?.id,
    props.activeRun?.id,
    props.activeRun?.state,
  ]);

  useEffect(() => {
    if (!props.open) {
      return;
    }

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus();
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // Overlays opened above this dialog keep first claim on Escape.
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }
      if (event.key === "Escape") {
        if (!isDialogTopmost()) {
          return;
        }
        event.preventDefault();
        props.onClose();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }

      const focusableElements = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="button"], [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => !element.hasAttribute("aria-hidden"));

      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement?.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isDialogTopmost, props.open, props.onClose]);

  const selectedRun =
    runOptions.find((run) => run.id === selectedRunId) ?? runOptions[0] ?? null;
  const displayedEvents = selectedRun?.activity ?? [];
  const selectedRunIsLive = Boolean(liveRun && selectedRun?.id === liveRun.id);
  const targetLabels = useMemo(
    () => new Map(props.targets.map((target) => [target.id, target.label])),
    [props.targets],
  );
  const sourceHealth = useMemo(() => {
    if (!selectedRun) {
      return [];
    }

    if (selectedRun.summary.sourceHealth.length > 0) {
      return selectedRun.summary.sourceHealth;
    }

    return selectedRun.targetExecutions.map((execution) => ({
      targetId: execution.targetId,
      health:
        execution.state === "completed"
          ? execution.warning
            ? ("warning" as const)
            : ("healthy" as const)
          : execution.state === "failed"
            ? ("failed" as const)
            : execution.state === "cancelled"
              ? ("cancelled" as const)
              : execution.state === "skipped"
                ? ("skipped" as const)
                : ("pending" as const),
      durationMs: execution.timing?.totalDurationMs ?? 0,
      warnings: execution.warning ? [execution.warning] : [],
    }));
  }, [selectedRun]);

  useEffect(() => {
    if (!props.open) {
      return;
    }

    followLiveEventsRef.current = selectedRunIsLive;
    setFollowLiveEvents(selectedRunIsLive);
  }, [props.open, selectedRun?.id, selectedRunIsLive]);

  useEffect(() => {
    if (!props.open || !selectedRunIsLive || !followLiveEvents) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      eventStreamEndRef.current?.scrollIntoView({ block: "end" });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [displayedEvents.length, followLiveEvents, props.open, selectedRunIsLive]);

  if (!props.open) {
    return null;
  }

  const handleEventStreamScroll = () => {
    const container = eventStreamRef.current;

    if (!container || !selectedRunIsLive) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const nextFollowLiveEvents = distanceFromBottom < 48;

    // Scroll fires continuously; only the edge transition is observable, so a
    // scroll that does not cross the threshold performs no state update at all
    // rather than relying on React's equality bail-out.
    if (nextFollowLiveEvents === followLiveEventsRef.current) {
      return;
    }

    followLiveEventsRef.current = nextFollowLiveEvents;
    setFollowLiveEvents(nextFollowLiveEvents);
  };

  const resumeLiveFollow = () => {
    followLiveEventsRef.current = true;
    setFollowLiveEvents(true);
    eventStreamEndRef.current?.scrollIntoView({ block: "end" });
  };

  const selectedReport = getDiscoveryRunReportCounts(selectedRun);
  const duplicateCount =
    selectedReport.duplicates ?? selectedRun?.summary.duplicatesMerged ?? 0;
  return (
    <div
      className="fixed inset-0 z-[140] overflow-y-auto bg-(--modal-scrim) p-6 backdrop-blur-sm sm:p-10 backdrop-blur-sm"
      onClick={props.onClose}
    >
      <div
        aria-describedby={dialogDescriptionId}
        aria-labelledby={dialogTitleId}
        aria-modal="true"
        className="mx-auto flex min-h-0 max-h-(--discovery-history-max-height) w-full max-w-5xl flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) shadow-(--modal-shadow)"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-(--surface-panel-border) px-5 py-4">
          <div className="grid gap-1">
            <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
              Recent searches
            </p>
            <h2
              className="text-[1.3rem] font-semibold tracking-[-0.02em] text-(--text-headline)"
              id={dialogTitleId}
            >
              Search history
            </h2>
            <p
              className="text-[0.9rem] leading-6 text-foreground-soft"
              id={dialogDescriptionId}
            >
              {selectedRunIsLive
                ? "Follow the current search here while new activity arrives."
                : "See what happened in each earlier search."}
            </p>
          </div>
          <Button
            aria-label="Close"
            className="size-10"
            onClick={props.onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="grid min-h-0 min-w-0 content-start gap-3 overflow-x-hidden overflow-y-auto border-b border-(--surface-panel-border) px-4 py-4 lg:border-b-0 lg:border-r">
            <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
              Searches
            </p>
            {runOptions.length > 0 ? (
              <CollectionSearchToolbar
                className="px-0"
                label="Find a search"
                onQueryChange={historyView.setQuery}
                placeholder="Search outcome, source, or activity"
                query={historyView.query}
                totalCount={runOptions.length}
                visibleCount={visibleRunOptions.length}
              />
            ) : null}
            <div className="grid gap-2 pb-1">
              {visibleRunOptions.length > 0 ? (
                visibleRunOptions.map((run) => {
                  const isSelected = run.id === selectedRun?.id;
                  const isLive = liveRun?.id === run.id;
                  const durationSummary =
                    run.summary.durationMs > 0
                      ? ` · ${formatDuration(run.summary.durationMs)}`
                      : "";

                  return (
                    <button
                      aria-pressed={isSelected}
                      className={[
                        "grid gap-1 rounded-(--radius-panel) border px-3 py-3 text-left transition-colors",
                        isSelected
                          ? "border-primary/40 bg-primary/10 text-foreground"
                          : "border-(--surface-panel-border) bg-(--surface-panel-raised) text-foreground-soft hover:bg-secondary",
                      ].join(" ")}
                      key={run.id}
                      onClick={() => setSelectedRunId(run.id)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[0.94rem] font-semibold text-(--text-headline)">
                          {formatOutcomeLabel(run.summary.outcome)}
                        </span>
                        {isLive ? (
                          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-(--tracking-label) text-primary">
                            Live
                          </span>
                        ) : null}
                      </div>
                      <span className="text-[0.8rem] text-foreground-muted">
                        {formatRunLabel(run.startedAt)}
                      </span>
                      <span className="text-[0.8rem] text-foreground-muted">
                        {`${run.summary.targetsCompleted}/${run.summary.targetsPlanned} sources completed · ${describeRunCounts(
                          run,
                        )}${durationSummary}`}
                      </span>
                    </button>
                  );
                })
              ) : runOptions.length > 0 ? (
                <CollectionNoMatches
                  noun="searches"
                  onClear={() => historyView.setQuery("")}
                  query={historyView.query}
                />
              ) : (
                <p className="text-[0.9rem] leading-6 text-foreground-soft">
                  No searches yet. Your recent runs will appear here.
                </p>
              )}
            </div>
          </aside>

          <div className="grid min-h-0 content-start gap-4 overflow-y-auto px-4 py-4">
            {selectedRun ? <p>{describeHistoryRun(selectedRun)}</p> : null}
            {selectedRun ? (
              <div className="grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-panel-raised) px-4 py-4 sm:grid-cols-4">
                <div>
                  <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                    Started
                  </p>
                  <p className="mt-2 text-[0.95rem] font-semibold text-(--text-headline)">
                    {formatRunLabel(selectedRun.startedAt)}
                  </p>
                </div>
                <div>
                  <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                    Outcome
                  </p>
                  <p className="mt-2 text-[0.95rem] font-semibold text-(--text-headline)">
                    {selectedRun.runPhase === "interrupted"
                      ? "Interrupted"
                      : formatOutcomeLabel(selectedRun.summary.outcome)}
                  </p>
                </div>
                <div>
                  <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                    Scope
                  </p>
                  <p className="mt-2 text-[0.95rem] font-semibold text-(--text-headline)">
                    {formatScopeLabel(selectedRun.scope)}
                  </p>
                </div>
                <div>
                  <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                    New to you
                  </p>
                  <p className="mt-2 text-[0.95rem] font-semibold text-(--text-headline)">
                    {getDiscoveryRunReportCounts(selectedRun).new ??
                      selectedRun.summary.validJobsFound}
                    {duplicateCount > 0 ? (
                      <span className="ml-2 text-[0.78rem] font-normal text-foreground-muted">
                        {`${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} merged`}
                      </span>
                    ) : null}
                  </p>
                </div>
                <div>
                  <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                    Saved directly / held for review
                  </p>
                  <p className="mt-2 text-[0.95rem] font-semibold text-(--text-headline)">
                    {selectedRun.summary.jobsPersisted} /{" "}
                    {selectedRun.summary.jobsStaged}
                  </p>
                </div>
                {selectedRun.summary.durationMs > 0 ? (
                  <div>
                    <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                      Duration
                    </p>
                    <p className="mt-2 text-[0.95rem] font-semibold text-(--text-headline)">
                      {formatDuration(selectedRun.summary.durationMs)}
                    </p>
                  </div>
                ) : null}
                {selectedRun.summary.timing?.longestGapMs != null &&
                selectedRun.summary.timing.longestGapMs > 10000 ? (
                  <div>
                    <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                      Longest quiet gap
                    </p>
                    <p className="mt-2 text-[0.95rem] font-semibold text-(--text-headline)">
                      {formatDuration(selectedRun.summary.timing.longestGapMs)}
                    </p>
                  </div>
                ) : null}
                {selectedRun.summary.browserCloseout ? (
                  <div className="sm:col-span-2">
                    <p className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                      Browser closeout
                    </p>
                    <p className="mt-2 text-[0.95rem] font-semibold text-(--text-headline)">
                      {selectedRun.summary.browserCloseout.label}
                    </p>
                    {selectedRun.summary.browserCloseout.detail ? (
                      <p className="mt-1 text-[0.84rem] leading-6 text-foreground-soft">
                        {selectedRun.summary.browserCloseout.detail}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            {selectedRun ? (
              <div className="grid gap-4">
                <section
                  aria-labelledby={`${dialogTitleId}-changes`}
                  className="grid gap-2"
                >
                  <h3
                    className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted"
                    id={`${dialogTitleId}-changes`}
                  >
                    Changes since earlier searches
                  </h3>
                  {(() => {
                    const changeCounts: ReadonlyArray<[string, number]> = [
                      // Listings seen for the first time, before the plan's
                      // "jobs to retain" limit; can exceed the saved count.
                      [
                        "New to you",
                        getDiscoveryRunReportCounts(selectedRun).new ??
                          selectedRun.summary.validJobsFound,
                      ],
                      ["Unchanged", selectedRun.summary.changeDigest.unchanged],
                      ["Changed", selectedRun.summary.changeDigest.changed],
                      [
                        "Reactivated",
                        selectedRun.summary.changeDigest.reactivated,
                      ],
                      ["Inactive", selectedRun.summary.changeDigest.inactive],
                      ["Skipped", selectedRun.summary.changeDigest.skipped],
                    ];
                    // A row of zeros is not evidence. Only the states this run
                    // actually observed get a card; when none did, one sentence
                    // says so instead of seven empty boxes.
                    const observed = changeCounts.filter(
                      ([, value]) => value > 0,
                    );

                    if (observed.length === 0) {
                      return (
                        <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                          This search found no changes against earlier searches.
                        </p>
                      );
                    }

                    return (
                      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
                        {observed.map(([label, value]) => (
                          <div
                            className="rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-panel-raised) px-3 py-2"
                            key={label}
                          >
                            <dt className="text-(length:--text-label) uppercase tracking-(--tracking-label) text-foreground-muted">
                              {label}
                            </dt>
                            <dd className="mt-1 text-(length:--text-heading-3) font-semibold text-(--text-headline)">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    );
                  })()}
                </section>

                {sourceHealth.length > 0 ? (
                  <section
                    aria-labelledby={`${dialogTitleId}-sources`}
                    className="grid gap-2"
                  >
                    <h3
                      className="text-[0.72rem] uppercase tracking-(--tracking-label) text-foreground-muted"
                      id={`${dialogTitleId}-sources`}
                    >
                      Source health
                    </h3>
                    <div className="grid gap-2 md:grid-cols-2">
                      {sourceHealth.map((source) => {
                        const sourceLabel =
                          targetLabels.get(source.targetId) ??
                          "Configured source";
                        const isRetrying = props.isTargetPending(
                          source.targetId,
                        );
                        const canRetry =
                          source.health === "failed" &&
                          Boolean(props.onRetrySource);
                        const execution = selectedRun.targetExecutions.find(
                          (candidate) => candidate.targetId === source.targetId,
                        );
                        // These are disjoint additions in the frozen run:
                        // direct saved jobs and jobs staged for the results list.
                        const contributed =
                          (execution?.jobsPersisted ?? 0) +
                          (execution?.jobsStaged ?? 0);
                        const terminalReport =
                          contributed === 0 &&
                          (execution?.state !== "completed" ||
                            source.health !== "healthy")
                            ? selectedRun.activity.findLast(
                                (event) =>
                                  event.targetId === source.targetId &&
                                  event.stage === "target" &&
                                  event.terminalState !== null,
                              )?.message
                            : undefined;
                        // Jobs this source listed that were already saved: a
                        // quiet re-run found them, it did not come up empty.
                        const alreadySaved =
                          (execution?.duplicatesMerged ?? 0) +
                          (execution?.jobsSkippedByLedger ?? 0);
                        const previousExecution = props.recentRuns
                          .filter((run) => run.id !== selectedRun.id)
                          .sort((left, right) =>
                            right.startedAt.localeCompare(left.startedAt),
                          )
                          .flatMap((run) => run.targetExecutions)
                          .find(
                            (candidate) =>
                              candidate.targetId === source.targetId,
                          );
                        const repeatedZero =
                          contributed === 0 &&
                          alreadySaved === 0 &&
                          previousExecution?.jobsPersisted === 0 &&
                          previousExecution.jobsStaged === 0 &&
                          previousExecution.duplicatesMerged +
                            previousExecution.jobsSkippedByLedger ===
                            0;
                        const zeroReason =
                          repeatedZero && !terminalReport
                            ? execution?.warning || source.warnings[0]
                              ? "The source was blocked or could not be read. Review it in the Job Finder browser or replace it."
                              : (execution?.jobsReviewed ?? 0) === 0
                                ? "The page layout could not be read. Check the source address or try another careers page."
                                : "No jobs matched this plan in either of its last two runs. Broaden the plan or try another source."
                            : null;

                        return (
                          <article
                            className="grid gap-2 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-panel-raised) px-3 py-3"
                            key={source.targetId}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0">
                                <p className="break-words text-[0.9rem] font-semibold text-(--text-headline)">
                                  {sourceLabel}
                                </p>
                                <p className="mt-1 text-[0.76rem] text-foreground-muted">
                                  {describeSourceRunHealth(source.health)}
                                  {source.durationMs > 0
                                    ? ` · ${formatDuration(source.durationMs)}`
                                    : ""}
                                </p>
                                <p className="mt-1 text-[0.82rem] text-foreground-soft">
                                  {getDiscoverySourceRunCountLabel(
                                    selectedRun,
                                    source.targetId,
                                  )}
                                  .
                                </p>
                                {execution?.sourceCounts
                                  ?.filter(
                                    (counts) =>
                                      counts.sourceId !== source.targetId,
                                  )
                                  .map((counts) => (
                                    <p
                                      key={counts.sourceId}
                                      className="mt-1 text-[0.82rem] text-foreground-soft"
                                    >
                                      Found on {counts.label}:{" "}
                                      {counts.inspected} inspected ·{" "}
                                      {counts.saved} saved · {counts.rejected}{" "}
                                      rejected · {counts.duplicates} duplicates
                                      · {counts.deferred} deferred ·{" "}
                                      {counts.pagesCovered ?? "Not recorded"}{" "}
                                      {counts.pagesCovered === 1
                                        ? "page"
                                        : "pages"}{" "}
                                      covered.
                                    </p>
                                  ))}
                                {execution?.rejectedListings?.length ? (
                                  <details className="mt-2 text-[0.82rem] text-foreground-soft">
                                    <summary>
                                      Why listings were excluded
                                    </summary>
                                    <ul>
                                      {execution.rejectedListings.map(
                                        (listing, index) => (
                                          <li key={`${listing.url}:${index}`}>
                                            {listing.title}: {listing.reason}
                                          </li>
                                        ),
                                      )}
                                    </ul>
                                  </details>
                                ) : null}
                              </div>
                              {canRetry ? (
                                <Button
                                  aria-label={`Retry failed source ${sourceLabel}`}
                                  disabled={
                                    props.isDiscoveryPending || isRetrying
                                  }
                                  onClick={() =>
                                    props.onRetrySource?.(source.targetId)
                                  }
                                  size="sm"
                                  type="button"
                                  variant="secondary"
                                >
                                  <RotateCcw
                                    aria-hidden="true"
                                    className="size-3.5"
                                  />
                                  {isRetrying ? "Retrying" : "Retry source"}
                                </Button>
                              ) : null}
                            </div>
                            {source.warnings.length > 0 &&
                            execution?.state !== "completed" ? (
                              <>
                                <p className="text-[0.82rem] leading-5 text-foreground-soft">
                                  {contributed > 0
                                    ? "Some jobs were collected, but this source did not finish."
                                    : describeFailure(source.warnings[0], {
                                        action: "read this source",
                                      }).userMessage}
                                </p>
                              </>
                            ) : null}
                            {source.warnings.length > 0 || terminalReport ? (
                              <details>
                                <summary>Technical details</summary>
                                {[
                                  ...source.warnings,
                                  ...(terminalReport ? [terminalReport] : []),
                                ].map((detail, index) => (
                                  <p
                                    className="text-[0.82rem] leading-5 text-foreground-soft"
                                    key={index}
                                  >
                                    {stripTerminalColors(detail)}
                                  </p>
                                ))}
                              </details>
                            ) : null}
                            {zeroReason ? (
                              <p className="text-[0.82rem] leading-5 text-(--warning-text)">
                                {zeroReason}
                              </p>
                            ) : null}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : null}

            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
              <p className="text-[0.78rem] uppercase tracking-(--tracking-label) text-foreground-muted">
                {selectedRunIsLive ? "Current search" : "What happened"}
              </p>
              {selectedRunIsLive ? (
                followLiveEvents ? (
                  <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[0.68rem] font-semibold uppercase tracking-(--tracking-label) text-primary">
                    Live
                  </span>
                ) : (
                  <Button
                    onClick={resumeLiveFollow}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Jump to latest
                  </Button>
                )
              ) : null}
            </div>

            {/* The activity log clips its last row against the dialog edge,
                so it carries the same edge affordance the shared bounded
                floating surfaces use instead of cutting a line mid-glyph with
                nothing to say there is more. */}
            <details className="relative grid min-h-0">
              <summary>Technical details</summary>
              <BoundedFloatingSurfaceScrollHint
                edge="start"
                visible={
                  eventStreamScrollState.hasOverflow &&
                  !eventStreamScrollState.atStart
                }
              />
              <BoundedFloatingSurfaceScrollHint
                edge="end"
                visible={
                  eventStreamScrollState.hasOverflow &&
                  !eventStreamScrollState.atEnd
                }
              />
              <div
                aria-atomic="false"
                aria-label={
                  selectedRunIsLive
                    ? "Current search activity"
                    : "Search activity"
                }
                aria-live="polite"
                aria-relevant="additions"
                className="grid gap-3 pb-6"
                onScroll={handleEventStreamScroll}
                ref={eventStreamRef}
                role="log"
              >
                {displayedEvents.length > 0 ? (
                  displayedEvents.map((event) => (
                    <ActivityEventCard
                      event={event}
                      key={event.id}
                      targetLabel={
                        event.targetId
                          ? (targetLabels.get(event.targetId) ??
                            "Configured source")
                          : null
                      }
                    />
                  ))
                ) : (
                  <p className="text-[0.9rem] leading-6 text-foreground-soft">
                    No activity was recorded for this run.
                  </p>
                )}
                <div aria-hidden="true" ref={eventStreamEndRef} />
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}
