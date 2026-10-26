import {
  carryOverOldPause,
  openJobStore,
  resetJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { app } from "electron";
import path from "node:path";

import { resolveDesktopUserDataDirectory } from "../setup/user-data-directory";
import { getJobFinderWorkspaceFilePath } from "./job-finder/paths";
import {
  readPendingResetIntentSync,
  recordStartupResetRecoveryFact,
} from "./job-finder/reset-intent-marker";

let store: JobStore | null = null;

export function getJobStoreFilePath(): string {
  return path.join(resolveDesktopUserDataDirectory(app), "job-finder.sqlite");
}

/** The Job Finder store, opened on first use. Main process only. */
export function getJobStore(): JobStore {
  if (store) return store;
  const opened = openJobStore(getJobStoreFilePath());
  // A confirmed reset that stopped part way finishes clearing the store
  // before any screen reads it; the workspace's own recovery handles the
  // rest. A marker that can't be read clears nothing: the person is told the
  // reset didn't finish and can start it again.
  const pending = readPendingResetIntentSync();
  try {
    if (pending.status === "readable") resetJobStore(opened);
    // Once per store: a pause set before this update stays set.
    carryOverOldPause(opened, getJobFinderWorkspaceFilePath());
  } catch (error) {
    // Not kept: the next use tries again, and a reset marker stays.
    opened.close();
    throw error;
  }
  store = opened;
  if (pending.status === "unreadable")
    recordStartupResetRecoveryFact({
      status: "degraded",
      reason: "marker_unreadable",
      quarantinedFileName: null,
    });
  return store;
}

export function closeJobStore(): void {
  store?.close();
  store = null;
}
