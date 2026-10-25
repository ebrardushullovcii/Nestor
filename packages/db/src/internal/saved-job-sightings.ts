import type { DatabaseSync } from "node:sqlite";
import type { SavedJob, SavedJobSightingPatch } from "@nestor/contracts";
import { prepareStatement } from "./sqlite-statements";

export const savedJobSightingColumns = {
  firstSeenAt: "first_seen_at",
  lastSeenAt: "last_seen_at",
  lastVerifiedActiveAt: "last_verified_active_at",
} as const;

/** Last supplied value wins per field; undefined means leave it alone. */
function coalesce(
  updates: readonly SavedJobSightingPatch[],
): SavedJobSightingPatch[] {
  const rows = new Map<string, SavedJobSightingPatch>();
  for (const update of updates) {
    const next = rows.get(update.id) ?? { id: update.id };
    for (const field of Object.keys(savedJobSightingColumns) as Array<
      keyof typeof savedJobSightingColumns
    >)
      if (update[field] !== undefined) next[field] = update[field];
    rows.set(update.id, next);
  }
  return [...rows.values()];
}

/** One indexed UPDATE, with no canonical row/body read or serialization. */
export function writeSavedJobSightings(
  db: DatabaseSync,
  updates: readonly SavedJobSightingPatch[],
): number {
  if (!updates.length) return 0;
  if (!db.isTransaction)
    throw new Error("Saved-job sightings require the job transaction.");
  const fields = Object.entries(savedJobSightingColumns);
  return Number(
    prepareStatement(
      db,
      `UPDATE saved_jobs AS job SET
    ${fields.map(([field, column]) => `${column} = CASE WHEN json_type(patch.value, '$.${field}') IS NULL THEN job.${column} ELSE json_extract(patch.value, '$.${field}') END`).join(", ")}
    FROM json_each(?) AS patch WHERE job.id = json_extract(patch.value, '$.id') AND job.assessment_id IS NOT NULL
    AND (${fields.map(([field, column]) => `(json_type(patch.value, '$.${field}') IS NOT NULL AND job.${column} IS NOT json_extract(patch.value, '$.${field}'))`).join(" OR ")})
  `,
    ).run(JSON.stringify(coalesce(updates))).changes,
  );
}

export function applySavedJobSightings(
  jobs: SavedJob[],
  updates: readonly SavedJobSightingPatch[],
): { jobs: SavedJob[]; changed: number } {
  const patches = new Map(coalesce(updates).map((patch) => [patch.id, patch]));
  let next: SavedJob[] | null = null;
  let changed = 0;
  jobs.forEach((job, index) => {
    const patch = patches.get(job.id);
    if (
      !patch ||
      !Object.keys(savedJobSightingColumns).some(
        (field) =>
          Reflect.get(patch, field) !== undefined &&
          Reflect.get(patch, field) !== Reflect.get(job, field),
      )
    )
      return;
    next ??= [...jobs];
    next[index] = { ...job, ...patch };
    changed++;
  });
  return { jobs: next ?? jobs, changed };
}
