import { useSyncExternalStore } from "react";
import type { JobSearchSourceRow, JobSearchStatus } from "@nestor/contracts";

/**
 * One stop on a walk through Needs you: a question or other application
 * step answered in the detail pane (`task`), or a job site to sign in to in
 * the browser (`site`, possibly several sources on one host).
 */
export interface WorkItem {
  /** The Needs you row: a task id, or a merged site's first task id. */
  id: number;
  kind: "task" | "site";
  label: string;
  /** For a site: the Needs you tasks and job sites its row stands for. */
  taskIds: readonly number[];
  sources: readonly { id: number; url: string }[];
}

export type SiteCheck = "checking" | "still";

interface Walk {
  items: readonly WorkItem[];
  index: number;
  paused: boolean;
}

interface Snapshot {
  walk: Walk | null;
  /**
   * By Needs you task id: a site checked after sign-in. Keyed by task, not
   * row, because a merged row's id moves when one of its sites closes.
   */
  checks: ReadonlyMap<number, SiteCheck>;
}

/** What a row's check says: Checking… while any of its sites is checked. */
export function siteCheck(
  checks: ReadonlyMap<number, SiteCheck>,
  taskIds: readonly number[],
): SiteCheck | undefined {
  const found = taskIds.map((id) => checks.get(id));
  return found.includes("checking")
    ? "checking"
    : found.includes("still")
      ? "still"
      : undefined;
}

let snapshot: Snapshot = { walk: null, checks: new Map() };
const listeners = new Set<() => void>();
const watchers = new Map<number, () => void>();

function set(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The item the walk is on, or null when there is no walk. */
export function currentWorkItem(walk: Walk | null): WorkItem | null {
  return walk ? (walk.items[walk.index] ?? null) : null;
}

function visit() {
  const item = currentWorkItem(snapshot.walk);
  if (item?.kind !== "site" || snapshot.walk?.paused) return;
  void window.nestor.needsYou
    .run("open_need", { id: item.taskIds[0] ?? item.id })
    .catch(() => undefined);
}

function advance() {
  const walk = snapshot.walk;
  if (!walk) return;
  const leaving = currentWorkItem(walk);
  if (walk.index + 1 >= walk.items.length) {
    set({ walk: null });
    if (leaving?.kind === "site")
      void window.nestor.browser
        ?.command({ type: "minimize" })
        .catch(() => undefined);
    return;
  }
  set({ walk: { ...walk, index: walk.index + 1, paused: false } });
  visit();
}

const TERMINAL = new Set<JobSearchSourceRow["state"]>([
  "done",
  "failed",
  "needs_you",
  "stopped",
]);
/** A site still unread this long after its check reads as not working. */
const CHECK_LIMIT_MS = 4 * 60_000;

function setCheck(item: WorkItem, check: SiteCheck) {
  const checks = new Map(snapshot.checks);
  for (const id of item.taskIds) checks.set(id, check);
  set({ checks });
}

/**
 * Reads each source again and watches the search until it has finished with
 * them. A site that now reads closes its Needs you row (the list drops it);
 * one that still can't be read says so.
 */
async function checkSite(item: WorkItem) {
  watchers.get(item.id)?.();
  setCheck(item, "checking");
  let searchId: string | null = null;
  try {
    for (const source of item.sources) {
      const status = await window.nestor.jobs.run("retry_source", {
        id: source.id,
      });
      searchId = status.search?.id ?? searchId;
    }
  } catch {
    setCheck(item, "still");
    return;
  }
  const seenWorking = new Set<number>();
  const finished = new Set<number>();
  let reading = false;
  let again = false;
  let stopped = false;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    if (watchers.get(item.id) === stop) watchers.delete(item.id);
  };
  const read = async (status?: JobSearchStatus) => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      do {
        again = false;
        const ended =
          status?.search?.id === searchId &&
          status?.search?.state !== "running";
        for (const source of item.sources) {
          if (finished.has(source.id)) continue;
          const page = await window.nestor.jobs.run("list_search_sources", {
            searchId,
            text: source.url,
            limit: 100,
          });
          const row = page.rows.find(
            (value) => value.sourceId === String(source.id),
          );
          if (row && !TERMINAL.has(row.state)) seenWorking.add(source.id);
          else if (ended || (row && seenWorking.has(source.id)))
            finished.add(source.id);
        }
      } while (again && !stopped);
    } catch {
      /* The next status update reads again. */
    } finally {
      reading = false;
    }
    if (!stopped && finished.size === item.sources.length) {
      stop();
      // A site that now reads has already left the list with its task.
      setCheck(item, "still");
    }
  };
  const unsubscribe = window.nestor.jobs.onSearchStatus(
    (status) => void read(status),
  );
  const timer = setTimeout(() => {
    stop();
    setCheck(item, "still");
  }, CHECK_LIMIT_MS);
  watchers.set(item.id, stop);
  void read();
}

export const workThrough = {
  /** Starts at the first item; a site opens in the browser at once. */
  start(items: readonly WorkItem[]) {
    if (!items.length) return;
    set({ walk: { items, index: 0, paused: false } });
    visit();
  },
  /** The person finished a site's sign-in: check it and go on. */
  doneWithSite() {
    const item = currentWorkItem(snapshot.walk);
    if (item?.kind === "site") void checkSite(item);
    advance();
  },
  /** A question was answered or the item left the list. */
  finished(id: number) {
    if (currentWorkItem(snapshot.walk)?.id === id) advance();
  },
  skip: advance,
  pause() {
    if (snapshot.walk && !snapshot.walk.paused)
      set({ walk: { ...snapshot.walk, paused: true } });
  },
  resume() {
    if (!snapshot.walk) return;
    set({ walk: { ...snapshot.walk, paused: false } });
    visit();
  },
  stop() {
    set({ walk: null });
  },
  /** Checks one site outside a walk, from its detail pane. */
  check(item: WorkItem) {
    void checkSite(item);
  },
  /** For tests: forget every walk and check. */
  reset() {
    for (const stop of [...watchers.values()]) stop();
    set({ walk: null, checks: new Map() });
  },
};

/** The walk through Needs you and the checks it started, shared with the browser. */
export function useWorkThrough(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}
