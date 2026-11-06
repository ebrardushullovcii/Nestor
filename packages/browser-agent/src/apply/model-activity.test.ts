import { expect, test, vi } from "vitest";
import { createApplyModelActivity } from "./model-activity";
import type { LLMClient } from "../agent/contracts";

test("nested model streams keep their waiting tool alive and inherit cancellation", async () => {
  const controller = new AbortController();
  const onProgress = vi.fn();
  const ownSignal = new AbortController();
  let inherited: AbortSignal | undefined;
  const activity = createApplyModelActivity({
    chatWithTools: (_messages, _tools, options) => {
      inherited = options?.signal;
      const streamed = options as typeof options & {
        onStreamEvent?: (event: {
          type: "reasoning_delta";
          text: string;
        }) => void;
      };
      streamed?.onStreamEvent?.({
        type: "reasoning_delta",
        text: "still working",
      });
      return Promise.resolve({ content: "complete" });
    },
  } satisfies LLMClient);
  await activity.run({ signal: controller.signal, onProgress }, () =>
    activity.client.chatWithTools([], [], { signal: ownSignal.signal }),
  );
  expect(onProgress).toHaveBeenCalledTimes(1);
  expect(inherited?.aborted).toBe(false);
  controller.abort();
  expect(inherited?.aborted).toBe(true);
  await activity.client.chatWithTools([], []);
  expect(onProgress).toHaveBeenCalledTimes(1);
});

test("an auxiliary question stream also keeps its enclosing model turn alive", async () => {
  const onStreamEvent = vi.fn();
  const activity = createApplyModelActivity({
    chatWithTools: (_messages, _tools, options) => {
      const streamed = options as typeof options & {
        onStreamEvent?: (event: {
          type: "tool_call_delta";
          index: number;
        }) => void;
      };
      streamed?.onStreamEvent?.({ type: "tool_call_delta", index: 0 });
      return Promise.resolve({ content: "read" });
    },
  });
  await activity.runModel({ onStreamEvent }, () =>
    activity.client.chatWithTools([], []),
  );
  expect(onStreamEvent).toHaveBeenCalledWith({
    type: "tool_call_delta",
    index: 0,
  });
});
