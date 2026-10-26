import { describe, expect, test, vi } from "vitest";

import {
  createFreshStartSeedProfile,
  createSeed,
  createProfileServiceHarness,
} from "./profile-service.test-support";

describe("resume import timing persistence", () => {
  test("persists measured stage and finalization timing without changing profile or candidates", async () => {
    const seed = createSeed();
    const { repository, profileWork } = createProfileServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...createFreshStartSeedProfile(),
          baseResume: {
            ...seed.profile.baseResume,
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            textContent: [
              "Jamie Rivers",
              "Staff Frontend Engineer",
              "Berlin, Germany",
              "jamie@example.com",
              "",
              "12 years of experience building React, TypeScript, and design systems.",
            ].join("\n"),
          },
        },
      },
    });
    const persistMeasuredRun =
      repository.upsertResumeImportRun.bind(repository);
    let profileBeforeTimingUpsert: string | null = null;
    let candidatesBeforeTimingUpsert: string | null = null;
    const upsertRunSpy = vi
      .spyOn(repository, "upsertResumeImportRun")
      .mockImplementation(async (run) => {
        profileBeforeTimingUpsert = JSON.stringify(
          await repository.getProfile(),
        );
        candidatesBeforeTimingUpsert = JSON.stringify(
          await repository.listResumeImportFieldCandidates({
            runId: run.id,
          }),
        );
        await persistMeasuredRun(run);
      });

    const snapshot = await profileWork.analyzeProfileFromResume();
    const persistedRun = await repository.getLatestResumeImportRun();
    const persistedCandidates =
      await repository.listResumeImportFieldCandidates({
        runId: persistedRun?.id ?? "",
      });

    expect(upsertRunSpy).toHaveBeenCalledTimes(1);
    const measuredRun = upsertRunSpy.mock.calls[0]?.[0];
    expect(measuredRun?.timing?.totalMs).toEqual(expect.any(Number));
    expect(measuredRun?.timing?.finalizationMs).toEqual(expect.any(Number));
    expect(persistedRun?.timing).toEqual(measuredRun?.timing);

    const timing = persistedRun?.timing;
    expect(timing).toBeTruthy();
    if (!timing) {
      throw new Error("Expected persisted resume import timing.");
    }

    expect(timing.totalMs).toEqual(expect.any(Number));
    expect(timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(timing.finalizationMs).toEqual(expect.any(Number));
    expect(timing.finalizationMs).toBeGreaterThanOrEqual(0);
    const expectedStages = [
      "identity_summary",
      "experience",
      "background",
      "shared_memory",
    ] as const;
    expect(timing.textStages).toHaveLength(expectedStages.length);
    for (const [index, stage] of expectedStages.entries()) {
      const stageTiming = timing.textStages[index];
      expect(stageTiming?.stage).toBe(stage);
      expect(stageTiming?.status).toBe("completed");
      expect(stageTiming?.providerKind).toBe("deterministic");
      expect(stageTiming?.providerLabel).toBe(
        "Built-in deterministic agent fallback",
      );
      expect(stageTiming?.durationMs).toEqual(expect.any(Number));
    }
    expect(persistedRun?.analysisProviderKind).toBe("deterministic");
    expect(persistedRun?.analysisProviderLabel).toBe(
      "Built-in deterministic agent fallback",
    );

    expect(snapshot.profile.fullName).toBe("Jamie Rivers");
    expect(snapshot.profile.email).toBe("jamie@example.com");
    expect(persistedCandidates).not.toHaveLength(0);
    expect(persistedRun?.candidateCounts.total).toBe(
      persistedCandidates.length,
    );
    expect(JSON.stringify(await repository.getProfile())).toBe(
      profileBeforeTimingUpsert,
    );
    expect(JSON.stringify(persistedCandidates)).toBe(
      candidatesBeforeTimingUpsert,
    );
  });
});
