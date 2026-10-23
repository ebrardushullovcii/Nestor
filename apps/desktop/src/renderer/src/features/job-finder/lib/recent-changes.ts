import { useSyncExternalStore } from "react";

/**
 * The person's own moves of jobs between lists, newest first. Each toast's
 * Undo and Activity's "Recent changes" read the same entries, so a move made
 * by mistake can be put back from either place, also after a restart.
 *
 * Every move has one way back, named the same on every screen:
 * - Shortlisted <-> Find jobs ("Move back to Find jobs")
 * - Find jobs <-> Not interested (Hide / Show again)
 * - Approved <-> To review ("Move back to To review")
 * - Applications -> Shortlisted while nothing was sent
 * - Apply queue -> out, before the job starts
 */
export type RecentChangeKind =
  | "shortlisted"
  | "hidden"
  | "shown_again"
  | "moved_to_find_jobs"
  | "approved"
  | "moved_to_review"
  | "moved_to_shortlisted"
  | "taken_out_of_queue";

export interface RecentChange {
  id: string;
  at: string;
  kind: RecentChangeKind;
  jobIds: string[];
  /** "Title at Company" of the first job, readable after it leaves a list. */
  label: string;
  /** For an approval: the review status each approval replaced. */
  restoreStatus?: Record<string, "draft" | "needs_review">;
  /** For a move back to To review: the export each job was approved with. */
  approvedExportIds?: Record<string, string>;
  undoneAt?: string | null;
  /** Set on a move that took back an earlier one; undoing it revives that. */
  revives?: string;
}

export type RecentChangeInput = Omit<
  RecentChange,
  "id" | "at" | "undoneAt" | "revives"
>;

/** The parts of the workspace that say whether a move can still be undone. */
export interface RecentChangeWorkspace {
  discoveryJobs: readonly { id: string }[];
  dismissedDiscoveryJobs: readonly { id: string }[];
  reviewQueue: readonly {
    jobId: string;
    resumeReview: { status: string };
  }[];
  /** Jobs whose application is in Applications (see review-queue-status). */
  applicationJobIds: ReadonlySet<string>;
}

export type RecentChangeUndo =
  | { possible: true; jobIds: string[] }
  | { possible: false; reason: string };

export const RECENT_CHANGES_LIMIT = 20;
const STORAGE_KEY = "nestor.job-finder.recent-changes.v1";

let entries: RecentChange[] = readStored();
const listeners = new Set<() => void>();

function readStored(): RecentChange[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? (parsed as RecentChange[])
          .filter(
            (entry) =>
              entry &&
              typeof entry.id === "string" &&
              typeof entry.kind === "string" &&
              Array.isArray(entry.jobIds),
          )
          .slice(0, RECENT_CHANGES_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function commit(next: RecentChange[]): void {
  entries = next.slice(0, RECENT_CHANGES_LIMIT);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Without storage the list lasts for this session only.
  }
  for (const listener of listeners) listener();
}

const REVERSE_KIND: Partial<Record<RecentChangeKind, RecentChangeKind>> = {
  shortlisted: "moved_to_find_jobs",
  moved_to_find_jobs: "shortlisted",
  hidden: "shown_again",
  shown_again: "hidden",
  approved: "moved_to_review",
  moved_to_review: "approved",
};

function sameJobs(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(left);
  return set.size === new Set(right).size && right.every((id) => set.has(id));
}

/**
 * Records a move. A move that takes back the newest move of the same jobs
 * (Undo in the triage bar, Show again right after Hide) marks that one
 * undone instead of adding a second line; the returned change still undoes
 * this move, and doing so revives the first.
 */
export function recordRecentChange(input: RecentChangeInput): RecentChange {
  const jobIds = [...new Set(input.jobIds)];
  const at = new Date().toISOString();
  const latest = entries.find((entry) =>
    entry.jobIds.some((id) => jobIds.includes(id)),
  );
  if (
    latest &&
    !latest.undoneAt &&
    REVERSE_KIND[latest.kind] === input.kind &&
    sameJobs(latest.jobIds, jobIds)
  ) {
    commit(
      entries.map((entry) =>
        entry.id === latest.id ? { ...entry, undoneAt: at } : entry,
      ),
    );
    return {
      ...input,
      jobIds,
      id: `${latest.id}_reverse`,
      at,
      undoneAt: null,
      revives: latest.id,
    };
  }
  const change: RecentChange = {
    ...input,
    jobIds,
    id: `change_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at,
    undoneAt: null,
  };
  commit([change, ...entries]);
  return change;
}

export function markRecentChangeUndone(change: RecentChange): void {
  if (change.revives) {
    const revived = change.revives;
    commit(
      entries.map((entry) =>
        entry.id === revived ? { ...entry, undoneAt: null } : entry,
      ),
    );
    return;
  }
  if (!entries.some((entry) => entry.id === change.id && !entry.undoneAt))
    return;
  const undoneAt = new Date().toISOString();
  commit(
    entries.map((entry) =>
      entry.id === change.id ? { ...entry, undoneAt } : entry,
    ),
  );
}

export function listRecentChanges(): readonly RecentChange[] {
  return entries;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRecentChanges(): readonly RecentChange[] {
  return useSyncExternalStore(subscribe, listRecentChanges);
}

/** Tests only. */
export function resetRecentChangesForTest(): void {
  entries = [];
  for (const listener of listeners) listener();
}

function jobsWord(count: number): string {
  return count === 1 ? "1 job" : `${count} jobs`;
}

/** What the move did, in the words its button used. */
export function describeRecentChange(change: RecentChange): string {
  const many = change.jobIds.length > 1;
  const what = many ? jobsWord(change.jobIds.length) : change.label;
  switch (change.kind) {
    case "shortlisted":
      return `Shortlisted ${what}`;
    case "hidden":
      return `Hid ${what}`;
    case "shown_again":
      return `Showed ${what} again in Find jobs`;
    case "moved_to_find_jobs":
      return `Moved ${what} back to Find jobs`;
    case "approved":
      return many
        ? `Approved ${change.jobIds.length} resumes`
        : `Approved the resume for ${change.label}`;
    case "moved_to_review":
      return many
        ? `Moved ${change.jobIds.length} resumes back to To review`
        : `Moved the resume for ${change.label} back to To review`;
    case "moved_to_shortlisted":
      return `Moved ${what} back to Shortlisted`;
    case "taken_out_of_queue":
      return `Took ${what} out of the apply queue`;
  }
}

/**
 * Whether Undo can still put the move back, judged on the workspace as it is
 * now: a job that moved on since (shortlisted again, applied to) keeps its
 * newer state and the reason says where it went.
 */
export function getRecentChangeUndo(
  change: RecentChange,
  workspace: RecentChangeWorkspace,
  /** The list it sits in, newest first: only a job's newest move undoes. */
  changes: readonly RecentChange[] = [],
): RecentChangeUndo {
  if (change.undoneAt) return { possible: false, reason: "Undone." };
  const index = changes.findIndex((entry) => entry.id === change.id);
  if (
    index > 0 &&
    changes
      .slice(0, index)
      .some(
        (newer) =>
          !newer.undoneAt &&
          newer.jobIds.some((id) => change.jobIds.includes(id)),
      )
  )
    return { possible: false, reason: "Changed again since." };
  const shortlisted = new Map(
    workspace.reviewQueue.map((item) => [item.jobId, item]),
  );
  const inFindJobs = new Set(workspace.discoveryJobs.map((job) => job.id));
  const hidden = new Set(workspace.dismissedDiscoveryJobs.map((job) => job.id));
  const applied = workspace.applicationJobIds;
  const pick = (
    test: (jobId: string) => boolean,
    reason: string,
  ): RecentChangeUndo => {
    const jobIds = change.jobIds.filter(test);
    return jobIds.length > 0
      ? { possible: true, jobIds }
      : { possible: false, reason };
  };
  switch (change.kind) {
    case "shortlisted":
      if (change.jobIds.every((id) => applied.has(id)))
        return {
          possible: false,
          reason: "In Applications now. Move it back from there.",
        };
      return pick(
        (id) => shortlisted.has(id) && !applied.has(id),
        "Already moved back to Find jobs.",
      );
    case "hidden":
      return pick((id) => hidden.has(id), "Already shown again.");
    case "shown_again":
      return pick(
        (id) => inFindJobs.has(id) && !shortlisted.has(id),
        "Shortlisted or hidden since.",
      );
    case "moved_to_find_jobs":
      return pick(
        (id) => !shortlisted.has(id) && !hidden.has(id),
        "Shortlisted again since.",
      );
    case "approved":
      if (change.jobIds.every((id) => applied.has(id)))
        return {
          possible: false,
          reason: "An application already uses this resume.",
        };
      return pick(
        (id) =>
          !applied.has(id) &&
          shortlisted.get(id)?.resumeReview.status === "approved",
        "No longer approved.",
      );
    case "moved_to_review":
      return pick(
        (id) =>
          Boolean(change.approvedExportIds?.[id]) &&
          shortlisted.has(id) &&
          shortlisted.get(id)?.resumeReview.status !== "approved",
        "Approved again since.",
      );
    case "moved_to_shortlisted":
      return {
        possible: false,
        reason:
          "Its form was closed. Apply again from Shortlisted for a fresh one.",
      };
    case "taken_out_of_queue":
      return {
        possible: false,
        reason: "Press Apply on the job to queue it again.",
      };
  }
}
