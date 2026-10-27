import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelTokenUsage, ModelUsageTotals } from "@nestor/contracts";

type State = ModelUsageTotals & { reported: number };
const scopes = new AsyncLocalStorage<State>();
export function createModelUsageRecorder() {
  const state: State = {
    calls: 0,
    reported: 0,
    unreportedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  return {
    run: <T>(work: () => Promise<T>): Promise<T> => scopes.run(state, work),
    snapshot: (): ModelUsageTotals => ({
      calls: state.calls,
      unreportedCalls: state.calls - state.reported,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cachedInputTokens: state.cachedInputTokens,
      reasoningTokens: state.reasoningTokens,
      ...(state.estimated ? { estimated: { ...state.estimated } } : {}),
    }),
  };
}
export const hasModelUsageScope = () => scopes.getStore() !== undefined;
export function recordModelRequestAttempt(): void {
  const state = scopes.getStore();
  if (state) state.calls++;
}
export function recordModelRequestUsage(usage: ModelTokenUsage): void {
  const state = scopes.getStore();
  if (!state) return;
  if (!usage.estimated) state.reported++;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningTokens",
  ] as const)
    state[key] += usage[key];
  if (usage.estimated) {
    const before = state.estimated;
    state.estimated = {
      ...usage.estimated,
      calls: (before?.calls ?? 0) + usage.estimated.calls,
      inputTokens: (before?.inputTokens ?? 0) + usage.estimated.inputTokens,
      outputTokens: (before?.outputTokens ?? 0) + usage.estimated.outputTokens,
    };
  }
}
