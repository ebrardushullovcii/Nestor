import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { getJobFinderWorkspaceFilePath } from "../services/job-finder/paths";

let startup: { queries: Promise<void>; complete: Promise<void> } | undefined;

/** One temporary worker prepares reads, then converts evidence in background. */
function prepare() {
  if (startup) return startup;
  const file = getJobFinderWorkspaceFilePath();
  if (!existsSync(file)) {
    startup = { queries: Promise.resolve(), complete: Promise.resolve() };
    return startup;
  }
  const worker = new Worker(
    new URL("./workspace-database-startup-worker.cjs", import.meta.url),
    { workerData: file, execArgv: [] },
  );
  let resolveQueries: () => void;
  let rejectQueries: (error: Error) => void;
  let resolveComplete: () => void;
  let rejectComplete: (error: Error) => void;
  const queries = new Promise<void>((resolve, reject) => {
    resolveQueries = resolve;
    rejectQueries = reject;
  });
  const complete = new Promise<void>((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  worker.on("message", (message: unknown) => {
    if (message === "queries-ready") resolveQueries();
    if (message === "complete") resolveComplete();
  });
  worker.once("error", (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    rejectQueries(error);
    rejectComplete(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error("Workspace preparation could not finish.");
      rejectQueries(error);
      rejectComplete(error);
    }
  });
  // Canonical service opening owns corruption recovery and its disclosure.
  // Retain rejection for callers without an unhandled background rejection.
  void queries.catch(() => undefined);
  void complete.catch(() => undefined);
  startup = { queries, complete };
  return startup;
}

export function prepareWorkspaceScreenReads(): Promise<void> {
  return prepare().queries;
}

export async function waitForWorkspaceDatabaseMigrations(): Promise<void> {
  await prepare().complete.catch(() => undefined);
}
