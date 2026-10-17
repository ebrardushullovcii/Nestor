import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  DiscoveryLedgerEntrySchema,
  type DiscoveryInventoryCompleteness,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function createHarness(completeness: DiscoveryInventoryCompleteness) {
  const seed = createSeed();
  const savedJob = seed.savedJobs[0]!;
  seed.discovery.discoveryLedger = [
    DiscoveryLedgerEntrySchema.parse({
      id: "ledger_existing",
      canonicalUrl: savedJob.canonicalUrl,
      applicationUrl: savedJob.applicationUrl,
      source: savedJob.source,
      sourceJobId: savedJob.sourceJobId,
      providerKey: savedJob.providerKey,
      providerBoardToken: savedJob.providerBoardToken,
      providerIdentifier: savedJob.providerIdentifier,
      title: savedJob.title,
      company: savedJob.company,
      location: savedJob.location,
      postedAt: savedJob.postedAt,
      postedAtText: savedJob.postedAtText,
      targetId: "target_linkedin_default",
      firstSeenAt: "2026-08-22T08:00:00.000Z",
      lastSeenAt: "2026-08-22T08:00:00.000Z",
      latestStatus: "seen",
    }),
  ];
  const baseRuntime = createBrowserRuntime();
  const browserRuntime: BrowserSessionRuntime = {
    ...baseRuntime,
    runDiscovery(source) {
      return Promise.resolve({
        source,
        startedAt: "2026-08-23T08:00:00.000Z",
        completedAt: "2026-08-23T08:01:00.000Z",
        querySummary: "Exhaustiveness invariant test",
        warning: null,
        inventoryCompleteness: completeness,
        jobs: [],
        agentMetadata: null,
      });
    },
  };

  return createWorkspaceServiceHarness({ seed, browserRuntime });
}

describe("discovery inventory completeness", () => {
  test.each(["unknown", "partial"] as const)(
    "does not mark unseen listings inactive for warning-free %s inventory",
    async (completeness) => {
      const { repository, workspaceService } = createHarness(completeness);

      await workspaceService.runDiscovery();

      expect(
        (await repository.getDiscoveryState()).discoveryLedger[0]?.latestStatus,
      ).toBe("seen");
    },
  );

  test("marks unseen listings inactive only for warning-free complete inventory", async () => {
    const { repository, workspaceService } = createHarness("complete");

    await workspaceService.runDiscovery();

    expect(
      (await repository.getDiscoveryState()).discoveryLedger[0],
    ).toMatchObject({ latestStatus: "inactive" });
  });
});
