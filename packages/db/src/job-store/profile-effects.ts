import type { JobStore } from "./job-store";
import {
  buildResumeRenderHeader,
  ResumeDraftIdentitySchema,
  type ResumeRenderProfile,
} from "@nestor/contracts";

export const PROFILE_RESUME_STALE_REASON =
  "Profile details changed after approval and the resume needs a fresh review.";
export const SETTINGS_RESUME_STALE_REASON =
  "Resume settings changed after approval and the resume needs a fresh review.";

/** Runs inside the fact write, so no Apply reader can observe new facts with old approval. */
export function invalidateProfileResumes(
  store: JobStore,
  reason = PROFILE_RESUME_STALE_REASON,
  changedIds?: readonly number[],
): void {
  if (changedIds?.length === 0) return;
  const rows = store
    .sql(
      `SELECT r.job_id FROM resumes r JOIN jobs j ON j.id=r.job_id
 WHERE j.stage IN ('shortlisted','resume')
 AND (? IS NULL OR r.job_id IN (SELECT value FROM json_each(?)))
 AND (r.state='writing' OR r.approved_at IS NOT NULL OR (r.draft_json IS NOT NULL AND json_extract(r.draft_json,'$.staleReason') IS NOT ?))
 AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.job_id=j.id AND a.state='submitted')`,
    )
    .all(
      changedIds ? JSON.stringify(changedIds) : null,
      changedIds ? JSON.stringify(changedIds) : null,
      reason,
    ) as { job_id: number }[];
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

/** Unreviewed drafts still refresh from new facts, including in-flight writing. */
export function invalidateUnapprovedProfileResumes(store: JobStore): void {
  const rows = store
    .sql(
      `SELECT r.job_id FROM resumes r JOIN jobs j ON j.id=r.job_id
    WHERE j.stage IN ('shortlisted','resume') AND r.level<>'original' AND r.approved_at IS NULL`,
    )
    .all() as { job_id: number }[];
  invalidateProfileResumes(
    store,
    PROFILE_RESUME_STALE_REASON,
    rows.map((row) => row.job_id),
  );
}

/** Draft sections and explicit identity values are snapshots, not live Profile bindings. */
export function invalidateChangedProfileResumes(
  store: JobStore,
  before: ResumeRenderProfile,
  after: ResumeRenderProfile,
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const rows = store
    .sql(
      `SELECT r.job_id,json_extract(r.draft_json,'$.identity') AS identity_json FROM resumes r JOIN jobs j ON j.id=r.job_id
    WHERE j.stage IN ('shortlisted','resume') AND r.level<>'original'
    AND r.approved_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM applications a WHERE a.job_id=j.id AND a.state='submitted')`,
    )
    .all() as {
    job_id: number;
    identity_json: string | null;
  }[];
  const ids = rows
    .filter((row) => {
      const draft = {
        identity: ResumeDraftIdentitySchema.nullable().parse(
          row.identity_json ? JSON.parse(row.identity_json) : null,
        ),
      };
      return (
        JSON.stringify(buildResumeRenderHeader(before, draft)) !==
        JSON.stringify(buildResumeRenderHeader(after, draft))
      );
    })
    .map((row) => row.job_id);
  invalidateProfileResumes(store, PROFILE_RESUME_STALE_REASON, ids);
}

export function applySettingsResumeEffects(
  store: JobStore,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): void {
  if (
    before["aiBehavior.jobSearch.remoteCountsAsAnyLocation"] !==
    after["aiBehavior.jobSearch.remoteCountsAsAnyLocation"]
  ) {
    // Fit is derived from the location policy. Keep jobs and resume drafts;
    // the next search judges these rows again with the new policy.
    const ids = store
      .sql(
        `UPDATE jobs SET fit_score=-1,fit_summary=NULL
       WHERE stage IN ('found','shortlisted','resume','hidden') AND fit_score>=0 RETURNING id`,
      )
      .all() as { id: number }[];
    if (ids.length) {
      store
        .sql(
          "UPDATE job_details SET fit_json=NULL WHERE job_id IN (SELECT value FROM json_each(?))",
        )
        .run(JSON.stringify(ids.map((row) => row.id)));
      store.notify({
        cause: "fit",
        stages: ["found", "shortlisted", "resume", "hidden"],
        ids: null,
        searchId: null,
      });
    }
  }
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
