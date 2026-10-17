import { DatabaseSync } from "node:sqlite";
import {
  ApplicationCrmSettingsSchema,
  JobFinderSettingsSchema,
} from "@nestor/contracts";
import type { JobFinderSettings } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "./index";
import {
  cleanupTempDirectoryWithRetry,
  createSavedJob,
  createTempRepository,
} from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

function trackerCrmSettings(
  afterDays: number,
): JobFinderSettings["applicationCrm"] {
  return ApplicationCrmSettingsSchema.parse({
    noResponseAutomation: { enabled: true, afterDays },
  });
}

async function expectCommitSettingsUpdateParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    const seedSettings = createSeed().settings;
    const observedCurrents: JobFinderSettings[] = [];

    const firstCommit = await repository.commitSettingsUpdate((current) => {
      observedCurrents.push(current);
      return { ...current, keepSessionAlive: !current.keepSessionAlive };
    });
    const secondCommit = await repository.commitSettingsUpdate((current) => {
      observedCurrents.push(current);
      return { ...current, discoveryOnly: true };
    });

    expect(observedCurrents).toHaveLength(2);
    expect(observedCurrents[0]).toEqual(seedSettings);
    expect(observedCurrents[1]).toEqual(firstCommit);

    expect(firstCommit.keepSessionAlive).toBe(!seedSettings.keepSessionAlive);
    expect(secondCommit.discoveryOnly).toBe(true);
    expect(secondCommit.keepSessionAlive).toBe(!seedSettings.keepSessionAlive);
    expect(await repository.getSettings()).toEqual(secondCommit);

    secondCommit.fontPreset = "space_grotesk_display";
    expect((await repository.getSettings()).fontPreset).not.toBe(
      "space_grotesk_display",
    );

    await expect(
      repository.commitSettingsUpdate(() => {
        throw new Error("updater failed");
      }),
    ).rejects.toThrow("updater failed");
    expect((await repository.getSettings()).discoveryOnly).toBe(true);
    expect((await repository.getSettings()).keepSessionAlive).toBe(
      !seedSettings.keepSessionAlive,
    );

    await expect(
      repository.commitSettingsUpdate(
        (current) =>
          ({
            ...current,
            keepSessionAlive: "not-a-boolean",
          }) as unknown as JobFinderSettings,
      ),
    ).rejects.toThrow();
    expect((await repository.getSettings()).keepSessionAlive).toBe(
      !seedSettings.keepSessionAlive,
    );

    const resetSeed = createSeed();
    await repository.reset(resetSeed);
    expect(await repository.getSettings()).toEqual(resetSeed.settings);
  } finally {
    await repository.close();
  }
}

async function expectScopedMergeParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    await Promise.all([
      repository.commitSettingsUpdate((current) => ({
        ...current,
        applicationCrm: trackerCrmSettings(3),
      })),
      repository.commitSavedJobDelta({
        upserts: [
          createSavedJob({ id: "job_scoped", sourceJobId: "target_scoped" }),
        ],
        updateSettings: (current) => ({ ...current, discoveryOnly: true }),
      }),
    ]);

    const settings = await repository.getSettings();
    expect(settings.applicationCrm?.noResponseAutomation.enabled).toBe(true);
    expect(settings.applicationCrm?.noResponseAutomation.afterDays).toBe(3);
    expect(settings.discoveryOnly).toBe(true);
    expect((await repository.listSavedJobs()).map((job) => job.id)).toContain(
      "job_scoped",
    );
  } finally {
    await repository.close();
  }
}

async function expectPairedSettingsJobDeltaAtomicityParity(
  createRepository: () => JobFinderRepository | Promise<JobFinderRepository>,
): Promise<void> {
  const repository = await createRepository();
  try {
    await repository.commitSavedJobDelta({
      upserts: [
        createSavedJob({ id: "job_paired", sourceJobId: "target_paired" }),
      ],
      updateSettings: (current) => ({
        ...current,
        keepSessionAlive: !current.keepSessionAlive,
        discoveryOnly: true,
      }),
    });

    const pairedSettings = await repository.getSettings();
    expect(pairedSettings.discoveryOnly).toBe(true);
    expect((await repository.listSavedJobs()).map((job) => job.id)).toEqual([
      "job_paired",
    ]);

    await expect(
      repository.commitSavedJobDelta({
        upserts: [
          createSavedJob({ id: "job_rollback", sourceJobId: "target_rb" }),
        ],
        updateSettings: () => {
          throw new Error("paired settings updater failed");
        },
      }),
    ).rejects.toThrow("paired settings updater failed");

    await expect(
      repository.commitSavedJobDelta({
        updateSettings: (current) =>
          ({
            ...current,
            keepSessionAlive: "not-a-boolean",
          }) as unknown as JobFinderSettings,
      }),
    ).rejects.toThrow();

    await expect(
      repository.commitSavedJobDelta({
        update: (job) =>
          job.id === "job_paired" ? { ...job, status: "shortlisted" } : job,
        updateSettings: () => {
          throw new Error("job-side failure after settings merge");
        },
      }),
    ).rejects.toThrow("job-side failure after settings merge");

    expect((await repository.listSavedJobs()).map((job) => job.id)).toEqual([
      "job_paired",
    ]);
    const afterFailures = await repository.getSettings();
    expect(afterFailures.keepSessionAlive).toBe(
      pairedSettings.keepSessionAlive,
    );
    expect((await repository.getSettings()).discoveryOnly).toBe(true);
  } finally {
    await repository.close();
  }
}

describe("commitSettingsUpdate", () => {
  test("in-memory repository applies updater output atomically", async () => {
    await expectCommitSettingsUpdateParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository applies updater output atomically", async () => {
    const temp = await createTempRepository("nestor-db-settings-update-");
    try {
      await expectCommitSettingsUpdateParity(() => temp.createRepository());
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("scoped settings merges against transaction-current state", () => {
  test("in-memory repository keeps concurrent scoped field owners", async () => {
    await expectScopedMergeParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository keeps concurrent scoped field owners", async () => {
    const temp = await createTempRepository("nestor-db-settings-scoped-");
    try {
      await expectScopedMergeParity(() => temp.createRepository());
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("commitSavedJobDelta paired settings updates", () => {
  test("in-memory repository pairs settings and saved-job mutations atomically", async () => {
    await expectPairedSettingsJobDeltaAtomicityParity(() =>
      createInMemoryJobFinderRepository(createSeed()),
    );
  });

  test("file repository pairs settings and saved-job mutations atomically", async () => {
    const temp = await createTempRepository("nestor-db-settings-paired-");
    try {
      await expectPairedSettingsJobDeltaAtomicityParity(() =>
        temp.createRepository(),
      );
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });

  test("file repository increments the settings singleton revision only on applied commits", async () => {
    const temp = await createTempRepository("nestor-db-settings-revision-");
    try {
      const repository = await temp.createRepository();
      try {
        await repository.commitSettingsUpdate((current) => ({
          ...current,
          discoveryOnly: true,
        }));
        await repository.commitSavedJobDelta({
          upserts: [
            createSavedJob({ id: "job_rev", sourceJobId: "target_rev" }),
          ],
          updateSettings: (current) => ({ ...current, discoveryOnly: false }),
        });

        await expect(
          repository.commitSettingsUpdate(() => {
            throw new Error("updater failed");
          }),
        ).rejects.toThrow("updater failed");
      } finally {
        await repository.close();
      }

      const database = new DatabaseSync(temp.filePath);
      try {
        const row = database
          .prepare(
            "SELECT revision FROM singleton_state WHERE key = 'settings'",
          )
          .get() as { revision?: unknown };
        expect(Number(row.revision)).toBe(3);
      } finally {
        database.close();
      }
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});

describe("file repository cross-handle settings concurrency", () => {
  test("two handles preserve interleaved scoped settings and saved-job writes", async () => {
    const temp = await createTempRepository("nestor-db-settings-handles-");
    try {
      const first = await temp.createRepository();
      const second = await temp.createRepository();
      try {
        for (let index = 0; index < 10; index += 1) {
          await first.commitSettingsUpdate((current) =>
            JobFinderSettingsSchema.parse({
              ...current,
              applicationCrm: trackerCrmSettings(index + 1),
            }),
          );
          await second.commitSavedJobDelta({
            upserts: [
              createSavedJob({
                id: `job_second_${index}`,
                sourceJobId: `target_second_${index}`,
              }),
            ],
            updateSettings: (current) =>
              JobFinderSettingsSchema.parse({
                ...current,
                fontPreset:
                  index % 2 === 0 ? "space_grotesk_display" : "inter_requisite",
              }),
          });
        }

        for (const handle of [first, second]) {
          const settings = await handle.getSettings();
          expect(settings.applicationCrm?.noResponseAutomation.afterDays).toBe(
            10,
          );
          expect(settings.fontPreset).toBe("inter_requisite");
          expect(await handle.listSavedJobs()).toHaveLength(10);
        }

        await first.commitSavedJobDelta({
          update: (job) =>
            job.id === "job_second_9" ? { ...job, status: "shortlisted" } : job,
          updateSettings: (current) => ({ ...current, discoveryOnly: true }),
        });
        await second.commitSettingsUpdate((current) => ({
          ...current,
          appearanceTheme: "dark",
        }));

        const converged = await second.getSettings();
        expect(converged.appearanceTheme).toBe("dark");
        expect(converged.discoveryOnly).toBe(true);
        expect(
          (await first.listSavedJobs()).find((job) => job.id === "job_second_9")
            ?.status,
        ).toBe("shortlisted");
      } finally {
        await first.close();
        await second.close();
      }
    } finally {
      await cleanupTempDirectoryWithRetry(temp.tempDirectory);
    }
  });
});
