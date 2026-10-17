// @vitest-environment jsdom
import { AssistantMessageSchema } from "@nestor/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantMessageParts } from "./assistant-message-parts";

afterEach(cleanup);
it("shows every proposal's full wording before Apply, including the ninth item", () => {
  const replacement =
    "The exact proposed synthetic wording with a 23% result. ".repeat(50);
  const items = Array.from({ length: 9 }, (_, index) => ({
    id: `item_${index}`,
    label: `Update summary ${index}`,
    detail: `Current: Current synthetic summary ${index}.\nProposed: ${replacement}${index}`,
  }));
  const message = AssistantMessageSchema.parse({
    id: "message_1",
    conversationId: "conversation_1",
    role: "assistant",
    origin: "sidebar",
    createdAt: "2026-10-02T10:00:00.000Z",
    parts: [
      {
        type: "proposal",
        proposalId: "proposal_1",
        kind: "profile_operations",
        summary: "Rewrite summaries",
        items,
        source: { store: "assistant" },
      },
    ],
  });
  const resolve = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <AssistantMessageParts
      message={message}
      actions={{
        onResolveProposal: resolve,
        onUndo: () => Promise.resolve(null),
        onAnswer: () => undefined,
        onOpenRoute: () => undefined,
      }}
    />,
  );
  expect(view.container.textContent).toContain(replacement + "8");
  expect(view.container.textContent).toContain("Current synthetic summary 8.");
  expect(view.container.querySelectorAll("li")).toHaveLength(9);
  expect(view.container.querySelector(".line-clamp-2")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(resolve).toHaveBeenCalledWith({
    messageId: "message_1",
    proposalId: "proposal_1",
    action: "accept",
  });
});

it("renders a saved Sent card as Sending results alongside unsent receipts", () => {
  const message = AssistantMessageSchema.parse(
    JSON.parse(
      JSON.stringify({
        id: "saved",
        conversationId: "conversation",
        role: "assistant",
        origin: "sidebar",
        createdAt: "2026-10-03T12:00:00Z",
        parts: [
          {
            type: "records",
            kind: "applications",
            title: "Sent",
            totalCount: 2,
            rows: [
              {
                id: "a",
                title: "Engineer",
                status: "Review the prepared run approval in Applications",
              },
              { id: "b", title: "Designer", status: "Try again" },
            ],
          },
        ],
      }),
    ),
  );
  render(
    <AssistantMessageParts
      message={message}
      actions={{
        onResolveProposal: () => Promise.resolve(),
        onUndo: () => Promise.resolve(null),
        onAnswer: () => undefined,
        onOpenRoute: () => undefined,
      }}
    />,
  );
  expect(screen.getByText("Sending results")).toBeTruthy();
  expect(screen.queryByText("Sent")).toBeNull();
  expect(screen.getByText("Try again")).toBeTruthy();
});
