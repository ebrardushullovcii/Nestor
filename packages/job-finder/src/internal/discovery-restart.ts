import type {
  DiscoveryRunRecord,
  JobFinderSearchRequest,
} from "@nestor/contracts";

/** How recent a finished source must be for a restarted search to skip it. */
export const RESTARTED_SEARCH_SKIP_WINDOW_MS = 24 * 60 * 60_000;

function sameSearchRequest(
  run: DiscoveryRunRecord,
  request: JobFinderSearchRequest | undefined,
): boolean {
  return (
    (run.searchIntent ?? "").trim() === (request?.intent ?? "").trim() &&
    (run.searchBreadth ?? null) === (request?.breadth ?? null) &&
    (run.searchFreshness ?? "any") === (request?.freshness ?? "any")
  );
}

/**
 * The sources a search of this plan that stopped before it finished (the app
 * closed, the person pressed Stop, the AI went away) already searched to the
 * end, so the same search started again goes on with the rest instead of
 * starting over at its first source. Walks back through consecutive stopped
 * searches of this plan with the same request; a finished search, another
 * request, or a source finished more than a day ago ends the skipping.
 * Source-generic: it reads only run records (ADR 0007).
 */
export function selectSourcesFinishedBeforeRestart(input: {
  activeRun: DiscoveryRunRecord | null;
  previousRuns: readonly DiscoveryRunRecord[];
  campaignId: string | null;
  searchRequest: JobFinderSearchRequest | undefined;
  now: Date;
}): Set<string> {
  const runs =
    input.activeRun && input.activeRun.state === "running"
      ? [input.activeRun, ...input.previousRuns]
      : input.previousRuns;
  const finished = new Set<string>();
  for (const run of runs) {
    if ((run.campaignId ?? null) !== input.campaignId) continue;
    if (run.scope !== "run_all") continue;
    if (run.state === "completed") break;
    if (!sameSearchRequest(run, input.searchRequest)) break;
    for (const execution of run.targetExecutions) {
      const completedAt = execution.completedAt
        ? Date.parse(execution.completedAt)
        : Number.NaN;
      if (
        execution.state === "completed" &&
        Number.isFinite(completedAt) &&
        input.now.getTime() - completedAt <= RESTARTED_SEARCH_SKIP_WINDOW_MS
      )
        finished.add(execution.targetId);
    }
  }
  return finished;
}
