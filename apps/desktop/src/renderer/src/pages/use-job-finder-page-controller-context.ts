import {
  CONFIRM_STEP_DONE_ACTION,
  JOB_FINDER_BROWSER_NAME,
} from "@renderer/features/job-finder/lib/job-finder-browser-handoff-copy";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ApplicationCrmBulkStageMutationInput,
  ApplyGroupedManualAnswerInput,
  JobFinderRendererWorkspaceSnapshot,
  ProfileCopilotMessage,
  ProfileSetupState,
  ProjectGroupedManualAnswerCommand,
  ResumeImportProgressEvent,
  SetJobFinderActivityControlInput,
  SnoozeGroupedDecisionInput,
} from "@nestor/contracts";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import { applicationSignInContinuesOnItsOwn } from "@renderer/features/job-finder/lib/application-sign-in-handoff";
import type {
  PendingActionScope,
  PendingActionState,
} from "./job-finder-pending-actions";
import { jobFinderPendingActions } from "./job-finder-pending-actions";
import {
  COMMAND_PENDING_RELEASE_MS,
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
  selectedApplicationAttempt: JobFinderPageContext["selectedApplicationAttempt"];
  selectedApplicationRecord: JobFinderPageContext["selectedApplicationRecord"];
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
  setSelectedApplicationRecordId: (recordId: string) => void;
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
    selectedApplicationAttempt,
    selectedApplicationRecord,
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
    setSelectedApplicationRecordId,
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
    onApplyGroupedManualAnswer: (input: ApplyGroupedManualAnswerInput) =>
      void runAction(
        () => actions.applyGroupedManualAnswer(input),
        () => undefined,
        "Grouped answer applied to the shortlisted applications. Final submission and account creation remain disabled.",
        {
          scope: jobFinderPendingActions.groupedManualAnswerApply(
            input.decisionId,
          ),
        },
      ),
    onProjectGroupedManualAnswer: (
      command: ProjectGroupedManualAnswerCommand,
    ) =>
      void runAction(
        () => actions.projectGroupedManualAnswer(command),
        () => undefined,
        "Grouped answer created for review. Approve it to fill every shortlisted application with the same safe answer.",
        {
          scope: jobFinderPendingActions.groupedManualAnswerProject(
            command.groupKey,
          ),
        },
      ),
    onSnoozeGroupedDecision: (input: SnoozeGroupedDecisionInput) =>
      void runAction(
        () => actions.snoozeGroupedDecision(input),
        () => undefined,
        input.reason
          ? "Grouped decision snoozed with your note."
          : "Grouped decision snoozed until the selected time.",
        {
          scope: jobFinderPendingActions.groupedDecisionSnooze(
            input.decisionId,
          ),
        },
      ),
    onApplyResumeTimelineRepairAction: async (runId, proposalId, action) => {
      await actions.applyResumeTimelineRepairAction(runId, proposalId, action);
    },
    onGetApplyRunDetails: actions.getApplyRunDetails,
    onSaveApplicationAnswer: actions.saveApplicationAnswer,
    onClearApplicationAnswer: actions.clearApplicationAnswer,
    onExportApplicationPacket: async (input) => {
      await runAction(
        () => actions.exportApplicationPacket(input),
        () => undefined,
        (result) =>
          result.status === "saved"
            ? "Application packet saved."
            : "Application packet export cancelled.",
      );
    },
    onResolveSubmissionOutcome: async (uncertainOutcomeId, resolution) => {
      await runAction(
        async () => {
          const result = await actions.resolveSubmissionOutcome({
            uncertainOutcomeId,
            resolution,
            confirmedOnEmployerSite: true,
          });
          if (result.status !== "recorded" && result.status !== "duplicate") {
            throw new Error(
              "The submission record changed before verification could be saved.",
            );
          }
          await actions.refreshWorkspace();
          return result;
        },
        () => undefined,
        resolution === "submitted"
          ? "Employer-site verification saved: submitted."
          : "Employer-site verification saved: not submitted.",
      );
    },
    onExportApplicationCrm: async (format, recordId) => {
      await runAction(
        () =>
          actions.exportApplicationCrm({
            format,
            applicationRecordIds: [recordId],
          }),
        () => undefined,
        (result) =>
          result.status === "saved"
            ? `Application tracker exported (${result.exportedCount}).`
            : "Application tracker export cancelled.",
      );
    },
    onMutateApplicationCrm: async (command) => {
      const completed = await runAction(
        () => actions.mutateApplicationCrm(command),
        () => undefined,
        "Application tracker updated.",
      );
      if (!completed) {
        throw new Error("The application tracker update could not be saved.");
      }
    },
    onMutateApplicationCrmBulkStage: async (
      command: ApplicationCrmBulkStageMutationInput,
    ) => {
      const completed = await runAction(
        () => actions.mutateApplicationCrmBulkStage(command),
        () => undefined,
        null,
      );
      if (!completed) {
        throw new Error(
          "The bulk application tracker update could not be saved.",
        );
      }
    },
    onGetSourceDebugRunDetails: actions.getSourceDebugRunDetails,
    // Returns the run's settled outcome instead of discarding it: the
    // Applications hand-off reports what actually happened beside the control,
    // and a `void`-ed promise can only ever look like success there.
    onPerformUserAction: (command, options) => {
      const openedRequestContinuesOnItsOwn = (requestId: string) => {
        const request = (workspace.userActionRequests ?? []).find(
          (candidate) => candidate.id === requestId,
        );
        return request ? applicationSignInContinuesOnItsOwn(request) : false;
      };
      return runAction(
        async () => {
          const request = (workspace.userActionRequests ?? []).find(
            (candidate) => candidate.id === command.requestId,
          );
          const parkedTab =
            command.action === "open_page" &&
            request?.scope.type === "discovery_source" &&
            request.scope.discoveryRunId
              ? request.scope.parkedTab
              : null;
          // Opening the step opens its parked tab; when that tab is gone
          // (a restart, or it was closed), main opens the address again as
          // the parked tab for this request. Then show it, expanded.
          const snapshot = await actions.performUserAction(command);
          if (parkedTab) {
            const browserState = await window.nestor.browser.getState();
            const tab =
              browserState.tabs.find((candidate) =>
                parkedTab.tabId !== null
                  ? candidate.id === parkedTab.tabId
                  : candidate.url === parkedTab.url,
              ) ??
              browserState.tabs.find(
                (candidate) => candidate.id === browserState.activeTabId,
              );
            if (!tab) {
              throw new Error(
                `Job Finder could not open that page in its browser. Open ${JOB_FINDER_BROWSER_NAME} from the top bar and go to the site to sign in; Job Finder notices when you're done.`,
              );
            }
            await window.nestor.browser.command({
              type: "select_tab",
              tabId: tab.id,
            });
            await window.nestor.browser.command({
              type: "expand",
              expanded: true,
            });
          }
          const applicationScope =
            request?.scope.type === "application" ? request.scope : null;
          if (command.action === "open_page" && applicationScope) {
            const latestRequest = (snapshot.userActionRequests ?? []).find(
              (candidate) => candidate.id === command.requestId,
            );
            const applicationRecord = applicationScope.applicationRecordId
              ? (snapshot.applicationRecords ?? []).find(
                  (record) =>
                    record.id === applicationScope.applicationRecordId,
                )
              : null;
            if (
              latestRequest?.state === "cancelled" ||
              (applicationRecord?.lastAttemptState === "failed" &&
                applicationRecord.lastActionLabel ===
                  "The prepared application page is no longer open.")
            ) {
              throw new Error(
                "That prepared application page is no longer open. Choose Prepare again in Applications to rebuild it.",
              );
            }
            // The page is selected in the browser; show it, as a parked
            // search tab is shown, instead of leaving the browser minimized.
            await window.nestor?.browser
              ?.command({ type: "expand", expanded: true })
              .catch(() => undefined);
          }
          return snapshot;
        },
        () => undefined,
        // "Action inbox" is not a destination this app has — the page is
        // called Needs you — and the opened-page case has a destination the
        // user actually needs to be told about.
        //
        // `confirm_done` deliberately raises NO banner. The check reports
        // itself in place, beside the control that started it (checking ->
        // done / not done yet). A "Verification started…" banner outlived the
        // result it announced, so the top of the screen claimed the check was
        // still running while the body already showed it had finished and
        // failed.
        command.action === "confirm_done"
          ? null
          : command.action === "open_page"
            ? openedRequestContinuesOnItsOwn(command.requestId)
              ? `Opened this application in ${JOB_FINDER_BROWSER_NAME}, right here in the app. Sign in there; Job Finder carries on by itself once you're in.`
              : `Opened this application in ${JOB_FINDER_BROWSER_NAME}, right here in the app. Finish the step there, then come back and choose "${CONFIRM_STEP_DONE_ACTION}".`
            : "Saved. Needs you is up to date.",
        {
          scope: jobFinderPendingActions.userAction(command.requestId),
          releasePendingAfterMs: COMMAND_PENDING_RELEASE_MS,
          pendingTimeoutMessage:
            "This took too long to confirm. Check its status before trying again.",
          // Only a caller that asked for it: the route message is written
          // either way, and every other caller keeps resolving `false`.
          ...(options?.rethrowError ? { rethrowError: true } : {}),
        },
      );
    },
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
    onSelectApplicationRecord: setSelectedApplicationRecordId,
    onSelectDiscoveryJob: setSelectedDiscoveryJobId,
    onSelectReviewItem: setSelectedReviewJobId,
    onSetActivityControl: (input: SetJobFinderActivityControlInput) =>
      runAction(
        () => actions.setActivityControl(input),
        () => undefined,
        input.paused ? "Activity paused." : "Activity resumed.",
      ),
    selectedApplicationAttempt,
    selectedApplicationRecord,
    selectedDiscoveryJob,
    selectedReviewItem,
    selectedReviewJob,
    selectedTailoredAsset,
    workspace,
  };
}
