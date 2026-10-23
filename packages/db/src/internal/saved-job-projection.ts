import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import {
  createRowValidationMarks,
  type ParseMarkedRow,
  type RowValidationStamp,
} from "./row-validation-marks";
import { listCollectionValues, parsePersistedRowValue } from "./state";

/** Saved jobs parsed per turn of the event loop on a full projection read. */
const PROJECTION_PAGE_ROWS = 200;

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
  job.sourceIntelligence = share(job.sourceIntelligence);
  job.screeningHints = share(job.screeningHints);
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
    if (isDeepStrictEqual(next[key], previous[key])) next[key] = previous[key];
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
    /** Who validates rows; rows it already marked skip the schema. */
    validationStamp?: RowValidationStamp;
  } = {},
) {
  const marks = createRowValidationMarks(
    database,
    "saved_jobs",
    options.validationStamp,
  );
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

  const readPage = database.prepare(
    `SELECT ${marks?.selectSql ?? "id, value FROM saved_jobs"}
      WHERE id > ? ORDER BY id LIMIT ?`,
  );

  /**
   * Every saved job, a page at a time with a turn of the event loop between
   * pages. Reading them in one statement held main for about a second with
   * 20,000 saved jobs (420 MB of rows), and kept every row's text alive until
   * the last was parsed. A write landing between pages is caught by the
   * change markers, which this read leaves for the next one.
   */
  async function readAllRowsInPages(): Promise<Map<string, SavedJob>> {
    // Starts reading in this turn when the stamp is known (or absent).
    if (marks && marks.current() === null) await marks.settled();
    const jobs = new Map<string, SavedJob>();
    let after = "";
    const readPageOfJobs = (parse: ParseMarkedRow | null) => {
      const rows = readPage.all(after, PROJECTION_PAGE_ROWS);
      for (const row of rows) {
        const job = toProjectionRow(
          parse
            ? parse(row, SavedJobSchema)
            : parsePersistedRowValue({
                tableName: "saved_jobs",
                rowId: String(row.id),
                rawValue: String(row.value),
                schema: SavedJobSchema,
              }),
          share,
        );
        jobs.set(job.id, job);
      }
      return rows;
    };
    for (;;) {
      const rows = marks ? marks.read(readPageOfJobs) : readPageOfJobs(null);
      if (rows.length < PROJECTION_PAGE_ROWS) return jobs;
      after = String(rows[rows.length - 1]!.id);
      await new Promise<void>((resolve) => setImmediate(resolve));
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
      const next =
        ids.length > PROJECTION_PAGE_ROWS ? new Map(jobsById) : jobsById;
      for (let start = 0; start < ids.length; start += PROJECTION_PAGE_ROWS) {
        if (start > 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
        const pageIds = ids.slice(start, start + PROJECTION_PAGE_ROWS);
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
        for (const job of rows)
          next.set(job.id, toProjectionRow(job, share, next.get(job.id)));
      }
      jobsById = next;
    }
    externalVersion = version;
    // A write arriving during chunked parsing belongs to the next projection.
    database
      .prepare("DELETE FROM saved_job_projection_changes WHERE revision <= ?")
      .run(revision);
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
  return Object.assign(readProjection, { currentIds });
}
