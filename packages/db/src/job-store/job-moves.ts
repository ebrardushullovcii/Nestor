import type { JobSelection, JobStage, TriageStage } from "@nestor/contracts";

import { toFilterSql } from "./job-list";
import type { Statements } from "./statements";

/** Where triage may take a job from, by where it goes. */
const TRIAGE_FROM: Record<TriageStage, readonly JobStage[]> = {
  shortlisted: ["found", "hidden"],
  hidden: ["found", "shortlisted"],
  found: ["hidden", "shortlisted"],
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
          `INSERT OR IGNORE INTO job_move_items (move_id, job_id, from_stage, from_stage_at, from_stage_note)
           SELECT ?, j.id, j.stage, j.stage_at, j.stage_note FROM jobs j
           WHERE j.id IN (SELECT value FROM json_each(?)) AND j.stage IN (${fromList})`,
        ).run(moveId, JSON.stringify(selection.ids), ...from)
      : (() => {
          const filter = toFilterSql(selection.filter);
          return sql(
            `INSERT INTO job_move_items (move_id, job_id, from_stage, from_stage_at, from_stage_note)
             SELECT ?, j.id, j.stage, j.stage_at, j.stage_note FROM jobs j
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
    `UPDATE jobs SET stage = ?, stage_at = ?, stage_note = NULL
     WHERE id IN (SELECT job_id FROM job_move_items WHERE move_id = ?)`,
  ).run(to, now, moveId);
  sql("DELETE FROM job_moves WHERE id <= ?").run(moveId - KEPT_MOVES);
  return { moveId, moved, stages, ids: readMovedIds(sql, moveId, moved) };
}

/**
 * Puts each job of a move back where it was, unless something else moved it
 * since. The move is spent either way.
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
       stage_note = (SELECT from_stage_note FROM job_move_items WHERE move_id = ?1 AND job_id = jobs.id)
     WHERE id IN (SELECT job_id FROM job_move_items WHERE move_id = ?1) AND stage = ?2`,
  ).run(moveId, move.to_stage);
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
    `UPDATE jobs SET stage = ?, stage_at = ?, stage_note = NULL
     WHERE id IN (SELECT value FROM json_each(?)) AND stage <> ?`,
  ).run(to, now, json, to);
  const moved = Number(result.changes);
  return {
    moveId: null,
    moved,
    stages: moved > 0 ? [...stages, to] : [],
    ids: moved > CHANGE_ID_LIMIT ? null : [...ids],
  };
}
