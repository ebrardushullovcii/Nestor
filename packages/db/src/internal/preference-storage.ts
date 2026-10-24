import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type {
  JobSearchPreferences,
  JobSearchCampaignCollection,
  JobSearchCampaign,
} from "@nestor/contracts";
import { backupBeforeStorageMigration } from "./storage-migration-backup";
import { notifyWorkspaceCommit } from "../workspace-commits";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function transaction<T>(db: DatabaseSync, run: () => T): T {
  if (db.isTransaction) return run();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    notifyWorkspaceCommit(db);
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function preference(db: DatabaseSync, value: JobSearchPreferences): string {
  const { targets, ...discovery } = value.discovery;
  const body = { ...value, discovery };
  const sources = targets.map((target) => ({
    id: digest(target),
    sourceId: target.id,
    target,
  }));
  const id = digest({ body, sources: sources.map((source) => source.id) });
  if (db.prepare("SELECT 1 FROM search_preference_sets WHERE id = ?").get(id))
    return id;
  db.prepare("INSERT INTO search_preference_sets VALUES (?, ?)").run(
    id,
    JSON.stringify(body),
  );
  const putSource = db.prepare(
    "INSERT OR IGNORE INTO job_sources(id, source_id, value) VALUES (?, ?, ?)",
  );
  const link = db.prepare(
    "INSERT INTO search_preference_sources VALUES (?, ?, ?, ?)",
  );
  sources.forEach((source, position) => {
    putSource.run(source.id, source.sourceId, JSON.stringify(source.target));
    link.run(id, source.sourceId, source.id, position);
  });
  return id;
}
function readPreference(db: DatabaseSync, id: string): JobSearchPreferences {
  const stored = db
    .prepare("SELECT value FROM search_preference_sets WHERE id = ?")
    .get(id);
  if (!stored) throw new Error("Search preferences are missing.");
  const body = JSON.parse(String(stored.value)) as JobSearchPreferences;
  const targets = db
    .prepare(
      "SELECT s.value FROM search_preference_sources p JOIN job_sources s ON s.id = p.source_version_id WHERE p.preference_id = ? ORDER BY p.position",
    )
    .all(id)
    .map(
      (row) =>
        JSON.parse(
          String(row.value),
        ) as JobSearchPreferences["discovery"]["targets"][number],
    );
  return { ...body, discovery: { ...body.discovery, targets } };
}
function replaceLinks(
  db: DatabaseSync,
  table: "plan_job_memberships" | "plan_sources",
  planId: string,
  ids: readonly string[],
): void {
  // Only changed memberships are written, even when a legacy callback returns
  // its complete domain object. A large plan is never rewritten as one JSON row.
  const existing = new Map(
    db
      .prepare(`SELECT item_id, position FROM ${table} WHERE plan_id = ?`)
      .all(planId)
      .map((row) => [String(row.item_id), Number(row.position)]),
  );
  const put = db.prepare(
    `INSERT INTO ${table}(plan_id, item_id, position) VALUES (?, ?, ?) ON CONFLICT(plan_id, item_id) DO UPDATE SET position = excluded.position`,
  );
  [...new Set(ids)].forEach((id, position) => {
    if (existing.get(id) !== position) put.run(planId, id, position);
    existing.delete(id);
  });
  const remove = db.prepare(
    `DELETE FROM ${table} WHERE plan_id = ? AND item_id = ?`,
  );
  for (const id of existing.keys()) remove.run(planId, id);
}

/** Encodes domain singletons as small references; no old-build dual write. */
export function encodePreferenceSingleton(
  db: DatabaseSync,
  key: string,
  input: unknown,
): unknown {
  if (key !== "search_preferences" && key !== "campaign_state") return input;
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name = 'search_preference_sets'",
      )
      .get()
  )
    return input;
  return transaction(db, () => {
    if (key === "search_preferences")
      return { preferenceId: preference(db, input as JobSearchPreferences) };
    const state = input as JobSearchCampaignCollection;
    const keep = new Set(state.campaigns.map((plan) => plan.id));
    for (const [position, plan] of state.campaigns.entries()) {
      const { searchPreferences, jobIds, sourceTargetIds, ...body } = plan;
      const preferenceId = preference(db, searchPreferences);
      const value = JSON.stringify(body);
      db.prepare(
        `INSERT INTO job_search_plans(id, preference_id, position, value) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET preference_id = excluded.preference_id, position = excluded.position, value = excluded.value
        WHERE preference_id IS NOT excluded.preference_id OR position IS NOT excluded.position OR value IS NOT excluded.value`,
      ).run(plan.id, preferenceId, position, value);
      replaceLinks(db, "plan_job_memberships", plan.id, jobIds);
      replaceLinks(db, "plan_sources", plan.id, sourceTargetIds);
    }
    for (const row of db.prepare("SELECT id FROM job_search_plans").all())
      if (!keep.has(String(row.id))) {
        for (const table of [
          "plan_job_memberships",
          "plan_sources",
          "job_search_plans",
        ])
          db.prepare(
            `DELETE FROM ${table} WHERE ${table === "job_search_plans" ? "id" : "plan_id"} = ?`,
          ).run(String(row.id));
      }
    return {
      activeCampaignId: state.activeCampaignId,
      notifications: state.notifications,
    };
  });
}

export function decodePreferenceSingleton(
  db: DatabaseSync,
  key: string,
  input: unknown,
): unknown {
  if (
    key === "search_preferences" &&
    input &&
    typeof input === "object" &&
    "preferenceId" in input
  )
    return readPreference(db, String(input.preferenceId));
  if (
    key !== "campaign_state" ||
    !input ||
    typeof input !== "object" ||
    "campaigns" in input
  )
    return input;
  const campaigns = db
    .prepare(
      "SELECT id, preference_id, value FROM job_search_plans ORDER BY position, id",
    )
    .all()
    .map((row) => {
      const plan = JSON.parse(String(row.value)) as JobSearchCampaign;
      const ids = (table: string) =>
        db
          .prepare(
            `SELECT item_id FROM ${table} WHERE plan_id = ? ORDER BY position`,
          )
          .all(String(row.id))
          .map((item) => String(item.item_id));
      return {
        ...plan,
        searchPreferences: readPreference(db, String(row.preference_id)),
        jobIds: ids("plan_job_memberships"),
        sourceTargetIds: ids("plan_sources"),
      };
    });
  return { ...input, campaigns };
}

export function migratePreferenceStorage(db: DatabaseSync): void {
  if (db.prepare("SELECT 1 FROM schema_migrations WHERE version = 27").get())
    return;
  const rows = db
    .prepare(
      "SELECT key, value FROM singleton_state WHERE key IN ('search_preferences', 'campaign_state')",
    )
    .all();
  if (rows.length) backupBeforeStorageMigration(db, 27);
  transaction(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS job_sources(id TEXT PRIMARY KEY, source_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_sources_identity_idx ON job_sources(source_id);
      CREATE TABLE IF NOT EXISTS search_preference_sets(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS search_preference_sources(preference_id TEXT NOT NULL, source_id TEXT NOT NULL, source_version_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(preference_id, source_id));
      CREATE INDEX IF NOT EXISTS search_preference_sources_order_idx ON search_preference_sources(preference_id, position);
      CREATE TABLE IF NOT EXISTS job_search_plans(id TEXT PRIMARY KEY, preference_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plan_job_memberships(plan_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(plan_id, item_id));
      CREATE INDEX IF NOT EXISTS plan_job_membership_order_idx ON plan_job_memberships(plan_id, position);
      CREATE INDEX IF NOT EXISTS plan_job_membership_job_idx ON plan_job_memberships(item_id, plan_id);
      CREATE TABLE IF NOT EXISTS plan_sources(plan_id TEXT NOT NULL, item_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(plan_id, item_id));
    `);
    for (const row of rows) {
      const key = String(row.key);
      const input = decodePreferenceSingleton(
        db,
        key,
        JSON.parse(String(row.value)) as unknown,
      );
      const encoded = encodePreferenceSingleton(db, key, input);
      db.prepare("UPDATE singleton_state SET value = ? WHERE key = ?").run(
        JSON.stringify(encoded),
        key,
      );
      // Exact round-trip check covers every source definition, independent plan
      // preference, explicit membership, order, active pointer and notification.
      if (
        !isDeepStrictEqual(decodePreferenceSingleton(db, key, encoded), input)
      )
        throw new Error("Preference migration changed stored values.");
    }
    db.prepare(
      "INSERT INTO schema_migrations(version, name) VALUES (27, 'normalized_sources_preferences_plans_membership')",
    ).run();
  });
}
