import { parentPort, workerData } from "node:worker_threads";
import {
  prepareWorkspaceQueryDatabase,
  prepareWorkspaceQuerySchema,
  completeWorkspaceDatabaseMigrations,
} from "@nestor/db";

async function prepare() {
  const port = parentPort;
  if (!port) throw new Error("Workspace preparation requires a worker.");
  try {
    prepareWorkspaceQuerySchema(String(workerData));
    port.postMessage("context-ready");
    // Missing indexes use the same SQL against original rows on the reader.
    // A compatible old index remains visible while its replacement commits.
    port.postMessage("queries-ready");
    prepareWorkspaceQueryDatabase(String(workerData));
    port.postMessage("index-ready");
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
