import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { runAgentTask, type AgentTaskRunOptions } from "./runtime";
import { elideOldToolOutputs, trimOldestExchanges } from "./context-budget";
import { AgentTaskResultStore } from "./result-store";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const base = (): AgentTaskRunOptions<object, object> => {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.phase !== "thinking") controller.abort();
    },
    taskId: "synthetic",
    capability: "test",
    systemPrompt: "test",
    state: {},
    initialDraft: {},
    model: { chat: () => Promise.resolve({ content: "thinking" }) },
    tools: [],
    validate: () => [],
    buildContext: () => ({}),
  };
};
function events(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === "string" && line.startsWith("[self_limit_hit] ")
      ? [JSON.parse(line.slice(17)) as { limit: string; where: string }]
      : [],
  );
}
test.each([false, true])(
  "only reports a validator bound the model was not given (advertised=%s)",
  async (advertised) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAgentTask({
      ...base(),

      model: {
        chat: () =>
          Promise.resolve({
            toolCalls: [
              {
                id: "x",
                type: "function",
                function: { name: "write", arguments: '{"text":"too long"}' },
              },
            ],
          }),
      },
      tools: [
        {
          name: "write",
          description: "write",
          permission: "draft_write",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", ...(advertised ? { maxLength: 2 } : {}) },
            },
          },
          inputSchema: z.object({ text: z.string().max(2) }),
          execute: () => ({ summary: "unused" }),
        },
      ],
    });
    expect(
      events(log).some((hit) => hit.limit === "unadvertised_validator_bound"),
    ).toBe(!advertised);
  },
);
test("reports history/evidence omitted by context maintenance", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const messages = [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [
        {
          id: "a",
          type: "function" as const,
          function: { name: "read", arguments: "{}" },
        },
      ],
    },
    {
      role: "tool" as const,
      toolCallId: "a",
      content: "evidence".repeat(1000),
    },
    { role: "user" as const, content: "next" },
    { role: "tool" as const, toolCallId: "b", content: "current" },
  ];
  expect(elideOldToolOutputs(messages, { keepRecent: 1 }).elided).toBe(1);
  expect(
    trimOldestExchanges(messages, { budgetTokens: 100, keepRecentMessages: 2 })
      .dropped.length,
  ).toBeGreaterThan(0);
  expect(events(log).map((hit) => hit.limit)).toEqual([
    "old_tool_outputs",
    "old_exchanges",
  ]);
});

test.each([
  [
    "minimum",
    z.object({ text: z.string().min(10) }),
    { type: "object", properties: { text: { type: "string" } } },
    { text: "ok" },
    true,
  ],
  [
    "enum",
    z.object({ text: z.enum(["one"]) }),
    {
      type: "object",
      properties: { text: { type: "string", enum: ["one", "two"] } },
    },
    { text: "two" },
    true,
  ],
  [
    "pattern",
    z.object({ text: z.string().regex(/^one$/u) }),
    {
      type: "object",
      properties: { text: { type: "string", pattern: "^[a-z]+$" } },
    },
    { text: "two" },
    true,
  ],
  [
    "keys",
    z.object({ text: z.string() }).strict(),
    { type: "object", properties: { text: { type: "string" } } },
    { text: "ok", extra: true },
    true,
  ],
  [
    "keys",
    z.object({ text: z.string() }).strict(),
    {
      type: "object",
      properties: { text: { type: "string" } },
      additionalProperties: false,
    },
    { text: "ok", extra: true },
    false,
  ],
] as const)(
  "detects hidden validator %s while preserving advertised restrictions",
  async (kind, inputSchema, parameters, args, expected) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runAgentTask({
      ...base(),

      model: {
        chat: () =>
          Promise.resolve({
            toolCalls: [
              {
                id: "x",
                type: "function",
                function: { name: "write", arguments: JSON.stringify(args) },
              },
            ],
          }),
      },
      tools: [
        {
          name: "write",
          description: "Write",
          permission: "draft_write",
          parameters,
          inputSchema,
          execute: () => ({ summary: "unused" }),
        },
      ],
    });
    expect(
      events(log).some((hit) =>
        hit.limit.startsWith("unadvertised_validator_"),
      ),
    ).toBe(expected);
  },
);

test("task keeps its full action history beyond the former task ceilings", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = new AgentTaskResultStore();
  const result = store.put({
    summary: "Synthetic rows",
    value: Array.from({ length: 100 }, (_, i) => i),
  });
  expect(
    store.read({ handle: result.reference.handle, limit: 100 })?.items,
  ).toHaveLength(100);
  let turn = 0;
  const resultOfTask = await runAgentTask({
    ...base(),
    onProgress: () => {},
    model: {
      chat: () =>
        Promise.resolve({
          toolCalls: [
            {
              id: `turn${++turn}`,
              type: "function",
              function: {
                name: turn >= 130 ? "finish_task" : "read",
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
        permission: "read",
        parameters: { type: "object" },
        inputSchema: z.object({}),
        execute: () => ({ summary: "Read", progressMade: false }),
      },
      {
        name: "finish_task",
        description: "Finish",
        permission: "read",
        parameters: { type: "object" },
        inputSchema: z.object({}),
        execute: () => ({ summary: "Done", finish: true }),
      },
    ],
  });
  expect(resultOfTask.receipt.stopReason).toBe("completed");
  expect(events(log).some((hit) => hit.limit === "result_read_items")).toBe(
    false,
  );
  expect(
    events(log).some((hit) => hit.where === "agent-runtime/recent_messages"),
  ).toBe(false);
});
