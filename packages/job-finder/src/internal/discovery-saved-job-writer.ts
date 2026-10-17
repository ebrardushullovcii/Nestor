import { isDeepStrictEqual } from "node:util";
import type { JobFinderDiscoveryState, SavedJob } from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

type DiscoveryUpdate = (
  current: JobFinderDiscoveryState,
) => JobFinderDiscoveryState;

/** Tracks immutable working rows, so a checkpoint only visits its changed jobs. */
export function createDiscoverySavedJobWriter(input: {
  persistedJobs: readonly SavedJob[];
  toStoredJob: (job: SavedJob) => SavedJob;
  merge: (
    current: SavedJob,
    baseline: SavedJob,
    intended: SavedJob,
  ) => SavedJob;
  commit: JobFinderRepository["commitSavedJobDelta"];
  persistDiscovery: (update: DiscoveryUpdate) => Promise<unknown>;
}) {
  const persisted = new Map(input.persistedJobs.map((job) => [job.id, job]));
  const committedReferences = new Map(persisted);
  let pending = new Map<string, SavedJob>();
  let tail = Promise.resolve();

  const stage = (job: SavedJob): void => {
    if (committedReferences.get(job.id) === job) pending.delete(job.id);
    else pending.set(job.id, job);
  };

  return {
    stage,
    // Only used when a speculative merge fails. Routine checkpoints never
    // rebuild this map or walk the saved inventory.
    restoreWorkingRows(jobs: readonly SavedJob[]): void {
      pending = new Map();
      for (const job of jobs) stage(job);
    },
    persist(this: void, updateDiscoveryState?: DiscoveryUpdate): Promise<void> {
      // Capture the intended references now. Another source or fit batch may
      // change a row while this commit awaits storage; that newer row must
      // remain pending and cannot become the baseline of the older commit.
      const captured = new Map(pending);
      const write = async (): Promise<void> => {
        const upserts: SavedJob[] = [];
        const updates = new Map<
          string,
          { baseline: SavedJob; intended: SavedJob }
        >();
        const intendedRows = new Map<string, SavedJob>();
        for (const [id, job] of captured) {
          if (committedReferences.get(id) === job) continue;
          const intended = input.toStoredJob(job);
          intendedRows.set(id, intended);
          const baseline = persisted.get(id);
          if (!baseline) upserts.push(intended);
          else if (!isDeepStrictEqual(baseline, intended)) {
            updates.set(id, { baseline, intended });
          }
        }

        if (upserts.length > 0 || updates.size > 0) {
          await input.commit({
            upserts,
            updateJobIds: [...updates.keys()],
            update: (current) => {
              const change = updates.get(current.id);
              return change
                ? input.merge(current, change.baseline, change.intended)
                : current;
            },
            ...(updateDiscoveryState ? { updateDiscoveryState } : {}),
          });
        } else if (updateDiscoveryState) {
          await input.persistDiscovery(updateDiscoveryState);
        }

        for (const [id, intended] of intendedRows) persisted.set(id, intended);
        for (const [id, job] of captured) {
          committedReferences.set(id, job);
          if (pending.get(id) === job) pending.delete(id);
        }
      };
      const result = tail.then(write);
      // A failed atomic write leaves both the baseline and dirty references
      // intact for the final pass; it must not poison subsequent writes.
      tail = result.catch(() => {});
      return result;
    },
  };
}
