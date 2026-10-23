// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { JobSearchCampaignSchema } from "@nestor/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import type { ReactElement } from "react";
import { createDiscoveryRunInterruptedFeedback } from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import type { JobFinderPageContext } from "./job-finder-page-context";
import {
  JobFinderApplicationsRoute,
  JobFinderDiscoveryRoute,
  JobFinderHomeRoute,
  JobFinderProfileRoute,
  JobFinderReviewQueueRoute,
} from "./job-finder-page-routes";

// The review-queue route reads applicationPolicy.defaultResumeStrategyId from
// the active campaign, so the fixture must be a schema-valid campaign. Parsing
// fills the required sibling defaults (external-write consent, submit
// authorization, quality sample ratio, schedule) instead of hand-waving them.
const activeCampaign = JobSearchCampaignSchema.parse({
  id: "campaign_1",
  name: "Campaign One",
  mode: "precision",
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  jobIds: ["job_a"],
  searchPreferences: {
    workModes: [],
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
  },
  limits: {
    retainedJobTarget: 15,
    analysisConcurrency: 2,
    preparationBatchSize: 5,
    dailyPreparationLimit: null,
  },
  stopRules: {
    pauseOnLoginRequired: false,
    pauseOnChangedForm: true,
    pauseOnUncertainEligibility: true,
    pauseOnFailureRatePercent: 30,
    failureRateMinimumSample: 5,
  },
  applicationPolicy: {
    resumeStrategy: "job_specific",
    defaultResumeStrategyId: null,
    requireReviewBeforePreparation: true,
  },
  progress: { lastUpdatedAt: "2026-08-20T00:00:00.000Z" },
});

function createWorkspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    hydration: { phase: "ready", deferredCollections: [] },
    activeCampaignId: "campaign_1",
    activityControl: { paused: false, pausedAt: null, reason: null },
    campaigns: [activeCampaign],
    dashboard: {
      activeCampaignId: "campaign_1",
      activeCampaignCount: 1,
      applicationsAppliedThisWeek: 0,
      applicationsAppliedToday: 0,
      applicationsReadyForApproval: 0,
      backgroundOperationCount: 0,
      generatedAt: "2026-08-20T00:00:00.000Z",
      interviewRate: null,
      jobsAwaitingReview: 0,
      jobsFoundToday: 0,
      needsYouCount: 0,
      recommendedNextAction: {
        detail: "Run the active search plan to collect openings.",
        label: "Review prepared applications",
        route: "/job-finder/applications",
      },
      responseRate: null,
      sourceHealth: { healthy: 0, needsAttention: 0, running: 0, total: 0 },
      upcomingFollowUps: 0,
      upcomingInterviews: 0,
    },
    discoveryJobs: [
      {
        id: "job_a",
        title: "Engineer",
        company: "Acme",
        location: "Remote",
        status: "new",
        applyPath: null,
        workMode: [],
        provenance: [],
        keySkills: [],
        keywordSignals: [],
        sourceIntelligence: null,
        normalizedCompensation: null,
        description: "Build reliable systems.",
        descriptionFormat: "text",
        sourceTargetId: null,
        screeningHints: {
          relocationText: null,
          remoteGeographies: [],
          requiresSecurityClearance: null,
          sponsorshipText: null,
          travelText: null,
        },
        matchAssessment: {
          score: 80,
          recommendation: "review_before_applying",
          reasons: ["Strong skills overlap"],
          gaps: [],
        },
      },
    ],
    dismissedDiscoveryJobs: [],
    recentDiscoveryRuns: [],
    discoverySessions: [],
    sourceAccessPrompts: [],
    activeDiscoveryRun: null,
    browserSession: {
      source: "user",
      status: "unknown",
      driver: "catalog_seed",
      label: "Browser",
      detail: null,
      lastCheckedAt: "2026-08-20T00:00:00.000Z",
    },
    intelligence: {
      companies: [],
      rapidReviewLogs: [],
      groupedDecisions: [],
      outcomeEvents: [],
      resumeStrategies: [],
      resumeStrategySelections: [],
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
    },
    reviewQueue: [
      {
        jobId: "job_a",
        title: "Role job_a",
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
      },
    ],
    tailoredAssets: [],
    applicationRecords: [],
    applicationAttempts: [],
    applyRuns: [],
    applyJobResults: [],
    selectedApplyRunId: null,
    settings: {},
    profileSetupState: { status: "completed", reviewItems: [] },
    profile: {
      baseResume: {
        id: "resume_base",
        fileName: "base-resume.pdf",
        uploadedAt: "2026-08-20T00:00:00.000Z",
        textContent: "Experienced engineer.",
        analysisWarnings: [],
      },
      fullName: "Test Candidate",
      yearsExperience: 6,
      skills: [],
      workEligibility: {
        authorizedWorkCountries: [],
        preferredRelocationRegions: [],
      },
      applicationIdentity: {
        preferredEmail: null,
        preferredPhone: null,
        preferredLinkIds: [],
      },
      answerBank: {
        customAnswers: [],
      },
      languages: [],
      links: [],
      proofBank: [],
      projects: [],
      certifications: [],
      education: [],
      experiences: [],
      spokenLanguages: [],
      narrative: {
        differentiators: [],
        motivationThemes: [],
      },
      skillGroups: {
        coreSkills: [],
        highlightedSkills: [],
        languagesAndFrameworks: [],
        softSkills: [],
        tools: [],
      },
      professionalSummary: {
        careerThemes: [],
        strengths: [],
      },
    },
    searchPreferences: {
      targetRoles: [],
      jobFamilies: [],
      employmentTypes: [],
      locations: [],
      excludedLocations: [],
      seniorityLevels: [],
      workModes: [],
      targetCompanyStages: [],
      targetIndustries: [],
      companyBlacklist: [],
      companyWhitelist: [],
      tailoringMode: "balanced",
      compensation: { currency: "USD", interval: "yearly" },
      discovery: {
        collectOnlyHardCriteriaMatches: false,
        targets: [
          {
            id: "source_1",
            label: "Acme careers",
            enabled: true,
            startingUrl: "https://acme.example/careers",
          },
        ],
      },
    },
    latestResumeImportRun: null,
    latestResumeImportReviewCandidates: [],
    profileCopilotMessages: [],
    profileRevisions: [],
    recentSourceDebugRuns: [],
    sourceInstructionArtifacts: [],
    // Home filters the open action requests on every render; the contract
    // defaults the list, so a parsed snapshot always has it.
    userActionRequests: [],
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function createContext(): JobFinderPageContext {
  // Canonical screens receive every controller handler; the harness supplies
  // stable no-op functions for any handler a test does not name explicitly.
  const handlerStubs = new Map<string | symbol, () => undefined>();
  const base = {
    actionState: { message: null },
    canImportResume: true,
    discoveryRunFeedback: null,
    importResumeGuardMessage: null,
    isAnyPending: () => false,
    isPending: () => false,
    liveDiscoveryEvents: [],
    onNavigateSafely: vi.fn(),
    profileCopilotBusy: false,
    profileCopilotPendingContextKey: null,
    resumeImportProgress: null,
    resumeAssistantMessages: [],
    resumeAssistantPending: false,
    resumeWorkspace: null,
    saveState: { state: "idle", version: 0 },
    tailoredDraftPreparation: {
      attemptedCount: 0,
      completedCount: 0,
      currentIndex: null,
      eligibleRemainingCount: 0,
      failedCount: 0,
      status: "idle",
      totalCount: 0,
    },
    workspace: createWorkspace(),
  };

  return new Proxy(base, {
    get(target, property) {
      if (property in target) {
        return target[property as keyof typeof target];
      }

      let stub = handlerStubs.get(property);
      if (!stub) {
        stub = () => undefined;
        handlerStubs.set(property, stub);
      }

      return stub;
    },
  }) as unknown as JobFinderPageContext;
}

/**
 * Timer callbacks this assertion excuses, by exact function name.
 *
 * jsdom implements `localStorage.setItem` by dispatching its storage event
 * through `setTimeout`, so any screen that reads a stored preference on mount
 * shows up on a raw `setTimeout` spy. That dispatch is the storage API, not a
 * deferred surface.
 *
 * The list is exact and closed on purpose. A substring test would excuse any
 * application callback whose name happened to contain one of these words, and
 * an anonymous callback — which is what a deferred surface usually schedules —
 * has an empty name and is never on the list.
 */
const JSDOM_INTERNAL_TIMER_CALLBACK_NAMES: ReadonlySet<string> = new Set([
  "_dispatchStorageEvent",
  // jsdom schedules the dispatcher through Function.prototype.bind, which
  // renames it; both spellings are the same jsdom internal.
  "bound _dispatchStorageEvent",
]);

/** The timers the screen itself scheduled. */
function surfaceTimerCalls(
  calls: readonly (readonly unknown[])[],
): readonly (readonly unknown[])[] {
  return calls.filter(([handler]) => {
    if (typeof handler !== "function") {
      return true;
    }
    return !JSDOM_INTERNAL_TIMER_CALLBACK_NAMES.has(handler.name);
  });
}

function renderCanonicalRoute(
  path: string,
  element: ReactElement,
  context = createContext(),
) {
  const setTimeoutSpy = vi.spyOn(window, "setTimeout");
  const rendered = render(
    <MemoryRouter initialEntries={[path]}>
      <Suspense fallback={null}>
        <Routes>
          <Route path="/job-finder" element={<Outlet context={context} />}>
            <Route index element={element} />
            <Route path="discovery" element={element} />
            <Route path="profile" element={element} />
            <Route path="applications" element={element} />
            <Route path="review-queue" element={element} />
          </Route>
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );

  return { setTimeoutSpy, ...rendered };
}

describe("canonical route first paint", () => {
  class ResizeObserverMock {
    observe() {}

    disconnect() {}
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts the real Find jobs heading immediately without a suspense fallback or deferred surface timer", () => {
    const { setTimeoutSpy } = renderCanonicalRoute(
      "/job-finder/discovery",
      <JobFinderDiscoveryRoute />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Find jobs" }),
    ).toBeTruthy();
    expect(screen.queryByText("Loading screen")).toBeNull();
    expect(surfaceTimerCalls(setTimeoutSpy.mock.calls)).toEqual([]);
  });

  it("renders the offline catalog state without a browser CTA", () => {
    const context = createContext();
    const onOpenBrowserSession = vi.fn();
    context.onOpenBrowserSession = onOpenBrowserSession;
    const baseCampaign = context.workspace.campaigns[0];
    context.workspace = {
      ...context.workspace,
      campaigns: baseCampaign ? [{ ...baseCampaign, jobIds: [] }] : [],
      discoveryJobs: [],
    };
    renderCanonicalRoute(
      "/job-finder/discovery",
      <JobFinderDiscoveryRoute />,
      context,
    );

    // Find jobs lands on Results; the results panel owns the unavailable-
    // search fact in one sentence. The slim search bar drops its browser
    // link entirely instead of repeating it.
    expect(
      screen.getAllByText(/Job Finder cannot search right now/u).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByTestId("discovery-search-bar-browser")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open the Job Finder browser" }),
    ).toBeNull();
    expect(onOpenBrowserSession).not.toHaveBeenCalled();
  });

  it("opens a browser session from Home without forwarding the React click event", async () => {
    const context = createContext();
    context.workspace = {
      ...context.workspace,
      campaigns: context.workspace.campaigns.map((plan) => ({
        ...plan,
        searchPreferences: {
          ...plan.searchPreferences,
          discovery: context.workspace.searchPreferences.discovery,
        },
        sourceTargetIds: ["source_1"],
      })),
    };
    const onOpenBrowserSession = vi.fn();
    context.onOpenBrowserSession = onOpenBrowserSession;
    context.discoveryRunFeedback = createDiscoveryRunInterruptedFeedback({
      detail: "The dedicated browser could not start.",
    });
    renderCanonicalRoute("/job-finder", <JobFinderHomeRoute />, context);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open the Job Finder browser",
      }),
    );

    expect(onOpenBrowserSession).toHaveBeenCalledTimes(1);
    expect(onOpenBrowserSession.mock.calls[0]).toEqual([]);
  });

  it("does not tell a workspace still loading its saved jobs to run a first search", () => {
    const context = createContext();
    context.workspace = {
      ...context.workspace,
      hydration: {
        phase: "bootstrap",
        deferredCollections: ["discovery_jobs", "applications"],
      },
    };
    renderCanonicalRoute("/job-finder", <JobFinderHomeRoute />, context);

    expect(screen.getByText("Loading your workspace")).toBeTruthy();
    expect(screen.queryByText("Run your first search")).toBeNull();
  });

  it("mounts the real Your profile heading immediately without a suspense fallback or deferred surface timer", () => {
    const { setTimeoutSpy } = renderCanonicalRoute(
      "/job-finder/profile",
      <JobFinderProfileRoute />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Profile" }),
    ).toBeTruthy();
    expect(screen.queryByText("Loading screen")).toBeNull();
    expect(surfaceTimerCalls(setTimeoutSpy.mock.calls)).toEqual([]);
  });

  it("mounts the real Applications heading immediately without a suspense fallback or deferred surface timer", () => {
    const { setTimeoutSpy } = renderCanonicalRoute(
      "/job-finder/applications",
      <JobFinderApplicationsRoute />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Applications" }),
    ).toBeTruthy();
    expect(screen.queryByText("Loading screen")).toBeNull();
    expect(surfaceTimerCalls(setTimeoutSpy.mock.calls)).toEqual([]);
  });

  it("mounts the real Shortlisted heading immediately with no placeholder, suspense fallback, or deferred surface timer", () => {
    const { setTimeoutSpy } = renderCanonicalRoute(
      "/job-finder/review-queue",
      <JobFinderReviewQueueRoute />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Shortlisted" }),
    ).toBeTruthy();
    expect(screen.queryByText("Loading screen")).toBeNull();
    expect(screen.queryByText("Opening your saved shortlist.")).toBeNull();
    expect(surfaceTimerCalls(setTimeoutSpy.mock.calls)).toEqual([]);
  });
});
