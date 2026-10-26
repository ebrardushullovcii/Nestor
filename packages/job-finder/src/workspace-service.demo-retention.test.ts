import { describe, expect, test } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

/**
 * Regression guard for the demo/manual-save data-gating blocker. Demo and
 * manually saved workspaces persist no campaign state, so every queue surface
 * must stay reachable through adoption/reconciliation instead of an empty
 * `campaigns[0].jobIds` gate.
 */
describe("workspace service demo retention", () => {
  test("adopts a campaign-free demo seed with non-empty Shortlisted and coherent sources", async () => {
    const seed = createSeed();
    expect(seed.campaigns).toEqual([]);
    const harness = createWorkspaceServiceHarness({ seed });

    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    const activeCampaign = snapshot.campaigns.find(
      (campaign) => campaign.id === snapshot.activeCampaignId,
    );

    expect(activeCampaign).toBeDefined();
    expect(activeCampaign?.jobIds).toEqual(
      expect.arrayContaining(seed.savedJobs.map((job) => job.id)),
    );
    expect(snapshot.reviewQueue.length).toBeGreaterThan(0);
    expect(snapshot.dashboard.jobsAwaitingReview).toBeGreaterThan(0);
    expect(snapshot.siteCounts.enabled).toBe(
      seed.searchPreferences.discovery.targets.filter(
        (target) => target.enabled,
      ).length,
    );
  });

  test("reconciles a stale empty-retention campaign back into the queues on read", async () => {
    const seed = createSeed();
    const harness = createWorkspaceServiceHarness({ seed });
    const { repository, workspaceService } = harness;

    const healthy = await workspaceService.getWorkspaceSnapshot();
    expect(healthy.dashboard.jobsAwaitingReview).toBeGreaterThan(0);

    // Simulate the legacy stale singleton: retention wiped after adoption
    // while the adoption history stays intact.
    const staleState = await repository.getCampaignState();
    expect(staleState).not.toBeNull();
    if (!staleState) return;
    await repository.saveCampaignState({
      notifications: staleState.notifications,
      activeCampaignId: staleState.activeCampaignId,
      campaigns: staleState.campaigns.map((campaign) =>
        campaign.id === staleState.activeCampaignId
          ? { ...campaign, jobIds: [] }
          : campaign,
      ),
    });
    const gated = await workspaceService.getWorkspaceSnapshot();
    expect(gated.dashboard.jobsAwaitingReview).toBeGreaterThan(0);

    const repaired = await repository.getCampaignState();
    expect(
      repaired?.campaigns.find(
        (campaign) => campaign.id === repaired.activeCampaignId,
      )?.jobIds,
    ).toEqual(expect.arrayContaining(seed.savedJobs.map((job) => job.id)));
  });
});
