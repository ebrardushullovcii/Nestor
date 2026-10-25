import {
  ApplicationListQuerySchema,
  ApplicationApplyModeSchema,
  DEFAULT_APPLICATION_APPLY_MODE,
  ApplicationPreparationUpdateSchema,
  ApplyJobsInputSchema,
  type ApplicationListPage,
  type ApplicationListQuery,
  type ApplicationRow,
  type ApplicationApplyMode,
  type ApplicationPreparationUpdate,
  type ApplyJobsInput,
  type ApplyJobsResult,
} from "@nestor/contracts";
import type { SQLInputValue } from "node:sqlite";

import type { JobStore } from "./job-store";
import { toFilterSql, toIso } from "./job-list";
import { createNeedsYouStore } from "./needs-you";

type Row = {
  id: number;
  job_id: number;
  mode: ApplicationApplyMode;
  title: string;
  company: string;
  location: string;
  state: ApplicationRow["state"];
  attempt: number;
  queued_at: number;
  updated_at: number;
  submitted_at: number | null;
  error: string | null;
};

const COLUMNS = `a.id, a.job_id, a.mode, j.title, j.company, j.location, a.state,
  a.attempt, a.queued_at, a.updated_at, a.submitted_at, a.error`;

function toRow(row: Row): ApplicationRow {
  return {
    id: row.id,
    jobId: row.job_id,
    mode: row.mode,
    title: row.title,
    company: row.company,
    location: row.location,
    state: row.state,
    attempt: row.attempt,
    queuedAt: toIso(row.queued_at),
    updatedAt: toIso(row.updated_at),
    submittedAt: row.submitted_at === null ? null : toIso(row.submitted_at),
    error: row.error,
  };
}

/** These commands write only the selected rows, inside the shared transaction. */
export function createApplicationStore(store: JobStore) {
  const { sql } = store;
  const changed = (ids: number[] | null = null) =>
    store.notify({
      cause: "application",
      stages: ["resume", "applied"],
      ids,
      searchId: null,
    });

  const getApplication = (id: number): ApplicationRow | null => {
    const row = sql(
      `SELECT ${COLUMNS} FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    ).get(id) as Row | undefined;
    return row ? toRow(row) : null;
  };

  return {
    /** Queues approved jobs; the browser runner consumes these rows separately. */
    applyJobs(
      input: ApplyJobsInput,
      requestedMode: ApplicationApplyMode = DEFAULT_APPLICATION_APPLY_MODE,
    ): ApplyJobsResult {
      const mode = ApplicationApplyModeSchema.parse(requestedMode);
      const { selection } = ApplyJobsInputSchema.parse(input);
      if (!("ids" in selection) && selection.filter.stage !== "resume") {
        throw new Error("Apply requires the Approved filter.");
      }
      const selected = "ids" in selection ? [...new Set(selection.ids)] : null;
      const filter =
        "ids" in selection
          ? {
              where:
                "j.stage = 'resume' AND j.id IN (SELECT value FROM json_each(?))",
              params: [JSON.stringify(selected)],
            }
          : toFilterSql(selection.filter);
      const where =
        "ids" in selection
          ? filter.where
          : `${filter.where} AND j.id NOT IN (SELECT value FROM json_each(?))`;
      const params: SQLInputValue[] = [
        ...filter.params,
        ...("ids" in selection ? [] : [JSON.stringify(selection.except)]),
      ];
      return store.transaction(() => {
        const { n: approved } = sql(
          `SELECT count(*) AS n FROM jobs j WHERE ${where}`,
        ).get(...params) as { n: number };
        const now = Date.now();
        const result = sql(
          `INSERT INTO applications (job_id, mode, state, queued_at, updated_at)
           SELECT j.id, ?, 'queued', ?, ? FROM jobs j WHERE ${where}
           ON CONFLICT(job_id) DO UPDATE SET
             mode = excluded.mode, state = 'queued', queued_at = excluded.queued_at,
             updated_at = excluded.updated_at, error = NULL
           WHERE applications.state IN ('stopped', 'failed')
             AND applications.submitted_at IS NULL`,
        ).run(mode, now, now, ...params);
        const queued = Number(result.changes);
        if (queued > 0)
          changed(selected && selected.length <= 200 ? selected : null);
        return {
          queued,
          unchanged: approved - queued,
          notApproved: selected ? selected.length - approved : 0,
        };
      });
    },

    getApplication,

    listApplications(input: ApplicationListQuery = {}): ApplicationListPage {
      const query = ApplicationListQuerySchema.parse(input);
      const clauses: string[] = [];
      const params: SQLInputValue[] = [];
      if (query.state !== null) {
        clauses.push("a.state = ?");
        params.push(query.state);
      }
      if (query.cursor !== null) {
        let cursor: unknown;
        try {
          cursor = JSON.parse(
            Buffer.from(query.cursor, "base64url").toString(),
          );
        } catch {
          throw new Error("Invalid applications page position.");
        }
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 3 ||
          !Number.isSafeInteger(cursor[0]) ||
          !Number.isSafeInteger(cursor[1]) ||
          cursor[1] <= 0 ||
          cursor[2] !== query.state
        )
          throw new Error("Invalid applications page position.");
        clauses.push("(a.updated_at, a.id) < (?, ?)");
        params.push(cursor[0] as number, cursor[1] as number);
      }
      const records = sql(
        `SELECT ${COLUMNS} FROM applications a JOIN jobs j ON j.id = a.job_id
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY a.updated_at DESC, a.id DESC LIMIT ?`,
      ).all(...params, query.limit + 1) as Row[];
      const page = records.slice(0, query.limit);
      const last = page.at(-1);
      return {
        rows: page.map(toRow),
        nextCursor:
          records.length > query.limit && last
            ? Buffer.from(
                JSON.stringify([last.updated_at, last.id, query.state]),
              ).toString("base64url")
            : null,
      };
    },

    /** Claims one queued row. The attempt prevents an old callback overwriting a retry. */
    claimNext(): ApplicationRow | null {
      return store.transaction(() => {
        const row = sql(
          `UPDATE applications SET state = 'running', attempt = attempt + 1, updated_at = ?
           WHERE id = (
             SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id
             WHERE a.state = 'queued' AND j.stage = 'resume'
             ORDER BY a.queued_at, a.id LIMIT 1
           ) RETURNING id, job_id`,
        ).get(Date.now()) as { id: number; job_id: number } | undefined;
        if (!row) return null;
        changed([row.job_id]);
        return getApplication(row.id);
      });
    },

    /** Preparation only. This API cannot mark an application sent or arm a send. */
    finishPreparation(input: ApplicationPreparationUpdate): boolean {
      input = ApplicationPreparationUpdateSchema.parse(input);
      return store.transaction(() => {
        const row = sql(
          `UPDATE applications SET state = ?, error = ?, updated_at = ?
           WHERE id = ? AND attempt = ? AND state = 'running' RETURNING job_id`,
        ).get(
          input.state,
          input.error ?? null,
          Date.now(),
          input.id,
          input.attempt,
        ) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
        return !!row;
      });
    },

    stop(id: number): boolean {
      return store.transaction(() => {
        const row = sql(
          `UPDATE applications SET state = 'stopped', updated_at = ?
           WHERE id = ? AND state IN ('queued', 'running', 'needs_you', 'ready')
           RETURNING job_id`,
        ).get(Date.now(), id) as { job_id: number } | undefined;
        if (row) {
          changed([row.job_id]);
        }
        return !!row;
      });
    },

    needsYou: createNeedsYouStore(store, changed),
  };
}

export type ApplicationStore = ReturnType<typeof createApplicationStore>;
