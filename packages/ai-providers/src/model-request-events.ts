import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelRequestEvent } from "./model-request-transport";

const events = new AsyncLocalStorage<{
  waiting: Set<object>;
  onProgress: (waiting: boolean) => void;
}>();

/** Progress for all model calls in an operation, including nested helpers. */
export function withModelProviderProgress<T>(
  onProgress: (waiting: boolean) => void,
  work: () => T,
): T {
  return events.run({ waiting: new Set(), onProgress }, work);
}

export function recordModelRequestEvent(
  event: ModelRequestEvent,
  request: object,
): void {
  const scope = events.getStore();
  if (!scope) return;
  const before = scope.waiting.size > 0;
  if (event.type === "waiting") scope.waiting.add(request);
  else if (event.type === "attempt_started") scope.waiting.delete(request);
  const waiting = scope.waiting.size > 0;
  if (before !== waiting) scope.onProgress(waiting);
}

export function finishModelRequestProgress(request: object): void {
  recordModelRequestEvent({ type: "attempt_started", attempt: 0 }, request);
}
