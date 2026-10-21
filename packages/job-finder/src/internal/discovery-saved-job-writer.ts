import { isDeepStrictEqual } from "node:util";
import type { JobFinderDiscoveryState, SavedJob } from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

type DiscoveryUpdate = (
  current: JobFinderDiscoveryState,
) => JobFinderDiscoveryState;

/**
 * Saved jobs written per transaction. A source of hundreds of new jobs saved
 * in one transaction held the main process for seconds; larger saves are
 * written in parts with a turn of the event loop between them, the
 * discovery update going with the last part so the run never counts a job
 * before it is stored.
 */
const ROWS_PER_COMMIT = 60;

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Discovery updates that carry the whole working state as it stood when they
 * were made (the run, its ledger, its staged jobs). A later one includes
 * everything an earlier one wrote, so a batch applies only the last of them
 * and whatever came after it; rebasing a 30,000-entry ledger once per saved
 * source in a batch was most of a search's save time.
 */
const supersedingUpdates = new WeakSet<DiscoveryUpdate>();

export function markSupersedingDiscoveryUpdate(
  update: DiscoveryUpdate,
): DiscoveryUpdate {
  supersedingUpdates.add(update);
  return update;
}

function composeUpdates(
  updates: readonly DiscoveryUpdate[],
): DiscoveryUpdate | undefined {
  let start = 0;
  for (const [index, update] of updates.entries())
    if (supersedingUpdates.has(update)) start = index;
  const applied = updates.slice(start);
  if (applied.length <= 1) return applied[0];
  return (current) => applied.reduce((state, update) => update(state), current);
}

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
  /**
   * How long a save waits for others to join it. A search over hundreds of
   * provider feeds finishes several sources a second, and one transaction
   * each rewrote the run's sources and ledger every time. Saves asked for
   * within the window are written together, their discovery updates applied
   * in the order they were asked for. Zero writes each save on its own.
   */
  coalesceMs?: number;
}) {
  const persisted = new Map(input.persistedJobs.map((job) => [job.id, job]));
  const committedReferences = new Map(persisted);
  let pending = new Map<string, SavedJob>();
  let tail = Promise.resolve();
  let gathering: { updates: DiscoveryUpdate[]; promise: Promise<void> } | null =
    null;

  const stage = (job: SavedJob): void => {
    if (committedReferences.get(job.id) === job) pending.delete(job.id);
    else pending.set(job.id, job);
  };

  // `captured` holds the intended references of this write. Another source
  // or fit batch may change a row while it awaits storage; that newer row
  // must remain pending and cannot become the baseline of this write.
  const write = async (
    captured: ReadonlyMap<string, SavedJob>,
    updateDiscoveryState: DiscoveryUpdate | undefined,
  ): Promise<void> => {
    const changedIds: string[] = [];
    const intendedRows = new Map<string, SavedJob>();
    const settled = (id: string, job: SavedJob) => {
      const intended = intendedRows.get(id);
      if (intended) persisted.set(id, intended);
      committedReferences.set(id, job);
      if (pending.get(id) === job) pending.delete(id);
    };
    for (const [id, job] of captured) {
      if (committedReferences.get(id) === job) continue;
      const intended = input.toStoredJob(job);
      intendedRows.set(id, intended);
      const baseline = persisted.get(id);
      if (!baseline || !isDeepStrictEqual(baseline, intended))
        changedIds.push(id);
    }

    if (changedIds.length === 0) {
      if (updateDiscoveryState)
        await input.persistDiscovery(updateDiscoveryState);
    }
    for (let start = 0; start < changedIds.length; start += ROWS_PER_COMMIT) {
      if (start > 0) await yieldToEventLoop();
      const partIds = changedIds.slice(start, start + ROWS_PER_COMMIT);
      const last = start + ROWS_PER_COMMIT >= changedIds.length;
      const upserts: SavedJob[] = [];
      const updates = new Map<
        string,
        { baseline: SavedJob; intended: SavedJob }
      >();
      for (const id of partIds) {
        const intended = intendedRows.get(id)!;
        const baseline = persisted.get(id);
        if (!baseline) upserts.push(intended);
        else updates.set(id, { baseline, intended });
      }
      await input.commit({
        upserts,
        updateJobIds: [...updates.keys()],
        update: (current) => {
          const change = updates.get(current.id);
          return change
            ? input.merge(current, change.baseline, change.intended)
            : current;
        },
        ...(last && updateDiscoveryState ? { updateDiscoveryState } : {}),
      });
      for (const id of partIds) settled(id, captured.get(id)!);
    }

    for (const [id, job] of captured) settled(id, job);
  };

  const enqueue = (run: () => Promise<void>): Promise<void> => {
    const result = tail.then(run);
    // A failed atomic write leaves both the baseline and dirty references
    // intact for the final pass; it must not poison subsequent writes.
    tail = result.catch(() => {});
    return result;
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
      const coalesceMs = input.coalesceMs ?? 0;
      if (coalesceMs <= 0) {
        // Capture the intended references now, when the save is asked for.
        const captured = new Map(pending);
        return enqueue(() => write(captured, updateDiscoveryState));
      }
      if (gathering) {
        if (updateDiscoveryState) gathering.updates.push(updateDiscoveryState);
        return gathering.promise;
      }
      const updates: DiscoveryUpdate[] = updateDiscoveryState
        ? [updateDiscoveryState]
        : [];
      const batch = {
        updates,
        promise: new Promise<void>((resolve) =>
          setTimeout(resolve, coalesceMs),
        ).then(() => {
          gathering = null;
          // Every save in the batch was asked for by now, so the rows pending
          // at this moment include each one's rows.
          return enqueue(() =>
            write(new Map(pending), composeUpdates(updates)),
          );
        }),
      };
      gathering = batch;
      return batch.promise;
    },
  };
}
