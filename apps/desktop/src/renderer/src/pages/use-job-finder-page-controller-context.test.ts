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

describe("reset completion", () => {
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
