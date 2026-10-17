import { describe, expect, test } from "vitest";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import type { JobFinderRepository } from "@nestor/db";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
  createSeed,
} from "./workspace-service.test-support";

/**
 * A finished run's counts are measured once, at its own terminal commit. The
 * plan card, Find jobs, Home and Search history all quote that one record.
 *
 * A later Run now that never starts — the sources are gone, a safeguard
 * blocks it, or a read fails before the pipeline opens a run — still reached
 * the campaign's terminal commit. With no new run to commit, that commit
 * landed on the previous finished run and recounted it against the current
 * workspace, where the jobs it had introduced were by then already members of
 * the plan. The same search silently changed from "66 new" to "51 new" with
 * no search in between.
 */
describe("a finished run's frozen counts", () => {
  test("survive a Run now that never opened a run of its own", async () => {
    const repository = createInMemoryJobFinderRepository(createSeed());
    let failNextSettingsRead = false;
    const failingRepository: JobFinderRepository = {
      ...repository,
      getSettings: async () => {
        if (failNextSettingsRead) {
          throw new Error("Settings could not be read on this device.");
        }
        return repository.getSettings();
      },
    };
    const workspaceService = createJobFinderWorkspaceService({
      repository: failingRepository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });

    const before = await workspaceService.getWorkspaceSnapshot();
    const campaignId = before.activeCampaignId;
    await workspaceService.runCampaignNow({ campaignId });

    const afterRun = await repository.getDiscoveryState();
    const frozenReport = afterRun.recentRuns[0]?.summary.report;
    expect(frozenReport).toBeTruthy();

    failNextSettingsRead = true;
    await expect(
      workspaceService.runCampaignNow({ campaignId }),
    ).rejects.toThrow(/Settings could not be read/u);

    const afterRefusal = await repository.getDiscoveryState();
    expect(afterRefusal.recentRuns[0]?.id).toBe(afterRun.recentRuns[0]?.id);
    expect(afterRefusal.recentRuns[0]?.summary.report).toEqual(frozenReport);
  }, 120_000);
});
