import { useEffect, useMemo, useRef, useState } from "react";
import type { JobListRow, FitJudgmentProgress } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { isDiscoveryUncheckedResult } from "./discovery-result-groups";

/**
 * Whether this app session already judged the jobs left without a fit score.
 * Reset by every search, so the jobs a stopped search leaves behind are judged
 * once it ends. Module state on purpose: leaving Find jobs and coming back
 * must not start another pass.
 */
let autoJudgeDone = false;

/** Test seam: forget that this session already judged. */
export function resetDiscoveryAutoJudgeForTests() {
  autoJudgeDone = false;
}

/**
 * Jobs without a fit score are judged on their own: when Find jobs opens with
 * some, and again after each search. The person used to have to find and
 * press "Judge fit for all 81" (or "Assess next 20") before the list could be
 * trusted. Only a pass that could not finish offers a way to try again.
 */
export function DiscoveryAssessmentContinuation(props: {
  className?: string;
  jobs: readonly JobListRow[];
  isSearchRunning: boolean;
  /** Judges every unjudged job in batches, in main, saving as it goes. */
  onJudgeAll?: () => Promise<unknown>;
  fitJudgmentProgress?: FitJudgmentProgress | null;
}) {
  const unreadCount = useMemo(
    () => props.jobs.filter(isDiscoveryUncheckedResult).length,
    [props.jobs],
  );
  const [failed, setFailed] = useState(false);
  const [isJudgingAll, setIsJudgingAll] = useState(false);
  const [localStartedAt, setLocalStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const fitProgress = props.fitJudgmentProgress;
  const judging =
    fitProgress?.phase === "judging" || fitProgress?.phase === "saving";
  const startedAt =
    judging && fitProgress
      ? Date.parse(fitProgress.startedAt)
      : isJudgingAll
        ? localStartedAt
        : null;
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const mounted = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const onJudgeAll = props.onJudgeAll;
  const judgeAll = async () => {
    if (busy.current || !onJudgeAll) return;
    busy.current = true;
    autoJudgeDone = true;
    setFailed(false);
    setLocalStartedAt(Date.now());
    setIsJudgingAll(true);
    try {
      await onJudgeAll();
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      busy.current = false;
      if (mounted.current) setIsJudgingAll(false);
    }
  };
  const judgeAllRef = useRef(judgeAll);
  judgeAllRef.current = judgeAll;

  const isSearchRunning = props.isSearchRunning;
  const canJudge = Boolean(onJudgeAll);
  useEffect(() => {
    if (isSearchRunning) {
      autoJudgeDone = false;
      return;
    }
    if (autoJudgeDone || judging || !canJudge || unreadCount === 0) return;
    void judgeAllRef.current();
  }, [canJudge, isSearchRunning, judging, unreadCount]);

  const leftUnjudged =
    !isJudgingAll && !judging && fitProgress?.phase === "completed"
      ? fitProgress.total - fitProgress.judged
      : 0;
  const offerRetry =
    canJudge &&
    !isJudgingAll &&
    !judging &&
    !isSearchRunning &&
    unreadCount > 0 &&
    (failed || fitProgress?.phase === "failed" || leftUnjudged > 0);

  if (!judging && !isJudgingAll && !offerRetry) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 text-xs text-foreground-soft",
        props.className,
      )}
      role="status"
    >
      {judging && fitProgress ? (
        <p>
          Judging fit · {fitProgress.judged} of {fitProgress.total} scored
        </p>
      ) : isJudgingAll ? (
        <p>Judging fit for {unreadCount} jobs</p>
      ) : (
        <>
          <p>
            {unreadCount} {unreadCount === 1 ? "job has" : "jobs have"} no fit
            score yet
          </p>
          <Button
            className="h-auto px-0 text-xs"
            onClick={() => void judgeAll()}
            size="compact"
            type="button"
            variant="link"
          >
            Try again
          </Button>
        </>
      )}
      {startedAt !== null ? (
        <span className="tabular-nums">
          {Math.max(0, Math.floor((now - startedAt) / 1000))}s
        </span>
      ) : null}
    </div>
  );
}
