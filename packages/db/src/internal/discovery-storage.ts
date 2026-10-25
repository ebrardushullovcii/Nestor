import type { DatabaseSync } from "node:sqlite";
import {
  DiscoveryBootstrapStateSchema,
  JobFinderDiscoveryStateSchema,
  type JobFinderDiscoveryState,
  type DiscoveryBootstrapState,
  type DiscoveryHomeState,
} from "@nestor/contracts";
import { normalizeLegacyDiscoveryState } from "./legacy";
import { parsePersistedRowValue } from "./state";

// Browser sessions and source-debug runs, in one small singleton row. Search
// runs, their logs and checkpoints, the ledger and pending jobs were the old
// search's; the job store keeps searches now.
const RETIRED_TABLES = [
  "discovery_run_checkpoints",
  "discovery_run_activity",
  "discovery_run_targets",
  "discovery_run_source_health",
  "discovery_runs",
  "discovery_ledger_observations",
  "discovery_ledger",
  "discovery_pending_jobs",
];

function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function readSmall(
  database: DatabaseSync,
  fallback: JobFinderDiscoveryState,
): JobFinderDiscoveryState {
  const row = database
    .prepare("SELECT value FROM singleton_state WHERE key = 'discovery_state'")
    .get();
  return row
    ? parsePersistedRowValue({
        tableName: "singleton_state",
        rowId: "discovery_state",
        rawValue: String(row.value),
        schema: JobFinderDiscoveryStateSchema,
      })
    : JobFinderDiscoveryStateSchema.parse(fallback);
}

function writeSmall(database: DatabaseSync, state: JobFinderDiscoveryState): void {
  const { sessions, activeSourceDebugRun, recentSourceDebugRuns } = state;
  database
    .prepare(
      `INSERT INTO singleton_state (key, value, revision)
    VALUES ('discovery_state', ?, 1)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
      revision = singleton_state.revision + 1`,
    )
    .run(JSON.stringify({ sessions, activeSourceDebugRun, recentSourceDebugRuns }));
}

/** Authoritative reset/import. Caller owns the transaction. */
export function replaceDiscoveryStorage(database: DatabaseSync, state: JobFinderDiscoveryState): void {
  writeSmall(database, JobFinderDiscoveryStateSchema.parse(state));
}

/** Drops the old search's tables and keeps sessions and source-debug runs. */
export function migrateDiscoveryStorage(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const table of RETIRED_TABLES) database.exec(`DROP TABLE IF EXISTS ${table}`);
    const row = database
      .prepare("SELECT value FROM singleton_state WHERE key = 'discovery_state'")
      .get();
    if (row) {
      writeSmall(
        database,
        normalizeLegacyDiscoveryState(JSON.parse(String(row.value)) as unknown),
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function readDiscoveryBootstrapStorage(
  database: DatabaseSync,
  fallback: JobFinderDiscoveryState,
): DiscoveryBootstrapState {
  return frozen(DiscoveryBootstrapStateSchema.parse(readSmall(database, fallback)));
}

export function readDiscoveryHomeStorage(
  database: DatabaseSync,
  fallback: JobFinderDiscoveryState,
): Omit<DiscoveryHomeState, "listingActivities"> {
  return frozen(readSmall(database, fallback));
}

export function readDiscoveryStorage(
  database: DatabaseSync,
  fallback: JobFinderDiscoveryState,
): JobFinderDiscoveryState {
  return frozen(readSmall(database, fallback));
}

// The row is small, so every read goes to the database; nothing can go stale.
export function createDiscoveryStorage(database: DatabaseSync, fallback: JobFinderDiscoveryState) {
  return {
    peek(): JobFinderDiscoveryState | null {
      return database.isTransaction ? null : readDiscoveryStorage(database, fallback);
    },
    read(): JobFinderDiscoveryState {
      return readDiscoveryStorage(database, fallback);
    },
    update(proposed: JobFinderDiscoveryState): JobFinderDiscoveryState {
      const state = frozen(JobFinderDiscoveryStateSchema.parse(proposed));
      writeSmall(database, state);
      return state;
    },
    /** Caller owns the transaction. */
    updateSessions(
      change: (sessions: JobFinderDiscoveryState["sessions"]) => JobFinderDiscoveryState["sessions"],
    ): JobFinderDiscoveryState["sessions"] {
      const current = readDiscoveryStorage(database, fallback);
      const sessions = frozen(change(current.sessions));
      writeSmall(database, { ...current, sessions });
      return sessions;
    },
  };
}
