import {
  AddTrackerEventInputSchema,
  TRACKER_STATUS_LABEL,
  TrackerFilterSchema,
  TrackerListQuerySchema,
  TrackerSelectionSchema,
  UpdateTrackerEventInputSchema,
  trackerStatusValues,
  type AddTrackerEventInput,
  type TrackerEvent,
  type TrackerFilter,
  type TrackerFilterInput,
  type TrackerListQueryInput,
  type TrackerPage,
  type TrackerRow,
  type TrackerSort,
  type TrackerStatus,
  type TrackerStatusCounts,
  type TrackerSelectionInput,
  type TrackerView,
  type UpdateTrackerEventInput,
} from "@nestor/contracts";
import { randomUUID } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";

import type { JobStore } from "./job-store";
import { toIso, toTextMatch } from "./job-list";
import { createRowUndo } from "./row-undo";

const DAY_MS = 86_400_000;
const TOTAL_CAP = 1000;

type RowRecord = {
  job_id: number;
  title: string;
  company: string;
  location: string;
  status: TrackerStatus;
  status_at: number;
  applied_at: number | null;
  next_at: number | null;
  next_title: string | null;
  work: TrackerRow["work"];
  work_error: string | null;
};

type EventRecord = {
  id: number;
  kind: TrackerEvent["kind"];
  at: number;
  title: string;
  body: string | null;
  due_at: number | null;
  done_at: number | null;
  place: string | null;
};

const ROW_COLUMNS = `t.job_id, j.title, j.company, j.location, t.status, t.status_at,
  t.applied_at, t.next_at, t.next_title,
  CASE WHEN t.status = 'applying' THEN COALESCE(a.disposition,a.state) END AS work,
  CASE WHEN t.status = 'applying' THEN a.error END AS work_error`;

/**
 * Each order is an indexed column or expression, then `job_id`, so a page
 * position is exact. The expressions match tracker-schema.ts's indexes
 * character for character, or SQLite sorts every row instead.
 */
const SORT: Record<TrackerSort, { key: string; dir: "ASC" | "DESC" }> = {
  recent: { key: "t.status_at", dir: "DESC" },
  applied: { key: "COALESCE(t.applied_at, 0)", dir: "DESC" },
  next: { key: "COALESCE(t.next_at, 9007199254740991)", dir: "ASC" },
};

/** One page of the tracker list, in `sort` order; exported for its plan test. */
export function trackerPageSql(sort: TrackerSort, where: string): string {
  const order = SORT[sort];
  return `SELECT ${ROW_COLUMNS}, ${order.key} AS sort_key
    FROM tracker t JOIN jobs j ON j.id = t.job_id
    LEFT JOIN applications a ON a.job_id = t.job_id
    WHERE ${where} ORDER BY ${order.key} ${order.dir}, t.job_id ${order.dir} LIMIT ?`;
}

function toEvent(row: EventRecord): TrackerEvent {
  return {
    id: row.id,
    kind: row.kind,
    at: toIso(row.at),
    title: row.title,
    body: row.body,
    dueAt: row.due_at === null ? null : toIso(row.due_at),
    doneAt: row.done_at === null ? null : toIso(row.done_at),
    place: row.place,
  };
}

const parseTime = (value: string | null | undefined) =>
  value ? Date.parse(value) : null;

function toFilterSql(filter: TrackerFilter, now: number) {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (filter.statuses.length > 0) {
    clauses.push(`t.status IN (${filter.statuses.map(() => "?").join(", ")})`);
    params.push(...filter.statuses);
  }
  if (filter.tag) {
    clauses.push("t.job_id IN (SELECT job_id FROM tracker_tags WHERE tag = ?)");
    params.push(filter.tag);
  }
  const match = toTextMatch(filter.text);
  if (match) {
    clauses.push(
      "j.rowid IN (SELECT rowid FROM jobs_text WHERE jobs_text MATCH ?)",
    );
    params.push(match);
  }
  if (filter.due) {
    clauses.push("t.next_at IS NOT NULL AND t.next_at <= ?");
    params.push(now);
  }
  if (filter.quietForDays !== null) {
    clauses.push("t.status = 'applied' AND t.status_at <= ?");
    params.push(now - filter.quietForDays * DAY_MS);
  }
  return {
    where: clauses.length > 0 ? clauses.join(" AND ") : "1",
    params,
  };
}

export type TrackerStore = ReturnType<typeof createTrackerStore>;

/** The Applications tracker. Every list, filter and count reads an index. */
export function createTrackerStore(store: JobStore) {
  const { sql } = store;
  const undo = createRowUndo(store, {
    journal: "tracker_undo",
    cause: "tracker",
  });
  const changed = (ids: number[] | null) =>
    store.notify({
      cause: "tracker",
      stages: ["resume", "applied"],
      ids: ids && ids.length <= 200 ? ids : null,
      searchId: null,
    });

  const counts = (): TrackerStatusCounts => {
    const result = Object.fromEntries(
      trackerStatusValues.map((status) => [status, 0]),
    ) as TrackerStatusCounts;
    for (const row of sql("SELECT status, n FROM tracker_counts").all() as {
      status: TrackerStatus;
      n: number;
    }[])
      result[row.status] = row.n;
    return result;
  };

  const tagsFor = (ids: readonly number[]) => {
    const tags = new Map<number, string[]>();
    for (const row of sql(
      `SELECT job_id, tag FROM tracker_tags
       WHERE job_id IN (SELECT value FROM json_each(?)) ORDER BY tag`,
    ).all(JSON.stringify(ids)) as { job_id: number; tag: string }[]) {
      tags.set(row.job_id, [...(tags.get(row.job_id) ?? []), row.tag]);
    }
    return tags;
  };

  const toRows = (records: RowRecord[]): TrackerRow[] => {
    const tags = tagsFor(records.map((row) => row.job_id));
    return records.map((row) => ({
      id: row.job_id,
      title: row.title,
      company: row.company,
      location: row.location,
      status: row.status,
      statusAt: toIso(row.status_at),
      work: row.work,
      workError: row.work_error,
      appliedAt: row.applied_at === null ? null : toIso(row.applied_at),
      nextAt: row.next_at === null ? null : toIso(row.next_at),
      nextTitle: row.next_title,
      tags: tags.get(row.job_id) ?? [],
    }));
  };

  const getRow = (jobId: number): TrackerRow | null => {
    const record = sql(
      `SELECT ${ROW_COLUMNS} FROM tracker t JOIN jobs j ON j.id = t.job_id
       LEFT JOIN applications a ON a.job_id = t.job_id WHERE t.job_id = ?`,
    ).get(jobId) as RowRecord | undefined;
    return record ? (toRows([record])[0] ?? null) : null;
  };

  const getEvent = (id: number) => {
    const row = sql("SELECT * FROM tracker_events WHERE id = ?").get(id) as
      | (EventRecord & { job_id: number })
      | undefined;
    return row ?? null;
  };

  const writeStatus = (jobId: number, status: TrackerStatus, at: number) => {
    sql(
      "UPDATE tracker SET status = ?, status_at = ?, status_change_id = ? WHERE job_id = ?",
    ).run(status, at, randomUUID(), jobId);
    return Number(
      sql(
        "INSERT INTO tracker_events (job_id, kind, at, title) VALUES (?, 'status', ?, ?)",
      ).run(jobId, at, TRACKER_STATUS_LABEL[status]).lastInsertRowid,
    );
  };

  return {
    counts,
    getRow,
    undoChange: (id: number) => undo.undo(id),

    list(input: TrackerListQueryInput = {}): TrackerPage {
      const query = TrackerListQuerySchema.parse(input);
      const now = Date.now();
      const filter = toFilterSql(query, now);
      const order = SORT[query.sort];
      const cmp = order.dir === "DESC" ? "<" : ">";
      let where = filter.where;
      const params = [...filter.params];
      if (query.cursor) {
        const [key, id] = JSON.parse(
          Buffer.from(query.cursor, "base64url").toString(),
        ) as [number, number];
        where += ` AND (${order.key} ${cmp} ? OR (${order.key} = ? AND t.job_id ${cmp} ?))`;
        params.push(key, key, id);
      }
      const from = `FROM tracker t JOIN jobs j ON j.id = t.job_id
        LEFT JOIN applications a ON a.job_id = t.job_id`;
      const records = sql(trackerPageSql(query.sort, where)).all(
        ...params,
        query.limit + 1,
      ) as (RowRecord & { sort_key: number })[];
      const more = records.length > query.limit;
      const page = records.slice(0, query.limit);
      const last = page.at(-1);
      const { n: total } = sql(
        `SELECT count(*) AS n FROM (SELECT 1 ${from} WHERE ${filter.where} LIMIT ?)`,
      ).get(...filter.params, TOTAL_CAP + 1) as { n: number };
      return {
        rows: toRows(page),
        nextCursor:
          more && last
            ? Buffer.from(
                JSON.stringify([last.sort_key, last.job_id]),
              ).toString("base64url")
            : null,
        total: Math.min(total, TOTAL_CAP),
        totalCapped: total > TOTAL_CAP,
        counts: counts(),
      };
    },

    /** Every application matching a filter, for export; streamed in pages. */
    *each(input: TrackerFilterInput & { sort?: TrackerSort }) {
      let cursor: string | null = null;
      do {
        const page = this.list({ ...input, cursor, limit: 200 });
        yield* page.rows;
        cursor = page.nextCursor;
      } while (cursor);
    },

    agenda(days: number, limit: number) {
      return (
        sql(`SELECT e.*, j.title AS job_title, j.company FROM tracker_events e
        JOIN jobs j ON j.id = e.job_id JOIN tracker t ON t.job_id = e.job_id
        WHERE e.due_at IS NOT NULL AND e.done_at IS NULL AND e.kind IN ('interview', 'reminder')
          AND e.due_at <= ? ORDER BY e.due_at, e.id LIMIT ?`).all(
          Date.now() + days * DAY_MS,
          limit,
        ) as (EventRecord & {
          job_id: number;
          job_title: string;
          company: string;
        })[]
      ).map((row) => ({
        jobId: row.job_id,
        job: `${row.job_title} at ${row.company}`,
        event: toEvent(row),
      }));
    },

    events(jobId: number): TrackerEvent[] {
      return (
        sql(
          "SELECT * FROM tracker_events WHERE job_id = ? ORDER BY at DESC, id DESC LIMIT 500",
        ).all(jobId) as EventRecord[]
      ).map(toEvent);
    },

    selectedIds(input: TrackerSelectionInput): number[] {
      const selection = TrackerSelectionSchema.parse(input);
      if ("ids" in selection) return selection.ids;
      const filter = toFilterSql(selection.filter, Date.now());
      return (
        sql(`SELECT t.job_id FROM tracker t JOIN jobs j ON j.id = t.job_id
        WHERE ${filter.where} AND t.job_id NOT IN (SELECT value FROM json_each(?))`).all(
          ...filter.params,
          JSON.stringify(selection.except),
        ) as { job_id: number }[]
      ).map((row) => row.job_id);
    },

    setStatus(ids: readonly number[], status: TrackerStatus) {
      return store.transaction(() => {
        const current = sql(
          `SELECT job_id, status, status_at FROM tracker
           WHERE job_id IN (SELECT value FROM json_each(?))
             AND status <> 'applying' AND status <> ?`,
        ).all(JSON.stringify(ids), status) as {
          job_id: number;
          status: TrackerStatus;
          status_at: number;
        }[];
        const change = undo.begin();
        for (const row of current) {
          change.capture({ table: "tracker", job_id: row.job_id });
          const id = writeStatus(row.job_id, status, Date.now());
          change.capture({ table: "tracker_events", id }, null);
        }
        const receipt = change.finish();
        if (current.length) changed(current.map((row) => row.job_id));
        return { changed: current.length, ...receipt };
      });
    },

    addEvent(input: AddTrackerEventInput) {
      const event = AddTrackerEventInputSchema.parse(input);
      return store.transaction(() => {
        if (!getRow(event.jobId))
          throw new Error("That job is not in Applications.");
        const change = undo.begin();
        change.capture({ table: "tracker", job_id: event.jobId });
        const now = Date.now();
        const id = Number(
          sql(
            `INSERT INTO tracker_events (job_id, kind, at, title, body, due_at, place)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            event.jobId,
            event.kind,
            now,
            event.title,
            event.body,
            parseTime(event.dueAt),
            event.place,
          ).lastInsertRowid,
        );
        change.capture({ table: "tracker_events", id }, null);
        // A reply or an interview is news: the application moves on with it.
        const row = getRow(event.jobId);
        const next: TrackerStatus | null =
          event.kind === "reply" &&
          (row?.status === "applied" || row?.status === "no_reply")
            ? "replied"
            : event.kind === "interview" &&
                row &&
                ["applied", "replied", "assessment", "no_reply"].includes(
                  row.status,
                )
              ? "interview"
              : null;
        if (next)
          change.capture(
            {
              table: "tracker_events",
              id: writeStatus(event.jobId, next, now),
            },
            null,
          );
        changed([event.jobId]);
        return { ...toEvent(getEvent(id)!), ...change.finish() };
      });
    },

    updateEvent(input: UpdateTrackerEventInput) {
      const patch = UpdateTrackerEventInputSchema.parse(input);
      return store.transaction(() => {
        const event = getEvent(patch.id);
        if (!event || event.kind === "status")
          throw new Error("That entry cannot be edited.");
        const change = undo.begin();
        change.capture({ table: "tracker_events", id: patch.id });
        sql(
          `UPDATE tracker_events SET title = ?, body = ?, due_at = ?, place = ?, done_at = ?
           WHERE id = ?`,
        ).run(
          patch.title ?? event.title,
          patch.body === undefined ? event.body : patch.body,
          patch.dueAt === undefined ? event.due_at : parseTime(patch.dueAt),
          patch.place === undefined ? event.place : patch.place,
          patch.done === undefined
            ? event.done_at
            : patch.done
              ? (event.done_at ?? Date.now())
              : null,
          patch.id,
        );
        changed([event.job_id]);
        return { ...toEvent(getEvent(patch.id)!), ...change.finish() };
      });
    },

    deleteEvent(id: number) {
      return store.transaction(() => {
        const event = getEvent(id);
        if (!event || event.kind === "status")
          return { deleted: false, undoId: null, undoCount: 0 };
        const change = undo.begin();
        change.capture({ table: "tracker_events", id });
        sql("DELETE FROM tracker_events WHERE id = ?").run(id);
        changed([event.job_id]);
        return { deleted: true, ...change.finish() };
      });
    },

    setTags(
      ids: readonly number[],
      add: readonly string[],
      remove: readonly string[],
    ) {
      return store.transaction(() => {
        const json = JSON.stringify(ids);
        const change = undo.begin();
        for (const job_id of new Set(ids))
          for (const tag of new Set([...add, ...remove]))
            change.capture({ table: "tracker_tags", job_id, tag });
        let changes = 0;
        for (const tag of add)
          changes += Number(
            sql(
              `INSERT OR IGNORE INTO tracker_tags (tag, job_id)
               SELECT ?, job_id FROM tracker WHERE job_id IN (SELECT value FROM json_each(?))`,
            ).run(tag, json).changes,
          );
        for (const tag of remove)
          changes += Number(
            sql(
              "DELETE FROM tracker_tags WHERE tag = ? AND job_id IN (SELECT value FROM json_each(?))",
            ).run(tag, json).changes,
          );
        if (changes > 0) changed([...ids]);
        return { changed: changes, ...change.finish() };
      });
    },

    tags() {
      return {
        tags: sql(
          "SELECT tag, count(*) AS count FROM tracker_tags GROUP BY tag ORDER BY tag",
        ).all() as { tag: string; count: number }[],
      };
    },

    views(): { views: TrackerView[] } {
      return {
        views: (
          sql("SELECT * FROM tracker_views ORDER BY name").all() as {
            id: number;
            name: string;
            filter_json: string;
            sort: TrackerSort;
          }[]
        ).map((row) => ({
          id: row.id,
          name: row.name,
          filter: TrackerFilterSchema.parse(JSON.parse(row.filter_json)),
          sort: row.sort,
        })),
      };
    },

    saveView(name: string, filter: TrackerFilter, sort: TrackerSort) {
      return store.transaction(() => {
        const change = undo.begin();
        const existing = this.views().views.find((view) => view.name === name);
        if (existing)
          change.capture({ table: "tracker_views", id: existing.id });
        sql(`INSERT INTO tracker_views (name, filter_json, sort) VALUES (?, ?, ?)
          ON CONFLICT (name) DO UPDATE SET filter_json = excluded.filter_json, sort = excluded.sort`).run(
          name,
          JSON.stringify(filter),
          sort,
        );
        const view = this.views().views.find((view) => view.name === name)!;
        if (!existing)
          change.capture({ table: "tracker_views", id: view.id }, null);
        const result = { ...view, ...change.finish() };
        changed([]);
        return result;
      });
    },

    deleteView(id: number) {
      return store.transaction(() => {
        const change = undo.begin();
        change.capture({ table: "tracker_views", id });
        const deleted =
          Number(
            sql("DELETE FROM tracker_views WHERE id = ?").run(id).changes,
          ) > 0;
        const result = { deleted, ...change.finish() };
        if (deleted) changed([]);
        return result;
      });
    },
  };
}
