import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import type {
  DiscoveryCpuRequest,
  DiscoveryCpuResponse,
  DiscoveryFeedTask,
  DiscoveryFeedResult,
} from "@nestor/contracts";

type Work = {
  id: number;
  task: DiscoveryFeedTask | null;
  resolve: (result: DiscoveryFeedResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};
type Slot = {
  worker: Worker;
  work: Work | null;
  idle: ReturnType<typeof setTimeout> | null;
};

/** Two CPU readers leave cores available for the window, browser and SQLite. */
export function createDiscoveryCpuPool(
  entry: string | URL,
  size = Math.min(2, Math.max(1, availableParallelism() - 1)),
) {
  const slots = new Set<Slot>();
  const queued: Work[] = [];
  let sequence = 0;
  let closed = false;
  const abortError = () => new DOMException("Aborted", "AbortError");

  const fail = (slot: Slot, error: Error) => {
    if (!slots.delete(slot)) return;
    if (slot.idle) clearTimeout(slot.idle);
    const work = slot.work;
    slot.work = null;
    work?.cleanup();
    work?.reject(error);
    void slot.worker.terminate();
    pump();
  };
  const startSlot = (): Slot => {
    // Electron's main preload and inspector flags must not run inside a reader.
    const worker = new Worker(entry, { execArgv: [] });
    const slot: Slot = { worker, work: null, idle: null };
    slots.add(slot);
    worker.on("message", (response: DiscoveryCpuResponse) => {
      const work = slot.work;
      if (!work || response.id !== work.id) return;
      slot.work = null;
      work.cleanup();
      if (response.error !== undefined) work.reject(new Error(response.error));
      else work.resolve(response.result);
      worker.unref();
      pump();
      if (!slot.work && !closed) {
        // A finished feed must not leave an idle isolate holding its last
        // board's parsing heap for the rest of the app session.
        slot.idle = setTimeout(() => {
          slot.idle = null;
          if (slot.work || !slots.delete(slot)) return;
          void worker.terminate();
        }, 5_000);
        slot.idle.unref();
      }
    });
    worker.on("error", (error: Error) => fail(slot, error));
    worker.on("exit", (code) =>
      fail(slot, new Error(`Feed reader exited (${code}).`)),
    );
    worker.unref();
    return slot;
  };
  function pump(): void {
    while (!closed && queued.length > 0) {
      const slot =
        [...slots].find((candidate) => !candidate.work) ??
        (slots.size < size ? startSlot() : null);
      if (!slot) return;
      if (slot.idle) clearTimeout(slot.idle);
      slot.idle = null;
      const work = queued.shift()!;
      slot.work = work;
      slot.worker.ref();
      try {
        const task = work.task;
        if (!task) throw new Error("Feed task has already been dispatched.");
        slot.worker.postMessage({
          id: work.id,
          task,
        } satisfies DiscoveryCpuRequest);
        work.task = null;
      } catch (error) {
        fail(slot, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  return {
    run(
      task: DiscoveryFeedTask,
      signal?: AbortSignal,
    ): Promise<DiscoveryFeedResult> {
      if (closed) return Promise.reject(new Error("Feed reader is closed."));
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const work: Work = {
          id: ++sequence,
          task,
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener("abort", abort),
        };
        const abort = () => {
          const position = queued.indexOf(work);
          if (position >= 0) {
            queued.splice(position, 1);
            work.cleanup();
            reject(abortError());
          } else {
            const slot = [...slots].find(
              (candidate) => candidate.work === work,
            );
            if (slot) fail(slot, abortError());
          }
        };
        signal?.addEventListener("abort", abort, { once: true });
        queued.push(work);
        pump();
      });
    },
    async close(): Promise<void> {
      closed = true;
      for (const work of queued.splice(0)) {
        work.cleanup();
        work.reject(abortError());
      }
      const closing = [...slots];
      slots.clear();
      await Promise.all(
        closing.map(async ({ worker, work, idle }) => {
          if (idle) clearTimeout(idle);
          work?.cleanup();
          work?.reject(abortError());
          await worker.terminate();
        }),
      );
    },
  };
}
