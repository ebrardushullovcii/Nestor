import { describe, expect, it } from "vitest";
import {
  AssistantMessagePartSchema,
  AssistantProposalSchema,
  AssistantResumeBatchStateSchema,
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

it("validates UI resume queue state at the typed bridge", () => {
  expect(() =>
    AssistantResumeBatchStateSchema.parse({
      id: "queue",
      jobIds: ["job_1"],
      activeJobIds: ["job_1", "job_2", "job_3"],
      completedJobIds: [],
      done: false,
      stopRequested: false,
    }),
  ).toThrow();
});

it("keeps a 33-job resume queue within bounded pipeline admission", () => {
  const state = {
    id: "batch",
    jobIds: Array.from({ length: 33 }, (_, i) => `job_${i}`),
    activeJobIds: ["job_0", "job_1"],
    completedJobIds: [],
    done: false,
    stopRequested: false,
  };
  expect(AssistantResumeBatchStateSchema.parse(state).jobIds).toHaveLength(33);
  expect(
    AssistantResumeBatchStateSchema.safeParse({
      ...state,
      activeJobIds: ["job_0", "job_1", "job_2"],
    }).success,
  ).toBe(true);
});
