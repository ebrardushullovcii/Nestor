import { describe, expect, test } from "vitest";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createSeed } from "./workspace-service.test-fixtures";

const editedAt = "2026-08-20T09:00:00.000Z";

async function harnessWithStaleProgress() {
  const harness = createWorkspaceServiceHarness({ seed: createSeed() });
  const initial = await harness.workspaceService.getWorkspaceSnapshot();
  const state = await harness.repository.getCampaignState();
  if (!state) throw new Error("Expected the adopted plan.");
  // An edited plan whose stored progress is behind the jobs, as after a
  // restart: the next snapshot derives new progress.
  await harness.repository.saveCampaignState({
    ...state,
    campaigns: state.campaigns.map((campaign) => ({
      ...campaign,
      updatedAt: editedAt,
      progress: { ...campaign.progress, jobsFound: 0, jobsRetained: 0 },
    })),
  });
  return { harness, jobCount: initial.campaigns[0]?.progress.jobsFound ?? 0 };
}

describe("a plan's updatedAt", () => {
  test("stays at the last edit when the snapshot refreshes its progress", async () => {
    const { harness, jobCount } = await harnessWithStaleProgress();
    expect(jobCount).toBeGreaterThan(0);

    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    expect(snapshot.campaigns[0]?.progress.jobsFound).toBe(jobCount);
    expect(snapshot.campaigns[0]?.updatedAt).toBe(editedAt);
    const stored = await harness.repository.getCampaignState();
    expect(stored?.campaigns[0]?.progress.jobsFound).toBe(jobCount);
    expect(stored?.campaigns[0]?.updatedAt).toBe(editedAt);
  });

  test("stays at the last edit in the display projection the Assistant edits from", async () => {
    const { harness, jobCount } = await harnessWithStaleProgress();
    const projection =
      await (harness.workspaceService.getWorkspaceProjection?.() ??
        harness.workspaceService.getWorkspaceSnapshot());
    expect(projection.campaigns[0]?.progress.jobsFound).toBe(jobCount);
    expect(projection.campaigns[0]?.updatedAt).toBe(editedAt);
  });
});
