import { notifyWorkspaceCommit } from "./workspace-commits";
import { openJobStore } from "./job-store/job-store";
import { createProfileWorkspace } from "./job-store/profile-workspace";
import { createSiteInstructionsStore } from "./job-store/site-instructions";
import { createActivityControlStore } from "./job-store/activity-control";
import {
  parseSavedJobsWithPreparation,
  readSavedJobFingerprintBatch,
  writeSavedJobFingerprints,
  samePreparedSavedJobInputs,
} from "./internal/saved-job-fingerprints";
import { writeSavedJobSightings } from "./internal/saved-job-sightings";
import { writeSavedJobPlanAssessments } from "./internal/saved-job-plan-assessments";
import { isDeepStrictEqual } from "node:util";
import { channel } from "node:diagnostics_channel";
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
  ApplicationAuthorityEnvelopeSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  ApplyQueueSchema,
  JobFinderDiscoveryStateSchema,
  JobFinderIntelligenceStateSchema,
  JobFinderRepositoryStateSchema,
  JobSearchCampaignCollectionSchema,
  ResumeDraftSchema,
  SavedJobSchema,
  SourceDebugEvidenceRefSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionPreflightRecordSchema,
  TailoredAssetSchema,
  type SavedJob,
  type JobFinderRepositoryState,
  readPreparedDiscoveryFingerprints,
} from "@nestor/contracts";
import { createHash, randomUUID } from "node:crypto";
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
  secureDatabaseFile,
  runMigrations,
} from "./internal/migrations";
import {
  consumeCleanCloseMarker,
  writeCleanCloseMarker,
} from "./internal/clean-close-marker";
import {
  scheduleWorkspaceDatabaseBackups,
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
import { normalizeLegacySourceDebugRunRecord } from "./internal/legacy";
import {
  bootstrapState,
  cloneValue,
  getSingletonValue,
  hasPersistedState,
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

import type {
  ApplicationRecordBatchCommitResult,
  FileJobFinderRepositoryOptions,
  JobFinderRepository,
  WorkspaceDatabaseRecoveryRequiredDetails,
  WorkspaceDatabaseRecoveryRequiredOutcome,
} from "./repository-types";
import { createSavedJobProjectionReader } from "./internal/saved-job-projection";
import {
  createSavedJobWriteReader,
  freezeSavedJobForWrite,
  sameSavedJobWrite,
} from "./internal/saved-job-write-reader";
import { toDiscoveryDisplayProjection } from "./internal/discovery-display-projection";
import {
  createDiscoveryStorage,
  replaceDiscoveryStorage,
  readDiscoveryBootstrapStorage,
  readDiscoveryHomeStorage,
} from "./internal/discovery-storage";
import { createIntelligenceProjectionReader } from "./internal/intelligence-projection";
import { createWorkspaceListActivityReader } from "./internal/workspace-list-activity";
import { createDisplayCollectionsReader } from "./internal/display-collections";
import { createSingletonProjectionReader } from "./internal/singleton-projection";
import { createResumeApprovalFolder } from "./internal/resume-approval-fold";

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
      runMigrations(database, {
        deferEvidenceConversion: options.deferEvidenceConversion ?? false,
      });
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
  let homeActivity:
    | ReturnType<typeof createWorkspaceListActivityReader>
    | undefined;
  let writeReader: ReturnType<typeof createSavedJobWriteReader> | null = null;
  const readJobsForWrite = (ids: readonly string[]) =>
    (writeReader ??= createSavedJobWriteReader(database))(ids);
  // Detail versions are disk-backed, with a bounded SQLite page cache.
  // Set this before any connection-local projection tables are created.
  database.exec("PRAGMA temp_store = FILE; PRAGMA temp.cache_size = -2048");
  const stopWalCheckpoints = scheduleWalCheckpoints(database, options.filePath);
  let approvalFolder: ReturnType<typeof createResumeApprovalFolder>;

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
  try {
    if (!hasPersistedState(database)) {
      bootstrapState(database, normalizedSeed);
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
      sqliteDetails: true,
    });
    readIntelligenceProjection = createIntelligenceProjectionReader(database);
    readDisplayCollections = createDisplayCollectionsReader(database);
    approvalFolder = createResumeApprovalFolder(
      database,
      readDisplayCollections.prepareResumeStateFold,
      readDisplayCollections.draftHasApproval,
    );
    // Every canonical and display read already composes pending approval
    // metadata. Fold its bodies in the background; close still flushes them.
    approvalFolder.schedule();
  } catch (error) {
    await stopWalCheckpoints();
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

  const startBackups = () =>
    automaticBackup.inBackground
      ? scheduleWorkspaceDatabaseBackups({
          filePath: options.filePath,
          firstCheckDelayMs: automaticBackup.firstCheckDelayMs ?? 0,
          schemaVersion: Number(
            database
              .prepare("SELECT MAX(version) AS version FROM schema_migrations")
              .get()?.version,
          ),
        })
      : async () => {};
  let stopBackups = startBackups();

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

  const profileStore =
    options.store ?? openJobStore(`${options.filePath}.jobs.sqlite`);
  const profileWorkspace = createProfileWorkspace(profileStore, normalizedSeed);
  // Site instructions and the pause live in the job store; the old file's
  // tables are no longer read.
  const siteInstructions = createSiteInstructionsStore(profileStore);
  const activityControl = createActivityControlStore(profileStore);
  const stopProfileUpdates = profileStore.onChange((change) => {
    if (["profile", "profile_activity", "settings"].includes(change.cause))
      notifyWorkspaceCommit(database);
  });
  return {
    readDisplayCollections: async () => ({
      ...(await readDisplayCollections()),
      profileCopilotMessages:
        await profileWorkspace.methods.listProfileCopilotMessages(),
      profileRevisions: await profileWorkspace.methods.listProfileRevisions(),
      sourceInstructionArtifacts: siteInstructions.list(),
    }),
    ...profileWorkspace.methods,
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
    ...createFileRepositoryResumeMethods(
      context,
      approvalFolder.schedule,
      approvalFolder.foldApprovalChanges,
      profileStore,
    ),
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
      Promise.resolve(
        cloneValue({
          ...readState(database, normalizedSeed),
          ...profileWorkspace.state(),
          sourceInstructionArtifacts: siteInstructions.list(),
          activityControl: activityControl.read(),
        }),
      ),
    async close() {
      if (!database.isOpen) return;
      stopProfileUpdates();
      await approvalFolder.flush();
      await stopBackups();
      await stopWalCheckpoints();
      database.close();
      if (!options.store) profileStore.close();
      writeCleanCloseMarker(options.filePath);
    },
    async reset(nextSeed) {
      const nextState = JobFinderRepositoryStateSchema.parse(
        cloneValue(nextSeed),
      );
      await stopBackups();
      try {
        profileWorkspace.reset(nextState);
        profileStore.transaction(() => {
          siteInstructions.replace(nextState.sourceInstructionArtifacts);
          activityControl.save(nextState.activityControl);
        });
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
        // Shared evidence has no row owner after an empty reset. Leaving it
        // behind would retain the deleted person's text in an otherwise empty DB.
        if (
          !nextState.resumeDrafts.length &&
          !nextState.resumeDraftRevisions.length
        )
          database.exec(
            "DELETE FROM resume_sources; DELETE FROM resume_source_texts",
          );
        if (!nextState.savedJobs.length)
          database.exec(
            "DELETE FROM job_provenance; DELETE FROM job_plan_assessments; DELETE FROM job_listing_texts; DELETE FROM job_fit_assessments",
          );
        database.exec(`DELETE FROM search_preference_sets WHERE id NOT IN (
          SELECT preference_id FROM job_search_plans UNION
          SELECT json_extract(value, '$.preferenceId') FROM singleton_state
            WHERE key = 'search_preferences' AND json_extract(value, '$.preferenceId') IS NOT NULL);
          DELETE FROM search_preference_sources WHERE preference_id NOT IN (SELECT id FROM search_preference_sets);
          DELETE FROM job_sources WHERE id NOT IN (SELECT source_version_id FROM search_preference_sources);`);
        // Rebuild the file so the deleted rows do not linger in free pages,
        // then fold the WAL back in and empty it: it holds the old pages too.
        database.exec("VACUUM");
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        await secureDatabaseFile(options.filePath);
        await removeWorkspaceDatabaseBackups(options.filePath);
        await removeWorkspaceRecoveryArtifacts(options.filePath);
      } finally {
        stopBackups = startBackups();
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
    listCuratedSavedJobIds() {
      // The read index carries each job's status, so no listing body is read.
      return Promise.resolve(
        database
          .prepare(
            `SELECT DISTINCT id FROM workspace_job_index
             WHERE origin = 'saved_jobs' AND status NOT IN ('discovered', 'archived')
             ORDER BY id`,
          )
          .all()
          .map((row) => String(row.id)),
      );
    },
    readSavedJobDiscoveryFingerprints(jobIds) {
      return Promise.resolve(readSavedJobFingerprintBatch(database, jobIds));
    },
    writeSavedJobDiscoveryFingerprints(jobs) {
      try {
        if (jobs.length)
          runImmediateTransaction(database, () => {
            const byId = new Map(jobs.map((job) => [job.id, job]));
            for (const { job: current, bodyKey } of readJobsForWrite([
              ...byId.keys(),
            ])) {
              const job = byId.get(current.id)!;
              if (!readPreparedDiscoveryFingerprints(job)) continue;
              const description = job.description;
              if (bodyKey) {
                if (
                  createHash("sha256").update(description).digest("hex") !==
                  bodyKey
                )
                  continue;
                // The interned key proves these exact bytes without loading the stored body.
                Object.defineProperty(current, "description", {
                  value: description,
                  enumerable: true,
                });
              }
              if (samePreparedSavedJobInputs(job, current))
                writeSavedJobFingerprints(database, job);
            }
          });
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    updateSavedJobSightings(updates) {
      try {
        return Promise.resolve(
          updates.length
            ? runImmediateTransaction(database, () =>
                writeSavedJobSightings(database, updates),
              )
            : 0,
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    updateSavedJobPlanAssessments(updates) {
      try {
        return Promise.resolve(
          updates.length
            ? runImmediateTransaction(database, () =>
                writeSavedJobPlanAssessments(database, updates),
              )
            : 0,
        );
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
    commitSavedJobDelta({
      planAssessments = [],
      sightings = [],
      upserts = [],
      upsertsFromDiscovery,
      upsertsFromBorrowedDiscovery,
      update,
      borrowCurrentJobs,
      updateJobIds,
      updateSettings,
      clearResumeApproval,
      updateDiscoveryState,
    }) {
      const startedAt = performance.now();
      try {
        const suppliedUpserts = [...upserts];

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
              ? upsertsFromDiscovery(cloneValue(currentDiscoveryState))
              : []),
            ...(upsertsFromBorrowedDiscovery && currentDiscoveryState
              ? upsertsFromBorrowedDiscovery(currentDiscoveryState)
              : []),
          ];
          if (normalizedUpserts.some((job) => !job.id))
            throw new Error("Saved job upserts must have an id.");
          if (updateSettings) {
            profileWorkspace.preferences.settings.replace(
              updateSettings(profileWorkspace.preferences.settings.read()),
            );
          }

          const existingJobIds = new Set<string>();
          let previousJobForResumeApproval: ReturnType<
            typeof SavedJobSchema.parse
          > | null = null;
          let nextJobForResumeApproval: ReturnType<
            typeof SavedJobSchema.parse
          > | null = null;

          if (update) {
            const currentJobs =
              updateJobIds && borrowCurrentJobs
                ? readJobsForWrite([
                    ...updateJobIds,
                    ...normalizedUpserts.map((job) => job.id),
                    ...(clearResumeApproval ? [clearResumeApproval.jobId] : []),
                  ]).map(({ job }) => job)
                : updateJobIds
                  ? listCollectionValues(
                      database,
                      "saved_jobs",
                      { parse: (value) => value as SavedJob },
                      {
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
                      },
                    )
                  : listValues(database, "saved_jobs", {
                      parse: (value) => value as SavedJob,
                    });
            for (const currentJob of currentJobs) {
              existingJobIds.add(currentJob.id);
              const nextJob = update(
                borrowCurrentJobs
                  ? freezeSavedJobForWrite(currentJob)
                  : currentJob,
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
              if (!sameSavedJobWrite(nextJob, currentJob)) {
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

          writeSavedJobSightings(database, sightings);
          writeSavedJobPlanAssessments(database, planAssessments);
          if (updateDiscoveryState && currentDiscoveryState) {
            discoveryStorage.update(
              updateDiscoveryState(currentDiscoveryState),
            );
          }
        });
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      const bookkeeping = channel("nestor.discovery.bookkeeping");
      if (bookkeeping.hasSubscribers)
        bookkeeping.publish({
          phase: "write",
          rows: upserts.length + (updateJobIds?.length ?? 0),
          ms: performance.now() - startedAt,
        });
      return secureDatabaseFile(options.filePath);
    },
    replaceSavedJobs(savedJobs) {
      const normalizedJobs = parseSavedJobsWithPreparation(savedJobs);
      runImmediateTransaction(database, () => {
        replaceCollection(database, "saved_jobs", normalizedJobs);
      });

      return secureDatabaseFile(options.filePath);
    },
    replaceSavedJobsAndDiscoveryState({ savedJobs, discoveryState }) {
      const normalizedJobs = parseSavedJobsWithPreparation(savedJobs);
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
      const normalizedJobs = parseSavedJobsWithPreparation(savedJobs);
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
              ...(options?.id ? [["id", options.id] as const] : []),
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
    getPreparedApplicationForm(resultId) {
      const forms = listCollectionValues(
        database,
        "prepared_application_forms",
        PreparedApplicationFormSchema,
        { orderBySql: "id", whereSql: "id = ?", params: [resultId] },
      );
      return Promise.resolve(forms[0] ?? null);
    },
    upsertPreparedApplicationForm(form) {
      return context.upsertPersistedValue(
        "prepared_application_forms",
        PreparedApplicationFormSchema.parse(form),
      );
    },
    deletePreparedApplicationForm(resultId) {
      database
        .prepare("DELETE FROM prepared_application_forms WHERE id = ?")
        .run(resultId);
      return secureDatabaseFile(options.filePath);
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
      return Promise.resolve(siteInstructions.list());
    },
    upsertSourceInstructionArtifact(artifact) {
      siteInstructions.upsert(artifact);
      return Promise.resolve();
    },
    deleteSourceInstructionArtifactsForTarget(targetId) {
      siteInstructions.deleteForSite(targetId);
      return Promise.resolve();
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
    readDiscoveryDisplayProjection() {
      return Promise.resolve(
        toDiscoveryDisplayProjection(discoveryStorage.read()),
      );
    },
    readDiscoveryBootstrapProjection() {
      return Promise.resolve(
        readDiscoveryBootstrapStorage(database, normalizedSeed.discovery),
      );
    },
    readDiscoveryHomeProjection(jobIds, planId = null) {
      const ownTransaction = !database.isTransaction;
      try {
        homeActivity ??= createWorkspaceListActivityReader(database, true);
        if (ownTransaction) database.exec("BEGIN");
        const discovery = readDiscoveryHomeStorage(
          database,
          normalizedSeed.discovery,
        );
        const result = {
          ...discovery,
          listingActivities: homeActivity.read(jobIds, planId),
        };
        if (ownTransaction) database.exec("COMMIT");
        return Promise.resolve(result);
      } catch (error) {
        if (ownTransaction && database.isTransaction) database.exec("ROLLBACK");
        homeActivity?.invalidate();
        return Promise.reject(
          error instanceof Error
            ? error
            : new Error("The Home discovery projection could not be read."),
        );
      }
    },
    getDiscoveryState() {
      return Promise.resolve(cloneValue(discoveryStorage.read()));
    },
    readDiscoveryStateForRun() {
      return Promise.resolve(discoveryStorage.read());
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
          return discoveryStorage.update(update(discoveryStorage.read()));
        });

        return secureDatabaseFile(options.filePath).then(() => ({
          ...nextDiscoveryState,
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
        const current = getSingletonValue(
          database,
          "campaign_state",
          JobSearchCampaignCollectionSchema,
        );
        if (isDeepStrictEqual(current, normalizedCampaignState)) return;
        saveSingletonValue(database, "campaign_state", normalizedCampaignState);
      });
      return secureDatabaseFile(options.filePath);
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
    getActivityControl() {
      return Promise.resolve(activityControl.read());
    },
    saveActivityControl(control) {
      activityControl.save(control);
      return Promise.resolve();
    },
    getApplyQueue() {
      return Promise.resolve(
        getSingletonValue(database, "apply_queue", ApplyQueueSchema, {
          onInvalid: "fallback",
        }),
      );
    },
    saveApplyQueue(queue) {
      runImmediateTransaction(database, () => {
        if (queue === null) {
          database
            .prepare(
              `DELETE FROM ${stateTableNames.singleton_state} WHERE key = ?`,
            )
            .run("apply_queue");
          return;
        }
        saveSingletonValue(
          database,
          "apply_queue",
          ApplyQueueSchema.parse(cloneValue(queue)),
        );
      });
      return secureDatabaseFile(options.filePath);
    },
  };
}
