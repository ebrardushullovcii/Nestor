/**
 * Resume workspace routes embed the job id in the path. Job ids may contain
 * spaces, commas, ampersands, and other reserved URL characters (for example
 * `job_target_site_software engineer, robotics & integration`), so callers
 * must encode on write and decode on read.
 */
export function encodeResumeWorkspaceJobId(jobId: string): string {
  return encodeURIComponent(jobId);
}

export function decodeResumeWorkspaceJobId(encodedJobId: string): string {
  try {
    return decodeURIComponent(encodedJobId);
  } catch {
    return encodedJobId;
  }
}

/** Shortlisted, opened on one job and its resume. */
export function buildShortlistedJobRoute(jobId: string | number): string {
  return `/job-finder/review-queue?jobId=${encodeURIComponent(String(jobId))}`;
}

export function getResumeWorkspaceJobIdFromPathname(
  pathname: string,
): string | null {
  const match = pathname.match(/\/job-finder\/review-queue\/([^/]+)\/resume$/);
  if (!match?.[1]) {
    return null;
  }

  return decodeResumeWorkspaceJobId(match[1]);
}
