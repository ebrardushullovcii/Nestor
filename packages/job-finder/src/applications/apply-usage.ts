import type {
  ApplicationApplyUsageTotals,
  ApplyAgentTiming,
  ApplyExecutionResult,
  ModelUsageTotals,
} from "@nestor/contracts";

const empty = (): ModelUsageTotals => ({
  calls: 0,
  unreportedCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
});
function fromTiming(timing: ApplyAgentTiming | undefined): ModelUsageTotals {
  if (!timing) return { ...empty(), calls: 1, unreportedCalls: 1 };
  const calls = Math.max(
    timing.modelTurns + timing.auxiliaryModelCalls,
    timing.transportCalls ?? 0,
  );
  return {
    ...empty(),
    ...timing.tokenUsage,
    calls,
    unreportedCalls: timing.tokenUsage?.unreportedCalls ?? calls,
  };
}
/** Retain earlier preparations; this scope counts actual provider requests, including letters and retries. */
export function accumulateApplyUsage(
  previous:
    | Pick<ApplyExecutionResult, "agentTiming" | "applyUsageTotals">
    | undefined,
  observed: ModelUsageTotals,
): ApplicationApplyUsageTotals {
  const before =
    previous?.applyUsageTotals ??
    (previous
      ? { ...fromTiming(previous.agentTiming), preparationAttempts: 1 }
      : { ...empty(), preparationAttempts: 0 });
  const current = observed;
  return {
    calls: before.calls + current.calls,
    unreportedCalls: before.unreportedCalls + current.unreportedCalls,
    inputTokens: before.inputTokens + current.inputTokens,
    outputTokens: before.outputTokens + current.outputTokens,
    cachedInputTokens: before.cachedInputTokens + current.cachedInputTokens,
    reasoningTokens: before.reasoningTokens + current.reasoningTokens,
    preparationAttempts: before.preparationAttempts + 1,
    ...(before.estimated || current.estimated
      ? {
          estimated: {
            calls:
              (before.estimated?.calls ?? 0) + (current.estimated?.calls ?? 0),
            inputTokens:
              (before.estimated?.inputTokens ?? 0) +
              (current.estimated?.inputTokens ?? 0),
            outputTokens:
              (before.estimated?.outputTokens ?? 0) +
              (current.estimated?.outputTokens ?? 0),
            method: "utf8_bytes_div_4_visible_only" as const,
          },
        }
      : {}),
  };
}
