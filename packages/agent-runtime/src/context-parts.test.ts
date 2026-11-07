import { expect, test, vi } from "vitest";
import { createContextParts, isModelInputLimit } from "./context-parts";
import {
  runAgentLoop,
  type AgentLoopMessage,
  type AgentLoopTool,
} from "./agent-loop";
import { runConversationTurn } from "./conversation-turn";

const call = (name: string, args = "{}") => ({
  id: name,
  type: "function" as const,
  function: { name, arguments: args },
});
const finish: AgentLoopTool = {
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
      finish: { reason: "done", stuck: false, needsPerson: false, data: {} },
    }),
};

test("a huge visible observation is ordered, stable and readable in full, including Unicode and the last fact", async () => {
  const parts = createContextParts();
  const text = "Visible fact 🦉 中文\n".repeat(10_000) + "THE LAST FACT";
  const original: AgentLoopMessage[] = [
    { role: "system", content: "Instructions" },
    { role: "user", content: text },
  ];
  const represented = parts.prepare(original, 8000);
  expect(original[1]!.content).toBe(text);
  const [notice, ...inline] = represented[1]!.content.split("\n");
  const id = /parts: ([^;]+);/u.exec(notice!)![1]!;
  let reconstructed = inline.join("\n");
  let offset: number | null = reconstructed.length;
  while (offset !== null) {
    const result = await parts.tool.execute(JSON.stringify({ id, offset }), {
      step: 1,
    });
    if (result.kind !== "ok") throw Error("Expected readable part");
    const page = JSON.parse(result.content) as {
      text: string;
      offset: number;
      nextOffset: number | null;
    };
    expect(page.offset).toBe(offset);
    reconstructed += page.text;
    offset = page.nextOffset;
  }
  expect(reconstructed).toBe(text);
  expect(parts.prepare(original, 8000)).toEqual(represented);
});

test("provider input rejection resends paged observations without replaying the action", async () => {
  const execute = vi.fn(() =>
    Promise.resolve({
      kind: "ok" as const,
      content: "Visible fact ".repeat(2000),
    }),
  );
  const observe: AgentLoopTool = {
    ...finish,
    definition: {
      ...finish.definition,
      function: { ...finish.definition.function, name: "observe" },
    },
    execute,
  };
  const requests: AgentLoopMessage[][] = [];
  const result = await runAgentLoop({
    subjectLabel: "synthetic application",
    messages: [{ role: "user", content: "Read the job" }],
    tools: [observe, finish],
    staleToolResultChars: null,
    retainCompactedHistory: true,
    compactionMaxChars: 100_000,
    model: {
      chatWithTools: (messages) => {
        requests.push(messages);
        if (requests.length === 1)
          return Promise.resolve({ toolCalls: [call("observe")] });
        if (requests.length === 2)
          return Promise.reject(
            Error(
              "Upstream request failed: [invalid_request_error] Input too long: model limit 1048576 tokens, requested 1603421 tokens.",
            ),
          );
        expect(messages.at(-1)!.content).toContain("read_context_part");
        expect(messages.at(-1)!.content).toContain("Visible fact");
        return Promise.resolve({ toolCalls: [call("finish")] });
      },
    },
  });
  expect(result.ending).toBe("finished");
  expect(execute).toHaveBeenCalledOnce();
  expect(requests).toHaveLength(3);
  expect(requests[2]!.at(-1)!.content.length).toBeLessThan(
    requests[1]!.at(-1)!.content.length,
  );
});

test("conversation input rejection uses the same exact paging and keeps tool execution once", async () => {
  const execute = vi.fn(() =>
    Promise.resolve({
      kind: "ok" as const,
      content: "Visible assistant fact ".repeat(1000),
    }),
  );
  let calls = 0;
  const result = await runConversationTurn({
    contextMaxChars: 100_000,
    tools: [
      {
        ...finish,
        label: () => "Read",
        definition: {
          ...finish.definition,
          function: { ...finish.definition.function, name: "observe" },
        },
        execute,
      },
    ],
    assembleMessages: (messages) =>
      Promise.resolve([{ role: "user", content: "Read" }, ...messages]),
    model: {
      chatWithTools: (messages) => {
        calls++;
        if (calls === 1)
          return Promise.resolve({ toolCalls: [call("observe")] });
        if (calls === 2)
          return Promise.reject(
            Object.assign(new Error("Provider rejected input"), {
              code: "context_length_exceeded",
            }),
          );
        expect(messages.at(-1)!.content).toContain("read_context_part");
        return Promise.resolve({ content: "Read the observation." });
      },
    },
  });
  expect(result.ending).toBe("replied");
  expect(execute).toHaveBeenCalledOnce();
  expect(calls).toBe(3);
});

test.each([
  "Input too long",
  "context_length_exceeded",
  "maximum context length exceeded",
  "prompt is too large",
])("recognizes provider input rejection %s", (message) => {
  expect(
    isModelInputLimit(
      new Error("Gateway failed", { cause: new Error(message) }),
    ),
  ).toBe(true);
});
test("ordinary provider failures are not context recovery", () => {
  expect(isModelInputLimit(Error("Insufficient account funds"))).toBe(false);
});

test("a completed call releases its snapshots while a live call can read them", async () => {
  const parts = createContextParts();
  const represented = parts.prepare(
    [{ role: "user", content: "Facts 🦉".repeat(1000) }],
    1000,
  );
  const id = /parts: ([^;]+);/u.exec(represented[0]!.content)![1]!;
  const read = () =>
    parts.tool.execute(JSON.stringify({ id, offset: 0 }), { step: 0 });
  expect((await read()).kind).toBe("ok");
  parts.dispose();
  const result = await read();
  expect(result.kind === "ok" && result.content).toContain(
    "Unknown context part id",
  );
});
