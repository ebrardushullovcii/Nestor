import {
  isRunnableJobDiscoveryTarget,
  type BrowserSessionState,
  type JobSearchPreferences,
} from "@nestor/contracts";

/**
 * Copy shared by the route header and search controls when Job Finder cannot
 * run a search at all.
 *
 * The old sentence named the build and its runtime lane, which is a fact about
 * how the app was assembled and nothing a person looking for work can act on.
 * Written in the voice of the failure copy table: what happened, and what to
 * do next.
 */
export const DISCOVERY_OFFLINE_SEARCH_REASON =
  "Job Finder cannot search right now; try again in a moment.";

/**
 * The results already on screen were saved earlier and are still worth
 * reading, but nothing here proves a search just ran.
 */
export const DISCOVERY_OFFLINE_CATALOG_NOTICE =
  "These results were saved earlier, so some may no longer be open.";

export const DISCOVERY_OFFLINE_SETUP_NOTICE = `${DISCOVERY_OFFLINE_SEARCH_REASON} ${DISCOVERY_OFFLINE_CATALOG_NOTICE}`;

export const DISCOVERY_OFFLINE_RUNTIME_LABEL = "Search unavailable";

export type DiscoveryRuntimeCapability = "agent_backed" | "offline_catalog";

export interface DiscoveryRuntimeProjection {
  capability: DiscoveryRuntimeCapability;
  isOffline: boolean;
  sourceSearchAvailable: boolean;
}

/**
 * `catalog_seed` is the explicit offline/catalog execution lane. A ready
 * status there only means the deterministic catalog can be read; it is not a
 * live source-search capability. An agent-backed driver keeps current-source
 * search available unless its session is genuinely blocked: a closed,
 * starting, or sign-in-pending browser is opened or handled by the run.
 *
 * `uninitialized` means no browser session exists yet, which is the normal
 * state of a fresh workspace before its first search. That is agent-backed:
 * the discovery run opens the browser itself, so it must never read as
 * offline.
 */
export function getDiscoveryRuntimeProjection(
  session: Pick<BrowserSessionState, "driver" | "status">,
): DiscoveryRuntimeProjection {
  const isOffline = session.driver === "catalog_seed";

  return {
    capability: isOffline ? "offline_catalog" : "agent_backed",
    isOffline,
    sourceSearchAvailable: !isOffline && session.status !== "blocked",
  };
}

/**
 * The single cause that currently disables Search, so every control derives
 * its label and target from the same fact instead of guessing. `null` means
 * the search is ready.
 */
export type DiscoverySearchBlocker =
  | "no_enabled_sources"
  | "no_search_roles"
  | "offline_runtime";

export interface DiscoverySearchReadiness {
  enabledSourceCount: number;
  hasSearchRoles: boolean;
  setupReady: boolean;
  sourceSearchAvailable: boolean;
  ready: boolean;
  reason: string | null;
  blocker: DiscoverySearchBlocker | null;
}

/**
 * Visible reason used by every Find-jobs search control while campaign
 * activity is paused. Non-color, one sentence, and distinct from the source
 * readiness reason so the two states are never confused.
 */
export const DISCOVERY_PAUSED_SEARCH_REASON =
  "Search is paused, so new searches stay unavailable.";

export function getDiscoverySearchReadiness(
  searchPreferences: JobSearchPreferences,
  session?: Pick<BrowserSessionState, "driver" | "status">,
): DiscoverySearchReadiness {
  const hasSearchRoles =
    searchPreferences.targetRoles.length > 0 ||
    searchPreferences.jobFamilies.length > 0;
  const enabledSourceCount = searchPreferences.discovery.targets.filter(
    isRunnableJobDiscoveryTarget,
  ).length;
  // Saved roles refine a search; the profile also guides a run without them.
  const setupReady = enabledSourceCount > 0;
  const runtime = session ? getDiscoveryRuntimeProjection(session) : null;
  // A browser that is blocked on one site (a sign-in, a failed page) never
  // holds back the whole search: the run reopens the browser and skips the
  // sources it cannot reach. Only an offline build cannot search.
  const sourceSearchAvailable = runtime ? !runtime.isOffline : true;
  const blocker: DiscoverySearchBlocker | null =
    enabledSourceCount === 0
      ? "no_enabled_sources"
      : runtime?.isOffline
        ? "offline_runtime"
        : null;

  return {
    enabledSourceCount,
    hasSearchRoles,
    setupReady,
    sourceSearchAvailable,
    ready: setupReady && sourceSearchAvailable,
    reason:
      blocker === "no_enabled_sources"
        ? "Add or enable at least one valid public job-source URL before searching."
        : blocker === "offline_runtime"
          ? DISCOVERY_OFFLINE_SEARCH_REASON
          : null,
    blocker,
  };
}
