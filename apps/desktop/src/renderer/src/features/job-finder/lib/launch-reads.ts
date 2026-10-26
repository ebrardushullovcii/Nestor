import { useSyncExternalStore } from "react";
import type { LaunchContext } from "@nestor/contracts";

/**
 * Settings and setup state for the first frame, read straight from the
 * database at launch: the theme, the side menu and Home's guided-setup
 * redirect use them before any screen loads the old workspace.
 */
export interface LaunchReads {
  context: LaunchContext | null;
}

let reads: LaunchReads = { context: null };
let started = false;
const listeners = new Set<() => void>();

/**
 * Asks once per window, and again whenever settings or the profile change, so
 * the theme and guided setup follow Settings, setup and Reset. A missing or
 * failing query leaves what was read last.
 */
export function startLaunchReads(): void {
  if (started) return;
  started = true;
  const nestor = typeof window === "undefined" ? undefined : window.nestor;
  const read = nestor?.launchContext;
  if (!read) return;
  let sequence = 0;
  const refresh = () => {
    const current = ++sequence;
    void read()
      .then((context) => {
        if (current !== sequence) return;
        reads = { context };
        for (const listener of listeners) listener();
      })
      .catch(() => undefined);
  };
  refresh();
  nestor.jobs?.onChange((change) => {
    if (change.cause === "settings" || change.cause === "profile") refresh();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const readLaunchReads = () => reads;

export function useLaunchReads(): LaunchReads {
  return useSyncExternalStore(subscribe, readLaunchReads, readLaunchReads);
}
