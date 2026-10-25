import {
  DiscoveryRunRecordSchema,
  JobFinderDiscoveryStateSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";

function createInterruptedDiscoveryRun() {
  return DiscoveryRunRecordSchema.parse({
    id: "discovery_run_before_restart",
    state: "running",
    scope: "run_all",
    startedAt: "2026-03-20T10:00:00.000Z",
    completedAt: null,
    targetIds: ["target_completed", "target_in_progress"],
    targetExecutions: [
      {
        targetId: "target_completed",
        adapterKind: "auto",
        resolvedAdapterKind: "target_site",
        state: "completed",
        startedAt: "2026-03-20T10:00:05.000Z",
        completedAt: "2026-03-20T10:00:10.000Z",
        jobsReviewed: 1,
        jobsFound: 1,
        jobsPersisted: 1,
      },
      {
        targetId: "target_in_progress",
        adapterKind: "auto",
        resolvedAdapterKind: "target_site",
        state: "running",
        startedAt: "2026-03-20T10:00:11.000Z",
        completedAt: null,
      },
    ],
    activity: [],
    summary: {
      targetsPlanned: 2,
      targetsCompleted: 1,
      validJobsFound: 1,
      jobsPersisted: 1,
      outcome: "running",
    },
  });
}

function createService(
  repository: ReturnType<typeof createInMemoryJobFinderRepository>,
) {
  return createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
  });
}

describe("discovery restart recovery", () => {
  test("startup recovery waits for background readiness and runs without a snapshot", async () => {
    const seed = createSeed();
    seed.discovery = {
      ...seed.discovery,
      runState: "running",
      activeRun: createInterruptedDiscoveryRun(),
    };
    const repository = createInMemoryJobFinderRepository(seed);
    let release: () => void = () => {};
    const backgroundWorkReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalRead =
      repository.readDiscoveryDisplayProjection.bind(repository);
    let recoveryReads = 0;
    vi.spyOn(repository, "readDiscoveryDisplayProjection").mockImplementation(
      () => {
        if (
          new Error().stack?.includes("recoverInterruptedDiscoveryStateOnLoad")
        )
          recoveryReads++;
        return originalRead();
      },
    );
    const service = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      backgroundWorkReady,
    });
    await service.getWorkspaceBootstrap();
    expect((await repository.getDiscoveryState()).runState).toBe("running");
    expect(recoveryReads).toBe(0);
    release();
    await vi.waitFor(async () =>
      expect((await repository.getDiscoveryState()).runState).toBe("failed"),
    );
    expect(recoveryReads).toBe(1);
    await service.getWorkspaceSnapshot();
    await service.getWorkspaceSnapshot();
    expect(recoveryReads).toBe(1);
    await service.shutdown();
    await repository.close();
  });
  test("fails a hard-interrupted run on reopen, preserves durable jobs, and allows a new search", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const previousService = createService(repository);
    await previousService.getWorkspaceSnapshot();

    const interruptedRun = createInterruptedDiscoveryRun();
    const persistedBeforeCrash = await repository.getDiscoveryState();
    await repository.commitDiscoveryStateUpdate(() =>
      JobFinderDiscoveryStateSchema.parse({
        ...persistedBeforeCrash,
        runState: "running",
        activeRun: interruptedRun,
        recentRuns: [interruptedRun],
      }),
    );

    // Simulate a process death: do not call shutdown or abort on the old service.
    const reopenedService = createService(repository);
    await vi.waitFor(async () =>
      expect((await repository.getDiscoveryState()).runState).toBe("failed"),
    );
    const recoveredSnapshot = await reopenedService.getWorkspaceSnapshot();
    const recoveredRun = recoveredSnapshot.recentDiscoveryRuns.find(
      (run) => run.id === interruptedRun.id,
    );

    expect(recoveredSnapshot.discoveryRunState).toBe("failed");
    expect(recoveredSnapshot.activeDiscoveryRun).toBeNull();
    expect(recoveredRun).toMatchObject({
      state: "failed",
      runPhase: "interrupted",
      summary: {
        targetsPlanned: 2,
        targetsCompleted: 1,
        validJobsFound: 1,
        jobsPersisted: 1,
        outcome: "failed",
      },
    });
    expect(recoveredRun?.completedAt).not.toBeNull();
    const recoveredCampaign = recoveredSnapshot.campaigns.find(
      (campaign) => campaign.id === recoveredRun?.campaignId,
    );
    expect(recoveredCampaign?.latestDigest?.discoveryRunId).toBe(
      interruptedRun.id,
    );
    expect(
      recoveredCampaign?.history.some(
        (entry) =>
          entry.discoveryRunId === interruptedRun.id &&
          entry.summary.startsWith("Interrupted:"),
      ),
    ).toBe(true);
    expect(
      recoveredRun?.targetExecutions.find(
        (execution) => execution.targetId === "target_completed",
      ),
    ).toMatchObject({
      state: "completed",
      completedAt: "2026-03-20T10:00:10.000Z",
      jobsPersisted: 1,
    });
    expect(
      recoveredRun?.targetExecutions.find(
        (execution) => execution.targetId === "target_in_progress",
      ),
    ).toMatchObject({
      state: "failed",
      warning:
        "Discovery was interrupted because the app closed before this source finished.",
    });
    expect(
      recoveredRun?.targetExecutions.find(
        (execution) => execution.targetId === "target_in_progress",
      )?.completedAt,
    ).not.toBeNull();
    expect(recoveredRun?.activity.at(-1)).toMatchObject({
      kind: "error",
      stage: "run",
      terminalState: "failed",
    });
    expect(recoveredRun?.activity.at(-1)?.message).toContain(
      "Jobs saved before the interruption remain available",
    );
    expect(
      recoveredSnapshot.discoveryJobs.some((job) => job.id === "job_ready"),
    ).toBe(true);

    const persistedAfterRecovery = await repository.getDiscoveryState();
    expect(persistedAfterRecovery.runState).toBe("failed");
    expect(persistedAfterRecovery.activeRun).toBeNull();
    expect(persistedAfterRecovery.recentRuns[0]?.id).toBe(interruptedRun.id);

    const resumedSnapshot = await reopenedService.runDiscovery();
    const newRun = resumedSnapshot.recentDiscoveryRuns[0];

    expect(resumedSnapshot.activeDiscoveryRun).toBeNull();
    expect(newRun?.state).toBe("completed");
    expect(newRun?.id).not.toBe(interruptedRun.id);
    expect(
      resumedSnapshot.recentDiscoveryRuns.find(
        (run) => run.id === interruptedRun.id,
      )?.state,
    ).toBe("failed");
    expect(
      resumedSnapshot.discoveryJobs.some((job) => job.id === "job_ready"),
    ).toBe(true);
  });

  test("interrupted-run recovery yields when a newer owner replaced the observed run", async () => {
    const baseRepository = createInMemoryJobFinderRepository(createSeed());
    const staleRun = createInterruptedDiscoveryRun();
    await baseRepository.commitDiscoveryStateUpdate((current) => ({
      ...current,
      runState: "running",
      activeRun: staleRun,
    }));

    const newerOwnerRun = DiscoveryRunRecordSchema.parse({
      ...staleRun,
      id: "discovery_run_newer_owner",
      startedAt: "2026-03-20T11:00:00.000Z",
    });
    let interceptedFirstCommit = false;
    const repository: Parameters<typeof createService>[0] = {
      ...baseRepository,
      commitDiscoveryStateUpdate: async (update) => {
        if (!interceptedFirstCommit) {
          interceptedFirstCommit = true;
          await baseRepository.commitDiscoveryStateUpdate((current) => ({
            ...current,
            runState: "running",
            activeRun: newerOwnerRun,
          }));
        }
        return baseRepository.commitDiscoveryStateUpdate(update);
      },
    };
    const reopenedService = createService(repository);

    await vi.waitFor(() => expect(interceptedFirstCommit).toBe(true));
    await reopenedService.getWorkspaceSnapshot();

    const persisted = await baseRepository.getDiscoveryState();
    expect(persisted.runState).toBe("running");
    expect(persisted.activeRun?.id).toBe("discovery_run_newer_owner");
    expect(persisted.recentRuns.some((run) => run.id === staleRun.id)).toBe(
      false,
    );
  });

  test("interrupted-run recovery leaves a state a newer owner already cleared untouched", async () => {
    const baseRepository = createInMemoryJobFinderRepository(createSeed());
    const staleRun = createInterruptedDiscoveryRun();
    await baseRepository.commitDiscoveryStateUpdate((current) => ({
      ...current,
      runState: "running",
      activeRun: staleRun,
    }));

    let interceptedFirstCommit = false;
    const repository: Parameters<typeof createService>[0] = {
      ...baseRepository,
      commitDiscoveryStateUpdate: async (update) => {
        if (!interceptedFirstCommit) {
          interceptedFirstCommit = true;
          await baseRepository.commitDiscoveryStateUpdate((current) => ({
            ...current,
            runState: "idle",
            activeRun: null,
          }));
        }
        return baseRepository.commitDiscoveryStateUpdate(update);
      },
    };
    const reopenedService = createService(repository);

    await vi.waitFor(() => expect(interceptedFirstCommit).toBe(true));
    await reopenedService.getWorkspaceSnapshot();

    const persisted = await baseRepository.getDiscoveryState();
    expect(persisted.runState).toBe("idle");
    expect(persisted.activeRun).toBeNull();
    expect(persisted.recentRuns.some((run) => run.id === staleRun.id)).toBe(
      false,
    );
  });
});
