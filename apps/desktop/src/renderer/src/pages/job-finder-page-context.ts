import type {
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportFormat,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  AppearanceTheme,
  ApplyGroupedManualAnswerInput,
  ApplyRunDetails,
  CampaignRuleFunnelProjection,
  ClearApplicationAnswerCommandInput,
  CandidateProfile,
  CompanyIntelligenceMutationInput,
  DiscoveryActivityEvent,
  DiscoveryFeedbackReason,
  EditableSourceInstructionArtifact,
  EmployerExclusionPreview,
  JobFinderApplyConsentActionInput,
  JobFinderApplyQueueActionInput,
  JobFinderApplyRunActionInput,
  JobFinderApplyRunDetailsQuery,
  JobFinderApplicationStartTarget,
  JobFinderOpenBrowserSessionInput,
  JobFinderPreparedApplicationPageInput,
  JobFinderSearchRequest,
  JobFinderResumePreview,
  JobFinderResumeWorkspace,
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderRendererWorkspaceSnapshot,
  JobSearchPreferences,
  ProfileCopilotContext,
  ProfileSetupReviewActionOptions,
  ProfileSetupStep,
  ProjectGroupedManualAnswerCommand,
  RapidReviewMutationInput,
  RecommendResumeStrategyInput,
  RecordOutcomeInput,
  RemoveEmployerExclusionInput,
  ResumeStrategyRecommendation,
  ResumeImportProgressEvent,
  ResumeApplicationMode,
  TailoringMode,
  ResumeTimelineRepairAction,
  SaveApplicationAnswerCommandInput,
  SaveCampaignRuleInput,
  SaveJobSearchCampaignInput,
  SaveResumeStrategyInput,
  SafeguardMutationInput,
  SelectResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
  SetJobFinderActivityControlInput,
  SetOutcomeSuggestionEnabledInput,
  SnoozeGroupedDecisionInput,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
  UpdateAiBehaviorInput,
  ResumeAssistantMessage,
  ResumeDraft,
  ResumeDraftPatch,
  SourceDebugRunDetails,
  UserActionCommandInput,
} from "@nestor/contracts";
import type { PendingActionScope } from "./job-finder-pending-actions";
import type {
  ActionState,
  JobFinderAutoApplyQueueStartOutcome,
  JobFinderQueuedJobOutcome,
} from "@renderer/features/job-finder/lib/job-finder-types";
import type { DiscoveryRunFeedback } from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import type { TailoredDraftPreparationViewState } from "@renderer/features/job-finder/screens/review-queue/review-queue-status";
import type { ResumeWorkHistoryDecisionRequest } from "@renderer/features/job-finder/screens/review-queue/resume-workspace-work-history-decisions";
import type { JobFinderSaveState } from "./job-finder-save-state";
import type { ApplyQueueControlAction } from "@renderer/features/job-finder/lib/apply-queue-view";

/**
 * Opt-in error propagation for one call, not a mode change for the action.
 *
 * Every Job Finder action reports its own failure once, as a route message, and
 * then resolves `false` — a caller that only fires and forgets wants exactly
 * that. A caller that reports the failure IN PLACE needs the cause as well, and
 * cannot get it from a boolean: the Applications hand-off composed "The Job
 * Finder browser did not open…" with nothing where the reason belonged. Passing
 * this makes the returned promise reject with the underlying error for that
 * call only; the route message is written either way, and no other caller's
 * behaviour changes.
 */
export type JobFinderActionFailureReporting = {
  readonly rethrowError?: boolean;
};

export interface JobFinderPageContext {
  actionState: ActionState;
  canImportResume: boolean;
  discoveryRunFeedback: DiscoveryRunFeedback | null;
  importResumeGuardMessage: string | null;
  isPending: (scope: PendingActionScope) => boolean;
  resumeOperationStarts?: Readonly<Record<string, number>>;
  isAnyPending: (scopes: readonly PendingActionScope[]) => boolean;
  onPrepareTailoredDrafts: (jobIds?: readonly string[]) => void;
  onStopTailoredDraftPreparation: () => void;
  tailoredDraftPreparation: TailoredDraftPreparationViewState;
  profileCopilotBusy: boolean;
  resumeImportProgress: ResumeImportProgressEvent | null;
  saveState: JobFinderSaveState;
  liveDiscoveryEvents: readonly DiscoveryActivityEvent[];
  onAnalyzeProfileFromResume: () => void;
  onApplyGroupedManualAnswer: (input: ApplyGroupedManualAnswerInput) => void;
  onApproveApplyRun: (input: JobFinderApplyRunActionInput) => void;
  onApproveApply: (jobId: string) => void;
  onCancelApplyRun: (input: JobFinderApplyRunActionInput) => Promise<boolean>;
  onRevokeApplyRunApproval: (input: JobFinderApplyRunActionInput) => void;
  onResolveApplyConsentRequest: (
    input: JobFinderApplyConsentActionInput,
  ) => void;
  onStartAutoApply: (input: JobFinderApplicationStartTarget) => void;
  onStartAutoApplyQueue: (
    jobIds: JobFinderApplyQueueActionInput["jobIds"],
    applicationAutomationMode?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
    options?: { stayOnCurrentPage?: boolean },
  ) => Promise<JobFinderAutoApplyQueueStartOutcome>;
  /** The person's "Approve N resumes" press on Shortlisted. */
  onApproveResumes: (jobIds: readonly string[]) => Promise<boolean>;
  /** Pause, Continue, Stop or Dismiss the Apply queue (ADR 0058). */
  onControlApplyQueue: (action: ApplyQueueControlAction) => void;
  onStartApplyCopilot: (input: JobFinderApplicationStartTarget) => void;
  onReviewResumePdf: (jobId: string) => void;
  /** Sends one finished application after the person presses Send. */
  onSubmitPreparedApplication: (jobId: string) => Promise<void>;
  /**
   * Send for me: presses Send on each filled-in form, one after another,
   * including forms filled in before Send for me was chosen.
   */
  onSendPreparedApplications: (jobIds: readonly string[]) => Promise<void>;
  onApplyProfileCopilotPatchGroup: (patchGroupId: string) => void;
  onApplyProfileSetupReviewAction: (
    reviewItemId: string,
    action: "confirm" | "dismiss" | "clear_value",
    options?: ProfileSetupReviewActionOptions,
  ) => void;
  onApplyResumeTimelineRepairAction: (
    runId: string,
    proposalId: string,
    action: ResumeTimelineRepairAction,
  ) => Promise<void>;
  onCheckBrowserSession: () => void;
  onDismissJob: (
    jobId: string,
    reasons: readonly DiscoveryFeedbackReason[],
    action?: "hide_job" | "hide_and_exclude_employer",
    expectedNormalizedCompanyName?: string | null,
    /** `quiet`: no success message; the triage bar says it and offers Undo. */
    options?: { quiet?: boolean },
  ) => Promise<void>;
  onPreviewEmployerExclusion: (
    jobId: string,
  ) => Promise<EmployerExclusionPreview>;
  onRemoveEmployerExclusion: (input: RemoveEmployerExclusionInput) => void;
  /** `quiet`: no success message; the triage bar's Undo asked for it. */
  onRestoreDismissedJob: (
    jobId: string,
    options?: { quiet?: boolean },
  ) => void;
  onEditResumeWorkspace: (jobId: string) => void;
  onGenerateResume: (
    jobId: string,
    options?: { selectAfter?: boolean },
  ) => Promise<boolean>;
  onRemoveReviewJob: (jobId: string) => void;
  onRemoveReviewJobs?: (
    jobIds: readonly string[],
    options?: { quiet?: boolean },
  ) => Promise<void>;
  onMutateRapidReview: (input: RapidReviewMutationInput) => Promise<void>;
  onMutateSafeguards: (input: SafeguardMutationInput) => Promise<boolean>;
  onApproveCurrentResume: (jobId: string) => void;
  /**
   * Approves the resume in the background and opens the next one to review
   * (or Shortlisted when none is left). `exportId` approves a PDF already
   * built from the saved draft instead of building one.
   */
  onApproveResumeAndContinue: (
    jobId: string,
    nextJobId: string | null,
    exportId?: string,
  ) => void;
  /** Approves a Light or Tailored draft and starts the application in one press. */
  onApproveResumeAndApply: (jobId: string) => void;
  onApproveResume: (jobId: string, exportId: string) => void;
  onClearResumeApproval: (jobId: string) => void;
  onSetWorkHistoryReviewAcknowledgment: (
    jobId: string,
    decision: ResumeWorkHistoryDecisionRequest,
  ) => void;
  /**
   * Typed passthrough to the fenced shell command; the Resume workspace owns
   * pending state and feedback for this action.
   */
  onSetResumeClaimConfirmation: (
    input: JobFinderSetResumeClaimConfirmationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  onExportResumePdf: (jobId: string) => void;
  /** Records that the imported resume is this person's own document. */
  onClaimResumeIdentity: () => void;
  /** Replaces the editable profile name with the imported resume's name. */
  onKeepResumeIdentity: () => void;
  /** Shows a file the app wrote in the OS file manager. Nothing is opened. */
  onRevealSavedFile: (path: string) => void;
  onPreviewResumeDraft: (
    draft: ResumeDraft,
    requestId?: string,
  ) => Promise<JobFinderResumePreview>;
  onGetApplyRunDetails: (
    input: JobFinderApplyRunDetailsQuery,
  ) => Promise<ApplyRunDetails>;
  onSaveApplicationAnswer: (
    command: SaveApplicationAnswerCommandInput,
  ) => Promise<ApplyRunDetails>;
  onClearApplicationAnswer: (
    command: ClearApplicationAnswerCommandInput,
  ) => Promise<ApplyRunDetails>;
  onExportApplicationPacket: (
    input: JobFinderApplyRunDetailsQuery,
  ) => Promise<void>;
  onResolveSubmissionOutcome: (
    uncertainOutcomeId: string,
    resolution: "submitted" | "not_submitted",
  ) => Promise<void>;
  onExportApplicationCrm: (
    format: ApplicationCrmExportFormat,
    recordId: string,
  ) => Promise<void>;
  onMutateApplicationCrm: (
    command: ApplicationCrmMutationInput,
  ) => Promise<void>;
  onMutateApplicationCrmBulkStage: (
    command: ApplicationCrmBulkStageMutationInput,
  ) => Promise<void>;
  onRefreshCompanyIntelligence: () => Promise<void>;
  onMutateCompanyIntelligence: (
    command: CompanyIntelligenceMutationInput,
  ) => Promise<void>;
  onSetCompanyPreference: (input: {
    companyId: string;
    preference: "neutral" | "follow" | "prefer" | "review" | "exclude";
  }) => Promise<void>;
  onReviewCompanyMerge: (input: {
    companyId: string;
    candidateId: string;
    decision: "accepted" | "rejected";
  }) => Promise<void>;
  onGetSourceDebugRunDetails: (runId: string) => Promise<SourceDebugRunDetails>;
  /** `retryInterrupted` imports again the file a stopped import saved. */
  onImportResume: (options?: { retryInterrupted?: boolean }) => void;
  onCancelImportResume: () => void;
  /**
   * Opens or focuses the Job Finder browser and resolves with whether that
   * actually happened. The result used to be discarded (`void runAction(...)`),
   * so a caller that reported an outcome beside the control could only report
   * an optimistic success: the rejection never reached it. Callers that do not
   * report an outcome still `void` the promise at their own call site.
   */

  onOpenBrowserSession: (
    input?: JobFinderOpenBrowserSessionInput,
    options?: JobFinderActionFailureReporting,
  ) => Promise<boolean>;
  onFocusPreparedApplicationPage: (
    input: JobFinderPreparedApplicationPageInput,
    options?: JobFinderActionFailureReporting,
  ) => Promise<boolean>;
  onOpenProfile: () => void;
  onNavigateSafely: (path: string) => void;
  /**
   * Sends one Needs-you command and resolves with whether it succeeded, for
   * the same reason as {@link JobFinderPageContext.onOpenBrowserSession}.
   * The failure is still reported once as a route banner by the action runner;
   * the boolean is what lets a surface say in place that nothing opened.
   */
  onPerformUserAction: (
    command: UserActionCommandInput,
    options?: JobFinderActionFailureReporting,
  ) => Promise<boolean>;
  onProjectGroupedManualAnswer: (
    command: ProjectGroupedManualAnswerCommand,
  ) => void;
  onProfileSurfaceDirtyChange: (dirty: boolean) => void;
  onSearchPlanSurfaceDirtyChange: (dirty: boolean) => void;
  /**
   * Reports each user-authored Profile or setup draft edit — including edits
   * made while the surface was already dirty, when no dirty transition
   * fires — so the shell's exact-request save retry stays truthful.
   */
  onProfileSurfaceDraftEdited: () => void;
  /** Reports staged settings edits so the shell save retry stays truthful. */
  onSettingsDraftEdited: () => void;
  profileCopilotPendingContextKey: string | null;
  onAssessJobListing: (jobId: string) => Promise<void>;
  onJudgeUnjudgedJobs?: () => Promise<void>;
  /** `quiet`: no success message; the triage bar says it and offers Undo. */
  onQueueJob: (
    jobId: string,
    options?: { quiet?: boolean },
  ) => Promise<JobFinderQueuedJobOutcome>;
  onQueueJobs?: (
    jobIds: readonly string[],
  ) => Promise<JobFinderQueuedJobOutcome>;
  onDismissJobs?: (jobIds: readonly string[]) => Promise<void>;
  onSetJobResumeApplicationMode: (
    jobId: string,
    resumeApplicationMode: ResumeApplicationMode,
    resumeTailoringMode?: TailoringMode | null,
  ) => void;
  onRejectProfileCopilotPatchGroup: (patchGroupId: string) => void;
  onResetWorkspace: () => void | Promise<boolean | void>;
  onResetBrowser: () => Promise<boolean>;
  onResumeProfileSetup: (step?: ProfileSetupStep) => void;
  onRunAgentDiscovery?: (searchRequest?: JobFinderSearchRequest) => void;
  /**
   * Cancels the active discovery run through the same fenced preload request
   * the shell Task Center uses; when absent, no surface offers a stop action.
   */
  onCancelDiscovery?: (runId: string) => Promise<boolean>;
  onRunDiscoveryForTarget?: (targetId: string) => void;
  onRefreshResumeWorkspace: (jobId: string) => void;
  onResumeWorkspaceDirtyChange: (dirty: boolean) => void;
  /**
   * Reports each user-authored Resume Studio draft edit — including edits
   * made while the workspace was already dirty, when no dirty transition
   * fires — so the shell's exact-request save retry stays truthful.
   */
  onResumeWorkspaceDraftEdited: () => void;
  onRegenerateResumeDraft: (jobId: string) => void;
  onRegenerateResumeSection: (jobId: string, sectionId: string) => void;
  onRestoreResumeDraftRevision: (jobId: string, revisionId: string) => void;
  onUndoResumeAssistantEdit: (jobId: string, revisionId: string) => void;
  onWriteEditableResumeForOriginalJob: (
    jobId: string,
    pendingRequest: string | null,
  ) => void;
  onSaveResumeDraft: (draft: ResumeDraft) => void;
  /** Saves Resume Studio edits by itself; resolves with what happened. */
  onAutosaveResumeDraft: (
    draft: ResumeDraft,
    onSaved: (updatedAt: string) => void,
    autosaveSessionId?: string,
  ) => Promise<{ saved: true } | { saved: false; message: string }>;
  onSaveResumeDraftAndThen: (
    draft: ResumeDraft,
    next: () => void | Promise<void>,
    successMessage?: string | null,
  ) => void;
  onSaveSetupStep: (
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
    nextStep: ProfileSetupStep,
    options?: {
      message?: string;
      openProfile?: boolean;
      stayOnCurrentStep?: boolean;
    },
  ) => void;
  onApplyResumePatch: (
    patch: ResumeDraftPatch,
    revisionReason?: string | null,
  ) => void;
  onSendProfileCopilotMessage: (
    content: string,
    context?: ProfileCopilotContext,
  ) => void | Promise<boolean>;
  onSendResumeAssistantMessage: (jobId: string, content: string) => void;
  onResolveResumeAssistantProposal: (
    jobId: string,
    proposalId: string,
    action: "accept" | "reject",
    patchIds: readonly string[],
  ) => void;
  onUndoProfileRevision: (revisionId: string) => void;
  onRunSourceDebug: (
    targetId: string,
    options?: { readabilityTimeoutMs?: number },
  ) => void;
  onRecordOutcome: (input: RecordOutcomeInput) => Promise<boolean>;
  onSetOutcomeSuggestionEnabled: (
    input: SetOutcomeSuggestionEnabledInput,
  ) => Promise<boolean>;
  onSaveResumeStrategy: (input: SaveResumeStrategyInput) => Promise<boolean>;
  onDisableResumeStrategy: (strategyId: string) => void;
  onSelectResumeStrategy: (input: SelectResumeStrategyInput) => void;
  onRecommendResumeStrategy: (
    input: RecommendResumeStrategyInput,
  ) => Promise<ResumeStrategyRecommendation | null>;
  onSetCampaignResumeStrategyDefault: (
    input: SetCampaignResumeStrategyDefaultInput,
  ) => void;
  onSaveAll: (
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
  ) => void;
  onSaveCampaign: (campaign: SaveJobSearchCampaignInput) => Promise<boolean>;
  onRunCampaignNow: (campaignId?: string | null) => Promise<boolean>;
  onDeleteCampaign: (campaignId: string) => Promise<boolean>;
  onMarkCampaignNotificationRead: (notificationId: string) => void;
  onMarkAllCampaignNotificationsRead: () => void;
  onSaveCampaignRule: (
    campaignId: string,
    rule: SaveCampaignRuleInput,
  ) => Promise<boolean>;
  onDeleteCampaignRule: (
    campaignId: string,
    ruleId: string,
  ) => Promise<boolean>;
  onToggleCampaignRule: (
    campaignId: string,
    ruleId: string,
    enabled: boolean,
  ) => Promise<boolean>;
  onProjectCampaignRuleFunnel: (
    campaignId: string,
  ) => Promise<CampaignRuleFunnelProjection>;
  onSaveProfile: (profile: CandidateProfile) => void;
  onSaveSearchPreferences: (searchPreferences: JobSearchPreferences) => void;
  onUpdateApplicationDefaults: (
    input: UpdateApplicationDefaultsInput,
  ) => Promise<boolean>;
  onUpdateWorkspaceBehavior: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean>;
  onUpdateAiBehavior: (input: UpdateAiBehaviorInput) => Promise<boolean>;
  onUpdateAppearanceTheme: (
    appearanceTheme: AppearanceTheme,
  ) => Promise<boolean>;
  onUpdateTrackerCrm: (
    applicationCrm: ApplicationCrmSettings,
  ) => Promise<boolean>;
  onSaveSourceInstructionArtifact: (
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ) => void;
  onSelectApplicationRecord: (recordId: string) => void;
  onSelectCampaign: (campaignId: string) => Promise<boolean>;
  onSelectDiscoveryJob: (jobId: string) => void;
  onSelectReviewItem: (jobId: string) => void;
  onSetActivityControl: (
    input: SetJobFinderActivityControlInput,
  ) => Promise<boolean>;
  onSnoozeGroupedDecision: (input: SnoozeGroupedDecisionInput) => void;
  onVerifySourceInstructions: (targetId: string, instructionId: string) => void;
  selectedApplicationAttempt:
    | JobFinderRendererWorkspaceSnapshot["applicationAttempts"][number]
    | null;
  selectedApplicationRecord:
    | JobFinderRendererWorkspaceSnapshot["applicationRecords"][number]
    | null;
  selectedDiscoveryJob:
    | JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number]
    | null;
  selectedReviewItem:
    | JobFinderRendererWorkspaceSnapshot["reviewQueue"][number]
    | null;
  selectedReviewJob:
    | JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number]
    | null;
  selectedTailoredAsset:
    | JobFinderRendererWorkspaceSnapshot["tailoredAssets"][number]
    | null;
  resumeAssistantMessages: readonly ResumeAssistantMessage[];
  resumeAssistantPending: boolean;
  resumeWorkspace: JobFinderResumeWorkspace | null;
  workspace: JobFinderRendererWorkspaceSnapshot;
}
