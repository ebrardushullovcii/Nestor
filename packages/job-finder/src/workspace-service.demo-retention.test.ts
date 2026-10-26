import { describe, expect, test } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

/** Campaign-free legacy fixtures receive a read-only queue projection. */
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
});
