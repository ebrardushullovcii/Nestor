import type { DatabaseSync, SQLOutputValue, StatementSync } from "node:sqlite";
import type { SchemaParser } from "../repository-types";
import { parsePersistedRowJson, validatePersistedRowValue } from "./state";

/**
 * Identity of the code that validates rows, normally a digest of the
 * main-process build. It may arrive after the reader is made.
 */
export type RowValidationStamp = PromiseLike<string | null> | string | null;

type StoredRow = Record<string, SQLOutputValue>;

/** A row's value: as stored if marked by this build, else through the schema. */
export type ParseMarkedRow = <T>(row: StoredRow, schema: SchemaParser<T>) => T;

export type RowValidationMarks = {
  /**
   * `id, value, validated_stamp FROM <table> ...` for a SELECT: the rows with
   * their marks. WHERE and ORDER BY may name the table's columns unqualified.
   */
  selectSql: string;
  /** The stamp if already known, otherwise null. */
  current(): string | null;
  /** The stamp, once known (rows read before then are validated). */
  settled(): Promise<string | null>;
  /**
   * Runs one synchronous read of `selectSql` rows, parsing each through
   * `parse`, and marks the rows it validated whose stored text is exactly
   * the schema's output. The read and its marks share one transaction, so a
   * mark never covers text written after it was read.
   */
  read<R>(run: (parse: ParseMarkedRow) => R): R;
};

/**
 * Which rows of a table a main-process build already validated, unchanged
 * since. Validating every saved job at start took about 3 s of CPU with
 * 20,000 jobs, and the resume drafts about 0.3 s. A row whose stored text is
 * exactly what this build's schema returns for it parses the same way again,
 * so the build marks it and its next start skips the schema for that row.
 * Marks live in the database with persistent triggers, so a write to a row
 * from any connection or build drops the row's mark, and a trigger gone
 * missing (a rebuilt table) drops every mark of that table. Returns null when
 * there is no stamp or marks cannot be kept; then every row is validated.
 */
export function createRowValidationMarks(
  database: DatabaseSync,
  table: string,
  stampSource: RowValidationStamp | undefined,
): RowValidationMarks | null {
  if (!stampSource || !prepareTable(database, table)) return null;
  let known: string | null = null;
  const settled = Promise.resolve(stampSource).then(
    (stamp) => {
      known = stamp;
      return stamp;
    },
    () => null,
  );
  const markRow: StatementSync = database.prepare(
    `INSERT OR REPLACE INTO row_validations
      (validated_table, validated_row_id, validated_stamp) VALUES (?, ?, ?)`,
  );

  function parseRow<T>(
    row: StoredRow,
    schema: SchemaParser<T>,
    stamp: string | null,
    validated: string[] | null,
  ): T {
    const rowId = String(row.id);
    const stored = parsePersistedRowJson({
      tableName: table,
      rowId,
      rawValue: String(row.value),
    });
    // This build validated exactly this text, and the schema returned it.
    if (stamp && row.validated_stamp === stamp) return stored as T;
    const value = validatePersistedRowValue({
      tableName: table,
      rowId,
      value: stored,
      schema,
    });
    if (validated && sameStoredJson(stored, value)) validated.push(rowId);
    return value;
  }

  return {
    selectSql: `${table}.id AS id, ${table}.value AS value,
        row_validations.validated_stamp AS validated_stamp
      FROM ${table} LEFT JOIN row_validations
        ON row_validations.validated_table = '${table}'
        AND row_validations.validated_row_id = ${table}.id`,
    current: () => known,
    settled: () => settled,
    read(run) {
      const stamp = known;
      // Inside someone else's transaction the rows may yet roll back.
      if (!stamp || database.isTransaction)
        return run((row, schema) => parseRow(row, schema, stamp, null));
      const validated: string[] = [];
      database.exec("BEGIN");
      let result: ReturnType<typeof run>;
      try {
        result = run((row, schema) => parseRow(row, schema, stamp, validated));
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      try {
        for (const id of validated) markRow.run(table, id, stamp);
        database.exec("COMMIT");
      } catch {
        // Another connection wrote since the read; a mark only saves work.
        if (database.isTransaction) database.exec("ROLLBACK");
      }
      return result;
    },
  };
}

function prepareTable(database: DatabaseSync, table: string): boolean {
  const triggers = {
    [`row_validations_${table}_insert`]: `AFTER INSERT ON ${table} BEGIN
      DELETE FROM row_validations WHERE validated_table = '${table}'
        AND validated_row_id = NEW.id; END`,
    [`row_validations_${table}_update`]: `AFTER UPDATE ON ${table} BEGIN
      DELETE FROM row_validations WHERE validated_table = '${table}'
        AND validated_row_id IN (OLD.id, NEW.id); END`,
    [`row_validations_${table}_delete`]: `AFTER DELETE ON ${table} BEGIN
      DELETE FROM row_validations WHERE validated_table = '${table}'
        AND validated_row_id = OLD.id; END`,
  };
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS row_validations (
      validated_table TEXT NOT NULL,
      validated_row_id TEXT NOT NULL,
      validated_stamp TEXT NOT NULL,
      PRIMARY KEY (validated_table, validated_row_id)
    ) WITHOUT ROWID`);
    const names = Object.keys(triggers);
    const present = Number(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger'
            AND tbl_name = ? AND name IN (SELECT value FROM json_each(?))`,
        )
        .get(table, JSON.stringify(names))?.count,
    );
    if (present === names.length) return true;
    const setUp = `DELETE FROM row_validations WHERE validated_table = '${table}';
      ${Object.entries(triggers)
        .map(
          ([name, body]) => `DROP TRIGGER IF EXISTS ${name};
            CREATE TRIGGER ${name} ${body};`,
        )
        .join("\n")}`;
    if (database.isTransaction) {
      database.exec(setUp);
      return true;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(setUp);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a schema's output is the stored JSON it was given, keys in the
 * same order. Anything JSON cannot hold (a Date, an undefined property) makes
 * it different, so such a row is validated on every read.
 */
function sameStoredJson(stored: unknown, parsed: unknown): boolean {
  if (stored === parsed) return true;
  if (
    typeof stored !== "object" ||
    typeof parsed !== "object" ||
    stored === null ||
    parsed === null
  )
    return false;
  if (Array.isArray(stored)) {
    if (!Array.isArray(parsed) || stored.length !== parsed.length)
      return false;
    for (let index = 0; index < stored.length; index += 1)
      if (!sameStoredJson(stored[index], parsed[index])) return false;
    return true;
  }
  if (
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  )
    return false;
  const storedRecord = stored as Record<string, unknown>;
  const parsedRecord = parsed as Record<string, unknown>;
  const storedKeys = Object.keys(storedRecord);
  const parsedKeys = Object.keys(parsedRecord);
  if (storedKeys.length !== parsedKeys.length) return false;
  for (let index = 0; index < storedKeys.length; index += 1) {
    const key = storedKeys[index]!;
    if (
      key !== parsedKeys[index] ||
      !sameStoredJson(storedRecord[key], parsedRecord[key])
    )
      return false;
  }
  return true;
}
