import {
  ApplicationCrmSettingsSchema,
  DiscoveryRunRecordSchema,
  SavedJobSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import { createCampaign } from "./internal/campaign-dashboard";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";

afterEach(() => vi.restoreAllMocks());

describe("interactive settings display snapshots", () => {
  test.each(["behavior", "crm", "theme"] as const)(
    "%s returns updated settings without full jobs or canonical discovery, while public snapshots retain checkpoints",
    async (mutation) => {
      const seed = createSeed();
      seed.savedJobs = Array.from({ length: 3000 }, (_, index) =>
        SavedJobSchema.parse({
          ...seed.savedJobs[0],
          id: `settings_job_${index}`,
          sourceJobId: `settings_job_${index}`,
          canonicalUrl: `https://example.com/jobs/${index}`,
          applicationUrl: `https://example.com/jobs/${index}/apply`,
          company: `Synthetic company ${index}`,
          status: "discovered",
        }),
      );
      seed.tailoredAssets = [];
      // Interactive settings run after the first plan exists. Creating a
      // workspace's first plan intentionally imports its canonical history.
      seed.campaigns = [
        createCampaign({
          id: "settings_plan",
          name: "Synthetic settings plan",
          mode: "precision",
          searchPreferences: seed.searchPreferences,
          now: "2026-10-13T10:00:00.000Z",
        }),
      ];
      seed.activeCampaignId = "settings_plan";
      seed.settings = {
        ...seed.settings,
        appearanceTheme: "dark",
        keepSessionAlive: true,
        discoveryOnly: false,
        salaryDisclosure: "pause_for_user",
        applicationCrm: ApplicationCrmSettingsSchema.parse({
          noResponseAutomation: { enabled: false, afterDays: 30 },
        }),
      };
      const run = DiscoveryRunRecordSchema.parse({
        id: "settings_checkpoint_run",
        campaignId: "settings_plan",
        state: "completed",
        scope: "run_all",
        startedAt: "2026-10-13T10:00:00.000Z",
        completedAt: "2026-10-13T10:00:01.000Z",
        targetIds: ["settings_target"],
        targetExecutions: [
          {
            targetId: "settings_target",
            state: "completed",
            adapterKind: "auto",
            agentCheckpoint: {
              revision: 7,
              savedAt: "2026-10-13T10:00:00.000Z",
              stepCount: 1,
              currentUrl: "https://example.com/jobs",
              lastStableUrl: "https://example.com/jobs",
              collectedJobs: [seed.savedJobs[0]],
              visitedUrls: [],
              phaseEvidence: {},
            },
          },
        ],
        summary: { targetsPlanned: 1, outcome: "completed" },
      });
      seed.discovery = { ...seed.discovery, recentRuns: [run] };
      const repository = createInMemoryJobFinderRepository(seed);
      const service = createJobFinderWorkspaceService({
        repository,
        browserRuntime: createBrowserRuntime(),
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });
      const allJobs = vi.spyOn(repository, "listSavedJobs");
      const canonicalDiscovery = vi.spyOn(repository, "getDiscoveryState");
      const displayJobs = vi.spyOn(repository, "readSavedJobsProjection");
      const displayDiscovery = vi.spyOn(
        repository,
        "readDiscoveryDisplayProjection",
      );
      const expected = {
        appearanceTheme: mutation === "theme" ? "light" : "dark",
        keepSessionAlive: mutation !== "behavior",
        discoveryOnly: mutation === "behavior",
        applicationCrm: ApplicationCrmSettingsSchema.parse({
          noResponseAutomation: {
            enabled: false,
            afterDays: mutation === "crm" ? 5 : 30,
          },
        }),
      };
      const display =
        mutation === "theme"
          ? await service.updateAppearanceTheme("light")
          : mutation === "behavior"
            ? await service.updateWorkspaceBehavior({
                keepSessionAlive: false,
                discoveryOnly: true,
              })
            : await service.updateTrackerCrm(expected.applicationCrm);

      expect(display.settings).toMatchObject(expected);
      expect(await repository.getSettings()).toMatchObject(expected);
      expect(allJobs).not.toHaveBeenCalled();
      expect(canonicalDiscovery).not.toHaveBeenCalled();
      expect(displayJobs).toHaveBeenCalled();
      expect(displayDiscovery).toHaveBeenCalled();
      expect(
        display.recentDiscoveryRuns[0]?.targetExecutions[0]?.agentCheckpoint,
      ).toBeNull();

      const canonical = await service.getWorkspaceSnapshot();
      expect(canonical.settings).toMatchObject(expected);
      expect(allJobs).toHaveBeenCalledTimes(1);
      expect(canonicalDiscovery).toHaveBeenCalledTimes(1);
      expect(
        canonical.recentDiscoveryRuns[0]?.targetExecutions[0]?.agentCheckpoint,
      ).toMatchObject({ revision: 7 });
    },
  );
});
