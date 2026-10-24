import type { DatabaseSync } from "node:sqlite";
import {
  workspaceJobIndexColumns,
  workspaceJobIndexSelectSql,
  workspaceJobTables,
  workspaceEntityIndexColumns,
  workspaceEntityIndexSelectSql,
  workspaceEntityTables,
  workspaceCompanyIndexColumns,
  workspaceCompanyIndexSelectSql,
  workspaceReadIndexVersion,
} from "./workspace-read-index";
import { registerWorkspaceStartupListFacts } from "./workspace-startup-list-facts";

const columns = {
  workspace_job_index: workspaceJobIndexColumns.join(","),
  workspace_entity_index: workspaceEntityIndexColumns,
  workspace_company_index: workspaceCompanyIndexColumns,
  workspace_company_jobs: "company_id,job_id",
};

/** A compatible committed index remains readable throughout its replacement. */
function readable(db: DatabaseSync): boolean {
  if (
    db
      .prepare("SELECT value FROM workspace_read_meta WHERE key='version'")
      .get()?.value !== workspaceReadIndexVersion
  )
    return false;
  for (const [table, fields] of Object.entries(columns)) {
    const present = new Set(
      db
        .prepare(`PRAGMA main.table_info(${table})`)
        .all()
        .map((row) => row.name),
    );
    if (fields.split(",").some((field) => !present.has(field))) return false;
  }
  return true;
}

/** Connection-local scalar rows avoid rereading old JSON for every facet. */
export function createWorkspaceStartupReads(db: DatabaseSync) {
  registerWorkspaceStartupListFacts(db);
  let generation = "";
  let fallback = false;
  return {
    ensure(inventory: boolean) {
      if (!inventory && !fallback) return false;
      const current = `${String(db.prepare("PRAGMA main.schema_version").get()!.schema_version)}:${String(db.prepare("PRAGMA data_version").get()!.data_version)}:${String(db.prepare("SELECT value FROM main.workspace_read_meta WHERE key='version'").get()?.value)}`;
      if (generation === current) return fallback;
      const needed = !readable(db);
      if (!inventory && needed) return fallback;
      for (const table of Object.keys(columns))
        db.exec(`DROP TABLE IF EXISTS temp.${table}`);
      if (needed) {
        // The exact stored-index SELECT is evaluated once, never once per facet
        // or correlated lookup. Only scalar screen facts survive this statement.
        db.exec(`CREATE TEMP TABLE workspace_job_index(${columns.workspace_job_index}, PRIMARY KEY(origin,id,plan_id));
        CREATE INDEX temp.workspace_startup_plan ON workspace_job_index(plan_id,origin,id);
        CREATE TEMP TABLE workspace_entity_index(${workspaceEntityIndexColumns}, PRIMARY KEY(origin,id));
        CREATE INDEX temp.workspace_startup_entity_job ON workspace_entity_index(origin,job_id);
        CREATE TEMP TABLE workspace_company_index(${workspaceCompanyIndexColumns}, PRIMARY KEY(id));
        CREATE TEMP TABLE workspace_company_jobs(company_id,job_id,PRIMARY KEY(company_id,job_id));`);
        for (const table of workspaceJobTables)
          db.exec(
            `INSERT INTO temp.workspace_job_index ${workspaceJobIndexSelectSql(table, "", true)}`,
          );
        for (const table of workspaceEntityTables)
          db.exec(
            `INSERT INTO temp.workspace_entity_index ${workspaceEntityIndexSelectSql(table)}`,
          );
        db.exec(`INSERT INTO temp.workspace_company_index ${workspaceCompanyIndexSelectSql};
        INSERT OR IGNORE INTO temp.workspace_company_jobs
          SELECT c.id,j.value FROM workspace_company_index c,json_each(c.value,'$.jobIds') j;`);
      }
      generation = current;
      fallback = needed;
      return fallback;
    },
    invalidate() {
      generation = "";
    },
  };
}
