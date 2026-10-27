import { useEffect, useSyncExternalStore } from "react";
import type { ActivityFeed } from "@nestor/contracts";

import { afterFirstScreen } from "./after-first-screen";

/**
 * Activity's rows from the job store, read once the first screen is shown
 * and again after every store change or search progress update. One copy
 * per window, shared by the header button's count and the open panel.
 */
export interface ActivityFeedState {
  feed: ActivityFeed | null;
  /** The last read failed; `feed` is what the one before it returned. */
  failed: boolean;
}

let state: ActivityFeedState = { feed: null, failed: false };
let started = false;
/** Bumped when the last user unmounts: a read or tick from before is dropped. */
let generation = 0;
let users = 0;
let pending: ReturnType<typeof setTimeout> | null = null;
let unsubscribes: Array<() => void> = [];
const listeners = new Set<() => void>();

function read(): void {
  // Hosts without the bridge (tests of other screens) have no Activity, and
  // a tick that outlived its window has nothing to read.
  if (typeof window === "undefined") return;
  const activity = window.nestor?.activity;
  if (!activity) return;
  const current = generation;
  const settle = (next: ActivityFeedState) => {
    if (current !== generation) return;
    state = next;
    for (const listener of listeners) listener();
  };
  void activity.feed().then(
    (feed) => settle({ feed, failed: false }),
    () => settle({ feed: state.feed, failed: true }),
  );
}

// A search changes the store several times a second; reading the feed after
// each burst kept main busy enough to hold screens back. Once a second is
// still live for the counts and progress it shows.
const REFRESH_GAP_MS = 1000;

/** Reads again soon; a burst of changes becomes one read. */
export function refreshActivityFeed(): void {
  if (!started || pending !== null) return;
  pending = setTimeout(() => {
    pending = null;
    read();
  }, REFRESH_GAP_MS);
}

function start(): void {
  if (started || typeof window === "undefined" || !window.nestor?.activity)
    return;
  started = true;
  const current = generation;
  afterFirstScreen(() => {
    if (current !== generation) return;
    read();
    unsubscribes = [
      window.nestor.jobs.onChange?.(refreshActivityFeed),
      window.nestor.jobs.onSearchStatus?.(refreshActivityFeed),
    ].filter((unsubscribe): unsubscribe is () => void => !!unsubscribe);
  });
}

/** The last user went away: no timer, listener or read outlives it. */
function stop(): void {
  generation += 1;
  started = false;
  if (pending !== null) clearTimeout(pending);
  pending = null;
  for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => state;

export function useActivityFeed(): ActivityFeedState {
  useEffect(() => {
    users += 1;
    start();
    return () => {
      users -= 1;
      if (users === 0) stop();
    };
  }, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
