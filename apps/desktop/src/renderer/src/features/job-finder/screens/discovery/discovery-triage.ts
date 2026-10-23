import { useEffect, useMemo, useRef, useState } from "react";
import type { JobListRow, ReviewQueueItem } from "@nestor/contracts";
import type { JobFinderQueuedJobOutcome } from "../../lib/job-finder-types";
import { prefetchJobDetail } from "../../hooks/use-job-detail";
import { hasOpenJobFinderOverlays } from "../../lib/job-finder-overlay-ownership";
import { isImeComposingEvent } from "../../lib/job-finder-shortcuts";
import { isDiscoveryAlsoFoundResult } from "./discovery-result-groups";
import { useKeptRouteHidden } from "../../lib/kept-route-visibility";

/**
 * A pass through Find jobs, one job at a time: Shortlist, Not interested, or
 * Skip, and the next job opens at once with its details already read. The
 * decision is sent behind the person (it takes a moment in the app), the last
 * one can be undone, and the bar says how far they are.
 *
 * Keys follow Quick review's (S shortlist, X not interested, J next, K back,
 * U undo). They act only outside text fields and open menus or dialogs, and
 * every one of them is reversible, so none is listed with the app-wide
 * shortcuts (which hold no approve, delete or send key).
 */
export interface DiscoveryTriage {
  /** Counted within the open job's group, so 5,000 weaker matches do not
   * bury the progress through the real ones. */
  goneThrough: number;
  total: number;
  weaker: boolean;
  nextTitle: string | null;
  onShortlist: (() => void) | null;
  onNotInterested: (() => void) | null;
  onSkip: (() => void) | null;
  undo: { label: string; onUndo: () => void } | null;
  failure: string | null;
}

const SHORTLISTED_STATUSES = new Set([
  "drafting",
  "ready_for_review",
  "approved",
  "submitted",
]);

interface LastDecision {
  kind: "shortlist" | "hide";
  jobId: string;
  title: string;
}

/**
 * Sends a decision once the next job has painted. Sent in the same tick, the
 * request's pending state re-rendered the page together with the selection
 * and the next job showed about 200ms later than a plain Skip.
 */
function afterNextPaint(run: () => void) {
  if (typeof window.requestAnimationFrame !== "function") {
    run();
    return;
  }
  window.requestAnimationFrame(() => window.setTimeout(run, 0));
}

export function findNextTriageJobId(
  orderedJobIds: readonly string[],
  currentJobId: string | null,
  isOpen: (jobId: string) => boolean,
  direction: 1 | -1 = 1,
): string | null {
  if (orderedJobIds.length === 0) return null;
  const start = currentJobId ? orderedJobIds.indexOf(currentJobId) : -1;
  for (let step = 1; step <= orderedJobIds.length; step += 1) {
    const index =
      (start + direction * step + orderedJobIds.length * 2) %
      orderedJobIds.length;
    const jobId = orderedJobIds[index]!;
    if (jobId !== currentJobId && isOpen(jobId)) return jobId;
  }
  return null;
}

export function useDiscoveryTriage(input: {
  enabled: boolean;
  jobs: readonly JobListRow[];
  orderedJobIds: readonly string[];
  inspectedJob: JobListRow | null;
  reviewQueue: readonly ReviewQueueItem[];
  campaignId: string | null;
  onSelectJob: (jobId: string) => void;
  onQueueJob: (
    jobId: string,
    options?: { quiet?: boolean },
  ) => void | Promise<JobFinderQueuedJobOutcome>;
  onDismissJob: (jobId: string) => void | Promise<void>;
  onRestoreDismissedJob: (jobId: string) => void;
  onRemoveFromShortlist?: (jobIds: readonly string[]) => Promise<void>;
}): DiscoveryTriage | null {
  // Each decided job, and whether it was a weaker match.
  const [decided, setDecided] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const [last, setLast] = useState<LastDecision | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const jobsById = useMemo(
    () => new Map(input.jobs.map((job) => [job.id, job] as const)),
    [input.jobs],
  );
  const shortlistedIds = useMemo(
    () => new Set(input.reviewQueue.map((item) => item.jobId)),
    [input.reviewQueue],
  );
  const weakerIds = useMemo(
    () =>
      new Set(
        input.jobs.filter(isDiscoveryAlsoFoundResult).map((job) => job.id),
      ),
    [input.jobs],
  );
  const isOpen = (jobId: string) => {
    if (decided.has(jobId) || shortlistedIds.has(jobId)) return false;
    const job = jobsById.get(jobId);
    return Boolean(job) && !SHORTLISTED_STATUSES.has(job!.status);
  };
  const current = input.inspectedJob;
  const currentId = current?.id ?? null;
  const currentWeaker = currentId !== null && weakerIds.has(currentId);
  // Open jobs in each group, counted once per change to the list or the
  // decisions. Counted on every render, moving to the next job walked all
  // 6,000 rows again.
  const orderedJobIds = input.orderedJobIds;
  const openCounts = useMemo(() => {
    let weaker = 0;
    let stronger = 0;
    for (const jobId of orderedJobIds) {
      if (decided.has(jobId) || shortlistedIds.has(jobId)) continue;
      const job = jobsById.get(jobId);
      if (!job || SHORTLISTED_STATUSES.has(job.status)) continue;
      if (weakerIds.has(jobId)) weaker += 1;
      else stronger += 1;
    }
    return { weaker, stronger };
  }, [decided, jobsById, orderedJobIds, shortlistedIds, weakerIds]);
  const openCount = currentWeaker ? openCounts.weaker : openCounts.stronger;
  const decidedCount = [...decided.values()].filter(
    (weaker) => weaker === currentWeaker,
  ).length;
  const nextId = findNextTriageJobId(input.orderedJobIds, currentId, isOpen);
  const previousId = findNextTriageJobId(
    input.orderedJobIds,
    currentId,
    (jobId) => jobsById.has(jobId),
    -1,
  );
  const currentIsOpen = currentId !== null && isOpen(currentId);

  const markDecided = (jobId: string, value: boolean) =>
    setDecided((previous) => {
      const next = new Map(previous);
      if (value) next.set(jobId, weakerIds.has(jobId));
      else next.delete(jobId);
      return next;
    });

  const shortlist = () => {
    if (!current || !currentIsOpen) return;
    const { id: jobId, title } = current;
    markDecided(jobId, true);
    setLast({ kind: "shortlist", jobId, title });
    setFailure(null);
    if (nextId) input.onSelectJob(nextId);
    const onQueueJob = input.onQueueJob;
    afterNextPaint(() => {
      void Promise.resolve(onQueueJob(jobId, { quiet: true }))
        .then((outcome) => {
          if (outcome && outcome.status === "failure") {
            markDecided(jobId, false);
            setFailure(`${title} was not shortlisted. ${outcome.message}`);
          }
        })
        .catch(() => {
          markDecided(jobId, false);
          setFailure(`${title} was not shortlisted. Try again.`);
        });
    });
  };
  const notInterested = () => {
    if (!current || !currentIsOpen) return;
    const { id: jobId, title } = current;
    markDecided(jobId, true);
    setLast({ kind: "hide", jobId, title });
    setFailure(null);
    if (nextId) input.onSelectJob(nextId);
    const onDismissJob = input.onDismissJob;
    afterNextPaint(() => {
      void Promise.resolve(onDismissJob(jobId)).catch(() => {
        markDecided(jobId, false);
        setFailure(`${title} could not be hidden. Try again.`);
      });
    });
  };
  const skip = () => {
    if (nextId) input.onSelectJob(nextId);
  };
  const back = () => {
    if (previousId) input.onSelectJob(previousId);
  };
  // A hidden job comes back into the list only once the restore lands, so
  // it is opened then; opening it before would fall back to the first row.
  const [reopenJobId, setReopenJobId] = useState<string | null>(null);
  const undo = () => {
    if (!last) return;
    if (last.kind === "hide") {
      input.onRestoreDismissedJob(last.jobId);
      setReopenJobId(last.jobId);
    } else {
      const { jobId, title } = last;
      void input.onRemoveFromShortlist?.([jobId]).catch(() => {
        markDecided(jobId, true);
        setFailure(`${title} is still in Shortlisted. Try Undo again.`);
      });
      input.onSelectJob(jobId);
    }
    markDecided(last.jobId, false);
    setLast(null);
    setFailure(null);
  };
  const onSelectJob = input.onSelectJob;
  const reopenRowListed = reopenJobId !== null && jobsById.has(reopenJobId);
  useEffect(() => {
    if (!reopenJobId || !reopenRowListed) return;
    onSelectJob(reopenJobId);
    setReopenJobId(null);
  }, [onSelectJob, reopenJobId, reopenRowListed]);
  const canUndo =
    last !== null && (last.kind === "hide" || Boolean(input.onRemoveFromShortlist));

  // The keys read the latest handlers without re-subscribing every render.
  const handlersRef = useRef({ shortlist, notInterested, skip, back, undo });
  handlersRef.current = { shortlist, notInterested, skip, back, undo };
  const enabled = input.enabled;
  // Find jobs stays mounted behind other screens; its keys are off there.
  const hiddenBehindAnotherScreen = useKeptRouteHidden();
  const keysEnabled = enabled && !hiddenBehindAnotherScreen;
  useEffect(() => {
    if (!keysEnabled) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isImeComposingEvent(event) ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        hasOpenJobFinderOverlays()
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      )
        return;
      const handlers = handlersRef.current;
      const action =
        event.key === "s" || event.key === "S"
          ? handlers.shortlist
          : event.key === "x" || event.key === "X"
            ? handlers.notInterested
            : event.key === "j" || event.key === "J"
              ? handlers.skip
              : event.key === "k" || event.key === "K"
                ? handlers.back
                : event.key === "u" || event.key === "U"
                  ? handlers.undo
                  : null;
      if (!action) return;
      event.preventDefault();
      // A held S or X would decide a run of jobs where Undo takes back only
      // the last one; only moving through the list repeats.
      if (event.repeat && action !== handlers.skip && action !== handlers.back)
        return;
      action();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keysEnabled]);

  // Read the next job while this one is being read.
  const nextRow = nextId ? (jobsById.get(nextId) ?? null) : null;
  const campaignId = input.campaignId;
  useEffect(() => {
    if (!enabled || !nextRow) return undefined;
    const timer = window.setTimeout(
      () => prefetchJobDetail(nextRow, campaignId),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [campaignId, enabled, nextRow]);

  if (!enabled || !current) return null;
  return {
    goneThrough: decidedCount,
    total: decidedCount + openCount,
    weaker: currentWeaker,
    nextTitle: nextRow?.title ?? null,
    onShortlist: currentIsOpen ? shortlist : null,
    onNotInterested: currentIsOpen ? notInterested : null,
    onSkip: nextId ? skip : null,
    undo:
      canUndo && last
      ? {
          label:
            last.kind === "hide"
              ? `Undo: show ${last.title} again`
              : `Undo: take ${last.title} off the shortlist`,
          onUndo: undo,
        }
      : null,
    failure,
  };
}
