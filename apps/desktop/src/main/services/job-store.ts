import { openJobStore, type JobStore } from "@nestor/db/job-store";
import { app } from "electron";
import path from "node:path";

import { resolveDesktopUserDataDirectory } from "../setup/user-data-directory";

let store: JobStore | null = null;

export function getJobStoreFilePath(): string {
  return path.join(resolveDesktopUserDataDirectory(app), "job-finder.sqlite");
}

/** The Job Finder store, opened on first use. Main process only. */
export function getJobStore(): JobStore {
  store ??= openJobStore(getJobStoreFilePath());
  return store;
}

export function closeJobStore(): void {
  store?.close();
  store = null;
}
