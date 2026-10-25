import type { SQLInputValue } from "node:sqlite";

import type { JobStore } from "./job-store";

type Target =
  | { table: "tracker"; job_id: number }
  | { table: "tracker_events"; id: number }
  | { table: "tracker_tags"; job_id: number; tag: string }
  | { table: "tracker_views"; id: number }
  | { table: "job_sites"; id: number };
type Row = Record<string, SQLInputValue>;
type Change = { target: Target; before: Row | null; after: Row | null };

/** Row comparisons keep an old Undo from overwriting later work. Derived
 * counts and next dates are maintained by the same triggers as normal edits. */
export function createRowUndo(
  store: JobStore,
  options: {
    journal: "tracker_undo" | "job_site_undo";
    cause: "tracker" | "sites";
  },
) {
  const read = (target: Target): Row | null => {
    const { table, ...key } = target;
    const columns =
      table === "tracker"
        ? "job_id, status, status_at, status_change_id"
        : table === "job_sites"
          ? "id, label, url, enabled, provider, lane, health, last_searched_at, sign_in_state, custom_instructions, instruction_status, validated_instruction_id, draft_instruction_id, last_debug_run_id, last_verified_at, stale_reason"
          : "*";
    return (
      (store
        .sql(
          `SELECT ${columns} FROM ${table} WHERE ${Object.keys(key)
            .map((column) => `${column} = ?`)
            .join(" AND ")}`,
        )
        .get(...Object.values(key)) as Row | undefined) ?? null
    );
  };
  const same = (a: Row | null, b: Row | null) =>
    JSON.stringify(a) === JSON.stringify(b);
  return {
    begin() {
      const pending: { target: Target; before: Row | null }[] = [];
      const captured = new Set<string>();
      return {
        capture(target: Target, before = read(target)) {
          const key = JSON.stringify(target);
          if (captured.has(key)) return;
          captured.add(key);
          pending.push({ target, before });
        },
        finish() {
          const items = pending
            .map((item) => ({ ...item, after: read(item.target) }))
            .filter((item) => !same(item.before, item.after));
          if (!items.length) return { undoId: null, undoCount: 0 };
          const undoId = Number(
            store
              .sql(
                `INSERT INTO ${options.journal} (at, items_json) VALUES (?, ?)`,
              )
              .run(Date.now(), JSON.stringify(items)).lastInsertRowid,
          );
          return { undoId, undoCount: items.length };
        },
      };
    },
    undo(undoId: number) {
      return store.transaction(() => {
        const saved = store
          .sql(`SELECT items_json FROM ${options.journal} WHERE id = ?`)
          .get(undoId) as { items_json: string } | undefined;
        if (!saved) return { changed: 0, skipped: 0 };
        const items = JSON.parse(saved.items_json) as Change[];
        const ids = new Set<number>();
        let changed = 0;
        let skipped = 0;
        for (const item of [...items].reverse()) {
          const current = read(item.target);
          const siteColumns =
            item.target.table === "job_sites" && item.before && item.after
              ? Object.keys(item.before).filter(
                  (column) => item.before![column] !== item.after![column],
                )
              : null;
          if (
            siteColumns
              ? !current ||
                siteColumns.some(
                  (column) => current[column] !== item.after![column],
                )
              : !same(current, item.after)
          ) {
            skipped++;
            continue;
          }
          const { table, ...key } = item.target;
          if (
            item.before?.job_id &&
            !store
              .sql("SELECT id FROM jobs WHERE id = ?")
              .get(item.before.job_id)
          ) {
            skipped++;
            continue;
          }
          if (
            (table === "tracker_views" ||
              (table === "job_sites" &&
                (!siteColumns || siteColumns.includes("url")))) &&
            item.before &&
            store
              .sql(
                `SELECT id FROM ${table} WHERE ${table === "job_sites" ? "url" : "name"} = ? AND id <> ?`,
              )
              .get(
                table === "job_sites" ? item.before.url! : item.before.name!,
                item.before.id!,
              )
          ) {
            skipped++;
            continue;
          }
          const jobId = item.before?.job_id ?? item.after?.job_id;
          if (typeof jobId === "number") ids.add(jobId);
          if (siteColumns && item.before) {
            store
              .sql(
                `UPDATE job_sites SET ${siteColumns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
              )
              .run(
                ...siteColumns.map((column) => item.before![column]!),
                item.before.id!,
              );
          } else if (item.before === null) {
            store
              .sql(
                `DELETE FROM ${table} WHERE ${Object.keys(key)
                  .map((column) => `${column} = ?`)
                  .join(" AND ")}`,
              )
              .run(...Object.values(key));
          } else {
            const columns = Object.keys(item.before);
            store
              .sql(
                `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
              ON CONFLICT DO UPDATE SET ${columns.map((column) => `${column} = excluded.${column}`).join(", ")}`,
              )
              .run(...Object.values(item.before));
          }
          changed++;
        }
        store.sql(`DELETE FROM ${options.journal} WHERE id = ?`).run(undoId);
        if (changed)
          store.notify({
            cause: options.cause,
            stages: options.cause === "sites" ? [] : ["resume", "applied"],
            ids: ids.size <= 200 ? [...ids] : null,
            searchId: null,
          });
        return { changed, skipped };
      });
    },
  };
}
