import { useContext, useEffect, useRef, useState } from "react";
import { KeptRouteVisibilityContext } from "../lib/kept-route-visibility";

const KEY_PREFIX = "nestor.job-finder.last-visit.";

/** When the person last left this screen, read without starting a visit. */
export function readVisit(key: string): string | null {
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

type SeenJob = { firstSeenAt?: string | null; discoveredAt?: string | null };

/**
 * When the person last left this screen, read as a visit starts; anything
 * first seen after it is new to them. Null before the first visit ends, so a
 * first look marks nothing. A screen kept mounted behind another one counts
 * as left while it is hidden. Coming back re-renders the screen only when the
 * new marks on `jobs` actually change.
 */
export function useSinceLastVisit(
  key: string,
  jobs: readonly SeenJob[] = [],
): string | null {
  const visibility = useContext(KeptRouteVisibilityContext);
  const [previousVisitEnd, setPreviousVisitEnd] = useState<string | null>(() =>
    visibility.isHidden() ? null : readVisit(key),
  );
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  // A visit ends when the screen is hidden behind another one or the window
  // closes; a remount alone (React's development double run) is not one.
  useEffect(() => {
    let wasHidden = visibility.isHidden();
    if (wasHidden) writeVisit(key, new Date().toISOString());
    return visibility.subscribe(() => {
      const hidden = visibility.isHidden();
      if (hidden === wasHidden) return;
      wasHidden = hidden;
      if (hidden) {
        writeVisit(key, new Date().toISOString());
        return;
      }
      const next = readVisit(key);
      setPreviousVisitEnd((current) =>
        jobsRef.current.every(
          (job) =>
            isNewSinceVisit(job, current) === isNewSinceVisit(job, next),
        )
          ? current
          : next,
      );
    });
  }, [key, visibility]);
  useEffect(() => {
    const leave = () => writeVisit(key, new Date().toISOString());
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, [key]);
  return previousVisitEnd;
}

/** A job first seen after the last visit ended. */
export function isNewSinceVisit(
  job: SeenJob,
  previousVisitEnd: string | null,
): boolean {
  if (!previousVisitEnd) return false;
  const seen = job.firstSeenAt ?? job.discoveredAt;
  return Boolean(seen) && Date.parse(seen!) > Date.parse(previousVisitEnd);
}
