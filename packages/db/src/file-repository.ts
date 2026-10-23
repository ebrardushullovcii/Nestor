import {
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
  ApplicationAuthorityEnvelopeSchema,
  ApprovedApplicationAnswerSnapshotSchema,
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
  ResumeDraftSchema,
  SavedJobSchema,
  SourceDebugEvidenceRefSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionPreflightRecordSchema,
  TailoredAssetSchema,
  type CandidateProfile,
  type JobFinderDiscoveryState,
  type JobFinderRepositoryState,
} from "@nestor/contracts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createFileRepositoryResumeMethods } from "./file-repository-resume-methods";
import { createFileRepositoryUserActionMethods } from "./file-repository-user-action-methods";
import { createFileRepositoryGroupedManualAnswerMethods } from "./file-repository-grouped-manual-answer-methods";
import { createApplicationAnswerSnapshotRepositoryMethods } from "./application-answer-snapshot-repository";
import { createApplicationAuthorityRepositoryMethods } from "./application-authority-repository";
import {
  APPLY_COLLECTION_ORDER_BY_SQL,
  APPLY_INDEXED_COLLECTION_CONFIGS,
  APPLICATION_ATTEMPT_INDEXED_COLLECTION_CONFIG,
  assertApplicationPreparationStartPreserved,
  buildOptionalSqlFilters,
} from "./apply-collection-support";
import {
  createFileRepositoryContext,
  INDEXED_COLLECTION_CONFIGS,
  runImmediateTransaction,
  scheduleWalCheckpoints,
  syncApprovedResumeExportsForJob,
} from "./file-repository-support";
import {
  areSameApplicationAnswerRecords,
  areSameApplicationQuestionRecords,
  latestApplicationAnswerRecord,
} from "./grouped-manual-answer-support";
import {
  openDatabaseFile,
  repairLegacyCommaSplitAchievements,
  secureDatabaseFile,
  runMigrations,
} from "./internal/migrations";
import {
  consumeCleanCloseMarker,
  writeCleanCloseMarker,
} from "./internal/clean-close-marker";
import {
  createWorkspaceCloseDatabaseBackup,
  createWorkspaceResetDatabaseBackup,
  getWorkspaceDatabaseBackupPaths,
  removeWorkspaceDatabaseBackups,
  reconcileWorkspaceBackupRotation,
} from "./file-repository-backup";
import {
  recoverWorkspaceDatabase,
  removeWorkspaceRecoveryArtifacts,
  type RestoredSnapshotRevalidator,
  type WorkspaceDatabaseRecoveryResult,
} from "./file-repository-recovery";
import {
  normalizeLegacySourceDebugRunRecord,
  readLegacySeed,
} from "./internal/legacy";
import {
  bootstrapState,
  cloneValue,
  getSingletonValue,
  getSingletonValueWithRevision,
  hasPersistedState,
  incrementSingletonRevision,
  listCollectionValues,
  listValues,
  listValuesInChunks,
  readState,
  replaceCollection,
  saveSingletonValue,
  stateTableNames,
  upsertIndexedCollectionValue,
  writeState,
} from "./internal/state";
import {
  applyProfileCopilotMessagePatchFlags,
  findProfileCopilotMessageByPatchGroup,
} from "./profile-copilot-message-flags";
import type {
  ApplicationRecordBatchCommitResult,
  FileJobFinderRepositoryOptions,
  JobFinderRepository,
  WorkspaceDatabaseRecoveryRequiredDetails,
  WorkspaceDatabaseRecoveryRequiredOutcome,
} from "./repository-types";
import { createSavedJobProjectionReader } from "./internal/saved-job-projection";
import { createDiscoveryDisplayProjectionReader } from "./internal/discovery-display-projection";
import {
  createDiscoveryStorage,
  replaceDiscoveryStorage,
} from "./internal/discovery-storage";
import { createIntelligenceProjectionReader } from "./internal/intelligence-projection";
import { createDisplayCollectionsReader } from "./internal/display-collections";
import { createSingletonProjectionReader } from "./internal/singleton-projection";

const nullableCampaignSchema = JobSearchCampaignCollectionSchema.nullable();

/**
 * Thrown by createFileJobFinderRepository when the workspace database could
 * not be opened safely and automatic single-attempt recovery did not produce
 * a usable live database. Carries a redacted incident: candidate kinds and
 * validation stages only, quarantine artifacts reduced to basenames, and no
 * filesystem paths or persisted values in the message.
 */
export class WorkspaceDatabaseRecoveryRequiredError extends Error {
  public readonly details: WorkspaceDatabaseRecoveryRequiredDetails;

  constructor(details: WorkspaceDatabaseRecoveryRequiredDetails) {
    super(
      `Workspace database recovery required (${details.outcome}). Automatic recovery could not restore the previous workspace safely; existing database artifacts were preserved and no empty replacement database was created.`,
    );
    this.name = "WorkspaceDatabaseRecoveryRequiredError";
    this.details = details;
  }
}

export async function createFileJobFinderRepository(
  options: FileJobFinderRepositoryOptions,
): Promise<JobFinderRepository> {
  const normalizedSeed = JobFinderRepositoryStateSchema.parse(
    cloneValue(options.seed),
  );
  const automaticBackup = options.automaticBackup ?? {};
  const recoveryTelemetry = options.recoveryTelemetry ?? {};
  const recoveryValidationOverrides = options.recoveryValidationOverrides ?? {};

  function closeDatabaseQuietly(database: DatabaseSync): void {
    try {
      database.close();
    } catch {
      // A broken probe connection must never mask the startup failure.
    }
  }

  function passesStartupIntegrityCheck(database: DatabaseSync): boolean {
    const rows = database.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check?: unknown;
    }>;
    return rows.length > 0 && rows.every((row) => row.integrity_check === "ok");
  }

  function ensureThrownError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  type WorkspaceOpenAttempt =
    | { status: "opened"; database: DatabaseSync }
    | { status: "failed"; error: Error };

  /**
   * Opens, migrates, and sanity-checks the live database once. A missing
   * database file is a legitimate first run only while no graceful-close
   * snapshot exists; otherwise it is treated as a recovery failure so a lost
   * workspace can never be silently replaced with a fresh one.
   */
  function attemptOpenAndValidate(): WorkspaceOpenAttempt {
    const backupPaths = getWorkspaceDatabaseBackupPaths(options.filePath);
    if (
      !existsSync(options.filePath) &&
      (existsSync(backupPaths.closeBackupPath) ||
        existsSync(backupPaths.closeBackupPreviousPath))
    ) {
      return {
        status: "failed",
        error: new Error(
          "Workspace database file is missing although close snapshots exist.",
        ),
      };
    }

    // A full integrity check reads every page: about 0.3 s of each start on
    // a 200 MB workspace. A file left exactly as a clean close left it has
    // nothing new to check; a crash or outside edit still gets the check.
    const closedCleanly = consumeCleanCloseMarker(options.filePath);

    let database: DatabaseSync;
    try {
      database = openDatabaseFile(options.filePath);
    } catch (error) {
      return { status: "failed", error: ensureThrownError(error) };
    }

    try {
      runMigrations(database);
      if (!closedCleanly && !passesStartupIntegrityCheck(database)) {
        throw new Error(
          "Workspace database failed the startup integrity check.",
        );
      }
      return { status: "opened", database };
    } catch (error) {
      closeDatabaseQuietly(database);
      return { status: "failed", error: ensureThrownError(error) };
    }
  }

  const restoredSnapshotRevalidator: RestoredSnapshotRevalidator = ({
    restoredTempPath,
  }) => {
    let candidate: DatabaseSync;
    try {
      candidate = openDatabaseFile(restoredTempPath);
    } catch {
      return false;
    }
    try {
      (recoveryValidationOverrides.runMigrations ?? runMigrations)(candidate);
      if (!passesStartupIntegrityCheck(candidate)) {
        return false;
      }
      return (
        recoveryValidationOverrides.hasPersistedState ?? hasPersistedState
      )(candidate);
    } catch {
      return false;
    } finally {
      closeDatabaseQuietly(candidate);
    }
  };

  function recoveryRequiredError(
    result: WorkspaceDatabaseRecoveryResult,
  ): WorkspaceDatabaseRecoveryRequiredError {
    const outcome: WorkspaceDatabaseRecoveryRequiredOutcome =
      result.outcome === "restore-failed"
        ? result.reason
        : result.outcome === "not-attempted"
          ? result.reason === "no-valid-candidate"
            ? "no-valid-candidate"
            : "salvage-required"
          : "restore-promotion-failed";
    return new WorkspaceDatabaseRecoveryRequiredError({
      incidentId: result.incidentId,
      outcome,
      failureEvidence: result.classification.evidence,
      sqliteErrorCode: result.classification.sqliteErrorCode,
      candidates: result.candidates,
      quarantineBasenames: result.quarantinedArtifacts,
    });
  }

  async function openWorkspaceDatabaseWithRecovery(): Promise<DatabaseSync> {
    const attempt = attemptOpenAndValidate();
    if (attempt.status === "opened") {
      return attempt.database;
    }

    // Exactly one classification/recovery pass per creation call. The
    // revalidator judges the isolated restore copy with the same strictness
    // as candidate evaluation before any byte is promoted to the live path.
    const recovery = await recoverWorkspaceDatabase({
      filePath: options.filePath,
      openError: attempt.error,
      environment: {
        now: () => new Date(),
        createIncidentId: randomUUID,
      },
      revalidateRestoredSnapshot: restoredSnapshotRevalidator,
      validation: recoveryValidationOverrides,
    });

    if (recovery.outcome === "restored") {
      const reopened = attemptOpenAndValidate();
      if (reopened.status === "opened") {
        try {
          recoveryTelemetry.onRestored?.({
            incidentId: recovery.incidentId,
            restoredFrom: recovery.restoredFrom,
            quarantinedArtifactBasenames: recovery.quarantinedArtifacts,
            lossWindow: recovery.lossWindow,
          });
        } catch {
          // Telemetry observer failures must never invalidate a successfully
          // reopened database; they surface as warnings only.
          console.warn(
            "[JobFinderRepository] Restore telemetry observer failed.",
          );
        }
        return reopened.database;
      }
      throw recoveryRequiredError(recovery);
    }

    if (
      recovery.outcome === "not-attempted" &&
      recovery.reason === "source-not-corrupt"
    ) {
      // Clean-integrity failure such as a migration or programming error:
      // surface the original error and leave every file untouched.
      throw attempt.error;
    }

    throw recoveryRequiredError(recovery);
  }

  const reconciliation = await reconcileWorkspaceBackupRotation(
    options.filePath,
  );
  if (reconciliation.actions.length > 0 || reconciliation.warnings.length > 0) {
    recoveryTelemetry.onRotationReconciled?.({
      actions: reconciliation.actions.map((action) => ({ code: action.code })),
      warnings: reconciliation.warnings.map((warning) => ({
        code: warning.code,
        fileBasename: basename(warning.path),
      })),
    });
  }

  const database = await openWorkspaceDatabaseWithRecovery();
  const stopWalCheckpoints = scheduleWalCheckpoints(database, options.filePath);

  // Everything below runs on the open connection. If any step fails, the
  // connection is closed before the error leaves: an orphaned handle keeps the
  // workspace file locked on Windows until the app exits.
  let context: ReturnType<typeof createFileRepositoryContext>;
  let discoveryStorage: ReturnType<typeof createDiscoveryStorage>;
  let readSavedJobsProjection: ReturnType<
    typeof createSavedJobProjectionReader
  >;
  let readIntelligenceProjection: ReturnType<
    typeof createIntelligenceProjectionReader
  >;
  let readDisplayCollections: ReturnType<typeof createDisplayCollectionsReader>;
  let readSingletonProjection: ReturnType<
    typeof createSingletonProjectionReader
  >;
  let readDiscoveryDisplayProjection: ReturnType<
    typeof createDiscoveryDisplayProjectionReader
  >;
  try {
    if (!hasPersistedState(database)) {
      const legacySeed = await readLegacySeed(options.filePath, normalizedSeed);
      const bootstrapSeed = legacySeed
        ? JobFinderRepositoryStateSchema.parse({
            ...legacySeed,
            profile: {
              ...legacySeed.profile,
              experiences: legacySeed.profile.experiences.map((experience) => ({
                ...experience,
                achievements: repairLegacyCommaSplitAchievements(
                  experience.achievements,
                ),
              })),
            },
            profileRevisions: legacySeed.profileRevisions.map((revision) => ({
              ...revision,
              snapshotProfile: {
                ...revision.snapshotProfile,
                experiences: revision.snapshotProfile.experiences.map(
                  (experience) => ({
                    ...experience,
                    achievements: repairLegacyCommaSplitAchievements(
                      experience.achievements,
                    ),
                  }),
                ),
              },
            })),
          })
        : normalizedSeed;
      bootstrapState(database, bootstrapSeed);
      await secureDatabaseFile(options.filePath);
    }

    context = createFileRepositoryContext({
      database,
      filePath: options.filePath,
    });
    readSingletonProjection = createSingletonProjectionReader(database);
    discoveryStorage = createDiscoveryStorage(
      database,
      normalizedSeed.discovery,
    );
    readSavedJobsProjection = createSavedJobProjectionReader(database, {
      validationStamp: options.rowValidationStamp ?? null,
    });
    readIntelligenceProjection = createIntelligenceProjectionReader(database);
    readDisplayCollections = createDisplayCollectionsReader(database, {
      validationStamp: options.rowValidationStamp ?? null,
    });
    readDiscoveryDisplayProjection = createDiscoveryDisplayProjectionReader(
      database,
      normalizedSeed.discovery,
    );
  } catch (error) {
    closeDatabaseQuietly(database);
    throw error;
  }

  function listApplyCollection<TValue>(input: {
    tableName:
      | "apply_runs"
      | "apply_job_results"
      | "apply_submit_approvals"
      | "application_question_records"
      | "application_answer_records"
      | "application_artifact_refs"
      | "application_replay_checkpoints"
      | "application_consent_requests";
    schema: { parse: (value: unknown) => TValue };
    orderBySql: string;
    filters?: ReadonlyArray<
      readonly [columnName: string, value: string | undefined]
    >;
  }): TValue[] {
    return listCollectionValues(database, input.tableName, input.schema, {
      ...buildOptionalSqlFilters(input.filters ?? []),
      orderBySql: input.orderBySql,
    });
  }

  /**
   * Empty-collection base for the narrow authority reader below. The seed's
   * singletons only satisfy the state schema's required fields; the authority
   * and answer-snapshot repositories never read them.
   */
  const authorityStateBase = JobFinderRepositoryStateSchema.parse({
    profile: normalizedSeed.profile,
    searchPreferences: normalizedSeed.searchPreferences,
    settings: normalizedSeed.settings,
  });

  /**
   * The authority and answer-snapshot repositories only touch their own
   * collections plus the apply result and application record an outcome
   * reconciles. Reading the whole workspace (saved jobs, resume revisions,
   * discovery history, source-debug evidence, ...) on every list call and
   * again inside every BEGIN IMMEDIATE authority write costs more than the
   * collections being read, so this reader loads exactly that subset with the
   * same schemas and orderings readState uses.
   */
  function readApplicationAuthorityState(): JobFinderRepositoryState {
    return {
      ...cloneValue(authorityStateBase),
      applyJobResults: listCollectionValues(
        database,
        "apply_job_results",
        ApplyJobResultSchema,
        { orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_job_results },
      ),
      applicationRecords: listValues(
        database,
        "application_records",
        ApplicationRecordSchema,
      ),
      applicationAnswerSnapshots: listCollectionValues(
        database,
        "application_answer_snapshots",
        ApprovedApplicationAnswerSnapshotSchema,
        { orderBySql: "profile_id ASC, revision DESC, id ASC" },
      ),
      applicationAuthorityEnvelopes: listCollectionValues(
        database,
        "application_authority_envelopes",
        ApplicationAuthorityEnvelopeSchema,
        { orderBySql: "revision DESC, id ASC" },
      ),
      submissionPreflights: listCollectionValues(
        database,
        "submission_preflights",
        SubmissionPreflightRecordSchema,
        { orderBySql: "created_at ASC, id ASC" },
      ),
      submissionExecutionGrants: listCollectionValues(
        database,
        "submission_execution_grants",
        SubmissionExecutionGrantSchema,
        { orderBySql: "granted_at DESC, id ASC" },
      ),
      submissionIdempotencyRecords: listCollectionValues(
        database,
        "submission_idempotency_records",
        SubmissionIdempotencyRecordSchema,
        { orderBySql: "updated_at DESC, id ASC" },
      ),
      submissionArmedMarkers: listCollectionValues(
        database,
        "submission_armed_markers",
        SubmissionArmedMarkerSchema,
        { orderBySql: "armed_at ASC, id ASC" },
      ),
      submissionOutcomeRecords: listCollectionValues(
        database,
        "submission_outcome_records",
        SubmissionOutcomeRecordSchema,
        { orderBySql: "attempted_at ASC, id ASC" },
      ),
    };
  }

  function serializeById(
    values: readonly { id: string }[],
  ): Map<string, string> {
    return new Map(values.map((value) => [value.id, JSON.stringify(value)]));
  }

  /**
   * One authority collection's persistence plan for a single mutation. Rows
   * that did not change are never rewritten, so a mutation touching one grant
   * no longer rebuilds the whole authority subtree.
   */
  interface AuthorityCollectionWrite {
    readonly tableName: string;
    readonly previous: ReadonlyMap<string, string>;
    readonly values: readonly { id: string }[];
    readonly write: (value: { id: string }) => void;
  }

  /**
   * Deletes removed rows child-first and writes changed rows parent-first so
   * the foreign keys declared on the submission tables hold at every statement
   * under PRAGMA foreign_keys = ON. `writes` must be ordered parent to child.
   */
  function persistAuthorityCollections(
    writes: readonly AuthorityCollectionWrite[],
  ): void {
    for (const collection of [...writes].reverse()) {
      const nextIds = new Set(collection.values.map((value) => value.id));
      for (const id of collection.previous.keys()) {
        if (!nextIds.has(id)) {
          database
            .prepare(`DELETE FROM ${collection.tableName} WHERE id = ?`)
            .run(id);
        }
      }
    }

    for (const collection of writes) {
      for (const value of collection.values) {
        if (collection.previous.get(value.id) !== JSON.stringify(value)) {
          collection.write(value);
        }
      }
    }
  }

  return {
    readDisplayCollections,
    ...createApplicationAnswerSnapshotRepositoryMethods({
      read: () => readApplicationAuthorityState(),
      mutate: (operation) =>
        runImmediateTransaction(database, () => {
          const state = readApplicationAuthorityState();
          const previousSnapshots = new Map(
            (state.applicationAnswerSnapshots ?? []).map((snapshot) => [
              snapshot.id,
              JSON.stringify(snapshot),
            ]),
          );
          const result = operation(state);
          const nextSnapshots = new Map(
            (state.applicationAnswerSnapshots ?? []).map((snapshot) => [
              snapshot.id,
              JSON.stringify(snapshot),
            ]),
          );
          for (const snapshotId of previousSnapshots.keys()) {
            if (!nextSnapshots.has(snapshotId)) {
              throw new Error(
                "Approved application answer snapshots are append-only; deletion is not permitted.",
              );
            }
          }
          for (const snapshot of state.applicationAnswerSnapshots ?? []) {
            const previous = previousSnapshots.get(snapshot.id);
            if (previous !== undefined) {
              if (previous !== nextSnapshots.get(snapshot.id)) {
                throw new Error(
                  "Approved application answer snapshots are immutable; updates are not permitted.",
                );
              }
              continue;
            }
            upsertIndexedCollectionValue(
              database,
              "application_answer_snapshots",
              snapshot,
              INDEXED_COLLECTION_CONFIGS.application_answer_snapshots,
            );
          }
          return result;
        }),
    }),
    ...createApplicationAuthorityRepositoryMethods({
      read: () => readApplicationAuthorityState(),
      mutate: (operation) =>
        runImmediateTransaction(database, () => {
          const state = readApplicationAuthorityState();
          const previousApplyJobResults = serializeById(state.applyJobResults);
          const previousApplicationRecords = serializeById(
            state.applicationRecords,
          );
          const previousApplicationAnswerSnapshots = serializeById(
            state.applicationAnswerSnapshots ?? [],
          );
          const previousAuthorityEnvelopes = serializeById(
            state.applicationAuthorityEnvelopes,
          );
          const previousSubmissionPreflights = serializeById(
            state.submissionPreflights,
          );
          const previousSubmissionExecutionGrants = serializeById(
            state.submissionExecutionGrants,
          );
          const previousSubmissionIdempotencyRecords = serializeById(
            state.submissionIdempotencyRecords,
          );
          const previousSubmissionArmedMarkers = serializeById(
            state.submissionArmedMarkers,
          );
          const previousSubmissionOutcomeRecords = serializeById(
            state.submissionOutcomeRecords,
          );
          const result = operation(state);
          const nextApplicationAnswerSnapshots = serializeById(
            state.applicationAnswerSnapshots ?? [],
          );
          for (const snapshotId of previousApplicationAnswerSnapshots.keys()) {
            if (!nextApplicationAnswerSnapshots.has(snapshotId)) {
              throw new Error(
                "Approved application answer snapshots are append-only; deletion is not permitted.",
              );
            }
          }
          for (const value of state.applicationAnswerSnapshots ?? []) {
            const previous = previousApplicationAnswerSnapshots.get(value.id);
            if (previous !== undefined) {
              if (previous !== nextApplicationAnswerSnapshots.get(value.id)) {
                throw new Error(
                  "Approved application answer snapshots are immutable; updates are not permitted.",
                );
              }
              continue;
            }
            upsertIndexedCollectionValue(
              database,
              "application_answer_snapshots",
              value,
              INDEXED_COLLECTION_CONFIGS.application_answer_snapshots,
            );
          }
          // Rotation revokes the current envelope and installs its
          // replacement in the same transaction. The partial unique index
          // allows exactly one active envelope, so the row leaving the active
          // status must be written before the row entering it.
          const orderedAuthorityEnvelopes = [
            ...state.applicationAuthorityEnvelopes.filter(
              (value) => value.status !== "active",
            ),
            ...state.applicationAuthorityEnvelopes.filter(
              (value) => value.status === "active",
            ),
          ];
          // Persist only the authority rows this mutation actually changed,
          // ordered parent to child. The surrounding BEGIN IMMEDIATE
          // transaction keeps the lifecycle atomic; all table names are fixed
          // repository constants.
          persistAuthorityCollections([
            {
              tableName: stateTableNames.application_authority_envelopes,
              previous: previousAuthorityEnvelopes,
              values: orderedAuthorityEnvelopes,
              write: (value) =>
                upsertIndexedCollectionValue(
                  database,
                  "application_authority_envelopes",
                  value,
                  INDEXED_COLLECTION_CONFIGS.application_authority_envelopes,
                ),
            },
            {
              tableName: stateTableNames.submission_preflights,
              previous: previousSubmissionPreflights,
              values: state.submissionPreflights,
              write: (value) =>
                upsertIndexedCollectionValue(
                  database,
                  "submission_preflights",
                  value,
                  INDEXED_COLLECTION_CONFIGS.submission_preflights,
                ),
            },
            {
              tableName: stateTableNames.submission_execution_grants,
              previous: previousSubmissionExecutionGrants,
              values: state.submissionExecutionGrants,
              write: (value) =>
                upsertIndexedCollectionValue(
                  database,
                  "submission_execution_grants",
                  value,
                  INDEXED_COLLECTION_CONFIGS.submission_execution_grants,
                ),
            },
            {
              tableName: stateTableNames.submission_idempotency_records,
              previous: previousSubmissionIdempotencyRecords,
              values: state.submissionIdempotencyRecords,
              write: (value) =>
                upsertIndexedCollectionValue(
                  database,
                  "submission_idempotency_records",
                  value,
                  INDEXED_COLLECTION_CONFIGS.submission_idempotency_records,
                ),
            },
            {
              tableName: stateTableNames.submission_armed_markers,
              previous: previousSubmissionArmedMarkers,
              values: state.submissionArmedMarkers,
              write: (value) =>
                upsertIndexedCollectionValue(
                  database,
                  "submission_armed_markers",
                  value,
                  INDEXED_COLLECTION_CONFIGS.submission_armed_markers,
                ),
            },
            {
              tableName: stateTableNames.submission_outcome_records,
              previous: previousSubmissionOutcomeRecords,
              values: state.submissionOutcomeRecords,
              write: (value) =>
                upsertIndexedCollectionValue(
                  database,
                  "submission_outcome_records",
                  value,
                  INDEXED_COLLECTION_CONFIGS.submission_outcome_records,
                ),
            },
          ]);
          // Outcome reconciliation may update the receipt nested in an
          // ApplyJobResult. Persist only changed parent rows in this same
          // transaction so authority state can never commit without its
          // matching receipt, while unrelated apply history is untouched.
          const nextApplyJobResults = serializeById(state.applyJobResults);
          for (const resultId of previousApplyJobResults.keys()) {
            if (!nextApplyJobResults.has(resultId)) {
              database
                .prepare(
                  `DELETE FROM ${stateTableNames.apply_job_results} WHERE id = ?`,
                )
                .run(resultId);
            }
          }
          for (const value of state.applyJobResults) {
            if (
              previousApplyJobResults.get(value.id) !==
              nextApplyJobResults.get(value.id)
            ) {
              upsertIndexedCollectionValue(
                database,
                "apply_job_results",
                value,
                APPLY_INDEXED_COLLECTION_CONFIGS.apply_job_results,
              );
            }
          }
          // Outcome reconciliation may also update the exact application
          // record projection. Persist only changed rows in this same
          // transaction so the result receipt, outcome, idempotency state,
          // and Applications truth can never diverge after a crash.
          const nextApplicationRecords = serializeById(
            state.applicationRecords,
          );
          for (const applicationRecordId of previousApplicationRecords.keys()) {
            if (!nextApplicationRecords.has(applicationRecordId)) {
              database
                .prepare(
                  `DELETE FROM ${stateTableNames.application_records} WHERE id = ?`,
                )
                .run(applicationRecordId);
            }
          }
          for (const value of state.applicationRecords) {
            if (
              previousApplicationRecords.get(value.id) !==
              nextApplicationRecords.get(value.id)
            ) {
              context.writePersistedValue("application_records", value);
            }
          }
          return result;
        }),
    }),
    ...createFileRepositoryResumeMethods(context),
    // These reads need only authority envelopes, not the application/result
    // bodies loaded by the transaction store for preflight/outcome mutations.
    listApplicationAuthorityEnvelopes(filter) {
      return Promise.resolve(
        listValues(
          database,
          "application_authority_envelopes",
          ApplicationAuthorityEnvelopeSchema,
        )
          .filter(
            (value) =>
              (filter?.id === undefined || value.id === filter.id) &&
              (filter?.status === undefined || value.status === filter.status),
          )
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
    },
    getApplicationAuthorityEnvelope(id) {
      return Promise.resolve(
        listCollectionValues(
          database,
          "application_authority_envelopes",
          ApplicationAuthorityEnvelopeSchema,
          {
            whereSql: "id = ?",
            params: [id],
            orderBySql: "id",
            limit: 1,
          },
        )[0] ?? null,
      );
    },
    ...createFileRepositoryUserActionMethods(context),
    ...createFileRepositoryGroupedManualAnswerMethods(context),
    exportState: () =>
      Promise.resolve(cloneValue(readState(database, normalizedSeed))),
    async close() {
      if (automaticBackup.onClose) {
        const backup = await createWorkspaceCloseDatabaseBackup({
          database,
          filePath: options.filePath,
        });
        if (backup.status === "skipped") {
          console.warn(
            "[JobFinderRepository] Skipped graceful-close database backup.",
            backup.reason,
          );
        }
      }
      await stopWalCheckpoints();
      database.close();
      writeCleanCloseMarker(options.filePath);
    },
    async reset(nextSeed) {
      const nextState = JobFinderRepositoryStateSchema.parse(
        cloneValue(nextSeed),
      );
      if (automaticBackup.beforeReset) {
        const backup = await createWorkspaceResetDatabaseBackup({
          database,
          filePath: options.filePath,
        });
        if (backup.status === "skipped") {
          console.warn(
            "[JobFinderRepository] Skipped pre-reset database backup.",
            backup.reason,
          );
        }
      }
      writeState(database, nextState);
      // Rebuild the file so the deleted rows do not linger in free pages,
      // then fold the WAL back in and empty it: it holds the old pages too.
      database.exec("VACUUM");
      database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await secureDatabaseFile(options.filePath);
      await removeWorkspaceDatabaseBackups(options.filePath);
      await removeWorkspaceRecoveryArtifacts(options.filePath);
    },
    // Singleton reads return their own copy already; only the shared seed
    // needs copying. Copying twice cost about 10 ms of every refresh.
    getProfile() {
      return Promise.resolve(
        getSingletonValue(database, "profile", CandidateProfileSchema) ??
          cloneValue(normalizedSeed.profile),
      );
    },
    readProfileProjection() {
      return Promise.resolve(
        readSingletonProjection(
          "profile",
          CandidateProfileSchema,
          normalizedSeed.profile,
        ),
      );
    },
    getProfileWithRevision() {
      const persisted = getSingletonValueWithRevision(
        database,
        "profile",
        CandidateProfileSchema,
      );
      return Promise.resolve(
        cloneValue({
          profile: persisted.value ?? normalizedSeed.profile,
          revision: persisted.revision,
        }),
      );
    },
    saveProfile(profile) {
      const normalizedProfile = CandidateProfileSchema.parse(
        cloneValue(profile),
      );
      runImmediateTransaction(database, () => {
        saveSingletonValue(database, "profile", normalizedProfile);
      });
      return secureDatabaseFile(options.filePath);
    },
    commitProfileUpdate(updateProfile, casOptions) {
      try {
        const outcome = runImmediateTransaction<{
          status: "applied" | "stale";
          profile: CandidateProfile;
          revision: number;
        }>(database, () => {
          const persisted = getSingletonValueWithRevision(
            database,
            "profile",
            CandidateProfileSchema,
          );
          const currentProfile = persisted.value ?? normalizedSeed.profile;
          if (
            casOptions?.expectedRevision !== undefined &&
            casOptions.expectedRevision !== persisted.revision
          ) {
            return {
              status: "stale" as const,
              profile: currentProfile,
              revision: persisted.revision,
            };
          }

          const nextProfile = CandidateProfileSchema.parse(
            cloneValue(updateProfile(cloneValue(currentProfile))),
          );
          saveSingletonValue(database, "profile", nextProfile);
          return {
            status: "applied" as const,
            profile: nextProfile,
            revision: persisted.revision + 1,
          };
        });
        if (outcome.status === "stale") {
          return Promise.resolve(outcome);
        }
        return secureDatabaseFile(options.filePath).then(() => outcome);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    getSearchPreferences() {
      return Promise.resolve(
        getSingletonValue(
          database,
          "search_preferences",
          JobSearchPreferencesSchema,
        ) ?? cloneValue(normalizedSeed.searchPreferences),
      );
    },
    readSearchPreferencesProjection() {
      return Promise.resolve(
        readSingletonProjection(
          "search_preferences",
          JobSearchPreferencesSchema,
          normalizedSeed.searchPreferences,
        ),
      );
    },
    getProfileSetupState() {
      return Promise.resolve(
        getSingletonValue(
          database,
          "profile_setup_state",
          ProfileSetupStateSchema,
        ) ?? cloneValue(normalizedSeed.profileSetupState),
      );
    },
    saveSearchPreferences(searchPreferences) {
      const normalizedSearchPreferences = JobSearchPreferencesSchema.parse(
        cloneValue(searchPreferences),
      );
      runImmediateTransaction(database, () => {
        saveSingletonValue(
          database,
          "search_preferences",
          normalizedSearchPreferences,
        );
        // Preference-only writes advance the shared profile epoch so copilot
        // commits that captured older preferences fail closed as stale.
        incrementSingletonRevision(database, "profile");
      });
      return secureDatabaseFile(options.filePath);
    },
    saveProfileSetupState(profileSetupState) {
      const normalizedProfileSetupState = ProfileSetupStateSchema.parse(
        cloneValue(profileSetupState),
      );
      runImmediateTransaction(database, () => {
        saveSingletonValue(
          database,
          "profile_setup_state",
          normalizedProfileSetupState,
        );
        // Setup-state-only writes advance the shared profile epoch so copilot
        // commits that captured older setup state fail closed as stale.
        incrementSingletonRevision(database, "profile");
      });
      return secureDatabaseFile(options.filePath);
    },
    saveProfileAndSearchPreferences(profile, searchPreferences) {
      const normalizedProfile = CandidateProfileSchema.parse(
        cloneValue(profile),
      );
      const normalizedSearchPreferences = JobSearchPreferencesSchema.parse(
        cloneValue(searchPreferences),
      );

      runImmediateTransaction(database, () => {
        saveSingletonValue(database, "profile", normalizedProfile);
        saveSingletonValue(
          database,
          "search_preferences",
          normalizedSearchPreferences,
        );
      });
      return secureDatabaseFile(options.filePath);
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
      const normalizedProfile = CandidateProfileSchema.parse(
        cloneValue(profile),
      );
      const normalizedSearchPreferences = JobSearchPreferencesSchema.parse(
        cloneValue(searchPreferences),
      );
      const normalizedProfileSetupState = ProfileSetupStateSchema.parse(
        cloneValue(profileSetupState),
      );
      const normalizedMessages = ProfileCopilotMessageSchema.array().parse(
        cloneValue(messages ?? []),
      );
      const normalizedRevisions = ProfileRevisionSchema.array().parse(
        cloneValue(revisions ?? []),
      );
      const normalizedMessagePatchFlags = cloneValue(messagePatchFlags ?? []);

      const outcome = runImmediateTransaction<{
        status: "applied" | "stale";
        profile: CandidateProfile;
        revision: number;
      }>(database, () => {
        const persisted = getSingletonValueWithRevision(
          database,
          "profile",
          CandidateProfileSchema,
        );
        const currentProfile = persisted.value ?? normalizedSeed.profile;
        if (
          expectedProfileRevision !== undefined &&
          expectedProfileRevision !== persisted.revision
        ) {
          return {
            status: "stale" as const,
            profile: currentProfile,
            revision: persisted.revision,
          };
        }

        saveSingletonValue(database, "profile", normalizedProfile);
        saveSingletonValue(
          database,
          "search_preferences",
          normalizedSearchPreferences,
        );
        saveSingletonValue(
          database,
          "profile_setup_state",
          normalizedProfileSetupState,
        );

        for (const message of normalizedMessages) {
          context.writePersistedValue("profile_copilot_messages", message);
        }

        for (const revision of normalizedRevisions) {
          context.writePersistedValue("profile_revisions", revision);
        }

        // Flag deltas resolve against transaction-current rows so sibling
        // groups changed by a concurrent apply/reject are never reverted.
        if (normalizedMessagePatchFlags.length > 0) {
          const currentMessages = listValues(
            database,
            "profile_copilot_messages",
            ProfileCopilotMessageSchema,
          );
          for (const message of applyProfileCopilotMessagePatchFlags(
            currentMessages,
            normalizedMessagePatchFlags,
          )) {
            context.writePersistedValue("profile_copilot_messages", message);
          }
        }

        return {
          status: "applied" as const,
          profile: normalizedProfile,
          revision: persisted.revision + 1,
        };
      });

      if (outcome.status === "stale") {
        return Promise.resolve(outcome);
      }

      return secureDatabaseFile(options.filePath).then(() => outcome);
    },
    commitProfileCopilotPatchFlagUpdate({ patchGroupId, applyMode }) {
      try {
        const didUpdate = runImmediateTransaction<boolean>(database, () => {
          const currentMessages = listValues(
            database,
            "profile_copilot_messages",
            ProfileCopilotMessageSchema,
          );
          const messageIndex = findProfileCopilotMessageByPatchGroup(
            currentMessages,
            { patchGroupId },
          );

          if (messageIndex < 0) {
            return false;
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
            context.writePersistedValue(
              "profile_copilot_messages",
              changedMessage,
            );
          }
          return true;
        });
        return secureDatabaseFile(options.filePath).then(() => didUpdate);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    listSavedJobs(options?: { limit?: number; offset?: number }) {
      if (options?.limit === undefined && options?.offset === undefined) {
        return listValuesInChunks(database, "saved_jobs", SavedJobSchema);
      }
      return Promise.resolve(
        listValues(database, "saved_jobs", SavedJobSchema, options),
      );
    },
    readSavedJobsProjection,
    listSavedJobIds() {
      const current = readSavedJobsProjection.currentIds();
      if (current) return Promise.resolve([...current]);
      return Promise.resolve(
        database
          .prepare(`SELECT id FROM ${stateTableNames.saved_jobs} ORDER BY id`)
          .all()
          .map((row) => String(row.id)),
      );
    },
    listSavedJobsByIds(jobIds) {
      if (jobIds.length === 0) return Promise.resolve([]);
      return Promise.resolve(
        listCollectionValues(database, "saved_jobs", SavedJobSchema, {
          whereSql: "id IN (SELECT value FROM json_each(?))",
          params: [JSON.stringify([...new Set(jobIds)])],
          orderBySql: "id",
        }),
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
        const suppliedUpserts = SavedJobSchema.array().parse(
          cloneValue([...upserts]),
        );
        let committedDiscovery: JobFinderDiscoveryState | null = null;

        runImmediateTransaction(database, () => {
          const currentDiscoveryState =
            upsertsFromDiscovery ||
            upsertsFromBorrowedDiscovery ||
            updateDiscoveryState
              ? discoveryStorage.read()
              : null;
          const normalizedUpserts = [
            ...suppliedUpserts,
            ...(upsertsFromDiscovery && currentDiscoveryState
              ? SavedJobSchema.array().parse(
                  upsertsFromDiscovery(cloneValue(currentDiscoveryState)),
                )
              : []),
            ...(upsertsFromBorrowedDiscovery && currentDiscoveryState
              ? SavedJobSchema.array().parse(
                  upsertsFromBorrowedDiscovery(currentDiscoveryState),
                )
              : []),
          ];
          if (updateSettings) {
            const currentSettings =
              getSingletonValue(
                database,
                "settings",
                JobFinderSettingsSchema,
              ) ?? normalizedSeed.settings;
            const nextSettings = JobFinderSettingsSchema.parse(
              cloneValue(updateSettings(cloneValue(currentSettings))),
            );
            saveSingletonValue(database, "settings", nextSettings);
          }

          const existingJobIds = new Set<string>();
          let previousJobForResumeApproval: ReturnType<
            typeof SavedJobSchema.parse
          > | null = null;
          let nextJobForResumeApproval: ReturnType<
            typeof SavedJobSchema.parse
          > | null = null;

          if (update) {
            const currentJobs = updateJobIds
              ? listCollectionValues(database, "saved_jobs", SavedJobSchema, {
                  whereSql: "id IN (SELECT value FROM json_each(?))",
                  params: [
                    JSON.stringify([
                      ...new Set([
                        ...updateJobIds,
                        ...normalizedUpserts.map((job) => job.id),
                        ...(clearResumeApproval
                          ? [clearResumeApproval.jobId]
                          : []),
                      ]),
                    ]),
                  ],
                  orderBySql: "id",
                })
              : listValues(database, "saved_jobs", SavedJobSchema);
            for (const currentJob of currentJobs) {
              existingJobIds.add(currentJob.id);
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
              if (JSON.stringify(nextJob) !== JSON.stringify(currentJob)) {
                context.writePersistedValue("saved_jobs", nextJob);
              }
            }
          }

          for (const job of normalizedUpserts) {
            if (update && existingJobIds.has(job.id)) {
              continue;
            }
            context.writePersistedValue("saved_jobs", job);
          }

          if (
            clearResumeApproval &&
            previousJobForResumeApproval &&
            nextJobForResumeApproval &&
            clearResumeApproval.shouldClear(
              previousJobForResumeApproval,
              nextJobForResumeApproval,
            )
          ) {
            const draft = listCollectionValues(
              database,
              "resume_drafts",
              ResumeDraftSchema,
              {
                whereSql: "job_id = ?",
                params: [clearResumeApproval.jobId],
                orderBySql: "updated_at DESC, id ASC",
              },
            )[0];
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
              // tailored_assets is an id/value table with no job_id or
              // updated_at columns, so the newest asset for this job is
              // selected in memory. Querying those columns threw "no such
              // column: job_id" and rolled back the whole delta.
              const existingAsset = listValues(
                database,
                "tailored_assets",
                TailoredAssetSchema,
              )
                .filter((asset) => asset.jobId === draft.jobId)
                .sort(
                  (left, right) =>
                    new Date(right.updatedAt).getTime() -
                      new Date(left.updatedAt).getTime() ||
                    left.id.localeCompare(right.id),
                )[0];

              syncApprovedResumeExportsForJob(database, draft.jobId, null);
              context.writePersistedValue("resume_drafts", staleDraft);
              if (existingAsset) {
                const staleAsset = TailoredAssetSchema.parse(
                  cloneValue({
                    ...existingAsset,
                    storagePath: null,
                    updatedAt: staleDraft.updatedAt,
                  }),
                );
                context.writePersistedValue("tailored_assets", staleAsset);
              }
            }
          }

          if (updateDiscoveryState && currentDiscoveryState) {
            committedDiscovery = discoveryStorage.update(
              updateDiscoveryState(currentDiscoveryState),
              currentDiscoveryState,
            );
          }
        });
        if (committedDiscovery) discoveryStorage.publish(committedDiscovery);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      return secureDatabaseFile(options.filePath);
    },
    commitDiscoveryFeedbackUpdate(jobId, update, feedbackOptions) {
      try {
        let committedDiscovery: JobFinderDiscoveryState | null = null;
        const result = runImmediateTransaction(database, () => {
          const discoveryState = discoveryStorage.read();
          const pendingJob =
            discoveryState.pendingDiscoveryJobs.find(
              (job) => job.id === jobId,
            ) ?? null;
          const savedJob = pendingJob
            ? null
            : (listCollectionValues(database, "saved_jobs", SavedJobSchema, {
                whereSql: "id = ?",
                params: [jobId],
                orderBySql: "id",
              })[0] ?? null);
          const searchPreferences = feedbackOptions?.borrowUnchangedState
            ? readSingletonProjection(
                "search_preferences",
                JobSearchPreferencesSchema,
                normalizedSeed.searchPreferences,
              )
            : (getSingletonValue(
                database,
                "search_preferences",
                JobSearchPreferencesSchema,
              ) ?? normalizedSeed.searchPreferences);
          const campaignState = feedbackOptions?.borrowUnchangedState
            ? readSingletonProjection(
                "campaign_state",
                nullableCampaignSchema,
                null,
              )
            : getSingletonValue(
                database,
                "campaign_state",
                JobSearchCampaignCollectionSchema,
              );
          const intelligenceState = feedbackOptions?.borrowUnchangedState
            ? readSingletonProjection(
                "intelligence_state",
                JobFinderIntelligenceStateSchema,
                normalizedSeed.intelligence,
              )
            : (getSingletonValue(
                database,
                "intelligence_state",
                JobFinderIntelligenceStateSchema,
              ) ?? normalizedSeed.intelligence);
          const next = update({
            job: cloneValue(pendingJob ?? savedJob),
            jobIsPending: pendingJob !== null,
            searchPreferences: feedbackOptions?.borrowUnchangedState
              ? searchPreferences
              : cloneValue(searchPreferences),
            campaignState: feedbackOptions?.borrowUnchangedState
              ? campaignState
              : cloneValue(campaignState),
            intelligenceState: feedbackOptions?.borrowUnchangedState
              ? intelligenceState
              : cloneValue(intelligenceState),
            discoveryState,
          });
          // Most feedback (hiding a job) leaves the preferences and plans as
          // they were. Validating and rewriting both (about 1 MB with 900
          // sources) on every hide was most of its cost, so an unchanged
          // value is left alone; only the profile epoch is ever compared.
          const searchPreferencesTouched = feedbackOptions?.borrowUnchangedState
            ? next.searchPreferences !== searchPreferences
            : JSON.stringify(next.searchPreferences) !==
              JSON.stringify(searchPreferences);
          const nextSearchPreferences = searchPreferencesTouched
            ? JobSearchPreferencesSchema.parse(
                cloneValue(next.searchPreferences),
              )
            : null;
          const nextCampaignState =
            next.campaignState === null ||
            (feedbackOptions?.borrowUnchangedState
              ? next.campaignState === campaignState
              : JSON.stringify(next.campaignState) ===
                JSON.stringify(campaignState))
              ? null
              : JobSearchCampaignCollectionSchema.parse(
                  cloneValue(next.campaignState),
                );
          const nextSavedJob = next.savedJob
            ? SavedJobSchema.parse(cloneValue(next.savedJob))
            : null;

          if (nextSavedJob) {
            context.writePersistedValue("saved_jobs", nextSavedJob);
          }
          if (nextSearchPreferences) {
            saveSingletonValue(
              database,
              "search_preferences",
              nextSearchPreferences,
            );
            // A changed preference advances the shared profile epoch so a
            // copilot commit that captured the older preferences fails
            // closed as stale instead of reverting this feedback. Most
            // discovery feedback leaves preferences untouched; those must
            // not invalidate unrelated in-flight profile work.
            if (
              JSON.stringify(nextSearchPreferences) !==
              JSON.stringify(searchPreferences)
            ) {
              incrementSingletonRevision(database, "profile");
            }
          }
          if (nextCampaignState !== null) {
            saveSingletonValue(database, "campaign_state", nextCampaignState);
          }
          committedDiscovery = discoveryStorage.update(
            next.discoveryState,
            discoveryState,
          );
          return next.result;
        });
        if (committedDiscovery) discoveryStorage.publish(committedDiscovery);
        return secureDatabaseFile(options.filePath).then(() => result);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    replaceSavedJobs(savedJobs) {
      const normalizedJobs = SavedJobSchema.array().parse(
        cloneValue([...savedJobs]),
      );
      runImmediateTransaction(database, () => {
        replaceCollection(database, "saved_jobs", normalizedJobs);
      });

      return secureDatabaseFile(options.filePath);
    },
    replaceSavedJobsAndDiscoveryState({ savedJobs, discoveryState }) {
      const normalizedJobs = SavedJobSchema.array().parse(
        cloneValue([...savedJobs]),
      );
      const normalizedDiscoveryState = JobFinderDiscoveryStateSchema.parse(
        cloneValue(discoveryState),
      );

      runImmediateTransaction(database, () => {
        replaceCollection(database, "saved_jobs", normalizedJobs);
        replaceDiscoveryStorage(database, normalizedDiscoveryState);
      });

      return secureDatabaseFile(options.filePath);
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

      runImmediateTransaction(database, () => {
        replaceCollection(database, "saved_jobs", normalizedJobs);
        syncApprovedResumeExportsForJob(database, normalizedDraft.jobId, null);
        context.writePersistedValue("resume_drafts", normalizedDraft);

        if (normalizedAsset) {
          context.writePersistedValue("tailored_assets", normalizedAsset);
        }
      });

      return secureDatabaseFile(options.filePath);
    },
    listApplyRuns(options) {
      return Promise.resolve(
        cloneValue(
          listApplyCollection({
            tableName: "apply_runs",
            schema: ApplyRunSchema,
            orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_runs,
            filters: options?.id ? [["id", options.id]] : [],
          }),
        ),
      );
    },
    upsertApplyRun(run) {
      const normalizedRun = ApplyRunSchema.parse(cloneValue(run));
      return context.upsertPersistedValue("apply_runs", normalizedRun);
    },
    listApplyJobResults(options) {
      return Promise.resolve(
        cloneValue(
          listApplyCollection({
            tableName: "apply_job_results",
            schema: ApplyJobResultSchema,
            orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_job_results,
            filters: [
              ...(options?.runId ? [["run_id", options.runId] as const] : []),
              ...(options?.jobId ? [["job_id", options.jobId] as const] : []),
              ...(options?.applicationRecordId
                ? [
                    [
                      "application_record_id",
                      options.applicationRecordId,
                    ] as const,
                  ]
                : []),
            ],
          }),
        ),
      );
    },
    upsertApplyJobResult(result) {
      const normalizedResult = ApplyJobResultSchema.parse(cloneValue(result));
      runImmediateTransaction(database, () => {
        const currentById = listApplyCollection({
          tableName: "apply_job_results",
          schema: ApplyJobResultSchema,
          orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_job_results,
          filters: [["id", normalizedResult.id]],
        })[0];
        const currentByLineage = listApplyCollection({
          tableName: "apply_job_results",
          schema: ApplyJobResultSchema,
          orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_job_results,
          filters: [
            ["run_id", normalizedResult.runId],
            ["job_id", normalizedResult.jobId],
          ],
        })[0];
        // Mirror the in-memory repository lineage replacement: an existing
        // row with the same run/job lineage keeps its persisted identity even
        // when the incoming result carries a new id. Re-keying under the new
        // id would orphan evidence records anchored to the persisted result
        // id and reset immutable preparation-start accounting for that
        // lineage.
        const nextResult = ApplyJobResultSchema.parse({
          ...normalizedResult,
          id: currentByLineage?.id ?? normalizedResult.id,
        });
        for (const current of [currentById, currentByLineage]) {
          if (current) {
            assertApplicationPreparationStartPreserved(current, nextResult);
          }
        }
        context.writePersistedValue("apply_job_results", nextResult);
      });
      return secureDatabaseFile(options.filePath);
    },
    markApplicationPreparationStarted(input) {
      const outcome = runImmediateTransaction(database, () => {
        const current = listApplyCollection({
          tableName: "apply_job_results",
          schema: ApplyJobResultSchema,
          orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_job_results,
          filters: [["id", input.resultId]],
        })[0];
        if (!current) {
          throw new Error("Apply result does not exist.");
        }
        if (current.runId !== input.runId || current.jobId !== input.jobId) {
          throw new Error("Apply result lineage does not match.");
        }
        if (current.applicationPreparationStartedAt) {
          return { result: current, didStart: false };
        }

        const result = ApplyJobResultSchema.parse({
          ...current,
          applicationPreparationStartedAt: input.startedAt,
          applicationPreparationStartedLocalDate: input.startedLocalDate,
        });
        context.writePersistedValue("apply_job_results", result);
        return { result, didStart: true };
      });
      return secureDatabaseFile(options.filePath).then(() =>
        cloneValue(outcome),
      );
    },
    compareAndSwapApplyJobResult(input) {
      const expected = ApplyJobResultSchema.parse(cloneValue(input.expected));
      const nextResult = ApplyJobResultSchema.parse(cloneValue(input.result));
      if (nextResult.id !== expected.id) {
        throw new Error("Apply result CAS cannot change the result identity.");
      }
      assertApplicationPreparationStartPreserved(expected, nextResult);
      const columns =
        APPLY_INDEXED_COLLECTION_CONFIGS.apply_job_results.getColumns(
          nextResult,
        );
      const update = database
        .prepare(
          `UPDATE apply_job_results
           SET run_id = ?, job_id = ?, application_record_id = ?, application_preparation_started_at = ?, application_preparation_started_local_date = ?, queue_position = ?, updated_at = ?, state = ?, value = ?
           WHERE id = ? AND value = ?`,
        )
        .run(
          ...columns,
          JSON.stringify(nextResult),
          expected.id,
          JSON.stringify(expected),
        );
      return Promise.resolve(update.changes === 1);
    },
    listApplySubmitApprovals(options) {
      return Promise.resolve(
        cloneValue(
          listApplyCollection({
            tableName: "apply_submit_approvals",
            schema: ApplySubmitApprovalSchema,
            orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_submit_approvals,
            filters: [
              ...(options?.id ? [["id", options.id] as const] : []),
              ...(options?.runId ? [["run_id", options.runId] as const] : []),
            ],
          }),
        ),
      );
    },
    upsertApplySubmitApproval(approval) {
      const normalizedApproval = ApplySubmitApprovalSchema.parse(
        cloneValue(approval),
      );
      return context.upsertPersistedValue(
        "apply_submit_approvals",
        normalizedApproval,
      );
    },
    listApplicationQuestionRecords(options) {
      return Promise.resolve(
        cloneValue(
          listApplyCollection({
            tableName: "application_question_records",
            schema: ApplicationQuestionRecordSchema,
            orderBySql:
              APPLY_COLLECTION_ORDER_BY_SQL.application_question_records,
            filters: [
              ...(options?.runId ? [["run_id", options.runId] as const] : []),
              ...(options?.jobId ? [["job_id", options.jobId] as const] : []),
              ...(options?.applicationRecordId
                ? [
                    [
                      "application_record_id",
                      options.applicationRecordId,
                    ] as const,
                  ]
                : []),
              ...(options?.resultId
                ? [["result_id", options.resultId] as const]
                : []),
            ],
          }),
        ),
      );
    },
    upsertApplicationQuestionRecord(record) {
      const normalizedRecord = ApplicationQuestionRecordSchema.parse(
        cloneValue(record),
      );
      return context.upsertPersistedValue(
        "application_question_records",
        normalizedRecord,
      );
    },
    listApplicationAnswerRecords(options) {
      return Promise.resolve(
        cloneValue(
          listApplyCollection({
            tableName: "application_answer_records",
            schema: ApplicationAnswerRecordSchema,
            orderBySql:
              APPLY_COLLECTION_ORDER_BY_SQL.application_answer_records,
            filters: [
              ...(options?.runId ? [["run_id", options.runId] as const] : []),
              ...(options?.jobId ? [["job_id", options.jobId] as const] : []),
              ...(options?.applicationRecordId
                ? [
                    [
                      "application_record_id",
                      options.applicationRecordId,
                    ] as const,
                  ]
                : []),
              ...(options?.resultId
                ? [["result_id", options.resultId] as const]
                : []),
              ...(options?.questionId
                ? [["question_id", options.questionId] as const]
                : []),
            ],
          }),
        ),
      );
    },
    upsertApplicationAnswerRecord(record) {
      const normalizedRecord = ApplicationAnswerRecordSchema.parse(
        cloneValue(record),
      );
      return context.upsertPersistedValue(
        "application_answer_records",
        normalizedRecord,
      );
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

      let result: "applied" | "duplicate" | "stale" | null = null;
      runImmediateTransaction(database, () => {
        const currentAnswers = listApplyCollection({
          tableName: "application_answer_records",
          schema: ApplicationAnswerRecordSchema,
          orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.application_answer_records,
          filters: [["question_id", expectedQuestion.id]],
        });
        if (currentAnswers.some((answer) => answer.id === nextAnswer.id)) {
          result = "duplicate";
          return;
        }

        const currentQuestion =
          listCollectionValues(
            database,
            "application_question_records",
            ApplicationQuestionRecordSchema,
            {
              whereSql: "id = ?",
              params: [expectedQuestion.id],
              orderBySql:
                APPLY_COLLECTION_ORDER_BY_SQL.application_question_records,
            },
          )[0] ?? null;
        const currentAnswer = latestApplicationAnswerRecord(
          currentAnswers,
          expectedQuestion.id,
        );
        if (
          currentQuestion === null ||
          !areSameApplicationQuestionRecords(
            currentQuestion,
            expectedQuestion,
          ) ||
          (expectedAnswer === null
            ? currentAnswer !== null
            : currentAnswer === null ||
              !areSameApplicationAnswerRecords(currentAnswer, expectedAnswer))
        ) {
          result = "stale";
          return;
        }

        context.writePersistedValue("application_answer_records", nextAnswer);
        context.writePersistedValue(
          "application_question_records",
          nextQuestion,
        );
        result = "applied";
      });

      if (result === null) {
        throw new Error(
          "Application answer mutation did not produce a result.",
        );
      }
      const mutationResult = result;
      return secureDatabaseFile(options.filePath).then(() => mutationResult);
    },
    listApplicationArtifactRefs(options) {
      return Promise.resolve(
        cloneValue(
          listApplyCollection({
            tableName: "application_artifact_refs",
            schema: ApplicationArtifactRefSchema,
            orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.application_artifact_refs,
            filters: [
              ...(options?.runId ? [["run_id", options.runId] as const] : []),
              ...(options?.jobId ? [["job_id", options.jobId] as const] : []),
              ...(options?.applicationRecordId
                ? [
                    [
                      "application_record_id",
                      options.applicationRecordId,
                    ] as const,
                  ]
                : []),
              ...(options?.resultId
                ? [["result_id", options.resultId] as const]
                : []),
            ],
          }),
        ),
      );
    },
    upsertApplicationArtifactRef(ref) {
      const normalizedRef = ApplicationArtifactRefSchema.parse(cloneValue(ref));
      return context.upsertPersistedValue(
        "application_artifact_refs",
        normalizedRef,
      );
    },
    listApplicationReplayCheckpoints(options) {
      return Promise.resolve(
        cloneValue(
          listApplyCollection({
            tableName: "application_replay_checkpoints",
            schema: ApplicationReplayCheckpointSchema,
            orderBySql:
              APPLY_COLLECTION_ORDER_BY_SQL.application_replay_checkpoints,
            filters: [
              ...(options?.runId ? [["run_id", options.runId] as const] : []),
              ...(options?.jobId ? [["job_id", options.jobId] as const] : []),
              ...(options?.applicationRecordId
                ? [
                    [
                      "application_record_id",
                      options.applicationRecordId,
                    ] as const,
                  ]
                : []),
              ...(options?.resultId
                ? [["result_id", options.resultId] as const]
                : []),
            ],
          }),
        ),
      );
    },
    upsertApplicationReplayCheckpoint(checkpoint) {
      const normalizedCheckpoint = ApplicationReplayCheckpointSchema.parse(
        cloneValue(checkpoint),
      );
      return context.upsertPersistedValue(
        "application_replay_checkpoints",
        normalizedCheckpoint,
      );
    },
    listApplicationConsentRequests(options) {
      return Promise.resolve(
        cloneValue(
          listApplyCollection({
            tableName: "application_consent_requests",
            schema: ApplicationConsentRequestSchema,
            orderBySql:
              APPLY_COLLECTION_ORDER_BY_SQL.application_consent_requests,
            filters: [
              ...(options?.runId ? [["run_id", options.runId] as const] : []),
              ...(options?.jobId ? [["job_id", options.jobId] as const] : []),
              ...(options?.applicationRecordId
                ? [
                    [
                      "application_record_id",
                      options.applicationRecordId,
                    ] as const,
                  ]
                : []),
              ...(options?.resultId
                ? [["result_id", options.resultId] as const]
                : []),
            ],
          }),
        ),
      );
    },
    upsertApplicationConsentRequest(request) {
      const normalizedRequest = ApplicationConsentRequestSchema.parse(
        cloneValue(request),
      );
      return context.upsertPersistedValue(
        "application_consent_requests",
        normalizedRequest,
      );
    },
    listApplicationRecords() {
      return Promise.resolve(
        cloneValue(
          listValues(database, "application_records", ApplicationRecordSchema),
        ),
      );
    },
    upsertApplicationRecord(applicationRecord) {
      const normalizedRecord = ApplicationRecordSchema.parse(
        cloneValue(applicationRecord),
      );
      return context.upsertPersistedValue(
        "application_records",
        normalizedRecord,
      );
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

      const result =
        runImmediateTransaction<ApplicationRecordBatchCommitResult>(
          database,
          () => {
            const currentRecords = listValues(
              database,
              "application_records",
              ApplicationRecordSchema,
            );
            const currentById = new Map(
              currentRecords.map((record) => [record.id, record]),
            );
            const missingRecordIds = expectedIds.filter(
              (id) => !currentById.has(id),
            );
            if (missingRecordIds.length > 0) {
              return { status: "missing", recordIds: missingRecordIds };
            }

            const staleRecordIds = expectedRevisions
              .filter(
                ({ applicationRecordId, expectedRevision }) =>
                  (currentById.get(applicationRecordId)?.crm?.revision ?? 0) !==
                  expectedRevision,
              )
              .map(({ applicationRecordId }) => applicationRecordId);
            if (staleRecordIds.length > 0) {
              return { status: "stale", recordIds: staleRecordIds };
            }

            const committedRecords = normalizedRecords.map((proposedRecord) => {
              const currentRecord = currentById.get(proposedRecord.id)!;
              // A bulk stage change is tracker activity: the row's Updated
              // date and last action move with it, like a single change,
              // unless another writer touched the row more recently.
              const proposedIsNewer =
                proposedRecord.lastUpdatedAt > currentRecord.lastUpdatedAt;
              const committedRecord = ApplicationRecordSchema.parse({
                ...currentRecord,
                crm: proposedRecord.crm,
                ...(proposedIsNewer
                  ? {
                      lastUpdatedAt: proposedRecord.lastUpdatedAt,
                      lastActionLabel: proposedRecord.lastActionLabel,
                    }
                  : {}),
              });
              context.writePersistedValue(
                "application_records",
                committedRecord,
              );
              return committedRecord;
            });
            return { status: "applied", committedRecords };
          },
        );

      return result.status === "applied"
        ? secureDatabaseFile(options.filePath).then(() => result)
        : Promise.resolve(result);
    },
    listApplicationAttempts(options) {
      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "application_attempts",
            ApplicationAttemptSchema,
            {
              orderBySql: "id ASC",
              ...buildOptionalSqlFilters([
                ["job_id", options?.jobId],
                ["application_record_id", options?.applicationRecordId],
              ]),
            },
          ),
        ),
      );
    },
    upsertApplicationAttempt(applicationAttempt) {
      const normalizedAttempt = ApplicationAttemptSchema.parse(
        cloneValue(applicationAttempt),
      );
      const columns =
        APPLICATION_ATTEMPT_INDEXED_COLLECTION_CONFIG.getColumns(
          normalizedAttempt,
        );
      database
        .prepare(
          `INSERT INTO application_attempts
             (id, job_id, application_record_id, updated_at, value)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             job_id = excluded.job_id,
             application_record_id = excluded.application_record_id,
             updated_at = excluded.updated_at,
             value = excluded.value`,
        )
        .run(
          normalizedAttempt.id,
          ...columns,
          JSON.stringify(normalizedAttempt),
        );
      return secureDatabaseFile(options.filePath);
    },
    claimApplicationAttempt(applicationAttempt) {
      const normalizedAttempt = ApplicationAttemptSchema.parse(
        cloneValue(applicationAttempt),
      );
      const insert = database
        .prepare(
          `INSERT OR IGNORE INTO application_attempts
             (id, job_id, application_record_id, updated_at, value)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          normalizedAttempt.id,
          ...APPLICATION_ATTEMPT_INDEXED_COLLECTION_CONFIG.getColumns(
            normalizedAttempt,
          ),
          JSON.stringify(normalizedAttempt),
        );
      return Promise.resolve(insert.changes === 1);
    },
    listSourceDebugRuns() {
      return Promise.resolve(
        cloneValue(
          listValues(database, "source_debug_runs", {
            parse: normalizeLegacySourceDebugRunRecord,
          }),
        ),
      );
    },
    upsertSourceDebugRun(run) {
      const normalizedRun = SourceDebugRunRecordSchema.parse(cloneValue(run));
      return context.upsertPersistedValue("source_debug_runs", normalizedRun);
    },
    listSourceDebugAttempts() {
      return Promise.resolve(
        cloneValue(
          listValues(
            database,
            "source_debug_attempts",
            SourceDebugWorkerAttemptSchema,
          ),
        ),
      );
    },
    upsertSourceDebugAttempt(attempt) {
      const normalizedAttempt = SourceDebugWorkerAttemptSchema.parse(
        cloneValue(attempt),
      );
      return context.upsertPersistedValue(
        "source_debug_attempts",
        normalizedAttempt,
      );
    },
    listSourceInstructionArtifacts() {
      return Promise.resolve(
        cloneValue(
          listValues(
            database,
            "source_instruction_artifacts",
            SourceInstructionArtifactSchema,
          ),
        ),
      );
    },
    upsertSourceInstructionArtifact(artifact) {
      const normalizedArtifact = SourceInstructionArtifactSchema.parse(
        cloneValue(artifact),
      );
      return context.upsertPersistedValue(
        "source_instruction_artifacts",
        normalizedArtifact,
      );
    },
    deleteSourceInstructionArtifactsForTarget(targetId) {
      runImmediateTransaction(database, () => {
        database
          .prepare(
            "DELETE FROM source_instruction_artifacts WHERE json_extract(value, '$.targetId') = ?",
          )
          .run(targetId);
      });

      return secureDatabaseFile(options.filePath);
    },
    listSourceDebugEvidenceRefs() {
      return Promise.resolve(
        cloneValue(
          listValues(
            database,
            "source_debug_evidence_refs",
            SourceDebugEvidenceRefSchema,
          ),
        ),
      );
    },
    upsertSourceDebugEvidenceRef(evidenceRef) {
      const normalizedEvidenceRef = SourceDebugEvidenceRefSchema.parse(
        cloneValue(evidenceRef),
      );
      return context.upsertPersistedValue(
        "source_debug_evidence_refs",
        normalizedEvidenceRef,
      );
    },
    upsertSourceDebugEvidenceRefs(evidenceRefs) {
      const normalizedEvidenceRefs = SourceDebugEvidenceRefSchema.array().parse(
        cloneValue([...evidenceRefs]),
      );

      runImmediateTransaction(database, () => {
        for (const normalizedEvidenceRef of normalizedEvidenceRefs) {
          context.writePersistedValue(
            "source_debug_evidence_refs",
            normalizedEvidenceRef,
          );
        }
      });

      return secureDatabaseFile(options.filePath);
    },
    getSettings() {
      return Promise.resolve(
        getSingletonValue(database, "settings", JobFinderSettingsSchema) ??
          cloneValue(normalizedSeed.settings),
      );
    },
    saveSettings(settings) {
      const normalizedSettings = JobFinderSettingsSchema.parse(
        cloneValue(settings),
      );
      runImmediateTransaction(database, () => {
        saveSingletonValue(database, "settings", normalizedSettings);
      });
      return secureDatabaseFile(options.filePath);
    },
    commitSettingsUpdate(update) {
      try {
        const nextSettings = runImmediateTransaction(database, () => {
          const currentSettings =
            getSingletonValue(database, "settings", JobFinderSettingsSchema) ??
            normalizedSeed.settings;
          const nextState = JobFinderSettingsSchema.parse(
            cloneValue(update(cloneValue(currentSettings))),
          );
          saveSingletonValue(database, "settings", nextState);
          return nextState;
        });

        return secureDatabaseFile(options.filePath).then(() =>
          cloneValue(nextSettings),
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    readDiscoveryDisplayProjection,
    getDiscoveryState() {
      return Promise.resolve(cloneValue(discoveryStorage.read()));
    },
    warmDiscoveryState() {
      try {
        if (!database.isTransaction) discoveryStorage.read();
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    commitDiscoverySessions(update) {
      try {
        const sessions = runImmediateTransaction(database, () =>
          discoveryStorage.updateSessions(update),
        );
        discoveryStorage.publishSessions();
        return secureDatabaseFile(options.filePath).then(() => [...sessions]);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    commitDiscoveryStateUpdate(update) {
      try {
        const nextDiscoveryState = runImmediateTransaction(database, () => {
          const current = discoveryStorage.read();
          return discoveryStorage.update(update(current), current);
        });
        discoveryStorage.publish(nextDiscoveryState);

        return secureDatabaseFile(options.filePath).then(() => ({
          ...nextDiscoveryState,
          sessions: [...nextDiscoveryState.sessions],
          recentRuns: [...nextDiscoveryState.recentRuns],
          recentSourceDebugRuns: [...nextDiscoveryState.recentSourceDebugRuns],
          discoveryLedger: [...nextDiscoveryState.discoveryLedger],
          pendingDiscoveryJobs: [...nextDiscoveryState.pendingDiscoveryJobs],
        }));
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    getCampaignState() {
      return Promise.resolve(
        getSingletonValue(
          database,
          "campaign_state",
          JobSearchCampaignCollectionSchema,
        ),
      );
    },
    readCampaignProjection() {
      return Promise.resolve(
        readSingletonProjection("campaign_state", nullableCampaignSchema, null),
      );
    },
    saveCampaignState(campaignState) {
      const normalizedCampaignState = JobSearchCampaignCollectionSchema.parse(
        cloneValue(campaignState),
      );
      runImmediateTransaction(database, () => {
        saveSingletonValue(database, "campaign_state", normalizedCampaignState);
      });
      return secureDatabaseFile(options.filePath);
    },
    commitCampaignPreferencesUpdate(update) {
      try {
        const result = runImmediateTransaction(database, () => {
          const campaignState = getSingletonValue(
            database,
            "campaign_state",
            JobSearchCampaignCollectionSchema,
          );
          const searchPreferences =
            getSingletonValue(
              database,
              "search_preferences",
              JobSearchPreferencesSchema,
            ) ?? normalizedSeed.searchPreferences;
          const next = update({
            campaignState: cloneValue(campaignState),
            searchPreferences: cloneValue(searchPreferences),
            intelligenceState: cloneValue(
              getSingletonValue(
                database,
                "intelligence_state",
                JobFinderIntelligenceStateSchema,
              ) ?? normalizedSeed.intelligence,
            ),
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
          saveSingletonValue(database, "campaign_state", nextCampaignState);
          saveSingletonValue(
            database,
            "search_preferences",
            nextSearchPreferences,
          );
          if (nextIntelligenceState)
            saveSingletonValue(
              database,
              "intelligence_state",
              nextIntelligenceState,
            );
          // A changed preference advances the shared profile epoch so a
          // copilot commit that captured the older preferences fails closed
          // as stale instead of reverting this campaign preference change.
          // A campaign-only edit leaves preferences untouched and must not
          // invalidate unrelated in-flight profile work.
          if (
            JSON.stringify(nextSearchPreferences) !==
            JSON.stringify(searchPreferences)
          ) {
            incrementSingletonRevision(database, "profile");
          }
          return next.result;
        });
        return secureDatabaseFile(options.filePath).then(() => result);
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    readIntelligenceProjection,
    getIntelligenceState() {
      return Promise.resolve(
        getSingletonValue(
          database,
          "intelligence_state",
          JobFinderIntelligenceStateSchema,
        ) ?? JobFinderIntelligenceStateSchema.parse({}),
      );
    },
    saveIntelligenceState(intelligenceState) {
      const normalized = JobFinderIntelligenceStateSchema.parse(
        cloneValue(intelligenceState),
      );
      runImmediateTransaction(database, () => {
        saveSingletonValue(database, "intelligence_state", normalized);
      });
      return secureDatabaseFile(options.filePath);
    },
    commitCompanyIntelligenceUpdate(expected, update) {
      try {
        const nextState = runImmediateTransaction(database, () => {
          const intelligenceState =
            getSingletonValue(
              database,
              "intelligence_state",
              JobFinderIntelligenceStateSchema,
            ) ?? normalizedSeed.intelligence;
          const savedJob =
            expected.jobId === null
              ? null
              : (listCollectionValues(database, "saved_jobs", SavedJobSchema, {
                  whereSql: "id = ?",
                  params: [expected.jobId],
                  orderBySql: "id ASC",
                })[0] ?? null);
          const applicationRecord =
            expected.applicationRecordId === null
              ? null
              : (listCollectionValues(
                  database,
                  "application_records",
                  ApplicationRecordSchema,
                  {
                    whereSql: "id = ?",
                    params: [expected.applicationRecordId],
                    orderBySql: "id ASC",
                  },
                )[0] ?? null);
          const normalized = JobFinderIntelligenceStateSchema.parse(
            cloneValue(
              update({
                intelligenceState: cloneValue(intelligenceState),
                savedJob: cloneValue(savedJob),
                applicationRecord: cloneValue(applicationRecord),
              }),
            ),
          );
          saveSingletonValue(database, "intelligence_state", normalized);
          return normalized;
        });
        return secureDatabaseFile(options.filePath).then(() =>
          cloneValue(nextState),
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    getActivityControl() {
      return Promise.resolve(
        getSingletonValue(
          database,
          "activity_control",
          JobFinderActivityControlSchema,
        ) ?? JobFinderActivityControlSchema.parse({}),
      );
    },
    saveActivityControl(activityControl) {
      const normalized = JobFinderActivityControlSchema.parse(
        cloneValue(activityControl),
      );
      runImmediateTransaction(database, () => {
        saveSingletonValue(database, "activity_control", normalized);
      });
      return secureDatabaseFile(options.filePath);
    },
  };
}
