import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { SavedJob } from "@nestor/contracts";
import { attachStoredSavedJobFingerprints } from "./saved-job-fingerprints";
import { attachStoredSavedJobSalary } from "./saved-job-storage";

/** Transaction-current rows for bounded writes; bodies load only if the updater reads them. */
export function createSavedJobWriteReader(db: DatabaseSync) {
  const rows =
    db.prepare(`SELECT j.id, j.value, j.assessment_id, j.has_plan_assessments,
    j.first_seen_at, j.last_seen_at, j.last_verified_active_at, j.description_id,
    a.value AS assessment, t.stable_key AS body_key, t.salary_prepared, t.salary_evidence,
    f.value AS fingerprints FROM saved_jobs j
    LEFT JOIN job_fit_assessments a ON a.id = j.assessment_id
    LEFT JOIN job_listing_texts t ON t.id = j.description_id
    LEFT JOIN saved_job_discovery_fingerprints f ON f.job_id = j.id
    WHERE j.id IN (SELECT value FROM json_each(?)) ORDER BY j.id`);
  const plans =
    db.prepare(`SELECT job_id, plan_id, value FROM job_plan_assessments
    WHERE job_id IN (SELECT value FROM json_each(?))`);
  const sightings =
    db.prepare(`SELECT job_id, value, description_id FROM job_provenance
    WHERE job_id IN (SELECT value FROM json_each(?)) ORDER BY job_id, position`);
  const text = db.prepare(
    "SELECT id, text FROM job_listing_texts WHERE id IN (SELECT value FROM json_each(?))",
  );
  return (ids: readonly string[]) => {
    if (!ids.length) return [];
    const keys = JSON.stringify([...new Set(ids)]);
    const currentRows = rows.all(keys);
    const sourceRows = sightings.all(keys);
    const jobs = new Map<string, { job: SavedJob; bodyKey: string | null }>();
    let bodies: Map<number, string> | undefined;
    const body = (id: number) => () => {
      bodies ??= new Map(
        text
          .all(
            JSON.stringify([
              ...new Set(
                [
                  ...currentRows.map((row) => row.description_id),
                  ...sourceRows.map((row) => row.description_id),
                ].filter((key) => key !== null),
              ),
            ]),
          )
          .map((row) => [Number(row.id), String(row.text)]),
      );
      const value = bodies.get(id);
      if (value === undefined)
        throw new Error("Saved listing text is missing.");
      return value;
    };
    for (const row of currentRows) {
      const job = JSON.parse(String(row.value)) as SavedJob;
      if (row.assessment_id !== null) {
        job.matchAssessment = JSON.parse(
          String(row.assessment),
        ) as SavedJob["matchAssessment"];
        job.firstSeenAt = row.first_seen_at as SavedJob["firstSeenAt"];
        job.lastSeenAt = row.last_seen_at as SavedJob["lastSeenAt"];
        job.lastVerifiedActiveAt =
          row.last_verified_active_at as SavedJob["lastVerifiedActiveAt"];
        job.provenance = [];
        if (row.has_plan_assessments === 1) job.planAssessments = {};
        else delete job.planAssessments;
        Object.defineProperty(job, "description", {
          enumerable: true,
          configurable: true,
          get: body(row.description_id as number),
        });
      }
      jobs.set(job.id, { job, bodyKey: row.body_key as string | null });
    }
    for (const row of plans.all(keys)) {
      const job = jobs.get(String(row.job_id))!.job;
      (job.planAssessments ??= {})[String(row.plan_id)] = JSON.parse(
        String(row.value),
      ) as SavedJob["matchAssessment"];
    }
    for (const row of sourceRows) {
      const sighting = JSON.parse(
        String(row.value),
      ) as SavedJob["provenance"][number];
      if (row.description_id !== null && sighting.listingFacts)
        Object.defineProperty(sighting.listingFacts, "description", {
          enumerable: true,
          configurable: true,
          get: body(row.description_id as number),
        });
      jobs.get(String(row.job_id))!.job.provenance.push(sighting);
    }
    for (const row of currentRows) {
      const job = jobs.get(String(row.id))!.job;
      attachStoredSavedJobFingerprints(job, row.fingerprints, true);
      attachStoredSavedJobSalary(job, row.salary_prepared, row.salary_evidence);
    }
    return [...jobs.values()];
  };
}

/** Freeze data without opening lazy fields; the rows never outlive their transaction. */
export function freezeSavedJobForWrite<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    ))
      if ("value" in descriptor)
        freezeSavedJobForWrite(descriptor.value as unknown);
    Object.freeze(value);
  }
  return value;
}

export function sameSavedJobWrite(left: SavedJob, right: SavedJob): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => {
      if (!Object.hasOwn(right, key)) return false;
      const a = Object.getOwnPropertyDescriptor(left, key)!;
      const b = Object.getOwnPropertyDescriptor(right, key)!;
      if (a.get && a.get === b.get) return true;
      return isDeepStrictEqual(Reflect.get(left, key), Reflect.get(right, key));
    })
  );
}
