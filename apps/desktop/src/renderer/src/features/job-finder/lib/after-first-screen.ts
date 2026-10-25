/**
 * Work that can wait until the first screen is usable: reads that make main
 * load the old route modules, which would otherwise hold Home's own read
 * behind them at launch.
 */
// Tests render screens on their own, with no first screen to wait for.
let shown = import.meta.env.MODE === "test";
const waiting: Array<() => void> = [];

/** How long after launch deferred work starts at the latest. */
const FIRST_SCREEN_FALLBACK_MS = 2_500;

/** Home calls this once its numbers are on screen. */
export function markFirstScreenShown(): void {
  if (shown) return;
  shown = true;
  for (const run of waiting.splice(0)) run();
}

if (typeof window !== "undefined")
  window.setTimeout(markFirstScreenShown, FIRST_SCREEN_FALLBACK_MS);

/** Runs `work` once the first screen is shown and the window is idle. */
export function afterFirstScreen(work: () => void): void {
  const idle = () =>
    typeof window.requestIdleCallback === "function"
      ? window.requestIdleCallback(() => work(), { timeout: 1_000 })
      : window.setTimeout(work, 0);
  if (shown) idle();
  else waiting.push(idle);
}
