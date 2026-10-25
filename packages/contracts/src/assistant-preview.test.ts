import { describe, expect, it } from "vitest";
import {
  AssistantMessagePartSchema,
  AssistantProposalSchema,
} from "./assistant";

describe("assistant change preview", () => {
  it("keeps a removed record's fields, one per line, beyond a single value's length", () => {
    const before = Array.from(
      { length: 12 },
      (_, index) => `Field ${index}: ${"synthetic detail ".repeat(8)}`,
    ).join("\n");
    const preview = [
      { label: "Skills", before: "React", after: "React, TypeScript" },
      { label: "Removed education", before, after: null },
    ];
    const parsed = AssistantMessagePartSchema.parse({
      type: "change",
      receiptId: "receipt_synthetic",
      target: "profile",
      summary: "Removed an education record",
      preview,
    });
    expect(before.length).toBeGreaterThan(600);
    expect(parsed.type === "change" ? parsed.preview : null).toEqual(preview);
  });
});

it("keeps exact proposal wording beyond two thousand characters in storage and the message", () => {
  const detail = `Current: ${"Current synthetic wording. ".repeat(100)}\nProposed: ${"Proposed synthetic wording. ".repeat(100)}`;
  const item = { id: "item_1", label: "Update summary", detail };
  const proposal = AssistantProposalSchema.parse({
    id: "proposal_1",
    conversationId: "conversation_1",
    kind: "profile_operations",
    summary: "Rewrite summary",
    createdAt: "2026-10-02T10:00:00.000Z",
    items: [
      {
        ...item,
        payload: {
          operation: "replace_professional_summary_fields",
          value: { fullSummary: "Synthetic summary" },
        },
      },
    ],
  });
  expect(proposal.items[0]!.detail).toBe(detail);
  const part = AssistantMessagePartSchema.parse({
    type: "proposal",
    proposalId: proposal.id,
    kind: proposal.kind,
    summary: proposal.summary,
    items: [item],
    source: { store: "assistant" },
  });
  expect(part.type === "proposal" && part.items[0]!.detail).toBe(detail);
});
