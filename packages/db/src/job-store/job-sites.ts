import {
  AddJobSitesInputSchema,
  SetJobSitesEnabledInputSchema,
  type SetJobSitesEnabledInput,
  JobSiteListQuerySchema,
  JobSiteRuntimeUpdateSchema,
  type JobSiteRuntimeUpdate,
  UpdateJobSiteInputSchema,
  parseJobSiteUrls,
  canonicalJobSiteUrl,
  jobSiteLabel,
  type AddJobSitesInput,
  type AddJobSitesResult,
  type JobSite,
  type JobSiteListQuery,
  type JobSitePage,
  type UpdateJobSiteInput,
} from "@nestor/contracts";
import type { SQLInputValue } from "node:sqlite";
import { createRowUndo } from "./row-undo";
import type { JobStore } from "./job-store";

export const JOB_SITES_SCHEMA = `
CREATE TABLE IF NOT EXISTS job_site_undo (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, items_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL COLLATE NOCASE,
  url TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  provider TEXT,
  lane TEXT NOT NULL DEFAULT 'auto' CHECK (lane IN ('auto', 'http', 'browser')),
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'healthy', 'needs_sign_in', 'blocked', 'failed')),
  last_searched_at TEXT,
  sign_in_state TEXT NOT NULL DEFAULT 'unknown' CHECK (sign_in_state IN ('unknown', 'not_required', 'required', 'signed_in')),
  custom_instructions TEXT,
  instruction_status TEXT NOT NULL DEFAULT 'missing',
  validated_instruction_id TEXT,
  draft_instruction_id TEXT,
  last_debug_run_id TEXT,
  last_verified_at TEXT,
  stale_reason TEXT,
  attention INTEGER GENERATED ALWAYS AS (health IN ('needs_sign_in', 'blocked', 'failed') OR instruction_status IN ('stale', 'unsupported')) STORED
);
CREATE INDEX IF NOT EXISTS job_sites_label ON job_sites(label, id);
CREATE INDEX IF NOT EXISTS job_sites_enabled ON job_sites(enabled, label, id);
CREATE INDEX IF NOT EXISTS job_sites_attention ON job_sites(attention, label, id);
CREATE INDEX IF NOT EXISTS job_sites_provider ON job_sites(provider, label, id);
CREATE INDEX IF NOT EXISTS job_sites_lane ON job_sites(lane, label, id);
CREATE INDEX IF NOT EXISTS job_sites_health ON job_sites(health, label, id);
CREATE INDEX IF NOT EXISTS job_sites_searched ON job_sites(last_searched_at, id);
CREATE INDEX IF NOT EXISTS job_sites_sign_in ON job_sites(sign_in_state, label, id);
CREATE VIRTUAL TABLE IF NOT EXISTS job_sites_fts USING fts5(label, url, content='job_sites', content_rowid='rowid', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS job_sites_fts_add AFTER INSERT ON job_sites BEGIN
  INSERT INTO job_sites_fts(rowid, label, url) VALUES (new.rowid, new.label, new.url);
END;
CREATE TRIGGER IF NOT EXISTS job_sites_fts_remove AFTER DELETE ON job_sites BEGIN
  INSERT INTO job_sites_fts(job_sites_fts, rowid, label, url) VALUES ('delete', old.rowid, old.label, old.url);
END;
CREATE TRIGGER IF NOT EXISTS job_sites_fts_update AFTER UPDATE OF label, url ON job_sites BEGIN
  INSERT INTO job_sites_fts(job_sites_fts, rowid, label, url) VALUES ('delete', old.rowid, old.label, old.url);
  INSERT INTO job_sites_fts(rowid, label, url) VALUES (new.rowid, new.label, new.url);
END;
`;

const COLUMNS = `s.id, s.label, s.url, s.enabled, s.provider, s.lane, s.health,
 s.last_searched_at AS lastSearchedAt, s.sign_in_state AS signInState,
 s.custom_instructions AS customInstructions, s.instruction_status AS instructionStatus,
 s.validated_instruction_id AS validatedInstructionId, s.draft_instruction_id AS draftInstructionId,
 s.last_debug_run_id AS lastDebugRunId, s.last_verified_at AS lastVerifiedAt, s.stale_reason AS staleReason`;
type SiteRow = Omit<JobSite, "enabled"> & { enabled: number };
const toSite = (row: SiteRow): JobSite => ({
  ...row,
  enabled: Boolean(row.enabled),
});

export function createJobSitesStore(store: JobStore) {
  const { sql } = store;
  const undo = createRowUndo(store, {
    journal: "job_site_undo",
    cause: "sites",
  });
  let lastChange = { undoId: null as number | null, undoCount: 0 };
  const changed = () =>
    store.notify({ cause: "sites", stages: [], ids: [], searchId: null });
  const get = (id: number): JobSite | null => {
    const row = sql(`SELECT ${COLUMNS} FROM job_sites s WHERE id = ?`).get(
      id,
    ) as SiteRow | undefined;
    return row ? toSite(row) : null;
  };
  return {
    get,
    takeUndo() {
      const value = lastChange;
      lastChange = { undoId: null, undoCount: 0 };
      return value;
    },
    undo: (undoId: number) => undo.undo(undoId),
    list(input: JobSiteListQuery = {}): JobSitePage {
      const query = JobSiteListQuerySchema.parse(input);
      const values: SQLInputValue[] = [];
      let match = "1";
      if (query.text.length >= 3) {
        match =
          "s.rowid IN (SELECT rowid FROM job_sites_fts WHERE job_sites_fts MATCH ?)";
        values.push(`"${query.text.replaceAll('"', '""')}"`);
      } else if (query.text) {
        match = "(s.label LIKE ? ESCAPE '\\' OR s.url LIKE ? ESCAPE '\\')";
        const text = `%${query.text.replace(/[\\%_]/gu, "\\$&")}%`;
        values.push(text, text);
      }
      const counts =
        sql(`SELECT count(*) AS "all", coalesce(sum(enabled), 0) AS enabled,
        coalesce(sum(NOT enabled), 0) AS disabled, coalesce(sum(attention), 0) AS needs_attention
        FROM job_sites s WHERE ${match}`).get(
          ...values,
        ) as JobSitePage["counts"];
      const filter =
        query.filter === "enabled"
          ? "s.enabled = 1"
          : query.filter === "disabled"
            ? "s.enabled = 0"
            : query.filter === "needs_attention"
              ? "s.attention = 1"
              : "1";
      let cursor = "1";
      if (query.cursor) {
        const data: unknown = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString(),
        );
        if (
          !Array.isArray(data) ||
          data.length !== 2 ||
          typeof data[0] !== "string" ||
          typeof data[1] !== "number"
        )
          throw new Error("Invalid site page.");
        cursor = "(s.label, s.id) > (?, ?)";
        values.push(data[0], data[1]);
      }
      const rows = (
        sql(`SELECT ${COLUMNS} FROM job_sites s WHERE ${match} AND ${filter} AND ${cursor}
        ORDER BY s.label, s.id LIMIT ?`).all(
          ...values,
          query.limit + 1,
        ) as SiteRow[]
      ).map(toSite);
      const visible = rows.slice(0, query.limit);
      const last = visible.at(-1);
      const selected =
        query.selection === undefined
          ? 0
          : (
              sql(
                `SELECT count(*) AS n FROM job_sites WHERE enabled = 1 AND id ${"all" in query.selection ? "NOT IN" : "IN"} (SELECT value FROM json_each(?))`,
              ).get(
                JSON.stringify(
                  "all" in query.selection
                    ? query.selection.except
                    : query.selection.ids,
                ),
              ) as { n: number }
            ).n;
      return {
        selected,
        enabledTotal: query.text
          ? (
              sql(
                "SELECT count(*) AS n FROM job_sites WHERE enabled = 1",
              ).get() as { n: number }
            ).n
          : counts.enabled,
        rows: visible,
        counts,
        total: counts[query.filter],
        nextCursor:
          rows.length > query.limit && last
            ? Buffer.from(JSON.stringify([last.label, last.id])).toString(
                "base64url",
              )
            : null,
      };
    },
    /** The runner needs enabled sites, not a workspace snapshot. */
    enabled(): JobSite[] {
      return (
        sql(
          `SELECT ${COLUMNS} FROM job_sites s WHERE enabled = 1 ORDER BY label, id`,
        ).all() as SiteRow[]
      ).map(toSite);
    },
    add(input: AddJobSitesInput): AddJobSitesResult {
      const parsed = parseJobSiteUrls(AddJobSitesInputSchema.parse(input).text);
      return store.transaction(() => {
        const change = undo.begin();
        let added = 0,
          duplicates = parsed.duplicates;
        const duplicateUrls = new Set(parsed.duplicateUrls);
        let firstAddedId: number | null = null;
        const insert = sql(
          "INSERT INTO job_sites (label, url) VALUES (?, ?) ON CONFLICT(url) DO NOTHING RETURNING id",
        );
        for (const url of parsed.urls) {
          if (sql("SELECT 1 FROM job_sites WHERE url = ?").get(url)) {
            duplicates++;
            duplicateUrls.add(url);
            continue;
          }
          const label = jobSiteLabel(url);
          const inserted = insert.get(label, url) as { id: number } | undefined;
          if (inserted) {
            change.capture({ table: "job_sites", id: inserted.id }, null);
            added++;
            firstAddedId ??= inserted.id;
          } else {
            duplicates++;
            duplicateUrls.add(url);
          }
        }
        lastChange = change.finish();
        if (added) changed();
        return {
          added,
          duplicates,
          duplicateUrls: [...duplicateUrls],
          invalid: parsed.invalid,
          firstAddedId,
        };
      });
    },
    update(input: UpdateJobSiteInput): JobSite | null {
      const value = UpdateJobSiteInputSchema.parse(input);
      return store.transaction(() => {
        const before = get(value.id);
        lastChange = { undoId: null, undoCount: 0 };
        if (!before) return null;
        const change = undo.begin();
        change.capture({ table: "job_sites", id: value.id });
        const columns: string[] = [];
        const values: SQLInputValue[] = [];
        const keys = {
          label: "label",
          enabled: "enabled",
          lane: "lane",
          customInstructions: "custom_instructions",
        } as const;
        for (const [key, column] of Object.entries(keys)) {
          const name = key as keyof typeof keys;
          if (value[name] !== undefined && value[name] !== before[name]) {
            columns.push(`${column} = ?`);
            values.push(
              typeof value[name] === "boolean"
                ? Number(value[name])
                : (value[name] ?? null),
            );
          }
        }
        const url =
          value.url === undefined
            ? before.url
            : canonicalJobSiteUrl(value.url)!;
        if (url !== before.url) {
          if (
            sql("SELECT 1 FROM job_sites WHERE url = ? AND id <> ?").get(
              url,
              value.id,
            )
          )
            throw new Error("That site is already in your list.");
          columns.push(
            "url = ?",
            "health = 'unknown'",
            "provider = NULL",
            "lane = 'auto'",
            "last_debug_run_id = NULL",
            "last_verified_at = NULL",
            "stale_reason = NULL",
            "sign_in_state = 'unknown'",
            "last_searched_at = NULL",
            "validated_instruction_id = NULL",
            "draft_instruction_id = NULL",
            "instruction_status = 'missing'",
          );
          values.push(url);
        }
        if (columns.length) {
          sql(`UPDATE job_sites SET ${columns.join(", ")} WHERE id = ?`).run(
            ...values,
            value.id,
          );
          changed();
        }
        lastChange = change.finish();
        return get(value.id);
      });
    },
    counts(): JobSitePage["counts"] {
      return sql(
        `SELECT count(*) AS "all", coalesce(sum(enabled), 0) AS enabled, coalesce(sum(NOT enabled), 0) AS disabled, coalesce(sum(attention), 0) AS needs_attention FROM job_sites`,
      ).get() as JobSitePage["counts"];
    },
    record(
      id: number,
      input: JobSiteRuntimeUpdate,
      notify = true,
    ): JobSite | null {
      const patch = JobSiteRuntimeUpdateSchema.parse(input);
      return store.transaction(() => {
        const before = get(id);
        if (!before) return null;
        const names = {
          provider: "provider",
          lane: "lane",
          health: "health",
          lastSearchedAt: "last_searched_at",
          signInState: "sign_in_state",
          instructionStatus: "instruction_status",
          validatedInstructionId: "validated_instruction_id",
          draftInstructionId: "draft_instruction_id",
          lastDebugRunId: "last_debug_run_id",
          lastVerifiedAt: "last_verified_at",
          staleReason: "stale_reason",
        } as const;
        const columns: string[] = [],
          values: SQLInputValue[] = [];
        for (const name of Object.keys(names) as (keyof typeof names)[]) {
          if (patch[name] !== undefined && patch[name] !== before[name]) {
            columns.push(`${names[name]} = ?`);
            values.push(patch[name] ?? null);
          }
        }
        if (columns.length) {
          sql(`UPDATE job_sites SET ${columns.join(", ")} WHERE id = ?`).run(
            ...values,
            id,
          );
          if (notify) changed();
        }
        return get(id);
      });
    },
    setEnabled(input: SetJobSitesEnabledInput): number {
      const value = SetJobSitesEnabledInputSchema.parse(input);
      return store.transaction(() => {
        const ids =
          "all" in value.selection
            ? value.selection.except
            : value.selection.ids;
        const selection = `id ${"all" in value.selection ? "NOT IN" : "IN"} (SELECT value FROM json_each(?))`;
        const text = value.text.toLowerCase();
        const filter =
          value.filter === "enabled"
            ? "enabled = 1"
            : value.filter === "disabled"
              ? "enabled = 0"
              : value.filter === "needs_attention"
                ? "attention = 1"
                : "1";
        const change = undo.begin();
        const selected =
          sql(`SELECT id FROM job_sites WHERE enabled <> ? AND ${selection} AND ${filter}
          AND (instr(lower(label), ?) > 0 OR instr(lower(url), ?) > 0)`).all(
            Number(value.enabled),
            JSON.stringify(ids),
            text,
            text,
          ) as { id: number }[];
        for (const row of selected)
          change.capture({ table: "job_sites", id: row.id });
        const result = sql(
          `UPDATE job_sites SET enabled = ? WHERE enabled <> ? AND ${selection} AND ${filter} AND (instr(lower(label), ?) > 0 OR instr(lower(url), ?) > 0)`,
        ).run(
          Number(value.enabled),
          Number(value.enabled),
          JSON.stringify(ids),
          text,
          text,
        );
        lastChange = change.finish();
        if (result.changes) changed();
        return Number(result.changes);
      });
    },
    remove(id: number): boolean {
      return store.transaction(() => {
        const change = undo.begin();
        change.capture({ table: "job_sites", id });
        const removed = Boolean(
          sql("DELETE FROM job_sites WHERE id = ?").run(id).changes,
        );
        lastChange = change.finish();
        if (removed) changed();
        return removed;
      });
    },
  };
}
export type JobSitesStore = ReturnType<typeof createJobSitesStore>;
