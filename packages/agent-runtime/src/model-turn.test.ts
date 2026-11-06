import { afterEach, expect, test, vi } from "vitest";
import { runAgentLoop } from "./agent-loop";
import {
  runConversationTurn,
  type ConversationModel,
} from "./conversation-turn";

afterEach(() => vi.useRealTimers());

function run(
  kind: "agent" | "conversation",
  model: ConversationModel,
  options: { signal?: AbortSignal; idleMs?: number } = {},
) {
  const common = {
    model,
    tools: [],
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return kind === "agent"
    ? runAgentLoop({
        ...common,
        messages: [],
        subjectLabel: "the task",
        ceilings: {
          modelIdleTimeoutMs: options.idleMs ?? 180_000,
        },
        onReplyWithoutTool: () =>
          Promise.resolve({
            kind: "finish",
            finish: {
              reason: "Done",
              stuck: false,
              needsPerson: false,
              data: {},
            },
          }),
      })
    : runConversationTurn({
        ...common,
        assembleMessages: () => Promise.resolve([]),
        ceilings: {
          modelIdleTimeoutMs: options.idleMs ?? 180_000,
        },
      });
}

for (const kind of ["agent", "conversation"] as const) {
  test(`${kind}: no default deadline becomes a one-millisecond timer`, async () => {
    vi.useFakeTimers();
    const model: ConversationModel = {
      chatWithTools: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ content: "Done" }), 100),
        ),
    };
    const done = vi.fn();
    const pending = run(kind, model).then((result) => {
      done();
      return result;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    expect((await pending).ending).toBe(
      kind === "agent" ? "finished" : "replied",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  test(`${kind}: steady text, reasoning and tool events outlive the old absolute limits`, async () => {
    vi.useFakeTimers();
    const pending = run(kind, {
      chatWithTools: (_messages, _tools, options) =>
        new Promise((resolve) => {
          const events = [
            { type: "text_delta", text: "working" },
            { type: "reasoning_delta", text: "thinking" },
            { type: "tool_call_started", index: 0, name: "compose" },
            { type: "tool_call_delta", index: 0 },
          ] as const;
          let tick = 0;
          const interval = setInterval(
            () => options?.onStreamEvent?.(events[tick++ % events.length]!),
            100_000,
          );
          setTimeout(() => {
            clearInterval(interval);
            resolve({ content: "Done" });
          }, 7_200_000);
        }),
    });
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect((await pending).ending).toBe(
      kind === "agent" ? "finished" : "replied",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  test(`${kind}: a silent connection reconnects repeatedly and succeeds`, async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const chatWithTools = vi.fn<ConversationModel["chatWithTools"]>(
      (_messages, _tools, options) => {
        signals.push(options!.signal!);
        return signals.length <= 3
          ? new Promise(() => undefined)
          : Promise.resolve({ content: "Done" });
      },
    );
    const pending = run(kind, { chatWithTools }, { idleMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(chatWithTools).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    const result = await pending;
    expect(result.ending).toBe(kind === "agent" ? "finished" : "replied");
    expect(chatWithTools).toHaveBeenCalledTimes(4);
    expect(signals.slice(0, 3).every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test(`${kind}: Stop cancels an uncooperative model without retrying`, async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const chatWithTools = vi.fn<ConversationModel["chatWithTools"]>(
      () => new Promise(() => undefined),
    );
    const pending = run(kind, { chatWithTools }, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect((await pending).ending).toBe("aborted");
    expect(chatWithTools).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
}

test.each(["length", "max_output_tokens", "transport"])(
  "output truncation (%s) retries with more room and the same history",
  async (kind) => {
    const seen: unknown[] = [];
    const limits: Array<number | undefined> = [];
    const empty = vi.fn();
    let calls = 0;
    const pending = runConversationTurn({
      model: {
        chatWithTools: (messages, _tools, options) => {
          seen.push(messages);
          limits.push(options?.maxOutputTokens);
          if (++calls === 1) {
            if (kind === "transport")
              return Promise.reject(
                new Error(
                  "The AI service returned an incomplete response: length",
                ),
              );
            return Promise.resolve({
              finishReason: kind,
              content: "Partial answer",
            });
          }
          return Promise.resolve({ content: "Complete answer" });
        },
      },
      tools: [],
      ceilings: { maxOutputTokens: 8000 },
      assembleMessages: () =>
        Promise.resolve([{ role: "user", content: "Keep all prior evidence" }]),
      onEmptyReply: empty,
    });
    expect((await pending).reply).toBe("Complete answer");
    expect(limits).toEqual([8000, 16000]);
    expect(seen[1]).toBe(seen[0]);
    expect(empty).not.toHaveBeenCalled();
  },
);

test("repeated output truncation fails after one retry without executing partial tools", async () => {
  const execute = vi.fn();
  const chatWithTools = vi
    .fn<ConversationModel["chatWithTools"]>()
    .mockResolvedValue({
      content: "Partial",
      finishReason: "length",
      toolCalls: [
        {
          id: "partial",
          type: "function",
          function: { name: "save", arguments: "{}" },
        },
      ],
    });
  const result = await runConversationTurn({
    model: { chatWithTools },
    tools: [
      {
        definition: {
          type: "function",
          function: {
            name: "save",
            description: "save",
            parameters: { type: "object", properties: {} },
          },
        },
        label: () => "Save",
        execute,
      },
    ],
    assembleMessages: () => Promise.resolve([]),
  });
  expect(result.ending).toBe("model_failed");
  expect(chatWithTools).toHaveBeenCalledTimes(2);
  expect(execute).not.toHaveBeenCalled();
});

test("a long tool stays alive while its nested model reports progress", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const pending = runAgentLoop({
    messages: [],
    subjectLabel: "the task",
    model: {
      chatWithTools: () =>
        Promise.resolve({
          toolCalls: [
            {
              id: `call_${++calls}`,
              type: "function",
              function: {
                name: calls === 1 ? "read" : "finish",
                arguments: "{}",
              },
            },
          ],
        }),
    },
    tools: [
      {
        definition: {
          type: "function",
          function: {
            name: "read",
            description: "Read",
            parameters: { type: "object", properties: {} },
          },
        },
        execute: (_raw, context) =>
          new Promise((resolve) => {
            const interval = setInterval(() => context.onProgress?.(), 100_000);
            setTimeout(() => {
              clearInterval(interval);
              resolve({ kind: "ok", content: "Read", progress: true });
            }, 500_000);
          }),
      },
      {
        definition: {
          type: "function",
          function: {
            name: "finish",
            description: "Finish",
            parameters: { type: "object", properties: {} },
          },
        },
        execute: () =>
          Promise.resolve({
            kind: "finish",
            finish: {
              reason: "Done",
              stuck: false,
              needsPerson: false,
              data: {},
            },
          }),
      },
    ],
  });
  await vi.advanceTimersByTimeAsync(500_000);
  expect((await pending).ending).toBe("finished");
  expect(vi.getTimerCount()).toBe(0);
});

test("conversation tools keep running while they report progress", async () => {
  vi.useFakeTimers();
  let calls = 0;
  const pending = runConversationTurn({
    model: {
      chatWithTools: () =>
        Promise.resolve(
          ++calls === 1
            ? {
                toolCalls: [
                  {
                    id: "read",
                    type: "function",
                    function: { name: "read", arguments: "{}" },
                  },
                ],
              }
            : { content: "Done" },
        ),
    },
    tools: [
      {
        definition: {
          type: "function",
          function: {
            name: "read",
            description: "Read",
            parameters: { type: "object", properties: {} },
          },
        },
        label: () => "Read",
        execute: (_raw, context) =>
          new Promise((resolve) => {
            const interval = setInterval(() => context.onProgress?.(), 100_000);
            setTimeout(() => {
              clearInterval(interval);
              resolve({ kind: "ok", content: "Read", progress: true });
            }, 7_200_000);
          }),
      },
    ],
    assembleMessages: (turn) => Promise.resolve([...turn]),
  });
  await vi.advanceTimersByTimeAsync(7_200_000);
  expect((await pending).ending).toBe("replied");
  expect(vi.getTimerCount()).toBe(0);
});
