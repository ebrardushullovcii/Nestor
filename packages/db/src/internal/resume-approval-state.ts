import type { DatabaseSync } from "node:sqlite";
import {
  ResumeDraftSchema,
  TailoredAssetSchema,
  type ResumeDraft,
  type TailoredAsset,
} from "@nestor/contracts";

/** Approval changes must not rewrite the (potentially megabyte) draft body. */
export function ensureResumeApprovalState(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tailored_asset_file_state (
      asset_id TEXT PRIMARY KEY REFERENCES tailored_assets(id) ON DELETE CASCADE,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS tailored_asset_file_body_update
      AFTER UPDATE OF value ON tailored_assets BEGIN
        DELETE FROM tailored_asset_file_state WHERE asset_id IN (OLD.id, NEW.id);
      END;
    CREATE TRIGGER IF NOT EXISTS tailored_asset_file_body_insert
      AFTER INSERT ON tailored_assets BEGIN
        DELETE FROM tailored_asset_file_state WHERE asset_id = NEW.id;
      END;
    CREATE TRIGGER IF NOT EXISTS tailored_asset_file_body_delete
      AFTER DELETE ON tailored_assets BEGIN
        DELETE FROM tailored_asset_file_state WHERE asset_id = OLD.id;
      END;
    CREATE TABLE IF NOT EXISTS resume_draft_approval_state (
      draft_id TEXT PRIMARY KEY REFERENCES resume_drafts(id) ON DELETE CASCADE,
      stale_reason TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS resume_draft_approval_body_update
      AFTER UPDATE OF value ON resume_drafts BEGIN
        DELETE FROM resume_draft_approval_state WHERE draft_id IN (OLD.id, NEW.id);
      END;
    CREATE TRIGGER IF NOT EXISTS resume_draft_approval_body_insert
      AFTER INSERT ON resume_drafts BEGIN
        DELETE FROM resume_draft_approval_state WHERE draft_id = NEW.id;
      END;
    CREATE TRIGGER IF NOT EXISTS resume_draft_approval_body_delete
      AFTER DELETE ON resume_drafts BEGIN
        DELETE FROM resume_draft_approval_state WHERE draft_id = OLD.id;
      END;
  `);
}

export const resumeDraftValueSql = `COALESCE((SELECT json_set(resume_drafts.value,
  '$.status', 'stale', '$.staleReason', stale_reason,
  '$.approvedAt', json('null'), '$.approvedExportId', json('null'),
  '$.updatedAt', resume_draft_approval_state.updated_at)
  FROM resume_draft_approval_state WHERE draft_id = resume_drafts.id), resume_drafts.value)`;

export const resumeDraftUpdatedAtSql = `COALESCE((SELECT updated_at
  FROM resume_draft_approval_state WHERE draft_id = resume_drafts.id), resume_drafts.updated_at)`;

export const tailoredAssetValueSql = `COALESCE((SELECT json_set(tailored_assets.value,
  '$.storagePath', json('null'), '$.updatedAt', tailored_asset_file_state.updated_at)
  FROM tailored_asset_file_state WHERE asset_id = tailored_assets.id), tailored_assets.value)`;

const stateSchema = ResumeDraftSchema.pick({
  status: true,
  staleReason: true,
  approvedAt: true,
  approvedExportId: true,
  updatedAt: true,
});

/** Borrowed bodies remain frozen; only the small approval projection changes. */
export function createResumeApprovalProjection(database: DatabaseSync) {
  const read = database.prepare(
    "SELECT draft_id, stale_reason, updated_at FROM resume_draft_approval_state ORDER BY draft_id",
  );
  const overlays = new WeakMap<
    ResumeDraft,
    { reason: string; at: string; draft: ResumeDraft }
  >();
  let lastBodies: readonly ResumeDraft[] | null = null;
  let lastState = "";
  let lastRows: readonly ResumeDraft[] = [];
  return (bodies: readonly ResumeDraft[]): readonly ResumeDraft[] => {
    const rows = read.all();
    const key = JSON.stringify(rows);
    if (!database.isTransaction && bodies === lastBodies && key === lastState)
      return lastRows;
    const byId = new Map(rows.map((row) => [String(row.draft_id), row]));
    const result = bodies
      .map((body) => {
        const row = byId.get(body.id);
        if (!row) return body;
        const state = stateSchema.parse({
          status: "stale",
          staleReason: row.stale_reason,
          approvedAt: null,
          approvedExportId: null,
          updatedAt: row.updated_at,
        });
        const cached = overlays.get(body);
        if (
          cached?.reason === state.staleReason &&
          cached.at === state.updatedAt
        )
          return cached.draft;
        const draft = Object.freeze({ ...body, ...state });
        if (!database.isTransaction)
          overlays.set(body, {
            reason: state.staleReason!,
            at: state.updatedAt,
            draft,
          });
        return draft;
      })
      .sort((a, b) =>
        a.updatedAt > b.updatedAt
          ? -1
          : a.updatedAt < b.updatedAt
            ? 1
            : Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
      );
    const frozen = Object.freeze(result);
    if (!database.isTransaction) {
      lastBodies = bodies;
      lastState = key;
      lastRows = frozen;
    }
    return frozen;
  };
}

const fileStateSchema = TailoredAssetSchema.pick({
  storagePath: true,
  updatedAt: true,
});

export function createTailoredAssetFileProjection(database: DatabaseSync) {
  const read = database.prepare(
    "SELECT asset_id, updated_at FROM tailored_asset_file_state ORDER BY asset_id",
  );
  const overlays = new WeakMap<
    TailoredAsset,
    { at: string; asset: TailoredAsset }
  >();
  let lastBodies: readonly TailoredAsset[] | null = null;
  let lastState = "";
  let lastRows: readonly TailoredAsset[] = [];
  return (bodies: readonly TailoredAsset[]): readonly TailoredAsset[] => {
    const rows = read.all();
    const key = JSON.stringify(rows);
    if (!database.isTransaction && bodies === lastBodies && key === lastState)
      return lastRows;
    const byId = new Map(rows.map((row) => [String(row.asset_id), row]));
    const result = Object.freeze(
      bodies.map((body) => {
        const row = byId.get(body.id);
        if (!row) return body;
        const state = fileStateSchema.parse({
          storagePath: null,
          updatedAt: row.updated_at,
        });
        const cached = overlays.get(body);
        if (cached?.at === state.updatedAt) return cached.asset;
        const asset = Object.freeze({ ...body, ...state });
        if (!database.isTransaction)
          overlays.set(body, { at: state.updatedAt, asset });
        return asset;
      }),
    );
    if (!database.isTransaction) {
      lastBodies = bodies;
      lastState = key;
      lastRows = result;
    }
    return result;
  };
}
