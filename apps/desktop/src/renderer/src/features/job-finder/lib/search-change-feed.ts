import type {
  JobFinderRendererWorkspaceSnapshot,
  WorkspaceListCounts,
} from "@nestor/contracts";
import { useSyncExternalStore } from "react";

/**
 * List counts read after a view refresh, which only patches the lists. They
 * belong to the workspace snapshot that was current when they were read; any
 * newer snapshot already counts the same jobs itself.
 */
interface SearchLiveCounts {
  counts: WorkspaceListCounts;
  workspace: JobFinderRendererWorkspaceSnapshot;
  /** The weaker matches behind "Show weaker matches", when read. */
  weaker?: number;
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

/**
 * Reads Find jobs' counts for `workspace` (a view refresh keeps the Find
 * jobs lists only patched, so their lengths are not the counts any more).
 */
export async function publishLiveFindJobsCounts(
  workspace: JobFinderRendererWorkspaceSnapshot,
): Promise<void> {
  const queries =
    typeof window === "undefined"
      ? undefined
      : window.nestor?.jobFinder?.queries;
  if (!queries) return;
  const planId = workspace.activeCampaignId;
  try {
    const [counts, wide] = await Promise.all([
      queries.getListCounts(),
      queries.queryJobList({
        list: "discovery",
        filters: {
          ...(planId ? { planId } : {}),
          discoveryBands: ["matches", "unchecked", "weaker", "mismatches"],
        },
        page: { offset: 0, limit: 1 },
      }),
    ]);
    publishSearchLiveCounts({
      counts,
      workspace,
      weaker: Math.max(0, wide.total - counts.discovery),
    });
  } catch {
    // The lists' own counts stay; the next refresh reads again.
  }
}

/** Find jobs' two numbers Home shows, while they come from queries. */
export function useLiveFindJobsCounts(
  workspace: JobFinderRendererWorkspaceSnapshot,
): { visible: number; weaker: number } | null {
  const current = useSyncExternalStore(subscribe, read, read);
  return current?.workspace === workspace && current.weaker !== undefined
    ? { visible: current.counts.discovery, weaker: current.weaker }
    : null;
}
