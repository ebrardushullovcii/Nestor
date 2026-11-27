import { expect, test } from "vitest";
import type { AgentLoopMessage } from "./agent-loop";
import { createContextHistory } from "./context-history";
import { foldSupersededContent } from "./context-fold";

const page = (n: number) => `page ${n} `.repeat(2_000);
const conversation = (): AgentLoopMessage[] => [
  { role: "system", content: "rules" },
  { role: "user", content: `Landed:\n${page(1)}` },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "a",
        type: "function",
        function: { name: "scroll", arguments: "{}" },
      },
    ],
  },
  { role: "tool", toolCallId: "a", content: `Scrolled.\n${page(2)}` },
];

test("a fold that frees more than it makes the provider read again replaces the superseded message and archives it exactly", () => {
  const history = createContextHistory(Number.MAX_SAFE_INTEGER);
  const messages = conversation();
  const folded = foldSupersededContent(
    messages,
    [{ index: 1, content: "Landed:\n[Page view 1, since replaced by 2.]" }],
    (archived) => history.archive(archived),
    // The last request sent the first three messages; the page-2 answer is new.
    3,
  );
  expect(folded?.[1]?.content).toBe(
    "Landed:\n[Page view 1, since replaced by 2.] [Exact earlier message: read_context_history archive 1.]",
  );
  expect(folded?.slice(2)).toEqual(messages.slice(2));
});

test("a fold waits while it would make the provider read more than it frees", () => {
  const history = createContextHistory(Number.MAX_SAFE_INTEGER);
  const messages: AgentLoopMessage[] = [
    ...conversation(),
    // Already sent and cached after the superseded view: larger than it.
    { role: "user", content: page(3).repeat(2) },
  ];
  expect(
    foldSupersededContent(
      messages,
      [{ index: 1, content: "Landed:\n[folded]" }],
      (archived) => history.archive(archived),
      messages.length,
    ),
  ).toBeNull();
});

test("folded screenshots come back as images from the archive", async () => {
  const history = createContextHistory(Number.MAX_SAFE_INTEGER);
  const image = {
    dataUrl: "data:image/png;base64,AAAA",
    label: "Current page.",
  };
  const messages: AgentLoopMessage[] = [
    { role: "system", content: "rules" },
    {
      role: "tool",
      toolCallId: "s",
      content: "Current page.",
      images: [image],
    },
    { role: "user", content: page(4) },
    { role: "user", content: page(5) },
  ];
  // Screenshots fold with the page views they came before.
  const folded = foldSupersededContent(
    messages,
    [
      {
        index: 1,
        content: "Current page.\n[Screenshot folded.]",
        dropImages: true,
      },
      { index: 2, content: "[Page view 4, since replaced by 5.]" },
    ],
    (archived) => history.archive(archived),
    3,
  );
  expect(folded?.[1]).toEqual({
    role: "tool",
    toolCallId: "s",
    content:
      "Current page.\n[Screenshot folded.] [Exact earlier message: read_context_history archive 1.]",
  });
  const read = await history.tool.execute('{"archive":1}', { step: 1 });
  expect(read).toMatchObject({ kind: "ok", images: [image] });
  expect(read.kind === "ok" && JSON.parse(read.content)).toEqual({
    archive: 1,
    totalMessages: 1,
    messages: [
      {
        role: "tool",
        toolCallId: "s",
        content: "Current page.",
        images: ["Current page."],
      },
    ],
  });
});
