import { createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import {
  isLikelyUtilityShortlistJob,
  resolveSavedJobCompany,
  resolveSavedJobLocation,
  extractSalaryRangeFromListingBody,
  readDiscoveryPreparation,
  readPreparedBodySalaryRange,
  writeDiscoveryPreparation,
  type SavedJob,
} from "@nestor/contracts";
import {
  ensureSavedJobFingerprintStorage,
  writeSavedJobFingerprints,
} from "./saved-job-fingerprints";
import { notifyWorkspaceCommit } from "../workspace-commits";
import { writeSavedJobPlanAssessments } from "./saved-job-plan-assessments";
import { refreshSavedJobReadIndex } from "./workspace-read-index";

export const savedJobSalarySelectSql = `, (SELECT salary_prepared FROM job_listing_texts WHERE id = saved_jobs.description_id) AS body_salary_prepared,
  (SELECT salary_evidence FROM job_listing_texts WHERE id = saved_jobs.description_id) AS body_salary_range`;
export function attachStoredSavedJobSalary<T>(
  row: T,
  prepared: unknown,
  value: unknown,
): T {
  if (prepared === 1 && row !== null && typeof row === "object") {
    const preparation = {
      ...readDiscoveryPreparation(row),
      bodySalaryRange: value as ReturnType<
        typeof extractSalaryRangeFromListingBody
      >,
    };
    writeDiscoveryPreparation(row, preparation);
  }
  return row;
}

export function ensureSavedJobRelations(db: DatabaseSync): void {
  ensureSavedJobFingerprintStorage(db);
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(saved_jobs)")
      .all()
      .map((row) => String(row.name)),
  );
  for (const [name, type] of [
    ["description_id", "INTEGER"],
    ["assessment_id", "INTEGER"],
    ["has_plan_assessments", "INTEGER"],
    ["list_visible", "INTEGER"],
    ["display_company", "TEXT"],
    ["display_location", "TEXT"],
    ["first_seen_at", "TEXT"],
    ["last_seen_at", "TEXT"],
    ["last_verified_active_at", "TEXT"],
  ])
    if (!columns.has(name!))
      db.exec(`ALTER TABLE saved_jobs ADD COLUMN ${name!} ${type!}`);
  db.exec(`CREATE TABLE IF NOT EXISTS job_listing_texts(id INTEGER PRIMARY KEY, stable_key TEXT UNIQUE NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_fit_assessments(id INTEGER PRIMARY KEY, stable_key TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_plan_assessments(job_id TEXT NOT NULL REFERENCES saved_jobs(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL, value TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY(job_id, plan_id));
    CREATE TABLE IF NOT EXISTS job_provenance(job_id TEXT NOT NULL REFERENCES saved_jobs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, value TEXT NOT NULL, description_id INTEGER REFERENCES job_listing_texts(id), PRIMARY KEY(job_id, position));`);
  const textColumns = new Set(
    db
      .prepare("PRAGMA table_info(job_listing_texts)")
      .all()
      .map((column) => column.name),
  );
  if (!textColumns.has("salary_prepared"))
    db.exec(
      "ALTER TABLE job_listing_texts ADD COLUMN salary_prepared INTEGER NOT NULL DEFAULT 0",
    );
  if (!textColumns.has("salary_evidence"))
    db.exec("ALTER TABLE job_listing_texts ADD COLUMN salary_evidence TEXT");
}
// Prepared SQL belongs to the connection, not to each changed job.
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function statement(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map<string, StatementSync>()));
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}
function intern(
  db: DatabaseSync,
  table: "job_listing_texts" | "job_fit_assessments",
  value: string,
  preparedSalary?: string | null,
): number {
  const key = createHash("sha256").update(value).digest("hex");
  const column = table === "job_listing_texts" ? "text" : "value";
  const read = statement(
    db,
    `SELECT id${table === "job_listing_texts" ? ", salary_prepared" : ""} FROM ${table} WHERE stable_key = ?`,
  );
  let stored = read.get(key);
  if (!stored) {
    statement(
      db,
      `INSERT INTO ${table}(stable_key, ${column}) VALUES (?, ?)`,
    ).run(key, value);
    stored = read.get(key)!;
  }
  if (table === "job_listing_texts" && stored.salary_prepared !== 1)
    statement(
      db,
      "UPDATE job_listing_texts SET salary_prepared = 1, salary_evidence = ? WHERE id = ?",
    ).run(
      preparedSalary === undefined
        ? extractSalaryRangeFromListingBody(value)
        : preparedSalary,
      stored.id!,
    );
  return Number(stored.id);
}

/** Current and source descriptions share text rows; plan verdicts share assessment rows. */
export function writeSavedJobStorage(db: DatabaseSync, job: SavedJob): void {
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const {
      description,
      matchAssessment,
      planAssessments,
      provenance,
      firstSeenAt,
      lastSeenAt,
      lastVerifiedActiveAt,
      ...body
    } = job;
    const descriptionId = intern(
      db,
      "job_listing_texts",
      description,
      readPreparedBodySalaryRange(job),
    );
    const assessmentId = intern(
      db,
      "job_fit_assessments",
      JSON.stringify(matchAssessment),
    );
    const bodyValue = JSON.stringify(body);
    const current = statement(
      db,
      "SELECT value FROM saved_jobs WHERE id = ?",
    ).get(job.id);
    const columns = [
      descriptionId,
      assessmentId,
      planAssessments === undefined ? 0 : 1,
      job.status !== "discovered" || !isLikelyUtilityShortlistJob(job) ? 1 : 0,
      resolveSavedJobCompany(job),
      resolveSavedJobLocation(job),
      firstSeenAt,
      lastSeenAt,
      lastVerifiedActiveAt,
    ];
    if (current?.value === bodyValue) {
      statement(
        db,
        `UPDATE saved_jobs SET description_id=?, assessment_id=?, has_plan_assessments=?, list_visible=?,
        display_company=?, display_location=?, first_seen_at=?, last_seen_at=?, last_verified_active_at=?
        WHERE id=? AND (description_id IS NOT ? OR assessment_id IS NOT ? OR has_plan_assessments IS NOT ? OR list_visible IS NOT ?
        OR display_company IS NOT ? OR display_location IS NOT ? OR first_seen_at IS NOT ? OR last_seen_at IS NOT ? OR last_verified_active_at IS NOT ?)`,
      ).run(...columns, job.id, ...columns);
    } else
      statement(
        db,
        `INSERT INTO saved_jobs(id, value, description_id, assessment_id, has_plan_assessments, list_visible, display_company, display_location, first_seen_at, last_seen_at, last_verified_active_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, description_id = excluded.description_id,
    assessment_id = excluded.assessment_id, has_plan_assessments = excluded.has_plan_assessments, list_visible = excluded.list_visible,
    display_company = excluded.display_company, display_location = excluded.display_location,
    first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at, last_verified_active_at = excluded.last_verified_active_at`,
      ).run(
        job.id,
        bodyValue,
        descriptionId,
        assessmentId,
        planAssessments === undefined ? 0 : 1,
        job.status !== "discovered" || !isLikelyUtilityShortlistJob(job)
          ? 1
          : 0,
        resolveSavedJobCompany(job),
        resolveSavedJobLocation(job),
        firstSeenAt,
        lastSeenAt,
        lastVerifiedActiveAt,
      );
    statement(
      db,
      "DELETE FROM job_plan_assessments WHERE job_id = ? AND plan_id NOT IN (SELECT value FROM json_each(?))",
    ).run(job.id, JSON.stringify(Object.keys(planAssessments ?? {})));
    writeSavedJobPlanAssessments(
      db,
      Object.entries(planAssessments ?? {}).map(([planId, assessment]) => ({
        jobId: job.id,
        planId,
        assessment,
      })),
    );
    const existingSightings = new Map(
      statement(
        db,
        "SELECT position, value, description_id FROM job_provenance WHERE job_id = ?",
      )
        .all(job.id)
        .map((row) => [Number(row.position), row]),
    );
    let provenanceChanged = false;
    provenance.forEach((sighting, position) => {
      const facts = sighting.listingFacts;
      const sourceDescriptionId = facts
        ? intern(db, "job_listing_texts", facts.description)
        : null;
      const value = facts
        ? { ...sighting, listingFacts: { ...facts, description: undefined } }
        : sighting;
      const serialized = JSON.stringify(value);
      const previous = existingSightings.get(position);
      if (
        previous?.value === serialized &&
        previous.description_id === sourceDescriptionId
      )
        return;
      provenanceChanged = true;
      statement(
        db,
        `INSERT INTO job_provenance VALUES (?, ?, ?, ?) ON CONFLICT(job_id,position)
        DO UPDATE SET value=excluded.value, description_id=excluded.description_id`,
      ).run(job.id, position, serialized, sourceDescriptionId);
    });
    if (existingSightings.size > provenance.length) {
      provenanceChanged = true;
      statement(
        db,
        "DELETE FROM job_provenance WHERE job_id=? AND position>=?",
      ).run(job.id, provenance.length);
    }
    writeSavedJobFingerprints(db, job);
    if (provenanceChanged) refreshSavedJobReadIndex(db, job.id);
    if (ownTransaction) {
      db.exec("COMMIT");
      notifyWorkspaceCommit(db);
    }
  } catch (error) {
    if (ownTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/** SQLite joins only the fields needed by a canonical detail or legacy domain read. */
export function savedJobValueSql(
  alias = "saved_jobs",
  includeDescription = true,
  includeSourceFacts = true,
): string {
  const source = includeSourceFacts
    ? "CASE WHEN p.description_id IS NULL THEN p.value ELSE json_set(p.value, '$.listingFacts.description', (SELECT text FROM job_listing_texts WHERE id = p.description_id)) END"
    : "json_remove(p.value, '$.listingFacts')";
  const parts = `json_set(${alias}.value, '$.firstSeenAt', ${alias}.first_seen_at, '$.lastSeenAt', ${alias}.last_seen_at,
    '$.lastVerifiedActiveAt', ${alias}.last_verified_active_at, '$.matchAssessment', json((SELECT value FROM job_fit_assessments WHERE id = ${alias}.assessment_id)),
    '$.provenance', json(COALESCE((SELECT json_group_array(json(value)) FROM
      (SELECT ${source} AS value FROM job_provenance p WHERE p.job_id = ${alias}.id ORDER BY p.position)), '[]'))
    ${includeDescription ? `, '$.description', (SELECT text FROM job_listing_texts WHERE id = ${alias}.description_id)` : ""})`;
  return `CASE WHEN ${alias}.assessment_id IS NULL THEN ${alias}.value ELSE
    CASE WHEN ${alias}.has_plan_assessments = 1 THEN json_set(${parts}, '$.planAssessments', json(COALESCE(
      (SELECT json_group_object(p.plan_id, json(p.value)) FROM job_plan_assessments p WHERE p.job_id = ${alias}.id), '{}')))
    ELSE ${parts} END END`;
}
