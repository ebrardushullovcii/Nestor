import {
  TRACKER_EXPORT_CHANNEL,
  TRACKER_RUN_CHANNEL,
  TrackerExportInputSchema,
  type TrackerCommandName,
} from "@nestor/contracts";
import { createTrackerStore } from "@nestor/db/job-store";
import {
  app,
  type WebContents,
  type IpcMain,
  type IpcMainInvokeEvent,
} from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { getJobStore } from "../services/job-store";
import {
  createTrackerCommandRunner,
  type RunTrackerCommand,
} from "../services/tracker-commands";
import { getRegisteredMainWindow } from "../setup/finished-work-notifier-instance";
import { chooseSavePath } from "./resume-export-path";
import { trackerCsv } from "./tracker-csv";

let runner: RunTrackerCommand | null = null;

/** The same commands the Applications screen uses; the Assistant calls this. */
export function runTrackerCommand<K extends TrackerCommandName>(
  name: K,
  input: unknown,
) {
  runner ??= createTrackerCommandRunner(getJobStore(), {
    exportApplications: (input) => exportTrackerCsv(input),
  });
  return runner(name, input);
}

function fromMainFrame(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame === event.sender.mainFrame;
}

export function registerTrackerRoutes(ipcMain: IpcMain): void {
  ipcMain.handle(TRACKER_RUN_CHANNEL, (event, request: unknown) => {
    if (!fromMainFrame(event)) throw new Error("Not allowed.");
    const { name, input } = (request ?? {}) as {
      name?: unknown;
      input?: unknown;
    };
    return runTrackerCommand(String(name) as TrackerCommandName, input);
  });

  // Exports what the list shows, as CSV a spreadsheet opens.
  ipcMain.handle(TRACKER_EXPORT_CHANNEL, async (event, payload: unknown) => {
    if (!fromMainFrame(event)) throw new Error("Not allowed.");
    return exportTrackerCsv(payload, event.sender);
  });
}

export async function exportTrackerCsv(
  payload: unknown,
  sender: WebContents | null = getRegisteredMainWindow()?.webContents ?? null,
) {
  const filter = TrackerExportInputSchema.parse(payload);
  const target = await chooseSavePath(
    sender,
    path.join(app.getPath("documents"), "Applications.csv"),
    { name: "CSV", extension: "csv", title: "Export applications" },
  );
  if (!target) return { outputPath: null, rows: 0 };
  const rows = [...createTrackerStore(getJobStore()).each(filter)];
  await writeFile(target, trackerCsv(rows), "utf8");
  return { outputPath: target, rows: rows.length };
}
