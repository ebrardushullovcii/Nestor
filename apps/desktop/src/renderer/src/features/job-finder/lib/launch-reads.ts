import { useSyncExternalStore } from "react";
import type { WorkspaceStartupContext } from "@nestor/contracts";

/**
 * Settings and setup state for the first frame, read straight from the
 * database at launch: the theme, the side menu and Home's guided-setup
 * redirect use them before any screen loads the old workspace.
 */
export interface LaunchReads {
  context: WorkspaceStartupContext | null;
}

let reads: LaunchReads = { context: null };
let started = false;
const listeners = new Set<() => void>();

/** Asks once per window; a missing or failing query leaves the defaults. */
export function startLaunchReads(): void {
  if (started) return;
  started = true;
  const queries =
    typeof window === "undefined"
      ? undefined
      : window.nestor?.jobFinder?.queries;
  if (!queries) return;
  void queries
    .getStartupContext()
    .then((context) => {
      reads = { context };
      for (const listener of listeners) listener();
    })
    .catch(() => undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const readLaunchReads = () => reads;

export function useLaunchReads(): LaunchReads {
  return useSyncExternalStore(subscribe, readLaunchReads, readLaunchReads);
}
