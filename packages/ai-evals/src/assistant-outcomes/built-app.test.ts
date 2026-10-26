import { AssistantMessageSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import { currentRequestChanges } from "./built-app";
const message = (id: string, role: "assistant" | "user", receipt?: string) =>
  AssistantMessageSchema.parse({
    id,
    conversationId: "conversation",
    role,
    origin: role === "user" ? "sidebar" : "host",
    createdAt: "2026-10-26T12:00:00.000Z",
    parts: receipt
      ? [
          {
            type: "change",
            target: "profile",
            receiptId: receipt,
            summary: "Changed Profile",
          },
        ]
      : [{ type: "text", text: "Change my Profile" }],
  });
test("a second Profile edit cannot borrow the first edit's Undo receipt", () => {
  expect(
    currentRequestChanges({
      messages: [
        message("first-user", "user"),
        message("first-reply", "assistant", "first-receipt"),
        message("second-user", "user"),
      ],
    }),
  ).toEqual([]);
  expect(
    currentRequestChanges({
      messages: [
        message("first-reply", "assistant", "first-receipt"),
        message("second-user", "user"),
        message("second-reply", "assistant", "second-receipt"),
      ],
    }).map((part) => part.receiptId),
  ).toEqual(["second-receipt"]);
});
test("an answer without a current person request supplies no receipt proof", () => {
  expect(
    currentRequestChanges({
      messages: [message("old-reply", "assistant", "old-receipt")],
    }),
  ).toEqual([]);
});
