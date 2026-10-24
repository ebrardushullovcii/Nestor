import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  BrowserAgentRunCheckpointSchema,
  DiscoveryActivityEventSchema,
  DiscoveryLedgerEntrySchema,
  DiscoveryRunRecordSchema,
  DiscoveryTargetExecutionSchema,
  JobFinderDiscoveryStateSchema,
  SavedJobSchema,
  type DiscoveryRunRecord,
  type DiscoveryActivityEvent,
  type DiscoveryLedgerEntry,
  type SavedJob,
  type BrowserAgentRunCheckpoint,
  type JobFinderDiscoveryState,
} from "@nestor/contracts";
import { normalizeLegacyDiscoveryState } from "./legacy";
import { adoptDiscoveryLedgerIndex, discoveryLedgerPatches } from "./discovery-ledger-patch";

// The singleton contains only the small, frequently changed discovery fields.
// Run activity, target execution/checkpoints, ledger and pending jobs are rows.
type SmallState = Omit<JobFinderDiscoveryState,
  "activeRun" | "recentRuns" | "discoveryLedger" | "pendingDiscoveryJobs">;
const RUN_METADATA = DiscoveryRunRecordSchema.omit({
  targetExecutions: true,
  activity: true,
});
const TARGET_METADATA = DiscoveryTargetExecutionSchema.omit({
  agentCheckpoint: true,
});

type TargetMetadata = ReturnType<typeof TARGET_METADATA.parse>;
type Target = DiscoveryRunRecord["targetExecutions"][number];

// Compiled statements per connection. A search saves several times a second
// and each save writes many rows; compiling the same INSERT for every row
// was a visible share of the main process.
const statementCache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

function statement(database: DatabaseSync, sql: string): StatementSync {
  let statements = statementCache.get(database);
  if (!statements) {
    statements = new Map();
    statementCache.set(database, statements);
  }
  let prepared = statements.get(sql);
  if (!prepared) {
    prepared = database.prepare(sql);
    statements.set(sql, prepared);
  }
  return prepared;
}

/**
 * Row positions of the run activity and ledger tables, as this connection
 * last committed them, by table and run. Reading every position back before
 * each save (thousands of ledger rows) is skipped while nothing else wrote.
 */
type PositionCache = Map<string, Map<string, number>>;

function frozen<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function parseRow<T>(table: string, id: string, value: unknown): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    throw new Error(`Corrupted persisted row in table "${table}" (row "${id}").`);
  }
}

function smallValue(state: JobFinderDiscoveryState) {
  return { sessions: state.sessions, runState: state.runState,
    activeSourceDebugRun: state.activeSourceDebugRun, recentSourceDebugRuns: state.recentSourceDebugRuns };
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
  statement(database, `INSERT OR REPLACE INTO ${table} (${columns}) VALUES (${parameters.map(() => "?").join(", ")})`).run(...parameters);
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
        const legacy = normalizeLegacyDiscoveryState(JSON.parse(String(row.value)) as unknown);
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

type CachedScope = {
  runId: string;
  values: Map<string, unknown>;
  ordered?: Array<{ key: string; value: unknown }>;
  /** Each listed row's stored position, and the largest of them. */
  positions?: Map<string, number>;
  maxPosition?: number;
};

export interface DiscoveryDisplayRowCache {
  scopes: Map<string, CachedScope>;
  dirty: Map<string, Set<string>>;
  /** Display runs by id, with the stored metadata text they were read from. */
  runs?: Map<string, { raw: string; run: DiscoveryRunRecord }>;
}

export function discoveryRowScope(table: string, runId = ""): string {
  return JSON.stringify([table, runId]);
}

/**
 * The scope's rows after the changes since its last read, without reading
 * the order of every row again. A search rewrites thousands of the 30,000
 * ledger rows (where it saw each listing last, which also moves the entry to
 * the end) and appends its log; listing every id in order on each refresh
 * was most of a refresh's cost. Returns null when a new or moved row does not
 * come after all the others, and the caller reads the whole order.
 */
function readChangedRowsInPlace<T>(
  database: DatabaseSync,
  table: string,
  params: string[],
  cached: CachedScope & {
    ordered: Array<{ key: string; value: unknown }>;
    positions: Map<string, number>;
    maxPosition: number;
  },
  dirtyIds: ReadonlySet<string>,
): Array<{ key: string; value: unknown }> | null {
  const ids = [...dirtyIds];
  const rows = statement(database, `SELECT id, position, value FROM ${table} WHERE ${params.length > 0 ? "run_id = ? AND " : ""}id IN (SELECT value FROM json_each(?))`)
    .all(...params, JSON.stringify(ids));
  const found = new Map(rows.map((row) => [String(row.id), row]));
  const replaced = new Map<string, unknown>();
  // Rows gone from their place: deleted, or moved after all the others.
  const removed = new Set<string>();
  const deleted: string[] = [];
  const appended: Array<{ id: string; position: number; raw: unknown }> = [];
  for (const id of ids) {
    const row = found.get(id);
    const previous = cached.positions.get(id);
    if (!row) {
      if (previous !== undefined) {
        removed.add(id);
        deleted.push(id);
      }
      continue;
    }
    const position = Number(row.position);
    if (previous === position) {
      replaced.set(id, row.value);
      continue;
    }
    // A row seen again moves to the end; any other move needs the order read.
    if (previous !== undefined) removed.add(id);
    appended.push({ id, position, raw: row.value });
  }
  appended.sort((left, right) => left.position - right.position);
  let maxPosition = cached.maxPosition;
  for (const { position } of appended) {
    if (!(position > maxPosition)) return null;
    maxPosition = position;
  }
  const ordered: Array<{ key: string; value: unknown }> = [];
  for (const entry of cached.ordered) {
    if (removed.has(entry.key)) continue;
    if (!replaced.has(entry.key)) {
      ordered.push(entry);
      continue;
    }
    const value = frozen(parseRow<T>(table, entry.key, replaced.get(entry.key)));
    cached.values.set(entry.key, value);
    ordered.push({ key: entry.key, value });
  }
  for (const { id, position, raw } of appended) {
    const value = frozen(parseRow<T>(table, id, raw));
    cached.values.set(id, value);
    cached.positions.set(id, position);
    ordered.push({ key: id, value });
  }
  for (const id of deleted) {
    cached.values.delete(id);
    cached.positions.delete(id);
  }
  cached.ordered = ordered;
  cached.maxPosition = maxPosition;
  return ordered;
}

function readKeyedRows<T>(database: DatabaseSync, table: string, where = "", params: string[] = [], cache?: DiscoveryDisplayRowCache): Array<{ key: string; value: T }> {
  const runId = params[0] ?? "";
  const scope = discoveryRowScope(table, runId);
  const cached = cache?.scopes.get(scope);
  // Every write to these tables is recorded as a change to its scope, so a
  // scope with none since the last read is that read, order included. A
  // finished search's thousands of log rows are not scanned again for an edit
  // somewhere else.
  const dirtyIds = cache?.dirty.get(scope);
  if (cached?.ordered && !dirtyIds)
    return cached.ordered as Array<{ key: string; value: T }>;
  if (cached?.ordered && cached.positions && cached.maxPosition !== undefined && dirtyIds) {
    const updated = readChangedRowsInPlace<T>(database, table, params, cached as Parameters<typeof readChangedRowsInPlace>[3], dirtyIds);
    if (updated) return updated as Array<{ key: string; value: T }>;
  }
  const cold = !cached;
  const rows = database.prepare(`SELECT id, position${cold ? ", value" : ""} FROM ${table} ${where} ORDER BY position`).all(...params);
  const valuesById = cached?.values ?? new Map<string, unknown>();
  const dirty = dirtyIds;
  const changedIds = cold ? [] : rows.map((row) => String(row.id))
    .filter((id) => dirty?.has(id) || !valuesById.has(id));
  // One indexed query replaces N per-row SELECTs. Only changed bodies cross
  // into JS; the ordered id scan and unchanged object identities stay cheap.
  const changed = changedIds.length > 0
    ? database.prepare(`SELECT id, value FROM ${table} WHERE ${params.length > 0 ? "run_id = ? AND " : ""}id IN (SELECT value FROM json_each(?))`)
      .all(...params, JSON.stringify(changedIds))
    : [];
  const rawById = new Map(changed.map((row) => [String(row.id), row.value]));
  const positions = new Map<string, number>();
  let maxPosition = -Infinity;
  let ascending = true;
  const values = rows.map((row) => {
    const id = String(row.id);
    const position = Number(row.position);
    if (!(position > maxPosition)) ascending = false;
    maxPosition = Math.max(maxPosition, position);
    positions.set(id, position);
    if (!cold && !dirty?.has(id) && valuesById.has(id))
      return { key: id, value: valuesById.get(id) as T };
    const raw = cold ? row.value : rawById.get(id);
    const parsed = frozen(parseRow<T>(table, id, raw));
    valuesById.set(id, parsed);
    return { key: id, value: parsed };
  });
  if (cache) {
    // Equal positions have no defined order; such a scope is always read whole.
    cache.scopes.set(scope, ascending
      ? { runId, values: valuesById, ordered: values, positions, maxPosition }
      : { runId, values: valuesById, ordered: values });
    const present = new Set(rows.map((row) => String(row.id)));
    for (const id of valuesById.keys()) if (!present.has(id)) valuesById.delete(id);
  }
  return values;
}

const rowValueLists = new WeakMap<object, unknown[]>();

function readRows<T>(database: DatabaseSync, table: string, where = "", params: string[] = [], cache?: DiscoveryDisplayRowCache): T[] {
  const keyed = readKeyedRows<T>(database, table, where, params, cache);
  // An unchanged scope returns the same keyed list; keep its value list too.
  let values = rowValueLists.get(keyed) as T[] | undefined;
  if (!values) {
    // Frozen here, in one native step: the state built around it is frozen
    // next, and walking 30,000 ledger rows one by one for that on every
    // refresh cost several milliseconds.
    values = Object.freeze(keyed.map(({ value }) => value)) as T[];
    if (cache) rowValueLists.set(keyed, values);
  }
  return values;
}

function readRun(database: DatabaseSync, row: { id: unknown; value: unknown }, includeCheckpoints: boolean, cache?: DiscoveryDisplayRowCache): DiscoveryRunRecord {
  const id = String(row.id);
  // A display run whose own row, sources and log are unchanged is the run
  // read last time: same object, so later identity checks stay cheap.
  const raw = String(row.value);
  const previous = !includeCheckpoints ? cache?.runs?.get(id) : undefined;
  if (
    previous &&
    previous.raw === raw &&
    !cache?.dirty.has(discoveryRowScope("discovery_run_targets", id)) &&
    !cache?.dirty.has(discoveryRowScope("discovery_run_activity", id)) &&
    cache?.scopes.get(discoveryRowScope("discovery_run_targets", id))?.ordered &&
    cache?.scopes.get(discoveryRowScope("discovery_run_activity", id))?.ordered
  )
    return previous.run;
  const metadata = parseRow<ReturnType<typeof RUN_METADATA.parse>>("discovery_runs", id, row.value);
  const targets = readKeyedRows<TargetMetadata>(database, "discovery_run_targets", "WHERE run_id = ?", [id], cache);
  const checkpointRows = includeCheckpoints ? database.prepare("SELECT id, value FROM discovery_run_checkpoints WHERE run_id = ?").all(id) : [];
  const checkpoints = new Map(checkpointRows.map((checkpoint) => [String(checkpoint.id), frozen(parseRow<BrowserAgentRunCheckpoint>("discovery_run_checkpoints", `${id}/${String(checkpoint.id)}`, checkpoint.value))]));
  const executions = targets.map(({ key, value }) => frozen({ ...value, agentCheckpoint: checkpoints.get(key) ?? null }));
  const activity = readRows<DiscoveryActivityEvent>(database, "discovery_run_activity", "WHERE run_id = ?", [id], cache);
  const run = frozen({ ...metadata, targetExecutions: executions, activity });
  if (cache && !includeCheckpoints) (cache.runs ??= new Map()).set(id, { raw, run });
  return run;
}

export function readDiscoveryStorage(database: DatabaseSync, fallback: JobFinderDiscoveryState, includeCheckpoints = true, cache?: DiscoveryDisplayRowCache): JobFinderDiscoveryState {
  const row = database.prepare("SELECT value FROM singleton_state WHERE key = 'discovery_state'").get();
  if (!row) {
    cache?.scopes.clear();
    cache?.dirty.clear();
    cache?.runs?.clear();
    return frozen(JobFinderDiscoveryStateSchema.parse(fallback));
  }
  const small = parseRow<SmallState>("singleton_state", "discovery_state", row.value);
  const runs = database.prepare("SELECT id, active, value FROM discovery_runs ORDER BY active DESC, position").all() as Array<{ id: string; active: number; value: string }>;
  if (cache) {
    const presentRuns = new Set(runs.map((run) => String(run.id)));
    for (const [scope, value] of cache.scopes) {
      if (value.runId && !presentRuns.has(value.runId)) {
        cache.scopes.delete(scope);
        cache.dirty.delete(scope);
      }
    }
    for (const runId of cache.runs?.keys() ?? []) {
      if (!presentRuns.has(runId)) cache.runs?.delete(runId);
    }
  }
  const active = runs.find((run) => Number(run.active) === 1);
  const recent = runs.filter((run) => Number(run.active) !== 1);
  return frozen({
    ...small,
    activeRun: active ? readRun(database, active, includeCheckpoints, cache) : null,
    recentRuns: recent.map((run) => readRun(database, run, includeCheckpoints, cache)),
    discoveryLedger: readRows<DiscoveryLedgerEntry>(database, "discovery_ledger", "", [], cache),
    pendingDiscoveryJobs: readRows<SavedJob>(database, "discovery_pending_jobs", "", [], cache),
  });
}

/**
 * Row keys of a stored list, by list. The rows' own ids when they are unique
 * (always, in practice); `keyedRows` otherwise. A save that changes one
 * ledger entry among 30,000 used to rebuild these for both lists.
 */
const rowKeyLists = new WeakMap<readonly object[], readonly string[]>();

function rowKeys<T extends { id: string }>(rows: readonly T[]): readonly string[] {
  let keys = rowKeyLists.get(rows);
  if (!keys) {
    const ids = rows.map((row) => row.id);
    keys = new Set(ids).size === ids.length ? ids : keyedRows(rows).map(({ key }) => key);
    rowKeyLists.set(rows, keys);
  }
  return keys;
}

const rowsByKeyLists = new WeakMap<readonly object[], ReadonlyMap<string, object>>();

function rowsByKey<T extends { id: string }>(rows: readonly T[]): ReadonlyMap<string, T> {
  let byKey = rowsByKeyLists.get(rows) as ReadonlyMap<string, T> | undefined;
  if (!byKey) {
    const keys = rowKeys(rows);
    byKey = new Map(rows.map((row, index) => [keys[index]!, row]));
    rowsByKeyLists.set(rows, byKey);
  }
  return byKey;
}

/** Keep the largest already-ordered subsequence at its persisted ranks. */
function orderedRanks(keys: readonly string[], previous: Map<string, number>): number[] {
  const known = keys.map((key) => previous.get(key));
  // The usual feedback/checkpoint moves a few sightings to the end. Its
  // ordered prefix already has valid ranks; finding an LIS for every one of
  // 37,000 untouched rows adds work without changing the chosen anchors.
  let prefix = 0;
  let previousRank = -Infinity;
  while (prefix < known.length) {
    const rank = known[prefix];
    if (rank === undefined || !(rank > previousRank)) break;
    previousRank = rank;
    prefix += 1;
  }
  if (prefix === known.length) return known as number[];
  if (known.length >= 256 && prefix >= known.length * 0.9 && known.length - prefix <= 2_048 &&
      known.slice(prefix).every((rank) => rank === undefined || rank <= previousRank)) {
    let maximum = previousRank;
    for (const rank of previous.values()) maximum = Math.max(maximum, rank);
    const ranks = known.slice(0, prefix) as number[];
    for (let index = prefix; index < known.length; index += 1)
      ranks.push(maximum + index - prefix + 1);
    if (
      ranks.every(
        (rank, index) =>
          Number.isFinite(rank) && (index === 0 || rank > ranks[index - 1]!),
      )
    )
      return ranks;
  }
  const tails: number[] = [];
  // Each index's predecessor in the subsequence (-1: none), and the anchors.
  const links = new Int32Array(keys.length).fill(-1);
  for (const [index, rank] of known.entries()) {
    if (rank === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (known[tails[middle]!]! < rank) low = middle + 1;
      else high = middle;
    }
    if (low > 0) links[index] = tails[low - 1]!;
    tails[low] = index;
  }
  const anchorFlags = new Uint8Array(keys.length);
  const anchors = { has: (index: number) => anchorFlags[index] === 1 };
  let cursor = tails.at(-1) ?? -1;
  while (cursor >= 0) {
    anchorFlags[cursor] = 1;
    cursor = links[cursor]!;
  }
  const ranks: number[] = [];
  let maximum = -1;
  for (const rank of previous.values()) maximum = Math.max(maximum, rank);
  let start = 0;
  for (let end = 0; end <= keys.length; end += 1) {
    if (end < keys.length && !anchors.has(end)) continue;
    const right = end < keys.length ? known[end]! : undefined;
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

function writeChangedRows<T extends { id: string }>(database: DatabaseSync, table: string, before: readonly T[], after: readonly T[], aliases: WeakMap<object, object>, runId?: string, positionCache?: PositionCache): T[] {
  if (before === after) return before as T[];
  const patch =
    table === "discovery_ledger"
      ? discoveryLedgerPatches.get(after)
      : undefined;
  if (patch?.before === before) {
    const result = after.slice();
    let maximum: number | null = null;
    for (const { index, previousIndex, moveToEnd } of patch.rows) {
      const row = after[index]!;
      const old = previousIndex === undefined ? undefined : before[previousIndex];
      const parsed =
        old === row || (old && aliases.get(row) === old)
          ? old
          : frozen(row);
      if (old && !moveToEnd && JSON.stringify(old) === JSON.stringify(parsed)) {
        result[index] = old;
      } else {
        let position: number;
        if (old && !moveToEnd)
          position = Number(
            statement(
              database,
              "SELECT position FROM discovery_ledger WHERE id = ?",
            ).get(row.id)?.position,
          );
        else {
          maximum ??= Number(
            statement(
              database,
              "SELECT COALESCE(MAX(position), -1) AS maximum FROM discovery_ledger",
            ).get()?.maximum,
          );
          position = ++maximum;
        }
        replaceRow(database, table, [row.id, position], parsed);
        result[index] = parsed;
      }
      frozen(row);
      aliases.set(row, result[index]);
    }
    // Existing ranks did not move. Appends invalidate the generic writer's
    // position cache; it can rebuild that cache if a later write reorders rows.
    positionCache?.delete(`${table}\u0000`);
    Object.freeze(result);
    adoptDiscoveryLedgerIndex(after, result);
    return result;
  }
  if (before.length === after.length && before.every((row, index) => row === after[index] || aliases.get(after[index]!) === row)) return before as T[];
  const cacheKey = `${table}\u0000${runId ?? ""}`;
  let positions = positionCache?.get(cacheKey);
  if (!positions) {
    positions = new Map(statement(database, `SELECT id, position FROM ${table}${runId ? " WHERE run_id = ?" : ""}`).all(...(runId ? [runId] : []))
      .map((row) => [String(row.id), Number(row.position)]));
    positionCache?.set(cacheKey, positions);
  }
  const nextKeys = rowKeys(after);
  const ranks = orderedRanks(nextKeys, positions);
  const previous = rowsByKey(before);
  const nextKeySet = new Set(nextKeys);
  const result: T[] = [];
  const resultByKey = new Map<string, T>();
  after.forEach((row, index) => {
    const key = nextKeys[index]!;
    const position = ranks[index]!;
    const old = previous.get(key);
    // Read before this row's own write below changes it.
    const previousPosition = old ? positions.get(key) : undefined;
    // Unchanged rows retain their validated, frozen identity. Updaters must
    // build a new row when changing a value.
    if (old === row || (old && aliases.get(row) === old)) {
      if (previousPosition !== position) {
        statement(database, `UPDATE ${table} SET position = ? WHERE ${runId ? "run_id = ? AND " : ""}id = ?`).run(...(runId ? [position, runId, key] : [position, key]));
        positions.set(key, position);
      }
      result.push(old);
      resultByKey.set(key, old);
      return;
    }
    const parsed = frozen(row);
    const same = old && JSON.stringify(old) === JSON.stringify(parsed);
    if (!same) {
      replaceRow(database, table, runId ? [runId, key, position] : [key, position], parsed);
      positions.set(key, position);
    } else if (previousPosition !== position) {
      statement(database, `UPDATE ${table} SET position = ? WHERE ${runId ? "run_id = ? AND " : ""}id = ?`).run(...(runId ? [position, runId, key] : [position, key]));
      positions.set(key, position);
    }
    const stored = same && old ? old : parsed;
    // The service may reuse its original row on later checkpoints. Freeze it
    // now so identity reuse cannot hide a later in-place edit.
    frozen(row);
    aliases.set(row, stored);
    result.push(stored);
    resultByKey.set(key, stored);
  });
  for (const key of previous.keys()) if (!nextKeySet.has(key)) {
    statement(database, `DELETE FROM ${table} WHERE ${runId ? "run_id = ? AND " : ""}id = ?`).run(...(runId ? [runId, key] : [key]));
    positions.delete(key);
  }
  // The stored list is the next save's "before": it has the same keys.
  // Frozen here in one native step; the state around it is frozen next, and
  // walking a 30,000-row ledger row by row for that cost each save
  // milliseconds.
  Object.freeze(result);
  rowKeyLists.set(result, nextKeys);
  rowsByKeyLists.set(result, resultByKey);
  return result;
}

// The run metadata text a stored run was written with, so the next save
// compares against it without validating the stored run again.
const storedRunMetadataText = new WeakMap<object, string>();

function runMetadata(run: DiscoveryRunRecord): ReturnType<typeof RUN_METADATA.parse> {
  const metadata: Partial<DiscoveryRunRecord> = { ...run };
  delete metadata.targetExecutions;
  delete metadata.activity;
  return metadata as ReturnType<typeof RUN_METADATA.parse>;
}

function targetMetadata(target: Target): TargetMetadata {
  const metadata: Partial<Target> = { ...target };
  delete metadata.agentCheckpoint;
  return metadata as TargetMetadata;
}

function writeRun(database: DatabaseSync, before: DiscoveryRunRecord | null, next: DiscoveryRunRecord, key: string, position: number, active: boolean, aliases: WeakMap<object, object>, positionCache?: PositionCache): DiscoveryRunRecord {
  const metadata = runMetadata(next);
  const metadataText = JSON.stringify(metadata);
  const oldMetadataText = before
    ? (storedRunMetadataText.get(before) ?? JSON.stringify(runMetadata(before)))
    : null;
  if (oldMetadataText === null || oldMetadataText !== metadataText) {
    replaceRow(database, "discovery_runs", [key, position, active ? 1 : 0], metadata);
  } else {
    statement(database, "UPDATE discovery_runs SET position = ?, active = ? WHERE id = ? AND (position <> ? OR active <> ?)").run(position, active ? 1 : 0, key, position, active ? 1 : 0);
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
        statement(database, "UPDATE discovery_run_targets SET position = ? WHERE run_id = ? AND id = ?").run(index, key, targetKey);
      targets.push(old);
      return;
    }
    const parsedMetadata = targetMetadata(target);
    // A stored target is its validated metadata plus its checkpoint.
    const oldParsedMetadata = old ? targetMetadata(old) : undefined;
    if (!oldParsedMetadata || JSON.stringify(oldParsedMetadata) !== JSON.stringify(parsedMetadata))
      replaceRow(database, "discovery_run_targets", [key, targetKey, index], parsedMetadata);
    else if (previousTarget?.index !== index)
      statement(database, "UPDATE discovery_run_targets SET position = ? WHERE run_id = ? AND id = ?").run(index, key, targetKey);
    const checkpoint = target.agentCheckpoint;
    const oldCheckpoint = old?.agentCheckpoint;
    let storedCheckpoint = oldCheckpoint;
    if (checkpoint !== oldCheckpoint) {
      if (!checkpoint) {
        if (oldCheckpoint) statement(database, "DELETE FROM discovery_run_checkpoints WHERE run_id = ? AND id = ?").run(key, targetKey);
        storedCheckpoint = null;
      } else if (!oldCheckpoint || checkpoint.revision !== oldCheckpoint.revision || checkpoint.savedAt !== oldCheckpoint.savedAt || JSON.stringify(checkpoint) !== JSON.stringify(oldCheckpoint)) {
        storedCheckpoint = frozen(checkpoint);
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
  const activity = writeChangedRows(database, "discovery_run_activity", before?.activity ?? [], next.activity, aliases, key, positionCache);
  const stored = frozen({ ...metadata, targetExecutions: targets, activity });
  storedRunMetadataText.set(stored, metadataText);
  return stored;
}

export function updateDiscoveryStorage(database: DatabaseSync, before: JobFinderDiscoveryState, proposed: JobFinderDiscoveryState, aliases: WeakMap<object, object>, positionCache?: PositionCache): JobFinderDiscoveryState {
  const small = smallValue(proposed);
  const oldSmall = smallValue(before);
  if (JSON.stringify(small) !== JSON.stringify(oldSmall)) writeSmall(database, proposed);
  else {
    // Every applied commit remains a visible revision, including a no-op.
    statement(database, "UPDATE singleton_state SET revision = revision + 1 WHERE key = 'discovery_state'").run();
  }
  const beforeRuns = new Map(keyedRows([before.activeRun, ...before.recentRuns].filter((run): run is DiscoveryRunRecord => run !== null)).map(({ key, row }, index) => [key, { row, index, active: index === 0 && before.activeRun !== null }]));
  const afterRuns = keyedRows([proposed.activeRun, ...proposed.recentRuns].filter((run): run is DiscoveryRunRecord => run !== null));
  const storedRuns = afterRuns.map(({ key, row }, index) => {
    const old = beforeRuns.get(key);
    const active = index === 0 && proposed.activeRun !== null;
    if (old?.row === row && old.index === index && old.active === active) return old.row;
    return writeRun(database, old?.row ?? null, row, key, index, active, aliases, positionCache);
  });
  const afterKeys = new Set(afterRuns.map(({ key }) => key));
  for (const id of beforeRuns.keys()) if (!afterKeys.has(id)) {
    // Removing the header invalidates the whole run. Its child rows no longer
    // need thousands of individual display/cache notifications as they go.
    database.prepare("DELETE FROM discovery_runs WHERE id = ?").run(id);
    for (const table of ["discovery_run_checkpoints", "discovery_run_activity", "discovery_run_targets"]) database.prepare(`DELETE FROM ${table} WHERE run_id = ?`).run(id);
  }
  const ledger = writeChangedRows(database, "discovery_ledger", before.discoveryLedger, proposed.discoveryLedger, aliases, undefined, positionCache);
  const pending = writeChangedRows(database, "discovery_pending_jobs", before.pendingDiscoveryJobs, proposed.pendingDiscoveryJobs, aliases, undefined, positionCache);
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
      const retiredChild = event === "DELETE" && table.startsWith("discovery_run_");
      database.exec(`CREATE TEMP TRIGGER discovery_canonical_${table}_${event.toLowerCase()}
        AFTER ${event} ON main.${table}
        ${retiredChild ? "WHEN EXISTS (SELECT 1 FROM discovery_runs WHERE id = OLD.run_id)" : ""}
        BEGIN UPDATE discovery_canonical_epoch SET revision = revision + 1; END`);
    }
  }
  const aliases = new WeakMap<object, object>();
  // Trusted only while this connection was the last to change the tables:
  // confirmed after a commit, dropped by any other change or a rollback.
  let positions: PositionCache | null = null;
  let positionsEpoch = -1;
  let positionsVersion = -1;
  let unconfirmedPositions: PositionCache | null = null;
  let cached: JobFinderDiscoveryState | null = null;
  let cachedEpoch = -1;
  let cachedVersion = -1;
  let pendingSessionCache: JobFinderDiscoveryState | null = null;
  const epoch = () => Number(database.prepare("SELECT revision FROM discovery_canonical_epoch").get()?.revision ?? 0);
  const version = () => Number(database.prepare("PRAGMA data_version").get()?.data_version ?? 0);
  return {
    peek(): JobFinderDiscoveryState | null {
      return !database.isTransaction && cached && epoch() === cachedEpoch && version() === cachedVersion ? cached : null;
    },
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
      const positionCache: PositionCache =
        positions && epoch() === positionsEpoch && version() === positionsVersion ? positions : new Map<string, Map<string, number>>();
      positions = null;
      unconfirmedPositions = positionCache;
      return updateDiscoveryStorage(database, before, proposed, aliases, positionCache);
    },
    /**
     * Browser session states live in the small singleton row. Writing them
     * through `update` read every run, log and checkpoint first: about 0.4 s
     * of the main process on each start with a large search history. Caller
     * owns the transaction; a current cached state stays current.
     */
    updateSessions(
      change: (sessions: JobFinderDiscoveryState["sessions"]) => JobFinderDiscoveryState["sessions"],
    ): JobFinderDiscoveryState["sessions"] {
      pendingSessionCache = null;
      const cacheWasCurrent = cached !== null && epoch() === cachedEpoch && version() === cachedVersion;
      const row = database.prepare("SELECT value FROM singleton_state WHERE key = 'discovery_state'").get();
      const small = row
        ? parseRow<SmallState>("singleton_state", "discovery_state", row.value)
        : smallValue(JobFinderDiscoveryStateSchema.parse(fallback));
      const sessions = frozen(change(small.sessions));
      writeSmall(database, { ...small, sessions } as JobFinderDiscoveryState);
      if (cacheWasCurrent && cached) {
        pendingSessionCache = frozen({ ...cached, sessions });
      }
      return sessions;
    },
    /** After the sessions commit: keep the cache current without a re-read. */
    publishSessions(): void {
      if (database.isTransaction) throw new Error("Discovery snapshots can only be published after commit.");
      if (pendingSessionCache) {
        cached = pendingSessionCache;
        cachedEpoch = epoch();
        cachedVersion = version();
      }
      pendingSessionCache = null;
    },
    publish(state: JobFinderDiscoveryState): void {
      if (database.isTransaction) throw new Error("Discovery snapshots can only be published after commit.");
      pendingSessionCache = null;
      cached = state;
      cachedEpoch = epoch();
      cachedVersion = version();
      if (unconfirmedPositions) {
        positions = unconfirmedPositions;
        positionsEpoch = cachedEpoch;
        positionsVersion = cachedVersion;
        unconfirmedPositions = null;
      }
    },
  };
}
