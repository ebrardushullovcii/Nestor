import { expect, test } from "vitest";
import { JobFinderIntelligenceSafeguardsSchema } from "@nestor/contracts";
import { projectPlanSafeguardPauses } from "./plan-safeguard-pauses";

test("projects only active plan pauses and removes dismissed pauses", () => {
  const pause = { id: "automatic_discovery_failures:plan", windowStartedAt: "2026-09-12T00:00:00.000Z",
    failuresInWindow: 3, sampleSize: 8, failureRatePercent: 37.5, failureRateThresholdPercent: 30, paused: true,
    explanation: "Search paused after repeated failures.", recoveryGuidance: "Review the failed searches." };
  const safeguards = JobFinderIntelligenceSafeguardsSchema.parse({ abnormalFailurePauses: [
    pause, { ...pause, id: "automatic_discovery_failures:other" },
    { ...pause, id: "automatic_application_failures:plan", paused: false },
  ] });
  const plans = [{ id: "plan", name: "My search" }];
  expect(projectPlanSafeguardPauses(safeguards, plans)).toEqual([{
    id: pause.id, campaignId: "plan", planName: "My search",
    title: "Paused after repeated failures (37.5% failed)",
    explanation: pause.explanation, route: "/job-finder/safeguards",
  }]);
  safeguards.safeguardDismissals.push({ id: "dismiss", kind: "abnormal_failure_pause",
    referenceId: pause.id, reason: "user_resolved", note: null, dismissedAt: pause.windowStartedAt });
  expect(projectPlanSafeguardPauses(safeguards, plans)).toEqual([]);
});
