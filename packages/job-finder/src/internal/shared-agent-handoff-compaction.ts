import { reportSelfLimitHit, selfLimitSlice } from "@nestor/core";
import {
  SharedAgentCompactionPolicySchema,
  SharedAgentCompactionSnapshotSchema,
  SharedAgentHandoffCompactionSchema,
  type SharedAgentCompactionPolicy,
  type SharedAgentHandoffCompaction,
} from "@nestor/contracts";

import { uniqueStrings } from "./shared";
import type { SourceInstructionFinalReviewPhaseContext } from "./source-instruction-types";

const NORMALIZED_CONTEXT_EXHAUSTED_REASON =
  "Context budget exhausted after compaction.";
const MAX_PHASE_CONFIRMED_FACTS = 12;
const MAX_PHASE_ATTEMPTED_ACTIONS = 10;
const MAX_AGGREGATED_CONFIRMED_FACTS = 16;
const MAX_BLOCKER_NOTES = 8;
const MAX_AVOID_STRATEGY_FINGERPRINTS = 12;
const MAX_PRESERVED_CONTEXT_LINES = 12;
const MAX_STICKY_WORKFLOW_STATE_LINES = 16;

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function estimatePhaseContextTokens(
  context: SourceInstructionFinalReviewPhaseContext,
): number {
  return estimateTokens(JSON.stringify(context));
}

function getEffectiveBudgets(input: {
  policy: SharedAgentCompactionPolicy;
  modelContextWindowTokens: number | null;
}) {
  const effectiveTarget = input.modelContextWindowTokens
    ? Math.min(
        input.policy.targetTokenBudget,
        Math.max(
          1,
          input.modelContextWindowTokens -
            input.policy.minimumResponseHeadroomTokens,
        ),
      )
    : input.policy.targetTokenBudget;

  return {
    warning: Math.min(input.policy.warningTokenBudget, effectiveTarget),
    target: effectiveTarget,
  };
}

function summarizePhaseContext(
  context: SourceInstructionFinalReviewPhaseContext,
): SourceInstructionFinalReviewPhaseContext {
  const parsedCompactionState = context.compactionState
    ? SharedAgentCompactionSnapshotSchema.safeParse(context.compactionState)
    : null;

  return {
    ...context,
    reviewTranscript: [],
    compactionState: parsedCompactionState?.success
      ? parsedCompactionState.data
      : null,
    confirmedFacts: selfLimitSlice(
      uniqueStrings(context.confirmedFacts),
      0,
      MAX_PHASE_CONFIRMED_FACTS,
      "packages/job-finder/src/internal/shared-agent-handoff-compaction.ts:67",
    ),
    attemptedActions: selfLimitSlice(
      uniqueStrings(context.attemptedActions),
      0,
      MAX_PHASE_ATTEMPTED_ACTIONS,
      "packages/job-finder/src/internal/shared-agent-handoff-compaction.ts:73",
    ),
  };
}

export function compactSourceInstructionReviewPhaseContexts(input: {
  phaseContexts: readonly SourceInstructionFinalReviewPhaseContext[];
  heuristicInstructionText: string;
  instructionUnderReviewText: string;
  verificationText: string;
  compactionPolicy: Partial<SharedAgentCompactionPolicy>;
  modelContextWindowTokens: number | null;
}): {
  phaseContexts: SourceInstructionFinalReviewPhaseContext[];
  handoffCompaction: SharedAgentHandoffCompaction;
} {
  const policy = SharedAgentCompactionPolicySchema.parse(
    input.compactionPolicy,
  );

  if (!policy.enabled) {
    return {
      phaseContexts: input.phaseContexts.map((context) => ({
        ...context,
        reviewTranscript: [...context.reviewTranscript],
      })),
      handoffCompaction: SharedAgentHandoffCompactionSchema.parse({
        mode: "full_context",
        keptTranscriptLineCount: input.phaseContexts.reduce(
          (sum, context) => sum + context.reviewTranscript.length,
          0,
        ),
        droppedTranscriptLineCount: 0,
        compactedPhaseContextCount: 0,
        compaction: null,
        normalizedFailureReason: null,
      }),
    };
  }

  const budgets = getEffectiveBudgets({
    policy,
    modelContextWindowTokens: input.modelContextWindowTokens,
  });
  const basePromptTokens = estimateTokens(
    [
      input.heuristicInstructionText,
      input.instructionUnderReviewText,
      input.verificationText,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const totalBefore =
    basePromptTokens +
    input.phaseContexts.reduce(
      (sum, context) => sum + estimatePhaseContextTokens(context),
      0,
    );

  if (totalBefore < budgets.warning) {
    return {
      phaseContexts: input.phaseContexts.map((context) => ({
        ...context,
        reviewTranscript: [...context.reviewTranscript],
      })),
      handoffCompaction: SharedAgentHandoffCompactionSchema.parse({
        mode: "full_context",
        keptTranscriptLineCount: input.phaseContexts.reduce(
          (sum, context) => sum + context.reviewTranscript.length,
          0,
        ),
        droppedTranscriptLineCount: 0,
        compactedPhaseContextCount: 0,
        compaction: null,
        normalizedFailureReason: null,
      }),
    };
  }

  const summarizedPhaseContexts = input.phaseContexts.map(
    summarizePhaseContext,
  );
  reportSelfLimitHit({
    limit: "source_review_context",
    kind: "context",
    value: budgets.warning,
    where: "job-finder/compactSourceInstructionReviewPhaseContexts",
  });
  const totalAfter =
    basePromptTokens +
    summarizedPhaseContexts.reduce(
      (sum, context) => sum + estimatePhaseContextTokens(context),
      0,
    );

  const totalDroppedTranscriptLines = input.phaseContexts.reduce(
    (sum, context) => sum + context.reviewTranscript.length,
    0,
  );

  return {
    phaseContexts: summarizedPhaseContexts,
    handoffCompaction: SharedAgentHandoffCompactionSchema.parse({
      mode: "summary_first",
      keptTranscriptLineCount: 0,
      droppedTranscriptLineCount: totalDroppedTranscriptLines,
      compactedPhaseContextCount: summarizedPhaseContexts.length,
      compaction: SharedAgentCompactionSnapshotSchema.parse({
        compactedAt: new Date().toISOString(),
        compactionCount: 1,
        triggerKind: "token_budget",
        estimatedTokensBefore: totalBefore,
        estimatedTokensAfter: totalAfter,
        summary:
          "Source-debug final review handoff switched to summary-first phase context to stay within budget.",
        confirmedFacts: selfLimitSlice(
          uniqueStrings(
            summarizedPhaseContexts.flatMap(
              (context) => context.confirmedFacts,
            ),
          ),
          0,
          MAX_AGGREGATED_CONFIRMED_FACTS,
          "packages/job-finder/src/internal/shared-agent-handoff-compaction.ts:193",
        ),
        blockerNotes: selfLimitSlice(
          uniqueStrings(
            summarizedPhaseContexts.flatMap((context) =>
              context.blockerSummary ? [context.blockerSummary] : [],
            ),
          ),
          0,
          MAX_BLOCKER_NOTES,
          "packages/job-finder/src/internal/shared-agent-handoff-compaction.ts:203",
        ),
        avoidStrategyFingerprints: selfLimitSlice(
          uniqueStrings(
            summarizedPhaseContexts.flatMap(
              (context) =>
                context.compactionState?.avoidStrategyFingerprints ?? [],
            ),
          ),
          0,
          MAX_AVOID_STRATEGY_FINGERPRINTS,
          "packages/job-finder/src/internal/shared-agent-handoff-compaction.ts:213",
        ),
        preservedContext: selfLimitSlice(
          uniqueStrings(
            summarizedPhaseContexts.flatMap((context) => [
              `Phase ${context.phase}: ${context.resultSummary}`,
            ]),
          ),
          0,
          MAX_PRESERVED_CONTEXT_LINES,
          "packages/job-finder/src/internal/shared-agent-handoff-compaction.ts:224",
        ),
        stickyWorkflowState: selfLimitSlice(
          uniqueStrings(
            summarizedPhaseContexts.flatMap((context) => [
              `Phase goal: ${context.phaseGoal}`,
              ...context.successCriteria.map(
                (criterion) => `Success criterion: ${criterion}`,
              ),
            ]),
          ),
          0,
          MAX_STICKY_WORKFLOW_STATE_LINES,
          "packages/job-finder/src/internal/shared-agent-handoff-compaction.ts:234",
        ),
      }),
      normalizedFailureReason:
        totalAfter > budgets.target
          ? NORMALIZED_CONTEXT_EXHAUSTED_REASON
          : null,
    }),
  };
}

export function createSharedAgentContextBudgetFailureReason(): string {
  return NORMALIZED_CONTEXT_EXHAUSTED_REASON;
}
