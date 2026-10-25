import { parentPort } from "node:worker_threads";
import type {
  DiscoveryCpuRequest,
  DiscoveryCpuResponse,
} from "@nestor/contracts";
import { runDiscoveryCpuTask } from "@nestor/job-finder/discovery-cpu";

if (!parentPort)
  throw new Error("The feed reader must run in a worker thread.");
const port = parentPort;
async function readFeed({ id, task }: DiscoveryCpuRequest): Promise<void> {
  let response: DiscoveryCpuResponse;
  try {
    response = { id, result: await runDiscoveryCpuTask(task) };
  } catch (error) {
    response = {
      id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
}
port.on("message", (request: DiscoveryCpuRequest) => {
  void readFeed(request);
});
