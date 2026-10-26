import { JobChangeSchema } from "@nestor/contracts";
import {
  createApplicationStore,
  type ApplicationStore,
} from "@nestor/db/applications";
import { BrowserWindow } from "electron";

import { getJobStore } from "../job-store";

const stores = new WeakMap<ReturnType<typeof getJobStore>, ApplicationStore>();

export function getApplicationStore(): ApplicationStore {
  const jobs = getJobStore();
  let applications = stores.get(jobs);
  if (!applications) {
    applications = createApplicationStore(jobs);
    stores.set(jobs, applications);
    jobs.onChange((change) => {
      if (
        change.cause !== "application" &&
        !change.stages.some(
          (stage) => stage === "resume" || stage === "applied",
        )
      )
        return;
      // Checked here, since the preload passes it through.
      const checked = JobChangeSchema.safeParse(change);
      if (!checked.success) return;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) {
          window.webContents.send(
            "job-finder:applications-changed",
            checked.data,
          );
        }
      }
    });
  }
  return applications;
}
