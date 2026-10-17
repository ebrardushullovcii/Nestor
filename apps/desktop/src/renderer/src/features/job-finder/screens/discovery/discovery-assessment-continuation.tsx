import { describeListingReadFailure } from "../../lib/describe-failure";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JobListRow, FitJudgmentProgress } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { isDiscoveryUncheckedResult } from "./discovery-result-groups";

export function DiscoveryAssessmentContinuation(props: {
  jobs: readonly JobListRow[];
  preferredJobs?: readonly JobListRow[];
  isSearchRunning: boolean;
  onAssess?: (jobId: string) => Promise<void>;
  /** Judges every unjudged job in batches, in main, saving as it goes. */
  onJudgeAll?: () => Promise<unknown>;
  fitJudgmentProgress?: FitJudgmentProgress | null;
}) {
  const unread = useMemo(
    () => props.jobs.filter(isDiscoveryUncheckedResult),
    [props.jobs],
  );
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isJudgingAll, setIsJudgingAll] = useState(false);
  const [localStartedAt, setLocalStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const fitProgress = props.fitJudgmentProgress;
  const judging =
    fitProgress?.phase === "judging" || fitProgress?.phase === "saving";
  const startedAt =
    judging && fitProgress
      ? Date.parse(fitProgress.startedAt)
      : progress || isJudgingAll
        ? localStartedAt
        : null;
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const stopped = useRef(false);
  const busy = useRef(false);
  useEffect(
    () => () => {
      stopped.current = true;
    },
    [],
  );

  const assessMore = async () => {
    const assess = props.onAssess;
    if (busy.current || !assess) return;
    busy.current = true;
    stopped.current = false;
    setError(null);
    setLocalStartedAt(Date.now());
    // Prioritize the visible page only when the person starts a bounded read.
    // Page turns do not rebuild and refilter the entire plan's job array.
    const batch: JobListRow[] = [];
    const added = new Set<string>();
    for (const candidates of [props.preferredJobs ?? [], unread]) {
      for (const job of candidates) {
        if (batch.length === 20) break;
        if (added.has(job.id) || !isDiscoveryUncheckedResult(job)) continue;
        added.add(job.id);
        batch.push(job);
      }
    }
    setProgress({ done: 0, total: batch.length });
    let listingUrl: string | undefined;
    try {
      for (const [index, job] of batch.entries()) {
        if (stopped.current) break;
        listingUrl = job.canonicalUrl;
        await assess(job.id);
        if (!stopped.current)
          setProgress({ done: index + 1, total: batch.length });
      }
    } catch (error) {
      if (!stopped.current)
        setError(
          describeListingReadFailure(error, listingUrl ? { listingUrl } : {}),
        );
    } finally {
      busy.current = false;
      if (!stopped.current) setProgress(null);
    }
  };

  const judgeAll = async () => {
    if (busy.current || !props.onJudgeAll) return;
    busy.current = true;
    stopped.current = false;
    setError(null);
    setLocalStartedAt(Date.now());
    setIsJudgingAll(true);
    try {
      await props.onJudgeAll();
    } catch {
      if (!stopped.current)
        setError(
          "Fit could not be judged right now. The jobs judged so far keep their scores; try again in a few minutes.",
        );
    } finally {
      busy.current = false;
      if (!stopped.current) setIsJudgingAll(false);
    }
  };

  if (unread.length === 0 && !progress && !isJudgingAll && !fitProgress)
    return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs text-foreground-soft"
      role="status"
    >
      {judging && fitProgress ? (
        <p>
          Judging fit · {fitProgress.judged} of {fitProgress.total} scores saved
          · {Math.max(0, fitProgress.total - fitProgress.processed)} waiting to
          be reviewed.
          {fitProgress.phase === "saving"
            ? " Saving this batch."
            : " Waiting for the model."}{" "}
          It carries on if you leave this page.
        </p>
      ) : isJudgingAll ? (
        <p>
          Judging fit · {unread.length} left. Scores appear as each batch is
          judged, and it carries on if you leave this page.
        </p>
      ) : progress ? (
        <p>
          Assessing listings · {progress.done} of {progress.total} finished.
          Leaving this page stops the batch after the current listing.
        </p>
      ) : !props.isSearchRunning && unread.length > 0 ? (
        <>
          {props.onJudgeAll ? (
            <Button size="sm" onClick={() => void judgeAll()}>
              Judge fit for all {unread.length}
            </Button>
          ) : null}
          {props.onAssess ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void assessMore()}
            >
              Assess next {Math.min(20, unread.length)}{" "}
              {unread.length === 1 ? "listing" : "listings"}
            </Button>
          ) : null}
        </>
      ) : null}
      {!isJudgingAll && !judging && fitProgress?.phase === "completed" ? (
        <p>
          Fit judging finished · {fitProgress.judged} of {fitProgress.total}{" "}
          judged.
          {fitProgress.judged < fitProgress.total
            ? ` ${fitProgress.total - fitProgress.judged} could not be judged; retry them when ready.`
            : ""}
        </p>
      ) : null}
      {!judging && fitProgress?.phase === "failed" ? (
        <p role="alert">
          Fit judging stopped. {fitProgress.judged} scores were saved; the rest
          can be retried.
        </p>
      ) : null}
      {startedAt !== null ? (
        <span>
          {Math.max(0, Math.floor((now - startedAt) / 1000))}s elapsed
        </span>
      ) : null}
      {error && fitProgress?.phase !== "failed" ? (
        <p role="alert">{error}</p>
      ) : null}
    </div>
  );
}
