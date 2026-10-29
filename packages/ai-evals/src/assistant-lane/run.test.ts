import { expect, test } from "vitest";
import {
  AssistantMessageSchema,
  type AssistantMessagePart,
} from "@nestor/contracts";
import { assistantReplyFailure } from "./run";
const message = (parts: AssistantMessagePart[]) =>
  AssistantMessageSchema.parse({
    id: "test_message",
    conversationId: "test_conversation",
    role: "assistant",
    origin: "host",
    createdAt: "2026-10-29T00:00:00.000Z",
    parts,
  });
test("records a provider outage instead of crediting earlier successful tools", () => {
  expect(
    assistantReplyFailure([
      message([
        {
          type: "notice",
          kind: "outage",
          text: "The model rate limited this request (429).",
        },
      ]),
    ]),
  ).toContain("429");
});
test("an old outage does not fail a later completed answer", () => {
  expect(
    assistantReplyFailure([
      message([{ type: "notice", kind: "outage", text: "Temporary failure" }]),
      message([{ type: "text", text: "Saved the requested headline." }]),
    ]),
  ).toBeNull();
});
test("a question or stopped notice is not reported as a provider outage", () => {
  expect(
    assistantReplyFailure([
      message([
        { type: "notice", kind: "stopped", text: "Stopped by the person." },
      ]),
    ]),
  ).toBeNull();
});
