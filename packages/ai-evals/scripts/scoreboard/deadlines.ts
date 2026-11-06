/** Seconds observed in the 2026-11-06 effort-study scoreboards. These include
 * deadline failures, so they are lower bounds, not estimates of successful work.
 * Standard also includes the owner's 262–377s Greenhouse measurements.
 */
export const OBSERVED_SECONDS: Readonly<Record<string, number>> = {
  standard: 377,
  multistep: 272.04,
  captcha: 207.305,
  security: 241.752,
  restart: 234.982,
  batch: 427.883,
  send: 242.223,
  search: 73.313,
};

/** 75% headroom plus 30s, rounded up to a minute. Unmeasured sign-in rows
 * borrow the multi-step observation until they have timings of their own.
 * --timeout remains an explicit operator override, never a hidden minimum.
 */
export function scenarioTimeoutSeconds(id: string, override?: number): number {
  if (override !== undefined) return override;
  const measured = OBSERVED_SECONDS[id] ?? OBSERVED_SECONDS.multistep;
  return Math.max(180, Math.ceil((measured * 1.75 + 30) / 60) * 60);
}
