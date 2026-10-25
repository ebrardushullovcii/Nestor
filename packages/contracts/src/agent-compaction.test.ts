import { describe, expect, test } from "vitest";

import {
  SharedAgentCompactionPolicySchema,
  SharedAgentCompactionSnapshotSchema,
} from "./index";

describe("agent compaction contracts", () => {
  test("parses the shared compaction policy defaults", () => {
    const policy = SharedAgentCompactionPolicySchema.parse({});

    expect(policy.enabled).toBe(true);
    expect(policy.warningTokenBudget).toBe(176_000);
    expect(policy.targetTokenBudget).toBe(184_000);
    expect(policy.minimumResponseHeadroomTokens).toBe(12_000);
    expect(policy.minimumPreserveRecentMessages).toBeLessThanOrEqual(
      policy.preserveRecentMessages,
    );
  });

  test("rejects impossible preserve-message relationships", () => {
    expect(() =>
      SharedAgentCompactionPolicySchema.parse({
        preserveRecentMessages: 2,
        minimumPreserveRecentMessages: 3,
      }),
    ).toThrow(/minimumPreserveRecentMessages|preserveRecentMessages/);
  });

  test("parses shared compaction snapshots with token evidence", () => {
    const snapshot = SharedAgentCompactionSnapshotSchema.parse({
      compactedAt: "2026-04-19T10:00:00.000Z",
      compactionCount: 2,
      triggerKind: "token_budget",
      estimatedTokensBefore: 140_000,
      estimatedTokensAfter: 82_000,
      summary: "Compacted long-running worker transcript.",
      confirmedFacts: ["Visited 8 pages."],
      blockerNotes: [],
      avoidStrategyFingerprints: ["search_filter_probe:target_site:search"],
      preservedContext: ["Senior Product Designer at Signal Systems"],
      stickyWorkflowState: ["Phase goal: Verify listing route"],
    });

    expect(snapshot.triggerKind).toBe("token_budget");
    expect(snapshot.estimatedTokensBefore).toBeDefined();
    expect(snapshot.estimatedTokensAfter).toBeLessThan(snapshot.estimatedTokensBefore!);
  });
});
