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
  runs: Array<{ jobIds: string[]; mode: ApplicationAutomationMode; runId: string }>;
  cancelled: string[];
  finishRun(index: number): void;
  queue(): ApplyQueue | null;
  setRemaining(value: number): void;
  setNow(iso: string): void;
  fireTimers(): void;
  timers: Array<{ delayMs: number; callback: () => void; cleared: boolean }>;
  state: {
    savedMode: ApplicationAutomationMode;
    paused: boolean;
    refuse: string | null;
    skip: Set<string>;
  };
}

function createHarness(initial: { remaining?: number; queue?: ApplyQueue | null } = {}): Harness {
  let stored: ApplyQueue | null = initial.queue ?? null;
  let remaining = initial.remaining ?? 1_000;
  let nowIso = "2026-10-23T14:00:00.000Z";
  const resetsAt = () => "2026-10-23T22:00:00.000Z";
  const settlers: Array<() => void> = [];
  const runs: Harness["runs"] = [];
  const cancelled: string[] = [];
  const timers: Harness["timers"] = [];
  const state: Harness["state"] = {
    savedMode: "autonomous_submit",
    paused: false,
    refuse: null,
    skip: new Set(),
  };
  const deps: ApplyQueueRunnerDeps = {
    loadQueue: async () => (stored ? structuredClone(stored) : null),
    saveQueue: async (queue) => {
      stored = queue ? structuredClone(queue) : null;
    },
    readDailyCapacity: async () => ({ remaining, resetsAt: resetsAt() }),
    readSavedMode: async () => state.savedMode,
    isActivityPaused: async () => state.paused,
    startRun: async (jobIds, mode): Promise<ApplyQueueStartedRun> => {
      if (state.refuse) throw new Error(state.refuse);
      const runId = `run_${runs.length + 1}`;
      const started = jobIds.filter((id) => !state.skip.has(id));
      runs.push({ jobIds: [...jobIds], mode, runId });
      remaining = Math.max(0, remaining - started.length);
      let settle!: () => void;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      settlers.push(settle);
      return {
        runId,
        startedJobIds: started,
        skipped: jobIds
          .filter((id) => state.skip.has(id))
          .map((jobId) => ({ jobId, reason: "Its resume waits for your review." })),
        settled,
      };
    },
    cancelRun: async (runId) => {
      cancelled.push(runId);
    },
    publish: () => undefined,
    now: () => new Date(nowIso),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return () => {
        timer.cleared = true;
      };
    },
    createId: () => "queue_1",
    onError: (error) => {
      throw error;
    },
  };
  return {
    deps,
    runs,
    cancelled,
    timers,
    state,
    finishRun: (index) => settlers[index]!(),
    queue: () => stored,
    setRemaining: (value) => {
      remaining = value;
    },
    setNow: (iso) => {
      nowIso = iso;
    },
    fireTimers: () => {
      for (const timer of timers.splice(0)) {
        if (!timer.cleared) timer.callback();
      }
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("apply queue runner", () => {
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

  it("stops at the daily limit and carries on after local midnight by itself", async () => {
    const harness = createHarness({ remaining: 12 });
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(30), "autonomous_submit");
    await settle();
    harness.finishRun(0);
    await settle();
    // The second run takes only what the day has left.
    expect(harness.runs.map((run) => run.jobIds.length)).toEqual([10, 2]);
    harness.finishRun(1);
    await settle();
    expect(harness.queue()?.state).toBe("waiting_for_tomorrow");
    expect(harness.queue()?.resumesAt).toBe("2026-10-23T22:00:00.000Z");
    expect(harness.runs).toHaveLength(2);
    const timer = harness.timers.at(-1)!;
    expect(timer.delayMs).toBe(8 * 60 * 60 * 1000 + 1_000);

    harness.setNow("2026-10-23T22:00:01.000Z");
    harness.setRemaining(20);
    harness.fireTimers();
    await settle();
    expect(harness.queue()?.state).toBe("running");
    expect(harness.runs.map((run) => run.jobIds.length)).toEqual([10, 2, 10]);
  });

  it("starts again at once when the person raises the limit", async () => {
    const harness = createHarness({ remaining: 0 });
    const runner = createApplyQueueRunner(harness.deps);
    await runner.start(ids(5), "autonomous_submit");
    await settle();
    expect(harness.queue()?.state).toBe("waiting_for_tomorrow");
    harness.setRemaining(10);
    runner.nudge();
    await settle();
    expect(harness.runs.map((run) => run.jobIds.length)).toEqual([5]);
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
      skipped: [{ jobId: "job_2", reason: "Its resume waits for your review." }],
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

  it("orders modes by what they allow", () => {
    expect(leastPermissiveMode("autonomous_submit", "prepare_only")).toBe(
      "prepare_only",
    );
    expect(leastPermissiveMode("confirm_before_submit", "autonomous_submit")).toBe(
      "confirm_before_submit",
    );
  });
});
