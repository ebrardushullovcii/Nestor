import type { ListingCard } from "@nestor/contracts";
import { abortable } from "./async";

/** Pool small pages, cap retained cards, and make slow processing back-pressure collection. */
export function createCardWaves(
  signal: AbortSignal,
  consume: (cards: ListingCard[]) => Promise<void>,
) {
  const pending: ListingCard[] = [];
  const space: (() => void)[] = [];
  const checkpoints: { target: number; resolve(): void }[] = [];
  let queued = 0,
    consumed = 0,
    flushing = 0;
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let draining = false,
    error: Error | null = null;
  const checkError = () => {
    if (error) throw error;
  };
  const releaseCheckpoints = () => {
    for (let index = checkpoints.length - 1; index >= 0; index--) {
      const checkpoint = checkpoints[index]!;
      if (checkpoint.target <= consumed || error || signal.aborted) {
        checkpoints.splice(index, 1);
        checkpoint.resolve();
      }
    }
  };
  const pump = () => {
    if (signal.aborted || error) {
      pending.length = 0;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const resolve of space.splice(0)) resolve();
      releaseCheckpoints();
      return;
    }
    if (active || pending.length === 0) return;
    if (!draining && !flushing && pending.length < 400) {
      timer ??= setTimeout(() => {
        timer = null;
        launch();
      }, 400);
      return;
    }
    launch();
  };
  const launch = () => {
    if (active || !pending.length || signal.aborted || error) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const batch = pending.splice(0, 400);
    for (const resolve of space.splice(0)) resolve();
    active = consume(batch)
      .catch((reason: unknown) => {
        error = reason instanceof Error ? reason : new Error(String(reason));
      })
      .finally(() => {
        consumed += batch.length;
        active = null;
        releaseCheckpoints();
        pump();
      });
  };
  signal.addEventListener("abort", pump, { once: true });
  return {
    async push(cards: readonly ListingCard[]) {
      for (let index = 0; index < cards.length; index += 400) {
        signal.throwIfAborted();
        if (error) throw error;
        while (pending.length >= 2000)
          await abortable(
            new Promise<void>((resolve) => space.push(resolve)),
            signal,
          );
        pending.push(...cards.slice(index, index + 400));
        queued += Math.min(400, cards.length - index);
        pump();
      }
    },
    /** Flush only the cards already accepted, then resume pooling small pages. */
    async checkpoint() {
      signal.throwIfAborted();
      checkError();
      if (consumed >= queued) return;
      const target = queued;
      flushing++;
      try {
        const completed = new Promise<void>((resolve) =>
          checkpoints.push({ target, resolve }),
        );
        pump();
        await abortable(completed, signal);
        checkError();
      } finally {
        flushing--;
      }
    },
    async drain() {
      draining = true;
      pump();
      while (active || pending.length) {
        if (active) await abortable(active, signal);
        else pump();
      }
      signal.removeEventListener("abort", pump);
      if (error) throw error;
    },
  };
}
