import type { SavedJob } from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

/**
 * One saved job by id, or null. Reading every saved job to find one parsed
 * and validated the whole collection: about 1.7 s of the main process on
 * 6,284 jobs, paid by each application step that looked a job up.
 */
export async function readSavedJob(
  repository: Pick<JobFinderRepository, "listSavedJobsByIds">,
  jobId: string,
): Promise<SavedJob | null> {
  const [job] = await repository.listSavedJobsByIds([jobId]);
  return job ?? null;
}
