import { describe, expect, test } from "vitest";
import {
  JobFinderDashboardSummarySchema,
  UpdateApplicationDefaultsInputSchema,
} from "./index";

describe("contracts workspace snapshot schema", () => {
  test("the Apply setting accepts fill or send and rejects the engine-only prepare capability", () => {
    for (const mode of ["confirm_before_submit", "autonomous_submit"]) {
      expect(
        UpdateApplicationDefaultsInputSchema.parse({
          applicationAutomationMode: mode,
        }).applicationAutomationMode,
      ).toBe(mode);
    }
    expect(() =>
      UpdateApplicationDefaultsInputSchema.parse({
        applicationAutomationMode: "prepare_only",
      }),
    ).toThrow();
  });
  test("parses a dashboard summary with no daily preparation capacity", () => {
    const base = {
      generatedAt: "2026-03-20T10:05:00.000Z",
      activeCampaignId: "campaign-test",
      activeCampaignCount: 1,
      jobsFoundToday: 0,
      jobsAwaitingReview: 0,
      applicationsReadyForApproval: 0,
      applicationsAppliedToday: 0,
      applicationsAppliedThisWeek: 0,
      needsYouCount: 0,
      upcomingInterviews: 0,
      upcomingFollowUps: 0,
      responseRate: null,
      interviewRate: null,
      sourceHealth: { healthy: 0, needsAttention: 0, running: 0, total: 0 },
      backgroundOperationCount: 0,
      recommendedNextAction: {
        label: "Find jobs",
        detail: "Start the active campaign.",
        route: "/job-finder/discovery",
      },
    };

    expect(
      JobFinderDashboardSummarySchema.safeParse({
        ...base,
      }).success,
    ).toBe(true);
  });
});
