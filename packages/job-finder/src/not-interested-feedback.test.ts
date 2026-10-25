import {
  JobFinderDismissDiscoveryJobInputSchema,
  SavedJobSchema,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { describe, expect, it, vi } from "vitest";
import { createJobFinderWorkspaceService } from "./index";
import { mergeSavedJobs } from "./internal/workspace-discovery-state-helpers";
import { createSeed } from "./workspace-service.test-fixtures";
import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "./workspace-service.test-runtimes";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("not-interested discovery feedback", () => {
  it("hides and restores one job with no feedback reasons", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness();
    const job = (await repository.listSavedJobs())[0]!;
    const hidden = await workspaceService.dismissDiscoveryJob(
      JobFinderDismissDiscoveryJobInputSchema.parse({
        jobId: job.id,
        reasons: [],
        action: "hide_job",
      }),
    );
    expect(hidden.discoveryJobs.some((entry) => entry.id === job.id)).toBe(
      false,
    );
    expect(
      hidden.dismissedDiscoveryJobs.find((entry) => entry.id === job.id)
        ?.discoveryFeedback?.reasons,
    ).toEqual([]);
    const restored = await workspaceService.restoreDismissedDiscoveryJob(
      job.id,
    );
    expect(restored.discoveryJobs.some((entry) => entry.id === job.id)).toBe(
      true,
    );
  });

  it("atomically hides and excludes only the previewed exact company name", async () => {
    const seed = createSeed();
    seed.searchPreferences = {
      ...seed.searchPreferences,
      companyWhitelist: [],
      excludedLocations: ["Antarctica"],
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });
    const job = seed.savedJobs.find(
      (candidate) => candidate.id === "job_generating",
    )!;
    await workspaceService.getWorkspaceSnapshot();
    const preview = await workspaceService.previewEmployerExclusion(job.id);
    expect(preview).toMatchObject({
      status: "available",
      displayCompanyName: "Northwind Labs",
      normalizedCompanyName: "northwind labs",
    });
    if (preview.status !== "available") throw new Error("Expected preview");

    await workspaceService.dismissDiscoveryJob({
      jobId: job.id,
      reasons: ["company"],
      action: "hide_and_exclude_employer",
      expectedNormalizedCompanyName: preview.normalizedCompanyName,
    });

    expect(await repository.getSearchPreferences()).toMatchObject({
      companyBlacklist: ["Northwind Labs"],
      excludedLocations: ["Antarctica"],
    });
    expect(
      (await repository.getCampaignState())?.campaigns[0]?.searchPreferences,
    ).toMatchObject({ companyBlacklist: ["Northwind Labs"] });
    expect(
      (await repository.listSavedJobs()).find(
        (candidate) => candidate.id === job.id,
      ),
    ).toMatchObject({
      status: "archived",
      discoveryFeedback: {
        employerExclusion: {
          displayCompanyName: "Northwind Labs",
          normalizedCompanyName: "northwind labs",
          addedByThisFeedback: true,
          campaignId: "campaign_default",
        },
      },
    });

    await workspaceService.removeEmployerExclusion({
      jobId: job.id,
      normalizedCompanyName: "northwind labs",
    });
    expect((await repository.getSearchPreferences()).companyBlacklist).toEqual(
      [],
    );
    expect(
      (await repository.listSavedJobs()).find(
        (candidate) => candidate.id === job.id,
      ),
    ).toMatchObject({
      status: "archived",
      discoveryFeedback: { employerExclusion: null },
    });
  });

  it("rejects a transaction-current active-campaign whitelist conflict without partial writes", async () => {
    const seed = createSeed();
    seed.searchPreferences = {
      ...seed.searchPreferences,
      companyWhitelist: [],
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });
    await workspaceService.getWorkspaceSnapshot();
    const state = await repository.getCampaignState();
    await repository.saveCampaignState({
      ...state!,
      campaigns: state!.campaigns.map((campaign) =>
        campaign.id === state!.activeCampaignId
          ? {
              ...campaign,
              searchPreferences: {
                ...campaign.searchPreferences,
                companyWhitelist: ["Northwind Labs"],
              },
            }
          : campaign,
      ),
    });
    const job = seed.savedJobs.find(
      (candidate) => candidate.id === "job_generating",
    )!;

    await expect(
      workspaceService.dismissDiscoveryJob({
        jobId: job.id,
        reasons: ["company"],
        action: "hide_and_exclude_employer",
        expectedNormalizedCompanyName: "northwind labs",
      }),
    ).rejects.toThrow("company_whitelisted");
    expect((await repository.getSearchPreferences()).companyBlacklist).toEqual(
      [],
    );
    expect(
      (await repository.listSavedJobs()).find((entry) => entry.id === job.id),
    ).toMatchObject({ status: job.status, discoveryFeedback: null });
  });

  it("conflicts instead of overwriting a newer re-dismiss while restore is waiting", async () => {
    const seed = createSeed();
    const original = seed.savedJobs[0]!;
    seed.savedJobs[0] = SavedJobSchema.parse({
      ...original,
      status: "discovered",
    });
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
      await workspaceService.dismissDiscoveryJob({
        jobId: original.id,
        reasons: ["role"],
      });
      const originalCommit =
        repository.commitDiscoveryFeedbackUpdate.bind(repository);
      const entered = deferred();
      const release = deferred();
      let parkRestore = true;
      repository.commitDiscoveryFeedbackUpdate = async <TResult>(
        jobId: string,
        update: Parameters<
          JobFinderRepository["commitDiscoveryFeedbackUpdate"]
        >[1],
      ): Promise<TResult> => {
        if (parkRestore) {
          parkRestore = false;
          entered.resolve();
          await release.promise;
        }
        return originalCommit(jobId, update) as Promise<TResult>;
      };

      const restore = workspaceService.restoreDismissedDiscoveryJob(
        original.id,
      );
      await entered.promise;
      vi.setSystemTime(new Date("2026-08-23T12:00:01.000Z"));
      await workspaceService.dismissDiscoveryJob({
        jobId: original.id,
        reasons: ["company"],
      });
      release.resolve();
      await expect(restore).rejects.toThrow(
        "changed while it was being restored",
      );
      expect(
        (await repository.listSavedJobs()).find(
          (entry) => entry.id === original.id,
        ),
      ).toMatchObject({
        status: "archived",
        discoveryFeedback: { revision: 2, reasons: ["company"] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves every state unchanged when the previewed company identity is stale", async () => {
    const seed = createSeed();
    seed.searchPreferences = {
      ...seed.searchPreferences,
      companyWhitelist: [],
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });
    const job = seed.savedJobs.find(
      (candidate) => candidate.id === "job_generating",
    )!;
    const preview = await workspaceService.previewEmployerExclusion(job.id);
    if (preview.status !== "available") throw new Error("Expected preview");
    await repository.commitSavedJobDelta({
      update: (current) =>
        current.id === job.id
          ? SavedJobSchema.parse({ ...current, company: "Changed Employer" })
          : current,
    });

    await expect(
      workspaceService.dismissDiscoveryJob({
        jobId: job.id,
        reasons: ["company"],
        action: "hide_and_exclude_employer",
        expectedNormalizedCompanyName: preview.normalizedCompanyName,
      }),
    ).rejects.toThrow("identity changed");
    expect((await repository.getSearchPreferences()).companyBlacklist).toEqual(
      [],
    );
    expect(
      (await repository.listSavedJobs()).find(
        (candidate) => candidate.id === job.id,
      ),
    ).toMatchObject({ company: "Changed Employer", status: job.status });
  });

  it("keeps Show again independent from a persisted employer exclusion", async () => {
    const seed = createSeed();
    seed.searchPreferences = {
      ...seed.searchPreferences,
      companyWhitelist: [],
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });
    const job = seed.savedJobs.find(
      (candidate) => candidate.id === "job_generating",
    )!;
    const preview = await workspaceService.previewEmployerExclusion(job.id);
    if (preview.status !== "available") throw new Error("Expected preview");
    await workspaceService.dismissDiscoveryJob({
      jobId: job.id,
      reasons: ["company"],
      action: "hide_and_exclude_employer",
      expectedNormalizedCompanyName: preview.normalizedCompanyName,
    });
    await workspaceService.restoreDismissedDiscoveryJob(job.id);

    expect((await repository.getSearchPreferences()).companyBlacklist).toEqual([
      "Northwind Labs",
    ]);
  });

  it("persists local reasons, preserves scoring facts, and supports resettable undo", async () => {
    const seed = createSeed();
    const original = seed.savedJobs[0]!;
    seed.savedJobs[0] = SavedJobSchema.parse({
      ...original,
      status: "discovered",
    });
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    const hidden = await workspaceService.dismissDiscoveryJob({
      jobId: original.id,
      reasons: ["location", "duplicate"],
    });
    const persisted = (await repository.listSavedJobs()).find(
      (job) => job.id === original.id,
    );

    expect(hidden.discoveryJobs.some((job) => job.id === original.id)).toBe(
      false,
    );
    expect(hidden.dismissedDiscoveryJobs[0]).toMatchObject({
      id: original.id,
      status: "archived",
      discoveryFeedback: {
        version: 1,
        revision: 1,
        reasons: ["location", "duplicate"],
      },
    });
    expect(persisted?.matchAssessment).toEqual(original.matchAssessment);

    const restored = await workspaceService.restoreDismissedDiscoveryJob(
      original.id,
    );
    expect(restored.dismissedDiscoveryJobs).toHaveLength(0);
    expect(
      restored.discoveryJobs.find((job) => job.id === original.id),
    ).toMatchObject({
      status: "discovered",
      discoveryFeedback: null,
    });
  });

  it("returns a dismissed shortlisted job to the shortlist after a restart", async () => {
    const seed = createSeed();
    const original = seed.savedJobs[0]!;
    seed.savedJobs[0] = SavedJobSchema.parse({
      ...original,
      status: "shortlisted",
    });
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    const hidden = await workspaceService.dismissDiscoveryJob({
      jobId: original.id,
      reasons: ["role"],
    });
    expect(hidden.dismissedDiscoveryJobs[0]).toMatchObject({
      status: "archived",
      discoveryFeedback: {
        version: 1,
        revision: 1,
        reasons: ["role"],
        priorStatus: "shortlisted",
      },
    });
    expect(
      (await repository.listSavedJobs()).find((job) => job.id === original.id),
    ).toMatchObject({
      status: "archived",
      discoveryFeedback: { priorStatus: "shortlisted" },
    });

    // A fresh service over the same repository simulates an app restart.
    const restarted = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
      exportFileVerifier: { exists: () => Promise.resolve(true) },
      researchAdapter: createResearchAdapter(),
    });
    const restored = await restarted.restoreDismissedDiscoveryJob(original.id);

    expect(restored.dismissedDiscoveryJobs).toHaveLength(0);
    expect(
      restored.discoveryJobs.find((job) => job.id === original.id),
    ).toMatchObject({
      status: "shortlisted",
      discoveryFeedback: null,
    });
    expect(
      (await repository.listSavedJobs()).find((job) => job.id === original.id),
    ).toMatchObject({ status: "shortlisted", discoveryFeedback: null });
  });

  it("keeps the original prior status when a hidden job is hidden again", async () => {
    const seed = createSeed();
    const original = seed.savedJobs[0]!;
    seed.savedJobs[0] = SavedJobSchema.parse({
      ...original,
      status: "shortlisted",
    });
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed,
    });

    await workspaceService.dismissDiscoveryJob({
      jobId: original.id,
      reasons: ["role"],
    });
    await workspaceService.dismissDiscoveryJob({
      jobId: original.id,
      reasons: ["company"],
    });
    expect(
      (await repository.listSavedJobs()).find((job) => job.id === original.id),
    ).toMatchObject({
      status: "archived",
      discoveryFeedback: {
        revision: 2,
        reasons: ["company"],
        priorStatus: "shortlisted",
      },
    });

    const restored = await workspaceService.restoreDismissedDiscoveryJob(
      original.id,
    );
    expect(
      restored.discoveryJobs.find((job) => job.id === original.id),
    ).toMatchObject({
      status: "shortlisted",
      discoveryFeedback: null,
    });
  });

  it("restores feedback persisted before prior status tracking as discovered", async () => {
    const seed = createSeed();
    const original = seed.savedJobs[0]!;
    seed.savedJobs[0] = SavedJobSchema.parse({
      ...original,
      status: "archived",
      discoveryFeedback: {
        version: 1,
        revision: 1,
        reasons: ["role"],
        recordedAt: "2026-07-31T12:00:00.000Z",
      },
    });
    const { workspaceService } = createWorkspaceServiceHarness({ seed });

    const restored = await workspaceService.restoreDismissedDiscoveryJob(
      original.id,
    );
    expect(
      restored.discoveryJobs.find((job) => job.id === original.id),
    ).toMatchObject({
      status: "discovered",
      discoveryFeedback: null,
    });
  });

  it("keeps explicit feedback across duplicate rediscovery without contaminating the new assessment", () => {
    const original = createSeed().savedJobs[0]!;
    const hidden = SavedJobSchema.parse({
      ...original,
      status: "archived",
      discoveryFeedback: {
        version: 1,
        revision: 2,
        reasons: ["company"],
        recordedAt: "2026-07-31T12:00:00.000Z",
      },
    });
    const rediscovered = SavedJobSchema.parse({
      ...original,
      status: "discovered",
      matchAssessment: { ...original.matchAssessment, score: 41 },
    });

    expect(mergeSavedJobs([hidden], [rediscovered])[0]).toMatchObject({
      status: "archived",
      discoveryFeedback: hidden.discoveryFeedback,
      matchAssessment: { score: 41 },
    });
  });
});
