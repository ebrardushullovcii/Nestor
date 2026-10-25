import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  SavedJobSchema,
  readPreparedDiscoveryFingerprints,
  writeDiscoveryPreparation,
  readPreparedSavedJobIdentity,
  readPreparedMatchAssessmentPostingFingerprint,
  readDiscoveryPreparation,
  type SavedJob,
  type SavedJobListFacts,
} from "@nestor/contracts";
import { parsePersistedRowValue } from "./state";
import { savedJobValueSql } from "./saved-job-storage";

const DETAIL_LIMIT = 16;
export const savedJobDetailFields = [
  "description",
  "summary",
  "keySkills",
  "responsibilities",
  "minimumQualifications",
  "preferredQualifications",
  "benefits",
  "sourceIntelligence",
  "screeningHints",
  "keywordSignals",
] as const satisfies readonly (keyof SavedJob)[];

/** Only lazy getter inputs: timestamps, verdicts and preparation do not own evidence. */
export function savedJobDetailKeySql(relational: boolean): string {
  const fields = savedJobDetailFields
    .filter((key) => key !== "description")
    .map(
      (key) => `json_type(value, '$.${key}'), json_extract(value, '$.${key}')`,
    );
  return `json_array(${relational ? "(SELECT stable_key FROM job_listing_texts WHERE id = saved_jobs.description_id)" : "json_extract(value, '$.description')"},
    ${fields.join(", ")}, json(${
      relational
        ? `(SELECT json_group_array(json_array((SELECT stable_key FROM job_listing_texts WHERE id = source.description_id), json_type(value, '$.listingFacts'), json_extract(value, '$.listingFacts')))
          FROM (SELECT description_id, value FROM job_provenance WHERE job_id = saved_jobs.id ORDER BY position) AS source)`
        : `(SELECT json_group_array(json_array(json_type(value, '$.listingFacts'), json_extract(value, '$.listingFacts'))) FROM json_each(saved_jobs.value, '$.provenance'))`
    }))`;
}

/**
 * Immutable projection versions keep their bodies in SQLite's temporary file,
 * not in the JS heap. A version remains readable after a write, reset or an
 * external commit. GC retires it only after its last borrowed row is released.
 * Ordinary canonical repository reads never use this store.
 */
export function createSavedJobDetails(database: DatabaseSync) {
  database.exec(`CREATE TEMP TABLE saved_job_details (
    version INTEGER PRIMARY KEY, id TEXT NOT NULL, value TEXT NOT NULL
  )`);
  const put = database.prepare(
    "INSERT INTO saved_job_details VALUES (?, ?, ?)",
  );
  let copyStored: StatementSync | null = null;
  const get = database.prepare(
    "SELECT id, value FROM saved_job_details WHERE version = ?",
  );
  const getDescription = database.prepare(`SELECT id,
    json_extract(value, '$.description') AS description
    FROM saved_job_details WHERE version = ?`);
  const remove = database.prepare(
    "DELETE FROM saved_job_details WHERE version IN (SELECT value FROM json_each(?))",
  );
  const cache = new Map<number, SavedJob>();
  const descriptions = new Map<number, string>();
  const retired: number[] = [];
  const registry = new FinalizationRegistry<number>((version) =>
    retired.push(version),
  );
  let nextVersion = 0;
  const latest = new Map<
    string,
    { key: string; anchor: WeakRef<{ version: number }> }
  >();

  function read(version: number): SavedJob {
    const cached = cache.get(version);
    if (cached) {
      cache.delete(version);
      cache.set(version, cached);
      return cached;
    }
    const row = get.get(version);
    if (!row) throw new Error("The saved-job projection has been closed.");
    const job = parsePersistedRowValue({
      tableName: "saved_jobs",
      rowId: String(row.id),
      rawValue: String(row.value),
      schema: SavedJobSchema,
    });
    freeze(job);
    cache.set(version, job);
    if (cache.size > DETAIL_LIMIT) cache.delete(cache.keys().next().value!);
    return job;
  }

  // Keep getter closures separate from `project`: they must never capture the
  // full parsed job or its raw text through that function's lexical context.
  function field(anchor: { version: number }, key: keyof SavedJob) {
    return key === "description"
      ? () => description(anchor.version)
      : () => read(anchor.version)[key];
  }
  function description(version: number): string {
    const full = cache.get(version);
    if (full) return full.description;
    const cached = descriptions.get(version);
    if (cached !== undefined) {
      descriptions.delete(version);
      descriptions.set(version, cached);
      return cached;
    }
    const row = getDescription.get(version);
    if (!row) throw new Error("The saved-job projection has been closed.");
    const value = row.description as string;
    descriptions.set(version, value);
    if (descriptions.size > DETAIL_LIMIT)
      descriptions.delete(descriptions.keys().next().value!);
    return value;
  }
  function facts(anchor: { version: number }, position: number) {
    return () => read(anchor.version).provenance[position]?.listingFacts;
  }

  function project(
    job: SavedJobListFacts | SavedJob,
    rawValue?: string,
    detailKey?: string,
  ): SavedJob {
    // A search can release thousands of versions in one GC. Reclaim a bounded
    // part per projected row, alongside the reader's existing paged yields.
    const released = retired.splice(-DETAIL_LIMIT);
    for (const version of released) {
      cache.delete(version);
      descriptions.delete(version);
    }
    if (released.length) remove.run(JSON.stringify(released));
    const key = createHash("sha256")
      .update(
        detailKey ??
          JSON.stringify([
            ...savedJobDetailFields.map((field) => [
              Object.hasOwn(job, field),
              Reflect.get(job, field) as unknown,
            ]),
            job.provenance.map((entry) => [
              Object.hasOwn(entry, "listingFacts"),
              Reflect.get(entry, "listingFacts") as unknown,
            ]),
          ]),
      )
      .digest("hex");
    const previous = latest.get(job.id);
    const shared = previous?.key === key ? previous.anchor.deref() : undefined;
    const anchor = shared ?? { version: ++nextVersion };
    const { version } = anchor;
    if (!shared && rawValue === undefined) {
      if (!copyStored) {
        const relational = database
          .prepare("PRAGMA table_info(saved_jobs)")
          .all()
          .some((column) => column.name === "assessment_id");
        copyStored = database.prepare(`INSERT INTO saved_job_details
        SELECT ?, id, ${relational ? savedJobValueSql() : "value"} FROM main.saved_jobs WHERE id = ?`);
      }
      copyStored.run(version, job.id);
    } else if (!shared) put.run(version, job.id, rawValue!);
    if (!shared) {
      latest.set(job.id, { key, anchor: new WeakRef(anchor) });
      registry.register(anchor, version);
    }
    // Every omitted field is a real validated, indexed SQLite read, never a
    // placeholder SavedJob. The compatibility view keeps existing read-only
    // consumers honest while its retained data is the explicit facts contract.
    const row = { ...job } as SavedJob;
    for (const key of savedJobDetailFields)
      Object.defineProperty(row, key, {
        enumerable: true,
        configurable: true,
        get: field(anchor, key),
      });
    row.provenance = job.provenance.map((entry, position) => {
      const sighting = { ...entry };
      Object.defineProperty(sighting, "listingFacts", {
        enumerable: true,
        configurable: true,
        get: facts(anchor, position),
      });
      return Object.freeze(sighting);
    });
    Object.freeze(row.provenance);
    const fingerprint = readPreparedDiscoveryFingerprints(job);
    const matchAssessmentPostingFingerprint =
      readPreparedMatchAssessmentPostingFingerprint(job);
    const bodySalaryRange = readDiscoveryPreparation(job)?.bodySalaryRange;
    if (fingerprint)
      writeDiscoveryPreparation(row, {
        fingerprints: { owner: row, value: fingerprint },
        ...(matchAssessmentPostingFingerprint
          ? { matchAssessmentPostingFingerprint }
          : {}),
        ...(bodySalaryRange !== undefined ? { bodySalaryRange } : {}),
      });
    const identity = readPreparedSavedJobIdentity(job);
    if (identity)
      writeDiscoveryPreparation(row, {
        savedIdentity: { owner: row, value: identity },
      });
    Object.freeze(row);
    return row;
  }
  return { project };
}

function freeze(value: unknown): void {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
