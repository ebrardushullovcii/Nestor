import { useSyncExternalStore } from "react";
import { toDestinationBadgeCount } from "./destination-counts";
import { JOB_FINDER_ROUTE_PATHS } from "./job-finder-route-hrefs";
import type {
  WorkspaceHomeSummary,
  WorkspaceListCounts,
  WorkspaceStartupContext,
} from "@nestor/contracts";

/**
 * The few rows the first frame needs, read straight from the database while
 * the full workspace still loads (ADR 0065). Home's counts and the sidebar
 * badges paint from these; the full workspace replaces them when it lands.
 */
export interface LaunchReads {
  counts: WorkspaceListCounts | null;
  home: WorkspaceHomeSummary | null;
  context: WorkspaceStartupContext | null;
}

let reads: LaunchReads = {
  counts: null,
  home: null,
  context: null,
};
let started = false;
let settled: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Partial<LaunchReads>): void {
  reads = { ...reads, ...next };
  for (const listener of listeners) listener();
}

/** Asks once per window; a missing or failing query leaves today's skeleton. */
export function startLaunchReads(): void {
  if (started) return;
  started = true;
  const queries =
    typeof window === "undefined"
      ? undefined
      : window.nestor?.jobFinder?.queries;
  if (!queries) return;
  const home = queries
    .getHomeSummary()
    .then((home) => publish({ home, counts: reads.counts ?? home.counts }))
    .catch(() => undefined);
  const counts = queries
    .getListCounts()
    .then((counts) => publish({ counts }))
    .catch(() => undefined);
  const context = queries
    .getStartupContext()
    .then((context) => publish({ context }))
    .catch(() => undefined);
  settled = Promise.all([home, counts, context]).then(() => {
    settled = null;
  });
}

/** The longest the full workspace load waits on the launch reads. */
const LAUNCH_READS_WAIT_MS = 3_000;

/**
 * Resolves once every launch read has answered (or failed), so the window's
 * full workspace load starts after the screens drawn from them are usable,
 * not ahead of them. Never waits longer than a few seconds.
 */
export function whenLaunchReadsSettled(): Promise<void> {
  if (!settled) return Promise.resolve();
  return Promise.race([
    settled,
    new Promise<void>((resolve) => setTimeout(resolve, LAUNCH_READS_WAIT_MS)),
  ]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const readLaunchReads = () => reads;

export function useLaunchReads(): LaunchReads {
  return useSyncExternalStore(subscribe, readLaunchReads, readLaunchReads);
}

/** The sidebar badge a destination shows while opening, as the loaded shell would. */
export function readLaunchDestinationCount(
  counts: WorkspaceListCounts | null,
  path: string,
): number | null {
  if (!counts) return null;
  if (path === JOB_FINDER_ROUTE_PATHS.discovery)
    return toDestinationBadgeCount(counts.discovery);
  if (path === JOB_FINDER_ROUTE_PATHS.reviewQueue)
    return toDestinationBadgeCount(counts.shortlisted);
  if (path === JOB_FINDER_ROUTE_PATHS.applications)
    return toDestinationBadgeCount(counts.applications);
  return null;
}
