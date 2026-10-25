import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { runMigrations } from "./migrations";

const baseResult = {
  id: "result_legacy",
  runId: "run_legacy",
  jobId: "job_legacy",
  state: "planned",
  summary: "Application planned.",
  detail: "Waiting to prepare.",
  startedAt: "2026-08-23T09:00:00.000Z",
  updatedAt: "2026-08-23T09:00:00.000Z",
};

describe("durable application preparation start migration", () => {
  test("adds v13 columns and index without fabricating legacy JSON fields", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-preparation-migration-"),
    );
    const filePath = path.join(directory, "workspace.sqlite");
    let database = new DatabaseSync(filePath);
    let open = true;

    try {
      runMigrations(database);
      database.exec(`
        -- The simulated older schema predates column-aware change-feed triggers.
        DROP TRIGGER workspace_feed_apply_job_results_update;
        DROP INDEX apply_job_results_preparation_local_date_run_job_idx;
        ALTER TABLE apply_job_results DROP COLUMN application_preparation_started_at;
        ALTER TABLE apply_job_results DROP COLUMN application_preparation_started_local_date;
        DELETE FROM schema_migrations WHERE version = 13;
      `);
      const insert = database.prepare(`
        INSERT INTO apply_job_results
          (id, run_id, job_id, application_record_id, queue_position, updated_at, state, value)
        VALUES (?, ?, ?, NULL, 0, ?, 'planned', ?)
      `);
      insert.run(
        baseResult.id,
        baseResult.runId,
        baseResult.jobId,
        baseResult.updatedAt,
        JSON.stringify(baseResult),
      );
      insert.run(
        "result_marked",
        "run_marked",
        "job_marked",
        baseResult.updatedAt,
        JSON.stringify({
          ...baseResult,
          id: "result_marked",
          runId: "run_marked",
          jobId: "job_marked",
          applicationPreparationStartedAt: "2026-08-23T10:00:00.000Z",
          applicationPreparationStartedLocalDate: "2026-08-23",
        }),
      );

      runMigrations(database);
      const legacy = database
        .prepare(
          `SELECT application_preparation_started_at AS startedAt,
                  application_preparation_started_local_date AS localDate,
                  value
           FROM apply_job_results WHERE id = ?`,
        )
        .get(baseResult.id) as {
        startedAt: string | null;
        localDate: string | null;
        value: string;
      };
      expect(legacy.startedAt).toBeNull();
      expect(legacy.localDate).toBeNull();
      expect(JSON.parse(legacy.value)).not.toHaveProperty(
        "applicationPreparationStartedAt",
      );
      expect(
        database
          .prepare(
            `SELECT id FROM apply_job_results
             WHERE application_preparation_started_local_date = ?
               AND run_id = ? AND job_id = ?`,
          )
          .all("2026-08-23", "run_marked", "job_marked"),
      ).toEqual([{ id: "result_marked" }]);
      expect(
        database
          .prepare("SELECT name FROM schema_migrations WHERE version = 13")
          .get(),
      ).toEqual({ name: "durable_application_preparation_started" });

      database.close();
      open = false;
      database = new DatabaseSync(filePath);
      open = true;
      runMigrations(database);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13",
          )
          .get(),
      ).toEqual({ count: 1 });
    } finally {
      if (open) database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps migrating when a legacy row drifted from the current apply schema", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-preparation-migration-drift-"),
    );
    const filePath = path.join(directory, "workspace.sqlite");
    const database = new DatabaseSync(filePath);

    try {
      runMigrations(database);
      database.exec(`
        -- The simulated older schema predates column-aware change-feed triggers.
        DROP TRIGGER workspace_feed_apply_job_results_update;
        DROP INDEX apply_job_results_preparation_local_date_run_job_idx;
        ALTER TABLE apply_job_results DROP COLUMN application_preparation_started_at;
        ALTER TABLE apply_job_results DROP COLUMN application_preparation_started_local_date;
        DELETE FROM schema_migrations WHERE version = 13;
      `);
      const insert = database.prepare(`
        INSERT INTO apply_job_results
          (id, run_id, job_id, application_record_id, queue_position, updated_at, state, value)
        VALUES (?, ?, ?, NULL, 0, ?, 'planned', ?)
      `);
      // A single legacy row whose unrelated fields drifted from the current
      // schema must not roll the migration back and re-fail on every launch.
      const driftedValue = {
        ...baseResult,
        id: "result_drifted",
        runId: "run_drifted",
        jobId: "job_drifted",
        blockerReason: "legacy_blocker_code_that_no_longer_exists",
      };
      insert.run(
        driftedValue.id,
        driftedValue.runId,
        driftedValue.jobId,
        baseResult.updatedAt,
        JSON.stringify(driftedValue),
      );
      insert.run(
        "result_marked",
        "run_marked",
        "job_marked",
        baseResult.updatedAt,
        JSON.stringify({
          ...baseResult,
          id: "result_marked",
          runId: "run_marked",
          jobId: "job_marked",
          applicationPreparationStartedAt: "2026-08-23T10:00:00.000Z",
          applicationPreparationStartedLocalDate: "2026-08-23",
        }),
      );

      expect(() => runMigrations(database)).not.toThrow();
      expect(
        database
          .prepare("SELECT name FROM schema_migrations WHERE version = 13")
          .get(),
      ).toEqual({ name: "durable_application_preparation_started" });
      expect(
        database
          .prepare(
            `SELECT application_preparation_started_at AS startedAt,
                    application_preparation_started_local_date AS localDate,
                    value
             FROM apply_job_results WHERE id = ?`,
          )
          .get("result_drifted"),
      ).toEqual({
        startedAt: null,
        localDate: null,
        // The drifted row itself is preserved byte for byte.
        value: JSON.stringify(driftedValue),
      });
      expect(
        database
          .prepare(
            `SELECT application_preparation_started_at AS startedAt,
                    application_preparation_started_local_date AS localDate
             FROM apply_job_results WHERE id = ?`,
          )
          .get("result_marked"),
      ).toEqual({
        startedAt: "2026-08-23T10:00:00.000Z",
        localDate: "2026-08-23",
      });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("leaves a half-set legacy preparation start unknown instead of inventing the missing half", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-preparation-migration-partial-"),
    );
    const filePath = path.join(directory, "workspace.sqlite");
    const database = new DatabaseSync(filePath);

    try {
      runMigrations(database);
      database.exec(`
        -- The simulated older schema predates column-aware change-feed triggers.
        DROP TRIGGER workspace_feed_apply_job_results_update;
        DROP INDEX apply_job_results_preparation_local_date_run_job_idx;
        ALTER TABLE apply_job_results DROP COLUMN application_preparation_started_at;
        ALTER TABLE apply_job_results DROP COLUMN application_preparation_started_local_date;
        DELETE FROM schema_migrations WHERE version = 13;
      `);
      database
        .prepare(
          `INSERT INTO apply_job_results
             (id, run_id, job_id, application_record_id, queue_position, updated_at, state, value)
           VALUES (?, ?, ?, NULL, 0, ?, 'planned', ?)`,
        )
        .run(
          "result_partial",
          "run_partial",
          "job_partial",
          baseResult.updatedAt,
          JSON.stringify({
            ...baseResult,
            id: "result_partial",
            runId: "run_partial",
            jobId: "job_partial",
            applicationPreparationStartedAt: "2026-08-23T10:00:00.000Z",
          }),
        );

      expect(() => runMigrations(database)).not.toThrow();
      expect(
        database
          .prepare(
            `SELECT application_preparation_started_at AS startedAt,
                    application_preparation_started_local_date AS localDate
             FROM apply_job_results WHERE id = ?`,
          )
          .get("result_partial"),
      ).toEqual({ startedAt: null, localDate: null });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
