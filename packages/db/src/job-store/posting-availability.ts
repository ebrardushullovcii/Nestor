import type { JobStage } from "@nestor/contracts";
import type { Statements } from "./statements";

type PreviousStage = {
  stage: JobStage;
  stage_at: number;
  stage_note: string | null;
  hide_owner: string | null;
};

/** Keeps each closure and reopening, together with the stage it interrupted. */
export function writePostingAvailability(
  sql: Statements,
  ids: readonly number[],
  state: "open" | "closed",
  reason: string,
) {
  const rows = sql(`SELECT id, stage, stage_at, stage_note, hide_owner FROM jobs
    WHERE id IN (SELECT value FROM json_each(?)) ${state === "open" ? "AND hide_owner='closed_listing'" : ""}`).all(
    JSON.stringify(ids),
  ) as Array<PreviousStage & { id: number }>;
  const stages = new Set<JobStage>();
  const changed: number[] = [];
  for (const row of rows) {
    const earlier =
      row.hide_owner === "closed_listing"
        ? (sql(`SELECT previous_stage AS stage, previous_stage_at AS stage_at,
          previous_stage_note AS stage_note, previous_hide_owner AS hide_owner
          FROM job_availability_checks WHERE job_id=? AND state='closed' ORDER BY id DESC LIMIT 1`).get(
            row.id,
          ) as PreviousStage | undefined)
        : undefined;
    const previous =
      earlier ??
      (row.hide_owner === "closed_listing"
        ? {
            ...row,
            stage: "found" as const,
            stage_note: null,
            hide_owner: null,
          }
        : row);
    sql(`INSERT INTO job_availability_checks(job_id, checked_at, state, reason, previous_stage, previous_stage_at, previous_stage_note, previous_hide_owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id,
      Date.now(),
      state,
      reason,
      previous.stage,
      previous.stage_at,
      previous.stage_note,
      previous.hide_owner,
    );
    stages.add(row.stage);
    // Sending or moving a job after a closure takes precedence over its old stage.
    if (state === "closed") {
      // Finish pending work before changing the stage: the ordinary approval-
      // removal trigger would otherwise turn this known closure into Stop.
      sql(`UPDATE applications SET state='failed', error=?, updated_at=?
        WHERE job_id=? AND submitted_at IS NULL AND state IN ('queued','running','needs_you','ready','failed')`).run(
        reason,
        Date.now(),
        row.id,
      );
      sql(`UPDATE jobs SET stage=CASE WHEN stage='applied' THEN stage ELSE 'hidden' END,
        stage_at=CASE WHEN stage='applied' THEN stage_at ELSE ? END,
        stage_note=?, hide_owner='closed_listing' WHERE id=?`).run(
        Date.now(),
        reason,
        row.id,
      );
      stages.add(row.stage === "applied" ? "applied" : "hidden");
      sql(`UPDATE needs_you SET resolved_at=? WHERE resolved_at IS NULL
        AND id IN (SELECT n.task_id FROM application_needs_you n JOIN applications a ON a.id=n.application_id WHERE a.job_id=?)
        AND NOT EXISTS (SELECT 1 FROM application_needs_you n JOIN applications a ON a.id=n.application_id JOIN jobs j ON j.id=a.job_id
          WHERE n.task_id=needs_you.id AND a.state IN ('queued','running','needs_you','failed') AND j.hide_owner IS NOT 'closed_listing')`).run(
        Date.now(),
        row.id,
      );
    } else {
      const to = row.stage === "hidden" ? previous.stage : row.stage;
      const approved =
        to !== "resume" ||
        sql(
          "SELECT 1 FROM resumes WHERE job_id=? AND approved_at IS NOT NULL",
        ).get(row.id);
      const stage = approved ? to : "shortlisted";
      sql(
        `UPDATE jobs SET stage=?, stage_at=?, stage_note=?, hide_owner=? WHERE id=?`,
      ).run(
        stage,
        row.stage === "hidden" ? previous.stage_at : row.stage_at,
        previous.stage_note,
        previous.hide_owner,
        row.id,
      );
      stages.add(stage);
    }
    changed.push(row.id);
  }
  return { ids: changed, stages: [...stages] };
}
