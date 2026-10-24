import { useSyncExternalStore } from "react";
import type {
  JobFinderRendererWorkspaceSnapshot,
  WorkspaceChanges,
  WorkspaceListCounts,
} from "@nestor/contracts";
import { JOB_FINDER_ROUTE_PATHS } from "./job-finder-route-hrefs";

/**
 * While a search runs, the window follows the database's change feed instead
 * of syncing the whole workspace for every progress event (ADR 0071). Find
 * jobs reads its list from the database and refetches it from the feed, so
 * the workspace snapshot only needs a sync where a screen shows what is not
 * queried yet: Home for the search's jobs and progress, and Find jobs, Search
 * plans and Profile for its progress. Those sync at most once per
 * `SEARCH_SYNC_INTERVAL_MS`; everywhere else only the list counts behind the
 * sidebar badges refresh, and a screen catches up when it opens.
 */
export const SEARCH_SYNC_INTERVAL_MS = 1_500;
/**
 * Progress alone (a source finished, a page read) syncs less often: the
 * search's own events already move the live progress line.
 */
export const SEARCH_PROGRESS_SYNC_INTERVAL_MS = 4_000;
const SEARCH_COUNTS_INTERVAL_MS = 1_000;

/** Tables a search writes its jobs, scores and plan membership to. */
const SEARCH_JOB_TABLES = new Set([
  "saved_jobs",
  "discovery_pending_jobs",
  "plan_job_memberships",
  "job_plan_assessments",
]);

const HOME_PATH = "/job-finder/home";
/** Screens that show the search's progress from the workspace snapshot. */
const SEARCH_VIEW_PATHS = [
  HOME_PATH,
  JOB_FINDER_ROUTE_PATHS.discovery,
  JOB_FINDER_ROUTE_PATHS.campaigns,
  JOB_FINDER_ROUTE_PATHS.profile,
];

function routePath(route: string): string {
  return route.split("?")[0] ?? "";
}

export function isSearchRunning(
  workspace: JobFinderRendererWorkspaceSnapshot | null,
): boolean {
  return (
    workspace?.discoveryRunState === "running" ||
    workspace?.activeDiscoveryRun?.state === "running"
  );
}

/** Home, Find jobs, Search plans and Profile (job sources) show the search. */
export function isSearchViewRoute(route: string): boolean {
  const path = routePath(route);
  return SEARCH_VIEW_PATHS.some(
    (view) => path === view || path.startsWith(`${view}/`),
  );
}

/** Home still lists the search's jobs from the workspace snapshot. */
export function isSearchJobsViewRoute(route: string): boolean {
  return routePath(route) === HOME_PATH;
}

/**
 * What a batch touched: the search's jobs, its run progress, or other work
 * (resumes, applications, settings). Main holds its own update notices while
 * a search runs, so other work is followed from the feed on every screen.
 */
export function classifySearchChanges(changes: WorkspaceChanges): {
  jobs: boolean;
  run: boolean;
  other: boolean;
} {
  let jobs = false;
  let run = false;
  let other = false;
  for (const change of changes.changes) {
    if (SEARCH_JOB_TABLES.has(change.table)) jobs = true;
    else if (
      change.table.startsWith("discovery_run") ||
      (change.table === "singleton_state" &&
        (change.id === "discovery_state" || change.id === "campaign_state"))
    )
      run = true;
    // The ledger and fingerprints are the search's own bookkeeping.
    else if (
      !change.table.startsWith("discovery_") &&
      change.table !== "saved_job_discovery_fingerprints"
    )
      other = true;
  }
  return { jobs, run, other };
}

export interface SearchChangeFeedFollower {
  /** A batch from the change feed. Ignored while no search runs. */
  onChanges(changes: WorkspaceChanges): void;
  /** The search's own callback saw jobs saved or a source finish. */
  onSearchProgress(): void;
  /** The person moved to another screen. */
  onRouteChange(): void;
  dispose(): void;
}

export function createSearchChangeFeedFollower(options: {
  isSearchRunning: () => boolean;
  currentRoute: () => string;
  requestSync: () => void;
  refreshCounts: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): SearchChangeFeedFollower {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((callback: () => void, ms: number) => window.setTimeout(callback, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) => window.clearTimeout(handle as number));
  let lastSyncAt = Number.NEGATIVE_INFINITY;
  let lastCountsAt = Number.NEGATIVE_INFINITY;
  let syncTimer: unknown = null;
  let syncDueAt = 0;
  let countsTimer: unknown = null;
  // Jobs changed while the person was on a screen that does not show them.
  let behind = false;
  let disposed = false;

  const sync = (interval = SEARCH_SYNC_INTERVAL_MS) => {
    if (disposed) return;
    const wait = lastSyncAt + interval - now();
    if (syncTimer !== null) {
      // A sooner reason replaces a later timer.
      if (wait >= syncDueAt - now()) return;
      clearTimer(syncTimer);
      syncTimer = null;
    }
    if (wait > 0) {
      syncDueAt = now() + wait;
      syncTimer = setTimer(() => {
        syncTimer = null;
        sync(interval);
      }, wait);
      return;
    }
    lastSyncAt = now();
    behind = false;
    options.requestSync();
  };
  const counts = () => {
    if (disposed || countsTimer !== null) return;
    const wait = lastCountsAt + SEARCH_COUNTS_INTERVAL_MS - now();
    if (wait > 0) {
      countsTimer = setTimer(() => {
        countsTimer = null;
        counts();
      }, wait);
      return;
    }
    lastCountsAt = now();
    options.refreshCounts();
  };
  const follow = (jobs: boolean, run: boolean, other = false) => {
    if (!jobs && !run && !other) return;
    const route = options.currentRoute();
    if (other || (jobs && isSearchJobsViewRoute(route))) sync();
    else if (run && isSearchViewRoute(route))
      sync(SEARCH_PROGRESS_SYNC_INTERVAL_MS);
    if (jobs && !isSearchJobsViewRoute(route)) {
      behind = true;
      counts();
    }
  };

  return {
    onChanges(changes) {
      if (disposed || !options.isSearchRunning()) return;
      const { jobs, run, other } = classifySearchChanges(changes);
      follow(jobs, run, other);
    },
    onSearchProgress() {
      if (disposed) return;
      follow(true, true);
    },
    onRouteChange() {
      if (disposed || !behind) return;
      if (isSearchJobsViewRoute(options.currentRoute())) sync();
    },
    dispose() {
      disposed = true;
      if (syncTimer !== null) clearTimer(syncTimer);
      if (countsTimer !== null) clearTimer(countsTimer);
    },
  };
}

/**
 * List counts read during a search for screens that do not sync. They belong
 * to the workspace snapshot that was current when they were read; any newer
 * snapshot already counts the same jobs itself.
 */
interface SearchLiveCounts {
  counts: WorkspaceListCounts;
  workspace: JobFinderRendererWorkspaceSnapshot;
}
let liveCounts: SearchLiveCounts | null = null;
const listeners = new Set<() => void>();

export function publishSearchLiveCounts(next: SearchLiveCounts | null): void {
  liveCounts = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const read = () => liveCounts;

/** The counts to show beside `workspace`, or null when its own are current. */
export function useSearchLiveCounts(
  workspace: JobFinderRendererWorkspaceSnapshot,
): WorkspaceListCounts | null {
  const current = useSyncExternalStore(subscribe, read, read);
  return current?.workspace === workspace ? current.counts : null;
}
