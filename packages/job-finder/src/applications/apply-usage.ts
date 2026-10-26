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
/** Retain earlier preparations and prefer the scope that also sees letters and provider retries. */
export function accumulateApplyUsage(
  previous:
    | Pick<ApplyExecutionResult, "agentTiming" | "applyUsageTotals">
    | undefined,
  timing: ApplyAgentTiming | undefined,
  observed: ModelUsageTotals,
): ApplicationApplyUsageTotals {
  const before =
    previous?.applyUsageTotals ??
    (previous
      ? { ...fromTiming(previous.agentTiming), preparationAttempts: 1 }
      : { ...empty(), preparationAttempts: 0 });
  const current = observed.calls > 0 ? observed : fromTiming(timing);
  return {
    calls: before.calls + current.calls,
    unreportedCalls: before.unreportedCalls + current.unreportedCalls,
    inputTokens: before.inputTokens + current.inputTokens,
    outputTokens: before.outputTokens + current.outputTokens,
    cachedInputTokens: before.cachedInputTokens + current.cachedInputTokens,
    reasoningTokens: before.reasoningTokens + current.reasoningTokens,
    preparationAttempts: before.preparationAttempts + 1,
  };
}
