import type { DatabaseSync } from "node:sqlite";
import {
  SavedJobSchema,
  DISCOVERY_FINGERPRINT_FIELDS,
  readPreparedDiscoveryFingerprints,
  readPreparedSavedJobIdentity,
  captureDiscoverySavedIdentityBasis,
  writeDiscoveryPreparation,
  type DiscoveryListingFingerprints,
  type DiscoverySavedJobFingerprints,
  type SavedJob,
} from "@nestor/contracts";

export function ensureSavedJobFingerprintStorage(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS saved_job_discovery_fingerprints (
    job_id TEXT PRIMARY KEY REFERENCES saved_jobs(id) ON DELETE CASCADE,
    value TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS saved_job_preparation_update AFTER UPDATE OF value ON saved_jobs
    WHEN OLD.value IS NOT NEW.value BEGIN
    DELETE FROM saved_job_discovery_fingerprints WHERE job_id = OLD.id;
  END;
  CREATE TRIGGER IF NOT EXISTS saved_job_preparation_delete AFTER DELETE ON saved_jobs BEGIN
    DELETE FROM saved_job_discovery_fingerprints WHERE job_id = OLD.id;
  END;`);
}

type StoredFingerprints = DiscoveryListingFingerprints & {
  identity?: Omit<
    NonNullable<DiscoverySavedJobFingerprints["identity"]>,
    "content"
  > & {
    content: { digest: string; packed: string } | null;
  };
};

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
export function writeSavedJobFingerprints(
  db: DatabaseSync,
  job: SavedJob,
): void {
  if (!db.isTransaction)
    throw new Error("Saved-job fingerprints require the job transaction.");
  const value = readSavedJobPreparedValue(job);
  if (!value) {
    db.prepare(
      "DELETE FROM saved_job_discovery_fingerprints WHERE job_id = ?",
    ).run(job.id);
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
  db.prepare(
    `INSERT INTO saved_job_discovery_fingerprints(job_id, value) VALUES (?, ?)
    ON CONFLICT(job_id) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value`,
  ).run(job.id, JSON.stringify(stored));
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
  const identity = readPreparedSavedJobIdentity(job);
  if (identity) {
    writeDiscoveryPreparation(row, {
      savedIdentity: {
        basis: captureDiscoverySavedIdentityBasis(job),
        value: structuredClone(identity),
      },
    });
    if (!readPreparedSavedJobIdentity(row))
      writeDiscoveryPreparation(row, { savedIdentity: undefined });
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
  const identity = readPreparedSavedJobIdentity(job);
  if (identity)
    writeDiscoveryPreparation(row, {
      savedIdentity: {
        basis: captureDiscoverySavedIdentityBasis(row),
        value: structuredClone(identity),
      },
    });
  return row;
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
    const { identity, ...value } = decodeFingerprints(raw);
    writeDiscoveryPreparation(row, {
      fingerprints: {
        ...(freezeAfter
          ? { owner: row }
          : { basis: capturedFingerprintBasis(row) }),
        value,
      },
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
