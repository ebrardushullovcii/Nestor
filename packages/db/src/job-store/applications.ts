import {
  UpsertSavedFormAnswerInputSchema,
  ApplicationListQuerySchema,
  ApplicationApplyModeSchema,
  DEFAULT_APPLICATION_APPLY_MODE,
  ApplicationPreparationUpdateSchema,
  ApplicationResumeArtifactSchema,
  ApplicationReviewCardSchema,
  ApplyExecutionResultSchema,
  SubmissionOutcomeRecordSchema,
  ApplyJobsInputSchema,
  JobSelectionSchema,
  type JobSelectionInput,
  type CandidateAnswerKind,
  type CandidateReusableAnswer,
  type UpsertSavedFormAnswerInput,
  type SavedFormAnswersQuery,
  type SavedFormAnswerKey,
  type ApplicationListPage,
  type ApplicationListQuery,
  type ApplicationRow,
  type ApplicationApplyMode,
  type ApplicationAutomationMode,
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
import { createProfileStore } from "./profile-store";
import { toFilterSql, toIso } from "./job-list";
import { createNeedsYouStore } from "./needs-you";

export interface ApplicationWork {
  attempt: number;
  resumeArtifact: ApplicationResumeArtifact;
  execution: ApplyExecutionResult;
  reviewCard: ApplicationReviewCard | null;
  authorityEnvelopeId: string | null;
  accessRecheck: boolean;
  profileDigest: string;
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
/**
 * Job `j` has an approved resume. Apply works only on these, whatever the
 * job's stage says; for Original that is the approved row with no tailored
 * PDF (the imported file).
 */
export const HAS_APPROVED_RESUME = `EXISTS (
  SELECT 1 FROM resumes r WHERE r.job_id = j.id AND r.approved_at IS NOT NULL)`;

/** An outcome names this row's own job, application, run and attempt. */
function isOwnSendLineage(
  row: Pick<ApplicationRow, "id" | "jobId" | "attempt">,
  outcome: Pick<
    SubmissionOutcomeRecord,
    "jobId" | "applicationRecordId" | "runId" | "resultId"
  >,
): boolean {
  return (
    outcome.jobId === String(row.jobId) &&
    outcome.applicationRecordId === `application_${row.id}` &&
    outcome.runId === `application_run_${row.id}` &&
    outcome.resultId === `application_${row.id}_attempt_${row.attempt}`
  );
}

export function createApplicationStore(store: JobStore) {
  // Retired approvals must be revoked before any Apply reader can queue them,
  // including callers that have not opened Profile or the workspace yet.
  createProfileStore(store);
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
    /** Resolves a chat instruction once, so later arrivals cannot widen it. */
    selectedJobIds(input: JobSelectionInput): number[] {
      const selection = JobSelectionSchema.parse(input);
      if ("ids" in selection) return [...new Set(selection.ids)];
      if (selection.filter.stage !== "resume")
        throw new Error("Apply requires the Approved filter.");
      const filter = toFilterSql(selection.filter);
      return (
        sql(`SELECT j.id FROM jobs j WHERE ${filter.where} AND ${HAS_APPROVED_RESUME}
        AND j.id NOT IN (SELECT value FROM json_each(?)) ORDER BY j.id`).all(
          ...filter.params,
          JSON.stringify(selection.except),
        ) as { id: number }[]
      ).map((row) => row.id);
    },
    /** Queues approved jobs; the browser runner consumes these rows separately. */
    applyJobs(
      input: ApplyJobsInput,
      requestedMode: ApplicationApplyMode = DEFAULT_APPLICATION_APPLY_MODE,
      instruction?: { conversationId: string; mode: ApplicationAutomationMode },
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
      // A job in Approved without an approval is reported as not approved.
      const approvedWhere = `${where} AND ${HAS_APPROVED_RESUME}`;
      return store.transaction(() => {
        const count = (condition: string) =>
          (
            sql(`SELECT count(*) AS n FROM jobs j WHERE ${condition}`).get(
              ...params,
            ) as { n: number }
          ).n;
        const approved = count(approvedWhere);
        const now = Date.now();
        const result = sql(
          `INSERT INTO applications (job_id, mode, state, queued_at, updated_at)
           SELECT j.id, ?, 'queued', ?, ? FROM jobs j WHERE ${approvedWhere}
           ON CONFLICT(job_id) DO UPDATE SET
             mode = excluded.mode, state = 'queued', queued_at = excluded.queued_at,
             updated_at = excluded.updated_at, error = NULL
           WHERE applications.state IN ('stopped', 'failed')
             AND applications.submitted_at IS NULL RETURNING id`,
        ).all(mode, now, now, ...params) as { id: number }[];
        for (const { id } of result) {
          if (instruction)
            sql(`INSERT INTO application_instructions (application_id, conversation_id, mode)
            VALUES (?, ?, ?) ON CONFLICT(application_id) DO UPDATE SET conversation_id = excluded.conversation_id, mode = excluded.mode`).run(
              id,
              instruction.conversationId,
              instruction.mode,
            );
          else
            sql(
              "DELETE FROM application_instructions WHERE application_id = ?",
            ).run(id);
        }
        const queued = result.length;
        if (queued > 0)
          changed(selected && selected.length <= 200 ? selected : null);
        return {
          queued,
          unchanged: approved - queued,
          notApproved: (selected ? selected.length : count(where)) - approved,
        };
      });
    },

    getApplication,

    instructionFor(
      id: number,
    ): { conversationId: string; mode: ApplicationAutomationMode } | null {
      const row = sql(
        "SELECT conversation_id, mode FROM application_instructions WHERE application_id = ?",
      ).get(id) as
        | { conversation_id: string; mode: ApplicationAutomationMode }
        | undefined;
      return row
        ? { conversationId: row.conversation_id, mode: row.mode }
        : null;
    },

    forJobs(jobIds: readonly number[]): ApplicationRow[] {
      if (jobIds.length > 200)
        throw new Error("Read applications for one page of jobs at a time.");
      return (
        sql(`SELECT ${COLUMNS} FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE a.job_id IN (SELECT value FROM json_each(?))`).all(
          JSON.stringify(jobIds),
        ) as Row[]
      ).map(toRow);
    },

    getSubmissionReceipt(id: number): SubmissionOutcomeRecord | null {
      const row = sql(
        "SELECT submission_outcome_json FROM applications WHERE id = ?",
      ).get(id) as { submission_outcome_json: string | null } | undefined;
      return row?.submission_outcome_json
        ? SubmissionOutcomeRecordSchema.parse(
            JSON.parse(row.submission_outcome_json),
          )
        : null;
    },

    recordOrigin(id: number, origin: string): void {
      origin = new URL(origin).origin;
      if (!/^https?:/u.test(origin))
        throw new Error("An application site must use HTTP or HTTPS.");
      sql(
        "INSERT OR IGNORE INTO application_origins (application_id, origin) VALUES (?, ?)",
      ).run(id, origin);
    },

    originsForApplications(ids: readonly number[]): string[] {
      return (
        sql(
          "SELECT DISTINCT origin FROM application_origins WHERE application_id IN (SELECT value FROM json_each(?))",
        ).all(JSON.stringify(ids)) as Array<{ origin: string }>
      ).map((row) => row.origin);
    },

    /**
     * Whether an application not yet sent keeps its prepared form at this
     * exact address. Durable, so it still holds after a restart, when the
     * browser no longer knows which tabs it filled.
     */
    holdsFormAt(url: string): boolean {
      return Boolean(
        sql(
          `SELECT 1 FROM applications a JOIN application_details d ON d.application_id = a.id
           WHERE a.state NOT IN ('submitted', 'uncertain')
             AND json_extract(d.review_json, '$.pageUrl') = ? LIMIT 1`,
        ).get(url),
      );
    },

    /** Details for one application, never part of a list or workspace snapshot. */
    getWork(id: number): ApplicationWork | null {
      const row = sql(
        "SELECT * FROM application_details WHERE application_id = ?",
      ).get(id) as
        | {
            attempt: number;
            resume_artifact_json: string;
            execution_json: string | null;
            review_json: string | null;
            authority_envelope_id: string | null;
            access_recheck: number;
            profile_digest: string;
          }
        | undefined;
      return row?.execution_json
        ? {
            attempt: row.attempt,
            resumeArtifact: ApplicationResumeArtifactSchema.parse(
              JSON.parse(row.resume_artifact_json),
            ),
            execution: ApplyExecutionResultSchema.parse(
              JSON.parse(row.execution_json),
            ),
            reviewCard: row.review_json
              ? ApplicationReviewCardSchema.parse(JSON.parse(row.review_json))
              : null,
            authorityEnvelopeId: row.authority_envelope_id,
            accessRecheck: row.access_recheck > 0,
            profileDigest: row.profile_digest,
          }
        : null;
    },

    getResumeArtifact(id: number): ApplicationResumeArtifact | null {
      const row = sql(
        "SELECT resume_artifact_json FROM application_details WHERE application_id = ?",
      ).get(id) as { resume_artifact_json: string } | undefined;
      return row
        ? ApplicationResumeArtifactSchema.parse(
            JSON.parse(row.resume_artifact_json),
          )
        : null;
    },

    setResumeArtifact(
      id: number,
      attempt: number,
      artifact: ApplicationResumeArtifact,
      profileDigest: string,
    ): boolean {
      artifact = ApplicationResumeArtifactSchema.parse(artifact);
      return store.transaction(() => {
        const row = getApplication(id);
        if (!row || row.attempt !== attempt || row.state !== "running")
          return false;
        if (artifact.jobId !== String(row.jobId))
          throw new Error("The application resume belongs to another job.");
        sql(`INSERT INTO application_details (application_id, attempt, resume_artifact_json, profile_digest)
          VALUES (?, ?, ?, ?) ON CONFLICT(application_id) DO UPDATE SET attempt = excluded.attempt,
          resume_artifact_json = excluded.resume_artifact_json, execution_json = NULL,
          review_json = NULL, authority_envelope_id = NULL, profile_digest = excluded.profile_digest`).run(
          id,
          attempt,
          JSON.stringify(artifact),
          profileDigest,
        );
        return true;
      });
    },

    /** Admit one access retry only after the watcher excludes a person-held page. */
    recheckAccess(id: number, attempt: number): boolean {
      return store.transaction(() => {
        const result =
          sql(`UPDATE application_details SET access_recheck=2 WHERE application_id=? AND attempt=? AND access_recheck=1
          AND EXISTS (SELECT 1 FROM applications a WHERE a.id=application_id AND a.attempt=application_details.attempt AND a.state='needs_you')`).run(
            id,
            attempt,
          );
        if (result.changes) changed([getApplication(id)!.jobId]);
        return !!result.changes;
      });
    },

    saveWork(
      id: number,
      work: Omit<ApplicationWork, "accessRecheck">,
    ): boolean {
      const resumeArtifact = ApplicationResumeArtifactSchema.parse(
        work.resumeArtifact,
      );
      const execution = ApplyExecutionResultSchema.parse(work.execution);
      const review = ApplicationReviewCardSchema.nullable().parse(
        work.reviewCard,
      );
      return store.transaction(() => {
        const current = getApplication(id);
        if (
          !current ||
          current.attempt !== work.attempt ||
          current.state !== "running"
        )
          return false;
        if (resumeArtifact.jobId !== String(current.jobId))
          throw new Error("The application resume belongs to another job.");
        sql(`INSERT INTO application_details
          (application_id, attempt, resume_artifact_json, execution_json, review_json, authority_envelope_id, profile_digest)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(application_id) DO UPDATE SET
          attempt = excluded.attempt, resume_artifact_json = excluded.resume_artifact_json,
          execution_json = excluded.execution_json, review_json = excluded.review_json,
          authority_envelope_id = excluded.authority_envelope_id, profile_digest = excluded.profile_digest, access_recheck = 0`).run(
          id,
          work.attempt,
          JSON.stringify(resumeArtifact),
          JSON.stringify(execution),
          review ? JSON.stringify(review) : null,
          work.authorityEnvelopeId,
          work.profileDigest,
        );
        changed([current.jobId]);
        return true;
      });
    },

    /** A refused answer must no longer appear as a filled answer in the review. */
    discardReviewAnswers(
      id: number,
      attempt: number,
      questions: readonly string[],
      refusedLetterText?: string,
    ): boolean {
      return store.transaction(() => {
        const current = getApplication(id);
        if (
          !current ||
          current.attempt !== attempt ||
          !["running", "ready", "needs_you"].includes(current.state)
        )
          return false;
        const row = sql(
          "SELECT review_json FROM application_details WHERE application_id=? AND attempt=?",
        ).get(id, attempt) as { review_json: string | null } | undefined;
        if (!row?.review_json) return false;
        const card = ApplicationReviewCardSchema.parse(
          JSON.parse(row.review_json),
        );
        const refused = new Set(questions);
        const answers = card.answers.filter(
          (answer) => !refused.has(answer.question),
        );
        const refusedLetter =
          card.letter &&
          ((card.letter.text === refusedLetterText &&
            ((card.letter.fields ?? []).some((field) => refused.has(field)) ||
              (refused.has("Cover letter") && !card.letter.fields?.length))) ||
            card.answers.some(
              (answer) =>
                refused.has(answer.question) &&
                answer.answer === card.letter!.text,
            ));
        const review = ApplicationReviewCardSchema.parse({
          ...card,
          answers,
          ...(refusedLetter ? { letter: null } : {}),
        });
        sql(
          "UPDATE application_details SET review_json=? WHERE application_id=? AND attempt=?",
        ).run(JSON.stringify(review), id, attempt);
        changed([current.jobId]);
        return true;
      });
    },

    /** A question answered from memory needs another preparation, without a task. */
    continuePreparation(id: number, attempt: number): boolean {
      return store.transaction(() => {
        const row =
          sql(`UPDATE applications SET state = 'queued', queued_at = ?, updated_at = ?
          WHERE id = ? AND attempt = ? AND state = 'running' RETURNING job_id`).get(
            Date.now(),
            Date.now(),
            id,
            attempt,
          ) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
        return !!row;
      });
    },

    /** Open lost its page: refill for review, never revive permission to send. */
    reprepareForReview(
      id: number,
      attempt: number,
      reason = "Restoring the form for your review.",
    ): boolean {
      return store.transaction(() => {
        const row =
          sql(`UPDATE applications SET state='queued', mode='confirm_before_submit',
          queued_at=?, updated_at=?, error=?
          WHERE id=? AND attempt=? AND state='ready' AND submitted_at IS NULL RETURNING job_id`).get(
            Date.now(),
            Date.now(),
            reason.slice(0, 2000),
            id,
            attempt,
          ) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
        return !!row;
      });
    },

    /** The state is written before the existing guarded send can be armed. */
    beginSubmission(id: number, attempt: number): boolean {
      return store.transaction(() => {
        const row =
          sql(`UPDATE applications SET state = 'submitting', updated_at = ?
          WHERE id = ? AND attempt = ? AND state IN ('running', 'ready') RETURNING job_id`).get(
            Date.now(),
            id,
            attempt,
          ) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
        return !!row;
      });
    },

    /** A refusal before a send was issued can return the filled form for review. */
    submissionRefused(id: number, attempt: number, reason: string): void {
      store.transaction(() => {
        const row =
          sql(`UPDATE applications SET state = 'ready', error = ?, updated_at = ?
          WHERE id = ? AND attempt = ? AND state IN ('ready', 'submitting') RETURNING job_id`).get(
            reason.slice(0, 2000),
            Date.now(),
            id,
            attempt,
          ) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
      });
    },

    submissionUnknown(id: number, attempt: number): void {
      store.transaction(() => {
        const row =
          sql(`UPDATE applications SET state = 'uncertain', error = ?, updated_at = ?
          WHERE id = ? AND attempt = ? AND state = 'submitting' RETURNING job_id`).get(
            "The app closed while this application was being sent. Check the site before taking another submission action.",
            Date.now(),
            id,
            attempt,
          ) as { job_id: number } | undefined;
        if (row) changed([row.job_id]);
      });
    },

    /** Only a validated employer receipt can move a job out of Approved. */
    recordSubmission(
      id: number,
      attempt: number,
      receipt: SubmissionOutcomeRecord,
    ): boolean {
      receipt = SubmissionOutcomeRecordSchema.parse(receipt);
      return store.transaction(() => {
        const current = getApplication(id);
        if (
          !current ||
          current.attempt !== attempt ||
          !["ready", "needs_you", "submitting"].includes(current.state)
        )
          return false;
        if (
          receipt.jobId !== String(current.jobId) ||
          receipt.applicationRecordId !== `application_${id}` ||
          receipt.runId !== `application_run_${id}` ||
          receipt.resultId !== `application_${id}_attempt_${attempt}`
        )
          throw new Error(
            "The submission receipt belongs to another application attempt.",
          );
        const state =
          receipt.outcome === "submitted"
            ? "submitted"
            : receipt.outcome === "outcome_uncertain"
              ? "uncertain"
              : "ready";
        sql(`UPDATE applications SET state = ?, submitted_at = ?, updated_at = ?,
          submission_outcome_id = ?, submission_outcome_json = ?, error = NULL WHERE id = ?`).run(
          state,
          receipt.outcome === "submitted"
            ? Date.parse(receipt.verifiedAt!)
            : null,
          Date.now(),
          receipt.id,
          JSON.stringify(receipt),
          id,
        );
        if (state === "submitted") store.setStage([current.jobId], "applied");
        changed([current.jobId]);
        return true;
      });
    },

    /**
     * Whether this outcome is the person's word on this row's uncertain
     * send: same job, application, run and attempt. Checked before anything
     * else records the resolution, so a mismatch changes nothing.
     */
    canResolveUncertainSend(
      id: number,
      outcome: Pick<
        SubmissionOutcomeRecord,
        "jobId" | "applicationRecordId" | "runId" | "resultId"
      >,
    ): boolean {
      const current = getApplication(id);
      return (
        !!current &&
        current.state === "uncertain" &&
        isOwnSendLineage(current, outcome)
      );
    },

    /**
     * The person checked the site after a send whose outcome was uncertain.
     * Only their word moves the row: sent becomes Applied, not sent stops
     * here so nothing sends it again by itself.
     */
    resolveUncertainSend(
      id: number,
      outcome: SubmissionOutcomeRecord,
    ): boolean {
      outcome = SubmissionOutcomeRecordSchema.parse(outcome);
      return store.transaction(() => {
        const current = getApplication(id);
        if (!current || current.state !== "uncertain") return false;
        if (!isOwnSendLineage(current, outcome))
          throw new Error(
            "The outcome belongs to another application attempt.",
          );
        const sent = outcome.outcome === "submitted";
        sql(`UPDATE applications SET state = ?, submitted_at = ?, updated_at = ?,
          submission_outcome_id = ?, submission_outcome_json = ?, error = ? WHERE id = ?`).run(
          sent ? "submitted" : "stopped",
          sent && outcome.verifiedAt ? Date.parse(outcome.verifiedAt) : null,
          Date.now(),
          outcome.id,
          JSON.stringify(outcome),
          sent ? null : "You checked the site: this application was not sent.",
          id,
        );
        if (sent) store.setStage([current.jobId], "applied");
        changed([current.jobId]);
        return true;
      });
    },

    /** A crash in preparation is retryable; an interrupted send requires proof. */
    recoverPreparation(): void {
      store.transaction(() => {
        const result = sql(
          "UPDATE applications SET state = 'queued', updated_at = ? WHERE state = 'running'",
        ).run(Date.now());
        if (result.changes) changed();
      });
    },

    listWorkInState(
      state: ApplicationRow["state"],
      limit = 16,
    ): ApplicationRow[] {
      return (
        sql(`SELECT ${COLUMNS} FROM applications a JOIN jobs j ON j.id = a.job_id
        WHERE a.state = ? ORDER BY a.updated_at, a.id LIMIT ?`).all(
          state,
          limit,
        ) as Row[]
      ).map(toRow);
    },

    /** How many applications sit in each state; for diagnostics. */
    stateCounts(): Partial<Record<ApplicationRow["state"], number>> {
      return Object.fromEntries(
        (
          sql(
            "SELECT state, COUNT(*) AS n FROM applications GROUP BY state",
          ).all() as { state: ApplicationRow["state"]; n: number }[]
        ).map((row) => [row.state, row.n]),
      );
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
             WHERE (a.state = 'queued' OR (a.state='needs_you' AND a.id IN (SELECT application_id FROM application_details WHERE access_recheck=2))) AND j.stage = 'resume'
               AND ${HAS_APPROVED_RESUME}
             ORDER BY a.queued_at, a.id LIMIT 1
           ) RETURNING id, job_id`,
        ).get(Date.now()) as { id: number; job_id: number } | undefined;
        if (!row) return null;
        const application = getApplication(row.id)!;
        sql(`UPDATE application_needs_you SET attempt=? WHERE application_id=? AND attempt=?
          AND task_id IN (SELECT id FROM needs_you WHERE kind<>'question' AND resolved_at IS NULL)`).run(
          application.attempt,
          row.id,
          application.attempt - 1,
        );
        changed([row.job_id]);
        return application;
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

/** The single reusable-answer bank, also used by Needs you. Writes release matching questions. */
export function createSavedAnswersStore(store: JobStore) {
  const memory = createNeedsYouStore(store, () =>
    store.notify({
      cause: "application",
      stages: ["resume", "applied"],
      ids: null,
      searchId: null,
    }),
  );
  return {
    list: (input: SavedFormAnswersQuery = {}) => memory.listAnswers(input),
    get: (input: SavedFormAnswerKey) => memory.getAnswerByKey(input),
    upsert(input: UpsertSavedFormAnswerInput) {
      return memory.remember(UpsertSavedFormAnswerInputSchema.parse(input));
    },
  };
}
export type SavedAnswersStore = ReturnType<typeof createSavedAnswersStore>;

/** Trusted authority projection, never sent to a list screen or the model. */
export function readSavedApplicationAnswers(
  store: JobStore,
  kinds?: readonly CandidateAnswerKind[],
): CandidateReusableAnswer[] {
  const rows = store
    .sql(
      `SELECT id,kind,label,prompt,answer,role_families_json,proof_entry_ids_json
    FROM form_answers WHERE needs_confirmation=0 ${kinds ? "AND kind IN (SELECT value FROM json_each(?))" : ""} ORDER BY id`,
    )
    .all(...(kinds ? [JSON.stringify(kinds)] : [])) as Array<{
    id: number;
    kind: CandidateAnswerKind;
    label: string;
    prompt: string;
    answer: string;
    role_families_json: string;
    proof_entry_ids_json: string;
  }>;
  return rows.map((row) => ({
    id: `form_answer_${row.id}`,
    kind: row.kind,
    label: row.label || row.prompt,
    question: row.prompt,
    answer: row.answer,
    roleFamilies: JSON.parse(row.role_families_json) as string[],
    proofEntryIds: JSON.parse(row.proof_entry_ids_json) as string[],
  }));
}
