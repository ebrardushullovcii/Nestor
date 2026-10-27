import type { JobSelection, JobStage, TriageStage } from "@nestor/contracts";

import { toFilterSql } from "./job-list";
import type { Statements } from "./statements";

/**
 * Where triage may take a job from, by where it goes. An approved job can go
 * back to Find jobs: leaving `resume` is what takes its approval away (Apply
 * and the Approved list read the stage), while the resume keeps its approval
 * and PDF so Undo puts both back.
 */
const TRIAGE_FROM: Record<TriageStage, readonly JobStage[]> = {
  shortlisted: ["found", "hidden"],
  hidden: ["found", "shortlisted"],
  found: ["hidden", "shortlisted", "resume"],
};

/** Undo reaches this many moves back. */
const KEPT_MOVES = 50;

/** Above this many, a change names no ids and screens just refetch. */
export const CHANGE_ID_LIMIT = 200;

export interface MoveOutcome {
  moveId: number | null;
  moved: number;
  stages: JobStage[];
  ids: number[] | null;
}

function readMovedIds(sql: Statements, moveId: number, moved: number) {
  if (moved > CHANGE_ID_LIMIT) return null;
  return (
    sql("SELECT job_id FROM job_move_items WHERE move_id = ?").all(moveId) as {
      job_id: number;
    }[]
  ).map((row) => row.job_id);
}

function readFromStages(sql: Statements, moveId: number): JobStage[] {
  return (
    sql("SELECT DISTINCT from_stage FROM job_move_items WHERE move_id = ?").all(
      moveId,
    ) as { from_stage: JobStage }[]
  ).map((row) => row.from_stage);
}

/** Moves the selected jobs that triage may move, and records it for Undo. */
export function writeMove(
  sql: Statements,
  selection: JobSelection,
  to: TriageStage,
  now: number,
): MoveOutcome {
  const from = TRIAGE_FROM[to];
  const moveId = Number(
    sql("INSERT INTO job_moves (at, to_stage) VALUES (?, ?)").run(now, to)
      .lastInsertRowid,
  );
  const fromList = from.map(() => "?").join(", ");
  const recorded =
    "ids" in selection
      ? sql(
          `INSERT OR IGNORE INTO job_move_items (move_id, job_id, from_stage, from_stage_at, from_stage_note, from_hide_owner)
           SELECT ?, j.id, j.stage, j.stage_at, j.stage_note, j.hide_owner FROM jobs j
           WHERE j.id IN (SELECT value FROM json_each(?)) AND j.stage IN (${fromList})`,
        ).run(moveId, JSON.stringify(selection.ids), ...from)
      : (() => {
          const filter = toFilterSql(selection.filter);
          return sql(
            `INSERT INTO job_move_items (move_id, job_id, from_stage, from_stage_at, from_stage_note, from_hide_owner)
             SELECT ?, j.id, j.stage, j.stage_at, j.stage_note, j.hide_owner FROM jobs j
             WHERE ${filter.where} AND j.stage IN (${fromList})
               AND j.id NOT IN (SELECT value FROM json_each(?))`,
          ).run(
            moveId,
            ...filter.params,
            ...from,
            JSON.stringify(selection.except),
          );
        })();
  const moved = Number(recorded.changes);
  if (moved === 0) {
    sql("DELETE FROM job_moves WHERE id = ?").run(moveId);
    return { moveId: null, moved: 0, stages: [], ids: [] };
  }
  const stages = [...new Set<JobStage>([...readFromStages(sql, moveId), to])];
  sql(
    `UPDATE jobs SET stage = ?, stage_at = ?, stage_note = NULL, hide_owner = CASE WHEN ? = 'hidden' THEN 'person' ELSE NULL END
     WHERE id IN (SELECT job_id FROM job_move_items WHERE move_id = ?)`,
  ).run(to, now, to, moveId);
  // Shortlisted again, a resume approved before it went back starts over at
  // review instead of reading as approved in To review.
  if (to === "shortlisted")
    sql(
      `UPDATE resumes SET approved_at = NULL, pdf_path = NULL
       WHERE approved_at IS NOT NULL
         AND job_id IN (SELECT job_id FROM job_move_items WHERE move_id = ?)`,
    ).run(moveId);
  sql("DELETE FROM job_moves WHERE id <= ?").run(moveId - KEPT_MOVES);
  return { moveId, moved, stages, ids: readMovedIds(sql, moveId, moved) };
}

/**
 * Whether job `j` of move item `i` can go back where move `m` found it: it is
 * still in the move's stage, since the move's own time, and in no later
 * recorded move (a job moved away and back again has moved on). A job goes
 * back to Approved only while its resume is still approved: shortlisting it
 * again clears that approval, and Undo never makes a job approved without one.
 */
export const STILL_FROM_MOVE = `j.stage = m.to_stage AND j.stage_at = m.at
  AND NOT EXISTS (SELECT 1 FROM job_move_items later
                  WHERE later.job_id = j.id AND later.move_id > m.id)
  AND (i.from_stage <> 'resume' OR EXISTS (
    SELECT 1 FROM resumes r WHERE r.job_id = j.id AND r.approved_at IS NOT NULL))`;

/**
 * Puts each job of a move back where it was, unless it has moved on since
 * (see `STILL_FROM_MOVE`). The move is spent either way.
 */
export function writeUndo(sql: Statements, moveId: number): MoveOutcome {
  const move = sql("SELECT to_stage FROM job_moves WHERE id = ?").get(
    moveId,
  ) as { to_stage: JobStage } | undefined;
  if (!move) return { moveId: null, moved: 0, stages: [], ids: [] };
  const ids = readMovedIds(sql, moveId, CHANGE_ID_LIMIT);
  const stages = [
    ...new Set<JobStage>([...readFromStages(sql, moveId), move.to_stage]),
  ];
  const result = sql(
    `UPDATE jobs SET
       stage = (SELECT from_stage FROM job_move_items WHERE move_id = ?1 AND job_id = jobs.id),
       stage_at = (SELECT from_stage_at FROM job_move_items WHERE move_id = ?1 AND job_id = jobs.id),
       stage_note = (SELECT from_stage_note FROM job_move_items WHERE move_id = ?1 AND job_id = jobs.id),
       hide_owner = (SELECT from_hide_owner FROM job_move_items WHERE move_id = ?1 AND job_id = jobs.id)
     WHERE id IN (
       SELECT j.id FROM job_moves m
       JOIN job_move_items i ON i.move_id = m.id
       JOIN jobs j ON j.id = i.job_id
       WHERE m.id = ?1 AND ${STILL_FROM_MOVE})`,
  ).run(moveId);
  sql("DELETE FROM job_moves WHERE id = ?").run(moveId);
  const moved = Number(result.changes);
  return {
    moveId,
    moved,
    stages,
    ids: moved > CHANGE_ID_LIMIT ? null : ids,
  };
}

/**
 * Sets a stage without triage's limits or an Undo record: for the flows that
 * own the later stages (a resume approved, an application sent).
 */
export function writeStage(
  sql: Statements,
  ids: readonly number[],
  to: JobStage,
  now: number,
): MoveOutcome {
  const json = JSON.stringify(ids);
  const stages = (
    sql(
      `SELECT DISTINCT stage FROM jobs WHERE id IN (SELECT value FROM json_each(?)) AND stage <> ?`,
    ).all(json, to) as { stage: JobStage }[]
  ).map((row) => row.stage);
  const result = sql(
    `UPDATE jobs SET stage = ?, stage_at = ?, stage_note = NULL, hide_owner = CASE WHEN ? = 'hidden' THEN 'person' ELSE NULL END
     WHERE id IN (SELECT value FROM json_each(?)) AND stage <> ?`,
  ).run(to, now, to, json, to);
  const moved = Number(result.changes);
  return {
    moveId: null,
    moved,
    stages: moved > 0 ? [...stages, to] : [],
    ids: moved > CHANGE_ID_LIMIT ? null : [...ids],
  };
}
