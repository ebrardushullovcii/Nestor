import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import { runMigrations } from "./internal/migrations";

describe("approved application answer snapshot migration", () => {
  test("creates the dedicated v16 table, uniqueness, and latest-revision index", () => {
    const database = new DatabaseSync(":memory:");
    try {
      runMigrations(database);

      const columns = database
        .prepare("PRAGMA table_info(application_answer_snapshots)")
        .all() as Array<{ name?: unknown }>;
      expect(columns.map((column) => column.name)).toEqual([
        "id",
        "profile_id",
        "revision",
        "digest",
        "source_profile_revision",
        "approved_at",
        "value",
      ]);

      const migration = database
        .prepare("SELECT name FROM schema_migrations WHERE version = ?")
        .get(16) as { name?: unknown } | undefined;
      expect(migration?.name).toBe("approved_application_answer_snapshots");

      const index = database
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get("application_answer_snapshots_profile_revision_idx") as
        | { sql?: unknown }
        | undefined;
      expect(index?.sql).toContain(
        "application_answer_snapshots(profile_id, revision DESC, id ASC)",
      );

      database
        .prepare(
          `INSERT INTO application_answer_snapshots
             (id, profile_id, revision, digest, source_profile_revision, approved_at, value)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "snapshot_1",
          "candidate_1",
          1,
          "a".repeat(64),
          1,
          "2026-08-28T10:00:00.000Z",
          "{}",
        );
      expect(() =>
        database
          .prepare(
            `INSERT INTO application_answer_snapshots
               (id, profile_id, revision, digest, source_profile_revision, approved_at, value)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "snapshot_2",
            "candidate_1",
            1,
            "b".repeat(64),
            2,
            "2026-08-28T10:01:00.000Z",
            "{}",
          ),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test("repairs an empty snapshot table whose column shape drifted", () => {
    const database = new DatabaseSync(":memory:");
    try {
      runMigrations(database);
      // The simulated older schema predates column-aware change-feed triggers.
      database.exec(
        "DROP TRIGGER workspace_feed_application_answer_snapshots_update",
      );
      database.exec(
        "ALTER TABLE application_answer_snapshots DROP COLUMN digest",
      );

      expect(() => runMigrations(database)).not.toThrow();
      const columns = database
        .prepare("PRAGMA table_info(application_answer_snapshots)")
        .all() as Array<{ name?: unknown }>;
      expect(columns.map((column) => column.name)).toEqual([
        "id",
        "profile_id",
        "revision",
        "digest",
        "source_profile_revision",
        "approved_at",
        "value",
      ]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
          )
          .get("application_answer_snapshots_profile_revision_idx"),
      ).toBeTruthy();
    } finally {
      database.close();
    }
  });

  test("fails closed instead of discarding approved snapshots on a drifted shape", () => {
    const database = new DatabaseSync(":memory:");
    try {
      runMigrations(database);
      // The simulated older schema predates column-aware change-feed triggers.
      database.exec(
        "DROP TRIGGER workspace_feed_application_answer_snapshots_update",
      );
      database.exec(
        "ALTER TABLE application_answer_snapshots DROP COLUMN digest",
      );
      database
        .prepare(
          `INSERT INTO application_answer_snapshots
             (id, profile_id, revision, source_profile_revision, approved_at, value)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "snapshot_1",
          "candidate_1",
          1,
          1,
          "2026-08-28T10:00:00.000Z",
          "{}",
        );

      expect(() => runMigrations(database)).toThrow(
        "Approved application answer snapshot migration cannot repair application_answer_snapshots: its column shape is outdated and it still holds rows.",
      );
    } finally {
      database.close();
    }
  });
});
