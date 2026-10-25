import { describe, expect, test } from "vitest";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createSeed } from "./workspace-service.test-fixtures";

describe("Home's first view (ADR 0077)", () => {
  test("holds what Home reads, as the full snapshot has it, without the Find jobs lists", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    // A workspace's first full snapshot creates its plan; until then the
    // first view has nothing to show and says so.
    expect(await harness.workspaceService.getWorkspaceHomeSnapshot?.()).toBe(
      null,
    );
    const full = await harness.workspaceService.getWorkspaceSnapshot();
    const home = await harness.workspaceService.getWorkspaceHomeSnapshot?.();
    if (!home) throw new Error("Expected Home's first view.");

    expect(home.hydration).toEqual({
      phase: "bootstrap",
      deferredCollections: ["discovery_jobs"],
    });
    // The rows of the jobs past Find jobs, as the full list has them.
    const byId = (rows: readonly { id: string }[]) =>
      [...rows].sort((left, right) => left.id.localeCompare(right.id));
    const shortlistedIds = new Set(home.reviewQueue.map((item) => item.jobId));
    expect(home.discoveryJobs.length).toBeGreaterThan(0);
    expect(home.discoveryJobs.every((job) => job.status !== "discovered")).toBe(
      true,
    );
    expect(byId(home.discoveryJobs)).toEqual(
      byId(
        full.discoveryJobs.filter((job) =>
          home.discoveryJobs.some((row) => row.id === job.id),
        ),
      ),
    );
    expect(
      [...shortlistedIds].every((id) =>
        home.discoveryJobs.some((job) => job.id === id),
      ),
    ).toBe(true);
    expect(home.dismissedDiscoveryJobs).toEqual([]);
    expect(home.companyJobs).toEqual([]);
    expect(full.reviewQueue.length).toBeGreaterThan(0);
    expect(home.reviewQueue).toEqual(full.reviewQueue);
    expect(home.applicationRecords).toEqual(full.applicationRecords);
    expect(home.applyRuns).toEqual(full.applyRuns);
    expect(home.tailoredAssets).toEqual(full.tailoredAssets);
    expect(home.recentDiscoveryRuns).toEqual(full.recentDiscoveryRuns);
    expect(home.activeCampaignId).toBe(full.activeCampaignId);
    expect(home.dashboard.globalDailyApplicationPreparationCapacity).toEqual(
      full.dashboard.globalDailyApplicationPreparationCapacity,
    );
  });

  test("writes nothing back from its partial view of the jobs", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    // The first full snapshot settles plans, progress and groupings.
    await harness.workspaceService.getWorkspaceSnapshot();
    const before = {
      campaigns: await harness.repository.getCampaignState(),
      intelligence: await harness.repository.getIntelligenceState(),
      records: await harness.repository.listApplicationRecords(),
    };

    await harness.workspaceService.getWorkspaceHomeSnapshot?.();

    expect(await harness.repository.getCampaignState()).toEqual(
      before.campaigns,
    );
    expect(await harness.repository.getIntelligenceState()).toEqual(
      before.intelligence,
    );
    expect(await harness.repository.listApplicationRecords()).toEqual(
      before.records,
    );
  });
});
