import type { SQLInputValue } from "node:sqlite";
import type { JobStore } from "./job-store";

export type FieldValue = string | number | boolean | null | undefined;
export type Fields = Record<string, FieldValue>;
export const column = (field: string) =>
  field.replaceAll(".", "_").replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const encode = (value: FieldValue): SQLInputValue =>
  typeof value === "boolean" ? Number(value) : (value ?? null);
export function flatten(value: unknown, keys: readonly string[]): Fields {
  return Object.fromEntries(
    keys.map((key) => {
      let item: unknown = value;
      for (const part of key.split("."))
        item =
          item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>)[part]
            : undefined;
      if (
        item !== undefined &&
        item !== null &&
        typeof item !== "string" &&
        typeof item !== "number" &&
        typeof item !== "boolean"
      )
        throw new Error(`Expected a scalar at ${key}`);
      return [key, item];
    }),
  );
}
export function inflate(
  fields: Record<string, unknown>,
  target: Record<string, unknown> = {},
): Record<string, unknown> {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const path = key.split(".");
    let parent = target;
    for (const part of path.slice(0, -1)) {
      const child = parent[part];
      if (!child || typeof child !== "object" || Array.isArray(child))
        parent[part] = {};
      parent = parent[part] as Record<string, unknown>;
    }
    parent[path.at(-1)!] = value;
  }
  return target;
}
export interface ScalarTable {
  name: string;
  fields: readonly string[];
  booleans: readonly string[];
  numbers: readonly string[];
  optional?: readonly string[];
}
export const scalarSchema = (table: ScalarTable) =>
  `CREATE TABLE IF NOT EXISTS ${table.name}(id INTEGER PRIMARY KEY CHECK(id=1),${table.fields.map((field) => `${quote(column(field))} ${table.booleans.includes(field) || table.numbers.includes(field) ? "INTEGER" : "TEXT"}`).join(",")});`;
export function createScalarValues(
  store: JobStore,
  table: ScalarTable,
  defaults: Fields,
) {
  const allowed = new Set(table.fields);
  const created = Boolean(
    store.transaction(
      () =>
        store
          .sql(
            `INSERT OR IGNORE INTO ${table.name}(id,${table.fields.map((field) => quote(column(field))).join(",")}) VALUES (1,${table.fields.map(() => "?").join(",")})`,
          )
          .run(...table.fields.map((field) => encode(defaults[field]))).changes,
    ),
  );
  const read = (keys: readonly string[] = table.fields): Fields => {
    if (!store.db.isOpen) throw new Error("The workspace changed or closed.");
    for (const key of keys)
      if (!allowed.has(key)) throw new Error(`Unknown field: ${key}`);
    const selected = keys
      .map((field) => `${quote(column(field))} AS ${quote(field)}`)
      .join(",");
    if (!keys.length) return {};
    const values = store
      .sql(`SELECT ${selected} FROM ${table.name} WHERE id=1`)
      .get() as Fields;
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value === null && table.optional?.includes(key)
          ? undefined
          : table.booleans.includes(key) && value !== null
            ? Boolean(value)
            : value,
      ]),
    );
  };
  return {
    created,
    read,
    patch(fields: Fields, expected: Fields = {}): boolean {
      const entries = Object.entries(fields).filter(
        (entry): entry is [string, Exclude<FieldValue, undefined>] =>
          entry[1] !== undefined,
      );
      for (const [key] of entries)
        if (!allowed.has(key)) throw new Error(`Unknown field: ${key}`);
      if (!entries.length) return false;
      const current = read(entries.map(([key]) => key));
      for (const [key] of entries)
        if (
          Object.hasOwn(expected, key) &&
          encode(expected[key]) !== encode(current[key])
        )
          throw new Error(
            `The saved ${key} changed while you were editing it. Reload this field and try again.`,
          );
      const changed = entries.filter(
        ([key, value]) => encode(value) !== encode(current[key]),
      );
      if (!changed.length) return false;
      store
        .sql(
          `UPDATE ${table.name} SET ${changed.map(([key]) => `${quote(column(key))}=?`).join(",")} WHERE id=1`,
        )
        .run(...changed.map(([, value]) => encode(value)));
      return true;
    },
  };
}
export const PROFILE_ITEMS_SCHEMA = `CREATE TABLE IF NOT EXISTS profile_items(id INTEGER PRIMARY KEY,scope TEXT NOT NULL,owner TEXT NOT NULL,field TEXT NOT NULL,value TEXT NOT NULL,position INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS profile_items_page ON profile_items(scope,owner,field,position,id);
CREATE INDEX IF NOT EXISTS profile_items_value ON profile_items(scope,field,value,owner);`;
/** Stable rows, including repeated values. Adding one fact does not rewrite its siblings. */
export function createProfileItems(store: JobStore) {
  const read = (scope: string, owner: string, field: string) =>
    store
      .sql(
        "SELECT id,value,position FROM profile_items WHERE scope=? AND owner=? AND field=? ORDER BY position,id",
      )
      .all(scope, owner, field) as {
      id: number;
      value: string;
      position: number;
    }[];
  return {
    values: (scope: string, owner: string, field: string) =>
      read(scope, owner, field).map((row) => row.value),
    patch(
      scope: string,
      owner: string,
      field: string,
      values: readonly string[],
      expected?: readonly string[],
    ): boolean {
      const previous = read(scope, owner, field),
        available = new Map<string, typeof previous>();
      if (
        expected &&
        JSON.stringify(previous.map((row) => row.value)) !==
          JSON.stringify(expected)
      )
        throw new Error(
          `The saved ${field} changed while you were editing it. Reload this list and try again.`,
        );
      for (const row of previous) {
        const same = available.get(row.value) ?? [];
        same.push(row);
        available.set(row.value, same);
      }
      let changed = false;
      for (const [position, value] of values.entries()) {
        const row = available.get(value)?.shift();
        if (!row) {
          store
            .sql(
              "INSERT INTO profile_items(scope,owner,field,value,position) VALUES (?,?,?,?,?)",
            )
            .run(scope, owner, field, value, position);
          changed = true;
        } else if (row.position !== position) {
          store
            .sql("UPDATE profile_items SET position=? WHERE id=?")
            .run(position, row.id);
          changed = true;
        }
      }
      for (const rows of available.values())
        for (const row of rows) {
          store.sql("DELETE FROM profile_items WHERE id=?").run(row.id);
          changed = true;
        }
      return changed;
    },
  };
}

export function flattenLists(
  value: unknown,
  keys: readonly string[],
): Record<string, string[]> {
  return Object.fromEntries(
    keys.map((key) => {
      let item: unknown = value;
      for (const part of key.split("."))
        item =
          item && typeof item === "object" && !Array.isArray(item)
            ? (item as Record<string, unknown>)[part]
            : undefined;
      if (item === undefined) return [key, []];
      if (
        !Array.isArray(item) ||
        !item.every((entry: unknown) => typeof entry === "string")
      )
        throw new Error(`Expected a text list at ${key}`);
      return [key, item];
    }),
  );
}
