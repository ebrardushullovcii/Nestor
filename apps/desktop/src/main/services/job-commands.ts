import {
  JOBS_CHANGED_CHANNEL,
  JOBS_RUN_CHANNEL,
  JOBS_SEARCH_STATUS_CHANNEL,
  JOBS_SUBSCRIBE_CHANNEL,
  type JobCommandName,
  type JobSearchStatus,
} from "@nestor/contracts";
import {
  createJobCommandRunner,
  type JobSearchControl,
  type RunJobCommand,
} from "@nestor/job-finder/job-commands";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";

import { getJobStore } from "./job-store";

/** A search runner that also reports its progress. */
export interface JobSearchService extends JobSearchControl {
  onStatus(listener: (status: JobSearchStatus) => void): () => void;
}

let searchService: JobSearchService | null = null;
let searchServicePending: Promise<JobSearchService> | null = null;
let createSearchService: (() => Promise<JobSearchService>) | null = null;
const subscribers = new Set<WebContents>();

/** Sends to every window that asked for job changes. */
export function broadcastToJobSubscribers(channel: string, payload: unknown) {
  for (const contents of subscribers) {
    if (contents.isDestroyed()) subscribers.delete(contents);
    else contents.send(channel, payload);
  }
}

/** Main supplies how to build the search once the browser and AI exist. */
export function setJobSearchServiceFactory(
  factory: () => Promise<JobSearchService>,
): void {
  createSearchService = factory;
}

async function getSearchService(): Promise<JobSearchService> {
  if (searchService) return searchService;
  if (!createSearchService) {
    // The search runs on the workspace's browser and AI; starting the
    // workspace registers how to build it.
    const { getJobFinderWorkspaceService } = await import("./job-finder");
    await getJobFinderWorkspaceService();
  }
  if (!createSearchService) {
    throw new Error("Search could not start. Try again in a moment.");
  }
  searchServicePending ??= createSearchService().then((service) => {
    searchService = service;
    service.onStatus((status) =>
      broadcastToJobSubscribers(JOBS_SEARCH_STATUS_CHANNEL, status),
    );
    return service;
  });
  try {
    return await searchServicePending;
  } catch (error) {
    searchServicePending = null;
    throw error;
  }
}

/** Scores jobs a closed app left without a fit. */
function scoreUnscoredJobs(): void {
  void getSearchService()
    .then((service) => service.scoreUnscored())
    .catch((error: unknown) => {
      console.warn("[Desktop] Could not score saved jobs.", error);
    });
}

let runner: RunJobCommand | null = null;

/** The same commands the screens use; the Assistant calls this directly. */
export function runJobCommand<K extends JobCommandName>(
  name: K,
  input: unknown,
) {
  runner ??= createJobCommandRunner({
    store: getJobStore(),
    search: getSearchService,
    currentSearch: () => searchService,
  });
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
  const store = getJobStore();
  store.onChange((change) =>
    broadcastToJobSubscribers(JOBS_CHANGED_CHANNEL, change),
  );
  if (store.unscoredJobIds(1).length > 0) {
    setTimeout(scoreUnscoredJobs, 5_000).unref?.();
  }
}
