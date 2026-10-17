import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import {
  DiscoveryRunRecordSchema,
  getDefaultCampaignConfiguration,
  JobFinderIntelligenceStateSchema,
  JobSearchCampaignCollectionSchema,
  JobSearchCampaignSchema,
} from "@nestor/contracts";

import {
  createFileJobFinderRepository,
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createSavedJob,
  createTempRepository,
} from "./file-repository.test-support";
import { runMigrations } from "./internal/migrations";
import {
  bootstrapState,
  saveSingletonValue,
  writeState,
} from "./internal/state";
import { createSeed } from "./test-fixtures";

function createPersistedCampaign(
  id: string,
  searchPreferences: ReturnType<typeof createSeed>["searchPreferences"],
) {
  const now = "2026-08-15T10:00:00.000Z";
  return JobSearchCampaignSchema.parse({
    id,
    name: `Plan ${id}`,
    mode: "precision",
    status: "active",
    createdAt: now,
    updatedAt: now,
    searchPreferences,
    jobIds: [],
    ...getDefaultCampaignConfiguration("precision"),
    progress: { lastUpdatedAt: now },
  });
}

async function expectCampaignPreferencesCommitAtomicity(
  repository: JobFinderRepository,
): Promise<void> {
  const seed = createSeed();
  const campaign = createPersistedCampaign(
    "campaign_atomic",
    seed.searchPreferences,
  );
  await repository.saveCampaignState({
    notifications: [],
    activeCampaignId: campaign.id,
    campaigns: [campaign],
  });

  await repository.commitCampaignPreferencesUpdate((current) => {
    expect(current.campaignState?.activeCampaignId).toBe(campaign.id);
    const preferences = {
      ...current.searchPreferences,
      companyBlacklist: ["Atomic Employer"],
    };
    return {
      result: null,
      campaignState: {
        ...current.campaignState!,
        campaigns: current.campaignState!.campaigns.map((entry) => ({
          ...entry,
          searchPreferences: preferences,
        })),
      },
      searchPreferences: preferences,
      intelligenceState: {
        ...current.intelligenceState,
        updatedAt: "2026-08-15T10:01:00.000Z",
      },
    };
  });

  expect((await repository.getSearchPreferences()).companyBlacklist).toEqual([
    "Atomic Employer",
  ]);
  expect(
    (await repository.getCampaignState())?.campaigns[0]?.searchPreferences
      .companyBlacklist,
  ).toEqual(["Atomic Employer"]);
  expect((await repository.getIntelligenceState()).updatedAt).toBe(
    "2026-08-15T10:01:00.000Z",
  );

  await expect(
    repository.commitCampaignPreferencesUpdate((current) => ({
      result: null,
      campaignState: current.campaignState!,
      searchPreferences: {
        ...current.searchPreferences,
        companyBlacklist: ["Invalid intelligence must roll back preferences"],
      },
      intelligenceState: { ...current.intelligenceState, updatedAt: "invalid" },
    })),
  ).rejects.toThrow();
  expect((await repository.getSearchPreferences()).companyBlacklist).toEqual([
    "Atomic Employer",
  ]);
  expect((await repository.getIntelligenceState()).updatedAt).toBe(
    "2026-08-15T10:01:00.000Z",
  );

  await expect(
    repository.commitCampaignPreferencesUpdate((current) => ({
      result: null,
      campaignState: {
        ...current.campaignState!,
        activeCampaignId: "missing_campaign",
      },
      searchPreferences: {
        ...current.searchPreferences,
        companyBlacklist: ["Must Roll Back"],
      },
    })),
  ).rejects.toThrow();
  expect((await repository.getSearchPreferences()).companyBlacklist).toEqual([
    "Atomic Employer",
  ]);
  expect(
    (await repository.getCampaignState())?.campaigns[0]?.searchPreferences
      .companyBlacklist,
  ).toEqual(["Atomic Employer"]);
}

describe("campaign and activity persistence", () => {
  test("commits campaign preferences atomically in memory", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    try {
      await expectCampaignPreferencesCommitAtomicity(repository);
    } finally {
      await repository.close();
    }
  });

  test("commits campaign preferences atomically in SQLite and survives restart", async () => {
    const temp = await createTempRepository("nestor-db-campaign-atomic-");
    let repository = await temp.createRepository();
    try {
      await expectCampaignPreferencesCommitAtomicity(repository);
      await repository.close();
      repository = await temp.createRepository();
      expect((await repository.getIntelligenceState()).updatedAt).toBe(
        "2026-08-15T10:01:00.000Z",
      );
      expect(
        (await repository.getSearchPreferences()).companyBlacklist,
      ).toEqual(["Atomic Employer"]);
      expect(
        (await repository.getCampaignState())?.campaigns[0]?.searchPreferences
          .companyBlacklist,
      ).toEqual(["Atomic Employer"]);
    } finally {
      await repository.close().catch(() => undefined);
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("backfills legacy jobs and discovery history into one default campaign", () => {
    const database = new DatabaseSync(":memory:");
    const job = createSavedJob({ id: "job_legacy" });
    const run = DiscoveryRunRecordSchema.parse({
      id: "run_legacy",
      state: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      completedAt: "2026-08-01T10:01:00.000Z",
      summary: { validJobsFound: 1, jobsPersisted: 1 },
    });
    try {
      runMigrations(database);
      database
        .prepare("DELETE FROM singleton_state WHERE key = ?")
        .run("campaign_state");
      database
        .prepare("DELETE FROM schema_migrations WHERE version = ?")
        .run(10);
      database
        .prepare(
          "INSERT OR REPLACE INTO singleton_state (key, value) VALUES (?, ?)",
        )
        .run(
          "search_preferences",
          JSON.stringify(createSeed().searchPreferences),
        );
      database
        .prepare(
          "INSERT OR REPLACE INTO singleton_state (key, value) VALUES (?, ?)",
        )
        .run(
          "discovery_state",
          JSON.stringify({ ...createSeed().discovery, recentRuns: [run] }),
        );
      database
        .prepare("INSERT INTO saved_jobs (id, value) VALUES (?, ?)")
        .run(job.id, JSON.stringify(job));
      runMigrations(database);
      const row = database
        .prepare("SELECT value FROM singleton_state WHERE key = ?")
        .get("campaign_state") as { value: string };
      const campaigns = JobSearchCampaignCollectionSchema.parse(
        JSON.parse(row.value) as unknown,
      );

      expect(campaigns.activeCampaignId).toBe("campaign_default");
      expect(campaigns.campaigns[0]?.jobIds).toEqual(["job_legacy"]);
      expect(campaigns.campaigns[0]?.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ discoveryRunId: "run_legacy" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  test("persists the workspace activity pause separately from campaigns", async () => {
    const temp = await createTempRepository("nestor-db-activity-");
    let repository = await temp.createRepository();

    try {
      await repository.saveActivityControl({
        paused: true,
        pausedAt: "2026-08-15T10:00:00.000Z",
        reason: "User paused browser work.",
      });
      await repository.close();
      repository = await temp.createRepository();

      await expect(repository.getActivityControl()).resolves.toEqual({
        paused: true,
        pausedAt: "2026-08-15T10:00:00.000Z",
        reason: "User paused browser work.",
      });
    } finally {
      await repository.close().catch(() => undefined);
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("persists additive Job Finder intelligence without a database migration", async () => {
    const temp = await createTempRepository("nestor-db-intelligence-");
    let repository = await temp.createRepository();
    const intelligence = JobFinderIntelligenceStateSchema.parse({
      updatedAt: "2026-08-15T10:00:00.000Z",
    });

    try {
      await repository.saveIntelligenceState(intelligence);
      await repository.close();
      repository = await temp.createRepository();

      await expect(repository.getIntelligenceState()).resolves.toEqual(
        intelligence,
      );
    } finally {
      await repository.close().catch(() => undefined);
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("reset with a campaign-free seed clears a stale persisted campaign singleton", async () => {
    const temp = await createTempRepository("nestor-db-campaign-reset-");
    const repository = await temp.createRepository();
    try {
      const seed = createSeed();
      const now = "2026-08-15T10:00:00.000Z";
      const staleCampaign = JobSearchCampaignSchema.parse({
        id: "campaign_stale",
        name: "Stale plan",
        description: "Left behind by an earlier workspace generation.",
        mode: "precision",
        status: "active",
        createdAt: now,
        updatedAt: now,
        searchPreferences: seed.searchPreferences,
        jobIds: ["job_stale"],
        ...getDefaultCampaignConfiguration("precision"),
        progress: { lastUpdatedAt: now },
      });
      await repository.saveCampaignState({
        notifications: [],
        activeCampaignId: staleCampaign.id,
        campaigns: [staleCampaign],
      });
      await expect(repository.getCampaignState()).resolves.not.toBeNull();

      // Demo/manual-save seeds carry no campaign state; the reset must not
      // preserve the previous generation's campaign singleton.
      await repository.reset({
        ...seed,
        savedJobs: [createSavedJob({ id: "job_manual" })],
      });

      await expect(repository.getCampaignState()).resolves.toBeNull();
    } finally {
      await repository.close().catch(() => undefined);
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("reset keeps campaign state when the seed carries one", async () => {
    const temp = await createTempRepository("nestor-db-campaign-keep-");
    let repository = await temp.createRepository();
    try {
      const seed = createSeed();
      const now = "2026-08-15T10:00:00.000Z";
      const campaign = JobSearchCampaignSchema.parse({
        id: "campaign_kept",
        name: "Kept plan",
        mode: "scale",
        status: "active",
        createdAt: now,
        updatedAt: now,
        searchPreferences: seed.searchPreferences,
        jobIds: ["job_manual"],
        ...getDefaultCampaignConfiguration("scale"),
        progress: { lastUpdatedAt: now },
      });
      await repository.reset({
        ...seed,
        savedJobs: [createSavedJob({ id: "job_manual" })],
        campaigns: [campaign],
        activeCampaignId: campaign.id,
      });
      await repository.close();
      repository = await temp.createRepository();

      const state = await repository.getCampaignState();
      expect(state?.activeCampaignId).toBe("campaign_kept");
      expect(state?.campaigns[0]?.jobIds).toEqual(["job_manual"]);
    } finally {
      await repository.close().catch(() => undefined);
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("bootstrap rejects a seed with campaigns and a null active pointer before writing", async () => {
    const temp = await createTempRepository("nestor-db-campaign-seed-null-");
    try {
      const seed = createSeed();
      const campaign = createPersistedCampaign(
        "campaign_seeded",
        seed.searchPreferences,
      );

      await expect(
        createFileJobFinderRepository({
          filePath: temp.filePath,
          seed: { ...seed, campaigns: [campaign], activeCampaignId: null },
        }),
      ).rejects.toThrow(/active campaign/i);

      expect(existsSync(temp.filePath)).toBe(false);
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("bootstrap rejects a seed whose active pointer is missing from the campaigns", async () => {
    const temp = await createTempRepository("nestor-db-campaign-seed-unknown-");
    try {
      const seed = createSeed();
      const campaign = createPersistedCampaign(
        "campaign_seeded",
        seed.searchPreferences,
      );

      await expect(
        createFileJobFinderRepository({
          filePath: temp.filePath,
          seed: {
            ...seed,
            campaigns: [campaign],
            activeCampaignId: "campaign_unknown",
          },
        }),
      ).rejects.toThrow(/must exist in the workspace campaigns/i);

      expect(existsSync(temp.filePath)).toBe(false);
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("reset with a malformed campaign pointer fails before deleting persisted campaigns", async () => {
    const temp = await createTempRepository("nestor-db-campaign-reset-guard-");
    const repository = await temp.createRepository();
    try {
      const seed = createSeed();
      const persisted = createPersistedCampaign(
        "campaign_persisted",
        seed.searchPreferences,
      );
      await repository.saveCampaignState({
        notifications: [],
        activeCampaignId: persisted.id,
        campaigns: [persisted],
      });

      await expect(
        repository.reset({
          ...seed,
          savedJobs: [createSavedJob({ id: "job_manual" })],
          campaigns: [
            createPersistedCampaign("campaign_next", seed.searchPreferences),
          ],
          activeCampaignId: null,
        }),
      ).rejects.toThrow(/active campaign/i);

      await expect(repository.getCampaignState()).resolves.toEqual({
        activeCampaignId: persisted.id,
        campaigns: [persisted],
        notifications: [],
      });
    } finally {
      await repository.close().catch(() => undefined);
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("writeState refuses to replace persisted campaigns with an inconsistent pointer", () => {
    const database = new DatabaseSync(":memory:");
    try {
      runMigrations(database);
      bootstrapState(database, createSeed());
      const seed = createSeed();
      const kept = createPersistedCampaign(
        "campaign_kept",
        seed.searchPreferences,
      );
      saveSingletonValue(database, "campaign_state", {
        activeCampaignId: kept.id,
        campaigns: [kept],
      });
      const persistedRow = database
        .prepare("SELECT value FROM singleton_state WHERE key = ?")
        .get("campaign_state") as { value: string };

      expect(() =>
        writeState(database, {
          ...seed,
          campaigns: [kept],
          activeCampaignId: null,
        }),
      ).toThrow(/would silently delete persisted campaigns/i);

      const rowAfterFailure = database
        .prepare("SELECT value FROM singleton_state WHERE key = ?")
        .get("campaign_state") as { value: string };
      expect(rowAfterFailure.value).toBe(persistedRow.value);
    } finally {
      database.close();
    }
  });
});
