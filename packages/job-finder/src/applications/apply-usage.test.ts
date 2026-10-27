import { expect, test } from "vitest";
import { ApplicationApplyUsageTotalsSchema } from "@nestor/contracts";
import { accumulateApplyUsage } from "./apply-usage";

test("resumed preparations retain estimates separately from provider totals and old rows still load", () => {
  const before = ApplicationApplyUsageTotalsSchema.parse({
    calls: 1,
    unreportedCalls: 0,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 60,
    reasoningTokens: 5,
    preparationAttempts: 1,
  });
  const total = accumulateApplyUsage(
    { applyUsageTotals: before },
    {
      calls: 2,
      unreportedCalls: 1,
      inputTokens: 200,
      outputTokens: 30,
      cachedInputTokens: 100,
      reasoningTokens: 10,
      estimated: {
        calls: 1,
        inputTokens: 50,
        outputTokens: 4,
        method: "utf8_bytes_div_4_visible_only",
      },
    },
  );
  expect(
    ApplicationApplyUsageTotalsSchema.parse(JSON.parse(JSON.stringify(total))),
  ).toMatchObject({
    calls: 3,
    inputTokens: 300,
    outputTokens: 50,
    unreportedCalls: 1,
    estimated: { calls: 1, inputTokens: 50, outputTokens: 4 },
  });
  expect(before.estimated).toBeUndefined();
});

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
  const total = accumulateApplyUsage(
    { applyUsageTotals: before },
    {
      calls: 6,
      unreportedCalls: 1,
      inputTokens: 200,
      outputTokens: 10,
      cachedInputTokens: 100,
      reasoningTokens: 5,
    },
  );
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
