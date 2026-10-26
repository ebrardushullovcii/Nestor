import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  JobFinderRendererWorkspaceSnapshot,
  ProfileCopilotMessage,
  ProfileSetupState,
  ResumeImportProgressEvent,
  SetJobFinderActivityControlInput,
} from "@nestor/contracts";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import type {
  PendingActionScope,
  PendingActionState,
} from "./job-finder-pending-actions";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import {
  createActionRunners,
  createPrimaryPageActions,
} from "./use-job-finder-page-controller-actions";
import type { JobFinderPageContext } from "./job-finder-page-context";
import type {
  JobFinderSaveCoordinator,
  JobFinderSaveState,
} from "./job-finder-save-state";

type BuildJobFinderPageContextArgs = {
  actionState: ActionState;
  actions: JobFinderShellActions;
  canImportResume: boolean;
  importResumeGuardMessage: string | null;
  resumeOperationStarts?: Readonly<Record<string, number>>;
  isAnyPendingAction: (scopes: readonly PendingActionScope[]) => boolean;
  isPendingAction: (scope: PendingActionScope) => boolean;
  latestWorkspaceRef: MutableRefObject<JobFinderRendererWorkspaceSnapshot | null>;
  getLocationPathname: () => string;
  navigate: (
    path: string,
    options?: { replace?: boolean; state?: unknown },
  ) => void;
  navigateSafely: (path: string) => void;
  profileCopilotBusy: boolean;
  resumeImportProgress: ResumeImportProgressEvent | null;
  profileCopilotPendingContextKey: string | null;
  profileCopilotRequestTokenRef: MutableRefObject<number>;
  requestApplyCopilotVisualCheckpoints: (request: {
    jobId: string;
    /** Identity of the exact application the prepare dialog is asking about. */
    subject: string | null;
    /** Honest statement of what preparation will do, prepare-only boundary included. */
    description: string;
    /**
     * Returns a refusal sentence when the start could not begin, so the dialog
     * can stay open and say why instead of closing silently.
     */
    onResolve: (
      visualCheckpointsEnabled: boolean,
    ) => string | null | void | Promise<string | null | void>;
  }) => void;
  profileSetupState: ProfileSetupState | null;
  saveCoordinator: JobFinderSaveCoordinator;
  saveState: JobFinderSaveState;
  selectedDiscoveryJob: JobFinderPageContext["selectedDiscoveryJob"];
  selectedReviewItem: JobFinderPageContext["selectedReviewItem"];
  selectedReviewJob: JobFinderPageContext["selectedReviewJob"];
  selectedTailoredAsset: JobFinderPageContext["selectedTailoredAsset"];
  setPendingActionState: Dispatch<SetStateAction<PendingActionState>>;
  setActionState: Dispatch<SetStateAction<ActionState>>;
  setOptimisticProfileCopilotMessages: Dispatch<
    SetStateAction<readonly ProfileCopilotMessage[]>
  >;
  setProfileCopilotBusy: Dispatch<SetStateAction<boolean>>;
  setProfileCopilotPendingContextKey: Dispatch<SetStateAction<string | null>>;
  setProfileSurfaceDirty: Dispatch<SetStateAction<boolean>>;
  /** Notifies the save coordinator that a staged settings draft changed. */
  onSettingsDraftEdited: () => void;
  /** Notifies the save coordinator that a profile/setup draft was edited. */
  onProfileSurfaceDraftEdited: () => void;
  onCancelImportResume: () => void;
  setSelectedDiscoveryJobId: (jobId: string) => void;
  setSelectedReviewJobId: (jobId: string) => void;
  sourceDebugRunIdRef: MutableRefObject<number>;
  workspace: JobFinderRendererWorkspaceSnapshot;
};

export function buildJobFinderPageContext(
  args: BuildJobFinderPageContextArgs,
): JobFinderPageContext {
  const {
    actionState,
    actions,
    canImportResume,
    importResumeGuardMessage,
    resumeOperationStarts,
    isAnyPendingAction,
    isPendingAction,
    latestWorkspaceRef,
    getLocationPathname,
    navigate,
    navigateSafely,
    profileCopilotBusy,
    resumeImportProgress,
    profileCopilotPendingContextKey,
    profileCopilotRequestTokenRef,
    requestApplyCopilotVisualCheckpoints,
    profileSetupState,
    saveCoordinator,
    saveState,
    selectedDiscoveryJob,
    selectedReviewItem,
    selectedReviewJob,
    selectedTailoredAsset,
    setPendingActionState,
    setActionState,
    setOptimisticProfileCopilotMessages,
    setProfileCopilotBusy,
    setProfileCopilotPendingContextKey,
    setProfileSurfaceDirty,
    onSettingsDraftEdited,
    onProfileSurfaceDraftEdited,
    onCancelImportResume,
    setSelectedDiscoveryJobId,
    setSelectedReviewJobId,
    sourceDebugRunIdRef,
    workspace,
  } = args;

  const { runAction, runSaveAction, withPendingScope } = createActionRunners({
    saveCoordinator,
    setActionState,
    setPendingActionState,
  });

  const primaryActions = createPrimaryPageActions({
    actions,
    canImportResume,
    importResumeGuardMessage,
    getLocationPathname,
    navigate,
    profileSetupState,
    profileCopilotRequestTokenRef,
    requestApplyCopilotVisualCheckpoints,
    runAction,
    runSaveAction,
    saveCoordinator,
    withPendingScope,
    setPendingActionState,
    setActionState,
    setOptimisticProfileCopilotMessages,
    setProfileCopilotBusy,
    setProfileCopilotPendingContextKey,
    setSelectedReviewJobId,
    sourceDebugRunIdRef,
    latestWorkspaceRef,
    workspace,
  });

  return {
    actionState,
    canImportResume,
    importResumeGuardMessage,
    resumeOperationStarts: resumeOperationStarts ?? {},
    isAnyPending: isAnyPendingAction,
    isPending: isPendingAction,
    profileCopilotBusy,
    resumeImportProgress,
    saveState,
    ...primaryActions,
    onProfileSurfaceDirtyChange: setProfileSurfaceDirty,
    onProfileSurfaceDraftEdited,
    onCancelImportResume,
    onSettingsDraftEdited,
    onNavigateSafely: navigateSafely,
    profileCopilotPendingContextKey,
    onApplyResumeTimelineRepairAction: async (runId, proposalId, action) => {
      await actions.applyResumeTimelineRepairAction(runId, proposalId, action);
    },
    onGetSourceDebugRunDetails: actions.getSourceDebugRunDetails,
    onSaveSourceInstructionArtifact: (targetId, artifact) =>
      void runAction(
        () => actions.saveSourceInstructionArtifact(targetId, artifact),
        () => undefined,
        "Saved guidance updated.",
        { scope: jobFinderPendingActions.sourceInstruction(targetId) },
      ),
    onVerifySourceInstructions: (targetId: string, instructionId: string) =>
      void runAction(
        () => actions.verifySourceInstructions(targetId, instructionId),
        () => undefined,
        "Saved guidance checked.",
        {
          scope: jobFinderPendingActions.sourceInstructionVerify(instructionId),
        },
      ),
    onResetBrowser: () =>
      runAction(actions.resetBrowser, () => undefined, null),
    onResetWorkspace: () =>
      runAction(
        actions.resetWorkspace,
        (snapshot) => {
          saveCoordinator.clearReceipt();
          navigate(
            snapshot.profileSetupState.status === "not_started"
              ? "/job-finder/profile/setup"
              : "/job-finder/profile",
          );
        },
        "Workspace reset. Your profile, resume, jobs, and browser session were cleared on this device.",
        {
          scope: jobFinderPendingActions.workspaceReset(),
          rethrowError: true,
        },
      ),
    onSelectDiscoveryJob: setSelectedDiscoveryJobId,
    onSelectReviewItem: setSelectedReviewJobId,
    onSetActivityControl: (input: SetJobFinderActivityControlInput) =>
      runAction(
        () => actions.setActivityControl(input),
        () => undefined,
        input.paused ? "Activity paused." : "Activity resumed.",
      ),
    selectedDiscoveryJob,
    selectedReviewItem,
    selectedReviewJob,
    selectedTailoredAsset,
    workspace,
  };
}
