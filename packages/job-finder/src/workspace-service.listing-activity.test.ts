import {
  CompanyEntitySchema,
  DiscoveryLedgerEntrySchema,
  JobFinderDiscoveryStateSchema,
  JobFinderIntelligenceStateSchema,
  ListingSignalRecordSchema,
} from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { describe, expect, test } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createSeed,
} from "./workspace-service.test-support";

describe("workspace listing activity snapshots", () => {
  test("projects every company-linked saved job across workflow states after restart", async () => {
    const seed = createSeed();
    const baseJob = seed.savedJobs[0]!;
    const jobs = [
      {
        ...baseJob,
        id: "company-rejected-active",
        sourceJobId: "company-rejected-active",
        canonicalUrl: "https://jobs.example.test/company-rejected-active",
        title: "Rejected but active",
        status: "rejected" as const,
        lastSeenAt: "2026-08-23T09:00:00.000Z",
      },
      {
        ...baseJob,
        id: "company-submitted-closed",
        sourceJobId: "company-submitted-closed",
        canonicalUrl: "https://jobs.example.test/company-submitted-closed",
        title: "Submitted and closed",
        status: "submitted" as const,
        lastSeenAt: null,
      },
      {
        ...baseJob,
        id: "company-dismissed",
        sourceJobId: "company-dismissed",
        canonicalUrl: "https://jobs.example.test/company-dismissed",
        title: "Dismissed opening",
        status: "archived" as const,
        lastSeenAt: null,
        discoveryFeedback: {
          version: 1 as const,
          revision: 1,
          reasons: ["other" as const],
          recordedAt: "2026-08-23T09:00:00.000Z",
          priorStatus: "discovered" as const,
        },
      },
      {
        ...baseJob,
        id: "company-archived",
        sourceJobId: "company-archived",
        canonicalUrl: "https://jobs.example.test/company-archived",
        title: "Archived opening",
        status: "archived" as const,
        lastSeenAt: "2026-08-23T08:00:00.000Z",
        discoveryFeedback: null,
      },
    ];
    seed.savedJobs = jobs;
    seed.intelligence = JobFinderIntelligenceStateSchema.parse({
      ...seed.intelligence,
      companies: [
        CompanyEntitySchema.parse({
          id: "company-complete",
          canonicalName: baseJob.company,
          jobIds: [
            jobs[3]!.id,
            jobs[0]!.id,
            jobs[1]!.id,
            jobs[2]!.id,
            jobs[0]!.id,
            "missing-job",
          ],
          createdAt: "2026-08-23T08:00:00.000Z",
          updatedAt: "2026-08-23T09:00:00.000Z",
        }),
      ],
      safeguards: {
        ...seed.intelligence.safeguards,
        listingSignals: [
          ListingSignalRecordSchema.parse({
            id: "company-submitted-closed-signal",
            jobId: jobs[1]!.id,
            signal: "closed",
            detail: null,
            detectedAt: "2026-08-23T10:00:00.000Z",
            confidence: 1,
            provenance: "provider",
            explanation: "The provider explicitly marked the listing closed.",
            recoveryGuidance: "Keep the application history for reference.",
          }),
        ],
      },
    });
    const repository = createInMemoryJobFinderRepository(seed);
    const createService = () =>
      createJobFinderWorkspaceService({
        repository,
        browserRuntime: createBrowserRuntime(),
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });

    const beforeRestart = await createService().getWorkspaceSnapshot();
    const afterRestart = await createService().getWorkspaceSnapshot();

    expect(beforeRestart.discoveryJobs).toEqual([]);
    expect(beforeRestart.dismissedDiscoveryJobs.map((job) => job.id)).toEqual([
      "company-dismissed",
    ]);
    expect(beforeRestart.companyJobs.map((job) => job.id)).toEqual([
      "company-archived",
      "company-dismissed",
      "company-rejected-active",
      "company-submitted-closed",
    ]);
    expect(new Set(beforeRestart.companyJobs.map((job) => job.id)).size).toBe(
      4,
    );
    expect(
      beforeRestart.companyJobs.find(
        (job) => job.id === "company-submitted-closed",
      )?.listingActivity.status,
    ).toBe("closed");
    expect(afterRestart.companyJobs).toEqual(beforeRestart.companyJobs);
  });

  test("rebuilds the same derived activity after a service restart", async () => {
    const seed = createSeed();
    const savedJob = seed.savedJobs[0]!;
    seed.discovery = JobFinderDiscoveryStateSchema.parse({
      ...seed.discovery,
      discoveryLedger: [
        DiscoveryLedgerEntrySchema.parse({
          id: "ledger-ready",
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
          firstSeenAt: "2026-08-23T08:00:00.000Z",
          lastSeenAt: "2026-08-23T09:00:00.000Z",
          inactiveAt: "2026-08-23T10:00:00.000Z",
          latestStatus: "inactive",
        }),
      ],
    });
    seed.intelligence = JobFinderIntelligenceStateSchema.parse({
      ...seed.intelligence,
      safeguards: {
        ...seed.intelligence.safeguards,
        listingSignals: [
          ListingSignalRecordSchema.parse({
            id: "signal-ready-closed",
            jobId: savedJob.id,
            signal: "closed",
            detail: "The provider returned an explicit closed state.",
            detectedAt: "2026-08-23T11:00:00.000Z",
            confidence: 1,
            provenance: "provider",
            explanation: "The listing is explicitly closed.",
            recoveryGuidance: "Review before reopening the listing.",
          }),
        ],
      },
    });
    const repository = createInMemoryJobFinderRepository(seed);
    const createService = () =>
      createJobFinderWorkspaceService({
        repository,
        browserRuntime: createBrowserRuntime(),
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });

    const beforeRestart = await createService().getWorkspaceSnapshot();
    const afterRestart = await createService().getWorkspaceSnapshot();
    const beforeActivity = beforeRestart.discoveryJobs.find(
      (job) => job.id === savedJob.id,
    )?.listingActivity;
    const afterActivity = afterRestart.discoveryJobs.find(
      (job) => job.id === savedJob.id,
    )?.listingActivity;

    expect(beforeActivity).toMatchObject({
      status: "closed",
      signalId: "signal-ready-closed",
      provenance: "provider",
      explanation: "The listing is explicitly closed.",
    });
    expect(afterActivity).toEqual(beforeActivity);
    expect("listingActivity" in (await repository.listSavedJobs())[0]!).toBe(
      false,
    );
  });

  test("rejects an explicitly closed listing before shortlist mutation", async () => {
    const seed = createSeed();
    const savedJob = seed.savedJobs[0]!;
    seed.intelligence = JobFinderIntelligenceStateSchema.parse({
      ...seed.intelligence,
      safeguards: {
        ...seed.intelligence.safeguards,
        listingSignals: [
          ListingSignalRecordSchema.parse({
            id: "signal-closed-gate",
            jobId: savedJob.id,
            signal: "closed",
            detail: "The provider returned an explicit closed state.",
            detectedAt: "2026-08-23T11:00:00.000Z",
            confidence: 1,
            provenance: "provider",
            explanation: "The listing is explicitly closed.",
            recoveryGuidance: "Choose another listing.",
          }),
        ],
      },
    });
    const repository = createInMemoryJobFinderRepository(seed);
    const service = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
    });
    const before = await repository.listSavedJobs();

    await expect(service.queueJobForReview(savedJob.id)).rejects.toThrow(
      /closed job/i,
    );
    expect(await repository.listSavedJobs()).toEqual(before);
    expect((await repository.getDiscoveryState()).pendingDiscoveryJobs).toEqual(
      seed.discovery.pendingDiscoveryJobs,
    );
  });

  test("promotes a discovery-only staged job into the durable review queue", async () => {
    const seed = createSeed();
    const pendingJob = {
      ...seed.savedJobs[0]!,
      id: "pending-shortlist-job",
      sourceJobId: "pending-shortlist-job",
      canonicalUrl: "https://jobs.example.test/pending-shortlist-job",
      applicationUrl: "https://jobs.example.test/pending-shortlist-job/apply",
      status: "discovered" as const,
    };
    seed.discovery = JobFinderDiscoveryStateSchema.parse({
      ...seed.discovery,
      pendingDiscoveryJobs: [pendingJob],
    });
    const repository = createInMemoryJobFinderRepository(seed);
    await repository.saveSearchPreferences({
      ...(await repository.getSearchPreferences()),
      tailoringMode: "conservative",
    });
    const service = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
    });

    await service.getWorkspaceSnapshot();
    const campaignState = await repository.getCampaignState();
    expect(campaignState).not.toBeNull();
    await repository.saveCampaignState({
      ...campaignState!,
      campaigns: campaignState!.campaigns.map((campaign) =>
        campaign.id === campaignState!.activeCampaignId
          ? { ...campaign, jobIds: [...campaign.jobIds, pendingJob.id] }
          : campaign,
      ),
    });

    const snapshot = await service.queueJobForReview(pendingJob.id);

    expect((await repository.getDiscoveryState()).pendingDiscoveryJobs).toEqual(
      [],
    );
    expect(
      (await repository.listSavedJobs()).find((job) => job.id === pendingJob.id)
        ?.status,
    ).toBe("drafting");
    expect(
      (await repository.listSavedJobs()).find((job) => job.id === pendingJob.id)
        ?.resumeTailoringMode,
    ).toBe("conservative");
    expect(
      snapshot.reviewQueue.find((item) => item.jobId === pendingJob.id)
        ?.resumeTailoringMode,
    ).toBe("conservative");
    expect(snapshot.reviewQueue.map((item) => item.jobId)).toContain(
      pendingJob.id,
    );
  });

  test.each(["unknown", "stale", "inactive"] as const)(
    "allows a listing with %s activity through the shortlist service gate",
    async (activity) => {
      const seed = createSeed();
      const savedJob = seed.savedJobs[1]!;
      if (activity === "stale") {
        seed.intelligence = JobFinderIntelligenceStateSchema.parse({
          ...seed.intelligence,
          safeguards: {
            ...seed.intelligence.safeguards,
            listingSignals: [
              ListingSignalRecordSchema.parse({
                id: "signal-stale-gate",
                jobId: savedJob.id,
                signal: "stale",
                detail: "The listing date is old.",
                detectedAt: "2026-08-23T11:00:00.000Z",
                confidence: 0.8,
                provenance: "browser",
                explanation: "The listing may be stale.",
                recoveryGuidance: "Verify before applying.",
              }),
            ],
          },
        });
      }
      if (activity === "inactive") {
        seed.discovery = JobFinderDiscoveryStateSchema.parse({
          ...seed.discovery,
          discoveryLedger: [
            DiscoveryLedgerEntrySchema.parse({
              id: "ledger-inactive-gate",
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
              firstSeenAt: "2026-08-23T08:00:00.000Z",
              lastSeenAt: "2026-08-23T09:00:00.000Z",
              inactiveAt: "2026-08-23T11:00:00.000Z",
              latestStatus: "inactive",
            }),
          ],
        });
      }
      const repository = createInMemoryJobFinderRepository(seed);
      const service = createJobFinderWorkspaceService({
        repository,
        browserRuntime: createBrowserRuntime(),
        aiClient: createAiClient(),
        documentManager: createDocumentManager(),
      });

      await expect(
        service.queueJobForReview(savedJob.id),
      ).resolves.toBeDefined();
    },
  );
});
