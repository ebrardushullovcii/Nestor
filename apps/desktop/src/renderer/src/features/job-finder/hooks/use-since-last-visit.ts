import { useEffect, useState } from "react";
import { useKeptRouteHidden } from "../lib/kept-route-visibility";

const KEY_PREFIX = "nestor.job-finder.last-visit.";

function readVisit(key: string): string | null {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    return raw && !Number.isNaN(Date.parse(raw)) ? raw : null;
  } catch {
    return null;
  }
}

function writeVisit(key: string, at: string): void {
  try {
    window.localStorage.setItem(KEY_PREFIX + key, at);
  } catch {
    // Without storage nothing is marked new; the list still works.
  }
}

/**
 * When the person last left this screen, read as a visit starts; anything
 * first seen after it is new to them. Null before the first visit ends, so a
 * first look marks nothing. A screen kept mounted behind another one counts
 * as left while it is hidden.
 */
export function useSinceLastVisit(key: string): string | null {
  const hidden = useKeptRouteHidden();
  const [previousVisitEnd, setPreviousVisitEnd] = useState<string | null>(() =>
    hidden ? null : readVisit(key),
  );
  // A visit ends when the screen is hidden behind another one or the window
  // closes; a remount alone (React's development double run) is not one.
  useEffect(() => {
    if (hidden) writeVisit(key, new Date().toISOString());
    else setPreviousVisitEnd(readVisit(key));
  }, [hidden, key]);
  useEffect(() => {
    const leave = () => writeVisit(key, new Date().toISOString());
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [key]);
  return previousVisitEnd;
}

/** A job first seen after the last visit ended. */
export function isNewSinceVisit(
  job: { firstSeenAt?: string | null; discoveredAt?: string | null },
  previousVisitEnd: string | null,
): boolean {
  if (!previousVisitEnd) return false;
  const seen = job.firstSeenAt ?? job.discoveredAt;
  return Boolean(seen) && Date.parse(seen!) > Date.parse(previousVisitEnd);
}
