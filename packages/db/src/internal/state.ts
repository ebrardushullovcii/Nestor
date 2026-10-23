import {
  PreparedApplicationFormSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplySubmitApprovalSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  ApplicationAuthorityEnvelopeSchema,
  ApplicationAttemptSchema,
  ApplicationAnswerRecordSchema,
  ApplicationArtifactRefSchema,
  ApplicationConsentRequestSchema,
  ApplicationRecordSchema,
  ApplicationQuestionRecordSchema,
  ApplicationReplayCheckpointSchema,
  SubmissionArmedMarkerSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionOutcomeRecordSchema,
  SubmissionPreflightRecordSchema,
  CandidateProfileSchema,
  JobFinderActivityControlSchema,
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
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
  TailoredAssetSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
  type JobFinderRepositoryState,
} from "@nestor/contracts";
import type {
  DatabaseSync,
  SQLInputValue,
  SQLOutputValue,
} from "node:sqlite";
import {
  APPLICATION_ATTEMPT_INDEXED_COLLECTION_CONFIG,
  APPLY_COLLECTION_ORDER_BY_SQL,
  APPLY_INDEXED_COLLECTION_CONFIGS,
} from "../apply-collection-support";
import { USER_ACTION_INDEXED_COLLECTION_CONFIGS } from "../user-action-repository-support";

import { normalizeLegacySourceDebugRunRecord } from "./legacy";
import {
  readDiscoveryStorage,
  replaceDiscoveryStorage,
} from "./discovery-storage";
import type {
  JobFinderRepositorySeed,
  SchemaParser,
  StateTableKey,
} from "../repository-types";

export const stateTableNames = {
  prepared_application_forms: "prepared_application_forms",
  application_authority_envelopes: "application_authority_envelopes",
  application_answer_snapshots: "application_answer_snapshots",
  application_answer_records: "application_answer_records",
  application_artifact_refs: "application_artifact_refs",
  application_attempts: "application_attempts",
  application_consent_requests: "application_consent_requests",
  application_question_records: "application_question_records",
  application_replay_checkpoints: "application_replay_checkpoints",
  application_records: "application_records",
  submission_armed_markers: "submission_armed_markers",
  submission_execution_grants: "submission_execution_grants",
  submission_idempotency_records: "submission_idempotency_records",
  submission_outcome_records: "submission_outcome_records",
  submission_preflights: "submission_preflights",
  apply_job_results: "apply_job_results",
  apply_runs: "apply_runs",
  apply_submit_approvals: "apply_submit_approvals",
  profile_copilot_messages: "profile_copilot_messages",
  profile_revisions: "profile_revisions",
  saved_jobs: "saved_jobs",
  resume_assistant_messages: "resume_assistant_messages",
  resume_draft_revisions: "resume_draft_revisions",
  resume_drafts: "resume_drafts",
  resume_export_artifacts: "resume_export_artifacts",
  resume_import_document_bundles: "resume_import_document_bundles",
  resume_import_field_candidates: "resume_import_field_candidates",
  resume_import_runs: "resume_import_runs",
  resume_research_artifacts: "resume_research_artifacts",
  resume_validation_results: "resume_validation_results",
  singleton_state: "singleton_state",
  source_debug_attempts: "source_debug_attempts",
  source_debug_evidence_refs: "source_debug_evidence_refs",
  source_debug_runs: "source_debug_runs",
  source_instruction_artifacts: "source_instruction_artifacts",
  tailored_assets: "tailored_assets",
  user_action_events: "user_action_events",
  user_action_requests: "user_action_requests",
} as const;

const APPLICATION_ANSWER_SNAPSHOT_INDEXED_COLLECTION_CONFIG = {
  columnNames: [
    "profile_id",
    "revision",
    "digest",
    "source_profile_revision",
    "approved_at",
  ],
  getColumns: (value: { id: string }) => {
    const snapshot = ApprovedApplicationAnswerSnapshotSchema.parse(value);
    return [
      snapshot.profileId,
      snapshot.revision,
      snapshot.digest,
      snapshot.sourceProfileRevision,
      snapshot.approvedAt,
    ];
  },
} as const;

export type StateCollectionTable = Exclude<
  keyof typeof stateTableNames,
  "singleton_state"
>;

export function cloneValue<TValue>(value: TValue): TValue {
  return structuredClone(value);
}

function normalizePaginationValue(
  value: number | undefined,
  fieldName: "limit" | "offset",
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isFinite(value)) {
    throw new RangeError(`${fieldName} must be a finite number.`);
  }

  return Math.max(0, Math.floor(value));
}

function buildPaginationSql(options?: { limit?: number; offset?: number }): {
  sql: string;
  params: readonly number[];
} {
  const limit =
    options?.limit === undefined
      ? undefined
      : normalizePaginationValue(options.limit, "limit", 0);
  const offset = normalizePaginationValue(options?.offset, "offset", 0);

  if (limit === undefined && offset === 0) {
    return { sql: "", params: [] };
  }

  if (limit === undefined) {
    return { sql: " LIMIT -1 OFFSET ?", params: [offset] };
  }

  return offset === 0
    ? { sql: " LIMIT ?", params: [limit] }
    : { sql: " LIMIT ? OFFSET ?", params: [limit, offset] };
}

interface PersistedRowValidationIssueLike {
  readonly code?: unknown;
  readonly path?: unknown;
}

/**
 * Summarizes why a persisted row failed validation without ever emitting raw
 * row payloads, which can carry candidate secrets.
 */
function describePersistedRowFailure(error: unknown): string {
  if (error instanceof SyntaxError) {
    return "the persisted value is not valid JSON";
  }

  const issues =
    typeof error === "object" && error !== null && "issues" in error
      ? (error as { issues?: unknown }).issues
      : null;

  if (Array.isArray(issues)) {
    const issueSummaries = issues.flatMap((issue) => {
      if (typeof issue !== "object" || issue === null) {
        return [];
      }
      const candidate = issue as PersistedRowValidationIssueLike;
      if (typeof candidate.code !== "string") {
        return [];
      }
      const path = Array.isArray(candidate.path)
        ? candidate.path.filter(
            (segment): segment is string | number =>
              typeof segment === "string" || typeof segment === "number",
          )
        : [];
      return [
        path.length > 0
          ? `${path.join(".")}: ${candidate.code}`
          : candidate.code,
      ];
    });

    if (issueSummaries.length > 0) {
      return `schema validation failed (${issueSummaries.slice(0, 5).join("; ")})`;
    }
  }

  return "schema validation failed";
}

export function parsePersistedRowJson(input: {
  tableName: string;
  rowId: string;
  rawValue: string;
}): unknown {
  try {
    return JSON.parse(input.rawValue) as unknown;
  } catch {
    throw new Error(
      `Corrupted persisted row in table "${input.tableName}" (row "${input.rowId}"): the persisted value is not valid JSON. Repair or remove the corrupted row before using this repository.`,
    );
  }
}

export function validatePersistedRowValue<TValue>(input: {
  tableName: string;
  rowId: string;
  value: unknown;
  schema: SchemaParser<TValue>;
}): TValue {
  try {
    return input.schema.parse(input.value);
  } catch (error) {
    throw new Error(
      `Corrupted persisted row in table "${input.tableName}" (row "${input.rowId}"): ${describePersistedRowFailure(error)}. Repair or remove the corrupted row before using this repository.`,
    );
  }
}

export function parsePersistedRowValue<TValue>(input: {
  tableName: string;
  rowId: string;
  rawValue: string;
  schema: SchemaParser<TValue>;
}): TValue {
  return validatePersistedRowValue({
    ...input,
    value: parsePersistedRowJson(input),
  });
}

export function listValues<TValue>(
  database: DatabaseSync,
  tableName: StateCollectionTable,
  schema: SchemaParser<TValue>,
  options?: {
    limit?: number;
    offset?: number;
  },
): TValue[] {
  const pagination = buildPaginationSql(options);
  const statement = database.prepare(
    `SELECT id, value FROM ${stateTableNames[tableName]} ORDER BY id${pagination.sql}`,
  );
  const rows = statement.all(...pagination.params);
  return rows.map((row) =>
    parsePersistedRowValue({
      tableName,
      rowId: String(row.id),
      rawValue: String(row.value),
      schema,
    }),
  );
}

const PARSE_CHUNK_ROWS = 100;

/**
 * `listValues` for a whole large collection without holding the event loop:
 * the rows are read at once, so the result is one consistent read, and are
 * parsed a chunk at a time with a turn of the event loop in between. Parsing
 * a few thousand saved jobs in one go held Electron main for over a second.
 */
export async function listValuesInChunks<TValue>(
  database: DatabaseSync,
  tableName: StateCollectionTable,
  schema: SchemaParser<TValue>,
): Promise<TValue[]> {
  const rows: (Record<string, SQLOutputValue> | null)[] = database
    .prepare(`SELECT id, value FROM ${stateTableNames[tableName]} ORDER BY id`)
    .all();
  const values: TValue[] = [];
  for (let start = 0; start < rows.length; start += PARSE_CHUNK_ROWS) {
    if (start > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const end = Math.min(rows.length, start + PARSE_CHUNK_ROWS);
    for (let index = start; index < end; index += 1) {
      const row = rows[index]!;
      // Each row's text is let go once parsed: holding every raw row until
      // the last was parsed kept two copies of the collection alive (over
      // 900 MB with 20,000 saved jobs).
      rows[index] = null;
      // Parsed from this read's own JSON, so already the caller's own copy;
      // cloning again was a second full copy of every job per read.
      values.push(
        parsePersistedRowValue({
          tableName,
          rowId: String(row.id),
          rawValue: String(row.value),
          schema,
        }),
      );
    }
  }
  return values;
}

export function listCollectionValues<TValue>(
  database: DatabaseSync,
  tableName: StateCollectionTable,
  schema: SchemaParser<TValue>,
  options: {
    orderBySql: string;
    whereSql?: string;
    params?: readonly SQLInputValue[];
    limit?: number;
    offset?: number;
  },
): TValue[] {
  const whereClause = options.whereSql ? ` WHERE ${options.whereSql}` : "";
  const pagination = buildPaginationSql(options);
  const baseParams = [...(options.params ?? [])] as SQLInputValue[];
  return database
    .prepare(
      `SELECT id, value FROM ${stateTableNames[tableName]}${whereClause} ORDER BY ${options.orderBySql}${pagination.sql}`,
    )
    .all(...baseParams, ...pagination.params)
    .map((row) =>
      parsePersistedRowValue({
        tableName,
        rowId: String(row.id),
        rawValue: String(row.value),
        schema,
      }),
    );
}

/**
 * Parsed singletons by their stored text. A workspace refresh reads the plan
 * state, search settings and discovery state every time, and validating them
 * (about 1 MB with a large search) dominated an unchanged refresh. When the
 * stored text is the same, a copy of the earlier validated value is returned;
 * callers own and may edit what they get, so the cached value is never shared.
 */
const parsedSingletons = new WeakMap<
  DatabaseSync,
  Map<string, { raw: string; schema: unknown; value: unknown }>
>();

function parseSingletonRow<TValue>(
  database: DatabaseSync,
  key: StateTableKey,
  rawValue: string,
  schema: SchemaParser<TValue>,
): TValue {
  let byKey = parsedSingletons.get(database);
  if (!byKey) {
    byKey = new Map();
    parsedSingletons.set(database, byKey);
  }
  const cached = byKey.get(key);
  if (cached && cached.schema === schema && cached.raw === rawValue) {
    return structuredClone(cached.value) as TValue;
  }
  const value = parsePersistedRowValue({
    tableName: stateTableNames.singleton_state,
    rowId: key,
    rawValue,
    schema,
  });
  byKey.set(key, { raw: rawValue, schema, value: structuredClone(value) });
  return value;
}

export function getSingletonValue<TValue>(
  database: DatabaseSync,
  key: StateTableKey,
  schema: SchemaParser<TValue>,
  options?: {
    /**
     * `throw` (the default) fails closed so a corrupted row is never silently
     * replaced by a default. `fallback` returns null instead and logs the
     * failure; it is reserved for singletons read through an explicit legacy
     * normalizer, where an unnormalizable pre-schema blob must degrade to the
     * seed default rather than make the whole workspace unreachable.
     */
    onInvalid?: "throw" | "fallback";
  },
): TValue | null {
  const row = database
    .prepare(
      `SELECT value FROM ${stateTableNames.singleton_state} WHERE key = ?`,
    )
    .get(key);

  if (!row) {
    return null;
  }

  if (options?.onInvalid === "fallback") {
    try {
      return parsePersistedRowValue({
        tableName: stateTableNames.singleton_state,
        rowId: key,
        rawValue: String(row.value),
        schema,
      });
    } catch (error) {
      console.warn(
        `[JobFinderRepository] Falling back to the default value for singleton "${key}": ${
          error instanceof Error
            ? error.message
            : "the persisted row could not be read"
        }`,
      );
      return null;
    }
  }

  return parseSingletonRow(database, key, String(row.value), schema);
}

export interface SingletonValueWithRevision<TValue> {
  value: TValue | null;
  revision: number;
}

export function getSingletonValueWithRevision<TValue>(
  database: DatabaseSync,
  key: StateTableKey,
  schema: SchemaParser<TValue>,
): SingletonValueWithRevision<TValue> {
  const row = database
    .prepare(
      `SELECT value, revision FROM ${stateTableNames.singleton_state} WHERE key = ?`,
    )
    .get(key) as { value?: unknown; revision?: unknown } | undefined;

  if (!row || typeof row.value !== "string") {
    return { value: null, revision: Number(row?.revision ?? 0) };
  }

  return {
    value: parseSingletonRow(database, key, row.value, schema),
    revision: Number(row.revision ?? 0),
  };
}

/**
 * Unconditional singleton save. The monotonic per-row revision increments
 * atomically inside the same statement so concurrent writers can never share
 * one revision value.
 */
export function saveSingletonValue(
  database: DatabaseSync,
  key: StateTableKey,
  value: unknown,
): void {
  database
    .prepare(
      `INSERT INTO ${stateTableNames.singleton_state} (key, value, revision)
       VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         revision = ${stateTableNames.singleton_state}.revision + 1`,
    )
    .run(key, JSON.stringify(value));
}

/**
 * Bootstrap/reset write: the whole value is replaced from an authoritative
 * seed rather than derived from the current one.
 *
 * The revision still only ever moves forward. Rewinding it to a literal 1 would
 * make the compare-and-swap epoch non-monotonic across a reset, so a token
 * captured before the reset would still satisfy the equality check afterwards
 * and overwrite freshly seeded state. A bootstrap into an empty table therefore
 * still starts at revision 1, while a reset advances the existing row.
 */
export function initSingletonValue(
  database: DatabaseSync,
  key: StateTableKey,
  value: unknown,
): void {
  saveSingletonValue(database, key, value);
}

/**
 * Advances a singleton row's monotonic revision without changing its value.
 * The profile row's revision is the shared compare-and-swap epoch for the
 * profile, search-preferences, and profile-setup-state singletons: copilot
 * commits snapshot all three, so preference-only or setup-state-only writes
 * must advance it too or the captured token would miss their changes.
 */
export function incrementSingletonRevision(
  database: DatabaseSync,
  key: StateTableKey,
): void {
  database
    .prepare(
      `UPDATE ${stateTableNames.singleton_state}
       SET revision = revision + 1
       WHERE key = ?`,
    )
    .run(key);
}

export function replaceCollection(
  database: DatabaseSync,
  tableName: StateCollectionTable,
  values: readonly { id: string }[],
): void {
  database.exec(`DELETE FROM ${stateTableNames[tableName]}`);
  const statement = database.prepare(
    `INSERT OR REPLACE INTO ${stateTableNames[tableName]} (id, value) VALUES (?, ?)`,
  );

  for (const value of values) {
    statement.run(value.id, JSON.stringify(value));
  }
}

export function replaceIndexedCollection(
  database: DatabaseSync,
  tableName: StateCollectionTable,
  values: readonly { id: string }[],
  options: {
    columnNames: readonly string[];
    getColumns: (value: { id: string }) => readonly SQLInputValue[];
  },
): void {
  database.exec(`DELETE FROM ${stateTableNames[tableName]}`);
  insertIndexedCollection(database, tableName, values, options);
}

function insertIndexedCollection(
  database: DatabaseSync,
  tableName: StateCollectionTable,
  values: readonly { id: string }[],
  options: {
    columnNames: readonly string[];
    getColumns: (value: { id: string }) => readonly SQLInputValue[];
  },
): void {
  const columnSql = ["id", ...options.columnNames, "value"].join(", ");
  const placeholders = Array.from({
    length: options.columnNames.length + 2,
  })
    .fill("?")
    .join(", ");
  const statement = database.prepare(
    `INSERT OR REPLACE INTO ${stateTableNames[tableName]} (${columnSql}) VALUES (${placeholders})`,
  );

  for (const value of values) {
    statement.run(
      value.id,
      ...options.getColumns(value),
      JSON.stringify(value),
    );
  }
}

export function upsertIndexedCollectionValue(
  database: DatabaseSync,
  tableName: StateCollectionTable,
  value: { id: string },
  options: {
    columnNames: readonly string[];
    getColumns: (value: { id: string }) => readonly SQLInputValue[];
    serializedValue?: string;
  },
): void {
  const columnSql = ["id", ...options.columnNames, "value"].join(", ");
  const placeholders = Array.from({
    length: options.columnNames.length + 2,
  })
    .fill("?")
    .join(", ");
  database
    .prepare(
      `INSERT OR REPLACE INTO ${stateTableNames[tableName]} (${columnSql}) VALUES (${placeholders})`,
    )
    .run(
      value.id,
      ...options.getColumns(value),
      options.serializedValue ?? JSON.stringify(value),
    );
}

export function upsertCollectionValue(
  database: DatabaseSync,
  tableName: StateCollectionTable,
  value: { id: string },
): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO ${stateTableNames[tableName]} (id, value) VALUES (?, ?)`,
    )
    .run(value.id, JSON.stringify(value));
}

/**
 * Campaign persistence is all-or-nothing: a state that carries campaigns
 * without a matching active pointer must never reach the delete-or-write
 * branch, because it would silently wipe the persisted campaign collection.
 */
function assertPersistableCampaignPointer(
  state: JobFinderRepositoryState,
): void {
  if (state.campaigns.length === 0) {
    if (state.activeCampaignId !== null) {
      throw new Error(
        "Refusing to persist workspace state: the seed has no campaigns but references an active campaign.",
      );
    }
    return;
  }

  if (
    state.activeCampaignId === null ||
    !state.campaigns.some((campaign) => campaign.id === state.activeCampaignId)
  ) {
    throw new Error(
      "Refusing to persist workspace state: campaigns without a matching active campaign id would silently delete persisted campaigns.",
    );
  }
}

export function writeState(
  database: DatabaseSync,
  state: JobFinderRepositoryState,
): void {
  assertPersistableCampaignPointer(state);
  const activeAuthorityCount = state.applicationAuthorityEnvelopes.filter(
    (envelope) => envelope.status === "active",
  ).length;
  if (activeAuthorityCount > 1) {
    throw new Error(
      "Refusing to persist workspace state: more than one active application authority envelope is not allowed.",
    );
  }
  database.exec("BEGIN IMMEDIATE");

  try {
    initSingletonValue(database, "profile", state.profile);
    initSingletonValue(database, "search_preferences", state.searchPreferences);
    initSingletonValue(
      database,
      "profile_setup_state",
      state.profileSetupState,
    );
    initSingletonValue(database, "settings", state.settings);
    replaceDiscoveryStorage(database, state.discovery);
    if (state.campaigns.length > 0 && state.activeCampaignId) {
      initSingletonValue(database, "campaign_state", {
        campaigns: state.campaigns,
        activeCampaignId: state.activeCampaignId,
        notifications: state.campaignNotifications,
      });
    } else {
      database
        .prepare(`DELETE FROM ${stateTableNames.singleton_state} WHERE key = ?`)
        .run("campaign_state");
    }
    initSingletonValue(database, "activity_control", state.activityControl);
    initSingletonValue(database, "intelligence_state", state.intelligence);
    replaceCollection(database, "prepared_application_forms", state.preparedApplicationForms ?? []);
    replaceCollection(database, "saved_jobs", state.savedJobs);
    replaceCollection(database, "tailored_assets", state.tailoredAssets);
    replaceIndexedCollection(
      database,
      "apply_runs",
      state.applyRuns,
      APPLY_INDEXED_COLLECTION_CONFIGS.apply_runs,
    );
    replaceIndexedCollection(
      database,
      "apply_job_results",
      state.applyJobResults,
      APPLY_INDEXED_COLLECTION_CONFIGS.apply_job_results,
    );
    replaceIndexedCollection(
      database,
      "apply_submit_approvals",
      state.applySubmitApprovals,
      APPLY_INDEXED_COLLECTION_CONFIGS.apply_submit_approvals,
    );
    replaceIndexedCollection(
      database,
      "application_question_records",
      state.applicationQuestionRecords,
      APPLY_INDEXED_COLLECTION_CONFIGS.application_question_records,
    );
    replaceIndexedCollection(
      database,
      "application_answer_records",
      state.applicationAnswerRecords,
      APPLY_INDEXED_COLLECTION_CONFIGS.application_answer_records,
    );
    replaceIndexedCollection(
      database,
      "application_artifact_refs",
      state.applicationArtifactRefs,
      APPLY_INDEXED_COLLECTION_CONFIGS.application_artifact_refs,
    );
    replaceIndexedCollection(
      database,
      "application_replay_checkpoints",
      state.applicationReplayCheckpoints,
      APPLY_INDEXED_COLLECTION_CONFIGS.application_replay_checkpoints,
    );
    replaceIndexedCollection(
      database,
      "application_consent_requests",
      state.applicationConsentRequests,
      APPLY_INDEXED_COLLECTION_CONFIGS.application_consent_requests,
    );
    replaceIndexedCollection(
      database,
      "application_answer_snapshots",
      state.applicationAnswerSnapshots ?? [],
      APPLICATION_ANSWER_SNAPSHOT_INDEXED_COLLECTION_CONFIG,
    );
    replaceIndexedCollection(
      database,
      "user_action_events",
      [],
      USER_ACTION_INDEXED_COLLECTION_CONFIGS.user_action_events,
    );
    replaceIndexedCollection(
      database,
      "user_action_requests",
      state.userActionRequests,
      USER_ACTION_INDEXED_COLLECTION_CONFIGS.user_action_requests,
    );
    replaceIndexedCollection(
      database,
      "user_action_events",
      state.userActionEvents,
      USER_ACTION_INDEXED_COLLECTION_CONFIGS.user_action_events,
    );
    replaceIndexedCollection(database, "resume_drafts", state.resumeDrafts, {
      columnNames: ["job_id", "created_at", "updated_at"],
      getColumns: (value) => {
        const draft = ResumeDraftSchema.parse(value);
        return [draft.jobId, draft.createdAt, draft.updatedAt];
      },
    });
    replaceIndexedCollection(
      database,
      "resume_draft_revisions",
      state.resumeDraftRevisions,
      {
        columnNames: ["draft_id", "created_at"],
        getColumns: (value) => {
          const revision = ResumeDraftRevisionSchema.parse(value);
          return [revision.draftId, revision.createdAt];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "resume_export_artifacts",
      state.resumeExportArtifacts,
      {
        columnNames: ["job_id", "draft_id", "exported_at", "is_approved"],
        getColumns: (value) => {
          const artifact = ResumeExportArtifactSchema.parse(value);
          return [
            artifact.jobId,
            artifact.draftId,
            artifact.exportedAt,
            artifact.isApproved ? 1 : 0,
          ];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "resume_import_runs",
      state.resumeImportRuns,
      {
        columnNames: ["source_resume_id", "started_at", "status"],
        getColumns: (value) => {
          const run = ResumeImportRunSchema.parse(value);
          return [run.sourceResumeId, run.startedAt, run.status];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "resume_import_document_bundles",
      state.resumeImportDocumentBundles,
      {
        columnNames: ["run_id", "source_resume_id", "created_at"],
        getColumns: (value) => {
          const bundle = ResumeDocumentBundleSchema.parse(value);
          return [bundle.runId, bundle.sourceResumeId, bundle.createdAt];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "resume_import_field_candidates",
      state.resumeImportFieldCandidates,
      {
        columnNames: ["run_id", "resolution", "created_at"],
        getColumns: (value) => {
          const candidate = ResumeImportFieldCandidateSchema.parse(value);
          return [candidate.runId, candidate.resolution, candidate.createdAt];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "resume_research_artifacts",
      state.resumeResearchArtifacts,
      {
        columnNames: ["job_id", "fetched_at"],
        getColumns: (value) => {
          const artifact = ResumeResearchArtifactSchema.parse(value);
          return [artifact.jobId, artifact.fetchedAt];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "resume_validation_results",
      state.resumeValidationResults,
      {
        columnNames: ["draft_id", "validated_at"],
        getColumns: (value) => {
          const validation = ResumeValidationResultSchema.parse(value);
          return [validation.draftId, validation.validatedAt];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "resume_assistant_messages",
      state.resumeAssistantMessages,
      {
        columnNames: ["job_id", "created_at"],
        getColumns: (value) => {
          const message = ResumeAssistantMessageSchema.parse(value);
          return [message.jobId, message.createdAt];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "profile_copilot_messages",
      state.profileCopilotMessages,
      {
        columnNames: ["created_at"],
        getColumns: (value) => {
          const message = ProfileCopilotMessageSchema.parse(value);
          return [message.createdAt];
        },
      },
    );
    replaceIndexedCollection(
      database,
      "profile_revisions",
      state.profileRevisions,
      {
        columnNames: ["created_at"],
        getColumns: (value) => {
          const revision = ProfileRevisionSchema.parse(value);
          return [revision.createdAt];
        },
      },
    );
    replaceCollection(
      database,
      "application_records",
      state.applicationRecords,
    );
    // Authority collections carry non-cascading foreign keys to preflights.
    // Delete children before parents, then insert parents before children so
    // reset and full-state replacement remain valid in both directions.
    for (const tableName of [
      "submission_outcome_records",
      "submission_armed_markers",
      "submission_idempotency_records",
      "submission_execution_grants",
      "submission_preflights",
      "application_authority_envelopes",
    ] as const) {
      database.exec(`DELETE FROM ${stateTableNames[tableName]}`);
    }
    insertIndexedCollection(
      database,
      "application_authority_envelopes",
      state.applicationAuthorityEnvelopes,
      {
        columnNames: ["revision", "status"],
        getColumns: (value) => {
          const envelope = ApplicationAuthorityEnvelopeSchema.parse(value);
          return [envelope.revision, envelope.status];
        },
      },
    );
    insertIndexedCollection(
      database,
      "submission_preflights",
      state.submissionPreflights,
      {
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
        getColumns: (value) => {
          const preflight = SubmissionPreflightRecordSchema.parse(value);
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
    );
    insertIndexedCollection(
      database,
      "submission_execution_grants",
      state.submissionExecutionGrants,
      {
        columnNames: [
          "preflight_id",
          "idempotency_key",
          "status",
          "granted_at",
          "expires_at",
        ],
        getColumns: (value) => {
          const grant = SubmissionExecutionGrantSchema.parse(value);
          return [
            grant.preflightId,
            grant.idempotencyKey,
            grant.status,
            grant.grantedAt,
            grant.expiresAt,
          ];
        },
      },
    );
    insertIndexedCollection(
      database,
      "submission_idempotency_records",
      state.submissionIdempotencyRecords,
      {
        columnNames: [
          "idempotency_key",
          "preflight_id",
          "revision",
          "status",
          "updated_at",
        ],
        getColumns: (value) => {
          const record = SubmissionIdempotencyRecordSchema.parse(value);
          return [
            record.idempotencyKey,
            record.preflightId,
            record.revision,
            record.status,
            record.updatedAt,
          ];
        },
      },
    );
    insertIndexedCollection(
      database,
      "submission_armed_markers",
      state.submissionArmedMarkers,
      {
        columnNames: ["idempotency_key", "preflight_id", "armed_at"],
        getColumns: (value) => {
          const marker = SubmissionArmedMarkerSchema.parse(value);
          return [marker.idempotencyKey, marker.preflightId, marker.armedAt];
        },
      },
    );
    insertIndexedCollection(
      database,
      "submission_outcome_records",
      state.submissionOutcomeRecords,
      {
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
        getColumns: (value) => {
          const outcome = SubmissionOutcomeRecordSchema.parse(value);
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
    );
    replaceIndexedCollection(
      database,
      "application_attempts",
      state.applicationAttempts,
      APPLICATION_ATTEMPT_INDEXED_COLLECTION_CONFIG,
    );
    replaceCollection(database, "source_debug_runs", state.sourceDebugRuns);
    replaceCollection(
      database,
      "source_debug_attempts",
      state.sourceDebugAttempts,
    );
    replaceCollection(
      database,
      "source_instruction_artifacts",
      state.sourceInstructionArtifacts,
    );
    replaceCollection(
      database,
      "source_debug_evidence_refs",
      state.sourceDebugEvidenceRefs,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function bootstrapState(
  database: DatabaseSync,
  seed: JobFinderRepositorySeed,
): void {
  const normalizedSeed = JobFinderRepositoryStateSchema.parse(cloneValue(seed));
  writeState(database, normalizedSeed);
}

export function hasPersistedState(database: DatabaseSync): boolean {
  const singletonCountRow = database
    .prepare(`SELECT COUNT(*) AS count FROM ${stateTableNames.singleton_state}`)
    .get() as { count?: number } | undefined;
  const singletonCount = Number(singletonCountRow?.count ?? 0);
  const jobCountRow = database
    .prepare(`SELECT COUNT(*) AS count FROM ${stateTableNames.saved_jobs}`)
    .get() as { count?: number } | undefined;
  const jobCount = Number(jobCountRow?.count ?? 0);

  return singletonCount > 0 || jobCount > 0;
}

export function readState(
  database: DatabaseSync,
  fallbackSeed: JobFinderRepositorySeed,
): JobFinderRepositoryState {
  const profile =
    getSingletonValue(database, "profile", CandidateProfileSchema) ??
    fallbackSeed.profile;
  const searchPreferences =
    getSingletonValue(
      database,
      "search_preferences",
      JobSearchPreferencesSchema,
    ) ?? fallbackSeed.searchPreferences;
  const settings =
    getSingletonValue(database, "settings", JobFinderSettingsSchema) ??
    fallbackSeed.settings;
  const profileSetupState =
    getSingletonValue(
      database,
      "profile_setup_state",
      ProfileSetupStateSchema,
    ) ?? fallbackSeed.profileSetupState;
  const discovery = readDiscoveryStorage(database, fallbackSeed.discovery);
  const campaignState = getSingletonValue(
    database,
    "campaign_state",
    JobSearchCampaignCollectionSchema,
  );
  const activityControl =
    getSingletonValue(
      database,
      "activity_control",
      JobFinderActivityControlSchema,
    ) ?? fallbackSeed.activityControl;
  const intelligence =
    getSingletonValue(
      database,
      "intelligence_state",
      JobFinderIntelligenceStateSchema,
    ) ?? fallbackSeed.intelligence;

  return JobFinderRepositoryStateSchema.parse({
    profile,
    searchPreferences,
    profileSetupState,
    savedJobs: listValues(database, "saved_jobs", SavedJobSchema),
    tailoredAssets: listValues(
      database,
      "tailored_assets",
      TailoredAssetSchema,
    ),
    resumeDrafts: listCollectionValues(
      database,
      "resume_drafts",
      ResumeDraftSchema,
      {
        orderBySql: "updated_at DESC, id ASC",
      },
    ),
    resumeDraftRevisions: listCollectionValues(
      database,
      "resume_draft_revisions",
      ResumeDraftRevisionSchema,
      {
        orderBySql: "created_at DESC, id ASC",
      },
    ),
    resumeExportArtifacts: listCollectionValues(
      database,
      "resume_export_artifacts",
      ResumeExportArtifactSchema,
      {
        orderBySql: "exported_at DESC, id ASC",
      },
    ),
    resumeImportRuns: listCollectionValues(
      database,
      "resume_import_runs",
      ResumeImportRunSchema,
      {
        orderBySql: "started_at DESC, id ASC",
      },
    ),
    resumeImportDocumentBundles: listCollectionValues(
      database,
      "resume_import_document_bundles",
      ResumeDocumentBundleSchema,
      {
        orderBySql: "created_at DESC, id ASC",
      },
    ),
    resumeImportFieldCandidates: listCollectionValues(
      database,
      "resume_import_field_candidates",
      ResumeImportFieldCandidateSchema,
      {
        orderBySql: "created_at DESC, id ASC",
      },
    ),
    resumeResearchArtifacts: listCollectionValues(
      database,
      "resume_research_artifacts",
      ResumeResearchArtifactSchema,
      {
        orderBySql: "fetched_at DESC, id ASC",
      },
    ),
    resumeValidationResults: listCollectionValues(
      database,
      "resume_validation_results",
      ResumeValidationResultSchema,
      {
        orderBySql: "validated_at DESC, id ASC",
      },
    ),
    resumeAssistantMessages: listCollectionValues(
      database,
      "resume_assistant_messages",
      ResumeAssistantMessageSchema,
      {
        orderBySql: "created_at ASC, id ASC",
      },
    ),
    profileCopilotMessages: listCollectionValues(
      database,
      "profile_copilot_messages",
      ProfileCopilotMessageSchema,
      {
        orderBySql: "created_at ASC, id ASC",
      },
    ),
    profileRevisions: listCollectionValues(
      database,
      "profile_revisions",
      ProfileRevisionSchema,
      {
        orderBySql: "created_at DESC, id ASC",
      },
    ),
    applyRuns: listCollectionValues(database, "apply_runs", ApplyRunSchema, {
      orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_runs,
    }),
    applyJobResults: listCollectionValues(
      database,
      "apply_job_results",
      ApplyJobResultSchema,
      {
        orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_job_results,
      },
    ),
    applySubmitApprovals: listCollectionValues(
      database,
      "apply_submit_approvals",
      ApplySubmitApprovalSchema,
      {
        orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.apply_submit_approvals,
      },
    ),
    applicationQuestionRecords: listCollectionValues(
      database,
      "application_question_records",
      ApplicationQuestionRecordSchema,
      {
        orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.application_question_records,
      },
    ),
    applicationAnswerRecords: listCollectionValues(
      database,
      "application_answer_records",
      ApplicationAnswerRecordSchema,
      {
        orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.application_answer_records,
      },
    ),
    applicationArtifactRefs: listCollectionValues(
      database,
      "application_artifact_refs",
      ApplicationArtifactRefSchema,
      {
        orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.application_artifact_refs,
      },
    ),
    preparedApplicationForms: listValues(database, "prepared_application_forms", PreparedApplicationFormSchema),
    applicationReplayCheckpoints: listCollectionValues(
      database,
      "application_replay_checkpoints",
      ApplicationReplayCheckpointSchema,
      {
        orderBySql:
          APPLY_COLLECTION_ORDER_BY_SQL.application_replay_checkpoints,
      },
    ),
    applicationConsentRequests: listCollectionValues(
      database,
      "application_consent_requests",
      ApplicationConsentRequestSchema,
      {
        orderBySql: APPLY_COLLECTION_ORDER_BY_SQL.application_consent_requests,
      },
    ),
    applicationAnswerSnapshots: listCollectionValues(
      database,
      "application_answer_snapshots",
      ApprovedApplicationAnswerSnapshotSchema,
      { orderBySql: "profile_id ASC, revision DESC, id ASC" },
    ),
    userActionRequests: listCollectionValues(
      database,
      "user_action_requests",
      UserActionRequestSchema,
      { orderBySql: "updated_at DESC, id ASC" },
    ),
    userActionEvents: listCollectionValues(
      database,
      "user_action_events",
      UserActionEventSchema,
      { orderBySql: "occurred_at ASC, id ASC" },
    ),
    applicationRecords: listValues(
      database,
      "application_records",
      ApplicationRecordSchema,
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
    applicationAttempts: listValues(
      database,
      "application_attempts",
      ApplicationAttemptSchema,
    ),
    sourceDebugRuns: listValues(database, "source_debug_runs", {
      parse: normalizeLegacySourceDebugRunRecord,
    }),
    sourceDebugAttempts: listValues(
      database,
      "source_debug_attempts",
      SourceDebugWorkerAttemptSchema,
    ),
    sourceInstructionArtifacts: listValues(
      database,
      "source_instruction_artifacts",
      SourceInstructionArtifactSchema,
    ),
    sourceDebugEvidenceRefs: listValues(
      database,
      "source_debug_evidence_refs",
      SourceDebugEvidenceRefSchema,
    ),
    settings,
    discovery,
    campaigns: campaignState?.campaigns ?? fallbackSeed.campaigns,
    activeCampaignId:
      campaignState?.activeCampaignId ?? fallbackSeed.activeCampaignId,
    campaignNotifications:
      campaignState?.notifications ?? fallbackSeed.campaignNotifications,
    activityControl,
    intelligence,
  });
}
