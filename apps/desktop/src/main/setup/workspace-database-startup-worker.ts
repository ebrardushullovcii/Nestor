import { parentPort, workerData } from "node:worker_threads";
import {
  prepareWorkspaceQueryDatabase,
  prepareWorkspaceQuerySchema,
  completeWorkspaceDatabaseMigrations,
} from "@nestor/db";

if (!parentPort) throw new Error("Workspace preparation requires a worker.");
try {
  prepareWorkspaceQuerySchema(String(workerData));
  parentPort.postMessage("context-ready");
  prepareWorkspaceQueryDatabase(String(workerData));
  parentPort.postMessage("queries-ready");
  completeWorkspaceDatabaseMigrations(String(workerData));
  parentPort.postMessage("complete");
} finally {
  parentPort.close();
}
