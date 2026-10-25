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
  type SeenListingCard,
  type TriageStage,
} from "@nestor/contracts";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { normalizeUrl, writeFoundJobs } from "./found-jobs";
import { getJob, listJobs, readStageCounts } from "./job-list";
import {
  CHANGE_ID_LIMIT,
  writeMove,
  writeStage,
  writeUndo,
  type MoveOutcome,
} from "./job-moves";
import {
  JOB_STORE_ADDED_COLUMNS,
  JOB_STORE_KEPT_FROM_VERSION,
  JOB_STORE_SCHEMA,
  type AddedColumn,
} from "./schema";
import { createSearches, type JobSearches } from "./searches";
import { createStatements, type Statements } from "./statements";
import { lookupSeenCards, rememberSeenCards } from "./seen-cards";

export { createProfileStore, type ProfileStore } from "./profile-store";
export {
  createPreferencesStore,
  type PreferencesStore,
} from "./preferences-store";
export { createJobSitesStore, type JobSitesStore } from "./job-sites";
export { createSourceAccessStore } from "./source-access";
export { createSearchSourcesStore } from "./search-sources";
export { createTrackerStore, type TrackerStore } from "./tracker";
export { createHomeStore, type HomeStore } from "./home";
export { createActivityStore, type ActivityStore } from "./activity";
export {
  createResumeStore,
  ResumeChangedError,
  type ResumeStore,
} from "./resumes";

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
  /** Indexed identity lookup before discovery reads a saved listing again. */
  findKnownUrls(urls: readonly string[]): string[];
  /** Listing-card closure evidence can retire an existing Found job without another detail read. */
  closeFoundUrls(urls: readonly string[]): number;
  lookupSeenCards(
    cards: readonly Pick<SeenListingCard, "url" | "cardFingerprint">[],
    roleGoalsKey: string,
  ): SeenListingCard[];
  rememberSeenCards(cards: readonly SeenListingCard[]): void;

  listJobs(query: JobListQueryInput): JobListPage;
  getJob(id: number): JobDetail | null;
  stageCounts(): JobStageCounts;

  /** Triage: moves jobs between found, hidden and shortlisted, with Undo. */
  moveJobs(input: { selection: JobSelection; to: TriageStage }): MoveJobsResult;
  undoMove(moveId: number): MoveJobsResult;
  /** For the flows that own later stages; no Undo record. */
  setStage(ids: readonly number[], to: JobStage): number;

  close(): void;
}

/** Closes `db` when `work` throws, so a failed open never leaks a handle. */
function closingOnFailure<T>(db: DatabaseSync, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (db.isOpen) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
    throw error;
  }
}

function openDatabase(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath);
  closingOnFailure(db, () =>
    db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = 5000;
    PRAGMA cache_size = -32768;
    PRAGMA mmap_size = 268435456;
  `),
  );
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
 * Adds the listed columns a table doesn't have yet, keeping its rows. Tables
 * the file doesn't have yet are skipped: their `CREATE TABLE` brings them.
 */
export function addMissingColumns(
  db: DatabaseSync,
  columns: readonly AddedColumn[],
): void {
  for (const { table, column, definition } of columns) {
    const existing = db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table) as { name: string }[];
    if (existing.length === 0 || existing.some((row) => row.name === column))
      continue;
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  }
}

/**
 * Opens the store at `filePath` (or `":memory:"`), adding what is missing and
 * keeping every row. Only a file from before the store kept its data
 * (`JOB_STORE_KEPT_FROM_VERSION`) is deleted and started over.
 */
export function openJobStore(filePath: string): JobStore {
  const inMemory = filePath === ":memory:";
  if (!inMemory) mkdirSync(path.dirname(filePath), { recursive: true });
  let db = openDatabase(filePath);
  const found = closingOnFailure(db, () => readVersion(db));
  if (
    !found.empty &&
    found.version < JOB_STORE_KEPT_FROM_VERSION &&
    !inMemory
  ) {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${filePath}${suffix}`, { force: true });
    }
    db = openDatabase(filePath);
  }
  const sql = closingOnFailure(db, () => {
    db.exec("BEGIN IMMEDIATE");
    // Columns first: a new index in the schema may cover a new column.
    addMissingColumns(db, JOB_STORE_ADDED_COLUMNS);
    for (const ddl of JOB_STORE_SCHEMA) db.exec(ddl);
    if (found.version < JOB_STORE_KEPT_FROM_VERSION)
      db.exec(`PRAGMA user_version = ${JOB_STORE_KEPT_FROM_VERSION}`);
    db.exec("COMMIT");
    if (!inMemory && process.platform !== "win32") {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          chmodSync(`${filePath}${suffix}`, 0o600);
        } catch {
          // The -wal and -shm files appear on first write.
        }
      }
    }
    return createStatements(db);
  });
  // Its setup writes (a search cut off by the last close is stopped).
  const searches = closingOnFailure(db, () => createSearches(sql));
  const listeners = new Set<(change: JobChange) => void>();
  let depth = 0;
  let pending: JobChange[] = [];

  const notify = (change: JobChange) => {
    if (change.stages.length === 0 && change.cause !== "sites") return;
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

    lookupSeenCards: (cards, roleGoalsKey) =>
      lookupSeenCards(sql, cards, roleGoalsKey),
    rememberSeenCards: (cards) => {
      if (cards.length) transaction(() => rememberSeenCards(sql, cards));
    },

    findKnownUrls(urls) {
      const find = sql("SELECT 1 FROM job_keys WHERE key = ?");
      return [...new Set(urls)].filter((url) =>
        Boolean(find.get(`url:${normalizeUrl(url)}`)),
      );
    },

    saveFoundJobs({ searchId, jobs }) {
      if (jobs.length === 0)
        return { added: [], hidden: [], merged: [], ids: [] };
      return transaction(() => {
        const {
          added,
          hidden,
          merged,
          ids: byInput,
          mergedStages,
        } = writeFoundJobs(sql, searchId, jobs, Date.now());
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
        return { added, hidden, merged, ids: byInput };
      });
    },

    closeFoundUrls(urls) {
      if (!urls.length) return 0;
      return transaction(() => {
        const rows =
          sql(`SELECT DISTINCT j.id FROM jobs j JOIN job_sightings s ON s.job_id = j.id
          WHERE j.stage = 'found' AND s.url IN (SELECT value FROM json_each(?))`).all(
            JSON.stringify(urls),
          ) as { id: number }[];
        if (!rows.length) return 0;
        const ids = rows.map((row) => row.id);
        sql(`UPDATE jobs SET stage = 'hidden', stage_at = ?, stage_note = 'Closed: this vacancy is no longer accepting applications.'
          WHERE id IN (SELECT value FROM json_each(?)) AND stage = 'found'`).run(
          Date.now(),
          JSON.stringify(ids),
        );
        notify({
          cause: "stage",
          stages: ["found", "hidden"],
          ids,
          searchId: null,
        });
        return ids.length;
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
          `SELECT id FROM jobs WHERE stage IN ('found', 'shortlisted', 'hidden') AND fit_score = -1
           ORDER BY found_at DESC LIMIT ?`,
        ).all(limit) as { id: number }[]
      ).map((row) => row.id),
    searches,

    listJobs: (query) => listJobs(sql, JobListQuerySchema.parse(query)),
    getJob: (id) => getJob(sql, id),
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

export { resetJobStore } from "./reset";
export { approveOriginalResumesForTests, seedTrackerDemo } from "./test-seeds";
