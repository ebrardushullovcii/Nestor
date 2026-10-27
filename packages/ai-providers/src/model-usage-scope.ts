import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelUsageTotals } from "@nestor/contracts";
import type { ModelUsagePayload } from "./openai-compatible-transport";
import { normalizeModelUsage } from "./model-token-usage";

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
    }),
  };
}
export const hasModelUsageScope = () => scopes.getStore() !== undefined;
export function recordModelRequestAttempt(): void {
  const state = scopes.getStore();
  if (state) state.calls++;
}
export function recordModelRequestUsage(
  usage: ModelUsagePayload | undefined,
): void {
  const state = scopes.getStore();
  if (!state || !usage || typeof usage.prompt_tokens !== "number") return;
  state.reported++;
  const normalized = normalizeModelUsage(usage);
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "reasoningTokens",
  ] as const)
    state[key] += normalized[key];
}
