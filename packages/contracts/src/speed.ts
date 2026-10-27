/**
 * How much the person lets Job Finder do at once: browser pages for search,
 * applications prepared together, and pages kept open waiting on them.
 * Standard fits an 8 GB laptop and stays on par with Chrome for the same
 * pages; the others trade memory and AI limits for speed.
 */
export const speedLevelValues = ["standard", "faster", "maximum"] as const;
// Plain values only, like job-finder-navigation.ts: the window imports them
// at startup. The schema lives in speed-schema.ts.
export type SpeedLevel = (typeof speedLevelValues)[number];

export interface SpeedLevelLimits {
  label: string;
  /** Pages a search reads in the browser at once. */
  searchPages: number;
  /** Applications prepared at once, never two on the same site. */
  applyAtOnce: number;
  /** Ready and Needs-you pages kept open; older ones close and refill on Open. */
  waitingPages: number;
}

// Measured 2026-10-27 on nine real job-board pages: about 65 MB of private
// memory per page in Nestor's browser, 67 MB in plain Chromium.
export const MEMORY_PER_PAGE_MB = 65;

export const SPEED_LEVELS: Record<SpeedLevel, SpeedLevelLimits> = {
  standard: {
    label: "Standard",
    searchPages: 2,
    applyAtOnce: 4,
    waitingPages: 3,
  },
  faster: { label: "Faster", searchPages: 4, applyAtOnce: 6, waitingPages: 6 },
  maximum: {
    label: "Maximum",
    searchPages: 6,
    applyAtOnce: 8,
    waitingPages: 10,
  },
};

/** Pages open at the busiest moment: search, applications and waiting pages. */
export function speedLevelPages(level: SpeedLevel): number {
  const limits = SPEED_LEVELS[level];
  return limits.searchPages + limits.applyAtOnce + limits.waitingPages;
}

/** Standard unless the person chose another level. */
export function speedLevelOf(settings: {
  speedLevel?: SpeedLevel | undefined;
}): SpeedLevel {
  return settings.speedLevel ?? "standard";
}
