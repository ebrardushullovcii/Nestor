import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { DiscoveryLedgerEntry } from "@nestor/contracts";
import { isDeepStrictEqual } from "node:util";
import { backupBeforeStorageMigration } from "./storage-migration-backup";

const mutable = new Set([
  "lastSeenAt",
  "inactiveAt",
  "titleTriageOutcome",
  "listingScreen",
]);
const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function statement(db: DatabaseSync, sql: string): StatementSync {
  let statements = cache.get(db);
  if (!statements)
    cache.set(db, (statements = new Map<string, StatementSync>()));
  let value = statements.get(sql);
  if (!value) statements.set(sql, (value = db.prepare(sql)));
  return value;
}

/** Complete canonical JSON; SQL NULL distinguishes an absent optional screen. */
export function discoveryLedgerValueSql(alias = "discovery_ledger"): string {
  const value = `json_set(${alias}.value,
    '$.lastSeenAt', observation.last_seen_at,
    '$.inactiveAt', observation.inactive_at,
    '$.titleTriageOutcome', observation.title_triage_outcome)`;
  return `(SELECT CASE WHEN observation.listing_screen IS NULL
    THEN ${value} ELSE json_set(${value}, '$.listingScreen', json(observation.listing_screen)) END
    FROM discovery_ledger_observations observation WHERE observation.id = ${alias}.id)`;
}

export function migrateDiscoveryLedgerStorage(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = 30").get()) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='discovery_ledger_observations'",
        )
        .get()
    )
      throw new Error(
        "Discovery ledger observation storage is missing; refusing to replace historical data.",
      );
    return;
  }
  if (db.prepare("SELECT 1 FROM discovery_ledger LIMIT 1").get())
    backupBeforeStorageMigration(db, 30);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE discovery_ledger_observations (
      id TEXT PRIMARY KEY REFERENCES discovery_ledger(id) ON DELETE CASCADE,
      last_seen_at TEXT NOT NULL, inactive_at TEXT,
      title_triage_outcome TEXT NOT NULL, listing_screen TEXT
    );
    INSERT INTO discovery_ledger_observations
      SELECT id, json_extract(value, '$.lastSeenAt'), json_extract(value, '$.inactiveAt'),
        json_extract(value, '$.titleTriageOutcome'),
        CASE WHEN json_type(value, '$.listingScreen') IS NULL THEN NULL
          ELSE json_quote(json_extract(value, '$.listingScreen')) END
      FROM discovery_ledger;
    UPDATE discovery_ledger SET value = json_remove(value,
      '$.lastSeenAt', '$.inactiveAt', '$.titleTriageOutcome', '$.listingScreen');
    DROP INDEX IF EXISTS workspace_ledger_activity_idx;`);
    // Keep direct full-row import and external connection edits compatible.
    // Ordinary writers already split fields and never enter these triggers.
    for (const event of ["INSERT", "UPDATE OF value"]) {
      db.exec(`CREATE TRIGGER discovery_ledger_split_${event === "INSERT" ? "insert" : "update"}
        AFTER ${event} ON discovery_ledger
        WHEN json_type(NEW.value, '$.lastSeenAt') IS NOT NULL BEGIN
          INSERT INTO discovery_ledger_observations
          VALUES (NEW.id, json_extract(NEW.value, '$.lastSeenAt'), json_extract(NEW.value, '$.inactiveAt'),
            json_extract(NEW.value, '$.titleTriageOutcome'),
            CASE WHEN json_type(NEW.value, '$.listingScreen') IS NULL THEN NULL
              ELSE json_quote(json_extract(NEW.value, '$.listingScreen')) END)
          ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
            inactive_at=excluded.inactive_at, title_triage_outcome=excluded.title_triage_outcome,
            listing_screen=excluded.listing_screen;
          UPDATE discovery_ledger SET value=json_remove(NEW.value,
            '$.lastSeenAt', '$.inactiveAt', '$.titleTriageOutcome', '$.listingScreen') WHERE id=NEW.id;
        END`);
    }
    db.exec(
      "INSERT INTO schema_migrations(version,name) VALUES (30,'discovery_ledger_observation_columns'); COMMIT",
    );
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

type LedgerWrite = {
  key: string;
  position: number;
  row: DiscoveryLedgerEntry;
  previous?: DiscoveryLedgerEntry | undefined;
};

/** Caller owns the transaction; sightings never touch stable evidence pages. */
export function writeDiscoveryLedgerRows(
  db: DatabaseSync,
  writes: readonly LedgerWrite[],
): void {
  const bodies: Array<readonly [string, number, string]> = [];
  const observations: Array<
    readonly [string, string, string | null, string, string | null]
  > = [];
  for (const { key, position, row, previous } of writes) {
    const stableKeys = Object.keys(row).filter((field) => !mutable.has(field));
    const sameBody =
      previous &&
      stableKeys.length ===
        Object.keys(previous).filter((field) => !mutable.has(field)).length &&
      stableKeys.every((field) =>
        isDeepStrictEqual(
          Reflect.get(row, field),
          Reflect.get(previous, field),
        ),
      );
    if (!sameBody) {
      const body: Partial<DiscoveryLedgerEntry> = { ...row };
      delete body.lastSeenAt;
      delete body.inactiveAt;
      delete body.titleTriageOutcome;
      delete body.listingScreen;
      bodies.push([key, position, JSON.stringify(body)]);
    } else {
      statement(
        db,
        "UPDATE discovery_ledger SET position=? WHERE id=? AND position<>?",
      ).run(position, key, position);
    }
    if (
      previous &&
      [...mutable].every((field) =>
        isDeepStrictEqual(
          Reflect.get(row, field),
          Reflect.get(previous, field),
        ),
      )
    )
      continue;
    observations.push([
      key,
      row.lastSeenAt,
      row.inactiveAt,
      row.titleTriageOutcome,
      row.listingScreen === undefined
        ? null
        : JSON.stringify(row.listingScreen),
    ]);
  }
  for (let start = 0; start < bodies.length; start += 100) {
    const batch = bodies.slice(start, start + 100);
    statement(
      db,
      `INSERT INTO discovery_ledger(id,position,value) VALUES ${batch.map(() => "(?,?,?)").join(",")}
      ON CONFLICT(id) DO UPDATE SET position=excluded.position,value=excluded.value`,
    ).run(...batch.flat());
  }
  for (let start = 0; start < observations.length; start += 100) {
    const batch = observations.slice(start, start + 100);
    statement(
      db,
      `INSERT INTO discovery_ledger_observations VALUES ${batch.map(() => "(?,?,?,?,?)").join(",")}
      ON CONFLICT(id) DO UPDATE SET last_seen_at=excluded.last_seen_at,inactive_at=excluded.inactive_at,
        title_triage_outcome=excluded.title_triage_outcome,listing_screen=excluded.listing_screen
      WHERE last_seen_at IS NOT excluded.last_seen_at OR inactive_at IS NOT excluded.inactive_at
        OR title_triage_outcome IS NOT excluded.title_triage_outcome OR listing_screen IS NOT excluded.listing_screen`,
    ).run(...batch.flat());
  }
}
