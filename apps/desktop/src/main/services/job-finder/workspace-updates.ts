import { BrowserWindow, type WebContents } from "electron";

export const JOB_FINDER_WORKSPACE_UPDATED_CHANNEL =
  "job-finder:workspace-updated";

const workspaceUpdateListeners = new Set<() => void>();

/**
 * Main-process listeners told about every workspace update (the assistant
 * watches its background runs this way instead of polling).
 */
export function onJobFinderWorkspaceUpdate(listener: () => void): () => void {
  workspaceUpdateListeners.add(listener);
  return () => workspaceUpdateListeners.delete(listener);
}

/** Tells only the main-process listeners; no window is asked to sync. */
export function notifyJobFinderWorkspaceListeners(): void {
  for (const listener of workspaceUpdateListeners) {
    try {
      listener();
    } catch {
      // A listener never blocks the renderer update.
    }
  }
}

/** Tells mounted renderers to converge through the existing delta sync. */
export function publishJobFinderWorkspaceUpdate(target?: WebContents): void {
  notifyJobFinderWorkspaceListeners();
  if (target) {
    const canSend = typeof target.send === "function";
    const isDestroyed =
      typeof target.isDestroyed === "function" && target.isDestroyed();
    if (canSend && !isDestroyed) {
      target.send(JOB_FINDER_WORKSPACE_UPDATED_CHANNEL);
    }
    return;
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(JOB_FINDER_WORKSPACE_UPDATED_CHANNEL);
    }
  }
}

const FIRST_UPDATE_DELAY_MS = 500;

/** Keep active work visible while its IPC response waits for the browser. */
export async function withJobFinderWorkspaceUpdates<T>(
  target: WebContents,
  operation: () => Promise<T>,
): Promise<T> {
  // The first write of an operation (a step moving to checking, a run
  // starting) lands within moments; show it then, not after the first beat.
  const first = setTimeout(
    () => publishJobFinderWorkspaceUpdate(target),
    FIRST_UPDATE_DELAY_MS,
  );
  const heartbeat = setInterval(
    () => publishJobFinderWorkspaceUpdate(target),
    3_000,
  );
  try {
    return await operation();
  } finally {
    clearTimeout(first);
    clearInterval(heartbeat);
    publishJobFinderWorkspaceUpdate(target);
  }
}

let draftUpdateTimer: ReturnType<typeof setTimeout> | undefined;

/** Persist keystrokes immediately, but coalesce the workspace refresh. */
export function scheduleAnswerDraftWorkspaceUpdate(): void {
  if (draftUpdateTimer) clearTimeout(draftUpdateTimer);
  draftUpdateTimer = setTimeout(() => {
    draftUpdateTimer = undefined;
    publishJobFinderWorkspaceUpdate();
  }, 150);
}
