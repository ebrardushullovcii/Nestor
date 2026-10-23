import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  ResumeComputationRequest,
  ResumeComputationResponse,
  ResumeDraftProcessor,
} from "@nestor/contracts";

/** One lazy worker per workspace. No database, AI client or Electron access. */
export function createResumeDraftProcessor(): ResumeDraftProcessor {
  let worker: Worker | undefined;
  let sequence = 0;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (response: ResumeComputationResponse) => void;
      reject: (error: Error) => void;
    }
  >();
  const run = (
    request: ResumeComputationRequest,
  ): Promise<ResumeComputationResponse> => {
    if (closed)
      return Promise.reject(new Error("Resume document worker is closed."));
    if (!worker) {
      const current = new Worker(
        path.join(__dirname, "resume-computation-worker.cjs"),
        { execArgv: [] },
      );
      worker = current;
      current.on("message", (response: ResumeComputationResponse) => {
        const task = pending.get(response.id);
        if (!task) return;
        pending.delete(response.id);
        if (response.kind === "error") task.reject(new Error(response.message));
        else task.resolve(response);
      });
      const failed = (error: Error) => {
        if (worker !== current) return;
        worker = undefined;
        for (const task of pending.values()) task.reject(error);
        pending.clear();
      };
      current.on("error", failed);
      current.on("exit", () =>
        failed(new Error("Resume document worker stopped.")),
      );
      // The worker must not keep Electron alive after its windows close.
      current.unref();
    }
    return new Promise((resolve, reject) => {
      pending.set(request.id, { resolve, reject });
      try {
        worker!.postMessage(request);
      } catch (error) {
        pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  return {
    async inspectPdf(filePath) {
      const response = await run({
        id: ++sequence,
        kind: "inspectPdf",
        input: filePath,
      });
      if (response.kind !== "inspectPdf")
        throw new Error("Unexpected PDF inspection response.");
      return response.result;
    },
    async render(input) {
      const response = await run({ id: ++sequence, kind: "render", input });
      if (response.kind !== "render")
        throw new Error("Unexpected resume rendering response.");
      return response.result;
    },
    async parse(input) {
      const response = await run({ id: ++sequence, kind: "parse", input });
      if (response.kind !== "parse")
        throw new Error("Unexpected resume parse response.");
      return response.result;
    },
    async close() {
      closed = true;
      for (const task of pending.values())
        task.reject(new Error("Resume document worker is closed."));
      pending.clear();
      await worker?.terminate();
      worker = undefined;
    },
    async stateHash(input) {
      const response = await run({ id: ++sequence, kind: "stateHash", input });
      if (response.kind !== "stateHash")
        throw new Error("Unexpected resume hash response.");
      return response.result;
    },
    async revision(input) {
      const response = await run({ id: ++sequence, kind: "revision", input });
      if (response.kind !== "revision")
        throw new Error("Unexpected resume revision response.");
      return response.result;
    },
    async sanitize(input) {
      const response = await run({ id: ++sequence, kind: "sanitize", input });
      if (response.kind !== "sanitize")
        throw new Error("Unexpected resume sanitizer response.");
      return response.result;
    },
    async validate(input) {
      const response = await run({ id: ++sequence, kind: "validate", input });
      if (response.kind !== "validate")
        throw new Error("Unexpected resume validator response.");
      return response.result;
    },
  };
}
