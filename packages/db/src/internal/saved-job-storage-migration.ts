import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  SavedJobSchema,
  isLikelyUtilityShortlistJob,
  resolveSavedJobCompany,
  resolveSavedJobLocation,
  extractSalaryRangeFromListingBody,
} from "@nestor/contracts";
import { isDeepStrictEqual } from "node:util";
import { backupBeforeStorageMigration } from "./storage-migration-backup";
import { ensureSavedJobRelations, savedJobValueSql } from "./saved-job-storage";
import { notifyWorkspaceCommit } from "../workspace-commits";

export function migrateSavedJobStorage(db: DatabaseSync): void {
  for (const step of migrateSavedJobStorageSteps(db)) void step;
}

/** Each yield leaves complete old/new rows and releases the writer lock. */
export function* migrateSavedJobStorageSteps(
  db: DatabaseSync,
): Generator<void> {
  ensureSavedJobRelations(db);
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = 28").get())
    return;
  const ids = db
    .prepare(
      "SELECT id FROM saved_jobs WHERE assessment_id IS NULL ORDER BY id",
    )
    .all();
  if (ids.length) backupBeforeStorageMigration(db, 28);
  // Validate old files once. SQLite moves fields in sets without a canonical
  // reread, separately compiled statements or root-row cascades for each job.
  db.function("migration_job", (value) => {
    const parsed = SavedJobSchema.safeParse(
      JSON.parse(String(value)) as unknown,
    );
    return parsed.success ? JSON.stringify(parsed.data) : null;
  });
  db.function("migration_hash", (value) =>
    createHash("sha256").update(String(value)).digest("hex"),
  );
  db.function(
    "migration_visible",
    (title, canonicalUrl, company, description, status) =>
      status !== "discovered" ||
      !isLikelyUtilityShortlistJob({
        title: String(title),
        canonicalUrl: String(canonicalUrl),
        company: String(company),
        description: String(description),
      })
        ? 1
        : 0,
  );
  db.function("migration_company", (company, canonicalUrl) =>
    resolveSavedJobCompany({
      company: String(company),
      canonicalUrl: String(canonicalUrl),
    }),
  );
  db.function("migration_location", (location) =>
    resolveSavedJobLocation({ location: String(location) }),
  );
  db.function("migration_salary", (text) =>
    extractSalaryRangeFromListingBody(String(text)),
  );
  db.function("migration_equal", (before, after) =>
    isDeepStrictEqual(JSON.parse(String(before)), JSON.parse(String(after)))
      ? 1
      : 0,
  );
  for (let offset = 0; offset < ids.length; offset += 50) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const count = db.prepare("SELECT count(*) AS n FROM saved_jobs").get()!.n;
      // Conversion changes storage, never the already-correct screen facts.
      // Keep the committed index and restore its writers in this transaction.
      const indexTriggers = db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'workspace_job_index_%' OR name LIKE 'workspace_plan_assessment_%' OR name = 'workspace_sighting_dates')",
        )
        .all();
      for (const { name } of indexTriggers)
        db.exec(`DROP TRIGGER ${String(name)}`);
      db.exec("CREATE TEMP TABLE migration_ids(id TEXT PRIMARY KEY)");
      db.prepare(
        "INSERT INTO migration_ids SELECT value FROM json_each(?)",
      ).run(
        JSON.stringify(ids.slice(offset, offset + 50).map((row) => row.id)),
      );
      db.exec(`
      CREATE TEMP TABLE migration_jobs AS
        SELECT id, jsonb(migration_job(value)) AS value FROM saved_jobs
        WHERE assessment_id IS NULL AND id IN (SELECT id FROM migration_ids);
      DELETE FROM migration_jobs WHERE value IS NULL;
      CREATE UNIQUE INDEX migration_jobs_id ON migration_jobs(id);
      CREATE TEMP TABLE migration_fingerprints AS SELECT * FROM saved_job_discovery_fingerprints WHERE job_id IN (SELECT id FROM migration_jobs);
      INSERT OR IGNORE INTO job_listing_texts(stable_key, text)
        SELECT migration_hash(json_extract(value, '$.description')), json_extract(value, '$.description') FROM migration_jobs;
      INSERT OR IGNORE INTO job_listing_texts(stable_key, text)
        SELECT migration_hash(json_extract(p.value, '$.listingFacts.description')), json_extract(p.value, '$.listingFacts.description')
        FROM migration_jobs j, json_each(j.value, '$.provenance') p WHERE json_type(p.value, '$.listingFacts') = 'object';
      UPDATE job_listing_texts SET salary_evidence = migration_salary(text), salary_prepared = 1 WHERE salary_prepared = 0
        AND stable_key IN (SELECT migration_hash(json_extract(value, '$.description')) FROM migration_jobs
          UNION SELECT migration_hash(json_extract(p.value, '$.listingFacts.description')) FROM migration_jobs j,
            json_each(j.value, '$.provenance') p WHERE json_type(p.value, '$.listingFacts') = 'object');
      DELETE FROM job_plan_assessments WHERE job_id IN (SELECT id FROM migration_jobs);
      INSERT INTO job_plan_assessments(job_id, plan_id, value, score)
        SELECT j.id, p.key, p.value, json_extract(p.value, '$.score') FROM migration_jobs j, json_each(j.value, '$.planAssessments') p;
      INSERT OR IGNORE INTO job_fit_assessments(stable_key, value)
        SELECT migration_hash(json_extract(value, '$.matchAssessment')), json_extract(value, '$.matchAssessment') FROM migration_jobs;
      DELETE FROM job_provenance WHERE job_id IN (SELECT id FROM migration_jobs);
      INSERT INTO job_provenance(job_id, position, value, description_id)
        SELECT j.id, p.key, json_remove(p.value, '$.listingFacts.description'),
          CASE WHEN json_type(p.value, '$.listingFacts') = 'object' THEN
            (SELECT id FROM job_listing_texts WHERE stable_key = migration_hash(json_extract(p.value, '$.listingFacts.description'))) END
        FROM migration_jobs j, json_each(j.value, '$.provenance') p;
      UPDATE saved_jobs SET
        value = json_remove(j.value, '$.description', '$.matchAssessment', '$.planAssessments', '$.provenance', '$.firstSeenAt', '$.lastSeenAt', '$.lastVerifiedActiveAt'),
        description_id = (SELECT id FROM job_listing_texts WHERE stable_key = migration_hash(json_extract(j.value, '$.description'))),
        assessment_id = (SELECT id FROM job_fit_assessments WHERE stable_key = migration_hash(json_extract(j.value, '$.matchAssessment'))),
        has_plan_assessments = CASE WHEN json_type(j.value, '$.planAssessments') IS NULL THEN 0 ELSE 1 END,
        list_visible = migration_visible(json_extract(j.value, '$.title'), json_extract(j.value, '$.canonicalUrl'),
          json_extract(j.value, '$.company'), json_extract(j.value, '$.description'), json_extract(j.value, '$.status')),
        display_company = migration_company(json_extract(j.value, '$.company'), json_extract(j.value, '$.canonicalUrl')),
        display_location = migration_location(json_extract(j.value, '$.location')),
        first_seen_at = json_extract(j.value, '$.firstSeenAt'), last_seen_at = json_extract(j.value, '$.lastSeenAt'),
        last_verified_active_at = json_extract(j.value, '$.lastVerifiedActiveAt')
        FROM migration_jobs j WHERE saved_jobs.id = j.id;
      INSERT OR REPLACE INTO saved_job_discovery_fingerprints SELECT * FROM migration_fingerprints;
      DROP TABLE migration_fingerprints;
    `);
      if (
        db
          .prepare(
            `SELECT 1 FROM saved_jobs JOIN migration_jobs j USING(id)
      WHERE migration_equal(json(j.value), ${savedJobValueSql()}) = 0 LIMIT 1`,
          )
          .get()
      )
        throw new Error(
          "Saved-job migration changed listing or assessment facts.",
        );
      if (db.prepare("SELECT count(*) AS n FROM saved_jobs").get()!.n !== count)
        throw new Error("Saved-job migration changed record counts.");
      db.exec("DROP TABLE migration_jobs; DROP TABLE migration_ids");
      for (const { sql } of indexTriggers) db.exec(String(sql));
      db.exec("COMMIT");
      notifyWorkspaceCommit(db);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    yield;
  }
  db.prepare(
    "INSERT INTO schema_migrations(version, name) VALUES (28, 'saved_job_evidence_and_assessment_references')",
  ).run();
}
