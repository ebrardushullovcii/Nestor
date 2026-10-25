import { describe, expect, test } from "vitest";
import type {
  ApplyBlockerReason,
  JobSearchCampaignStopRules,
} from "@nestor/contracts";
import {
  evaluateCampaignApplyStopRules,
  isQuestionHandoffPauseReason,
} from "./campaign-apply-stop-rules";

function buildStopRules(
  overrides: Partial<JobSearchCampaignStopRules> = {},
): JobSearchCampaignStopRules {
  return {
    pauseOnLoginRequired: true,
    pauseOnChangedForm: true,
    pauseOnUncertainEligibility: true,
    pauseOnFailureRatePercent: 30,
    failureRateMinimumSample: 5,
    ...overrides,
  };
}

function evaluate(
  blockerReason: ApplyBlockerReason | null,
  counts: {
    blockedCount?: number;
    failedCount?: number;
    processedCount?: number;
  },
  stopRules: JobSearchCampaignStopRules = buildStopRules(),
): string | null {
  return evaluateCampaignApplyStopRules({
    blockerReason,
    blockedCount: counts.blockedCount ?? 0,
    failedCount: counts.failedCount ?? 0,
    processedCount: counts.processedCount ?? 0,
    stopRules,
  });
}

describe("campaign apply stop rules", () => {
  test("a question hand-off is told apart from a safety limit", () => {
    expect(
      isQuestionHandoffPauseReason(
        evaluate("required_human_input", { processedCount: 1 }),
      ),
    ).toBe(true);
    expect(
      isQuestionHandoffPauseReason(
        evaluate("auth_required", { processedCount: 1 }),
      ),
    ).toBe(false);
    expect(
      isQuestionHandoffPauseReason(
        evaluate(null, { processedCount: 5, failedCount: 5 }),
      ),
    ).toBe(false);
    expect(isQuestionHandoffPauseReason(null)).toBe(false);
  });

  test("pauses on login-required blockers when enabled", () => {
    for (const reason of [
      "auth_required",
      "signup_consent_required",
    ] as const) {
      const pauseReason = evaluate(reason, { processedCount: 1 });
      expect(pauseReason).not.toBeNull();
      expect(pauseReason).toMatch(/login|signup/i);
    }
  });

  test("pauses on changed-form blockers when enabled", () => {
    for (const reason of [
      "field_interpretation_failed",
      "submit_confirmation_missing",
      "unexpected_navigation",
    ] as const) {
      expect(evaluate(reason, { processedCount: 1 })).not.toBeNull();
    }
  });

  test("pauses on uncertain-eligibility blockers with explicit eligibility language", () => {
    for (const reason of [
      "required_human_input",
      "question_grounding_failed",
    ] as const) {
      const pauseReason = evaluate(reason, { processedCount: 1 });
      expect(pauseReason).not.toBeNull();
      expect(pauseReason).toMatch(/eligibility|user-answer/i);
    }
  });

  test("does not pause on non-mapped blockers", () => {
    for (const reason of [
      "resume_missing",
      "resume_stale",
      "site_protection",
      "asset_unavailable",
      "provider_submit_auth_unavailable",
    ] as const) {
      expect(
        evaluate(reason, { processedCount: 10, blockedCount: 1 }),
      ).toBeNull();
    }
  });

  test("respects disabled specific-rule flags", () => {
    const stopRules = buildStopRules({
      pauseOnLoginRequired: false,
      pauseOnChangedForm: false,
      pauseOnUncertainEligibility: false,
    });
    expect(
      evaluate("auth_required", { processedCount: 1 }, stopRules),
    ).toBeNull();
    expect(
      evaluate("submit_confirmation_missing", { processedCount: 1 }, stopRules),
    ).toBeNull();
    expect(
      evaluate("required_human_input", { processedCount: 1 }, stopRules),
    ).toBeNull();
  });

  test("pauses on failure rate at the boundary", () => {
    const pauseReason = evaluate(null, {
      processedCount: 10,
      blockedCount: 3,
    });
    expect(pauseReason).not.toBeNull();
    expect(pauseReason).toMatch(/30%/);
  });

  test("does not pause on failure rate below the boundary", () => {
    expect(evaluate(null, { processedCount: 10, blockedCount: 2 })).toBeNull();
  });

  test("does not pause on failure rate with insufficient sample", () => {
    expect(evaluate(null, { processedCount: 4, blockedCount: 4 })).toBeNull();
  });

  test("does not divide by zero with zero processed count", () => {
    expect(evaluate(null, { processedCount: 0 })).toBeNull();
  });

  test("clamps malformed negative counts", () => {
    expect(
      evaluate(null, { processedCount: 10, blockedCount: -2, failedCount: -1 }),
    ).toBeNull();
    expect(evaluate(null, { processedCount: -5 })).toBeNull();
  });

  test("survives a malformed zero minimum sample without dividing by zero", () => {
    const stopRules = buildStopRules({ failureRateMinimumSample: 0 });
    expect(evaluate(null, { processedCount: 0 }, stopRules)).toBeNull();
  });

  test("specific blockers take precedence over the aggregate failure rate", () => {
    const pauseReason = evaluate("auth_required", {
      processedCount: 10,
      blockedCount: 10,
    });
    expect(pauseReason).toMatch(/login|signup/i);
    expect(pauseReason).not.toMatch(/failure rate/i);
  });

  test("falls back to failure rate when the specific flag is disabled", () => {
    const stopRules = buildStopRules({ pauseOnLoginRequired: false });
    const pauseReason = evaluate(
      "auth_required",
      { processedCount: 10, blockedCount: 10 },
      stopRules,
    );
    expect(pauseReason).toMatch(/failure rate/i);
  });
});
