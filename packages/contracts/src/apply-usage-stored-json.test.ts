import { expect, test } from "vitest";
import { ApplyAgentTimingSchema } from "./agent-timing";
import { ApplyExecutionResultSchema } from "./discovery";

test("old execution JSON reads with no invented historical usage totals", () => {
  const execution = ApplyExecutionResultSchema.parse({
    state: "ready",
    summary: "Prepared",
    detail: "Stored detail",
    submittedAt: null,
    outcome: null,
    nextActionLabel: "Review the form",
  });
  expect(execution.applyUsageTotals).toBeNull();
  const timing = ApplyAgentTimingSchema.parse({
    totalMs: 1,
    modelMs: 0,
    modelTurns: 0,
    auxiliaryModelMs: 0,
    auxiliaryModelCalls: 0,
    toolMs: 0,
    pageReadMs: 0,
    pageReads: 0,
    writeMs: 0,
    uploadMs: 0,
    longestSteps: [],
    requests: [],
  });
  // An old run did not count provider requests; it does not claim zero.
  expect(timing.transportCalls).toBeUndefined();
  expect(timing.transportRetries).toBeUndefined();
});
