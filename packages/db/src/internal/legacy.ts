import {
  AiApplyingBehaviorSchema,
  AiBehaviorPreferenceSchema,
  AiJobSearchBehaviorSchema,
  AiProfileAssistantBehaviorSchema,
  ApplicationAttemptSchema,
  ApplicationCrmSettingsSchema,
  ApplicationCrmStageDefinitionSchema,
  ApplicationRecordSchema,
  CandidateProfileSchema,
  CoverLetterPreferenceSchema,
  JobFinderDiscoveryStateSchema,
  JobFinderRepositoryStateSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ResumeAssistantMessageSchema,
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  ResumeExportArtifactSchema,
  ResumeResearchArtifactSchema,
  ResumeValidationResultSchema,
  SavedJobSchema,
  SourceDebugEvidenceRefSchema,
  SourceDebugRunRecordSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
  TailoredAssetSchema,
  type JobFinderDiscoveryState,
  type JobFinderSettings,
  type SourceDebugRunRecord,
} from "@nestor/contracts";
import { readFile } from "node:fs/promises";

import type { JobFinderRepositorySeed } from "../repository-types";

function cloneValue<TValue>(value: TValue): TValue {
  return structuredClone(value);
}

// Legacy JSON has no per-field migration history. Recover valid siblings
// instead of erasing every preference when one obsolete value fails parsing.
function recoverLegacySettings(
  value: unknown,
  seed: JobFinderSettings,
): JobFinderSettings {
  const parsed = JobFinderSettingsSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const conservativeBehavior = AiBehaviorPreferenceSchema.parse({
    applying: { coverLetterPolicy: "never", preApprovedDeclarations: [] },
  });
  const fallback = JobFinderSettingsSchema.parse({
    ...seed,
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
    aiBehavior: conservativeBehavior,
  });

  function recoverFields<T>(
    schema: {
      shape: Record<
        string,
        {
          safeParse: (
            input: unknown,
          ) => { success: true; data: unknown } | { success: false };
        }
      >;
      parse: (input: unknown) => T;
    },
    input: unknown,
    defaults: T,
  ): T {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return cloneValue(defaults);
    }
    const source = input as Record<string, unknown>;
    const defaultFields = defaults as Record<string, unknown>;
    return schema.parse(
      Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => {
          const result = field.safeParse(source[key]);
          return [key, result.success ? result.data : defaultFields[key]];
        }),
      ),
    );
  }

  const recovered = recoverFields(JobFinderSettingsSchema, value, fallback);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    if (source.applicationCrm !== undefined) {
      const crm = source.applicationCrm;
      const defaults = ApplicationCrmSettingsSchema.parse({});
      recovered.applicationCrm = recoverFields(ApplicationCrmSettingsSchema, crm, defaults);
      if (crm && typeof crm === "object" && !Array.isArray(crm)) {
        const fields = crm as Record<string, unknown>;
        recovered.applicationCrm.noResponseAutomation = recoverFields(
          ApplicationCrmSettingsSchema.shape.noResponseAutomation.removeDefault(),
          fields.noResponseAutomation,
          defaults.noResponseAutomation,
        );
        if (Array.isArray(fields.customStages)) {
          recovered.applicationCrm.customStages = fields.customStages.flatMap((stage: unknown) => {
            const parsedStage = ApplicationCrmStageDefinitionSchema.safeParse(stage);
            return parsedStage.success ? [parsedStage.data] : [];
          });
        }
      }
    }
    if (source.coverLetter !== undefined) {
      recovered.coverLetter = recoverFields(
        CoverLetterPreferenceSchema,
        source.coverLetter,
        CoverLetterPreferenceSchema.parse({}),
      );
    }
    if (
      source.aiBehavior !== undefined &&
      !AiBehaviorPreferenceSchema.safeParse(source.aiBehavior).success
    ) {
      const behavior = source.aiBehavior;
      recovered.aiBehavior = cloneValue(conservativeBehavior);
      if (
        behavior &&
        typeof behavior === "object" &&
        !Array.isArray(behavior)
      ) {
        const groups = behavior as Record<string, unknown>;
        recovered.aiBehavior = {
          profileAssistant: recoverFields(
            AiProfileAssistantBehaviorSchema,
            groups.profileAssistant,
            conservativeBehavior.profileAssistant,
          ),
          jobSearch: recoverFields(
            AiJobSearchBehaviorSchema,
            groups.jobSearch,
            conservativeBehavior.jobSearch,
          ),
          applying: recoverFields(
            AiApplyingBehaviorSchema,
            groups.applying,
            conservativeBehavior.applying,
          ),
        };
      }
    }
  }
  console.warn(
    "[JobFinderRepository] Repaired invalid legacy settings; valid preferences were preserved and invalid permissions were disabled. The original JSON was kept.",
  );
  return JobFinderSettingsSchema.parse(recovered);
}

function getLegacyJsonPath(filePath: string): string {
  return filePath.replace(/\.[^.]+$/, ".json");
}

export function normalizeLegacySourceDebugRunRecord(
  value: unknown,
): SourceDebugRunRecord {
  const parsedValue =
    value && typeof value === "object"
      ? ({ ...(value as Record<string, unknown>) } as Record<string, unknown>)
      : value;

  if (
    parsedValue &&
    typeof parsedValue === "object" &&
    "state" in parsedValue &&
    "activePhase" in parsedValue
  ) {
    const state = parsedValue.state;
    const isTerminalState =
      state === "completed" ||
      state === "cancelled" ||
      state === "failed" ||
      state === "interrupted";

    if (isTerminalState) {
      parsedValue.activePhase = null;
    }
  }

  return SourceDebugRunRecordSchema.parse(parsedValue);
}

export function normalizeLegacyDiscoveryState(
  value: unknown,
): JobFinderDiscoveryState {
  const parsedValue =
    value && typeof value === "object"
      ? ({ ...(value as Record<string, unknown>) } as Record<string, unknown>)
      : {};

  const activeSourceDebugRun =
    parsedValue.activeSourceDebugRun == null
      ? null
      : normalizeLegacySourceDebugRunRecord(parsedValue.activeSourceDebugRun);
  const recentSourceDebugRuns = Array.isArray(parsedValue.recentSourceDebugRuns)
    ? parsedValue.recentSourceDebugRuns.flatMap((run) => {
        try {
          return [normalizeLegacySourceDebugRunRecord(run)];
        } catch {
          return [];
        }
      })
    : [];

  return JobFinderDiscoveryStateSchema.parse({
    ...parsedValue,
    activeSourceDebugRun,
    recentSourceDebugRuns,
  });
}

function migrateWorkModeToArray(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const migrateValue = (value: unknown) => {
    if (typeof value === "string") {
      return value ? [value] : [];
    }

    if (value === null) {
      return [];
    }

    return value;
  };

  const migrateCollection = (entries: unknown, key: "workMode") => {
    if (!Array.isArray(entries)) {
      return entries;
    }

    return entries.map((entry: unknown) => {
      if (typeof entry !== "object" || entry === null) {
        return entry;
      }

      const record = entry as Record<string, unknown>;
      return {
        ...record,
        [key]: migrateValue(record[key]),
      };
    });
  };

  const nextData = { ...data };

  if (data.profile && typeof data.profile === "object") {
    const profile = data.profile as Record<string, unknown>;

    nextData.profile = {
      ...profile,
      experiences: migrateCollection(profile.experiences, "workMode"),
    };
  }

  if (Array.isArray(data.savedJobs)) {
    nextData.savedJobs = migrateCollection(data.savedJobs, "workMode");
  }

  return nextData;
}

function migrateLegacySourceIdentifiers(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const normalizeSource = (value: unknown) => {
    if (typeof value !== "string") {
      return value;
    }

    const normalized = value.trim().toLowerCase();

    if (normalized === "generic_site" || normalized === "linkedin") {
      return "target_site";
    }

    return value;
  };

  const normalizeAdapterKind = (value: unknown) => {
    if (typeof value !== "string") {
      return value;
    }

    const normalized = value.trim().toLowerCase();

    if (
      normalized === "linkedin" ||
      normalized === "generic_site" ||
      normalized === "target_site"
    ) {
      return "auto";
    }

    return value;
  };

  const migrateRecordArray = (
    entries: unknown,
    migrateRecord: (record: Record<string, unknown>) => Record<string, unknown>,
  ): unknown => {
    if (!Array.isArray(entries)) {
      return entries;
    }

    return entries.map((entry): unknown => {
      if (typeof entry !== "object" || entry === null) {
        return entry;
      }

      return migrateRecord(entry as Record<string, unknown>);
    });
  };

  const nextData = { ...data };

  if (data.searchPreferences && typeof data.searchPreferences === "object") {
    const searchPreferences = data.searchPreferences as Record<string, unknown>;
    const discovery =
      searchPreferences.discovery &&
      typeof searchPreferences.discovery === "object"
        ? (searchPreferences.discovery as Record<string, unknown>)
        : null;

    nextData.searchPreferences = {
      ...searchPreferences,
      ...(discovery
        ? {
            discovery: {
              ...discovery,
              targets: migrateRecordArray(discovery.targets, (record) => ({
                ...record,
                adapterKind: normalizeAdapterKind(record.adapterKind),
              })),
            },
          }
        : {}),
    };
  }

  if (Array.isArray(data.savedJobs)) {
    nextData.savedJobs = migrateRecordArray(data.savedJobs, (record) => ({
      ...record,
      source: normalizeSource(record.source),
      provenance: migrateRecordArray(record.provenance, (provenanceRecord) => ({
        ...provenanceRecord,
        adapterKind: normalizeAdapterKind(provenanceRecord.adapterKind),
        resolvedAdapterKind: normalizeSource(
          provenanceRecord.resolvedAdapterKind,
        ),
      })),
    }));
  }

  const legacyDiscovery =
    data.discovery && typeof data.discovery === "object"
      ? (data.discovery as Record<string, unknown>)
      : null;

  if (legacyDiscovery) {
    nextData.discovery = {
      ...legacyDiscovery,
      sessions: migrateRecordArray(legacyDiscovery.sessions, (record) => ({
        ...record,
        adapterKind: normalizeSource(record.adapterKind),
      })),
    };
  }

  return nextData;
}

export async function readLegacySeed(
  filePath: string,
  seed: JobFinderRepositorySeed,
): Promise<JobFinderRepositorySeed | null> {
  const legacyPath = getLegacyJsonPath(filePath);

  if (legacyPath === filePath) {
    return null;
  }

  try {
    const raw = await readFile(legacyPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migratedData = migrateLegacySourceIdentifiers(
      migrateWorkModeToArray(parsed),
    );
    const profile = CandidateProfileSchema.safeParse(migratedData.profile);
    const searchPreferences = JobSearchPreferencesSchema.safeParse(
      migratedData.searchPreferences,
    );
    const settings = recoverLegacySettings(
      migratedData.settings,
      seed.settings,
    );
    const discovery = (() => {
      try {
        return {
          success: true as const,
          data: normalizeLegacyDiscoveryState(migratedData.discovery),
        };
      } catch {
        return { success: false as const, data: null };
      }
    })();
    const savedJobs = SavedJobSchema.array().safeParse(migratedData.savedJobs);
    const tailoredAssets = TailoredAssetSchema.array().safeParse(
      migratedData.tailoredAssets,
    );
    const resumeDrafts = ResumeDraftSchema.array().safeParse(
      migratedData.resumeDrafts ?? [],
    );
    const resumeDraftRevisions = ResumeDraftRevisionSchema.array().safeParse(
      migratedData.resumeDraftRevisions ?? [],
    );
    const resumeExportArtifacts = ResumeExportArtifactSchema.array().safeParse(
      migratedData.resumeExportArtifacts ?? [],
    );
    const resumeResearchArtifacts =
      ResumeResearchArtifactSchema.array().safeParse(
        migratedData.resumeResearchArtifacts ?? [],
      );
    const resumeValidationResults =
      ResumeValidationResultSchema.array().safeParse(
        migratedData.resumeValidationResults ?? [],
      );
    const resumeAssistantMessages =
      ResumeAssistantMessageSchema.array().safeParse(
        migratedData.resumeAssistantMessages ?? [],
      );
    const applicationRecords = ApplicationRecordSchema.array().safeParse(
      migratedData.applicationRecords,
    );
    const applicationAttempts = ApplicationAttemptSchema.array().safeParse(
      migratedData.applicationAttempts ?? [],
    );
    const sourceDebugAttempts =
      SourceDebugWorkerAttemptSchema.array().safeParse(
        migratedData.sourceDebugAttempts ?? [],
      );
    const sourceInstructionArtifacts =
      SourceInstructionArtifactSchema.array().safeParse(
        migratedData.sourceInstructionArtifacts ?? [],
      );
    const sourceDebugEvidenceRefs =
      SourceDebugEvidenceRefSchema.array().safeParse(
        migratedData.sourceDebugEvidenceRefs ?? [],
      );
    const sourceDebugRuns = Array.isArray(migratedData.sourceDebugRuns)
      ? migratedData.sourceDebugRuns.flatMap((run) => {
          try {
            return [normalizeLegacySourceDebugRunRecord(run)];
          } catch {
            return [];
          }
        })
      : cloneValue(seed.sourceDebugRuns);

    return JobFinderRepositoryStateSchema.parse({
      profile: profile.success ? profile.data : cloneValue(seed.profile),
      searchPreferences: searchPreferences.success
        ? searchPreferences.data
        : cloneValue(seed.searchPreferences),
      savedJobs: savedJobs.success
        ? savedJobs.data
        : cloneValue(seed.savedJobs),
      tailoredAssets: tailoredAssets.success
        ? tailoredAssets.data
        : cloneValue(seed.tailoredAssets),
      resumeDrafts: resumeDrafts.success
        ? resumeDrafts.data
        : cloneValue(seed.resumeDrafts),
      resumeDraftRevisions: resumeDraftRevisions.success
        ? resumeDraftRevisions.data
        : cloneValue(seed.resumeDraftRevisions),
      resumeExportArtifacts: resumeExportArtifacts.success
        ? resumeExportArtifacts.data
        : cloneValue(seed.resumeExportArtifacts),
      resumeResearchArtifacts: resumeResearchArtifacts.success
        ? resumeResearchArtifacts.data
        : cloneValue(seed.resumeResearchArtifacts),
      resumeValidationResults: resumeValidationResults.success
        ? resumeValidationResults.data
        : cloneValue(seed.resumeValidationResults),
      resumeAssistantMessages: resumeAssistantMessages.success
        ? resumeAssistantMessages.data
        : cloneValue(seed.resumeAssistantMessages),
      applicationRecords: applicationRecords.success
        ? applicationRecords.data
        : cloneValue(seed.applicationRecords),
      applicationAttempts: applicationAttempts.success
        ? applicationAttempts.data
        : cloneValue(seed.applicationAttempts),
      sourceDebugRuns,
      sourceDebugAttempts: sourceDebugAttempts.success
        ? sourceDebugAttempts.data
        : cloneValue(seed.sourceDebugAttempts),
      sourceInstructionArtifacts: sourceInstructionArtifacts.success
        ? sourceInstructionArtifacts.data
        : cloneValue(seed.sourceInstructionArtifacts),
      sourceDebugEvidenceRefs: sourceDebugEvidenceRefs.success
        ? sourceDebugEvidenceRefs.data
        : cloneValue(seed.sourceDebugEvidenceRefs),
      settings,
      discovery: discovery.success
        ? discovery.data
        : cloneValue(seed.discovery),
    });
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? error.code : null;

    if (errorCode === "ENOENT") {
      return null;
    }

    throw error;
  }
}
