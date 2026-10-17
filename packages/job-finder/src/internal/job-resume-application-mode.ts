import type {
  JobFinderSettings,
  ResumeApplicationMode,
  SavedJob,
} from "@nestor/contracts";

export const DEFAULT_RESUME_APPLICATION_MODE: ResumeApplicationMode =
  "tailored_per_job";

export function resolveJobResumeApplicationMode(
  job: Pick<SavedJob, "resumeApplicationMode">,
  settings: Pick<JobFinderSettings, "resumeApplicationMode">,
): ResumeApplicationMode {
  return (
    job.resumeApplicationMode ??
    settings.resumeApplicationMode ??
    DEFAULT_RESUME_APPLICATION_MODE
  );
}
