import type {
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportInput,
  ApplicationCrmFileExportResult,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  ApplyGroupedManualAnswerInput,
  ApplyRunDetails,
  AppearanceTheme,
  CampaignRuleFunnelProjection,
  CandidateAnswerKind,
  CandidateReusableAnswer,
  CandidateLinkKind,
  CandidateProfile,
  ClearApplicationAnswerCommandInput,
  CompanyIntelligenceMutationInput,
  DiscoveryActivityEvent,
  DiscoveryFeedbackReason,
  EditableSourceInstructionArtifact,
  EmployerExclusionPreview,
  JobFinderApplicationPacketExportResult,
  ResolveSubmissionOutcomeInput,
  ResolveSubmissionOutcomeResult,
  JobFinderApplyConsentActionInput,
  JobFinderApplyCopilotActionInput,
  JobFinderApplyQueueActionInput,
  JobFinderApplyRunActionInput,
  JobFinderApplyQueueControlInput,
  JobFinderApproveResumesInput,
  JobFinderStartApplyQueueInput,
  JobFinderApplyRunDetailsQuery,
  JobFinderApplicationStartTarget,
  JobFinderPreparedApplicationPageInput,
  JobFinderAgentDiscoveryResult,
  JobFinderSearchRequest,
  JobFinderDiscoveryCancellationInput,
  JobFinderOpenBrowserSessionInput,
  JobFinderResumePreview,
  JobFinderResumeWorkspace,
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  JobFinderSettings,
  JobSearchPreferences,
  RapidReviewMutationInput,
  RecommendResumeStrategyInput,
  RecordOutcomeInput,
  ResumeStrategyRecommendation,
  ReviewCompanyMergeInput,
  SaveResumeStrategyInput,
  SafeguardMutationInput,
  SaveCampaignRuleInput,
  SaveJobSearchCampaignInput,
  SelectResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
  SetCompanyPreferenceInput,
  SetJobFinderActivityControlInput,
  SetOutcomeSuggestionEnabledInput,
  JobFinderRendererWorkspaceSnapshot,
  JobSourceAdapterKind,
  ProfileCopilotContext,
  ProfileSetupReviewAction,
  ProfileSetupReviewActionOptions,
  ProfileSetupState,
  ProjectGroupedManualAnswerCommand,
  ResumeAssistantMessage,
  ResumeApplicationMode,
  TailoringMode,
  JobFinderResumePdfExportResult,
  ResumePdfExportIntent,
  RemoveEmployerExclusionInput,
  RevealSavedFileResult,
  ResumeDraft,
  ResumeDraftPatch,
  ResumeTimelineRepairAction,
  SaveApplicationAnswerCommandInput,
  SnoozeGroupedDecisionInput,
  SourceDebugProgressEvent,
  SourceDebugRunDetails,
  SourceInstructionStatus,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
  UpdateAiBehaviorInput,
  WorkMode,
  UserActionCommandInput,
} from "@nestor/contracts";

export type JobFinderScreen =
  | "home"
  | "profile"
  | "discovery"
  | "review-queue"
  | "applications"
  | "campaigns"
  | "actions"
  | "analytics"
  | "settings"
  | "rapid-review"
  | "resume-strategies"
  | "safeguards"
  | "companies";

/**
 * Typed result of starting an employer-application batch queue. Curation is
 * consumed only on `confirmed`; every other status preserves the exact
 * staged selection so a refusal, handled backend failure, or unknown ending
 * can never silently discard the user's review work.
 */
export type JobFinderAutoApplyQueueStartOutcome =
  | { status: "confirmed" }
  | {
      status: "refused";
      reason:
        | "daily_capacity_exhausted"
        | "work_paused"
        | "empty_selection"
        | "cancelled_stayed_in_workspace";
      message: string | null;
    }
  | { status: "failed"; message: string | null }
  | { status: "unknown" };

export interface JobFinderShellActions {
  analyzeProfileFromResume: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  openBrowserSession: (
    input?: JobFinderOpenBrowserSessionInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  checkBrowserSession: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  performUserAction: (
    command: UserActionCommandInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  refreshWorkspace: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  /** Judges every job of the plan that has no fit verdict yet. */
  judgeUnjudgedJobs?: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  /** A paced background refresh; never stacks on another one. */
  requestWorkspaceRefresh?: () => void;
  resetWorkspace: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  resetBrowser: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  runAgentDiscovery: (
    onActivity?: (event: DiscoveryActivityEvent) => void,
    targetId?: string,
    searchRequest?: JobFinderSearchRequest,
  ) => Promise<JobFinderAgentDiscoveryResult>;
  cancelAgentDiscovery: (
    input: JobFinderDiscoveryCancellationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  runSourceDebug: (
    targetId: string,
    onProgress?: (event: SourceDebugProgressEvent) => void,
    options?: { readabilityTimeoutMs?: number },
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  getSourceDebugRunDetails: (runId: string) => Promise<SourceDebugRunDetails>;
  getApplyRunDetails: (
    input: JobFinderApplyRunDetailsQuery,
  ) => Promise<ApplyRunDetails>;
  saveApplicationAnswer: (
    command: SaveApplicationAnswerCommandInput,
  ) => Promise<ApplyRunDetails>;
  clearApplicationAnswer: (
    command: ClearApplicationAnswerCommandInput,
  ) => Promise<ApplyRunDetails>;
  projectGroupedManualAnswer: (
    command: ProjectGroupedManualAnswerCommand,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  applyGroupedManualAnswer: (
    input: ApplyGroupedManualAnswerInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  snoozeGroupedDecision: (
    input: SnoozeGroupedDecisionInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  exportApplicationPacket: (
    input: JobFinderApplyRunDetailsQuery,
  ) => Promise<JobFinderApplicationPacketExportResult>;
  resolveSubmissionOutcome: (
    input: ResolveSubmissionOutcomeInput,
  ) => Promise<ResolveSubmissionOutcomeResult>;
  saveSourceInstructionArtifact: (
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  acceptSourceInstructionDraft: (
    targetId: string,
    instructionId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  verifySourceInstructions: (
    targetId: string,
    instructionId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  importResume: (options?: {
    retryInterrupted?: boolean;
  }) => Promise<JobFinderRendererWorkspaceSnapshot>;
  saveProfile: (
    profile: CandidateProfile,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  saveWorkspaceInputs: (
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  saveSearchPreferences: (
    searchPreferences: JobSearchPreferences,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  saveCampaign: (
    campaign: SaveJobSearchCampaignInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  selectCampaign: (
    campaignId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  runCampaignNow: (
    campaignId?: string | null,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  markCampaignNotificationRead: (
    notificationId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  markAllCampaignNotificationsRead: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  saveCampaignRule: (
    campaignId: string,
    rule: SaveCampaignRuleInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  deleteCampaignRule: (
    campaignId: string,
    ruleId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  deleteCampaign: (campaignId: string) => Promise<boolean>;
  toggleCampaignRule: (
    campaignId: string,
    ruleId: string,
    enabled: boolean,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  projectCampaignRuleFunnel: (
    campaignId: string,
  ) => Promise<CampaignRuleFunnelProjection>;
  setActivityControl: (
    input: SetJobFinderActivityControlInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  mutateRapidReview: (
    input: RapidReviewMutationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  recordOutcome: (
    input: RecordOutcomeInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  saveResumeStrategy: (
    input: SaveResumeStrategyInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  disableResumeStrategy: (
    strategyId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  selectResumeStrategy: (
    input: SelectResumeStrategyInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  recommendResumeStrategy: (
    input: RecommendResumeStrategyInput,
  ) => Promise<ResumeStrategyRecommendation>;
  setCampaignResumeStrategyDefault: (
    input: SetCampaignResumeStrategyDefaultInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  refreshCompanyIntelligence: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  setCompanyPreference: (
    input: SetCompanyPreferenceInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  reviewCompanyMerge: (
    input: ReviewCompanyMergeInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  mutateCompanyIntelligence: (
    input: CompanyIntelligenceMutationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  setOutcomeSuggestionEnabled: (
    input: SetOutcomeSuggestionEnabledInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  mutateSafeguards: (
    input: SafeguardMutationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  saveSettings: (
    settings: JobFinderSettings,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  updateApplicationDefaults: (
    input: UpdateApplicationDefaultsInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  updateWorkspaceBehavior: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  updateAiBehavior: (
    input: UpdateAiBehaviorInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  updateAppearanceTheme: (
    appearanceTheme: AppearanceTheme,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  updateTrackerCrm: (
    applicationCrm: ApplicationCrmSettings,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  saveProfileSetupState: (
    profileSetupState: ProfileSetupState,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  applyProfileSetupReviewAction: (
    reviewItemId: string,
    action: ProfileSetupReviewAction,
    options?: ProfileSetupReviewActionOptions,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  applyResumeTimelineRepairAction: (
    runId: string,
    proposalId: string,
    action: ResumeTimelineRepairAction,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  sendProfileCopilotMessage: (
    content: string,
    context?: ProfileCopilotContext,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  applyProfileCopilotPatchGroup: (
    patchGroupId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  rejectProfileCopilotPatchGroup: (
    patchGroupId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  undoProfileRevision: (
    revisionId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  assessJobListing: (
    jobId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  queueJobForReview: (
    jobId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  queueJobsForReview?: (
    jobIds: readonly string[],
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  removeJobsFromReview?: (
    jobIds: readonly string[],
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  dismissDiscoveryJobs?: (
    jobIds: readonly string[],
    reasons: readonly DiscoveryFeedbackReason[],
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  setJobResumeApplicationMode: (
    jobId: string,
    resumeApplicationMode: ResumeApplicationMode,
    resumeTailoringMode?: TailoringMode | null,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  removeJobFromReview: (
    jobId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  dismissDiscoveryJob: (
    jobId: string,
    reasons: readonly DiscoveryFeedbackReason[],
    action?: "hide_job" | "hide_and_exclude_employer",
    expectedNormalizedCompanyName?: string | null,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  previewEmployerExclusion: (
    jobId: string,
  ) => Promise<EmployerExclusionPreview>;
  removeEmployerExclusion: (
    input: RemoveEmployerExclusionInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  restoreDismissedDiscoveryJob: (
    jobId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  getResumeWorkspace: (jobId: string) => Promise<JobFinderResumeWorkspace>;
  previewResumeDraft: (
    draft: ResumeDraft,
    requestId?: string,
  ) => Promise<JobFinderResumePreview>;
  saveResumeDraft: (
    draft: ResumeDraft,
    autosaveSessionId?: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  regenerateResumeDraft: (
    jobId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  regenerateResumeSection: (
    jobId: string,
    sectionId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  restoreResumeDraftRevision: (
    jobId: string,
    revisionId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  undoResumeAssistantEdit: (
    jobId: string,
    revisionId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  exportResumePdf: (
    jobId: string,
    intent?: ResumePdfExportIntent,
  ) => Promise<JobFinderResumePdfExportResult>;
  /**
   * Shows a file the app wrote in the OS file manager. The export already
   * named the path and then left the person to find it by hand; nothing is
   * opened or executed, only selected.
   */
  revealSavedFile: (path: string) => Promise<RevealSavedFileResult>;
  approveResume: (
    jobId: string,
    exportId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  clearResumeApproval: (
    jobId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  setWorkHistoryReviewAcknowledgment: (
    input: JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  setResumeClaimConfirmation: (
    input: JobFinderSetResumeClaimConfirmationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  applyResumePatch: (
    patch: ResumeDraftPatch,
    revisionReason?: string | null,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  getResumeAssistantMessages: (
    jobId: string,
  ) => Promise<readonly ResumeAssistantMessage[]>;
  sendResumeAssistantMessage: (
    jobId: string,
    content: string,
  ) => Promise<readonly ResumeAssistantMessage[]>;
  resolveResumeAssistantProposal: (
    jobId: string,
    proposalId: string,
    action: "accept" | "reject",
    patchIds: readonly string[],
  ) => Promise<readonly ResumeAssistantMessage[]>;
  generateResume: (
    jobId: string,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  startApplyCopilotRun: (
    input: JobFinderApplyCopilotActionInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  startAutoApplyRun: (
    input: JobFinderApplicationStartTarget,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  startAutoApplyQueueRun: (
    jobIds: JobFinderApplyQueueActionInput["jobIds"],
    applicationAutomationMode?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  /** One Apply press over many jobs: a saved queue of runs of ten. */
  startApplyQueue: (
    input: JobFinderStartApplyQueueInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  /** The person's "Approve N resumes" press. */
  approveResumes: (
    input: JobFinderApproveResumesInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  controlApplyQueue: (
    input: JobFinderApplyQueueControlInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  approveApplyRun: (
    input: JobFinderApplyRunActionInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  cancelApplyRun: (
    input: JobFinderApplyRunActionInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  resolveApplyConsentRequest: (
    input: JobFinderApplyConsentActionInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  revokeApplyRunApproval: (
    input: JobFinderApplyRunActionInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  focusPreparedApplicationPage: (
    input: JobFinderPreparedApplicationPageInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  /** Sends one application the person has already looked over. */
  submitPreparedApplication: (input: {
    jobId: string;
  }) => Promise<JobFinderRendererWorkspaceSnapshot>;
  /** Send for me: sends each filled-in form under one permission. */
  sendPreparedApplications: (input: {
    jobIds: string[];
  }) => Promise<JobFinderRendererWorkspaceSnapshot>;
  approveApply: (
    input: JobFinderApplicationStartTarget,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  mutateApplicationCrm: (
    input: ApplicationCrmMutationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  mutateApplicationCrmBulkStage: (
    input: ApplicationCrmBulkStageMutationInput,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  runApplicationNoResponseAutomation: (
    settings?: ApplicationCrmSettings,
  ) => Promise<JobFinderRendererWorkspaceSnapshot>;
  exportApplicationCrm: (
    input: ApplicationCrmExportInput,
  ) => Promise<ApplicationCrmFileExportResult>;
}

export interface ScreenDefinition {
  id: JobFinderScreen;
  label: string;
  count: number | null;
}

export type ExperienceFormEntry = {
  id: string;
  companyName: string;
  companyUrl: string;
  title: string;
  employmentType: string;
  location: string;
  workMode: WorkMode[];
  startDate: string;
  endDate: string;
  isCurrent: boolean;
  summary: string;
  achievements: string;
  skills: string;
  domainTags: string;
  peopleManagementScope: string;
  ownershipScope: string;
  sourceCandidateId?: string | null;
  sourceCandidateFingerprint?: string | null;
};

export type EducationFormEntry = {
  id: string;
  schoolName: string;
  degree: string;
  fieldOfStudy: string;
  location: string;
  startDate: string;
  endDate: string;
  summary: string;
  sourceCandidateId?: string | null;
  sourceCandidateFingerprint?: string | null;
};

export type CertificationFormEntry = {
  id: string;
  name: string;
  issuer: string;
  issueDate: string;
  expiryDate: string;
  credentialUrl: string;
};

export type LinkFormEntry = {
  id: string;
  label: string;
  url: string;
  kind: CandidateLinkKind | "";
};

export type ProjectFormEntry = {
  id: string;
  name: string;
  projectType: string;
  summary: string;
  role: string;
  skills: string;
  outcome: string;
  projectUrl: string;
  repositoryUrl: string;
  caseStudyUrl: string;
};

export type LanguageFormEntry = {
  id: string;
  language: string;
  proficiency: string;
  interviewPreference: boolean;
  notes: string;
};

export type ProofBankEntryFormEntry = {
  id: string;
  title: string;
  claim: string;
  heroMetric: string;
  supportingContext: string;
  roleFamilies: string;
  projectIds: string;
  linkIds: string;
};

export type ReusableAnswerFormEntry = {
  needsConfirmation?: boolean;
  applicationScope?: CandidateReusableAnswer["applicationScope"];
  id: string;
  label: string;
  question: string;
  answer: string;
  kind: CandidateAnswerKind;
  roleFamilies: string;
  proofEntryIds: string;
};

export type DiscoveryTargetEditorValue = {
  id: string;
  label: string;
  startingUrl: string;
  enabled: boolean;
  adapterKind: JobSourceAdapterKind;
  customInstructions: string;
  instructionStatus: SourceInstructionStatus;
  validatedInstructionId: string | null;
  draftInstructionId: string | null;
  lastDebugRunId: string | null;
  lastVerifiedAt: string | null;
  staleReason: string | null;
};

export type BooleanSelectValue = "" | "yes" | "no";

export type BadgeTone =
  | "active"
  | "critical"
  | "muted"
  | "neutral"
  | "positive"
  /**
   * Attention that is not yet a failure: a blocked claim, a pending
   * work-history decision, a paused run awaiting the user. Before this member
   * existed those states borrowed `critical` (overstating them) or `neutral`
   * (hiding them), while `--warning-text` was used by nothing.
   */
  | "warning";

export interface ActionState {
  message: string | null;
  /**
   * What the message reports: `success` (the action finished as asked),
   * `failure` (it was refused or failed and the person may need to act), or
   * `progress` (still running). A success may become a toast; a failure and
   * a message without a tone always stay inline (ADR 0042).
   */
  tone?: "success" | "failure" | "progress" | null;
  toastTone?: "success" | "warning";
  /**
   * A file this action just wrote, when the message names its path. The
   * surface that prints the message offers "Open folder" beside it, so the
   * path is an action rather than something to retype.
   */
  savedFilePath?: string | null;
  /** Where the message's natural next step lives, offered beside it. */
  actionLink?: { label: string; route: string } | null;
  /** Puts back what a quick action took away; the toast offers Undo. */
  undo?: (() => void) | null;
}

/**
 * Request-local resolution of one Shortlist decision. `onQueueJob` returns
 * this awaited outcome so the Discovery screen can attribute feedback to the
 * exact clicked job; the shared route-scoped `ActionState` keeps serving other
 * surfaces but is never the attribution authority for a shortlist row.
 */
export type JobFinderQueuedJobOutcome = {
  message: string;
  status: "success" | "failure";
};
