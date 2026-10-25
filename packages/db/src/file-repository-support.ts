import { notifyWorkspaceCommit } from "./workspace-commits";
import {
  ApplicationAuthorityEnvelopeSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  ProfileCopilotMessageSchema,
  ProfileRevisionSchema,
  ResumeAssistantMessageSchema,
  ResumeDocumentBundleSchema,
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  ResumeExportArtifactSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
  ResumeResearchArtifactSchema,
  ResumeValidationResultSchema,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionPreflightRecordSchema,
} from "@nestor/contracts";
import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { readWalCheckpointProgress } from "./internal/wal-checkpoint-progress";

import { secureDatabaseFile } from "./internal/migrations";
import {
  cloneValue,
  listCollectionValues,
  upsertCollectionValue,
  upsertIndexedCollectionValue,
} from "./internal/state";
import { APPLY_INDEXED_COLLECTION_CONFIGS } from "./apply-collection-support";
import { USER_ACTION_INDEXED_COLLECTION_CONFIGS } from "./user-action-repository-support";

export function runImmediateTransaction<TValue>(
  database: DatabaseSync,
  operation: () => TValue,
): TValue {
  database.exec("BEGIN IMMEDIATE");

  try {
    const result = operation();
    database.exec("COMMIT");
    notifyWorkspaceCommit(database);
    walCheckpointSchedulers.get(database)?.();
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Quiet time after the last write before the log is folded into the file. */
const WAL_CHECKPOINT_IDLE_MS = 1_500;
/** A log this large is folded in at once, quiet or not. */
const WAL_CHECKPOINT_MAX_BYTES = 16 * 1024 * 1024;
const walCheckpointSchedulers = new WeakMap<DatabaseSync, () => void>();

/**
 * Folds the write-ahead log into the database once writes pause, instead of
 * inside whichever commit crossed SQLite's 1,000-page mark: that commit then
 * also copied the pages and synced the file, 26-500 ms on a 200 MB
 * workspace, in the middle of a click. A log past the size cap is folded at
 * once. Returns the function that stops the schedule.
 */
export function scheduleWalCheckpoints(
  database: DatabaseSync,
  filePath: string,
  options: {
    /** Fold the log in from a worker thread (the app); tests may keep it inline. */
    background?: boolean;
  } = {},
): () => Promise<void> {
  database.exec("PRAGMA wal_autocheckpoint = 0");
  const walPath = `${filePath}-wal`;
  let urgentGeneration: string | null = null;
  let urgentFrame = 0;
  let fallbackHighWater = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const inline = () => {
    try {
      database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    } catch (error) {
      console.warn(
        "[JobFinderRepository] Write-ahead log checkpoint failed.",
        error,
      );
    }
  };
  const background =
    options.background === false
      ? null
      : createBackgroundCheckpointer(filePath, inline);
  const checkpoint = () => {
    timer = null;
    if (background) {
      background.run();
      return;
    }
    if (database.isTransaction) {
      timer = setTimeout(checkpoint, WAL_CHECKPOINT_IDLE_MS);
      return;
    }
    inline();
  };
  walCheckpointSchedulers.set(database, () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const progress = readWalCheckpointProgress(filePath);
    let urgent = false;
    if (progress) {
      if (urgentGeneration !== progress.generation) {
        urgentGeneration = progress.generation;
        urgentFrame = 0;
      }
      // Backfill is completed checkpoint work, even if another connection did
      // it. A pinned reader cannot cause the same frames to request endlessly;
      // another cap's worth of new frames may retry while it remains pinned.
      urgent = (progress.frames - Math.max(urgentFrame, progress.backfilled)) * progress.frameBytes >= WAL_CHECKPOINT_MAX_BYTES;
      if (urgent) urgentFrame = progress.frames;
    } else {
      // Missing/unpublished WAL-index headers are only a scheduling failure.
      // Retain idle checkpoints and bound further physical file growth.
      let bytes = 0;
      try { bytes = statSync(walPath).size; } catch { /* No WAL yet. */ }
      if (bytes < fallbackHighWater) fallbackHighWater = bytes;
      urgent = bytes - fallbackHighWater >= WAL_CHECKPOINT_MAX_BYTES;
      if (urgent) fallbackHighWater = bytes;
    }
    if (urgent) {
      checkpoint();
    }
    timer = setTimeout(checkpoint, WAL_CHECKPOINT_IDLE_MS);
    timer.unref?.();
  });
  return async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    walCheckpointSchedulers.delete(database);
    await background?.stop();
  };
}

// Runs in the worker: its own connection, used only to fold the log in.
const CHECKPOINT_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const database = new DatabaseSync(workerData.filePath);
database.exec("PRAGMA busy_timeout = 1000");
parentPort.on("message", (message) => {
  if (message === "close") {
    database.close();
    parentPort.close();
    return;
  }
  let ok = true;
  try {
    database.exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch {
    ok = false;
  }
  parentPort.postMessage(ok);
});
`;

/**
 * Folds the log in from a worker thread with its own connection. Copying the
 * log into a 200-500 MB file and syncing it held main 180-220 ms each time
 * the log passed the size cap (a profile save restaling every draft, a
 * search). SQLite lets another connection checkpoint beside the app's reads
 * and writes. If the worker cannot run, the checkpoint runs inline.
 */
function createBackgroundCheckpointer(filePath: string, inline: () => void) {
  let worker: Worker | null = null;
  let failed = false;
  let busy = false;
  let again = false;

  function start(): Worker | null {
    try {
      const started = new Worker(CHECKPOINT_WORKER_SOURCE, {
        eval: true,
        workerData: { filePath },
      });
      started.on("message", (ok: unknown) => {
        busy = false;
        if (ok !== true) failed = true;
        if (again) {
          again = false;
          run();
        }
      });
      started.on("error", () => {
        failed = true;
        busy = false;
        if (worker === started) worker = null;
      });
      started.unref();
      return started;
    } catch {
      failed = true;
      return null;
    }
  }

  function run(): void {
    if (failed) {
      inline();
      return;
    }
    worker ??= start();
    if (!worker) {
      inline();
      return;
    }
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    worker.postMessage("checkpoint");
  }

  /**
   * Closes the worker's connection before the app closes its own, so the
   * app's close is the last one and still folds in and removes the log.
   */
  async function stop(): Promise<void> {
    const stopping = worker;
    worker = null;
    failed = true;
    if (!stopping) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        void stopping.terminate().finally(resolve);
      }, 5_000);
      stopping.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      stopping.postMessage("close");
    });
  }

  return { run, stop };
}

export function syncApprovedResumeExportsForJob(
  database: DatabaseSync,
  jobId: string,
  approvedExportId: string | null = null,
): void {
  database
    .prepare(
      `UPDATE resume_export_artifacts
       SET is_approved = CASE WHEN id = ? THEN 1 ELSE 0 END,
           value = json_set(
             value,
             '$.isApproved',
             CASE WHEN id = ? THEN json('true') ELSE json('false') END
           )
       WHERE job_id = ?`,
    )
    .run(approvedExportId, approvedExportId, jobId);
}

export function resolveApprovedExportId(
  database: DatabaseSync,
  draft: { approvedExportId: string | null; id: string; jobId: string },
): string | null {
  if (!draft.approvedExportId) {
    return null;
  }

  const matchingArtifact = listCollectionValues(
    database,
    "resume_export_artifacts",
    ResumeExportArtifactSchema,
    {
      whereSql: "id = ? AND draft_id = ? AND job_id = ?",
      params: [draft.approvedExportId, draft.id, draft.jobId],
      orderBySql: "exported_at DESC, id ASC",
    },
  )[0];

  return matchingArtifact?.id ?? null;
}

export const INDEXED_COLLECTION_CONFIGS = {
  ...APPLY_INDEXED_COLLECTION_CONFIGS,
  ...USER_ACTION_INDEXED_COLLECTION_CONFIGS,
  application_answer_snapshots: {
    columnNames: [
      "profile_id",
      "revision",
      "digest",
      "source_profile_revision",
      "approved_at",
    ],
    getColumns: (value: unknown) => {
      const snapshot = ApprovedApplicationAnswerSnapshotSchema.parse(
        cloneValue(value),
      );
      return [
        snapshot.profileId,
        snapshot.revision,
        snapshot.digest,
        snapshot.sourceProfileRevision,
        snapshot.approvedAt,
      ];
    },
  },
  application_authority_envelopes: {
    columnNames: ["revision", "status"],
    getColumns: (value: unknown) => {
      const envelope = ApplicationAuthorityEnvelopeSchema.parse(
        cloneValue(value),
      );
      return [envelope.revision, envelope.status];
    },
  },
  submission_preflights: {
    columnNames: [
      "idempotency_key",
      "run_id",
      "job_id",
      "result_id",
      "application_record_id",
      "authority_envelope_id",
      "authority_revision",
      "created_at",
    ],
    getColumns: (value: unknown) => {
      const preflight = SubmissionPreflightRecordSchema.parse(
        cloneValue(value),
      );
      return [
        preflight.idempotencyKey,
        preflight.runId,
        preflight.jobId,
        preflight.resultId,
        preflight.applicationRecordId,
        preflight.authorityEnvelopeId,
        preflight.authorityRevision,
        preflight.createdAt,
      ];
    },
  },
  submission_execution_grants: {
    columnNames: [
      "preflight_id",
      "idempotency_key",
      "status",
      "granted_at",
      "expires_at",
    ],
    getColumns: (value: unknown) => {
      const grant = SubmissionExecutionGrantSchema.parse(cloneValue(value));
      return [
        grant.preflightId,
        grant.idempotencyKey,
        grant.status,
        grant.grantedAt,
        grant.expiresAt,
      ];
    },
  },
  submission_idempotency_records: {
    columnNames: [
      "idempotency_key",
      "preflight_id",
      "revision",
      "status",
      "updated_at",
    ],
    getColumns: (value: unknown) => {
      const record = SubmissionIdempotencyRecordSchema.parse(cloneValue(value));
      return [
        record.idempotencyKey,
        record.preflightId,
        record.revision,
        record.status,
        record.updatedAt,
      ];
    },
  },
  submission_armed_markers: {
    columnNames: ["idempotency_key", "preflight_id", "armed_at"],
    getColumns: (value: unknown) => {
      const marker = SubmissionArmedMarkerSchema.parse(cloneValue(value));
      return [marker.idempotencyKey, marker.preflightId, marker.armedAt];
    },
  },
  submission_outcome_records: {
    columnNames: [
      "preflight_id",
      "idempotency_key",
      "run_id",
      "job_id",
      "result_id",
      "application_record_id",
      "attempted_at",
      "outcome",
    ],
    getColumns: (value: unknown) => {
      const outcome = SubmissionOutcomeRecordSchema.parse(cloneValue(value));
      return [
        outcome.preflightId,
        outcome.idempotencyKey,
        outcome.runId,
        outcome.jobId,
        outcome.resultId,
        outcome.applicationRecordId,
        outcome.attemptedAt,
        outcome.outcome,
      ];
    },
  },
  profile_copilot_messages: {
    columnNames: ["created_at"],
    getColumns: (value: unknown) => {
      const message = ProfileCopilotMessageSchema.parse(cloneValue(value));
      return [message.createdAt];
    },
  },
  profile_revisions: {
    columnNames: ["created_at"],
    getColumns: (value: unknown) => {
      const revision = ProfileRevisionSchema.parse(cloneValue(value));
      return [revision.createdAt];
    },
  },
  resume_assistant_messages: {
    columnNames: ["job_id", "created_at"],
    getColumns: (value: unknown) => {
      const message = ResumeAssistantMessageSchema.parse(cloneValue(value));
      return [message.jobId, message.createdAt];
    },
  },
  resume_draft_revisions: {
    columnNames: ["draft_id", "created_at"],
    getColumns: (value: unknown) => {
      const revision = ResumeDraftRevisionSchema.parse(cloneValue(value));
      return [revision.draftId, revision.createdAt];
    },
  },
  resume_drafts: {
    columnNames: ["job_id", "created_at", "updated_at"],
    getColumns: (value: unknown) => {
      const draft = ResumeDraftSchema.parse(cloneValue(value));
      return [draft.jobId, draft.createdAt, draft.updatedAt];
    },
  },
  resume_export_artifacts: {
    columnNames: ["job_id", "draft_id", "exported_at", "is_approved"],
    getColumns: (value: unknown) => {
      const artifact = ResumeExportArtifactSchema.parse(cloneValue(value));
      return [
        artifact.jobId,
        artifact.draftId,
        artifact.exportedAt,
        artifact.isApproved ? 1 : 0,
      ];
    },
  },
  resume_import_runs: {
    columnNames: ["source_resume_id", "started_at", "status"],
    getColumns: (value: unknown) => {
      const run = ResumeImportRunSchema.parse(cloneValue(value));
      return [run.sourceResumeId, run.startedAt, run.status];
    },
  },
  resume_import_document_bundles: {
    columnNames: ["run_id", "source_resume_id", "created_at"],
    getColumns: (value: unknown) => {
      const bundle = ResumeDocumentBundleSchema.parse(cloneValue(value));
      return [bundle.runId, bundle.sourceResumeId, bundle.createdAt];
    },
  },
  resume_import_field_candidates: {
    columnNames: ["run_id", "resolution", "created_at"],
    getColumns: (value: unknown) => {
      const candidate = ResumeImportFieldCandidateSchema.parse(
        cloneValue(value),
      );
      return [candidate.runId, candidate.resolution, candidate.createdAt];
    },
  },
  resume_research_artifacts: {
    columnNames: ["job_id", "fetched_at"],
    getColumns: (value: unknown) => {
      const artifact = ResumeResearchArtifactSchema.parse(cloneValue(value));
      return [artifact.jobId, artifact.fetchedAt];
    },
  },
  resume_validation_results: {
    columnNames: ["draft_id", "validated_at"],
    getColumns: (value: unknown) => {
      const validation = ResumeValidationResultSchema.parse(cloneValue(value));
      return [validation.draftId, validation.validatedAt];
    },
  },
} as const;

export type PersistedTableName =
  | "prepared_application_forms"
  | "application_answer_snapshots"
  | "application_authority_envelopes"
  | "apply_runs"
  | "apply_job_results"
  | "apply_submit_approvals"
  | "application_question_records"
  | "application_answer_records"
  | "application_artifact_refs"
  | "application_replay_checkpoints"
  | "application_consent_requests"
  | "tailored_assets"
  | "resume_drafts"
  | "resume_draft_revisions"
  | "resume_export_artifacts"
  | "resume_import_runs"
  | "resume_import_document_bundles"
  | "resume_import_field_candidates"
  | "resume_research_artifacts"
  | "resume_validation_results"
  | "resume_assistant_messages"
  | "profile_copilot_messages"
  | "profile_revisions"
  | "application_records"
  | "application_attempts"
  | "submission_armed_markers"
  | "submission_execution_grants"
  | "submission_idempotency_records"
  | "submission_outcome_records"
  | "submission_preflights"
  | "source_debug_runs"
  | "source_debug_attempts"
  | "source_instruction_artifacts"
  | "saved_jobs"
  | "source_debug_evidence_refs";

export type FileRepositoryContext = {
  database: DatabaseSync;
  filePath: string;
  upsertPersistedValue: (
    tableName: PersistedTableName,
    value: { id: string },
  ) => Promise<void>;
  writePersistedValue: (
    tableName: PersistedTableName,
    value: { id: string },
  ) => void;
};

export function createFileRepositoryContext(input: {
  database: DatabaseSync;
  filePath: string;
}): FileRepositoryContext {
  const { database, filePath } = input;

  function writePersistedValue(
    tableName: PersistedTableName,
    value: { id: string },
  ): void {
    const indexedConfig =
      tableName in INDEXED_COLLECTION_CONFIGS
        ? INDEXED_COLLECTION_CONFIGS[
            tableName as keyof typeof INDEXED_COLLECTION_CONFIGS
          ]
        : null;

    if (indexedConfig) {
      upsertIndexedCollectionValue(database, tableName, value, indexedConfig);
      return;
    }

    upsertCollectionValue(database, tableName, value);
  }

  function upsertPersistedValue(
    tableName: PersistedTableName,
    value: { id: string },
  ): Promise<void> {
    runImmediateTransaction(database, () => {
      writePersistedValue(tableName, value);
    });

    return secureDatabaseFile(filePath);
  }

  return {
    database,
    filePath,
    upsertPersistedValue,
    writePersistedValue,
  };
}
