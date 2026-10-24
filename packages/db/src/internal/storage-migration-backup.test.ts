import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import {
  backupBeforeStorageMigration,
  withStorageMigrationBackups,
} from "./storage-migration-backup";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "nestor-migration-backup-"));
  directories.push(directory);
  const file = join(directory, "workspace.sqlite");
  const database = new DatabaseSync(file);
  database.exec(
    "PRAGMA journal_mode = WAL; CREATE TABLE facts(value TEXT); INSERT INTO facts VALUES ('original')",
  );
  return { file, database };
}
function fact(file: string) {
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    return copy.prepare("SELECT value FROM facts").get()!.value;
  } finally {
    copy.close();
  }
}
test("every batch backup restores the complete pre-upgrade WAL state", () => {
  const { database, file } = fixture();
  try {
    withStorageMigrationBackups(database, () => {
      backupBeforeStorageMigration(database, "discovery-progress");
      database.exec("UPDATE facts SET value = 'converted run'");
      backupBeforeStorageMigration(database, 26);
      database.exec("UPDATE facts SET value = 'converted resume'");
      backupBeforeStorageMigration(database, 28);
    });
    for (const suffix of ["discovery-progress", "v26", "v28"])
      expect(fact(`${file}.before-${suffix}.sqlite`)).toBe("original");
    expect(fact(file)).toBe("converted resume");
  } finally {
    database.close();
  }
});
test("a resumed batch preserves old backups and takes a fresh recovery point", () => {
  const { database, file } = fixture();
  try {
    backupBeforeStorageMigration(database, 26);
    database.exec("UPDATE facts SET value = 'resumed state'");
    withStorageMigrationBackups(database, () => {
      backupBeforeStorageMigration(database, 26);
      backupBeforeStorageMigration(database, 27);
      database.exec("UPDATE facts SET value = 'next conversion'");
      backupBeforeStorageMigration(database, 28);
    });
    expect(fact(`${file}.before-v26.sqlite`)).toBe("original");
    expect(fact(`${file}.before-v27.sqlite`)).toBe("resumed state");
    expect(fact(`${file}.before-v28.sqlite`)).toBe("resumed state");
    backupBeforeStorageMigration(database, 30);
    expect(fact(`${file}.before-v30.sqlite`)).toBe("next conversion");
  } finally {
    database.close();
  }
});

test("yielded conversions share one pre-batch recovery point", async () => {
  const { database, file } = fixture();
  try {
    await withStorageMigrationBackups(database, async () => {
      backupBeforeStorageMigration(database, 27);
      database.exec("UPDATE facts SET value = 'preferences converted'");
      await new Promise<void>((resolve) => setImmediate(resolve));
      backupBeforeStorageMigration(database, 28);
      database.exec("UPDATE facts SET value = 'jobs converted'");
      await new Promise<void>((resolve) => setImmediate(resolve));
      backupBeforeStorageMigration(database, 26);
    });
    for (const version of [26, 27, 28])
      expect(fact(`${file}.before-v${version}.sqlite`)).toBe("original");
    backupBeforeStorageMigration(database, 30);
    expect(fact(`${file}.before-v30.sqlite`)).toBe("jobs converted");
  } finally {
    database.close();
  }
});
