import { parentPort, workerData } from "node:worker_threads";
import {
  prepareWorkspaceQueryDatabase,
  completeWorkspaceDatabaseMigrations,
} from "@nestor/db";

if (!parentPort) throw new Error("Workspace preparation requires a worker.");
try {
  prepareWorkspaceQueryDatabase(String(workerData));
  parentPort.postMessage("queries-ready");
  completeWorkspaceDatabaseMigrations(String(workerData));
  parentPort.postMessage("complete");
} finally {
  parentPort.close();
}
