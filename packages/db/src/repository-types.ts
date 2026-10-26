import type {
  CandidateProfile,
  JobFinderActivityControl,
  JobFinderSettings,
  JobSearchPreferences,
  ProfileCopilotMessage,
  ProfileRevision,
  ProfileSetupState,
  ResumeDocumentBundle,
  ResumeImportCandidateResolution,
  ResumeImportFieldCandidate,
  ResumeImportRun,
  ResumeImportRunStatus,
  SourceDebugEvidenceRef,
  SourceDebugRunRecord,
  SourceDebugWorkerAttempt,
  SourceDebugWorkerAttemptInput,
  SourceInstructionArtifact,
  UpsertSavedFormAnswerInput,
} from "@nestor/contracts";

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

/**
 * Job Finder's profile work over the job store: the profile, goals,
 * settings, setup and import records, site instructions and the pause. A
 * site check's runs, attempts and evidence last only while the app runs.
 */
export interface JobFinderRepository {
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
    savedAnswers?: readonly UpsertSavedFormAnswerInput[];
    profile: CandidateProfile;
    searchPreferences: JobSearchPreferences;
    run: ResumeImportRun;
    documentBundles: readonly ResumeDocumentBundle[];
    fieldCandidates: readonly ResumeImportFieldCandidate[];
    expectedProfileRevision?: number;
  }): Promise<ResumeImportFinalizationOutcome>;
  listProfileCopilotMessages(): Promise<readonly ProfileCopilotMessage[]>;
  upsertProfileCopilotMessage(message: ProfileCopilotMessage): Promise<void>;
  listProfileRevisions(): Promise<readonly ProfileRevision[]>;
  upsertProfileRevision(revision: ProfileRevision): Promise<void>;
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
  getActivityControl(): Promise<JobFinderActivityControl>;
  saveActivityControl(activityControl: JobFinderActivityControl): Promise<void>;
}
