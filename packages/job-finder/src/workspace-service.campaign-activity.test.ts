import { describe, expect, test, vi } from "vitest";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function createInterruptibleBrowserRuntime() {
  const baseRuntime = createBrowserRuntime();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const executionState: { signal?: AbortSignal } = {};
  const executeApplicationFlow = vi.fn(
    async (
      _source: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[0],
      _input: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[1],
      options?: Parameters<BrowserSessionRuntime["executeApplicationFlow"]>[2],
    ) => {
      if (!options?.signal) {
        throw new Error("Expected direct apply execution to receive a signal.");
      }
      const signal = options.signal;
      executionState.signal = signal;
      markStarted();
      return new Promise<never>((_resolve, reject) => {
        const abort = () =>
          reject(new DOMException("Application flow aborted.", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
    },
  );

  return {
    browserRuntime: {
      ...baseRuntime,
      executeApplicationFlow,
    },
    executeApplicationFlow,
    executionState,
    started,
  };
}

function createService() {
  const repository = createInMemoryJobFinderRepository(createSeed());
  const service = createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
    exportFileVerifier: { exists: () => Promise.resolve(true) },
    researchAdapter: createResearchAdapter(),
  });
  return { repository, service };
}

describe("workspace campaign and activity controls", () => {
  test("persists pause state, and an explicit user action resumes it instead of failing", async () => {
    const { service } = createService();
    const paused = await service.setActivityControl({
      paused: true,
      reason: "Pause all browser work.",
    });

    expect(paused.activityControl).toMatchObject({
      paused: true,
      reason: "Pause all browser work.",
    });
    // A deliberate Check source click clears the pause; it must never fail
    // with "press Resume on Home first" (whatever the check itself returns).
    await service.runSourceDebug("target_linkedin_default").catch((error) => {
      expect(String(error)).not.toContain("activity is paused");
    });
    expect(
      (await service.getWorkspaceSnapshot()).activityControl.paused,
    ).toBe(false);

    await service.setActivityControl({ paused: true, reason: "Again." });
    const resumed = await service.setActivityControl({ paused: false });
    expect(resumed.activityControl).toEqual({
      paused: false,
      pausedAt: null,
      reason: null,
    });
  });

  test("rejects discovery when the active campaign itself is paused", async () => {
    const { service } = createService();
    const snapshot = await service.getWorkspaceSnapshot();
    const active = snapshot.campaigns.find(
      (campaign) => campaign.id === snapshot.activeCampaignId,
    );
    if (!active) throw new Error("Expected an active campaign fixture.");

    await service.saveCampaign({
      id: active.id,
      name: active.name,
      description: active.description,
      mode: active.mode,
      status: "paused",
      searchPreferences: active.searchPreferences,
      sourceTargetIds: active.sourceTargetIds,
      minimumFitScore: active.minimumFitScore,
      limits: active.limits,
      stopRules: active.stopRules,
      applicationPolicy: active.applicationPolicy,
      schedule: active.schedule,
      rules: active.rules,
      latestDigest: active.latestDigest,
    });

    await expect(service.runDiscovery()).rejects.toThrow(
      "Set it to active before starting discovery",
    );
  });

  test("Home pause keeps the current browser run alive until Resume", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    const interruptible = createInterruptibleBrowserRuntime();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: interruptible.browserRuntime,
    });
    const firstRun = workspaceService.startApplyCopilotRun("job_ready");
    await interruptible.started;
    const before = (await repository.listApplyRuns())[0]!;

    const paused = await workspaceService.setActivityControl({
      paused: true,
      reason: "Paused by you.",
      pauseBehavior: "finish_current",
    });
    expect(paused.activityControl.pauseBehavior).toBe("finish_current");
    expect(interruptible.executionState.signal?.aborted).toBe(false);
    expect((await repository.listApplyRuns())[0]).toMatchObject({
      id: before.id,
      state: "running",
    });

    await workspaceService.setActivityControl({ paused: false });
    expect((await repository.listApplyRuns())[0]?.id).toBe(before.id);
    const aborted = expect(firstRun).rejects.toThrow(/aborted/i);
    await workspaceService.cancelApplyRun(before.id);
    await aborted;
  });

  test("deduplicates and aborts a direct copilot browser run when activity pauses", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    const interruptible = createInterruptibleBrowserRuntime();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: interruptible.browserRuntime,
    });

    const firstRun = workspaceService.startApplyCopilotRun("job_ready");
    await interruptible.started;
    expect(await repository.listApplyRuns()).toEqual([
      expect.objectContaining({
        state: "running",
        jobIds: ["job_ready"],
      }),
    ]);
    await expect(
      workspaceService.startApplyCopilotRun("job_ready"),
    ).rejects.toThrow(/already being prepared/i);

    const pause = workspaceService.setActivityControl({ paused: true });
    await expect(firstRun).rejects.toThrow(/aborted/i);
    const paused = await pause;

    expect(interruptible.executeApplicationFlow).toHaveBeenCalledTimes(1);
    expect(interruptible.executionState.signal?.aborted).toBe(true);
    const pausedRun = paused.applyRuns[0];
    expect(pausedRun?.state).toBe("cancelled");
    expect(typeof pausedRun?.completedAt).toBe("string");
  });

  test("deduplicates and aborts the legacy approveApply browser run when activity pauses", async () => {
    const interruptible = createInterruptibleBrowserRuntime();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      browserRuntime: interruptible.browserRuntime,
    });
    await workspaceService.generateResume("job_ready");
    const exported = await workspaceService.exportResumePdf("job_ready");
    const exportArtifact = exported.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(exportArtifact).toBeTruthy();
    await workspaceService.approveResume("job_ready", exportArtifact!.id);

    const firstRun = workspaceService.approveApply("job_ready");
    await interruptible.started;
    expect(await repository.listApplyRuns()).toEqual([
      expect.objectContaining({
        state: "running",
        jobIds: ["job_ready"],
      }),
    ]);
    await expect(workspaceService.approveApply("job_ready")).rejects.toThrow(
      /already being prepared/i,
    );

    const pause = workspaceService.setActivityControl({ paused: true });
    await expect(firstRun).rejects.toThrow(/aborted/i);
    const paused = await pause;

    expect(interruptible.executeApplicationFlow).toHaveBeenCalledTimes(1);
    expect(interruptible.executionState.signal?.aborted).toBe(true);
    const pausedRun = paused.applyRuns[0];
    expect(pausedRun?.state).toBe("cancelled");
    expect(typeof pausedRun?.completedAt).toBe("string");
  });

  test("aborts and recovers a direct copilot run when the workspace shuts down", async () => {
    const seed = createSeed();
    seed.settings = {
      ...seed.settings,
      resumeApplicationMode: "original_resume",
    };
    const interruptible = createInterruptibleBrowserRuntime();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: interruptible.browserRuntime,
    });

    const firstRun = workspaceService.startApplyCopilotRun("job_ready");
    await interruptible.started;
    const shutdown = workspaceService.shutdown();
    await expect(firstRun).rejects.toThrow(/aborted/i);
    await shutdown;

    expect(interruptible.executionState.signal?.aborted).toBe(true);
    const recoveredRun = (await repository.listApplyRuns())[0];
    expect(recoveredRun?.state).toBe("failed");
    expect(recoveredRun?.summary).toBe(
      "Automatic apply stopped because the app closed.",
    );
  });
});
