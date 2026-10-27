import {
  AssistantConversationViewSchema,
  JOB_COMMANDS,
} from "@nestor/contracts";
import type { Page } from "playwright";
import { expect, test, vi } from "vitest";
import { huntOutcomeCases } from "./hunt-cases";

test("a chat search checks its saved choices through the paged site contract", async () => {
  const origin = "http://127.0.0.1:12345";
  vi.stubGlobal("window", {
    nestor: {
      jobs: {
        async run(name: string, input: unknown) {
          if (name === "list_sites") {
            JOB_COMMANDS.list_sites.input.parse(input);
            return { rows: [{ id: 11, url: `${origin}/board/` }] };
          }
          if (name === "search_status")
            return {
              search: {
                id: "synthetic-search",
                state: "done",
                sourcesTotal: 1,
                settings: {
                  depth: "quick",
                  picky: "balanced",
                  postedWithin: "month",
                  note: "Synthetic TypeScript engineering outcome check",
                  sites: { ids: [11] },
                },
              },
            };
          throw Error(`Unexpected read: ${name}`);
        },
      },
    },
  });
  try {
    const page = {
      async evaluate<T>(read: () => T): Promise<Awaited<T>> {
        return await read();
      },
    } as unknown as Page;
    const reply = AssistantConversationViewSchema.parse({
      conversation: {
        id: "synthetic-conversation",
        title: "Search my sites",
        createdAt: "2026-10-27T12:00:00.000Z",
        updatedAt: "2026-10-27T12:00:00.000Z",
      },
      messages: [],
      lastSequence: 0,
    });
    const batch = huntOutcomeCases(origin).find(
      (batch) => batch.id === "hunt-search",
    )!;
    const assertions = await batch.actions[0]!.observe(page, reply, {
      operations: [],
      receipts: [],
    });
    expect(assertions.length).toBeGreaterThan(0);
    expect(assertions.every((assertion) => assertion.passed)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
