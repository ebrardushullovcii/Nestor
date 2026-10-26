import {
  openJobStore,
  resetJobStore,
  type JobStore,
} from "@nestor/db/job-store";
import { app } from "electron";
import path from "node:path";

import { resolveDesktopUserDataDirectory } from "../setup/user-data-directory";
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
  store = openJobStore(getJobStoreFilePath());
  // A confirmed reset that stopped part way finishes clearing the store
  // before any screen reads it; the workspace's own recovery handles the
  // rest. A marker that can't be read clears nothing: the person is told the
  // reset didn't finish and can start it again.
  const pending = readPendingResetIntentSync();
  if (pending.status === "readable") resetJobStore(store);
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
