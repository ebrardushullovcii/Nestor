import { parentPort, workerData } from "node:worker_threads";
import {
  prepareWorkspaceQueryDatabase,
  completeWorkspaceDatabaseMigrations,
} from "@nestor/db";

async function prepare() {
  const port = parentPort;
  if (!port) throw new Error("Workspace preparation requires a worker.");
  try {
    prepareWorkspaceQueryDatabase(String(workerData), () =>
      port.postMessage("context-ready"),
    );
    port.postMessage("index-ready");
    port.postMessage("queries-ready");
    await completeWorkspaceDatabaseMigrations(String(workerData), () =>
      port.postMessage("writer-ready"),
    );
    port.postMessage("complete");
  } finally {
    port.close();
  }
}
void prepare().catch((error: unknown) => {
  throw error;
});
