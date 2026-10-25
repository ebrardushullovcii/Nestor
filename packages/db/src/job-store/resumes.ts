import {
  ResumeDraftSchema,
  type JobListingFacts,
  type JobStage,
  type ResumeDraft,
  type ResumeLevel,
  type ResumeState,
  type ResumeStatus,
  type StoredResume,
} from "@nestor/contracts";

import type { JobStore } from "./job-store";

type ResumeRow = {
  job_id: number;
  level: ResumeLevel;
  state: ResumeState;
  updated_at: number;
  error: string | null;
  draft_json: string | null;
  previous_json: string | null;
  approved_at: number | null;
  pdf_path: string | null;
};

type PreviousResume = {
  level: ResumeLevel;
  draft: ResumeDraft | null;
  approvedAt: number | null;
  pdfPath: string | null;
};

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

function toStoredResume(row: ResumeRow): StoredResume {
  const previous = row.previous_json
    ? (JSON.parse(row.previous_json) as PreviousResume)
    : null;
  return {
    jobId: row.job_id,
    level: row.level,
    state: row.state,
    approvedAt: iso(row.approved_at),
    error: row.error,
    draft: row.draft_json
      ? ResumeDraftSchema.parse(JSON.parse(row.draft_json))
      : null,
    updatedAt: new Date(row.updated_at).toISOString(),
    previousLevel: previous?.level ?? null,
    pdfPath: row.pdf_path,
  };
}

/** A save that lost to a newer one. The editor reloads and keeps going. */
export class ResumeChangedError extends Error {
  override readonly name = "ResumeChangedError";
}

export interface ResumeStore {
  /** Shortlisted jobs whose resume still has to be written, oldest first. */
  listUnwritten(limit: number): number[];
  /** The list rows' resume status, for the ids on screen. */
  statuses(ids: readonly number[]): Map<number, ResumeStatus>;
  get(jobId: number): StoredResume | null;

  /**
   * Starts writing a shortlisted job's resume at its saved level, or at
   * `level` when it has none yet. Null when the job is not shortlisted or its
   * resume is no longer waiting.
   */
  startWriting(jobId: number, level: ResumeLevel): ResumeLevel | null;
  /** Keeps a finished write, unless the job left Shortlisted meanwhile. */
  finishWriting(jobId: number, draft: ResumeDraft | null): boolean;
  failWriting(jobId: number, error: string): void;
  /**
   * Puts a stopped write back in the queue: one job's, or with no id every
   * write a closed app left behind.
   */
  requeue(jobId?: number): void;

  /** The person's edit. It needs approving again. */
  saveDraft(
    jobId: number,
    draft: ResumeDraft,
    expectedUpdatedAt: string,
  ): StoredResume;
  /** Writes the resume again at `level`; Undo puts the old one back. */
  setLevel(jobId: number, level: ResumeLevel): StoredResume;
  undoLevel(jobId: number): StoredResume;
  /** The posting text a listing read found for a job that had only its card. */
  saveListing(jobId: number, description: string, facts: JobListingFacts): void;
  /** Approves it and hands the job to Apply in one write. */
  approve(jobId: number, pdfPath: string | null): StoredResume;
}

export function createResumeStore(store: JobStore): ResumeStore {
  const { sql } = store;
  const read = (jobId: number) =>
    sql("SELECT * FROM resumes WHERE job_id = ?").get(jobId) as
      | ResumeRow
      | undefined;
  const stageOf = (jobId: number) =>
    (
      sql("SELECT stage FROM jobs WHERE id = ?").get(jobId) as
        | { stage: JobStage }
        | undefined
    )?.stage ?? null;
  const changed = (jobId: number, stages: JobStage[] = ["shortlisted"]) =>
    store.notify({ cause: "resume", stages, ids: [jobId], searchId: null });
  const require = (jobId: number) => {
    const row = read(jobId);
    if (!row) throw new Error(`Job ${jobId} has no resume yet.`);
    return row;
  };
  /** An approved job goes back to Shortlisted when its resume changes. */
  const unapprove = (jobId: number, now: number): JobStage[] => {
    if (stageOf(jobId) !== "resume") return ["shortlisted"];
    sql("UPDATE jobs SET stage = 'shortlisted', stage_at = ? WHERE id = ?").run(
      now,
      jobId,
    );
    return ["shortlisted", "resume"];
  };

  return {
    listUnwritten(limit) {
      return (
        sql(
          `SELECT j.id FROM jobs j LEFT JOIN resumes r ON r.job_id = j.id
           WHERE j.stage = 'shortlisted' AND (r.job_id IS NULL OR r.state = 'queued')
           ORDER BY j.stage_at, j.id LIMIT ?`,
        ).all(limit) as { id: number }[]
      ).map((row) => row.id);
    },

    statuses(ids) {
      const rows = sql(
        `SELECT job_id, level, state, approved_at, error FROM resumes
         WHERE job_id IN (SELECT value FROM json_each(?))`,
      ).all(JSON.stringify(ids)) as ResumeRow[];
      return new Map(
        rows.map((row) => [
          row.job_id,
          {
            level: row.level,
            state: row.state,
            approvedAt: iso(row.approved_at),
            error: row.error,
          },
        ]),
      );
    },

    get(jobId) {
      const row = read(jobId);
      return row ? toStoredResume(row) : null;
    },

    startWriting(jobId, level) {
      return store.transaction(() => {
        if (stageOf(jobId) !== "shortlisted") return null;
        const row = read(jobId);
        // An Undo or a finished write since this was queued wins.
        if (row && row.state !== "queued") return null;
        const writing = row?.level ?? level;
        sql(
          `INSERT INTO resumes (job_id, level, state, updated_at) VALUES (?, ?, 'writing', ?)
           ON CONFLICT (job_id) DO UPDATE SET state = 'writing', error = NULL, updated_at = excluded.updated_at`,
        ).run(jobId, writing, Date.now());
        changed(jobId);
        return writing;
      });
    },

    finishWriting(jobId, draft) {
      return store.transaction(() => {
        const row = read(jobId);
        if (stageOf(jobId) !== "shortlisted" || row?.state !== "writing") {
          return false;
        }
        sql(
          `UPDATE resumes SET state = 'ready', error = NULL, draft_json = ?, updated_at = ?
           WHERE job_id = ?`,
        ).run(draft ? JSON.stringify(draft) : null, Date.now(), jobId);
        changed(jobId);
        return true;
      });
    },

    failWriting(jobId, error) {
      store.transaction(() => {
        const result = sql(
          `UPDATE resumes SET state = 'failed', error = ?, updated_at = ?
           WHERE job_id = ? AND state = 'writing'`,
        ).run(error, Date.now(), jobId);
        if (Number(result.changes) > 0) changed(jobId);
      });
    },

    requeue(jobId) {
      if (jobId === undefined) {
        sql(
          "UPDATE resumes SET state = 'queued' WHERE state = 'writing'",
        ).run();
        return;
      }
      sql(
        "UPDATE resumes SET state = 'queued' WHERE job_id = ? AND state = 'writing'",
      ).run(jobId);
    },

    saveDraft(jobId, draft, expectedUpdatedAt) {
      return store.transaction(() => {
        const row = require(jobId);
        if (new Date(row.updated_at).toISOString() !== expectedUpdatedAt) {
          throw new ResumeChangedError(
            "This resume changed since you opened it. Showing the newer one.",
          );
        }
        const now = Math.max(Date.now(), row.updated_at + 1);
        const stages = unapprove(jobId, now);
        sql(
          `UPDATE resumes SET draft_json = ?, updated_at = ?, approved_at = NULL, pdf_path = NULL
           WHERE job_id = ?`,
        ).run(JSON.stringify(draft), now, jobId);
        changed(jobId, stages);
        return toStoredResume(require(jobId));
      });
    },

    setLevel(jobId, level) {
      return store.transaction(() => {
        const row = read(jobId);
        const now = Date.now();
        const stages = unapprove(jobId, now);
        const previous: PreviousResume | null = row
          ? {
              level: row.level,
              draft: row.draft_json
                ? (JSON.parse(row.draft_json) as ResumeDraft)
                : null,
              approvedAt: row.approved_at,
              pdfPath: row.pdf_path,
            }
          : null;
        sql(
          `INSERT INTO resumes (job_id, level, state, updated_at, previous_json)
           VALUES (?, ?, 'queued', ?, ?)
           ON CONFLICT (job_id) DO UPDATE SET level = excluded.level, state = 'queued',
             error = NULL, updated_at = excluded.updated_at, previous_json = excluded.previous_json,
             approved_at = NULL, pdf_path = NULL`,
        ).run(jobId, level, now, previous ? JSON.stringify(previous) : null);
        changed(jobId, stages);
        return toStoredResume(require(jobId));
      });
    },

    undoLevel(jobId) {
      return store.transaction(() => {
        const row = require(jobId);
        if (!row.previous_json) return toStoredResume(row);
        const previous = JSON.parse(row.previous_json) as PreviousResume;
        const now = Date.now();
        sql(
          `UPDATE resumes SET level = ?, state = 'ready', error = NULL, draft_json = ?,
             updated_at = ?, previous_json = NULL, approved_at = ?, pdf_path = ?
           WHERE job_id = ?`,
        ).run(
          previous.level,
          previous.draft ? JSON.stringify(previous.draft) : null,
          now,
          previous.approvedAt,
          previous.pdfPath,
          jobId,
        );
        const stages: JobStage[] = ["shortlisted"];
        if (previous.approvedAt !== null && stageOf(jobId) === "shortlisted") {
          sql(
            "UPDATE jobs SET stage = 'resume', stage_at = ? WHERE id = ?",
          ).run(now, jobId);
          stages.push("resume");
        }
        changed(jobId, stages);
        return toStoredResume(require(jobId));
      });
    },

    saveListing(jobId, description, facts) {
      sql(
        "UPDATE job_details SET description = ?, facts_json = ? WHERE job_id = ?",
      ).run(description, JSON.stringify(facts), jobId);
    },

    approve(jobId, pdfPath) {
      return store.transaction(() => {
        const row = require(jobId);
        if (row.state !== "ready") {
          throw new Error("This resume is still being written.");
        }
        const now = Date.now();
        sql(
          `UPDATE resumes SET approved_at = ?, pdf_path = ?, previous_json = NULL
           WHERE job_id = ?`,
        ).run(now, pdfPath, jobId);
        const stages: JobStage[] = ["shortlisted"];
        if (stageOf(jobId) === "shortlisted") {
          sql(
            "UPDATE jobs SET stage = 'resume', stage_at = ? WHERE id = ?",
          ).run(now, jobId);
          stages.push("resume");
        }
        changed(jobId, stages);
        return toStoredResume(require(jobId));
      });
    },
  };
}
