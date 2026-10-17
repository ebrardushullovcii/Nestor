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
} from "@nestor/contracts";

import { secureDatabaseFile } from "./internal/migrations";
import { TAILORED_ASSET_JOB_ID_SQL } from "./internal/tailored-asset-storage";
import {
  cloneValue,
  getSingletonValue,
  getSingletonValueWithRevision,
  listCollectionValues,
  listValues,
  saveSingletonValue,
} from "./internal/state";
import type { JobFinderRepository } from "./repository-types";
import { prunePersistedResumeDraftRevisions } from "./resume-draft-revision-retention";
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
>;

export function createFileRepositoryResumeMethods(
  context: FileRepositoryContext,
): FileRepositoryResumeMethods {
  const { database, filePath, upsertPersistedValue, writePersistedValue } =
    context;

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
      const draft = listCollectionValues(
        database,
        "resume_drafts",
        ResumeDraftSchema,
        {
          whereSql: "job_id = ?",
          params: [jobId],
          orderBySql: "updated_at DESC, id ASC",
        },
      )[0];
      return Promise.resolve(draft ? cloneValue(draft) : null);
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
    applyResumePatchWithRevision({
      expectedDraftUpdatedAt,
      draft,
      revision,
      validation,
      tailoredAsset,
    }) {
      const normalizedDraft = ResumeDraftSchema.parse(
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
      const normalizedAsset = tailoredAsset
        ? TailoredAssetSchema.parse(cloneValue(tailoredAsset))
        : null;

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

      runImmediateTransaction(database, () => {
        const currentPersistedDraft = listCollectionValues(
          database,
          "resume_drafts",
          ResumeDraftSchema,
          {
            orderBySql: "id ASC",
            whereSql: "id = ?",
            params: [normalizedDraft.id],
          },
        ).find((entry) => entry.id === normalizedDraft.id);
        if (
          !currentPersistedDraft ||
          currentPersistedDraft.updatedAt !== expectedDraftUpdatedAt
        ) {
          throw new Error(
            "Resume draft changed before this edit could be saved. Reload the workspace and try again.",
          );
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

        writePersistedValue("resume_drafts", persistedDraft);
        writePersistedValue("resume_draft_revisions", normalizedRevision);
        prunePersistedResumeDraftRevisions(
          database,
          normalizedRevision.draftId,
        );
        writePersistedValue("resume_validation_results", normalizedValidation);
        if (normalizedAsset) {
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
  };
}
