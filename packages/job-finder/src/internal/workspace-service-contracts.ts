import type { CandidateReusableAnswer } from "@nestor/contracts";
import type { JobSitesStore } from "@nestor/db/job-store";
import type {
  JobFinderAiClient,
  ResumeVisionProvider,
} from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type {
  AddBrowserJobResult,
  AppearanceTheme,
  ApplicationAutomationMode,
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportInput,
  ApplicationCrmExportResult,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  ApplicationDocumentRevision,
  ApplicationPacket,
  ApplicationQuestionRecord,
  ApplicationRecord,
  ApplyGroupedManualAnswerInput,
  ApplyRunDetails,
  AssistantChangeEntry,
  CandidateAsset,
  CandidateAssetKind,
  CandidateAssetListInput,
  CandidateAssetListResult,
  CandidateProfile,
  ClearApplicationAnswerCommandInput,
  EditableSourceInstructionArtifact,
  JobFinderActivityControl,
  JobFinderApplyCopilotActionInput,
  JobFinderInterviewFollowUpInput,
  JobFinderOpenBrowserSessionInput,
  JobFinderPreparedApplicationPageInput,
  JobFinderResumePreview,
  JobFinderSettings,
  JobFinderWorkspaceSnapshot,
  JobPosting,
  JobSearchPreferences,
  ProfileCopilotContext,
  ProfileCopilotPatchOperation,
  ProfileSetupReviewAction,
  ProfileSetupReviewActionOptions,
  ProfileSetupState,
  ProjectGroupedManualAnswerCommand,
  RawApplyPage,
  ResumeDocumentBundle,
  ResumeDraftProcessor,
  ResumeImportFieldCandidate,
  ResumeImportRun,
  ResumeImportVisionArtifact,
  ResumeResearchArtifact,
  ResumeSourceDocument,
  ResumeTemplateDefinition,
  ResumeTemplateId,
  ResumeTimelineRepairAction,
  SaveApplicationAnswerCommandInput,
  SavedJob,
  SaveUserActionAnswerDraftInput,
  SetJobFinderActivityControlInput,
  SnoozeGroupedDecisionInput,
  SourceDebugProgressEvent,
  SourceDebugRunDetails,
  SourceDebugRunRecord,
  UpdateAiBehaviorInput,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
  UserActionCommandInput,
} from "@nestor/contracts";
import type { JobFinderRepository, JobFinderRepositorySeed } from "@nestor/db";
import type { ListingHtmlFetcher } from "./listing-detail-enrichment";
import type { ResumeRenderDocument } from "./resume-workspace-structure";
import type {
  AssistantProfileEditResult,
  AssistantUndoResult,
} from "./workspace-assistant-edit-methods";
import type { ResumeExportFileVerifier } from "./workspace-service-context";

export interface JobFinderWorkspaceResetOptions {
  /**
   * Runs while the service reset gate is held, immediately before replacing
   * the repository state. Desktop callers use this to remove app-owned files
   * without allowing a new operation to start between the file and database
   * reset.
   */
  beforeStateReset?: () => Promise<void>;
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
  /**
   * Home's first view (ADR 0077): every collection Home reads except the
   * Find jobs lists, which stay deferred. Null when the workspace cannot give
   * one; the full snapshot follows either way.
   */
  getWorkspaceHomeSnapshot?(): Promise<JobFinderWorkspaceSnapshot | null>;
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
  setActivityControl(
    input: SetJobFinderActivityControlInput,
  ): Promise<JobFinderWorkspaceSnapshot>;
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
  /** Starts resumes that shortlisting asked for and a restart left waiting. */
  removeJobFromReview(jobId: string): Promise<JobFinderWorkspaceSnapshot>;
  /** Moves several jobs back to Find jobs, then reads the workspace once. */
  removeJobsFromReview?(jobIds: readonly string[]): Promise<void>;
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
  /**
   * Moves an unsent application back to Shortlisted: its prepared form
   * closes, nothing is sent or prepared again, and its history and receipts
   * stay. Refused for a sent application and while one is being filled in.
   */
  returnApplicationToShortlist(
    applicationRecordId: string,
  ): Promise<JobFinderWorkspaceSnapshot>;
  /** Undo of the move: the application is listed in Applications again. */
  undoReturnApplicationToShortlist(
    jobId: string,
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
  undoAssistantResumeChange(request: {
    jobId: string;
    entries: readonly AssistantChangeEntry[];
    reason: string;
  }): Promise<AssistantUndoResult>;
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
}

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

export interface JobFinderDocumentManager {
  /** Drops replaced managed exports after their references have committed. */
  pruneGeneratedResumeFiles?(): Promise<void>;
  /** Releases an unpersisted PDF/HTML produced only to measure a draft. */
  discardResumeArtifact?(artifact: RenderedResumeArtifact): Promise<void>;
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
  readSavedAnswers?: () => readonly CandidateReusableAnswer[];
  jobSites?: JobSitesStore;
  /** Host acknowledgement that the first display transfer has finished. */
  backgroundWorkReady?: PromiseLike<void>;
  resumeDraftProcessor?: ResumeDraftProcessor;
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
  /** A resume started by shortlisting was queued, written or withdrawn. */
  onShortlistResumeChanged?: () => void;
  onListingAssessmentFinished?: () => void;
  /** Saved jobs were rescored in the background after a profile or goal save. */
  onSavedJobsRescored?: () => void;
  /**
   * Called when the person deliberately starts work (Search now, Apply, Run
   * now). The desktop host lifts a browser pause the person caused there
   * (closing the browser mid-run), so the start is not refused.
   */
  onExplicitUserStart?: () => void | Promise<void>;
  /** Whether a search has finished on the job store; it completes setup. */
  hasRunJobSearch?: () => boolean;
}
