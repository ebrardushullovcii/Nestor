import { HOME_SUMMARY_CHANNEL } from "@nestor/contracts";
import { createHomeStore, type HomeStore } from "@nestor/db/job-store";
import type { IpcMain } from "electron";

import { getJobStore } from "../services/job-store";

let home: HomeStore | null = null;

export function registerHomeRoutes(ipcMain: IpcMain): void {
  ipcMain.handle(HOME_SUMMARY_CHANNEL, (_event, input: unknown) => {
    home ??= createHomeStore(getJobStore());
    return home.summary(input as Parameters<HomeStore["summary"]>[0]);
  });
}
