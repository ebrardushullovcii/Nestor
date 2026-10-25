import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { getJobFinderWorkspaceFilePath } from "../services/job-finder/paths";

let startup:
  | {
      context: Promise<void>;
      queries: Promise<void>;
      writer: Promise<boolean>;
      complete: Promise<void>;
    }
  | undefined;

/** One temporary worker prepares reads, then converts evidence in background. */
function prepare() {
  if (startup) return startup;
  const file = getJobFinderWorkspaceFilePath();
  if (!existsSync(file)) {
    startup = {
      context: Promise.resolve(),
      queries: Promise.resolve(),
      writer: Promise.resolve(false),
      complete: Promise.resolve(),
    };
    return startup;
  }
  const worker = new Worker(
    new URL("./workspace-database-startup-worker.cjs", import.meta.url),
    { workerData: file, execArgv: [] },
  );
  let resolveQueries: () => void;
  let resolveContext: () => void;
  let rejectContext: (error: Error) => void;
  let rejectQueries: (error: Error) => void;
  let resolveComplete: () => void;
  let rejectComplete: (error: Error) => void;
  let resolveWriter: (ready: boolean) => void;
  let rejectWriter: (error: Error) => void;
  const writer = new Promise<boolean>((resolve, reject) => {
    resolveWriter = resolve;
    rejectWriter = reject;
  });
  const context = new Promise<void>((resolve, reject) => {
    resolveContext = resolve;
    rejectContext = reject;
  });
  const queries = new Promise<void>((resolve, reject) => {
    resolveQueries = resolve;
    rejectQueries = reject;
  });
  const complete = new Promise<void>((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  worker.on("message", (message: unknown) => {
    if (message === "context-ready") resolveContext();
    if (message === "queries-ready") resolveQueries();
    if (message === "writer-ready") resolveWriter(true);
    if (message === "complete") resolveComplete();
  });
  worker.once("error", (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    rejectContext(error);
    rejectQueries(error);
    rejectComplete(error);
    rejectWriter(error);
  });
  worker.once("exit", (code) => {
    if (code !== 0) {
      const error = new Error("Workspace preparation could not finish.");
      rejectContext(error);
      rejectQueries(error);
      rejectComplete(error);
      rejectWriter(error);
    }
  });
  // Canonical service opening owns corruption recovery and its disclosure.
  // Retain rejection for callers without an unhandled background rejection.
  void queries.catch(() => undefined);
  void context.catch(() => undefined);
  void complete.catch(() => undefined);
  void writer.catch(() => undefined);
  startup = { context, queries, writer, complete };
  return startup;
}

export function prepareWorkspaceStartupContextReads(): Promise<void> {
  return prepare().context;
}

export function prepareWorkspaceScreenReads(): Promise<void> {
  return prepare().queries;
}

export async function waitForWorkspaceDatabaseMigrations(): Promise<void> {
  await prepare().complete.catch(() => undefined);
}

export async function prepareWorkspaceWriter(): Promise<boolean> {
  // Canonical opening retains the single corruption-recovery path on failure.
  return prepare().writer.catch(() => false);
}
