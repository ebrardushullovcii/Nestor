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
let pending: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function read(): void {
  // Hosts without the bridge (tests of other screens) have no Activity.
  const activity = window.nestor?.activity;
  if (!activity) return;
  const settle = (next: ActivityFeedState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  void activity.feed().then(
    (feed) => settle({ feed, failed: false }),
    () => settle({ feed: state.feed, failed: true }),
  );
}

/** Reads again soon; a burst of changes becomes one read. */
export function refreshActivityFeed(): void {
  if (pending !== null) return;
  pending = setTimeout(() => {
    pending = null;
    read();
  }, 250);
}

function start(): void {
  if (started || typeof window === "undefined" || !window.nestor?.activity)
    return;
  started = true;
  afterFirstScreen(() => {
    read();
    window.nestor.jobs.onChange?.(refreshActivityFeed);
    window.nestor.jobs.onSearchStatus?.(refreshActivityFeed);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => state;

export function useActivityFeed(): ActivityFeedState {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
