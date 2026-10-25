import {
  JOBS_CHANGED_CHANNEL,
  JOBS_RUN_CHANNEL,
  JOBS_SUBSCRIBE_CHANNEL,
  type JobCommandName,
} from "@nestor/contracts";
import {
  createJobCommandRunner,
  type RunJobCommand,
} from "@nestor/job-finder/job-commands";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import { getJobStore } from "./job-store";

const subscribers = new Set<WebContents>();

/** Sends to every window that asked for job changes. */
export function broadcastToJobSubscribers(channel: string, payload: unknown) {
  for (const contents of subscribers) {
    if (contents.isDestroyed()) subscribers.delete(contents);
    else contents.send(channel, payload);
  }
}

let runner: RunJobCommand | null = null;

/** The same commands the screens use; the Assistant calls this directly. */
export function runJobCommand<K extends JobCommandName>(
  name: K,
  input: unknown,
) {
  runner ??= createJobCommandRunner({ store: getJobStore() });
  return runner(name, input);
}

function fromMainFrame(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame === event.sender.mainFrame;
}

/** Registered at startup, so the first screen never waits on old services. */
export function registerJobRoutes(ipcMain: IpcMain): void {
  ipcMain.handle(JOBS_RUN_CHANNEL, (event, request: unknown) => {
    if (!fromMainFrame(event)) throw new Error("Not allowed.");
    const { name, input } = (request ?? {}) as {
      name?: unknown;
      input?: unknown;
    };
    return runJobCommand(String(name) as JobCommandName, input);
  });
  ipcMain.handle(JOBS_SUBSCRIBE_CHANNEL, (event) => {
    if (!fromMainFrame(event)) throw new Error("Not allowed.");
    const contents = event.sender;
    if (!subscribers.has(contents)) {
      subscribers.add(contents);
      contents.once("destroyed", () => subscribers.delete(contents));
    }
    return { ok: true as const };
  });
  getJobStore().onChange((change) =>
    broadcastToJobSubscribers(JOBS_CHANGED_CHANNEL, change),
  );
}
