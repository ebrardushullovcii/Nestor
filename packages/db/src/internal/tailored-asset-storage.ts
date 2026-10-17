import type { DatabaseSync } from "node:sqlite";

// Guard invalid JSON so unrelated damaged documents do not prevent the index
// from being installed or maintained. The selected body still gets validated.
export const TAILORED_ASSET_JOB_ID_SQL =
  "CASE WHEN json_valid(value) THEN json_extract(value, '$.jobId') END";

export function ensureTailoredAssetJobIndex(database: DatabaseSync): void {
  // An older workspace can open without this table; creating the index then
  // failed the whole migration and the workspace would not open. The table's
  // own creation path installs the index later.
  const table = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tailored_assets'",
    )
    .get();
  if (!table) return;
  database.exec(`
    CREATE INDEX IF NOT EXISTS tailored_assets_job_id_idx
    ON tailored_assets (${TAILORED_ASSET_JOB_ID_SQL}, id);
  `);
}
