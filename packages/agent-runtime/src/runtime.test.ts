import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import { runAgentTask } from "./runtime";

describe("agent task runtime", () => {
  test("preserves private provider continuation across tool turns without putting it in receipts", async () => {
    const continuation = {
      kind: "reasoning_content" as const,
      route: "test-model",
      text: "private synthetic continuation",
    };
    let turns = 0;
    const result = await runAgentTask({
      taskId: "continuation",
      capability: "resume_generation",
      systemPrompt: "Use the tools.",
      state: {},
      initialDraft: {},
      model: {
        chat(input) {
          if (++turns === 1)
            return Promise.resolve({
              continuation,
              toolCalls: [
                {
                  id: "read",
                  type: "function" as const,
                  function: { name: "read", arguments: "{}" },
                },
              ],
            });
          expect(
            input.messages.find((message) => message.role === "assistant"),
          ).toMatchObject({ continuation });
          return Promise.resolve({
            toolCalls: [
              {
                id: "finish",
                type: "function" as const,
                function: { name: "finish_task", arguments: "{}" },
              },
            ],
          });
        },
      },
      tools: [
        {
          name: "read",
          description: "Read",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "read",
          execute: () => ({ summary: "Read", value: {} }),
        },
        {
          name: "finish_task",
          description: "Finish",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "read",
          execute: () => ({ summary: "Finished", finish: true }),
        },
      ],
      validate: () => [],
      buildContext: () => ({}),
    });
    expect(result.receipt.stopReason).toBe("completed");
    expect(JSON.stringify(result)).not.toContain(continuation.text);
  });
  test("with the draft shown in the context, an earlier draft write is replayed as a note", async () => {
    const marker = "SYNTHETIC_DRAFT_BODY";
    const seen: string[] = [];
    let turns = 0;
    await runAgentTask({
      taskId: "draft_once",
      capability: "resume_generation",
      systemPrompt: "Use the tools.",
      state: {},
      initialDraft: { text: "" },
      model: {
        chat(input) {
          seen.push(JSON.stringify(input.messages));
          turns += 1;
          return Promise.resolve({
            toolCalls: [
              turns === 1
                ? {
                    id: "write",
                    type: "function" as const,
                    function: {
                      name: "write",
                      arguments: JSON.stringify({ text: marker }),
                    },
                  }
                : {
                    id: "finish",
                    type: "function" as const,
                    function: { name: "finish_task", arguments: "{}" },
                  },
            ],
          });
        },
      },
      tools: [
        {
          name: "write",
          description: "Write the draft",
          inputSchema: z.object({ text: z.string() }),
          parameters: { type: "object", properties: {} },
          permission: "draft_write",
          execute: (input) => ({
            summary: "Written",
            draft: { text: (input as { text: string }).text },
            progressMade: true,
          }),
        },
        {
          name: "finish_task",
          description: "Finish",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "read",
          execute: () => ({ summary: "Finished", finish: true }),
        },
      ],
      validate: () => [],
      buildContext: ({ draft }) => ({ draft }),
      draftShownInContext: true,
    });
    expect(turns).toBe(2);
    // Once, in the task state; the replayed call carries a note instead.
    expect(seen[1]!.split(marker)).toHaveLength(2);
    expect(seen[1]).toContain("applied to the task draft");
  });

  test("repairs a rejected tool call and finishes a valid draft", async () => {
    let call = 0;
    const result = await runAgentTask({
      taskId: "task_1",
      capability: "profile_copilot",
      systemPrompt: "Update the draft.",
      state: { saved: "old" },
      initialDraft: { value: "" },
      model: {
        model: "test-model",
        reasoningEffort: "high",
        chat() {
          call += 1;
          return Promise.resolve(
            call === 1
              ? {
                  toolCalls: [
                    {
                      id: "bad",
                      type: "function",
                      function: { name: "set_value", arguments: "{}" },
                    },
                  ],
                }
              : {
                  toolCalls: [
                    {
                      id: "set",
                      type: "function",
                      function: {
                        name: "set_value",
                        arguments: JSON.stringify({ value: "ready" }),
                      },
                    },
                    {
                      id: "finish",
                      type: "function",
                      function: { name: "finish_task", arguments: "{}" },
                    },
                  ],
                },
          );
        },
      },
      tools: [
        {
          name: "set_value",
          description: "Set the value",
          inputSchema: z.object({ value: z.string().min(1) }),
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
          permission: "draft_write",
          execute(input: { value: string }, context) {
            return {
              draft: { ...context.draft, value: input.value },
              summary: "Value set",
              progressMade: true,
            };
          },
        },
        {
          name: "finish_task",
          description: "Finish",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "read",
          execute() {
            return { summary: "Finish requested", finish: true };
          },
        },
      ],
      validate: (draft) =>
        draft.value
          ? []
          : [{ code: "required", message: "Value required", path: ["value"] }],
      buildContext: ({ state, draft, validationIssues }) => ({
        state,
        draft,
        validationIssues,
      }),
    });

    expect(result.draft.value).toBe("ready");
    expect(result.receipt.stopReason).toBe("completed");
    expect(result.receipt.repairAttempts).toBe(1);
  });

  test("treats cut-off tool arguments as a repair turn instead of stopping the run", async () => {
    let call = 0;
    const seenToolMessages: string[] = [];
    const tools = [
      {
        name: "set_value",
        description: "Set the value",
        inputSchema: z.object({ value: z.string().min(1) }),
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        permission: "draft_write" as const,
        execute(
          input: { value: string },
          context: { draft: { value: string } },
        ) {
          return {
            draft: { ...context.draft, value: input.value },
            summary: "Value set",
            progressMade: true,
          };
        },
      },
      {
        name: "finish_task",
        description: "Finish",
        inputSchema: z.object({}),
        parameters: { type: "object", properties: {} },
        permission: "read" as const,
        execute() {
          return { summary: "Finish requested", finish: true };
        },
      },
    ];
    const result = await runAgentTask({
      taskId: "task_cut_off_args",
      capability: "resume_generation",
      systemPrompt: "Set the value.",
      state: {},
      initialDraft: { value: "" },
      model: {
        model: "test-model",
        reasoningEffort: "high",
        chat(request) {
          call += 1;
          for (const message of request.messages) {
            if (message.role === "tool") seenToolMessages.push(message.content);
          }
          return Promise.resolve(
            call === 1
              ? {
                  toolCalls: [
                    {
                      id: "cut",
                      type: "function" as const,
                      function: {
                        name: "set_value",
                        arguments: '{"value": "a long proposal that was cu',
                      },
                    },
                  ],
                }
              : {
                  toolCalls: [
                    {
                      id: "set",
                      type: "function" as const,
                      function: {
                        name: "set_value",
                        arguments: JSON.stringify({ value: "ready" }),
                      },
                    },
                    {
                      id: "finish",
                      type: "function" as const,
                      function: { name: "finish_task", arguments: "{}" },
                    },
                  ],
                },
          );
        },
      },
      tools,
      validate: (draft) =>
        draft.value
          ? []
          : [{ code: "required", message: "Value required", path: ["value"] }],
      buildContext: ({ draft, validationIssues }) => ({
        draft,
        validationIssues,
      }),
    });

    expect(result.receipt.stopReason).toBe("completed");
    expect(result.draft.value).toBe("ready");
    expect(result.receipt.toolReceipts[0]).toMatchObject({
      outcome: "rejected",
      failureKind: "validation",
    });
    expect(seenToolMessages.join("\n")).toContain("not valid JSON");
  });

  test("keeps the cause of a tool failure that stops the run", async () => {
    const result = await runAgentTask({
      taskId: "task_tool_error",
      capability: "resume_generation",
      systemPrompt: "Pick a template.",
      state: {},
      initialDraft: { value: "" },
      model: {
        model: "test-model",
        reasoningEffort: "high",
        chat() {
          return Promise.resolve({
            toolCalls: [
              {
                id: "pick",
                type: "function" as const,
                function: { name: "pick", arguments: "{}" },
              },
            ],
          });
        },
      },
      tools: [
        {
          name: "pick",
          description: "Pick",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "draft_write" as const,
          execute(): never {
            throw new Error("Template 'x' is unavailable.");
          },
        },
      ],
      validate: () => [],
      buildContext: ({ draft }) => ({ draft }),
    });

    expect(result.receipt.stopReason).toBe("permanent_failure");
    expect(result.receipt.toolReceipts[0]?.validationIssues[0]).toMatchObject({
      code: "tool_error",
      message: "Template 'x' is unavailable.",
    });
  });

  test("does not finish on top of a write it refused in the same turn", async () => {
    // A model often sends its change and finish together. When the change is
    // refused, finishing then dropped it without the model ever hearing why.
    let call = 0;
    const seenFinishRejections: unknown[] = [];
    const result = await runAgentTask({
      taskId: "task_refused_write",
      capability: "profile_copilot",
      systemPrompt: "Add an item.",
      state: {},
      initialDraft: { items: [] as string[] },
      model: {
        model: "test-model",
        reasoningEffort: "low",
        chat(request) {
          call += 1;
          for (const message of request.messages) {
            if (
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.includes("finishRejected")
            ) {
              seenFinishRejections.push(message.content);
            }
          }
          const item = call === 1 ? "" : "ready";
          return Promise.resolve({
            toolCalls: [
              {
                id: `add_${call}`,
                type: "function",
                function: {
                  name: "add_item",
                  arguments: JSON.stringify({ item }),
                },
              },
              {
                id: `finish_${call}`,
                type: "function",
                function: { name: "finish_task", arguments: "{}" },
              },
            ],
          });
        },
      },
      tools: [
        {
          name: "add_item",
          description: "Add an item",
          inputSchema: z.object({ item: z.string().min(1) }),
          parameters: {
            type: "object",
            properties: { item: { type: "string" } },
            required: ["item"],
          },
          permission: "draft_write",
          execute(input: { item: string }, context) {
            return {
              draft: { items: [...context.draft.items, input.item] },
              summary: "Item added",
              progressMade: true,
            };
          },
        },
        {
          name: "finish_task",
          description: "Finish",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "read",
          execute() {
            return { summary: "Finish requested", finish: true };
          },
        },
      ],
      validate: () => [],
      buildContext: ({ state, draft, validationIssues }) => ({
        state,
        draft,
        validationIssues,
      }),
    });

    expect(result.receipt.stopReason).toBe("completed");
    expect(result.draft.items).toEqual(["ready"]);
    expect(call).toBe(2);
    expect(seenFinishRejections.length).toBeGreaterThan(0);
  });

  test("rejects external-action tools without executing them", async () => {
    let executed = false;
    const result = await runAgentTask({
      taskId: "task_2",
      capability: "safe_boundary",
      systemPrompt: "Do not submit.",
      state: {},
      initialDraft: {},
      model: {
        chat() {
          return Promise.resolve({
            toolCalls: [
              {
                id: "submit",
                type: "function",
                function: { name: "submit_application", arguments: "{}" },
              },
            ],
          });
        },
      },
      tools: [
        {
          name: "submit_application",
          description: "Submit",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "external_action",
          execute() {
            executed = true;
            return { summary: "submitted" };
          },
        },
      ],
      validate: () => [],
      buildContext: () => ({}),
    });

    expect(executed).toBe(false);
    expect(result.receipt.stopReason).toBe("safety_boundary");
    expect(result.receipt.toolReceipts[0]?.failureKind).toBe("safety_boundary");
  });

  test("keeps the assistant tool-call message when the recent tail contains many tool results", async () => {
    let providerCall = 0;
    const result = await runAgentTask({
      taskId: "task_protocol_safe_tail",
      capability: "bounded_task",
      systemPrompt: "Inspect, then finish.",
      state: {},
      initialDraft: {},
      model: {
        chat({ messages }) {
          providerCall += 1;
          if (providerCall === 2) {
            const firstRecent = messages[2];
            expect(firstRecent?.role).toBe("assistant");
            expect(firstRecent?.toolCalls).toHaveLength(9);
          }
          return Promise.resolve(
            providerCall === 1
              ? {
                  toolCalls: Array.from({ length: 9 }, (_, index) => ({
                    id: `read_${index}`,
                    type: "function" as const,
                    function: { name: "read", arguments: "{}" },
                  })),
                }
              : {
                  toolCalls: [
                    {
                      id: "finish",
                      type: "function" as const,
                      function: { name: "finish_task", arguments: "{}" },
                    },
                  ],
                },
          );
        },
      },
      tools: [
        {
          name: "read",
          description: "Read",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "read",
          parallelSafe: true,
          execute() {
            return { summary: "Read" };
          },
        },
        {
          name: "finish_task",
          description: "Finish",
          inputSchema: z.object({}),
          parameters: { type: "object", properties: {} },
          permission: "read",
          execute() {
            return { summary: "Finish", finish: true };
          },
        },
      ],
      validate: () => [],
      buildContext: () => ({}),
    });

    expect(result.receipt.stopReason).toBe("completed");
  });
});

test("a task's working model stream outlives the former task and turn budgets", async () => {
  vi.useFakeTimers();
  try {
    const pending = runAgentTask({
      taskId: "long-stream",
      capability: "synthetic",
      systemPrompt: "Finish",
      state: {},
      initialDraft: {},
      model: {
        chat: ({ onStreamEvent }) =>
          new Promise((resolve) => {
            const interval = setInterval(
              () =>
                onStreamEvent?.({ type: "reasoning_delta", text: "Working" }),
              100_000,
            );
            setTimeout(() => {
              clearInterval(interval);
              resolve({
                toolCalls: [
                  {
                    id: "finish",
                    type: "function",
                    function: { name: "finish_task", arguments: "{}" },
                  },
                ],
              });
            }, 7_200_000);
          }),
      },
      tools: [
        {
          name: "finish_task",
          description: "Finish",
          parameters: { type: "object" },
          inputSchema: z.object({}),
          permission: "read",
          execute: () => ({ summary: "Done", finish: true }),
        },
      ],
      validate: () => [],
      buildContext: () => ({}),
    });
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect((await pending).receipt.stopReason).toBe("completed");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("Stop cancels an uncooperative task model without retrying", async () => {
  const controller = new AbortController();
  const chat = vi.fn(() => new Promise<never>(() => {}));
  const pending = runAgentTask({
    taskId: "stop-stream",
    capability: "synthetic",
    systemPrompt: "Finish",
    state: {},
    initialDraft: {},
    model: { chat },
    tools: [],
    validate: () => [],
    buildContext: () => ({}),
    signal: controller.signal,
  });
  controller.abort();
  expect((await pending).receipt.stopReason).toBe("cancelled");
  expect(chat).toHaveBeenCalledOnce();
});

test("a detached tool abort keeps its cause and does not cancel the typed task", async () => {
  const controller = new AbortController();
  let turns = 0;
  const result = await runAgentTask({
    taskId: "child-abort",
    capability: "resume_generation",
    systemPrompt: "Read and finish.",
    state: {},
    initialDraft: {},
    signal: controller.signal,
    model: {
      chat: () =>
        Promise.resolve({
          toolCalls: [
            {
              id: String(++turns),
              type: "function",
              function: {
                name: turns === 1 ? "read" : "finish_task",
                arguments: "{}",
              },
            },
          ],
        }),
    },
    tools: [
      {
        name: "read",
        description: "Read",
        inputSchema: z.object({}),
        parameters: { type: "object", properties: {} },
        permission: "read",
        execute: () => {
          throw new DOMException(
            "The child connection was reset",
            "AbortError",
          );
        },
      },
      {
        name: "finish_task",
        description: "Finish",
        inputSchema: z.object({}),
        parameters: { type: "object", properties: {} },
        permission: "read",
        execute: () => ({ summary: "Done", finish: true }),
      },
    ],
    validate: () => [],
    buildContext: () => ({}),
  });
  expect(result.receipt.stopReason).toBe("completed");
  expect(result.receipt.toolReceipts[0]?.failureKind).toBe("transient_network");
  expect(
    result.receipt.toolReceipts[0]?.validationIssues[0]?.message,
  ).toContain("child connection was reset");
  expect(turns).toBe(2);
});

test("Stop interrupts an uncooperative typed-task tool and starts no later step", async () => {
  const controller = new AbortController();
  const after = vi.fn(() => ({ summary: "Must not run" }));
  const result = await runAgentTask({
    taskId: "stop",
    capability: "resume_generation",
    systemPrompt: "Read.",
    state: {},
    initialDraft: {},
    signal: controller.signal,
    model: {
      chat: () =>
        Promise.resolve({
          toolCalls: [
            {
              id: "read",
              type: "function",
              function: { name: "read", arguments: "{}" },
            },
            {
              id: "after",
              type: "function",
              function: { name: "after", arguments: "{}" },
            },
          ],
        }),
    },
    tools: [
      {
        name: "read",
        description: "Read",
        inputSchema: z.object({}),
        parameters: { type: "object", properties: {} },
        permission: "read",
        execute: () =>
          new Promise<never>(() => {
            controller.abort(
              new DOMException("The person pressed Stop", "AbortError"),
            );
          }),
      },
      {
        name: "after",
        description: "After",
        inputSchema: z.object({}),
        parameters: { type: "object", properties: {} },
        permission: "read",
        execute: after,
      },
    ],
    validate: () => [],
    buildContext: () => ({}),
  });
  expect(result.receipt.stopReason).toBe("cancelled");
  expect(after).not.toHaveBeenCalled();
});

test("Stop during provider backoff returns a cancelled receipt without retrying", async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const chat = vi.fn(() => Promise.reject(new Error("Network reset")));
    const pending = runAgentTask({
      taskId: "stop-backoff",
      capability: "synthetic",
      systemPrompt: "Finish",
      state: {},
      initialDraft: {},
      model: { chat },
      tools: [],
      validate: () => [],
      buildContext: () => ({}),
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    expect((await pending).receipt.stopReason).toBe("cancelled");
    expect(chat).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("retryable task provider failures continue beyond three attempts until success", async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const pending = runAgentTask({
      taskId: "retry-until-success",
      capability: "synthetic",
      systemPrompt: "Finish",
      state: {},
      initialDraft: {},
      model: {
        chat: () =>
          ++attempts <= 6
            ? Promise.reject(new Error("Network reset"))
            : Promise.resolve({
                toolCalls: [
                  {
                    id: "finish",
                    type: "function",
                    function: { name: "finish_task", arguments: "{}" },
                  },
                ],
              }),
      },
      tools: [
        {
          name: "finish_task",
          description: "Finish",
          inputSchema: z.object({}),
          parameters: { type: "object" },
          permission: "read",
          execute: () => ({ summary: "Done", finish: true }),
        },
      ],
      validate: () => [],
      buildContext: () => ({}),
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.receipt.stopReason).toBe("completed");
    expect(result.receipt.providerCalls).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
