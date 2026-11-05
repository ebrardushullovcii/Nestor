import type { ListingCard } from "@nestor/contracts";
import { abortable } from "./async";

/** Bounded, serial waves per source; a slow source must not hold healthy ones. */
export function createCardWaves(
  signal: AbortSignal,
  consume: (cards: ListingCard[]) => Promise<void>,
  concurrency = 1,
) {
  const pending: ListingCard[] = [];
  const space: (() => void)[] = [];
  const checkpoints: { targets: Map<string, number>; resolve(): void }[] = [];
  const queued = new Map<string, number>();
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
    while (active.size < limit) {
      const source = pending.find(
        (card) => !active.has(card.sourceId),
      )?.sourceId;
      if (source === undefined) return;
      const batch: ListingCard[] = [];
      for (const card of pending) {
        if (card.sourceId === source) batch.push(card);
        if (batch.length === 400) break;
      }
      if (!draining && !flushing && !force && batch.length < 400) {
        timer ??= setTimeout(() => {
          timer = null;
          pump(true);
        }, 400);
        return;
      }
      let remaining = batch.length;
      for (let index = 0; index < pending.length && remaining > 0; ) {
        if (pending[index]!.sourceId === source) {
          pending.splice(index, 1);
          remaining--;
        } else index++;
      }
      for (const resolve of space.splice(0)) resolve();
      const work = Promise.resolve()
        .then(() => consume(batch))
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
        while (pending.length >= 2000) {
          await abortable(
            new Promise<void>((resolve) => space.push(resolve)),
            signal,
          );
          checkError();
        }
        signal.throwIfAborted();
        const chunk = cards.slice(index, index + 400);
        pending.push(...chunk);
        for (const card of chunk)
          queued.set(card.sourceId, (queued.get(card.sourceId) ?? 0) + 1);
        pump();
      }
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
        while (active.size || pending.length) {
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
