import type {
  PreparedApplicationForm,
  ApplyJobResult,
  ApplyJobResultInput,
  ApplyRun,
  ApplySubmitApproval,
  ApplicationAttempt,
  ApplicationAttemptInput,
  ApplicationAnswerRecord,
  ApplicationArtifactRef,
  ApplicationArtifactRefInput,
  ApplicationConsentRequest,
  ApplicationRecord,
  ApplicationRecordInput,
  ApplicationQuestionRecord,
  ApplicationQuestionRecordInput,
  ApplicationReplayCheckpoint,
  ApplicationReplayCheckpointInput,
  CandidateProfile,
  DiscoverySavedJobFingerprints,
  SavedJobSightingPatch,
  SavedJobPlanAssessmentPatch,
  JobFinderDiscoveryState,
  JobFinderActivityControl,
  ApplyQueue,
  JobFinderRepositoryState,
  JobFinderIntelligenceState,
  JobFinderSettings,
  JobSearchCampaignCollection,
  JobSearchPreferences,
  ProfileCopilotMessage,
  ProfileRevision,
  ProfileSetupState,
  ResumeAssistantMessage,
  ResumeDocumentBundle,
  ResumeDraft,
  ResumeDraftRevision,
  ResumeExportArtifact,
  ResumeImportCandidateResolution,
  ResumeImportFieldCandidate,
  ResumeImportRun,
  ResumeImportRunStatus,
  ResumeResearchArtifact,
  ResumeValidationResult,
  SavedJob,
  SourceDebugEvidenceRef,
  SourceDebugRunRecord,
  SourceDebugWorkerAttempt,
  SourceDebugWorkerAttemptInput,
  SourceInstructionArtifact,
  TailoredAsset,
  SaveUserActionAnswerDraftInput,
  UserActionEvent,
  UserActionRequest,
} from "@nestor/contracts";
import type {
  CreateUserActionRequestResult,
  UserActionEventQuery,
  UserActionRequestQuery,
  UserActionTransitionCommitResult,
  UserActionTransitionInput,
} from "./user-action-repository-types";
import type {
  CommitGroupedManualAnswerInput,
  CommitGroupedManualAnswerResult,
} from "./grouped-manual-answer-types";
import type {
  WorkspaceBackupReconciliationAction,
  WorkspaceBackupReconciliationWarning,
} from "./file-repository-backup";
import type {
  WorkspaceRecoveryCandidateKind,
  WorkspaceRecoveryCandidateStatus,
  WorkspaceRecoveryLossWindowInputs,
  WorkspaceRecoverySqliteErrorCode,
  WorkspaceRecoveryValidationOverrides,
} from "./file-repository-recovery";
import type { ApplicationAuthorityRepository } from "./application-authority-repository-types";
import type { ApplicationAnswerSnapshotRepository } from "./application-answer-snapshot-repository-types";

export type JobFinderRepositorySeed = JobFinderRepositoryState;

/** Frozen, validated rows borrowed by display/recovery readers, never write seeds. */
export interface JobFinderDisplayCollections {
  tailoredAssets: readonly TailoredAsset[];
  resumeDrafts: readonly ResumeDraft[];
  resumeExportArtifacts: readonly ResumeExportArtifact[];
  resumeResearchArtifacts: readonly ResumeResearchArtifact[];
  applyRuns: readonly ApplyRun[];
  applyJobResults: readonly ApplyJobResult[];
  applicationRecords: readonly ApplicationRecord[];
  applicationAttempts: readonly ApplicationAttempt[];
  sourceInstructionArtifacts: readonly SourceInstructionArtifact[];
  sourceDebugAttempts: readonly SourceDebugWorkerAttempt[];
  profileCopilotMessages: readonly ProfileCopilotMessage[];
  profileRevisions: readonly ProfileRevision[];
  userActionRequests: readonly UserActionRequest[];
  userActionEvents: readonly UserActionEvent[];
  latestResumeValidationResults: readonly ResumeValidationResult[];
}

declare const discoveryDisplayProjectionBrand: unique symbol;
/** Commit callbacks borrow frozen canonical rows. Copy a row before changing it. */
export type BorrowedDiscoveryState = Readonly<JobFinderDiscoveryState>;
/** Display-only discovery data has no checkpoints and cannot be a write seed. */
export type DiscoveryDisplayProjection = JobFinderDiscoveryState & {
  readonly [discoveryDisplayProjectionBrand]: true;
};
type CanonicalDiscoveryWrite = JobFinderDiscoveryState & {
  readonly [discoveryDisplayProjectionBrand]?: never;
};

/**
 * Outcome of a revision-checked profile commit. "applied" carries the
 * schema-parsed profile that was persisted together with the incremented
 * revision; "stale" carries the current persisted profile and revision with
 * nothing written.
 */
export type ProfileCommitOutcome =
  | { status: "applied"; profile: CandidateProfile; revision: number }
  | { status: "stale"; profile: CandidateProfile; revision: number };

/**
 * Outcome of the import finalization compare-and-swap. A stale finalization
 * never writes the supplied profile, preferences, or import artifacts.
 */
export type ResumeImportFinalizationOutcome =
  | {
      status: "applied";
      profile: CandidateProfile;
      searchPreferences: JobSearchPreferences;
      revision: number;
    }
  | {
      status: "stale";
      profile: CandidateProfile;
      searchPreferences: JobSearchPreferences;
      revision: number;
    };

/**
 * A transaction-current patch-group flag flip for one persisted copilot
 * message. Unlike whole-message upserts, a delta never carries sibling
 * groups, so concurrent apply/reject decisions on the same message cannot
 * overwrite each other.
 */
export interface ProfileCopilotMessagePatchFlag {
  messageId: string;
  patchGroupId: string;
  applyMode: ProfileCopilotMessage["patchGroups"][number]["applyMode"];
}

export type ApplicationAnswerMutationResult = "applied" | "duplicate" | "stale";

export type ApplicationRecordBatchCommitResult =
  | {
      status: "applied";
      committedRecords: readonly ApplicationRecord[];
    }
  | {
      status: "missing" | "stale";
      recordIds: readonly string[];
    };

export interface DiscoveryFeedbackCommitCurrent {
  job: SavedJob | null;
  jobIsPending: boolean;
  searchPreferences: JobSearchPreferences;
  campaignState: JobSearchCampaignCollection | null;
  intelligenceState: JobFinderIntelligenceState;
  discoveryState: BorrowedDiscoveryState;
}

export interface DiscoveryFeedbackCommitNext<TResult> {
  result: TResult;
  savedJob?: SavedJob;
  searchPreferences: JobSearchPreferences;
  campaignState: JobSearchCampaignCollection | null;
  discoveryState: JobFinderDiscoveryState;
}

export interface CampaignPreferencesCommitCurrent {
  campaignState: JobSearchCampaignCollection | null;
  searchPreferences: JobSearchPreferences;
  intelligenceState: JobFinderIntelligenceState;
}

export interface CampaignPreferencesCommitNext<TResult> {
  result: TResult;
  campaignState: JobSearchCampaignCollection;
  searchPreferences: JobSearchPreferences;
  intelligenceState?: JobFinderIntelligenceState;
}

export interface CompanyIntelligenceCommitExpected {
  companyId: string;
  expectedCompanyUpdatedAt: string;
  jobId: string | null;
  applicationRecordId: string | null;
}

export interface CompanyIntelligenceCommitCurrent {
  intelligenceState: JobFinderIntelligenceState;
  savedJob: SavedJob | null;
  applicationRecord: ApplicationRecord | null;
}

export interface JobFinderRepository
  extends ApplicationAuthorityRepository, ApplicationAnswerSnapshotRepository {
  /** Optional for custom repositories; ordinary reads remain caller-owned. */
  readDisplayCollections?(): Promise<JobFinderDisplayCollections>;
  /** One complete document for a selected preview; no workspace-wide body read. */
  getTailoredAssetById(assetId: string): Promise<TailoredAsset | null>;
  /** Caller-owned first asset in listTailoredAssets order for one selected job. */
  getTailoredAssetByJobId(jobId: string): Promise<TailoredAsset | null>;
  exportState(): Promise<JobFinderRepositoryState>;
  close(): Promise<void>;
  reset(seed: JobFinderRepositorySeed): Promise<void>;
  getProfile(): Promise<CandidateProfile>;
  /** Validated frozen singleton; display readers must not mutate it. */
  readProfileProjection?(): Promise<CandidateProfile>;
  /**
   * Reads the persisted candidate profile together with the profile
   * singleton's monotonic revision. The revision is the compare-and-swap
   * epoch for commitProfileUpdate and commitProfileCopilotState, and it
   * advances whenever the persisted profile, search preferences, or profile
   * setup state changes, because copilot commits write all three together.
   */
  getProfileWithRevision(): Promise<{
    profile: CandidateProfile;
    revision: number;
  }>;
  saveProfile(profile: CandidateProfile): Promise<void>;
  /**
   * Atomically applies a synchronous transform to the currently stored
   * candidate profile. The updater receives the latest persisted profile and
   * its schema-parsed output replaces it inside one transaction, so concurrent
   * writers cannot revert each other with stale full-profile snapshots.
   *
   * When options.expectedRevision is provided, the transaction first compares
   * it against the persisted profile revision: a mismatch returns a "stale"
   * outcome carrying the current profile and revision without writing, while a
   * match applies the updater and increments the revision exactly once.
   */
  commitProfileUpdate(
    updateProfile: (current: CandidateProfile) => CandidateProfile,
    options?: { expectedRevision?: number },
  ): Promise<ProfileCommitOutcome>;
  getSearchPreferences(): Promise<JobSearchPreferences>;
  readSearchPreferencesProjection?(): Promise<JobSearchPreferences>;
  /**
   * Persists search preferences and advances the shared profile revision
   * epoch, so concurrent compare-and-swap commits that captured preferences
   * go stale instead of overwriting this write with their snapshot.
   */
  saveSearchPreferences(searchPreferences: JobSearchPreferences): Promise<void>;
  getProfileSetupState(): Promise<ProfileSetupState>;
  /**
   * Persists the profile setup state and advances the shared profile revision
   * epoch, so concurrent compare-and-swap commits that captured setup state
   * go stale instead of overwriting this write with their snapshot.
   */
  saveProfileSetupState(profileSetupState: ProfileSetupState): Promise<void>;
  saveProfileAndSearchPreferences(
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
  ): Promise<void>;
  commitProfileCopilotState(input: {
    profile: CandidateProfile;
    searchPreferences: JobSearchPreferences;
    profileSetupState: ProfileSetupState;
    messages?: readonly ProfileCopilotMessage[];
    revisions?: readonly ProfileRevision[];
    /**
     * Transaction-current patch-group flag flips applied after `messages`
     * upserts. Prefer deltas over whole-message snapshots when only one
     * group's applyMode changes: a snapshot would revert sibling groups that
     * changed between the caller's read and this commit.
     */
    messagePatchFlags?: readonly ProfileCopilotMessagePatchFlag[];
    /**
     * Compare-and-swap token for the shared profile revision epoch. When
     * provided, the whole copilot commit (profile, preferences, setup state,
     * messages, and revisions) is skipped and a "stale" outcome with the
     * current profile and revision is returned if any of those three
     * singletons advanced after the caller captured the token.
     */
    expectedProfileRevision?: number;
  }): Promise<ProfileCommitOutcome>;
  /**
   * Flips one patch group's applyMode on its persisted copilot message
   * inside a single transaction, leaving sibling groups owned by their
   * concurrent writers. Resolves the owning message from current persisted
   * state rather than a caller snapshot. Returns false without writing when
   * no persisted message contains the patch group.
   */
  commitProfileCopilotPatchFlagUpdate(input: {
    patchGroupId: string;
    applyMode: ProfileCopilotMessage["patchGroups"][number]["applyMode"];
  }): Promise<boolean>;
  listSavedJobs(options?: {
    limit?: number;
    offset?: number;
  }): Promise<readonly SavedJob[]>;
  /** Validated immutable rows borrowed only for read-only display projections. */
  readSavedJobsProjection(): Promise<readonly SavedJob[]>;
  /** Saved-job ids in `listSavedJobs` order, without reading the jobs. */
  listSavedJobIds(): Promise<readonly string[]>;
  /** The saved jobs with these ids, in `listSavedJobs` order. */
  listSavedJobsByIds(jobIds: readonly string[]): Promise<readonly SavedJob[]>;
  /** Stored prepared fingerprints in one indexed batch; listing bodies are not read. */
  readSavedJobDiscoveryFingerprints(
    jobIds: readonly string[],
  ): Promise<ReadonlyMap<string, DiscoverySavedJobFingerprints>>;
  /** Timestamp-only batch; absent fields stay unchanged, null clears, unknown ids are ignored. */
  updateSavedJobSightings(
    updates: readonly SavedJobSightingPatch[],
  ): Promise<number>;
  updateSavedJobPlanAssessments(
    updates: readonly SavedJobPlanAssessmentPatch[],
  ): Promise<number>;
  /**
   * Atomically applies row-local saved-job updates and/or inserts without
   * replacing rows that the caller did not intend to change.
   */
  commitSavedJobDelta(input: {
    planAssessments?: readonly SavedJobPlanAssessmentPatch[];
    /** Applied after full upserts, in this same job/discovery transaction. */
    sightings?: readonly SavedJobSightingPatch[];
    upserts?: readonly SavedJob[];
    /**
     * Builds additional upserts from transaction-current canonical discovery
     * state, after acquiring the write lock. Paired `updateDiscoveryState`
     * receives that same state before any changes, so pending promotion and
     * removal cannot discard a newer enrichment. These rows follow `upserts`
     * precedence: with `update`, an existing saved row is updated instead.
     * This factory receives its own mutable copy; the paired state updater
     * borrows frozen rows, so factory edits cannot leak into that updater.
     */
    upsertsFromDiscovery?: (
      current: JobFinderDiscoveryState,
    ) => readonly SavedJob[];
    /**
     * Read-only alternative to the owned factory above. Borrows the same frozen,
     * transaction-current canonical state as the paired updater without copying
     * history. Return new rows for changes. When both factories are supplied,
     * these rows follow the owned factory's rows with the same upsert precedence.
     */
    upsertsFromBorrowedDiscovery?: (
      current: BorrowedDiscoveryState,
    ) => readonly SavedJob[];
    update?: (job: SavedJob) => SavedJob;
    /** Give the updater frozen current rows; it must return a new row for changes. */
    borrowCurrentJobs?: boolean;
    /**
     * Runs `update` only on these rows (and on stored rows an upsert names);
     * every other row stays as stored without being read. Pass it only when
     * `update` returns every other row unchanged. Without it `update` runs on
     * every row.
     */
    updateJobIds?: readonly string[];
    /**
     * Synchronous transform merged into the latest persisted settings inside
     * the same transaction as the saved-job changes, so paired settings/job
     * updates stay atomic against concurrent writers. The updater must merge
     * its owned fields into the passed current settings; returning a stale
     * full snapshot would revert concurrent field owners.
     */
    updateSettings?: (current: JobFinderSettings) => JobFinderSettings;
    clearResumeApproval?: {
      jobId: string;
      staleReason: string;
      shouldClear: (previousJob: SavedJob, nextJob: SavedJob) => boolean;
    };
    /**
     * Synchronous transform applied to the latest persisted discovery state
     * inside the same transaction as the saved-job changes, so paired
     * job/ledger updates stay atomic against concurrent writers.
     */
    updateDiscoveryState?: (
      current: BorrowedDiscoveryState,
    ) => CanonicalDiscoveryWrite;
  }): Promise<void>;
  /**
   * Applies discovery feedback against transaction-current job, preference,
   * campaign, intelligence, and discovery state. A thrown updater or invalid
   * output leaves every owned value unchanged.
   */
  commitDiscoveryFeedbackUpdate<TResult>(
    jobId: string,
    update: (
      current: DiscoveryFeedbackCommitCurrent,
    ) => DiscoveryFeedbackCommitNext<TResult>,
    /** Borrow frozen transaction-current singletons; replace changed values. */
    options?: { borrowUnchangedState: boolean },
  ): Promise<TResult>;
  /**
   * Destructively replaces the complete saved-job collection. The caller must
   * provide an authoritative full snapshot; paged or stale reads are invalid.
   * Prefer commitSavedJobDelta for ordinary product mutations.
   */
  replaceSavedJobs(savedJobs: readonly SavedJob[]): Promise<void>;
  /**
   * Destructively replaces the complete saved-job collection together with
   * discovery state. Reserved for authoritative reset/import boundaries.
   */
  replaceSavedJobsAndDiscoveryState(input: {
    savedJobs: readonly SavedJob[];
    discoveryState: CanonicalDiscoveryWrite;
  }): Promise<void>;
  /**
   * Destructively replaces the complete saved-job collection while clearing
   * resume approval. Prefer commitSavedJobDelta for row-local product updates.
   */
  replaceSavedJobsAndClearResumeApproval(input: {
    savedJobs: readonly SavedJob[];
    draft: ResumeDraft;
    staleReason: string;
    tailoredAsset?: TailoredAsset | null;
  }): Promise<void>;
  listTailoredAssets(): Promise<readonly TailoredAsset[]>;
  upsertTailoredAsset(tailoredAsset: TailoredAsset): Promise<void>;
  listResumeDrafts(): Promise<readonly ResumeDraft[]>;
  getResumeDraftByJobId(jobId: string): Promise<ResumeDraft | null>;
  upsertResumeDraft(draft: ResumeDraft): Promise<void>;
  listResumeDraftRevisions(
    draftId?: string,
  ): Promise<readonly ResumeDraftRevision[]>;
  /** The id `listResumeDraftRevisions(draftId)[0]` would have, read alone. */
  getLatestResumeDraftRevisionId(draftId: string): Promise<string | null>;
  upsertResumeDraftRevision(revision: ResumeDraftRevision): Promise<void>;
  listResumeExportArtifacts(options?: {
    jobId?: string;
    draftId?: string;
  }): Promise<readonly ResumeExportArtifact[]>;
  upsertResumeExportArtifact(artifact: ResumeExportArtifact): Promise<void>;
  listResumeResearchArtifacts(
    jobId?: string,
  ): Promise<readonly ResumeResearchArtifact[]>;
  upsertResumeResearchArtifact(artifact: ResumeResearchArtifact): Promise<void>;
  listResumeImportRuns(options?: {
    sourceResumeId?: string;
    statuses?: readonly ResumeImportRunStatus[];
    limit?: number;
  }): Promise<readonly ResumeImportRun[]>;
  getLatestResumeImportRun(
    sourceResumeId?: string,
  ): Promise<ResumeImportRun | null>;
  upsertResumeImportRun(run: ResumeImportRun): Promise<void>;
  listResumeImportDocumentBundles(options?: {
    runId?: string;
    sourceResumeId?: string;
  }): Promise<readonly ResumeDocumentBundle[]>;
  listResumeImportFieldCandidates(options?: {
    runId?: string;
    resolution?: ResumeImportCandidateResolution;
    resolutions?: readonly ResumeImportCandidateResolution[];
  }): Promise<readonly ResumeImportFieldCandidate[]>;
  replaceResumeImportRunArtifacts(input: {
    run: ResumeImportRun;
    documentBundles: readonly ResumeDocumentBundle[];
    fieldCandidates: readonly ResumeImportFieldCandidate[];
  }): Promise<void>;
  finalizeResumeImportRun(input: {
    profile: CandidateProfile;
    searchPreferences: JobSearchPreferences;
    run: ResumeImportRun;
    documentBundles: readonly ResumeDocumentBundle[];
    fieldCandidates: readonly ResumeImportFieldCandidate[];
    expectedProfileRevision?: number;
  }): Promise<ResumeImportFinalizationOutcome>;
  listResumeValidationResults(
    draftId?: string,
  ): Promise<readonly ResumeValidationResult[]>;
  /** At most one result per requested draft, using the history's latest-first order. */
  listLatestResumeValidationResults(
    draftIds: readonly string[],
  ): Promise<readonly ResumeValidationResult[]>;
  upsertResumeValidationResult(
    validationResult: ResumeValidationResult,
  ): Promise<void>;
  listResumeAssistantMessages(
    jobId?: string,
  ): Promise<readonly ResumeAssistantMessage[]>;
  upsertResumeAssistantMessage(message: ResumeAssistantMessage): Promise<void>;
  listProfileCopilotMessages(): Promise<readonly ProfileCopilotMessage[]>;
  upsertProfileCopilotMessage(message: ProfileCopilotMessage): Promise<void>;
  listProfileRevisions(): Promise<readonly ProfileRevision[]>;
  upsertProfileRevision(revision: ProfileRevision): Promise<void>;
  listApplyRuns(options?: { id?: string }): Promise<readonly ApplyRun[]>;
  upsertApplyRun(run: ApplyRun): Promise<void>;
  listApplyJobResults(options?: {
    id?: string;
    runId?: string;
    jobId?: string;
    applicationRecordId?: string;
  }): Promise<readonly ApplyJobResult[]>;
  upsertApplyJobResult(result: ApplyJobResultInput): Promise<void>;
  getPreparedApplicationForm(
    resultId: string,
  ): Promise<PreparedApplicationForm | null>;
  upsertPreparedApplicationForm(form: PreparedApplicationForm): Promise<void>;
  deletePreparedApplicationForm(resultId: string): Promise<void>;
  markApplicationPreparationStarted(input: {
    resultId: string;
    runId: string;
    jobId: string;
    startedAt: string;
    startedLocalDate: string;
  }): Promise<{ result: ApplyJobResult; didStart: boolean }>;
  compareAndSwapApplyJobResult(input: {
    expected: ApplyJobResult;
    result: ApplyJobResultInput;
  }): Promise<boolean>;
  listApplySubmitApprovals(options?: {
    id?: string;
    runId?: string;
  }): Promise<readonly ApplySubmitApproval[]>;
  upsertApplySubmitApproval(approval: ApplySubmitApproval): Promise<void>;
  listApplicationQuestionRecords(options?: {
    runId?: string;
    jobId?: string;
    resultId?: string;
    applicationRecordId?: string;
  }): Promise<readonly ApplicationQuestionRecord[]>;
  upsertApplicationQuestionRecord(
    record: ApplicationQuestionRecordInput,
  ): Promise<void>;
  listApplicationAnswerRecords(options?: {
    runId?: string;
    jobId?: string;
    resultId?: string;
    questionId?: string;
    applicationRecordId?: string;
  }): Promise<readonly ApplicationAnswerRecord[]>;
  upsertApplicationAnswerRecord(record: ApplicationAnswerRecord): Promise<void>;
  /**
   * Compare the latest answer and question with the caller's captured values,
   * then append the answer and update its question in one atomic operation.
   * A duplicate command is reported separately so retries remain idempotent.
   */
  commitApplicationAnswerMutation(input: {
    expectedAnswer: ApplicationAnswerRecord | null;
    expectedQuestion: ApplicationQuestionRecord;
    answer: ApplicationAnswerRecord;
    question: ApplicationQuestionRecord;
  }): Promise<ApplicationAnswerMutationResult>;
  listApplicationArtifactRefs(options?: {
    runId?: string;
    jobId?: string;
    resultId?: string;
    applicationRecordId?: string;
  }): Promise<readonly ApplicationArtifactRef[]>;
  upsertApplicationArtifactRef(ref: ApplicationArtifactRefInput): Promise<void>;
  listApplicationReplayCheckpoints(options?: {
    runId?: string;
    jobId?: string;
    resultId?: string;
    applicationRecordId?: string;
  }): Promise<readonly ApplicationReplayCheckpoint[]>;
  upsertApplicationReplayCheckpoint(
    checkpoint: ApplicationReplayCheckpointInput,
  ): Promise<void>;
  listApplicationConsentRequests(options?: {
    runId?: string;
    jobId?: string;
    resultId?: string;
    applicationRecordId?: string;
  }): Promise<readonly ApplicationConsentRequest[]>;
  upsertApplicationConsentRequest(
    request: ApplicationConsentRequest,
  ): Promise<void>;
  listUserActionRequests(
    query?: UserActionRequestQuery,
  ): Promise<readonly UserActionRequest[]>;
  saveUserActionAnswerDraft(
    input: SaveUserActionAnswerDraftInput,
  ): Promise<void>;
  getUserActionRequest(id: string): Promise<UserActionRequest | null>;
  createUserActionRequest(
    request: UserActionRequest,
  ): Promise<CreateUserActionRequestResult>;
  listUserActionEvents(
    query?: UserActionEventQuery,
  ): Promise<readonly UserActionEvent[]>;
  commitUserActionTransition(
    input: UserActionTransitionInput,
  ): Promise<UserActionTransitionCommitResult>;
  commitGroupedManualAnswer(
    input: CommitGroupedManualAnswerInput,
  ): Promise<CommitGroupedManualAnswerResult>;
  saveResumeDraftWithValidation(input: {
    draft: ResumeDraft;
    validation: ResumeValidationResult;
    tailoredAsset?: TailoredAsset | null;
  }): Promise<void>;
  applyResumePatchWithRevision(input: {
    /** Replace only this latest revision, preserving its exact pre-edit snapshot. */
    coalesceRevision?: { id: string; afterHash: string };
    expectedDraftUpdatedAt: string;
    draft: ResumeDraft;
    revision: ResumeDraftRevision;
    validation: ResumeValidationResult;
    tailoredAsset?: TailoredAsset | null;
  }): Promise<void>;
  approveResumeExport(input: {
    draft: ResumeDraft;
    exportArtifact: ResumeExportArtifact;
    validation?: ResumeValidationResult | null;
    tailoredAsset?: TailoredAsset | null;
  }): Promise<void>;
  clearResumeApproval(input: {
    draft: ResumeDraft;
    /** Null when an undo puts the draft back as it was. */
    staleReason: string | null;
    tailoredAsset?: TailoredAsset | null;
  }): Promise<void>;
  /**
   * Marks stored drafts stale in one transaction, as clearResumeApproval
   * does for one: status, reason and time, no approval, the job's exports
   * unapproved, and the job's first tailored asset without its file. Only
   * those fields change in the commit; the file repository then folds them
   * into the bodies in bounded background slices for older builds. Whole
   * drafts are not read or validated by the save. Unknown ids are skipped.
   */
  staleResumeDrafts?(input: {
    draftIds: readonly string[];
    staleReason: string;
    updatedAt: string;
    /** The explicit profile save and its approval invalidation share a commit. */
    profileInputs?: {
      profile: CandidateProfile;
      searchPreferences?: JobSearchPreferences;
    };
  }): Promise<void>;
  listApplicationRecords(): Promise<readonly ApplicationRecord[]>;
  upsertApplicationRecord(
    applicationRecord: ApplicationRecordInput,
  ): Promise<void>;
  /**
   * Atomically validates every selected CRM revision, then merges the CRM field
   * from each proposed changed record onto its transaction-current record.
   * Non-CRM fields remain owned by their concurrent writers. Missing or stale
   * selected records leave the persisted collection untouched.
   */
  commitApplicationRecordBatch(input: {
    expectedRevisions: readonly {
      applicationRecordId: string;
      expectedRevision: number;
    }[];
    records: readonly ApplicationRecord[];
  }): Promise<ApplicationRecordBatchCommitResult>;
  listApplicationAttempts(options?: {
    jobId?: string;
    applicationRecordId?: string;
  }): Promise<readonly ApplicationAttempt[]>;
  upsertApplicationAttempt(
    applicationAttempt: ApplicationAttemptInput,
  ): Promise<void>;
  claimApplicationAttempt(
    applicationAttempt: ApplicationAttemptInput,
  ): Promise<boolean>;
  listSourceDebugRuns(): Promise<readonly SourceDebugRunRecord[]>;
  upsertSourceDebugRun(run: SourceDebugRunRecord): Promise<void>;
  listSourceDebugAttempts(): Promise<readonly SourceDebugWorkerAttempt[]>;
  upsertSourceDebugAttempt(
    attempt: SourceDebugWorkerAttemptInput,
  ): Promise<void>;
  listSourceInstructionArtifacts(): Promise<
    readonly SourceInstructionArtifact[]
  >;
  upsertSourceInstructionArtifact(
    artifact: SourceInstructionArtifact,
  ): Promise<void>;
  deleteSourceInstructionArtifactsForTarget(targetId: string): Promise<void>;
  listSourceDebugEvidenceRefs(): Promise<readonly SourceDebugEvidenceRef[]>;
  upsertSourceDebugEvidenceRef(
    evidenceRef: SourceDebugEvidenceRef,
  ): Promise<void>;
  upsertSourceDebugEvidenceRefs(
    evidenceRefs: readonly SourceDebugEvidenceRef[],
  ): Promise<void>;
  getSettings(): Promise<JobFinderSettings>;
  saveSettings(settings: JobFinderSettings): Promise<void>;
  /**
   * Atomically applies a synchronous transform to the currently stored
   * workspace settings. The updater receives a clone of the latest persisted
   * settings and its schema-parsed output replaces them inside one
   * transaction, so concurrent writers cannot revert each other with stale
   * full-settings snapshots. A thrown updater or schema failure leaves the
   * persisted settings untouched and rejects.
   */
  commitSettingsUpdate(
    update: (current: JobFinderSettings) => JobFinderSettings,
  ): Promise<JobFinderSettings>;
  getDiscoveryState(): Promise<JobFinderDiscoveryState>;
  /** Frozen canonical run state, including checkpoints. Never mutate borrowed rows. */
  readDiscoveryStateForRun?(): Promise<JobFinderDiscoveryState>;
  /**
   * Borrowed immutable display state, reused until discovery changes. Agent
   * checkpoints stay in canonical storage and are null in this projection.
   * Never use it for resume, export, or full-state replacement. Writes must
   * use getDiscoveryState or the transaction-current commit updater instead.
   */
  readDiscoveryDisplayProjection(): Promise<DiscoveryDisplayProjection>;
  /**
   * Atomically applies a synchronous transform to the currently stored
   * discovery state. The updater borrows frozen canonical rows and must return
   * new rows for changes; untouched rows may retain their references. Only
   * changed rows are validated and written inside the transaction. Use
   * getDiscoveryState for an owned, mutable copy. A thrown updater or invalid
   * output leaves the persisted state untouched and rejects.
   */
  commitDiscoveryStateUpdate(
    update: (current: BorrowedDiscoveryState) => CanonicalDiscoveryWrite,
  ): Promise<JobFinderDiscoveryState>;
  /**
   * Reads the canonical discovery state into its cache without copying it,
   * so the first discovery commit after start does not pay for the read.
   */
  warmDiscoveryState?(): Promise<void>;
  /**
   * Atomically changes only the stored browser session states, without
   * reading discovery runs, logs or checkpoints.
   */
  commitDiscoverySessions?(
    update: (
      sessions: JobFinderDiscoveryState["sessions"],
    ) => JobFinderDiscoveryState["sessions"],
  ): Promise<JobFinderDiscoveryState["sessions"]>;
  getCampaignState(): Promise<JobSearchCampaignCollection | null>;
  readCampaignProjection?(): Promise<JobSearchCampaignCollection | null>;
  saveCampaignState(campaignState: JobSearchCampaignCollection): Promise<void>;
  /**
   * Applies a campaign collection and its corresponding global preferences
   * against transaction-current values. A company preference can include its
   * directory state so the marker and enforced exclusions commit together.
   * Invalid output or a thrown updater leaves every singleton unchanged.
   */
  commitCampaignPreferencesUpdate<TResult>(
    update: (
      current: CampaignPreferencesCommitCurrent,
    ) => CampaignPreferencesCommitNext<TResult>,
  ): Promise<TResult>;
  getIntelligenceState(): Promise<JobFinderIntelligenceState>;
  /** Borrowed immutable display state. Canonical reads remain caller-owned. */
  readIntelligenceProjection?(): Promise<JobFinderIntelligenceState>;
  saveIntelligenceState(state: JobFinderIntelligenceState): Promise<void>;
  /**
   * Replaces intelligence state from a synchronous transform of the latest
   * singleton and the exact currently persisted evidence references. The file
   * implementation acquires its write lock before reading these values. A
   * thrown updater or invalid output leaves intelligence unchanged.
   */
  commitCompanyIntelligenceUpdate(
    expected: CompanyIntelligenceCommitExpected,
    update: (
      current: CompanyIntelligenceCommitCurrent,
    ) => JobFinderIntelligenceState,
  ): Promise<JobFinderIntelligenceState>;
  getActivityControl(): Promise<JobFinderActivityControl>;
  saveActivityControl(activityControl: JobFinderActivityControl): Promise<void>;
  /** The one saved Apply queue (Apply to selected, this page or all), or null. */
  getApplyQueue(): Promise<ApplyQueue | null>;
  saveApplyQueue(queue: ApplyQueue | null): Promise<void>;
}

export interface AutomaticWorkspaceBackupOptions {
  /**
   * Rotate the graceful-close snapshot into `<filePath>.backup` (previous
   * generation preserved as `<filePath>.backup.prev`) right before the
   * repository closes its SQLite connection (normal app shutdown).
   */
  onClose?: boolean;
  /**
   * Snapshot the pre-reset state into the dedicated `<filePath>.reset-backup`
   * destination right before a destructive full-state reset overwrites it.
   * Close snapshots use a different destination and can never overwrite it
   * with post-reset state.
   */
  beforeReset?: boolean;
}

export type WorkspaceBackupReconciliationActionCode =
  WorkspaceBackupReconciliationAction["code"];

export type WorkspaceBackupReconciliationWarningCode =
  WorkspaceBackupReconciliationWarning["code"];

/**
 * Redacted pre-open rotation-reconciliation event. Paths are reduced to
 * basenames and raw errors are dropped so the payload is safe for desktop
 * user disclosure.
 */
export interface WorkspaceRotationReconciliationEvent {
  readonly actions: ReadonlyArray<{
    readonly code: WorkspaceBackupReconciliationActionCode;
  }>;
  readonly warnings: ReadonlyArray<{
    readonly code: WorkspaceBackupReconciliationWarningCode;
    readonly fileBasename: string;
  }>;
}

/** Redacted successful-restore event; carries no paths or row values. */
export interface WorkspaceDatabaseRestoreTelemetryEvent {
  readonly incidentId: string;
  readonly restoredFrom: WorkspaceRecoveryCandidateKind;
  readonly quarantinedArtifactBasenames: ReadonlyArray<string>;
  readonly lossWindow: WorkspaceRecoveryLossWindowInputs;
}

/**
 * Optional typed telemetry hooks emitted during repository creation.
 * `onRotationReconciled` fires only when reconciliation performed actions or
 * retained invalid files; `onRestored` fires once after a corrupted workspace
 * was recovered from a validated snapshot and reopened.
 */
export interface WorkspaceDatabaseStartupRecoveryTelemetry {
  onRotationReconciled?: (event: WorkspaceRotationReconciliationEvent) => void;
  onRestored?: (event: WorkspaceDatabaseRestoreTelemetryEvent) => void;
}

export type WorkspaceDatabaseRecoveryRequiredOutcome =
  | "no-valid-candidate"
  | "quarantine-incomplete"
  | "restore-revalidation-rejected"
  | "restore-promotion-failed"
  | "salvage-required";

/**
 * Redacted incident carried by WorkspaceDatabaseRecoveryRequiredError.
 * Candidates expose kinds/stages only, quarantined artifacts are basenames,
 * and the message never contains filesystem paths or persisted row values.
 */
export interface WorkspaceDatabaseRecoveryRequiredDetails {
  readonly incidentId: string;
  readonly outcome: WorkspaceDatabaseRecoveryRequiredOutcome;
  readonly failureEvidence:
    | "reported-error-code"
    | "failed-integrity-check"
    | "clean-integrity-check"
    | "source-missing"
    | "probe-unavailable"
    | null;
  readonly sqliteErrorCode: WorkspaceRecoverySqliteErrorCode | null;
  readonly candidates: ReadonlyArray<WorkspaceRecoveryCandidateStatus>;
  readonly quarantineBasenames: ReadonlyArray<string>;
}

export interface FileJobFinderRepositoryOptions {
  filePath: string;
  seed: JobFinderRepositorySeed;
  /**
   * Opt-in database-only recovery snapshots stored next to the live
   * database. They do not capture generated documents, candidate assets, or
   * browser profile data, so they cannot restore a full workspace after a
   * destructive reset; they recover the SQLite database itself. Backup
   * failures are non-fatal and never block close or reset.
   */
  automaticBackup?: AutomaticWorkspaceBackupOptions;
  /**
   * Typed startup recovery telemetry: backup-rotation reconciliation
   * outcomes and successful corruption restores, redacted for user
   * disclosure. Omitted hooks are skipped.
   */
  recoveryTelemetry?: WorkspaceDatabaseStartupRecoveryTelemetry;
  /**
   * Narrow validation seam mirroring the recovery core's overrides.
   * Production callers omit it; startup always applies the strict built-in
   * restored-snapshot revalidation regardless.
   */
  recoveryValidationOverrides?: WorkspaceRecoveryValidationOverrides;
}

export type StateTableKey =
  | "profile"
  | "search_preferences"
  | "profile_setup_state"
  | "settings"
  | "discovery_state"
  | "campaign_state"
  | "intelligence_state"
  | "activity_control"
  | "apply_queue";

export interface SchemaParser<TValue> {
  parse: (value: unknown) => TValue;
}
