import { randomUUID } from "node:crypto";
import {
  runTraceEnabled,
  traceEvent,
  traceSafe,
  withTraceScope,
} from "@nestor/core/run-trace";

export interface ModelTurnObservation {
  id: string;
  request: unknown;
  response?: unknown;
  error?: unknown;
  durationMs: number;
}
export interface ToolCallObservation {
  id: string;
  name: string;
  arguments: string;
  /** The exact tool message handed back to the model, including a refusal. */
  result: string | null;
  durationMs: number;
}
export interface RuntimeObservers {
  onModelTurn?: (event: ModelTurnObservation) => void;
  onToolCall?: (event: ToolCallObservation) => void;
}

function notify<T>(observer: ((value: T) => void) | undefined, event: T): void {
  if (!observer) return;
  try {
    // A detached copy prevents an observer from changing prompts/results.
    const returned: unknown = observer(traceSafe(event) as T);
    if (returned instanceof Promise) void returned.catch(() => {});
  } catch {
    /* Observation cannot fail a run. */
  }
}

export async function observeModel<T>(
  observers: RuntimeObservers,
  request: unknown,
  work: () => Promise<T>,
): Promise<T> {
  if (!observers.onModelTurn && !runTraceEnabled()) return work();
  const id = randomUUID();
  const started = Date.now();
  let snapshot: unknown;
  try {
    snapshot = traceSafe(request);
  } catch {
    snapshot = { observationError: "Request could not be copied" };
  }
  traceEvent("model_turn_started", { id, request: snapshot });
  try {
    const response = await withTraceScope({ modelTurnId: id }, work);
    const event = {
      id,
      request: snapshot,
      response,
      durationMs: Date.now() - started,
    };
    traceEvent("model_turn", event);
    notify(observers.onModelTurn, event);
    return response;
  } catch (error) {
    const event = {
      id,
      request: snapshot,
      error,
      durationMs: Date.now() - started,
    };
    traceEvent("model_turn", event);
    notify(observers.onModelTurn, event);
    throw error;
  }
}

export function observeTool(
  observers: RuntimeObservers,
  call: { id: string; function: { name: string; arguments: string } },
  content: string | null,
  started: number,
): void {
  if (!observers.onToolCall && !runTraceEnabled()) return;
  const event = {
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
    result: content,
    durationMs: Math.max(0, Date.now() - started),
  };
  traceEvent("tool_call", event);
  notify(observers.onToolCall, event);
}
