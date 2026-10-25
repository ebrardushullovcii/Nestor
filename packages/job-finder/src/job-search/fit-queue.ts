import { abortable } from "./async";
import type { JobSearchContext, JobSearchRunnerDeps } from "./types";
import type { JobSearchSettings } from "@nestor/contracts";

export function createFitQueue(
  deps: JobSearchRunnerDeps,
  context: JobSearchContext,
  signal: AbortSignal,
  limit: number,
  onScored: (count: number) => void,
  onError: (error: unknown) => void,
  settings?: JobSearchSettings,
) {
  const pending: number[] = [];
  const seen = new Set<number>();
  const active = new Set<Promise<void>>();
  let scored = 0,
    judging = 0;
  let drainers = 0;
  let flushCount = 0;
  let partialTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPartialTimer = () => {
    if (partialTimer) clearTimeout(partialTimer);
    partialTimer = null;
  };
  signal.addEventListener("abort", clearPartialTimer, { once: true });

  const judge = async (ids: number[]) => {
    const jobs = ids.flatMap((id) => {
      const job = deps.store.getJob(id);
      return job &&
        job.fitScore === null &&
        !job.stageNote?.startsWith("Closed:")
        ? [job]
        : [];
    });
    if (jobs.length === 0) return;
    judging += jobs.length;
    try {
      const updates = await abortable(
        deps.engine.fitJobs({
          jobs,
          context,
          signal,
          ...(settings?.note ? { request: settings.note } : {}),
        }),
        signal,
      );
      if (signal.aborted) return;
      deps.store.setFit(updates);
      scored += updates.length;
      onScored(updates.length);
      if (updates.length < jobs.length)
        onError(new Error("Some jobs are still waiting for a fit score."));
    } finally {
      judging -= jobs.length;
    }
  };

  const pump = () => {
    if (signal.aborted) {
      clearPartialTimer();
      pending.length = 0;
      return;
    }
    while (
      active.size < limit &&
      (pending.length >= 24 ||
        ((drainers > 0 || flushCount > 0) && pending.length > 0))
    ) {
      const batch = pending.splice(0, 24);
      flushCount = Math.max(0, flushCount - batch.length);
      const task = judge(batch)
        .catch((error: unknown) => {
          if (!signal.aborted) onError(error);
        })
        .finally(() => {
          active.delete(task);
          pump();
        });
      active.add(task);
    }
    if (pending.length === 0 || drainers > 0) clearPartialTimer();
    else if (!partialTimer) {
      // Pool small pages and feeds across sites, while still scoring a slow
      // search before its source finishes. Full batches never wait for this.
      partialTimer = setTimeout(() => {
        partialTimer = null;
        flushCount = pending.length;
        pump();
      }, 5_000);
      partialTimer.unref();
    }
  };

  return {
    get pendingCount() {
      return pending.length;
    },
    get activeCount() {
      return judging;
    },
    get scored() {
      return scored;
    },
    enqueue(ids: readonly number[]) {
      if (signal.aborted) return;
      for (const id of ids)
        if (!seen.has(id)) {
          seen.add(id);
          pending.push(id);
        }
      pump();
    },
    async drain() {
      drainers++;
      try {
        pump();
        while (active.size > 0) await Promise.all([...active]);
      } finally {
        drainers--;
      }
    },
  };
}
