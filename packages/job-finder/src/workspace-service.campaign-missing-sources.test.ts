import { describe, expect, test } from "vitest";

import { DISCOVERY_NO_JOB_SITES_MESSAGE } from "@nestor/contracts";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";

/**
 * Removing the only job site in Profile and then pressing Run now used to do
 * nothing at all: no run started, the plan card kept "Last run succeeded" from
 * days earlier, and Find jobs kept its stale success banner. A run that cannot
 * search has to start and end as a failed run that says why.
 */
describe("running a plan whose sources are gone", () => {
  test("records a failed run with the plain reason instead of doing nothing", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const before = await workspaceService.getWorkspaceSnapshot();
    const campaign = before.campaigns.find(
      (candidate) => candidate.id === before.activeCampaignId,
    );
    if (!campaign) throw new Error("Expected an active campaign fixture.");

    // The plan still exists; the sources behind it are gone.
    await workspaceService.saveSearchPreferences({
      ...campaign.searchPreferences,
      discovery: { ...campaign.searchPreferences.discovery, targets: [] },
    });
    await workspaceService.saveCampaign({
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      mode: campaign.mode,
      status: campaign.status,
      searchPreferences: {
        ...campaign.searchPreferences,
        discovery: { ...campaign.searchPreferences.discovery, targets: [] },
      },
      sourceTargetIds: [],
      minimumFitScore: campaign.minimumFitScore,
      limits: campaign.limits,
      stopRules: campaign.stopRules,
      applicationPolicy: campaign.applicationPolicy,
      rules: campaign.rules,
      schedule: campaign.schedule,
      latestDigest: campaign.latestDigest,
    });

    await expect(
      workspaceService.runCampaignNow({ campaignId: campaign.id }),
    ).rejects.toThrow(DISCOVERY_NO_JOB_SITES_MESSAGE);

    const discovery = await repository.getDiscoveryState();
    const recordedRun = discovery.recentRuns.find(
      (run) => run.campaignId === campaign.id,
    );
    expect(recordedRun?.state).toBe("failed");
    expect(recordedRun?.summary.warnings).toContain(
      DISCOVERY_NO_JOB_SITES_MESSAGE,
    );

    const campaignState = await repository.getCampaignState();
    const ranPlan = campaignState?.campaigns.find(
      (candidate) => candidate.id === campaign.id,
    );
    expect(ranPlan?.schedule.runFacts.lastRunOutcome).toBe("failed");
    expect(ranPlan?.schedule.runFacts.lastRunAt).not.toBeNull();
  });

  test("supersedes an earlier success so the newest run is the failure", async () => {
    // The plan card, its history and Home all read the newest run for this
    // plan. A plan that had already searched successfully kept that success
    // as its newest record, which is what a person sees after removing the
    // last source.
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const before = await workspaceService.getWorkspaceSnapshot();
    const campaign = before.campaigns.find(
      (candidate) => candidate.id === before.activeCampaignId,
    );
    if (!campaign) throw new Error("Expected an active campaign fixture.");

    await workspaceService.runCampaignNow({ campaignId: campaign.id });
    const afterSuccess = await repository.getCampaignState();
    expect(
      afterSuccess?.campaigns.find((candidate) => candidate.id === campaign.id)
        ?.schedule.runFacts.lastRunOutcome,
    ).toBe("success");

    await workspaceService.saveSearchPreferences({
      ...campaign.searchPreferences,
      discovery: { ...campaign.searchPreferences.discovery, targets: [] },
    });
    await workspaceService.saveCampaign({
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      mode: campaign.mode,
      status: campaign.status,
      searchPreferences: {
        ...campaign.searchPreferences,
        discovery: { ...campaign.searchPreferences.discovery, targets: [] },
      },
      sourceTargetIds: [],
      minimumFitScore: campaign.minimumFitScore,
      limits: campaign.limits,
      stopRules: campaign.stopRules,
      applicationPolicy: campaign.applicationPolicy,
      rules: campaign.rules,
      schedule: campaign.schedule,
      latestDigest: campaign.latestDigest,
    });

    await expect(
      workspaceService.runCampaignNow({ campaignId: campaign.id }),
    ).rejects.toThrow(DISCOVERY_NO_JOB_SITES_MESSAGE);

    const discovery = await repository.getDiscoveryState();
    expect(discovery.recentRuns[0]?.state).toBe("failed");
    expect(discovery.recentRuns[0]?.summary.warnings).toContain(
      DISCOVERY_NO_JOB_SITES_MESSAGE,
    );

    const campaignState = await repository.getCampaignState();
    expect(
      campaignState?.campaigns.find((candidate) => candidate.id === campaign.id)
        ?.schedule.runFacts.lastRunOutcome,
    ).toBe("failed");
  });
});
