import type { ListingCard } from "@nestor/contracts";
import { abortable } from "./async";

/** Pool small pages, cap retained cards, and make slow processing back-pressure collection. */
export function createCardWaves(
  signal: AbortSignal,
  consume: (cards: ListingCard[]) => Promise<void>,
) {
  const pending: ListingCard[] = [];
  const space: (() => void)[] = [];
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let draining = false,
    error: Error | null = null;
  const pump = () => {
    if (signal.aborted || error) {
      pending.length = 0;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const resolve of space.splice(0)) resolve();
      return;
    }
    if (active || pending.length === 0) return;
    if (!draining && pending.length < 400) {
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
        active = null;
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
        pump();
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
