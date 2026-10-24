import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

/** SQLite copies a consistent database including WAL before any shape changes. */
export function backupBeforeStorageMigration(
  database: DatabaseSync,
  version: number,
): void {
  const row = database
    .prepare("PRAGMA database_list")
    .all()
    .find((item) => item.name === "main");
  const file = String(row?.file ?? "");
  if (!file || file === ":memory:") return;
  const backup = `${file}.before-v${version}.sqlite`;
  if (!existsSync(backup))
    database.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
}
