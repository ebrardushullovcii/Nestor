import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import { runMigrations } from "./migrations";

describe("outcome event source lineage migration", () => {
  test("backfills the saved source from job lineage and names the unknown rest", () => {
    const database = new DatabaseSync(":memory:");
    runMigrations(database);
    database
      .prepare("INSERT INTO saved_jobs (id, value) VALUES (?, ?)")
      .run(
        "job_1",
        JSON.stringify({
          id: "job_1",
          provenance: [
            { targetId: "target_boards", startingUrl: "https://example.test" },
          ],
        }),
      );
    database
      .prepare("INSERT INTO saved_jobs (id, value) VALUES (?, ?)")
      .run("job_2", JSON.stringify({ id: "job_2", provenance: [] }));
    database
      .prepare("INSERT INTO singleton_state (key, value) VALUES (?, ?)")
      .run(
        "intelligence_state",
        JSON.stringify({
          outcomeEvents: [
            { id: "outcome_1", jobId: "job_1", source: "target_site" },
            { id: "outcome_2", jobId: "job_2", source: "target_site" },
            { id: "outcome_3", jobId: "job_gone", source: "target_site" },
          ],
          untouched: { marker: "preserved" },
        }),
      );
    database.prepare("DELETE FROM schema_migrations WHERE version = 17").run();

    runMigrations(database);
    // Re-running must not change anything it already wrote.
    runMigrations(database);

    const row = database
      .prepare("SELECT value FROM singleton_state WHERE key = ?")
      .get("intelligence_state") as { value: string };
    expect(JSON.parse(row.value)).toEqual({
      outcomeEvents: [
        {
          id: "outcome_1",
          jobId: "job_1",
          source: "target_site",
          sourceTargetId: "target_boards",
        },
        {
          id: "outcome_2",
          jobId: "job_2",
          source: "target_site",
          sourceTargetId: null,
        },
        {
          id: "outcome_3",
          jobId: "job_gone",
          source: "target_site",
          sourceTargetId: null,
        },
      ],
      untouched: { marker: "preserved" },
    });
  });

  test("leaves an already recorded source lineage alone", () => {
    const database = new DatabaseSync(":memory:");
    runMigrations(database);
    database
      .prepare("INSERT INTO saved_jobs (id, value) VALUES (?, ?)")
      .run(
        "job_1",
        JSON.stringify({
          id: "job_1",
          provenance: [{ targetId: "target_new" }],
        }),
      );
    database
      .prepare("INSERT INTO singleton_state (key, value) VALUES (?, ?)")
      .run(
        "intelligence_state",
        JSON.stringify({
          outcomeEvents: [
            {
              id: "outcome_1",
              jobId: "job_1",
              sourceTargetId: "target_recorded",
            },
          ],
        }),
      );
    database.prepare("DELETE FROM schema_migrations WHERE version = 17").run();

    runMigrations(database);

    const row = database
      .prepare("SELECT value FROM singleton_state WHERE key = ?")
      .get("intelligence_state") as { value: string };
    expect(JSON.parse(row.value)).toEqual({
      outcomeEvents: [
        { id: "outcome_1", jobId: "job_1", sourceTargetId: "target_recorded" },
      ],
    });
  });
});
