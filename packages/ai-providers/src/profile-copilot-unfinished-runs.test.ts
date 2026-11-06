import { describe, expect, test } from "vitest";

import { createJobFinderAiClientFromEnvironment } from "./index";
import {
  createEnvironment,
  createPreferences,
  createProfile,
} from "./test-fixtures";

type ToolCall = { name: string; arguments: Record<string, unknown> };

const readContext: ToolCall = { name: "read_profile_context", arguments: {} };
const addStaffDesigner: ToolCall = {
  name: "set_profile_list_fields",
  arguments: {
    summary: "Add Staff Designer to target roles",
    fields: { targetRoles: ["Staff Designer"] },
  },
};
const finish: ToolCall = { name: "finish_task", arguments: {} };

/** Answers each model turn with the next scripted set of tool calls. */
function mockToolTurns(turns: readonly (readonly ToolCall[])[]) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    const turn = turns[Math.min(calls, turns.length - 1)] ?? [];
    calls += 1;
    return Promise.resolve(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: turn.map((call, index) => ({
                  id: `call_${calls}_${index}`,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments),
                  },
                })),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function revise(request: string) {
  const client = createJobFinderAiClientFromEnvironment(createEnvironment());
  return client.reviseCandidateProfile({
    profile: createProfile(),
    searchPreferences: createPreferences(),
    context: { surface: "profile", section: "basics" },
    relevantReviewItems: [],
    request,
  });
}

describe("Profile Assistant runs that stop before finishing", () => {
  test("keeps prepared cards through more than the former 120-turn no-progress ceiling", async () => {
    // Live, a run that circled after proposing was thrown away whole and the
    // built-in editor answered with no card.
    const mock = mockToolTurns([
      [addStaffDesigner],
      ...Array.from({ length: 130 }, () => [readContext]),
      [finish],
    ]);
    try {
      const reply = await revise("Add Staff Designer to my target roles.");

      expect(reply.patchGroups).toHaveLength(1);
      expect(reply.patchGroups[0]?.operations[0]).toEqual({
        operation: "replace_profile_list_fields",
        value: { targetRoles: ["Staff Designer"] },
      });
      expect(reply.executionReceipt?.stopReason).toBe("completed");
      expect(reply.executionReceipt?.fallbackUsed).toBe(false);
      // No second run once cards exist.
      expect(mock.callCount()).toBe(132);
    } finally {
      mock.restore();
    }
  });

  test("continues the same run until the model prepares its change and finishes", async () => {
    const mock = mockToolTurns([
      [readContext],
      [readContext],
      [readContext],
      [readContext],
      [addStaffDesigner],
      [finish],
    ]);
    try {
      const reply = await revise("Add Staff Designer to my target roles.");

      expect(reply.executionReceipt?.stopReason).toBe("completed");
      expect(reply.executionReceipt?.fallbackUsed).toBe(false);
      expect(reply.patchGroups).toHaveLength(1);
      expect(mock.callCount()).toBe(6);
    } finally {
      mock.restore();
    }
  });
});
