import {
  savedJobFingerprintSelectSql,
  attachStoredSavedJobFingerprints,
  ensureSavedJobFingerprintStorage,
} from "./saved-job-fingerprints";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { yieldToEventLoop } from "@nestor/core";
import {
  savedJobSalarySelectSql,
  attachStoredSavedJobSalary,
  savedJobValueSql,
} from "./saved-job-storage";
import {
  SavedJobSchema,
  type SavedJobListFacts,
  type SavedJob,
} from "@nestor/contracts";
import { listCollectionValues, parsePersistedRowJson } from "./state";
import {
  createSavedJobDetails,
  savedJobDetailFields,
} from "./saved-job-details";

/** Keep each SQLite read bounded even for unusually large old rows. */
const PROJECTION_PAGE_ROWS = 12;
const PROJECTION_SLICE_MS = 8;

type ProjectionChanges = {
  before: readonly SavedJob[];
  rows: readonly SavedJob[];
  removedIds: readonly string[];
};
const projectionChanges = new WeakMap<readonly SavedJob[], ProjectionChanges>();

/** Only the latest adjacent committed display versions have a change hint. */
export function readSavedJobProjectionChanges(
  before: readonly SavedJob[],
  after: readonly SavedJob[],
): ProjectionChanges | null {
  const changes = projectionChanges.get(after);
  return changes?.before === before ? changes : null;
}

/** Borrowed projection values cannot become an accidental repository write. */
export function freezeProjection<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeProjection(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Each sighting keeps the listing as its source read it, which is nearly
 * always the job's own description, and most plan verdicts equal the shared
 * one. Parsed row by row these are separate copies; on 6,284 saved jobs the
 * duplicates were about a seventh of the main process's memory. A projection
 * row is frozen once this returns, so equal values can be one value.
 */
function shareRepeatedValues(job: SavedJob, share: ShareValue): SavedJob {
  for (const sighting of job.provenance) {
    const facts = sighting.listingFacts;
    if (!facts) continue;
    if (facts.description === job.description) {
      facts.description = job.description;
    }
    if (facts.summary !== null && facts.summary === job.summary) {
      facts.summary = job.summary;
    }
  }
  job.sourceIntelligence = share(job.sourceIntelligence);
  job.screeningHints = share(job.screeningHints);
  return shareListValues(job, share);
}

function shareListValues<
  T extends Pick<
    SavedJobListFacts,
    "planAssessments" | "matchAssessment" | "normalizedCompensation"
  >,
>(job: T, share: ShareValue): T {
  const plans = job.planAssessments;
  if (plans) {
    const shared = JSON.stringify(job.matchAssessment);
    for (const [planId, assessment] of Object.entries(plans)) {
      if (JSON.stringify(assessment) === shared) {
        plans[planId] = job.matchAssessment;
      }
    }
  }
  // Values many jobs hold alike: what a source is known for (84 distinct
  // among 6,284 jobs), pay and screening hints, and the parts of a verdict
  // most rule scores share. One frozen copy serves every job holding it.
  job.normalizedCompensation = share(job.normalizedCompensation);
  // A plan's own verdict rarely repeats its dimensions elsewhere, so only
  // the shared verdict's are worth looking up.
  job.matchAssessment.dimensions = share(job.matchAssessment.dimensions);
  for (const assessment of new Set([
    job.matchAssessment,
    ...Object.values(plans ?? {}),
  ])) {
    if (assessment)
      assessment.compensationFit = share(assessment.compensationFit);
  }
  return job;
}

type ShareValue = <T>(value: T) => T;

/** Distinct values kept for sharing before the table starts over. */
const SHARED_VALUE_LIMIT = 20_000;

function createValueSharing(): ShareValue {
  const values = new Map<string, unknown>();
  return <T>(value: T): T => {
    if (value === null || typeof value !== "object") return value;
    const key = JSON.stringify(value);
    const existing = values.get(key);
    if (existing !== undefined) return existing as T;
    if (values.size >= SHARED_VALUE_LIMIT) values.clear();
    values.set(key, freezeProjection(value));
    return value;
  };
}

function toProjectionRow(
  job: SavedJob,
  share: ShareValue,
  previous?: SavedJob,
): SavedJob {
  shareRepeatedValues(job, share);
  // A timestamp/status change does not need another retained copy of the
  // listing body, sightings or verdict evidence. Schema parsing owns `job`.
  if (previous) shareUnchangedFields(job, previous);
  return freezeProjection(job);
}

function shareUnchangedFields<T extends object>(next: T, previous: T): void {
  for (const key of Object.keys(next) as Array<keyof T>)
    if (
      !Object.getOwnPropertyDescriptor(previous, key)?.get &&
      isDeepStrictEqual(next[key], previous[key])
    )
      next[key] = previous[key];
}

/**
 * Only display projections borrow these validated, immutable rows. Ordinary
 * reads remain caller-owned. Temporary triggers track every write path, including
 * transactional reset/import; rollbacks also roll back their change markers.
 * A different connection's commit invalidates the cache through data_version.
 */
export function createSavedJobProjectionReader(
  database: DatabaseSync,
  options: {
    sqliteDetails?: boolean;
  } = {},
) {
  ensureSavedJobFingerprintStorage(database);
  const details = options.sqliteDetails
    ? createSavedJobDetails(database)
    : null;
  const pageRows = PROJECTION_PAGE_ROWS;
  database.exec(`
    CREATE TEMP TABLE saved_job_projection_epoch (revision INTEGER NOT NULL);
    INSERT INTO saved_job_projection_epoch VALUES (0);
    CREATE TEMP TABLE saved_job_projection_changes (
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL
    );
    ${["INSERT", "UPDATE", "DELETE"]
      .map((event) => {
        const row = event === "DELETE" ? "OLD" : "NEW";
        return `CREATE TEMP TRIGGER saved_job_projection_${event.toLowerCase()}
          AFTER ${event} ON main.saved_jobs BEGIN
            UPDATE saved_job_projection_epoch SET revision = revision + 1;
            UPDATE saved_job_projection_changes
              SET revision = (SELECT revision FROM saved_job_projection_epoch)
              WHERE id = ${row}.id;
            INSERT INTO saved_job_projection_changes
              SELECT ${row}.id, revision FROM saved_job_projection_epoch
              WHERE NOT EXISTS (
                SELECT 1 FROM saved_job_projection_changes WHERE id = ${row}.id
              );
          END;`;
      })
      .join("\n")}
  `);
  const share = createValueSharing();
  let jobsById = new Map<string, SavedJob>();
  let snapshot: readonly SavedJob[] | null = null;
  let hintedSnapshot: readonly SavedJob[] | null = null;
  let externalVersion: number | null = null;
  let pending: Promise<readonly SavedJob[]> | null = null;
  let pendingVersion: number | null = null;
  let pendingRevision: number | null = null;
  const readVersion = database.prepare("PRAGMA data_version");
  const readRevision = database.prepare(
    "SELECT revision FROM saved_job_projection_epoch",
  );
  const readChanges = database.prepare(
    "SELECT id FROM saved_job_projection_changes",
  );

  const relational = database
    .prepare("PRAGMA table_info(saved_jobs)")
    .all()
    .some((column) => column.name === "assessment_id");
  if (relational)
    for (const table of [
      "job_plan_assessments",
      "saved_job_discovery_fingerprints",
    ])
      for (const operation of ["insert", "update", "delete"] as const) {
        const ref = operation === "delete" ? "OLD" : "NEW";
        database.exec(`CREATE TEMP TRIGGER saved_job_projection_${table}_${operation}
      AFTER ${operation.toUpperCase()} ON main.${table} BEGIN
        UPDATE saved_job_projection_epoch SET revision = revision + 1;
        INSERT INTO saved_job_projection_changes(id,revision) SELECT ${ref}.job_id,revision FROM saved_job_projection_epoch
          WHERE 1 ON CONFLICT(id) DO UPDATE SET revision = excluded.revision;
      END`);
      }
  const preparationSql =
    savedJobFingerprintSelectSql +
    (relational
      ? savedJobSalarySelectSql
      : ", NULL AS body_salary_prepared, NULL AS body_salary_range");
  const readPage = database.prepare(
    `SELECT id, ${
      relational ? savedJobValueSql() : "value"
    } AS value${preparationSql} FROM saved_jobs
      WHERE id > ? ORDER BY id LIMIT ?`,
  );
  // SQLite strips evidence before it crosses into the JS heap. In addition
  // to avoiding a large parse, retained strings cannot keep a full raw row's
  // backing string alive through an implementation-specific substring view.
  const withoutDetails = `jsonb_remove(saved_jobs.value,
    ${savedJobDetailFields.map((key) => `'$.${key}'`).join(", ")})`;
  // Materialize only this page, parsing each large row into SQLite JSONB
  // once for the repeated field and array operations. The full evidence
  // still never enters JS.
  const factsQuery = (selection: string) => `
    WITH saved_job_list_source AS MATERIALIZED (
      SELECT id, CASE WHEN json_valid(value) THEN jsonb(${
        relational ? savedJobValueSql("saved_jobs", false, false) : "value"
      }) ELSE value END AS value${preparationSql}
      FROM saved_jobs ${selection}
    ) SELECT id, discovery_fingerprints, body_salary_prepared, body_salary_range,
    CASE WHEN typeof(saved_jobs.value) = 'blob' THEN json(
      CASE WHEN json_type(saved_jobs.value, '$.provenance') = 'array'
        AND NOT EXISTS (SELECT 1 FROM json_each(saved_jobs.value, '$.provenance') WHERE type != 'object')
      THEN jsonb_set(${withoutDetails}, '$.provenance', jsonb((
        SELECT json_group_array(json(json_remove(sighting.value, '$.listingFacts')))
        FROM json_each(saved_jobs.value, '$.provenance') AS sighting
      ))) ELSE ${withoutDetails} END
    ) ELSE saved_jobs.value END AS list_value
    FROM saved_job_list_source AS saved_jobs ORDER BY id`;
  const readFactsPage = details
    ? database.prepare(factsQuery("WHERE id > ? ORDER BY id LIMIT ?"))
    : null;

  function readListFacts(
    row: Record<string, SQLOutputValue>,
  ): SavedJobListFacts {
    const input = {
      tableName: "saved_jobs",
      rowId: String(row.id),
      rawValue: String(row.list_value),
    };
    const facts = attachStoredSavedJobFingerprints(
      parsePersistedRowJson(input) as SavedJobListFacts,
      row.discovery_fingerprints,
      true,
    );
    attachStoredSavedJobSalary(
      facts,
      row.body_salary_prepared,
      row.body_salary_range,
    );
    return freezeProjection(shareListValues(facts, share));
  }
  const readChangedFacts = details
    ? database.prepare(
        factsQuery("WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id"),
      )
    : null;

  /**
   * Every saved job, a page at a time with a turn of the event loop between
   * pages. Reading them in one statement held main for about a second with
   * 20,000 saved jobs (420 MB of rows), and kept every row's text alive until
   * the last was parsed. A write landing between pages is caught by the
   * change markers, which this read leaves for the next one.
   */
  async function readAllRowsInPages(): Promise<Map<string, SavedJob>> {
    const jobs = new Map<string, SavedJob>();
    let after = "";
    let sliceStarted = performance.now();
    for (;;) {
      const rows = (readFactsPage ?? readPage).all(after, pageRows);
      for (const row of rows) {
        const job = details
          ? details.project(readListFacts(row))
          : toProjectionRow(
              attachStoredSavedJobSalary(
                attachStoredSavedJobFingerprints(
                  parsePersistedRowJson({
                    tableName: "saved_jobs",
                    rowId: String(row.id),
                    rawValue: String(row.value),
                  }) as SavedJob,
                  row.discovery_fingerprints,
                  true,
                ),
                row.body_salary_prepared,
                row.body_salary_range,
              ),
              share,
            );
        jobs.set(job.id, job);
        if (performance.now() - sliceStarted >= PROJECTION_SLICE_MS) {
          await yieldToEventLoop();
          sliceStarted = performance.now();
        }
      }
      if (rows.length < pageRows) return jobs;
      after = String(rows.at(-1)!.id);
    }
  }

  async function read(): Promise<readonly SavedJob[]> {
    const before = snapshot;
    const version = Number(readVersion.get()?.data_version);
    const incremental = before !== null && version === externalVersion;
    const revision = Number(readRevision.get()?.revision);
    const changes = readChanges.all();
    if (
      snapshot !== null &&
      version === externalVersion &&
      changes.length === 0
    )
      return snapshot;

    if (snapshot === null || version !== externalVersion) {
      jobsById = await readAllRowsInPages();
    } else {
      // Changed rows a page at a time, like a full read: a search that just
      // rewrote thousands of jobs held main for seconds when they were all
      // parsed in one go. The rows are only published once all are read; a
      // write landing between pages keeps its marker for the next read.
      const ids = changes.map((row) => String(row.id));
      const next = ids.length > pageRows ? new Map(jobsById) : jobsById;
      let sliceStarted = performance.now();
      for (let start = 0; start < ids.length; start += pageRows) {
        if (performance.now() - sliceStarted >= PROJECTION_SLICE_MS) {
          await yieldToEventLoop();
          sliceStarted = performance.now();
        }
        const pageIds = ids.slice(start, start + pageRows);
        if (details && readChangedFacts) {
          const found = new Set<string>();
          for (const row of readChangedFacts.all(JSON.stringify(pageIds))) {
            const facts = readListFacts(row);
            found.add(facts.id);
            next.set(facts.id, details.project(facts));
          }
          for (const id of pageIds) if (!found.has(id)) next.delete(id);
          continue;
        }
        const rows = listCollectionValues(
          database,
          "saved_jobs",
          SavedJobSchema,
          {
            whereSql: "id IN (SELECT value FROM json_each(?))",
            params: [JSON.stringify(pageIds)],
            orderBySql: "id",
          },
        );
        const returnedIds = new Set(rows.map((job) => job.id));
        for (const id of pageIds) if (!returnedIds.has(id)) next.delete(id);
        for (const job of rows) {
          const projected = toProjectionRow(job, share, next.get(job.id));
          next.set(
            job.id,
            details
              ? details.project(projected, JSON.stringify(job))
              : projected,
          );
        }
      }
      jobsById = next;
    }
    externalVersion = version;
    // A write arriving during chunked parsing belongs to the next projection.
    if (Number(readRevision.get()?.revision) === revision) {
      // No local write arrived during the paged read. Consume all markers
      // with SQLite's bulk clear instead of deleting each index entry.
      database.exec("DELETE FROM saved_job_projection_changes");
    } else {
      database
        .prepare("DELETE FROM saved_job_projection_changes WHERE revision <= ?")
        .run(revision);
    }
    snapshot = Object.freeze(
      [...jobsById.values()].sort((left, right) =>
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
      ),
    );
    // Drop the previous hint first: chaining `before` references through a
    // WeakMap would otherwise retain every historical version of the list.
    if (hintedSnapshot) projectionChanges.delete(hintedSnapshot);
    hintedSnapshot = null;
    if (before && incremental) {
      const ids = changes.map((row) => String(row.id));
      projectionChanges.set(snapshot, {
        before,
        rows: ids.flatMap((id) => {
          const job = jobsById.get(id);
          return job ? [job] : [];
        }),
        removedIds: ids.filter((id) => !jobsById.has(id)),
      });
      hintedSnapshot = snapshot;
    }
    return snapshot;
  }

  function readProjection(): Promise<readonly SavedJob[]> {
    // Transaction reads see their own writes, but neither the cached map nor
    // its change markers may consume them: a rollback can reuse the epoch.
    // Capture this rare read synchronously so it cannot outlive the transaction.
    if (database.isTransaction) {
      return Promise.resolve(
        freezeProjection(
          listCollectionValues(database, "saved_jobs", SavedJobSchema, {
            orderBySql: "id",
          }),
        ),
      );
    }
    const version = Number(readVersion.get()?.data_version);
    const revision = Number(readRevision.get()?.revision);
    if (pending) {
      // A mutation response must see its own commit even if a cold display
      // read was already parsing older rows when the mutation completed.
      return version === pendingVersion && revision === pendingRevision
        ? pending
        : pending.then(() => readProjection());
    }
    pendingVersion = version;
    pendingRevision = revision;
    pending = read().finally(() => {
      pending = null;
    });
    return pending;
  }

  const hasChanges = database.prepare(
    "SELECT EXISTS (SELECT 1 FROM saved_job_projection_changes) AS changed",
  );
  const idsBySnapshot = new WeakMap<readonly SavedJob[], readonly string[]>();
  /**
   * Every saved job's id, in id order, when the cached rows are current;
   * otherwise null and the caller asks the table. Each workspace refresh
   * listed every id from the table (20 ms with 20,000 jobs) to reconcile plans.
   */
  function currentIds(): readonly string[] | null {
    if (database.isTransaction || pending || snapshot === null) return null;
    if (Number(readVersion.get()?.data_version) !== externalVersion)
      return null;
    if (Number(hasChanges.get()?.changed) !== 0) return null;
    let ids = idsBySnapshot.get(snapshot);
    if (!ids) {
      ids = Object.freeze(snapshot.map((job) => job.id));
      idsBySnapshot.set(snapshot, ids);
    }
    return ids;
  }
  return Object.assign(readProjection, {
    currentIds,
  });
}
