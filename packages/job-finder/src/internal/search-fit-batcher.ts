/**
 * When the jobs a running search keeps go to the fit judge (ADR 0041).
 *
 * Every call pays the same fixed cost (instructions, the person, the goals),
 * so batches should be full; scores should also show while the search runs.
 * A full batch goes at once. The run's first batch, and a batch at least
 * half full, go once the oldest waiting job has waited `partialWaitMs`. Any
 * job goes once it has waited `maxWaitMs`. The end of the search sends what
 * is left.
 */
export function createSearchFitBatcher(input: {
  batchSize: number;
  concurrency: number;
  partialWaitMs: number;
  maxWaitMs: number;
  /** Judges one batch; a rejection leaves its jobs unjudged. */
  judge: (jobIds: readonly string[]) => Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? (() => Date.now());
  const minimumPartial = Math.max(1, Math.ceil(input.batchSize / 2));
  const queue: Array<{ id: string; queuedAt: number }> = [];
  const inFlight = new Set<Promise<void>>();
  let started = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let closed = false;

  const waitBeforePartial = () =>
    started === 0 || queue.length >= minimumPartial
      ? input.partialWaitMs
      : input.maxWaitMs;
  const due = () => {
    if (queue.length === 0) return false;
    if (queue.length >= input.batchSize || flushing) return true;
    return now() - queue[0]!.queuedAt >= waitBeforePartial();
  };
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const pump = (): void => {
    while (!closed && inFlight.size < input.concurrency && due()) {
      const batch = queue
        .splice(0, input.batchSize)
        .map((entry) => entry.id);
      started += 1;
      const running: Promise<void> = input
        .judge(batch)
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(running);
          pump();
        });
      inFlight.add(running);
    }
    clearTimer();
    // A full house of calls calls back here as each one ends.
    if (
      closed ||
      flushing ||
      queue.length === 0 ||
      inFlight.size >= input.concurrency
    )
      return;
    const waited = now() - queue[0]!.queuedAt;
    timer = setTimeout(pump, Math.max(0, waitBeforePartial() - waited));
  };

  return {
    enqueue(jobIds: Iterable<string>): void {
      if (closed) return;
      const at = now();
      for (const id of jobIds) queue.push({ id, queuedAt: at });
      pump();
    },
    /** Sends what is left and waits for every batch. */
    async finish(): Promise<void> {
      flushing = true;
      pump();
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
    /** Stops: nothing waiting is sent, and calls in flight are not waited on. */
    stop(): void {
      closed = true;
      queue.length = 0;
      clearTimer();
    },
    get waiting(): number {
      return queue.length;
    },
  };
}
