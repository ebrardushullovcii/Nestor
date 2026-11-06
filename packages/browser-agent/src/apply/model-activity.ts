import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMClient } from "../agent/contracts";

// Structural compatibility while the shared stream-liveness API lands.
type StreamEvent =
  | { type: "attempt_started"; attempt: number }
  | { type: "provider_wait"; delayMs: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_started"; index: number; name: string }
  | { type: "tool_call_delta"; index: number };
type ModelOptions = NonNullable<Parameters<LLMClient["chatWithTools"]>[2]> & {
  onStreamEvent?: (event: StreamEvent) => void;
};
type Activity = { signal?: AbortSignal; onProgress?: () => void };

/** Nested question/fact checks are progress in the model turn or tool waiting for them. */
export function createApplyModelActivity(client: LLMClient) {
  const scope = new AsyncLocalStorage<Activity>();
  const run = <T>(context: Activity, work: () => T): T =>
    scope.run(context, work);
  return {
    run,
    runModel<T>(options: ModelOptions | undefined, work: () => T): T {
      return run(
        {
          ...(options?.signal ? { signal: options.signal } : {}),
          onProgress: () =>
            options?.onStreamEvent?.({ type: "tool_call_delta", index: 0 }),
        },
        work,
      );
    },
    client: {
      chatWithTools: (messages, tools, options = undefined) => {
        const context = scope.getStore();
        const streamOptions = options as ModelOptions | undefined;
        const signal = context?.signal
          ? options?.signal
            ? AbortSignal.any([context.signal, options.signal])
            : context.signal
          : options?.signal;
        const request: ModelOptions = {
          ...options,
          ...(signal ? { signal } : {}),
          onStreamEvent: (event) => {
            streamOptions?.onStreamEvent?.(event);
            context?.onProgress?.();
          },
        };
        return client.chatWithTools(messages, tools, request);
      },
    } satisfies LLMClient,
  };
}
