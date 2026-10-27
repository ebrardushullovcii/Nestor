import { expect, test } from "vitest";
import replay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/page-history-cost.json";
import type { AgentMessage } from "../types";
import { compactApplyPageHistory } from "./page-history";

test("page-history cost replay retains current fields, instructions, resume and tool pairs once", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "Keep all the safety checks." },
    { role: "user", content: "Applicant facts and the selected resume." },
  ];
  const views = new Set<string>();
  for (let turn = 0; turn < replay.turns; turn++) {
    const view = `Page ${turn}\n${replay.pageText.repeat(replay.repetitions)}\nFields: c0 Name, c1 Start date ${turn}`;
    views.add(view);
    messages.push(
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: `call-${turn}`,
            type: "function",
            function: { name: "fill_fields", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: `call-${turn}`,
        content: `Filled the known field.\n${view}`,
      },
    );
  }
  const current = [...views].at(-1)!;
  const result = compactApplyPageHistory(messages, views, current);
  const text = JSON.stringify(result);
  expect(text.length / JSON.stringify(messages).length).toBeLessThan(
    replay.maxRetainedRatio,
  );
  expect(text.split(current.replaceAll("\n", "\\n")).length - 1).toBe(1);
  expect(result[0]).toEqual(messages[0]);
  expect(result[1]).toEqual(messages[1]);
  expect(result.filter((entry) => entry.role === "tool")).toHaveLength(
    replay.turns,
  );
  expect(result.filter((entry) => entry.role === "assistant")).toHaveLength(
    replay.turns,
  );
  expect(result.at(-1)?.content).toContain("c1 Start date 11");
});
