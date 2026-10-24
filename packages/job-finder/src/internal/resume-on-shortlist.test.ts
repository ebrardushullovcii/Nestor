import { describe, expect, it, vi } from "vitest";
import type { ResumeBatchGenerationResult } from "@nestor/contracts";
import {
  createResumeOnShortlist,
  type ResumeOnShortlistDeps,
} from "./resume-on-shortlist";

type Outcome = ResumeBatchGenerationResult["outcome"];

function harness(
  options: {
    enabled?: boolean;
    paused?: boolean;
    needing?: (ids: readonly string[]) => readonly string[];
    queue?: string[];
  } = {},
) {
  let queue = [...(options.queue ?? [])];
  const state = {
    enabled: options.enabled ?? true,
    paused: options.paused ?? false,
    closing: false,
  };
  const writes = new Map<
    string,
    { resolve: (outcome: Outcome) => void; shouldStop: () => boolean }
  >();
  const retries: Array<() => void> = [];
  const deps: ResumeOnShortlistDeps = {
    isEnabled: () => Promise.resolve(state.enabled),
    isPaused: () => Promise.resolve(state.paused),
    isClosing: () => state.closing,
    needingResume: (ids) => Promise.resolve(options.needing?.(ids) ?? ids),
    readQueue: () => Promise.resolve([...queue]),
    updateQueue: (change) => {
      queue = [...change(queue)];
      return Promise.resolve();
    },
    generate: vi.fn(
      (jobId: string, shouldStop: () => boolean) =>
        new Promise<ResumeBatchGenerationResult>((resolve) => {
          if (shouldStop()) {
            resolve({ jobId, outcome: "not_started" });
            return;
          }
          writes.set(jobId, {
            shouldStop,
            resolve: (outcome) => resolve({ jobId, outcome }),
          });
        }),
    ),
    cancelInFlight: vi.fn((jobId: string) => {
      writes.get(jobId)?.resolve("cancelled");
    }),
    onChange: vi.fn(),
    retryLater: (run) => retries.push(run),
  };
  const controller = createResumeOnShortlist(deps);
  const settle = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };
  return {
    controller,
    deps,
    state,
    writes,
    retries,
    settle,
    queue: () => queue,
    finish: async (jobId: string, outcome: Outcome = "written") => {
      writes.get(jobId)!.resolve(outcome);
      writes.delete(jobId);
      await settle();
    },
  };
}

describe("resumes written on shortlist", () => {
  it("starts every shortlisted job that needs a resume and keeps it until written", async () => {
    const h = harness({
      needing: (ids) => ids.filter((id) => id !== "original"),
    });
    await h.controller.request(["a", "b", "original"]);
    await h.settle();
    expect(h.queue()).toEqual(["a", "b"]);
    expect([...h.writes.keys()]).toEqual(["a", "b"]);
    await h.finish("a");
    expect(h.queue()).toEqual(["b"]);
    await h.finish("b", "fallback");
    expect(h.queue()).toEqual([]);
    expect(h.deps.onChange).toHaveBeenCalled();
  });

  it("does nothing while the switch is off or AI is missing", async () => {
    const h = harness({ enabled: false });
    await h.controller.request(["a"]);
    await h.settle();
    expect(h.queue()).toEqual([]);
    expect(h.deps.generate).not.toHaveBeenCalled();
  });

  it("asks nothing for jobs that already have a resume", async () => {
    const h = harness({ needing: () => [] });
    await h.controller.request(["a"]);
    expect(h.queue()).toEqual([]);
    expect(h.deps.onChange).not.toHaveBeenCalled();
  });

  it("does not start a job twice when it is shortlisted again while queued", async () => {
    const h = harness();
    await h.controller.request(["a"]);
    await h.controller.request(["a"]);
    await h.settle();
    expect(h.queue()).toEqual(["a"]);
    expect(h.deps.generate).toHaveBeenCalledTimes(1);
  });

  it("takes a job out when it is moved back, hidden or its shortlist undone", async () => {
    const h = harness({ paused: true });
    await h.controller.request(["a", "b"]);
    await h.controller.withdraw(["a"]);
    expect(h.queue()).toEqual(["b"]);
    expect(h.deps.cancelInFlight).not.toHaveBeenCalled();
  });

  it("cancels a resume that is being written, so no half draft is saved", async () => {
    const h = harness();
    await h.controller.request(["a"]);
    await h.settle();
    await h.controller.withdraw(["a"]);
    await h.settle();
    expect(h.deps.cancelInFlight).toHaveBeenCalledWith("a");
    expect(h.queue()).toEqual([]);
  });

  it("holds the queue while paused and starts it on Continue", async () => {
    const h = harness({ paused: true });
    await h.controller.request(["a", "b"]);
    await h.settle();
    expect(h.deps.generate).not.toHaveBeenCalled();
    expect(h.queue()).toEqual(["a", "b"]);
    h.state.paused = false;
    h.controller.pauseChanged(false);
    await h.settle();
    expect([...h.writes.keys()]).toEqual(["a", "b"]);
  });

  it("keeps a job that a pause stopped before it started", async () => {
    const h = harness();
    await h.controller.request(["a"]);
    await h.settle();
    h.controller.pauseChanged(true);
    // The writer reads the stop before it takes a writer slot.
    expect(h.writes.get("a")!.shouldStop()).toBe(true);
    await h.finish("a", "not_started");
    expect(h.queue()).toEqual(["a"]);
    expect(h.retries).toHaveLength(0);
  });

  it("carries on after a restart from the saved list", async () => {
    const h = harness({ queue: ["a", "b"] });
    await h.controller.continue();
    await h.settle();
    expect([...h.writes.keys()]).toEqual(["a", "b"]);
  });

  it("keeps the jobs a shutdown aborted, so the next start writes them", async () => {
    const h = harness();
    await h.controller.request(["a", "b", "c"]);
    await h.settle();
    await h.finish("a");
    h.state.closing = true;
    // Closing aborts the one being written and the ones waiting their turn.
    await h.finish("b", "cancelled");
    await h.finish("c", "failed");
    expect(h.queue()).toEqual(["b", "c"]);
    expect(h.retries).toHaveLength(0);
  });

  it("tries again later when the AI service turned the job away", async () => {
    const h = harness();
    await h.controller.request(["a"]);
    await h.settle();
    await h.finish("a", "not_started");
    expect(h.queue()).toEqual(["a"]);
    expect(h.retries).toHaveLength(1);
    h.retries[0]!();
    await h.settle();
    expect(h.writes.has("a")).toBe(true);
  });

  it("drops a job whose resume failed or was blocked, leaving it as it is today", async () => {
    const h = harness();
    await h.controller.request(["a", "b"]);
    await h.settle();
    await h.finish("a", "failed");
    await h.finish("b", "blocked");
    expect(h.queue()).toEqual([]);
  });
});
