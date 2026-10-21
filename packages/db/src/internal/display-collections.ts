import type {
  DatabaseSync,
  SQLInputValue,
  StatementSync,
} from "node:sqlite";
import {
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ProfileCopilotMessageSchema,
  ProfileRevisionSchema,
  ResumeDraftSchema,
  ResumeExportArtifactSchema,
  ResumeResearchArtifactSchema,
  ResumeValidationResultSchema,
  SourceDebugWorkerAttemptSchema,
  SourceInstructionArtifactSchema,
  TailoredAssetSchema,
  UserActionEventSchema,
  UserActionRequestSchema,
} from "@nestor/contracts";
import type {
  JobFinderDisplayCollections,
  SchemaParser,
} from "../repository-types";
import { APPLY_COLLECTION_ORDER_BY_SQL } from "../apply-collection-support";
import {
  createRowValidationMarks,
  type ParseMarkedRow,
  type RowValidationStamp,
} from "./row-validation-marks";
import { freezeProjection } from "./saved-job-projection";
import { parsePersistedRowValue, type StateCollectionTable } from "./state";

/**
 * This is a borrowed read path, not a canonical repository cache. TEMP markers
 * cover every local writer (including reset/import), roll back with writes,
 * and data_version covers commits made by other SQLite connections.
 */
export function createDisplayCollectionsReader(
  database: DatabaseSync,
  options: {
    /** Who validates rows; marked tables skip the schema for rows it marked. */
    validationStamp?: RowValidationStamp;
  } = {},
) {
  const readVersion = database.prepare("PRAGMA data_version");

  function collection<T extends { id: string }>(
    table: StateCollectionTable,
    schema: SchemaParser<T>,
    orderBy: string,
    where = "1",
    { marked = false }: { marked?: boolean } = {},
  ): () => readonly T[] {
    const prefix = `display_${table}`;
    const marks = marked
      ? createRowValidationMarks(database, table, options.validationStamp)
      : null;
    const rowsSql = marks?.selectSql ?? `id, value FROM ${table}`;
    database.exec(`
      CREATE TEMP TABLE ${prefix}_epoch (revision INTEGER NOT NULL);
      INSERT INTO ${prefix}_epoch VALUES (0);
      CREATE TEMP TABLE ${prefix}_changes (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      ${["INSERT", "UPDATE", "DELETE"]
        .map((event) => {
          const row = event === "DELETE" ? "OLD" : "NEW";
          return `CREATE TEMP TRIGGER ${prefix}_${event.toLowerCase()}
          AFTER ${event} ON main.${table} BEGIN
            UPDATE ${prefix}_epoch SET revision = revision + 1;
            INSERT INTO ${prefix}_changes (id, revision)
              VALUES (${row}.id, (SELECT revision FROM ${prefix}_epoch))
              ON CONFLICT(id) DO UPDATE SET revision = excluded.revision;
          END;`;
        })
        .join("\n")}
    `);
    const epoch = database.prepare(`SELECT revision FROM ${prefix}_epoch`);
    const all = database.prepare(
      `SELECT ${rowsSql} WHERE ${where} ORDER BY ${orderBy}`,
    );
    const ids = database.prepare(
      `SELECT id FROM ${table} WHERE ${where} ORDER BY ${orderBy}`,
    );
    const changes = database.prepare(
      `SELECT id FROM ${prefix}_changes WHERE revision > ?`,
    );
    const changedRows = database.prepare(`SELECT ${rowsSql}
      WHERE (${where}) AND id IN (SELECT value FROM json_each(?))`);
    const clear = database.prepare(
      `DELETE FROM ${prefix}_changes WHERE revision <= ?`,
    );
    let snapshot: readonly T[] | null = null;
    let rowsById = new Map<string, T>();
    let cachedEpoch = -1;
    let cachedVersion = -1;
    /** Rows of one SELECT; a marked table marks those it validated. */
    const readRows = (
      statement: StatementSync,
      ...params: SQLInputValue[]
    ): T[] => {
      const run = (parse: ParseMarkedRow | null) =>
        statement.all(...params).map((row) =>
          freezeProjection(
            parse
              ? parse(row, schema)
              : parsePersistedRowValue({
                  tableName: table,
                  rowId: String(row.id),
                  rawValue: String(row.value),
                  schema,
                }),
          ),
        );
      return marks ? marks.read(run) : run(null);
    };

    return () => {
      const revision = Number(epoch.get()?.revision);
      const version = Number(readVersion.get()?.data_version);
      // A rollback may reuse an epoch. Reads within a transaction must neither
      // enter the committed cache nor consume that transaction's change markers.
      if (database.isTransaction) return Object.freeze(readRows(all));
      if (snapshot && revision === cachedEpoch && version === cachedVersion)
        return snapshot;
      let next: T[];
      if (!snapshot || version !== cachedVersion) {
        next = readRows(all);
      } else {
        const orderedIds = ids.all().map((row) => String(row.id));
        const dirty = new Set(
          changes.all(cachedEpoch).map((row) => String(row.id)),
        );
        // A latest-validation replacement can reveal an older row not in the
        // previous latest-only set, even though that row itself did not change.
        for (const id of orderedIds) if (!rowsById.has(id)) dirty.add(id);
        const replacements = new Map(
          readRows(changedRows, JSON.stringify([...dirty])).map(
            (value) => [value.id, value] as const,
          ),
        );
        next = orderedIds.map((id) => {
          const row = replacements.get(id) ?? rowsById.get(id);
          if (!row)
            throw new Error(
              `Display row "${id}" disappeared from table "${table}".`,
            );
          return row;
        });
      }
      // Publish only after every changed row validated successfully.
      rowsById = new Map(next.map((row) => [row.id, row]));
      snapshot = Object.freeze(next);
      cachedEpoch = revision;
      cachedVersion = version;
      clear.run(revision);
      return snapshot;
    };
  }

  const readers = {
    tailoredAssets: collection(
      "tailored_assets",
      TailoredAssetSchema,
      "id ASC",
    ),
    // About 18 MB of drafts on a large workspace: 0.3 s to validate.
    resumeDrafts: collection(
      "resume_drafts",
      ResumeDraftSchema,
      "updated_at DESC, id ASC",
      "1",
      { marked: true },
    ),
    resumeExportArtifacts: collection(
      "resume_export_artifacts",
      ResumeExportArtifactSchema,
      "exported_at DESC, id ASC",
    ),
    resumeResearchArtifacts: collection(
      "resume_research_artifacts",
      ResumeResearchArtifactSchema,
      "fetched_at DESC, id ASC",
    ),
    applyRuns: collection(
      "apply_runs",
      ApplyRunSchema,
      APPLY_COLLECTION_ORDER_BY_SQL.apply_runs,
    ),
    applyJobResults: collection(
      "apply_job_results",
      ApplyJobResultSchema,
      APPLY_COLLECTION_ORDER_BY_SQL.apply_job_results,
    ),
    applicationRecords: collection(
      "application_records",
      ApplicationRecordSchema,
      "id ASC",
    ),
    applicationAttempts: collection(
      "application_attempts",
      ApplicationAttemptSchema,
      "id ASC",
    ),
    sourceInstructionArtifacts: collection(
      "source_instruction_artifacts",
      SourceInstructionArtifactSchema,
      "id ASC",
    ),
    sourceDebugAttempts: collection(
      "source_debug_attempts",
      SourceDebugWorkerAttemptSchema,
      "id ASC",
    ),
    profileCopilotMessages: collection(
      "profile_copilot_messages",
      ProfileCopilotMessageSchema,
      "created_at ASC, id ASC",
    ),
    profileRevisions: collection(
      "profile_revisions",
      ProfileRevisionSchema,
      "created_at DESC, id ASC",
    ),
    userActionRequests: collection(
      "user_action_requests",
      UserActionRequestSchema,
      "updated_at DESC, id ASC",
    ),
    userActionEvents: collection(
      "user_action_events",
      UserActionEventSchema,
      "occurred_at ASC, id ASC",
    ),
    latestResumeValidationResults: collection(
      "resume_validation_results",
      ResumeValidationResultSchema,
      "validated_at DESC, id ASC",
      `id IN (
      SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY draft_id ORDER BY validated_at DESC, id ASC) AS position
        FROM resume_validation_results) WHERE position = 1
    )`,
    ),
  };
  return (): Promise<JobFinderDisplayCollections> => {
    try {
      return Promise.resolve({
        tailoredAssets: readers.tailoredAssets(),
        resumeDrafts: readers.resumeDrafts(),
        resumeExportArtifacts: readers.resumeExportArtifacts(),
        resumeResearchArtifacts: readers.resumeResearchArtifacts(),
        applyRuns: readers.applyRuns(),
        applyJobResults: readers.applyJobResults(),
        applicationRecords: readers.applicationRecords(),
        applicationAttempts: readers.applicationAttempts(),
        sourceInstructionArtifacts: readers.sourceInstructionArtifacts(),
        sourceDebugAttempts: readers.sourceDebugAttempts(),
        profileCopilotMessages: readers.profileCopilotMessages(),
        profileRevisions: readers.profileRevisions(),
        userActionRequests: readers.userActionRequests(),
        userActionEvents: readers.userActionEvents(),
        latestResumeValidationResults: readers.latestResumeValidationResults(),
      });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  };
}
