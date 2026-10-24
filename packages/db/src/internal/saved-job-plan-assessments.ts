import type { DatabaseSync } from "node:sqlite";
import type { SavedJob, SavedJobPlanAssessmentPatch } from "@nestor/contracts";
import { prepareStatement } from "./sqlite-statements";

/** Only verdict rows and optional-map presence change; listing bodies are never read. */
export function writeSavedJobPlanAssessments(
  db: DatabaseSync,
  updates: readonly SavedJobPlanAssessmentPatch[],
): number {
  if (!updates.length) return 0;
  if (!db.isTransaction)
    throw new Error("Plan assessments require the job transaction.");
  const patches = new Map(
    updates.map((patch) => [
      JSON.stringify([patch.jobId, patch.planId]),
      patch,
    ]),
  );
  const put = prepareStatement(
    db,
    `INSERT INTO job_plan_assessments(job_id,plan_id,value,score)
    SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM saved_jobs WHERE id = ?)
    ON CONFLICT(job_id,plan_id) DO UPDATE SET value=excluded.value,score=excluded.score
    WHERE value IS NOT excluded.value`,
  );
  const remove = prepareStatement(
    db,
    "DELETE FROM job_plan_assessments WHERE job_id = ? AND plan_id = ?",
  );
  const presence = prepareStatement(
    db,
    "UPDATE saved_jobs SET has_plan_assessments = 1 WHERE id = ? AND has_plan_assessments IS NOT 1",
  );
  let changed = 0;
  for (const patch of patches.values()) {
    if (patch.assessment === null)
      changed += Number(remove.run(patch.jobId, patch.planId).changes);
    else {
      const result = put.run(
        patch.jobId,
        patch.planId,
        JSON.stringify(patch.assessment),
        patch.assessment.score,
        patch.jobId,
      );
      changed += Number(result.changes);
      if (result.changes) presence.run(patch.jobId);
    }
  }
  return changed;
}

export function applySavedJobPlanAssessments(
  jobs: SavedJob[],
  updates: readonly SavedJobPlanAssessmentPatch[],
): { jobs: SavedJob[]; changed: number } {
  let next = jobs;
  let changed = 0;
  for (const patch of new Map(
    updates.map((item) => [JSON.stringify([item.jobId, item.planId]), item]),
  ).values()) {
    const index = next.findIndex((job) => job.id === patch.jobId);
    const job = next[index];
    if (!job) continue;
    if (
      JSON.stringify(job.planAssessments?.[patch.planId] ?? null) ===
      JSON.stringify(patch.assessment)
    )
      continue;
    const plans = { ...job.planAssessments };
    if (patch.assessment === null) delete plans[patch.planId];
    else plans[patch.planId] = structuredClone(patch.assessment);
    if (next === jobs) next = [...jobs];
    next[index] = { ...job, planAssessments: plans };
    changed++;
  }
  return { jobs: next, changed };
}
