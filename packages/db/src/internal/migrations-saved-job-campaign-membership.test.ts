import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import { runMigrations } from "./migrations";

describe("saved job campaign membership migration", () => {
  test("backfills every plan retaining a shared job without duplicating the job", () => {
    const database = new DatabaseSync(":memory:");
    runMigrations(database);
    database
      .prepare("INSERT INTO saved_jobs (id, value) VALUES (?, ?)")
      .run("shared", JSON.stringify({ id: "shared", title: "Shared job" }));
    database
      .prepare("INSERT OR REPLACE INTO singleton_state (key, value) VALUES (?, ?)")
      .run(
        "campaign_state",
        JSON.stringify({
          activeCampaignId: "one",
          campaigns: [
            { id: "one", jobIds: ["shared"] },
            { id: "two", jobIds: ["shared"] },
          ],
        }),
      );
    database.prepare("DELETE FROM schema_migrations WHERE version = 18").run();

    runMigrations(database);

    const rows = database
      .prepare("SELECT value FROM saved_jobs WHERE id = ?")
      .all("shared") as Array<{ value: string }>;
    expect(rows).toHaveLength(1);
    const migratedJob = JSON.parse(rows[0]!.value) as unknown;
    expect(migratedJob).toMatchObject({ campaignIds: ["one", "two"] });
  });
});
