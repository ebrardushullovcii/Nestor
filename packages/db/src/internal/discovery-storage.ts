import type { DatabaseSync } from "node:sqlite";
import {
  BrowserAgentRunCheckpointSchema,
  DiscoveryActivityEventSchema,
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
  DiscoveryTargetExecutionSchema,
  JobFinderDiscoveryStateSchema,
  SavedJobSchema,
  type DiscoveryRunRecord,
  type JobFinderDiscoveryState,
} from "@nestor/contracts";
import { normalizeLegacyDiscoveryState } from "./legacy";

// The singleton contains only the small, frequently changed discovery fields.
// Run activity, target execution/checkpoints, ledger and pending jobs are rows.
const SMALL_STATE = JobFinderDiscoveryStateSchema.omit({
  activeRun: true,
  recentRuns: true,
  discoveryLedger: true,
  pendingDiscoveryJobs: true,
});
const RUN_METADATA = DiscoveryRunRecordSchema.omit({
  targetExecutions: true,
  activity: true,
});
const TARGET_METADATA = DiscoveryTargetExecutionSchema.omit({
  agentCheckpoint: true,
});

type TargetMetadata = ReturnType<typeof TARGET_METADATA.parse>;
type Target = DiscoveryRunRecord["targetExecutions"][number];

function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function parseRow<T>(table: string, id: string, value: unknown, parser: { parse(value: unknown): T }): T {
  try {
    return parser.parse(JSON.parse(String(value)) as unknown);
  } catch {
    throw new Error(`Corrupted persisted row in table "${table}" (row "${id}").`);
  }
}

function smallValue(state: JobFinderDiscoveryState) {
  return SMALL_STATE.parse(state);
}

function writeSmall(database: DatabaseSync, state: JobFinderDiscoveryState): void {
  database.prepare(`INSERT INTO singleton_state (key, value, revision)
    VALUES ('discovery_state', ?, 1)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value,
      revision = singleton_state.revision + 1`).run(JSON.stringify(smallValue(state)));
}

function replaceRow(database: DatabaseSync, table: string, keys: readonly (string | number)[], value: unknown): void {
  const columns = table === "discovery_runs" || table === "discovery_ledger" || table === "discovery_pending_jobs"
    ? table === "discovery_runs" ? "id, position, active, value" : "id, position, value"
    : table === "discovery_run_targets" || table === "discovery_run_activity"
      ? "run_id, id, position, value" : "run_id, id, value";
  const parameters = [...keys, JSON.stringify(value)];
  database.prepare(`INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${parameters.map(() => "?").join(", ")})`).run(...parameters);
}

function clearRows(database: DatabaseSync): void {
  for (const table of ["discovery_run_checkpoints", "discovery_run_activity", "discovery_run_targets", "discovery_runs", "discovery_ledger", "discovery_pending_jobs"]) {
    database.exec(`DELETE FROM ${table}`);
  }
}

function keyedRows<T extends { id: string }>(rows: readonly T[]): Array<{ key: string; row: T }> {
  const occurrences = new Map<string, number>();
  const actualIds = new Set(rows.map((row) => row.id));
  const allocated = new Set<string>();
  return rows.map((row) => {
    const count = occurrences.get(row.id) ?? 0;
    occurrences.set(row.id, count + 1);
    let key = count === 0 ? row.id : `${row.id}#duplicate_${count}`;
    while (allocated.has(key) || (count > 0 && actualIds.has(key))) key += "_";
    allocated.add(key);
    return { key, row };
  });
}

/** Authoritative reset/import and one-time legacy migration. Caller owns the transaction. */
export function replaceDiscoveryStorage(database: DatabaseSync, state: JobFinderDiscoveryState): void {
  const complete = JobFinderDiscoveryStateSchema.parse(state);
  clearRows(database);
  writeSmall(database, complete);
  const runs = keyedRows([complete.activeRun, ...complete.recentRuns].filter((run): run is DiscoveryRunRecord => run !== null));
  for (const [position, { key, row: run }] of runs.entries()) {
    replaceRow(database, "discovery_runs", [key, position, position === 0 && complete.activeRun ? 1 : 0], RUN_METADATA.parse(run));
    keyedRows(run.targetExecutions.map((target) => ({ id: target.targetId, target }))).forEach(({ key: targetKey, row: { target } }, index) => {
      replaceRow(database, "discovery_run_targets", [key, targetKey, index], TARGET_METADATA.parse(target));
      if (target.agentCheckpoint) replaceRow(database, "discovery_run_checkpoints", [key, targetKey], BrowserAgentRunCheckpointSchema.parse(target.agentCheckpoint));
    });
    keyedRows(run.activity).forEach(({ key: eventKey, row: event }, index) => replaceRow(database, "discovery_run_activity", [key, eventKey, index], DiscoveryActivityEventSchema.parse(event)));
  }
  keyedRows(complete.discoveryLedger).forEach(({ key, row: entry }, index) => replaceRow(database, "discovery_ledger", [key, index], DiscoveryLedgerEntrySchema.parse(entry)));
  keyedRows(complete.pendingDiscoveryJobs).forEach(({ key, row: job }, index) => replaceRow(database, "discovery_pending_jobs", [key, index], SavedJobSchema.parse(job)));
}

/** Transactional, repeatable migration of the existing complete singleton. */
export function migrateDiscoveryStorage(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const migrated = Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = 20").get());
    const tables = ["discovery_runs", "discovery_run_targets", "discovery_run_checkpoints", "discovery_run_activity", "discovery_ledger", "discovery_pending_jobs"];
    if (migrated && tables.some((table) => !database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))) {
      throw new Error("Normalized discovery storage is missing a table; refusing to replace historical data with empty rows.");
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS discovery_runs (id TEXT PRIMARY KEY, position INTEGER NOT NULL, active INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS discovery_runs_position_idx ON discovery_runs(active DESC, position);
      CREATE TABLE IF NOT EXISTS discovery_run_targets (run_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (run_id, id));
      CREATE INDEX IF NOT EXISTS discovery_run_targets_position_idx ON discovery_run_targets(run_id, position);
      CREATE TABLE IF NOT EXISTS discovery_run_checkpoints (run_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (run_id, id));
      CREATE TABLE IF NOT EXISTS discovery_run_activity (run_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (run_id, id));
      CREATE INDEX IF NOT EXISTS discovery_run_activity_position_idx ON discovery_run_activity(run_id, position);
      CREATE TABLE IF NOT EXISTS discovery_ledger (id TEXT PRIMARY KEY, position INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS discovery_ledger_position_idx ON discovery_ledger(position);
      CREATE TABLE IF NOT EXISTS discovery_pending_jobs (id TEXT PRIMARY KEY, position INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS discovery_pending_jobs_position_idx ON discovery_pending_jobs(position);
    `);
    if (!migrated) {
      const row = database.prepare("SELECT value FROM singleton_state WHERE key = 'discovery_state'").get();
      if (row) {
        const legacy = parseRow("singleton_state", "discovery_state", row.value, { parse: normalizeLegacyDiscoveryState });
        replaceDiscoveryStorage(database, legacy);
      }
      database.prepare("INSERT INTO schema_migrations (version, name) VALUES (20, 'normalized_discovery_storage')").run();
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export interface DiscoveryDisplayRowCache {
  scopes: Map<string, { runId: string; values: Map<string, unknown> }>;
  dirty: Map<string, Set<string>>;
}

export function discoveryRowScope(table: string, runId = ""): string {
  return JSON.stringify([table, runId]);
}

function readKeyedRows<T>(database: DatabaseSync, table: string, parser: { parse(value: unknown): T }, where = "", params: string[] = [], cache?: DiscoveryDisplayRowCache): Array<{ key: string; value: T }> {
  const runId = params[0] ?? "";
  const scope = discoveryRowScope(table, runId);
  const cached = cache?.scopes.get(scope);
  const cold = !cached;
  const rows = database.prepare(`SELECT id${cold ? ", value" : ""} FROM ${table} ${where} ORDER BY position`).all(...params);
  const valuesById = cached?.values ?? new Map<string, unknown>();
  const dirty = cache?.dirty.get(scope);
  const changedIds = cold ? [] : rows.map((row) => String(row.id))
    .filter((id) => dirty?.has(id) || !valuesById.has(id));
  // One indexed query replaces N per-row SELECTs. Only changed bodies cross
  // into JS; the ordered id scan and unchanged object identities stay cheap.
  const changed = changedIds.length > 0
    ? database.prepare(`SELECT id, value FROM ${table} WHERE ${params.length > 0 ? "run_id = ? AND " : ""}id IN (SELECT value FROM json_each(?))`)
      .all(...params, JSON.stringify(changedIds))
    : [];
  const rawById = new Map(changed.map((row) => [String(row.id), row.value]));
  const values = rows.map((row) => {
    const id = String(row.id);
    if (!cold && !dirty?.has(id) && valuesById.has(id))
      return { key: id, value: valuesById.get(id) as T };
    const raw = cold ? row.value : rawById.get(id);
    const parsed = frozen(parseRow(table, id, raw, parser));
    valuesById.set(id, parsed);
    return { key: id, value: parsed };
  });
  if (cache) {
    cache.scopes.set(scope, { runId, values: valuesById });
    const present = new Set(rows.map((row) => String(row.id)));
    for (const id of valuesById.keys()) if (!present.has(id)) valuesById.delete(id);
  }
  return values;
}

function readRows<T>(database: DatabaseSync, table: string, parser: { parse(value: unknown): T }, where = "", params: string[] = [], cache?: DiscoveryDisplayRowCache): T[] {
  return readKeyedRows(database, table, parser, where, params, cache).map(({ value }) => value);
}

function readRun(database: DatabaseSync, row: { id: unknown; value: unknown }, includeCheckpoints: boolean, cache?: DiscoveryDisplayRowCache): DiscoveryRunRecord {
  const id = String(row.id);
  const metadata = parseRow("discovery_runs", id, row.value, RUN_METADATA);
  const targets = readKeyedRows(database, "discovery_run_targets", TARGET_METADATA, "WHERE run_id = ?", [id], cache);
  const checkpointRows = includeCheckpoints ? database.prepare("SELECT id, value FROM discovery_run_checkpoints WHERE run_id = ?").all(id) : [];
  const checkpoints = new Map(checkpointRows.map((checkpoint) => [String(checkpoint.id), frozen(parseRow("discovery_run_checkpoints", `${id}/${String(checkpoint.id)}`, checkpoint.value, BrowserAgentRunCheckpointSchema))]));
  const executions = targets.map(({ key, value }) => frozen({ ...value, agentCheckpoint: checkpoints.get(key) ?? null }));
  const activity = readRows(database, "discovery_run_activity", DiscoveryActivityEventSchema, "WHERE run_id = ?", [id], cache);
  return frozen({ ...metadata, targetExecutions: executions, activity });
}

export function readDiscoveryStorage(database: DatabaseSync, fallback: JobFinderDiscoveryState, includeCheckpoints = true, cache?: DiscoveryDisplayRowCache): JobFinderDiscoveryState {
  const row = database.prepare("SELECT value FROM singleton_state WHERE key = 'discovery_state'").get();
  if (!row) {
    cache?.scopes.clear();
    cache?.dirty.clear();
    return frozen(JobFinderDiscoveryStateSchema.parse(fallback));
  }
  const small = parseRow("singleton_state", "discovery_state", row.value, SMALL_STATE);
  const runs = database.prepare("SELECT id, active, value FROM discovery_runs ORDER BY active DESC, position").all() as Array<{ id: string; active: number; value: string }>;
  if (cache) {
    const presentRuns = new Set(runs.map((run) => String(run.id)));
    for (const [scope, value] of cache.scopes) {
      if (value.runId && !presentRuns.has(value.runId)) {
        cache.scopes.delete(scope);
        cache.dirty.delete(scope);
      }
    }
  }
  const active = runs.find((run) => Number(run.active) === 1);
  const recent = runs.filter((run) => Number(run.active) !== 1);
  return frozen({
    ...small,
    activeRun: active ? readRun(database, active, includeCheckpoints, cache) : null,
    recentRuns: recent.map((run) => readRun(database, run, includeCheckpoints, cache)),
    discoveryLedger: readRows(database, "discovery_ledger", DiscoveryLedgerEntrySchema, "", [], cache),
    pendingDiscoveryJobs: readRows(database, "discovery_pending_jobs", SavedJobSchema, "", [], cache),
  });
}

/** Keep the largest already-ordered subsequence at its persisted ranks. */
function orderedRanks(keys: readonly string[], previous: Map<string, number>): number[] {
  const tails: number[] = [];
  const links = new Map<number, number>();
  for (const [index, key] of keys.entries()) {
    const rank = previous.get(key);
    if (rank === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (previous.get(keys[tails[middle]!]!)! < rank) low = middle + 1;
      else high = middle;
    }
    if (low > 0) links.set(index, tails[low - 1]!);
    tails[low] = index;
  }
  const anchors = new Set<number>();
  let cursor = tails.at(-1);
  while (cursor !== undefined) {
    anchors.add(cursor);
    cursor = links.get(cursor);
  }
  const ranks: number[] = [];
  let maximum = -1;
  for (const rank of previous.values()) maximum = Math.max(maximum, rank);
  let start = 0;
  for (let end = 0; end <= keys.length; end += 1) {
    if (end < keys.length && !anchors.has(end)) continue;
    const right = end < keys.length ? previous.get(keys[end]!)! : undefined;
    const left = start > 0 ? ranks[start - 1]! : undefined;
    const count = end - start;
    for (let offset = 0; offset < count; offset += 1) {
      // SQLite's non-STRICT numeric position column accepts fractional ranks.
      // Mid-list inserts use the existing gap without shifting later rows;
      // append/move-to-end ranks are strictly above the previous maximum.
      ranks[start + offset] = right === undefined
        ? Math.max(maximum, left ?? -1) + offset + 1
        : left === undefined ? right - count + offset
          : left + (right - left) * ((offset + 1) / (count + 1));
    }
    if (right !== undefined) ranks[end] = right;
    start = end + 1;
  }
  // Compact only when floating-point gaps or extreme ranks are exhausted.
  // Never publish a rank collision that could reorder canonical state on reopen.
  if (ranks.some((rank, index) => !Number.isFinite(rank) || (index > 0 && rank <= ranks[index - 1]!)))
    return keys.map((_, index) => index);
  return ranks;
}

function writeChangedRows<T extends { id: string }>(database: DatabaseSync, table: string, before: readonly T[], after: readonly T[], parser: { parse(value: unknown): T }, aliases: WeakMap<object, object>, runId?: string): T[] {
  if (before === after) return before as T[];
  const positions = new Map(database.prepare(`SELECT id, position FROM ${table}${runId ? " WHERE run_id = ?" : ""}`).all(...(runId ? [runId] : []))
    .map((row) => [String(row.id), Number(row.position)]));
  const nextRows = keyedRows(after);
  const ranks = orderedRanks(nextRows.map(({ key }) => key), positions);
  const previous = new Map(keyedRows(before).map(({ key, row }) => [key, { row, position: positions.get(key) }]));
  const seen = new Set<string>();
  const result: T[] = [];
  nextRows.forEach(({ key, row }, index) => {
    const position = ranks[index]!;
    seen.add(key);
    const previousEntry = previous.get(key);
    const old = previousEntry?.row;
    // Unchanged rows retain their validated, frozen identity. Updaters must
    // build a new row when changing a value.
    if (old === row || (old && aliases.get(row) === old)) {
      if (previousEntry?.position !== position)
        database.prepare(`UPDATE ${table} SET position = ? WHERE ${runId ? "run_id = ? AND " : ""}id = ?`).run(...(runId ? [position, runId, key] : [position, key]));
      result.push(old);
      return;
    }
    const parsed = frozen(parser.parse(row));
    const same = old && JSON.stringify(old) === JSON.stringify(parsed);
    if (!same) {
      replaceRow(database, table, runId ? [runId, key, position] : [key, position], parsed);
    } else if (previousEntry?.position !== position) {
      database.prepare(`UPDATE ${table} SET position = ? WHERE ${runId ? "run_id = ? AND " : ""}id = ?`).run(...(runId ? [position, runId, key] : [position, key]));
    }
    const stored = same && old ? old : parsed;
    // The service may reuse its original row on later checkpoints. Freeze it
    // now so identity reuse cannot hide a later in-place edit.
    frozen(row);
    aliases.set(row, stored);
    result.push(stored);
  });
  for (const key of previous.keys()) if (!seen.has(key)) database.prepare(`DELETE FROM ${table} WHERE ${runId ? "run_id = ? AND " : ""}id = ?`).run(...(runId ? [runId, key] : [key]));
  return result;
}

function writeRun(database: DatabaseSync, before: DiscoveryRunRecord | null, next: DiscoveryRunRecord, key: string, position: number, active: boolean, aliases: WeakMap<object, object>): DiscoveryRunRecord {
  const metadata = frozen(RUN_METADATA.parse(next));
  const oldMetadata = before && RUN_METADATA.parse(before);
  if (!oldMetadata || JSON.stringify(oldMetadata) !== JSON.stringify(metadata)) {
    replaceRow(database, "discovery_runs", [key, position, active ? 1 : 0], metadata);
  } else {
    database.prepare("UPDATE discovery_runs SET position = ?, active = ? WHERE id = ? AND (position <> ? OR active <> ?)").run(position, active ? 1 : 0, key, position, active ? 1 : 0);
  }
  const oldTargets = before?.targetExecutions ?? [];
  const oldById = new Map(keyedRows(oldTargets.map((target) => ({ id: target.targetId, target }))).map(({ key: targetKey, row: { target } }, index) => [targetKey, { target, index }]));
  const seenTargets = new Set<string>();
  const targets: Target[] = [];
  keyedRows(next.targetExecutions.map((target) => ({ id: target.targetId, target }))).forEach(({ key: targetKey, row: { target } }, index) => {
    seenTargets.add(targetKey);
    const previousTarget = oldById.get(targetKey);
    const old = previousTarget?.target;
    if (old === target || (old && aliases.get(target) === old)) {
      if (previousTarget?.index !== index)
        database.prepare("UPDATE discovery_run_targets SET position = ? WHERE run_id = ? AND id = ?").run(index, key, targetKey);
      targets.push(old);
      return;
    }
    const parsedMetadata: TargetMetadata = TARGET_METADATA.parse(target);
    const oldParsedMetadata = old && TARGET_METADATA.parse(old);
    if (!oldParsedMetadata || JSON.stringify(oldParsedMetadata) !== JSON.stringify(parsedMetadata))
      replaceRow(database, "discovery_run_targets", [key, targetKey, index], parsedMetadata);
    else if (previousTarget?.index !== index)
      database.prepare("UPDATE discovery_run_targets SET position = ? WHERE run_id = ? AND id = ?").run(index, key, targetKey);
    const checkpoint = target.agentCheckpoint;
    const oldCheckpoint = old?.agentCheckpoint;
    let storedCheckpoint = oldCheckpoint;
    if (checkpoint !== oldCheckpoint) {
      if (!checkpoint) {
        if (oldCheckpoint) database.prepare("DELETE FROM discovery_run_checkpoints WHERE run_id = ? AND id = ?").run(key, targetKey);
        storedCheckpoint = null;
      } else if (!oldCheckpoint || checkpoint.revision !== oldCheckpoint.revision || checkpoint.savedAt !== oldCheckpoint.savedAt || JSON.stringify(checkpoint) !== JSON.stringify(oldCheckpoint)) {
        storedCheckpoint = frozen(BrowserAgentRunCheckpointSchema.parse(checkpoint));
        replaceRow(database, "discovery_run_checkpoints", [key, targetKey], storedCheckpoint);
      }
    }
    const stored = frozen({ ...(oldParsedMetadata && JSON.stringify(oldParsedMetadata) === JSON.stringify(parsedMetadata) ? oldParsedMetadata : frozen(parsedMetadata)), agentCheckpoint: storedCheckpoint ?? null });
    frozen(target);
    aliases.set(target, stored);
    targets.push(stored);
  });
  for (const targetKey of oldById.keys()) if (!seenTargets.has(targetKey)) {
    database.prepare("DELETE FROM discovery_run_targets WHERE run_id = ? AND id = ?").run(key, targetKey);
    database.prepare("DELETE FROM discovery_run_checkpoints WHERE run_id = ? AND id = ?").run(key, targetKey);
  }
  const activity = writeChangedRows(database, "discovery_run_activity", before?.activity ?? [], next.activity, DiscoveryActivityEventSchema, aliases, key);
  return frozen({ ...metadata, targetExecutions: targets, activity });
}

export function updateDiscoveryStorage(database: DatabaseSync, before: JobFinderDiscoveryState, proposed: JobFinderDiscoveryState, aliases: WeakMap<object, object>): JobFinderDiscoveryState {
  const small = smallValue(proposed);
  const oldSmall = smallValue(before);
  if (JSON.stringify(small) !== JSON.stringify(oldSmall)) writeSmall(database, proposed);
  else {
    // Every applied commit remains a visible revision, including a no-op.
    database.prepare("UPDATE singleton_state SET revision = revision + 1 WHERE key = 'discovery_state'").run();
  }
  const beforeRuns = new Map(keyedRows([before.activeRun, ...before.recentRuns].filter((run): run is DiscoveryRunRecord => run !== null)).map(({ key, row }, index) => [key, { row, index, active: index === 0 && before.activeRun !== null }]));
  const afterRuns = keyedRows([proposed.activeRun, ...proposed.recentRuns].filter((run): run is DiscoveryRunRecord => run !== null));
  const storedRuns = afterRuns.map(({ key, row }, index) => {
    const old = beforeRuns.get(key);
    const active = index === 0 && proposed.activeRun !== null;
    if (old?.row === row && old.index === index && old.active === active) return old.row;
    return writeRun(database, old?.row ?? null, row, key, index, active, aliases);
  });
  const afterKeys = new Set(afterRuns.map(({ key }) => key));
  for (const id of beforeRuns.keys()) if (!afterKeys.has(id)) {
    for (const table of ["discovery_run_checkpoints", "discovery_run_activity", "discovery_run_targets"]) database.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(id);
    database.prepare("DELETE FROM discovery_runs WHERE id = ?").run(id);
  }
  const ledger = writeChangedRows(database, "discovery_ledger", before.discoveryLedger, proposed.discoveryLedger, DiscoveryLedgerEntrySchema, aliases);
  const pending = writeChangedRows(database, "discovery_pending_jobs", before.pendingDiscoveryJobs, proposed.pendingDiscoveryJobs, SavedJobSchema, aliases);
  return frozen({ ...small, activeRun: proposed.activeRun ? storedRuns[0] ?? null : null, recentRuns: proposed.activeRun ? storedRuns.slice(1) : storedRuns, discoveryLedger: ledger, pendingDiscoveryJobs: pending });
}

export function createDiscoveryStorage(database: DatabaseSync, fallback: JobFinderDiscoveryState) {
  // Connection-local triggers observe our own writes, including row-only edits
  // made by another repository method. SQLite data_version covers other
  // connections, while the transactional TEMP epoch rolls back with the edit.
  database.exec("CREATE TEMP TABLE discovery_canonical_epoch (revision INTEGER NOT NULL); INSERT INTO discovery_canonical_epoch VALUES (0)");
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    const condition = event === "UPDATE"
      ? "OLD.key = 'discovery_state' OR NEW.key = 'discovery_state'"
      : `${event === "DELETE" ? "OLD" : "NEW"}.key = 'discovery_state'`;
    database.exec(`CREATE TEMP TRIGGER discovery_canonical_singleton_${event.toLowerCase()}
      AFTER ${event} ON main.singleton_state
      WHEN ${condition}
      BEGIN UPDATE discovery_canonical_epoch SET revision = revision + 1; END`);
  }
  for (const table of ["discovery_runs", "discovery_run_targets", "discovery_run_checkpoints", "discovery_run_activity", "discovery_ledger", "discovery_pending_jobs"]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      database.exec(`CREATE TEMP TRIGGER discovery_canonical_${table}_${event.toLowerCase()}
        AFTER ${event} ON main.${table}
        BEGIN UPDATE discovery_canonical_epoch SET revision = revision + 1; END`);
    }
  }
  const aliases = new WeakMap<object, object>();
  let cached: JobFinderDiscoveryState | null = null;
  let cachedEpoch = -1;
  let cachedVersion = -1;
  const epoch = () => Number(database.prepare("SELECT revision FROM discovery_canonical_epoch").get()?.revision ?? 0);
  const version = () => Number(database.prepare("PRAGMA data_version").get()?.data_version ?? 0);
  return {
    read(): JobFinderDiscoveryState {
      const currentEpoch = epoch();
      const currentVersion = version();
      if (cached && currentEpoch === cachedEpoch && currentVersion === cachedVersion) return cached;
      const state = readDiscoveryStorage(database, fallback);
      // A read inside a transaction may see rows that later roll back. Keep
      // only committed snapshots; rollback may reuse an epoch value.
      if (!database.isTransaction) {
        cached = state;
        cachedEpoch = currentEpoch;
        cachedVersion = currentVersion;
      }
      return state;
    },
    update(proposed: JobFinderDiscoveryState, before: JobFinderDiscoveryState): JobFinderDiscoveryState {
      return updateDiscoveryStorage(database, before, proposed, aliases);
    },
    publish(state: JobFinderDiscoveryState): void {
      if (database.isTransaction) throw new Error("Discovery snapshots can only be published after commit.");
      cached = state;
      cachedEpoch = epoch();
      cachedVersion = version();
    },
  };
}
