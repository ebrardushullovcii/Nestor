import {
  TRACKER_EXPORT_CHANNEL,
  TRACKER_RUN_CHANNEL,
  TRACKER_STATUS_LABEL,
  TrackerExportInputSchema,
  type TrackerCommandName,
  type TrackerRow,
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

function csvCell(value: string | null): string {
  const text = value ?? "";
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

const CSV_COLUMNS: readonly [string, (row: TrackerRow) => string | null][] = [
  ["Company", (row) => row.company],
  ["Job", (row) => row.title],
  ["Location", (row) => row.location],
  ["Status", (row) => TRACKER_STATUS_LABEL[row.status]],
  ["Status since", (row) => row.statusAt.slice(0, 10)],
  ["Applied", (row) => row.appliedAt?.slice(0, 10) ?? null],
  ["Next", (row) => row.nextTitle],
  ["Next on", (row) => row.nextAt?.slice(0, 16).replace("T", " ") ?? null],
  ["Tags", (row) => row.tags.join("; ")],
];

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
  const lines = [CSV_COLUMNS.map(([header]) => header).join(",")];
  for (const row of createTrackerStore(getJobStore()).each(filter))
    lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(row))).join(","));
  await writeFile(target, `${lines.join("\r\n")}\r\n`, "utf8");
  return { outputPath: target, rows: lines.length - 1 };
}
