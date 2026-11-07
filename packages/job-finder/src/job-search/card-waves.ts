import type { ListingCard } from "@nestor/contracts";
import { abortable } from "./async";
import { reportSelfLimitHit } from "@nestor/core";

export interface CardWaveQueue {
  push(cards: readonly ListingCard[]): void;
  counts(): [string, number][];
  take(sourceId: string, size: number): ListingCard[];
  complete(cards: readonly ListingCard[]): void;
}

/** Bounded, serial waves per source; a slow source must not hold healthy ones. */
export function createCardWaves(
  signal: AbortSignal,
  consume: (cards: ListingCard[]) => Promise<void>,
  concurrency = 1,
  durable?: CardWaveQueue,
) {
  const pending: ListingCard[] = [];
  const queue: CardWaveQueue = durable ?? {
    push(cards) {
      pending.push(...cards);
    },
    counts() {
      const counts = new Map<string, number>();
      for (const card of pending)
        counts.set(card.sourceId, (counts.get(card.sourceId) ?? 0) + 1);
      return [...counts];
    },
    take(sourceId, size) {
      const batch: ListingCard[] = [];
      for (let index = 0; index < pending.length && batch.length < size; ) {
        if (pending[index]!.sourceId === sourceId)
          batch.push(...pending.splice(index, 1));
        else index++;
      }
      return batch;
    },
    complete() {},
  };
  const pendingCount = () =>
    queue.counts().reduce((n, [, count]) => n + count, 0);
  const space: (() => void)[] = [];
  const checkpoints: { targets: Map<string, number>; resolve(): void }[] = [];
  const queued = new Map<string, number>(queue.counts());
  const consumed = new Map<string, number>();
  const active = new Map<string, Promise<void>>();
  const limit = Math.max(1, Math.floor(concurrency));
  let flushing = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let draining = false,
    error: Error | null = null;
  const checkError = () => {
    if (error) throw error;
  };
  const completed = (targets: Map<string, number>) =>
    [...targets].every(
      ([source, target]) => (consumed.get(source) ?? 0) >= target,
    );
  const releaseCheckpoints = () => {
    for (let index = checkpoints.length - 1; index >= 0; index--) {
      const checkpoint = checkpoints[index]!;
      if (completed(checkpoint.targets) || error || signal.aborted) {
        checkpoints.splice(index, 1);
        checkpoint.resolve();
      }
    }
  };
  const pump = (force = false) => {
    if (signal.aborted || error) {
      pending.length = 0;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const resolve of space.splice(0)) resolve();
      releaseCheckpoints();
      return;
    }
    if (pendingCount() && active.size >= limit)
      reportSelfLimitHit({
        limit: "card_wave_concurrency",
        kind: "concurrency",
        value: limit,
        where: "job-finder/createCardWaves",
      });
    while (active.size < limit) {
      const source = queue.counts().find(([id]) => !active.has(id))?.[0];
      if (source === undefined) return;
      const count = queue.counts().find(([id]) => id === source)?.[1] ?? 0;
      if (!draining && !flushing && !force && count < 400) {
        timer ??= setTimeout(() => {
          timer = null;
          pump(true);
        }, 400);
        return;
      }
      const batch = queue.take(source, 400);
      for (const resolve of space.splice(0)) resolve();
      const work = Promise.resolve()
        .then(async () => {
          await consume(batch);
          signal.throwIfAborted();
          queue.complete(batch);
        })
        .catch((reason: unknown) => {
          error = reason instanceof Error ? reason : new Error(String(reason));
        })
        .finally(() => {
          consumed.set(source, (consumed.get(source) ?? 0) + batch.length);
          active.delete(source);
          releaseCheckpoints();
          pump();
        });
      active.set(source, work);
    }
  };
  const abort = () => pump();
  signal.addEventListener("abort", abort, { once: true });
  return {
    async push(cards: readonly ListingCard[]) {
      for (let index = 0; index < cards.length; index += 400) {
        signal.throwIfAborted();
        checkError();
        // Production queues persist before acknowledging acceptance and read
        // only active waves into memory. They never wait for another source's
        // screening inside a browser tool's connection-idle boundary.
        while (!durable && pendingCount() >= 2000) {
          reportSelfLimitHit({
            limit: "card_wave_pending",
            kind: "count",
            value: 2000,
            where: "job-finder/createCardWaves",
          });
          await abortable(
            new Promise<void>((resolve) => space.push(resolve)),
            signal,
          );
          checkError();
        }
        signal.throwIfAborted();
        const chunk = cards.slice(index, index + 400);
        queue.push(chunk);
        for (const card of chunk)
          queued.set(card.sourceId, (queued.get(card.sourceId) ?? 0) + 1);
        pump();
      }
      pump(); // Also starts durable work restored after a crash.
    },
    /** Snapshot accepted work. Quick waits only for its own source's cards. */
    async checkpoint(sourceId?: string) {
      signal.throwIfAborted();
      checkError();
      const targets =
        sourceId === undefined
          ? new Map(queued)
          : new Map([[sourceId, queued.get(sourceId) ?? 0]]);
      if (completed(targets)) return;
      flushing++;
      try {
        const done = new Promise<void>((resolve) =>
          checkpoints.push({ targets, resolve }),
        );
        pump();
        await abortable(done, signal);
        checkError();
      } finally {
        flushing--;
      }
    },
    async drain() {
      draining = true;
      try {
        pump();
        while (active.size || pendingCount()) {
          if (active.size)
            await abortable(Promise.race(active.values()), signal);
          else pump();
        }
        checkError();
      } finally {
        if (timer) clearTimeout(timer);
        timer = null;
        signal.removeEventListener("abort", abort);
      }
    },
  };
}
