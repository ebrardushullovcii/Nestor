import type {
  ActivityApplication,
  ActivityFeed,
  ActivityMove,
  ActivityResume,
  ActivitySearch,
  ApplicationWorkState,
  JobStage,
  ResumeState,
  TriageStage,
} from "@nestor/contracts";

import type { JobStore } from "./job-store";
import { toIso } from "./job-list";

/** Finished work stays in Activity this long. */
const FINISHED_FOR_MS = 86_400_000;
const LIMIT = 10;

/**
 * Activity's rows: searches, resume writing and Apply work that are running
 * or finished within the last day, each from an indexed state and time.
 * Applications waiting on the person are left to Needs you.
 */
export function createActivityStore(store: JobStore) {
  const { sql } = store;
  return {
    feed(now = Date.now()): ActivityFeed {
      const since = now - FINISHED_FOR_MS;
      const searches = (
        sql(
          `SELECT id, state, started_at, finished_at, sources_done, sources_total, added, error
           FROM searches WHERE state = 'running' OR finished_at >= ?
           ORDER BY started_at DESC LIMIT 3`,
        ).all(since) as {
          id: string;
          state: ActivitySearch["state"];
          started_at: number;
          finished_at: number | null;
          sources_done: number;
          sources_total: number;
          added: number;
          error: string | null;
        }[]
      ).map(
        (row): ActivitySearch => ({
          id: row.id,
          state: row.state,
          startedAt: toIso(row.started_at),
          finishedAt: row.finished_at === null ? null : toIso(row.finished_at),
          sourcesDone: row.sources_done,
          sourcesTotal: row.sources_total,
          added: row.added,
          error: row.error,
        }),
      );
      const resumes = (
        sql(
          `SELECT r.job_id, j.stage, j.title, j.company, r.state, r.updated_at, r.error
           FROM resumes r JOIN jobs j ON j.id = r.job_id
           WHERE r.state IN ('queued', 'writing')
              OR (r.state IN ('ready', 'failed') AND r.updated_at >= ?)
           ORDER BY r.state IN ('queued', 'writing') DESC, r.updated_at DESC
           LIMIT ${LIMIT}`,
        ).all(since) as {
          job_id: number;
          stage: JobStage;
          title: string;
          company: string;
          state: ResumeState;
          updated_at: number;
          error: string | null;
        }[]
      ).map(
        (row): ActivityResume => ({
          jobId: row.job_id,
          stage: row.stage,
          title: row.title,
          company: row.company,
          state: row.state,
          at: toIso(row.updated_at),
          error: row.error,
        }),
      );
      const applications = (
        sql(
          `SELECT a.id, a.job_id, j.title, j.company, a.state, a.updated_at, a.error
           FROM applications a JOIN jobs j ON j.id = a.job_id
           WHERE a.state IN ('queued', 'running', 'submitting')
              OR (a.state IN ('ready', 'submitted', 'stopped', 'failed', 'uncertain')
                  AND a.updated_at >= ?)
           ORDER BY a.state IN ('queued', 'running', 'submitting') DESC, a.updated_at DESC
           LIMIT ${LIMIT}`,
        ).all(since) as {
          id: number;
          job_id: number;
          title: string;
          company: string;
          state: ApplicationWorkState;
          updated_at: number;
          error: string | null;
        }[]
      ).map(
        (row): ActivityApplication => ({
          id: row.id,
          jobId: row.job_id,
          title: row.title,
          company: row.company,
          state: row.state,
          at: toIso(row.updated_at),
          error: row.error,
        }),
      );
      const running = (
        sql(
          `SELECT
             (SELECT COUNT(*) FROM searches WHERE state = 'running')
           + (SELECT COUNT(*) FROM resumes WHERE state IN ('queued', 'writing'))
           + (SELECT COUNT(*) FROM applications
              WHERE state IN ('queued', 'running', 'submitting')) AS n`,
        ).get() as { n: number }
      ).n;
      const moves = (
        sql(
          `SELECT m.id, m.at, m.to_stage,
             (SELECT group_concat(DISTINCT i.from_stage) FROM job_move_items i
              WHERE i.move_id = m.id) AS from_stages,
             (SELECT COUNT(*) FROM job_move_items i WHERE i.move_id = m.id) AS count,
             (SELECT COUNT(*) FROM job_move_items i JOIN jobs j ON j.id = i.job_id
              WHERE i.move_id = m.id AND j.stage = m.to_stage) AS still_there,
             j.title, j.company
           FROM job_moves m
           JOIN jobs j ON j.id = (SELECT MIN(job_id) FROM job_move_items i
                                  WHERE i.move_id = m.id)
           WHERE m.at >= ?
           ORDER BY m.id DESC LIMIT ${LIMIT}`,
        ).all(since) as {
          id: number;
          at: number;
          to_stage: TriageStage;
          from_stages: string;
          count: number;
          still_there: number;
          title: string;
          company: string;
        }[]
      ).map(
        (row): ActivityMove => ({
          id: row.id,
          at: toIso(row.at),
          to: row.to_stage,
          from: row.from_stages.split(",") as JobStage[],
          count: row.count,
          title: row.title,
          company: row.company,
          stillThere: row.still_there,
        }),
      );
      return { searches, resumes, applications, moves, running };
    },
  };
}

export type ActivityStore = ReturnType<typeof createActivityStore>;
