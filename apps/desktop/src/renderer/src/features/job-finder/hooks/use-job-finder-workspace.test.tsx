// @vitest-environment jsdom

import {
  createFreshStartCandidateProfile,
  DiscoveryJobViewSchema,
  DiscoveryRunRecordSchema,
  JobListRowSchema,
  getDefaultCampaignConfiguration,
  JobFinderSettingsSchema,
  JobFinderWorkspaceDeltaSchema,
  JobFinderWorkspaceSyncResultSchema,
  JobFinderRendererWorkspaceSnapshotSchema,
  JobSearchCampaignSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import type {
  CandidateProfile,
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderWorkspaceDelta,
  JobFinderWorkspaceEntityMutationInput,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceSyncResult,
  ResumeImportProgressEvent,
} from "@nestor/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useJobFinderWorkspace } from "./use-job-finder-workspace";
import { createJobFinderWorkspaceDeltaTracker } from "../../../../../main/services/job-finder/workspace-delta";
import { applyJobFinderWorkspaceDelta } from "../../../pages/job-finder-workspace-delta";

function requireReadyWorkspace(
  value: ReturnType<typeof useJobFinderWorkspace>,
): Extract<ReturnType<typeof useJobFinderWorkspace>, { status: "ready" }> {
  if (value.status !== "ready") {
    throw new Error("Expected a ready Job Finder workspace.");
  }
  return value;
}

function createBaseSnapshot(
  generatedAt: string,
): JobFinderRendererWorkspaceSnapshot {
  const profile = createFreshStartCandidateProfile();
  const searchPreferences = JobSearchPreferencesSchema.parse({
    targetRoles: [],
    jobFamilies: [],
    locations: [],
    excludedLocations: [],
    workModes: [],
    seniorityLevels: [],
    minimumSalaryUsd: null,
    targetSalaryUsd: null,
    salaryCurrency: "USD",
    targetIndustries: [],
    targetCompanyStages: [],
    employmentTypes: [],
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    companyBlacklist: [],
    companyWhitelist: [],
    discovery: {
      historyLimit: 5,
      targets: [],
    },
  });
  const settings = JobFinderSettingsSchema.parse({
    resumeTemplateId: "classic_ats",
    resumeFormat: "pdf",
    fontPreset: "inter_requisite",
    appearanceTheme: "system",
    humanReviewRequired: true,
    keepSessionAlive: false,
    allowAutoSubmitOverride: false,
    discoveryOnly: false,
  });
  const campaign = JobSearchCampaignSchema.parse({
    id: "campaign_1",
    name: "Test campaign",
    description: "",
    mode: "precision",
    status: "active",
    createdAt: generatedAt,
    updatedAt: generatedAt,
    searchPreferences,
    sourceTargetIds: [],
    jobIds: [],
    minimumFitScore: null,
    ...getDefaultCampaignConfiguration("precision"),
    schedule: {},
    progress: { lastUpdatedAt: generatedAt },
    history: [],
  });
  return JobFinderRendererWorkspaceSnapshotSchema.parse({
    module: "job-finder",
    generatedAt,
    hydration: { phase: "complete", deferredCollections: [] },
    agentProvider: {
      kind: "deterministic",
      role: "chat",
      ready: true,
      label: "Test AI",
      model: null,
      baseUrl: null,
      modelContextWindowTokens: null,
      reservedHeadroomTokens: null,
      requestTimeoutMs: null,
      detail: "Test AI",
    },
    visionProvider: null,
    availableResumeTemplates: [],
    profile,
    searchPreferences,
    profileSetupState: {
      status: "completed",
      currentStep: "import",
      completedAt: generatedAt,
      reviewItems: [],
      lastResumedAt: null,
    },
    browserSession: {
      source: "target_site",
      status: "ready",
      driver: "catalog_seed",
      label: "Ready",
      detail: "Ready",
      lastCheckedAt: generatedAt,
    },
    sourceAccessPrompts: [],
    discoverySessions: [],
    discoveryRunState: "idle",
    activeDiscoveryRun: null,
    recentDiscoveryRuns: [],
    activeSourceDebugRun: null,
    recentSourceDebugRuns: [],
    discoveryJobs: [],
    dismissedDiscoveryJobs: [],
    companyJobs: [],
    selectedDiscoveryJobId: null,
    reviewQueue: [],
    selectedReviewJobId: null,
    tailoredAssets: [],
    resumeDrafts: [],
    resumeExportArtifacts: [],
    resumeResearchArtifacts: [],
    applyRuns: [],
    applyJobResults: [],
    applicationRecords: [],
    applicationAttempts: [],
    userActionRequests: [],
    userActionEvents: [],
    sourceInstructionArtifacts: [],
    latestResumeImportRun: null,
    latestResumeImportReviewCandidates: [],
    profileCopilotMessages: [],
    profileRevisions: [],
    selectedApplyRunId: null,
    selectedApplicationRecordId: null,
    settings,
    campaigns: [campaign],
    activeCampaignId: campaign.id,
    campaignNotifications: [],
    dashboard: {
      generatedAt,
      activeCampaignId: campaign.id,
      activeCampaignCount: 1,
      jobsFoundToday: 0,
      jobsAwaitingReview: 0,
      applicationsReadyForApproval: 0,
      applicationsAppliedToday: 0,
      applicationsAppliedThisWeek: 0,
      needsYouCount: 0,
      upcomingInterviews: 0,
      upcomingFollowUps: 0,
      responseRate: null,
      interviewRate: null,
      sourceHealth: {
        healthy: 0,
        needsAttention: 0,
        running: 0,
        total: 0,
      },
      backgroundOperationCount: 0,
      recommendedNextAction: {
        label: "Review profile",
        detail: "Complete the profile before searching.",
        route: "/job-finder/profile",
      },
    },
    activityControl: { paused: false, pausedAt: null, reason: null },
    intelligence: {},
  });
}

function createDiscoveryJob(jobId: string, generatedAt: string) {
  return DiscoveryJobViewSchema.parse({
    id: jobId,
    source: "target_site",
    sourceJobId: `source_${jobId}`,
    canonicalUrl: `https://jobs.example.com/roles/${jobId}`,
    applicationUrl: `https://jobs.example.com/roles/${jobId}/apply`,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: generatedAt,
    salaryText: null,
    description: `Description for ${jobId}`,
    status: "discovered",
    matchAssessment: { score: 80, reasons: [], gaps: [] },
    listingActivity: { status: "unknown" },
  });
}

function createWorkspace(
  jobId: string,
  generatedAt = "2026-08-09T10:00:00.000Z",
): JobFinderRendererWorkspaceSnapshot {
  const base = createBaseSnapshot(generatedAt);
  return {
    ...base,
    discoveryJobs: [createDiscoveryJob(jobId, generatedAt)],
    selectedDiscoveryJobId: jobId,
  };
}

function createJobReplacementDelta(input: {
  baseRevision: number;
  currentRevision: number;
  previousJobId: string;
  currentJobId: string;
}): JobFinderWorkspaceDelta {
  const generatedAt = "2026-08-09T10:01:00.000Z";
  const base = createBaseSnapshot(generatedAt);
  return JobFinderWorkspaceDeltaSchema.parse({
    baseRevision: input.baseRevision,
    currentRevision: input.currentRevision,
    generatedAt,
    discoveryRunState: "idle",
    activeDiscoveryRun: null,
    discoverySessions: [],
    sourceAccessPrompts: [],
    latestResumeImportRun: null,
    campaigns: base.campaigns,
    activeCampaignId: base.activeCampaignId,
    campaignNotifications: [],
    dashboard: base.dashboard,
    activityControl: base.activityControl,
    intelligence: base.intelligence,
    selectedDiscoveryJobId: input.currentJobId,
    selectedReviewJobId: null,
    selectedApplyRunId: null,
    selectedApplicationRecordId: null,
    discoveryJobs: {
      upserts: [createDiscoveryJob(input.currentJobId, generatedAt)],
      removedIds: [input.previousJobId],
    },
    dismissedDiscoveryJobs: { upserts: [], removedIds: [] },
    companyJobs: { upserts: [], removedIds: [] },
    recentDiscoveryRuns: { upserts: [], removedIds: [] },
    reviewQueue: { upserts: [], removedIds: [] },
    applyRuns: { upserts: [], removedIds: [] },
    applyJobResults: { upserts: [], removedIds: [] },
    applicationRecords: { upserts: [], removedIds: [] },
    applicationAttempts: { upserts: [], removedIds: [] },
    userActionRequests: { upserts: [], removedIds: [] },
    userActionEvents: { upserts: [], removedIds: [] },
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

describe("useJobFinderWorkspace revision window", () => {
  const syncWorkspace =
    vi.fn<
      (baseRevision: number | null) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const mutateWorkspaceEntities =
    vi.fn<
      (
        input: JobFinderWorkspaceEntityMutationInput,
      ) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const getWorkspace =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const bareSnapshotAction =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  let notifyUpdate: () => void;

  beforeEach(() => {
    syncWorkspace.mockReset();
    mutateWorkspaceEntities.mockReset();
    getWorkspace.mockReset();
    bareSnapshotAction.mockReset();
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        ping: vi.fn(() => Promise.resolve({ platform: "win32" as const })),
        jobFinder: {
          syncWorkspace,
          mutateWorkspaceEntities,
          getWorkspace,
          checkBrowserSession: bareSnapshotAction,
          resetWorkspace: bareSnapshotAction,
          onWorkspaceUpdate: (listener: () => void) => {
            notifyUpdate = listener;
            return () => undefined;
          },
        },
      } as unknown as Window["nestor"],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nestor");
  });

  function snapshotResult(
    snapshot: JobFinderRendererWorkspaceSnapshot,
    currentRevision: number,
  ): JobFinderWorkspaceSyncResult {
    return { kind: "snapshot", currentRevision, reason: "initial", snapshot };
  }

  function parsedDelta(result: JobFinderWorkspaceSyncResult) {
    const parsed = JobFinderWorkspaceSyncResultSchema.parse(result);
    if (parsed.kind !== "delta") throw new Error("Expected a tracker delta");
    return parsed;
  }

  async function publishUpdate(
    result: ReturnType<
      typeof renderHook<ReturnType<typeof useJobFinderWorkspace>, unknown>
    >["result"],
    expected: JobFinderRendererWorkspaceSnapshot,
  ) {
    act(() => notifyUpdate());
    await waitFor(() =>
      expect(requireReadyWorkspace(result.current).workspace.generatedAt).toBe(
        expected.generatedAt,
      ),
    );
  }

  it.each(["delta", "snapshot"] as const)(
    "parses tracker 1→3 from held 1 after a %s at 2 without a full fetch",
    async (updateKind) => {
      const initial = JobFinderRendererWorkspaceSnapshotSchema.parse(
        createWorkspace("kept-job"),
      );
      initial.fitJudgmentProgress = null;
      const run = (id: string, activityIds: string[]) =>
        DiscoveryRunRecordSchema.parse({
          id,
          state: "running",
          startedAt: initial.generatedAt,
          activity: activityIds.map((eventId) => ({
            id: eventId,
            runId: id,
            timestamp: initial.generatedAt,
            kind: "info",
            stage: "run",
            message: eventId,
          })),
        });
      initial.activeDiscoveryRun = run("held-run", ["held-prefix"]);
      const intermediate: JobFinderRendererWorkspaceSnapshot = {
        ...initial,
        generatedAt: "2026-08-09T10:01:00.000Z",
        profile:
          updateKind === "snapshot"
            ? { ...initial.profile, summary: "Intermediate summary" }
            : initial.profile,
        discoveryJobs: [
          { ...initial.discoveryJobs[0]!, title: "Intermediate title" },
          JobListRowSchema.parse(
            createDiscoveryJob("temporary-job", initial.generatedAt),
          ),
        ],
        activeDiscoveryRun: run("intermediate-run", ["wrong-prefix"]),
      };
      const final: JobFinderRendererWorkspaceSnapshot = {
        ...initial,
        generatedAt: "2026-08-09T10:02:00.000Z",
        activeDiscoveryRun: run("held-run", ["held-prefix", "final-tail"]),
      };
      const tracker = createJobFinderWorkspaceDeltaTracker();
      const first = JobFinderWorkspaceSyncResultSchema.parse(
        tracker.synchronize(null, initial),
      );
      // A changed field now travels inside a delta; a full snapshot at 2 is
      // what another receiver with an unknown revision gets.
      const second = JobFinderWorkspaceSyncResultSchema.parse(
        tracker.synchronize(updateKind === "snapshot" ? 99 : 1, intermediate),
      );
      expect(second.kind).toBe(updateKind);
      const cumulative = parsedDelta(tracker.synchronize(1, final));
      expect(cumulative.delta).toMatchObject({
        baseRevision: 1,
        currentRevision: 3,
        discoveryJobs: { upserts: [], removedIds: [] },
        activeDiscoveryRunActivityFrom: 1,
      });
      const direct = applyJobFinderWorkspaceDelta({
        revision: 1,
        workspace: initial,
        delta: cumulative.delta,
      });
      expect(direct.status).toBe("applied");
      if (direct.status === "applied") expect(direct.workspace).toEqual(final);
      const mutation = deferred<JobFinderWorkspaceSyncResult>();
      syncWorkspace.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
      mutateWorkspaceEntities.mockReturnValueOnce(mutation.promise);
      const { result } = renderHook(() => useJobFinderWorkspace());
      await waitFor(() => expect(result.current.status).toBe("ready"));
      const baseline = requireReadyWorkspace(result.current).workspace;
      let pending!: Promise<unknown>;
      act(() => {
        pending = requireReadyWorkspace(
          result.current,
        ).actions.queueJobForReview("kept-job");
      });
      await publishUpdate(result, intermediate);
      expect(
        requireReadyWorkspace(result.current).workspace.discoveryJobs,
      ).toEqual(intermediate.discoveryJobs);
      await act(async () => {
        mutation.resolve(cumulative);
        await pending;
      });
      const actual = requireReadyWorkspace(result.current).workspace;
      expect(actual).toEqual(final);
      expect(actual.discoveryJobs).toBe(baseline.discoveryJobs);
      expect(actual.discoveryJobs[0]).toBe(baseline.discoveryJobs[0]);
      expect(actual.activeDiscoveryRun?.activity.map(({ id }) => id)).toEqual([
        "held-prefix",
        "final-tail",
      ]);
      expect(syncWorkspace.mock.calls).toEqual([[null], [1]]);
      expect(getWorkspace).not.toHaveBeenCalled();
    },
  );

  it("ignores an older mutation delta after a cumulative update already reached 3", async () => {
    const initial = createWorkspace("initial-job");
    const intermediate = {
      ...initial,
      generatedAt: "2026-08-09T10:01:00.000Z",
    };
    const final = { ...initial, generatedAt: "2026-08-09T10:02:00.000Z" };
    const tracker = createJobFinderWorkspaceDeltaTracker();
    syncWorkspace.mockResolvedValueOnce(tracker.synchronize(null, initial));
    const older = parsedDelta(tracker.synchronize(1, intermediate));
    const newer = parsedDelta(tracker.synchronize(1, final));
    syncWorkspace.mockResolvedValueOnce(newer);
    const mutation = deferred<JobFinderWorkspaceSyncResult>();
    mutateWorkspaceEntities.mockReturnValueOnce(mutation.promise);
    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    let pending!: Promise<unknown>;
    act(() => {
      pending = requireReadyWorkspace(result.current).actions.queueJobForReview(
        "initial-job",
      );
    });
    await publishUpdate(result, final);
    const held = requireReadyWorkspace(result.current).workspace;
    await act(async () => {
      mutation.resolve(older);
      await pending;
    });
    expect(requireReadyWorkspace(result.current).workspace).toBe(held);
    expect(syncWorkspace).toHaveBeenCalledTimes(2);
    expect(getWorkspace).not.toHaveBeenCalled();
  });

  it.each([4, 5])(
    "keeps four baselines and recovers only after revision 1 expires at %i",
    async (latestRevision) => {
      const initial = createWorkspace("initial-job");
      const tracker = createJobFinderWorkspaceDeltaTracker();
      syncWorkspace.mockResolvedValueOnce(tracker.synchronize(null, initial));
      const mutation = deferred<JobFinderWorkspaceSyncResult>();
      mutateWorkspaceEntities.mockReturnValueOnce(mutation.promise);
      const { result } = renderHook(() => useJobFinderWorkspace());
      await waitFor(() => expect(result.current.status).toBe("ready"));
      let pending!: Promise<unknown>;
      act(() => {
        pending = requireReadyWorkspace(
          result.current,
        ).actions.queueJobForReview("initial-job");
      });
      for (let revision = 2; revision <= latestRevision; revision += 1) {
        const current = {
          ...initial,
          generatedAt: `2026-08-09T10:0${revision}:00.000Z`,
        };
        syncWorkspace.mockResolvedValueOnce(
          parsedDelta(tracker.synchronize(revision - 1, current)),
        );
        await publishUpdate(result, current);
      }
      const recovered = createWorkspace(
        "recovered-job",
        "2026-08-09T10:07:00.000Z",
      );
      if (latestRevision === 5) {
        syncWorkspace.mockResolvedValueOnce(snapshotResult(recovered, 7));
      }
      await act(async () => {
        mutation.resolve({
          kind: "delta",
          delta: createJobReplacementDelta({
            baseRevision: 1,
            currentRevision: 6,
            previousJobId: "initial-job",
            currentJobId: "stale-job",
          }),
        });
        await pending;
      });
      if (latestRevision === 5) {
        expect(requireReadyWorkspace(result.current).workspace).toBe(recovered);
        expect(syncWorkspace.mock.calls).toEqual([
          [null],
          [1],
          [2],
          [3],
          [4],
          [null],
        ]);
      } else {
        expect(
          requireReadyWorkspace(result.current).workspace
            .selectedDiscoveryJobId,
        ).toBe("stale-job");
        expect(syncWorkspace.mock.calls).toEqual([[null], [1], [2], [3]]);
      }
      expect(getWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each([
    "checkBrowserSession",
    "resetWorkspace",
    "runAgentDiscovery",
  ] as const)(
    "invalidates all held baselines after %s returns a bare snapshot",
    async (action) => {
      const initial = createWorkspace("initial-job");
      const bare = createWorkspace("bare-job");
      const recovered = createWorkspace("recovered-job");
      syncWorkspace
        .mockResolvedValueOnce(snapshotResult(initial, 1))
        .mockResolvedValueOnce(snapshotResult(recovered, 4));
      bareSnapshotAction.mockResolvedValueOnce(bare);
      Object.assign(window.nestor.jobFinder as object, {
        runAgentDiscovery: () => Promise.resolve({ snapshot: bare }),
      });
      mutateWorkspaceEntities.mockResolvedValueOnce({
        kind: "delta",
        delta: createJobReplacementDelta({
          baseRevision: 1,
          currentRevision: 3,
          previousJobId: "initial-job",
          currentJobId: "stale-job",
        }),
      });
      const { result } = renderHook(() => useJobFinderWorkspace());
      await waitFor(() => expect(result.current.status).toBe("ready"));
      await act(async () => {
        await requireReadyWorkspace(result.current).actions[action]();
      });
      expect(requireReadyWorkspace(result.current).workspace).toBe(bare);
      await act(async () => {
        await requireReadyWorkspace(result.current).actions.queueJobForReview(
          "bare-job",
        );
      });
      expect(mutateWorkspaceEntities).toHaveBeenCalledWith({
        baseRevision: null,
        mutation: { type: "queue_job_for_review", jobId: "bare-job" },
      });
      expect(requireReadyWorkspace(result.current).workspace).toBe(recovered);
      expect(syncWorkspace.mock.calls).toEqual([[null], [null]]);
      expect(getWorkspace).not.toHaveBeenCalled();
    },
  );

  it("starts an unrevisioned bootstrap with no claimed baseline", async () => {
    const bootstrap = createWorkspace("bootstrap-job");
    const recovered = createWorkspace("recovered-job");
    Object.assign(window.nestor.jobFinder as object, {
      getWorkspaceBootstrap: () => Promise.resolve(bootstrap),
    });
    syncWorkspace.mockResolvedValueOnce(snapshotResult(recovered, 4));
    mutateWorkspaceEntities.mockResolvedValueOnce({
      kind: "delta",
      delta: createJobReplacementDelta({
        baseRevision: 1,
        currentRevision: 3,
        previousJobId: "bootstrap-job",
        currentJobId: "unheld-job",
      }),
    });
    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await requireReadyWorkspace(result.current).actions.queueJobForReview(
        "bootstrap-job",
      );
    });
    expect(mutateWorkspaceEntities.mock.calls[0]?.[0].baseRevision).toBeNull();
    expect(requireReadyWorkspace(result.current).workspace).toBe(recovered);
    expect(syncWorkspace.mock.calls).toEqual([[null]]);
    expect(getWorkspace).not.toHaveBeenCalled();
  });

  it("clears old baselines on recovery and retains the new revisioned snapshot", async () => {
    const initial = createWorkspace("initial-job");
    const recovered = createWorkspace("recovered-job");
    const final = createWorkspace("final-job");
    syncWorkspace
      .mockResolvedValueOnce(snapshotResult(initial, 1))
      .mockResolvedValueOnce(snapshotResult(recovered, 4))
      .mockResolvedValueOnce(snapshotResult(final, 6));
    mutateWorkspaceEntities
      .mockResolvedValueOnce({
        kind: "delta",
        delta: createJobReplacementDelta({
          baseRevision: 2,
          currentRevision: 3,
          previousJobId: "initial-job",
          currentJobId: "gap-job",
        }),
      })
      .mockResolvedValueOnce({
        kind: "delta",
        delta: createJobReplacementDelta({
          baseRevision: 1,
          currentRevision: 5,
          previousJobId: "initial-job",
          currentJobId: "stale-job",
        }),
      })
      .mockResolvedValueOnce({
        kind: "delta",
        delta: createJobReplacementDelta({
          baseRevision: 6,
          currentRevision: 8,
          previousJobId: "final-job",
          currentJobId: "last-job",
        }),
      });
    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    for (const jobId of ["initial-job", "recovered-job", "final-job"]) {
      await act(async () => {
        await requireReadyWorkspace(result.current).actions.queueJobForReview(
          jobId,
        );
      });
    }
    expect(
      mutateWorkspaceEntities.mock.calls.map(([input]) => input.baseRevision),
    ).toEqual([1, 4, 6]);
    expect(
      requireReadyWorkspace(result.current).workspace.selectedDiscoveryJobId,
    ).toBe("last-job");
    expect(syncWorkspace.mock.calls).toEqual([[null], [null], [null]]);
    expect(getWorkspace).not.toHaveBeenCalled();
  });
});

describe("useJobFinderWorkspace entity mutations", () => {
  const syncWorkspace =
    vi.fn<
      (baseRevision: number | null) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const mutateWorkspaceEntities =
    vi.fn<
      (
        input: JobFinderWorkspaceEntityMutationInput,
      ) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const getWorkspace =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const getWorkspaceBootstrap =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const checkBrowserSession =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const legacyQueueJobForReview =
    vi.fn<(jobId: string) => Promise<JobFinderRendererWorkspaceSnapshot>>();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        ping: vi.fn(() => Promise.resolve({ platform: "win32" as const })),
        jobFinder: {
          syncWorkspace,
          mutateWorkspaceEntities,
          getWorkspace,
          checkBrowserSession,
          queueJobForReview: legacyQueueJobForReview,
        },
      } as unknown as Window["nestor"],
    });
  });

  function enableBootstrapApi() {
    Object.assign(window.nestor.jobFinder as object, {
      getWorkspaceBootstrap,
    });
  }

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, "nestor");
  });

  it("applies returned pause and browser-reset snapshots without polling", async () => {
    const initial = createBaseSnapshot("2026-10-05T10:00:00Z");
    const resumed = {
      ...initial,
      generatedAt: "2026-10-05T10:00:01Z",
      activityControl: { paused: false, pausedAt: null, reason: null },
    };
    const reset = {
      ...resumed,
      generatedAt: "2026-10-05T10:00:02Z",
      activityControl: {
        paused: true,
        pausedAt: "2026-10-05T10:00:02Z",
        reason: "Browser reset",
      },
    };
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: initial,
    });
    Object.assign(window.nestor.jobFinder, {
      setActivityControl: vi.fn().mockResolvedValue(resumed),
      resetBrowser: vi.fn().mockResolvedValue(reset),
    });
    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await requireReadyWorkspace(result.current).actions.setActivityControl({
        paused: false,
      });
    });
    expect(requireReadyWorkspace(result.current).workspace).toBe(resumed);
    await act(async () => {
      await requireReadyWorkspace(result.current).actions.resetBrowser();
    });
    expect(requireReadyWorkspace(result.current).workspace).toBe(reset);
  });

  it("commits a typed entity delta without calling the legacy snapshot route", async () => {
    const initialWorkspace = createWorkspace("job-old");
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: initialWorkspace,
    });
    mutateWorkspaceEntities.mockResolvedValueOnce({
      kind: "delta",
      delta: createJobReplacementDelta({
        baseRevision: 1,
        currentRevision: 2,
        previousJobId: "job-old",
        currentJobId: "job-new",
      }),
    });

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await requireReadyWorkspace(result.current).actions.queueJobForReview(
        "job-new",
      );
    });

    expect(mutateWorkspaceEntities).toHaveBeenCalledWith({
      baseRevision: 1,
      mutation: {
        type: "queue_job_for_review",
        jobId: "job-new",
      },
    });
    expect(legacyQueueJobForReview).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    if (result.current.status === "ready") {
      expect(
        result.current.workspace.discoveryJobs.map(({ id }) => id),
      ).toEqual(["job-new"]);
      expect(result.current.workspace.selectedDiscoveryJobId).toBe("job-new");
    }
  });

  it("commits one bulk shortlist delta for every selected ID without a full workspace read", async () => {
    const initial = createWorkspace("job-old");
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: initial,
    });
    const jobIds = Array.from({ length: 50 }, (_, index) => `job-${index}`);
    const delta = createJobReplacementDelta({
      baseRevision: 1,
      currentRevision: 2,
      previousJobId: "job-old",
      currentJobId: "job-49",
    });
    mutateWorkspaceEntities.mockResolvedValueOnce({ kind: "delta", delta });
    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      await requireReadyWorkspace(result.current).actions.queueJobsForReview!(
        jobIds,
      );
    });
    expect(mutateWorkspaceEntities).toHaveBeenCalledExactlyOnceWith({
      baseRevision: 1,
      mutation: { type: "queue_jobs_for_review", jobIds },
    });
    expect(legacyQueueJobForReview).not.toHaveBeenCalled();
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(
      requireReadyWorkspace(result.current).workspace.discoveryJobs.map(
        ({ id }) => id,
      ),
    ).toEqual(["job-49"]);
    mutateWorkspaceEntities.mockResolvedValueOnce({
      kind: "delta",
      delta: { ...delta, baseRevision: 2, currentRevision: 3 },
    });
    await act(async () => {
      await requireReadyWorkspace(result.current).actions.queueJobsForReview!([
        "job-49",
      ]);
    });
    expect(mutateWorkspaceEntities).toHaveBeenLastCalledWith({
      baseRevision: 2,
      mutation: { type: "queue_jobs_for_review", jobIds: ["job-49"] },
    });
  });

  // PERF-03 / F33 durability contract. A mutation that answers with the typed
  // sync envelope must let the renderer CARRY its revision baseline forward;
  // a mutation that answers with a bare snapshot must SURRENDER it. Both
  // halves are load-bearing: the first is the whole point of the delta path,
  // and the second is what stops a delta from being computed against a
  // baseline the renderer no longer holds.
  it("carries the delta revision baseline forward across consecutive mutations", async () => {
    const initialWorkspace = createWorkspace("job-old");
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: initialWorkspace,
    });
    mutateWorkspaceEntities
      .mockResolvedValueOnce({
        kind: "delta",
        delta: createJobReplacementDelta({
          baseRevision: 1,
          currentRevision: 2,
          previousJobId: "job-old",
          currentJobId: "job-second",
        }),
      })
      .mockResolvedValueOnce({
        kind: "delta",
        delta: createJobReplacementDelta({
          baseRevision: 2,
          currentRevision: 3,
          previousJobId: "job-second",
          currentJobId: "job-third",
        }),
      });

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await requireReadyWorkspace(result.current).actions.queueJobForReview(
        "job-second",
      );
    });
    await act(async () => {
      await requireReadyWorkspace(result.current).actions.queueJobForReview(
        "job-third",
      );
    });

    // The second mutation must advertise revision 2 — not 0/null. Resetting
    // the baseline here is what forced every follow-up request back onto a
    // full-snapshot payload.
    expect(mutateWorkspaceEntities).toHaveBeenNthCalledWith(2, {
      baseRevision: 2,
      mutation: { type: "queue_job_for_review", jobId: "job-third" },
    });
    // No extra full-snapshot round trip was needed to keep converging.
    expect(syncWorkspace).toHaveBeenCalledTimes(1);
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(
      requireReadyWorkspace(result.current).workspace.discoveryJobs.map(
        ({ id }) => id,
      ),
    ).toEqual(["job-third"]);
  });

  it("surrenders the delta baseline after a bare-snapshot mutation response", async () => {
    const initialWorkspace = createWorkspace("job-old");
    const mutatedWorkspace = createWorkspace(
      "job-after-bare-snapshot",
      "2026-08-09T10:05:00.000Z",
    );
    // Exactly one queued sync response: the initial hydration. Leaving an
    // unconsumed `...Once` value behind would leak into the next test,
    // because `vi.clearAllMocks()` clears calls but not queued results.
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: initialWorkspace,
    });
    checkBrowserSession.mockResolvedValueOnce(mutatedWorkspace);

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await requireReadyWorkspace(result.current).actions.checkBrowserSession();
    });

    // A bare snapshot carries no revision, so the renderer holds a workspace
    // that corresponds to no revision main knows about. The next entity
    // mutation must therefore ask for a full re-baseline rather than claim a
    // revision whose baseline no longer matches the committed state.
    mutateWorkspaceEntities.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 8,
      reason: "stale_base",
      snapshot: mutatedWorkspace,
    });
    await act(async () => {
      await requireReadyWorkspace(result.current).actions.queueJobForReview(
        "job-after-bare-snapshot",
      );
    });

    expect(mutateWorkspaceEntities).toHaveBeenNthCalledWith(1, {
      baseRevision: null,
      mutation: {
        type: "queue_job_for_review",
        jobId: "job-after-bare-snapshot",
      },
    });
  });

  it("clears cancelled import progress and ignores progress delivered after settlement", async () => {
    const initialWorkspace = createWorkspace("job-import");
    const importResponse = deferred<JobFinderRendererWorkspaceSnapshot>();
    const progressListeners: Array<
      ((event: ResumeImportProgressEvent) => void) | undefined
    > = [];
    const importResume =
      vi.fn<
        (
          onProgress?: (event: ResumeImportProgressEvent) => void,
        ) => Promise<JobFinderRendererWorkspaceSnapshot>
      >();
    importResume.mockImplementation((onProgress) => {
      progressListeners.push(onProgress);
      return importResponse.promise;
    });
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: initialWorkspace,
    });
    Object.assign(window.nestor.jobFinder as object, { importResume });

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let importPromise!: Promise<JobFinderRendererWorkspaceSnapshot>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      importPromise = result.current.actions.importResume();
    });

    const progress: ResumeImportProgressEvent = {
      stage: "reading_document",
      message: "Reading the selected resume.",
      occurredAt: "2026-08-09T10:00:01.000Z",
    };
    act(() => {
      progressListeners[0]?.(progress);
    });
    await waitFor(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      expect(result.current.resumeImportProgress).toEqual(progress);
    });

    // Main resolves a closed/cancelled picker with the unchanged snapshot.
    await act(async () => {
      importResponse.resolve(initialWorkspace);
      await importPromise;
    });
    expect(result.current.status).toBe("ready");
    if (result.current.status === "ready") {
      expect(result.current.resumeImportProgress).toBeNull();
    }

    // A misbehaving late event must not resurrect Guided setup's busy state.
    act(() => {
      progressListeners[0]?.(progress);
    });
    expect(result.current.status).toBe("ready");
    if (result.current.status === "ready") {
      expect(result.current.resumeImportProgress).toBeNull();
    }
  });

  it("recovers a revision mismatch with one fresh snapshot", async () => {
    const initialWorkspace = createWorkspace("job-old");
    const recoveredWorkspace = createWorkspace(
      "job-recovered",
      "2026-08-09T10:02:00.000Z",
    );
    syncWorkspace
      .mockResolvedValueOnce({
        kind: "snapshot",
        currentRevision: 4,
        reason: "initial",
        snapshot: initialWorkspace,
      })
      .mockResolvedValueOnce({
        kind: "snapshot",
        currentRevision: 6,
        reason: "initial",
        snapshot: recoveredWorkspace,
      });
    mutateWorkspaceEntities.mockResolvedValueOnce({
      kind: "delta",
      delta: createJobReplacementDelta({
        baseRevision: 2,
        currentRevision: 5,
        previousJobId: "job-old",
        currentJobId: "job-stale",
      }),
    });

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await requireReadyWorkspace(result.current).actions.removeJobFromReview(
        "job-old",
      );
    });

    expect(syncWorkspace).toHaveBeenNthCalledWith(2, null);
    expect(getWorkspace).not.toHaveBeenCalled();
    if (result.current.status === "ready") {
      expect(result.current.workspace.selectedDiscoveryJobId).toBe(
        "job-recovered",
      );
    }
  });

  it("ignores a slower older action response after a newer response commits", async () => {
    const initialWorkspace = createWorkspace("job-initial");
    const olderWorkspace = createWorkspace(
      "job-older",
      "2026-08-09T10:03:00.000Z",
    );
    const newerWorkspace = createWorkspace(
      "job-newer",
      "2026-08-09T10:04:00.000Z",
    );
    syncWorkspace
      .mockResolvedValueOnce({
        kind: "snapshot",
        currentRevision: 1,
        reason: "initial",
        snapshot: initialWorkspace,
      })
      // The fenced older response schedules one trailing authoritative
      // fetch so the superseded action still converges; it must observe the
      // already-committed newer state instead of rolling it back.
      .mockResolvedValueOnce({
        kind: "snapshot",
        currentRevision: 2,
        reason: "initial",
        snapshot: newerWorkspace,
      });
    const older = deferred<JobFinderRendererWorkspaceSnapshot>();
    const newer = deferred<JobFinderRendererWorkspaceSnapshot>();
    checkBrowserSession
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let olderAction!: Promise<JobFinderRendererWorkspaceSnapshot>;
    let newerAction!: Promise<JobFinderRendererWorkspaceSnapshot>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }

      olderAction = result.current.actions.checkBrowserSession();
      newerAction = result.current.actions.checkBrowserSession();
    });

    await act(async () => {
      newer.resolve(newerWorkspace);
      await newerAction;
    });
    await act(async () => {
      older.resolve(olderWorkspace);
      await olderAction;
    });

    expect(result.current.status).toBe("ready");
    if (result.current.status === "ready") {
      expect(result.current.workspace.selectedDiscoveryJobId).toBe("job-newer");
    }
    // The convergence fetch runs after the fenced response settles and its
    // snapshot (already reflecting the newer commit) keeps the state.
    await waitFor(() => expect(syncWorkspace).toHaveBeenCalledTimes(2));
    if (result.current.status === "ready") {
      expect(result.current.workspace.selectedDiscoveryJobId).toBe("job-newer");
    }
  });

  it("keeps an update-triggered sync from invalidating an in-flight cancellation", async () => {
    const beforeCancellation = createWorkspace("job-running");
    const cancelled = createWorkspace(
      "job-cancelled",
      "2026-08-09T10:05:00.000Z",
    );
    const cancellation = deferred<JobFinderRendererWorkspaceSnapshot>();
    const updateSync = deferred<JobFinderWorkspaceSyncResult>();
    const updateListeners: Array<() => void> = [];
    const cancelAgentDiscovery = vi.fn(() => cancellation.promise);
    const onWorkspaceUpdate = vi.fn((listener: () => void) => {
      updateListeners.push(listener);
      return () => undefined;
    });

    syncWorkspace
      .mockResolvedValueOnce({
        kind: "snapshot",
        currentRevision: 1,
        reason: "initial",
        snapshot: beforeCancellation,
      })
      .mockReturnValueOnce(updateSync.promise);
    Object.assign(window.nestor.jobFinder as object, {
      cancelAgentDiscovery,
      onWorkspaceUpdate,
    });

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let cancellationPromise!: Promise<JobFinderRendererWorkspaceSnapshot>;
    act(() => {
      cancellationPromise = requireReadyWorkspace(
        result.current,
      ).actions.cancelAgentDiscovery({ runId: "discovery_run_1" });
    });
    expect(cancelAgentDiscovery).toHaveBeenCalledOnce();

    act(() => updateListeners[0]?.());
    await waitFor(() => expect(syncWorkspace).toHaveBeenCalledTimes(2));

    let cancellationResult: JobFinderRendererWorkspaceSnapshot | undefined;
    await act(async () => {
      cancellation.resolve(cancelled);
      cancellationResult = await cancellationPromise;
    });
    expect(cancellationResult).toBe(cancelled);
    expect(requireReadyWorkspace(result.current).workspace).toBe(cancelled);

    act(() => {
      updateSync.resolve({
        kind: "snapshot",
        currentRevision: 1,
        reason: "initial",
        snapshot: beforeCancellation,
      });
    });
    await act(() => Promise.resolve());

    expect(requireReadyWorkspace(result.current).workspace).toBe(cancelled);
  });

  it("rests between update-driven syncs for twice as long as the last one took", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T10:00:00.000Z"));
    const workspace = createWorkspace("job-searching");
    const snapshotResult = (
      currentRevision: number,
    ): JobFinderWorkspaceSyncResult => ({
      kind: "snapshot",
      currentRevision,
      reason: currentRevision === 1 ? "initial" : "stale_base",
      snapshot: workspace,
    });
    const slowSync = deferred<JobFinderWorkspaceSyncResult>();
    const updateListeners: Array<() => void> = [];
    Object.assign(window.nestor.jobFinder as object, {
      onWorkspaceUpdate: vi.fn((listener: () => void) => {
        updateListeners.push(listener);
        return () => undefined;
      }),
    });
    syncWorkspace
      .mockResolvedValueOnce(snapshotResult(1))
      .mockReturnValueOnce(slowSync.promise)
      .mockResolvedValue(snapshotResult(3));

    const { result } = renderHook(() => useJobFinderWorkspace());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    expect(syncWorkspace).toHaveBeenCalledTimes(1);

    // An update syncs at once; main takes a second to answer.
    act(() => updateListeners[0]?.());
    expect(syncWorkspace).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      slowSync.resolve(snapshotResult(2));
      await vi.advanceTimersByTimeAsync(0);
    });

    // Updates arriving now wait out twice that second, then share one sync.
    act(() => {
      updateListeners[0]?.();
      updateListeners[0]?.();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_990);
    });
    expect(syncWorkspace).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(syncWorkspace).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(syncWorkspace).toHaveBeenCalledTimes(3);
  });

  it("shows the bootstrap before deferred collections arrive and then hydrates them", async () => {
    enableBootstrapApi();
    const bootstrap: JobFinderRendererWorkspaceSnapshot = {
      ...createWorkspace("job-bootstrap"),
      discoveryJobs: [],
      selectedDiscoveryJobId: null,
      hydration: {
        phase: "bootstrap" as const,
        deferredCollections: ["discovery_jobs", "applications"] as const,
      },
    };
    const hydrated = createWorkspace("job-hydrated");
    const hydration = deferred<JobFinderWorkspaceSyncResult>();
    getWorkspaceBootstrap.mockResolvedValueOnce(bootstrap);
    syncWorkspace.mockReturnValueOnce(hydration.promise);

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status === "ready") {
      expect(result.current.workspace.hydration.phase).toBe("bootstrap");
      expect(result.current.workspace.discoveryJobs).toEqual([]);
      expect(result.current.workspace.hydration.deferredCollections).toEqual(
        expect.arrayContaining(["discovery_jobs", "applications"]),
      );
    }

    await act(async () => {
      hydration.resolve({
        kind: "snapshot",
        currentRevision: 8,
        reason: "initial",
        snapshot: hydrated,
      });
      await hydration.promise;
    });
    await waitFor(() => {
      expect(result.current.status).toBe("ready");
      if (result.current.status === "ready") {
        expect(result.current.workspace.hydration.phase).toBe("complete");
        expect(result.current.workspace.discoveryJobs[0]?.id).toBe(
          "job-hydrated",
        );
      }
    });
  });

  it("does not let late hydration overwrite a newer user action", async () => {
    enableBootstrapApi();
    const bootstrap: JobFinderRendererWorkspaceSnapshot = {
      ...createWorkspace("job-bootstrap"),
      discoveryJobs: [],
      selectedDiscoveryJobId: null,
      hydration: {
        phase: "bootstrap" as const,
        deferredCollections: ["discovery_jobs"] as const,
      },
    };
    const hydrated = createWorkspace("job-hydrated");
    const actionWorkspace = createWorkspace("job-action");
    const hydration = deferred<JobFinderWorkspaceSyncResult>();
    getWorkspaceBootstrap.mockResolvedValueOnce(bootstrap);
    syncWorkspace.mockReturnValueOnce(hydration.promise);
    checkBrowserSession.mockResolvedValueOnce(actionWorkspace);

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      await result.current.actions.checkBrowserSession();
    });

    await act(async () => {
      hydration.resolve({
        kind: "snapshot",
        currentRevision: 9,
        reason: "initial",
        snapshot: hydrated,
      });
      await hydration.promise;
    });

    expect(result.current.status).toBe("ready");
    if (result.current.status === "ready") {
      expect(result.current.workspace.selectedDiscoveryJobId).toBe(
        "job-action",
      );
    }
  });

  it("reports bootstrap failures instead of showing a blank shell", async () => {
    enableBootstrapApi();
    getWorkspaceBootstrap.mockRejectedValueOnce(
      new Error("bootstrap database unavailable"),
    );

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status === "error") {
      expect(result.current.message).toBe("bootstrap database unavailable");
    }
  });

  it("reports a full hydration failure and keeps the bootstrap error actionable", async () => {
    enableBootstrapApi();
    const bootstrap = {
      ...createWorkspace("job-bootstrap"),
      discoveryJobs: [],
      selectedDiscoveryJobId: null,
      hydration: {
        phase: "bootstrap" as const,
        deferredCollections: ["discovery_jobs"] as const,
      },
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    getWorkspaceBootstrap.mockResolvedValueOnce(bootstrap);
    syncWorkspace.mockRejectedValueOnce(
      new Error("hydration sync unavailable"),
    );
    getWorkspace.mockRejectedValueOnce(new Error("full workspace unavailable"));

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status === "error") {
      expect(result.current.message).toBe("full workspace unavailable");
      expect(typeof result.current.retry).toBe("function");
    }
  });

  it("retries the initial workspace load after a recoverable failure", async () => {
    const recoveredWorkspace = createWorkspace("job-recovered");
    syncWorkspace
      .mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce({
        kind: "snapshot",
        currentRevision: 1,
        reason: "initial",
        snapshot: recoveredWorkspace,
      });
    getWorkspace.mockRejectedValueOnce(
      new Error("database temporarily unavailable"),
    );

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("error"));

    act(() => {
      if (result.current.status !== "error") {
        throw new Error("Expected a failed initial workspace load.");
      }
      result.current.retry();
    });

    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status === "ready") {
      expect(result.current.workspace.selectedDiscoveryJobId).toBe(
        "job-recovered",
      );
    }
  });

  it("refreshes just after server reset and when focus or visibility finds stale capacity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T10:00:00.000Z"));
    const initialWorkspace = {
      ...createWorkspace("job-capacity"),
      dashboard: {
        globalDailyApplicationPreparationCapacity: {
          limit: 20,
          used: 7,
          legacyUncertain: 0,
          remaining: 13,
          localDate: "2026-08-09",
          resetsAt: "2026-08-09T10:00:01.000Z",
        },
      },
    } as JobFinderRendererWorkspaceSnapshot;
    const refreshedWorkspace = {
      ...initialWorkspace,
      dashboard: {
        globalDailyApplicationPreparationCapacity: {
          limit: 20,
          used: 0,
          legacyUncertain: 0,
          remaining: 20,
          localDate: "2026-08-10",
          resetsAt: "2026-08-10T10:00:01.000Z",
        },
      },
    } as JobFinderRendererWorkspaceSnapshot;
    syncWorkspace.mockResolvedValue({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: initialWorkspace,
    });

    const { result } = renderHook(() => useJobFinderWorkspace());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe("ready");
    syncWorkspace.mockClear();
    syncWorkspace.mockResolvedValue({
      kind: "snapshot",
      currentRevision: 2,
      reason: "initial",
      snapshot: refreshedWorkspace,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(syncWorkspace).toHaveBeenCalledTimes(1);

    syncWorkspace.mockClear();
    vi.setSystemTime(new Date("2026-08-10T10:00:02.000Z"));
    window.dispatchEvent(new Event("focus"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(syncWorkspace).toHaveBeenCalledTimes(1);

    syncWorkspace.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(syncWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("useJobFinderWorkspace concurrency convergence", () => {
  function deferral<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });

    return { promise, resolve, reject };
  }

  const syncWorkspace =
    vi.fn<
      (baseRevision: number | null) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const mutateWorkspaceEntities =
    vi.fn<
      (
        input: JobFinderWorkspaceEntityMutationInput,
      ) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const getWorkspace =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const getWorkspaceBootstrap =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const checkBrowserSession =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const saveProfile =
    vi.fn<
      (profile: CandidateProfile) => Promise<JobFinderRendererWorkspaceSnapshot>
    >();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        ping: vi.fn(() => Promise.resolve({ platform: "win32" as const })),
        jobFinder: {
          syncWorkspace,
          mutateWorkspaceEntities,
          getWorkspace,
          checkBrowserSession,
          saveProfile,
        },
      } as unknown as Window["nestor"],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nestor");
  });

  // Bootstrap-aware initial load; legacy-path tests never install this.
  function enableBootstrapApi() {
    Object.assign(window.nestor.jobFinder as object, {
      getWorkspaceBootstrap,
    });
  }

  function createBootstrapPhaseWorkspace(
    jobId: string,
  ): JobFinderRendererWorkspaceSnapshot {
    const base = createWorkspace(jobId);
    return {
      ...base,
      hydration: {
        phase: "bootstrap" as const,
        deferredCollections: ["discovery_jobs"] as const,
      },
    };
  }

  function queueSyncResponses(
    ...responses: Array<{ promise: Promise<JobFinderWorkspaceSyncResult> }>
  ) {
    syncWorkspace.mockImplementation(() => {
      const next = responses.shift();
      if (!next) {
        throw new Error("Unexpected extra syncWorkspace call");
      }
      return next.promise;
    });
  }

  function snapshotResult(
    snapshot: JobFinderRendererWorkspaceSnapshot,
    currentRevision = 1,
  ): JobFinderWorkspaceSyncResult {
    return { kind: "snapshot", currentRevision, reason: "initial", snapshot };
  }

  function renderReadyWith(
    firstSync: { promise: Promise<JobFinderWorkspaceSyncResult> },
    snapshot: JobFinderRendererWorkspaceSnapshot,
    ...restResponses: Array<{ promise: Promise<JobFinderWorkspaceSyncResult> }>
  ) {
    queueSyncResponses(firstSync, ...restResponses);
    return renderHook(() => useJobFinderWorkspace());
  }

  it("converges a committed entity mutation that lost the sequencing race to a background refresh", async () => {
    const staleWorkspace = createWorkspace("job-old");
    const convergedWorkspace = createWorkspace(
      "job-new",
      "2026-08-09T10:06:00.000Z",
    );

    const initialSync = deferral<JobFinderWorkspaceSyncResult>();
    const backgroundRefresh = deferral<JobFinderWorkspaceSyncResult>();
    const convergenceFetch = deferral<JobFinderWorkspaceSyncResult>();
    const mutation = deferral<JobFinderWorkspaceSyncResult>();

    mutateWorkspaceEntities.mockReturnValue(mutation.promise);
    const { result } = renderReadyWith(
      initialSync,
      staleWorkspace,
      backgroundRefresh,
      convergenceFetch,
    );
    act(() => {
      initialSync.resolve(snapshotResult(staleWorkspace));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(syncWorkspace).toHaveBeenCalledTimes(1);

    let mutationPromise!: Promise<unknown>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      mutationPromise = result.current.actions.queueJobForReview("job-new");
    });

    // A focus/capacity-style refresh starts after the mutation dispatched
    // and answers first, committing the pre-mutation snapshot.
    let refreshPromise!: Promise<unknown>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      refreshPromise = result.current.actions.refreshWorkspace();
    });
    act(() => {
      backgroundRefresh.resolve(snapshotResult(staleWorkspace));
    });
    await refreshPromise;

    act(() => {
      mutation.resolve({
        kind: "delta",
        delta: createJobReplacementDelta({
          baseRevision: 1,
          currentRevision: 2,
          previousJobId: "job-old",
          currentJobId: "job-new",
        }),
      });
    });

    // The fenced mutation response must not be dropped silently: exactly one
    // trailing authoritative fetch is scheduled instead.
    await waitFor(() => expect(syncWorkspace).toHaveBeenCalledTimes(3));

    act(() => {
      convergenceFetch.resolve(snapshotResult(convergedWorkspace, 2));
    });

    await waitFor(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      expect(
        result.current.workspace.discoveryJobs.map(({ id }) => id),
      ).toEqual(["job-new"]);
      expect(result.current.workspace.selectedDiscoveryJobId).toBe("job-new");
    });
    await mutationPromise;
  });

  it("converges a fenced user action response with one trailing fetch", async () => {
    const staleWorkspace = createWorkspace("job-old");
    const savedWorkspace = createWorkspace(
      "job-old",
      "2026-08-09T10:08:00.000Z",
    );

    const initialSync = deferral<JobFinderWorkspaceSyncResult>();
    const backgroundRefresh = deferral<JobFinderWorkspaceSyncResult>();
    const convergenceFetch = deferral<JobFinderWorkspaceSyncResult>();
    const actionResponse = deferral<JobFinderRendererWorkspaceSnapshot>();

    saveProfile.mockReturnValue(actionResponse.promise);
    const { result } = renderReadyWith(
      initialSync,
      staleWorkspace,
      backgroundRefresh,
      convergenceFetch,
    );
    act(() => {
      initialSync.resolve(snapshotResult(staleWorkspace));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(syncWorkspace).toHaveBeenCalledTimes(1);

    let actionPromise!: Promise<unknown>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      actionPromise = result.current.actions.saveProfile(
        {} as CandidateProfile,
      );
    });

    // The refresh wins the race and commits while the action is in flight.
    let refreshPromise!: Promise<unknown>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      refreshPromise = result.current.actions.refreshWorkspace();
    });
    act(() => {
      backgroundRefresh.resolve(snapshotResult(staleWorkspace));
    });
    await refreshPromise;

    act(() => {
      actionResponse.resolve(savedWorkspace);
    });

    await waitFor(() => expect(syncWorkspace).toHaveBeenCalledTimes(3));

    act(() => {
      convergenceFetch.resolve(snapshotResult(savedWorkspace, 2));
    });

    await waitFor(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      // The fenced action's own snapshot must not be committed directly, but
      // the visible workspace must still converge onto its committed state.
      expect(result.current.workspace.generatedAt).toBe(
        savedWorkspace.generatedAt,
      );
    });
    await actionPromise;
  });

  it("resumes hydration when an allowDuringBootstrap action supersedes it", async () => {
    const bootstrapSnapshot = createBootstrapPhaseWorkspace("job-old");
    const supersedingSnapshot = createBootstrapPhaseWorkspace("job-old");
    const hydratedSnapshot = createWorkspace("job-old");

    const bootstrap = deferral<JobFinderRendererWorkspaceSnapshot>();
    const hydrationFetch = deferral<JobFinderWorkspaceSyncResult>();
    const resumeFetch = deferral<JobFinderWorkspaceSyncResult>();
    const actionResponse = deferral<JobFinderRendererWorkspaceSnapshot>();

    enableBootstrapApi();
    getWorkspaceBootstrap.mockReturnValue(bootstrap.promise);
    checkBrowserSession.mockReturnValue(actionResponse.promise);

    // The hydration request fires immediately after the bootstrap snapshot
    // lands, so the response queue must be installed before resolving it.
    queueSyncResponses(hydrationFetch, resumeFetch);

    const { result } = renderHook(() => useJobFinderWorkspace());
    act(() => {
      bootstrap.resolve(bootstrapSnapshot);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") {
      throw new Error("Expected a ready workspace.");
    }
    expect(result.current.workspace.hydration.phase).toBe("bootstrap");
    expect(syncWorkspace).toHaveBeenCalledTimes(1);

    let actionPromise!: Promise<unknown>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      actionPromise = result.current.actions.checkBrowserSession();
    });

    // The allowDuringBootstrap action wins the sequence race and commits
    // another partial bootstrap snapshot while the backend still hydrates.
    act(() => {
      actionResponse.resolve(supersedingSnapshot);
    });

    // Hydration settles afterwards and loses the fence.
    act(() => {
      hydrationFetch.resolve(snapshotResult(hydratedSnapshot, 9));
    });

    // A superseded hydration must schedule one authoritative resume fetch
    // instead of stranding the shell on the partial bootstrap forever.
    await waitFor(() => expect(syncWorkspace).toHaveBeenCalledTimes(2));

    act(() => {
      resumeFetch.resolve(snapshotResult(hydratedSnapshot, 9));
    });

    await waitFor(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      expect(result.current.workspace.hydration.phase).toBe("complete");
      expect(result.current.workspace.generatedAt).toBe(
        hydratedSnapshot.generatedAt,
      );
    });
    await actionPromise;
  });

  it("recovers bootstrap through the resume fetch when a superseded hydration attempt fails", async () => {
    const bootstrapSnapshot = createBootstrapPhaseWorkspace("job-old");
    const supersedingSnapshot = createBootstrapPhaseWorkspace("job-old");
    const hydratedSnapshot = createWorkspace("job-old");

    const bootstrap = deferral<JobFinderRendererWorkspaceSnapshot>();
    const hydrationFetch = deferral<JobFinderWorkspaceSyncResult>();
    const resumeFetch = deferral<JobFinderWorkspaceSyncResult>();
    const actionResponse = deferral<JobFinderRendererWorkspaceSnapshot>();

    enableBootstrapApi();
    getWorkspaceBootstrap.mockReturnValue(bootstrap.promise);
    checkBrowserSession.mockReturnValue(actionResponse.promise);

    queueSyncResponses(hydrationFetch, resumeFetch);
    getWorkspace.mockRejectedValueOnce(new Error("hydration full load failed"));

    const { result } = renderHook(() => useJobFinderWorkspace());
    act(() => {
      bootstrap.resolve(bootstrapSnapshot);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let actionPromise!: Promise<unknown>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      actionPromise = result.current.actions.checkBrowserSession();
    });
    act(() => {
      actionResponse.resolve(supersedingSnapshot);
    });

    act(() => {
      hydrationFetch.reject(new Error("hydration sync failed"));
    });

    // The failed-but-superseded hydration still converges through the resume
    // fetch; no error state and no stranded bootstrap.
    await waitFor(() => expect(syncWorkspace).toHaveBeenCalledTimes(2));

    act(() => {
      resumeFetch.resolve(snapshotResult(hydratedSnapshot, 4));
    });

    await waitFor(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace without an error state.");
      }
      expect(result.current.workspace.hydration.phase).toBe("complete");
    });
    await actionPromise;
  });

  it("surfaces a retryable error when even the bootstrap resume fetch fails", async () => {
    const bootstrapSnapshot = createBootstrapPhaseWorkspace("job-old");
    const supersedingSnapshot = createBootstrapPhaseWorkspace("job-old");

    const bootstrap = deferral<JobFinderRendererWorkspaceSnapshot>();
    const hydrationFetch = deferral<JobFinderWorkspaceSyncResult>();
    const resumeFetch = deferral<JobFinderWorkspaceSyncResult>();
    const actionResponse = deferral<JobFinderRendererWorkspaceSnapshot>();

    enableBootstrapApi();
    getWorkspaceBootstrap.mockReturnValue(bootstrap.promise);
    checkBrowserSession.mockReturnValue(actionResponse.promise);

    queueSyncResponses(hydrationFetch, resumeFetch);
    getWorkspace.mockRejectedValue(new Error("resume fallback failed"));

    const { result } = renderHook(() => useJobFinderWorkspace());
    act(() => {
      bootstrap.resolve(bootstrapSnapshot);
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let actionPromise!: Promise<unknown>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      actionPromise = result.current.actions.checkBrowserSession();
    });
    act(() => {
      actionResponse.resolve(supersedingSnapshot);
    });

    act(() => {
      hydrationFetch.reject(new Error("hydration sync failed"));
    });

    // The superseded hydration schedules one authoritative resume fetch.
    await waitFor(() => expect(syncWorkspace).toHaveBeenCalledTimes(2));

    // Even the resume fetch fails end to end; the shell must surface the
    // retryable error instead of silently stranding the bootstrap phase.
    act(() => {
      resumeFetch.reject(new Error("resume sync failed"));
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status === "error") {
      expect(result.current.message).toBe("resume fallback failed");
      expect(typeof result.current.retry).toBe("function");
    }
    await actionPromise;
  });
});

describe("useJobFinderWorkspace resume claim confirmation action", () => {
  const removeCommand: JobFinderSetResumeClaimConfirmationInput = {
    intent: "remove",
    jobId: "job_1",
    draftId: "resume_draft_job_1",
    expectedDraftUpdatedAt: "2026-08-09T10:00:00.000Z",
    confirmationId: "claim_confirmation_section_experience_abc",
  };

  const syncWorkspace =
    vi.fn<
      (baseRevision: number | null) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const getWorkspace =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const setResumeClaimConfirmation =
    vi.fn<
      (
        input: JobFinderSetResumeClaimConfirmationInput,
      ) => Promise<JobFinderRendererWorkspaceSnapshot>
    >();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        ping: vi.fn(() => Promise.resolve({ platform: "win32" as const })),
        jobFinder: {
          syncWorkspace,
          getWorkspace,
          setResumeClaimConfirmation,
        },
      } as unknown as Window["nestor"],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nestor");
  });

  function snapshotSyncResult(
    snapshot: JobFinderRendererWorkspaceSnapshot,
    currentRevision = 1,
  ): JobFinderWorkspaceSyncResult {
    return { kind: "snapshot", currentRevision, reason: "initial", snapshot };
  }

  it("forwards the typed command and commits the returned snapshot", async () => {
    const initial = createWorkspace("job_1");
    const committed = createWorkspace("job_1", "2026-08-09T10:05:00.000Z");
    syncWorkspace.mockResolvedValueOnce(snapshotSyncResult(initial));
    setResumeClaimConfirmation.mockResolvedValueOnce(committed);

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(
        requireReadyWorkspace(
          result.current,
        ).actions.setResumeClaimConfirmation(removeCommand),
      ).resolves.toBe(committed);
    });

    expect(setResumeClaimConfirmation).toHaveBeenCalledOnce();
    expect(setResumeClaimConfirmation).toHaveBeenCalledWith(removeCommand);
    if (result.current.status === "ready") {
      expect(result.current.workspace).toBe(committed);
    }
  });

  it("never lets a stale claim-confirmation response overwrite a newer commit", async () => {
    const initial = createWorkspace("job_1");
    const newer = createWorkspace("job_1", "2026-08-09T10:06:00.000Z");
    const staleResponse = deferred<JobFinderRendererWorkspaceSnapshot>();
    syncWorkspace
      .mockResolvedValueOnce(snapshotSyncResult(initial))
      .mockResolvedValueOnce(snapshotSyncResult(newer, 2));
    setResumeClaimConfirmation
      .mockReturnValueOnce(staleResponse.promise)
      .mockResolvedValueOnce(newer);

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let staleAction!: Promise<unknown>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      staleAction =
        result.current.actions.setResumeClaimConfirmation(removeCommand);
    });

    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready workspace.");
      }
      await result.current.actions.setResumeClaimConfirmation(removeCommand);
    });

    if (result.current.status !== "ready") {
      throw new Error("Expected a ready workspace.");
    }
    // The newest request already owns the sequence and committed its snapshot.
    expect(result.current.workspace).toBe(newer);

    act(() => {
      staleResponse.resolve(
        createWorkspace("job_1", "2026-08-09T10:03:00.000Z"),
      );
    });
    await staleAction;

    // The fenced stale response schedules one authoritative convergence fetch
    // instead of committing over the newer workspace.
    await waitFor(() => expect(syncWorkspace).toHaveBeenCalledTimes(2));
    await act(async () => {});
    if (result.current.status === "ready") {
      expect(result.current.workspace).toBe(newer);
    }
  });
});
