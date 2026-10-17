import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  ApplyJobResultSchema,
  ApplyRunSchema,
  type JobSearchCampaign,
  type SaveJobSearchCampaignInput,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAgentBrowserRuntime,
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";

type Repository = ReturnType<typeof createInMemoryJobFinderRepository>;
type WorkspaceService = ReturnType<typeof createJobFinderWorkspaceService>;

afterEach(() => {
  vi.restoreAllMocks();
});

function createService(
  repository: Repository,
  browserRuntime: BrowserSessionRuntime = createBrowserRuntime(),
): WorkspaceService {
  return createJobFinderWorkspaceService({
    repository,
    browserRuntime,
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
  });
}

function createAutomaticFailureRuntime(): BrowserSessionRuntime {
  const baseRuntime = createAgentBrowserRuntime([]);

  return {
    ...baseRuntime,
    async runAgentDiscovery(source, options) {
      const result = await baseRuntime.runAgentDiscovery!(source, options);
      const now = new Date().toISOString();
      return {
        ...result,
        startedAt: now,
        completedAt: now,
        warning: "Agent runtime failed while probing the source.",
        agentMetadata: result.agentMetadata
          ? {
              ...result.agentMetadata,
              phaseCompletionMode: "runtime_failed",
              phaseCompletionReason:
                "Agent runtime failed while probing the source.",
            }
          : null,
      };
    },
  };
}

function toCampaignInput(
  campaign: JobSearchCampaign,
  overrides: Partial<SaveJobSearchCampaignInput> = {},
): SaveJobSearchCampaignInput {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    mode: campaign.mode,
    status: campaign.status,
    searchPreferences: campaign.searchPreferences,
    sourceTargetIds: campaign.sourceTargetIds,
    minimumFitScore: campaign.minimumFitScore,
    limits: campaign.limits,
    stopRules: campaign.stopRules,
    applicationPolicy: campaign.applicationPolicy,
    schedule: campaign.schedule,
    rules: campaign.rules,
    latestDigest: campaign.latestDigest,
    ...overrides,
  };
}

async function configureAutomaticFailureThreshold(
  service: WorkspaceService,
  repository: Repository,
  pauseOnFailureRatePercent: number,
): Promise<string> {
  const initialSnapshot = await service.getWorkspaceSnapshot();
  const activeCampaign = initialSnapshot.campaigns.find(
    (campaign) => campaign.id === initialSnapshot.activeCampaignId,
  );
  if (!activeCampaign) {
    throw new Error("Expected an active campaign fixture.");
  }

  await service.saveCampaign(
    toCampaignInput(activeCampaign, {
      stopRules: {
        ...activeCampaign.stopRules,
        pauseOnFailureRatePercent,
        failureRateMinimumSample: 1,
      },
    }),
  );

  const campaignState = await repository.getCampaignState();
  const configuredCampaign = campaignState?.campaigns.find(
    (campaign) => campaign.id === activeCampaign.id,
  );
  if (!configuredCampaign) {
    throw new Error("Expected the configured campaign to persist.");
  }
  return configuredCampaign.id;
}

async function seedInterruptedApplyEvidence(
  repository: Repository,
  campaignId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await repository.upsertApplyRun(
    ApplyRunSchema.parse({
      id: "apply_run_automatic_safeguard_restart",
      campaignId,
      mode: "queue_auto",
      state: "running",
      jobIds: ["job_ready"],
      currentJobId: "job_ready",
      submitApprovalId: "apply_approval_restart",
      visualCheckpointsEnabled: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      summary: "Automatic apply queue is running in safe review mode.",
      detail: "The synthetic queue is waiting for safe review.",
      totalJobs: 1,
      pendingJobs: 1,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    }),
  );
  await repository.upsertApplyJobResult(
    ApplyJobResultSchema.parse({
      id: "apply_result_automatic_safeguard_restart",
      runId: "apply_run_automatic_safeguard_restart",
      jobId: "job_ready",
      queuePosition: 0,
      state: "failed",
      summary: "Synthetic application preparation failed.",
      detail: "The synthetic form could not be interpreted safely.",
      startedAt: now,
      updatedAt: now,
      completedAt: now,
      blockerReason: "field_interpretation_failed",
      blockerSummary: "The form could not be interpreted safely.",
    }),
  );
}

describe("workspace service automatic safeguard persistence", () => {
  test("persists source-debug safeguards and keeps one pause across snapshots and reload", async () => {
    const repository = createInMemoryJobFinderRepository({
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
    });
    const service = createService(repository, createAutomaticFailureRuntime());
    const campaignId = await configureAutomaticFailureThreshold(
      service,
      repository,
      10,
    );
    const saveIntelligenceState = vi.spyOn(repository, "saveIntelligenceState");

    const sourceResult = await service.runSourceDebug(
      "target_linkedin_default",
    );
    expect(sourceResult.recentSourceDebugRuns[0]?.state).toBe("failed");

    const firstSnapshot = await service.getWorkspaceSnapshot();
    const firstPause =
      firstSnapshot.intelligence.safeguards.abnormalFailurePauses.find(
        (pause) => pause.id === `automatic_source_debug_failures:${campaignId}`,
      );
    expect(firstPause).toMatchObject({
      failuresInWindow: 1,
      sampleSize: 2,
      failureRateThresholdPercent: 10,
    });
    expect(firstPause?.failureRatePercent).toBeCloseTo(50, 3);
    expect(saveIntelligenceState).toHaveBeenCalledTimes(1);

    const secondSnapshot = await service.getWorkspaceSnapshot();
    expect(secondSnapshot.intelligence.safeguards).toEqual(
      firstSnapshot.intelligence.safeguards,
    );

    const reopenedSnapshot = await createService(
      repository,
      createAutomaticFailureRuntime(),
    ).getWorkspaceSnapshot();
    expect(reopenedSnapshot.intelligence.safeguards).toEqual(
      firstSnapshot.intelligence.safeguards,
    );
    expect(saveIntelligenceState).toHaveBeenCalledTimes(1);
    expect(
      (await repository.getIntelligenceState()).safeguards
        .abnormalFailurePauses,
    ).toHaveLength(1);
  });

  test("does not replace a failed source-debug result with a safeguard write error", async () => {
    const repository = createInMemoryJobFinderRepository({
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
    });
    const service = createService(repository, createAutomaticFailureRuntime());
    await configureAutomaticFailureThreshold(service, repository, 10);
    vi.spyOn(repository, "saveIntelligenceState").mockRejectedValueOnce(
      new Error("synthetic safeguard write failed"),
    );

    const result = await service.runSourceDebug("target_linkedin_default");
    const run = result.recentSourceDebugRuns[0];

    expect(run?.state).toBe("failed");
    expect(run?.finalSummary).toContain("agent service was unavailable");
    expect(run?.finalSummary).not.toContain("safeguard");
    expect(
      (await repository.getIntelligenceState()).safeguards
        .abnormalFailurePauses,
    ).toEqual([]);
  });

  test("persists apply safeguards while recovering a run and keeps one pause across snapshots and reload", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const setupService = createService(repository);
    const campaignId = await configureAutomaticFailureThreshold(
      setupService,
      repository,
      100,
    );
    await seedInterruptedApplyEvidence(repository, campaignId);
    const saveIntelligenceState = vi.spyOn(repository, "saveIntelligenceState");

    const reopenedService = createService(repository);
    const firstSnapshot = await reopenedService.getWorkspaceSnapshot();
    const recoveredRun = firstSnapshot.applyRuns.find(
      (run) => run.id === "apply_run_automatic_safeguard_restart",
    );
    expect(recoveredRun).toMatchObject({ state: "failed" });

    const firstPause =
      firstSnapshot.intelligence.safeguards.abnormalFailurePauses.find(
        (pause) => pause.id === `automatic_application_failures:${campaignId}`,
      );
    expect(firstPause).toMatchObject({
      failuresInWindow: 1,
      sampleSize: 1,
      failureRatePercent: 100,
      failureRateThresholdPercent: 100,
    });
    expect(saveIntelligenceState).toHaveBeenCalledTimes(1);

    const secondSnapshot = await reopenedService.getWorkspaceSnapshot();
    expect(secondSnapshot.intelligence.safeguards).toEqual(
      firstSnapshot.intelligence.safeguards,
    );
    const reloadedSnapshot =
      await createService(repository).getWorkspaceSnapshot();
    expect(reloadedSnapshot.intelligence.safeguards).toEqual(
      firstSnapshot.intelligence.safeguards,
    );
    expect(saveIntelligenceState).toHaveBeenCalledTimes(1);
    expect(
      (await repository.getIntelligenceState()).safeguards
        .abnormalFailurePauses,
    ).toHaveLength(1);
  });

  test("does not replace a recovered apply result with a safeguard write error", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const setupService = createService(repository);
    const campaignId = await configureAutomaticFailureThreshold(
      setupService,
      repository,
      100,
    );
    await seedInterruptedApplyEvidence(repository, campaignId);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(repository, "saveIntelligenceState").mockRejectedValueOnce(
      new Error("synthetic safeguard write failed"),
    );

    const result = await createService(repository).getWorkspaceSnapshot();
    const recoveredRun = result.applyRuns.find(
      (run) => run.id === "apply_run_automatic_safeguard_restart",
    );

    expect(recoveredRun).toMatchObject({
      state: "failed",
      summary: "Automatic apply stopped because the app closed.",
    });
    expect(recoveredRun?.detail).not.toContain("safeguard");
    expect(
      (await repository.getIntelligenceState()).safeguards
        .abnormalFailurePauses,
    ).toEqual([]);
  });
});

describe("application failure pause at the next start", () => {
  test("is measured again from the evidence on record, so sent applications lift a stale 100% pause", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    const setupService = createService(repository);
    const campaignId = await configureAutomaticFailureThreshold(
      setupService,
      repository,
      60,
    );
    await seedInterruptedApplyEvidence(repository, campaignId);
    const service = createService(repository);
    const paused = (
      await service.getWorkspaceSnapshot()
    ).intelligence.safeguards.abnormalFailurePauses.find(
      (pause) => pause.id === `automatic_application_failures:${campaignId}`,
    );
    expect(paused).toMatchObject({ paused: true, sampleSize: 1 });

    const now = new Date().toISOString();
    await repository.upsertApplyRun(
      ApplyRunSchema.parse({
        id: "apply_run_sent",
        campaignId,
        mode: "queue_auto",
        state: "completed",
        jobIds: ["job_sent"],
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        summary: "Application submitted",
        detail: "Application submitted",
        totalJobs: 1,
        pendingJobs: 0,
      }),
    );
    await repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "apply_result_sent",
        runId: "apply_run_sent",
        jobId: "job_sent",
        state: "submitted",
        summary: "Application submitted",
        detail: "The employer site confirmed that it received the application.",
        startedAt: now,
        updatedAt: now,
        completedAt: now,
      }),
    );

    await service.startApplyCopilotRun("job_ready").catch(() => undefined);

    const pause = (
      await repository.getIntelligenceState()
    ).safeguards.abnormalFailurePauses.find(
      (entry) => entry.id === `automatic_application_failures:${campaignId}`,
    );
    expect(pause).toMatchObject({ sampleSize: 2, paused: false });
    expect(pause?.failureRatePercent).toBeCloseTo(50, 3);
  });
});
