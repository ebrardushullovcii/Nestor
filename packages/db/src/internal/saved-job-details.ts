import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  SavedJobSchema,
  JobPostingSchema,
  type SavedJob,
  type SavedJobListFacts,
} from "@nestor/contracts";
import {
  parsePersistedRowJson,
  parsePersistedRowValue,
  validatePersistedRowValue,
} from "./state";

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

/**
 * Immutable projection versions keep their bodies in SQLite's temporary file,
 * not in the JS heap. A version remains readable after a write, reset or an
 * external commit. GC retires it only after its last borrowed row is released.
 * Ordinary canonical repository reads never use this store.
 */
export function createSavedJobDetails(
  database: DatabaseSync,
  validationStamp?: () => string | null,
) {
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
  let getMarked: StatementSync | null = null;
  const getDescription = database.prepare(`SELECT id,
    json_extract(value, '$.description') AS description
    FROM saved_job_details WHERE version = ?`);
  const remove = database.prepare(
    "DELETE FROM saved_job_details WHERE version = ?",
  );
  const cache = new Map<number, SavedJob>();
  const descriptions = new Map<number, string>();
  const retired: number[] = [];
  const registry = new FinalizationRegistry<number>((version) =>
    retired.push(version),
  );
  let nextVersion = 0;

  function read(version: number): SavedJob {
    const cached = cache.get(version);
    if (cached) {
      cache.delete(version);
      cache.set(version, cached);
      return cached;
    }
    const stamp = validationStamp?.();
    const row = stamp
      ? (getMarked ??= database.prepare(`SELECT details.id, details.value,
          CASE WHEN current.value = details.value THEN validation.validated_stamp END AS validated_stamp
          FROM saved_job_details AS details
          LEFT JOIN main.saved_jobs AS current ON current.id = details.id
          LEFT JOIN main.row_validations AS validation
            ON validation.validated_table = 'saved_jobs' AND validation.validated_row_id = current.id
          WHERE details.version = ?`)).get(version)
      : get.get(version);
    if (!row) throw new Error("The saved-job projection has been closed.");
    const stored = {
      tableName: "saved_jobs",
      rowId: String(row.id),
      rawValue: String(row.value),
    };
    // A validation mark covers this TEMP version only while the current
    // canonical text is byte-identical. Historical versions still validate
    // after a write, reset or external commit (ADRs 0054/0057).
    const job =
      stamp && row.validated_stamp === stamp
        ? (parsePersistedRowJson(stored) as SavedJob)
        : parsePersistedRowValue({ ...stored, schema: SavedJobSchema });
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
    const value = validatePersistedRowValue({
      tableName: "saved_jobs",
      rowId: String(row.id),
      value: row.description,
      schema: JobPostingSchema.shape.description,
    });
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
  ): SavedJob {
    for (const version of retired.splice(0)) {
      cache.delete(version);
      descriptions.delete(version);
      remove.run(version);
    }
    const version = ++nextVersion;
    const anchor = { version };
    if (rawValue === undefined) {
      copyStored ??= database.prepare(`INSERT INTO saved_job_details
        SELECT ?, id, value FROM main.saved_jobs WHERE id = ?`);
      copyStored.run(version, job.id);
    } else put.run(version, job.id, rawValue);
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
    Object.freeze(row);
    registry.register(anchor, version);
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
