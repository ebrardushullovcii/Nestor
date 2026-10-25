import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  DiscoveryLedgerEntrySchema,
  JobFinderDiscoveryStateSchema,
} from "@nestor/contracts";
import {
  discoveryLedgerValueSql,
  migrateDiscoveryLedgerStorage,
  writeDiscoveryLedgerRows,
} from "./discovery-ledger-storage";
import { readDiscoveryStorage } from "./discovery-storage";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function legacy() {
  const directory = mkdtempSync(path.join(tmpdir(), "nestor-ledger30-"));
  const file = path.join(directory, "workspace.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE discovery_ledger(id TEXT PRIMARY KEY,position INTEGER,value TEXT);`);
  cleanup.push(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const rows = [
    undefined,
    null,
    {
      key: "screen",
      verdict: "keep",
      category: null,
      reason: "Synthetic evidence",
    },
  ].map((listingScreen, index) =>
    DiscoveryLedgerEntrySchema.parse({
      id: `synthetic_${index}`,
      canonicalUrl: `https://example.test/jobs/${index}`,
      source: "target_site",
      targetId: "synthetic",
      title: 'Role "日本語" \\ path\n🚀\u0000'.repeat(50),
      firstSeenAt: "2026-10-23T00:00:00.000Z",
      lastSeenAt: "2026-10-23T00:00:00.000Z",
      ...(listingScreen === undefined ? {} : { listingScreen }),
    }),
  );
  rows.forEach((row, position) =>
    db
      .prepare("INSERT INTO discovery_ledger VALUES (?,?,?)")
      .run(row.id, position, JSON.stringify(row)),
  );
  const read = () =>
    db
      .prepare(
        `SELECT ${discoveryLedgerValueSql()} AS value FROM discovery_ledger ORDER BY position`,
      )
      .all()
      .map((row) => JSON.parse(String(row.value)) as (typeof rows)[number]);
  return { db, file, rows, read };
}

test("migration 30 retains every canonical field, optional null and immutable legacy backup", () => {
  const { db, file, rows, read } = legacy();
  migrateDiscoveryLedgerStorage(db);
  expect(read()).toEqual(rows);
  const backup = new DatabaseSync(`${file}.before-v30.sqlite`, {
    readOnly: true,
  });
  try {
    expect(
      backup
        .prepare("SELECT value FROM discovery_ledger ORDER BY position")
        .all()
        .map((row) => row.value),
    ).toEqual(rows.map((row) => JSON.stringify(row)));
  } finally {
    backup.close();
  }
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM discovery_ledger WHERE json_type(value,'$.lastSeenAt') IS NOT NULL",
      )
      .get()?.n,
  ).toBe(0);
  migrateDiscoveryLedgerStorage(db);
  expect(read()).toEqual(rows);
});

test("a sighting changes only observation columns and an aborted batch restores both tables", () => {
  const { db, rows, read } = legacy();
  migrateDiscoveryLedgerStorage(db);
  const before = db
    .prepare("SELECT rowid,value FROM discovery_ledger ORDER BY position")
    .all();
  db.exec(
    "CREATE TRIGGER forbid_body BEFORE UPDATE OF value ON discovery_ledger BEGIN SELECT RAISE(ABORT,'body rewritten'); END",
  );
  const next = rows.map((row) => ({
    ...row,
    lastSeenAt: "2026-10-24T00:00:00.000Z",
    inactiveAt: "2026-10-24T00:00:00.000Z",
    titleTriageOutcome: "skip_title" as const,
    listingScreen: null,
  }));
  db.exec("BEGIN IMMEDIATE");
  writeDiscoveryLedgerRows(
    db,
    next.map((row, position) => ({
      key: row.id,
      position,
      row,
      previous: rows[position],
    })),
  );
  db.exec("COMMIT");
  expect(read()).toEqual(next);
  expect(
    db
      .prepare("SELECT rowid,value FROM discovery_ledger ORDER BY position")
      .all(),
  ).toEqual(before);
  db.exec(
    "CREATE TRIGGER fail_observation BEFORE INSERT ON discovery_ledger_observations WHEN NEW.id='synthetic_2' BEGIN SELECT RAISE(ABORT,'late failure'); END",
  );
  db.exec("BEGIN IMMEDIATE");
  expect(() =>
    writeDiscoveryLedgerRows(
      db,
      rows.map((row, position) => ({
        key: row.id,
        position,
        row,
        previous: next[position],
      })),
    ),
  ).toThrow("late failure");
  db.exec("ROLLBACK");
  expect(read()).toEqual(next);
});

test("failed conversion rolls schema and values back; full external edits still reconstruct", () => {
  const { db, rows, read } = legacy();
  db.exec(
    "CREATE TRIGGER fail_conversion BEFORE UPDATE ON discovery_ledger BEGIN SELECT RAISE(ABORT,'conversion failed'); END",
  );
  expect(() => migrateDiscoveryLedgerStorage(db)).toThrow("conversion failed");
  expect(
    db.prepare("SELECT 1 FROM schema_migrations WHERE version=30").get(),
  ).toBeUndefined();
  expect(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name='discovery_ledger_observations'",
      )
      .get(),
  ).toBeUndefined();
  expect(
    db
      .prepare("SELECT value FROM discovery_ledger ORDER BY position")
      .all()
      .map((row) => row.value),
  ).toEqual(rows.map((row) => JSON.stringify(row)));
  db.exec("DROP TRIGGER fail_conversion");
  migrateDiscoveryLedgerStorage(db);
  const changed = {
    ...rows[0]!,
    lastSeenAt: "2026-10-24T01:00:00.000Z",
    title: "External evidence",
    listingScreen: null,
  };
  db.prepare("UPDATE discovery_ledger SET value=? WHERE id=?").run(
    JSON.stringify(changed),
    changed.id,
  );
  expect(read()[0]).toEqual(changed);
});

test("a missing observation fails the canonical read instead of returning an incomplete entry", () => {
  const { db } = legacy();
  migrateDiscoveryLedgerStorage(db);
  db.exec(`CREATE TABLE singleton_state(key TEXT,value TEXT);
    INSERT INTO singleton_state VALUES ('discovery_state','{}');
    CREATE TABLE discovery_runs(id TEXT,active INTEGER,value TEXT,progress TEXT,position INTEGER);
    DELETE FROM discovery_ledger_observations WHERE id='synthetic_0';`);
  expect(() =>
    readDiscoveryStorage(db, JobFinderDiscoveryStateSchema.parse({})),
  ).toThrow('Corrupted persisted row in table "discovery_ledger"');
});
