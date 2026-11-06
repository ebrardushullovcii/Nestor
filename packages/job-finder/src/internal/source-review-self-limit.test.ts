import { afterEach, expect, test, vi } from "vitest";
import {
  createDeterministicJobFinderAiClient,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import {
  JobDiscoveryTargetSchema,
  SourceDebugRunRecordSchema,
  SourceInstructionArtifactSchema,
} from "@nestor/contracts";
import { reviewSourceInstructionArtifactWithAi } from "./source-instruction-review";
import type { SourceInstructionFinalReviewPhaseContext } from "./source-instruction-types";
import { compactSourceInstructionReviewPhaseContexts } from "./shared-agent-handoff-compaction";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const at = "2026-11-06T00:00:00Z";
function phase(): SourceInstructionFinalReviewPhaseContext {
  return {
    phase: "search_filter_probe",
    phaseGoal: "Read jobs",
    successCriteria: ["Jobs read"],
    stopConditions: [],
    knownFactsAtStart: [],
    startedAt: at,
    completedAt: at,
    outcome: "succeeded",
    completionMode: "structured_finish",
    completionReason: null,
    resultSummary: "Read",
    blockerSummary: null,
    confirmedFacts: ["Read"],
    attemptedActions: ["Read"],
    phaseEvidence: null,
    visualEvidence: [],
    compactionState: null,
    reviewTranscript: ["Read"],
  };
}
function input(chatWithTools: NonNullable<JobFinderAiClient["chatWithTools"]>) {
  const target = JobDiscoveryTargetSchema.parse({
    id: "target",
    label: "Synthetic",
    startingUrl: "https://example.test/",
  });
  const run = SourceDebugRunRecordSchema.parse({
    id: "run",
    targetId: target.id,
    startedAt: at,
    updatedAt: at,
    targetLabel: target.label,
    targetUrl: target.startingUrl,
    targetHostname: "example.test",
  });
  const heuristicInstruction = SourceInstructionArtifactSchema.parse({
    id: "instruction",
    targetId: target.id,
    createdAt: at,
    updatedAt: at,
    basedOnRunId: run.id,
    versionInfo: {
      promptProfileVersion: "test",
      toolsetVersion: "test",
      adapterVersion: "test",
    },
  });
  return {
    aiClient: { ...createDeterministicJobFinderAiClient(), chatWithTools },
    target,
    run,
    heuristicInstruction,
    adapterKind: "target_site" as const,
    verification: null,
    instructionUnderReview: null,
    phaseContexts: [phase()],
    compactionPolicy: { enabled: false },
    modelContextWindowTokens: 128000,
  };
}
function limits(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === "string" && line.startsWith("[self_limit_hit] ")
      ? [JSON.parse(line.slice(17)) as { limit: string; value: number }]
      : [],
  );
}
test.each(["finish reason", "transport exception"])(
  "removed source-review output caps do not report %s",
  async (mode) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chat: NonNullable<JobFinderAiClient["chatWithTools"]> = () => {
      if (mode === "transport exception")
        return Promise.reject(Error("incomplete response: max_output_tokens"));
      return Promise.resolve({ content: "{}", finishReason: "length" });
    };
    await reviewSourceInstructionArtifactWithAi(input(chat));
    expect(
      limits(log).some((hit) => hit.limit === "source_review_output"),
    ).toBe(false);
  },
);
test("source review can finish beyond its removed sixty-second deadline", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const chat: NonNullable<JobFinderAiClient["chatWithTools"]> = (
    _messages,
    _tools,
    options,
  ) => {
    expect(Reflect.get(options ?? {}, "maxOutputTokens")).toBeUndefined();
    return new Promise((resolve) =>
      setTimeout(() => resolve({ content: "{}" }), 60001),
    );
  };
  const pending = reviewSourceInstructionArtifactWithAi(input(chat));
  await vi.advanceTimersByTimeAsync(60002);
  await pending;
  expect(limits(log)).toEqual([]);
});

test("source-review compaction reports lost transcript and every bounded summary collection", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const many = (name: string) =>
    Array.from({ length: 30 }, (_, i) => `${name} ${i}`);
  compactSourceInstructionReviewPhaseContexts({
    phaseContexts: Array.from({ length: 20 }, (_, i) => ({
      ...phase(),
      resultSummary: `Result ${i}`,
      blockerSummary: `Block ${i}`,
      phaseGoal: `Goal ${i}`,
      successCriteria: many(`success ${i}`),
      confirmedFacts: many(`fact ${i}`),
      attemptedActions: many(`action ${i}`),
      reviewTranscript: many(`transcript ${i}`),
    })),
    heuristicInstructionText: "heuristic",
    instructionUnderReviewText: "prior",
    verificationText: "verify",
    compactionPolicy: {
      warningTokenBudget: 200,
      targetTokenBudget: 300,
      minimumResponseHeadroomTokens: 100,
    },
    modelContextWindowTokens: 500,
  });
  expect(limits(log).some((hit) => hit.limit === "source_review_context")).toBe(
    true,
  );
  expect(limits(log).map((hit) => hit.value)).toEqual(
    expect.arrayContaining([12, 10, 16, 8]),
  );
});
