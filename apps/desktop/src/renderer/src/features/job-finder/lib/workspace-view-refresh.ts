import { useSyncExternalStore } from "react";
import type {
  JobFinderJobDetail,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";

/**
 * A workspace update no longer rebuilds the whole workspace in main (the
 * full sync walked every job; 6.6 s on 12,000 jobs at the end of a search).
 * The window re-reads Home's first view (ADR 0077), which holds everything
 * but the Find jobs lists, and patches those lists for the jobs the change
 * feed named. Screens on queries read their own pages.
 */

/** As many changed jobs as one refresh reads one by one. */
export const PATCHED_JOBS_LIMIT = 200;

type Workspace = JobFinderRendererWorkspaceSnapshot;
type ListedJob = Workspace["discoveryJobs"][number];

/**
 * The Find jobs lists with each changed job's own record applied. `details`
 * lines up with `jobIds`; null means the job is gone. Returns `complete:
 * false` when a job should join a list it is not in yet: its listed row
 * (listing activity and the rest) comes only from a full read.
 */
export function patchFindJobsLists(input: {
  current: Pick<
    Workspace,
    "discoveryJobs" | "dismissedDiscoveryJobs" | "companyJobs"
  >;
  /** The first view's rows for the jobs past Find jobs, freshly projected. */
  curated: readonly ListedJob[];
  jobIds: readonly string[];
  details: readonly (JobFinderJobDetail | null | undefined)[];
}): {
  discoveryJobs: Workspace["discoveryJobs"];
  dismissedDiscoveryJobs: Workspace["dismissedDiscoveryJobs"];
  companyJobs: Workspace["companyJobs"];
  complete: boolean;
} {
  const { current } = input;
  const curated = new Map(input.curated.map((row) => [row.id, row]));
  const changed = new Map<string, JobFinderJobDetail["job"] | null>();
  input.jobIds.forEach((jobId, index) => {
    const detail = input.details[index];
    // Unread (the read failed): left as it is.
    if (detail === undefined) return;
    changed.set(jobId, detail?.job ?? null);
  });
  let complete = true;
  const fresh = (row: ListedJob): ListedJob | null => {
    const fromView = curated.get(row.id);
    if (fromView) return fromView;
    if (!changed.has(row.id)) return row;
    const job = changed.get(row.id);
    return job ? ({ ...row, ...job } as ListedJob) : null;
  };
  const knownRows = new Map<string, ListedJob>();
  for (const row of [
    ...current.discoveryJobs,
    ...current.dismissedDiscoveryJobs,
  ])
    knownRows.set(row.id, row);

  const discoveryJobs: ListedJob[] = [];
  const listed = new Set<string>();
  for (const row of current.discoveryJobs) {
    const next = fresh(row);
    if (!next || next.status === "archived") continue;
    discoveryJobs.push(next);
    listed.add(next.id);
  }
  const dismissed: ListedJob[] = [];
  const hidden = new Set<string>();
  for (const row of current.dismissedDiscoveryJobs) {
    const next = fresh(row);
    if (!next || next.status !== "archived" || !next.discoveryFeedback)
      continue;
    dismissed.push(next);
    hidden.add(next.id);
  }
  for (const [jobId, job] of changed) {
    if (!job || listed.has(jobId) || hidden.has(jobId)) continue;
    const known = knownRows.get(jobId) ?? curated.get(jobId);
    const isHidden = job.status === "archived" && Boolean(job.discoveryFeedback);
    if (job.status === "archived" && !isHidden) continue;
    if (!known) {
      // A job new to these lists (one a search found): its row needs the
      // full read's projection.
      complete = false;
      continue;
    }
    const row = { ...known, ...job } as ListedJob;
    if (isHidden) dismissed.push(row);
    else discoveryJobs.push(row);
  }
  const companyJobs = current.companyJobs.map((row) => {
    const next = fresh(row);
    return next ?? row;
  });
  return {
    discoveryJobs,
    dismissedDiscoveryJobs: dismissed,
    companyJobs,
    complete,
  };
}

// Screens that still list every job (Companies, Rapid review, a link to one
// job, Ctrl+K, Recent changes, Safeguards) read the full workspace once when
// they open after the lists fell behind, never on the update path.
let listsBehind = false;
let fullReadPending = false;
let readFull: (() => Promise<unknown>) | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

export function markFindJobsListsBehind(behind: boolean): void {
  if (listsBehind === behind) return;
  listsBehind = behind;
  notify();
}

export function registerFullWorkspaceRead(
  read: (() => Promise<unknown>) | null,
): void {
  readFull = read;
}

/** Called as such a screen opens: one full read if the lists fell behind. */
export function readFullWorkspaceIfBehind(): void {
  if (!listsBehind || !readFull || fullReadPending) return;
  fullReadPending = true;
  notify();
  void readFull()
    .then(
      () => {
        listsBehind = false;
      },
      () => undefined,
    )
    .finally(() => {
      fullReadPending = false;
      notify();
    });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const readCurrent = () => !listsBehind && !fullReadPending;

/** Whether the Find jobs lists hold every job (no full read owed or under way). */
export function useFindJobsListsCurrent(): boolean {
  return useSyncExternalStore(subscribe, readCurrent, readCurrent);
}
