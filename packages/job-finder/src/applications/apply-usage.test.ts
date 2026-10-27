import { expect, test } from "vitest";
import { ApplicationApplyUsageTotalsSchema } from "@nestor/contracts";
import { accumulateApplyUsage } from "./apply-usage";

test("a saved skip before the agent starts records zero model calls", () => {
  expect(
    accumulateApplyUsage(undefined, {
      calls: 0,
      unreportedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    }),
  ).toMatchObject({
    calls: 0,
    unreportedCalls: 0,
    inputTokens: 0,
    preparationAttempts: 1,
  });
});
test("a resumed fill keeps earlier calls and tokens, including a provider retry with unreported usage", () => {
  const before = ApplicationApplyUsageTotalsSchema.parse(
    JSON.parse(
      JSON.stringify({
        calls: 3,
        unreportedCalls: 0,
        inputTokens: 400,
        outputTokens: 20,
        cachedInputTokens: 300,
        reasoningTokens: 10,
        preparationAttempts: 1,
      }),
    ),
  );
  const total = accumulateApplyUsage({ applyUsageTotals: before }, {
    calls: 6,
    unreportedCalls: 1,
    inputTokens: 200,
    outputTokens: 10,
    cachedInputTokens: 100,
    reasoningTokens: 5,
  });
  expect(total).toEqual({
    calls: 9,
    unreportedCalls: 1,
    inputTokens: 600,
    outputTokens: 30,
    cachedInputTokens: 400,
    reasoningTokens: 15,
    preparationAttempts: 2,
  });
});
