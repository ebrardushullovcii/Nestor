import { describe, expect, test } from "vitest";

import { compactSourceInstructionReviewPhaseContexts } from "./shared-agent-handoff-compaction";
import type { SourceInstructionFinalReviewPhaseContext } from "./source-instruction-types";

function createPhaseContext(
  overrides?: Partial<SourceInstructionFinalReviewPhaseContext>,
): SourceInstructionFinalReviewPhaseContext {
  return {
    phase: "search_filter_probe",
    phaseGoal: "Verify search controls",
    successCriteria: ["Find stable search controls"],
    stopConditions: ["Stop when route is proven"],
    knownFactsAtStart: ["Start from jobs route"],
    startedAt: "2026-04-19T10:00:00.000Z",
    completedAt: "2026-04-19T10:01:00.000Z",
    outcome: "succeeded",
    completionMode: "structured_finish",
    completionReason: null,
    resultSummary: "Search controls stayed stable.",
    blockerSummary: null,
    confirmedFacts: ["Keyword search box changed results"],
    attemptedActions: ["Filled searchbox", "Submitted search"],
    phaseEvidence: null,
    visualEvidence: [],
    compactionState: null,
    reviewTranscript: ["assistant: inspected search controls"],
    ...overrides,
  };
}

describe("shared agent handoff compaction", () => {
  test("keeps full context when prompt stays under warning budget", () => {
    const result = compactSourceInstructionReviewPhaseContexts({
      phaseContexts: [createPhaseContext()],
      heuristicInstructionText: "heuristic",
      instructionUnderReviewText: "existing",
      verificationText: "verification",
      compactionPolicy: {
        enabled: true,
        warningTokenBudget: 10_000,
        targetTokenBudget: 12_000,
        minimumResponseHeadroomTokens: 500,
      },
      modelContextWindowTokens: 20_000,
    });

    expect(result.handoffCompaction.mode).toBe("full_context");
    expect(result.phaseContexts[0]?.reviewTranscript).toHaveLength(1);
  });

  test("switches to summary-first mode and drops raw transcript lines when over budget", () => {
    const result = compactSourceInstructionReviewPhaseContexts({
      phaseContexts: [
        createPhaseContext({
          reviewTranscript: Array.from({ length: 120 }, (_, index) =>
            `assistant: transcript line ${index}`,
          ),
        }),
      ],
      heuristicInstructionText: "heuristic",
      instructionUnderReviewText: "existing",
      verificationText: "verification",
      compactionPolicy: {
        enabled: true,
        warningTokenBudget: 200,
        targetTokenBudget: 350,
        minimumResponseHeadroomTokens: 100,
      },
      modelContextWindowTokens: 500,
    });

    expect(result.handoffCompaction.mode).toBe("summary_first");
    expect(result.handoffCompaction.droppedTranscriptLineCount).toBe(120);
    expect(result.phaseContexts[0]?.reviewTranscript).toEqual([]);
    expect(result.handoffCompaction.compaction).toBeDefined();
    expect(result.handoffCompaction.compaction?.summary.length).toBeGreaterThan(0);
  });

  test("keeps transcripts intact when compaction is disabled", () => {
    const result = compactSourceInstructionReviewPhaseContexts({
      phaseContexts: [
        createPhaseContext({
          reviewTranscript: ["assistant: line 1", "assistant: line 2"],
        }),
      ],
      heuristicInstructionText: "heuristic",
      instructionUnderReviewText: "existing",
      verificationText: "verification",
      compactionPolicy: {
        enabled: false,
        warningTokenBudget: 200,
        targetTokenBudget: 350,
        minimumResponseHeadroomTokens: 100,
      },
      modelContextWindowTokens: 500,
    });

    expect(result.handoffCompaction.mode).toBe("full_context");
    expect(result.handoffCompaction.droppedTranscriptLineCount).toBe(0);
    expect(result.handoffCompaction.compaction).toBeNull();
    expect(result.phaseContexts[0]?.reviewTranscript).toHaveLength(2);
  });
});
