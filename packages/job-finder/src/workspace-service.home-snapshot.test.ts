import { describe, expect, test } from "vitest";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import { createSeed } from "./workspace-service.test-fixtures";

describe("Home's first view (ADR 0077)", () => {

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
