// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import type { ReactElement } from "react";
import type {
  JobFinderRendererWorkspaceSnapshot,
  UserActionCommandInput,
} from "@nestor/contracts";
import type { FinishInBrowserInput } from "@renderer/features/job-finder/screens/applications/applications-detail-panel-recovery-actions-section";
import type { JobFinderPageContext } from "./job-finder-page-context";
import {
  JobFinderApplicationsRoute,
  JobFinderActionsRoute,
  getUnavailableApplicationMessage,
  runJobFinderApplicationBrowserHandoff,
  selectCampaignApplicationsScope,
  selectOutcomeAnalyticsScope,
  selectRapidReviewScope,
} from "./job-finder-page-routes";

describe("getUnavailableApplicationMessage", () => {
  it("keeps the exact start failure visible after navigation outruns record creation", () => {
    expect(
      getUnavailableApplicationMessage(
        "The approved answer snapshot could not be read.",
      ),
    ).toBe("The approved answer snapshot could not be read.");
    expect(getUnavailableApplicationMessage("  ")).toBe(
      "The requested application is no longer available or is not unique, so no other application was selected.",
    );
  });
});

// Only the props Applications hands its screen matter here, so the screen
// itself is replaced by a recorder. That keeps this a test of the route's
// wiring instead of a second copy of the Applications screen fixtures.
const { applicationsScreenProps } = vi.hoisted(() => ({
  applicationsScreenProps: {
    current: null as {
      scopeControl?: ReactElement<{
        onSelect: (id: string) => Promise<boolean>;
      }>;
      searchPlanName?: string;
      applicationRecords?: { id: string }[];
      canConfirmFinishedInBrowser?: boolean;
      onConfirmFinishedInBrowser?: (input: FinishInBrowserInput) => void;
      onSubmitPreparedApplication?: (jobId: string) => Promise<void>;
      onPrepareApplicationAgain?: (jobId: string) => Promise<void>;
      onSelectRecord?: (recordId: string) => void;
      selectedRecord?: { id: string } | null;
    } | null,
  },
}));

vi.mock(
  "@renderer/features/job-finder/screens/applications/applications-screen",
  () => ({
    ApplicationsScreen: (props: Record<string, unknown>) => {
      applicationsScreenProps.current = props;
      return null;
    },
  }),
);

function workspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    activeCampaignId: "campaign_1",
    campaigns: [
      {
        id: "campaign_1",
        name: "Campaign One",
        jobIds: ["job_a", "job_b"],
      },
      {
        id: "campaign_2",
        name: "Campaign Two",
        jobIds: ["job_c"],
      },
    ],
    discoveryJobs: [
      { id: "job_a", title: "Job A" },
      { id: "job_b", title: "Job B" },
      { id: "job_c", title: "Job C" },
      { id: "job_d", title: "Job D" },
    ],
    intelligence: {
      rapidReviewLogs: [
        {
          campaignId: "campaign_1",
          entries: [{ id: "decision_1", jobId: "job_a" }],
        },
        {
          campaignId: "campaign_2",
          entries: [{ id: "decision_2", jobId: "job_c" }],
        },
      ],
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("selectRapidReviewScope", () => {
  it("scopes reviewed jobs and the decision log to the active campaign", () => {
    const scope = selectRapidReviewScope(workspace());

    expect(scope.campaign?.id).toBe("campaign_1");
    expect(scope.campaign?.name).toBe("Campaign One");
    expect(scope.jobs.map((job) => job.id)).toEqual(["job_a", "job_b"]);
    expect(scope.log?.campaignId).toBe("campaign_1");
    expect(scope.log?.entries.map((entry) => entry.jobId)).toEqual(["job_a"]);
  });

  it("returns no log when the active campaign has no decisions yet", () => {
    const current = workspace();
    current.intelligence.rapidReviewLogs = [];

    const scope = selectRapidReviewScope(current);

    expect(scope.log).toBeNull();
    expect(scope.jobs.map((job) => job.id)).toEqual(["job_a", "job_b"]);
  });

  it("returns an empty scope when the active campaign id matches nothing", () => {
    const current = workspace();
    current.activeCampaignId = "campaign_missing";

    const scope = selectRapidReviewScope(current);

    expect(scope.campaign).toBeNull();
    expect(scope.jobs).toEqual([]);
    expect(scope.log).toBeNull();
  });
});

describe("selectOutcomeAnalyticsScope", () => {
  it("exposes the active campaign and the outcome analytics inputs", () => {
    const current = workspace();
    current.intelligence.outcomeEvents = [
      {
        id: "outcome_1",
        jobId: "job_a",
        campaignId: "campaign_1",
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["intelligence"]["outcomeEvents"];
    current.intelligence.outcomeAnalytics = {
      generatedAt: "2026-08-15T10:00:00.000Z",
      buckets: [],
    };
    current.intelligence.resumeStrategies = [
      { id: "strategy_1", name: "SWE generalist" },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["intelligence"]["resumeStrategies"];

    const scope = selectOutcomeAnalyticsScope(current);

    expect(scope.activeCampaignId).toBe("campaign_1");
    expect(scope.campaigns.map((campaign) => campaign.id)).toEqual([
      "campaign_1",
      "campaign_2",
    ]);
    expect(scope.events).toHaveLength(1);
    expect(scope.events[0]).toMatchObject({ jobId: "job_a" });
    expect(scope.overview?.buckets).toEqual([]);
    expect(scope.resumeStrategies).toHaveLength(1);
  });

  it("falls back to no events and no overview on a fresh workspace", () => {
    const scope = selectOutcomeAnalyticsScope(workspace());

    expect(scope.events).toEqual([]);
    expect(scope.overview).toBeNull();
    expect(scope.resumeStrategies).toEqual([]);
  });
});

describe("selectCampaignApplicationsScope", () => {
  it("shows saved applications across plans when all plans are requested", () => {
    const saved = applicationWorkspace("campaign_2");
    expect(
      selectCampaignApplicationsScope(saved, true).applicationRecords,
    ).toEqual(saved.applicationRecords);
    expect(selectCampaignApplicationsScope(saved, true).applyRuns).toEqual(
      saved.applyRuns,
    );
  });
  function applicationWorkspace(activeCampaignId: string) {
    return {
      activeCampaignId,
      campaigns: [
        { id: "campaign_1", jobIds: ["job_shared", "job_unique"] },
        { id: "campaign_2", jobIds: ["job_shared"] },
      ],
      discoveryJobs: [{ id: "job_shared" }, { id: "job_unique" }],
      applicationRecords: [
        { id: "record_a", jobId: "job_shared" },
        { id: "record_b", jobId: "job_shared" },
        { id: "record_legacy_unique", jobId: "job_unique" },
        { id: "record_legacy_ambiguous", jobId: "job_shared" },
      ],
      applyRuns: [
        { id: "run_1", campaignId: "campaign_1", jobIds: ["job_shared"] },
        { id: "run_2", campaignId: "campaign_2", jobIds: ["job_shared"] },
        { id: "run_legacy_unique", campaignId: null, jobIds: ["job_unique"] },
        {
          id: "run_legacy_ambiguous",
          campaignId: null,
          jobIds: ["job_shared"],
        },
      ],
      applyJobResults: [
        {
          id: "result_1",
          runId: "run_1",
          jobId: "job_shared",
          applicationRecordId: "record_a",
        },
        {
          id: "result_2",
          runId: "run_2",
          jobId: "job_shared",
          applicationRecordId: "record_b",
        },
        {
          id: "result_legacy_unique",
          runId: "run_legacy_unique",
          jobId: "job_unique",
          applicationRecordId: "record_legacy_unique",
        },
        {
          id: "result_legacy_ambiguous",
          runId: "run_legacy_ambiguous",
          jobId: "job_shared",
          applicationRecordId: "record_legacy_ambiguous",
        },
      ],
      applicationAttempts: [
        {
          id: "attempt_a",
          jobId: "job_shared",
          applicationRecordId: "record_a",
        },
        {
          id: "attempt_b",
          jobId: "job_shared",
          applicationRecordId: "record_b",
        },
        {
          id: "attempt_legacy_unique",
          jobId: "job_unique",
          applicationRecordId: "record_legacy_unique",
        },
      ],
      selectedApplyRunId: "run_1",
    } as unknown as JobFinderRendererWorkspaceSnapshot;
  }

  // F57. Campaign membership is resolved through a per-campaign Set index
  // instead of a linear `jobIds.includes` inside a nested loop. The rule it
  // encodes is unchanged: a legacy run/record belongs to a campaign only when
  // exactly one campaign contains every one of its jobs.
  it("keeps legacy campaign resolution unique-owner-only across multi-job runs", () => {
    const base = {
      activeCampaignId: "campaign_1",
      campaigns: [
        { id: "campaign_1", jobIds: ["job_1", "job_2", "job_3"] },
        { id: "campaign_2", jobIds: ["job_2"] },
        { id: "campaign_3", jobIds: ["job_1", "job_2", "job_3"] },
      ],
      discoveryJobs: [{ id: "job_1" }, { id: "job_2" }, { id: "job_3" }],
      applicationRecords: [],
      applyJobResults: [],
      applicationAttempts: [],
      selectedApplyRunId: null,
    };

    // campaign_1 is the only campaign containing both jobs, so the legacy run
    // resolves to it.
    const uniqueOwner = selectCampaignApplicationsScope({
      ...base,
      applyRuns: [
        { id: "run_span", campaignId: null, jobIds: ["job_1", "job_3"] },
      ],
      campaigns: [base.campaigns[0], base.campaigns[1]],
    } as unknown as JobFinderRendererWorkspaceSnapshot);
    expect(uniqueOwner.applyRuns.map((run) => run.id)).toEqual(["run_span"]);

    // campaign_1 and campaign_3 both contain every job, so ownership is
    // ambiguous and the run belongs to neither.
    const ambiguousOwner = selectCampaignApplicationsScope({
      ...base,
      applyRuns: [
        { id: "run_span", campaignId: null, jobIds: ["job_1", "job_3"] },
      ],
    } as unknown as JobFinderRendererWorkspaceSnapshot);
    expect(ambiguousOwner.applyRuns).toEqual([]);

    // A job outside every campaign resolves to no campaign at all.
    const unowned = selectCampaignApplicationsScope({
      ...base,
      applyRuns: [
        { id: "run_outside", campaignId: null, jobIds: ["job_unknown"] },
      ],
    } as unknown as JobFinderRendererWorkspaceSnapshot);
    expect(unowned.applyRuns).toEqual([]);
  });

  it("switches exact shared-job application lineage with the active campaign", () => {
    const campaignOne = selectCampaignApplicationsScope(
      applicationWorkspace("campaign_1"),
    );
    expect(campaignOne.applicationRecords.map((record) => record.id)).toEqual([
      "record_a",
      "record_legacy_unique",
    ]);
    expect(campaignOne.applyRuns.map((run) => run.id)).toEqual([
      "run_1",
      "run_legacy_unique",
    ]);
    expect(campaignOne.applyJobResults.map((result) => result.id)).toEqual([
      "result_1",
      "result_legacy_unique",
    ]);
    expect(
      campaignOne.applicationAttempts.map((attempt) => attempt.id),
    ).toEqual(["attempt_a", "attempt_legacy_unique"]);
    expect(campaignOne.selectedApplyRunId).toBe("run_1");

    const campaignTwo = selectCampaignApplicationsScope(
      applicationWorkspace("campaign_2"),
    );
    expect(campaignTwo.applicationRecords.map((record) => record.id)).toEqual([
      "record_b",
    ]);
    expect(campaignTwo.applyRuns.map((run) => run.id)).toEqual(["run_2"]);
    expect(campaignTwo.applyJobResults.map((result) => result.id)).toEqual([
      "result_2",
    ]);
    expect(
      campaignTwo.applicationAttempts.map((attempt) => attempt.id),
    ).toEqual(["attempt_b"]);
    expect(campaignTwo.selectedApplyRunId).toBeNull();
  });
});

describe("runJobFinderApplicationBrowserHandoff", () => {
  const target = {
    jobId: "job_a",
    resultId: "result_a",
    runId: "run_a",
    applicationRecordId: "record_a",
    destinationUrl: "https://jobs.example.com/apply/1",
  };

  function pendingRequests(): JobFinderRendererWorkspaceSnapshot["userActionRequests"] {
    return [
      {
        id: "request_a",
        revision: 3,
        state: "pending",
        scope: { type: "application", runId: "run_a", jobId: "job_a" },
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
  }

  it("opens the exact paused application page and reports that, with no submit authority", async () => {
    const onPerformUserAction = vi.fn();
    const onOpenBrowserSession = vi.fn();

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession,
      onPerformUserAction,
      requests: pendingRequests(),
      target,
    });

    expect(outcome).toEqual({ kind: "opened_application_page" });
    expect(onOpenBrowserSession).not.toHaveBeenCalled();
    expect(onPerformUserAction).toHaveBeenCalledTimes(1);
    expect(onPerformUserAction.mock.calls[0]?.[0]).toMatchObject({
      requestId: "request_a",
      expectedRevision: 3,
      action: "open_page",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  });

  it("reports opening only the window when there is no recorded step to reopen", async () => {
    // The fall-back opens a bare browser session. Reporting this as
    // "opened the application page" sent the user to a window that never
    // showed the step.
    const onPerformUserAction = vi.fn();
    const onOpenBrowserSession = vi.fn();

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession,
      onPerformUserAction,
      requests: [],
      target,
    });

    expect(outcome).toEqual({ kind: "opened_browser_only" });
    expect(onPerformUserAction).not.toHaveBeenCalled();
    expect(onOpenBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("brings a closed form back, reporting each step, before handing it over", async () => {
    const phases: string[] = [];
    const order: string[] = [];
    const onReopenApplicationPage = vi.fn(
      async (
        resultId: string,
        onProgress: (progress: {
          resultId: string;
          phase: "opening" | "refilling" | "verifying" | "ready";
        }) => void,
      ) => {
        order.push("reopen");
        for (const phase of [
          "opening",
          "refilling",
          "verifying",
          "ready",
        ] as const)
          onProgress({ resultId, phase });
        return { resultId, state: "open" as const, reason: null };
      },
    );
    const onFocusPreparedApplicationPage = vi.fn(() => {
      order.push("focus");
      return Promise.resolve(true);
    });

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onFocusPreparedApplicationPage,
      onOpenBrowserSession: vi.fn(),
      onPerformUserAction: vi.fn(),
      readApplicationPageState: (resultId) =>
        Promise.resolve({ resultId, state: "reopenable", reason: null }),
      onReopenApplicationPage,
      onReopenProgress: (phase) => phases.push(phase),
      requests: [],
      target,
    });

    expect(outcome).toEqual({ kind: "opened_application_page" });
    expect(order).toEqual(["reopen", "focus"]);
    expect(phases).toEqual(["opening", "refilling", "verifying", "ready"]);
  });

  it("keeps a form that did not come back saved and does not hand anything over", async () => {
    const onFocusPreparedApplicationPage = vi.fn(() => Promise.resolve(true));

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onFocusPreparedApplicationPage,
      onOpenBrowserSession: vi.fn(),
      onPerformUserAction: vi.fn(),
      readApplicationPageState: (resultId) =>
        Promise.resolve({ resultId, state: "reopenable", reason: null }),
      onReopenApplicationPage: (resultId) =>
        Promise.resolve({
          resultId,
          state: "reopenable",
          reason: "reopen_failed",
        }),
      requests: [],
      target,
    });

    expect(outcome).toMatchObject({ kind: "failed" });
    expect(onFocusPreparedApplicationPage).not.toHaveBeenCalled();
  });

  it("focuses the exact prepared result when review has no pending step", async () => {
    const onFocusPreparedApplicationPage = vi.fn(() => Promise.resolve(true));
    const onOpenBrowserSession = vi.fn();
    const onPerformUserAction = vi.fn();

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onFocusPreparedApplicationPage,
      onOpenBrowserSession,
      onPerformUserAction,
      requests: [],
      target,
    });

    expect(outcome).toEqual({ kind: "opened_application_page" });
    expect(onFocusPreparedApplicationPage).toHaveBeenCalledWith(target);
    expect(onOpenBrowserSession).not.toHaveBeenCalled();
    expect(onPerformUserAction).not.toHaveBeenCalled();
  });

  it("reports a missing prepared-result binding without opening an arbitrary browser tab", async () => {
    const onFocusPreparedApplicationPage = vi.fn(() => Promise.resolve(false));
    const onOpenBrowserSession = vi.fn();

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onFocusPreparedApplicationPage,
      onOpenBrowserSession,
      onPerformUserAction: vi.fn(),
      requests: [],
      target,
    });

    expect(outcome).toEqual({ kind: "failed", reason: "" });
    expect(onOpenBrowserSession).not.toHaveBeenCalled();
  });

  it("reports a failure with its reason instead of claiming the page opened", async () => {
    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: vi.fn(),
      onPerformUserAction: vi.fn(() => {
        throw new Error("The browser runtime is disabled");
      }),
      requests: pendingRequests(),
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "The browser runtime is disabled",
    });
  });

  // The production hands are asynchronous. A revision of this function wrapped
  // a call whose promise its own context wrapper discarded in `try`/`catch`:
  // nothing could throw synchronously, so `failed` was unreachable outside a
  // test that injected a synchronously-throwing double, and a failing IPC still
  // reported "Opened in the Job Finder browser".
  it("reports a rejected open-page command as a failure instead of claiming the page opened", async () => {
    const onOpenBrowserSession = vi.fn();
    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession,
      onPerformUserAction: vi.fn(() =>
        Promise.reject(new Error("The browser runtime is disabled")),
      ),
      requests: pendingRequests(),
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "The browser runtime is disabled",
    });
    expect(onOpenBrowserSession).not.toHaveBeenCalled();
  });

  it("treats the action runner's own `false` as a failure, not a silent success", async () => {
    // `runAction` reports a failed command by resolving `false` after writing
    // its own route message, so the promise never rejects. Reading only
    // rejections would report success for every command main refused.
    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: vi.fn(),
      onPerformUserAction: vi.fn(() => Promise.resolve(false)),
      requests: pendingRequests(),
      target,
    });

    expect(outcome).toEqual({ kind: "failed", reason: "" });
  });

  it("reports a rejected bare-window open as a failure too", async () => {
    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: vi.fn(() =>
        Promise.reject(new Error("No browser session could be started")),
      ),
      onPerformUserAction: vi.fn(),
      requests: [],
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "No browser session could be started",
    });
  });

  it("treats a `false` bare-window open as a failure too", async () => {
    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: vi.fn(() => Promise.resolve(false)),
      onPerformUserAction: vi.fn(),
      requests: [],
      target,
    });

    expect(outcome).toEqual({ kind: "failed", reason: "" });
  });

  it("does not aim the open at a request main refuses to transition", async () => {
    // A second run supersedes the first run's request. Sending the open at a
    // superseded row could only fail, so the window opens instead and the
    // outcome says exactly that.
    const onPerformUserAction = vi.fn();
    const onOpenBrowserSession = vi.fn();
    const superseded = [
      {
        id: "request_superseded",
        revision: 3,
        state: "superseded",
        scope: { type: "application", runId: "run_a", jobId: "job_a" },
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession,
      onPerformUserAction,
      requests: superseded,
      target,
    });

    expect(outcome).toEqual({ kind: "opened_browser_only" });
    expect(onPerformUserAction).not.toHaveBeenCalled();
    expect(onOpenBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("reports a failed bare-window open as a failure too", async () => {
    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: vi.fn(() => {
        throw new Error("No browser session could be started");
      }),
      onPerformUserAction: vi.fn(),
      requests: [],
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "No browser session could be started",
    });
  });
});

/**
 * "Check whether this step is done" is gated on the pending browser-step
 * request for the selected application, and the same request supplies the
 * in-place "Checking…" / "still blocked" text. The command it sends used to
 * run a second, run-scoped lookup and `return` silently when that matched
 * nothing, so a request left over from an earlier run for the same job left
 * the control enabled while pressing it did nothing at all. Gate, status, and
 * command now read one request.
 */
describe("Applications browser-step confirmation", () => {
  function selectedRecordWorkspace(
    userActionRequests: unknown[],
    options?: { secondRecord?: boolean },
  ): JobFinderRendererWorkspaceSnapshot {
    // `record_a` stays first so it is the record Applications selects.
    const applicationRecords = options?.secondRecord
      ? [
          { id: "record_a", jobId: "job_a" },
          { id: "record_b", jobId: "job_a" },
        ]
      : [{ id: "record_a", jobId: "job_a" }];
    const applyJobResults = options?.secondRecord
      ? [
          {
            id: "result_a",
            runId: "run_current",
            jobId: "job_a",
            applicationRecordId: "record_a",
          },
          {
            id: "result_b",
            runId: "run_current",
            jobId: "job_a",
            applicationRecordId: "record_b",
          },
        ]
      : [
          {
            id: "result_a",
            runId: "run_current",
            jobId: "job_a",
            applicationRecordId: "record_a",
          },
        ];

    return {
      hydration: { phase: "ready", deferredCollections: [] },
      activeCampaignId: "campaign_1",
      campaigns: [
        { id: "campaign_1", name: "Campaign One", jobIds: ["job_a"] },
      ],
      dashboard: null,
      discoveryJobs: [{ id: "job_a", title: "Job A" }],
      applicationRecords,
      applicationAttempts: [],
      applyRuns: [
        { id: "run_current", campaignId: "campaign_1", jobIds: ["job_a"] },
      ],
      applyJobResults,
      selectedApplyRunId: null,
      settings: {},
      intelligence: {
        companies: [],
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
      userActionRequests,
    } as unknown as JobFinderRendererWorkspaceSnapshot;
  }

  function renderApplicationsRoute(input: {
    actionMessage?: string;
    expectUnavailable?: boolean;
    initialEntry?: string;
    isPending?: (scope: string) => boolean;
    onPerformUserAction: ReturnType<typeof vi.fn>;
    onSelectApplicationRecord?: ReturnType<typeof vi.fn>;
    onSelectCampaign?: ReturnType<typeof vi.fn>;
    onSubmitPreparedApplication?: (jobId: string) => Promise<void>;
    onStartApplyCopilot?: JobFinderPageContext["onStartApplyCopilot"];
    workspace: JobFinderRendererWorkspaceSnapshot;
  }) {
    const handlerStubs = new Map<string | symbol, () => undefined>();
    const base = {
      actionState: { message: input.actionMessage ?? null },
      isAnyPending: () => false,
      isPending: input.isPending ?? (() => false),
      liveDiscoveryEvents: [],
      onNavigateSafely: vi.fn(),
      onPerformUserAction: input.onPerformUserAction,
      onStartApplyCopilot: input.onStartApplyCopilot ?? vi.fn(),
      onSubmitPreparedApplication:
        input.onSubmitPreparedApplication ?? vi.fn(() => Promise.resolve()),
      onSelectApplicationRecord: input.onSelectApplicationRecord ?? vi.fn(),
      onSelectCampaign: input.onSelectCampaign ?? vi.fn(),
      saveState: { state: "idle", version: 0 },
      selectedApplicationAttempt: null,
      selectedApplicationRecord: null,
      workspace: input.workspace,
    };
    const context = new Proxy(base, {
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

    render(
      <MemoryRouter
        initialEntries={[input.initialEntry ?? "/job-finder/applications"]}
      >
        <Routes>
          <Route path="/job-finder" element={<Outlet context={context} />}>
            <Route
              path="applications"
              element={<JobFinderApplicationsRoute />}
            />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const props = applicationsScreenProps.current;
    if (!props && !input.expectUnavailable) {
      throw new Error("Applications did not render its screen.");
    }

    return props ?? {};
  }

  beforeEach(() => {
    if (typeof globalThis.crypto?.randomUUID !== "function") {
      vi.stubGlobal("crypto", {
        randomUUID: () => "00000000-0000-4000-8000-000000000000",
      });
    }
  });

  afterEach(() => {
    cleanup();
    applicationsScreenProps.current = null;
    vi.unstubAllGlobals();
  });

  it("switches the Applications view without changing the app's current plan", async () => {
    const saved = selectedRecordWorkspace([]);
    saved.campaigns.push({
      ...saved.campaigns[0]!,
      id: "campaign_empty",
      name: "Empty plan",
      jobIds: [],
    });
    const onSelectCampaign = vi.fn();
    renderApplicationsRoute({
      workspace: saved,
      onPerformUserAction: vi.fn(),
      onSelectCampaign,
    });
    await act(async () => {
      await applicationsScreenProps.current?.scopeControl?.props.onSelect(
        "campaign_empty",
      );
    });
    expect(applicationsScreenProps.current?.searchPlanName).toBe("Empty plan");
    expect(applicationsScreenProps.current?.applicationRecords).toEqual([]);
    expect(onSelectCampaign).not.toHaveBeenCalled();
    expect(saved.activeCampaignId).toBe("campaign_1");
  });

  it("shows the start failure and retries the exact job with one press when no record was created", () => {
    const current = selectedRecordWorkspace([]);
    current.applicationRecords = [];
    current.applyRuns = [];
    current.applyJobResults = [];
    const onStartApplyCopilot = vi.fn();
    renderApplicationsRoute({
      actionMessage: "The AI provider key is missing.",
      expectUnavailable: true,
      initialEntry: "/job-finder/applications?jobId=job_a",
      onPerformUserAction: vi.fn(),
      onStartApplyCopilot,
      workspace: current,
    });

    expect(screen.getByText("The AI provider key is missing.")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Could not start application" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onStartApplyCopilot).toHaveBeenCalledExactlyOnceWith({
      jobId: "job_a",
    });
  });

  it.each([
    "/job-finder/applications?jobId=missing_job",
    "/job-finder/applications?jobId=job_a&applicationRecordId=missing_record",
  ])(
    "does not start a replacement for an unavailable target at %s",
    (initialEntry) => {
      const onStartApplyCopilot = vi.fn();
      renderApplicationsRoute({
        expectUnavailable: true,
        initialEntry,
        onPerformUserAction: vi.fn(),
        onStartApplyCopilot,
        workspace: selectedRecordWorkspace([]),
      });
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(
        screen.getByRole("button", { name: "Show all applications" }),
      ).toBeTruthy();
      expect(onStartApplyCopilot).not.toHaveBeenCalled();
    },
  );

  it("opens a linked application in its own search plan", async () => {
    const current = selectedRecordWorkspace([]);
    current.campaigns.push({
      id: "campaign_2",
      name: "Campaign Two",
      jobIds: ["job_b"],
    } as JobFinderRendererWorkspaceSnapshot["campaigns"][number]);
    current.discoveryJobs.push({
      id: "job_b",
      title: "Job B",
    } as JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number]);
    current.applicationRecords.push({
      id: "record_b",
      jobId: "job_b",
    } as JobFinderRendererWorkspaceSnapshot["applicationRecords"][number]);
    const onSelectCampaign = vi.fn(() => new Promise<boolean>(() => undefined));

    renderApplicationsRoute({
      expectUnavailable: true,
      initialEntry: "/job-finder/applications?applicationRecordId=record_b",
      onPerformUserAction: vi.fn(),
      onSelectCampaign,
      workspace: current,
    });

    await waitFor(() =>
      expect(onSelectCampaign).toHaveBeenCalledExactlyOnceWith("campaign_2"),
    );
    expect(screen.queryByText("Application unavailable")).toBeNull();
  });

  it("does not switch plans for a stale application ID", () => {
    const onSelectCampaign = vi.fn();
    renderApplicationsRoute({
      expectUnavailable: true,
      initialEntry:
        "/job-finder/applications?applicationRecordId=missing_record",
      onPerformUserAction: vi.fn(),
      onSelectCampaign,
      workspace: selectedRecordWorkspace([]),
    });

    expect(screen.getByText("Application unavailable")).toBeTruthy();
    expect(onSelectCampaign).not.toHaveBeenCalled();
  });

  it("retries a declined switch for a linked application", async () => {
    const current = selectedRecordWorkspace([]);
    current.campaigns.push({
      id: "campaign_2",
      name: "Campaign Two",
      jobIds: ["job_b"],
    } as JobFinderRendererWorkspaceSnapshot["campaigns"][number]);
    current.applicationRecords.push({
      id: "record_b",
      jobId: "job_b",
    } as JobFinderRendererWorkspaceSnapshot["applicationRecords"][number]);
    const onSelectCampaign = vi.fn(() => Promise.resolve(false));
    renderApplicationsRoute({
      expectUnavailable: true,
      initialEntry: "/job-finder/applications?applicationRecordId=record_b",
      onPerformUserAction: vi.fn(),
      onSelectCampaign,
      workspace: current,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Switch to Campaign Two" }),
    );
    await waitFor(() => expect(onSelectCampaign).toHaveBeenCalledTimes(2));
  });

  it("does not show an older same-job record while a new application is starting", () => {
    const onSelectApplicationRecord = vi.fn();
    const props = renderApplicationsRoute({
      initialEntry: "/job-finder/applications?jobId=job_a",
      isPending: () => true,
      onPerformUserAction: vi.fn(),
      onSelectApplicationRecord,
      workspace: selectedRecordWorkspace([]),
    });

    expect(props.selectedRecord).toBeNull();
    props.onSelectRecord?.("record_a");
    expect(onSelectApplicationRecord).not.toHaveBeenCalled();
  });

  it("selects the record owned by the newest active same-job result", () => {
    const current = selectedRecordWorkspace([], { secondRecord: true });
    current.applicationRecords = [
      {
        id: "record_a",
        jobId: "job_a",
        lastUpdatedAt: "2026-09-22T01:00:00.000Z",
      },
      {
        id: "record_b",
        jobId: "job_a",
        lastUpdatedAt: "2026-09-22T02:00:00.000Z",
      },
    ] as typeof current.applicationRecords;
    current.applyRuns = [
      {
        id: "run_current",
        campaignId: "campaign_1",
        jobIds: ["job_a"],
        state: "running",
      },
    ] as typeof current.applyRuns;
    current.applyJobResults = [
      {
        id: "result_a",
        runId: "run_current",
        jobId: "job_a",
        applicationRecordId: "record_a",
        state: "cancelled",
        updatedAt: "2026-09-22T01:00:00.000Z",
      },
      {
        id: "result_b",
        runId: "run_current",
        jobId: "job_a",
        applicationRecordId: "record_b",
        state: "filling",
        updatedAt: "2026-09-22T02:00:00.000Z",
      },
    ] as typeof current.applyJobResults;

    const props = renderApplicationsRoute({
      initialEntry: "/job-finder/applications?jobId=job_a",
      onPerformUserAction: vi.fn(),
      workspace: current,
    });

    expect(props.selectedRecord?.id).toBe("record_b");
  });

  it("sends the confirmation for the pending request the control is enabled by, even when it came from an earlier run", () => {
    const onPerformUserAction = vi.fn();
    const props = renderApplicationsRoute({
      onPerformUserAction,
      workspace: selectedRecordWorkspace([
        {
          id: "request_earlier_run",
          revision: 5,
          state: "pending",
          scope: { type: "application", runId: "run_previous", jobId: "job_a" },
        },
      ]),
    });

    expect(props.canConfirmFinishedInBrowser).toBe(true);

    props.onConfirmFinishedInBrowser?.({
      jobId: "job_a",
      resultId: "result_a",
      runId: "run_current",
      applicationRecordId: "record_a",
      destinationUrl: null,
    });

    expect(onPerformUserAction).toHaveBeenCalledTimes(1);
    expect(onPerformUserAction.mock.calls[0]?.[0]).toMatchObject({
      requestId: "request_earlier_run",
      expectedRevision: 5,
      action: "confirm_done",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  });

  it("reprepares a closed review page on the selected application record in one action", async () => {
    const onStartApplyCopilot = vi.fn();
    const props = renderApplicationsRoute({
      onPerformUserAction: vi.fn(),
      workspace: selectedRecordWorkspace([], { secondRecord: true }),
      onStartApplyCopilot,
    });

    expect(props.onPrepareApplicationAgain).toBeTypeOf("function");
    await props.onPrepareApplicationAgain?.("job_a");
    expect(onStartApplyCopilot).toHaveBeenCalledExactlyOnceWith({
      jobId: "job_a",
      applicationRecordId: "record_a",
    });
    await expect(
      props.onPrepareApplicationAgain?.("different_job"),
    ).rejects.toThrow("Select this application again before retrying.");
    expect(onStartApplyCopilot).toHaveBeenCalledTimes(1);
  });

  it("wires the Ask-before-sending action into Applications", async () => {
    const onSubmitPreparedApplication = vi.fn(() => Promise.resolve());
    const props = renderApplicationsRoute({
      onPerformUserAction: vi.fn(),
      workspace: selectedRecordWorkspace([]),
      onSubmitPreparedApplication,
    });

    await props.onSubmitPreparedApplication?.("job_a");

    expect(onSubmitPreparedApplication).toHaveBeenCalledWith("job_a");
  });

  it("still sends the confirmation when the pending request came from the visible run", () => {
    const onPerformUserAction = vi.fn();
    const props = renderApplicationsRoute({
      onPerformUserAction,
      workspace: selectedRecordWorkspace([
        {
          id: "request_current_run",
          revision: 2,
          state: "pending",
          scope: { type: "application", runId: "run_current", jobId: "job_a" },
        },
      ]),
    });

    expect(props.canConfirmFinishedInBrowser).toBe(true);

    props.onConfirmFinishedInBrowser?.({
      jobId: "job_a",
      resultId: "result_a",
      runId: "run_current",
      applicationRecordId: "record_a",
      destinationUrl: null,
    });

    expect(onPerformUserAction).toHaveBeenCalledTimes(1);
    expect(onPerformUserAction.mock.calls[0]?.[0]).toMatchObject({
      requestId: "request_current_run",
      action: "confirm_done",
      submitAuthorized: false,
    });
  });

  it("keeps the control unavailable when nothing pending is left to confirm", () => {
    const onPerformUserAction = vi.fn();
    const props = renderApplicationsRoute({
      onPerformUserAction,
      workspace: selectedRecordWorkspace([
        {
          id: "request_resolved",
          revision: 4,
          state: "resolved",
          scope: { type: "application", runId: "run_current", jobId: "job_a" },
        },
        {
          id: "request_other_job",
          revision: 1,
          state: "pending",
          scope: { type: "application", runId: "run_other", jobId: "job_z" },
        },
      ]),
    });

    expect(props.canConfirmFinishedInBrowser).toBe(false);

    props.onConfirmFinishedInBrowser?.({
      jobId: "job_a",
      resultId: "result_a",
      runId: "run_current",
      applicationRecordId: "record_a",
      destinationUrl: null,
    });

    expect(onPerformUserAction).not.toHaveBeenCalled();
  });

  it("skips a superseded earlier-run request in favour of the live one", () => {
    // A second run of the same job supersedes the first run's request with the
    // newer request's own timestamp, and requests arrive sorted by updatedAt
    // descending then id ascending, so the superseded row can sort first.
    // Sending its id would make main throw on a terminal transition, leaving
    // the live step with no way to be confirmed from Applications.
    const onPerformUserAction = vi.fn();
    const props = renderApplicationsRoute({
      onPerformUserAction,
      workspace: selectedRecordWorkspace([
        {
          id: "application_login_fp",
          revision: 6,
          state: "superseded",
          scope: {
            type: "application",
            runId: "run_previous",
            jobId: "job_a",
            applicationRecordId: "record_a",
          },
        },
        {
          id: "application_manual_answer_fp",
          revision: 2,
          state: "pending",
          scope: {
            type: "application",
            runId: "run_current",
            jobId: "job_a",
            applicationRecordId: "record_a",
          },
        },
      ]),
    });

    expect(props.canConfirmFinishedInBrowser).toBe(true);

    props.onConfirmFinishedInBrowser?.({
      jobId: "job_a",
      resultId: "result_a",
      runId: "run_current",
      applicationRecordId: "record_a",
      destinationUrl: null,
    });

    expect(onPerformUserAction).toHaveBeenCalledTimes(1);
    expect(onPerformUserAction.mock.calls[0]?.[0]).toMatchObject({
      requestId: "application_manual_answer_fp",
      expectedRevision: 2,
      action: "confirm_done",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  });

  it.each(["skipped", "cancelled", "expired", "superseded"])(
    "keeps the control unavailable when the only request is %s",
    (state) => {
      const onPerformUserAction = vi.fn();
      const props = renderApplicationsRoute({
        onPerformUserAction,
        workspace: selectedRecordWorkspace([
          {
            id: `request_${state}`,
            revision: 3,
            state,
            scope: {
              type: "application",
              runId: "run_current",
              jobId: "job_a",
              applicationRecordId: "record_a",
            },
          },
        ]),
      });

      expect(props.canConfirmFinishedInBrowser).toBe(false);

      props.onConfirmFinishedInBrowser?.({
        jobId: "job_a",
        resultId: "result_a",
        runId: "run_current",
        applicationRecordId: "record_a",
        destinationUrl: null,
      });

      expect(onPerformUserAction).not.toHaveBeenCalled();
    },
  );

  it("confirms the selected record's own step when the job has two records", () => {
    // A job shared by two campaigns has two application records with two
    // separate blockers. Confirming here must never resume the record the user
    // is not looking at, which would spend preparation capacity on it.
    const onPerformUserAction = vi.fn();
    const props = renderApplicationsRoute({
      onPerformUserAction,
      workspace: selectedRecordWorkspace(
        [
          {
            id: "application_login_other_record",
            revision: 9,
            state: "awaiting_user",
            scope: {
              type: "application",
              runId: "run_current",
              jobId: "job_a",
              applicationRecordId: "record_b",
            },
          },
          {
            id: "application_manual_answer_selected_record",
            revision: 4,
            state: "pending",
            scope: {
              type: "application",
              runId: "run_current",
              jobId: "job_a",
              applicationRecordId: "record_a",
            },
          },
        ],
        { secondRecord: true },
      ),
    });

    expect(props.selectedRecord?.id).toBe("record_a");
    expect(props.canConfirmFinishedInBrowser).toBe(true);

    props.onConfirmFinishedInBrowser?.({
      jobId: "job_a",
      resultId: "result_a",
      runId: "run_current",
      applicationRecordId: "record_a",
      destinationUrl: null,
    });

    expect(onPerformUserAction).toHaveBeenCalledTimes(1);
    expect(onPerformUserAction.mock.calls[0]?.[0]).toMatchObject({
      requestId: "application_manual_answer_selected_record",
      expectedRevision: 4,
      action: "confirm_done",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
  });

  it("keeps the control unavailable when only another record of the same job is blocked", () => {
    const onPerformUserAction = vi.fn();
    const props = renderApplicationsRoute({
      onPerformUserAction,
      workspace: selectedRecordWorkspace(
        [
          {
            id: "application_login_other_record",
            revision: 9,
            state: "awaiting_user",
            scope: {
              type: "application",
              runId: "run_current",
              jobId: "job_a",
              applicationRecordId: "record_b",
            },
          },
        ],
        { secondRecord: true },
      ),
    });

    expect(props.selectedRecord?.id).toBe("record_a");
    expect(props.canConfirmFinishedInBrowser).toBe(false);

    props.onConfirmFinishedInBrowser?.({
      jobId: "job_a",
      resultId: "result_a",
      runId: "run_current",
      applicationRecordId: "record_a",
      destinationUrl: null,
    });

    expect(onPerformUserAction).not.toHaveBeenCalled();
  });
});

const actionsRouteProps = vi.hoisted(() => ({
  current: null as {
    onCommand: (command: UserActionCommandInput) => Promise<void>;
  } | null,
}));
vi.mock("@renderer/features/job-finder/screens/actions/actions-screen", () => ({
  ActionsScreen: (props: {
    onCommand: (command: UserActionCommandInput) => Promise<void>;
  }) => {
    actionsRouteProps.current = props;
    return null;
  },
}));
it("Needs you returns a rejected answer command to the form so the failure is visible", async () => {
  const onPerformUserAction = vi.fn(() =>
    Promise.reject(new Error("This answer changed in another view")),
  );
  const current = workspace();
  current.hydration = {
    phase: "complete",
    deferredCollections: [],
  };
  current.userActionRequests = [];
  const base = {
    workspace: current,
    onPerformUserAction,
    isPending: () => false,
  };
  const context = new Proxy(base, {
    get: (target, key) =>
      key in target ? target[key as keyof typeof target] : () => undefined,
  }) as unknown as JobFinderPageContext;
  render(
    <MemoryRouter initialEntries={["/job-finder/actions"]}>
      <Routes>
        <Route path="/job-finder" element={<Outlet context={context} />}>
          <Route path="actions" element={<JobFinderActionsRoute />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  const command = {
    action: "submit_manual_answer" as const,
    requestId: "request_a",
    commandId: "answer_a",
    expectedRevision: 1,
    answer: "Yes",
    saveForFuture: false,
    credentialsPolicy: "browser_only" as const,
    submitAuthorized: false as const,
    accountCreationAuthorized: false as const,
  };
  await waitFor(() => expect(actionsRouteProps.current).not.toBeNull());
  await expect(actionsRouteProps.current!.onCommand(command)).rejects.toThrow(
    "This answer changed in another view",
  );
  expect(onPerformUserAction).toHaveBeenCalledWith(command, {
    rethrowError: true,
  });
});
