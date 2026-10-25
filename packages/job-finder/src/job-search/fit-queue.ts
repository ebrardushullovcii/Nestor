import { abortable } from "./async";
import type { JobSearchContext, JobSearchRunnerDeps } from "./types";

export function createFitQueue(
  deps: JobSearchRunnerDeps,
  context: JobSearchContext,
  signal: AbortSignal,
  limit: number,
  onScored: (count: number) => void,
  onError: (error: unknown) => void,
) {
  const pending: number[] = [];
  const seen = new Set<number>();
  const active = new Set<Promise<void>>();
  let scored = 0;
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
        (job.stage === "found" || job.stage === "shortlisted")
        ? [job]
        : [];
    });
    if (jobs.length === 0) return;
    const updates = await abortable(
      deps.engine.judgeFits({ jobs, context, signal }),
      signal,
    );
    if (signal.aborted) return;
    deps.store.setFit(updates);
    scored += updates.length;
    onScored(updates.length);
    if (updates.length < jobs.length)
      onError(new Error("Some jobs are still waiting for a fit score."));
  };

  const pump = () => {
    if (signal.aborted) {
      clearPartialTimer();
      pending.length = 0;
      return;
    }
    while (
      active.size < limit &&
      (pending.length >= 20 ||
        ((drainers > 0 || flushCount > 0) && pending.length > 0))
    ) {
      const batch = pending.splice(0, 20);
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
