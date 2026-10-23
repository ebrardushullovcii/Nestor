import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
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
  getSingletonValue,
  getSingletonValueWithRevision,
  listCollectionValues,
  parsePersistedRowValue,
  listValues,
  upsertIndexedCollectionValue,
  saveSingletonValue,
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
  | "listResumeResearchArtifacts"
  | "upsertResumeResearchArtifact"
  | "listResumeImportRuns"
  | "getLatestResumeImportRun"
  | "upsertResumeImportRun"
  | "listResumeImportDocumentBundles"
  | "listResumeImportFieldCandidates"
  | "replaceResumeImportRunArtifacts"
  | "finalizeResumeImportRun"
  | "listResumeValidationResults"
  | "listLatestResumeValidationResults"
  | "upsertResumeValidationResult"
  | "listResumeAssistantMessages"
  | "upsertResumeAssistantMessage"
  | "listProfileCopilotMessages"
  | "upsertProfileCopilotMessage"
  | "listProfileRevisions"
  | "upsertProfileRevision"
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
): FileRepositoryResumeMethods {
  const { database, filePath, upsertPersistedValue, writePersistedValue } =
    context;
  // Canonical, schema-normalized values, keyed by the exact stored JSON.
  // Every read still checks SQLite and returns its own mutable clone. This
  // only avoids parsing the same large draft several times during approval.
  const draftReads = new Map<string, { json: string; draft: ResumeDraft }>();

  return {
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
    listResumeImportRuns(options) {
      const whereParts: string[] = [];
      const params: Array<string | number> = [];

      if (options?.sourceResumeId) {
        whereParts.push("source_resume_id = ?");
        params.push(options.sourceResumeId);
      }

      if (options?.statuses && options.statuses.length > 0) {
        const placeholders = options.statuses.map(() => "?").join(", ");
        whereParts.push(`status IN (${placeholders})`);
        params.push(...options.statuses);
      }

      const limitSql =
        typeof options?.limit === "number" && options.limit >= 0
          ? ` LIMIT ${Math.floor(options.limit)}`
          : "";

      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "resume_import_runs",
            ResumeImportRunSchema,
            {
              ...(whereParts.length > 0
                ? { whereSql: whereParts.join(" AND "), params }
                : {}),
              orderBySql: `started_at DESC, id ASC${limitSql}`,
            },
          ),
        ),
      );
    },
    getLatestResumeImportRun(sourceResumeId) {
      const runs = listCollectionValues(
        database,
        "resume_import_runs",
        ResumeImportRunSchema,
        {
          ...(sourceResumeId
            ? { whereSql: "source_resume_id = ?", params: [sourceResumeId] }
            : {}),
          orderBySql: "started_at DESC, id ASC",
        },
      );
      return Promise.resolve(runs[0] ?? null);
    },
    upsertResumeImportRun(run) {
      const normalizedRun = ResumeImportRunSchema.parse(cloneValue(run));
      return upsertPersistedValue("resume_import_runs", normalizedRun);
    },
    listResumeImportDocumentBundles(options) {
      const whereParts: string[] = [];
      const params: Array<string> = [];

      if (options?.runId) {
        whereParts.push("run_id = ?");
        params.push(options.runId);
      }

      if (options?.sourceResumeId) {
        whereParts.push("source_resume_id = ?");
        params.push(options.sourceResumeId);
      }

      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "resume_import_document_bundles",
            ResumeDocumentBundleSchema,
            {
              ...(whereParts.length > 0
                ? { whereSql: whereParts.join(" AND "), params }
                : {}),
              orderBySql: "created_at DESC, id ASC",
            },
          ),
        ),
      );
    },
    listResumeImportFieldCandidates(options) {
      const whereParts: string[] = [];
      const params: Array<string> = [];

      if (options?.runId) {
        whereParts.push("run_id = ?");
        params.push(options.runId);
      }

      const normalizedResolutions = options?.resolution
        ? [options.resolution]
        : options?.resolutions?.length
          ? [...options.resolutions]
          : [];

      if (normalizedResolutions.length === 1) {
        whereParts.push("resolution = ?");
        params.push(normalizedResolutions[0]!);
      } else if (normalizedResolutions.length > 1) {
        const placeholders = normalizedResolutions.map(() => "?").join(", ");
        whereParts.push(`resolution IN (${placeholders})`);
        params.push(...normalizedResolutions);
      }

      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "resume_import_field_candidates",
            ResumeImportFieldCandidateSchema,
            {
              ...(whereParts.length > 0
                ? { whereSql: whereParts.join(" AND "), params }
                : {}),
              orderBySql: "created_at DESC, id ASC",
            },
          ),
        ),
      );
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

      runImmediateTransaction(database, () => {
        writePersistedValue("resume_import_runs", normalizedRun);
        database
          .prepare(
            "DELETE FROM resume_import_document_bundles WHERE run_id = ?",
          )
          .run(normalizedRun.id);
        database
          .prepare(
            "DELETE FROM resume_import_field_candidates WHERE run_id = ?",
          )
          .run(normalizedRun.id);

        for (const bundle of normalizedBundles) {
          writePersistedValue("resume_import_document_bundles", bundle);
        }

        for (const candidate of normalizedCandidates) {
          writePersistedValue("resume_import_field_candidates", candidate);
        }
      });

      return secureDatabaseFile(filePath);
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

      const outcome = runImmediateTransaction<
        | {
            status: "applied";
            profile: typeof normalizedProfile;
            searchPreferences: typeof normalizedSearchPreferences;
            revision: number;
          }
        | {
            status: "stale";
            profile: typeof normalizedProfile;
            searchPreferences: typeof normalizedSearchPreferences;
            revision: number;
          }
      >(database, () => {
        const persistedProfile = getSingletonValueWithRevision(
          database,
          "profile",
          CandidateProfileSchema,
        );
        const currentProfile = persistedProfile.value ?? normalizedProfile;
        const currentSearchPreferences =
          getSingletonValue(
            database,
            "search_preferences",
            JobSearchPreferencesSchema,
          ) ?? normalizedSearchPreferences;

        if (
          expectedProfileRevision !== undefined &&
          expectedProfileRevision !== persistedProfile.revision
        ) {
          return {
            status: "stale" as const,
            profile: currentProfile,
            searchPreferences: currentSearchPreferences,
            revision: persistedProfile.revision,
          };
        }

        saveSingletonValue(database, "profile", normalizedProfile);
        saveSingletonValue(
          database,
          "search_preferences",
          normalizedSearchPreferences,
        );
        writePersistedValue("resume_import_runs", normalizedRun);
        database
          .prepare(
            "DELETE FROM resume_import_document_bundles WHERE run_id = ?",
          )
          .run(normalizedRun.id);
        database
          .prepare(
            "DELETE FROM resume_import_field_candidates WHERE run_id = ?",
          )
          .run(normalizedRun.id);

        for (const bundle of normalizedBundles) {
          writePersistedValue("resume_import_document_bundles", bundle);
        }

        for (const candidate of normalizedCandidates) {
          writePersistedValue("resume_import_field_candidates", candidate);
        }

        return {
          status: "applied" as const,
          profile: normalizedProfile,
          searchPreferences: normalizedSearchPreferences,
          revision: persistedProfile.revision + 1,
        };
      });

      if (outcome.status === "stale") {
        return Promise.resolve(outcome);
      }

      return secureDatabaseFile(filePath).then(() => outcome);
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
    listProfileCopilotMessages() {
      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "profile_copilot_messages",
            ProfileCopilotMessageSchema,
            {
              orderBySql: "created_at ASC, id ASC",
            },
          ),
        ),
      );
    },
    upsertProfileCopilotMessage(message) {
      const normalizedMessage = ProfileCopilotMessageSchema.parse(
        cloneValue(message),
      );
      return upsertPersistedValue(
        "profile_copilot_messages",
        normalizedMessage,
      );
    },
    listProfileRevisions() {
      return Promise.resolve(
        cloneValue(
          listCollectionValues(
            database,
            "profile_revisions",
            ProfileRevisionSchema,
            {
              orderBySql: "created_at DESC, id ASC",
            },
          ),
        ),
      );
    },
    upsertProfileRevision(revision) {
      const normalizedRevision = ProfileRevisionSchema.parse(
        cloneValue(revision),
      );
      return upsertPersistedValue("profile_revisions", normalizedRevision);
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
      const draftJson = JSON.stringify(normalizedDraft);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const revisionJson = JSON.stringify(normalizedRevision);
      await new Promise<void>((resolve) => setImmediate(resolve));
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
          ? ResumeDraftRevisionSchema.parse(JSON.parse(coalescedRow.value))
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
            serializedValue:
              persistedDraft === normalizedDraft
                ? draftJson
                : JSON.stringify(persistedDraft),
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
            serializedValue: revisionJson,
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
        if (profile) saveSingletonValue(database, "profile", profile);
        if (preferences)
          saveSingletonValue(database, "search_preferences", preferences);
      });
      publish();

      await secureDatabaseFile(filePath);
      scheduleApprovalFold();
    },
  };
}
