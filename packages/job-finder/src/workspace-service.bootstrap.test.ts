import {
  ApplicationRecordSchema,
  CampaignNotificationSchema,
  CompanyEntitySchema,
  DiscoveryRunRecordSchema,
  JobFinderDiscoveryStateSchema,
  JobFinderIntelligenceStateSchema,
  SourceDebugRunRecordSchema,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const savedAt = "2026-08-19T10:00:00.000Z";
const sessionCheckedAt = "2026-03-20T10:04:00.000Z";

function createHydrationFixture() {
  const seed = createSeed();
  const discoveryRun = DiscoveryRunRecordSchema.parse({
    id: "discovery_history_1",
    campaignId: "campaign_default",
    state: "completed",
    startedAt: "2026-08-19T09:00:00.000Z",
    completedAt: "2026-08-19T09:02:00.000Z",
    targetIds: ["target_linkedin_default"],
    summary: {
      targetsPlanned: 1,
      targetsCompleted: 1,
      validJobsFound: 2,
      jobsPersisted: 2,
      outcome: "completed",
    },
  });
  const sourceDebugRun = SourceDebugRunRecordSchema.parse({
    id: "source_debug_history_1",
    targetId: "target_linkedin_default",
    state: "completed",
    startedAt: "2026-08-19T09:05:00.000Z",
    updatedAt: "2026-08-19T09:10:00.000Z",
    completedAt: "2026-08-19T09:10:00.000Z",
    targetLabel: "Primary target",
    targetUrl: "https://www.linkedin.com/jobs/search/",
    targetHostname: "www.linkedin.com",
    finalSummary: "The source was verified for the saved search.",
    phases: [],
    attemptIds: [],
    phaseSummaries: [],
    instructionArtifactId: null,
  });
  const applicationRecord = ApplicationRecordSchema.parse({
    id: "application_ready",
    jobId: "job_ready",
    title: "Senior Product Designer",
    company: "Signal Systems",
    status: "ready_for_review",
    lastActionLabel: "Resume prepared",
    nextActionLabel: "Review the prepared application",
    lastUpdatedAt: savedAt,
  });
  const company = CompanyEntitySchema.parse({
    id: "company_signal",
    canonicalName: "Signal Systems",
    jobIds: ["job_ready"],
    applicationRecordIds: [applicationRecord.id],
    createdAt: savedAt,
    updatedAt: savedAt,
  });

  seed.settings = {
    ...seed.settings,
    appearanceTheme: "dark",
    discoveryOnly: true,
    keepSessionAlive: true,
    resumeTemplateId: "modern_split",
  };
  seed.discovery = JobFinderDiscoveryStateSchema.parse({
    ...seed.discovery,
    sessions: [
      {
        adapterKind: "target_site",
        status: "ready",
        driver: "catalog_seed",
        label: "Browser session ready",
        detail: "Validated recently.",
        lastCheckedAt: sessionCheckedAt,
      },
    ],
    runState: "completed",
    recentRuns: [discoveryRun],
    recentSourceDebugRuns: [sourceDebugRun],
  });
  seed.sourceDebugRuns = [sourceDebugRun];
  seed.applicationRecords = [applicationRecord];
  seed.intelligence = JobFinderIntelligenceStateSchema.parse({
    ...seed.intelligence,
    companies: [company],
  });
  seed.activityControl = {
    paused: true,
    pausedAt: savedAt,
    reason: "Paused while reviewing the saved campaign state.",
  };

  return { seed, discoveryRun, sourceDebugRun, applicationRecord, company };
}

describe("workspace service bootstrap hydration", () => {
  test("bootstrap never reads the deferred discovery display projection", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createHydrationFixture().seed,
    });
    const fullDiscoveryRead = vi.spyOn(
      repository,
      "readDiscoveryDisplayProjection",
    );
    const bootstrapRead = vi.spyOn(
      repository,
      "readDiscoveryBootstrapProjection",
    );
    try {
      const bootstrap = await workspaceService.getWorkspaceBootstrap();
      expect(bootstrap.hydration.phase).toBe("bootstrap");
      expect(bootstrapRead).toHaveBeenCalledOnce();
      expect(fullDiscoveryRead).not.toHaveBeenCalled();
    } finally {
      fullDiscoveryRead.mockRestore();
      bootstrapRead.mockRestore();
    }
  });
  test("keeps the shell state in bootstrap and restores deferred collections in the full snapshot", async () => {
    const fixture = createHydrationFixture();
    const harness = createWorkspaceServiceHarness({ seed: fixture.seed });
    const { repository, workspaceService } = harness;

    // Existing workspaces create their default campaign lazily. Customize the
    // persisted campaign after that compatibility migration so the bootstrap
    // must return the real campaign rather than a placeholder.
    await workspaceService.getWorkspaceSnapshot();
    const existingCampaignState = await repository.getCampaignState();
    expect(existingCampaignState).not.toBeNull();
    if (!existingCampaignState) return;

    const notification = CampaignNotificationSchema.parse({
      id: "notification_strong_match",
      campaignId: existingCampaignState.activeCampaignId,
      kind: "strong_match",
      title: "Strong match ready",
      body: "Signal Systems is ready for review.",
      createdAt: savedAt,
      jobId: "job_ready",
      sourceTargetId: "target_linkedin_default",
    });
    const activeCampaign = existingCampaignState.campaigns.find(
      (campaign) => campaign.id === existingCampaignState.activeCampaignId,
    );
    expect(activeCampaign).toBeDefined();
    if (!activeCampaign) return;

    await repository.saveCampaignState({
      activeCampaignId: activeCampaign.id,
      campaigns: [
        {
          ...activeCampaign,
          name: "Platform systems search",
          description: "Saved campaign state used by the hydration test.",
          sourceTargetIds: ["target_linkedin_default"],
          jobIds: fixture.seed.savedJobs.map((job) => job.id),
        },
      ],
      notifications: [notification],
    });

    const bootstrap = await workspaceService.getWorkspaceBootstrap();

    expect(bootstrap.hydration).toEqual({
      phase: "bootstrap",
      deferredCollections: [
        "discovery_jobs",
        "review_queue",
        "applications",
        "source_history",
        "documents",
        "intelligence",
      ],
    });
    expect(bootstrap.discoveryJobs).toEqual([]);
    expect(bootstrap.dismissedDiscoveryJobs).toEqual([]);
    expect(bootstrap.companyJobs).toEqual([]);
    expect(bootstrap.reviewQueue).toEqual([]);
    expect(bootstrap.applicationRecords).toEqual([]);
    expect(bootstrap.recentDiscoveryRuns).toEqual([]);
    expect(bootstrap.recentSourceDebugRuns).toEqual([]);
    expect(bootstrap.sourceInstructionArtifacts).toEqual([]);
    expect(bootstrap.tailoredAssets).toEqual([]);
    expect(bootstrap.resumeDrafts).toEqual([]);
    expect(bootstrap.resumeExportArtifacts).toEqual([]);
    expect(bootstrap.resumeResearchArtifacts).toEqual([]);
    expect(bootstrap.applyRuns).toEqual([]);
    expect(bootstrap.applyJobResults).toEqual([]);
    expect(bootstrap.applicationAttempts).toEqual([]);
    expect(bootstrap.profileCopilotMessages).toEqual([]);
    expect(bootstrap.profileRevisions).toEqual([]);
    expect(bootstrap.intelligence).toEqual(
      JobFinderIntelligenceStateSchema.parse({}),
    );
    expect(
      bootstrap.dashboard.globalDailyApplicationPreparationCapacity,
    ).toBeNull();

    expect(bootstrap.profile).toEqual(fixture.seed.profile);
    expect(bootstrap.profileSetupState).toEqual(fixture.seed.profileSetupState);
    expect(bootstrap.searchPreferences.discovery.targets).toEqual(
      fixture.seed.searchPreferences.discovery.targets,
    );
    expect(bootstrap.settings).toMatchObject({
      appearanceTheme: "dark",
      discoveryOnly: true,
      keepSessionAlive: true,
      resumeTemplateId: "modern_split",
    });
    expect(bootstrap.browserSession).toMatchObject({
      source: "target_site",
      status: "ready",
      driver: "catalog_seed",
    });
    expect(bootstrap.discoverySessions).toHaveLength(1);
    expect(bootstrap.discoverySessions[0]).toMatchObject({
      adapterKind: "target_site",
      status: "ready",
    });
    expect(bootstrap.discoveryRunState).toBe("completed");
    expect(bootstrap.activityControl).toEqual(fixture.seed.activityControl);
    expect(bootstrap.campaigns[0]).toMatchObject({
      id: activeCampaign.id,
      name: "Platform systems search",
      description: "Saved campaign state used by the hydration test.",
      sourceTargetIds: ["target_linkedin_default"],
      jobIds: fixture.seed.savedJobs.map((job) => job.id),
    });
    expect(bootstrap.activeCampaignId).toBe(activeCampaign.id);
    expect(bootstrap.campaignNotifications).toEqual([notification]);

    const full = await workspaceService.getWorkspaceSnapshot();

    expect(full.hydration).toEqual({
      phase: "complete",
      deferredCollections: [],
    });
    expect(full.discoveryJobs.map((job) => job.id)).toEqual(
      expect.arrayContaining(fixture.seed.savedJobs.map((job) => job.id)),
    );
    expect(full.reviewQueue.map((item) => item.jobId)).toContain("job_ready");
    expect(full.applicationRecords.map((record) => record.id)).toEqual([
      fixture.applicationRecord.id,
    ]);
    expect(full.recentDiscoveryRuns).toEqual([fixture.discoveryRun]);
    expect(full.recentSourceDebugRuns).toEqual([fixture.sourceDebugRun]);
    expect(full.tailoredAssets.map((asset) => asset.id)).toEqual(
      fixture.seed.tailoredAssets.map((asset) => asset.id),
    );
    expect(full.intelligence.companies).toEqual([fixture.company]);
    expect(full.companyJobs.map((job) => job.id)).toEqual(["job_ready"]);
    expect(
      full.dashboard.globalDailyApplicationPreparationCapacity,
    ).toMatchObject({ limit: 20, remaining: 20, used: 0 });

    // Full hydration keeps the shell facts returned by bootstrap and the
    // persisted campaign notification; only derived progress may be updated.
    expect(full.profile).toEqual(bootstrap.profile);
    expect(full.searchPreferences.discovery.targets).toEqual(
      bootstrap.searchPreferences.discovery.targets,
    );
    expect(full.settings).toMatchObject(bootstrap.settings);
    expect(full.activityControl).toEqual(bootstrap.activityControl);
    expect(full.activeCampaignId).toBe(bootstrap.activeCampaignId);
    expect(full.campaignNotifications).toEqual(bootstrap.campaignNotifications);
    expect(full.campaigns[0]).toMatchObject({
      id: activeCampaign.id,
      name: "Platform systems search",
      sourceTargetIds: ["target_linkedin_default"],
      jobIds: fixture.seed.savedJobs.map((job) => job.id),
    });
  });
});

describe("browser session on a workspace that has never run discovery", () => {
  test("reports the runtime's own lane instead of the offline catalog", async () => {
    // A fresh workspace has no persisted adapter session. Falling back to the
    // catalog lane here told an agent-backed build that it could not search
    // before anything had been tried.
    const runtime = createBrowserRuntime();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      browserRuntime: {
        ...runtime,
        getSessionState: (source) =>
          Promise.resolve({
            source,
            status: "unknown" as const,
            driver: "embedded_browser_agent" as const,
            label: "Browser profile not started",
            detail: "The run opens the browser when a search starts.",
            lastCheckedAt: "2026-03-20T10:04:00.000Z",
          }),
      },
    });

    const bootstrap = await workspaceService.getWorkspaceBootstrap();
    const full = await workspaceService.getWorkspaceSnapshot();

    expect(bootstrap.discoverySessions).toEqual([]);
    expect(bootstrap.browserSession).toMatchObject({
      source: "target_site",
      status: "unknown",
      driver: "embedded_browser_agent",
    });
    expect(full.browserSession.driver).toBe("embedded_browser_agent");
  });
});
