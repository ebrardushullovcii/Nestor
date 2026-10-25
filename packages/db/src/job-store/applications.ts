import {
  ApplicationListQuerySchema,
  ApplicationApplyModeSchema,
  DEFAULT_APPLICATION_APPLY_MODE,
  ApplicationPreparationUpdateSchema,
  ApplicationResumeArtifactSchema,
  ApplicationReviewCardSchema,
  ApplyExecutionResultSchema,
  SubmissionOutcomeRecordSchema,
  ApplyJobsInputSchema,
  type ApplicationListPage,
  type ApplicationListQuery,
  type ApplicationRow,
  type ApplicationApplyMode,
  type ApplicationPreparationUpdate,
  type ApplyJobsInput,
  type ApplyJobsResult,
  type ApplicationResumeArtifact,
  type ApplicationReviewCard,
  type ApplyExecutionResult,
  type SubmissionOutcomeRecord,
} from "@nestor/contracts";
import type { SQLInputValue } from "node:sqlite";

import type { JobStore } from "./job-store";
import { toFilterSql, toIso } from "./job-list";
import { createNeedsYouStore } from "./needs-you";

export interface ApplicationWork {
  attempt: number;
  resumeArtifact: ApplicationResumeArtifact;
  execution: ApplyExecutionResult;
  reviewCard: ApplicationReviewCard | null;
  authorityEnvelopeId: string | null;
}

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

    forJobs(jobIds: readonly number[]): ApplicationRow[] {
      if (jobIds.length > 200) throw new Error("Read applications for one page of jobs at a time.");
      return (sql(`SELECT ${COLUMNS} FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE a.job_id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(jobIds)) as Row[]).map(toRow);
    },

    getSubmissionReceipt(id: number): SubmissionOutcomeRecord | null {
      const row = sql("SELECT submission_outcome_json FROM applications WHERE id = ?").get(id) as { submission_outcome_json: string | null } | undefined;
      return row?.submission_outcome_json ? SubmissionOutcomeRecordSchema.parse(JSON.parse(row.submission_outcome_json)) : null;
    },

    recordOrigin(id: number, origin: string): void {
      origin = new URL(origin).origin;
      if (!/^https?:/u.test(origin)) throw new Error("An application site must use HTTP or HTTPS.");
      sql("INSERT OR IGNORE INTO application_origins (application_id, origin) VALUES (?, ?)").run(id, origin);
    },

    originsForApplications(ids: readonly number[]): string[] {
      return (sql("SELECT DISTINCT origin FROM application_origins WHERE application_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as Array<{ origin: string }>).map(row => row.origin);
    },

    /** Details for one application, never part of a list or workspace snapshot. */
    getWork(id: number): ApplicationWork | null {
      const row = sql("SELECT * FROM application_details WHERE application_id = ?").get(id) as {
        attempt: number; resume_artifact_json: string; execution_json: string | null;
        review_json: string | null; authority_envelope_id: string | null;
      } | undefined;
      return row?.execution_json ? {
        attempt: row.attempt,
        resumeArtifact: ApplicationResumeArtifactSchema.parse(JSON.parse(row.resume_artifact_json)),
        execution: ApplyExecutionResultSchema.parse(JSON.parse(row.execution_json)),
        reviewCard: row.review_json ? ApplicationReviewCardSchema.parse(JSON.parse(row.review_json)) : null,
        authorityEnvelopeId: row.authority_envelope_id,
      } : null;
    },

    getResumeArtifact(id: number): ApplicationResumeArtifact | null {
      const row = sql("SELECT resume_artifact_json FROM application_details WHERE application_id = ?").get(id) as { resume_artifact_json: string } | undefined;
      return row ? ApplicationResumeArtifactSchema.parse(JSON.parse(row.resume_artifact_json)) : null;
    },

    setResumeArtifact(id: number, attempt: number, artifact: ApplicationResumeArtifact): boolean {
      artifact = ApplicationResumeArtifactSchema.parse(artifact);
      return store.transaction(() => {
        const row = getApplication(id);
        if (!row || row.attempt !== attempt || row.state !== "running") return false;
        if (artifact.jobId !== String(row.jobId)) throw new Error("The application resume belongs to another job.");
        sql(`INSERT INTO application_details (application_id, attempt, resume_artifact_json)
          VALUES (?, ?, ?) ON CONFLICT(application_id) DO UPDATE SET attempt = excluded.attempt,
          resume_artifact_json = excluded.resume_artifact_json, execution_json = NULL,
          review_json = NULL, authority_envelope_id = NULL`).run(id, attempt, JSON.stringify(artifact));
        return true;
      });
    },

    saveWork(id: number, work: ApplicationWork): boolean {
      const resumeArtifact = ApplicationResumeArtifactSchema.parse(work.resumeArtifact);
      const execution = ApplyExecutionResultSchema.parse(work.execution);
      const review = ApplicationReviewCardSchema.nullable().parse(work.reviewCard);
      return store.transaction(() => {
        const current = getApplication(id);
        if (!current || current.attempt !== work.attempt || current.state !== "running") return false;
        if (resumeArtifact.jobId !== String(current.jobId)) throw new Error("The application resume belongs to another job.");
        sql(`INSERT INTO application_details
          (application_id, attempt, resume_artifact_json, execution_json, review_json, authority_envelope_id)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(application_id) DO UPDATE SET
          attempt = excluded.attempt, resume_artifact_json = excluded.resume_artifact_json,
          execution_json = excluded.execution_json, review_json = excluded.review_json,
          authority_envelope_id = excluded.authority_envelope_id`).run(
            id, work.attempt, JSON.stringify(resumeArtifact), JSON.stringify(execution),
            review ? JSON.stringify(review) : null, work.authorityEnvelopeId,
          );
        changed([current.jobId]);
        return true;
      });
    },

    /** A question answered from memory needs another preparation, without a task. */
    continuePreparation(id: number, attempt: number): boolean {
      return store.transaction(() => {
        const row = sql(`UPDATE applications SET state = 'queued', queued_at = ?, updated_at = ?
          WHERE id = ? AND attempt = ? AND state = 'running' RETURNING job_id`).get(Date.now(), Date.now(), id, attempt) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
        return !!row;
      });
    },

    /** The state is written before the existing guarded send can be armed. */
    beginSubmission(id: number, attempt: number): boolean {
      return store.transaction(() => {
        const row = sql(`UPDATE applications SET state = 'submitting', updated_at = ?
          WHERE id = ? AND attempt = ? AND state IN ('running', 'ready') RETURNING job_id`).get(Date.now(), id, attempt) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
        return !!row;
      });
    },

    /** A refusal before a send was issued can return the filled form for review. */
    submissionRefused(id: number, attempt: number, reason: string): void {
      store.transaction(() => {
        const row = sql(`UPDATE applications SET state = 'ready', error = ?, updated_at = ?
          WHERE id = ? AND attempt = ? AND state = 'submitting' RETURNING job_id`).get(reason.slice(0, 2000), Date.now(), id, attempt) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
      });
    },

    submissionUnknown(id: number, attempt: number): void {
      store.transaction(() => {
        const row = sql(`UPDATE applications SET state = 'uncertain', error = ?, updated_at = ?
          WHERE id = ? AND attempt = ? AND state = 'submitting' RETURNING job_id`).get(
            "The app closed while this application was being sent. Check the site before taking another submission action.",
            Date.now(), id, attempt,
          ) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
      });
    },

    /** Only a validated employer receipt can move a job out of Approved. */
    recordSubmission(id: number, attempt: number, receipt: SubmissionOutcomeRecord): boolean {
      receipt = SubmissionOutcomeRecordSchema.parse(receipt);
      return store.transaction(() => {
        const current = getApplication(id);
        if (!current || current.attempt !== attempt || current.state === "submitted" || current.state === "uncertain") return false;
        if (receipt.jobId !== String(current.jobId) || receipt.applicationRecordId !== `application_${id}`) throw new Error("The submission receipt belongs to another application.");
        const state = receipt.outcome === "submitted" ? "submitted" : receipt.outcome === "outcome_uncertain" ? "uncertain" : "ready";
        sql(`UPDATE applications SET state = ?, submitted_at = ?, updated_at = ?,
          submission_outcome_id = ?, submission_outcome_json = ?, error = NULL WHERE id = ?`).run(
            state, receipt.outcome === "submitted" ? Date.parse(receipt.verifiedAt!) : null,
            Date.now(), receipt.id, JSON.stringify(receipt), id,
          );
        if (state === "submitted") store.setStage([current.jobId], "applied");
        changed([current.jobId]);
        return true;
      });
    },

    /** A crash in preparation is retryable; an interrupted send requires proof. */
    recoverPreparation(): void {
      store.transaction(() => {
        const result = sql("UPDATE applications SET state = 'queued', updated_at = ? WHERE state = 'running'").run(Date.now());
        if (result.changes) changed();
      });
    },

    listWorkInState(state: ApplicationRow["state"], limit = 16): ApplicationRow[] {
      return (sql(`SELECT ${COLUMNS} FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE a.state = ? ORDER BY a.updated_at, a.id LIMIT ?`).all(state, limit) as Row[]).map(toRow);
    },

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
