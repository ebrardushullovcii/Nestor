import type { DatabaseSync } from "node:sqlite";

const VERSION = "2";
const jobTables = ["saved_jobs", "discovery_pending_jobs"] as const;

function indexJobSql(table: string, where = ""): string {
  // A global row and one row per explicit campaign membership. Verdicts belong
  // to their plan; the global assessment is only the persisted fallback.
  return `INSERT OR REPLACE INTO workspace_job_index
    SELECT '${table}', j.id, p.plan_id,
      json_extract(j.value, '$.status'),
      COALESCE(json_extract(j.value, '$.source'), ''),
      COALESCE((SELECT sum(CASE value WHEN 'remote' THEN 1 WHEN 'hybrid' THEN 2 WHEN 'onsite' THEN 4 WHEN 'flexible' THEN 8 ELSE 0 END) FROM json_each(j.value, '$.workMode')), 0),
      json_extract(j.value, '$.title'), COALESCE(json_extract(j.value, '$.company'), ''),
      lower(COALESCE(json_extract(j.value, '$.title'), '') || ' ' ||
        COALESCE(json_extract(j.value, '$.company'), '') || ' ' ||
        COALESCE(json_extract(j.value, '$.location'), '')),
      COALESCE(json_extract(a.value, '$.score'), 0),
      CASE WHEN json_extract(j.value, '$.status') = 'archived'
        AND json_type(j.value, '$.discoveryFeedback') = 'object' THEN 1 ELSE 0 END,
      CASE WHEN json_type(a.value, '$.judgment') = 'object' THEN 0 ELSE 1 END,
      CASE WHEN json_extract(a.value, '$.judgment.listingClosed') = 1 THEN 1 ELSE 0 END,
      CASE WHEN json_extract(a.value, '$.recommendation') = 'skip' THEN 1 ELSE 0 END,
      CASE WHEN json_extract(j.value, '$.discoveryMethod') = 'catalog_seed' OR
        COALESCE(json_extract(a.value, '$.contextFingerprint'), '') = '' OR
        COALESCE(json_extract(a.value, '$.postingFingerprint'), '') = '' THEN 1 ELSE 0 END,
      CASE WHEN json_extract(a.value, '$.locationReach') = 'outside_area' THEN 1 ELSE 0 END,
      CASE json_extract(a.value, '$.titleFamilyMatch') WHEN 'same_family' THEN 0
        WHEN 'adjacent' THEN 1 WHEN 'unrelated' THEN 3 ELSE 2 END,
      COALESCE(json_extract(j.value, '$.postedAt'), json_extract(j.value, '$.firstSeenAt'),
        json_extract(j.value, '$.discoveredAt'), ''),
      CASE WHEN json_extract(j.value, '$.detailQuality') = 'detail_enriched' THEN 0 ELSE 1 END,
      COALESCE(json_extract(j.value, '$.lastSeenAt'), json_extract(j.value, '$.discoveredAt'), ''),
      json_extract(j.value, '$.location'), json_extract(j.value, '$.sourceJobId'),
      json_extract(j.value, '$.canonicalUrl'), json_extract(j.value, '$.applicationUrl'),
      json_extract(j.value, '$.postedAt'), json_extract(j.value, '$.postedAtText'),
      json_extract(j.value, '$.discoveredAt'), json_extract(j.value, '$.firstSeenAt'),
      json_extract(j.value, '$.salaryText'), json_extract(j.value, '$.detailQuality'),
      COALESCE(json_extract(a.value, '$.scoreIsUpperBound'), 0),
      COALESCE(json_extract(a.value, '$.recommendation'), 'review'),
      json_extract(a.value, '$.titleFamilyMatch'), json_extract(a.value, '$.locationReach'),
      json_extract(j.value, '$.resumeApplicationMode'), json_extract(j.value, '$.resumeTailoringMode')
    FROM ${table} j JOIN (
      SELECT id, '' AS plan_id FROM ${table} ${where.replaceAll("j.id", "id")}
      UNION ALL SELECT s.id, membership.value FROM ${table} s,
        json_each(s.value, '$.campaignIds') membership ${where.replaceAll("j.id", "s.id")}
    ) p ON p.id = j.id
    JOIN json_each(json_array(COALESCE(
      (SELECT verdict.value FROM json_each(j.value, '$.planAssessments') verdict
        WHERE verdict.key = p.plan_id), json_extract(j.value, '$.matchAssessment')))) a
    ${where};`;
}

/** Additive metadata only: existing JSON and schema migration versions stay intact. */
export function ensureWorkspaceReadIndex(database: DatabaseSync): void {
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(
    `CREATE TABLE IF NOT EXISTS workspace_read_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  const version = database
    .prepare("SELECT value FROM workspace_read_meta WHERE key = 'version'")
    .get()?.value;
  const indexedTriggers = database
    .prepare(
      "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'workspace_job_index_%'",
    )
    .get()?.count;
  database.exec("BEGIN IMMEDIATE");
  try {
    if (version && version !== VERSION) {
      for (const { name } of database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'workspace_job_index_%' OR name LIKE 'workspace_entity_%' OR name LIKE 'workspace_companies_%')",
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
        table_name TEXT NOT NULL, item_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete'))
      );
      CREATE TABLE IF NOT EXISTS workspace_job_index (
        origin TEXT NOT NULL, id TEXT NOT NULL, plan_id TEXT NOT NULL,
        status TEXT NOT NULL, source TEXT NOT NULL, work_mode INTEGER NOT NULL,
        title TEXT NOT NULL, company TEXT NOT NULL, search_text TEXT NOT NULL,
        score REAL NOT NULL, hidden INTEGER NOT NULL, unjudged INTEGER NOT NULL,
        closed INTEGER NOT NULL, mismatch INTEGER NOT NULL, provisional INTEGER NOT NULL,
        outside INTEGER NOT NULL, title_family INTEGER NOT NULL, recency TEXT NOT NULL,
        detail INTEGER NOT NULL, seen TEXT NOT NULL,
        location TEXT, source_job_id TEXT, canonical_url TEXT NOT NULL, application_url TEXT NOT NULL,
        posted_at TEXT, posted_text TEXT, discovered_at TEXT NOT NULL, first_seen_at TEXT,
        salary_text TEXT, detail_quality TEXT NOT NULL, score_upper INTEGER NOT NULL,
        recommendation TEXT NOT NULL, title_family_match TEXT, location_reach TEXT,
        resume_mode TEXT, tailoring_mode TEXT,
        PRIMARY KEY(origin, id, plan_id)
      );
      CREATE INDEX IF NOT EXISTS workspace_job_list_idx ON workspace_job_index(
        plan_id, hidden, status, unjudged, closed, mismatch, provisional, outside,
        score DESC, title_family, recency DESC, detail, title, company, id);
      CREATE INDEX IF NOT EXISTS workspace_job_fit_idx ON workspace_job_index(
        plan_id, unjudged, closed, mismatch, provisional, outside, score DESC,
        title_family, recency DESC, detail, title, company, id);
      CREATE INDEX IF NOT EXISTS workspace_job_date_idx ON workspace_job_index(plan_id, recency DESC, id);
      CREATE INDEX IF NOT EXISTS workspace_job_company_idx ON workspace_job_index(plan_id, company, id);
      CREATE TABLE IF NOT EXISTS workspace_entity_index (
        origin TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL,
        status TEXT NOT NULL, updated_at TEXT NOT NULL,
        approved_at TEXT, approved_export_id TEXT, stale_reason TEXT, stage TEXT,
        returned_to_shortlist_at TEXT, run_id TEXT, last_action_label TEXT, next_action_label TEXT,
        PRIMARY KEY(origin, id)
      );
      CREATE INDEX IF NOT EXISTS workspace_entity_job_idx ON workspace_entity_index(origin, job_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS workspace_company_index (id TEXT PRIMARY KEY, name TEXT NOT NULL, canonical_name TEXT NOT NULL,
        preference TEXT NOT NULL, job_count INTEGER NOT NULL, application_count INTEGER NOT NULL, updated_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workspace_company_name_idx ON workspace_company_index(name, id);
      CREATE TABLE IF NOT EXISTS workspace_company_jobs (company_id TEXT NOT NULL, job_id TEXT NOT NULL, PRIMARY KEY(company_id, job_id));
      CREATE INDEX IF NOT EXISTS workspace_company_job_idx ON workspace_company_jobs(job_id, company_id);
    `);
    if (version !== VERSION || indexedTriggers !== 6) {
      database.exec("DELETE FROM workspace_job_index");
      for (const table of jobTables) {
        database.exec(indexJobSql(table));
        for (const operation of ["insert", "update", "delete"] as const) {
          const name = `workspace_job_index_${table}_${operation}`;
          database.exec(`DROP TRIGGER IF EXISTS ${name}`);
          database.exec(`CREATE TRIGGER ${name} AFTER ${operation.toUpperCase()} ON ${table} BEGIN
            DELETE FROM workspace_job_index WHERE origin = '${table}' AND id = ${operation === "insert" ? "NEW" : "OLD"}.id;
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
    for (const table of [
      "application_records",
      "resume_drafts",
      "apply_job_results",
    ]) {
      const select = (
        condition: string,
      ) => `INSERT OR REPLACE INTO workspace_entity_index
        SELECT '${table}', id, json_extract(value, '$.jobId'),
          COALESCE(json_extract(value, '$.status'), json_extract(value, '$.state'), ''),
          COALESCE(json_extract(value, '$.updatedAt'), json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), ''),
          json_extract(value, '$.approvedAt'), json_extract(value, '$.approvedExportId'), json_extract(value, '$.staleReason'),
          json_extract(value, '$.crm.stage'), json_extract(value, '$.returnedToShortlistAt'), json_extract(value, '$.runId'),
          json_extract(value, '$.lastActionLabel'), json_extract(value, '$.nextActionLabel')
        FROM ${table} ${condition};`;
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
          ${operation === "update" ? `WHEN ${columns.map((column) => `NEW.${String(column.name)} IS NOT OLD.${String(column.name)}`).join(" OR ")}` : ""}
          BEGIN INSERT INTO workspace_changes(table_name, item_id, operation)
            VALUES ('${table}', ${key}, '${operation === "delete" ? "delete" : "upsert"}'); END`);
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
