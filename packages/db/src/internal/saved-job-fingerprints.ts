import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  SavedJobSchema,
  DISCOVERY_FINGERPRINT_FIELDS,
  readPreparedDiscoveryFingerprints,
  readPreparedSavedJobIdentity,
  readPreparedMatchAssessmentPostingFingerprint,
  computeMatchAssessmentPostingFingerprint,
  captureDiscoverySavedIdentityBasis,
  writeDiscoveryPreparation,
  readDiscoveryPreparation,
  type DiscoverySavedJobFingerprints,
  type SavedJob,
} from "@nestor/contracts";

export function ensureSavedJobFingerprintStorage(db: DatabaseSync): void {
  const inputs = new Set([
    ...DISCOVERY_FINGERPRINT_FIELDS,
    ...Object.keys(captureDiscoverySavedIdentityBasis({})).filter(
      (key) => key !== "alternateListingUrls",
    ),
    "provenance",
  ]);
  db.exec(`CREATE TABLE IF NOT EXISTS saved_job_discovery_fingerprints (
    job_id TEXT PRIMARY KEY REFERENCES saved_jobs(id) ON DELETE CASCADE,
    value TEXT NOT NULL
  );
  DROP TRIGGER IF EXISTS saved_job_preparation_update;
  CREATE TRIGGER saved_job_preparation_update AFTER UPDATE OF value ON saved_jobs
    WHEN OLD.value IS NOT NEW.value AND CASE WHEN json_valid(OLD.value) AND json_valid(NEW.value) THEN
      ${[...inputs].map((key) => `(json_type(OLD.value, '$.${key}') IS NOT json_type(NEW.value, '$.${key}') OR json_extract(OLD.value, '$.${key}') IS NOT json_extract(NEW.value, '$.${key}'))`).join(" OR ")}
      ELSE 1 END BEGIN
    DELETE FROM saved_job_discovery_fingerprints WHERE job_id = OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS saved_job_preparation_delete AFTER DELETE ON saved_jobs BEGIN
    DELETE FROM saved_job_discovery_fingerprints WHERE job_id = OLD.id;
  END;`);
}

type StoredFingerprints = Omit<DiscoverySavedJobFingerprints, "identity"> & {
  identity?: Omit<
    NonNullable<DiscoverySavedJobFingerprints["identity"]>,
    "content"
  > & {
    content: { digest: string; packed: string } | null;
  };
};

/** Both callers are transaction-current; description can be verified by its interned hash. */
export function samePreparedSavedJobInputs(
  left: SavedJob,
  right: SavedJob,
): boolean {
  return (
    DISCOVERY_FINGERPRINT_FIELDS.every((field) =>
      isDeepStrictEqual(left[field], right[field]),
    ) &&
    isDeepStrictEqual(
      captureDiscoverySavedIdentityBasis(left),
      captureDiscoverySavedIdentityBasis(right),
    )
  );
}

function decodeFingerprints(raw: string): DiscoverySavedJobFingerprints {
  const { identity, ...stored } = JSON.parse(raw) as StoredFingerprints;
  return {
    ...stored,
    ...(identity
      ? {
          identity: {
            ...identity,
            content: identity.content
              ? {
                  digest: identity.content.digest,
                  packed: Uint8Array.from(
                    Buffer.from(identity.content.packed, "base64"),
                  ),
                }
              : null,
          },
        }
      : {}),
  };
}

export function readSavedJobPreparedValue(
  job: SavedJob,
): DiscoverySavedJobFingerprints | null {
  const fingerprints = readPreparedDiscoveryFingerprints(job);
  if (!fingerprints) return null;
  const identity = readPreparedSavedJobIdentity(job);
  const { version, card, detail, material } = fingerprints;
  return {
    version,
    card,
    detail,
    material,
    matchAssessmentPostingFingerprint:
      readPreparedMatchAssessmentPostingFingerprint(job) ??
      computeMatchAssessmentPostingFingerprint(job),
    ...(identity ? { identity: structuredClone(identity) } : {}),
  };
}

/** No listing bodies are selected; one indexed query answers the entire batch. */
export function readSavedJobFingerprintBatch(
  db: DatabaseSync,
  ids: readonly string[],
): ReadonlyMap<string, DiscoverySavedJobFingerprints> {
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
        decodeFingerprints(String(row.value)),
      ]),
  );
}

/** The caller's job transaction owns this write and any rollback. */
const writes = new WeakMap<
  DatabaseSync,
  { put: StatementSync; remove: StatementSync; read: StatementSync }
>();
export function writeSavedJobFingerprints(
  db: DatabaseSync,
  job: SavedJob,
): void {
  if (!db.isTransaction)
    throw new Error("Saved-job fingerprints require the job transaction.");
  let prepared = writes.get(db);
  if (!prepared) {
    prepared = {
      put: db.prepare(`INSERT INTO saved_job_discovery_fingerprints(job_id, value) VALUES (?, ?)
        ON CONFLICT(job_id) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value`),
      remove: db.prepare(
        "DELETE FROM saved_job_discovery_fingerprints WHERE job_id = ?",
      ),
      read: db.prepare(
        "SELECT value FROM saved_job_discovery_fingerprints WHERE job_id = ?",
      ),
    };
    writes.set(db, prepared);
  }
  const value = readSavedJobPreparedValue(job);
  if (!value) {
    prepared.remove.run(job.id);
    return;
  }
  const { identity, ...fingerprints } = value;
  const stored: StoredFingerprints = {
    ...fingerprints,
    ...(identity
      ? {
          identity: {
            ...identity,
            content: identity.content
              ? {
                  digest: identity.content.digest,
                  packed: Buffer.from(identity.content.packed).toString(
                    "base64",
                  ),
                }
              : null,
          },
        }
      : {}),
  };
  const serialized = JSON.stringify(stored);
  // Read transaction-current storage rather than caching across rollback or
  // another connection's edit. Equality is checked before binding the body.
  if (prepared.read.get(job.id)?.value === serialized) return;
  prepared.put.run(job.id, serialized);
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

/** A codec may normalize fields; retain only preparation still valid afterward. */
export function copySavedJobPreparation<T extends SavedJob>(
  job: SavedJob,
  row: T,
): T {
  const value = readPreparedDiscoveryFingerprints(job);
  if (value) {
    writeDiscoveryPreparation(row, {
      fingerprints: {
        basis: capturedFingerprintBasis(job),
        value: { ...value },
      },
    });
    if (!readPreparedDiscoveryFingerprints(row))
      delete readDiscoveryPreparation(row)!.fingerprints;
    else {
      const fingerprint =
        readPreparedMatchAssessmentPostingFingerprint(row, job) ??
        computeMatchAssessmentPostingFingerprint(row);
      writeDiscoveryPreparation(row, {
        matchAssessmentPostingFingerprint: fingerprint,
      });
    }
  }
  const identity = readPreparedSavedJobIdentity(job);
  if (identity) {
    writeDiscoveryPreparation(row, {
      savedIdentity: {
        basis: captureDiscoverySavedIdentityBasis(job),
        value: structuredClone(identity),
      },
    });
    if (!readPreparedSavedJobIdentity(row))
      delete readDiscoveryPreparation(row)!.savedIdentity;
  }
  const source = readDiscoveryPreparation(job);
  const salary: unknown = source && Reflect.get(source, "bodySalaryRange");
  if (
    (typeof salary === "string" || salary === null) &&
    Reflect.get(job, "description") === Reflect.get(row, "description")
  ) {
    const preparation = {
      ...readDiscoveryPreparation(row),
      bodySalaryRange: salary,
    };
    writeDiscoveryPreparation(row, preparation);
  }
  return row;
}
/** Transitional legacy write validation preserves the new carried metadata. */
export function parseSavedJobWithPreparation(job: SavedJob): SavedJob {
  return copySavedJobPreparation(job, SavedJobSchema.parse(job));
}
export function parseSavedJobsWithPreparation(
  jobs: readonly SavedJob[],
): SavedJob[] {
  return jobs.map(parseSavedJobWithPreparation);
}
export function cloneSavedJobWithPreparation(job: SavedJob): SavedJob {
  return copySavedJobPreparation(job, structuredClone(job));
}

/** Joined with each canonical/list page, never fetched once per job. */
export const savedJobFingerprintSelectSql = `, (SELECT value FROM saved_job_discovery_fingerprints
  WHERE job_id = saved_jobs.id) AS discovery_fingerprints`;
export function attachStoredSavedJobFingerprints<T>(
  row: T,
  raw: unknown,
  freezeAfter = false,
): T {
  if (typeof raw === "string" && row !== null && typeof row === "object") {
    const { identity, matchAssessmentPostingFingerprint, ...value } =
      decodeFingerprints(raw);
    writeDiscoveryPreparation(row, {
      fingerprints: {
        ...(freezeAfter
          ? { owner: row }
          : { basis: capturedFingerprintBasis(row) }),
        value,
      },
      ...(matchAssessmentPostingFingerprint
        ? { matchAssessmentPostingFingerprint }
        : {}),
      ...(identity
        ? {
            savedIdentity: {
              ...(freezeAfter
                ? { owner: row }
                : { basis: captureDiscoverySavedIdentityBasis(row) }),
              value: identity,
            },
          }
        : {}),
    });
  }
  return row;
}
