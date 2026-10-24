import type { DatabaseSync } from "node:sqlite";
import { constants, copyFileSync, existsSync, linkSync } from "node:fs";

const batches = new WeakMap<DatabaseSync, { snapshot?: string }>();

/** One immutable recovery point covers this consecutive upgrade batch. */
export function withStorageMigrationBackups<T>(
  database: DatabaseSync,
  migrate: () => T,
): T {
  if (batches.has(database)) return migrate();
  batches.set(database, {});
  try {
    return migrate();
  } finally {
    batches.delete(database);
  }
}

/** SQLite copies a consistent database including WAL before any shape changes. */
export function backupBeforeStorageMigration(
  database: DatabaseSync,
  version: number | "discovery-progress",
): void {
  const row = database
    .prepare("PRAGMA database_list")
    .all()
    .find((item) => item.name === "main");
  const file = String(row?.file ?? "");
  if (!file || file === ":memory:") return;
  const backup = `${file}.before-${typeof version === "number" ? `v${version}` : version}.sqlite`;
  if (existsSync(backup)) return;
  const batch = batches.get(database);
  if (batch?.snapshot) {
    // Each established recovery filename remains independently usable. An old
    // backup from an interrupted upgrade never seeds a new batch's snapshot.
    try {
      linkSync(batch.snapshot, backup);
    } catch {
      if (existsSync(backup)) return;
      copyFileSync(batch.snapshot, backup, constants.COPYFILE_EXCL);
    }
  } else {
    database.prepare("VACUUM main INTO ?").run(backup);
    if (batch) batch.snapshot = backup;
  }
}
