import { useEffect, useSyncExternalStore } from "react";
import type { SourceDebugRunRecord } from "@nestor/contracts";

/**
 * "Check these N sources" runs one source check after another. The queue
 * lives outside any screen so leaving Profile while a check runs does not
 * silently drop the sources still waiting; the runner hook is mounted once
 * at the Job Finder page level and advances it on every workspace update.
 */
export interface SourceCheckQueueState {
  /** Source ids still waiting for their check to start. */
  waiting: readonly string[];
  /** The check the queue launched last, until it has been seen start and finish. */
  launched: { targetId: string; seenRunning: boolean } | null;
  /** How many sources were in the batch when it started. */
  total: number;
  /** How many of them have finished (or failed to start). */
  done: number;
}

const IDLE: SourceCheckQueueState = {
  waiting: [],
  launched: null,
  total: 0,
  done: 0,
};

let state: SourceCheckQueueState = IDLE;
const listeners = new Set<() => void>();

function setState(next: SourceCheckQueueState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSourceCheckQueueState(): SourceCheckQueueState {
  return state;
}

export function startSourceCheckQueue(targetIds: readonly string[]): void {
  setState({
    waiting: [...targetIds],
    launched: null,
    total: targetIds.length,
    done: 0,
  });
}

/** Drops what is still waiting; a check already running is left alone. */
export function stopSourceCheckQueue(): void {
  setState(IDLE);
}

/** Test helper: back to the idle state. */
export function resetSourceCheckQueueForTests(): void {
  setState(IDLE);
}

export function useSourceCheckQueue(): SourceCheckQueueState {
  return useSyncExternalStore(
    subscribe,
    getSourceCheckQueueState,
    getSourceCheckQueueState,
  );
}

export function isSourceCheckQueueActive(
  queue: SourceCheckQueueState,
): boolean {
  return queue.waiting.length > 0 || queue.launched !== null;
}

/** Give the parent this long to report a launched check as pending. */
const LAUNCH_GRACE_MS = 10_000;

export function useSourceCheckQueueRunner(input: {
  isSourceDebugPending: (targetId: string) => boolean;
  recentSourceDebugRuns: readonly SourceDebugRunRecord[];
  onRunSourceDebug: (targetId: string) => void;
}): void {
  const queue = useSourceCheckQueue();
  const { isSourceDebugPending, onRunSourceDebug, recentSourceDebugRuns } =
    input;
  const anyCheckRunning =
    recentSourceDebugRuns.some((run) => run.state === "running") ||
    (queue.launched !== null && isSourceDebugPending(queue.launched.targetId));
  useEffect(() => {
    if (queue.launched) {
      const { targetId, seenRunning } = queue.launched;
      const running =
        isSourceDebugPending(targetId) ||
        recentSourceDebugRuns.some(
          (run) => run.targetId === targetId && run.state === "running",
        );
      if (running) {
        if (!seenRunning) {
          setState({ ...queue, launched: { targetId, seenRunning: true } });
        }
        return;
      }
      if (seenRunning) {
        setState({ ...queue, launched: null, done: queue.done + 1 });
        return;
      }
      // Launched but not reported yet: give the parent a moment, then move
      // on so a check that failed to start cannot stall the whole batch.
      const timer = window.setTimeout(
        () => setState({ ...queue, launched: null, done: queue.done + 1 }),
        LAUNCH_GRACE_MS,
      );
      return () => window.clearTimeout(timer);
    }
    if (queue.waiting.length === 0) {
      if (queue.total > 0) setState(IDLE);
      return;
    }
    if (anyCheckRunning) return;
    const [next, ...rest] = queue.waiting;
    if (!next) return;
    setState({
      ...queue,
      waiting: rest,
      launched: { targetId: next, seenRunning: false },
    });
    onRunSourceDebug(next);
  }, [
    anyCheckRunning,
    isSourceDebugPending,
    onRunSourceDebug,
    queue,
    recentSourceDebugRuns,
  ]);
}
