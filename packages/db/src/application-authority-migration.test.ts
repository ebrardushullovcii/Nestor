import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./internal/migrations";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((cleanupPath) => rm(cleanupPath, { recursive: true, force: true })),
  );
});

function createEnvelopeValue(input: {
  id: string;
  revision: number;
  createdAt: string;
}): string {
  return JSON.stringify({
    id: input.id,
    mode: "prepare_only",
    status: "active",
    revision: input.revision,
    createdAt: input.createdAt,
    expiresAt: null,
    revokedAt: null,
  });
}

describe("application authority migration integrity", () => {
  test("repairs an empty migration-15 authority table whose column shape drifted", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-authority-migration-"),
    );
    cleanupPaths.push(directory);
    const database = new DatabaseSync(path.join(directory, "workspace.sqlite"));

    try {
      runMigrations(database);
      database.exec(
        "ALTER TABLE application_authority_envelopes DROP COLUMN value",
      );

      expect(() => runMigrations(database)).not.toThrow();
      const columns = database
        .prepare("PRAGMA table_info(application_authority_envelopes)")
        .all() as Array<{ name?: unknown }>;
      expect(columns.map((column) => column.name)).toEqual([
        "id",
        "revision",
        "status",
        "value",
      ]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
          )
          .get("application_authority_envelopes_active_unique_idx"),
      ).toBeTruthy();

      // Reopening the repaired workspace stays clean.
      expect(() => runMigrations(database)).not.toThrow();
    } finally {
      database.close();
    }
  });

  test("repairs a drifted foreign-key parent without dropping healthy sibling tables", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-authority-migration-parent-"),
    );
    cleanupPaths.push(directory);
    const database = new DatabaseSync(path.join(directory, "workspace.sqlite"));

    try {
      runMigrations(database);
      database.exec(
        "ALTER TABLE submission_preflights DROP COLUMN authority_revision",
      );

      expect(() => runMigrations(database)).not.toThrow();
      const columns = (
        database
          .prepare("PRAGMA table_info(submission_preflights)")
          .all() as Array<{ name?: unknown }>
      ).map((column) => column.name);
      expect(columns).toContain("authority_revision");
      for (const tableName of [
        "submission_execution_grants",
        "submission_idempotency_records",
        "submission_armed_markers",
        "submission_outcome_records",
      ]) {
        expect(
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .get(tableName),
        ).toBeTruthy();
      }
    } finally {
      database.close();
    }
  });

  test("fails closed instead of discarding rows when a drifted authority table is not empty", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-authority-migration-rows-"),
    );
    cleanupPaths.push(directory);
    const database = new DatabaseSync(path.join(directory, "workspace.sqlite"));

    try {
      runMigrations(database);
      database.exec(
        "ALTER TABLE application_authority_envelopes DROP COLUMN value",
      );
      database
        .prepare(
          "INSERT INTO application_authority_envelopes (id, revision, status) VALUES (?, ?, ?)",
        )
        .run("authority_a", 1, "active");

      expect(() => runMigrations(database)).toThrow(
        "Application authority migration cannot repair application_authority_envelopes: its column shape is outdated and it still holds rows.",
      );
    } finally {
      database.close();
    }
  });

  test("backfills the one-active-envelope index by revoking superseded active envelopes", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-authority-migration-duplicates-"),
    );
    cleanupPaths.push(directory);
    const database = new DatabaseSync(path.join(directory, "workspace.sqlite"));

    try {
      runMigrations(database);
      // A workspace created before the partial unique index existed can already
      // hold two active envelopes.
      database.exec(
        "DROP INDEX application_authority_envelopes_active_unique_idx",
      );
      const insert = database.prepare(
        "INSERT INTO application_authority_envelopes (id, revision, status, value) VALUES (?, ?, ?, ?)",
      );
      insert.run(
        "authority_old",
        1,
        "active",
        createEnvelopeValue({
          id: "authority_old",
          revision: 1,
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
      );
      insert.run(
        "authority_new",
        2,
        "active",
        createEnvelopeValue({
          id: "authority_new",
          revision: 2,
          createdAt: "2026-08-02T00:00:00.000Z",
        }),
      );

      expect(() => runMigrations(database)).not.toThrow();

      expect(
        database
          .prepare(
            "SELECT id FROM application_authority_envelopes WHERE status = 'active'",
          )
          .all(),
      ).toEqual([{ id: "authority_new" }]);
      const revoked = database
        .prepare(
          "SELECT status, value FROM application_authority_envelopes WHERE id = ?",
        )
        .get("authority_old") as { status: string; value: string };
      expect(revoked.status).toBe("revoked");
      const revokedValue = JSON.parse(revoked.value) as {
        status?: unknown;
        revokedAt?: unknown;
      };
      expect(revokedValue.status).toBe("revoked");
      expect(typeof revokedValue.revokedAt).toBe("string");
      expect(Date.parse(String(revokedValue.revokedAt))).toBeGreaterThanOrEqual(
        Date.parse("2026-08-01T00:00:00.000Z"),
      );
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
          )
          .get("application_authority_envelopes_active_unique_idx"),
      ).toBeTruthy();
    } finally {
      database.close();
    }
  });

  test("fails closed when a superseded active envelope cannot be read", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-authority-migration-unreadable-"),
    );
    cleanupPaths.push(directory);
    const database = new DatabaseSync(path.join(directory, "workspace.sqlite"));

    try {
      runMigrations(database);
      database.exec(
        "DROP INDEX application_authority_envelopes_active_unique_idx",
      );
      const insert = database.prepare(
        "INSERT INTO application_authority_envelopes (id, revision, status, value) VALUES (?, ?, ?, ?)",
      );
      insert.run("authority_broken", 1, "active", "not json");
      insert.run(
        "authority_new",
        2,
        "active",
        createEnvelopeValue({
          id: "authority_new",
          revision: 2,
          createdAt: "2026-08-02T00:00:00.000Z",
        }),
      );

      expect(() => runMigrations(database)).toThrow(
        'Application authority migration cannot revoke superseded active envelope "authority_broken"',
      );
      // The failed repair rolled back: both rows survive untouched.
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM application_authority_envelopes WHERE status = 'active'",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  test("installs a database-level one-active-envelope invariant", () => {
    const database = new DatabaseSync(":memory:");

    try {
      runMigrations(database);

      const index = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get("application_authority_envelopes_active_unique_idx") as
        | { sql?: unknown }
        | undefined;
      expect(index?.sql).toEqual(
        expect.stringContaining("CREATE UNIQUE INDEX"),
      );
      expect(index?.sql).toEqual(
        expect.stringContaining("WHERE status = 'active'"),
      );

      database
        .prepare(
          "INSERT INTO application_authority_envelopes (id, revision, status, value) VALUES (?, ?, ?, ?)",
        )
        .run("authority_a", 1, "active", "{}");
      expect(() =>
        database
          .prepare(
            "INSERT INTO application_authority_envelopes (id, revision, status, value) VALUES (?, ?, ?, ?)",
          )
          .run("authority_b", 1, "active", "{}"),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});
