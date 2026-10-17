// @vitest-environment jsdom

import {
  createFreshStartCandidateProfile,
  DiscoveryJobViewSchema,
  getDefaultCampaignConfiguration,
  JobFinderResumeWorkspaceSchema,
  JobFinderSettingsSchema,
  JobFinderRendererWorkspaceSnapshotSchema,
  JobSearchCampaignSchema,
  JobSearchPreferencesSchema,
  ResumeDraftSchema,
} from "@nestor/contracts";
import type {
  JobFinderResumeWorkspace,
  JobFinderRendererWorkspaceSnapshot,
  ResumeAssistantMessage,
} from "@nestor/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { useJobFinderPageController } from "./use-job-finder-page-controller";

type ResumeWorkspaceRequest = {
  jobId: string;
  reject: (error: unknown) => void;
  resolve: (workspace: JobFinderResumeWorkspace) => void;
};

type ResumeAssistantRequest = {
  content: string;
  jobId: string;
  resolve: (messages: readonly ResumeAssistantMessage[]) => void;
};

function createReviewQueueItem(jobId: string) {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    matchScore: 80,
    applicationStatus: "shortlisted",
    assetStatus: "not_started",
    progressPercent: null,
    resumeAssetId: null,
    resumeApplicationMode: "tailored_per_job",
    resumeReview: { status: "not_started" },
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function createBaseSnapshot(): JobFinderRendererWorkspaceSnapshot {
  const generatedAt = "2026-08-20T00:00:00.000Z";
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
    discovery: { historyLimit: 5, targets: [] },
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
    jobIds: ["job_1", "job_2", "job_3"],
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
    reviewQueue: [
      createReviewQueueItem("job_1"),
      createReviewQueueItem("job_2"),
      createReviewQueueItem("job_3"),
    ],
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
      sourceHealth: { healthy: 0, needsAttention: 0, running: 0, total: 0 },
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

function createWorkspace(): JobFinderRendererWorkspaceSnapshot {
  return createBaseSnapshot();
}

type TestResumeWorkspace = JobFinderResumeWorkspace & { marker: string };

function createResumeWorkspace(
  jobId: string,
  marker: string,
): TestResumeWorkspace {
  const job = DiscoveryJobViewSchema.parse({
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
    discoveredAt: "2026-08-20T00:00:00.000Z",
    salaryText: null,
    description: `Description for ${jobId}`,
    status: "discovered",
    matchAssessment: { score: 80, reasons: [], gaps: [] },
    listingActivity: { status: "unknown" },
  });
  const draft = ResumeDraftSchema.parse({
    id: `draft_${jobId}`,
    jobId,
    status: "draft",
    templateId: "classic_ats",
    sections: [],
    targetPageCount: 2,
    generationMethod: null,
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    workHistoryReviewAcknowledgments: [],
    claimConfirmations: [],
    issueApprovals: [],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  const workspace = JobFinderResumeWorkspaceSchema.parse({
    job,
    draft,
    validation: null,
    exports: [],
    research: [],
    assistantMessages: [],
    revisions: [],
    tailoredAsset: null,
    sharedProfile: {},
    workHistoryReviewSuggestions: [],
    strategyContext: null,
  });
  return { ...workspace, marker };
}

function activeResumeWorkspaceMarker(
  controller: ReturnType<typeof useJobFinderPageController>,
): string | null {
  const context = controller.context;
  if (!context) {
    throw new Error("Expected an assembled Job Finder page context.");
  }
  const workspace = context.resumeWorkspace as TestResumeWorkspace | null;
  return workspace?.marker ?? null;
}

async function flushTurns(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

// The data router constructs a real fetch Request for every navigation.
// jsdom's AbortSignal fails Node's brand check inside the Request constructor,
// so hand React Router a stub with the tiny request surface it reads (url,
// method, signal).
class NavigationRequestStub {
  method: string;
  signal: unknown;
  url: string;

  constructor(
    input: string | URL,
    init?: { method?: string; signal?: unknown },
  ) {
    this.url = String(input);
    this.method = (init?.method ?? "GET").toUpperCase();
    this.signal = init?.signal ?? null;
  }
}

beforeAll(() => {
  vi.stubGlobal("Request", NavigationRequestStub);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function requireController(harness: {
  current: ReturnType<typeof useJobFinderPageController> | null;
}): ReturnType<typeof useJobFinderPageController> {
  const controller = harness.current;
  if (!controller) {
    throw new Error("Expected mounted Job Finder page controller.");
  }
  return controller;
}

function requireControllerContext(harness: {
  current: ReturnType<typeof useJobFinderPageController> | null;
}): NonNullable<ReturnType<typeof useJobFinderPageController>["context"]> {
  const controller = requireController(harness);
  const context = controller.context;
  if (!context) {
    throw new Error("Expected an assembled Job Finder page context.");
  }
  return context;
}

describe("useJobFinderPageController resume-workspace mount loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "nestor");
  });

  function createMountHarness() {
    const workspace = createWorkspace();
    const pendingRequests: ResumeWorkspaceRequest[] = [];
    const pendingAssistantRequests: ResumeAssistantRequest[] = [];

    const getResumeWorkspace = vi.fn(
      (jobId: string) =>
        new Promise<JobFinderResumeWorkspace>((resolve, reject) => {
          pendingRequests.push({ jobId, reject, resolve });
        }),
    );
    const sendResumeAssistantMessage = vi.fn(
      (jobId: string, content: string) =>
        new Promise<readonly ResumeAssistantMessage[]>((resolve) => {
          pendingAssistantRequests.push({ content, jobId, resolve });
        }),
    );

    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        ping: vi.fn(() => Promise.resolve({ platform: "darwin" as const })),
        jobFinder: {
          getWorkspaceBootstrap: vi.fn(() => Promise.resolve(workspace)),
          getResumeWorkspace,
          sendResumeAssistantMessage,
        },
      } as unknown as Window["nestor"],
    });

    type Controller = ReturnType<typeof useJobFinderPageController>;
    const mounted: { current: Controller | null } = { current: null };

    function ControllerProbe() {
      mounted.current = useJobFinderPageController();
      return null;
    }

    const router = createMemoryRouter(
      [{ path: "*", element: <ControllerProbe /> }],
      { initialEntries: ["/job-finder/review-queue/job_1/resume"] },
    );

    const view = render(<RouterProvider router={router} />);

    return {
      router,
      getResumeWorkspace,
      sendResumeAssistantMessage,
      get current() {
        return mounted.current;
      },
      unmount: view.unmount,
      // Answers the OLDEST parked request.
      respondOldest(jobId: string, marker: string) {
        const request = pendingRequests.shift();
        if (!request) {
          throw new Error("No parked resume-workspace request to answer.");
        }
        const answeredJobId = request.jobId;
        request.resolve(createResumeWorkspace(jobId, marker));
        return answeredJobId;
      },
      // Answers the NEWEST parked request (the latest fetch the controller
      // dispatched).
      respondLatest(jobId: string, marker: string) {
        const request = pendingRequests.pop();
        if (!request) {
          throw new Error("No parked resume-workspace request to answer.");
        }
        const answeredJobId = request.jobId;
        request.resolve(createResumeWorkspace(jobId, marker));
        return answeredJobId;
      },
      // Fails the OLDEST parked request.
      rejectOldest(error: unknown) {
        const request = pendingRequests.shift();
        if (!request) {
          throw new Error("No parked resume-workspace request to fail.");
        }
        request.reject(error);
        return request.jobId;
      },
      respondAssistant(messages: readonly ResumeAssistantMessage[]) {
        const request = pendingAssistantRequests.shift();
        if (!request) {
          throw new Error("No parked resume-assistant request to answer.");
        }
        request.resolve(messages);
        return request;
      },
    };
  }

  it("issues exactly one authoritative fetch per resume-workspace navigation", async () => {
    const harness = createMountHarness();

    await waitFor(() =>
      expect(requireController(harness).workspaceState.status).toBe("ready"),
    );
    expect(harness.getResumeWorkspace).toHaveBeenCalledTimes(1);
    expect(harness.getResumeWorkspace.mock.calls[0]?.[0]).toBe("job_1");

    act(() => {
      harness.respondOldest("job_1", "mount-v1");
    });

    await waitFor(() =>
      expect(activeResumeWorkspaceMarker(requireController(harness))).toBe(
        "mount-v1",
      ),
    );
    // The removed duplicate effect used to fire a second identical load.
    expect(harness.getResumeWorkspace).toHaveBeenCalledTimes(1);

    harness.unmount();
  });

  it("never lets an older parked mount response overwrite a newer refresh", async () => {
    const harness = createMountHarness();

    await waitFor(() =>
      expect(requireController(harness).workspaceState.status).toBe("ready"),
    );

    // The job_1 mount load stays parked while an explicit reload runs and
    // commits newer state through the same shared token fence.
    act(() => {
      void requireControllerContext(harness).onRefreshResumeWorkspace("job_1");
    });
    await waitFor(() =>
      expect(harness.getResumeWorkspace).toHaveBeenCalledTimes(2),
    );

    expect(harness.respondLatest("job_1", "reload-v2")).toBe("job_1");
    await waitFor(() =>
      expect(activeResumeWorkspaceMarker(requireController(harness))).toBe(
        "reload-v2",
      ),
    );

    // The original stale mount response settles last; the request token must
    // discard it instead of rolling the editor back.
    expect(harness.respondOldest("job_1", "stale-mount-v0")).toBe("job_1");
    await flushTurns();

    expect(activeResumeWorkspaceMarker(requireController(harness))).toBe(
      "reload-v2",
    );

    harness.unmount();
  });

  it("retires a pending assistant request when reloading and ignores its late reply", async () => {
    const harness = createMountHarness();

    await waitFor(() =>
      expect(requireController(harness).workspaceState.status).toBe("ready"),
    );
    expect(harness.respondOldest("job_1", "mount-v1")).toBe("job_1");
    await waitFor(() =>
      expect(activeResumeWorkspaceMarker(requireController(harness))).toBe(
        "mount-v1",
      ),
    );

    act(() => {
      requireControllerContext(harness).onSendResumeAssistantMessage(
        "job_1",
        "Tighten the summary using only the evidence already present",
      );
    });
    await waitFor(() =>
      expect(harness.sendResumeAssistantMessage).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(requireControllerContext(harness).resumeAssistantPending).toBe(
        true,
      ),
    );

    act(() => {
      requireControllerContext(harness).onRefreshResumeWorkspace("job_1");
    });
    await waitFor(() =>
      expect(harness.getResumeWorkspace).toHaveBeenCalledTimes(2),
    );
    expect(harness.respondLatest("job_1", "reload-v2")).toBe("job_1");
    await waitFor(() =>
      expect(activeResumeWorkspaceMarker(requireController(harness))).toBe(
        "reload-v2",
      ),
    );
    expect(requireControllerContext(harness).resumeAssistantPending).toBe(
      false,
    );
    expect(requireControllerContext(harness).resumeAssistantMessages).toEqual(
      [],
    );

    const lateReply: ResumeAssistantMessage = {
      id: "assistant_late_reply",
      jobId: "job_1",
      role: "assistant",
      content: "A late reply that must not replace the reloaded workspace.",
      patches: [],
      proposalStatus: "none",
      baseDraftUpdatedAt: null,
      resolvedPatchIds: [],
      resolvedAt: null,
      proposalError: null,
      createdAt: "2026-08-20T00:01:00.000Z",
    };
    act(() => {
      harness.respondAssistant([lateReply]);
    });
    await flushTurns();

    expect(requireControllerContext(harness).resumeAssistantPending).toBe(
      false,
    );
    expect(requireControllerContext(harness).resumeAssistantMessages).toEqual(
      [],
    );

    harness.unmount();
  });

  it("keeps a late mount response from crossing an out-and-back navigation", async () => {
    const harness = createMountHarness();

    await waitFor(() =>
      expect(requireController(harness).workspaceState.status).toBe("ready"),
    );

    await act(async () => {
      await harness.router.navigate("/job-finder/review-queue/job_2/resume");
    });
    await waitFor(() =>
      expect(harness.getResumeWorkspace).toHaveBeenCalledTimes(2),
    );
    expect(harness.respondLatest("job_2", "v-job_2")).toBe("job_2");
    await waitFor(() => {
      const context = requireControllerContext(harness);
      expect(context.resumeWorkspace?.job.id).toBe("job_2");
    });

    await act(async () => {
      await harness.router.navigate("/job-finder/review-queue/job_1/resume");
    });
    await waitFor(() =>
      expect(harness.getResumeWorkspace).toHaveBeenCalledTimes(3),
    );
    expect(harness.respondLatest("job_1", "v-job_1-late")).toBe("job_1");
    await waitFor(() =>
      expect(activeResumeWorkspaceMarker(requireController(harness))).toBe(
        "v-job_1-late",
      ),
    );

    // The very first parked job_1 mount response settles after the fresh
    // navigation fetch and must not win.
    expect(harness.respondOldest("job_1", "stale-first-load")).toBe("job_1");
    await flushTurns();

    expect(activeResumeWorkspaceMarker(requireController(harness))).toBe(
      "v-job_1-late",
    );

    harness.unmount();
  });

  it("keeps the owned unavailable state when the IPC layer wraps an unknown-job failure", async () => {
    const harness = createMountHarness();

    await waitFor(() =>
      expect(requireController(harness).workspaceState.status).toBe("ready"),
    );

    await act(async () => {
      harness.rejectOldest(
        new Error(
          "Error invoking remote method 'job-finder:get-resume-workspace': Error: Unknown Job Finder job 'job_target_site_2776321'.",
        ),
      );
      await flushTurns();
    });

    // The route owns the "Resume no longer available" screen, so the
    // controller must neither bounce nor publish a message.
    expect(requireControllerContext(harness).actionState.message).toBeNull();
    expect(harness.router.state.location.pathname).toBe(
      "/job-finder/review-queue/job_1/resume",
    );

    harness.unmount();
  });

  it("never puts a raw IPC failure string on screen when the workspace cannot load", async () => {
    const harness = createMountHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await waitFor(() =>
      expect(requireController(harness).workspaceState.status).toBe("ready"),
    );

    await act(async () => {
      harness.rejectOldest(
        new Error(
          "Error invoking remote method 'job-finder:get-resume-workspace': Error: SQLITE_BUSY",
        ),
      );
      await flushTurns();
    });

    const message = requireControllerContext(harness).actionState.message;
    expect(message).toContain("We couldn’t open the resume editor");
    expect(message).not.toContain("job-finder:get-resume-workspace");
    expect(message).not.toContain("SQLITE_BUSY");
    expect(logged).toHaveBeenCalled();

    logged.mockRestore();
    harness.unmount();
  });

  it("discards a mount response that settles after unmount without crashing", async () => {
    const harness = createMountHarness();

    await waitFor(() =>
      expect(requireController(harness).workspaceState.status).toBe("ready"),
    );
    expect(harness.getResumeWorkspace).toHaveBeenCalledTimes(1);

    harness.unmount();

    expect(() => {
      harness.respondOldest("job_1", "post-unmount-v1");
    }).not.toThrow();
    await flushTurns();
  });
});
