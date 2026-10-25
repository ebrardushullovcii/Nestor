import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  JobFinderRendererWorkspaceSnapshot,
  ResumeImportProgressEvent,
} from "@nestor/contracts";
import { ListChecks, X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { StatusBadge } from "../status-badge";
import type { RecentChange } from "../../lib/recent-changes";
import { RecentChangesSection } from "./recent-changes-section";
import { isImeComposingEvent } from "../../lib/job-finder-shortcuts";
import { useJobFinderOverlayOwnership } from "../../lib/job-finder-overlay-ownership";
import { requestLegacyWorkspace } from "../../lib/legacy-workspace-demand";
import {
  buildJobFinderTaskCenterModel,
  describeTaskCenterCounts,
  type JobFinderTaskCenterItem,
  type JobFinderTaskCenterModel,
  isStaleFinishedTask,
} from "./job-finder-task-center-model";

interface JobFinderTaskCenterProps {
  /** Null until the old workspace loads; opening the panel asks for it. */
  workspace: JobFinderRendererWorkspaceSnapshot | null;
  isResumeImportPending: boolean;
  resumeImportProgress?: ResumeImportProgressEvent | null | undefined;
  onNavigate?: ((path: string) => void | Promise<void>) | undefined;
  /** Puts back one of the person's recent moves. */
  onUndoRecentChange?: ((change: RecentChange) => Promise<boolean>) | undefined;
}

const NO_TASKS: JobFinderTaskCenterModel = {
  activeCount: 0,
  pausedCount: 0,
  items: [],
};

const CLEARED_ACTIVITY_STORAGE_KEY = "nestor.job-finder.cleared-activity.v1";

function readClearedActivityIds(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(CLEARED_ACTIVITY_STORAGE_KEY) ?? "[]",
    ) as unknown;
    return new Set(
      Array.isArray(stored)
        ? stored.filter((value): value is string => typeof value === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function isFinishedActivity(item: JobFinderTaskCenterItem): boolean {
  return item.status === "completed" || item.status === "cancelled";
}

function taskTone(status: JobFinderTaskCenterItem["status"]) {
  if (status === "active" || status === "stopping") {
    return "active" as const;
  }
  if (status === "completed") {
    return "positive" as const;
  }
  // A run that failed or was cut short can be run again; amber says "look
  // at this" without the alarm red reserves for something at risk.
  if (status === "failed" || status === "interrupted") {
    return "warning" as const;
  }
  return "muted" as const;
}

function statusLabel(status: JobFinderTaskCenterItem["status"]): string {
  return status === "active"
    ? "In progress"
    : status === "stopping"
      ? "Stopping"
      : status === "paused"
        ? "Paused"
        : status === "completed"
          ? "Complete"
          : status === "cancelled"
            ? "Stopped"
            : status === "failed"
              ? "Failed"
              : "Interrupted";
}

export function JobFinderTaskCenter(props: JobFinderTaskCenterProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  // The panel is React-controlled so the overlay ownership stack always knows
  // whether the Task Center is open, regardless of how the last toggle
  // happened (summary click, Escape, outside press, or task navigation).
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [taskFeedback, setTaskFeedback] = useState<
    Readonly<Record<string, string>>
  >({});
  const [clearedActivityIds, setClearedActivityIds] = useState(
    readClearedActivityIds,
  );
  const model = useMemo(
    () =>
      props.workspace
        ? buildJobFinderTaskCenterModel({
            workspace: props.workspace,
            isResumeImportPending: props.isResumeImportPending,
            resumeImportProgress: props.resumeImportProgress,
          })
        : NO_TASKS,
    [
      props.isResumeImportPending,
      props.resumeImportProgress,
      props.workspace,
    ],
  );

  const closePanel = useCallback((restoreFocus: boolean) => {
    setIsPanelOpen(false);
    if (restoreFocus) {
      summaryRef.current?.focus();
    }
  }, []);

  const { isTopmost: isPanelTopmost } = useJobFinderOverlayOwnership({
    active: isPanelOpen,
    close: () => closePanel(true),
  });

  useEffect(() => {
    if (!isPanelOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Inner controls and higher overlays keep first claim on Escape.
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }
      if (event.key !== "Escape" || !isPanelTopmost()) {
        return;
      }
      event.preventDefault();
      closePanel(true);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !detailsRef.current?.contains(event.target)
      ) {
        closePanel(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [closePanel, isPanelOpen, isPanelTopmost]);

  async function navigateToTask(item: JobFinderTaskCenterItem) {
    if (!item.resumeRoute) {
      return;
    }

    setTaskFeedback((current) => {
      const next = { ...current };
      delete next[item.id];
      return next;
    });
    try {
      if (!props.onNavigate) {
        throw new Error("Task navigation is unavailable");
      }
      await props.onNavigate(item.resumeRoute);
      setIsPanelOpen(false);
    } catch {
      setTaskFeedback((current) => ({
        ...current,
        [item.id]: "That page could not open. Try again.",
      }));
    }
  }

  async function runResumeAction(item: JobFinderTaskCenterItem) {
    await navigateToTask(item);
  }

  async function navigateToReview(item: JobFinderTaskCenterItem) {
    if (!item.reviewRoute || !props.onNavigate) return;
    await props.onNavigate(item.reviewRoute);
    setIsPanelOpen(false);
  }

  const taskCountsLabel = describeTaskCenterCounts(model);
  const visibleItems = model.items.filter(
    (item) =>
      !isFinishedActivity(item) ||
      (!clearedActivityIds.has(item.id) &&
        !isStaleFinishedTask(item, Date.now())),
  );
  const finishedItems = visibleItems.filter(isFinishedActivity);

  function clearFinishedActivity() {
    const next = new Set(clearedActivityIds);
    for (const item of finishedItems) next.add(item.id);
    setClearedActivityIds(next);
    try {
      window.localStorage.setItem(
        CLEARED_ACTIVITY_STORAGE_KEY,
        JSON.stringify([...next]),
      );
    } catch {
      // The panel still clears this session when local storage is unavailable.
    }
  }

  return (
    <details
      className="group relative z-40 shrink-0"
      open={isPanelOpen}
      ref={detailsRef}
    >
      <summary
        aria-label={
          props.workspace?.activityControl?.paused
            ? "Activity: paused"
            : taskCountsLabel
              ? `Activity: ${taskCountsLabel}`
              : "Activity"
        }
        className="inline-flex h-10 min-h-10 min-w-10 cursor-pointer list-none items-center justify-center gap-2 rounded-(--radius-button) border border-(--control-border) bg-(--surface-panel) px-2.5 py-2 text-(length:--text-small) font-medium text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:bg-secondary hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 xl:px-4 xl:text-(length:--text-small) [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          // The panel state owns openness so overlay ownership and shell
          // shortcut blocking stay truthful; cancel the native summary toggle.
          event.preventDefault();
          if (!props.workspace) requestLegacyWorkspace();
          setIsPanelOpen((open) => !open);
        }}
        ref={summaryRef}
        title={
          props.workspace?.activityControl?.paused
            ? "Activity: paused"
            : taskCountsLabel
              ? `Activity: ${taskCountsLabel}`
              : "Activity"
        }
      >
        <ListChecks aria-hidden="true" className="size-4 shrink-0" />
        {/* One name at every width. "Tasks" read as a to-do list for the
            person, which is what Needs you is; this panel is what Job Finder
            itself is doing, so it is named for that. */}
        <span className="hidden whitespace-nowrap min-[900px]:inline max-[1099px]:!hidden xl:max-[1440px]:!hidden">
          Activity
        </span>
        {/* One zero rule for every count in the shell: a badge never renders
            at 0. This chip used to render a permanent grey "Tasks 0" in every
            screenshot of every round — and the one count that rendered zero
            was the one that means "nothing is happening". The accessible name
            on the summary still states the active count at any value. */}
        {props.workspace?.activityControl?.paused ? (
          <span className="text-xs text-foreground">Paused</span>
        ) : taskCountsLabel ? (
          <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-(--input) px-1.5 text-(length:--text-tiny) text-foreground tabular-nums">
            {taskCountsLabel}
          </span>
        ) : null}
      </summary>

      {/* Anchored under its own trigger at every width. As a `fixed` sheet it
          resolved against the header — the header paints a backdrop filter,
          which makes it the containing block — so at the minimum window size
          the panel opened upward over the title bar, clipped its own heading
          off the top of the window, and swallowed clicks on the toolbar. */}
      <section
        aria-label="Activity"
        className="surface-popover-solid absolute right-0 top-12 grid max-h-[min(38rem,calc(100vh-8rem))] w-[min(34rem,calc(100vw-2rem))] gap-3 overflow-x-hidden overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) p-4 shadow-(--modal-shadow) motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-150"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-1">
            <h2 className="font-display text-(--text-headline)">Activity</h2>
            <p className="text-(length:--text-small) leading-5 text-foreground-soft">
              {/* Promise last runs only while there are some to show. */}
              {finishedItems.length > 0
                ? "What Job Finder is doing now and how its last runs ended."
                : "What Job Finder is doing now."}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {finishedItems.length > 0 ? (
              <Button
                onClick={clearFinishedActivity}
                size="compact"
                type="button"
                variant="ghost"
              >
                Clear finished
              </Button>
            ) : null}
            <Button
              aria-label="Close Activity"
              className="shrink-0"
              onClick={() => closePanel(true)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>

        {visibleItems.length === 0 ? (
          <p className="rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3 text-(length:--text-small) text-foreground-soft">
            {props.workspace
              ? "Nothing is running. Resume imports and source checks show here while they work."
              : "Loading activity…"}
          </p>
        ) : (
          <div className="grid gap-3">
            {visibleItems.map((item) => {
              const visibleStatus = item.status;
              return (
                <article
                  className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-3"
                  data-task-kind={item.kind}
                  data-task-status={visibleStatus}
                  key={item.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="grid min-w-0 gap-0.5">
                      <h3 className="font-semibold text-foreground">
                        {item.title}
                      </h3>
                      <p className="break-words text-(length:--text-small) text-foreground-soft">
                        {item.sourceLabel}
                      </p>
                    </div>
                    <StatusBadge tone={taskTone(visibleStatus)}>
                      {statusLabel(visibleStatus)}
                    </StatusBadge>
                  </div>

                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-(length:--text-small) leading-5">
                    {/* "STOPPED" on the badge and "Stage: Stopped" under it
                        said one thing twice. */}
                    {visibleStatus === "stopping" ||
                    item.stageLabel.trim().toLowerCase() ===
                      statusLabel(visibleStatus).toLowerCase() ? null : (
                      <>
                        <dt className="text-foreground-muted">Stage</dt>
                        <dd className="text-foreground">{item.stageLabel}</dd>
                      </>
                    )}
                    <dt className="text-foreground-muted">Progress</dt>
                    <dd className="text-foreground">{item.countLabel}</dd>
                    {item.historyEstimateLabel ? (
                      <>
                        <dt className="text-foreground-muted">
                          History estimate
                        </dt>
                        <dd className="text-foreground">
                          {item.historyEstimateLabel}
                        </dd>
                      </>
                    ) : null}
                  </dl>

                  {item.resumeRoute ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      {item.resumeRoute && item.resumeActionLabel ? (
                        <Button
                          onClick={() => void runResumeAction(item)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          {item.resumeActionLabel}
                        </Button>
                      ) : null}
                      {item.reviewRoute && item.reviewActionLabel ? (
                        <Button
                          onClick={() => void navigateToReview(item)}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          {item.reviewActionLabel}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {taskFeedback[item.id] ? (
                    <p
                      className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-small) leading-5 text-foreground-soft"
                      role="status"
                    >
                      {taskFeedback[item.id]}
                    </p>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
        {props.onUndoRecentChange && props.workspace ? (
          <RecentChangesSection
            onUndo={props.onUndoRecentChange}
            workspace={props.workspace}
          />
        ) : null}
      </section>
    </details>
  );
}
