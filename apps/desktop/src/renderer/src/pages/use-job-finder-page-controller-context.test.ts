import {
  clearUiResumeBatch,
  syncUiResumeBatch,
} from "../../../main/services/assistant/ui-resume-batch";
import type {
  AssistantResumeBatchState,
  ResumeBatchGenerationProgress,
} from "@nestor/contracts";
import { ApplicationCrmBulkStageMutationInputSchema } from "@nestor/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject, SetStateAction } from "react";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import type { PendingActionState } from "./job-finder-pending-actions";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import { buildJobFinderPageContext } from "./use-job-finder-page-controller-context";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import type { DiscoveryRunFeedback } from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import { createJobFinderSaveCoordinator } from "./job-finder-save-state";
import { runJobFinderApplicationBrowserHandoff } from "./job-finder-page-routes";
import { formatJobFinderBrowserHandoffFailedStatus } from "@renderer/features/job-finder/lib/job-finder-browser-handoff-copy";

type BatchGenerate = Window["nestor"]["jobFinder"]["generateResumeForBatch"];
type BatchProgressListener = (progress: ResumeBatchGenerationProgress) => void;
const progressListeners = new Set<BatchProgressListener>();
const unsubscribeProgress = vi.fn();

beforeEach(() => {
  clearUiResumeBatch();
  progressListeners.clear();
  unsubscribeProgress.mockClear();
  vi.stubGlobal("window", {
    nestor: {
      jobFinder: {
        onResumeBatchProgress: (listener: BatchProgressListener) => {
          progressListeners.add(listener);
          return () => {
            progressListeners.delete(listener);
            unsubscribeProgress();
          };
        },
      },
      assistant: {
        syncResumeBatch: (state: AssistantResumeBatchState) =>
          Promise.resolve(syncUiResumeBatch(state)),
      },
    },
  });
});
function buildContext(overrides: {
  actions: Partial<JobFinderShellActions>;
  batchGenerate?: BatchGenerate;
  workspace?: JobFinderRendererWorkspaceSnapshot;
  latestWorkspaceRef?: MutableRefObject<JobFinderRendererWorkspaceSnapshot | null>;
}) {
  let actionState: ActionState = { message: null };
  const actionMessages: (string | null)[] = [];
  let pendingActionState: PendingActionState = {};
  let discoveryRunFeedback: DiscoveryRunFeedback | null = null;
  const workspace =
    overrides.workspace ??
    ({
      activeCampaignId: "campaign_active",
    } as JobFinderRendererWorkspaceSnapshot);
  // Existing command stubs represent the service's work. The controller talks
  // only to the new typed receipt bridge and receives no workspace per job.
  const generateResumeForBatch = vi.fn<BatchGenerate>(
    overrides.batchGenerate ??
      (async ({ jobId }) => {
        if (!overrides.actions.generateResume)
          throw new Error("This test must provide a batch generation stub.");
        await overrides.actions.generateResume(jobId);
        return { jobId, outcome: "written" };
      }),
  );
  if (window.nestor.jobFinder)
    window.nestor.jobFinder.generateResumeForBatch = generateResumeForBatch;
  const setActionState = (next: SetStateAction<ActionState>) => {
    actionState = typeof next === "function" ? next(actionState) : next;
    actionMessages.push(actionState.message);
  };
  const setPendingActionState = (next: SetStateAction<PendingActionState>) => {
    pendingActionState =
      typeof next === "function" ? next(pendingActionState) : next;
  };
  const setDiscoveryRunFeedback = (
    next: SetStateAction<DiscoveryRunFeedback | null>,
  ) => {
    discoveryRunFeedback =
      typeof next === "function" ? next(discoveryRunFeedback) : next;
  };
  const saveCoordinator = createJobFinderSaveCoordinator({
    onStateChange: vi.fn(),
  });
  const context = buildJobFinderPageContext({
    actionState,
    actions: overrides.actions as JobFinderShellActions,
    activeRouteResumeAssistantMessages: [],
    activeRouteResumeAssistantPending: false,
    activeRouteResumeWorkspace: null,
    canImportResume: true,
    confirmLeaveDirtyResumeWorkspace: () => Promise.resolve(true),
    importResumeGuardMessage: null,
    isAnyPendingAction: () => false,
    isPendingAction: () => false,
    isCurrentResumeAssistantRequest: () => false,
    isCurrentResumeWorkspaceJob: () => false,
    liveDiscoveryEvents: [],
    latestWorkspaceRef: overrides.latestWorkspaceRef ?? { current: workspace },
    getLocationPathname: () => "/job-finder/home",
    navigate: vi.fn(),
    navigateSafely: vi.fn(),
    profileCopilotBusy: false,
    resumeImportProgress: null,
    profileCopilotPendingContextKey: null,
    profileCopilotRequestTokenRef: { current: 0 },
    requestApplyCopilotVisualCheckpoints: vi.fn(),
    profileSetupState: null,
    saveCoordinator,
    saveState: { state: "idle", version: 0 },
    refreshResumeWorkspace: () => Promise.resolve(false),
    resumeAssistantRequestTokenRef: { current: 0 },
    selectedApplicationAttempt: null,
    selectedApplicationRecord: null,
    selectedDiscoveryJob: null,
    selectedReviewItem: null,
    selectedReviewJob: null,
    selectedTailoredAsset: null,
    setPendingActionState,
    setActionState,
    setDiscoveryRunFeedback,
    setLiveDiscoveryEvents: vi.fn(),
    setOptimisticProfileCopilotMessages: vi.fn(),
    setProfileCopilotBusy: vi.fn(),
    setProfileCopilotPendingContextKey: vi.fn(),
    setProfileSurfaceDirty: vi.fn(),
    setSearchPlanSurfaceDirty: vi.fn(),
    setResumeAssistantMessages: vi.fn(),
    setResumeAssistantPending: vi.fn(),
    setResumeWorkspace: vi.fn(),
    clearResumeWorkspaceState: vi.fn(),
    setResumeWorkspaceDirty: vi.fn(),
    setSelectedApplicationRecordId: vi.fn(),
    setSelectedDiscoveryJobId: vi.fn(),
    setSelectedReviewJobId: vi.fn(),
    sourceDebugRunIdRef: { current: 0 },
    workspace,
  } as unknown as Parameters<typeof buildJobFinderPageContext>[0]);

  return {
    context,
    getActionState: () => actionState,
    getActionMessages: () => actionMessages,
    getPendingActionState: () => pendingActionState,
    getDiscoveryRunFeedback: () => discoveryRunFeedback,
    generateResumeForBatch,
  };
}

describe("buildJobFinderPageContext campaign schedule and notifications", () => {
  it("exposes onRunCampaignNow through the page controller with a pending scope", async () => {
    const runCampaignNow = vi
      .fn<JobFinderShellActions["runCampaignNow"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getPendingActionState, getActionState } = buildContext({
      actions: { runCampaignNow },
    });

    const completed = await context.onRunCampaignNow("campaign_b");

    expect(runCampaignNow).toHaveBeenCalledWith("campaign_b");
    expect(completed).toBe(true);
    expect(getPendingActionState()).toEqual({});
    expect(getActionState().message).toMatch(/searches and reads listings/i);
    expect(getActionState().message).toMatch(
      /does not fill application forms/i,
    );
  });

  it("defaults run-now to the active campaign when no id is supplied", async () => {
    const runCampaignNow = vi
      .fn<JobFinderShellActions["runCampaignNow"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context } = buildContext({
      actions: { runCampaignNow },
      workspace: {
        activeCampaignId: "campaign_active",
      } as JobFinderRendererWorkspaceSnapshot,
    });

    await context.onRunCampaignNow();

    expect(runCampaignNow).toHaveBeenCalledWith(undefined);
  });

  it("freezes campaign-run feedback from that plan's own completed ledger", async () => {
    const runCampaignNow = vi
      .fn<JobFinderShellActions["runCampaignNow"]>()
      .mockResolvedValue({
        recentDiscoveryRuns: [
          {
            id: "run_campaign_b",
            campaignId: "campaign_b",
            state: "completed",
            startedAt: "2026-09-12T10:00:00.000Z",
            summary: {
              report: {
                measuredAt: "2026-09-12T10:01:00.000Z",
                found: 5,
                new: 0,
                retained: 15,
                duplicates: 5,
                worthOpening: 5,
              },
            },
          },
        ],
      } as unknown as JobFinderRendererWorkspaceSnapshot);
    const { context, getDiscoveryRunFeedback } = buildContext({
      actions: { runCampaignNow },
    });

    await context.onRunCampaignNow("campaign_b");

    expect(getDiscoveryRunFeedback()?.headline).toContain(
      "5 found · 0 new · 15 kept · 5 already here",
    );
  });

  it("keeps the campaign-run scope pending while the action runs", async () => {
    let resolveRun: () => void = () => undefined;
    const runCampaignNow = vi
      .fn<JobFinderShellActions["runCampaignNow"]>()
      .mockImplementation(
        () =>
          new Promise<JobFinderRendererWorkspaceSnapshot>((resolve) => {
            resolveRun = () =>
              resolve({} as JobFinderRendererWorkspaceSnapshot);
          }),
      );
    const { context, getPendingActionState } = buildContext({
      actions: { runCampaignNow },
    });

    const actionPromise = context.onRunCampaignNow("campaign_b");
    expect(getPendingActionState()).toEqual({
      [jobFinderPendingActions.campaignRun("campaign_b")]: 1,
    });

    resolveRun();
    await actionPromise;
    expect(getPendingActionState()).toEqual({});
  });

  it("exposes mark-read and mark-all-read through the page controller", async () => {
    const markCampaignNotificationRead = vi
      .fn<JobFinderShellActions["markCampaignNotificationRead"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const markAllCampaignNotificationsRead = vi
      .fn<JobFinderShellActions["markAllCampaignNotificationsRead"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);
    const { context, getActionState } = buildContext({
      actions: {
        markCampaignNotificationRead,
        markAllCampaignNotificationsRead,
      },
    });
    const pageContext = context;

    pageContext.onMarkCampaignNotificationRead("n_1");
    await vi.waitFor(() => {
      expect(markCampaignNotificationRead).toHaveBeenCalledWith("n_1");
    });

    pageContext.onMarkAllCampaignNotificationsRead();
    await vi.waitFor(() => {
      expect(markAllCampaignNotificationsRead).toHaveBeenCalledTimes(1);
      expect(getActionState().message).toMatch(/marked as read/i);
    });
  });
});

describe("buildJobFinderPageContext scoped settings saves", () => {
  it("saves application tracker settings through updateTrackerCrm without a whole-settings merge", async () => {
    const snapshot = {} as JobFinderRendererWorkspaceSnapshot;
    const saveSettings = vi.fn<JobFinderShellActions["saveSettings"]>();
    const updateTrackerCrm = vi
      .fn<JobFinderShellActions["updateTrackerCrm"]>()
      .mockResolvedValue(snapshot);
    const { context } = buildContext({
      actions: { saveSettings, updateTrackerCrm },
    });

    const completed = await context.onUpdateTrackerCrm({
      noResponseAutomation: { enabled: true, afterDays: 7 },
      customStages: [],
    });

    expect(completed).toBe(true);
    expect(updateTrackerCrm).toHaveBeenCalledOnce();
    expect(updateTrackerCrm).toHaveBeenCalledWith({
      noResponseAutomation: { enabled: true, afterDays: 7 },
      customStages: [],
    });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("marks tracker settings saves as failed when the scoped method fails", async () => {
    const failingUpdate = vi
      .fn<JobFinderShellActions["updateTrackerCrm"]>()
      .mockRejectedValue(new Error("commit refused"));
    const { context, getActionState } = buildContext({
      actions: { updateTrackerCrm: failingUpdate },
    });

    const completed = await context.onUpdateTrackerCrm({
      noResponseAutomation: { enabled: false, afterDays: 30 },
      customStages: [],
    });

    expect(completed).toBe(false);
    expect(getActionState().message).toBe("commit refused");
  });
});

describe("Applications browser hand-off failure reporting", () => {
  /**
   * The hand-off status is composed from what the REAL action wrapper hands
   * back, so these drive `buildJobFinderPageContext`'s own
   * `onPerformUserAction` / `onOpenBrowserSession` with a rejecting IPC double.
   * Calling the composer directly with a fabricated error would have passed
   * before the fix as well: the whole defect was that the wrapper reports its
   * failure as a bare `false` and the cause never reached the sentence.
   */
  const target = {
    jobId: "job_a",
    resultId: "result_a",
    runId: "run_a",
    applicationRecordId: "record_a",
    destinationUrl: "https://jobs.example.com/apply/1",
  };

  function pendingRequests() {
    return [
      {
        id: "request_a",
        revision: 3,
        state: "pending",
        scope: {
          type: "application",
          runId: "run_a",
          jobId: "job_a",
          applicationRecordId: "record_a",
        },
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
  }

  it("carries the real cause into the failed status when the open-page command rejects", async () => {
    const performUserAction = vi
      .fn<JobFinderShellActions["performUserAction"]>()
      .mockRejectedValue(new Error("The browser runtime is disabled"));
    const { context } = buildContext({ actions: { performUserAction } });

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: () =>
        context.onOpenBrowserSession(undefined, { rethrowError: true }),
      onPerformUserAction: (command) =>
        context.onPerformUserAction(command, { rethrowError: true }),
      requests: pendingRequests(),
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "The browser runtime is disabled",
    });
    expect(performUserAction).toHaveBeenCalledTimes(1);

    const status = formatJobFinderBrowserHandoffFailedStatus(
      outcome.kind === "failed" ? outcome.reason : null,
    );

    expect(status).toBe(
      "The Job Finder browser did not open, so nothing was opened for this " +
        "application and nothing was sent to the employer. The browser runtime " +
        "is disabled. Try again, or open this step from Needs you.",
    );
  });

  it("reports a closed prepared page after the refreshed workspace exposes Try again", async () => {
    const performUserAction = vi
      .fn<JobFinderShellActions["performUserAction"]>()
      .mockResolvedValue({
        userActionRequests: [],
        applicationRecords: [
          {
            id: "record_a",
            lastAttemptState: "failed",
            lastActionLabel: "The prepared application page is no longer open.",
          },
        ],
      } as unknown as JobFinderRendererWorkspaceSnapshot);
    const { context } = buildContext({
      actions: { performUserAction },
      workspace: {
        activeCampaignId: "campaign_active",
        userActionRequests: pendingRequests(),
      } as JobFinderRendererWorkspaceSnapshot,
    });

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: () =>
        context.onOpenBrowserSession(undefined, { rethrowError: true }),
      onPerformUserAction: (command) =>
        context.onPerformUserAction(command, { rethrowError: true }),
      requests: pendingRequests(),
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason:
        "That prepared application page is no longer open. Choose Prepare again in Applications to rebuild it.",
    });
  });

  it("shows the application page expanded after opening it, not minimized", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {
      ...globalThis.window,
      nestor: { browser: { command, getState: vi.fn() } },
    });
    try {
      const performUserAction = vi
        .fn<JobFinderShellActions["performUserAction"]>()
        .mockResolvedValue({
          userActionRequests: pendingRequests(),
          applicationRecords: [],
        } as unknown as JobFinderRendererWorkspaceSnapshot);
      const { context } = buildContext({
        actions: { performUserAction },
        workspace: {
          activeCampaignId: "campaign_active",
          userActionRequests: pendingRequests(),
        } as JobFinderRendererWorkspaceSnapshot,
      });

      await context.onPerformUserAction(
        {
          action: "open_page",
          requestId: "request_a",
          commandId: "open_a",
          expectedRevision: 3,
          credentialsPolicy: "browser_only",
          submitAuthorized: false,
          accountCreationAuthorized: false,
        },
        { rethrowError: true },
      );

      expect(command).toHaveBeenCalledWith({ type: "expand", expanded: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("opens a parked sign-in whose tab is gone through main, then shows it", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    const getState = vi.fn().mockResolvedValue({
      activeTabId: "tab_before_restart",
      tabs: [{ id: "tab_before_restart", url: "http://localhost/authboard/" }],
    });
    vi.stubGlobal("window", {
      ...globalThis.window,
      nestor: { browser: { command, getState } },
    });
    try {
      const requests = [
        {
          id: "request_sign_in",
          revision: 2,
          state: "pending",
          scope: {
            type: "discovery_source",
            discoveryRunId: "run_1",
            parkedTab: {
              tabId: "tab_before_restart",
              url: "http://localhost/authboard/",
              title: null,
            },
          },
        },
      ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];
      const performUserAction = vi
        .fn<JobFinderShellActions["performUserAction"]>()
        .mockResolvedValue({
          userActionRequests: requests,
        } as unknown as JobFinderRendererWorkspaceSnapshot);
      const { context } = buildContext({
        actions: { performUserAction },
        workspace: {
          activeCampaignId: "campaign_active",
          userActionRequests: requests,
        } as JobFinderRendererWorkspaceSnapshot,
      });

      await context.onPerformUserAction(
        {
          action: "open_page",
          requestId: "request_sign_in",
          commandId: "open_sign_in",
          expectedRevision: 2,
          credentialsPolicy: "browser_only",
          submitAuthorized: false,
          accountCreationAuthorized: false,
        },
        { rethrowError: true },
      );

      // Main reopens the tab first (the renderer no longer refuses when the
      // tab is missing from its view), then it is selected and expanded.
      expect(performUserAction).toHaveBeenCalledOnce();
      expect(command).toHaveBeenCalledWith({
        type: "select_tab",
        tabId: "tab_before_restart",
      });
      expect(command).toHaveBeenCalledWith({ type: "expand", expanded: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries the real cause when only the window could be opened", async () => {
    const openBrowserSession = vi
      .fn<JobFinderShellActions["openBrowserSession"]>()
      .mockRejectedValue(new Error("No browser session could be started"));
    const { context } = buildContext({ actions: { openBrowserSession } });

    const outcome = await runJobFinderApplicationBrowserHandoff({
      onOpenBrowserSession: () =>
        context.onOpenBrowserSession(undefined, { rethrowError: true }),
      onPerformUserAction: (command) =>
        context.onPerformUserAction(command, { rethrowError: true }),
      requests:
        [] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"],
      target,
    });

    expect(outcome).toEqual({
      kind: "failed",
      reason: "No browser session could be started",
    });
    expect(
      formatJobFinderBrowserHandoffFailedStatus(
        outcome.kind === "failed" ? outcome.reason : null,
      ),
    ).toContain("No browser session could be started.");
  });

  it("still reports the failure once at the route and leaves other callers resolving false", async () => {
    // The banner is unchanged, and a caller that does not ask for the cause
    // keeps the wrapper's own fire-and-forget contract.
    const performUserAction = vi
      .fn<JobFinderShellActions["performUserAction"]>()
      .mockRejectedValue(new Error("The browser runtime is disabled"));
    const { context, getActionState } = buildContext({
      actions: { performUserAction },
    });

    await expect(
      context.onPerformUserAction({
        requestId: "request_a",
        commandId: "command_a",
        expectedRevision: 3,
        action: "confirm_done",
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    ).resolves.toBe(false);

    expect(getActionState().message).toContain(
      "The browser runtime is disabled",
    );
  });
});

describe("tracker bulk notices and reset completion", () => {
  it.each(["stage", "tags", "archive"] as const)(
    "leaves %s success to the tracker toast",
    async (action) => {
      const mutateApplicationCrmBulkStage = vi
        .fn<JobFinderShellActions["mutateApplicationCrmBulkStage"]>()
        .mockResolvedValue({
          activeCampaignId: null,
        } as unknown as JobFinderRendererWorkspaceSnapshot);
      const { context, getActionMessages } = buildContext({
        actions: { mutateApplicationCrmBulkStage },
      });
      const command = ApplicationCrmBulkStageMutationInputSchema.parse({
        action,
        stage: "reviewing",
        tags: ["Priority"],
        items: [
          { applicationRecordId: "synthetic_application", expectedRevision: 0 },
        ],
      });
      await context.onMutateApplicationCrmBulkStage(command);
      expect(mutateApplicationCrmBulkStage).toHaveBeenCalledWith(command);
      expect(getActionMessages().filter((message) => message !== null)).toEqual(
        [],
      );
    },
  );

  it("returns reset failure to the pending confirmation", async () => {
    const resetWorkspace = vi.fn(() =>
      Promise.reject(new Error("Your workspace was not deleted.")),
    );
    const { context } = buildContext({ actions: { resetWorkspace } });
    await expect(context.onResetWorkspace()).rejects.toThrow(
      "Your workspace was not deleted.",
    );
    expect(resetWorkspace).toHaveBeenCalledOnce();
  });
});
