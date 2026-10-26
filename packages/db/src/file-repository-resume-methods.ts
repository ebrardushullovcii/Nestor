import { createProfileStore } from "./job-store/profile-store";
import { createPreferencesStore } from "./job-store/preferences-store";
import type { JobStore } from "./job-store/job-store";
import { readResumeRevision } from "./internal/resume-revision-storage";
import { retainedResumeExportPaths } from "./resume-export-retention";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  ResumeAssistantMessageSchema,
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  ResumeExportArtifactSchema,
  ResumeResearchArtifactSchema,
  ResumeValidationResultSchema,
  TailoredAssetSchema,
  type ResumeDraft,
} from "@nestor/contracts";

import { secureDatabaseFile } from "./internal/migrations";
import { TAILORED_ASSET_JOB_ID_SQL } from "./internal/tailored-asset-storage";
import {
  resumeDraftValueSql,
  resumeDraftUpdatedAtSql,
} from "./internal/resume-approval-state";
import {
  cloneValue,
  listCollectionValues,
  parsePersistedRowValue,
  listValues,
  upsertIndexedCollectionValue,
} from "./internal/state";
import type { JobFinderRepository } from "./repository-types";
import {
  assertResumeRevisionCoalescing,
  prunePersistedResumeDraftRevisions,
} from "./resume-draft-revision-retention";
import {
  resolveApprovedExportId,
  runImmediateTransaction,
  syncApprovedResumeExportsForJob,
  type FileRepositoryContext,
} from "./file-repository-support";

type FileRepositoryResumeMethods = Pick<
  JobFinderRepository,
  | "listTailoredAssets"
  | "getTailoredAssetById"
  | "getTailoredAssetByJobId"
  | "upsertTailoredAsset"
  | "listResumeDrafts"
  | "getResumeDraftByJobId"
  | "upsertResumeDraft"
  | "listResumeDraftRevisions"
  | "getLatestResumeDraftRevisionId"
  | "upsertResumeDraftRevision"
  | "listResumeExportArtifacts"
  | "upsertResumeExportArtifact"
  | "listRetainedResumeExportPaths"
  | "listResumeResearchArtifacts"
  | "upsertResumeResearchArtifact"
  | "listResumeValidationResults"
  | "listLatestResumeValidationResults"
  | "upsertResumeValidationResult"
  | "listResumeAssistantMessages"
  | "upsertResumeAssistantMessage"
  | "saveResumeDraftWithValidation"
  | "applyResumePatchWithRevision"
  | "approveResumeExport"
  | "clearResumeApproval"
  | "staleResumeDrafts"
>;

export function createFileRepositoryResumeMethods(
  context: FileRepositoryContext,
  scheduleApprovalFold: () => void,
  foldApprovalChanges: () => () => void,
  store: JobStore,
): FileRepositoryResumeMethods {
  const { database, filePath, upsertPersistedValue, writePersistedValue } =
    context;
  // Canonical, schema-normalized values, keyed by the exact stored JSON.
  // Every read still checks SQLite and returns its own mutable clone. This
  // only avoids parsing the same large draft several times during approval.
  const draftReads = new Map<string, { json: string; draft: ResumeDraft }>();

  return {
    listRetainedResumeExportPaths() {
      const references = database
        .prepare(
          "SELECT json_extract(value, '$.approvedExportId') AS reference FROM resume_drafts WHERE json_extract(value, '$.approvedExportId') IS NOT NULL",
        )
        .all()
        .map((row) => String(row.reference));
      for (const table of [
        "application_records",
        "application_attempts",
        "apply_runs",
        "apply_job_results",
        "application_artifact_refs",
        "application_replay_checkpoints",
        "application_consent_requests",
        "submission_preflights",
        "submission_outcome_records",
        "application_answer_snapshots",
        "prepared_application_forms",
      ]) {
        const rows = database
          .prepare(
            `SELECT DISTINCT leaf.atom AS reference
          FROM ${table} AS record, json_tree(record.value) AS leaf
          WHERE leaf.type = 'text' AND (leaf.key IN ('filePath', 'storagePath')
            OR leaf.atom IN (SELECT id FROM resume_export_artifacts)
            OR leaf.atom IN (SELECT json_extract(value, '$.sha256') FROM resume_export_artifacts))`,
          )
          .all();
        for (const row of rows) references.push(String(row.reference));
      }
      return Promise.resolve(
        retainedResumeExportPaths({
          assets: database
            .prepare(
              "SELECT json_extract(value, '$.storagePath') AS storagePath FROM tailored_assets",
            )
            .all() as Array<{ storagePath: string | null }>,
          exports: database
            .prepare(
              `SELECT id, draft_id AS draftId, exported_at AS exportedAt, is_approved AS isApproved,
          json_extract(value, '$.format') AS format, json_extract(value, '$.filePath') AS filePath,
          json_extract(value, '$.sha256') AS sha256
          FROM resume_export_artifacts`,
            )
            .all()
            .map((row) => ({
              id: String(row.id),
              draftId: String(row.draftId),
              exportedAt: String(row.exportedAt),
              isApproved: Boolean(row.isApproved),
              format: row.format as "html" | "pdf",
              filePath: String(row.filePath),
              sha256: row.sha256 ? String(row.sha256) : null,
            })),
          references,
        }),
      );
    },
    getTailoredAssetById(assetId) {
      return Promise.resolve(
        listCollectionValues(database, "tailored_assets", TailoredAssetSchema, {
          whereSql: "id = ?",
          params: [assetId],
          orderBySql: "id",
          limit: 1,
        })[0] ?? null,
      );
    },
    getTailoredAssetByJobId(jobId) {
      return Promise.resolve(
        listCollectionValues(database, "tailored_assets", TailoredAssetSchema, {
          whereSql: `${TAILORED_ASSET_JOB_ID_SQL} = ?`,
          params: [jobId],
          orderBySql: "id",
          limit: 1,
        })[0] ?? null,
      );
    },
    listTailoredAssets() {
      return Promise.resolve(
        cloneValue(
          listValues(database, "tailored_assets", TailoredAssetSchema),
        ),
      );
    },
    upsertTailoredAsset(tailoredAsset) {
      const normalizedAsset = TailoredAssetSchema.parse(
        cloneValue(tailoredAsset),
      );
      return upsertPersistedValue("tailored_assets", normalizedAsset);
    },
    listResumeDrafts() {
      return Promise.resolve(
        cloneValue(
          listCollectionValues(database, "resume_drafts", ResumeDraftSchema, {
            orderBySql: "updated_at DESC, id ASC",
          }),
        ),
      );
    },
    getResumeDraftByJobId(jobId) {
      const row = database
        .prepare(
          `SELECT id, ${resumeDraftValueSql} AS value FROM resume_drafts WHERE job_id = ? ORDER BY ${resumeDraftUpdatedAtSql} DESC, id ASC LIMIT 1`,
        )
        .get(jobId);
      if (!row) {
        draftReads.delete(jobId);
        return Promise.resolve(null);
      }
      const json = String(row.value);
      const cached = draftReads.get(jobId);
      if (cached?.json === json)
        return Promise.resolve(cloneValue(cached.draft));
      const draft = parsePersistedRowValue({
        database,
        tableName: "resume_drafts",
        rowId: String(row.id),
        rawValue: json,
        schema: ResumeDraftSchema,
      });
      draftReads.delete(jobId);
      draftReads.set(jobId, { json, draft });
      if (draftReads.size > 8)
        draftReads.delete(draftReads.keys().next().value!);
      return Promise.resolve(cloneValue(draft));
    },
    upsertResumeDraft(draft) {
      const normalizedDraft = ResumeDraftSchema.parse(cloneValue(draft));
      return upsertPersistedValue("resume_drafts", normalizedDraft);
    },
    listResumeDraftRevisions(draftId) {
      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "resume_draft_revisions",
            ResumeDraftRevisionSchema,
            draftId
              ? {
                  whereSql: "draft_id = ?",
                  params: [draftId],
                  orderBySql: "created_at DESC, id ASC",
                }
              : { orderBySql: "created_at DESC, id ASC" },
          ),
        ),
      );
    },
    getLatestResumeDraftRevisionId(draftId) {
      // Every save asks for this; reading the up to 100 kept revisions with
      // their full drafts to take the first id cost ~140 ms on a long history.
      const row = database
        .prepare(
          `SELECT id FROM resume_draft_revisions
           WHERE draft_id = ?
           ORDER BY created_at DESC, id ASC
           LIMIT 1`,
        )
        .get(draftId) as { id?: unknown } | undefined;
      return Promise.resolve(typeof row?.id === "string" ? row.id : null);
    },
    upsertResumeDraftRevision(revision) {
      const normalizedRevision = ResumeDraftRevisionSchema.parse(
        cloneValue(revision),
      );
      runImmediateTransaction(database, () => {
        writePersistedValue("resume_draft_revisions", normalizedRevision);
        prunePersistedResumeDraftRevisions(
          database,
          normalizedRevision.draftId,
        );
      });
      return secureDatabaseFile(filePath);
    },
    listResumeExportArtifacts(options) {
      const whereParts: string[] = [];
      const params: Array<string> = [];

      if (options?.jobId) {
        whereParts.push("job_id = ?");
        params.push(options.jobId);
      }

      if (options?.draftId) {
        whereParts.push("draft_id = ?");
        params.push(options.draftId);
      }

      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "resume_export_artifacts",
            ResumeExportArtifactSchema,
            {
              ...(whereParts.length > 0
                ? { whereSql: whereParts.join(" AND "), params }
                : {}),
              orderBySql: "exported_at DESC, id ASC",
            },
          ),
        ),
      );
    },
    upsertResumeExportArtifact(artifact) {
      const normalizedArtifact = ResumeExportArtifactSchema.parse(
        cloneValue(artifact),
      );

      if (normalizedArtifact.isApproved) {
        throw new Error(
          "Approved resume exports must be written through approveResumeExport().",
        );
      }

      return upsertPersistedValue(
        "resume_export_artifacts",
        normalizedArtifact,
      );
    },
    listResumeResearchArtifacts(jobId) {
      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "resume_research_artifacts",
            ResumeResearchArtifactSchema,
            jobId
              ? {
                  whereSql: "job_id = ?",
                  params: [jobId],
                  orderBySql: "fetched_at DESC, id ASC",
                }
              : { orderBySql: "fetched_at DESC, id ASC" },
          ),
        ),
      );
    },
    upsertResumeResearchArtifact(artifact) {
      const normalizedArtifact = ResumeResearchArtifactSchema.parse(
        cloneValue(artifact),
      );
      return upsertPersistedValue(
        "resume_research_artifacts",
        normalizedArtifact,
      );
    },
    listResumeValidationResults(draftId) {
      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "resume_validation_results",
            ResumeValidationResultSchema,
            draftId
              ? {
                  whereSql: "draft_id = ?",
                  params: [draftId],
                  orderBySql: "validated_at DESC, id ASC",
                }
              : { orderBySql: "validated_at DESC, id ASC" },
          ),
        ),
      );
    },
    listLatestResumeValidationResults(draftIds) {
      if (draftIds.length === 0) return Promise.resolve([]);
      return Promise.resolve(
        listCollectionValues(
          database,
          "resume_validation_results",
          ResumeValidationResultSchema,
          {
            whereSql: `id IN (
            SELECT (
              SELECT id FROM resume_validation_results
              WHERE draft_id = requested.value
              ORDER BY validated_at DESC, id ASC LIMIT 1
            ) FROM json_each(?) AS requested
          )`,
            params: [JSON.stringify([...new Set(draftIds)])],
            orderBySql: "validated_at DESC, id ASC",
          },
        ),
      );
    },
    upsertResumeValidationResult(validationResult) {
      const normalizedValidation = ResumeValidationResultSchema.parse(
        cloneValue(validationResult),
      );
      return upsertPersistedValue(
        "resume_validation_results",
        normalizedValidation,
      );
    },
    listResumeAssistantMessages(jobId) {
      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "resume_assistant_messages",
            ResumeAssistantMessageSchema,
            jobId
              ? {
                  whereSql: "job_id = ?",
                  params: [jobId],
                  orderBySql: "created_at ASC, id ASC",
                }
              : { orderBySql: "created_at ASC, id ASC" },
          ),
        ),
      );
    },
    upsertResumeAssistantMessage(message) {
      const normalizedMessage = ResumeAssistantMessageSchema.parse(
        cloneValue(message),
      );
      return upsertPersistedValue(
        "resume_assistant_messages",
        normalizedMessage,
      );
    },
    saveResumeDraftWithValidation({ draft, validation, tailoredAsset }) {
      const normalizedDraft = ResumeDraftSchema.parse(
        cloneValue(
          draft.approvedExportId
            ? draft
            : { ...draft, approvedAt: null, approvedExportId: null },
        ),
      );
      const normalizedValidation = ResumeValidationResultSchema.parse(
        cloneValue(validation),
      );
      const normalizedAsset = tailoredAsset
        ? TailoredAssetSchema.parse(cloneValue(tailoredAsset))
        : null;

      if (normalizedValidation.draftId !== normalizedDraft.id) {
        throw new Error(
          "Resume validation result does not belong to the provided draft.",
        );
      }

      if (normalizedAsset && normalizedAsset.jobId !== normalizedDraft.jobId) {
        throw new Error(
          "Tailored asset job does not match the provided draft.",
        );
      }

      runImmediateTransaction(database, () => {
        const approvedExportId = resolveApprovedExportId(
          database,
          normalizedDraft,
        );
        const persistedDraft =
          approvedExportId === normalizedDraft.approvedExportId
            ? normalizedDraft
            : ResumeDraftSchema.parse(
                cloneValue({
                  ...normalizedDraft,
                  approvedAt: null,
                  approvedExportId,
                }),
              );
        syncApprovedResumeExportsForJob(
          database,
          persistedDraft.jobId,
          persistedDraft.approvedExportId,
        );

        writePersistedValue("resume_drafts", persistedDraft);
        writePersistedValue("resume_validation_results", normalizedValidation);
        if (normalizedAsset) {
          writePersistedValue("tailored_assets", normalizedAsset);
        }
      });

      return secureDatabaseFile(filePath);
    },
    async applyResumePatchWithRevision({
      coalesceRevision,
      expectedDraftUpdatedAt,
      draft,
      revision,
      validation,
      tailoredAsset,
    }) {
      const normalizedDraft = ResumeDraftSchema.parse(
        draft.approvedExportId
          ? draft
          : { ...draft, approvedAt: null, approvedExportId: null },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const normalizedRevision = ResumeDraftRevisionSchema.parse(revision);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const normalizedValidation =
        ResumeValidationResultSchema.parse(validation);
      const normalizedAsset = tailoredAsset
        ? TailoredAssetSchema.parse(tailoredAsset)
        : null;

      // Schemas already return independent values. Prepare their JSON and
      // index columns before the transaction, with turns between large rows.

      const validationJson = JSON.stringify(normalizedValidation);
      await new Promise<void>((resolve) => setImmediate(resolve));

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

      if (normalizedAsset && normalizedAsset.jobId !== normalizedDraft.jobId) {
        throw new Error(
          "Tailored asset job does not match the provided draft.",
        );
      }

      // Validate the retained snapshot outside the transaction. Recheck its
      // exact stored bytes inside it so another connection cannot change it.
      const latestRevisionRow = () =>
        database
          .prepare(
            "SELECT id, value FROM resume_draft_revisions WHERE draft_id = ? ORDER BY created_at DESC, id ASC LIMIT 1",
          )
          .get(normalizedDraft.id) as { id: string; value: string } | undefined;
      const coalescedRow = coalesceRevision ? latestRevisionRow() : undefined;
      if (coalesceRevision) {
        const previous = coalescedRow
          ? readResumeRevision(
              database,
              String(coalescedRow.id),
              String(coalescedRow.value),
            )
          : undefined;
        assertResumeRevisionCoalescing(
          previous,
          normalizedRevision,
          coalesceRevision,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      runImmediateTransaction(database, () => {
        // CAS needs the timestamp, not another parse of the entire draft.
        const currentPersistedDraft = database
          .prepare(
            `SELECT ${resumeDraftUpdatedAtSql} AS updated_at FROM resume_drafts WHERE id = ?`,
          )
          .get(normalizedDraft.id) as { updated_at: string } | undefined;
        if (
          !currentPersistedDraft ||
          currentPersistedDraft.updated_at !== expectedDraftUpdatedAt
        ) {
          throw new Error(
            "Resume draft changed before this edit could be saved. Reload the workspace and try again.",
          );
        }

        if (coalesceRevision) {
          const current = latestRevisionRow();
          if (
            !current ||
            current.id !== coalescedRow?.id ||
            current.value !== coalescedRow.value
          ) {
            throw new Error(
              "Resume edit history changed before this autosave could be grouped.",
            );
          }
        }

        const approvedExportId = resolveApprovedExportId(
          database,
          normalizedDraft,
        );
        const persistedDraft =
          approvedExportId === normalizedDraft.approvedExportId
            ? normalizedDraft
            : ResumeDraftSchema.parse(
                cloneValue({
                  ...normalizedDraft,
                  approvedAt: null,
                  approvedExportId,
                }),
              );
        syncApprovedResumeExportsForJob(
          database,
          persistedDraft.jobId,
          persistedDraft.approvedExportId,
        );

        upsertIndexedCollectionValue(
          database,
          "resume_drafts",
          persistedDraft,
          {
            columnNames: ["job_id", "created_at", "updated_at"],
            getColumns: () => [
              persistedDraft.jobId,
              persistedDraft.createdAt,
              persistedDraft.updatedAt,
            ],
          },
        );
        upsertIndexedCollectionValue(
          database,
          "resume_draft_revisions",
          normalizedRevision,
          {
            columnNames: ["draft_id", "created_at"],
            getColumns: () => [
              normalizedRevision.draftId,
              normalizedRevision.createdAt,
            ],
          },
        );
        prunePersistedResumeDraftRevisions(
          database,
          normalizedRevision.draftId,
        );
        upsertIndexedCollectionValue(
          database,
          "resume_validation_results",
          normalizedValidation,
          {
            columnNames: ["draft_id", "validated_at"],
            getColumns: () => [
              normalizedValidation.draftId,
              normalizedValidation.validatedAt,
            ],
            serializedValue: validationJson,
          },
        );
        if (normalizedAsset) {
          // Small asset bridge; its generic writer owns the asset index.
          writePersistedValue("tailored_assets", normalizedAsset);
        }
      });

      return secureDatabaseFile(filePath);
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
      const normalizedValidation = validation
        ? ResumeValidationResultSchema.parse(cloneValue(validation))
        : null;
      const normalizedAsset = tailoredAsset
        ? TailoredAssetSchema.parse(cloneValue(tailoredAsset))
        : null;

      if (normalizedAsset && normalizedAsset.jobId !== normalizedDraft.jobId) {
        throw new Error(
          "Tailored asset job does not match the provided draft.",
        );
      }

      if (normalizedDraft.id !== normalizedArtifact.draftId) {
        throw new Error(
          "Approved export does not belong to the provided resume draft.",
        );
      }

      if (normalizedDraft.jobId !== normalizedArtifact.jobId) {
        throw new Error(
          "Approved export job does not match the provided resume draft.",
        );
      }

      if (
        normalizedValidation &&
        normalizedValidation.draftId !== normalizedDraft.id
      ) {
        throw new Error(
          "Resume validation result does not belong to the provided draft.",
        );
      }

      if (!normalizedArtifact.isApproved) {
        throw new Error(
          "Approved export artifacts must be persisted with isApproved=true.",
        );
      }

      runImmediateTransaction(database, () => {
        syncApprovedResumeExportsForJob(
          database,
          normalizedArtifact.jobId,
          normalizedArtifact.id,
        );
        writePersistedValue("resume_drafts", normalizedDraft);
        writePersistedValue("resume_export_artifacts", normalizedArtifact);
        if (normalizedValidation) {
          writePersistedValue(
            "resume_validation_results",
            normalizedValidation,
          );
        }
        if (normalizedAsset) {
          writePersistedValue("tailored_assets", normalizedAsset);
        }
      });

      return secureDatabaseFile(filePath);
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

      runImmediateTransaction(database, () => {
        syncApprovedResumeExportsForJob(database, normalizedDraft.jobId, null);

        writePersistedValue("resume_drafts", normalizedDraft);
        if (normalizedAsset) {
          writePersistedValue("tailored_assets", normalizedAsset);
        }
      });

      return secureDatabaseFile(filePath);
    },
    async staleResumeDrafts({
      draftIds,
      staleReason,
      updatedAt,
      profileInputs,
    }) {
      const profile = profileInputs
        ? CandidateProfileSchema.parse(cloneValue(profileInputs.profile))
        : null;
      const preferences = profileInputs?.searchPreferences
        ? JobSearchPreferencesSchema.parse(
            cloneValue(profileInputs.searchPreferences),
          )
        : null;
      const readJobId = database.prepare(
        "SELECT job_id FROM resume_drafts WHERE id = ?",
      );
      const markDraft = database.prepare(
        `INSERT INTO resume_draft_approval_state (draft_id, stale_reason, updated_at)
         VALUES (?, ?, ?) ON CONFLICT(draft_id) DO UPDATE
         SET stale_reason = excluded.stale_reason, updated_at = excluded.updated_at`,
      );
      const readFirstAssetId = database.prepare(
        `SELECT id FROM tailored_assets WHERE ${TAILORED_ASSET_JOB_ID_SQL} = ? ORDER BY id LIMIT 1`,
      );
      const clearAssetFile = database.prepare(
        `INSERT INTO tailored_asset_file_state (updated_at, asset_id) VALUES (?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET updated_at = excluded.updated_at`,
      );
      let publish = () => {};
      store.transaction(() =>
        runImmediateTransaction(database, () => {
          for (const draftId of new Set(draftIds)) {
            const row = readJobId.get(draftId);
            if (!row) continue;
            const jobId = String(row.job_id);
            syncApprovedResumeExportsForJob(database, jobId, null);
            markDraft.run(draftId, staleReason, updatedAt);
            const asset = readFirstAssetId.get(jobId);
            if (asset) clearAssetFile.run(updatedAt, String(asset.id));
          }
          publish = foldApprovalChanges();
          if (profile) createProfileStore(store).replace(profile);
          if (preferences)
            createPreferencesStore(store).goals.replace(preferences);
        }),
      );
      publish();

      await secureDatabaseFile(filePath);
      scheduleApprovalFold();
    },
  };
}
