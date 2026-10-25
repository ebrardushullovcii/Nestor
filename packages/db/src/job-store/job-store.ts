import {
  JobListQuerySchema,
  type FoundJob,
  type JobChange,
  type JobDetail,
  type JobFitUpdate,
  type JobListPage,
  type JobListQueryInput,
  type JobSelection,
  type JobStage,
  type JobStageCounts,
  type MoveJobsResult,
  type SaveFoundJobsResult,
  type TriageStage,
} from "@nestor/contracts";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { readListingStage, writeFoundJobs } from "./found-jobs";
import { getJob, listJobs, readStageCounts } from "./job-list";
import {
  CHANGE_ID_LIMIT,
  writeMove,
  writeStage,
  writeUndo,
  type MoveOutcome,
} from "./job-moves";
import { JOB_STORE_SCHEMA, JOB_STORE_VERSION } from "./schema";
import { createSearches, type JobSearches } from "./searches";
import { createStatements, type Statements } from "./statements";

export interface JobStore {
  /** For tables that live beside `jobs`; see `schema.ts`. */
  readonly db: DatabaseSync;
  /** Cached prepared statements over `db`. */
  readonly sql: Statements;
  /** Runs `write` in one immediate transaction; nested calls join it. */
  transaction<T>(write: () => T): T;
  /** Called after each committed write. Returns the unsubscribe. */
  onChange(listener: (change: JobChange) => void): () => void;
  /** Tells listeners about a write made through `db` directly. */
  notify(change: JobChange): void;

  /** Saves what a search found: new jobs start in `found`, others merge. */
  saveFoundJobs(input: {
    searchId: string | null;
    jobs: readonly FoundJob[];
  }): SaveFoundJobsResult;
  setFit(updates: readonly JobFitUpdate[]): void;
  /** Saved jobs still waiting for a fit score, newest first. */
  unscoredJobIds(limit: number): number[];
  readonly searches: JobSearches;

  listJobs(query: JobListQueryInput): JobListPage;
  getJob(id: number): JobDetail | null;
  /** The stage of a saved job with this listing link, so a search can skip it. */
  stageForListing(url: string): JobStage | null;
  stageCounts(): JobStageCounts;

  /** Triage: moves jobs between found, hidden and shortlisted, with Undo. */
  moveJobs(input: { selection: JobSelection; to: TriageStage }): MoveJobsResult;
  undoMove(moveId: number): MoveJobsResult;
  /** For the flows that own later stages; no Undo record. */
  setStage(ids: readonly number[], to: JobStage): number;

  close(): void;
}

function openDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -32768;
    PRAGMA mmap_size = 268435456;
  `);
  return db;
}

function readVersion(db: DatabaseSync): { version: number; empty: boolean } {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  const { n } = db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as {
    n: number;
  };
  return { version, empty: n === 0 };
}

/**
 * Opens the store at `filePath` (or `":memory:"`), creating what is missing.
 * A file written by another store version is deleted and started over.
 */
export function openJobStore(filePath: string): JobStore {
  const inMemory = filePath === ":memory:";
  if (!inMemory) mkdirSync(path.dirname(filePath), { recursive: true });
  let db = openDatabase(filePath);
  const found = readVersion(db);
  if (!found.empty && found.version !== JOB_STORE_VERSION && !inMemory) {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${filePath}${suffix}`, { force: true });
    }
    db = openDatabase(filePath);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const ddl of JOB_STORE_SCHEMA) db.exec(ddl);
    db.exec(`PRAGMA user_version = ${JOB_STORE_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  if (!inMemory && process.platform !== "win32") {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        chmodSync(`${filePath}${suffix}`, 0o600);
      } catch {
        // The -wal and -shm files appear on first write.
      }
    }
  }

  const sql = createStatements(db);
  const listeners = new Set<(change: JobChange) => void>();
  let depth = 0;
  let pending: JobChange[] = [];

  const notify = (change: JobChange) => {
    if (change.stages.length === 0) return;
    if (depth > 0) {
      pending.push(change);
      return;
    }
    for (const listener of listeners) listener(change);
  };

  const transaction = <T>(write: () => T): T => {
    if (depth > 0) return write();
    db.exec("BEGIN IMMEDIATE");
    depth = 1;
    let result: T;
    try {
      result = write();
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      pending = [];
      throw error;
    } finally {
      depth = 0;
    }
    const changes = pending;
    pending = [];
    for (const change of changes) notify(change);
    return result;
  };

  const moveResult = (
    outcome: MoveOutcome,
    cause: "move" | "undo",
  ): MoveJobsResult => {
    notify({ cause, stages: outcome.stages, ids: outcome.ids, searchId: null });
    return {
      moveId: cause === "move" ? outcome.moveId : null,
      moved: outcome.moved,
      counts: readStageCounts(sql),
    };
  };

  return {
    db,
    sql,
    transaction,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify,

    saveFoundJobs({ searchId, jobs }) {
      if (jobs.length === 0) return { added: [], hidden: [], merged: [] };
      return transaction(() => {
        const { added, hidden, merged, mergedStages } = writeFoundJobs(
          sql,
          searchId,
          jobs,
          Date.now(),
        );
        const stages = new Set(mergedStages);
        if (added.length > 0) stages.add("found");
        if (hidden.length > 0) stages.add("hidden");
        const ids = [...added, ...hidden, ...merged];
        notify({
          cause: "found",
          stages: [...stages],
          ids: ids.length > CHANGE_ID_LIMIT ? null : ids,
          searchId,
        });
        return { added, hidden, merged };
      });
    },

    setFit(updates) {
      if (updates.length === 0) return;
      transaction(() => {
        const now = new Date().toISOString();
        const stageOf = sql("SELECT stage FROM jobs WHERE id = ?");
        const setRow = sql(
          "UPDATE jobs SET fit_score = ?, fit_summary = ? WHERE id = ?",
        );
        const setDetail = sql(
          "UPDATE job_details SET fit_json = ? WHERE job_id = ?",
        );
        const stages = new Set<JobStage>();
        const ids: number[] = [];
        for (const { id, scoredAt, ...fit } of updates) {
          const row = stageOf.get(id) as { stage: JobStage } | undefined;
          if (!row) continue;
          setRow.run(fit.score, fit.summary || null, id);
          setDetail.run(
            JSON.stringify({ ...fit, scoredAt: scoredAt ?? now }),
            id,
          );
          stages.add(row.stage);
          ids.push(id);
        }
        notify({
          cause: "fit",
          stages: [...stages],
          ids: ids.length > CHANGE_ID_LIMIT ? null : ids,
          searchId: null,
        });
      });
    },

    unscoredJobIds: (limit) =>
      (
        sql(
          `SELECT id FROM jobs WHERE stage IN ('found', 'shortlisted') AND fit_score = -1
           ORDER BY found_at DESC LIMIT ?`,
        ).all(limit) as { id: number }[]
      ).map((row) => row.id),
    searches: createSearches(sql),

    listJobs: (query) => listJobs(sql, JobListQuerySchema.parse(query)),
    getJob: (id) => getJob(sql, id),
    stageForListing: (url) => readListingStage(sql, url),
    stageCounts: () => readStageCounts(sql),

    moveJobs({ selection, to }) {
      return transaction(() =>
        moveResult(writeMove(sql, selection, to, Date.now()), "move"),
      );
    },
    undoMove(moveId) {
      return transaction(() => moveResult(writeUndo(sql, moveId), "undo"));
    },
    setStage(ids, to) {
      if (ids.length === 0) return 0;
      return transaction(() => {
        const outcome = writeStage(sql, ids, to, Date.now());
        notify({
          cause: "stage",
          stages: outcome.stages,
          ids: outcome.ids,
          searchId: null,
        });
        return outcome.moved;
      });
    },

    close() {
      listeners.clear();
      if (db.isOpen) db.close();
    },
  };
}
export type { JobSearches } from "./searches";
