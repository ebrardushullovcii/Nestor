import type {
  JobFinderJobDetail,
  JobFinderJobDetailQuery,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

export async function readJobFinderJobDetail(
  repository: JobFinderRepository | null,
  input: JobFinderJobDetailQuery,
): Promise<JobFinderJobDetail> {
  if (!repository) throw new Error("Job detail storage is unavailable.");
  const [saved] = await repository.listSavedJobsByIds([input.jobId]);
  const job =
    saved ??
    (
      await repository.readDiscoveryDisplayProjection()
    ).pendingDiscoveryJobs.find((entry) => entry.id === input.jobId);
  if (!job) throw new Error("This job is no longer in your workspace.");
  const assessment = input.planId ? job.planAssessments?.[input.planId] : null;
  return {
    job: assessment ? { ...job, matchAssessment: assessment } : job,
    planId: input.planId,
  };
}
