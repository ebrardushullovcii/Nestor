import { expect, test } from "vitest";
import type { AgentLoopMessage } from "./agent-loop";
import { createContextArchive } from "./context-archive";

test("immutable shared archives preserve exact public messages at every character boundary", () => {
  const archive = createContextArchive();
  const messages: AgentLoopMessage[] = [
    {
      role: "assistant",
      content: "Read 🦉 中文",
      toolCalls: [
        {
          id: "one",
          type: "function",
          function: {
            name: "read",
            arguments: '{"url":"https://board.example"}',
          },
        },
      ],
      continuation: {
        kind: "reasoning_content",
        route: "private",
        text: "PRIVATE",
      },
    },
    {
      role: "tool",
      toolCallId: "one",
      content: 'First\n"last"',
      images: [
        {
          dataUrl: "data:image/png;base64,synthetic",
          label: "Synthetic image",
        },
      ],
    },
  ];
  const first = archive(messages.slice(0, 1));
  const second = archive(messages);
  const expected = JSON.stringify(
    messages.map((message) => {
      if (message.role !== "assistant") return message;
      return {
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls,
      };
    }),
  );
  let rebuilt = "";
  for (let offset = 0; offset < second.length; offset += 3)
    rebuilt += second.slice(offset, offset + 3);
  expect(rebuilt).toBe(expected);
  expect(JSON.parse(first.slice(0, first.length))).toEqual([
    (JSON.parse(expected) as unknown[])[0],
  ]);
  expect(archive(messages).key).toBe(second.key);
  expect(archive([]).slice(0, 2)).toBe("[]");
  expect(rebuilt).not.toContain("PRIVATE");
});
