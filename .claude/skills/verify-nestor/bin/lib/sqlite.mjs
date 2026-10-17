// Read the instance's SQLite files from a private copy, never the live file.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function snapshot(file, scratch) {
  mkdirSync(scratch, { recursive: true });
  const copy = path.join(scratch, path.basename(file));
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(copy + suffix, { force: true });
    if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
  }
  return copy;
}

export function databases(userDataDir) {
  if (!existsSync(userDataDir)) return [];
  return readdirSync(userDataDir)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => path.join(userDataDir, name));
}

function open(file, scratch) {
  return new DatabaseSync(snapshot(file, scratch), { readOnly: false });
}

export function tables(userDataDir, scratch) {
  return databases(userDataDir).map((file) => {
    const db = open(file, scratch);
    try {
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all();
      return {
        database: path.basename(file),
        tables: rows.map(({ name }) => ({
          name,
          rows: db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n,
        })),
      };
    } finally {
      db.close();
    }
  });
}

/**
 * Newest rows of a table, optionally only rows whose text contains `pattern`.
 * JSON-looking text columns are parsed so the evidence is readable.
 */
export function rows(userDataDir, scratch, table, { limit = 5, pattern } = {}) {
  if (!NAME.test(table)) throw new Error(`Not a table name: ${table}`);
  for (const file of databases(userDataDir)) {
    const db = open(file, scratch);
    try {
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table);
      if (!exists) continue;
      const columns = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((c) => c.name);
      const order = ["updated_at", "created_at", "at", "rowid"].find(
        (c) => c === "rowid" || columns.includes(c),
      );
      const where = pattern
        ? `WHERE ${columns.map((c) => `CAST("${c}" AS TEXT) LIKE ?`).join(" OR ")}`
        : "";
      const params = pattern ? columns.map(() => `%${pattern}%`) : [];
      const found = db
        .prepare(
          `SELECT * FROM "${table}" ${where} ORDER BY ${order === "rowid" ? "rowid" : `"${order}"`} DESC LIMIT ?`,
        )
        .all(...params, Number(limit))
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => {
              if (typeof value === "string" && /^[[{]/.test(value))
                try {
                  return [key, JSON.parse(value)];
                } catch {}
              return [key, value];
            }),
          ),
        );
      return { database: path.basename(file), table, rows: found };
    } finally {
      db.close();
    }
  }
  throw new Error(`No table ${table} in ${userDataDir}`);
}

/** One file per read, so every action's rows stay in the evidence. */
export function saveRows(evidenceDir, result, name = result.table) {
  const time = new Date().toISOString().slice(11, 19).replaceAll(":", "");
  const file = path.join(evidenceDir, `db-${time}-${name}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}
