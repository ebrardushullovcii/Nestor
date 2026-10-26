import { ACTIVITY_FEED_CHANNEL } from "@nestor/contracts";
import { createActivityStore, type ActivityStore } from "@nestor/db/job-store";
import type { IpcMain } from "electron";

import { getJobStore } from "../services/job-store";

let activity: ActivityStore | null = null;

export function registerActivityRoutes(ipcMain: IpcMain): void {
  ipcMain.handle(ACTIVITY_FEED_CHANNEL, () => {
    activity ??= createActivityStore(getJobStore());
    return activity.feed();
  });
}
