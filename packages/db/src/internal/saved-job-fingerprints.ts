import type { DatabaseSync } from "node:sqlite";
import {
  SavedJobSchema,
  DISCOVERY_FINGERPRINT_FIELDS,
  readPreparedDiscoveryFingerprints,
  writeDiscoveryPreparation,
  type DiscoveryListingFingerprints,
  type SavedJob,
} from "@nestor/contracts";

export function ensureSavedJobFingerprintStorage(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS saved_job_discovery_fingerprints (
    job_id TEXT PRIMARY KEY REFERENCES saved_jobs(id) ON DELETE CASCADE,
    value TEXT NOT NULL
  )`);
}

/** No listing bodies are selected; one indexed query answers the entire batch. */
export function readSavedJobFingerprintBatch(
  db: DatabaseSync,
  ids: readonly string[],
): ReadonlyMap<string, DiscoveryListingFingerprints> {
  if (!ids.length) return new Map();
  return new Map(
    db
      .prepare(
        `SELECT job_id, value FROM saved_job_discovery_fingerprints
    WHERE job_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify([...new Set(ids)]))
      .map((row) => [
        String(row.job_id),
        JSON.parse(String(row.value)) as DiscoveryListingFingerprints,
      ]),
  );
}

/** The caller's job transaction owns this write and any rollback. */
export function writeSavedJobFingerprints(
  db: DatabaseSync,
  job: SavedJob,
): void {
  if (!db.isTransaction)
    throw new Error("Saved-job fingerprints require the job transaction.");
  const value = readPreparedDiscoveryFingerprints(job);
  if (!value) {
    db.prepare(
      "DELETE FROM saved_job_discovery_fingerprints WHERE job_id = ?",
    ).run(job.id);
    return;
  }
  db.prepare(
    `INSERT INTO saved_job_discovery_fingerprints(job_id, value) VALUES (?, ?)
    ON CONFLICT(job_id) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value`,
  ).run(job.id, JSON.stringify(value));
}

function capturedFingerprintBasis(
  row: object,
): Readonly<Record<string, unknown>> {
  return structuredClone(
    Object.fromEntries(
      DISCOVERY_FINGERPRINT_FIELDS.map((field) => [
        field,
        Reflect.get(row, field),
      ]),
    ),
  );
}

/** Transitional legacy write validation preserves the new carried metadata. */
export function parseSavedJobWithPreparation(job: SavedJob): SavedJob {
  const row = SavedJobSchema.parse(job);
  const value = readPreparedDiscoveryFingerprints(job);
  if (value) {
    writeDiscoveryPreparation(row, {
      fingerprints: {
        basis: capturedFingerprintBasis(job),
        value: { ...value },
      },
    });
    if (!readPreparedDiscoveryFingerprints(row))
      writeDiscoveryPreparation(row, { fingerprints: undefined });
  }
  return row;
}
export function parseSavedJobsWithPreparation(
  jobs: readonly SavedJob[],
): SavedJob[] {
  return jobs.map(parseSavedJobWithPreparation);
}
export function cloneSavedJobWithPreparation(job: SavedJob): SavedJob {
  const row = structuredClone(job);
  const value = readPreparedDiscoveryFingerprints(job);
  if (value)
    writeDiscoveryPreparation(row, {
      fingerprints: {
        basis: capturedFingerprintBasis(row),
        value: { ...value },
      },
    });
  return row;
}
