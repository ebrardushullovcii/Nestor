import type { ApplicationAutomationMode, ApplyQueue } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import {
  createApplyQueueRunner,
  leastPermissiveMode,
  type ApplyQueueRunnerDeps,
  type ApplyQueueStartedRun,
} from "./apply-queue-runner";

function ids(count: number, prefix = "job"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index + 1}`);
}

interface Harness {
  deps: ApplyQueueRunnerDeps;
  runs: Array<{
    jobIds: string[];
    mode: ApplicationAutomationMode;
    runId: string;
  }>;
  cancelled: string[];
  finishRun(index: number): void;
  queue(): ApplyQueue | null;
  state: {
    savedMode: ApplicationAutomationMode;
    paused: boolean;
    refuse: string | null;
    skip: Set<string>;
  };
}

function createHarness(
  initial: { remaining?: number; queue?: ApplyQueue | null } = {},
): Harness {
  let stored: ApplyQueue | null = initial.queue ?? null;
  const nowIso = "2026-10-23T14:00:00.000Z";
  const settlers: Array<() => void> = [];
  const runs: Harness["runs"] = [];
  const cancelled: string[] = [];
  const state: Harness["state"] = {
    savedMode: "autonomous_submit",
    paused: false,
    refuse: null,
    skip: new Set(),
  };
  const deps: ApplyQueueRunnerDeps = {
    loadQueue: () => Promise.resolve(stored ? structuredClone(stored) : null),
    saveQueue: (queue) => {
      stored = queue ? structuredClone(queue) : null;
      return Promise.resolve();
    },
    readSavedMode: () => Promise.resolve(state.savedMode),
    isActivityPaused: () => Promise.resolve(state.paused),
    startRun: (jobIds, mode): Promise<ApplyQueueStartedRun> => {
      if (state.refuse) return Promise.reject(new Error(state.refuse));
      const runId = `run_${runs.length + 1}`;
      const started = jobIds.filter((id) => !state.skip.has(id));
      runs.push({ jobIds: [...jobIds], mode, runId });
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      settlers.push(settle);
      return Promise.resolve({
        runId,
        startedJobIds: started,
        skipped: jobIds
          .filter((id) => state.skip.has(id))
          .map((jobId) => ({
            jobId,
            reason: "Its resume waits for your review.",
          })),
        settled,
      });
    },
    cancelRun: (runId) => {
      cancelled.push(runId);
      return Promise.resolve();
    },
    publish: () => undefined,
    now: () => new Date(nowIso),
    createId: () => "queue_1",
    onError: (error) => {
      throw error;
    },
  };
  return {
    deps,
    runs,
    cancelled,
    state,
    finishRun: (index) => settlers[index]!(),
    queue: () => stored,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("apply queue runner", () => {
  it("persists the assistant's exact grant binding before dispatch and stops if binding fails", async () => {
    const harness = createHarness();
    const runner = createApplyQueueRunner(harness.deps);
    let boundId: string | null = null;
    await runner.start(ids(12), "prepare_only", (queue) => {
      expect(harness.runs).toHaveLength(0);
      expect(harness.queue()).toBeNull();
      expect(queue.jobIds).toEqual(ids(12));
      queue.assistantScopes = [{ conversationId: "chat", jobIds: ids(12) }];
      boundId = queue.id;
      return Promise.resolve();
    });
    expect(harness.queue()?.id).toBe(boundId);
    expect(harness.queue()?.assistantScopes).toEqual([
      { conversationId: "chat", jobIds: ids(12) },
    ]);
    expect(harness.runs[0]?.mode).toBe("prepare_only");
    const failed = createHarness();
    const second = createApplyQueueRunner(failed.deps);
    await expect(
      second.start(ids(2), "autonomous_submit", () =>
        Promise.reject(new Error("Stopped before binding")),
      ),
    ).rejects.toThrow("Stopped before binding");
    expect(failed.runs).toHaveLength(0);
    expect(failed.queue()).toBeNull();
    runner.dispose();
    second.dispose();
  });

  it("does not interpret a queue-wide refusal as permission to skip jobs", async () => {
    for (const reason of [
      "Global pause",
      "Daily limit",
      "Abnormal failure rate",
      "These applications share an employer: untyped failure",
    ]) {
      const harness = createHarness();
      harness.state.refuse = reason;
      const runner = createApplyQueueRunner(harness.deps);
      await runner.start(ids(4), "autonomous_submit");
      expect(harness.queue()).toMatchObject({
        state: "paused",
        pausedReason: reason,
        startedJobIds: [],
        skipped: [],
      });
      expect(harness.runs).toHaveLength(0);
    }
  });

  it("chains runs of ten without another press until every job has started", async () => {
    const harness = createHarness();
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(25), "autonomous_submit");
    await settle();
    expect(harness.runs.map((run) => run.jobIds.length)).toEqual([10]);

    harness.finishRun(0);
    await settle();
    expect(harness.runs.map((run) => run.jobIds.length)).toEqual([10, 10]);
    expect(harness.runs[1]!.jobIds[0]).toBe("job_11");

    harness.finishRun(1);
    await settle();
    expect(harness.runs.map((run) => run.jobIds.length)).toEqual([10, 10, 5]);

    harness.finishRun(2);
    await settle();
    expect(harness.queue()?.state).toBe("done");
    expect(harness.queue()?.startedJobIds).toHaveLength(25);
  });

  it("survives a restart without starting a job twice", async () => {
    const first = createHarness();
    const runner = createApplyQueueRunner(first.deps);
    await runner.start(ids(15), "autonomous_submit");
    await settle();
    runner.dispose();
    const saved = first.queue()!;
    expect(saved.activeRunId).toBe("run_1");

    // The app restarts mid-run.
    const second = createHarness({ queue: saved });
    const restarted = createApplyQueueRunner(second.deps);
    await restarted.resumeAfterRestart();
    await settle();
    expect(second.runs).toHaveLength(1);
    expect(second.runs[0]!.jobIds).toEqual(ids(15).slice(10));
    second.finishRun(0);
    await settle();
    expect(second.queue()?.state).toBe("done");
  });

  it("stop cancels the run under way and starts nothing else", async () => {
    const harness = createHarness();
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(25), "autonomous_submit");
    await settle();
    await runner.control("stop");
    expect(harness.cancelled).toEqual(["run_1"]);
    harness.finishRun(0);
    await settle();
    expect(harness.runs).toHaveLength(1);
    expect(harness.queue()?.state).toBe("stopped");
    await runner.control("dismiss");
    expect(harness.queue()).toBeNull();
  });

  it("pause lets the current run finish and continue picks up the rest", async () => {
    const harness = createHarness();
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(15), "autonomous_submit");
    await settle();
    await runner.control("pause");
    harness.finishRun(0);
    await settle();
    expect(harness.runs).toHaveLength(1);
    expect(harness.cancelled).toEqual([]);
    await runner.control("continue");
    await settle();
    expect(harness.runs.map((run) => run.jobIds.length)).toEqual([10, 5]);
  });

  it("a refused start gives the jobs back and pauses with the reason", async () => {
    const harness = createHarness();
    harness.state.refuse = "Applying is paused while you review a safeguard.";
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(3), "autonomous_submit");
    await settle();
    expect(harness.queue()).toMatchObject({
      state: "paused",
      pausedReason: "Applying is paused while you review a safeguard.",
      startedJobIds: [],
    });
    harness.state.refuse = null;
    await runner.control("continue");
    await settle();
    expect(harness.runs[0]!.jobIds).toEqual(ids(3));
  });

  it("names the jobs a run left out instead of dropping them", async () => {
    const harness = createHarness();
    harness.state.skip = new Set(["job_2"]);
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(3), "autonomous_submit");
    await settle();
    harness.finishRun(0);
    await settle();
    expect(harness.queue()).toMatchObject({
      state: "done",
      startedJobIds: ["job_1", "job_3"],
      skipped: [
        { jobId: "job_2", reason: "Its resume waits for your review." },
      ],
    });
  });

  it("waits while new work is paused and never sends beyond the saved mode", async () => {
    const harness = createHarness();
    harness.state.paused = true;
    harness.state.savedMode = "prepare_only";
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(2), "autonomous_submit");
    await settle();
    expect(harness.runs).toHaveLength(0);
    harness.state.paused = false;
    runner.nudge();
    await settle();
    expect(harness.runs[0]!.mode).toBe("prepare_only");
  });

  it("a second press adds its jobs to the queue that is going", async () => {
    const harness = createHarness();
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(5), "autonomous_submit");
    await settle();
    await runner.start([...ids(5), "extra_1"], "autonomous_submit");
    expect(harness.queue()?.jobIds).toEqual([...ids(5), "extra_1"]);
    harness.finishRun(0);
    await settle();
    expect(harness.runs[1]!.jobIds).toEqual(["extra_1"]);
  });

  it("takes a waiting job out so no run starts it; a started job stays", async () => {
    const harness = createHarness();
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(12), "autonomous_submit");
    await settle();
    // job_1 is in the run under way; job_11 and job_12 are still waiting.
    expect(await runner.remove(["job_1", "job_11"])).toEqual(["job_11"]);
    expect(harness.queue()?.jobIds).not.toContain("job_11");
    expect(harness.queue()?.startedJobIds).toContain("job_1");
    harness.finishRun(0);
    await settle();
    expect(harness.runs.map((run) => run.jobIds)).toEqual([
      ids(10),
      ["job_12"],
    ]);
    expect(harness.cancelled).toEqual([]);
  });

  it("a paused queue emptied by taking its last jobs out is done", async () => {
    const harness = createHarness();
    harness.state.paused = true;
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(2), "autonomous_submit");
    await settle();
    await runner.control("pause");
    expect(await runner.remove(ids(2))).toEqual(ids(2));
    expect(harness.queue()).toMatchObject({ state: "done", jobIds: [] });
    expect(harness.runs).toHaveLength(0);
  });

  it("a job taken out and pressed again goes back in", async () => {
    const harness = createHarness();
    harness.state.paused = true;
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(3), "autonomous_submit");
    await settle();
    await runner.remove(["job_2"]);
    await runner.start(["job_2"], "autonomous_submit");
    harness.state.paused = false;
    runner.nudge();
    await settle();
    expect(harness.runs[0]!.jobIds.sort()).toEqual(ids(3).sort());
  });

  it("orders modes by what they allow", () => {
    expect(leastPermissiveMode("autonomous_submit", "prepare_only")).toBe(
      "prepare_only",
    );
    expect(
      leastPermissiveMode("confirm_before_submit", "autonomous_submit"),
    ).toBe("confirm_before_submit");
  });
});
