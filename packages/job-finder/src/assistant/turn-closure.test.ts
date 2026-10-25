import { describe, expect, it } from "vitest";

import { shortChangeTitle } from "./session-host";
import { closeStoppedTurn } from "./turn-closure";

describe("closing a stopped turn", () => {
  it("answers dangling tool calls and records that the request ended", () => {
    const closing = closeStoppedTurn([
      { role: "user", content: "Compare every shortlisted job" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_job", arguments: "{}" },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "get_job", arguments: "{}" },
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: "{}" },
    ]);
    expect(closing).toEqual([
      {
        role: "tool",
        toolCallId: "call_2",
        content: "Stopped before this finished.",
      },
      {
        role: "assistant",
        content: expect.stringContaining(
          "request is closed",
        ) as unknown as string,
      },
    ]);
  });
});

describe("change card titles", () => {
  it("keeps a long brief to its first sentence", () => {
    expect(
      shortChangeTitle(
        "Tailor this draft properly for the Comet role. Keep the summary short and move design systems first.",
      ),
    ).toBe("Tailor this draft properly for the Comet role.");
    expect(shortChangeTitle("x".repeat(200))).toHaveLength(88);
  });
});
