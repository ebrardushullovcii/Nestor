import {
  CONFIRM_STEP_DONE_ACTION,
  JOB_FINDER_BROWSER_NAME,
} from "@renderer/features/job-finder/lib/job-finder-browser-handoff-copy";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ApplicationCrmBulkStageMutationInput,
  ApplyGroupedManualAnswerInput,
  CampaignRuleFunnelProjection,
  DiscoveryActivityEvent,
  JobFinderResumeWorkspace,
  JobFinderRendererWorkspaceSnapshot,
  ProfileCopilotMessage,
  ProfileSetupState,
  ProjectGroupedManualAnswerCommand,
  RapidReviewMutationInput,
  RecordOutcomeInput,
  ResumeImportProgressEvent,
  ResumeAssistantMessage,
  ResumeDraft,
  SafeguardMutationInput,
  SaveCampaignRuleInput,
  SaveJobSearchCampaignInput,
  SetJobFinderActivityControlInput,
  SetOutcomeSuggestionEnabledInput,
  SnoozeGroupedDecisionInput,
} from "@nestor/contracts";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import {
  createDiscoveryRunSucceededFeedback,
  type DiscoveryRunFeedback,
} from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import {
  formatDiscoveryRunReportLabel,
  getDiscoveryRunReportCounts,
  hasDiscoveryRunReportCounts,
} from "@renderer/features/job-finder/lib/discovery-run-count-label";
import type { TailoredDraftPreparationViewState } from "@renderer/features/job-finder/screens/review-queue/review-queue-status";
import { safeguardMutationKey } from "@renderer/features/job-finder/screens/safeguards/safeguards-presentation";
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
  activeRouteResumeAssistantMessages: readonly ResumeAssistantMessage[];
  activeRouteResumeAssistantPending: boolean;
  activeRouteResumeWorkspace: JobFinderResumeWorkspace | null;
  canImportResume: boolean;
  confirmLeaveDirtyResumeWorkspace: (pendingAction: string) => Promise<boolean>;
  importResumeGuardMessage: string | null;
  resumeOperationStarts?: Readonly<Record<string, number>>;
  isAnyPendingAction: (scopes: readonly PendingActionScope[]) => boolean;
  isPendingAction: (scope: PendingActionScope) => boolean;
  isCurrentResumeAssistantRequest: (
    jobId: string,
    requestToken: number,
  ) => boolean;
  isCurrentResumeWorkspaceJob: (jobId: string) => boolean;
  discoveryRunFeedback: DiscoveryRunFeedback | null;
  liveDiscoveryEvents: readonly DiscoveryActivityEvent[];
  latestWorkspaceRef: MutableRefObject<JobFinderRendererWorkspaceSnapshot | null>;
  locationPathname: string;
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
  refreshResumeWorkspace: (
    jobId: string,
    options?: {
      updateAssistantMessages?: boolean;
    },
  ) => Promise<boolean>;
  adoptAutosavedResumeDraft: (draft: ResumeDraft) => void;
  resumeAssistantRequestTokenRef: MutableRefObject<number>;
  selectedApplicationAttempt: JobFinderPageContext["selectedApplicationAttempt"];
  selectedApplicationRecord: JobFinderPageContext["selectedApplicationRecord"];
  selectedDiscoveryJob: JobFinderPageContext["selectedDiscoveryJob"];
  selectedReviewItem: JobFinderPageContext["selectedReviewItem"];
  selectedReviewJob: JobFinderPageContext["selectedReviewJob"];
  selectedTailoredAsset: JobFinderPageContext["selectedTailoredAsset"];
  setPendingActionState: Dispatch<SetStateAction<PendingActionState>>;
  setActionState: Dispatch<SetStateAction<ActionState>>;
  setDiscoveryRunFeedback: Dispatch<
    SetStateAction<DiscoveryRunFeedback | null>
  >;
  setLiveDiscoveryEvents: Dispatch<SetStateAction<DiscoveryActivityEvent[]>>;
  setOptimisticProfileCopilotMessages: Dispatch<
    SetStateAction<readonly ProfileCopilotMessage[]>
  >;
  setProfileCopilotBusy: Dispatch<SetStateAction<boolean>>;
  setProfileCopilotPendingContextKey: Dispatch<SetStateAction<string | null>>;
  setProfileSurfaceDirty: Dispatch<SetStateAction<boolean>>;
  setSearchPlanSurfaceDirty: (dirty: boolean) => void;
  setResumeAssistantMessages: Dispatch<
    SetStateAction<readonly ResumeAssistantMessage[]>
  >;
  setResumeAssistantPending: Dispatch<SetStateAction<boolean>>;
  setResumeWorkspace: Dispatch<SetStateAction<JobFinderResumeWorkspace | null>>;
  clearResumeWorkspaceState: () => void;
  setResumeWorkspaceDirty: Dispatch<SetStateAction<boolean>>;
  /** Notifies the save coordinator that a staged settings draft changed. */
  onSettingsDraftEdited: () => void;
  /** Notifies the save coordinator that a profile/setup draft was edited. */
  onProfileSurfaceDraftEdited: () => void;
  onCancelImportResume: () => void;
  /** Notifies the save coordinator that a Resume Studio draft was edited. */
  onResumeWorkspaceDraftEdited: () => void;
  setSelectedApplicationRecordId: (recordId: string) => void;
  setSelectedDiscoveryJobId: (jobId: string) => void;
  setSelectedReviewJobId: (jobId: string) => void;
  setTailoredDraftPreparation: Dispatch<
    SetStateAction<TailoredDraftPreparationViewState>
  >;
  sourceDebugRunIdRef: MutableRefObject<number>;
  tailoredDraftPreparation: TailoredDraftPreparationViewState;
  tailoredDraftPreparationRunRef: MutableRefObject<boolean>;
  tailoredDraftPreparationStopRequestedRef: MutableRefObject<boolean>;
  tailoredDraftPreparationDisposedRef: MutableRefObject<boolean>;
  workspace: JobFinderRendererWorkspaceSnapshot;
};

export function buildJobFinderPageContext(
  args: BuildJobFinderPageContextArgs,
): JobFinderPageContext {
  const {
    actionState,
    actions,
    activeRouteResumeAssistantMessages,
    activeRouteResumeAssistantPending,
    activeRouteResumeWorkspace,
    canImportResume,
    confirmLeaveDirtyResumeWorkspace,
    importResumeGuardMessage,
    resumeOperationStarts,
    isAnyPendingAction,
    isPendingAction,
    isCurrentResumeAssistantRequest,
    isCurrentResumeWorkspaceJob,
    discoveryRunFeedback,
    liveDiscoveryEvents,
    latestWorkspaceRef,
    locationPathname,
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
    refreshResumeWorkspace,
    adoptAutosavedResumeDraft,
    resumeAssistantRequestTokenRef,
    selectedApplicationAttempt,
    selectedApplicationRecord,
    selectedDiscoveryJob,
    selectedReviewItem,
    selectedReviewJob,
    selectedTailoredAsset,
    setPendingActionState,
    setActionState,
    setDiscoveryRunFeedback,
    setLiveDiscoveryEvents,
    setOptimisticProfileCopilotMessages,
    setProfileCopilotBusy,
    setProfileCopilotPendingContextKey,
    setProfileSurfaceDirty,
    setSearchPlanSurfaceDirty,
    setResumeAssistantMessages,
    setResumeAssistantPending,
    setResumeWorkspace,
    clearResumeWorkspaceState,
    setResumeWorkspaceDirty,
    onSettingsDraftEdited,
    onProfileSurfaceDraftEdited,
    onCancelImportResume,
    onResumeWorkspaceDraftEdited,
    setSelectedApplicationRecordId,
    setSelectedDiscoveryJobId,
    setSelectedReviewJobId,
    setTailoredDraftPreparation,
    sourceDebugRunIdRef,
    tailoredDraftPreparation,
    tailoredDraftPreparationRunRef,
    tailoredDraftPreparationStopRequestedRef,
    tailoredDraftPreparationDisposedRef,
    workspace,
  } = args;

  const {
    runAction,
    runResumeWorkspaceAction,
    runSaveAction,
    withPendingScope,
  } = createActionRunners({
    saveCoordinator,
    setActionState,
    setPendingActionState,
  });

  const primaryActions = createPrimaryPageActions({
    actions,
    activeRouteResumeWorkspace,
    canImportResume,
    confirmLeaveDirtyResumeWorkspace,
    importResumeGuardMessage,
    isCurrentResumeAssistantRequest,
    isCurrentResumeWorkspaceJob,
    locationPathname,
    navigate,
    profileSetupState,
    profileCopilotRequestTokenRef,
    requestApplyCopilotVisualCheckpoints,
    refreshResumeWorkspace,
    adoptAutosavedResumeDraft,
    resumeAssistantRequestTokenRef,
    runAction,
    runResumeWorkspaceAction,
    runSaveAction,
    saveCoordinator,
    withPendingScope,
    setPendingActionState,
    setActionState,
    setDiscoveryRunFeedback,
    setLiveDiscoveryEvents,
    setOptimisticProfileCopilotMessages,
    setProfileCopilotBusy,
    setProfileCopilotPendingContextKey,
    setResumeAssistantMessages,
    setResumeAssistantPending,
    setResumeWorkspace,
    clearResumeWorkspaceState,
    setResumeWorkspaceDirty,
    setSelectedReviewJobId,
    setTailoredDraftPreparation,
    sourceDebugRunIdRef,
    tailoredDraftPreparationRunRef,
    tailoredDraftPreparationStopRequestedRef,
    tailoredDraftPreparationDisposedRef,
    latestWorkspaceRef,
    workspace,
  });

  return {
    actionState,
    canImportResume,
    discoveryRunFeedback,
    importResumeGuardMessage,
    resumeOperationStarts: resumeOperationStarts ?? {},
    isAnyPending: isAnyPendingAction,
    isPending: isPendingAction,
    profileCopilotBusy,
    resumeImportProgress,
    saveState,
    ...primaryActions,
    onProfileSurfaceDirtyChange: setProfileSurfaceDirty,
    onSearchPlanSurfaceDirtyChange: setSearchPlanSurfaceDirty,
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
    tailoredDraftPreparation,
    onApplyResumeTimelineRepairAction: async (runId, proposalId, action) => {
      await actions.applyResumeTimelineRepairAction(runId, proposalId, action);
    },
    onGetApplyRunDetails: actions.getApplyRunDetails,
    onSaveApplicationAnswer: actions.saveApplicationAnswer,
    onClearApplicationAnswer: actions.clearApplicationAnswer,
    // The confirmation mutates the saved draft; the studio reads the resume
    // workspace, not the general snapshot, so refresh it or the approved row
    // only changes after a reload.
    onSetResumeClaimConfirmation: async (input) => {
      const snapshot = await actions.setResumeClaimConfirmation(input);
      await refreshResumeWorkspace(input.jobId);
      return snapshot;
    },
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
    onRefreshCompanyIntelligence: async () => {
      await runAction(
        () => actions.refreshCompanyIntelligence(),
        () => undefined,
        "What Job Finder knows about these employers was refreshed from your saved jobs and applications.",
        { scope: jobFinderPendingActions.companyIntelligenceRefresh() },
      );
    },
    onMutateCompanyIntelligence: async (command) => {
      const completed = await runAction(
        () => actions.mutateCompanyIntelligence(command),
        () => undefined,
        command.mutation.type.includes("contact")
          ? "Company contact updated."
          : command.mutation.type.includes("note")
            ? "Company note updated."
            : "Salary/offer evidence updated.",
        {
          scope: jobFinderPendingActions.companyIntelligenceMutation(
            command.companyId,
          ),
        },
      );
      if (!completed) {
        throw new Error("The company change could not be saved.");
      }
    },
    onSetCompanyPreference: async (input) => {
      const completed = await runAction(
        () =>
          actions.setCompanyPreference({
            companyId: input.companyId,
            preference: input.preference,
          }),
        () => undefined,
        "Company preference saved. It only changes local tracking and never affects final-submit authority.",
        { scope: jobFinderPendingActions.companyPreference(input.companyId) },
      );
      if (!completed) {
        throw new Error("The company preference could not be saved.");
      }
    },
    onReviewCompanyMerge: async (input) => {
      const completed = await runAction(
        () =>
          actions.reviewCompanyMerge({
            companyId: input.companyId,
            candidateId: input.candidateId,
            decision: input.decision,
          }),
        () => undefined,
        input.decision === "accepted"
          ? "Companies merged. Their aliases, jobs, applications, contacts, notes, and evidence were preserved."
          : "Duplicate suggestion rejected. The two companies stay separate.",
        { scope: jobFinderPendingActions.companyMergeReview(input.companyId) },
      );
      if (!completed) {
        throw new Error("The merge decision could not be saved.");
      }
    },
    onMutateRapidReview: async (input: RapidReviewMutationInput) => {
      const completed = await runAction(
        () => actions.mutateRapidReview(input),
        () => undefined,
        input.type === "decide"
          ? "Quick review decision saved."
          : "Quick review decision undone.",
        { scope: jobFinderPendingActions.rapidReview() },
      );
      if (!completed) {
        throw new Error("The rapid review change could not be saved.");
      }
    },
    onMutateSafeguards: (input: SafeguardMutationInput) => {
      return runAction(
        () => actions.mutateSafeguards(input),
        () => undefined,
        "Safeguard updated. It only pauses or unblocks local work and never grants submission authority.",
        {
          scope: jobFinderPendingActions.safeguardsMutation(
            safeguardMutationKey(input),
          ),
        },
      );
    },
    onRecordOutcome: async (input: RecordOutcomeInput) => {
      const completed = await runAction(
        () => actions.recordOutcome(input),
        () => undefined,
        "Outcome recorded. Analytics use only outcomes you record here; this stays local tracking and is not submission evidence.",
        {
          rethrowError: true,
          scope: jobFinderPendingActions.recordOutcome(input.jobId),
        },
      );
      if (!completed) {
        throw new Error("The outcome could not be recorded.");
      }
      return completed;
    },
    onSetOutcomeSuggestionEnabled: (input: SetOutcomeSuggestionEnabledInput) =>
      runAction(
        () => actions.setOutcomeSuggestionEnabled(input),
        () => undefined,
        input.enabled || input.reset
          ? "Suggestion reset. Analytics will re-evaluate it from outcomes you recorded."
          : "Suggestion disabled. It stays off until you reset it.",
        {
          scope: jobFinderPendingActions.outcomeSuggestion(
            input.dimension,
            input.key,
          ),
        },
      ),
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
    onPreviewResumeDraft: actions.previewResumeDraft,
    onSaveCampaign: (campaign: SaveJobSearchCampaignInput) =>
      runAction(
        () => actions.saveCampaign(campaign),
        () => undefined,
        campaign.id === null ? "Search plan created." : "Search plan updated.",
      ),
    onRunCampaignNow: (campaignId?: string | null) => {
      const resolvedCampaignId = campaignId ?? workspace.activeCampaignId;
      return runAction(
        () => actions.runCampaignNow(campaignId),
        (snapshot) => {
          const latestPlanRun = [...(snapshot.recentDiscoveryRuns ?? [])]
            .filter((run) => run.campaignId === resolvedCampaignId)
            .sort(
              (left, right) =>
                Date.parse(right.startedAt) - Date.parse(left.startedAt),
            )[0];
          const report = getDiscoveryRunReportCounts(latestPlanRun);
          setDiscoveryRunFeedback(
            createDiscoveryRunSucceededFeedback(
              null,
              hasDiscoveryRunReportCounts(report)
                ? formatDiscoveryRunReportLabel(report)
                : null,
              hasDiscoveryRunReportCounts(report) ? report.new : null,
            ),
          );
        },
        "Search plan run started. Discovery searches and reads listings; it does not fill application forms or perform submits.",
        {
          scope: jobFinderPendingActions.campaignRun(resolvedCampaignId),
          startMessage:
            "Running this search plan now. Discovery only searches and reads listings, and stops before any final submit control.",
        },
      );
    },
    onDeleteCampaign: (campaignId: string) =>
      runAction(
        () => actions.deleteCampaign(campaignId),
        () => undefined,
        // A refused deletion is reported inline by the campaigns screen.
        (deleted) => (deleted ? "Search plan deleted." : null),
      ),
    onMarkCampaignNotificationRead: (notificationId: string) =>
      void runAction(
        () => actions.markCampaignNotificationRead(notificationId),
        () => undefined,
        "Notification marked as read.",
        {
          scope: jobFinderPendingActions.campaignNotification(notificationId),
        },
      ),
    onMarkAllCampaignNotificationsRead: () =>
      void runAction(
        () => actions.markAllCampaignNotificationsRead(),
        () => undefined,
        "All search plan notifications marked as read.",
        {
          scope: jobFinderPendingActions.campaignNotificationAll(),
        },
      ),
    onSaveCampaignRule: (campaignId: string, rule: SaveCampaignRuleInput) =>
      runAction(
        () => actions.saveCampaignRule(campaignId, rule),
        () => undefined,
        rule.id === null
          ? "Search plan rule added."
          : "Search plan rule updated.",
        { scope: jobFinderPendingActions.campaignRule(campaignId, rule.id) },
      ),
    onDeleteCampaignRule: (campaignId: string, ruleId: string) =>
      runAction(
        () => actions.deleteCampaignRule(campaignId, ruleId),
        () => undefined,
        "Search plan rule removed.",
        { scope: jobFinderPendingActions.campaignRule(campaignId, ruleId) },
      ),
    onToggleCampaignRule: (
      campaignId: string,
      ruleId: string,
      enabled: boolean,
    ) =>
      runAction(
        () => actions.toggleCampaignRule(campaignId, ruleId, enabled),
        () => undefined,
        enabled ? "Search plan rule enabled." : "Search plan rule disabled.",
        { scope: jobFinderPendingActions.campaignRule(campaignId, ruleId) },
      ),
    onProjectCampaignRuleFunnel: (
      campaignId: string,
    ): Promise<CampaignRuleFunnelProjection> =>
      actions.projectCampaignRuleFunnel(campaignId),
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
    onResetWorkspace: () => {
      // Stay resolves false: take no action and keep every draft. Leave
      // resolves true after the controller discarded only the named draft
      // state, so the reset — and its success navigation — runs exactly once.
      return confirmLeaveDirtyResumeWorkspace("reset the workspace").then(
        (mayLeave) => {
          if (!mayLeave) {
            return;
          }

          return runAction(
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
          );
        },
      );
    },
    onResumeWorkspaceDirtyChange: setResumeWorkspaceDirty,
    onResumeWorkspaceDraftEdited,
    onSelectApplicationRecord: setSelectedApplicationRecordId,
    onSelectCampaign: (campaignId: string) =>
      confirmLeaveDirtyResumeWorkspace("switch search plans").then(
        (mayLeave) =>
          mayLeave
            ? runAction(
                () => actions.selectCampaign(campaignId),
                () => setDiscoveryRunFeedback(null),
                "Active search plan updated.",
              )
            : false,
      ),
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
    liveDiscoveryEvents,
    selectedReviewItem,
    selectedReviewJob,
    selectedTailoredAsset,
    resumeAssistantMessages: activeRouteResumeAssistantMessages,
    resumeAssistantPending: activeRouteResumeAssistantPending,
    resumeWorkspace: activeRouteResumeWorkspace,
    workspace,
  };
}
