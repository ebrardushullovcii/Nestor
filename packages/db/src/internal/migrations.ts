import { chmod } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import {
  CandidateProfileSchema,
  ApplicationQuestionRecordSchema,
  ApplicationAnswerRecordSchema,
  ApplyJobResultSchema,
  JobSearchPreferencesSchema,
  getDefaultCampaignConfiguration,
  normalizeCompanyName,
} from "@nestor/contracts";

import { quarantineAgentAnswers } from "../agent-answer-migration";
import { migrateDiscoveryStorage } from "./discovery-storage";
import { ensureTailoredAssetJobIndex } from "./tailored-asset-storage";
import { ensureResumeApprovalState } from "./resume-approval-state";
import { ensureWorkspaceReadIndex } from "./workspace-read-index";
import { migrateResumeStorage } from "./resume-storage-migration";
import { migratePreferenceStorage } from "./preference-storage";
import { migrateSavedJobStorage } from "./saved-job-storage-migration";

/**
 * Exact column shape every application-authority table must have. The assert
 * and the column-level repair read the same map so a drifted table can never
 * be detected by one and missed by the other.
 */
const APPLICATION_AUTHORITY_REQUIRED_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  application_authority_envelopes: ["id", "revision", "status", "value"],
  submission_preflights: [
    "id",
    "idempotency_key",
    "run_id",
    "job_id",
    "result_id",
    "application_record_id",
    "authority_envelope_id",
    "authority_revision",
    "created_at",
    "value",
  ],
  submission_execution_grants: [
    "id",
    "preflight_id",
    "idempotency_key",
    "status",
    "granted_at",
    "expires_at",
    "value",
  ],
  submission_idempotency_records: [
    "id",
    "idempotency_key",
    "preflight_id",
    "revision",
    "status",
    "updated_at",
    "value",
  ],
  submission_armed_markers: [
    "id",
    "idempotency_key",
    "preflight_id",
    "armed_at",
    "value",
  ],
  submission_outcome_records: [
    "id",
    "preflight_id",
    "idempotency_key",
    "run_id",
    "job_id",
    "result_id",
    "application_record_id",
    "attempted_at",
    "outcome",
    "value",
  ],
};

/**
 * Child-to-parent drop order. Repair removes a foreign-key parent only after
 * every table that references it, so an outdated shape can be rebuilt without
 * tripping `PRAGMA foreign_keys = ON`.
 */
const APPLICATION_AUTHORITY_TABLE_DROP_ORDER = [
  "submission_outcome_records",
  "submission_armed_markers",
  "submission_idempotency_records",
  "submission_execution_grants",
  "submission_preflights",
  "application_authority_envelopes",
] as const;

const APPLICATION_ANSWER_SNAPSHOT_REQUIRED_COLUMNS: readonly string[] = [
  "id",
  "profile_id",
  "revision",
  "digest",
  "source_profile_revision",
  "approved_at",
  "value",
];

/**
 * Opens a workspace database file, releasing the OS handle when the open
 * fails.
 *
 * `new DatabaseSync(path)` opens the file inside the constructor, so a throw
 * leaves the caller with no object to close. On Windows that orphaned handle
 * keeps the file locked, and the very next thing corruption recovery does is
 * rename the suspect file aside — which then fails with EBUSY and turns a
 * recoverable workspace into "quarantine-incomplete". Deferring the open with
 * `{ open: false }` gives us an object we can always close, so the handle is
 * gone before recovery touches the file. POSIX never held the lock and is
 * unaffected.
 */
export function openDatabaseFile(
  filePath: string,
  options: { readOnly?: boolean } = {},
): DatabaseSync {
  const database = new DatabaseSync(filePath, {
    open: false,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });

  try {
    database.open();
  } catch (error) {
    try {
      database.close();
    } catch {
      // A database that never opened has nothing to close.
    }
    throw error;
  }

  return database;
}

export function secureDatabaseFile(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return Promise.resolve();
  }

  const relatedFiles = [filePath, `${filePath}-wal`, `${filePath}-shm`];

  return Promise.all(
    relatedFiles.map(async (candidate) => {
      try {
        await chmod(candidate, 0o600);
      } catch {
        // Ignore permission updates for files that do not exist yet.
      }
    }),
  ).then(() => undefined);
}

function isStrongLegacyAchievementContinuation(value: string): boolean {
  const trimmed = value.trim();
  const startsWithContinuationWord =
    /^(?:and|or|while|which|that|with|using|including|ensuring|improving|reducing|synchronizing|supporting)\b/u.test(
      trimmed,
    );
  const technologyTokens = trimmed.split(/\s+(?:and|&)\s+/u);
  const isTechnologyList =
    trimmed.length <= 48 &&
    technologyTokens.length <= 4 &&
    technologyTokens.every(
      (token) =>
        !/\s/u.test(token) &&
        (/[A-Za-z]\.[A-Za-z]/u.test(token) ||
          /[a-z][A-Z]/u.test(token) ||
          /^(?:\.?NET|[A-Za-z][A-Za-z0-9]*#|[A-Za-z][A-Za-z0-9]*\+\+)$/u.test(
            token,
          )),
    );

  return startsWithContinuationWord || isTechnologyList;
}

export function repairLegacyCommaSplitAchievements(
  values: readonly string[],
): string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (
    !normalized.some(
      (value, index) =>
        index > 0 && isStrongLegacyAchievementContinuation(value),
    )
  ) {
    return normalized;
  }

  const repaired: string[] = [];
  let current = normalized[0] ?? "";

  for (const value of normalized.slice(1)) {
    if (
      !/[.!?]$/u.test(current) &&
      isStrongLegacyAchievementContinuation(value)
    ) {
      current = `${current}${/[,;:]$/u.test(current) ? " " : ", "}${value}`;
      continue;
    }

    repaired.push(current);
    current = value;
  }

  if (current) repaired.push(current);
  return repaired;
}

/**
 * Reads the legacy discovery run list defensively. A discovery blob whose shape
 * drifted from the current schema must not abort the default-campaign
 * migration, because a rolled back migration re-fails on every later launch.
 * Invalid JSON deliberately still throws: that is genuine corruption, which
 * startup recovery handles separately.
 */
function readLegacyDiscoveryRuns(
  serializedDiscoveryState: unknown,
): Array<{ id: string; startedAt: string; completedAt?: string }> {
  if (typeof serializedDiscoveryState !== "string") return [];

  const parsedValue = JSON.parse(serializedDiscoveryState) as unknown;

  const recentRuns =
    parsedValue &&
    typeof parsedValue === "object" &&
    !Array.isArray(parsedValue)
      ? (parsedValue as { recentRuns?: unknown }).recentRuns
      : undefined;
  if (!Array.isArray(recentRuns)) return [];

  return recentRuns.filter(
    (run): run is { id: string; startedAt: string; completedAt?: string } =>
      typeof run === "object" &&
      run !== null &&
      typeof (run as { id?: unknown }).id === "string" &&
      typeof (run as { startedAt?: unknown }).startedAt === "string",
  );
}

export function runMigrations(database: DatabaseSync): void {
  function ensurePreparedApplicationForms(): void {
    database.exec(`CREATE TABLE IF NOT EXISTS prepared_application_forms (
      id TEXT PRIMARY KEY, value TEXT NOT NULL
    )`);
    database
      .prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)",
      )
      .run(21, "durable_prepared_application_forms");
  }
  function hasTable(tableName: string): boolean {
    return Boolean(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        )
        .get(tableName),
    );
  }

  function hasSingletonStateRevisionColumn(): boolean {
    if (!hasTable("singleton_state")) return false;
    const columns = database
      .prepare("PRAGMA table_info(singleton_state)")
      .all() as Array<{ name?: unknown }>;
    return columns.some((column) => column?.name === "revision");
  }

  function ensureSingletonStateRevisionColumn(): void {
    if (hasSingletonStateRevisionColumn()) return;
    database.exec(
      "ALTER TABLE singleton_state ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    );
  }

  function hasColumn(tableName: string, columnName: string): boolean {
    if (!hasTable(tableName)) return false;
    const columns = database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: unknown }>;
    return columns.some((column) => column.name === columnName);
  }

  function hasIndex(indexName: string): boolean {
    return Boolean(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name = ?",
        )
        .get(indexName),
    );
  }

  const applicationLineageTables = [
    "apply_job_results",
    "application_question_records",
    "application_answer_records",
    "application_artifact_refs",
    "application_replay_checkpoints",
    "application_consent_requests",
    "application_attempts",
    "user_action_requests",
  ] as const;

  function ensureApplicationLineageColumns(): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS application_records (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS application_attempts (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    for (const tableName of applicationLineageTables) {
      if (!hasColumn(tableName, "application_record_id")) {
        database.exec(
          `ALTER TABLE ${tableName} ADD COLUMN application_record_id TEXT`,
        );
      }
    }

    if (!hasColumn("application_attempts", "job_id")) {
      database.exec("ALTER TABLE application_attempts ADD COLUMN job_id TEXT");
    }
    if (!hasColumn("application_attempts", "updated_at")) {
      database.exec(
        "ALTER TABLE application_attempts ADD COLUMN updated_at TEXT",
      );
    }

    database.exec(`
      CREATE INDEX IF NOT EXISTS apply_job_results_application_record_idx
        ON apply_job_results(application_record_id, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS application_question_records_application_record_idx
        ON application_question_records(application_record_id, detected_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS application_answer_records_application_record_idx
        ON application_answer_records(application_record_id, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS application_artifact_refs_application_record_idx
        ON application_artifact_refs(application_record_id, created_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS application_replay_checkpoints_application_record_idx
        ON application_replay_checkpoints(application_record_id, created_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS application_consent_requests_application_record_idx
        ON application_consent_requests(application_record_id, requested_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS application_attempts_application_record_idx
        ON application_attempts(application_record_id, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS application_attempts_job_idx
        ON application_attempts(job_id, updated_at DESC, id ASC);
      CREATE INDEX IF NOT EXISTS user_action_requests_application_record_idx
        ON user_action_requests(application_record_id, updated_at DESC, id ASC);
    `);
  }

  function parseMigrationObject(
    tableName: string,
    rowId: string,
    serializedValue: string,
  ): Record<string, unknown> {
    const parsed = JSON.parse(serializedValue) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `Cannot migrate ${tableName}.${rowId}: persisted value is not an object.`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  function backfillApplicationRecordLineage(): void {
    const applicationRecords = (
      database
        .prepare("SELECT id, value FROM application_records")
        .all() as Array<{
        id: string;
        value: string;
      }>
    ).map((row) => {
      const value = parseMigrationObject(
        "application_records",
        row.id,
        row.value,
      );
      return {
        id: row.id,
        jobId: typeof value.jobId === "string" ? value.jobId : null,
      };
    });
    const applicationRecordById = new Map(
      applicationRecords.map((record) => [record.id, record]),
    );
    const applicationRecordIdsByJob = new Map<string, string[]>();
    for (const record of applicationRecords) {
      if (record.jobId === null) continue;
      const ids = applicationRecordIdsByJob.get(record.jobId) ?? [];
      ids.push(record.id);
      applicationRecordIdsByJob.set(record.jobId, ids);
    }

    function resolveDirectLineage(
      value: Record<string, unknown>,
      jobId: string,
    ): string | null {
      if (typeof value.applicationRecordId === "string") {
        const exact = applicationRecordById.get(value.applicationRecordId);
        return exact?.jobId === jobId ? exact.id : null;
      }
      if (Object.prototype.hasOwnProperty.call(value, "applicationRecordId")) {
        return null;
      }
      const candidates = applicationRecordIdsByJob.get(jobId) ?? [];
      return candidates.length === 1 ? candidates[0]! : null;
    }

    const resultRows = database
      .prepare("SELECT id, run_id, job_id, value FROM apply_job_results")
      .all() as Array<{
      id: string;
      run_id: string;
      job_id: string;
      value: string;
    }>;
    const resultLineage = new Map<
      string,
      { runId: string; jobId: string; applicationRecordId: string | null }
    >();
    const updateResult = database.prepare(
      "UPDATE apply_job_results SET application_record_id = ?, value = ? WHERE id = ?",
    );
    for (const row of resultRows) {
      const value = parseMigrationObject(
        "apply_job_results",
        row.id,
        row.value,
      );
      const applicationRecordId = resolveDirectLineage(value, row.job_id);
      value.applicationRecordId = applicationRecordId;
      const receipt = value.privacyReceipt;
      if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
        const lineage = (receipt as Record<string, unknown>).lineage;
        if (lineage && typeof lineage === "object" && !Array.isArray(lineage)) {
          const lineageValue = lineage as Record<string, unknown>;
          const matchesResult =
            lineageValue.runId === row.run_id &&
            lineageValue.jobId === row.job_id &&
            lineageValue.resultId === row.id;
          const existingApplicationRecordMatches =
            !Object.prototype.hasOwnProperty.call(
              lineageValue,
              "applicationRecordId",
            ) || lineageValue.applicationRecordId === applicationRecordId;
          lineageValue.applicationRecordId =
            matchesResult && existingApplicationRecordMatches
              ? applicationRecordId
              : null;
        }
      }
      updateResult.run(applicationRecordId, JSON.stringify(value), row.id);
      resultLineage.set(row.id, {
        runId: row.run_id,
        jobId: row.job_id,
        applicationRecordId,
      });
    }

    const descendantTables = [
      "application_question_records",
      "application_answer_records",
      "application_artifact_refs",
      "application_replay_checkpoints",
      "application_consent_requests",
    ] as const;
    for (const tableName of descendantTables) {
      const rows = database
        .prepare(
          `SELECT id, run_id, job_id, result_id, value FROM ${tableName}`,
        )
        .all() as Array<{
        id: string;
        run_id: string;
        job_id: string;
        result_id: string | null;
        value: string;
      }>;
      const update = database.prepare(
        `UPDATE ${tableName} SET application_record_id = ?, value = ? WHERE id = ?`,
      );
      for (const row of rows) {
        const value = parseMigrationObject(tableName, row.id, row.value);
        const result = row.result_id ? resultLineage.get(row.result_id) : null;
        const applicationRecordId =
          result && result.runId === row.run_id && result.jobId === row.job_id
            ? result.applicationRecordId
            : null;
        value.applicationRecordId = applicationRecordId;
        update.run(applicationRecordId, JSON.stringify(value), row.id);
      }
    }

    const attemptRows = database
      .prepare("SELECT id, value FROM application_attempts")
      .all() as Array<{ id: string; value: string }>;
    const updateAttempt = database.prepare(
      `UPDATE application_attempts
       SET job_id = ?, application_record_id = ?, updated_at = ?, value = ?
       WHERE id = ?`,
    );
    for (const row of attemptRows) {
      const value = parseMigrationObject(
        "application_attempts",
        row.id,
        row.value,
      );
      const jobId = typeof value.jobId === "string" ? value.jobId : null;
      const updatedAt =
        typeof value.updatedAt === "string" ? value.updatedAt : null;
      const applicationRecordId = jobId
        ? resolveDirectLineage(value, jobId)
        : null;
      value.applicationRecordId = applicationRecordId;
      updateAttempt.run(
        jobId,
        applicationRecordId,
        updatedAt,
        JSON.stringify(value),
        row.id,
      );
    }

    const userActionRows = database
      .prepare("SELECT id, value FROM user_action_requests")
      .all() as Array<{ id: string; value: string }>;
    const updateUserAction = database.prepare(
      "UPDATE user_action_requests SET application_record_id = ?, value = ? WHERE id = ?",
    );
    for (const row of userActionRows) {
      const value = parseMigrationObject(
        "user_action_requests",
        row.id,
        row.value,
      );
      const scope = value.scope;
      let applicationRecordId: string | null = null;
      if (scope && typeof scope === "object" && !Array.isArray(scope)) {
        const scopeValue = scope as Record<string, unknown>;
        if (
          scopeValue.type === "application" &&
          typeof scopeValue.resultId === "string" &&
          typeof scopeValue.runId === "string" &&
          typeof scopeValue.jobId === "string"
        ) {
          const result = resultLineage.get(scopeValue.resultId);
          if (
            result?.runId === scopeValue.runId &&
            result.jobId === scopeValue.jobId
          ) {
            applicationRecordId = result.applicationRecordId;
          }
          scopeValue.applicationRecordId = applicationRecordId;
        }
      }
      updateUserAction.run(applicationRecordId, JSON.stringify(value), row.id);
    }
  }

  function applyApplicationLineageMigration(): void {
    ensureApplicationLineageColumns();
    backfillApplicationRecordLineage();
  }

  function applyApplicationPreparationStartedMigration(): void {
    if (!hasColumn("apply_job_results", "application_preparation_started_at")) {
      database.exec(
        "ALTER TABLE apply_job_results ADD COLUMN application_preparation_started_at TEXT",
      );
    }
    if (
      !hasColumn(
        "apply_job_results",
        "application_preparation_started_local_date",
      )
    ) {
      database.exec(
        "ALTER TABLE apply_job_results ADD COLUMN application_preparation_started_local_date TEXT",
      );
    }

    const rows = database
      .prepare("SELECT id, value FROM apply_job_results")
      .all() as Array<{ id: string; value: string }>;
    const update = database.prepare(`
      UPDATE apply_job_results
      SET application_preparation_started_at = ?,
          application_preparation_started_local_date = ?
      WHERE id = ?
    `);
    for (const row of rows) {
      const persisted = parseMigrationObject(
        "apply_job_results",
        row.id,
        row.value,
      );
      // Read the two mirrored scalars defensively instead of parsing the whole
      // legacy row against the current schema: an unrelated drifted field must
      // not roll the migration back and leave the workspace unopenable on every
      // later launch. The paired invariant is preserved — a half-set legacy row
      // stays unknown rather than inventing the missing half.
      const startedAt =
        typeof persisted.applicationPreparationStartedAt === "string"
          ? persisted.applicationPreparationStartedAt
          : null;
      const startedLocalDate =
        typeof persisted.applicationPreparationStartedLocalDate === "string"
          ? persisted.applicationPreparationStartedLocalDate
          : null;
      const paired = startedAt !== null && startedLocalDate !== null;
      update.run(
        paired ? startedAt : null,
        paired ? startedLocalDate : null,
        row.id,
      );
    }

    database.exec(`
      CREATE INDEX IF NOT EXISTS apply_job_results_preparation_local_date_run_job_idx
        ON apply_job_results(
          application_preparation_started_local_date,
          run_id,
          job_id
        );
    `);
  }

  /**
   * Returns `false` only when the default campaign could not be created yet and
   * the attempt must be retried on a later launch. The caller records schema
   * version 10 exactly when this returns `true`, so a deferred workspace keeps
   * re-running this migration instead of banking a version it never applied.
   */
  function ensureDefaultCampaignState(): boolean {
    const existing = database
      .prepare("SELECT value FROM singleton_state WHERE key = ?")
      .get("campaign_state");
    if (existing) return true;

    const preferencesRow = database
      .prepare("SELECT value FROM singleton_state WHERE key = ?")
      .get("search_preferences") as { value?: unknown } | undefined;
    if (typeof preferencesRow?.value !== "string") return true;

    // Invalid JSON stays fail-closed: that is genuine corruption, and startup
    // recovery is built to act on it. Schema drift is different — a legacy
    // preferences blob that no longer matches the current schema must not roll
    // the whole migration back, because every other pending migration in the
    // same transaction would roll back with it and re-fail on every later
    // launch. Defer this one migration instead, so a repaired preferences row
    // still gets its legacy discovery history mapped into the default campaign.
    const persistedPreferences = JSON.parse(preferencesRow.value) as unknown;
    let searchPreferences: ReturnType<typeof JobSearchPreferencesSchema.parse>;
    try {
      searchPreferences =
        JobSearchPreferencesSchema.parse(persistedPreferences);
    } catch {
      console.warn(
        "[DB migration] Deferring default campaign creation because the persisted search preferences do not match the current schema. The workspace still fails closed when those preferences are read; repair that row and reopen to complete this migration.",
      );
      return false;
    }
    const now = new Date().toISOString();
    const campaignId = "campaign_default";
    const discoveryRow = database
      .prepare("SELECT value FROM singleton_state WHERE key = ?")
      .get("discovery_state") as { value?: unknown } | undefined;
    const legacyRuns = readLegacyDiscoveryRuns(discoveryRow?.value);
    const campaign = {
      id: campaignId,
      name: "My job search",
      description: "Your existing Job Finder workspace.",
      mode: "precision" as const,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
      searchPreferences,
      sourceTargetIds: searchPreferences.discovery.targets
        .filter((target) => target.enabled)
        .map((target) => target.id),
      jobIds: (
        database
          .prepare("SELECT id FROM saved_jobs ORDER BY id")
          .all() as Array<{
          id: string;
        }>
      ).map((row) => row.id),
      minimumFitScore: null,
      ...getDefaultCampaignConfiguration("precision"),
      schedule: {},
      progress: { lastUpdatedAt: now },
      history: [
        ...legacyRuns.map((run) => ({
          id: `campaign_history_discovery_${run.id}`,
          campaignId,
          kind: "discovery_run" as const,
          occurredAt: run.completedAt ?? run.startedAt,
          summary: `Imported discovery run ${run.id}.`,
          discoveryRunId: run.id,
        })),
        {
          id: "campaign_history_default_created",
          campaignId,
          kind: "created" as const,
          occurredAt: now,
          summary: "Existing workspace moved into the default campaign.",
          discoveryRunId: null,
        },
      ],
    };
    database
      .prepare("INSERT INTO singleton_state (key, value) VALUES (?, ?)")
      .run(
        "campaign_state",
        JSON.stringify({ activeCampaignId: campaignId, campaigns: [campaign] }),
      );
    return true;
  }

  /**
   * Materializes the inverse campaign/job relationship on each shared job.
   * Campaign jobIds remain the authoritative retained order; this field lets
   * every job record answer which plans retain it without copying content.
   */
  function backfillSavedJobCampaignIds(): void {
    const campaignRow = database
      .prepare("SELECT value FROM singleton_state WHERE key = ?")
      .get("campaign_state") as { value?: unknown } | undefined;
    const memberships = new Map<string, Set<string>>();
    if (typeof campaignRow?.value === "string") {
      const state = JSON.parse(campaignRow.value) as unknown;
      if (state && typeof state === "object" && "campaigns" in state) {
        const campaigns = (state as { campaigns?: unknown }).campaigns;
        if (Array.isArray(campaigns)) {
          for (const campaign of campaigns) {
            if (!campaign || typeof campaign !== "object") continue;
            const id = (campaign as { id?: unknown }).id;
            const jobIds = (campaign as { jobIds?: unknown }).jobIds;
            if (typeof id !== "string" || !Array.isArray(jobIds)) continue;
            for (const jobId of jobIds) {
              if (typeof jobId !== "string") continue;
              const plans = memberships.get(jobId) ?? new Set<string>();
              plans.add(id);
              memberships.set(jobId, plans);
            }
          }
        }
      }
    }

    const rows = database
      .prepare("SELECT id, value FROM saved_jobs")
      .all() as Array<{ id: string; value: string }>;
    const update = database.prepare(
      "UPDATE saved_jobs SET value = ? WHERE id = ?",
    );
    for (const row of rows) {
      const job = parseMigrationObject("saved_jobs", row.id, row.value);
      const existing = Array.isArray(job.campaignIds)
        ? job.campaignIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const campaignIds = [
        ...new Set([...existing, ...(memberships.get(row.id) ?? [])]),
      ].sort();
      update.run(JSON.stringify({ ...job, campaignIds }), row.id);
    }
  }

  function ensureResumeImportTables(): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS resume_import_runs (
        id TEXT PRIMARY KEY,
        source_resume_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        status TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS resume_import_runs_source_resume_id_idx
        ON resume_import_runs(source_resume_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS resume_import_document_bundles (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        source_resume_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS resume_import_document_bundles_run_id_idx
        ON resume_import_document_bundles(run_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS resume_import_document_bundles_source_resume_id_idx
        ON resume_import_document_bundles(source_resume_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS resume_import_field_candidates (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        resolution TEXT NOT NULL,
        created_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS resume_import_field_candidates_run_id_idx
        ON resume_import_field_candidates(run_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS resume_import_field_candidates_resolution_idx
        ON resume_import_field_candidates(resolution, created_at DESC);
    `);
  }

  function ensureProfileCopilotTables(): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS profile_copilot_messages (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS profile_copilot_messages_created_at_idx
        ON profile_copilot_messages(created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS profile_revisions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS profile_revisions_created_at_idx
        ON profile_revisions(created_at DESC, id ASC);
    `);
  }

  function repairProfileRecordAchievementFragments(profile: unknown): boolean {
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      return false;
    }

    const profileRecord = profile as Record<string, unknown>;
    if (!Array.isArray(profileRecord.experiences)) return false;
    let changed = false;

    for (const experience of profileRecord.experiences) {
      if (
        !experience ||
        typeof experience !== "object" ||
        Array.isArray(experience)
      ) {
        continue;
      }
      const experienceRecord = experience as Record<string, unknown>;
      if (
        !Array.isArray(experienceRecord.achievements) ||
        !experienceRecord.achievements.every(
          (achievement) => typeof achievement === "string",
        )
      ) {
        continue;
      }

      const achievements = experienceRecord.achievements;
      const repaired = repairLegacyCommaSplitAchievements(achievements);
      if (
        repaired.length === achievements.length &&
        repaired.every((value, index) => value === achievements[index])
      ) {
        continue;
      }

      experienceRecord.achievements = repaired;
      changed = true;
    }

    return changed;
  }

  function repairPersistedProfileAchievementFragments(): void {
    if (hasTable("singleton_state")) {
      const row = database
        .prepare("SELECT value FROM singleton_state WHERE key = ?")
        .get("profile") as { value?: string } | undefined;

      if (row?.value) {
        try {
          const profile = JSON.parse(row.value) as unknown;
          if (repairProfileRecordAchievementFragments(profile)) {
            database
              .prepare("UPDATE singleton_state SET value = ? WHERE key = ?")
              .run(JSON.stringify(profile), "profile");
          }
        } catch {
          // Leave malformed legacy state untouched; schema loading will surface it.
        }
      }
    }

    if (!hasTable("profile_revisions")) return;

    const revisionRows = database
      .prepare("SELECT id, value FROM profile_revisions")
      .all() as Array<{ id: string; value: string }>;
    const updateRevision = database.prepare(
      "UPDATE profile_revisions SET value = ? WHERE id = ?",
    );

    for (const row of revisionRows) {
      try {
        const revision = JSON.parse(row.value) as unknown;
        if (
          revision &&
          typeof revision === "object" &&
          !Array.isArray(revision) &&
          repairProfileRecordAchievementFragments(
            (revision as Record<string, unknown>).snapshotProfile,
          )
        ) {
          updateRevision.run(JSON.stringify(revision), row.id);
        }
      } catch {
        // Leave malformed revision rows untouched; schema loading will surface them.
      }
    }
  }

  function repairPersistedCompanyAliasNormalization(): void {
    if (!hasTable("singleton_state")) return;

    const row = database
      .prepare("SELECT value FROM singleton_state WHERE key = ?")
      .get("intelligence_state") as { value?: string } | undefined;
    if (!row?.value) return;

    try {
      const intelligence = JSON.parse(row.value) as unknown;
      if (
        !intelligence ||
        typeof intelligence !== "object" ||
        Array.isArray(intelligence) ||
        !Array.isArray((intelligence as { companies?: unknown }).companies)
      ) {
        return;
      }

      let changed = false;
      for (const company of (intelligence as { companies: unknown[] })
        .companies) {
        if (
          !company ||
          typeof company !== "object" ||
          Array.isArray(company) ||
          !Array.isArray((company as { aliases?: unknown }).aliases)
        ) {
          continue;
        }

        for (const alias of (company as { aliases: unknown[] }).aliases) {
          if (!alias || typeof alias !== "object" || Array.isArray(alias)) {
            continue;
          }
          const aliasRecord = alias as Record<string, unknown>;
          if (typeof aliasRecord.alias !== "string") continue;
          const normalized = normalizeCompanyName(aliasRecord.alias);
          if (!normalized || aliasRecord.normalized === normalized) continue;
          aliasRecord.normalized = normalized;
          changed = true;
        }
      }

      if (changed) {
        database
          .prepare("UPDATE singleton_state SET value = ? WHERE key = ?")
          .run(JSON.stringify(intelligence), "intelligence_state");
      }
    } catch {
      // Leave unrelated malformed state untouched; schema loading will surface it.
    }
  }

  /**
   * Backfills `sourceTargetId` on stored outcome events.
   *
   * Outcomes recorded the source *kind*, which has one value for every job,
   * so the Outcomes screen's "source" breakdown was a single bucket holding
   * everything. The job's own discovery provenance names the saved source it
   * came from; where that lineage exists it is copied onto the event, and
   * where it does not the field stays null so the event groups under the
   * unknown-source bucket rather than disappearing.
   */
  function backfillOutcomeEventSourceTargetIds(): void {
    if (!hasTable("singleton_state") || !hasTable("saved_jobs")) return;

    const row = database
      .prepare("SELECT value FROM singleton_state WHERE key = ?")
      .get("intelligence_state") as { value?: string } | undefined;
    if (!row?.value) return;

    try {
      const intelligence = JSON.parse(row.value) as unknown;
      if (
        !intelligence ||
        typeof intelligence !== "object" ||
        Array.isArray(intelligence) ||
        !Array.isArray(
          (intelligence as { outcomeEvents?: unknown }).outcomeEvents,
        )
      ) {
        return;
      }

      const lineageByJobId = new Map<string, string>();
      const jobRows = database
        .prepare("SELECT id, value FROM saved_jobs")
        .all() as Array<{ id?: unknown; value?: unknown }>;
      for (const jobRow of jobRows) {
        if (typeof jobRow.value !== "string") continue;
        try {
          const job = JSON.parse(jobRow.value) as unknown;
          if (!job || typeof job !== "object" || Array.isArray(job)) continue;
          const record = job as Record<string, unknown>;
          const id = typeof record.id === "string" ? record.id : null;
          if (!id) continue;
          const provenance = Array.isArray(record.provenance)
            ? record.provenance
            : [];
          for (const entry of provenance) {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              continue;
            }
            const targetId = (entry as Record<string, unknown>).targetId;
            if (typeof targetId === "string" && targetId.trim().length > 0) {
              lineageByJobId.set(id, targetId);
              break;
            }
          }
        } catch {
          // A malformed saved job contributes no lineage; schema loading
          // surfaces it separately.
        }
      }

      let changed = false;
      for (const event of (intelligence as { outcomeEvents: unknown[] })
        .outcomeEvents) {
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          continue;
        }
        const eventRecord = event as Record<string, unknown>;
        if (typeof eventRecord.sourceTargetId === "string") continue;
        const jobId =
          typeof eventRecord.jobId === "string" ? eventRecord.jobId : null;
        const targetId = jobId ? (lineageByJobId.get(jobId) ?? null) : null;
        if (eventRecord.sourceTargetId === targetId) continue;
        eventRecord.sourceTargetId = targetId;
        changed = true;
      }

      if (changed) {
        database
          .prepare("UPDATE singleton_state SET value = ? WHERE key = ?")
          .run(JSON.stringify(intelligence), "intelligence_state");
      }
    } catch {
      // Leave unrelated malformed state untouched; schema loading will
      // surface it.
    }
  }

  function ensureApplyFoundationTables(): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS apply_runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS apply_runs_updated_at_idx
        ON apply_runs(updated_at DESC, id ASC);

      CREATE TABLE IF NOT EXISTS apply_job_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        queue_position INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        state TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS apply_job_results_run_id_idx
        ON apply_job_results(run_id, queue_position ASC, updated_at DESC, id ASC);

      CREATE INDEX IF NOT EXISTS apply_job_results_job_id_idx
        ON apply_job_results(job_id, updated_at DESC, id ASC);

      CREATE UNIQUE INDEX IF NOT EXISTS apply_job_results_run_job_unique_idx
        ON apply_job_results(run_id, job_id);

      CREATE TABLE IF NOT EXISTS apply_submit_approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS apply_submit_approvals_run_id_idx
        ON apply_submit_approvals(run_id, created_at DESC, id ASC);

      CREATE TABLE IF NOT EXISTS application_question_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        result_id TEXT,
        detected_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS application_question_records_run_job_idx
        ON application_question_records(run_id, job_id, detected_at ASC, id ASC);

      CREATE INDEX IF NOT EXISTS application_question_records_result_idx
        ON application_question_records(result_id, detected_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS application_answer_records (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        result_id TEXT,
        question_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS application_answer_records_question_idx
        ON application_answer_records(question_id, created_at ASC, id ASC);

      CREATE INDEX IF NOT EXISTS application_answer_records_run_job_idx
        ON application_answer_records(run_id, job_id, created_at ASC, id ASC);

      CREATE INDEX IF NOT EXISTS application_answer_records_result_idx
        ON application_answer_records(result_id, created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS application_artifact_refs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        result_id TEXT,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS application_artifact_refs_result_idx
        ON application_artifact_refs(result_id, created_at DESC, id ASC);

      CREATE INDEX IF NOT EXISTS application_artifact_refs_run_job_idx
        ON application_artifact_refs(run_id, job_id, created_at DESC, id ASC);

      CREATE TABLE IF NOT EXISTS application_replay_checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        result_id TEXT,
        created_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS application_replay_checkpoints_result_idx
        ON application_replay_checkpoints(result_id, created_at DESC, id ASC);

      CREATE INDEX IF NOT EXISTS application_replay_checkpoints_run_job_idx
        ON application_replay_checkpoints(run_id, job_id, created_at DESC, id ASC);

      CREATE TABLE IF NOT EXISTS application_consent_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        result_id TEXT,
        requested_at TEXT NOT NULL,
        status TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS application_consent_requests_result_idx
        ON application_consent_requests(result_id, requested_at DESC, id ASC);

      CREATE INDEX IF NOT EXISTS application_consent_requests_run_job_idx
        ON application_consent_requests(run_id, job_id, requested_at DESC, id ASC);
    `);
  }

  /**
   * Typed authority state is intentionally kept in dedicated collections.
   * Legacy apply rows and settings never populate these tables, so an old
   * workspace remains prepare-only by absence of an authority envelope.
   */
  function ensureApplicationAuthorityTables(): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS application_authority_envelopes (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS application_authority_envelopes_status_idx
        ON application_authority_envelopes(status, revision DESC, id ASC);

      -- There is one user authority scope per workspace. The partial unique
      -- index makes that invariant hold for every SQLite writer, not only the
      -- repository methods that perform the normal preflight checks.
      CREATE UNIQUE INDEX IF NOT EXISTS application_authority_envelopes_active_unique_idx
        ON application_authority_envelopes(status)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS submission_preflights (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        result_id TEXT NOT NULL,
        application_record_id TEXT NOT NULL,
        authority_envelope_id TEXT NOT NULL,
        authority_revision INTEGER NOT NULL CHECK (authority_revision > 0),
        created_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS submission_preflights_lineage_idx
        ON submission_preflights(run_id, job_id, created_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS submission_execution_grants (
        id TEXT PRIMARY KEY,
        preflight_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        value TEXT NOT NULL,
        FOREIGN KEY (preflight_id) REFERENCES submission_preflights(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS submission_execution_grants_preflight_unique_idx
        ON submission_execution_grants(preflight_id);

      CREATE INDEX IF NOT EXISTS submission_execution_grants_status_idx
        ON submission_execution_grants(status, expires_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS submission_idempotency_records (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        preflight_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        value TEXT NOT NULL,
        FOREIGN KEY (preflight_id) REFERENCES submission_preflights(id)
      );

      CREATE INDEX IF NOT EXISTS submission_idempotency_records_status_idx
        ON submission_idempotency_records(status, updated_at DESC, id ASC);

      CREATE TABLE IF NOT EXISTS submission_armed_markers (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        preflight_id TEXT NOT NULL UNIQUE,
        armed_at TEXT NOT NULL,
        value TEXT NOT NULL,
        FOREIGN KEY (preflight_id) REFERENCES submission_preflights(id)
      );

      CREATE INDEX IF NOT EXISTS submission_armed_markers_armed_at_idx
        ON submission_armed_markers(armed_at ASC, id ASC);

      CREATE TABLE IF NOT EXISTS submission_outcome_records (
        id TEXT PRIMARY KEY,
        preflight_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        result_id TEXT NOT NULL,
        application_record_id TEXT NOT NULL,
        attempted_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        value TEXT NOT NULL,
        FOREIGN KEY (preflight_id) REFERENCES submission_preflights(id)
      );

      CREATE INDEX IF NOT EXISTS submission_outcome_records_key_idx
        ON submission_outcome_records(idempotency_key, attempted_at ASC, id ASC);

      CREATE INDEX IF NOT EXISTS submission_outcome_records_lineage_idx
        ON submission_outcome_records(run_id, job_id, attempted_at ASC, id ASC);
    `);
  }

  /**
   * Approved answer snapshots are immutable history, separate from authority
   * envelopes and their execution children. The repository only appends rows;
   * reset/bootstrap is the sole full-collection replacement path.
   */
  function ensureApplicationAnswerSnapshotTables(): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS application_answer_snapshots (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        digest TEXT NOT NULL,
        source_profile_revision INTEGER NOT NULL CHECK (source_profile_revision > 0),
        approved_at TEXT NOT NULL,
        value TEXT NOT NULL,
        UNIQUE (profile_id, revision)
      );

      CREATE INDEX IF NOT EXISTS application_answer_snapshots_profile_revision_idx
        ON application_answer_snapshots(profile_id, revision DESC, id ASC);
    `);
  }

  /**
   * One `PRAGMA table_info` per table instead of one per column: the authority
   * shape is checked on every workspace open, so the repeated probe cost is
   * paid by every launch.
   */
  function listTableColumns(tableName: string): Set<string> {
    if (!hasTable(tableName)) return new Set<string>();
    const columns = database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: unknown }>;
    return new Set(columns.map((column) => String(column.name)));
  }

  function assertApplicationAuthorityTableShape(): void {
    for (const [tableName, columnNames] of Object.entries(
      APPLICATION_AUTHORITY_REQUIRED_COLUMNS,
    )) {
      const presentColumns = listTableColumns(tableName);
      for (const columnName of columnNames) {
        if (!presentColumns.has(columnName)) {
          throw new Error(
            `Application authority migration is incomplete: ${tableName}.${columnName} is missing.`,
          );
        }
      }
    }
  }

  function countTableRows(tableName: string): number {
    const row = database
      .prepare(`SELECT COUNT(*) AS count FROM ${tableName}`)
      .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  function listDriftedApplicationAuthorityTables(): string[] {
    return Object.entries(APPLICATION_AUTHORITY_REQUIRED_COLUMNS)
      .filter(([tableName, columnNames]) => {
        if (!hasTable(tableName)) return false;
        const presentColumns = listTableColumns(tableName);
        return columnNames.some(
          (columnName) => !presentColumns.has(columnName),
        );
      })
      .map(([tableName]) => tableName);
  }

  /**
   * Column-level repair for the authority tables. `CREATE TABLE IF NOT EXISTS`
   * cannot fix a table that already exists with an outdated shape, so a drifted
   * workspace would otherwise fail the shape assert on every launch with no
   * recovery path. These tables only ever hold typed authority state written by
   * the repository, so an empty drifted table is rebuilt; one that still holds
   * rows is never silently discarded and fails with an actionable error.
   */
  function repairApplicationAuthorityTableShape(): void {
    const driftedTables = listDriftedApplicationAuthorityTables();
    if (driftedTables.length === 0) return;

    for (const tableName of driftedTables) {
      if (countTableRows(tableName) > 0) {
        throw new Error(
          `Application authority migration cannot repair ${tableName}: its column shape is outdated and it still holds rows. Restore a workspace backup or remove those rows before reopening this workspace.`,
        );
      }
    }

    for (const tableName of APPLICATION_AUTHORITY_TABLE_DROP_ORDER) {
      if (driftedTables.includes(tableName)) {
        database.exec(`DROP TABLE IF EXISTS ${tableName}`);
      }
    }
  }

  function hasApplicationAnswerSnapshotColumnDrift(): boolean {
    if (!hasTable("application_answer_snapshots")) return false;
    const presentColumns = listTableColumns("application_answer_snapshots");
    return APPLICATION_ANSWER_SNAPSHOT_REQUIRED_COLUMNS.some(
      (columnName) => !presentColumns.has(columnName),
    );
  }

  /** Same column-level repair contract as the authority tables. */
  function repairApplicationAnswerSnapshotTableShape(): void {
    if (!hasApplicationAnswerSnapshotColumnDrift()) return;

    if (countTableRows("application_answer_snapshots") > 0) {
      throw new Error(
        "Approved application answer snapshot migration cannot repair application_answer_snapshots: its column shape is outdated and it still holds rows. Restore a workspace backup or remove those rows before reopening this workspace.",
      );
    }

    database.exec("DROP TABLE IF EXISTS application_answer_snapshots");
  }

  function assertApplicationAnswerSnapshotTableShape(): void {
    const presentColumns = listTableColumns("application_answer_snapshots");
    for (const columnName of APPLICATION_ANSWER_SNAPSHOT_REQUIRED_COLUMNS) {
      if (!presentColumns.has(columnName)) {
        throw new Error(
          `Approved application answer snapshot migration is incomplete: application_answer_snapshots.${columnName} is missing.`,
        );
      }
    }
    if (!hasIndex("application_answer_snapshots_profile_revision_idx")) {
      throw new Error(
        "Approved application answer snapshot migration is incomplete: application_answer_snapshots_profile_revision_idx is missing.",
      );
    }
  }

  /**
   * Backfilling the one-active-envelope unique index onto a workspace created
   * before that index existed is exactly the case where two active envelopes
   * can already be persisted, and creating the index over them fails. Resolve
   * that deterministically first — the newest active envelope survives and the
   * superseded ones are revoked — so the repair can never brick the workspace
   * it exists to repair. Runs inside the migration transaction, so a failure
   * rolls back instead of leaving a half-repaired database.
   */
  function resolveDuplicateActiveApplicationAuthorityEnvelopes(): void {
    if (!hasTable("application_authority_envelopes")) return;
    if (hasIndex("application_authority_envelopes_active_unique_idx")) return;

    const activeRows = database
      .prepare(
        `SELECT id, value FROM application_authority_envelopes
         WHERE status = 'active'
         ORDER BY revision DESC, id ASC`,
      )
      .all() as Array<{ id: string; value: string }>;
    if (activeRows.length <= 1) return;

    const update = database.prepare(
      "UPDATE application_authority_envelopes SET status = ?, value = ? WHERE id = ?",
    );
    const revokedAtFloor = new Date().toISOString();

    for (const row of activeRows.slice(1)) {
      let persisted: Record<string, unknown>;
      try {
        persisted = parseMigrationObject(
          "application_authority_envelopes",
          row.id,
          row.value,
        );
      } catch {
        throw new Error(
          `Application authority migration cannot revoke superseded active envelope "${row.id}": its persisted value is unreadable. Restore a workspace backup or remove that row before reopening this workspace.`,
        );
      }

      const createdAt =
        typeof persisted.createdAt === "string" ? persisted.createdAt : null;
      // revokedAt may never precede createdAt.
      const revokedAt =
        createdAt !== null && Date.parse(createdAt) > Date.parse(revokedAtFloor)
          ? createdAt
          : revokedAtFloor;

      update.run(
        "revoked",
        JSON.stringify({ ...persisted, status: "revoked", revokedAt }),
        row.id,
      );
      console.warn(
        `[DB migration] Revoked superseded active application authority envelope "${row.id}" so exactly one active envelope remains.`,
      );
    }
  }

  function ensureUserActionTables(): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_action_requests (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS user_action_requests_state_idx
        ON user_action_requests(state, updated_at DESC, id ASC);

      CREATE INDEX IF NOT EXISTS user_action_requests_scope_idx
        ON user_action_requests(scope_type, updated_at DESC, id ASC);

      CREATE TABLE IF NOT EXISTS user_action_events (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        previous_revision INTEGER NOT NULL CHECK (previous_revision >= 0),
        resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
        occurred_at TEXT NOT NULL,
        value TEXT NOT NULL,
        FOREIGN KEY (request_id) REFERENCES user_action_requests(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS user_action_events_request_idx
        ON user_action_events(request_id, occurred_at ASC, id ASC);
    `);
  }

  function rewritePersistedResultId(input: {
    tableName: string;
    rowId: string;
    serializedValue: string;
    survivorId: string;
  }): string | null {
    let parsedValue: unknown;

    try {
      parsedValue = JSON.parse(input.serializedValue) as unknown;
    } catch {
      console.warn(
        `[DB migration] Skipping embedded resultId rewrite for ${input.tableName}.${input.rowId} because the persisted value is not valid JSON.`,
      );
      return null;
    }

    if (
      !parsedValue ||
      typeof parsedValue !== "object" ||
      Array.isArray(parsedValue)
    ) {
      console.warn(
        `[DB migration] Skipping embedded resultId rewrite for ${input.tableName}.${input.rowId} because the persisted value is not a JSON object.`,
      );
      return null;
    }

    return JSON.stringify({
      ...parsedValue,
      resultId: input.survivorId,
    });
  }

  function dedupeApplyJobResultsByRunAndJob(): void {
    const evidenceTables = [
      "application_question_records",
      "application_answer_records",
      "application_artifact_refs",
      "application_replay_checkpoints",
      "application_consent_requests",
    ] as const;

    database.exec(`
      CREATE TEMP TABLE apply_job_result_dedupe_map AS
      WITH ranked_results AS (
        SELECT
          id,
          run_id,
          job_id,
          FIRST_VALUE(id) OVER (
            PARTITION BY run_id, job_id
            ORDER BY updated_at DESC, queue_position ASC, id ASC
          ) AS survivor_id,
          ROW_NUMBER() OVER (
            PARTITION BY run_id, job_id
            ORDER BY updated_at DESC, queue_position ASC, id ASC
          ) AS row_number
        FROM apply_job_results
      )
      SELECT id AS duplicate_id, survivor_id
      FROM ranked_results
      WHERE row_number > 1;
    `);

    for (const tableName of evidenceTables) {
      if (!hasTable(tableName)) {
        continue;
      }

      const rows = database
        .prepare(
          `
        SELECT
          ${tableName}.id AS id,
          ${tableName}.value AS value,
          apply_job_result_dedupe_map.survivor_id AS survivor_id
        FROM ${tableName}
        INNER JOIN apply_job_result_dedupe_map
          ON apply_job_result_dedupe_map.duplicate_id = ${tableName}.result_id;
      `,
        )
        .all();

      const updateStatement = database.prepare(`
        UPDATE ${tableName}
        SET value = ?, result_id = ?
        WHERE id = ?
      `);

      for (const row of rows) {
        if (
          !row ||
          typeof row !== "object" ||
          typeof (row as { id?: unknown }).id !== "string" ||
          typeof (row as { value?: unknown }).value !== "string" ||
          typeof (row as { survivor_id?: unknown }).survivor_id !== "string"
        ) {
          throw new Error(
            `Invalid ${tableName} evidence row while rewriting apply result ids.`,
          );
        }
        const typedRow = row as {
          id: string;
          value: string;
          survivor_id: string;
        };
        const rewrittenValue = rewritePersistedResultId({
          tableName,
          rowId: typedRow.id,
          serializedValue: typedRow.value,
          survivorId: typedRow.survivor_id,
        });

        updateStatement.run(
          rewrittenValue ?? typedRow.value,
          typedRow.survivor_id,
          typedRow.id,
        );
      }
    }

    database.exec(`
      DELETE FROM apply_job_results
      WHERE id IN (SELECT duplicate_id FROM apply_job_result_dedupe_map);

      DROP TABLE apply_job_result_dedupe_map;
    `);
  }

  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const versionRow = database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
    )
    .get() as { version?: number } | undefined;
  function confirmLegacyAgentAnswers() {
    const row = database
      .prepare("SELECT value FROM singleton_state WHERE key = 'profile'")
      .get() as { value: string } | undefined;
    const parsedProfile = row
      ? CandidateProfileSchema.safeParse(JSON.parse(row.value))
      : null;
    if (parsedProfile?.success) {
      const profile = parsedProfile.data;
      const questions = (
        database
          .prepare("SELECT value FROM application_question_records")
          .all() as { value: string }[]
      ).map((entry) =>
        ApplicationQuestionRecordSchema.parse(JSON.parse(entry.value)),
      );
      const answers = (
        database
          .prepare("SELECT value FROM application_answer_records")
          .all() as { value: string }[]
      ).map((entry) =>
        ApplicationAnswerRecordSchema.parse(JSON.parse(entry.value)),
      );
      const reviews = (
        database.prepare("SELECT value FROM apply_job_results").all() as {
          value: string;
        }[]
      )
        .map(
          (entry) =>
            ApplyJobResultSchema.parse(JSON.parse(entry.value)).reviewCard,
        )
        .filter((card) => card !== null);
      const repaired = quarantineAgentAnswers(
        profile,
        questions,
        answers,
        reviews,
      );
      if (JSON.stringify(profile) !== JSON.stringify(repaired)) {
        database
          .prepare(
            "UPDATE singleton_state SET value = ?, revision = revision + 1 WHERE key = 'profile'",
          )
          .run(JSON.stringify(repaired));
        // Approval of the old library cannot authorize those values after repair.
        const envelopes = database
          .prepare(
            "SELECT id, value FROM application_authority_envelopes WHERE status = 'active'",
          )
          .all() as { id: string; value: string }[];
        for (const envelope of envelopes) {
          const value = JSON.parse(envelope.value) as Record<string, unknown>;
          database
            .prepare(
              "UPDATE application_authority_envelopes SET status = 'revoked', value = ? WHERE id = ?",
            )
            .run(
              JSON.stringify({
                ...value,
                status: "revoked",
                revokedAt: new Date().toISOString(),
              }),
              envelope.id,
            );
        }
      }
    }
    database
      .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(19, "confirm_legacy_agent_answers");
  }

  const currentVersion = Number(versionRow?.version ?? 0);
  const appliedVersions = new Set(
    (
      database.prepare("SELECT version FROM schema_migrations").all() as Array<{
        version: number;
      }>
    ).map((row) => Number(row.version)),
  );

  if (currentVersion >= 4) {
    const resumeImportTablesMissing =
      !hasTable("resume_import_runs") ||
      !hasTable("resume_import_document_bundles") ||
      !hasTable("resume_import_field_candidates");
    const profileCopilotTablesMissing =
      !hasTable("profile_copilot_messages") || !hasTable("profile_revisions");
    const applyFoundationTablesMissing =
      !hasTable("apply_runs") ||
      !hasTable("apply_job_results") ||
      !hasTable("apply_submit_approvals") ||
      !hasTable("application_question_records") ||
      !hasTable("application_answer_records") ||
      !hasTable("application_artifact_refs") ||
      !hasTable("application_replay_checkpoints") ||
      !hasTable("application_consent_requests");
    const userActionTablesMissing =
      !hasTable("user_action_requests") || !hasTable("user_action_events");
    // Migration rows can be removed independently while reproducing or
    // repairing legacy databases. Do not let a later version hide a missing
    // earlier migration merely because MAX(version) is newer.
    const needsProfileCopilotMigration = !appliedVersions.has(5);
    const needsApplyFoundationMigration = !appliedVersions.has(6);
    const needsApplyFoundationIndexMigration = !appliedVersions.has(7);
    const needsProfileAchievementRepairMigration = !appliedVersions.has(8);
    const needsUserActionMigration = !appliedVersions.has(9);
    const needsCampaignMigration = !appliedVersions.has(10);
    const singletonRevisionColumnMissing = !hasSingletonStateRevisionColumn();
    const needsSingletonRevisionMigration = !appliedVersions.has(11);
    const applicationLineageColumnsMissing = applicationLineageTables.some(
      (tableName) => !hasColumn(tableName, "application_record_id"),
    );
    const applicationAttemptIndexColumnsMissing =
      !hasColumn("application_attempts", "job_id") ||
      !hasColumn("application_attempts", "updated_at");
    const needsApplicationLineageMigration = !appliedVersions.has(12);
    const applicationPreparationColumnsMissing =
      !hasColumn("apply_job_results", "application_preparation_started_at") ||
      !hasColumn(
        "apply_job_results",
        "application_preparation_started_local_date",
      );
    const applicationPreparationIndexMissing = !hasIndex(
      "apply_job_results_preparation_local_date_run_job_idx",
    );
    const needsApplicationPreparationStartedMigration =
      !appliedVersions.has(13);
    const needsCompanyAliasNormalizationMigration = !appliedVersions.has(14);
    const applicationAuthorityTablesMissing =
      !hasTable("application_authority_envelopes") ||
      !hasTable("submission_preflights") ||
      !hasTable("submission_execution_grants") ||
      !hasTable("submission_idempotency_records") ||
      !hasTable("submission_armed_markers") ||
      !hasTable("submission_outcome_records");
    // Detected at column granularity like every sibling migration, so a table
    // that exists with an outdated shape is repaired instead of failing the
    // shape assert forever.
    const applicationAuthorityColumnsMissing =
      listDriftedApplicationAuthorityTables().length > 0;
    const applicationAuthorityActiveUniqueIndexMissing =
      hasTable("application_authority_envelopes") &&
      !hasIndex("application_authority_envelopes_active_unique_idx");
    const needsApplicationAuthorityMigration = !appliedVersions.has(15);
    const applicationAnswerSnapshotTablesMissing = !hasTable(
      "application_answer_snapshots",
    );
    const applicationAnswerSnapshotColumnsMissing =
      hasApplicationAnswerSnapshotColumnDrift();
    const applicationAnswerSnapshotIndexMissing = !hasIndex(
      "application_answer_snapshots_profile_revision_idx",
    );
    const needsApplicationAnswerSnapshotMigration = !appliedVersions.has(16);
    const needsLegacyAgentAnswerMigration = !appliedVersions.has(19);
    const needsOutcomeSourceLineageMigration = !appliedVersions.has(17);
    const needsSavedJobCampaignMembershipMigration = !appliedVersions.has(18);

    if (
      resumeImportTablesMissing ||
      profileCopilotTablesMissing ||
      applyFoundationTablesMissing ||
      needsProfileCopilotMigration ||
      needsApplyFoundationMigration ||
      needsApplyFoundationIndexMigration ||
      needsProfileAchievementRepairMigration ||
      userActionTablesMissing ||
      needsUserActionMigration ||
      needsCampaignMigration ||
      singletonRevisionColumnMissing ||
      needsSingletonRevisionMigration ||
      applicationLineageColumnsMissing ||
      applicationAttemptIndexColumnsMissing ||
      needsApplicationLineageMigration ||
      applicationPreparationColumnsMissing ||
      applicationPreparationIndexMissing ||
      needsApplicationPreparationStartedMigration ||
      needsCompanyAliasNormalizationMigration ||
      applicationAuthorityTablesMissing ||
      applicationAuthorityColumnsMissing ||
      applicationAuthorityActiveUniqueIndexMissing ||
      needsApplicationAuthorityMigration ||
      applicationAnswerSnapshotTablesMissing ||
      applicationAnswerSnapshotColumnsMissing ||
      applicationAnswerSnapshotIndexMissing ||
      needsApplicationAnswerSnapshotMigration ||
      needsOutcomeSourceLineageMigration ||
      needsSavedJobCampaignMembershipMigration ||
      needsLegacyAgentAnswerMigration
    ) {
      database.exec("BEGIN IMMEDIATE");
      try {
        if (resumeImportTablesMissing) {
          ensureResumeImportTables();
        }

        if (profileCopilotTablesMissing || needsProfileCopilotMigration) {
          ensureProfileCopilotTables();
        }

        if (
          applyFoundationTablesMissing ||
          needsApplyFoundationMigration ||
          needsApplyFoundationIndexMigration
        ) {
          if (
            hasTable("apply_job_results") &&
            needsApplyFoundationIndexMigration
          ) {
            dedupeApplyJobResultsByRunAndJob();
          }

          ensureApplyFoundationTables();
        }

        if (userActionTablesMissing || needsUserActionMigration) {
          ensureUserActionTables();
        }

        if (needsProfileCopilotMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(5, "job_finder_profile_copilot_history");
        }

        if (needsApplyFoundationMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(6, "job_finder_apply_foundation");
        }

        if (needsApplyFoundationIndexMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(7, "job_finder_apply_foundation_dedupe");
        }

        if (needsProfileAchievementRepairMigration) {
          repairPersistedProfileAchievementFragments();
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(8, "repair_legacy_profile_achievement_fragments");
        }

        if (needsUserActionMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(9, "job_finder_user_actions");
        }

        if (needsCampaignMigration && ensureDefaultCampaignState()) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(10, "job_search_campaigns");
        }

        if (singletonRevisionColumnMissing || needsSingletonRevisionMigration) {
          ensureSingletonStateRevisionColumn();
        }

        if (needsSingletonRevisionMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(11, "singleton_state_revision");
        }

        if (
          applicationLineageColumnsMissing ||
          applicationAttemptIndexColumnsMissing ||
          needsApplicationLineageMigration
        ) {
          applyApplicationLineageMigration();
        }

        if (needsApplicationLineageMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(12, "exact_application_record_lineage");
        }

        if (
          applicationPreparationColumnsMissing ||
          applicationPreparationIndexMissing ||
          needsApplicationPreparationStartedMigration
        ) {
          applyApplicationPreparationStartedMigration();
        }

        if (needsApplicationPreparationStartedMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(13, "durable_application_preparation_started");
        }

        if (needsCompanyAliasNormalizationMigration) {
          repairPersistedCompanyAliasNormalization();
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(14, "repair_company_alias_normalization");
        }

        if (
          applicationAuthorityTablesMissing ||
          applicationAuthorityColumnsMissing ||
          applicationAuthorityActiveUniqueIndexMissing ||
          needsApplicationAuthorityMigration
        ) {
          repairApplicationAuthorityTableShape();
          resolveDuplicateActiveApplicationAuthorityEnvelopes();
          ensureApplicationAuthorityTables();
        }

        if (
          applicationAnswerSnapshotTablesMissing ||
          applicationAnswerSnapshotColumnsMissing ||
          applicationAnswerSnapshotIndexMissing ||
          needsApplicationAnswerSnapshotMigration
        ) {
          repairApplicationAnswerSnapshotTableShape();
          ensureApplicationAnswerSnapshotTables();
        }

        assertApplicationAuthorityTableShape();
        assertApplicationAnswerSnapshotTableShape();

        if (needsApplicationAuthorityMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(15, "application_authority_state");
        }

        if (needsApplicationAnswerSnapshotMigration) {
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(16, "approved_application_answer_snapshots");
        }

        if (needsOutcomeSourceLineageMigration) {
          backfillOutcomeEventSourceTargetIds();
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(17, "outcome_event_source_lineage");
        }

        if (needsSavedJobCampaignMembershipMigration) {
          backfillSavedJobCampaignIds();
          database
            .prepare(
              "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
            )
            .run(18, "saved_job_campaign_membership");
        }

        if (needsLegacyAgentAnswerMigration) confirmLegacyAgentAnswers();

        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }

    if (appliedVersions.has(15) || needsApplicationAuthorityMigration) {
      assertApplicationAuthorityTableShape();
    }

    if (appliedVersions.has(16) || needsApplicationAnswerSnapshotMigration) {
      assertApplicationAnswerSnapshotTableShape();
    }

    ensurePreparedApplicationForms();
    migrateDiscoveryStorage(database);
    ensureTailoredAssetJobIndex(database);
    ensureResumeApprovalState(database);
    migratePreferenceStorage(database);
    migrateResumeStorage(database);
    migrateSavedJobStorage(database);
    ensureWorkspaceReadIndex(database);
    return;
  }

  database.exec("BEGIN IMMEDIATE");

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS singleton_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS saved_jobs (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tailored_assets (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS application_records (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS application_attempts (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    if (currentVersion < 1) {
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(1, "job_finder_baseline");
    }

    if (currentVersion < 2) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS source_debug_runs (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS source_debug_attempts (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS source_instruction_artifacts (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS source_debug_evidence_refs (
          id TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(2, "job_finder_source_debug_artifacts");
    }

    if (currentVersion < 3) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS resume_drafts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS resume_drafts_job_id_idx
          ON resume_drafts(job_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS resume_draft_revisions (
          id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS resume_draft_revisions_draft_id_idx
          ON resume_draft_revisions(draft_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS resume_export_artifacts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          draft_id TEXT NOT NULL,
          exported_at TEXT NOT NULL,
          is_approved INTEGER NOT NULL DEFAULT 0,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS resume_export_artifacts_job_id_idx
          ON resume_export_artifacts(job_id, exported_at DESC);

        CREATE INDEX IF NOT EXISTS resume_export_artifacts_draft_id_idx
          ON resume_export_artifacts(draft_id, exported_at DESC);

        CREATE TABLE IF NOT EXISTS resume_research_artifacts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS resume_research_artifacts_job_id_idx
          ON resume_research_artifacts(job_id, fetched_at DESC);

        CREATE TABLE IF NOT EXISTS resume_validation_results (
          id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL,
          validated_at TEXT NOT NULL,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS resume_validation_results_draft_id_idx
          ON resume_validation_results(draft_id, validated_at DESC);

        CREATE TABLE IF NOT EXISTS resume_assistant_messages (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          value TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS resume_assistant_messages_job_id_idx
          ON resume_assistant_messages(job_id, created_at ASC);
      `);

      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(3, "job_finder_resume_workspace");
    }

    if (currentVersion < 4) {
      ensureResumeImportTables();

      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(4, "job_finder_resume_import_runs");
    }

    if (currentVersion < 5) {
      ensureProfileCopilotTables();

      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(5, "job_finder_profile_copilot_history");
    }

    if (currentVersion < 6) {
      if (hasTable("apply_job_results")) {
        dedupeApplyJobResultsByRunAndJob();
      }

      ensureApplyFoundationTables();

      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(6, "job_finder_apply_foundation");
    }

    if (currentVersion < 7) {
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(7, "job_finder_apply_foundation_dedupe");
    }

    if (currentVersion < 8) {
      repairPersistedProfileAchievementFragments();
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(8, "repair_legacy_profile_achievement_fragments");
    }

    if (currentVersion < 9) {
      ensureUserActionTables();
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(9, "job_finder_user_actions");
    }

    if (currentVersion < 10 && ensureDefaultCampaignState()) {
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(10, "job_search_campaigns");
    }

    if (currentVersion < 11) {
      ensureSingletonStateRevisionColumn();
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(11, "singleton_state_revision");
    }

    if (currentVersion < 12) {
      applyApplicationLineageMigration();
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(12, "exact_application_record_lineage");
    }

    if (currentVersion < 13) {
      applyApplicationPreparationStartedMigration();
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(13, "durable_application_preparation_started");
    }

    if (currentVersion < 14) {
      repairPersistedCompanyAliasNormalization();
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(14, "repair_company_alias_normalization");
    }

    if (currentVersion < 15) {
      repairApplicationAuthorityTableShape();
      resolveDuplicateActiveApplicationAuthorityEnvelopes();
      ensureApplicationAuthorityTables();

      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(15, "application_authority_state");
    }

    if (currentVersion < 16) {
      repairApplicationAnswerSnapshotTableShape();
      ensureApplicationAnswerSnapshotTables();

      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(16, "approved_application_answer_snapshots");
    }

    if (currentVersion < 17) {
      backfillOutcomeEventSourceTargetIds();

      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(17, "outcome_event_source_lineage");
    }

    if (currentVersion < 18) {
      backfillSavedJobCampaignIds();
      database
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(18, "saved_job_campaign_membership");
    }

    if (currentVersion < 19) confirmLegacyAgentAnswers();

    assertApplicationAuthorityTableShape();
    assertApplicationAnswerSnapshotTableShape();

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  ensurePreparedApplicationForms();
  migrateDiscoveryStorage(database);
  ensureTailoredAssetJobIndex(database);
  ensureResumeApprovalState(database);
  migratePreferenceStorage(database);
  migrateResumeStorage(database);
  migrateSavedJobStorage(database);
  ensureWorkspaceReadIndex(database);
}
