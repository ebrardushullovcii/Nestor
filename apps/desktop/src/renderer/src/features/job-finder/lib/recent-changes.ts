import { useSyncExternalStore } from "react";

/**
 * The person's own moves of jobs between lists, newest first. Each toast's
 * Undo and Activity's "Recent changes" read the same entries, so a move made
 * by mistake can be put back from either place, also after a restart.
 *
 * Moves between Find jobs and Shortlisted live in the job store and undo
 * there; these are the moves out of Applications:
 * - Applications -> Shortlisted while nothing was sent
 * - Apply queue -> out, before the job starts
 */
export type RecentChangeKind = "moved_to_shortlisted" | "taken_out_of_queue";

const KINDS: ReadonlySet<string> = new Set<RecentChangeKind>([
  "moved_to_shortlisted",
  "taken_out_of_queue",
]);

export interface RecentChange {
  id: string;
  at: string;
  kind: RecentChangeKind;
  jobIds: string[];
  /** "Title at Company" of the first job, readable after it leaves a list. */
  label: string;
  undoneAt?: string | null;
}

export type RecentChangeInput = Omit<RecentChange, "id" | "at" | "undoneAt">;

/** The parts of the workspace that say whether a move can still be undone. */
export interface RecentChangeWorkspace {
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
              KINDS.has(entry.kind) &&
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

/** Records a move. */
export function recordRecentChange(input: RecentChangeInput): RecentChange {
  const change: RecentChange = {
    ...input,
    jobIds: [...new Set(input.jobIds)],
    id: `change_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    undoneAt: null,
  };
  commit([change, ...entries]);
  return change;
}

export function markRecentChangeUndone(change: RecentChange): void {
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
  const what =
    change.jobIds.length > 1 ? jobsWord(change.jobIds.length) : change.label;
  switch (change.kind) {
    case "moved_to_shortlisted":
      return `Moved ${what} back to Shortlisted`;
    case "taken_out_of_queue":
      return `Took ${what} out of the apply queue`;
  }
}

/**
 * Whether Undo can still put the move back, judged on the workspace as it is
 * now: a job that moved on since keeps its newer state and the reason says where it went.
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
    case "moved_to_shortlisted":
      return pick((id) => !applied.has(id), "In Applications again since.");
    case "taken_out_of_queue":
      return {
        possible: false,
        reason: "Press Apply on the job to queue it again.",
      };
  }
}
