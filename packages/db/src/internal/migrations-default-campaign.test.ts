import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";

import { runMigrations } from "./migrations";
import { createSeed } from "../test-fixtures";

/**
 * Rewinds a fully migrated database to the state migration 10 runs against:
 * search preferences persisted, no campaign state, version 10 not recorded.
 */
function rewindToPreCampaignState(
  database: DatabaseSync,
  serializedSearchPreferences: string,
  serializedDiscoveryState?: string,
): void {
  runMigrations(database);
  database.exec(`
    DELETE FROM schema_migrations WHERE version = 10;
    DELETE FROM singleton_state WHERE key = 'campaign_state';
  `);
  const upsert = database.prepare(
    "INSERT OR REPLACE INTO singleton_state (key, value, revision) VALUES (?, ?, 1)",
  );
  upsert.run("search_preferences", serializedSearchPreferences);
  if (serializedDiscoveryState !== undefined) {
    upsert.run("discovery_state", serializedDiscoveryState);
  }
}

function readCampaignState(
  database: DatabaseSync,
): { activeCampaignId?: unknown } | null {
  const row = database
    .prepare("SELECT value FROM singleton_state WHERE key = 'campaign_state'")
    .get() as { value?: unknown } | undefined;
  return typeof row?.value === "string"
    ? (JSON.parse(row.value) as { activeCampaignId?: unknown })
    : null;
}

describe("default campaign migration", () => {
  test("creates the default campaign from readable legacy search preferences", () => {
    const database = new DatabaseSync(":memory:");
    try {
      rewindToPreCampaignState(
        database,
        JSON.stringify(createSeed().searchPreferences),
      );

      expect(() => runMigrations(database)).not.toThrow();
      expect(readCampaignState(database)?.activeCampaignId).toBe(
        "campaign_default",
      );
      expect(
        database
          .prepare("SELECT name FROM schema_migrations WHERE version = 10")
          .get(),
      ).toEqual({ name: "job_search_campaigns" });
    } finally {
      database.close();
    }
  });

  test("defers default campaign creation instead of rolling every pending migration back on drifted legacy preferences", () => {
    const database = new DatabaseSync(":memory:");
    try {
      rewindToPreCampaignState(
        database,
        JSON.stringify({ definitelyNot: "search preferences" }),
      );

      // A thrown migration rolls back every other pending migration in the same
      // transaction and re-fails identically on every later launch.
      expect(() => runMigrations(database)).not.toThrow();
      expect(readCampaignState(database)).toBeNull();
      // Version 10 must stay unrecorded while the campaign was never created:
      // banking it would skip the legacy discovery-history mapping forever,
      // even after the preferences row is repaired.
      expect(
        database
          .prepare("SELECT name FROM schema_migrations WHERE version = 10")
          .get(),
      ).toBeUndefined();

      // Reopening stays clean and simply retries the deferred campaign.
      expect(() => runMigrations(database)).not.toThrow();
      expect(readCampaignState(database)).toBeNull();
    } finally {
      database.close();
    }
  });

  test("completes the deferred migration once the drifted preferences row is repaired", () => {
    const database = new DatabaseSync(":memory:");
    try {
      rewindToPreCampaignState(
        database,
        JSON.stringify({ definitelyNot: "search preferences" }),
        JSON.stringify({
          recentRuns: [
            {
              id: "run_legacy_1",
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: "2026-01-01T00:05:00.000Z",
            },
          ],
        }),
      );
      runMigrations(database);

      database
        .prepare(
          "UPDATE singleton_state SET value = ? WHERE key = 'search_preferences'",
        )
        .run(JSON.stringify(createSeed().searchPreferences));

      expect(() => runMigrations(database)).not.toThrow();
      expect(readCampaignState(database)?.activeCampaignId).toBe(
        "campaign_default",
      );
      expect(
        database
          .prepare("SELECT name FROM schema_migrations WHERE version = 10")
          .get(),
      ).toEqual({ name: "job_search_campaigns" });
    } finally {
      database.close();
    }
  });

  test("still creates the default campaign when the legacy discovery shape drifted", () => {
    const database = new DatabaseSync(":memory:");
    try {
      rewindToPreCampaignState(
        database,
        JSON.stringify(createSeed().searchPreferences),
        JSON.stringify({ recentRuns: "not-an-array-of-runs" }),
      );

      expect(() => runMigrations(database)).not.toThrow();
      expect(readCampaignState(database)?.activeCampaignId).toBe(
        "campaign_default",
      );
    } finally {
      database.close();
    }
  });

  test("keeps invalid persisted JSON fail-closed so startup recovery can act on it", () => {
    const database = new DatabaseSync(":memory:");
    try {
      rewindToPreCampaignState(database, "not-json{");

      expect(() => runMigrations(database)).toThrow();
      expect(readCampaignState(database)).toBeNull();
      expect(
        database
          .prepare("SELECT name FROM schema_migrations WHERE version = 10")
          .get(),
      ).toBeUndefined();
    } finally {
      database.close();
    }
  });
});
