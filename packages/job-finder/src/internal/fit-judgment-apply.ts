import type {
  FitJudgment,
  MatchAssessment,
  TitleFamilyMatch,
} from "@nestor/contracts";

/**
 * The model decides fit (ADR 0041). The rule scorer still builds an
 * assessment for a job the model has not judged yet, so a fresh search result
 * has a number to sort by; once the model has judged the job, its verdict
 * replaces the rule verdict: score, recommendation, role and preference fit,
 * place, reasons and gaps. What stays from the scorer is bookkeeping the
 * model is not asked for: salary arithmetic, application effort, and the
 * counts behind requirement evidence.
 */

const TITLE_FAMILY_BY_ROLE: Record<
  FitJudgment["role"],
  TitleFamilyMatch | null
> = {
  exact: "same_family",
  adjacent: "adjacent",
  conflict: "unrelated",
  unknown: null,
};

export function applyFitJudgment(
  assessment: MatchAssessment,
  judgment: FitJudgment,
): MatchAssessment {
  return {
    ...assessment,
    score: judgment.score,
    scoreIsUpperBound: false,
    locationReach: judgment.locationReach,
    titleFamilyMatch: TITLE_FAMILY_BY_ROLE[judgment.role],
    dimensions: {
      ...assessment.dimensions,
      roleSuitability: {
        state: judgment.role,
        explanation:
          judgment.roleExplanation ??
          "The model compared this role with the work you are looking for.",
        evidence: [],
      },
      preferenceAlignment: {
        state: judgment.preferences,
        explanation:
          judgment.preferencesExplanation ??
          "The model compared this listing with your saved goals.",
        evidence: [],
      },
    },
    reasons: judgment.reasons,
    gaps: judgment.gaps,
    recommendation: judgment.recommendation,
    // The model's own reason for its verdict; the other fields only stand in
    // for a verdict saved before it gave one.
    recommendationRationale:
      judgment.summary ??
      (judgment.recommendation === "skip"
        ? (judgment.gaps[0] ?? judgment.roleExplanation)
        : (judgment.roleExplanation ?? judgment.reasons[0])) ??
      "The model judged this listing against your profile and goals.",
    judgment,
  };
}

/** The verdict a posting carries from an earlier assessment, if any. */
export function readCarriedJudgment(posting: object): FitJudgment | null {
  const assessment = (posting as { matchAssessment?: MatchAssessment | null })
    .matchAssessment;
  return assessment?.judgment ?? null;
}

/** A completed read survives rediscovery and incomplete or older replacements. */
export function preserveCompletedAssessment(
  previous: MatchAssessment | null | undefined,
  incoming: MatchAssessment,
): MatchAssessment {
  if (!previous?.judgment) return incoming;
  if (!incoming.judgment) return previous;
  if (
    previous.judgment.contextFingerprint !==
      incoming.judgment.contextFingerprint ||
    previous.judgment.postingFingerprint !==
      incoming.judgment.postingFingerprint
  )
    return incoming;
  if (
    previous.judgment.source === "full" &&
    incoming.judgment.source !== "full"
  )
    return previous;
  if (
    Date.parse(incoming.judgment.judgedAt) <
    Date.parse(previous.judgment.judgedAt)
  )
    return previous;
  return incoming;
}
