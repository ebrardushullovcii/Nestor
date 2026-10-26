import {
  ApplicationRecordSchema,
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
    targetIds: ["1"],
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
    targetId: "1",
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
