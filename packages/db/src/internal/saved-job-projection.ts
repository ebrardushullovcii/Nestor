import type { DatabaseSync } from "node:sqlite";
import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { listCollectionValues, listValuesInChunks } from "./state";

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
function shareRepeatedValues(job: SavedJob): SavedJob {
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
  return job;
}

function toProjectionRow(job: SavedJob): SavedJob {
  return freezeProjection(shareRepeatedValues(job));
}

/**
 * Only display projections borrow these validated, immutable rows. Ordinary
 * reads remain caller-owned. Temporary triggers track every write path, including
 * transactional reset/import; rollbacks also roll back their change markers.
 * A different connection's commit invalidates the cache through data_version.
 */
export function createSavedJobProjectionReader(database: DatabaseSync) {
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
  let jobsById = new Map<string, SavedJob>();
  let snapshot: readonly SavedJob[] | null = null;
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

  async function read(): Promise<readonly SavedJob[]> {
    const version = Number(readVersion.get()?.data_version);
    const revision = Number(readRevision.get()?.revision);
    const changes = readChanges.all();
    if (
      snapshot !== null &&
      version === externalVersion &&
      changes.length === 0
    )
      return snapshot;

    if (snapshot === null || version !== externalVersion) {
      // The read captures all rows before yielding to parse them in chunks.
      const rows = await listValuesInChunks(
        database,
        "saved_jobs",
        SavedJobSchema,
      );
      jobsById = new Map(rows.map((job) => [job.id, toProjectionRow(job)]));
    } else {
      const ids = changes.map((row) => String(row.id));
      const rows = listCollectionValues(
        database,
        "saved_jobs",
        SavedJobSchema,
        {
          whereSql: "id IN (SELECT value FROM json_each(?))",
          params: [JSON.stringify(ids)],
          orderBySql: "id",
        },
      );
      for (const id of ids) jobsById.delete(id);
      for (const job of rows) jobsById.set(job.id, toProjectionRow(job));
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
  return readProjection;
}
