import type { SQLInputValue } from "node:sqlite";

import type { JobStore } from "./job-store";

type Target =
  | { table: "tracker"; job_id: number }
  | { table: "tracker_events"; id: number }
  | { table: "tracker_tags"; job_id: number; tag: string }
  | { table: "tracker_views"; id: number };
type Row = Record<string, SQLInputValue>;
type Change = { target: Target; before: Row | null; after: Row | null };

/** Row comparisons keep an old Undo from overwriting later work. Derived
 * counts and next dates are maintained by the same triggers as normal edits. */
export function createTrackerUndo(store: JobStore) {
  const read = (target: Target): Row | null => {
    const { table, ...key } = target;
    const columns =
      table === "tracker" ? "job_id, status, status_at, status_change_id" : "*";
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
              .sql("INSERT INTO tracker_undo (at, items_json) VALUES (?, ?)")
              .run(Date.now(), JSON.stringify(items)).lastInsertRowid,
          );
          return { undoId, undoCount: items.length };
        },
      };
    },
    undo(undoId: number) {
      return store.transaction(() => {
        const saved = store
          .sql("SELECT items_json FROM tracker_undo WHERE id = ?")
          .get(undoId) as { items_json: string } | undefined;
        if (!saved) return { changed: 0, skipped: 0 };
        const items = JSON.parse(saved.items_json) as Change[];
        const ids = new Set<number>();
        let changed = 0;
        let skipped = 0;
        for (const item of [...items].reverse()) {
          if (!same(read(item.target), item.after)) {
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
            table === "tracker_views" &&
            item.before &&
            store
              .sql("SELECT id FROM tracker_views WHERE name = ? AND id <> ?")
              .get(item.before.name!, item.before.id!)
          ) {
            skipped++;
            continue;
          }
          const jobId = item.before?.job_id ?? item.after?.job_id;
          if (typeof jobId === "number") ids.add(jobId);
          if (item.before === null) {
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
        store.sql("DELETE FROM tracker_undo WHERE id = ?").run(undoId);
        if (changed)
          store.notify({
            cause: "tracker",
            stages: ["resume", "applied"],
            ids: ids.size <= 200 ? [...ids] : null,
            searchId: null,
          });
        return { changed, skipped };
      });
    },
  };
}
