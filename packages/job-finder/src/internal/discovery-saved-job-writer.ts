import { isDeepStrictEqual } from "node:util";
import type {
  JobFinderDiscoveryState,
  SavedJob,
  SavedJobPlanAssessmentPatch,
  SavedJobSightingPatch,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { yieldToEventLoop } from "@nestor/core";

type DiscoveryUpdate = ((
  current: JobFinderDiscoveryState,
) => JobFinderDiscoveryState) & { committed?: () => void };

/**
 * Saved jobs written per transaction. A source of hundreds of new jobs saved
 * in one transaction held the main process for seconds; larger saves are
 * written in parts with a turn of the event loop between them, the
 * discovery update going with the last part so the run never counts a job
 * before it is stored.
 */
const ROWS_PER_COMMIT = 12;

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
  return Object.assign(
    (current: JobFinderDiscoveryState) =>
      applied.reduce((state, update) => update(state), current),
    { committed: () => applied.forEach((update) => update.committed?.()) },
  );
}

/** Plan verdicts and sightings do not need a transaction-current listing body. */
function metadataChanges(
  baseline: SavedJob,
  intended: SavedJob,
): {
  sighting: SavedJobSightingPatch;
  planAssessments: SavedJobPlanAssessmentPatch[];
} | null {
  const sighting: SavedJobSightingPatch = { id: intended.id };
  const planAssessments: SavedJobPlanAssessmentPatch[] = [];
  for (const key of Object.keys(intended) as Array<keyof SavedJob>) {
    const before = Object.getOwnPropertyDescriptor(baseline, key);
    const after = Object.getOwnPropertyDescriptor(intended, key);
    if (before?.get && before.get === after?.get) continue;
    if (before?.get || after?.get) return null;
    if (before?.value === after?.value) continue;
    if (key === "planAssessments") {
      const previous = baseline.planAssessments;
      const next = intended.planAssessments;
      if (
        !next ||
        (!previous && Object.keys(next).length === 0) ||
        Object.keys(previous ?? {}).some(
          (planId) => !Object.hasOwn(next, planId),
        )
      )
        return null;
      for (const [planId, assessment] of Object.entries(next))
        if (!isDeepStrictEqual(previous?.[planId], assessment))
          planAssessments.push({ jobId: intended.id, planId, assessment });
    } else if (
      key === "firstSeenAt" ||
      key === "lastSeenAt" ||
      key === "lastVerifiedActiveAt"
    ) {
      const value = intended[key];
      if (value === undefined) return null;
      sighting[key] = value;
    } else return null;
  }
  return { sighting, planAssessments };
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
  /** Gather saves requested in this event-loop turn into one transaction. */
  coalesce?: boolean;
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
    const metadataById = new Map<
      string,
      NonNullable<ReturnType<typeof metadataChanges>>
    >();
    const settled = (id: string, job: SavedJob) => {
      const intended = intendedRows.get(id);
      if (intended) persisted.set(id, intended);
      committedReferences.set(id, job);
      if (pending.get(id) === job) pending.delete(id);
    };
    let turnStarted = performance.now();
    for (const [id, job] of captured) {
      if (performance.now() - turnStarted >= 8) {
        await yieldToEventLoop();
        turnStarted = performance.now();
      }
      if (committedReferences.get(id) === job) continue;
      const intended = input.toStoredJob(job);
      intendedRows.set(id, intended);
      const baseline = persisted.get(id);
      const metadata = baseline ? metadataChanges(baseline, intended) : null;
      if (metadata) {
        if (
          Object.keys(metadata.sighting).length > 1 ||
          metadata.planAssessments.length > 0
        ) {
          metadataById.set(id, metadata);
          changedIds.push(id);
        }
        continue;
      }
      if (
        !baseline ||
        Object.keys(intended).some((key) => {
          const left = Object.getOwnPropertyDescriptor(baseline, key);
          const right = Object.getOwnPropertyDescriptor(intended, key);
          if (left?.get && left.get === right?.get) return false;
          return !isDeepStrictEqual(
            Reflect.get(baseline, key),
            Reflect.get(intended, key),
          );
        })
      )
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
      const sightings: SavedJobSightingPatch[] = [];
      const planAssessments: SavedJobPlanAssessmentPatch[] = [];
      const updates = new Map<
        string,
        { baseline: SavedJob; intended: SavedJob }
      >();
      for (const id of partIds) {
        const metadata = metadataById.get(id);
        if (metadata) {
          if (Object.keys(metadata.sighting).length > 1)
            sightings.push(metadata.sighting);
          planAssessments.push(...metadata.planAssessments);
          continue;
        }
        const intended = intendedRows.get(id)!;
        const baseline = persisted.get(id);
        if (!baseline) upserts.push(intended);
        else updates.set(id, { baseline, intended });
      }
      await input.commit({
        borrowCurrentJobs: true,
        upserts,
        sightings,
        planAssessments,
        updateJobIds: [...updates.keys()],
        ...(updates.size > 0
          ? {
              update: (current: SavedJob) => {
                const change = updates.get(current.id);
                return change
                  ? input.merge(current, change.baseline, change.intended)
                  : current;
              },
            }
          : {}),
        ...(last && updateDiscoveryState ? { updateDiscoveryState } : {}),
      });
      for (const id of partIds) settled(id, captured.get(id)!);
    }

    for (const [id, job] of captured) settled(id, job);
    updateDiscoveryState?.committed?.();
  };

  const enqueue = (run: () => Promise<void>): Promise<void> => {
    const result = tail.then(async () => {
      // Empty saved-job batches still write run/ledger changes. A chain of
      // resolved commits must not starve Electron's input and timer phase.
      await yieldToEventLoop();
      return run();
    });
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
      if (!input.coalesce) {
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
        promise: new Promise<void>((resolve) => setImmediate(resolve)).then(
          () => {
            gathering = null;
            // Every save in the batch was asked for by now, so the rows pending
            // at this moment include each one's rows.
            return enqueue(() =>
              write(new Map(pending), composeUpdates(updates)),
            );
          },
        ),
      };
      gathering = batch;
      return batch.promise;
    },
  };
}
