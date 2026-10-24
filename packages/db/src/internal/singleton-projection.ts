import type { DatabaseSync } from "node:sqlite";
import type { SchemaParser, StateTableKey } from "../repository-types";
import { freezeProjection } from "./saved-job-projection";
import { parsePersistedRowValue } from "./state";
import { decodePreferenceSingleton } from "./preference-storage";

/** Immutable values for readers that never write through a borrowed object. */
export function createSingletonProjectionReader(database: DatabaseSync) {
  database.exec(`
    CREATE TEMP TABLE singleton_projection_epochs (key TEXT PRIMARY KEY, revision INTEGER NOT NULL);
    ${["INSERT", "UPDATE", "DELETE"]
      .map((event) => {
        const row = event === "DELETE" ? "OLD" : "NEW";
        return `CREATE TEMP TRIGGER singleton_projection_${event.toLowerCase()}
        AFTER ${event} ON main.singleton_state BEGIN
          INSERT INTO singleton_projection_epochs VALUES (${row}.key, 1)
          ON CONFLICT(key) DO UPDATE SET revision = revision + 1;
          ${
            event === "UPDATE"
              ? `INSERT INTO singleton_projection_epochs SELECT OLD.key, 1 WHERE OLD.key != NEW.key
            ON CONFLICT(key) DO UPDATE SET revision = revision + 1;`
              : ""
          }
        END;`;
      })
      .join("\n")}
  `);
  const epoch = database.prepare(
    "SELECT revision FROM singleton_projection_epochs WHERE key = ?",
  );
  const version = database.prepare("PRAGMA data_version");
  const row = database.prepare(
    "SELECT value FROM singleton_state WHERE key = ?",
  );
  const cache = new Map<
    StateTableKey,
    { epoch: number; version: number; schema: unknown; value: unknown }
  >();
  return function read<T>(
    key: StateTableKey,
    schema: SchemaParser<T>,
    fallback: T,
  ): T {
    const currentEpoch = Number(epoch.get(key)?.revision ?? 0);
    const currentVersion = Number(version.get()?.data_version);
    const previous = cache.get(key);
    if (
      previous?.schema === schema &&
      previous.epoch === currentEpoch &&
      previous.version === currentVersion
    )
      return previous.value as T;
    const stored = row.get(key);
    const value = freezeProjection(
      stored
        ? (decodePreferenceSingleton(
            database,
            key,
            parsePersistedRowValue({
              tableName: "singleton_state",
              rowId: key,
              rawValue: String(stored.value),
              schema,
            }),
          ) as T)
        : structuredClone(fallback),
    );
    // A rolled-back epoch can be reused. Never publish an uncommitted value.
    if (!database.isTransaction)
      cache.set(key, {
        epoch: currentEpoch,
        version: currentVersion,
        schema,
        value,
      });
    return value;
  };
}
