import { useSyncExternalStore } from "react";
import type {
  JobFinderRendererWorkspaceSnapshot,
  JobFinderSettings,
} from "@nestor/contracts";
import type { JobFinderWorkspaceState } from "@renderer/features/job-finder/hooks/use-job-finder-workspace";
import type { JobFinderPageContext } from "./job-finder-page-context";
import type { JobFinderSaveState } from "./job-finder-save-state";

/**
 * What the page reads from the old whole-workspace controller. The controller
 * is its own chunk, loaded only once a screen asks for the old workspace
 * (Profile, setup, Settings, Activity, the command palette); until then, and
 * again once it unmounts, the page draws from the store and this view is null.
 */
export interface LegacyControllerView {
  appearanceTheme: JobFinderSettings["appearanceTheme"] | null;
  context: JobFinderPageContext | null;
  dismissSavedStatus: () => void;
  navigateFromShell: (path: string) => void;
  platform: "darwin" | "linux" | "win32" | undefined;
  retryLastSave: () => void;
  saveState: JobFinderSaveState;
  workspace: JobFinderRendererWorkspaceSnapshot | null;
  workspaceState: JobFinderWorkspaceState;
}

let view: LegacyControllerView | null = null;
const listeners = new Set<() => void>();

export function publishLegacyControllerView(
  next: LegacyControllerView | null,
): void {
  if (view === next) return;
  view = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => view;

export function useLegacyControllerView(): LegacyControllerView | null {
  return useSyncExternalStore(subscribe, read, read);
}
