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
  listDrafts(origin: string): BrowserPasswordMetadata[];
  getDraft(id: string, origin: string): EncryptedBrowserPassword | null;
  putDraft(record: EncryptedBrowserPassword): string;
  resolveDraft(id: string, origin: string, accepted: boolean): boolean;
  clearDrafts(): void;
  close(): void;
}

export function createBrowserPasswordRepository(
  filePath: string,
): BrowserPasswordRepository {
  if (filePath !== ":memory:")
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filePath);
  if (filePath !== ":memory:") chmodSync(filePath, 0o600);
  db.exec(`PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS browser_passwords (
      id TEXT PRIMARY KEY, origin TEXT NOT NULL, username TEXT NOT NULL,
      ciphertext BLOB NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
      UNIQUE(origin, username)
    );
    CREATE TABLE IF NOT EXISTS browser_password_drafts (
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
    listDrafts: (origin) =>
      db
        .prepare(
          `SELECT id, origin, username, createdAt, updatedAt
        FROM browser_password_drafts WHERE origin = ? ORDER BY username`,
        )
        .all(origin) as unknown as BrowserPasswordMetadata[],
    getDraft: (id, origin) =>
      (db
        .prepare(
          "SELECT * FROM browser_password_drafts WHERE id = ? AND origin = ?",
        )
        .get(id, origin) as unknown as EncryptedBrowserPassword | undefined) ??
      null,
    putDraft: (record) => {
      if (!record.ciphertext.byteLength)
        throw new Error("Encrypted credential required.");
      // Concurrent runs for the same site/user get the original draft ID and password.
      const row = db
        .prepare(
          `INSERT INTO browser_password_drafts
        (id, origin, username, ciphertext, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(origin, username) DO UPDATE SET id = browser_password_drafts.id
        RETURNING id`,
        )
        .get(
          record.id,
          record.origin,
          record.username,
          record.ciphertext,
          record.createdAt,
          record.updatedAt,
        ) as { id: string };
      return row.id;
    },
    resolveDraft: (id, origin, accepted) => {
      // Promotion and draft removal must commit together across interruption.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (accepted)
          db.prepare(
            `INSERT INTO browser_passwords
            (id, origin, username, ciphertext, createdAt, updatedAt)
            SELECT id, origin, username, ciphertext, createdAt, ?
            FROM browser_password_drafts WHERE id = ? AND origin = ?
            ON CONFLICT(origin, username) DO UPDATE SET
              ciphertext = excluded.ciphertext, updatedAt = excluded.updatedAt`,
          ).run(new Date().toISOString(), id, origin);
        const removed = db
          .prepare(
            "DELETE FROM browser_password_drafts WHERE id = ? AND origin = ?",
          )
          .run(id, origin);
        db.exec("COMMIT");
        return removed.changes !== 0;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    clearDrafts: () => {
      db.exec("DELETE FROM browser_password_drafts");
    },
    close: () => db.close(),
  };
}
