import { describe, expect, test } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

/** Campaign-free legacy fixtures receive a read-only queue projection. */
describe("workspace service demo retention", () => {
  test("goal saves preserve campaigns and Home counts current enabled job-site rows", async () => {
    const seed = createSeed();
    const { workspaceService, repository, jobSites } =
      createWorkspaceServiceHarness({ seed });
    jobSites.add({
      text: "https://second.synthetic.test/jobs\nhttps://disabled.synthetic.test/jobs",
    });
    const rows = jobSites.list().rows;
    jobSites.record(
      rows.find((row) => row.url.includes("second.synthetic"))!.id,
      { health: "needs_sign_in" },
    );
    jobSites.update({
      id: rows.find((row) => row.url.includes("disabled.synthetic"))!.id,
      enabled: false,
    });
    const first = await workspaceService.getWorkspaceSnapshot();
    expect(first.dashboard.sourceHealth).toEqual({
      healthy: 1,
      needsAttention: 1,
      running: 0,
      total: 2,
    });
    const campaigns = await repository.getCampaignState();
    const result = await workspaceService.saveSearchPreferences({
      ...first.searchPreferences,
      targetRoles: ["Platform Engineer"],
    });
    expect(result.dashboard.sourceHealth).toEqual(first.dashboard.sourceHealth);
    expect(result.searchPreferences.discovery.targets).toEqual([]);
    expect(await repository.getCampaignState()).toEqual(campaigns);
    expect(jobSites.counts().enabled).toBe(2);
  });

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
      seed.jobSites.filter((target) => target.enabled).length,
    );
  });
});
