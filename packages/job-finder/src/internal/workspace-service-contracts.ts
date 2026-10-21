import type {
  AddBrowserJobResult,
  ApplicationDocumentRevision,
  ApplicationQuestionRecord,
  ApplicationRecord,
  ResumeBatchGenerationResult,
  ResumeBatchGenerationProgress,
  ResumeBatchProviderBlock,
  ResumeBatchCheckpoint,
} from "@nestor/contracts";
import type {
  JobFinderAiClient,
  ResumeVisionProvider,
} from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type {
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportInput,
  ApplicationCrmExportResult,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  ApplicationAutomationMode,
  AppearanceTheme,
  ApplicationPacket,
  RawApplyPage,
  CampaignRuleFunnelProjection,
  CandidateAsset,
  CandidateAssetListInput,
  CandidateAssetListResult,
  ClearApplicationAnswerCommandInput,
  CompanyIntelligenceMutationInput,
  ApplyRunDetails,
  ApplyGroupedManualAnswerInput,
  DeleteCampaignRuleInput,
  DeleteJobSearchCampaignInput,
  DiscoveryRunScope,
  DiscoveryFeedbackBatchResult,
  CandidateProfile,
  DiscoveryActivityEvent,
  EditableSourceInstructionArtifact,
  EmployerExclusionPreview,
  JobFinderApplyCopilotActionInput,
  JobFinderDismissDiscoveryJobInput,
  JobFinderOpenBrowserSessionInput,
  JobFinderResumePreview,
  ResumeDocumentBundle,
  JobFinderInterviewFollowUpInput,
  ResumeImportFieldCandidate,
  ResumeImportRun,
  ResumeTimelineRepairAction,
  ResumeImportVisionArtifact,
  ResumeApplicationMode,
  TailoringMode,
  ResumeSourceDocument,
  JobFinderResumeWorkspace,
  JobFinderSettings,
  JobFinderSearchRequest,
  JobFinderWorkspaceSnapshot,
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  JobFinderSetResumeClaimConfirmationInput,
  JobSearchPreferences,
  JobSearchCampaignMode,
  MarkAllCampaignNotificationsReadInput,
  MarkCampaignNotificationReadInput,
  ProfileCopilotContext,
  ProfileSetupState,
  ProfileSetupReviewAction,
  ProfileSetupReviewActionOptions,
  ProjectCampaignRuleFunnelInput,
  ProjectGroupedManualAnswerCommand,
  RapidReviewMutationInput,
  RecommendResumeStrategyInput,
  RecordOutcomeInput,
  RemoveEmployerExclusionInput,
  ResumeStrategyRecommendation,
  ReviewCompanyMergeInput,
  RunCampaignNowInput,
  SaveResumeStrategyInput,
  SafeguardBlockerView,
  SafeguardMutationInput,
  SafeguardsOverview,
  SelectResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
  SetCompanyPreferenceInput,
  SetOutcomeSuggestionEnabledInput,
  SnoozeGroupedDecisionInput,
  ResumeAssistantMessage,
  ResumeDraft,
  ResumeDraftPatch,
  ResumeResearchArtifact,
  ResumeTemplateId,
  ResumeTemplateDefinition,
  SavedJob,
  SaveCampaignRuleRouteInput,
  SaveJobSearchCampaignInput,
  JobFinderActivityControl,
  JobFinderPreparedApplicationPageInput,
  SetJobFinderActivityControlInput,
  SaveApplicationAnswerCommandInput,
  SourceDebugProgressEvent,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
  ToggleCampaignRuleInput,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
  UpdateAiBehaviorInput,
  SaveUserActionAnswerDraftInput,
  UserActionCommandInput,
  CandidateAssetKind,
  AssistantChangeEntry,
  JobPosting,
  ProfileCopilotPatchOperation,
} from "@nestor/contracts";
import type { JobFinderRepository, JobFinderRepositorySeed } from "@nestor/db";
import type {
  AssistantEditResult,
  AssistantProfileEditResult,
  AssistantUndoResult,
} from "./workspace-assistant-edit-methods";
import type { ResumeSpecialistResult } from "./workspace-assistant-resume-specialist";
import type { ResumeExportFileVerifier } from "./workspace-service-context";
import type { ResumeRenderDocument } from "./resume-workspace-structure";
import type { ListingHtmlFetcher } from "./listing-detail-enrichment";

export interface JobFinderWorkspaceResetOptions {
  /**
   * Runs while the service reset gate is held, immediately before replacing
   * the repository state. Desktop callers use this to remove app-owned files
   * without allowing a new operation to start between the file and database
   * reset.
   */
  beforeStateReset?: () => Promise<void>;
}

export interface DiscoveryFeedbackBatchOptions {
  signal?: AbortSignal;
  /** Checked before every write, including inside the repository transaction. */
  assertCurrent?: () => void;
}

export interface JobFinderWorkspaceService {
  refreshApprovedApplicationLetter(
    document: ApplicationDocumentRevision,
  ): Promise<void>;
  shutdown(): Promise<void>;
  getWorkspaceSnapshot(): Promise<JobFinderWorkspaceSnapshot>;
  /** Read-only display projection; validated job rows may be shared in main. */
  getWorkspaceProjection?(): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * What an application's documents are written against: the profile, the
   * one job, its application record and its newest result. Read by id, so
   * opening Applications does not rebuild the whole workspace.
   */
  getApplicationDocumentContext?(
    jobId: string,
    applicationRecordId: string,
  ): Promise<{
    profile: JobFinderWorkspaceSnapshot["profile"];
    job: SavedJob | null;
    applicationRecord:
      | JobFinderWorkspaceSnapshot["applicationRecords"][number]
      | null;
    latestResult: JobFinderWorkspaceSnapshot["applyJobResults"][number] | null;
  }>;
  /**
   * Returns the small, shell-safe first paint. Deferred collections are empty
   * by design and are marked in the snapshot hydration metadata.
   */
  getWorkspaceBootstrap(): Promise<JobFinderWorkspaceSnapshot>;
  getResumeImportState(): Promise<{
    activeVisionRunIds: readonly string[];
    resumeImportRuns: readonly ResumeImportRun[];
    resumeImportDocumentBundles: readonly ResumeDocumentBundle[];
    resumeImportFieldCandidates: readonly ResumeImportFieldCandidate[];
  }>;
  openBrowserSession(
    input?: JobFinderOpenBrowserSessionInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  checkBrowserSession(): Promise<JobFinderWorkspaceSnapshot>;
  saveUserActionAnswerDraft(
    input: SaveUserActionAnswerDraftInput,
  ): Promise<void>;
  performUserAction(
    command: UserActionCommandInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  projectGroupedManualAnswer(
    command: ProjectGroupedManualAnswerCommand,
  ): Promise<JobFinderWorkspaceSnapshot>;
  applyGroupedManualAnswer(
    command: ApplyGroupedManualAnswerInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  snoozeGroupedDecision(
    command: SnoozeGroupedDecisionInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  saveApplicationAnswer(
    command: SaveApplicationAnswerCommandInput,
  ): Promise<ApplyRunDetails>;
  clearApplicationAnswer(
    command: ClearApplicationAnswerCommandInput,
  ): Promise<ApplyRunDetails>;
  /**
   * Carries on applications waiting on a file question once a fitting file is
   * restored or added in Profile > Files. Returns how many were continued;
   * the continuations run in the background.
   */
  continueApplicationsWaitingForFiles(input: {
    assetId: string;
    assetKind: CandidateAssetKind;
  }): Promise<number>;
  withWorkspaceRestore(operation: () => Promise<void>): Promise<void>;
  resetWorkspace(
    seed: JobFinderRepositorySeed,
    options?: JobFinderWorkspaceResetOptions,
  ): Promise<JobFinderWorkspaceSnapshot>;
  saveProfile(profile: CandidateProfile): Promise<JobFinderWorkspaceSnapshot>;
  saveProfileAndSearchPreferences(
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
  ): Promise<JobFinderWorkspaceSnapshot>;
  runResumeImport(input: {
    signal?: AbortSignal;
    baseResume: ResumeSourceDocument;
    documentBundle: ResumeDocumentBundle;
    importWarnings?: readonly string[];
    visionArtifact?: ResumeImportVisionArtifact | null;
  }): Promise<JobFinderWorkspaceSnapshot>;
  analyzeProfileFromResume(): Promise<JobFinderWorkspaceSnapshot>;
  saveSearchPreferences(
    searchPreferences: JobSearchPreferences,
  ): Promise<JobFinderWorkspaceSnapshot>;
  saveProfileSetupState(
    profileSetupState: ProfileSetupState,
  ): Promise<JobFinderWorkspaceSnapshot>;
  applyProfileSetupReviewAction(
    reviewItemId: string,
    action: ProfileSetupReviewAction,
    options?: ProfileSetupReviewActionOptions,
  ): Promise<JobFinderWorkspaceSnapshot>;
  applyResumeTimelineRepairAction(
    runId: string,
    proposalId: string,
    action: ResumeTimelineRepairAction,
  ): Promise<JobFinderWorkspaceSnapshot>;
  sendProfileCopilotMessage(
    content: string,
    context?: ProfileCopilotContext,
  ): Promise<JobFinderWorkspaceSnapshot>;
  proposeProfileCopilotChange(
    content: string,
    context?: ProfileCopilotContext,
  ): Promise<JobFinderWorkspaceSnapshot>;
  applyProfileCopilotPatchGroup(
    patchGroupId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  rejectProfileCopilotPatchGroup(
    patchGroupId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  undoProfileRevision(revisionId: string): Promise<JobFinderWorkspaceSnapshot>;
  saveSettings(
    settings: JobFinderSettings,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Merges only the provided application-default fields (per-job CV mode,
   * default resume template, font preset) into the transaction-current
   * settings. A resume-affecting change stales approved drafts first, and a
   * default mode change pins the previous default onto active null-mode jobs
   * in the same repository commit. Never runs CRM automation.
   */
  updateApplicationDefaults(
    input: UpdateApplicationDefaultsInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Merges only the provided workspace-behavior fields (session keep-alive,
   * discovery-only) into the transaction-current settings. Theme, CRM, and
   * application defaults are never touched.
   */
  updateWorkspaceBehavior(
    input: UpdateWorkspaceBehaviorInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Saves the AI behavior section of Settings in one action: the behavior
   * preference and cover-letter preference into settings, and the resume
   * approach into both `settings.resumeApplicationMode` and
   * `searchPreferences.tailoringMode`. The search selectivity also drives
   * `searchPreferences.discovery.collectOnlyHardCriteriaMatches`, so search
   * preferences go through the ordinary save path (active plan kept in sync).
   */
  updateAiBehavior(
    input: UpdateAiBehaviorInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Replaces the tracker CRM settings in the transaction-current settings and
   * only then offers the due-based no-response automation run. Automation
   * failures are reported separately and never roll the committed settings
   * back.
   */
  updateTrackerCrm(
    applicationCrm: ApplicationCrmSettings,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Replaces the appearance theme in the transaction-current settings without
   * touching any other settings field.
   */
  updateAppearanceTheme(
    appearanceTheme: AppearanceTheme,
  ): Promise<JobFinderWorkspaceSnapshot>;
  saveCampaign(
    campaign: SaveJobSearchCampaignInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  selectCampaign(campaignId: string): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Deletes one campaign. Returns `true` when the campaign was removed and
   * `false` when the id is unknown or the campaign is the last remaining one
   * (the persisted collection schema requires an existing active campaign).
   * An active pointer moves to the first remaining non-archived campaign,
   * mirroring the archive hand-off.
   */
  deleteCampaign(input: DeleteJobSearchCampaignInput): Promise<boolean>;
  setActivityControl(
    input: SetJobFinderActivityControlInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  runDiscovery(targetId?: string): Promise<JobFinderWorkspaceSnapshot>;
  runAgentDiscovery(
    onActivity?: (event: DiscoveryActivityEvent) => void,
    signal?: AbortSignal,
    targetId?: string,
    searchRequest?: JobFinderSearchRequest,
  ): Promise<JobFinderWorkspaceSnapshot>;
  runDiscoveryForTarget(
    targetId: string,
    onActivity?: (event: DiscoveryActivityEvent) => void,
    signal?: AbortSignal,
  ): Promise<JobFinderWorkspaceSnapshot>;
  cancelDiscoveryRun(runId: string): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Runs one discovery cycle for a campaign now (manual trigger). Works
   * regardless of the campaign schedule's `enabled` flag, but still obeys the
   * global activity pause and the campaign's own status.
   */
  runCampaignNow(
    input?: RunCampaignNowInput,
    onActivity?: (event: DiscoveryActivityEvent) => void,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Runs every campaign whose persisted schedule is due at `now` (catch-up
   * included). Missing `nextRunAt` values are initialized truthfully without
   * triggering immediate work.
   */
  runDueScheduledCampaigns(
    now?: string,
    onActivity?: (event: DiscoveryActivityEvent) => void,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /** Runs due schedules without building a workspace snapshot on an idle tick. */
  processDueScheduledCampaigns?(
    now?: string,
    onActivity?: (event: DiscoveryActivityEvent) => void,
  ): Promise<boolean>;
  /**
   * Marks a single in-app campaign notification read. Unknown ids are a
   * no-op; the timestamp comes from the caller (main supplies the ISO readAt).
   */
  markCampaignNotificationRead(
    input: MarkCampaignNotificationReadInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Marks every unread in-app campaign notification read. Already-read
   * notifications keep their original read timestamps; an invalid read
   * timestamp is a no-op.
   */
  markAllCampaignNotificationsRead(
    input: MarkAllCampaignNotificationsReadInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Creates or updates one campaign rule. New rules start unmeasured;
   * updates preserve previously measured remove/downgrade counts unless the
   * caller explicitly replaces them.
   */
  saveCampaignRule(
    input: SaveCampaignRuleRouteInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /** Removes one campaign rule by id. */
  deleteCampaignRule(
    input: DeleteCampaignRuleInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /** Toggles one campaign rule's enabled/disabled state. */
  toggleCampaignRule(
    input: ToggleCampaignRuleInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Read-only projection of rule effects and the funnel, computed only
   * against the real persisted jobs retained by the campaign.
   */
  projectCampaignRuleFunnel(
    input: ProjectCampaignRuleFunnelInput,
  ): Promise<CampaignRuleFunnelProjection>;
  runSourceDebug(
    targetId: string,
    signal?: AbortSignal,
    onProgress?: (event: SourceDebugProgressEvent) => void,
  ): Promise<JobFinderWorkspaceSnapshot>;
  cancelSourceDebug(runId: string): Promise<JobFinderWorkspaceSnapshot>;
  getSourceDebugRun(runId: string): Promise<SourceDebugRunRecord>;
  getSourceDebugRunDetails(runId: string): Promise<SourceDebugRunDetails>;
  listSourceDebugRuns(
    targetId: string,
  ): Promise<readonly SourceDebugRunRecord[]>;
  saveSourceInstructionArtifact(
    targetId: string,
    artifact: EditableSourceInstructionArtifact,
  ): Promise<JobFinderWorkspaceSnapshot>;
  acceptSourceInstructionDraft(
    targetId: string,
    instructionId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  verifySourceInstructions(
    targetId: string,
    instructionId: string,
    signal?: AbortSignal,
    onProgress?: (event: SourceDebugProgressEvent) => void,
  ): Promise<JobFinderWorkspaceSnapshot>;
  assessJobListing(jobId: string): Promise<JobFinderWorkspaceSnapshot>;
  queueJobForReview(jobId: string): Promise<JobFinderWorkspaceSnapshot>;
  /** One row-local shortlist commit, without constructing a workspace per job. */
  queueJobsForReview?(jobIds: readonly string[]): Promise<void>;
  saveResumeBatchCheckpoint(checkpoint: ResumeBatchCheckpoint): Promise<void>;
  setJobResumeApplicationMode(
    jobId: string,
    resumeApplicationMode: ResumeApplicationMode,
    resumeTailoringMode?: TailoringMode | null,
  ): Promise<JobFinderWorkspaceSnapshot>;
  removeJobFromReview(jobId: string): Promise<JobFinderWorkspaceSnapshot>;
  /** Moves several jobs back to Find jobs, then reads the workspace once. */
  removeJobsFromReview?(jobIds: readonly string[]): Promise<void>;
  dismissDiscoveryJob(
    input: JobFinderDismissDiscoveryJobInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  dismissDiscoveryJobs?(
    inputs: readonly JobFinderDismissDiscoveryJobInput[],
    options?: DiscoveryFeedbackBatchOptions,
  ): Promise<DiscoveryFeedbackBatchResult>;
  excludeEmployerDiscoveryJobs?(
    input: {
      jobId: string;
      jobIds: readonly string[];
      expectedNormalizedCompanyName: string;
    },
    options?: DiscoveryFeedbackBatchOptions,
  ): Promise<DiscoveryFeedbackBatchResult>;
  previewEmployerExclusion(jobId: string): Promise<EmployerExclusionPreview>;
  removeEmployerExclusion(
    input: RemoveEmployerExclusionInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  restoreDismissedDiscoveryJob(
    jobId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  restoreDismissedDiscoveryJobs?(
    jobIds: readonly string[],
    options?: DiscoveryFeedbackBatchOptions,
  ): Promise<DiscoveryFeedbackBatchResult>;
  mutateRapidReview(
    input: RapidReviewMutationInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  recordOutcome(input: RecordOutcomeInput): Promise<JobFinderWorkspaceSnapshot>;
  refreshCompanyIntelligence(): Promise<JobFinderWorkspaceSnapshot>;
  setCompanyPreference(
    input: SetCompanyPreferenceInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  reviewCompanyMerge(
    input: ReviewCompanyMergeInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  mutateCompanyIntelligence(
    input: CompanyIntelligenceMutationInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  setOutcomeSuggestionEnabled(
    input: SetOutcomeSuggestionEnabledInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Applies one typed local safeguard mutation (caps, conflicts, listing
   * signals, failure pauses, sample reviews, contradictions, or dismissals).
   * Mutations never grant credentials, login, CAPTCHA, MFA, legal consent,
   * account creation, upload, redirect, or final-submit authority.
   */
  mutateSafeguards(
    input: SafeguardMutationInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /** Read-only gate overview used by the Safeguards screen and tests. */
  getSafeguardsOverview(): Promise<SafeguardsOverview>;
  /**
   * Read-only gate projection for application preparation of the given jobs
   * (caps, conflicts, signals, global pauses/reviews, advisory contradictions).
   */
  evaluateApplicationSafeguardBlockers(
    jobIds: readonly string[],
  ): Promise<readonly SafeguardBlockerView[]>;
  /**
   * Read-only gate projection for a discovery run (global pauses and pending
   * sample reviews only; job-scoped gates are enforced at preparation time).
   */
  evaluateDiscoverySafeguardBlockers(): Promise<
    readonly SafeguardBlockerView[]
  >;
  saveResumeStrategy(
    input: SaveResumeStrategyInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  disableResumeStrategy(
    strategyId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  selectResumeStrategy(
    input: SelectResumeStrategyInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  recommendResumeStrategy(
    input: RecommendResumeStrategyInput,
  ): Promise<ResumeStrategyRecommendation>;
  setCampaignResumeStrategyDefault(
    input: SetCampaignResumeStrategyDefaultInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  generateResume(
    jobId: string,
    options?: { language?: string | null },
  ): Promise<JobFinderWorkspaceSnapshot>;
  generateResumeForBatch(
    jobId: string,
    options: {
      regenerate?: boolean;
      shouldStop: () => boolean;
      onStage?: (stage: ResumeBatchGenerationProgress["stage"]) => void;
      onProviderBlocked?: (block: ResumeBatchProviderBlock) => void;
    },
  ): Promise<ResumeBatchGenerationResult>;
  getResumeWorkspace(jobId: string): Promise<JobFinderResumeWorkspace>;
  previewResumeDraft(
    draft: ResumeDraft,
    signal?: AbortSignal,
  ): Promise<JobFinderResumePreview>;
  saveResumeDraft(draft: ResumeDraft): Promise<JobFinderWorkspaceSnapshot>;
  restoreResumeDraftRevision(
    jobId: string,
    revisionId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Removes one accepted AI edit and keeps every edit made after it. Unlike
   * restoring a revision, later manual edits survive.
   */
  undoResumeAssistantEdit(
    jobId: string,
    revisionId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  regenerateResumeDraft(
    jobId: string,
    options?: { language?: string | null },
  ): Promise<JobFinderWorkspaceSnapshot>;
  regenerateResumeSection(
    jobId: string,
    sectionId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  exportResumePdf(
    jobId: string,
    outputPath?: string | null,
  ): Promise<JobFinderWorkspaceSnapshot>;
  approveResume(
    jobId: string,
    exportId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  clearResumeApproval(jobId: string): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Acknowledges or removes one server-owned work-history review decision as
   * a real draft mutation. The command validates the exact projected
   * suggestion identity (including the FNV-1a message hash) under the per-job
   * draft transition lock and never starts an export, approval, preparation,
   * or submission.
   */
  setWorkHistoryReviewAcknowledgment(
    input: JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Adds or removes one server-owned resume claim confirmation as a real
   * draft mutation. The command validates the exact projected `confirm_needed`
   * assessment identity (locator plus normalized content hash) or the stored
   * confirmation id under the per-job draft transition lock, never accepts
   * hard unsupported claims, and never starts an export, approval,
   * preparation, or submission.
   */
  setResumeClaimConfirmation(
    input: JobFinderSetResumeClaimConfirmationInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  applyResumePatch(
    patch: ResumeDraftPatch,
    revisionReason?: string | null,
  ): Promise<JobFinderWorkspaceSnapshot>;
  getResumeAssistantMessages(
    jobId: string,
  ): Promise<readonly ResumeAssistantMessage[]>;
  /** Read the retired chats in order, without creating or loading resumes. */
  getResumeAssistantHistory(): Promise<readonly ResumeAssistantMessage[]>;
  sendResumeAssistantMessage(
    jobId: string,
    content: string,
  ): Promise<readonly ResumeAssistantMessage[]>;
  resolveResumeAssistantProposal(
    jobId: string,
    proposalId: string,
    action: "accept" | "reject",
    patchIds: readonly string[],
  ): Promise<readonly ResumeAssistantMessage[]>;
  getApplyRunDetails(
    runId: string,
    jobId: string,
    applicationRecordId?: string | null,
  ): Promise<ApplyRunDetails>;
  /**
   * Writes a letter or written answer for one saved job with the model, the
   * same way the apply agent writes the letter it sends. Null when no model is
   * available; the caller keeps its plain evidence-built draft.
   */
  writeApplicationDocumentText(input: {
    jobId: string;
    kind: "cover_letter" | "short_response";
    questionPrompt: string | null;
    priorText: string | null;
  }): Promise<string | null>;
  buildApplicationPacket(
    runId: string,
    jobId: string,
    applicationRecordId?: string | null,
  ): Promise<ApplicationPacket>;
  startApplyCopilotRun(
    jobId: string,
    options?: Pick<
      JobFinderApplyCopilotActionInput,
      "visualCheckpointsEnabled"
    >,
    applicationRecordId?: string | null,
  ): Promise<JobFinderWorkspaceSnapshot>;
  startAutoApplyRun(
    jobId: string,
    applicationRecordId?: string | null,
  ): Promise<JobFinderWorkspaceSnapshot>;
  startAutoApplyQueueRun(
    jobIds: readonly string[],
    applicationAutomationMode?: ApplicationAutomationMode,
  ): Promise<JobFinderWorkspaceSnapshot>;
  approveApplyRun(runId: string): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * `skippedByPerson` names jobs the person chose to skip, so they read as
   * skipped rather than as an application that could not be finished.
   */
  cancelApplyRun(
    runId: string,
    options?: { skippedByPerson?: readonly string[] },
  ): Promise<JobFinderWorkspaceSnapshot>;
  resolveApplyConsentRequest(
    requestId: string,
    action: "approve" | "decline",
  ): Promise<JobFinderWorkspaceSnapshot>;
  revokeApplyRunApproval(runId: string): Promise<JobFinderWorkspaceSnapshot>;
  inspectPreparedApplicationPage(
    input: JobFinderPreparedApplicationPageInput,
  ): Promise<RawApplyPage>;
  focusPreparedApplicationPage(
    input: JobFinderPreparedApplicationPageInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Records filled-in applications the person sent themselves on the page
   * they were handed (the site showed its confirmation). Returns how many.
   */
  recordApplicationsSentByPerson(): Promise<number>;
  /** Judges every job of the active plan that has no current fit verdict. */
  judgeUnjudgedJobs(): Promise<JobFinderWorkspaceSnapshot>;
  /**
   * Sends one application the person already looked over.
   *
   * The only way a confirm-first application is ever sent. It runs the same
   * checks and writes the same single record as a run that was allowed to send
   * on its own, so an application cannot be sent twice by taking a different
   * route to it.
   */
  submitPreparedApplication(jobId: string): Promise<JobFinderWorkspaceSnapshot>;
  approveApply(
    jobId: string,
    applicationRecordId?: string | null,
  ): Promise<JobFinderWorkspaceSnapshot>;
  recordLiveAssistantApplicationAction(
    input: JobFinderInterviewFollowUpInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  mutateApplicationCrm(
    command: ApplicationCrmMutationInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  mutateApplicationCrmBulkStage(
    command: ApplicationCrmBulkStageMutationInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
  runApplicationNoResponseAutomation(
    settings?: ApplicationCrmSettings,
  ): Promise<JobFinderWorkspaceSnapshot>;
  exportApplicationCrm(
    command: ApplicationCrmExportInput,
  ): Promise<ApplicationCrmExportResult>;
  /**
   * The shared assistant-edit operation (ADR 0037): typed profile operations
   * committed with attribution, returning the exact values touched so one
   * change can be undone later without losing other edits.
   */
  applyAssistantProfileOperations(request: {
    operations: readonly ProfileCopilotPatchOperation[];
    summary: string;
    messageId: string | null;
  }): Promise<AssistantProfileEditResult>;
  undoAssistantProfileChange(request: {
    profileEntries: readonly AssistantChangeEntry[];
    searchPreferencesEntries: readonly AssistantChangeEntry[];
    reason: string;
  }): Promise<AssistantUndoResult>;
  undoAssistantSettingsChange(request: {
    entries: readonly AssistantChangeEntry[];
  }): Promise<AssistantUndoResult>;
  applyAssistantResumePatches(request: {
    jobId: string;
    patches: readonly Omit<
      ResumeDraftPatch,
      "draftId" | "origin" | "appliedAt" | "id"
    >[];
    expectedDraftUpdatedAt: string | null;
    summary: string;
  }): Promise<AssistantEditResult & { draftUpdatedAt: string }>;
  applyAssistantResumeRevision(request: {
    jobId: string;
    patches: readonly ResumeDraftPatch[];
    baseDraftUpdatedAt: string;
    summary: string;
  }): Promise<AssistantEditResult & { draftUpdatedAt: string }>;
  undoAssistantResumeChange(request: {
    jobId: string;
    entries: readonly AssistantChangeEntry[];
    reason: string;
  }): Promise<AssistantUndoResult>;
  /**
   * Runs the resume revision specialist for a substantial rewrite and returns
   * gate-checked patches without storing any chat message.
   */
  /** Reads the job postings on a page the assistant was lent (no writes). */
  addJobFromBrowserPage(input: {
    html: string;
    pageUrl: string;
  }): Promise<AddBrowserJobResult>;
  extractJobsFromPageText(input: {
    pageText: string;
    pageUrl: string;
    pageType: "search_results" | "job_detail";
    maxJobs: number;
    signal?: AbortSignal;
  }): Promise<JobPosting[]>;
  /**
   * Saves postings the person picked from a page through the canonical merge
   * (ADR 0030) into the active search plan.
   */
  saveJobsFromPage(input: {
    postings: readonly JobPosting[];
    pageUrl: string;
    /**
     * The person asked to apply on this page: a saved copy of the same job
     * from another site applies here from now on.
     */
    applyOnThisPage?: boolean;
  }): Promise<{
    savedJobIds: string[];
    newJobIds: string[];
    mergedJobIds: string[];
  }>;
  runResumeRevisionSpecialist(input: {
    jobId: string;
    brief: string;
    recentExcerpt: readonly { role: "user" | "assistant"; content: string }[];
  }): Promise<ResumeSpecialistResult>;
}

type DiscoveryTargetPipelineSharedOptions = {
  onActivity?: (event: DiscoveryActivityEvent) => void;
  signal?: AbortSignal;
  allowInactiveMarking?: boolean;
  useAgentRuntime?: boolean;
  /** Explicit campaign context; discovery then uses the campaign's preferences. */
  campaign?: CampaignRunContext;
  /** The person's instruction and run-scoped search knobs. */
  searchRequest?: JobFinderSearchRequest;
};

export type DiscoveryTargetPipelineOptions =
  | (DiscoveryTargetPipelineSharedOptions & {
      scope: "single_target";
      targetId: string;
    })
  | (DiscoveryTargetPipelineSharedOptions & {
      scope: Exclude<DiscoveryRunScope, "single_target">;
      targetId?: never;
    });

export interface RenderedResumeArtifact {
  fileName: string | null;
  storagePath: string | null;
  sha256?: string | null;
  format: "html" | "pdf";
  intermediateFileName?: string | null;
  intermediateStoragePath?: string | null;
  pageCount?: number | null;
  warnings?: readonly string[];
}

/**
 * Explicit campaign discovery context: run the pipeline against a specific
 * campaign's preferences and tag the run record with that campaign id without
 * changing the active campaign or the global search preferences.
 *
 * `runJobBudget` carries the campaign's explicit discovery run budget (from
 * `limits.discoveryRunJobBudget`). When omitted or null the pipeline falls back
 * to the campaign search preferences' `discovery.runJobBudget`, then to the
 * interactive precision default.
 */
export interface CampaignRunContext {
  campaignId: string;
  mode: JobSearchCampaignMode;
  searchPreferences: JobSearchPreferences;
  runJobBudget?: number | null;
}

export interface JobFinderDocumentManager {
  listResumeTemplates(): readonly ResumeTemplateDefinition[];
  renderResumePreview(
    input: {
      job: SavedJob;
      profile: CandidateProfile;
      renderDocument: ResumeRenderDocument;
      templateId: ResumeTemplateId;
      settings: JobFinderSettings;
    },
    signal?: AbortSignal,
  ): Promise<{
    html: string;
    pageCount?: JobFinderResumePreview["metadata"]["pageCount"];
    warnings?: readonly string[];
  }>;
  renderResumeArtifact(input: {
    job: SavedJob;
    profile: CandidateProfile;
    renderDocument: ResumeRenderDocument;
    templateId: ResumeTemplateId;
    settings: JobFinderSettings;
    targetPath?: string | null;
    onQueueWait?: (milliseconds: number) => void;
    signal?: AbortSignal;
  }): Promise<RenderedResumeArtifact>;
  /**
   * Renders a cover or motivation letter to a file, through the same path the
   * resume export uses, and puts it beside that resume.
   *
   * Optional: a runtime that cannot render one leaves a form asking for a
   * letter file to the person rather than sending something else.
   */
  /** Reads the latest approved letter, including an earlier approved revision. */
  getApprovedApplicationLetter?(
    jobId: string,
    applicationRecordId?: string,
  ): Promise<ApplicationDocumentRevision | null>;
  /**
   * Keeps a letter the person wrote or accepted while answering a form's
   * letter question as this application's approved letter.
   */
  saveApprovedApplicationLetter?(input: {
    profile: CandidateProfile;
    job: SavedJob;
    applicationRecord: ApplicationRecord;
    question: ApplicationQuestionRecord;
    text: string;
  }): Promise<void>;
  renderLetterArtifact?(input: {
    text: string;
    job: SavedJob;
    profile: CandidateProfile;
    settings: JobFinderSettings;
    /** A type the form insisted on. Null means the renderer may choose. */
    fileType: "pdf" | "docx" | "txt" | null;
  }): Promise<RenderedLetterArtifact>;
}

/** A letter rendered to a file, with the exact bytes that were written. */
export type RenderedLetterArtifact =
  | {
      ok: true;
      fileName: string;
      mimeType: string;
      storagePath: string;
      sha256: string;
    }
  | { ok: false; reason: string };

export interface ResumeResearchAdapterInput {
  job: SavedJob;
  profile: CandidateProfile;
}

export interface ResumeResearchAdapter {
  fetchResearchPages(
    input: ResumeResearchAdapterInput,
  ): Promise<readonly ResumeResearchArtifact[]>;
}

export interface ResolvedApplicationCandidateAsset {
  asset: CandidateAsset;
  loadVerifiedBytes: () => Promise<Uint8Array>;
}

export interface CandidateAssetResolver {
  /** Lists assets the local library may offer to an application. */
  list?(input: CandidateAssetListInput): Promise<CandidateAssetListResult>;
  resolveForApplication(
    assetId: string,
  ): Promise<ResolvedApplicationCandidateAsset>;
}

export interface CreateJobFinderWorkspaceServiceOptions {
  onFitJudgmentProgress?: () => void;
  aiClient: JobFinderAiClient;
  visionProvider?: ResumeVisionProvider;
  documentManager: JobFinderDocumentManager;
  exportFileVerifier?: ResumeExportFileVerifier;
  repository: JobFinderRepository;
  browserRuntime: BrowserSessionRuntime;
  candidateAssetResolver?: CandidateAssetResolver;
  researchAdapter?: ResumeResearchAdapter;
  /** Plain-HTTP listing page reader; tests inject a fake, production defaults. */
  fetchListingHtml?: ListingHtmlFetcher;
  /**
   * Called after every activity-control save (Home's Pause/Resume, or an
   * explicit user action resuming paused work). The desktop host mirrors the
   * flag onto the embedded browser, which keeps its own pause.
   */
  onActivityControlChanged?: (
    control: JobFinderActivityControl,
  ) => void | Promise<void>;
  /** Publishes the terminal snapshot of a queue resumed after restart. */
  onDetachedApplyRunFinished?: () => void;
  onResumeEvidenceFinished?: () => void;
  onListingAssessmentFinished?: () => void;
  /** Saved jobs were rescored in the background after a profile or goal save. */
  onSavedJobsRescored?: () => void;
  /**
   * Called when the person deliberately starts work (Search now, Apply, Run
   * now). The desktop host lifts a browser pause the person caused there
   * (closing the browser mid-run), so the start is not refused.
   */
  onExplicitUserStart?: () => void | Promise<void>;
}
