import { ApplicationCrmBulkStageMutationInputSchema } from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject, SetStateAction } from "react";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import type { PendingActionState } from "./job-finder-pending-actions";
import { buildJobFinderPageContext } from "./use-job-finder-page-controller-context";
import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import type { DiscoveryRunFeedback } from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import { createJobFinderSaveCoordinator } from "./job-finder-save-state";

function buildContext(overrides: {
  actions: Partial<JobFinderShellActions>;
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
  };
}

describe("Applications browser hand-off failure reporting", () => {
  /**
   * The hand-off status is composed from what the REAL action wrapper hands
   * back, so these drive `buildJobFinderPageContext`'s own
   * `onPerformUserAction` / `onOpenBrowserSession` with a rejecting IPC double.
   * Calling the composer directly with a fabricated error would have passed
   * before the fix as well: the whole defect was that the wrapper reports its
   * failure as a bare `false` and the cause never reached the sentence.
   */
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
