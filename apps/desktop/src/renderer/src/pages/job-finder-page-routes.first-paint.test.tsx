// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { JobSearchCampaignSchema } from "@nestor/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import type { ReactElement } from "react";
import type * as LaunchReadsModule from "@renderer/features/job-finder/lib/launch-reads";
import type { JobFinderPageContext } from "./job-finder-page-context";
import {
  JobFinderProfileRoute,
} from "./job-finder-page-routes";

// What the window read from the database at launch; empty unless a test sets
// it, as the real reads are before they answer.
const launch = vi.hoisted(() => ({
  reads: { counts: null, home: null, context: null } as unknown,
}));
vi.mock(
  "@renderer/features/job-finder/lib/launch-reads",
  async (importOriginal) => ({
    ...(await importOriginal<typeof LaunchReadsModule>()),
    useLaunchReads: () => launch.reads,
  }),
);

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
    discoverySessions: [],
    sourceAccessPrompts: [],
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
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobs: {
          run: vi.fn(() => new Promise(() => {})),
          onChange: () => () => undefined,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    launch.reads = { counts: null, home: null, context: null };
    Reflect.deleteProperty(window, "nestor");
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
});
