import { createTestJobSites } from "./source-debug.test-support";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAgentBrowserRuntime,
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed as createBaseSeed,
} from "./workspace-service.test-support";

function createSeed() {
  const seed = createBaseSeed();
  seed.searchPreferences.discovery.targets[0]!.id = "1";
  return seed;
}

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
    jobSites: createTestJobSites(
      createSeed().searchPreferences.discovery.targets,
    ),
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

async function configureAutomaticFailureThreshold(
  service: WorkspaceService,
  repository: Repository,
  pauseOnFailureRatePercent: number,
): Promise<string> {
  // Builds the default campaign in the snapshot if the seed has none yet.
  await service.getWorkspaceSnapshot();
  const campaignState = await repository.getCampaignState();
  const activeCampaign = campaignState?.campaigns.find(
    (campaign) => campaign.id === campaignState.activeCampaignId,
  );
  if (!campaignState || !activeCampaign) {
    throw new Error("Expected an active campaign fixture.");
  }

  await repository.saveCampaignState({
    ...campaignState,
    campaigns: campaignState.campaigns.map((campaign) =>
      campaign.id === activeCampaign.id
        ? {
            ...campaign,
            sourceTargetIds: ["1"],
            stopRules: {
              ...campaign.stopRules,
              pauseOnFailureRatePercent,
              failureRateMinimumSample: 1,
            },
          }
        : campaign,
    ),
  });
  return activeCampaign.id;
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

    const sourceResult = await service.runSourceDebug("1");
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

    const result = await service.runSourceDebug("1");
    const run = result.recentSourceDebugRuns[0];

    expect(run?.state).toBe("failed");
    expect(run?.finalSummary).toContain("agent service was unavailable");
    expect(run?.finalSummary).not.toContain("safeguard");
    expect(
      (await repository.getIntelligenceState()).safeguards
        .abnormalFailurePauses,
    ).toEqual([]);
  });
});
