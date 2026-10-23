import {
  PreparedApplicationFormSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplySubmitApprovalSchema,
  ApplicationAnswerRecordSchema,
  ApplicationArtifactRefSchema,
  ApplicationAttemptSchema,
  ApplicationConsentRequestSchema,
  ApplicationRecordSchema,
  ApplicationQuestionRecordSchema,
  ApplicationReplayCheckpointSchema,
  CandidateProfileSchema,
  JobFinderActivityControlSchema,
  JobFinderDiscoveryStateSchema,
  JobFinderIntelligenceStateSchema,
  JobFinderRepositoryStateSchema,
  JobFinderSettingsSchema,
  JobSearchCampaignCollectionSchema,
  JobSearchPreferencesSchema,
  ProfileCopilotMessageSchema,
  ProfileRevisionSchema,
  ProfileSetupStateSchema,
  ResumeDocumentBundleSchema,
  ResumeAssistantMessageSchema,
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  ResumeExportArtifactSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
  ResumeResearchArtifactSchema,
  ResumeValidationResultSchema,
  SavedJobSchema,
  SourceDebugEvidenceRefSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
  TailoredAssetSchema,
  UserActionEventSchema,
  SaveUserActionAnswerDraftInputSchema,
  mergeUserActionAnswerDraft,
  UserActionRequestSchema,
  type ApplicationAnswerRecord,
  type ApplicationQuestionRecord,
  type CandidateProfile,
  type SavedJob,
  type ResumeValidationResult,
  type UserActionRequest,
} from "@nestor/contracts";

import { cloneValue } from "./internal/state";
import { freezeProjection } from "./internal/saved-job-projection";
import { toDiscoveryDisplayProjection } from "./internal/discovery-display-projection";
import { createApplicationAnswerSnapshotRepositoryMethods } from "./application-answer-snapshot-repository";
import { createApplicationAuthorityRepositoryMethods } from "./application-authority-repository";
import {
  areSameApplicationAnswerRecords,
  areSameApplicationQuestionRecords,
  latestApplicationAnswerRecord,
  normalizeGroupedManualAnswerCommit,
  resolveGroupedManualAnswerCommit,
  type GroupedManualAnswerCurrentSnapshot,
} from "./grouped-manual-answer-support";
import type { CommitGroupedManualAnswerInput } from "./grouped-manual-answer-types";
import type { DiscoveryDisplayProjection } from "./repository-types";
import {
  assertApplicationPreparationStartPreserved,
  matchesOptionalStringFilters,
  sortApplicationAnswerRecords,
  sortApplicationArtifactRefs,
  sortApplicationConsentRequests,
  sortApplicationQuestionRecords,
  sortApplicationReplayCheckpoints,
  sortApplyJobResults,
  sortApplyRuns,
  sortApplySubmitApprovals,
} from "./apply-collection-support";
import {
  areSameUserActionEvents,
  areSameUserActionRequests,
  assertUserActionTransitionCurrent,
  createPersistedUserActionCreatedEvent,
  matchesUserActionEventQuery,
  matchesUserActionRequestQuery,
  normalizeUserActionTransition,
  sortUserActionEvents,
  sortUserActionRequests,
} from "./user-action-repository-support";
import {
  clearApprovedResumeExportsForJob,
  replaceArtifactsForRun,
  resolveApprovedExportId,
  sortExports,
  sortImportRuns,
  sortMessages,
  sortNewestFirst,
  sortResearch,
  sortResumeDrafts,
  sortValidationResults,
  upsertById,
} from "./in-memory-repository-utils";
import { retainResumeDraftRevisions } from "./resume-draft-revision-retention";
import {
  applyProfileCopilotMessagePatchFlags,
  findProfileCopilotMessageByPatchGroup,
} from "./profile-copilot-message-flags";
import type {
  JobFinderRepository,
  JobFinderRepositorySeed,
} from "./repository-types";

function assertAtMostOneActiveApplicationAuthority(
  state: JobFinderRepositorySeed,
): void {
  const activeAuthorityCount = state.applicationAuthorityEnvelopes.filter(
    (envelope) => envelope.status === "active",
  ).length;
  if (activeAuthorityCount > 1) {
    throw new Error(
      "Refusing to create an in-memory repository with more than one active application authority envelope.",
    );
  }
}

export function createInMemoryJobFinderRepository(
  seed: JobFinderRepositorySeed,
): JobFinderRepository {
  const state = JobFinderRepositoryStateSchema.parse(cloneValue(seed));
  assertAtMostOneActiveApplicationAuthority(state);
  let profileRevision = 1;
  let discoveryProjectionSource: typeof state.discovery | null = null;
  let discoveryProjection: DiscoveryDisplayProjection | null = null;
  let intelligenceProjectionSource: typeof state.intelligence | null = null;
  let intelligenceProjection: typeof state.intelligence | null = null;
  let savedProjectionSource: typeof state.savedJobs | null = null;
  let savedProjection: readonly SavedJob[] = [];
  const savedProjectionRows = new WeakMap<SavedJob, SavedJob>();
  const displayCollections = new WeakMap<object, readonly object[]>();
  const displayRows = new WeakMap<object, object>();
  function borrowDisplayRows<T extends object>(
    source: readonly T[],
    order: (rows: readonly T[]) => readonly T[] = (rows) => rows,
  ): readonly T[] {
    const cached = displayCollections.get(source);
    if (cached) return cached as readonly T[];
    const rows = Object.freeze(
      order(source).map((value) => {
        let borrowed = displayRows.get(value);
        if (!borrowed) {
          borrowed = freezeProjection(cloneValue(value));
          displayRows.set(value, borrowed);
        }
        return borrowed as T;
      }),
    );
    displayCollections.set(source, rows);
    return rows;
  }

  function readProfileWithRevision(): {
    profile: CandidateProfile;
    revision: number;
  } {
    return cloneValue({ profile: state.profile, revision: profileRevision });
  }

  function commitProfileUpdateOutcome(
    updateProfile: (current: CandidateProfile) => CandidateProfile,
    expectedRevision: number | undefined,
  ):
    | { status: "applied"; profile: CandidateProfile; revision: number }
    | { status: "stale"; profile: CandidateProfile; revision: number } {
    if (
      expectedRevision !== undefined &&
      expectedRevision !== profileRevision
    ) {
      return {
        status: "stale",
        profile: cloneValue(state.profile),
        revision: profileRevision,
      };
    }

    const nextProfile = CandidateProfileSchema.parse(
      cloneValue(updateProfile(cloneValue(state.profile))),
    );
    state.profile = nextProfile;
    profileRevision += 1;
    return {
      status: "applied",
      profile: cloneValue(nextProfile),
      revision: profileRevision,
    };
  }

  return {
    ...createApplicationAnswerSnapshotRepositoryMethods({
      read: () => state,
      mutate: (operation) => {
        const draft = JobFinderRepositoryStateSchema.parse(cloneValue(state));
        const result = operation(draft);
        Object.assign(state, draft);
        return result;
      },
    }),
    ...createApplicationAuthorityRepositoryMethods({
      read: () => state,
      mutate: (operation) => {
        const draft = JobFinderRepositoryStateSchema.parse(cloneValue(state));
        const result = operation(draft);
        Object.assign(state, draft);
        return result;
      },
    }),
    close() {
      return Promise.resolve();
    },
    exportState: () => Promise.resolve(cloneValue(state)),
    readDisplayCollections: () =>
      Promise.resolve({
        tailoredAssets: borrowDisplayRows(state.tailoredAssets),
        resumeDrafts: borrowDisplayRows(state.resumeDrafts, sortResumeDrafts),
        resumeExportArtifacts: borrowDisplayRows(
          state.resumeExportArtifacts,
          sortExports,
        ),
        resumeResearchArtifacts: borrowDisplayRows(
          state.resumeResearchArtifacts,
          sortResearch,
        ),
        applyRuns: borrowDisplayRows(state.applyRuns, sortApplyRuns),
        applyJobResults: borrowDisplayRows(
          state.applyJobResults,
          sortApplyJobResults,
        ),
        applicationRecords: borrowDisplayRows(state.applicationRecords),
        applicationAttempts: borrowDisplayRows(state.applicationAttempts),
        sourceInstructionArtifacts: borrowDisplayRows(
          state.sourceInstructionArtifacts,
        ),
        sourceDebugAttempts: borrowDisplayRows(state.sourceDebugAttempts),
        profileCopilotMessages: borrowDisplayRows(
          state.profileCopilotMessages,
          sortMessages,
        ),
        profileRevisions: borrowDisplayRows(
          state.profileRevisions,
          sortNewestFirst,
        ),
        userActionRequests: borrowDisplayRows(
          state.userActionRequests,
          sortUserActionRequests,
        ),
        userActionEvents: borrowDisplayRows(
          state.userActionEvents,
          sortUserActionEvents,
        ),
        latestResumeValidationResults: borrowDisplayRows(
          state.resumeValidationResults,
          (values) => {
            const latest = new Map<string, ResumeValidationResult>();
            for (const value of sortValidationResults(values)) {
              if (!latest.has(value.draftId)) latest.set(value.draftId, value);
            }
            return [...latest.values()];
          },
        ),
      }),
    getTailoredAssetById: (assetId) =>
      Promise.resolve(
        cloneValue(
          state.tailoredAssets.find((asset) => asset.id === assetId) ?? null,
        ),
      ),
    getTailoredAssetByJobId: (jobId) =>
      Promise.resolve(
        cloneValue(
          state.tailoredAssets.find((asset) => asset.jobId === jobId) ?? null,
        ),
      ),
    reset(nextSeed) {
      const normalizedSeed = JobFinderRepositoryStateSchema.parse(
        cloneValue(nextSeed),
      );
      assertAtMostOneActiveApplicationAuthority(normalizedSeed);

      // The reset replaces the whole workspace, but the compare-and-swap epoch
      // only ever moves forward — mirroring `initSingletonValue` in the SQLite
      // backend. Rewinding it to 1 would let a token captured before the reset
      // still satisfy the equality check afterwards and overwrite the freshly
      // seeded profile, search preferences and profile setup state.
      profileRevision += 1;
      state.profile = normalizedSeed.profile;
      state.searchPreferences = normalizedSeed.searchPreferences;
      state.profileSetupState = normalizedSeed.profileSetupState;
      state.savedJobs = normalizedSeed.savedJobs;
      state.tailoredAssets = normalizedSeed.tailoredAssets;
      state.resumeDrafts = normalizedSeed.resumeDrafts;
      state.resumeDraftRevisions = normalizedSeed.resumeDraftRevisions;
      state.resumeExportArtifacts = normalizedSeed.resumeExportArtifacts;
      state.resumeImportRuns = normalizedSeed.resumeImportRuns;
      state.resumeImportDocumentBundles =
        normalizedSeed.resumeImportDocumentBundles;
      state.resumeImportFieldCandidates =
        normalizedSeed.resumeImportFieldCandidates;
      state.resumeResearchArtifacts = normalizedSeed.resumeResearchArtifacts;
      state.resumeValidationResults = normalizedSeed.resumeValidationResults;
      state.resumeAssistantMessages = normalizedSeed.resumeAssistantMessages;
      state.profileCopilotMessages = normalizedSeed.profileCopilotMessages;
      state.profileRevisions = normalizedSeed.profileRevisions;
      state.applyRuns = normalizedSeed.applyRuns;
      state.applyJobResults = normalizedSeed.applyJobResults;
      state.applySubmitApprovals = normalizedSeed.applySubmitApprovals;
      state.applicationAuthorityEnvelopes =
        normalizedSeed.applicationAuthorityEnvelopes;
      state.submissionPreflights = normalizedSeed.submissionPreflights;
      state.submissionExecutionGrants =
        normalizedSeed.submissionExecutionGrants;
      state.submissionIdempotencyRecords =
        normalizedSeed.submissionIdempotencyRecords;
      state.submissionArmedMarkers = normalizedSeed.submissionArmedMarkers;
      state.submissionOutcomeRecords = normalizedSeed.submissionOutcomeRecords;
      state.applicationQuestionRecords =
        normalizedSeed.applicationQuestionRecords;
      state.applicationAnswerRecords = normalizedSeed.applicationAnswerRecords;
      state.applicationArtifactRefs = normalizedSeed.applicationArtifactRefs;
      state.preparedApplicationForms = normalizedSeed.preparedApplicationForms;
      state.applicationReplayCheckpoints =
        normalizedSeed.applicationReplayCheckpoints;
      state.applicationConsentRequests =
        normalizedSeed.applicationConsentRequests;
      state.applicationAnswerSnapshots =
        normalizedSeed.applicationAnswerSnapshots;
      state.userActionRequests = normalizedSeed.userActionRequests;
      state.userActionEvents = normalizedSeed.userActionEvents;
      state.applicationRecords = normalizedSeed.applicationRecords;
      state.applicationAttempts = normalizedSeed.applicationAttempts;
      state.sourceDebugRuns = normalizedSeed.sourceDebugRuns;
      state.sourceDebugAttempts = normalizedSeed.sourceDebugAttempts;
      state.sourceInstructionArtifacts =
        normalizedSeed.sourceInstructionArtifacts;
      state.sourceDebugEvidenceRefs = normalizedSeed.sourceDebugEvidenceRefs;
      state.settings = normalizedSeed.settings;
      state.discovery = normalizedSeed.discovery;
      state.campaigns = normalizedSeed.campaigns;
      state.activeCampaignId = normalizedSeed.activeCampaignId;
      state.campaignNotifications = normalizedSeed.campaignNotifications;
      state.activityControl = normalizedSeed.activityControl;
      state.intelligence = normalizedSeed.intelligence;

      return Promise.resolve();
    },
    getProfile() {
      return Promise.resolve(cloneValue(state.profile));
    },
    getProfileWithRevision() {
      return Promise.resolve(readProfileWithRevision());
    },
    saveProfile(profile) {
      state.profile = CandidateProfileSchema.parse(cloneValue(profile));
      profileRevision += 1;
      return Promise.resolve();
    },
    commitProfileUpdate(updateProfile, options) {
      try {
        return Promise.resolve(
          commitProfileUpdateOutcome(updateProfile, options?.expectedRevision),
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    getSearchPreferences() {
      return Promise.resolve(cloneValue(state.searchPreferences));
    },
    getProfileSetupState() {
      return Promise.resolve(cloneValue(state.profileSetupState));
    },
    saveSearchPreferences(searchPreferences) {
      state.searchPreferences = JobSearchPreferencesSchema.parse(
        cloneValue(searchPreferences),
      );
      // Preference-only writes advance the shared profile epoch so copilot
      // commits that captured older preferences fail closed as stale.
      profileRevision += 1;
      return Promise.resolve();
    },
    saveProfileSetupState(profileSetupState) {
      state.profileSetupState = ProfileSetupStateSchema.parse(
        cloneValue(profileSetupState),
      );
      // Setup-state-only writes advance the shared profile epoch so copilot
      // commits that captured older setup state fail closed as stale.
      profileRevision += 1;
      return Promise.resolve();
    },
    saveProfileAndSearchPreferences(profile, searchPreferences) {
      state.profile = CandidateProfileSchema.parse(cloneValue(profile));
      state.searchPreferences = JobSearchPreferencesSchema.parse(
        cloneValue(searchPreferences),
      );
      profileRevision += 1;
      return Promise.resolve();
    },
    commitProfileCopilotState({
      profile,
      searchPreferences,
      profileSetupState,
      messages,
      revisions,
      messagePatchFlags,
      expectedProfileRevision,
    }) {
      if (
        expectedProfileRevision !== undefined &&
        expectedProfileRevision !== profileRevision
      ) {
        return Promise.resolve({
          status: "stale" as const,
          profile: cloneValue(state.profile),
          revision: profileRevision,
        });
      }

      state.profile = CandidateProfileSchema.parse(cloneValue(profile));
      profileRevision += 1;
      state.searchPreferences = JobSearchPreferencesSchema.parse(
        cloneValue(searchPreferences),
      );
      state.profileSetupState = ProfileSetupStateSchema.parse(
        cloneValue(profileSetupState),
      );

      if (messages) {
        const normalizedMessages = ProfileCopilotMessageSchema.array().parse(
          cloneValue(messages),
        );
        for (const message of normalizedMessages) {
          state.profileCopilotMessages = upsertById(
            state.profileCopilotMessages,
            message,
          );
        }
      }

      if (revisions) {
        const normalizedRevisions = ProfileRevisionSchema.array().parse(
          cloneValue(revisions),
        );
        for (const revision of normalizedRevisions) {
          state.profileRevisions = upsertById(state.profileRevisions, revision);
        }
      }

      // Flag deltas resolve against transaction-current rows so sibling
      // groups changed by a concurrent apply/reject are never reverted.
      if (messagePatchFlags && messagePatchFlags.length > 0) {
        const changedMessages = applyProfileCopilotMessagePatchFlags(
          ProfileCopilotMessageSchema.array().parse(
            cloneValue(state.profileCopilotMessages),
          ),
          cloneValue(messagePatchFlags),
        );
        for (const message of changedMessages) {
          state.profileCopilotMessages = upsertById(
            state.profileCopilotMessages,
            ProfileCopilotMessageSchema.parse(cloneValue(message)),
          );
        }
      }

      return Promise.resolve({
        status: "applied" as const,
        profile: cloneValue(state.profile),
        revision: profileRevision,
      });
    },
    commitProfileCopilotPatchFlagUpdate({ patchGroupId, applyMode }) {
      const currentMessages = ProfileCopilotMessageSchema.array().parse(
        cloneValue(state.profileCopilotMessages),
      );

      const messageIndex = findProfileCopilotMessageByPatchGroup(
        currentMessages,
        { patchGroupId },
      );

      if (messageIndex < 0) {
        return Promise.resolve(false);
      }

      const [changedMessage] = applyProfileCopilotMessagePatchFlags(
        currentMessages,
        [
          {
            messageId: currentMessages[messageIndex]!.id,
            patchGroupId,
            applyMode,
          },
        ],
      );

      if (changedMessage) {
        state.profileCopilotMessages = upsertById(
          state.profileCopilotMessages,
          ProfileCopilotMessageSchema.parse(cloneValue(changedMessage)),
        );
      }
      return Promise.resolve(true);
    },
    listSavedJobs(options?: { limit?: number; offset?: number }) {
      const normalizePaginationValue = (
        value: number | undefined,
        fieldName: "limit" | "offset",
        defaultValue: number,
      ): number => {
        if (value === undefined) {
          return defaultValue;
        }
        if (!Number.isFinite(value)) {
          throw new RangeError(`${fieldName} must be a finite number.`);
        }
        return Math.max(0, Math.floor(value));
      };
      const limit = normalizePaginationValue(options?.limit, "limit", -1);
      const offset = normalizePaginationValue(options?.offset, "offset", 0);
      const orderedJobs = [...state.savedJobs].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      const sliced =
        limit < 0
          ? orderedJobs.slice(offset)
          : orderedJobs.slice(offset, offset + limit);
      return Promise.resolve(cloneValue(sliced));
    },
    readSavedJobsProjection() {
      if (savedProjectionSource !== state.savedJobs) {
        const rows = [...state.savedJobs]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((job) => {
            let row = savedProjectionRows.get(job);
            if (!row) {
              row = freezeProjection(cloneValue(job));
              savedProjectionRows.set(job, row);
            }
            return row;
          });
        if (
          rows.length !== savedProjection.length ||
          rows.some((row, index) => row !== savedProjection[index])
        ) {
          savedProjection = Object.freeze(rows);
        }
        savedProjectionSource = state.savedJobs;
      }
      return Promise.resolve(savedProjection);
    },
    listSavedJobIds() {
      return Promise.resolve(
        state.savedJobs
          .map((job) => job.id)
          .sort((left, right) => left.localeCompare(right)),
      );
    },
    listSavedJobsByIds(jobIds) {
      const wanted = new Set(jobIds);
      return Promise.resolve(
        cloneValue(
          state.savedJobs
            .filter((job) => wanted.has(job.id))
            .sort((left, right) => left.id.localeCompare(right.id)),
        ),
      );
    },
    commitSavedJobDelta({
      upserts = [],
      upsertsFromDiscovery,
      upsertsFromBorrowedDiscovery,
      update,
      updateJobIds,
      updateSettings,
      clearResumeApproval,
      updateDiscoveryState,
    }) {
      try {
        const currentDiscoveryState =
          upsertsFromDiscovery ||
          upsertsFromBorrowedDiscovery ||
          updateDiscoveryState
            ? freezeProjection(state.discovery)
            : null;
        const normalizedUpserts = SavedJobSchema.array().parse(
          cloneValue([
            ...upserts,
            ...(upsertsFromDiscovery && currentDiscoveryState
              ? upsertsFromDiscovery(cloneValue(currentDiscoveryState))
              : []),
            ...(upsertsFromBorrowedDiscovery && currentDiscoveryState
              ? upsertsFromBorrowedDiscovery(currentDiscoveryState)
              : []),
          ]),
        );
        const existingJobIds = new Set(state.savedJobs.map((job) => job.id));
        let previousJobForResumeApproval: ReturnType<
          typeof SavedJobSchema.parse
        > | null = null;
        let nextJobForResumeApproval: ReturnType<
          typeof SavedJobSchema.parse
        > | null = null;

        const nextSettings = updateSettings
          ? JobFinderSettingsSchema.parse(
              cloneValue(updateSettings(cloneValue(state.settings))),
            )
          : null;

        let nextSavedJobs = state.savedJobs;
        if (update) {
          const updatedJobIds = updateJobIds
            ? new Set([
                ...updateJobIds,
                ...normalizedUpserts.map((job) => job.id),
                ...(clearResumeApproval ? [clearResumeApproval.jobId] : []),
              ])
            : null;
          nextSavedJobs = state.savedJobs.map((currentJob) => {
            if (updatedJobIds && !updatedJobIds.has(currentJob.id)) {
              return currentJob;
            }
            const nextJob = SavedJobSchema.parse(
              cloneValue(update(cloneValue(currentJob))),
            );
            if (nextJob.id !== currentJob.id) {
              throw new Error(
                "Saved job delta updates must preserve each job id.",
              );
            }
            if (currentJob.id === clearResumeApproval?.jobId) {
              previousJobForResumeApproval = currentJob;
              nextJobForResumeApproval = nextJob;
            }
            return JSON.stringify(nextJob) === JSON.stringify(currentJob)
              ? currentJob
              : nextJob;
          });
        }

        for (const job of normalizedUpserts) {
          if (update && existingJobIds.has(job.id)) {
            continue;
          }
          nextSavedJobs = upsertById(nextSavedJobs, job);
        }

        let nextResumeDrafts = state.resumeDrafts;
        let nextResumeExportArtifacts = state.resumeExportArtifacts;
        let nextTailoredAssets = state.tailoredAssets;

        if (
          clearResumeApproval &&
          previousJobForResumeApproval &&
          nextJobForResumeApproval &&
          clearResumeApproval.shouldClear(
            previousJobForResumeApproval,
            nextJobForResumeApproval,
          )
        ) {
          // Select the newest draft, matching the SQLite repository's
          // "updated_at DESC, id ASC" lookup and getResumeDraftByJobId. Taking
          // the first inserted draft could leave an approved resume standing
          // against changed job text.
          const draft = sortResumeDrafts(state.resumeDrafts).find(
            (candidate) => candidate.jobId === clearResumeApproval.jobId,
          );
          if (
            draft &&
            (draft.approvedAt ||
              draft.approvedExportId ||
              draft.status === "approved")
          ) {
            const staleDraft = ResumeDraftSchema.parse(
              cloneValue({
                ...draft,
                status: "stale",
                staleReason: clearResumeApproval.staleReason,
                approvedAt: null,
                approvedExportId: null,
                updatedAt: new Date().toISOString(),
              }),
            );

            nextResumeDrafts = upsertById(nextResumeDrafts, staleDraft);
            nextResumeExportArtifacts = clearApprovedResumeExportsForJob(
              nextResumeExportArtifacts,
              staleDraft.jobId,
            );
            // Same newest-first rule as the SQLite tailored-asset lookup.
            const existingAsset =
              [...state.tailoredAssets]
                .sort(
                  (left, right) =>
                    new Date(right.updatedAt).getTime() -
                      new Date(left.updatedAt).getTime() ||
                    left.id.localeCompare(right.id),
                )
                .find((asset) => asset.jobId === staleDraft.jobId) ?? null;
            if (existingAsset) {
              nextTailoredAssets = upsertById(nextTailoredAssets, {
                ...existingAsset,
                storagePath: null,
                updatedAt: staleDraft.updatedAt,
              });
            }
          }
        }

        const nextDiscoveryState =
          updateDiscoveryState && currentDiscoveryState
            ? JobFinderDiscoveryStateSchema.parse(
                cloneValue(updateDiscoveryState(currentDiscoveryState)),
              )
            : null;

        state.savedJobs = nextSavedJobs;
        state.resumeDrafts = nextResumeDrafts;
        state.resumeExportArtifacts = nextResumeExportArtifacts;
        state.tailoredAssets = nextTailoredAssets;
        if (nextSettings) {
          state.settings = nextSettings;
        }
        if (nextDiscoveryState) {
          state.discovery = nextDiscoveryState;
        }

        return Promise.resolve();
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    commitDiscoveryFeedbackUpdate(jobId, update) {
      try {
        const pendingJob =
          state.discovery.pendingDiscoveryJobs.find(
            (job) => job.id === jobId,
          ) ?? null;
        const savedJob =
          state.savedJobs.find((job) => job.id === jobId) ?? null;
        const next = update({
          job: cloneValue(pendingJob ?? savedJob),
          jobIsPending: pendingJob !== null,
          searchPreferences: cloneValue(state.searchPreferences),
          campaignState:
            state.campaigns.length === 0 || !state.activeCampaignId
              ? null
              : cloneValue(
                  JobSearchCampaignCollectionSchema.parse({
                    campaigns: state.campaigns,
                    activeCampaignId: state.activeCampaignId,
                    notifications: state.campaignNotifications,
                  }),
                ),
          intelligenceState: cloneValue(state.intelligence),
          discoveryState: freezeProjection(cloneValue(state.discovery)),
        });
        const nextSearchPreferences = JobSearchPreferencesSchema.parse(
          cloneValue(next.searchPreferences),
        );
        const nextCampaignState =
          next.campaignState === null
            ? null
            : JobSearchCampaignCollectionSchema.parse(
                cloneValue(next.campaignState),
              );
        const nextDiscoveryState = JobFinderDiscoveryStateSchema.parse(
          cloneValue(next.discoveryState),
        );
        const nextSavedJob = next.savedJob
          ? SavedJobSchema.parse(cloneValue(next.savedJob))
          : null;

        if (nextSavedJob) {
          state.savedJobs = upsertById(state.savedJobs, nextSavedJob);
        }
        // A changed preference advances the shared profile epoch so a
        // copilot commit that captured the older preferences fails closed as
        // stale instead of reverting this feedback. Most discovery feedback
        // leaves preferences untouched; those rewrites must not invalidate
        // unrelated in-flight profile work.
        if (
          JSON.stringify(nextSearchPreferences) !==
          JSON.stringify(state.searchPreferences)
        ) {
          profileRevision += 1;
        }
        state.searchPreferences = nextSearchPreferences;
        if (nextCampaignState !== null) {
          state.campaigns = nextCampaignState.campaigns;
          state.activeCampaignId = nextCampaignState.activeCampaignId;
          state.campaignNotifications = nextCampaignState.notifications;
        }
        state.discovery = nextDiscoveryState;
        return Promise.resolve(next.result);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    replaceSavedJobs(savedJobs) {
      state.savedJobs = SavedJobSchema.array().parse(
        cloneValue([...savedJobs]),
      );
      return Promise.resolve();
    },
    replaceSavedJobsAndDiscoveryState({ savedJobs, discoveryState }) {
      state.savedJobs = SavedJobSchema.array().parse(
        cloneValue([...savedJobs]),
      );
      state.discovery = JobFinderDiscoveryStateSchema.parse(
        cloneValue(discoveryState),
      );
      return Promise.resolve();
    },
    replaceSavedJobsAndClearResumeApproval({
      savedJobs,
      draft,
      staleReason,
      tailoredAsset,
    }) {
      const normalizedJobs = SavedJobSchema.array().parse(
        cloneValue([...savedJobs]),
      );
      const normalizedDraft = ResumeDraftSchema.parse(
        cloneValue({
          ...draft,
          staleReason,
          approvedAt: null,
          approvedExportId: null,
        }),
      );
      const normalizedAsset = tailoredAsset
        ? TailoredAssetSchema.parse(cloneValue(tailoredAsset))
        : null;

      if (normalizedAsset && normalizedAsset.jobId !== normalizedDraft.jobId) {
        throw new Error(
          "Tailored asset job does not match the provided draft.",
        );
      }

      state.savedJobs = normalizedJobs;
      state.resumeDrafts = upsertById(state.resumeDrafts, normalizedDraft);
      state.resumeExportArtifacts = clearApprovedResumeExportsForJob(
        state.resumeExportArtifacts,
        normalizedDraft.jobId,
      );
      if (normalizedAsset) {
        state.tailoredAssets = upsertById(
          state.tailoredAssets,
          normalizedAsset,
        );
      }
      return Promise.resolve();
    },
    listTailoredAssets() {
      return Promise.resolve(cloneValue(state.tailoredAssets));
    },
    upsertTailoredAsset(tailoredAsset) {
      const normalizedAsset = TailoredAssetSchema.parse(
        cloneValue(tailoredAsset),
      );
      state.tailoredAssets = upsertById(state.tailoredAssets, normalizedAsset);
      return Promise.resolve();
    },
    listResumeDrafts() {
      return Promise.resolve(sortResumeDrafts(cloneValue(state.resumeDrafts)));
    },
    getResumeDraftByJobId(jobId) {
      const draft = sortResumeDrafts(state.resumeDrafts).find(
        (entry) => entry.jobId === jobId,
      );
      return Promise.resolve(draft ? cloneValue(draft) : null);
    },
    upsertResumeDraft(draft) {
      const normalizedDraft = ResumeDraftSchema.parse(cloneValue(draft));
      state.resumeDrafts = upsertById(state.resumeDrafts, normalizedDraft);
      return Promise.resolve();
    },
    listResumeDraftRevisions(draftId) {
      const values = draftId
        ? state.resumeDraftRevisions.filter(
            (entry) => entry.draftId === draftId,
          )
        : state.resumeDraftRevisions;
      return Promise.resolve(sortNewestFirst(cloneValue(values)));
    },
    upsertResumeDraftRevision(revision) {
      const normalizedRevision = ResumeDraftRevisionSchema.parse(
        cloneValue(revision),
      );
      state.resumeDraftRevisions = retainResumeDraftRevisions(
        upsertById(state.resumeDraftRevisions, normalizedRevision),
        normalizedRevision.draftId,
      );
      return Promise.resolve();
    },
    listResumeExportArtifacts(options) {
      const values = state.resumeExportArtifacts.filter((entry) => {
        if (options?.jobId && entry.jobId !== options.jobId) {
          return false;
        }

        if (options?.draftId && entry.draftId !== options.draftId) {
          return false;
        }

        return true;
      });
      return Promise.resolve(sortExports(cloneValue(values)));
    },
    upsertResumeExportArtifact(artifact) {
      const normalizedArtifact = ResumeExportArtifactSchema.parse(
        cloneValue(artifact),
      );

      // Only approveResumeExport() demotes the job's sibling exports, so
      // writing an approved artifact through this method would leave two
      // approved exports for one job. The SQLite repository refuses the same
      // write; the backends must not diverge on an approval invariant.
      if (normalizedArtifact.isApproved) {
        throw new Error(
          "Approved resume exports must be written through approveResumeExport().",
        );
      }

      state.resumeExportArtifacts = upsertById(
        state.resumeExportArtifacts,
        normalizedArtifact,
      );
      return Promise.resolve();
    },
    listResumeResearchArtifacts(jobId) {
      const values = jobId
        ? state.resumeResearchArtifacts.filter((entry) => entry.jobId === jobId)
        : state.resumeResearchArtifacts;
      return Promise.resolve(sortResearch(cloneValue(values)));
    },
    upsertResumeResearchArtifact(artifact) {
      const normalizedArtifact = ResumeResearchArtifactSchema.parse(
        cloneValue(artifact),
      );
      state.resumeResearchArtifacts = upsertById(
        state.resumeResearchArtifacts,
        normalizedArtifact,
      );
      return Promise.resolve();
    },
    listResumeImportRuns(options) {
      let values = state.resumeImportRuns;

      if (options?.sourceResumeId) {
        values = values.filter(
          (entry) => entry.sourceResumeId === options.sourceResumeId,
        );
      }

      if (options?.statuses && options.statuses.length > 0) {
        const allowedStatuses = new Set(options.statuses);
        values = values.filter((entry) => allowedStatuses.has(entry.status));
      }

      const sortedValues = sortImportRuns(cloneValue(values));
      return Promise.resolve(
        typeof options?.limit === "number"
          ? sortedValues.slice(0, Math.max(0, options.limit))
          : sortedValues,
      );
    },
    async getLatestResumeImportRun(sourceResumeId) {
      const values = await this.listResumeImportRuns({
        ...(sourceResumeId ? { sourceResumeId } : {}),
        limit: 1,
      });
      return values[0] ?? null;
    },
    upsertResumeImportRun(run) {
      const normalizedRun = ResumeImportRunSchema.parse(cloneValue(run));
      state.resumeImportRuns = upsertById(
        state.resumeImportRuns,
        normalizedRun,
      );
      return Promise.resolve();
    },
    listResumeImportDocumentBundles(options) {
      const values = state.resumeImportDocumentBundles.filter((entry) => {
        if (options?.runId && entry.runId !== options.runId) {
          return false;
        }

        if (
          options?.sourceResumeId &&
          entry.sourceResumeId !== options.sourceResumeId
        ) {
          return false;
        }

        return true;
      });

      return Promise.resolve(sortNewestFirst(cloneValue(values)));
    },
    listResumeImportFieldCandidates(options) {
      const values = state.resumeImportFieldCandidates.filter((entry) => {
        if (options?.runId && entry.runId !== options.runId) {
          return false;
        }

        if (options?.resolution && entry.resolution !== options.resolution) {
          return false;
        }

        if (options?.resolutions && options.resolutions.length > 0) {
          const allowedResolutions = new Set(options.resolutions);

          if (!allowedResolutions.has(entry.resolution)) {
            return false;
          }
        }

        return true;
      });

      return Promise.resolve(sortNewestFirst(cloneValue(values)));
    },
    replaceResumeImportRunArtifacts({ run, documentBundles, fieldCandidates }) {
      const normalizedRun = ResumeImportRunSchema.parse(cloneValue(run));
      const normalizedBundles = ResumeDocumentBundleSchema.array().parse(
        cloneValue([...documentBundles]),
      );
      const normalizedCandidates =
        ResumeImportFieldCandidateSchema.array().parse(
          cloneValue([...fieldCandidates]),
        );

      for (const bundle of normalizedBundles) {
        if (bundle.runId !== normalizedRun.id) {
          throw new Error(
            "Resume document bundle does not belong to the provided import run.",
          );
        }
      }

      for (const candidate of normalizedCandidates) {
        if (candidate.runId !== normalizedRun.id) {
          throw new Error(
            "Resume import candidate does not belong to the provided import run.",
          );
        }
      }

      state.resumeImportRuns = upsertById(
        state.resumeImportRuns,
        normalizedRun,
      );
      const nextArtifacts = replaceArtifactsForRun(
        state.resumeImportDocumentBundles,
        state.resumeImportFieldCandidates,
        normalizedRun.id,
        normalizedBundles,
        normalizedCandidates,
      );
      state.resumeImportDocumentBundles = nextArtifacts.bundles;
      state.resumeImportFieldCandidates = nextArtifacts.candidates;
      return Promise.resolve();
    },
    finalizeResumeImportRun({
      profile,
      searchPreferences,
      run,
      documentBundles,
      fieldCandidates,
      expectedProfileRevision,
    }) {
      const normalizedProfile = CandidateProfileSchema.parse(
        cloneValue(profile),
      );
      const normalizedSearchPreferences = JobSearchPreferencesSchema.parse(
        cloneValue(searchPreferences),
      );
      const normalizedRun = ResumeImportRunSchema.parse(cloneValue(run));
      const normalizedBundles = ResumeDocumentBundleSchema.array().parse(
        cloneValue([...documentBundles]),
      );
      const normalizedCandidates =
        ResumeImportFieldCandidateSchema.array().parse(
          cloneValue([...fieldCandidates]),
        );

      for (const bundle of normalizedBundles) {
        if (bundle.runId !== normalizedRun.id) {
          throw new Error(
            "Resume document bundle does not belong to the provided import run.",
          );
        }
      }

      for (const candidate of normalizedCandidates) {
        if (candidate.runId !== normalizedRun.id) {
          throw new Error(
            "Resume import candidate does not belong to the provided import run.",
          );
        }
      }

      if (
        expectedProfileRevision !== undefined &&
        expectedProfileRevision !== profileRevision
      ) {
        return Promise.resolve({
          status: "stale" as const,
          profile: cloneValue(state.profile),
          searchPreferences: cloneValue(state.searchPreferences),
          revision: profileRevision,
        });
      }

      state.profile = normalizedProfile;
      profileRevision += 1;
      state.searchPreferences = normalizedSearchPreferences;
      state.resumeImportRuns = upsertById(
        state.resumeImportRuns,
        normalizedRun,
      );
      const nextArtifacts = replaceArtifactsForRun(
        state.resumeImportDocumentBundles,
        state.resumeImportFieldCandidates,
        normalizedRun.id,
        normalizedBundles,
        normalizedCandidates,
      );
      state.resumeImportDocumentBundles = nextArtifacts.bundles;
      state.resumeImportFieldCandidates = nextArtifacts.candidates;
      return Promise.resolve({
        status: "applied" as const,
        profile: cloneValue(state.profile),
        searchPreferences: cloneValue(state.searchPreferences),
        revision: profileRevision,
      });
    },
    listResumeValidationResults(draftId) {
      const values = draftId
        ? state.resumeValidationResults.filter(
            (entry) => entry.draftId === draftId,
          )
        : state.resumeValidationResults;
      return Promise.resolve(sortValidationResults(cloneValue(values)));
    },
    listLatestResumeValidationResults(draftIds) {
      const wanted = new Set(draftIds);
      const latestByDraftId = new Map<string, ResumeValidationResult>();
      for (const result of state.resumeValidationResults) {
        if (!wanted.has(result.draftId)) continue;
        const latest = latestByDraftId.get(result.draftId);
        const dateDelta = latest
          ? Date.parse(result.validatedAt) - Date.parse(latest.validatedAt)
          : 0;
        if (
          !latest ||
          dateDelta > 0 ||
          (dateDelta === 0 && result.id.localeCompare(latest.id) < 0)
        ) {
          latestByDraftId.set(result.draftId, result);
        }
      }
      return Promise.resolve(
        sortValidationResults(cloneValue([...latestByDraftId.values()])),
      );
    },
    upsertResumeValidationResult(validationResult) {
      const normalizedValidation = ResumeValidationResultSchema.parse(
        cloneValue(validationResult),
      );
      state.resumeValidationResults = upsertById(
        state.resumeValidationResults,
        normalizedValidation,
      );
      return Promise.resolve();
    },
    listResumeAssistantMessages(jobId) {
      const values = jobId
        ? state.resumeAssistantMessages.filter((entry) => entry.jobId === jobId)
        : state.resumeAssistantMessages;
      return Promise.resolve(sortMessages(cloneValue(values)));
    },
    upsertResumeAssistantMessage(message) {
      const normalizedMessage = ResumeAssistantMessageSchema.parse(
        cloneValue(message),
      );
      state.resumeAssistantMessages = upsertById(
        state.resumeAssistantMessages,
        normalizedMessage,
      );
      return Promise.resolve();
    },
    listProfileCopilotMessages() {
      return Promise.resolve(
        sortMessages(cloneValue(state.profileCopilotMessages)),
      );
    },
    upsertProfileCopilotMessage(message) {
      const normalizedMessage = ProfileCopilotMessageSchema.parse(
        cloneValue(message),
      );
      state.profileCopilotMessages = upsertById(
        state.profileCopilotMessages,
        normalizedMessage,
      );
      return Promise.resolve();
    },
    listProfileRevisions() {
      return Promise.resolve(
        sortNewestFirst(cloneValue(state.profileRevisions)),
      );
    },
    upsertProfileRevision(revision) {
      const normalizedRevision = ProfileRevisionSchema.parse(
        cloneValue(revision),
      );
      state.profileRevisions = upsertById(
        state.profileRevisions,
        normalizedRevision,
      );
      return Promise.resolve();
    },
    listApplyRuns(options) {
      const values = state.applyRuns.filter((run) =>
        matchesOptionalStringFilters(run, [["id", options?.id]]),
      );

      return Promise.resolve(sortApplyRuns(cloneValue(values)));
    },
    upsertApplyRun(run) {
      const normalizedRun = ApplyRunSchema.parse(cloneValue(run));
      state.applyRuns = upsertById(state.applyRuns, normalizedRun);
      return Promise.resolve();
    },
    listApplyJobResults(options) {
      const values = state.applyJobResults.filter((result) =>
        matchesOptionalStringFilters(result, [
          ["id", options?.id],
          ["runId", options?.runId],
          ["jobId", options?.jobId],
          ["applicationRecordId", options?.applicationRecordId],
        ]),
      );

      return Promise.resolve(sortApplyJobResults(cloneValue(values)));
    },
    getPreparedApplicationForm(resultId) {
      return Promise.resolve(cloneValue(state.preparedApplicationForms?.find(form => form.id === resultId) ?? null));
    },
    upsertPreparedApplicationForm(form) {
      state.preparedApplicationForms = upsertById(state.preparedApplicationForms ?? [], PreparedApplicationFormSchema.parse(cloneValue(form)));
      return Promise.resolve();
    },
    deletePreparedApplicationForm(resultId) {
      state.preparedApplicationForms = (state.preparedApplicationForms ?? []).filter(form => form.id !== resultId);
      return Promise.resolve();
    },
    upsertApplyJobResult(result) {
      const normalizedResult = ApplyJobResultSchema.parse(cloneValue(result));
      const existingResults = state.applyJobResults.filter(
        (entry) =>
          entry.id === normalizedResult.id ||
          (entry.runId === normalizedResult.runId &&
            entry.jobId === normalizedResult.jobId),
      );
      const existingResult =
        existingResults.find(
          (entry) =>
            entry.runId === normalizedResult.runId &&
            entry.jobId === normalizedResult.jobId,
        ) ?? existingResults[0];
      const nextResult = ApplyJobResultSchema.parse({
        ...normalizedResult,
        id: existingResult?.id ?? normalizedResult.id,
      });
      for (const current of existingResults) {
        assertApplicationPreparationStartPreserved(current, nextResult);
      }

      state.applyJobResults = [
        ...state.applyJobResults.filter(
          (entry) =>
            entry.id !== nextResult.id &&
            (entry.runId !== normalizedResult.runId ||
              entry.jobId !== normalizedResult.jobId),
        ),
        nextResult,
      ];

      return Promise.resolve();
    },
    markApplicationPreparationStarted(input) {
      const current = state.applyJobResults.find(
        (entry) => entry.id === input.resultId,
      );
      if (!current) {
        return Promise.reject(new Error("Apply result does not exist."));
      }
      if (current.runId !== input.runId || current.jobId !== input.jobId) {
        return Promise.reject(
          new Error("Apply result lineage does not match."),
        );
      }
      if (current.applicationPreparationStartedAt) {
        return Promise.resolve({
          result: cloneValue(current),
          didStart: false,
        });
      }

      try {
        const result = ApplyJobResultSchema.parse({
          ...current,
          applicationPreparationStartedAt: input.startedAt,
          applicationPreparationStartedLocalDate: input.startedLocalDate,
        });
        state.applyJobResults = state.applyJobResults.map((entry) =>
          entry.id === result.id ? result : entry,
        );
        return Promise.resolve({ result: cloneValue(result), didStart: true });
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    compareAndSwapApplyJobResult(input) {
      const expected = ApplyJobResultSchema.parse(cloneValue(input.expected));
      const nextResult = ApplyJobResultSchema.parse(cloneValue(input.result));
      const current = state.applyJobResults.find(
        (entry) => entry.id === expected.id,
      );
      if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
        return Promise.resolve(false);
      }
      if (nextResult.id !== expected.id) {
        throw new Error("Apply result CAS cannot change the result identity.");
      }
      assertApplicationPreparationStartPreserved(expected, nextResult);

      state.applyJobResults = state.applyJobResults.map((entry) =>
        entry.id === expected.id ? nextResult : entry,
      );
      return Promise.resolve(true);
    },
    listApplySubmitApprovals(options) {
      const values = state.applySubmitApprovals.filter((approval) =>
        matchesOptionalStringFilters(approval, [
          ["id", options?.id],
          ["runId", options?.runId],
        ]),
      );

      return Promise.resolve(sortApplySubmitApprovals(cloneValue(values)));
    },
    upsertApplySubmitApproval(approval) {
      const normalizedApproval = ApplySubmitApprovalSchema.parse(
        cloneValue(approval),
      );
      state.applySubmitApprovals = upsertById(
        state.applySubmitApprovals,
        normalizedApproval,
      );
      return Promise.resolve();
    },
    listApplicationQuestionRecords(options) {
      const values = state.applicationQuestionRecords.filter((record) =>
        matchesOptionalStringFilters(record, [
          ["runId", options?.runId],
          ["jobId", options?.jobId],
          ["applicationRecordId", options?.applicationRecordId],
          ["resultId", options?.resultId],
        ]),
      );

      return Promise.resolve(
        sortApplicationQuestionRecords(cloneValue(values)),
      );
    },
    upsertApplicationQuestionRecord(record) {
      const normalizedRecord = ApplicationQuestionRecordSchema.parse(
        cloneValue(record),
      );
      state.applicationQuestionRecords = upsertById(
        state.applicationQuestionRecords,
        normalizedRecord,
      );
      return Promise.resolve();
    },
    listApplicationAnswerRecords(options) {
      const values = state.applicationAnswerRecords.filter((record) =>
        matchesOptionalStringFilters(record, [
          ["runId", options?.runId],
          ["jobId", options?.jobId],
          ["applicationRecordId", options?.applicationRecordId],
          ["resultId", options?.resultId],
          ["questionId", options?.questionId],
        ]),
      );

      return Promise.resolve(sortApplicationAnswerRecords(cloneValue(values)));
    },
    upsertApplicationAnswerRecord(record) {
      const normalizedRecord = ApplicationAnswerRecordSchema.parse(
        cloneValue(record),
      );
      state.applicationAnswerRecords = upsertById(
        state.applicationAnswerRecords,
        normalizedRecord,
      );
      return Promise.resolve();
    },
    commitApplicationAnswerMutation(input) {
      const expectedAnswer = input.expectedAnswer
        ? ApplicationAnswerRecordSchema.parse(cloneValue(input.expectedAnswer))
        : null;
      const expectedQuestion = ApplicationQuestionRecordSchema.parse(
        cloneValue(input.expectedQuestion),
      );
      const nextAnswer = ApplicationAnswerRecordSchema.parse(
        cloneValue(input.answer),
      );
      const nextQuestion = ApplicationQuestionRecordSchema.parse(
        cloneValue(input.question),
      );

      if (
        expectedQuestion.id !== nextQuestion.id ||
        expectedQuestion.id !== nextAnswer.questionId
      ) {
        throw new Error(
          "Application answer mutation records must target the same question.",
        );
      }
      if (nextAnswer.revision !== (expectedAnswer?.revision ?? 0) + 1) {
        throw new Error(
          "Application answer mutation must advance the answer revision by one.",
        );
      }

      if (
        state.applicationAnswerRecords.some(
          (record) => record.id === nextAnswer.id,
        )
      ) {
        return Promise.resolve("duplicate" as const);
      }

      const currentAnswer = latestApplicationAnswerRecord(
        state.applicationAnswerRecords,
        expectedQuestion.id,
      );
      const currentQuestion = state.applicationQuestionRecords.find(
        (record) => record.id === expectedQuestion.id,
      );
      if (
        currentQuestion === undefined ||
        !areSameApplicationQuestionRecords(currentQuestion, expectedQuestion) ||
        (expectedAnswer === null
          ? currentAnswer !== null
          : currentAnswer === null ||
            !areSameApplicationAnswerRecords(currentAnswer, expectedAnswer))
      ) {
        return Promise.resolve("stale" as const);
      }

      state.applicationAnswerRecords = upsertById(
        state.applicationAnswerRecords,
        nextAnswer,
      );
      state.applicationQuestionRecords = upsertById(
        state.applicationQuestionRecords,
        nextQuestion,
      );
      return Promise.resolve("applied" as const);
    },
    listApplicationArtifactRefs(options) {
      const values = state.applicationArtifactRefs.filter((ref) =>
        matchesOptionalStringFilters(ref, [
          ["runId", options?.runId],
          ["jobId", options?.jobId],
          ["applicationRecordId", options?.applicationRecordId],
          ["resultId", options?.resultId],
        ]),
      );

      return Promise.resolve(sortApplicationArtifactRefs(cloneValue(values)));
    },
    upsertApplicationArtifactRef(ref) {
      const normalizedRef = ApplicationArtifactRefSchema.parse(cloneValue(ref));
      state.applicationArtifactRefs = upsertById(
        state.applicationArtifactRefs,
        normalizedRef,
      );
      return Promise.resolve();
    },
    listApplicationReplayCheckpoints(options) {
      const values = state.applicationReplayCheckpoints.filter((checkpoint) =>
        matchesOptionalStringFilters(checkpoint, [
          ["runId", options?.runId],
          ["jobId", options?.jobId],
          ["applicationRecordId", options?.applicationRecordId],
          ["resultId", options?.resultId],
        ]),
      );

      return Promise.resolve(
        sortApplicationReplayCheckpoints(cloneValue(values)),
      );
    },
    upsertApplicationReplayCheckpoint(checkpoint) {
      const normalizedCheckpoint = ApplicationReplayCheckpointSchema.parse(
        cloneValue(checkpoint),
      );
      state.applicationReplayCheckpoints = upsertById(
        state.applicationReplayCheckpoints,
        normalizedCheckpoint,
      );
      return Promise.resolve();
    },
    listApplicationConsentRequests(options) {
      const values = state.applicationConsentRequests.filter((request) =>
        matchesOptionalStringFilters(request, [
          ["runId", options?.runId],
          ["jobId", options?.jobId],
          ["applicationRecordId", options?.applicationRecordId],
          ["resultId", options?.resultId],
        ]),
      );

      return Promise.resolve(
        sortApplicationConsentRequests(cloneValue(values)),
      );
    },
    upsertApplicationConsentRequest(request) {
      const normalizedRequest = ApplicationConsentRequestSchema.parse(
        cloneValue(request),
      );
      state.applicationConsentRequests = upsertById(
        state.applicationConsentRequests,
        normalizedRequest,
      );
      return Promise.resolve();
    },
    listUserActionRequests(query) {
      const requests = state.userActionRequests.filter((request) =>
        matchesUserActionRequestQuery(request, query),
      );
      return Promise.resolve(sortUserActionRequests(cloneValue(requests)));
    },
    getUserActionRequest(id) {
      const request = state.userActionRequests.find((entry) => entry.id === id);
      return Promise.resolve(request ? cloneValue(request) : null);
    },
    saveUserActionAnswerDraft(input) {
      const command = SaveUserActionAnswerDraftInputSchema.parse(input);
      const request = state.userActionRequests.find(
        (entry) => entry.id === command.requestId,
      );
      if (
        !request ||
        request.kind !== "manual_answer" ||
        request.scope.type !== "application" ||
        request.revision !== command.expectedRevision ||
        !(
          command.draft === null
            ? [
                "pending",
                "awaiting_user",
                "still_blocked",
                "verifying",
                "resolved",
              ]
            : ["pending", "awaiting_user", "still_blocked"]
        ).includes(request.state)
      ) {
        throw new Error(
          "This question has changed. Reopen it before editing your answer.",
        );
      }
      Object.assign(
        request,
        cloneValue(
          mergeUserActionAnswerDraft(
            request,
            command.draft,
            command.editedAt ?? Date.now(),
          ),
        ),
      );
      return Promise.resolve();
    },
    createUserActionRequest(request) {
      const normalizedRequest = UserActionRequestSchema.parse(
        cloneValue(request),
      );
      const existingById = state.userActionRequests.find(
        (entry) => entry.id === normalizedRequest.id,
      );
      const existingByDedupeKey = state.userActionRequests.find(
        (entry) => entry.dedupeKey === normalizedRequest.dedupeKey,
      );

      if (
        existingById &&
        !areSameUserActionRequests(existingById, normalizedRequest)
      ) {
        throw new Error(
          `User action request id '${normalizedRequest.id}' already exists with different data.`,
        );
      }

      const existing = existingById ?? existingByDedupeKey;
      if (existing) {
        let createdEvent = state.userActionEvents.find(
          (event) =>
            event.requestId === existing.id && event.operation === "created",
        );
        if (!createdEvent) {
          createdEvent = createPersistedUserActionCreatedEvent(existing);
          state.userActionEvents = [...state.userActionEvents, createdEvent];
        }
        return Promise.resolve(
          cloneValue({
            status: "existing" as const,
            request: existing,
            event: createdEvent,
          }),
        );
      }

      const createdEvent =
        createPersistedUserActionCreatedEvent(normalizedRequest);
      const eventCollision = state.userActionEvents.find(
        (event) => event.id === createdEvent.id,
      );
      if (
        eventCollision &&
        !areSameUserActionEvents(eventCollision, createdEvent)
      ) {
        throw new Error(
          `User action event id '${createdEvent.id}' already exists with different data.`,
        );
      }

      state.userActionRequests = [
        ...state.userActionRequests,
        normalizedRequest,
      ];
      state.userActionEvents = eventCollision
        ? state.userActionEvents
        : [...state.userActionEvents, createdEvent];

      return Promise.resolve(
        cloneValue({
          status: "created" as const,
          request: normalizedRequest,
          event: createdEvent,
        }),
      );
    },
    listUserActionEvents(query) {
      const events = state.userActionEvents.filter((event) =>
        matchesUserActionEventQuery(event, query),
      );
      return Promise.resolve(sortUserActionEvents(cloneValue(events)));
    },
    commitUserActionTransition(input) {
      const transition = normalizeUserActionTransition(input);
      const existingEvent = state.userActionEvents.find(
        (event) => event.id === transition.event.id,
      );

      if (existingEvent) {
        if (!areSameUserActionEvents(existingEvent, transition.event)) {
          throw new Error(
            `User action event id '${transition.event.id}' already exists with different data.`,
          );
        }
        const currentRequest = state.userActionRequests.find(
          (request) => request.id === transition.request.id,
        );
        if (!currentRequest) {
          throw new Error(
            `User action request '${transition.request.id}' does not exist.`,
          );
        }
        return Promise.resolve(
          cloneValue({
            status: "duplicate" as const,
            request: currentRequest,
            event: existingEvent,
          }),
        );
      }

      const currentRequest = state.userActionRequests.find(
        (request) => request.id === transition.request.id,
      );
      if (!currentRequest) {
        throw new Error(
          `User action request '${transition.request.id}' does not exist.`,
        );
      }
      if (currentRequest.revision !== transition.event.previousRevision) {
        return Promise.resolve(
          cloneValue({
            status: "stale" as const,
            request: currentRequest,
            event: null,
          }),
        );
      }

      assertUserActionTransitionCurrent(
        currentRequest,
        transition.request,
        transition.event,
      );
      // Lifecycle transitions cannot replace edits saved while the command waited.
      transition.request.answerDraft = currentRequest.answerDraft;
      transition.request.answerDraftFieldUpdatedAt =
        currentRequest.answerDraftFieldUpdatedAt;
      state.userActionRequests = [
        ...state.userActionRequests.filter(
          (request) => request.id !== transition.request.id,
        ),
        transition.request,
      ];
      state.userActionEvents = [
        ...state.userActionEvents,
        UserActionEventSchema.parse(cloneValue(transition.event)),
      ];

      return Promise.resolve(
        cloneValue({
          status: "applied" as const,
          request: transition.request,
          event: transition.event,
        }),
      );
    },
    commitGroupedManualAnswer(input: CommitGroupedManualAnswerInput) {
      const plan = normalizeGroupedManualAnswerCommit(input);

      const requests = new Map<string, UserActionRequest>();
      for (const entry of plan.lineage) {
        const request = state.userActionRequests.find(
          (candidate) => candidate.id === entry.requestId,
        );
        if (request) {
          requests.set(entry.requestId, request);
        }
      }

      const answersByQuestionId = new Map<
        string,
        ApplicationAnswerRecord | null
      >();
      const questionIds = [...plan.expectedAnswerRevisionByQuestionId.keys()];
      for (const questionId of questionIds) {
        answersByQuestionId.set(
          questionId,
          latestApplicationAnswerRecord(
            state.applicationAnswerRecords,
            questionId,
          ),
        );
      }

      const questions = new Map<string, ApplicationQuestionRecord>();
      for (const change of plan.questionChanges) {
        const question = state.applicationQuestionRecords.find(
          (candidate) => candidate.id === change.next.id,
        );
        if (question) {
          questions.set(change.next.id, question);
        }
      }

      const decision =
        state.intelligence.groupedDecisions.find(
          (candidate) => candidate.id === plan.decision.id,
        ) ?? null;

      const snapshot: GroupedManualAnswerCurrentSnapshot = {
        requests,
        answersByQuestionId,
        questions,
        decision,
        events: state.userActionEvents,
      };
      const outcome = resolveGroupedManualAnswerCommit(plan, snapshot);
      if (outcome.status === "stale") {
        return Promise.resolve(cloneValue(outcome));
      }
      if (outcome.status === "duplicate") {
        return Promise.resolve(cloneValue(outcome));
      }

      const nextRequests = plan.lineage.reduce((currentRequests, entry) => {
        const next = plan.requestsByRequestId.get(entry.requestId)!;
        return currentRequests.map((request) =>
          request.id === next.id ? next : request,
        );
      }, state.userActionRequests);
      const nextEvents = [
        ...state.userActionEvents,
        ...outcome.events.map((event) =>
          UserActionEventSchema.parse(cloneValue(event)),
        ),
      ];
      let nextAnswers = state.applicationAnswerRecords;
      for (const change of plan.answerChanges) {
        nextAnswers = upsertById(nextAnswers, change.next);
      }
      let nextQuestions = state.applicationQuestionRecords;
      for (const change of plan.questionChanges) {
        nextQuestions = upsertById(nextQuestions, change.next);
      }
      const nextIntelligence = JobFinderIntelligenceStateSchema.parse({
        ...state.intelligence,
        groupedDecisions: state.intelligence.groupedDecisions.map(
          (candidate) =>
            candidate.id === plan.decision.id ? plan.decision : candidate,
        ),
        updatedAt: plan.appliedAt,
      });

      // Build and validate the complete next state before swapping any member,
      // preserving the same all-or-nothing behavior as the SQLite transaction.
      state.userActionRequests = nextRequests;
      state.userActionEvents = nextEvents;
      state.applicationAnswerRecords = nextAnswers;
      state.applicationQuestionRecords = nextQuestions;
      state.intelligence = nextIntelligence;

      return Promise.resolve(
        cloneValue({
          status: "applied" as const,
          decision: plan.decision,
          lineage: plan.lineage,
          requests: plan.lineage.map(
            (entry) => plan.requestsByRequestId.get(entry.requestId)!,
          ),
        }),
      );
    },
    saveResumeDraftWithValidation({ draft, validation, tailoredAsset }) {
      const parsedDraft = ResumeDraftSchema.parse(
        cloneValue(
          draft.approvedExportId
            ? draft
            : { ...draft, approvedAt: null, approvedExportId: null },
        ),
      );
      const normalizedValidation = ResumeValidationResultSchema.parse(
        cloneValue(validation),
      );
      const normalizedDraft = {
        ...parsedDraft,
        approvedExportId: resolveApprovedExportId(
          state.resumeExportArtifacts,
          parsedDraft,
        ),
      };
      if (!normalizedDraft.approvedExportId) {
        normalizedDraft.approvedAt = null;
      }

      if (normalizedValidation.draftId !== normalizedDraft.id) {
        throw new Error(
          "Resume validation result does not belong to the provided draft.",
        );
      }

      const nextResumeDrafts = upsertById(state.resumeDrafts, normalizedDraft);
      const nextResumeExportArtifacts = clearApprovedResumeExportsForJob(
        state.resumeExportArtifacts,
        normalizedDraft.jobId,
      ).map((artifact) =>
        artifact.jobId === normalizedDraft.jobId &&
        artifact.id === normalizedDraft.approvedExportId
          ? { ...artifact, isApproved: true }
          : artifact,
      );
      const nextResumeValidationResults = upsertById(
        state.resumeValidationResults,
        normalizedValidation,
      );
      const nextTailoredAssets = tailoredAsset
        ? (() => {
            const normalizedAsset = TailoredAssetSchema.parse(
              cloneValue(tailoredAsset),
            );
            if (normalizedAsset.jobId !== normalizedDraft.jobId) {
              throw new Error(
                "Tailored asset job does not match the provided draft.",
              );
            }
            return upsertById(state.tailoredAssets, normalizedAsset);
          })()
        : state.tailoredAssets;

      state.resumeDrafts = nextResumeDrafts;
      state.resumeExportArtifacts = nextResumeExportArtifacts;
      state.resumeValidationResults = nextResumeValidationResults;
      state.tailoredAssets = nextTailoredAssets;
      return Promise.resolve();
    },
    applyResumePatchWithRevision({
      expectedDraftUpdatedAt,
      draft,
      revision,
      validation,
      tailoredAsset,
    }) {
      const parsedDraft = ResumeDraftSchema.parse(
        cloneValue(
          draft.approvedExportId
            ? draft
            : { ...draft, approvedAt: null, approvedExportId: null },
        ),
      );
      const normalizedRevision = ResumeDraftRevisionSchema.parse(
        cloneValue(revision),
      );
      const normalizedValidation = ResumeValidationResultSchema.parse(
        cloneValue(validation),
      );
      const normalizedDraft = {
        ...parsedDraft,
        approvedExportId: resolveApprovedExportId(
          state.resumeExportArtifacts,
          parsedDraft,
        ),
      };
      if (!normalizedDraft.approvedExportId) {
        normalizedDraft.approvedAt = null;
      }

      const persistedDraft = state.resumeDrafts.find(
        (entry) => entry.id === normalizedDraft.id,
      );
      if (
        !persistedDraft ||
        persistedDraft.updatedAt !== expectedDraftUpdatedAt
      ) {
        throw new Error(
          "Resume draft changed before this edit could be saved. Reload the workspace and try again.",
        );
      }

      if (normalizedRevision.draftId !== normalizedDraft.id) {
        throw new Error(
          "Resume revision does not belong to the provided draft.",
        );
      }

      if (normalizedValidation.draftId !== normalizedDraft.id) {
        throw new Error(
          "Resume validation result does not belong to the provided draft.",
        );
      }

      const nextResumeDrafts = upsertById(state.resumeDrafts, normalizedDraft);
      const nextResumeExportArtifacts = clearApprovedResumeExportsForJob(
        state.resumeExportArtifacts,
        normalizedDraft.jobId,
      ).map((artifact) =>
        artifact.jobId === normalizedDraft.jobId &&
        artifact.id === normalizedDraft.approvedExportId
          ? { ...artifact, isApproved: true }
          : artifact,
      );
      const nextResumeDraftRevisions = retainResumeDraftRevisions(
        upsertById(state.resumeDraftRevisions, normalizedRevision),
        normalizedRevision.draftId,
      );
      const nextResumeValidationResults = upsertById(
        state.resumeValidationResults,
        normalizedValidation,
      );
      const nextTailoredAssets = tailoredAsset
        ? (() => {
            const normalizedAsset = TailoredAssetSchema.parse(
              cloneValue(tailoredAsset),
            );
            if (normalizedAsset.jobId !== normalizedDraft.jobId) {
              throw new Error(
                "Tailored asset job does not match the provided draft.",
              );
            }
            return upsertById(state.tailoredAssets, normalizedAsset);
          })()
        : state.tailoredAssets;

      state.resumeDrafts = nextResumeDrafts;
      state.resumeExportArtifacts = nextResumeExportArtifacts;
      state.resumeDraftRevisions = nextResumeDraftRevisions;
      state.resumeValidationResults = nextResumeValidationResults;
      state.tailoredAssets = nextTailoredAssets;
      return Promise.resolve();
    },
    approveResumeExport({ draft, exportArtifact, validation, tailoredAsset }) {
      const approvedAt = draft.approvedAt ?? new Date().toISOString();
      const normalizedDraft = ResumeDraftSchema.parse(
        cloneValue({
          ...draft,
          approvedAt,
          approvedExportId: exportArtifact.id,
        }),
      );
      const normalizedArtifact = ResumeExportArtifactSchema.parse(
        cloneValue({ ...exportArtifact, isApproved: true }),
      );

      if (normalizedArtifact.draftId !== normalizedDraft.id) {
        throw new Error(
          "Approved export does not belong to the provided resume draft.",
        );
      }

      if (normalizedArtifact.jobId !== normalizedDraft.jobId) {
        throw new Error(
          "Approved export job does not match the provided resume draft.",
        );
      }

      const normalizedValidation = validation
        ? ResumeValidationResultSchema.parse(cloneValue(validation))
        : null;
      if (
        normalizedValidation &&
        normalizedValidation.draftId !== normalizedDraft.id
      ) {
        throw new Error(
          "Resume validation result does not belong to the provided draft.",
        );
      }
      const normalizedAsset = tailoredAsset
        ? TailoredAssetSchema.parse(cloneValue(tailoredAsset))
        : null;
      if (normalizedAsset && normalizedAsset.jobId !== normalizedDraft.jobId) {
        throw new Error(
          "Tailored asset job does not match the provided draft.",
        );
      }

      const nextResumeDrafts = upsertById(state.resumeDrafts, normalizedDraft);
      const nextResumeExportArtifacts = upsertById(
        state.resumeExportArtifacts,
        normalizedArtifact,
      ).map((entry) =>
        entry.jobId === normalizedArtifact.jobId &&
        entry.id !== normalizedArtifact.id
          ? { ...entry, isApproved: false }
          : entry,
      );
      const nextResumeValidationResults = normalizedValidation
        ? upsertById(state.resumeValidationResults, normalizedValidation)
        : state.resumeValidationResults;
      const nextTailoredAssets = normalizedAsset
        ? upsertById(state.tailoredAssets, normalizedAsset)
        : state.tailoredAssets;

      state.resumeDrafts = nextResumeDrafts;
      state.resumeExportArtifacts = nextResumeExportArtifacts;
      state.resumeValidationResults = nextResumeValidationResults;
      state.tailoredAssets = nextTailoredAssets;
      return Promise.resolve();
    },
    clearResumeApproval({ draft, staleReason, tailoredAsset }) {
      const normalizedDraft = ResumeDraftSchema.parse(
        cloneValue({
          ...draft,
          staleReason,
          approvedAt: null,
          approvedExportId: null,
        }),
      );
      const normalizedAsset = tailoredAsset
        ? TailoredAssetSchema.parse(cloneValue(tailoredAsset))
        : null;
      if (normalizedAsset && normalizedAsset.jobId !== normalizedDraft.jobId) {
        throw new Error(
          "Tailored asset job does not match the provided draft.",
        );
      }

      const nextResumeDrafts = upsertById(state.resumeDrafts, normalizedDraft);
      const nextResumeExportArtifacts = clearApprovedResumeExportsForJob(
        state.resumeExportArtifacts,
        normalizedDraft.jobId,
      );
      const nextTailoredAssets = normalizedAsset
        ? upsertById(state.tailoredAssets, normalizedAsset)
        : state.tailoredAssets;

      state.resumeDrafts = nextResumeDrafts;
      state.resumeExportArtifacts = nextResumeExportArtifacts;
      state.tailoredAssets = nextTailoredAssets;
      return Promise.resolve();
    },
    staleResumeDrafts({ draftIds, staleReason, updatedAt }) {
      for (const draftId of new Set(draftIds)) {
        const draft = state.resumeDrafts.find((entry) => entry.id === draftId);
        if (!draft) continue;
        state.resumeExportArtifacts = clearApprovedResumeExportsForJob(
          state.resumeExportArtifacts,
          draft.jobId,
        );
        state.resumeDrafts = upsertById(state.resumeDrafts, {
          ...draft,
          status: "stale",
          staleReason,
          approvedAt: null,
          approvedExportId: null,
          updatedAt,
        });
        const asset = state.tailoredAssets.find(
          (entry) => entry.jobId === draft.jobId,
        );
        if (asset) {
          state.tailoredAssets = upsertById(state.tailoredAssets, {
            ...asset,
            storagePath: null,
            updatedAt,
          });
        }
      }
      return Promise.resolve();
    },
    listApplicationRecords() {
      return Promise.resolve(cloneValue(state.applicationRecords));
    },
    upsertApplicationRecord(applicationRecord) {
      const normalizedRecord = ApplicationRecordSchema.parse(
        cloneValue(applicationRecord),
      );
      state.applicationRecords = upsertById(
        state.applicationRecords,
        normalizedRecord,
      );
      return Promise.resolve();
    },
    commitApplicationRecordBatch({ expectedRevisions, records }) {
      const normalizedRecords = ApplicationRecordSchema.array().parse(
        cloneValue([...records]),
      );
      const expectedIds = expectedRevisions.map(
        ({ applicationRecordId }) => applicationRecordId,
      );
      const expectedIdSet = new Set(expectedIds);
      const nextIdSet = new Set(normalizedRecords.map((record) => record.id));
      if (
        expectedIdSet.size !== expectedIds.length ||
        nextIdSet.size !== normalizedRecords.length ||
        normalizedRecords.some((record) => !expectedIdSet.has(record.id))
      ) {
        throw new Error(
          "Application record batch changes must be unique selected records.",
        );
      }

      const currentById = new Map(
        state.applicationRecords.map((record) => [record.id, record]),
      );
      const missingRecordIds = expectedIds.filter((id) => !currentById.has(id));
      if (missingRecordIds.length > 0) {
        return Promise.resolve({
          status: "missing" as const,
          recordIds: missingRecordIds,
        });
      }

      const staleRecordIds = expectedRevisions
        .filter(
          ({ applicationRecordId, expectedRevision }) =>
            (currentById.get(applicationRecordId)?.crm?.revision ?? 0) !==
            expectedRevision,
        )
        .map(({ applicationRecordId }) => applicationRecordId);
      if (staleRecordIds.length > 0) {
        return Promise.resolve({
          status: "stale" as const,
          recordIds: staleRecordIds,
        });
      }

      const committedRecords = normalizedRecords.map((proposedRecord) =>
        ApplicationRecordSchema.parse({
          ...currentById.get(proposedRecord.id)!,
          crm: proposedRecord.crm,
          // A bulk stage change is tracker activity: the row's Updated date
          // and last action move with it, like a single change, unless
          // another writer touched the row more recently.
          ...(proposedRecord.lastUpdatedAt >
          currentById.get(proposedRecord.id)!.lastUpdatedAt
            ? {
                lastUpdatedAt: proposedRecord.lastUpdatedAt,
                lastActionLabel: proposedRecord.lastActionLabel,
              }
            : {}),
        }),
      );
      const committedById = new Map(
        committedRecords.map((record) => [record.id, record]),
      );
      state.applicationRecords = state.applicationRecords.map(
        (record) => committedById.get(record.id) ?? record,
      );
      return Promise.resolve({
        status: "applied" as const,
        committedRecords: cloneValue(committedRecords),
      });
    },
    listApplicationAttempts(options) {
      return Promise.resolve(
        cloneValue(
          state.applicationAttempts.filter((attempt) =>
            matchesOptionalStringFilters(attempt, [
              ["jobId", options?.jobId],
              ["applicationRecordId", options?.applicationRecordId],
            ]),
          ),
        ),
      );
    },
    upsertApplicationAttempt(applicationAttempt) {
      const normalizedAttempt = ApplicationAttemptSchema.parse(
        cloneValue(applicationAttempt),
      );
      state.applicationAttempts = upsertById(
        state.applicationAttempts,
        normalizedAttempt,
      );
      return Promise.resolve();
    },
    claimApplicationAttempt(applicationAttempt) {
      const normalizedAttempt = ApplicationAttemptSchema.parse(
        cloneValue(applicationAttempt),
      );
      if (
        state.applicationAttempts.some(
          (attempt) => attempt.id === normalizedAttempt.id,
        )
      ) {
        return Promise.resolve(false);
      }
      state.applicationAttempts = [
        ...state.applicationAttempts,
        normalizedAttempt,
      ];
      return Promise.resolve(true);
    },
    listSourceDebugRuns() {
      return Promise.resolve(cloneValue(state.sourceDebugRuns));
    },
    upsertSourceDebugRun(run) {
      const normalizedRun = SourceDebugRunRecordSchema.parse(cloneValue(run));
      state.sourceDebugRuns = upsertById(state.sourceDebugRuns, normalizedRun);
      return Promise.resolve();
    },
    listSourceDebugAttempts() {
      return Promise.resolve(cloneValue(state.sourceDebugAttempts));
    },
    upsertSourceDebugAttempt(attempt) {
      const normalizedAttempt = SourceDebugWorkerAttemptSchema.parse(
        cloneValue(attempt),
      );
      state.sourceDebugAttempts = upsertById(
        state.sourceDebugAttempts,
        normalizedAttempt,
      );
      return Promise.resolve();
    },
    listSourceInstructionArtifacts() {
      return Promise.resolve(cloneValue(state.sourceInstructionArtifacts));
    },
    upsertSourceInstructionArtifact(artifact) {
      const normalizedArtifact = SourceInstructionArtifactSchema.parse(
        cloneValue(artifact),
      );
      state.sourceInstructionArtifacts = upsertById(
        state.sourceInstructionArtifacts,
        normalizedArtifact,
      );
      return Promise.resolve();
    },
    deleteSourceInstructionArtifactsForTarget(targetId) {
      state.sourceInstructionArtifacts =
        state.sourceInstructionArtifacts.filter(
          (artifact) => artifact.targetId !== targetId,
        );
      return Promise.resolve();
    },
    listSourceDebugEvidenceRefs() {
      return Promise.resolve(cloneValue(state.sourceDebugEvidenceRefs));
    },
    upsertSourceDebugEvidenceRef(evidenceRef) {
      const normalizedEvidenceRef = SourceDebugEvidenceRefSchema.parse(
        cloneValue(evidenceRef),
      );
      state.sourceDebugEvidenceRefs = upsertById(
        state.sourceDebugEvidenceRefs,
        normalizedEvidenceRef,
      );
      return Promise.resolve();
    },
    upsertSourceDebugEvidenceRefs(evidenceRefs) {
      const normalizedEvidenceRefs = SourceDebugEvidenceRefSchema.array().parse(
        cloneValue([...evidenceRefs]),
      );

      for (const normalizedEvidenceRef of normalizedEvidenceRefs) {
        state.sourceDebugEvidenceRefs = upsertById(
          state.sourceDebugEvidenceRefs,
          normalizedEvidenceRef,
        );
      }

      return Promise.resolve();
    },
    getSettings() {
      return Promise.resolve(cloneValue(state.settings));
    },
    saveSettings(settings) {
      state.settings = JobFinderSettingsSchema.parse(cloneValue(settings));
      return Promise.resolve();
    },
    commitSettingsUpdate(update) {
      try {
        const nextSettings = JobFinderSettingsSchema.parse(
          cloneValue(update(cloneValue(state.settings))),
        );
        state.settings = nextSettings;
        return Promise.resolve(cloneValue(nextSettings));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    readDiscoveryDisplayProjection() {
      if (
        discoveryProjectionSource !== state.discovery ||
        !discoveryProjection
      ) {
        discoveryProjection = toDiscoveryDisplayProjection(state.discovery);
        discoveryProjectionSource = state.discovery;
      }
      return Promise.resolve(discoveryProjection);
    },
    getDiscoveryState() {
      return Promise.resolve(cloneValue(state.discovery));
    },
    commitDiscoveryStateUpdate(update) {
      try {
        const nextDiscoveryState = JobFinderDiscoveryStateSchema.parse(
          cloneValue(update(freezeProjection(cloneValue(state.discovery)))),
        );
        state.discovery = nextDiscoveryState;
        return Promise.resolve(cloneValue(nextDiscoveryState));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    getCampaignState() {
      if (state.campaigns.length === 0 || !state.activeCampaignId) {
        return Promise.resolve(null);
      }
      return Promise.resolve(
        cloneValue(
          JobSearchCampaignCollectionSchema.parse({
            campaigns: state.campaigns,
            activeCampaignId: state.activeCampaignId,
            notifications: state.campaignNotifications,
          }),
        ),
      );
    },
    saveCampaignState(campaignState) {
      const normalized = JobSearchCampaignCollectionSchema.parse(
        cloneValue(campaignState),
      );
      state.campaigns = normalized.campaigns;
      state.activeCampaignId = normalized.activeCampaignId;
      state.campaignNotifications = normalized.notifications;
      return Promise.resolve();
    },
    commitCampaignPreferencesUpdate(update) {
      try {
        const campaignState =
          state.campaigns.length === 0 || !state.activeCampaignId
            ? null
            : JobSearchCampaignCollectionSchema.parse({
                campaigns: state.campaigns,
                activeCampaignId: state.activeCampaignId,
                notifications: state.campaignNotifications,
              });
        const next = update({
          campaignState: cloneValue(campaignState),
          searchPreferences: cloneValue(state.searchPreferences),
          intelligenceState: cloneValue(state.intelligence),
        });
        const nextCampaignState = JobSearchCampaignCollectionSchema.parse(
          cloneValue(next.campaignState),
        );
        const nextSearchPreferences = JobSearchPreferencesSchema.parse(
          cloneValue(next.searchPreferences),
        );
        const nextIntelligenceState =
          next.intelligenceState === undefined
            ? null
            : JobFinderIntelligenceStateSchema.parse(
                cloneValue(next.intelligenceState),
              );
        state.campaigns = nextCampaignState.campaigns;
        state.activeCampaignId = nextCampaignState.activeCampaignId;
        state.campaignNotifications = nextCampaignState.notifications;
        // A changed preference advances the shared profile epoch so a
        // copilot commit that captured the older preferences fails closed as
        // stale instead of reverting this campaign preference change. A
        // campaign-only edit leaves preferences untouched and must not
        // invalidate unrelated in-flight profile work.
        if (
          JSON.stringify(nextSearchPreferences) !==
          JSON.stringify(state.searchPreferences)
        ) {
          profileRevision += 1;
        }
        state.searchPreferences = nextSearchPreferences;
        if (nextIntelligenceState) state.intelligence = nextIntelligenceState;
        return Promise.resolve(next.result);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    readIntelligenceProjection() {
      if (
        intelligenceProjectionSource !== state.intelligence ||
        !intelligenceProjection
      ) {
        intelligenceProjection = freezeProjection(
          cloneValue(state.intelligence),
        );
        intelligenceProjectionSource = state.intelligence;
      }
      return Promise.resolve(intelligenceProjection);
    },
    getIntelligenceState() {
      return Promise.resolve(cloneValue(state.intelligence));
    },
    saveIntelligenceState(intelligenceState) {
      state.intelligence = JobFinderIntelligenceStateSchema.parse(
        cloneValue(intelligenceState),
      );
      return Promise.resolve();
    },
    commitCompanyIntelligenceUpdate(expected, update) {
      try {
        const savedJob =
          expected.jobId === null
            ? null
            : (state.savedJobs.find((job) => job.id === expected.jobId) ??
              null);
        const applicationRecord =
          expected.applicationRecordId === null
            ? null
            : (state.applicationRecords.find(
                (record) => record.id === expected.applicationRecordId,
              ) ?? null);
        const nextState = JobFinderIntelligenceStateSchema.parse(
          cloneValue(
            update({
              intelligenceState: cloneValue(state.intelligence),
              savedJob: cloneValue(savedJob),
              applicationRecord: cloneValue(applicationRecord),
            }),
          ),
        );
        state.intelligence = nextState;
        return Promise.resolve(cloneValue(nextState));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    getActivityControl() {
      return Promise.resolve(cloneValue(state.activityControl));
    },
    saveActivityControl(activityControl) {
      state.activityControl = JobFinderActivityControlSchema.parse(
        cloneValue(activityControl),
      );
      return Promise.resolve();
    },
  };
}
