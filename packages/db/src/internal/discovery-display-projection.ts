import type { DatabaseSync } from "node:sqlite";
import type {
  JobFinderDiscoveryState,
  DiscoveryRunRecord,
} from "@nestor/contracts";
import { normalizeLegacyDiscoveryState } from "./legacy";
import { cloneValue, parsePersistedRowValue } from "./state";
import { freezeProjection } from "./saved-job-projection";
import {
  discoveryRowScope,
  readDiscoveryStorage,
  type DiscoveryDisplayRowCache,
} from "./discovery-storage";
import type { DiscoveryDisplayProjection } from "../repository-types";

/** Checkpoints belong to resume/write paths, never to the display projection. */
export function toDiscoveryDisplayProjection(
  state: JobFinderDiscoveryState,
): DiscoveryDisplayProjection {
  const displayRun = (run: DiscoveryRunRecord): DiscoveryRunRecord => ({
    ...run,
    targetExecutions: run.targetExecutions.map((execution) => ({
      ...execution,
      agentCheckpoint: null,
    })),
  });
  return freezeProjection(
    cloneValue({
      ...state,
      activeRun: state.activeRun ? displayRun(state.activeRun) : null,
      recentRuns: state.recentRuns.map(displayRun),
    }),
  ) as unknown as DiscoveryDisplayProjection;
}

/** Remove checkpoint payloads inside SQLite, before JSON crosses into JS. */
function displayRunSql(run: string): string {
  return `json_set(${run}, '$.targetExecutions', json((
    SELECT json_group_array(json_set(execution.value, '$.agentCheckpoint', json('null')))
    FROM json_each(${run}, '$.targetExecutions') AS execution
  )))`;
}

export function createDiscoveryDisplayProjectionReader(
  database: DatabaseSync,
  fallback: JobFinderDiscoveryState,
) {
  const normalized = Boolean(
    database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discovery_runs'",
      )
      .get(),
  );
  // All local write paths (reset/import included) pass through this table.
  // SQLite rolls these markers back together with a failed transaction.
  database.exec(`
    CREATE TEMP TABLE discovery_display_epoch (revision INTEGER NOT NULL);
    INSERT INTO discovery_display_epoch VALUES (0);
    ${["INSERT", "UPDATE", "DELETE"]
      .map(
        (event) => `
      CREATE TEMP TRIGGER discovery_display_${event.toLowerCase()}
      AFTER ${event} ON main.singleton_state
      WHEN ${
        event === "UPDATE"
          ? "(OLD.key = 'discovery_state' OR NEW.key = 'discovery_state') AND (OLD.value IS NOT NEW.value OR OLD.key IS NOT NEW.key)"
          : `${event === "DELETE" ? "OLD" : "NEW"}.key = 'discovery_state'`
      }
      BEGIN UPDATE discovery_display_epoch SET revision = revision + 1; END;
    `,
      )
      .join("\n")}
  `);
  if (normalized) {
    database.exec(`CREATE TEMP TABLE discovery_display_changes (
      table_name TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY (table_name, run_id, id)
    )`);
    // Checkpoint bodies are absent from this projection. A checkpoint-only
    // commit must keep the same display object and avoid rebuilding history.
    for (const table of ["discovery_runs", "discovery_run_targets", "discovery_run_activity", "discovery_run_source_health", "discovery_ledger", "discovery_pending_jobs"]) {
      for (const event of ["INSERT", "UPDATE", "DELETE"]) {
        const row = event === "DELETE" ? "OLD" : "NEW";
        const runId = table === "discovery_run_targets" || table === "discovery_run_activity" || table === "discovery_run_source_health"
          ? `${row}.run_id` : "''";
        const retiredChild = event === "DELETE" && runId !== "''";
        database.exec(`CREATE TEMP TRIGGER discovery_display_${table}_${event.toLowerCase()}
          AFTER ${event} ON main.${table}
          ${retiredChild ? "WHEN EXISTS (SELECT 1 FROM discovery_runs WHERE id = OLD.run_id)" : ""}
          BEGIN
            UPDATE discovery_display_epoch SET revision = revision + 1;
            INSERT INTO discovery_display_changes (table_name, run_id, id)
              VALUES ('${table}', ${runId}, ${row}.id)
              ON CONFLICT(table_name, run_id, id) DO NOTHING;
          END`);
      }
    }
  }
  const readRevision = database.prepare(
    "SELECT revision FROM discovery_display_epoch",
  );
  const readVersion = database.prepare("PRAGMA data_version");
  const readDisplay = database.prepare(`
    SELECT json_set(state.value,
      '$.activeRun', json(CASE
        WHEN json_type(state.value, '$.activeRun') = 'object'
        THEN ${displayRunSql("json_extract(state.value, '$.activeRun')")}
        ELSE json_extract(state.value, '$.activeRun') END),
      '$.recentRuns', json((
        SELECT json_group_array(${displayRunSql("run.value")})
        FROM json_each(state.value, '$.recentRuns') AS run
      ))
    ) AS value
    FROM singleton_state AS state WHERE state.key = 'discovery_state'
  `);
  let cached: JobFinderDiscoveryState | null = null;
  let cachedRevision: number | null = null;
  let cachedVersion: number | null = null;
  let rowCache: DiscoveryDisplayRowCache | null = null;

  function read(): JobFinderDiscoveryState {
    const revision = Number(readRevision.get()?.revision);
    const version = Number(readVersion.get()?.data_version);
    // Never retain a projection of uncommitted data: a rollback can reuse
    // the same epoch on its next write.
    if (database.isTransaction) cached = null;
    if (cached && revision === cachedRevision && version === cachedVersion)
      return cached;

    if (normalized && !database.isTransaction) {
      if (version !== cachedVersion || !rowCache) {
        rowCache = { scopes: new Map(), dirty: new Map() };
      }
      rowCache.dirty.clear();
      for (const row of database
        .prepare(
          "SELECT table_name, run_id, id FROM discovery_display_changes",
        )
        .all()) {
        const scope = discoveryRowScope(
          String(row.table_name),
          String(row.run_id),
        );
        let dirty = rowCache.dirty.get(scope);
        if (!dirty) rowCache.dirty.set(scope, (dirty = new Set()));
        dirty.add(String(row.id));
      }
    }

    let projection: JobFinderDiscoveryState;
    try {
      if (normalized) {
        // Checkpoint rows are never selected, so their payloads cannot cross
        // into JavaScript just to render discovery state.
        projection = readDiscoveryStorage(
          database,
          fallback,
          false,
          database.isTransaction ? undefined : (rowCache ?? undefined),
        );
      } else {
        const row = readDisplay.get();
        projection = row
          ? freezeProjection(
              parsePersistedRowValue({
                tableName: "singleton_state",
                rowId: "discovery_state",
                rawValue: String(row.value),
                schema: { parse: normalizeLegacyDiscoveryState },
              }),
            )
          : toDiscoveryDisplayProjection(fallback);
      }
    } catch (error) {
      // Match ordinary repository reads without exposing persisted contents.
      if (
        error instanceof Error &&
        error.message.startsWith("Corrupted persisted row")
      )
        throw error;
      throw new Error(
        'Corrupted persisted row in table "singleton_state" (row "discovery_state"): the discovery display projection could not be read.',
      );
    }
    if (!database.isTransaction) {
      cached = projection;
      cachedRevision = revision;
      cachedVersion = version;
      rowCache?.dirty.clear();
      if (normalized)
        database
          // This connection-local table cannot change during the synchronous
          // read above. All its changes are consumed, so SQLite can clear it
          // without visiting and deleting each row and index entry in turn.
          .prepare("DELETE FROM discovery_display_changes")
          .run();
    }
    return projection;
  }

  return (): Promise<DiscoveryDisplayProjection> => {
    try {
      return Promise.resolve(read() as unknown as DiscoveryDisplayProjection);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("The discovery display projection could not be read."),
      );
    }
  };
}
