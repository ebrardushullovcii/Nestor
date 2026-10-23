/* eslint-disable @typescript-eslint/require-await -- fakes implement async interfaces with immediate results. */
import { describe, expect, it } from "vitest";

import type { AgentLoopMessage, AgentLoopToolCall } from "./agent-loop";
import {
  availablePromptTokens,
  createTokenCalibrator,
  elideOldToolOutputs,
  estimateTokens,
  trimOldestExchanges,
} from "./context-budget";
import {
  readStatusNote,
  runConversationTurn,
  type ConversationModel,
  type ConversationTool,
  type ConversationTurnEvent,
} from "./conversation-turn";

function call(id: string, name: string, args: unknown = {}): AgentLoopToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function scripted(
  responses: Array<
    | { content?: string; toolCalls?: AgentLoopToolCall[] }
    | ((messages: AgentLoopMessage[]) => {
        content?: string;
        toolCalls?: AgentLoopToolCall[];
      })
  >,
): ConversationModel & { seen: AgentLoopMessage[][] } {
  const seen: AgentLoopMessage[][] = [];
  let index = 0;
  return {
    seen,
    async chatWithTools(messages, _tools, options) {
      seen.push(messages);
      const next = responses[index++];
      if (!next) throw new Error("no more scripted responses");
      const response = typeof next === "function" ? next(messages) : next;
      if (response.content) {
        options?.onStreamEvent?.({ type: "attempt_started", attempt: 0 });
        options?.onStreamEvent?.({
          type: "text_delta",
          text: response.content,
        });
      }
      return {
        ...response,
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cachedInputTokens: 50,
          reasoningTokens: 0,
        },
      };
    },
  };
}

function tool(
  name: string,
  execute: ConversationTool["execute"],
): ConversationTool {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: name,
        parameters: { type: "object", properties: {} },
      },
    },
    label: () => `Running ${name}`,
    execute,
  };
}

describe("runConversationTurn", () => {
  it("refreshes the offered catalog after a tool loads more capabilities", async () => {
    let loaded = false;
    const load = tool("load", async () => {
      loaded = true;
      return { kind: "ok", content: "Loaded" };
    });
    const edit = tool("edit", async () => ({ kind: "ok", content: "Saved" }));
    const seen: string[][] = [];
    const responses = scripted([
      { toolCalls: [call("load1", "load")] },
      { toolCalls: [call("edit1", "edit")] },
      { content: "Saved." },
    ]);
    const result = await runConversationTurn({
      model: {
        chatWithTools(messages, definitions, options) {
          seen.push(definitions.map((entry) => entry.function.name));
          return responses.chatWithTools(messages, definitions, options);
        },
      },
      tools: [load, edit],
      getToolDefinitions: () =>
        (loaded ? [load, edit] : [load]).map((t) => t.definition),
      assembleMessages: async (messages) => [...messages],
    });
    expect(result.ending).toBe("replied");
    expect(seen).toEqual([["load"], ["load", "edit"], ["load", "edit"]]);
  });

  it("ends with plain words as the reply and reports usage", async () => {
    const model = scripted([
      { toolCalls: [call("c1", "read_profile")] },
      { content: "Your headline is Engineer." },
    ]);
    const events: ConversationTurnEvent[] = [];
    const result = await runConversationTurn({
      model,
      tools: [
        tool("read_profile", async () => ({
          kind: "ok",
          content: "headline: Engineer",
        })),
      ],
      assembleMessages: async (turn) => [
        { role: "system", content: "sys" },
        { role: "user", content: "what is my headline" },
        ...turn,
      ],
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.ending).toBe("replied");
    expect(result.reply).toBe("Your headline is Engineer.");
    expect(result.usage.inputTokens).toBe(200);
    expect(result.turnMessages.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(events.some((event) => event.type === "tool_started")).toBe(true);
    // The tool definitions offered to the model carry the optional status note.
    expect(model.seen).toHaveLength(2);
  });

  it("reads a steering message at the next tool boundary and does not dispatch stale calls", async () => {
    const executed: string[] = [];
    let steering: string[] = [];
    const model = scripted([
      {
        toolCalls: [
          call("c1", "shortlist", { id: 1 }),
          call("c2", "shortlist", { id: 2 }),
        ],
      },
      (messages) => {
        const last = messages.at(-1);
        expect(last).toEqual({
          role: "user",
          content: "skip the second one",
        });
        return { content: "Done, only the first one." };
      },
    ]);
    const result = await runConversationTurn({
      model,
      tools: [
        tool("shortlist", async (raw) => {
          executed.push(raw);
          // The person types while the first call runs.
          steering = ["skip the second one"];
          return { kind: "ok", content: "shortlisted" };
        }),
      ],
      assembleMessages: async (turn) => [...turn],
      takeSteering: async () => {
        const next = steering;
        steering = [];
        return next;
      },
    });
    expect(executed).toEqual([JSON.stringify({ id: 1 })]);
    expect(result.ending).toBe("replied");
    const toolResults = result.turnMessages.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1]?.content).toMatch(/Not run/);
  });

  it("aborts the running tool's own signal on the deadline", async () => {
    let sawAbort = false;
    const model = scripted([
      { toolCalls: [call("c1", "slow")] },
      { content: "It took too long." },
    ]);
    const result = await runConversationTurn({
      model,
      tools: [
        tool(
          "slow",
          (_raw, context) =>
            new Promise((resolve) => {
              context.signal?.addEventListener("abort", () => {
                sawAbort = true;
                resolve({ kind: "ok", content: "late" });
              });
            }),
        ),
      ],
      assembleMessages: async (turn) => [...turn],
      ceilings: { toolTimeoutMs: 1_000 },
    });
    expect(sawAbort).toBe(true);
    expect(result.ending).toBe("replied");
    expect(result.turnMessages.find((m) => m.role === "tool")?.content).toMatch(
      /longer than 1 seconds/,
    );
  });

  it("never dispatches once the fence says the turn is no longer current", async () => {
    let current = true;
    const executed: string[] = [];
    const model = scripted([
      { toolCalls: [call("c1", "write"), call("c2", "write")] },
    ]);
    const result = await runConversationTurn({
      model,
      tools: [
        tool("write", async (raw) => {
          executed.push(raw);
          current = false;
          return { kind: "ok", content: "written" };
        }),
      ],
      assembleMessages: async (turn) => [...turn],
      isCurrent: () => current,
    });
    expect(executed).toHaveLength(1);
    expect(result.ending).toBe("superseded");
  });

  it("stops at once when the turn is aborted", async () => {
    const controller = new AbortController();
    const model = scripted([{ toolCalls: [call("c1", "wait")] }]);
    const promise = runConversationTurn({
      model,
      tools: [
        tool(
          "wait",
          () =>
            new Promise(() => {
              controller.abort();
            }),
        ),
      ],
      assembleMessages: async (turn) => [...turn],
      signal: controller.signal,
    });
    await expect(promise).resolves.toMatchObject({ ending: "aborted" });
  });

  it("caps a long tool result and stores the rest", async () => {
    const stored: string[] = [];
    const model = scripted([
      { toolCalls: [call("c1", "big")] },
      { content: "ok" },
    ]);
    const result = await runConversationTurn({
      model,
      tools: [
        tool("big", async () => ({ kind: "ok", content: "x".repeat(500) })),
      ],
      assembleMessages: async (turn) => [...turn],
      toolResultLimitChars: 100,
      storeOverflow: async (_name, content) => {
        stored.push(content);
        return "Read handle h1 for the rest.";
      },
    });
    const toolMessage = result.turnMessages.find((m) => m.role === "tool");
    expect(toolMessage?.content.length).toBeLessThan(200);
    expect(toolMessage?.content).toMatch(/handle h1/);
    expect(stored[0]).toHaveLength(500);
  });

  it("reads the optional status note without ever failing on it", () => {
    expect(readStatusNote({ status: "Checking your roles" })).toBe(
      "Checking your roles",
    );
    expect(readStatusNote({ status: 42 })).toBeNull();
    expect(
      readStatusNote({
        status: Array.from({ length: 30 }, () => "w").join(" "),
      }),
    ).toBeNull();
  });
});

describe("context budget", () => {
  const exchange = (index: number): AgentLoopMessage[] => [
    { role: "user", content: `question ${index} ${"q".repeat(400)}` },
    {
      role: "assistant",
      content: "",
      toolCalls: [call(`c${index}`, "read")],
    },
    { role: "tool", toolCallId: `c${index}`, content: "r".repeat(2_000) },
    { role: "assistant", content: `answer ${index}` },
  ];

  it("shortens older tool output and keeps calls paired", () => {
    const messages = [1, 2, 3, 4].flatMap(exchange);
    const { messages: next, elided } = elideOldToolOutputs(messages, {
      keepRecent: 2,
    });
    expect(elided).toBe(2);
    expect(next).toHaveLength(messages.length);
    const tools = next.filter((m) => m.role === "tool");
    expect(tools[0]?.content).toMatch(/^\[Earlier result\] read/);
    expect(tools[3]?.content).toHaveLength(2_000);
  });

  it("drops the oldest exchanges at a person-message boundary until it fits", () => {
    const messages = [1, 2, 3, 4, 5].flatMap(exchange);
    const budget = estimateTokens([4, 5].flatMap(exchange)) + 10;
    const { kept, dropped } = trimOldestExchanges(messages, {
      budgetTokens: budget,
      keepRecentMessages: 4,
    });
    expect(kept[0]).toMatchObject({ role: "user" });
    expect(estimateTokens(kept)).toBeLessThanOrEqual(budget);
    expect(dropped.length + kept.length).toBe(messages.length);
    // Every kept tool result still has its call.
    const callIds = new Set(
      kept.flatMap((m) =>
        m.role === "assistant" ? (m.toolCalls ?? []).map((c) => c.id) : [],
      ),
    );
    for (const message of kept) {
      if (message.role === "tool")
        expect(callIds.has(message.toolCallId)).toBe(true);
    }
  });

  it("learns the provider's ratio within bounds", () => {
    const calibrator = createTokenCalibrator();
    calibrator.observe(1_000, 1_300);
    calibrator.observe(1_000, 1_300);
    expect(calibrator.ratio()).toBeCloseTo(1.3, 1);
    calibrator.observe(1_000, 100_000);
    expect(calibrator.ratio()).toBeLessThanOrEqual(2);
    expect(
      availablePromptTokens({
        contextWindowTokens: 128_000,
        reservedOutputTokens: 8_000,
        toolSchemaTokens: 10_000,
        marginTokens: 6_000,
      }),
    ).toBe(104_000);
  });
});
