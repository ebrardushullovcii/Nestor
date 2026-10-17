import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";

export const RESUME_WORKSPACE_REQUIRED_COLLECTIONS = [
  "discovery_jobs",
  "review_queue",
  "documents",
] as const;

export type ResumeWorkspaceRouteState =
  | { kind: "hydrating" }
  | { kind: "available" }
  | { kind: "unavailable" };

/**
 * Decides what the resume workspace route should do for a just-synced
 * workspace snapshot.
 *
 * The workspace bootstrap intentionally leaves the deferred review queue (and
 * the other large collections) empty. A snapshot that is still hydrating must
 * never be treated as proof that the job is missing; the route shows its
 * loading gate instead. Once hydration is complete the snapshot's review queue
 * is authoritative, so an absent job is genuinely unavailable and the route can
 * show an explicit reason instead of silently bouncing.
 *
 * Benign background refreshes and fit-score recomputes land here too: as long
 * as the job stays in the hydrated queue, the route remains available.
 */
export function resolveResumeWorkspaceRouteState(input: {
  hydration: JobFinderRendererWorkspaceSnapshot["hydration"];
  reviewQueue: readonly JobFinderRendererWorkspaceSnapshot["reviewQueue"][number][];
  jobId: string;
}): ResumeWorkspaceRouteState {
  const isHydrating =
    input.hydration.phase === "bootstrap" &&
    RESUME_WORKSPACE_REQUIRED_COLLECTIONS.some((collection) =>
      input.hydration.deferredCollections.includes(collection),
    );

  if (isHydrating) {
    return { kind: "hydrating" };
  }

  const isAvailable = input.reviewQueue.some(
    (item) => item.jobId === input.jobId,
  );

  return isAvailable ? { kind: "available" } : { kind: "unavailable" };
}
