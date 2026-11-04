import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { rows } from "./sqlite.mjs";

function fixture(t, sql) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nestor-sqlite-helper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(root, "synthetic.sqlite"));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return (table, options) =>
    rows(root, path.join(root, "scratch"), table, options);
}

test("WITHOUT ROWID uses the complete primary key for ordering, filtering and limits", (t) => {
  const read = fixture(
    t,
    `CREATE TABLE listing_cards (
      source TEXT, listing INTEGER, payload TEXT,
      PRIMARY KEY (source, listing)
    ) WITHOUT ROWID;
    INSERT INTO listing_cards VALUES
      ('a', 2, '{"label":"older"}'),
      ('b', 1, '{"label":"skip"}'),
      ('a', 3, '{"label":"keep-a"}'),
      ('b', 2, '{"label":"keep-b"}');`,
  );
  const result = read("listing_cards", { limit: 3 });
  assert.equal(result.database, "synthetic.sqlite");
  assert.deepEqual(
    result.rows.map(({ source, listing }) => [source, listing]),
    [
      ["b", 2],
      ["b", 1],
      ["a", 3],
    ],
  );
  assert.deepEqual(read("listing_cards", { pattern: "keep", limit: 1 }).rows, [
    { source: "b", listing: 2, payload: { label: "keep-b" } },
  ]);
});

test("WITHOUT ROWID keeps timestamp priority and breaks ties by primary key", (t) => {
  const read = fixture(
    t,
    `CREATE TABLE snapshots (
      id TEXT PRIMARY KEY, updated_at INTEGER, created_at INTEGER
    ) WITHOUT ROWID;
    INSERT INTO snapshots VALUES ('b', 5, 99), ('c', 5, 1), ('a', 9, 0);`,
  );
  assert.deepEqual(
    read("snapshots").rows.map(({ id }) => id),
    ["a", "c", "b"],
  );
});

test("ordinary tables retain descending rowid fallback", (t) => {
  const read = fixture(
    t,
    `CREATE TABLE notes (label TEXT);
    INSERT INTO notes VALUES ('first'), ('second'), ('third');`,
  );
  assert.deepEqual(read("notes", { limit: 2 }).rows, [
    { label: "third" },
    { label: "second" },
  ]);
});

test("ordinary tables retain timestamp priority over rowid", (t) => {
  const read = fixture(
    t,
    `CREATE TABLE notes (label TEXT, updated_at INTEGER, created_at INTEGER);
    INSERT INTO notes VALUES ('first', 100, 1), ('second', 20, 200);`,
  );
  assert.deepEqual(
    read("notes").rows.map(({ label }) => label),
    ["first", "second"],
  );
});
