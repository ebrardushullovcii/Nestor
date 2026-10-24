import { ensureSavedJobFingerprintStorage } from "./saved-job-fingerprints";
import type { DatabaseSync } from "node:sqlite";

const VERSION = "11";
const jobTables = ["saved_jobs", "discovery_pending_jobs"] as const;
const jobFields =
  "status source work_mode title company search_text score hidden unjudged closed mismatch provisional outside title_family recency detail seen location source_job_id canonical_url application_url posted_at posted_text discovered_at first_seen_at salary_text detail_quality score_upper recommendation title_family_match location_reach resume_mode tailoring_mode visible rank_score feedback result_group".split(
    " ",
  );

function indexJobSql(table: string, where = ""): string {
  // A global row and one row per explicit campaign membership. Verdicts belong
  // to their plan; the global assessment is only the persisted fallback.
  const plans =
    table === "saved_jobs"
      ? "COALESCE((SELECT jsonb_group_array(plan_id) FROM plan_job_memberships WHERE item_id = j.id), jsonb('[]'))"
      : "COALESCE(jsonb_extract(j.value, '$.campaignIds'), jsonb('[]'))";
  const metadata =
    table === "saved_jobs"
      ? "list_visible, display_company, display_location, assessment_id, COALESCE(first_seen_at, json_extract(value, '$.firstSeenAt')) AS first_seen_at, COALESCE(last_seen_at, json_extract(value, '$.lastSeenAt')) AS last_seen_at, COALESCE(last_verified_active_at, json_extract(value, '$.lastVerifiedActiveAt')) AS last_verified_active_at"
      : "NULL AS list_visible, NULL AS display_company, NULL AS display_location, NULL AS assessment_id, json_extract(value, '$.firstSeenAt') AS first_seen_at, json_extract(value, '$.lastSeenAt') AS last_seen_at, json_extract(value, '$.lastVerifiedActiveAt') AS last_verified_active_at";
  const storedColumns =
    table === "saved_jobs"
      ? ", list_visible, display_company, display_location, assessment_id, first_seen_at, last_seen_at, last_verified_active_at"
      : "";
  const assessment =
    table === "saved_jobs"
      ? `COALESCE((SELECT verdict_plan.value FROM job_plan_assessments verdict_plan
        WHERE verdict_plan.job_id = j.id AND verdict_plan.plan_id = p.value),
      (SELECT verdict.value FROM json_each(j.value, '$.planAssessments') verdict WHERE verdict.key = p.value),
      (SELECT value FROM job_fit_assessments WHERE id = j.assessment_id), json_extract(j.value, '$.matchAssessment'))`
      : `COALESCE((SELECT verdict.value FROM json_each(j.value, '$.planAssessments') verdict WHERE verdict.key = p.value),
      json_extract(j.value, '$.matchAssessment'))`;
  return `INSERT INTO workspace_job_index
    WITH raw_jobs AS MATERIALIZED (SELECT id, jsonb(value) AS value ${storedColumns}
      FROM ${table} ${where.replaceAll("j.id", "id")}),
    jobs AS MATERIALIZED (SELECT id, jsonb_remove(value, '$.description', '$.provenance', '$.summary',
      '$.responsibilities', '$.minimumQualifications', '$.preferredQualifications', '$.keywordSignals', '$.latestMatchAssessmentAudit') AS value,
      ${metadata} FROM raw_jobs),
    verdicts AS MATERIALIZED (SELECT j.id, p.value AS plan_id, jsonb(${assessment}) AS verdict
      FROM jobs j, json_each(jsonb_insert(${plans}, '$[#]', '')) p)
    SELECT '${table}', j.id, v.plan_id,
      json_extract(j.value, '$.status'),
      COALESCE(json_extract(j.value, '$.source'), ''),
      COALESCE((SELECT sum(CASE value WHEN 'remote' THEN 1 WHEN 'hybrid' THEN 2 WHEN 'onsite' THEN 4 WHEN 'flexible' THEN 8 ELSE 0 END) FROM json_each(j.value, '$.workMode')), 0),
      json_extract(j.value, '$.title'), COALESCE(j.display_company, json_extract(j.value, '$.company'), ''),
      lower(COALESCE(json_extract(j.value, '$.title'), '') || ' ' ||
        COALESCE(json_extract(j.value, '$.company'), '') || ' ' ||
        COALESCE(json_extract(j.value, '$.location'), '')),
      COALESCE(json_extract(v.verdict, '$.score'), 0),
      CASE WHEN json_extract(j.value, '$.status') = 'archived'
        AND json_type(j.value, '$.discoveryFeedback') = 'object' THEN 1 ELSE 0 END,
      CASE WHEN json_type(v.verdict, '$.judgment') = 'object' THEN 0 ELSE 1 END,
      CASE WHEN json_extract(v.verdict, '$.judgment.listingClosed') = 1 THEN 1 ELSE 0 END,
      CASE WHEN json_extract(v.verdict, '$.recommendation') = 'skip' THEN 1 ELSE 0 END,
      CASE WHEN json_extract(j.value, '$.discoveryMethod') = 'catalog_seed' OR
        trim(COALESCE(json_extract(v.verdict, '$.contextFingerprint'), '')) = '' OR
        trim(COALESCE(json_extract(v.verdict, '$.postingFingerprint'), '')) = '' THEN 1 ELSE 0 END,
      CASE WHEN json_extract(v.verdict, '$.locationReach') = 'outside_area' THEN 1 ELSE 0 END,
      CASE json_extract(v.verdict, '$.titleFamilyMatch') WHEN 'same_family' THEN 0
        WHEN 'adjacent' THEN 1 WHEN 'unrelated' THEN 3 ELSE 2 END,
      COALESCE(json_extract(j.value, '$.postedAt'), j.first_seen_at,
        json_extract(j.value, '$.discoveredAt'), ''),
      CASE WHEN json_extract(j.value, '$.detailQuality') = 'detail_enriched' THEN 0 ELSE 1 END,
      COALESCE(j.last_seen_at, json_extract(j.value, '$.discoveredAt'), ''),
      CASE WHEN j.list_visible IS NOT NULL THEN j.display_location ELSE json_extract(j.value, '$.location') END, json_extract(j.value, '$.sourceJobId'),
      json_extract(j.value, '$.canonicalUrl'), json_extract(j.value, '$.applicationUrl'),
      json_extract(j.value, '$.postedAt'), json_extract(j.value, '$.postedAtText'),
      json_extract(j.value, '$.discoveredAt'), j.first_seen_at,
      json_extract(j.value, '$.salaryText'), json_extract(j.value, '$.detailQuality'),
      COALESCE(json_extract(v.verdict, '$.scoreIsUpperBound'), 0),
      COALESCE(json_extract(v.verdict, '$.recommendation'), 'review'),
      json_extract(v.verdict, '$.titleFamilyMatch'), json_extract(v.verdict, '$.locationReach'),
      json_extract(j.value, '$.resumeApplicationMode'), json_extract(j.value, '$.resumeTailoringMode'),
      COALESCE(j.list_visible, 1),
      CASE WHEN json_extract(j.value, '$.discoveryMethod') = 'catalog_seed' OR
        trim(COALESCE(json_extract(v.verdict, '$.contextFingerprint'), '')) = '' OR trim(COALESCE(json_extract(v.verdict, '$.postingFingerprint'), '')) = ''
        THEN 0 ELSE COALESCE(json_extract(v.verdict, '$.score'), 0) END,
      CASE WHEN json_type(j.value, '$.discoveryFeedback') = 'object' THEN 1 ELSE 0 END,
      CASE WHEN json_extract(v.verdict, '$.judgment.listingClosed') = 1 OR json_extract(v.verdict, '$.recommendation') = 'skip'
        THEN 'mismatches'
        WHEN json_type(v.verdict, '$.judgment') IS NOT 'object' OR json_extract(j.value, '$.discoveryMethod') = 'catalog_seed'
          OR trim(COALESCE(json_extract(v.verdict, '$.contextFingerprint'), '')) = ''
          OR trim(COALESCE(json_extract(v.verdict, '$.postingFingerprint'), '')) = '' THEN 'unchecked'
        WHEN json_extract(v.verdict, '$.score') < 35 AND NOT (
          json_extract(v.verdict, '$.locationReach') IS 'in_area' AND COALESCE(json_extract(v.verdict, '$.titleFamilyMatch'),
            CASE json_extract(v.verdict, '$.dimensions.roleSuitability.state') WHEN 'exact' THEN 'same_family' WHEN 'adjacent' THEN 'adjacent' ELSE '' END) IN ('same_family', 'adjacent'))
          THEN 'mismatches'
        WHEN json_extract(v.verdict, '$.score') < 50 THEN 'weaker' ELSE 'matches' END
    FROM verdicts v JOIN jobs j ON j.id = v.id
    WHERE 1 ON CONFLICT(origin, id, plan_id) DO UPDATE SET ${jobFields.map((field) => `${field} = excluded.${field}`).join(", ")}
      WHERE ${jobFields.map((field) => `workspace_job_index.${field} IS NOT excluded.${field}`).join(" OR ")};`;
}

/** Additive metadata only: existing JSON and schema migration versions stay intact. */
export function ensureWorkspaceReadIndex(database: DatabaseSync): void {
  ensureSavedJobFingerprintStorage(database);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(
    `CREATE TABLE IF NOT EXISTS workspace_read_meta (key TEXT PRIMARY KEY, value TEXT)`,
  );
  const version = database
    .prepare("SELECT value FROM workspace_read_meta WHERE key = 'version'")
    .get()?.value;
  const indexedTriggers = database
    .prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workspace_job_index_%'",
    )
    .get()?.count;
  const ownTransaction = !database.isTransaction;
  if (ownTransaction) database.exec("BEGIN IMMEDIATE");
  try {
    if (version && version !== VERSION) {
      for (const { name } of database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'workspace_job_index_%' OR name LIKE 'workspace_entity_%' OR name LIKE 'workspace_companies_%' OR name LIKE 'workspace_feed_%' OR name LIKE 'workspace_membership_%' OR name LIKE 'workspace_plan_assessment_%' OR name = 'workspace_sighting_dates')",
        )
        .all())
        database.exec(`DROP TRIGGER ${String(name)}`);
      database.exec(
        "DROP TABLE IF EXISTS workspace_job_index; DROP TABLE IF EXISTS workspace_entity_index; DROP TABLE IF EXISTS workspace_company_jobs; DROP TABLE IF EXISTS workspace_company_index",
      );
    }
    database.exec(`
      CREATE TABLE IF NOT EXISTS workspace_changes (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT, item_id TEXT,
        operation TEXT CHECK(operation IN ('upsert', 'delete'))
      );
      CREATE TABLE IF NOT EXISTS workspace_job_index (
        origin TEXT, id TEXT, plan_id TEXT,
        status TEXT, source TEXT, work_mode INTEGER,
        title TEXT, company TEXT, search_text TEXT,
        score REAL, hidden INTEGER, unjudged INTEGER,
        closed INTEGER, mismatch INTEGER, provisional INTEGER,
        outside INTEGER, title_family INTEGER, recency TEXT,
        detail INTEGER, seen TEXT,
        location TEXT, source_job_id TEXT, canonical_url TEXT, application_url TEXT,
        posted_at TEXT, posted_text TEXT, discovered_at TEXT, first_seen_at TEXT,
        salary_text TEXT, detail_quality TEXT, score_upper INTEGER,
        recommendation TEXT, title_family_match TEXT, location_reach TEXT,
        resume_mode TEXT, tailoring_mode TEXT, visible INTEGER, rank_score REAL, feedback INTEGER, result_group TEXT,
        PRIMARY KEY(origin, id, plan_id)
      );
      CREATE TABLE IF NOT EXISTS workspace_entity_index (
        origin TEXT, id TEXT, job_id TEXT,
        status TEXT, updated_at TEXT,
        approved_at TEXT, approved_export_id TEXT, stale_reason TEXT, stage TEXT,
        returned_to_shortlist_at TEXT, run_id TEXT, last_action_label TEXT, next_action_label TEXT,
        PRIMARY KEY(origin, id)
      );
      CREATE INDEX IF NOT EXISTS workspace_entity_job_idx ON workspace_entity_index(origin, job_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS workspace_company_index (id TEXT PRIMARY KEY, name TEXT, canonical_name TEXT,
        preference TEXT, job_count INTEGER, application_count INTEGER, updated_at TEXT, value TEXT);
      CREATE INDEX IF NOT EXISTS workspace_company_name_idx ON workspace_company_index(name, id);
      CREATE TABLE IF NOT EXISTS workspace_company_jobs (company_id TEXT, job_id TEXT, PRIMARY KEY(company_id, job_id));
      CREATE INDEX IF NOT EXISTS workspace_company_job_idx ON workspace_company_jobs(job_id, company_id);
    `);
    if (version !== VERSION || indexedTriggers !== 6) {
      database.exec("DELETE FROM workspace_job_index");
      for (const table of jobTables) {
        database.exec(indexJobSql(table));
        for (const operation of ["insert", "update", "delete"] as const) {
          const name = `workspace_job_index_${table}_${operation}`;
          database.exec(`DROP TRIGGER IF EXISTS ${name}`);
          const event =
            operation === "update" && table === "saved_jobs"
              ? "UPDATE OF value, description_id, assessment_id, has_plan_assessments, list_visible, display_company, display_location"
              : operation.toUpperCase();
          database.exec(`CREATE TRIGGER ${name} AFTER ${event} ON ${table} BEGIN
            DELETE FROM workspace_job_index WHERE origin = '${table}' AND id = ${operation === "delete" ? "OLD" : "NEW"}.id
              ${operation === "delete" ? "" : table === "saved_jobs" ? "AND plan_id != '' AND plan_id NOT IN (SELECT plan_id FROM plan_job_memberships WHERE item_id = NEW.id)" : "AND plan_id NOT IN (SELECT value FROM json_each(json_insert(COALESCE(json_extract(NEW.value, '$.campaignIds'), '[]'), '$[#]', '')))"};
            ${operation === "delete" ? "" : indexJobSql(table, "WHERE j.id = NEW.id")}
          END`);
        }
      }
      database
        .prepare(
          "INSERT OR REPLACE INTO workspace_read_meta VALUES ('version', ?)",
        )
        .run(VERSION);
    }
    database.exec(`CREATE TRIGGER IF NOT EXISTS workspace_sighting_dates AFTER UPDATE OF first_seen_at, last_seen_at, last_verified_active_at ON saved_jobs BEGIN
      UPDATE workspace_job_index SET first_seen_at = NEW.first_seen_at,
        seen = COALESCE(NEW.last_seen_at, json_extract(NEW.value, '$.discoveredAt'), ''),
        recency = COALESCE(json_extract(NEW.value, '$.postedAt'), NEW.first_seen_at, json_extract(NEW.value, '$.discoveredAt'), '')
      WHERE origin = 'saved_jobs' AND id = NEW.id;
    END`);
    for (const operation of ["insert", "update", "delete"] as const) {
      const ref = operation === "delete" ? "OLD" : "NEW";
      database.exec(`CREATE TRIGGER IF NOT EXISTS workspace_plan_assessment_${operation}
        AFTER ${operation.toUpperCase()} ON job_plan_assessments BEGIN
          ${indexJobSql("saved_jobs", `WHERE j.id = ${ref}.job_id`)}
          INSERT INTO workspace_changes(table_name,item_id,operation) VALUES ('saved_jobs',${ref}.job_id,'upsert');
        END`);
    }
    database.exec(
      "CREATE INDEX IF NOT EXISTS plan_job_membership_job_idx ON plan_job_memberships(item_id, plan_id)",
    );
    for (const operation of ["insert", "delete", "update"] as const) {
      database.exec(`CREATE TRIGGER IF NOT EXISTS workspace_membership_${operation} AFTER ${operation.toUpperCase()} ON plan_job_memberships BEGIN
        ${operation === "insert" ? "" : "DELETE FROM workspace_job_index WHERE origin = 'saved_jobs' AND id = OLD.item_id AND plan_id = OLD.plan_id;"}
        ${operation === "delete" ? "" : indexJobSql("saved_jobs", "WHERE j.id = NEW.item_id")}
      END`);
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS workspace_job_list_idx ON workspace_job_index(
        plan_id, hidden, status, unjudged, closed, mismatch, provisional, outside,
        score DESC, title_family, recency DESC, detail, title, company, id);
      CREATE INDEX IF NOT EXISTS workspace_job_fit_idx ON workspace_job_index(
        plan_id, unjudged, closed, mismatch, provisional, outside, rank_score DESC,
        title_family, recency DESC, detail, title, company, id);
      CREATE INDEX IF NOT EXISTS workspace_job_date_idx ON workspace_job_index(plan_id, recency DESC, id);
      CREATE INDEX IF NOT EXISTS workspace_job_company_idx ON workspace_job_index(plan_id, company, id);
      CREATE INDEX IF NOT EXISTS workspace_job_identity_idx ON workspace_job_index(id, plan_id);
      CREATE INDEX IF NOT EXISTS workspace_job_counts_idx ON workspace_job_index(plan_id, status, visible, hidden, origin, id);
    `);
    for (const table of [
      "application_records",
      "resume_drafts",
      "apply_job_results",
    ]) {
      const select = (
        condition: string,
      ) => `INSERT OR REPLACE INTO workspace_entity_index
        WITH rows AS MATERIALIZED (SELECT id, jsonb_remove(jsonb(value), '$.sections', '$.visualObservationSets', '$.visualCheckpoints') AS value FROM ${table} ${condition})
        SELECT '${table}', id, json_extract(value, '$.jobId'),
          COALESCE(json_extract(value, '$.status'), json_extract(value, '$.state'), ''),
          COALESCE(json_extract(value, '$.updatedAt'), json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), ''),
          json_extract(value, '$.approvedAt'), json_extract(value, '$.approvedExportId'), json_extract(value, '$.staleReason'),
          json_extract(value, '$.crm.stage'), json_extract(value, '$.returnedToShortlistAt'), json_extract(value, '$.runId'),
          json_extract(value, '$.lastActionLabel'), json_extract(value, '$.nextActionLabel')
        FROM rows;`;
      const triggerExists = database
        .prepare("SELECT 1 FROM sqlite_master WHERE name = ?")
        .get(`workspace_entity_${table}_insert`);
      if (!triggerExists) database.exec(select(""));
      for (const operation of ["insert", "update", "delete"] as const) {
        database.exec(`CREATE TRIGGER IF NOT EXISTS workspace_entity_${table}_${operation}
          AFTER ${operation.toUpperCase()} ON ${table} BEGIN
            DELETE FROM workspace_entity_index WHERE origin = '${table}' AND id = ${operation === "insert" ? "NEW" : "OLD"}.id;
            ${operation === "delete" ? "" : select("WHERE id = NEW.id")}
          END`);
      }
    }
    const companies = `DELETE FROM workspace_company_jobs; DELETE FROM workspace_company_index;
      INSERT INTO workspace_company_index SELECT json_extract(c.value, '$.id'),
        lower(json_extract(c.value, '$.canonicalName')), json_extract(c.value, '$.canonicalName'),
        COALESCE(json_extract(c.value, '$.preference'), 'neutral'), COALESCE(json_array_length(c.value, '$.jobIds'), 0),
        COALESCE(json_array_length(c.value, '$.applicationRecordIds'), 0), json_extract(c.value, '$.updatedAt'), c.value
        FROM singleton_state s, json_each(s.value, '$.companies') c WHERE s.key = 'intelligence_state';
      INSERT OR IGNORE INTO workspace_company_jobs SELECT c.id, j.value
        FROM workspace_company_index c, json_each(c.value, '$.jobIds') j;`;
    if (
      !database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'workspace_companies_update'",
        )
        .get()
    ) {
      database.exec(companies);
    }
    for (const operation of ["insert", "update", "delete"]) {
      database.exec(`CREATE TRIGGER IF NOT EXISTS workspace_companies_${operation}
        AFTER ${operation.toUpperCase()} ON singleton_state
        WHEN ${operation === "delete" ? "OLD" : "NEW"}.key = 'intelligence_state'
        BEGIN ${companies} END`);
    }
    // Persistent triggers cover ordinary writes, reset/import, side metadata,
    // and writes made by an older build on a shared data folder. No payloads or
    // personal text enter the feed. A rollback also rolls back its revisions.
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'workspace_%' AND name NOT IN ('schema_migrations', 'row_validations')",
      )
      .all();
    for (const { name } of tables) {
      const table = String(name);
      if (!/^[a-z_]+$/.test(table)) continue;
      const columns = database.prepare(`PRAGMA table_info(${table})`).all();
      const keys = columns
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk));
      if (!keys.length) continue;
      for (const operation of ["insert", "update", "delete"] as const) {
        const ref = operation === "delete" ? "OLD" : "NEW";
        const key =
          keys.length === 1
            ? `CAST(${ref}.${String(keys[0]!.name)} AS TEXT)`
            : `json_array(${keys.map((column) => `${ref}.${String(column.name)}`).join(", ")})`;
        database.exec(`CREATE TRIGGER IF NOT EXISTS workspace_feed_${table}_${operation}
          AFTER ${operation.toUpperCase()} ON ${table}
          BEGIN INSERT INTO workspace_changes(table_name, item_id, operation)
            VALUES ('${table}', ${key}, '${operation === "delete" ? "delete" : "upsert"}'); END`);
      }
    }
    if (ownTransaction) database.exec("COMMIT");
  } catch (error) {
    if (ownTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
