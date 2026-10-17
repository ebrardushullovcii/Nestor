import type {
  ApplyBlockerReason,
  JobSearchCampaignStopRules,
} from "@nestor/contracts";

export interface CampaignApplyStopCounts {
  blockedCount: number;
  failedCount: number;
  processedCount: number;
}

export interface EvaluateCampaignApplyStopRulesInput extends CampaignApplyStopCounts {
  blockerReason: ApplyBlockerReason | null;
  stopRules: JobSearchCampaignStopRules;
}

const loginRequiredReasons = new Set<ApplyBlockerReason>([
  "auth_required",
  "signup_consent_required",
]);

const changedFormReasons = new Set<ApplyBlockerReason>([
  "field_interpretation_failed",
  "submit_confirmation_missing",
  "unexpected_navigation",
]);

// Safe proxy for unresolved eligibility / user-answer uncertainty, not a fit score.
const uncertainEligibilityReasons = new Set<ApplyBlockerReason>([
  "required_human_input",
  "question_grounding_failed",
]);

/**
 * The stop rule for questions only the person can answer. It is not a safety
 * limit being hit: the run did what it could and the rest waits in Needs you,
 * so the run's summary says that instead of "paused by safety rules".
 */
export const UNCERTAIN_ELIGIBILITY_PAUSE_REASON =
  "Pausing: unresolved eligibility or user-answer uncertainty requires human input.";

export function isQuestionHandoffPauseReason(reason: string | null): boolean {
  return reason === UNCERTAIN_ELIGIBILITY_PAUSE_REASON;
}

function formatFailureRateReason(
  failureRatePercent: number,
  thresholdPercent: number,
): string {
  return `Pausing: application failure rate ${Math.round(failureRatePercent)}% is at or above the configured ${thresholdPercent}% threshold.`;
}

export function evaluateCampaignApplyStopRules(
  input: EvaluateCampaignApplyStopRulesInput,
): string | null {
  const { blockerReason, stopRules } = input;

  // Specific blocker mappings take precedence over the aggregate failure rate.
  if (blockerReason !== null) {
    if (
      stopRules.pauseOnLoginRequired &&
      loginRequiredReasons.has(blockerReason)
    ) {
      return "Pausing: login or signup consent is required before applying can continue.";
    }
    if (stopRules.pauseOnChangedForm && changedFormReasons.has(blockerReason)) {
      return "Pausing: the application form changed in a way that prevents safe preparation.";
    }
    if (
      stopRules.pauseOnUncertainEligibility &&
      uncertainEligibilityReasons.has(blockerReason)
    ) {
      return UNCERTAIN_ELIGIBILITY_PAUSE_REASON;
    }
  }

  // Clamp defensively so malformed negative counts can never widen the pause window.
  const processedCount = Math.max(0, input.processedCount);
  const blockedCount = Math.max(0, input.blockedCount);
  const failedCount = Math.max(0, input.failedCount);

  if (
    processedCount > 0 &&
    processedCount >= stopRules.failureRateMinimumSample
  ) {
    const unsuccessfulCount = Math.min(
      processedCount,
      blockedCount + failedCount,
    );
    const failureRatePercent = (unsuccessfulCount / processedCount) * 100;
    if (failureRatePercent >= stopRules.pauseOnFailureRatePercent) {
      return formatFailureRateReason(
        failureRatePercent,
        stopRules.pauseOnFailureRatePercent,
      );
    }
  }

  return null;
}
