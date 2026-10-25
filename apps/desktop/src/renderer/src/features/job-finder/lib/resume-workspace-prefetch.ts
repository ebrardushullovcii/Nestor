import type { JobFinderResumeWorkspace } from "@nestor/contracts";

/**
 * The next resume in a review pass, read ahead of time.
 *
 * Opening a resume reads its saved draft, checks and history (no model call).
 * While the person reads one resume, the next one is read in the background,
 * so "Approve and next" swaps straight to it instead of showing a loading
 * card. A read is used once and only while it is fresh; the studio still
 * reads the resume again behind it, so nothing stale stays on screen.
 */
const FRESH_FOR_MS = 60_000;

interface Entry {
  at: number;
  value: JobFinderResumeWorkspace | null;
}

const entries = new Map<string, Entry>();

export function prefetchResumeWorkspace(
  jobId: string,
  load: (jobId: string) => Promise<JobFinderResumeWorkspace>,
  now = Date.now(),
): void {
  const existing = entries.get(jobId);
  if (existing && now - existing.at < FRESH_FOR_MS) return;
  const entry: Entry = { at: now, value: null };
  entries.set(jobId, entry);
  load(jobId).then(
    (value) => {
      if (entries.get(jobId) === entry) entry.value = value;
    },
    () => {
      if (entries.get(jobId) === entry) entries.delete(jobId);
    },
  );
}

/** The read-ahead resume for this job, once, if it arrived and is fresh. */
export function takePrefetchedResumeWorkspace(
  jobId: string,
  now = Date.now(),
): JobFinderResumeWorkspace | null {
  const entry = entries.get(jobId);
  entries.delete(jobId);
  if (!entry?.value || now - entry.at >= FRESH_FOR_MS) return null;
  return entry.value.job.id === jobId ? entry.value : null;
}

/** For tests. */
export function clearPrefetchedResumeWorkspaces(): void {
  entries.clear();
}
