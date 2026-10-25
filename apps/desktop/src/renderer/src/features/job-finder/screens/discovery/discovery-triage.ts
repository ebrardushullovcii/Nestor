import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewQueueItem, WorkspaceJobListRow } from "@nestor/contracts";
import type { JobFinderQueuedJobOutcome } from "../../lib/job-finder-types";
import { prefetchJobDetail } from "../../hooks/use-job-detail";
import { hasOpenJobFinderOverlays } from "../../lib/job-finder-overlay-ownership";
import { isImeComposingEvent } from "../../lib/job-finder-shortcuts";
import { useEffectWhileKeptRouteShown } from "../../lib/kept-route-visibility";

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

interface TriageDecision {
  weaker: boolean;
  kind: "shortlist" | "hide";
  landed: boolean;
}

export function useDiscoveryTriage(input: {
  enabled: boolean;
  /** The page on screen: titles and statuses of the rows it shows. */
  rows: readonly WorkspaceJobListRow[];
  /** The whole list in order, across pages. */
  orderedJobIds: readonly string[];
  /** A listed job's band. */
  groupOf: (jobId: string) => WorkspaceJobListRow["resultGroup"] | undefined;
  inspectedJob: {
    id: string;
    title: string;
    detailRevision?: string | undefined;
  } | null;
  reviewQueue: readonly ReviewQueueItem[];
  campaignId: string | null;
  /** The inspector's cache key part for a job, so a prefetch is reused. */
  detailRevision?: (jobId: string) => string;
  onSelectJob: (jobId: string) => void;
  onQueueJob: (
    jobId: string,
    options?: { quiet?: boolean },
  ) => void | Promise<JobFinderQueuedJobOutcome>;
  onDismissJob: (jobId: string) => void | Promise<void>;
  onRestoreDismissedJob: (jobId: string) => void;
  onRemoveFromShortlist?: (jobIds: readonly string[]) => Promise<void>;
}): DiscoveryTriage | null {
  // Each decided job: whether it was a weaker match, how it was decided,
  // and whether the decision has landed (the job is in Shortlisted, or has
  // left the list). A landed decision undone somewhere else (Move back,
  // Show again) is forgotten, so the job can be decided again (STAB-009).
  const [decided, setDecided] = useState<ReadonlyMap<string, TriageDecision>>(
    new Map(),
  );
  const [last, setLast] = useState<LastDecision | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const jobsById = useMemo(
    () => new Map(input.rows.map((job) => [job.id, job] as const)),
    [input.rows],
  );
  const shortlistedIds = useMemo(
    () => new Set(input.reviewQueue.map((item) => item.jobId)),
    [input.reviewQueue],
  );
  const groupOf = input.groupOf;
  const isWeaker = (jobId: string) => {
    const group = groupOf(jobId);
    return group === "weaker" || group === "mismatches";
  };
  // Every listed job waits on a decision; a row on this page also says
  // whether it was decided meanwhile.
  const isOpen = (jobId: string) => {
    if (decided.has(jobId) || shortlistedIds.has(jobId)) return false;
    const job = jobsById.get(jobId);
    return !job || !SHORTLISTED_STATUSES.has(job.status);
  };
  const current = input.inspectedJob;
  const currentId = current?.id ?? null;
  const currentWeaker = currentId !== null && isWeaker(currentId);
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
      if (job && SHORTLISTED_STATUSES.has(job.status)) continue;
      const group = groupOf(jobId);
      if (group === "weaker" || group === "mismatches") weaker += 1;
      else stronger += 1;
    }
    return { weaker, stronger };
  }, [decided, groupOf, jobsById, orderedJobIds, shortlistedIds]);
  const openCount = currentWeaker ? openCounts.weaker : openCounts.stronger;
  const decidedCount = [...decided.values()].filter(
    (decision) => decision.weaker === currentWeaker,
  ).length;
  useEffect(() => {
    const listed = new Set(orderedJobIds);
    setDecided((previous) => {
      let next: Map<string, TriageDecision> | null = null;
      for (const [jobId, decision] of previous) {
        const landed =
          decision.kind === "shortlist"
            ? shortlistedIds.has(jobId)
            : !listed.has(jobId);
        if (!decision.landed && landed) {
          next ??= new Map(previous);
          next.set(jobId, { ...decision, landed: true });
        } else if (decision.landed && !landed) {
          next ??= new Map(previous);
          next.delete(jobId);
        }
      }
      return next ?? previous;
    });
  }, [orderedJobIds, shortlistedIds]);
  const nextId = findNextTriageJobId(input.orderedJobIds, currentId, isOpen);
  const previousId = findNextTriageJobId(
    input.orderedJobIds,
    currentId,
    () => true,
    -1,
  );
  const currentIsOpen = currentId !== null && isOpen(currentId);

  const markDecided = (
    jobId: string,
    value: boolean,
    kind: TriageDecision["kind"] = "shortlist",
  ) =>
    setDecided((previous) => {
      const next = new Map(previous);
      if (value)
        next.set(jobId, { weaker: isWeaker(jobId), kind, landed: false });
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
    markDecided(jobId, true, "hide");
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
  const reopenRowListed =
    reopenJobId !== null && input.orderedJobIds.includes(reopenJobId);
  useEffect(() => {
    if (!reopenJobId || !reopenRowListed) return;
    onSelectJob(reopenJobId);
    setReopenJobId(null);
  }, [onSelectJob, reopenJobId, reopenRowListed]);
  const canUndo =
    last !== null &&
    (last.kind === "hide" || Boolean(input.onRemoveFromShortlist));

  // The keys read the latest handlers without re-subscribing every render.
  const handlersRef = useRef({ shortlist, notInterested, skip, back, undo });
  handlersRef.current = { shortlist, notInterested, skip, back, undo };
  const enabled = input.enabled;
  // Find jobs stays mounted behind other screens; its keys are off there.
  useEffectWhileKeptRouteShown(() => {
    if (!enabled) return undefined;
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
  }, [enabled]);

  // Read the next job while this one is being read.
  const nextRow = nextId ? (jobsById.get(nextId) ?? null) : null;
  const campaignId = input.campaignId;
  const detailRevision = input.detailRevision;
  useEffect(() => {
    if (!enabled || !nextId) return undefined;
    const timer = window.setTimeout(
      () =>
        prefetchJobDetail(
          { id: nextId, detailRevision: detailRevision?.(nextId) ?? "0" },
          campaignId,
        ),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [campaignId, detailRevision, enabled, nextId]);

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
