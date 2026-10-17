import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { runMigrations } from "./migrations";

function readJsonRow(
  database: DatabaseSync,
  tableName: string,
  id: string,
): Record<string, unknown> {
  const row = database
    .prepare(`SELECT value FROM ${tableName} WHERE id = ?`)
    .get(id) as { value?: unknown } | undefined;
  return JSON.parse(String(row?.value)) as Record<string, unknown>;
}

describe("exact application-record lineage migration", () => {
  test("backfills only safe lineage and remains stable across reruns", () => {
    const database = new DatabaseSync(":memory:");
    runMigrations(database);

    const insertApplicationRecord = database.prepare(
      "INSERT INTO application_records (id, value) VALUES (?, ?)",
    );
    for (const [id, jobId] of [
      ["application_unique", "job_unique"],
      ["application_ambiguous_a", "job_ambiguous"],
      ["application_ambiguous_b", "job_ambiguous"],
    ] as const) {
      insertApplicationRecord.run(id, JSON.stringify({ id, jobId }));
    }

    const insertResult = database.prepare(`
      INSERT INTO apply_job_results
        (id, run_id, job_id, queue_position, updated_at, state, value)
      VALUES (?, ?, ?, 0, ?, 'planned', ?)
    `);
    insertResult.run(
      "result_unique",
      "run_unique",
      "job_unique",
      "2026-08-23T10:00:00.000Z",
      JSON.stringify({
        id: "result_unique",
        runId: "run_unique",
        jobId: "job_unique",
        privacyReceipt: {
          lineage: {
            runId: "run_unique",
            jobId: "job_unique",
            resultId: "result_unique",
          },
        },
      }),
    );
    insertResult.run(
      "result_ambiguous",
      "run_ambiguous",
      "job_ambiguous",
      "2026-08-23T10:00:01.000Z",
      JSON.stringify({
        id: "result_ambiguous",
        runId: "run_ambiguous",
        jobId: "job_ambiguous",
      }),
    );
    insertResult.run(
      "result_conflicting",
      "run_conflicting",
      "job_unique",
      "2026-08-23T10:00:02.000Z",
      JSON.stringify({
        id: "result_conflicting",
        runId: "run_conflicting",
        jobId: "job_unique",
        applicationRecordId: "application_ambiguous_a",
      }),
    );
    insertResult.run(
      "result_without_candidate",
      "run_without_candidate",
      "job_without_candidate",
      "2026-08-23T10:00:03.000Z",
      JSON.stringify({
        id: "result_without_candidate",
        runId: "run_without_candidate",
        jobId: "job_without_candidate",
      }),
    );
    for (const [id, runId, receiptLineage] of [
      [
        "result_receipt_conflicting_run",
        "run_receipt_conflicting_run",
        {
          runId: "run_other",
          jobId: "job_unique",
          resultId: "result_receipt_conflicting_run",
        },
      ],
      [
        "result_receipt_conflicting_job",
        "run_receipt_conflicting_job",
        {
          runId: "run_receipt_conflicting_job",
          jobId: "job_other",
          resultId: "result_receipt_conflicting_job",
        },
      ],
      [
        "result_receipt_conflicting_result",
        "run_receipt_conflicting_result",
        {
          runId: "run_receipt_conflicting_result",
          jobId: "job_unique",
          resultId: "result_other",
        },
      ],
      [
        "result_receipt_conflicting_application",
        "run_receipt_conflicting_application",
        {
          runId: "run_receipt_conflicting_application",
          jobId: "job_unique",
          resultId: "result_receipt_conflicting_application",
          applicationRecordId: "application_ambiguous_a",
        },
      ],
    ] as const) {
      insertResult.run(
        id,
        runId,
        "job_unique",
        "2026-08-23T10:00:04.000Z",
        JSON.stringify({
          id,
          runId,
          jobId: "job_unique",
          privacyReceipt: { lineage: receiptLineage },
        }),
      );
    }

    const insertQuestion = database.prepare(`
      INSERT INTO application_question_records
        (id, run_id, job_id, result_id, detected_at, value)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertQuestion.run(
      "question_exact",
      "run_unique",
      "job_unique",
      "result_unique",
      "2026-08-23T10:01:00.000Z",
      JSON.stringify({ id: "question_exact" }),
    );
    insertQuestion.run(
      "question_conflicting_run",
      "run_other",
      "job_unique",
      "result_unique",
      "2026-08-23T10:01:01.000Z",
      JSON.stringify({ id: "question_conflicting_run" }),
    );

    database
      .prepare("INSERT INTO application_attempts (id, value) VALUES (?, ?)")
      .run(
        "attempt_unique",
        JSON.stringify({
          id: "attempt_unique",
          jobId: "job_unique",
          updatedAt: "2026-08-23T10:02:00.000Z",
        }),
      );

    const insertUserAction = database.prepare(`
      INSERT INTO user_action_requests
        (id, dedupe_key, revision, kind, state, scope_type, updated_at, value)
      VALUES (?, ?, 1, 'login', 'pending', 'application', ?, ?)
    `);
    insertUserAction.run(
      "action_exact",
      "action:exact",
      "2026-08-23T10:03:00.000Z",
      JSON.stringify({
        id: "action_exact",
        scope: {
          type: "application",
          runId: "run_unique",
          jobId: "job_unique",
          resultId: "result_unique",
        },
      }),
    );
    insertUserAction.run(
      "action_conflicting_job",
      "action:conflicting",
      "2026-08-23T10:03:01.000Z",
      JSON.stringify({
        id: "action_conflicting_job",
        scope: {
          type: "application",
          runId: "run_unique",
          jobId: "job_other",
          resultId: "result_unique",
        },
      }),
    );

    database.prepare("DELETE FROM schema_migrations WHERE version = 12").run();
    runMigrations(database);

    expect(
      readJsonRow(database, "apply_job_results", "result_unique"),
    ).toMatchObject({
      applicationRecordId: "application_unique",
      privacyReceipt: {
        lineage: { applicationRecordId: "application_unique" },
      },
    });
    expect(
      readJsonRow(database, "apply_job_results", "result_ambiguous")
        .applicationRecordId,
    ).toBeNull();
    expect(
      readJsonRow(database, "apply_job_results", "result_conflicting")
        .applicationRecordId,
    ).toBeNull();
    expect(
      readJsonRow(database, "apply_job_results", "result_without_candidate")
        .applicationRecordId,
    ).toBeNull();
    for (const id of [
      "result_receipt_conflicting_run",
      "result_receipt_conflicting_job",
      "result_receipt_conflicting_result",
      "result_receipt_conflicting_application",
    ]) {
      const result = readJsonRow(database, "apply_job_results", id);
      expect(result.applicationRecordId).toBe("application_unique");
      expect(
        (
          (result.privacyReceipt as Record<string, unknown>).lineage as Record<
            string,
            unknown
          >
        ).applicationRecordId,
      ).toBeNull();
    }
    expect(
      (
        (
          readJsonRow(
            database,
            "apply_job_results",
            "result_receipt_conflicting_run",
          ).privacyReceipt as Record<string, unknown>
        ).lineage as Record<string, unknown>
      ).runId,
    ).toBe("run_other");
    expect(
      readJsonRow(database, "application_question_records", "question_exact")
        .applicationRecordId,
    ).toBe("application_unique");
    expect(
      readJsonRow(
        database,
        "application_question_records",
        "question_conflicting_run",
      ).applicationRecordId,
    ).toBeNull();
    expect(
      readJsonRow(database, "application_attempts", "attempt_unique")
        .applicationRecordId,
    ).toBe("application_unique");
    expect(
      (
        readJsonRow(database, "user_action_requests", "action_exact").scope as {
          applicationRecordId?: unknown;
        }
      ).applicationRecordId,
    ).toBe("application_unique");
    expect(
      (
        readJsonRow(database, "user_action_requests", "action_conflicting_job")
          .scope as { applicationRecordId?: unknown }
      ).applicationRecordId,
    ).toBeNull();

    const beforeRerun = database
      .prepare(
        "SELECT id, application_record_id, value FROM apply_job_results ORDER BY id",
      )
      .all();
    database.prepare("DELETE FROM schema_migrations WHERE version = 12").run();
    runMigrations(database);
    expect(
      database
        .prepare(
          "SELECT id, application_record_id, value FROM apply_job_results ORDER BY id",
        )
        .all(),
    ).toEqual(beforeRerun);
    expect(
      database
        .prepare("SELECT name FROM schema_migrations WHERE version = 12")
        .get(),
    ).toEqual({ name: "exact_application_record_lineage" });

    database.close();
  });

  test("keeps conflicting receipt lineage unassigned after reopen and rerun", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-lineage-migration-"),
    );
    const databasePath = path.join(tempDirectory, "lineage.sqlite");
    let database = new DatabaseSync(databasePath);
    let databaseIsOpen = true;

    try {
      runMigrations(database);
      database
        .prepare("INSERT INTO application_records (id, value) VALUES (?, ?)")
        .run(
          "application_unique",
          JSON.stringify({ id: "application_unique", jobId: "job_unique" }),
        );
      database
        .prepare(
          `
          INSERT INTO apply_job_results
            (id, run_id, job_id, queue_position, updated_at, state, value)
          VALUES (?, ?, ?, 0, ?, 'planned', ?)
        `,
        )
        .run(
          "result_conflicting_receipt",
          "run_unique",
          "job_unique",
          "2026-08-23T11:00:00.000Z",
          JSON.stringify({
            id: "result_conflicting_receipt",
            runId: "run_unique",
            jobId: "job_unique",
            privacyReceipt: {
              lineage: {
                runId: "run_other",
                jobId: "job_unique",
                resultId: "result_conflicting_receipt",
              },
            },
          }),
        );
      database
        .prepare("DELETE FROM schema_migrations WHERE version = 12")
        .run();
      runMigrations(database);
      database.close();
      databaseIsOpen = false;

      database = new DatabaseSync(databasePath);
      databaseIsOpen = true;
      database
        .prepare("DELETE FROM schema_migrations WHERE version = 12")
        .run();
      runMigrations(database);

      const result = readJsonRow(
        database,
        "apply_job_results",
        "result_conflicting_receipt",
      );
      expect(result.applicationRecordId).toBe("application_unique");
      expect(
        (
          (result.privacyReceipt as Record<string, unknown>).lineage as Record<
            string,
            unknown
          >
        ).applicationRecordId,
      ).toBeNull();
    } finally {
      if (databaseIsOpen) database.close();
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
