import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DiscoveryIdentityStore } from "@nestor/contracts";

const initialized = new WeakSet<DatabaseSync>();
let sequence = 0;

/** Exact-input cache plus a disk-backed run index; no listing bodies enter it. */
export function createDiscoveryIdentityStore(
  database: DatabaseSync,
): DiscoveryIdentityStore {
  if (!initialized.has(database)) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS discovery_identity_keys (identity_hash TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS discovery_identity_aliases (
        identity_hash TEXT NOT NULL, alias_key TEXT NOT NULL,
        PRIMARY KEY (identity_hash, alias_key)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS discovery_identity_alias_key ON discovery_identity_aliases(alias_key);
    `);
    initialized.add(database);
  }
  const table = `discovery_identity_run_${++sequence}`;
  database.exec(`CREATE TEMP TABLE ${table} (alias_key TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY(alias_key, id)) WITHOUT ROWID;
    CREATE INDEX ${table}_id ON ${table}(id)`);
  const known = database.prepare(
    "SELECT 1 FROM discovery_identity_keys WHERE identity_hash = ?",
  );
  const addKey = database.prepare(
    "INSERT INTO discovery_identity_keys VALUES (?)",
  );
  const addAlias = database.prepare(
    "INSERT OR IGNORE INTO discovery_identity_aliases VALUES (?, ?)",
  );
  const remove = database.prepare(`DELETE FROM ${table} WHERE id = ?`);
  const put = database.prepare(
    `INSERT OR IGNORE INTO ${table} SELECT alias_key, ? FROM discovery_identity_aliases WHERE identity_hash = ?`,
  );
  const find = database.prepare(
    `SELECT alias_key, id FROM ${table} WHERE alias_key IN (SELECT value FROM json_each(?))`,
  );
  let closed = false;
  const batch = (operation: () => void) => {
    if (database.isTransaction) {
      operation();
      return;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  return {
    put(id, signature, build) {
      const hash = createHash("sha256").update(signature).digest("hex");
      if (!known.get(hash))
        batch(() => {
          addKey.run(hash);
          for (const alias of build()) addAlias.run(hash, alias.key);
        });
      remove.run(id);
      put.run(id, hash);
    },
    remove(id) {
      remove.run(id);
    },
    find(keys) {
      return find
        .all(JSON.stringify(keys))
        .map((row) => ({ key: String(row.alias_key), id: Number(row.id) }));
    },
    batch,
    close() {
      if (closed) return;
      closed = true;
      database.exec(`DROP TABLE ${table}`);
    },
  };
}
