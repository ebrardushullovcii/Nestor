import type { BrowserPasswordMetadata } from "@nestor/contracts";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Main supplies OS-encrypted bytes only; this repository never accepts a password. */
export interface EncryptedBrowserPassword extends BrowserPasswordMetadata {
  ciphertext: Uint8Array;
}
export interface BrowserPasswordRepository {
  list(): BrowserPasswordMetadata[];
  get(id: string): EncryptedBrowserPassword | null;
  put(record: EncryptedBrowserPassword): void;
  delete(id: string): void;
  close(): void;
}

export function createBrowserPasswordRepository(
  filePath: string,
): BrowserPasswordRepository {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  chmodSync(filePath, 0o600);
  db.exec(`PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS browser_passwords (
      id TEXT PRIMARY KEY, origin TEXT NOT NULL, username TEXT NOT NULL,
      ciphertext BLOB NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(origin, username)
    )`);
  return {
    list: () =>
      db
        .prepare(
          "SELECT id, origin, username, createdAt, updatedAt FROM browser_passwords ORDER BY origin, username",
        )
        .all() as unknown as BrowserPasswordMetadata[],
    get: (id) =>
      (db
        .prepare("SELECT * FROM browser_passwords WHERE id = ?")
        .get(id) as unknown as EncryptedBrowserPassword | undefined) ?? null,
    put: (record) => {
      if (!record.ciphertext.byteLength)
        throw new Error("Encrypted credential required.");
      db.prepare(
        `INSERT INTO browser_passwords (id, origin, username, ciphertext, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
        ciphertext = excluded.ciphertext, updatedAt = excluded.updatedAt`,
      ).run(
        record.id,
        record.origin,
        record.username,
        record.ciphertext,
        record.createdAt,
        record.updatedAt,
      );
    },
    delete: (id) => {
      db.prepare("DELETE FROM browser_passwords WHERE id = ?").run(id);
    },
    close: () => db.close(),
  };
}
