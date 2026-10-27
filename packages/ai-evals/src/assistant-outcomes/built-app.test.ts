import { AssistantMessageSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import {
  currentRequestChanges,
  validateBatches,
  type BuiltAppBatch,
} from "./built-app";
import { ACTION_INVENTORY } from "./inventory";
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

const batch = (id: string, requires?: string[]): BuiltAppBatch => ({
  id,
  request: "Open Home in the app",
  ...(requires ? { requires } : {}),
  actions: [
    { actionId: "navigation.home", observe: () => Promise.resolve([]) },
  ],
});

test("case IDs cannot collide, credit excluded controls, or name absent controls", () => {
  expect(() => validateBatches([batch("same"), batch("same")])).toThrow(
    "Duplicate outcome batch",
  );
  const duplicate = batch("duplicate");
  duplicate.actions = [...duplicate.actions, ...duplicate.actions];
  expect(() => validateBatches([duplicate])).toThrow("Duplicate outcome case");
  const excluded = ACTION_INVENTORY.find(
    (entry) => entry.coverage.kind === "excluded",
  )!;
  for (const actionId of [excluded.id, "absent.action"])
    expect(() =>
      validateBatches([
        {
          ...batch("invalid"),
          actions: [{ actionId, observe: () => Promise.resolve([]) }],
        },
      ]),
    ).toThrow("Not a mapped app action");
});

test("the full run must execute every prerequisite first, before any chat mutation", () => {
  expect(() => validateBatches([batch("undo", ["remove"])])).toThrow(
    "Missing prerequisite",
  );
  expect(() => validateBatches([batch("a", ["b"]), batch("b", ["a"])])).toThrow(
    "Cyclic prerequisites",
  );
  expect(() =>
    validateBatches([batch("undo", ["remove"]), batch("remove")]),
  ).toThrow("must run before");
  expect(() =>
    validateBatches([batch("remove"), batch("undo", ["remove"])]),
  ).not.toThrow();
});
