import {
  ApplyQueueSchema,
  listApplyQueueRemainingJobIds,
  type ApplicationAutomationMode,
  type ApplyQueue,
  type ApplyQueueSkippedJob,
} from "@nestor/contracts";

/** The run ceiling from ADR 0012: one run starts at most ten applications. */
export const APPLY_QUEUE_RUN_SIZE = 10;

export interface ApplyQueueStartedRun {
  runId: string | null;
  startedJobIds: readonly string[];
  /** Jobs the run left out, each with the sentence that says why. */
  skipped: readonly ApplyQueueSkippedJob[];
  /** Settles when the run has finished in the background. */
  settled: Promise<void>;
}

export interface ApplyQueueRunnerDeps {
  loadQueue(): Promise<ApplyQueue | null>;
  saveQueue(queue: ApplyQueue | null): Promise<void>;
  /** Starts the day can still take, and when the day's count resets. */
  readDailyCapacity(): Promise<{ remaining: number; resetsAt: string }>;
  readSavedMode(): Promise<ApplicationAutomationMode>;
  isActivityPaused(): Promise<boolean>;
  /** One run of at most ten jobs in `mode`; throws when nothing could start. */
  startRun(
    jobIds: readonly string[],
    mode: ApplicationAutomationMode,
  ): Promise<ApplyQueueStartedRun>;
  cancelRun(runId: string): Promise<void>;
  publish(): void;
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => () => void;
  createId?: () => string;
  onError?: (error: unknown) => void;
}

export interface ApplyQueueRunner {
  /**
   * One Apply press over many jobs. Adds to a queue that is still going and
   * returns once its first run is going or refused.
   */
  start(
    jobIds: readonly string[],
    mode: ApplicationAutomationMode,
  ): Promise<ApplyQueue>;
  control(
    action: "pause" | "continue" | "stop" | "dismiss",
  ): Promise<ApplyQueue | null>;
  /** After launch: carries on a queue that was running or waiting. */
  resumeAfterRestart(): Promise<void>;
  /** Settings or paused activity changed; a waiting queue looks again. */
  nudge(): void;
  /** Resolves when no step is in flight (tests). */
  idle(): Promise<void>;
  dispose(): void;
}

const MODE_RANK: Record<ApplicationAutomationMode, number> = {
  prepare_only: 0,
  confirm_before_submit: 1,
  autonomous_submit: 2,
};

/** The mode that allows less: a queue never sends more than either allows. */
export function leastPermissiveMode(
  left: ApplicationAutomationMode,
  right: ApplicationAutomationMode,
): ApplicationAutomationMode {
  return MODE_RANK[left] <= MODE_RANK[right] ? left : right;
}

function errorSentence(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (message.trim() || "The next applications could not start.").slice(
    0,
    1_000,
  );
}

const ALREADY_TAKEN_REASON = "Already applied or being applied to.";

export function createApplyQueueRunner(
  deps: ApplyQueueRunnerDeps,
): ApplyQueueRunner {
  const now = deps.now ?? (() => new Date());
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, delayMs: number) => {
      const handle = setTimeout(callback, delayMs);
      (handle as { unref?: () => void }).unref?.();
      return () => clearTimeout(handle);
    });
  const createId =
    deps.createId ??
    (() => `apply_queue_${now().getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const onError =
    deps.onError ??
    ((error: unknown) => console.error("[Apply queue] step failed", error));

  let disposed = false;
  let pumping: Promise<void> | null = null;
  let pumpAgain = false;
  let activeRunSettled: Promise<void> | null = null;
  let clearWakeTimer: (() => void) | null = null;

  const save = async (queue: ApplyQueue | null) => {
    await deps.saveQueue(
      queue ? ApplyQueueSchema.parse({ ...queue, updatedAt: now().toISOString() }) : null,
    );
    deps.publish();
  };

  const armWakeTimer = (resumesAt: string) => {
    clearWakeTimer?.();
    // A second past local midnight, so the new day's count is what is read.
    const delayMs = Math.max(1_000, Date.parse(resumesAt) - now().getTime() + 1_000);
    // Timers longer than about 24.8 days overflow; a day is the most needed.
    clearWakeTimer = setTimer(
      () => {
        clearWakeTimer = null;
        pump();
      },
      Math.min(delayMs, 2_147_000_000),
    );
  };

  async function step(): Promise<void> {
    if (disposed || activeRunSettled) return;
    const queue = await deps.loadQueue();
    if (!queue) return;
    if (queue.state !== "running" && queue.state !== "waiting_for_tomorrow") {
      return;
    }
    const remaining = listApplyQueueRemainingJobIds(queue);
    if (remaining.length === 0) {
      clearWakeTimer?.();
      clearWakeTimer = null;
      await save({ ...queue, state: "done", activeRunId: null, resumesAt: null });
      return;
    }
    // "Pause new work" holds the queue too; resuming nudges it.
    if (await deps.isActivityPaused()) return;
    const capacity = await deps.readDailyCapacity();
    if (capacity.remaining <= 0) {
      if (queue.state !== "waiting_for_tomorrow" || queue.resumesAt !== capacity.resetsAt) {
        await save({
          ...queue,
          state: "waiting_for_tomorrow",
          resumesAt: capacity.resetsAt,
        });
      }
      armWakeTimer(capacity.resetsAt);
      return;
    }
    clearWakeTimer?.();
    clearWakeTimer = null;

    const take = remaining.slice(
      0,
      Math.min(APPLY_QUEUE_RUN_SIZE, capacity.remaining),
    );
    const mode = leastPermissiveMode(queue.mode, await deps.readSavedMode());
    // Taken before the run starts: a crash or restart mid-run never hands
    // the same job to a second run.
    await save({
      ...queue,
      state: "running",
      resumesAt: null,
      pausedReason: null,
      startedJobIds: [...queue.startedJobIds, ...take],
    });

    let started: ApplyQueueStartedRun;
    try {
      started = await deps.startRun(take, mode);
    } catch (error: unknown) {
      // Nothing started: the jobs go back and the queue pauses with the
      // reason, so Continue tries the same jobs again.
      const current = await deps.loadQueue();
      if (current) {
        const giveBack = new Set(take);
        await save({
          ...current,
          state: current.state === "stopped" ? "stopped" : "paused",
          pausedReason: current.state === "stopped" ? null : errorSentence(error),
          startedJobIds: current.startedJobIds.filter((id) => !giveBack.has(id)),
        });
      }
      return;
    }

    const startedIds = new Set(started.startedJobIds);
    const skippedIds = new Set(started.skipped.map((entry) => entry.jobId));
    const skipped: ApplyQueueSkippedJob[] = [
      ...started.skipped.filter((entry) => take.includes(entry.jobId)),
      ...take
        .filter((id) => !startedIds.has(id) && !skippedIds.has(id))
        .map((jobId) => ({ jobId, reason: ALREADY_TAKEN_REASON })),
    ];
    const notStarted = new Set(skipped.map((entry) => entry.jobId));
    const current = (await deps.loadQueue()) ?? queue;
    const stoppedMeanwhile = current.state === "stopped";
    await save({
      ...current,
      startedJobIds: current.startedJobIds.filter((id) => !notStarted.has(id)),
      skipped: [
        ...current.skipped.filter((entry) => !notStarted.has(entry.jobId)),
        ...skipped,
      ],
      activeRunId: stoppedMeanwhile ? null : started.runId,
    });
    if (stoppedMeanwhile && started.runId) {
      await deps.cancelRun(started.runId).catch(onError);
    }
    if (started.startedJobIds.length === 0 || stoppedMeanwhile) {
      pumpAgain = true;
      return;
    }

    const runId = started.runId;
    activeRunSettled = started.settled
      .catch(onError)
      .then(async () => {
        const latest = await deps.loadQueue();
        if (latest && latest.activeRunId === runId) {
          await save({ ...latest, activeRunId: null });
        }
      })
      .catch(onError)
      .finally(() => {
        activeRunSettled = null;
        pump();
      });
  }

  function pump(): void {
    if (disposed) return;
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = (async () => {
      try {
        do {
          pumpAgain = false;
          await step().catch(onError);
        } while (pumpAgain && !disposed);
      } finally {
        pumping = null;
      }
    })();
  }

  return {
    async start(jobIds, mode) {
      const unique = [...new Set(jobIds)];
      const existing = await deps.loadQueue();
      const createdAt = now().toISOString();
      const ongoing =
        existing &&
        existing.state !== "done" &&
        existing.state !== "stopped";
      let queue: ApplyQueue;
      if (ongoing && existing) {
        const known = new Set(existing.jobIds);
        queue = {
          ...existing,
          mode,
          jobIds: [...existing.jobIds, ...unique.filter((id) => !known.has(id))],
          // A job pressed again after it was skipped gets another chance.
          skipped: existing.skipped.filter((entry) => !unique.includes(entry.jobId)),
          state: existing.state === "waiting_for_tomorrow" ? existing.state : "running",
          pausedReason: null,
        };
      } else {
        queue = {
          id: createId(),
          mode,
          state: "running",
          jobIds: unique,
          startedJobIds: [],
          skipped: [],
          activeRunId: null,
          pausedReason: null,
          resumesAt: null,
          createdAt,
          updatedAt: createdAt,
        };
      }
      await save(queue);
      pump();
      // The press returns once the first run is going or refused, as one
      // Apply to all always did; the rest goes on in the background.
      await pumping;
      return ApplyQueueSchema.parse((await deps.loadQueue()) ?? queue);
    },
    async control(action) {
      const queue = await deps.loadQueue();
      if (!queue) return null;
      if (action === "dismiss") {
        if (queue.state === "done" || queue.state === "stopped") {
          await save(null);
          return null;
        }
        return queue;
      }
      if (action === "pause") {
        if (queue.state !== "running" && queue.state !== "waiting_for_tomorrow") {
          return queue;
        }
        clearWakeTimer?.();
        clearWakeTimer = null;
        // The run under way finishes; no new run starts.
        const next = { ...queue, state: "paused" as const, pausedReason: null, resumesAt: null };
        await save(next);
        return next;
      }
      if (action === "continue") {
        if (queue.state !== "paused") return queue;
        const next = { ...queue, state: "running" as const, pausedReason: null };
        await save(next);
        pump();
        return next;
      }
      // Stop: the run under way is cancelled and nothing else starts.
      clearWakeTimer?.();
      clearWakeTimer = null;
      const next = {
        ...queue,
        state: "stopped" as const,
        activeRunId: null,
        pausedReason: null,
        resumesAt: null,
      };
      await save(next);
      if (queue.activeRunId) {
        await deps.cancelRun(queue.activeRunId).catch(onError);
      }
      return next;
    },
    async resumeAfterRestart() {
      const queue = await deps.loadQueue();
      if (!queue) return;
      // A run of the last session ended with it; its jobs were already
      // taken, so they are not started again.
      if (queue.activeRunId && !activeRunSettled) {
        await save({ ...queue, activeRunId: null });
      }
      pump();
    },
    nudge() {
      pump();
    },
    async idle() {
      for (;;) {
        const pending = pumping ?? activeRunSettled;
        if (!pending) return;
        await pending;
      }
    },
    dispose() {
      disposed = true;
      clearWakeTimer?.();
      clearWakeTimer = null;
    },
  };
}
