import {
  type JobFitJudgmentResult,
} from "@nestor/ai-providers";
import type {
  FitJudgment,
  JobPosting,
  MatchAssessment,
} from "@nestor/contracts";

import {
  createMatchAssessmentPostingFingerprint,
  MATCH_ASSESSMENT_SCORER_VERSION,
  sameFitEvidenceFingerprint,
} from "./match-assessment-session";

export { applyFitJudgment, readCarriedJudgment } from "./fit-judgment-apply";

/**
 * Batch fit judging: the model judges many jobs per call against the
 * person's profile and goals (ADR 0041). See fit-judgment-apply for how a
 * verdict replaces the rule scorer's.
 */

export function toFitJudgment(
  result: Omit<JobFitJudgmentResult, "jobId">,
  input: {
    source: FitJudgment["source"];
    judgedAt: string;
    contextFingerprint: string | null;
    postingFingerprint: string | null;
  },
): FitJudgment {
  return {
    source: input.source,
    judgedAt: input.judgedAt,
    contextFingerprint: input.contextFingerprint,
    postingFingerprint: input.postingFingerprint,
    score: result.score,
    recommendation: result.recommendation,
    role: result.role,
    roleExplanation: result.roleExplanation,
    preferences: result.preferences,
    preferencesExplanation: result.preferencesExplanation,
    locationReach: result.locationReach,
    reasons: result.reasons.slice(0, 4),
    gaps: result.gaps.slice(0, 4),
    summary: result.summary ?? null,
    listingClosed: result.listingClosed,
    listingClosedEvidence: result.listingClosedEvidence,
  };
}

/**
 * Whether the model should judge this job (again): never judged, or judged
 * before the profile facts, the goals or the listing it was given changed.
 * A verdict an earlier build stamped with the whole-input fingerprint of the
 * same inputs (`legacyVerdictFingerprint`) is current too.
 * Rubric changes alone are refreshed only by the search's capped older-job
 * pass (`refreshRubric`), never by automatic judging when Find jobs opens.
 */
export function jobNeedsFitJudgment(
  job: JobPosting & { matchAssessment: MatchAssessment },
  verdictFingerprint: string,
  legacyVerdictFingerprint?: string,
  options: { refreshRubric?: boolean } = {},
): boolean {
  const judgment = job.matchAssessment.judgment;
  if (!judgment) {
    return true;
  }
  return (
    (options.refreshRubric === true &&
      job.matchAssessment.scorerVersion < MATCH_ASSESSMENT_SCORER_VERSION) ||
    (!sameFitEvidenceFingerprint(
      judgment.contextFingerprint,
      verdictFingerprint,
    ) &&
      (legacyVerdictFingerprint === undefined ||
        !sameFitEvidenceFingerprint(
          judgment.contextFingerprint,
          legacyVerdictFingerprint,
        ))) ||
    !sameFitEvidenceFingerprint(
      judgment.postingFingerprint,
      fitPostingFingerprint(job),
    )
  );
}

/** What a verdict was given on: it changes when the listing does. */
export function fitPostingFingerprint(job: JobPosting): string {
  return createMatchAssessmentPostingFingerprint(job);
}
