import { buildResumeWorkspaceRoute } from "../../lib/resume-workspace-route";
import type {
  JobFinderRendererWorkspaceSnapshot,
  ReviewQueueItem,
} from "@nestor/contracts";
import {
  AbnormalFailurePauseSchema,
  ApplicationRecordSchema,
  createFreshStartCandidateProfile,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { buildJobFinderTaskCenterModel } from "../../components/task-center/job-finder-task-center-model";
import { countNeedsYou } from "../../lib/destination-counts";
import {
  buildInterruptedSearchRetryRequest,
  buildJobSearchHomeModel,
  type BuildJobSearchHomeModelInput,
} from "./job-search-home-model";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");

function workspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    activeCampaignId: "campaign-1",
    activityControl: { paused: false, pausedAt: null, reason: null },
    activeDiscoveryRun: null,
    activeSourceDebugRun: null,
    applicationRecords: [],
    applyJobResults: [],
    applyRuns: [],
    campaignNotifications: [],
    campaigns: [
      {
        id: "campaign-1",
        name: "Remote TypeScript",
        status: "active",
        jobIds: [],
        history: [],
      },
    ],
    dashboard: {
      activeCampaignCount: 1,
      activeCampaignId: "campaign-1",
      applicationsAppliedThisWeek: 0,
      applicationsAppliedToday: 0,
      applicationsReadyForApproval: 0,
      backgroundOperationCount: 0,
      generatedAt: "2026-08-15T09:00:00.000Z",
      interviewRate: null,
      jobsAwaitingReview: 0,
      jobsFoundToday: 0,
      needsYouCount: 0,
      recommendedNextAction: {
        detail: "Run the active search plan to collect relevant openings.",
        label: "Find jobs",
        route: "/job-finder/discovery",
      },
      responseRate: null,
      sourceHealth: { healthy: 1, needsAttention: 0, running: 0, total: 1 },
      upcomingFollowUps: 0,
      upcomingInterviews: 0,
    },
    discoveryJobs: [],
    recentDiscoveryRuns: [],
    recentSourceDebugRuns: [],
    reviewQueue: [],
    searchPreferences: {
      discovery: {
        targets: [
          {
            id: "target-1",
            label: "Replica board",
            url: "http://127.0.0.1:47950/board/",
            enabled: true,
          },
        ],
        historyLimit: 5,
      },
    },
    settings: {},
    profileSetupState: {
      status: "completed",
      currentStep: "ready_check",
      completedAt: "2026-08-15T08:00:00.000Z",
      reviewItems: [],
      lastResumedAt: "2026-08-15T08:00:00.000Z",
    },
    resumeExportArtifacts: [],
    tailoredAssets: [],
    userActionRequests: [],
    latestResumeImportRun: null,
    intelligence: {
      groupedDecisions: [],
      safeguards: {
        companyApplicationCaps: [],
        simultaneousApplicationConflicts: [],
        listingSignals: [],
        abnormalFailurePauses: [],
        preparedBatchSampleReviews: [],
        contradictoryAnswerDetections: [],
        safeguardDismissals: [],
        updatedAt: null,
      },
      companies: [],
      outcomeEvents: [],
      resumeStrategies: [],
      resumeStrategySelections: [],
      rapidReviewLogs: [],
      outcomeAnalytics: null,
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function completedRun(counts: { found: number; new: number }) {
  return {
    id: "run-1",
    state: "completed",
    runPhase: null,
    startedAt: "2026-08-15T09:30:00.000Z",
    completedAt: "2026-08-15T09:40:00.000Z",
    targetIds: ["target-1"],
    activity: [],
    targetExecutions: [],
    summary: {
      validJobsFound: counts.new,
      duplicatesMerged: 0,
      targetsPlanned: 1,
      targetsCompleted: 1,
      durationMs: 600_000,
      report: {
        found: counts.found,
        new: counts.new,
        kept: counts.new,
        alreadyHere: 0,
      },
    },
  };
}

function withJobs(
  base: JobFinderRendererWorkspaceSnapshot,
  count: number,
  options: { weaker?: number } = {},
): JobFinderRendererWorkspaceSnapshot {
  const weaker = options.weaker ?? 0;
  const ids = Array.from({ length: count + weaker }, (_u, i) => `job_${i}`);
  return {
    ...base,
    campaigns: base.campaigns.map((campaign) => ({ ...campaign, jobIds: ids })),
    discoveryJobs: ids.map((id, index) => ({
      id,
      title: `Job ${index}`,
      company: "Employer",
      discoveryMethod: "browser_agent",
      matchAssessment: {
        score: index < count ? 70 : 10,
        judgment: {
          source: "batch",
          judgedAt: "2026-10-02T10:00:00.000Z",
          score: index < count ? 70 : 10,
          recommendation: "review_before_applying",
        },
        recommendation: index < count ? "apply" : "consider",
        dimensions: {
          roleSuitability: { state: "exact" },
          evidenceConfidence: { level: "high" },
        },
        contextFingerprint: "ctx",
        postingFingerprint: "post",
      },
    })),
    recentDiscoveryRuns: [
      completedRun({ found: count + weaker, new: count + weaker }),
    ],
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function queueItem(
  jobId: string,
  overrides: Partial<ReviewQueueItem> = {},
): ReviewQueueItem {
  return {
    jobId,
    title: `Job ${jobId}`,
    company: "Employer",
    location: "Remote",
    matchScore: 70,
    applicationStatus: "drafting",
    assetStatus: "not_started",
    progressPercent: null,
    resumeAssetId: null,
    resumeApplicationMode: "tailored_per_job",
    resumeTailoringMode: null,
    resumeReview: { status: "not_started" },
    updatedAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  } as ReviewQueueItem;
}

function withShortlist(
  base: JobFinderRendererWorkspaceSnapshot,
  items: readonly ReviewQueueItem[],
): JobFinderRendererWorkspaceSnapshot {
  const ids = new Set([
    ...base.campaigns.flatMap((campaign) => campaign.jobIds),
    ...items.map((item) => item.jobId),
  ]);
  return {
    ...base,
    campaigns: base.campaigns.map((campaign) => ({
      ...campaign,
      jobIds: [...ids],
    })),
    reviewQueue: items,
  } as JobFinderRendererWorkspaceSnapshot;
}

function withDailyPreparationRemaining(
  base: JobFinderRendererWorkspaceSnapshot,
  remaining: number,
): JobFinderRendererWorkspaceSnapshot {
  return {
    ...base,
    dashboard: {
      ...base.dashboard,
      globalDailyApplicationPreparationCapacity: {
        limit: 20,
        used: 20 - remaining,
        legacyUncertain: 0,
        remaining,
        localDate: "2026-08-15",
        resetsAt: "2026-08-16T00:00:00.000Z",
      },
    },
  } as JobFinderRendererWorkspaceSnapshot;
}

function build(
  ws: JobFinderRendererWorkspaceSnapshot,
  overrides: Partial<BuildJobSearchHomeModelInput> = {},
) {
  return buildJobSearchHomeModel({
    workspace: ws,
    tasks: buildJobFinderTaskCenterModel({
      workspace: ws,
      isDiscoveryPending: false,
      isResumeImportPending: false,
      now: NOW,
      ...(overrides.tasks ? {} : {}),
    }),
    discoveryRunPending: false,
    canRunDiscovery: true,
    applicationAutomationMode: "prepare_only",
    now: NOW,
    ...overrides,
  });
}

describe("buildJobSearchHomeModel · before the first search", () => {
  it("sends a brand-new workspace to setup and shows no pipeline", () => {
    const ws = workspace();
    ws.profileSetupState = {
      ...ws.profileSetupState,
      status: "not_started",
      currentStep: "import",
      completedAt: null,
    };
    const model = build(ws);
    expect(model.next.id).toBe("setup");
    expect(model.next.primary).toEqual({
      label: "Start setup",
      action: { kind: "navigate", route: "/job-finder/profile/setup" },
    });
    expect(model.stages).toBeNull();
    expect(model.statusLine).toContain("Set up your profile");
  });

  it("names the step a half-finished setup resumes at", () => {
    const ws = workspace();
    ws.profileSetupState = {
      ...ws.profileSetupState,
      status: "in_progress",
      currentStep: "targeting",
      completedAt: null,
    };
    const model = build(ws);
    expect(model.next.id).toBe("setup");
    expect(model.next.title).toBe("Finish setting up");
    expect(model.next.detail).toContain("your job targets");
    expect(model.next.primary.label).toBe("Continue setup");
  });

  it("names the required job target gap when import leaves setup on optional Extras", () => {
    const ws = workspace();
    ws.profileSetupState = {
      ...ws.profileSetupState,
      status: "in_progress",
      currentStep: "extras",
      completedAt: null,
    };
    ws.profile = {
      ...createFreshStartCandidateProfile(),
      id: "synthetic-jamie",
      fullName: "Jamie Rivers",
      email: "jamie@example.test",
      baseResume: {
        ...createFreshStartCandidateProfile().baseResume,
        textContent: "Synthetic frontend engineering work",
      },
      targetRoles: ["Frontend Engineer"],
    };
    ws.searchPreferences.discovery.targets = [];
    const model = build(ws);
    expect(model.next.id).toBe("setup");
    expect(model.next.detail).toContain("Add a job source in your job targets");
    expect(model.next.detail).not.toContain("optional extras");
    expect(model.next.primary.action).toEqual({
      kind: "resume_setup",
      step: "targeting",
    });
  });

  it("asks for a job source when none is saved, and to turn one on when all are off", () => {
    const none = workspace();
    none.searchPreferences.discovery.targets = [];
    expect(build(none).next).toMatchObject({
      id: "sources",
      title: "Add a job source",
    });
    expect(build(none).statusLine).toBe(
      "No job source added yet, so nothing can be searched.",
    );

    const off = workspace();
    off.searchPreferences.discovery.targets = [
      { ...off.searchPreferences.discovery.targets[0]!, enabled: false },
    ];
    const model = build(off);
    expect(model.next).toMatchObject({
      id: "sources",
      title: "Turn on a job source",
    });
    expect(model.next.primary.action).toEqual({
      kind: "navigate",
      route:
        "/job-finder/profile?section=sources&focus=job-sources#profile-job-sources",
    });
    expect(model.statusLine).toContain("No job source is turned on");
  });

  it("offers the first search in place once a source is on", () => {
    const model = build(workspace());
    expect(model.next.id).toBe("first_search");
    expect(model.next.primary).toEqual({
      label: "Search now",
      action: { kind: "run_search" },
    });
    expect(model.stages).toBeNull();
    expect(model.now).toEqual([]);
    expect(model.statusLine).toBe(
      "Ready to search 1 source. Nothing has been searched yet.",
    );
  });

  it("falls back to opening Find jobs when Home cannot run the search itself", () => {
    const model = build(workspace(), { canRunDiscovery: false });
    expect(model.next.primary).toEqual({
      label: "Open Find jobs",
      action: { kind: "navigate", route: "/job-finder/discovery" },
    });
  });
});

describe("buildJobSearchHomeModel · while something runs", () => {
  it("shows a running search under Happening now with Stop, and tells the person to wait", () => {
    const ws = workspace();
    ws.activeDiscoveryRun = {
      id: "run-live",
      state: "running",
      runPhase: null,
      startedAt: "2026-08-15T11:58:00.000Z",
      completedAt: null,
      targetIds: ["target-1"],
      activity: [
        {
          runId: "run-live",
          stage: "extraction",
          targetId: "target-1",
          message: "Reading listings",
          at: "2026-08-15T11:59:00.000Z",
        },
      ],
      targetExecutions: [],
      summary: { targetsPlanned: 1, targetsCompleted: 0 },
    } as unknown as JobFinderRendererWorkspaceSnapshot["activeDiscoveryRun"];
    const model = build(ws);
    expect(model.now).toHaveLength(1);
    expect(model.now[0]).toMatchObject({
      title: "Searching Replica board",
      stop: {
        label: "Stop",
        action: { kind: "stop_search", runId: "run-live" },
      },
    });
    expect(model.next.id).toBe("wait_search");
    expect(model.statusLine.startsWith("Searching Replica board · ")).toBe(
      true,
    );
  });

  it("shows a search that was just requested before the run is recorded", () => {
    const model = build(workspace(), { discoveryRunPending: true });
    expect(model.now[0]?.title).toBe("Starting the search");
    expect(model.next.id).toBe("wait_search");
  });

  it("shows resume writing with a stop, and never recommends creating the same resumes again", () => {
    const ws = withShortlist(withJobs(workspace(), 3), [
      queueItem("job_0", { assetStatus: "generating" }),
      queueItem("job_1"),
      queueItem("job_2"),
    ]);
    const tasks = buildJobFinderTaskCenterModel({
      workspace: ws,
      isDiscoveryPending: false,
      isResumeImportPending: false,
      tailoredDraftPreparation: {
        attemptedCount: 1,
        completedCount: 0,
        currentIndex: 1,
        eligibleRemainingCount: 0,
        failedCount: 0,
        status: "running",
        totalCount: 3,
      },
      now: NOW,
    });
    const model = build(ws, { tasks });
    expect(model.now[0]).toMatchObject({
      title: "Writing resumes",
      stop: { action: { kind: "stop_resumes" } },
    });
    expect(model.next.id).toBe("wait_resumes");
    expect(model.stages?.[1]).toMatchObject({
      label: "Shortlisted",
      count: 3,
      // The running batch writes the two not started yet; they are not
      // waiting on the person.
      detail: "2 need a resume · 1 being written",
    });
  });

  it("shows an application run with Stop and says nothing is needed", () => {
    const ws = withShortlist(withJobs(workspace(), 1), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: {
          status: "needs_review",
        } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    ws.applicationRecords = [
      {
        id: "record-0",
        jobId: "job_0",
        title: "Job job_0",
        company: "Employer",
        status: "drafting",
        lastAttemptState: "in_progress",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "Filling in",
        lastUpdatedAt: "2026-08-15T11:59:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyRuns = [
      {
        id: "apply-1",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_0"],
        currentJobId: "job_0",
        createdAt: "2026-08-15T11:58:00.000Z",
        updatedAt: "2026-08-15T11:59:00.000Z",
        completedAt: null,
        summary: "Applying",
        detail: "Applying",
        totalJobs: 1,
        pendingJobs: 1,
        submittedJobs: 0,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 0,
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyRuns"];
    const model = build(ws);
    expect(model.now[0]).toMatchObject({
      title: "Applying: Employer · Job 0",
      stop: { action: { kind: "stop_apply", runId: "apply-1" } },
    });
    expect(model.next.id).toBe("wait_apply");
    expect(model.stages?.[2]).toMatchObject({
      label: "Applications",
      count: 1,
      detail: "1 filling in",
    });
    // The job is in Applications now, so Shortlisted does not offer it again.
    expect(model.stages?.[1]?.detail).toBe("1 in Applications");
  });

  it("says a job waiting for a free browser tab is waiting, not being worked on", () => {
    const ws = withJobs(workspace(), 1);
    ws.applyRuns = [
      {
        id: "apply-1",
        mode: "queue_auto",
        state: "running",
        jobIds: ["job_0"],
        currentJobId: "job_0",
        createdAt: "2026-08-15T11:58:00.000Z",
        updatedAt: "2026-08-15T11:59:00.000Z",
        completedAt: null,
        summary: "Applying",
        detail: "Applying",
        totalJobs: 1,
        pendingJobs: 1,
        submittedJobs: 0,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 0,
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyRuns"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: null,
        state: "filling",
        summary: "Waiting for a free browser tab",
        startedAt: "2026-08-15T11:58:30.000Z",
        updatedAt: "2026-08-15T11:59:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    const model = build(ws);
    expect(model.now[0]).toMatchObject({
      title: "Waiting to apply: Employer · Job 0",
    });
    expect(model.now[0]?.detail).toContain("Browser tab limit reached");
    expect(model.now[0]?.detail).toContain("prepared, unsent forms stay open");
  });

  it("reports a paused workspace before anything else", () => {
    const ws = workspace();
    ws.activityControl = {
      paused: true,
      pausedAt: "2026-08-15T11:00:00.000Z",
      reason: "Paused by you.",
    };
    const model = build(ws);
    expect(model.paused).toBe(true);
    expect(model.statusLine.startsWith("Paused.")).toBe(true);
    expect(model.next).toMatchObject({
      id: "paused",
      primary: { label: "Resume", action: { kind: "resume_activity" } },
    });
  });
});

describe("buildJobSearchHomeModel · after a search", () => {
  it("asks the person to look through what the search found", () => {
    const ws = withJobs(workspace(), 10);
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "look_through",
      title: "Look through 10 jobs",
      primary: {
        label: "Open Find jobs",
        action: { kind: "navigate", route: "/job-finder/discovery" },
      },
    });
    expect(model.next.secondary[0]?.label).toBe("Search again");
    expect(model.statusLine).toBe(
      "Last search finished 2 hours ago · 10 new jobs.",
    );
    expect(model.stages?.map((stage) => stage.count)).toEqual([10, 0, 0]);
  });

  it("names the source when the newest search covered only one of several", () => {
    const ws = withJobs(workspace(), 10);
    ws.searchPreferences.discovery.targets = [
      ...ws.searchPreferences.discovery.targets,
      {
        id: "target-2",
        label: "Sign-in board",
        url: "http://localhost:47950/authboard/",
        enabled: true,
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["searchPreferences"]["discovery"]["targets"];
    ws.recentDiscoveryRuns = [
      {
        ...ws.recentDiscoveryRuns[0]!,
        scope: "single_target",
        targetIds: ["target-2"],
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["recentDiscoveryRuns"];
    const model = build(ws);
    expect(model.statusLine).toBe(
      "Last search of Sign-in board finished 2 hours ago · 10 new jobs.",
    );
  });

  it("counts exactly the rows Find jobs lists and names the hidden weaker matches", () => {
    const ws = withJobs(workspace(), 9, { weaker: 1 });
    const model = build(ws);
    expect(model.stages?.[0]).toMatchObject({
      label: "Find jobs",
      count: 9,
      detail: "+ 1 weaker",
    });
    expect(model.next.title).toBe("Look through 9 jobs");
  });

  it("says when a search found nothing and offers the two ways out", () => {
    const ws = workspace();
    ws.recentDiscoveryRuns = [
      completedRun({ found: 0, new: 0 }),
    ] as unknown as JobFinderRendererWorkspaceSnapshot["recentDiscoveryRuns"];
    const model = build(ws);
    expect(model.next.id).toBe("nothing_found");
    expect(model.next.primary).toEqual({
      label: "Search again",
      action: { kind: "run_search" },
    });
    expect(model.next.secondary[0]?.label).toBe("Open job sources");
    expect(model.statusLine).toBe("Last search finished 2 hours ago.");
  });

  it("retries an interrupted search on the sources still enabled", () => {
    const ws = workspace();
    ws.recentDiscoveryRuns = [
      {
        ...completedRun({ found: 0, new: 0 }),
        state: "cancelled",
        runPhase: "interrupted",
        searchIntent: "frontend",
        searchFreshness: "recent",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["recentDiscoveryRuns"];
    expect(buildInterruptedSearchRetryRequest(ws)).toEqual({
      intent: "frontend",
      freshness: "recent",
      sourceIds: ["target-1"],
    });
    const model = build(ws);
    expect(model.next.id).toBe("search_failed");
    expect(model.next.title).toBe("Your last search stopped early");
    expect(model.next.primary).toEqual({
      label: "Search again",
      action: {
        kind: "run_search",
        request: {
          intent: "frontend",
          freshness: "recent",
          sourceIds: ["target-1"],
        },
      },
    });
    expect(model.statusLine).toContain("stopped early");

    ws.searchPreferences.discovery.targets = [
      { ...ws.searchPreferences.discovery.targets[0]!, id: "target-2" },
    ];
    expect(buildInterruptedSearchRetryRequest(ws)).toBeNull();
    expect(build(ws).next.primary).toEqual({
      label: "Choose sources",
      action: { kind: "navigate", route: "/job-finder/discovery" },
    });
  });

  it("offers to run a failed search again", () => {
    const ws = workspace();
    ws.recentDiscoveryRuns = [
      { ...completedRun({ found: 0, new: 0 }), state: "failed" },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["recentDiscoveryRuns"];
    const model = build(ws);
    expect(model.next.id).toBe("search_failed");
    expect(model.next.title).toBe("Your last search failed");
    expect(model.statusLine).toBe("Last search failed 2 hours ago.");
  });

  it("flags a failing enabled source with the one place to fix it", () => {
    const ws = withJobs(workspace(), 2);
    ws.searchPreferences.discovery.targets = [
      {
        ...ws.searchPreferences.discovery.targets[0]!,
        staleReason: "connection_failed",
        lastVerifiedAt: "2026-08-15T09:00:00.000Z",
      } as unknown as JobFinderRendererWorkspaceSnapshot["searchPreferences"]["discovery"]["targets"][number],
    ];
    const model = build(ws);
    expect(model.problems).toHaveLength(1);
    // A quiet line hidden for good once dismissed, not a red alarm (issue
    // #50, ADR 0051). Its words and count are the Job sources filter's,
    // and its button opens that filter.
    expect(model.problems[0]).toMatchObject({
      id: "failing-sources",
      tone: null,
      text: "1 job source needs attention.",
      button: {
        label: "Open job sources",
        action: {
          kind: "navigate",
          route:
            "/job-finder/profile?section=sources&focus=job-sources&show=needs_attention#profile-job-sources",
        },
      },
      dismissKey: "dismissed",
    });
    // A broken source is a warning, not the next step, while work remains.
    expect(model.next.id).toBe("look_through");
  });
});

describe("buildJobSearchHomeModel · shortlist and applications", () => {
  it("counts each shortlisted job once, the way Shortlisted's tabs do", () => {
    // A failed Aggressive resume keeps its old asset id: it needs a resume,
    // not a review. The tile used to say "2 need a resume · 2 to review" for
    // three jobs beside a "To review 1" tab.
    const failed = (id: string) =>
      queueItem(id, {
        assetStatus: "failed",
        resumeAssetId: `asset-${id}`,
        resumeTailoringMode: "aggressive",
      });
    const toReview = queueItem("job_review", {
      assetStatus: "ready",
      resumeAssetId: "asset-job_review",
      resumeTailoringMode: "aggressive",
      resumeReview: {
        status: "needs_review",
      } as ReviewQueueItem["resumeReview"],
    });
    const ws = withShortlist(withJobs(workspace(), 5), [
      failed("job_0"),
      failed("job_1"),
      toReview,
    ]);
    expect(build(ws).stages?.[1]).toMatchObject({
      count: 3,
      detail: "2 need a resume · 1 to review",
    });
  });

  it("offers to create the missing resumes in place", () => {
    const ws = withShortlist(withJobs(workspace(), 5), [
      queueItem("job_0"),
      queueItem("job_1"),
      queueItem("job_2"),
    ]);
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "create_resumes",
      title: "Create 3 resumes",
      primary: {
        label: "Create 3 resumes",
        action: { kind: "create_resumes" },
      },
    });
    expect(model.stages?.[1]).toMatchObject({
      count: 3,
      detail: "3 need a resume",
    });
  });

  it("offers Apply to all once the resumes are ready, in the mode from Settings", () => {
    const ready = (id: string) =>
      queueItem(id, {
        assetStatus: "ready",
        resumeAssetId: `asset-${id}`,
        resumeReview: {
          status: "needs_review",
        } as ReviewQueueItem["resumeReview"],
      });
    const ws = withShortlist(withJobs(workspace(), 5), [
      ready("job_0"),
      ready("job_1"),
      queueItem("job_2"),
    ]);
    const model = build(ws, { applicationAutomationMode: "autonomous_submit" });
    expect(model.next).toMatchObject({
      id: "apply",
      title: "Apply to 2 ready jobs",
      primary: {
        label: "Apply to all 2",
        action: { kind: "apply_all", jobIds: ["job_0", "job_1"] },
      },
    });
    expect(model.next.detail).toContain("sends each application");
    // The saved mode is named, and changing it is one press away.
    expect(model.next.detailLink).toEqual({
      label: "Change how it applies",
      action: {
        kind: "navigate",
        route: "/job-finder/settings#settings-application-authority",
      },
    });
    expect(model.stages?.[1]?.detail).toBe(
      "1 need a resume · 2 ready to apply",
    );
  });

  it("asks for a review before applying with an Aggressive resume", () => {
    const ws = withShortlist(withJobs(workspace(), 2), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeTailoringMode: "aggressive",
        resumeReview: {
          status: "needs_review",
        } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    const model = build(ws);
    // One resume to read: the press opens that resume, not the list.
    expect(model.next).toMatchObject({
      id: "review_resumes",
      title: "Review the resume",
      primary: {
        label: "Review the resume",
        action: {
          kind: "navigate",
          route: "/job-finder/review-queue/job_0/resume",
        },
      },
    });
    expect(model.stages?.[1]?.detail).toBe("1 to review");
  });

  it("holds back a Tailored resume with a line to decide, names it, and still applies to the ready ones", () => {
    const ws = withShortlist(withJobs(workspace(), 3), [
      queueItem("job_0", {
        title: "Cedar Frontend Engineer",
        company: "Cedar",
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeTailoringMode: "balanced",
        resumeLinesToDecide: 1,
        resumeReview: {
          status: "needs_review",
        } as ReviewQueueItem["resumeReview"],
      }),
      queueItem("job_1", {
        assetStatus: "ready",
        resumeAssetId: "asset-1",
        resumeReview: {
          status: "needs_review",
        } as ReviewQueueItem["resumeReview"],
      }),
      queueItem("job_2", {
        assetStatus: "ready",
        resumeAssetId: "asset-2",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "review_resumes",
      title: "Review the resume",
      primary: {
        label: "Review the resume",
        action: {
          kind: "navigate",
          route: "/job-finder/review-queue/job_0/resume",
        },
      },
    });
    expect(model.next.detail).toContain(
      "A line in the resume for Cedar Frontend Engineer at Cedar is waiting for your decision.",
    );
    expect(model.next.detail).toContain(
      '"Apply to all 2" starts the others; Cedar Frontend Engineer waits for this.',
    );
    const apply = model.next.secondary.find(
      (button) => button.action.kind === "apply_all",
    );
    expect(apply?.label).toBe("Apply to all 2");
    expect(apply?.action).toEqual({
      kind: "apply_all",
      jobIds: ["job_1", "job_2"],
    });
  });

  it("keeps Create and Apply one press away beside an Aggressive review", () => {
    const ws = withShortlist(withJobs(workspace(), 3), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeTailoringMode: "aggressive",
        resumeReview: {
          status: "needs_review",
        } as ReviewQueueItem["resumeReview"],
      }),
      queueItem("job_1"),
      queueItem("job_2", {
        assetStatus: "ready",
        resumeAssetId: "asset-2",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "review_resumes",
      title: "Review the resume",
    });
    expect(
      model.next.secondary.map((button) => button.label).slice(0, 2),
    ).toEqual(["Create the missing resume", "Apply to 1 ready job"]);
  });

  it("leads with Create when most shortlisted jobs still need a resume, with Apply beside it", () => {
    const ws = withShortlist(withJobs(workspace(), 5), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
      queueItem("job_1"),
      queueItem("job_2"),
      queueItem("job_3"),
      queueItem("job_4"),
    ]);
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "create_resumes",
      title: "Create 4 resumes",
      primary: { label: "Create 4 resumes", action: { kind: "create_resumes" } },
    });
    expect(model.next.secondary[0]).toMatchObject({
      label: "Apply to 1 ready job",
      action: { kind: "apply_all", jobIds: ["job_0"] },
    });
  });

  it("keeps Apply first when most jobs are ready, with Create in place beside it", () => {
    const ready = (id: string) =>
      queueItem(id, {
        assetStatus: "ready",
        resumeAssetId: `asset-${id}`,
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      });
    const ws = withShortlist(withJobs(workspace(), 3), [
      ready("job_0"),
      ready("job_1"),
      queueItem("job_2"),
    ]);
    const model = build(ws);
    expect(model.next).toMatchObject({ id: "apply", title: "Apply to 2 ready jobs" });
    expect(model.next.secondary[0]).toMatchObject({
      label: "Create the missing resume",
      action: { kind: "create_resumes" },
    });
  });

  it("sends the person to Applications when forms are filled in and ready to send", () => {
    const ws = withShortlist(withJobs(workspace(), 2), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: {
          status: "needs_review",
        } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    ws.applicationRecords = [
      {
        id: "record-0",
        jobId: "job_0",
        title: "Job 0",
        company: "Employer",
        status: "ready_for_review",
        lastAttemptState: "ready",
        automationMode: "prepare_only",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "Filled in",
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-0",
        state: "awaiting_review",
        blockerReason: null,
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "send",
      title: "Send 1 application",
      primary: {
        label: "Open Applications",
        action: { kind: "navigate", route: "/job-finder/applications" },
      },
    });
    expect(model.stages?.[2]).toMatchObject({
      count: 1,
      detail: "1 ready to send",
    });
    expect(model.stages?.[1]?.detail).toBe("1 in Applications");
    // Searching again stays one press for a returning person.
    expect(model.next.secondary.map((button) => button.label).slice(0, 2)).toEqual([
      "Search again",
    ]);
  });

  it("under Send for me, sends forms filled in earlier with one press", () => {
    const ws = withShortlist(withJobs(workspace(), 3), []);
    ws.applicationRecords = ["job_0", "job_1"].map((jobId, index) => ({
      id: `record-${index}`,
      jobId,
      title: `Job ${index}`,
      company: "Employer",
      status: "ready_for_review",
      lastAttemptState: "ready",
      // Filled in under Prepare for me, before Send for me was chosen.
      automationMode: "prepare_only",
      questionSummary: { total: 0, answered: 0 },
      lastActionLabel: "Filled in",
      lastUpdatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = ["job_0", "job_1"].map((jobId, index) => ({
      id: `result-${index}`,
      runId: "apply-1",
      jobId,
      applicationRecordId: `record-${index}`,
      state: "awaiting_review",
      blockerReason: null,
      updatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];

    const model = build(ws, { applicationAutomationMode: "autonomous_submit" });

    expect(model.next).toMatchObject({
      id: "send",
      title: "Send 2 applications",
      primary: {
        label: "Send all 2",
        action: { kind: "send_prepared", jobIds: ["job_0", "job_1"] },
      },
    });
    expect(model.next.detail).not.toMatch(/Press Send/);
    expect(model.next.secondary[0]?.label).toBe("Open Applications");
  });

  it("under Send for me, a Needs-you card that leads still offers Send in place", () => {
    const ws = withShortlist(withJobs(workspace(), 3), []);
    ws.applicationRecords = ["job_0", "job_1"].map((jobId, index) => ({
      id: `record-${index}`,
      jobId,
      title: `Job ${index}`,
      company: "Employer",
      status: "ready_for_review",
      lastAttemptState: "ready",
      automationMode: "autonomous_submit",
      questionSummary: { total: 0, answered: 0 },
      lastActionLabel: "Filled in",
      lastUpdatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = ["job_0", "job_1"].map((jobId, index) => ({
      id: `result-${index}`,
      runId: "apply-1",
      jobId,
      applicationRecordId: `record-${index}`,
      state: "awaiting_review",
      summary:
        index === 0
          ? "Not sent: your permission to send changed"
          : "Apply form filled in",
      detail: "Nothing was sent.",
      blockerReason: null,
      updatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    ws.userActionRequests = [
      {
        id: "action-1",
        state: "pending",
        kind: "login",
        scope: {
          type: "application",
          runId: "run-1",
          jobId: "job_2",
          applicationRecordId: "record-2",
        },
        title: "Sign in required",
        summary: "Sign in to continue.",
        createdAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];

    const model = build(ws, { applicationAutomationMode: "autonomous_submit" });

    expect(model.next.id).toBe("needs_you");
    expect(model.next.secondary).toContainEqual({
      label: "Send all 2",
      action: { kind: "send_prepared", jobIds: ["job_0", "job_1"] },
    });

    // Without the sign-in step the send card leads and says what was not sent.
    ws.userActionRequests = [];
    const sendFirst = build(ws, {
      applicationAutomationMode: "autonomous_submit",
    });
    expect(sendFirst.next.id).toBe("send");
    expect(sendFirst.next.detail).toBe(
      "1 was not sent: your permission to send changed. Send all 2 tries again.",
    );
  });

  it("does not recommend retrying a listing the application observed closed", () => {
    const ws = withJobs(workspace(), 1);
    ws.applicationRecords = [
      {
        id: "record-0",
        jobId: "job_0",
        title: "Job 0",
        company: "Employer",
        status: "shortlisted",
        lastAttemptState: "failed",
        automationMode: "prepare_only",
        questionSummary: { total: 0, answered: 0 },
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-0",
        state: "failed",
        blockerReason: "application_closed",
        summary: "This job is no longer taking applications.",
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    expect(build(ws).next.id).not.toBe("retry");
  });

  it("offers to try failed applications again with the jobs Applications would retry", () => {
    const ws = withShortlist(withJobs(workspace(), 2), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    ws.applicationRecords = [
      {
        id: "record-0",
        jobId: "job_0",
        title: "Job 0",
        company: "Employer",
        status: "ready_for_review",
        lastAttemptState: "failed",
        automationMode: "prepare_only",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "The prepared application page is no longer open.",
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-0",
        state: "failed",
        blockerReason: "unexpected_navigation",
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    const model = build(ws);
    // The form had been filled in; after a restart its page is gone. Home
    // used to say the attempt "stopped before the form was finished".
    expect(model.next.detail).toContain(
      "This form was filled in, but its page closed before it was sent (closing Job Finder closes it), so nothing was sent. Trying again fills it in again from the listing.",
    );
    expect(model.next.detail).not.toContain("before the form was finished");
    // A retry names the mode it will run in, not just "the mode in Settings".
    expect(model.next.detail).toContain("you press Send on each one");
    expect(model.next.detailLink?.label).toBe("Change how it applies");
    expect(model.next).toMatchObject({
      id: "retry",
      title: "Try again for 1 application",
      primary: {
        label: "Try again",
        action: { kind: "apply_all", jobIds: ["job_0"] },
      },
    });
    expect(model.stages?.[2]).toMatchObject({
      count: 1,
      detail: "1 could not apply",
    });
  });

  it("does not call a form filled in when its page closed while it waited on the person", () => {
    const ws = withShortlist(withJobs(workspace(), 2), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    ws.applicationRecords = [
      {
        id: "record-0",
        jobId: "job_0",
        title: "Job 0",
        company: "Employer",
        status: "ready_for_review",
        lastAttemptState: "failed",
        automationMode: "prepare_only",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "The prepared application page is no longer open.",
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-0",
        state: "failed",
        blockerReason: "unexpected_navigation",
        // It had stopped at its file question when Job Finder restarted.
        reviewCard: {
          waitingOnYou: ["Add your portfolio and academic transcript."],
        },
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    const model = build(ws);
    expect(model.next.id).toBe("retry");
    expect(model.next.detail).not.toContain("was filled in");
    expect(model.next.detail).toContain(
      "The last attempt stopped before the form was finished.",
    );
  });

  it("does not call a form whose send failed in an outage unfinished", () => {
    const ws = withJobs(workspace(), 2);
    ws.applicationRecords = ["job_0", "job_1"].map((jobId, index) => ({
      id: `record-${index}`,
      jobId,
      title: `Job ${index}`,
      company: "Employer",
      status: "ready_for_review",
      lastAttemptState: "failed",
      automationMode: "autonomous_submit",
      questionSummary: { total: 0, answered: 0 },
      lastActionLabel: "Stopped",
      lastUpdatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-0",
        state: "failed",
        blockerReason: null,
        summary: "Not sent: 127.0.0.1:47969 could not be reached",
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
      {
        id: "result-1",
        runId: "apply-1",
        jobId: "job_1",
        applicationRecordId: "record-1",
        state: "failed",
        blockerReason: null,
        summary: "Job Finder could not open the application page",
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];

    const model = build(ws, {
      applicationAutomationMode: "autonomous_submit",
    });

    expect(model.next.id).toBe("retry");
    expect(model.next.detail).toContain(
      "This form was filled in but not sent: 127.0.0.1:47969 could not be reached. One other attempt stopped before the form was finished.",
    );
  });

  it("says an unfinished attempt stopped before the form was finished, and names sending under Send for me", () => {
    const ws = withJobs(workspace(), 2);
    ws.applicationRecords = ["job_0", "job_1"].map((jobId, index) => ({
      id: `record-${index}`,
      jobId,
      title: `Job ${index}`,
      company: "Employer",
      status: "ready_for_review",
      lastAttemptState: "failed",
      automationMode: "autonomous_submit",
      questionSummary: { total: 0, answered: 0 },
      lastActionLabel: "Stopped",
      lastUpdatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-0",
        state: "failed",
        blockerReason: "unexpected_navigation",
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
      {
        id: "result-1",
        runId: "apply-1",
        jobId: "job_1",
        applicationRecordId: "record-1",
        state: "failed",
        blockerReason: null,
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];

    const model = build(ws, {
      applicationAutomationMode: "autonomous_submit",
    });

    expect(model.next.detail).toBe(
      "This form was filled in, but its page closed before it was sent (closing Job Finder closes it), so nothing was sent. One other attempt stopped before the form was finished. Trying again starts each one from the listing. Job Finder fills in and sends each application, and pauses only when it needs you.",
    );
  });

  it("starts only the ready applications that fit today's remaining capacity", () => {
    const ready = (id: string) =>
      queueItem(id, {
        assetStatus: "ready",
        resumeAssetId: `asset-${id}`,
        resumeReview: {
          status: "needs_review",
        } as ReviewQueueItem["resumeReview"],
      });
    const ws = withDailyPreparationRemaining(
      withShortlist(withJobs(workspace(), 3), [
        ready("job_0"),
        ready("job_1"),
        ready("job_2"),
      ]),
      2,
    );
    expect(build(ws).next).toMatchObject({
      id: "apply",
      title: "Apply to 2 of 3 ready jobs",
      primary: {
        label: "Apply to 2",
        action: { kind: "apply_all", jobIds: ["job_0", "job_1"] },
      },
    });
    expect(build(withDailyPreparationRemaining(ws, 0)).next).toMatchObject({
      id: "daily_limit",
      primary: {
        label: "Open Applying settings",
        action: {
          kind: "navigate",
          route: "/job-finder/settings#settings-application-authority",
        },
      },
    });
  });

  it("offers a partial retry batch and a Settings step when the daily limit is reached", () => {
    const ws = withJobs(workspace(), 4);
    ws.applicationRecords = Array.from({ length: 4 }, (_unused, index) => ({
      id: `record-${index}`,
      jobId: `job_${index}`,
      title: `Job ${index}`,
      company: "Employer",
      status: "ready_for_review",
      lastAttemptState: "failed",
      automationMode: "prepare_only",
      questionSummary: { total: 0, answered: 0 },
      lastActionLabel: "Application preparation stopped.",
      lastUpdatedAt: "2026-08-15T11:00:00.000Z",
    })) as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = Array.from({ length: 4 }, (_unused, index) => ({
      id: `result-${index}`,
      runId: `apply-${index}`,
      jobId: `job_${index}`,
      applicationRecordId: `record-${index}`,
      state: "failed",
      blockerReason: "unexpected_navigation",
      updatedAt: "2026-08-15T11:00:00.000Z",
    })) as JobFinderRendererWorkspaceSnapshot["applyJobResults"];

    const partial = build(withDailyPreparationRemaining(ws, 2));
    expect(partial.next).toMatchObject({
      id: "retry",
      title: "Try again for 2 of 4 applications",
      primary: {
        label: "Try again for 2",
        action: { kind: "apply_all", jobIds: ["job_0", "job_1"] },
      },
    });
    expect(partial.stages?.[2]).toMatchObject({
      count: 4,
      detail: "4 could not apply",
    });
    expect(build(withDailyPreparationRemaining(ws, 0)).next).toMatchObject({
      id: "daily_limit",
      title: "Today's preparation limit is reached",
      primary: {
        label: "Open Applying settings",
        action: {
          kind: "navigate",
          route: "/job-finder/settings#settings-application-authority",
        },
      },
    });
  });

  it("puts Needs you ahead of everything else and counts it like the badge", () => {
    const ws = withShortlist(withJobs(workspace(), 2), [queueItem("job_0")]);
    ws.userActionRequests = [
      {
        id: "action-1",
        state: "pending",
        kind: "login",
        scope: {
          type: "application",
          runId: "run-1",
          jobId: "job_0",
          applicationRecordId: "record-1",
        },
        title: "Sign in required",
        summary: "Sign in to continue.",
        createdAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
    const model = build(ws);
    expect(countNeedsYou(ws)).toBe(1);
    expect(model.next).toMatchObject({
      id: "needs_you",
      title: "1 thing needs you",
      primary: {
        label: "Open Needs you",
        action: { kind: "navigate", route: "/job-finder/actions" },
      },
    });
  });

  it("puts a safeguard pause ahead of Needs you", () => {
    const ws = workspace();
    ws.intelligence.safeguards.abnormalFailurePauses = [
      AbnormalFailurePauseSchema.parse({
        id: "automatic_discovery_failures:campaign-1",
        windowStartedAt: "2026-08-15T00:00:00.000Z",
        failuresInWindow: 3,
        sampleSize: 8,
        failureRatePercent: 37.5,
        failureRateThresholdPercent: 30,
        paused: true,
        explanation: "Review failed searches.",
        recoveryGuidance: "Open Safeguards",
      }),
    ];
    const model = build(ws);
    expect(model.next.id).toBe("safeguards");
    expect(model.next.detail).toBe("Review failed searches.");
    expect(model.next.primary.label).toBe("Open Safeguards");
  });

  it("does not hold anything back for an old prepared-batch sample review", () => {
    const ws = withJobs(workspace(), 2);
    ws.intelligence.safeguards.preparedBatchSampleReviews = [
      {
        id: "sample-1",
        batchId: "apply-1",
        campaignId: "campaign-1",
        sampleJobIds: ["job_0"],
        reviewCompleted: false,
        createdAt: "2026-08-15T11:00:00.000Z",
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as typeof ws.intelligence.safeguards.preparedBatchSampleReviews;
    const model = build(ws);
    expect(model.next.id).not.toBe("safeguards");
  });

  it("is all caught up when every shortlisted job has been applied to", () => {
    const ws = withShortlist(withJobs(workspace(), 3), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    ws.applicationRecords = [
      {
        id: "record-0",
        jobId: "job_0",
        title: "Job 0",
        company: "Employer",
        status: "submitted",
        lastAttemptState: "submitted",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "Sent",
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "caught_up",
      title: "All caught up",
      primary: { label: "Search again", action: { kind: "run_search" } },
    });
    expect(model.stages?.[2]).toMatchObject({ count: 1, detail: "1 applied" });
  });

  it("shows the plan selector only with two or more plans", () => {
    const one = build(workspace());
    expect(one.showPlanSelector).toBe(false);
    const ws = workspace();
    ws.campaigns = [
      ...ws.campaigns,
      { ...ws.campaigns[0]!, id: "campaign-2", name: "Backend" },
    ];
    expect(build(ws).showPlanSelector).toBe(true);
  });
});

describe("buildJobSearchHomeModel · round 2 matrix fixes", () => {
  const readyItem = (id: string) =>
    queueItem(id, {
      assetStatus: "ready",
      resumeAssetId: `asset-${id}`,
      resumeReview: {
        status: "needs_review",
      } as ReviewQueueItem["resumeReview"],
    });

  function failedApplications(
    ws: JobFinderRendererWorkspaceSnapshot,
    jobIds: readonly string[],
    result: Record<string, unknown> = {},
  ): JobFinderRendererWorkspaceSnapshot {
    ws.applicationRecords = [
      ...(ws.applicationRecords ?? []),
      ...jobIds.map((jobId) => ({
        id: `record-${jobId}`,
        jobId,
        title: `Job ${jobId}`,
        company: "Employer",
        status: "ready_for_review",
        lastAttemptState: "failed",
        automationMode: "prepare_only",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "Stopped",
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      })),
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      ...(ws.applyJobResults ?? []),
      ...jobIds.map((jobId) => ({
        id: `result-${jobId}`,
        runId: "apply-1",
        jobId,
        applicationRecordId: `record-${jobId}`,
        state: "failed",
        blockerReason: null,
        updatedAt: "2026-08-15T11:00:00.000Z",
        ...result,
      })),
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    return ws;
  }

  it("counts all 11 ready jobs and caps only the press at one batch", () => {
    const ids = Array.from({ length: 11 }, (_u, i) => `job_${i}`);
    const ws = withShortlist(withJobs(workspace(), 11), ids.map(readyItem));
    const model = build(ws);
    expect(model.stages?.[1]?.detail).toBe("11 ready to apply");
    expect(model.next).toMatchObject({
      id: "apply",
      title: "Apply to 10 of 11 ready jobs",
      primary: { label: "Apply to 10" },
    });
    expect(
      model.next.primary.action.kind === "apply_all" &&
        model.next.primary.action.jobIds,
    ).toEqual(ids.slice(0, 10));
    expect(model.next.detail).toContain(
      "Job Finder works through 10 at a time. The other 1 stays in Shortlisted for the next press.",
    );
  });

  it("counts every retryable application and caps only the press", () => {
    const ids = Array.from({ length: 12 }, (_u, i) => `job_${i}`);
    const ws = failedApplications(withJobs(workspace(), 12), ids);
    const model = build(ws);
    expect(model.stages?.[2]?.detail).toBe("12 could not apply");
    expect(model.next).toMatchObject({
      id: "retry",
      title: "Try again for 10 of 12 applications",
      primary: { label: "Try again for 10" },
    });
  });

  it("keeps Try again for all one press away while a form waits to be sent", () => {
    const ws = withShortlist(withJobs(workspace(), 4), [
      readyItem("job_0"),
      readyItem("job_1"),
      readyItem("job_2"),
    ]);
    ws.applicationRecords = [
      {
        id: "record-job_0",
        jobId: "job_0",
        title: "Job 0",
        company: "Employer",
        status: "ready_for_review",
        lastAttemptState: "ready",
        automationMode: "prepare_only",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "Filled in",
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-job_0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-job_0",
        state: "awaiting_review",
        blockerReason: null,
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    failedApplications(ws, ["job_1", "job_2"]);
    const model = build(ws);
    expect(model.next.id).toBe("send");
    expect(model.next.secondary.map((button) => button.label).slice(0, 2)).toEqual([
      "Try again for all 2",
      "Search again",
    ]);
    expect(model.next.secondary[0]?.action).toEqual({
      kind: "apply_all",
      jobIds: ["job_1", "job_2"],
    });
  });

  it("offers Apply to all beside Needs you, and names a source sign-in as one", () => {
    const ws = withShortlist(withJobs(workspace(), 3), [
      readyItem("job_0"),
      readyItem("job_1"),
    ]);
    ws.userActionRequests = [
      {
        id: "action-1",
        state: "pending",
        kind: "login",
        scope: { type: "discovery_source", targetId: "target-1" },
        title: "Sign in",
        summary: "Sign in to continue.",
        createdAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
    const model = build(ws);
    expect(model.next.id).toBe("needs_you");
    expect(model.next.detail).toContain("A job source wants you to sign in");
    expect(model.next.detail).not.toContain("An application is waiting");
    expect(model.next.secondary.map((button) => button.label).slice(0, 2)).toEqual([
      "Apply to all 2",
    ]);
  });

  it("sends a search whose only source leads to a missing page to Job sources", () => {
    const ws = workspace();
    ws.recentDiscoveryRuns = [
      {
        ...completedRun({ found: 0, new: 0 }),
        state: "failed",
        targetExecutions: [
          {
            targetId: "target-1",
            state: "failed",
            jobsFound: 0,
            // The wording the discovery agent records (round 2 Find jobs run).
            warning:
              "Agent discovery failed: Starting page returned HTTP 404: http://127.0.0.1:47954/nope/",
          },
        ],
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["recentDiscoveryRuns"];
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "source_failed",
      title: "Fix a job source",
      primary: {
        label: "Open job sources",
        action: {
          kind: "navigate",
          route:
            "/job-finder/profile?section=sources&focus=job-sources#profile-job-sources",
        },
      },
    });
    expect(model.next.detail).toContain("Replica board");
    expect(model.next.detail).not.toContain("Run it again");
    // One message for one fact: no problem line repeating the card.
    expect(model.problems).toEqual([]);

    // The person replaced the broken source: search again, not "Fix".
    ws.searchPreferences.discovery.targets = [
      { ...ws.searchPreferences.discovery.targets[0]!, id: "target-2" },
    ];
    const replaced = build(ws);
    expect(replaced.next.id).toBe("search_failed");
    expect(replaced.next.primary.label).toBe("Search again");
  });

  it("after the person stops a search that found jobs, points at the jobs without a source problem", () => {
    const ws = withJobs(workspace(), 4);
    ws.recentDiscoveryRuns = [
      {
        ...completedRun({ found: 4, new: 4 }),
        state: "cancelled",
        summary: {
          ...completedRun({ found: 4, new: 4 }).summary,
          sourceHealth: [
            { targetId: "target-1", health: "cancelled", warnings: [] },
          ],
        },
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["recentDiscoveryRuns"];
    const model = build(ws);
    expect(model.next.id).toBe("look_through");
    expect(model.next.detail).toContain("You stopped the search");
    expect(model.problems).toEqual([]);
    expect(model.statusLine).toContain("stopped early");
  });

  it("tells the person to hand a taken-over application back", () => {
    const ws = failedApplications(withJobs(workspace(), 1), ["job_0"], {
      summary: "You took over this application.",
    });
    const model = build(ws);
    expect(model.next.id).toBe("retry");
    expect(model.next.detail).toContain(
      "Press Resume agent there when you are done",
    );
  });

  it("leaves a changed Aggressive resume out of the retry batch and says why", () => {
    const ws = withShortlist(withJobs(workspace(), 2), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeTailoringMode: "aggressive",
        resumeReview: { status: "stale" } as ReviewQueueItem["resumeReview"],
      }),
      queueItem("job_1", {
        assetStatus: "ready",
        resumeAssetId: "asset-1",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    failedApplications(ws, ["job_0", "job_1"]);
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "retry",
      title: "Try again for 1 application",
      primary: { action: { kind: "apply_all", jobIds: ["job_1"] } },
    });
    expect(model.next.detail).toContain(
      "One other waits until you approve its changed Aggressive resume",
    );

    const alone = withShortlist(withJobs(workspace(), 1), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeTailoringMode: "aggressive",
        resumeReview: { status: "stale" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    failedApplications(alone, ["job_0"]);
    expect(build(alone).next).toMatchObject({
      id: "review_resumes",
      title: "Approve 1 changed resume",
      primary: { label: "Open Applications" },
    });
  });

  it("does not call a shortlist with an out-of-date resume caught up", () => {
    const ws = withShortlist(withJobs(workspace(), 1), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: { status: "stale" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    const model = build(ws);
    expect(model.stages?.[1]?.detail).toBe("1 to check");
    expect(model.next).toMatchObject({
      id: "review_resumes",
      title: "Check 1 shortlisted job",
      primary: { label: "Open Shortlisted" },
    });
  });

  it("points at the weaker matches when a search kept only those", () => {
    const ws = withJobs(workspace(), 0, { weaker: 3 });
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "look_through",
      title: "Look through 3 weaker matches",
    });
    expect(model.stages?.[0]?.detail).toBe("+ 3 weaker");
  });

  it("sends a non-review safeguard to the Safeguards list, not the Reviews tab", () => {
    const ws = withJobs(workspace(), 2);
    ws.intelligence.safeguards.companyApplicationCaps = [
      {
        id: "cap-1",
        companyKey: "employer",
        companyName: "Employer",
        limit: 1,
        count: 1,
        limitReached: true,
        heldJobIds: ["job_0"],
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as typeof ws.intelligence.safeguards.companyApplicationCaps;
    const model = build(ws);
    expect(model.next.id).toBe("safeguards");
    expect(model.next.primary.action).toEqual({
      kind: "navigate",
      route: "/job-finder/safeguards",
    });
    expect(model.next.detail).not.toContain("sample");
  });

  it("keeps waiting for a writing batch and offers the ready ones as a second press", () => {
    const ws = withShortlist(withJobs(workspace(), 3), [
      readyItem("job_0"),
      queueItem("job_1", { assetStatus: "generating" }),
      queueItem("job_2"),
    ]);
    const tasks = buildJobFinderTaskCenterModel({
      workspace: ws,
      isDiscoveryPending: false,
      isResumeImportPending: false,
      tailoredDraftPreparation: {
        attemptedCount: 2,
        completedCount: 1,
        currentIndex: 2,
        eligibleRemainingCount: 0,
        failedCount: 0,
        status: "running",
        totalCount: 3,
      },
      now: NOW,
    });
    const model = build(ws, { tasks });
    expect(model.next.id).toBe("wait_resumes");
    expect(model.next.detail).toContain("1 is ready so far");
    expect(model.next.secondary).toEqual([
      {
        label: "Apply to the ready one now",
        action: { kind: "apply_all", jobIds: ["job_0"] },
      },
    ]);
    expect(model.stages?.[1]?.detail).toBe(
      "1 need a resume · 1 being written · 1 ready to apply",
    );
  });

  it("keeps Needs you one press away while work is paused", () => {
    const ws = workspace();
    ws.activityControl = {
      paused: true,
      pausedAt: "2026-08-15T11:00:00.000Z",
      reason: "Paused by you.",
    } as JobFinderRendererWorkspaceSnapshot["activityControl"];
    ws.userActionRequests = [
      {
        id: "action-1",
        state: "pending",
        kind: "manual_answer",
        scope: {
          type: "application",
          runId: "run-1",
          jobId: "job_0",
          applicationRecordId: "record-1",
        },
        title: "Answer",
        summary: "Answer",
        createdAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
    const model = build(ws);
    expect(model.next.id).toBe("paused");
    expect(model.next.secondary).toEqual([
      {
        label: "Open Needs you",
        action: { kind: "navigate", route: "/job-finder/actions" },
      },
    ]);
  });

  it("names the count on a partial retry offered beside another card", () => {
    const ws = withDailyPreparationRemaining(
      withShortlist(withJobs(workspace(), 4), [readyItem("job_0")]),
      1,
    );
    ws.applicationRecords = [
      {
        id: "record-job_0",
        jobId: "job_0",
        title: "Job 0",
        company: "Employer",
        status: "ready_for_review",
        lastAttemptState: "ready",
        automationMode: "prepare_only",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "Filled in",
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-job_0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-job_0",
        state: "awaiting_review",
        blockerReason: null,
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    failedApplications(ws, ["job_1", "job_2", "job_3"]);
    const model = build(ws);
    expect(model.next.id).toBe("send");
    expect(model.next.secondary[0]).toEqual({
      label: "Try again for 1 of 3",
      action: { kind: "apply_all", jobIds: ["job_1"] },
    });
    // With nothing left today, the limit is named instead of silence.
    const spent = build(withDailyPreparationRemaining(ws, 0));
    expect(spent.next.secondary[0]).toEqual({
      label: "Change today's limit",
      action: {
        kind: "navigate",
        route: "/job-finder/settings#settings-application-authority",
      },
    });
  });
});

describe("buildJobSearchHomeModel · planned jobs of a stopped or paused batch", () => {
  function withPlannedBatch(runState: string, paused: boolean) {
    const ws = withShortlist(withJobs(workspace(), 2), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
      queueItem("job_1", {
        assetStatus: "ready",
        resumeAssetId: "asset-1",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    ws.applicationRecords = ["job_0", "job_1"].map((jobId, index) => ({
      id: `record-${index}`,
      jobId,
      title: `Job ${index}`,
      company: "Employer",
      status: "ready_for_review",
      lastAttemptState: "in_progress",
      automationMode: "prepare_only",
      questionSummary: { total: 0, answered: 0 },
      lastActionLabel: "",
      lastUpdatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyRuns = [
      {
        id: "apply-1",
        mode: "queue_auto",
        state: runState,
        jobIds: ["job_0", "job_1"],
        currentJobId: "job_0",
        totalJobs: 2,
        pendingJobs: 1,
        createdAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyRuns"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-0",
        state: "submitted",
        startedAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T10:30:00.000Z",
      },
      {
        id: "result-1",
        runId: "apply-1",
        jobId: "job_1",
        applicationRecordId: "record-1",
        state: "planned",
        startedAt: "2026-08-15T10:00:00.000Z",
        updatedAt: "2026-08-15T10:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    ws.activityControl = paused
      ? ({
          paused: true,
          pausedAt: "2026-08-15T10:20:00.000Z",
          reason: null,
          pauseBehavior: "finish_current",
        } as JobFinderRendererWorkspaceSnapshot["activityControl"])
      : ({
          paused: false,
          pausedAt: null,
          reason: null,
        } as JobFinderRendererWorkspaceSnapshot["activityControl"]);
    return ws;
  }

  it("offers a job a safety limit left behind as one retry, never as Filling in", () => {
    const model = build(withPlannedBatch("paused_for_user_review", false));
    const tile = model.stages?.find((stage) =>
      stage.detail?.includes("not started"),
    );
    expect(tile?.detail).toBe("1 applied · 1 not started");
    expect(tile?.detail).not.toContain("filling in");
    // Nothing is left to settle in Safeguards, so Home offers the retry
    // itself instead of "A safeguard is waiting on you".
    expect(model.next).toMatchObject({
      id: "retry",
      title: "Try again for 1 application",
      primary: { action: { kind: "apply_all", jobIds: ["job_1"] } },
    });
    expect(model.next.detail).toContain(
      "A safety limit stopped the batch before Job Finder got to this one, so nothing was filled in or sent.",
    );
    expect(model.next.secondary.map((button) => button.label)).toContain(
      "Open Safeguards",
    );
  });

  it("retries the job the batch never reached first when today's limit allows one", () => {
    const ws = withPlannedBatch("paused_for_user_review", false);
    ws.applicationRecords[0] = {
      ...ws.applicationRecords[0]!,
      lastAttemptState: "failed",
    };
    ws.applyJobResults[0] = {
      ...ws.applyJobResults[0]!,
      state: "failed",
      blockerReason: "unexpected_navigation",
    } as JobFinderRendererWorkspaceSnapshot["applyJobResults"][number];
    const model = build(withDailyPreparationRemaining(ws, 1));
    expect(model.next).toMatchObject({
      id: "retry",
      primary: { action: { kind: "apply_all", jobIds: ["job_1"] } },
    });
  });

  it("says a job of a running batch is waiting, not filling in", () => {
    const model = build(withPlannedBatch("running", false));
    const tile = model.stages?.find((stage) =>
      stage.detail?.includes("waiting"),
    );
    expect(tile?.detail).toBe("1 waiting · 1 applied");
  });

  it("says Paused for a job held by the person's pause, with no retry", () => {
    const model = build(withPlannedBatch("running", true));
    const tile = model.stages?.find((stage) =>
      stage.detail?.includes("paused"),
    );
    expect(tile?.detail).toBe("1 paused · 1 applied");
    expect(model.next.id).not.toBe("retry");
  });
});

describe("buildJobSearchHomeModel · tracker dates", () => {
  function withTrackedApplication(
    base: JobFinderRendererWorkspaceSnapshot,
  ): JobFinderRendererWorkspaceSnapshot {
    return {
      ...base,
      applicationRecords: [
        ApplicationRecordSchema.parse({
          id: "application_0",
          jobId: "job_0",
          title: "Job 0",
          company: "Employer",
          status: "submitted",
          lastAttemptState: "submitted",
          lastActionLabel: "Applied",
          nextActionLabel: null,
          lastUpdatedAt: "2026-08-10T10:00:00.000Z",
          crm: {
            stage: "interview",
            stageChangedAt: "2026-08-12T10:00:00.000Z",
            reminders: [
              {
                id: "reminder_overdue",
                title: "Send a thank-you note",
                dueAt: "2026-08-14T09:00:00.000Z",
                createdAt: "2026-08-12T10:00:00.000Z",
                updatedAt: "2026-08-12T10:00:00.000Z",
              },
            ],
            interviews: [
              {
                id: "interview_soon",
                title: "Panel interview",
                startsAt: "2026-08-16T09:00:00.000Z",
                createdAt: "2026-08-12T10:00:00.000Z",
                updatedAt: "2026-08-12T10:00:00.000Z",
              },
            ],
          },
        }),
      ],
    } as JobFinderRendererWorkspaceSnapshot;
  }

  it.each(["search", "limit"])(
    "names a due reminder while %s holds other work",
    (mode) => {
      const state = withTrackedApplication(withJobs(workspace(), 1));
      if (mode === "search") {
        state.activeDiscoveryRun = {
          ...state.recentDiscoveryRuns[0],
          state: "running",
        } as JobFinderRendererWorkspaceSnapshot["activeDiscoveryRun"];
      }
      if (mode === "limit") {
        state.dashboard.globalDailyApplicationPreparationCapacity = {
          localDate: "2026-08-15",
          limit: 20,
          used: 20,
          remaining: 0,
          resetsAt: "2026-08-16T00:00:00Z",
          legacyUncertain: 0,
        };
      }
      const model = build(state);
      expect(model.next.id).toBe("tracker_due");
      expect(model.next.title).toContain("Send a thank-you note");
      expect(model.next.primary.action.kind).toBe("navigate");
      if (model.next.primary.action.kind === "navigate") {
        expect(model.next.primary.action.route).toContain("application_0");
      }
    },
  );

  it.each(["paused", "safeguards", "needs_you"])(
    "keeps %s before a due reminder and names the reminder second",
    (mode) => {
      const state = withTrackedApplication(withJobs(workspace(), 1));
      if (mode === "paused")
        state.activityControl = {
          paused: true,
          reason: null,
          pausedAt: "2026-08-15T10:00:00Z",
        };
      if (mode === "safeguards")
        state.intelligence.safeguards.abnormalFailurePauses = [
          AbnormalFailurePauseSchema.parse({
            id: "pause",
            windowStartedAt: "2026-08-01T10:00:00Z",
            failuresInWindow: 4,
            sampleSize: 5,
            failureRatePercent: 80,
            failureRateThresholdPercent: 50,
            minimumSample: 5,
            paused: true,
            explanation: "Review failures",
            recoveryGuidance: "Review this hold",
          }),
        ];
      if (mode === "needs_you")
        state.userActionRequests = [
          {
            id: "request",
            kind: "login",
            state: "pending",
            scope: { type: "discovery_source", targetId: "source-1" },
            summary: "Sign in",
          },
        ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
      const model = build(state);
      expect(model.next.id).toBe(mode);
      expect(model.next.detail).toContain("Send a thank-you note");
      expect(
        model.next.secondary.some(
          (button) => button.label === "Open due follow-up",
        ),
      ).toBe(true);
    },
  );

  it("counts an overdue follow-up and a near interview on the Applications tile", () => {
    const model = build(withTrackedApplication(withJobs(workspace(), 1)));
    const applications = model.stages?.find(
      (stage) => stage.id === "applications",
    );
    expect(applications?.detail).toContain("1 follow-up overdue");
    expect(applications?.detail).toContain("1 interview soon");
  });

  it("makes the tracker the next step when nothing else waits on the person", () => {
    const model = build(
      withTrackedApplication(
        withShortlist(withJobs(workspace(), 3), [
          queueItem("job_0", {
            assetStatus: "ready",
            resumeAssetId: "asset-0",
            resumeReview: {
              status: "approved",
            } as ReviewQueueItem["resumeReview"],
          }),
        ]),
      ),
    );
    expect(model.next.id).toBe("tracker_due");
    expect(model.next.title).toBe("Send a thank-you note · Job 0 at Employer");
  });
});

describe("buildJobSearchHomeModel · applications the person stopped or may have sent", () => {
  function withResult(
    result: Record<string, unknown>,
    lastAttemptState = "failed",
  ) {
    const ws = withShortlist(withJobs(workspace(), 2), [
      queueItem("job_0", {
        assetStatus: "ready",
        resumeAssetId: "asset-0",
        resumeReview: { status: "approved" } as ReviewQueueItem["resumeReview"],
      }),
    ]);
    ws.applicationRecords = [
      {
        id: "record-0",
        jobId: "job_0",
        title: "Job 0",
        company: "Employer",
        status: "ready_for_review",
        lastAttemptState,
        automationMode: "prepare_only",
        questionSummary: { total: 0, answered: 0 },
        lastActionLabel: "Stopped",
        lastUpdatedAt: "2026-08-15T11:00:00.000Z",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = [
      {
        id: "result-0",
        runId: "apply-1",
        jobId: "job_0",
        applicationRecordId: "record-0",
        updatedAt: "2026-08-15T11:00:00.000Z",
        ...result,
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    return ws;
  }

  it("never offers to retry an application the person cancelled", () => {
    const model = build(
      withResult({ state: "cancelled", summary: "Cancelled by you" }, "cancelled"),
    );
    expect(model.next.id).not.toBe("retry");
    expect(model.stages?.[2]?.detail).toBe("1 cancelled");
  });

  it("asks the person to check a form whose page closed instead of retrying it", () => {
    const model = build(
      withResult({
        state: "failed",
        summary: "The prepared application page is no longer open.",
        blockerReason: "unexpected_navigation",
        blockerSummary: "The prepared application page is no longer open.",
      }),
    );
    expect(model.next).toMatchObject({
      id: "check_closed",
      title: "Check 1 application whose form closed",
      primary: { action: { kind: "navigate" } },
    });
    expect(model.next.detail).toContain("Prepare again");
    expect(model.stages?.[2]?.detail).toBe("1 form closed");

  });

  it("leads with the resumes to review and keeps a closed form as a quiet line", () => {
    const ws = withResult({
      state: "failed",
      summary: "The prepared application page is no longer open.",
      blockerReason: "unexpected_navigation",
      blockerSummary: "The prepared application page is no longer open.",
    });
    ws.reviewQueue = [
      ...ws.reviewQueue,
      queueItem("job_1", {
        assetStatus: "ready",
        resumeAssetId: "asset-1",
        resumeTailoringMode: "aggressive",
        resumeReview: { status: "needs_review" } as ReviewQueueItem["resumeReview"],
      }),
      queueItem("job_2", {
        assetStatus: "ready",
        resumeAssetId: "asset-2",
        resumeTailoringMode: "aggressive",
        resumeReview: { status: "needs_review" } as ReviewQueueItem["resumeReview"],
      }),
    ];
    for (const campaign of ws.campaigns) {
      campaign.jobIds = [...new Set([...campaign.jobIds, "job_1", "job_2"])];
    }
    const model = build(ws);
    expect(model.next).toMatchObject({
      id: "review_resumes",
      title: "Review 2 resumes",
      primary: {
        label: "Start reviewing",
        action: { kind: "navigate", route: buildResumeWorkspaceRoute("job_1") },
      },
    });
    expect(model.next.also?.map((line) => line.id)).toEqual(["check_closed"]);
    expect(model.next.also?.[0]?.link?.label).toBe("Open Applications");
  });
});
it("separates untouched jobs, queued drafts and active writers in a ten-job batch", () => {
  const ws = withShortlist(
    withJobs(workspace(), 32),
    Array.from({ length: 32 }, (_, index) =>
      queueItem(
        `job_${index}`,
        index < 8
          ? {
              assetStatus: "ready",
              resumeAssetId: `asset_${index}`,
              resumeReview: { status: "needs_review" },
            }
          : {},
      ),
    ),
  );
  ws.intelligence.resumeBatchCheckpoint = {
    id: "batch",
    jobIds: Array.from({ length: 10 }, (_, index) => `job_${index + 2}`),
    activeJobIds: ["job_8", "job_9"],
    completedJobIds: Array.from(
      { length: 6 },
      (_, index) => `job_${index + 2}`,
    ),
    done: false,
    stopRequested: false,
  };
  const model = build(ws, {
    tailoredDraftPreparation: {
      status: "running",
      totalCount: 10,
      attemptedCount: 8,
      completedCount: 6,
      failedCount: 0,
      eligibleRemainingCount: 20,
      currentIndex: 8,
    },
  });
  expect(
    model.stages?.find((stage) => stage.label === "Shortlisted")?.detail,
  ).toContain("20 need a resume · 2 queued · 2 being written");
});

it("Home counts the selected plan's sources rather than every saved source", () => {
  const ws = workspace();
  const target = ws.searchPreferences.discovery.targets[0]!;
  ws.searchPreferences.discovery.targets = Array.from(
    { length: 7 },
    (_, index) => ({ ...target, id: `source-${index}` }),
  );
  ws.campaigns[0]!.searchPreferences = ws.searchPreferences;
  ws.campaigns[0]!.sourceTargetIds = ["source-0"];
  ws.campaigns[0]!.sourceSelectionMode = "selected";
  const model = build(ws);
  expect(model.statusLine).toBe(
    "Ready to search 1 source. Nothing has been searched yet.",
  );
  expect(JSON.stringify(model)).toContain("Job Finder searches 1 source");
});
