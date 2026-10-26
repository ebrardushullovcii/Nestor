import type { JobStore } from "./job-store";

export const PROFILE_RESUME_STALE_REASON =
  "Profile details changed after approval and the resume needs a fresh review.";
export const SETTINGS_RESUME_STALE_REASON =
  "Resume settings changed after approval and the resume needs a fresh review.";

/** Runs inside the fact write, so no Apply reader can observe new facts with old approval. */
export function invalidateProfileResumes(
  store: JobStore,
  reason = PROFILE_RESUME_STALE_REASON,
): void {
  const rows = store
    .sql(
      `SELECT r.job_id FROM resumes r JOIN jobs j ON j.id=r.job_id
 WHERE j.stage IN ('shortlisted','resume')
 AND (r.state='writing' OR r.approved_at IS NOT NULL OR (r.draft_json IS NOT NULL AND json_extract(r.draft_json,'$.staleReason') IS NOT ?))
 AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.job_id=j.id AND a.state='submitted')`,
    )
    .all(reason) as { job_id: number }[];
  if (!rows.length) return;
  const now = Date.now(),
    ids = JSON.stringify(rows.map((row) => row.job_id));
  store
    .sql(
      `UPDATE resumes SET approved_at=NULL,pdf_path=NULL,previous_json=NULL,state='queued',error=NULL,updated_at=?,
 draft_json=CASE WHEN draft_json IS NULL THEN NULL ELSE json_set(draft_json,'$.status','stale','$.staleReason',?,'$.approvedAt',NULL,'$.approvedExportId',NULL,'$.updatedAt',?) END
 WHERE job_id IN (SELECT value FROM json_each(?))`,
    )
    .run(now, reason, new Date(now).toISOString(), ids);
  store
    .sql(
      `UPDATE jobs SET stage='shortlisted',stage_at=? WHERE stage='resume' AND id IN (SELECT value FROM json_each(?))`,
    )
    .run(now, ids);
  store.notify({
    cause: "resume",
    stages: ["shortlisted", "resume"],
    ids: rows.map((row) => row.job_id),
    searchId: null,
  });
}

export function applySettingsResumeEffects(
  store: JobStore,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  if (
    before.resumeFormat !== after.resumeFormat ||
    before.fontPreset !== after.fontPreset
  )
    invalidateProfileResumes(store, SETTINGS_RESUME_STALE_REASON);
  if (before.resumeApplicationMode === after.resumeApplicationMode) return;
  const tailoring = store
    .sql("SELECT tailoring_mode AS mode FROM profile_goals WHERE id=1")
    .get()?.mode;
  const level =
    before.resumeApplicationMode === "original_resume"
      ? "original"
      : tailoring === "conservative"
        ? "light"
        : tailoring === "aggressive"
          ? "aggressive"
          : "tailored";
  const rows = store
    .sql(
      `INSERT INTO resumes(job_id,level,state,updated_at)
 SELECT id,?,'queued',? FROM jobs WHERE stage IN ('shortlisted','resume')
 ON CONFLICT(job_id) DO NOTHING RETURNING job_id`,
    )
    .all(level, Date.now()) as { job_id: number }[];
  if (rows.length)
    store.notify({
      cause: "resume",
      stages: ["shortlisted", "resume"],
      ids: rows.map((row) => row.job_id),
      searchId: null,
    });
}

/** An intentional application address wins; a mirrored primary address follows the edit. */
export function followPrimaryContact(input: {
  before: unknown;
  after: unknown;
  preferred: unknown;
  nextPreferred: unknown;
  phone?: boolean;
}): unknown {
  const normalize = (value: unknown) => {
    const text = typeof value === "string" ? value : "";
    return input.phone ? text.replace(/\D/gu, "") : text.trim().toLowerCase();
  };
  return normalize(input.before) !== normalize(input.after) &&
    normalize(input.preferred) === normalize(input.nextPreferred) &&
    (!normalize(input.preferred) ||
      normalize(input.preferred) === normalize(input.before))
    ? input.after
    : input.nextPreferred;
}
