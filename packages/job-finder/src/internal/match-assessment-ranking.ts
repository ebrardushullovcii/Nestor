import type { MatchAssessment } from "@nestor/contracts";

const recommendationPriority: Record<
  MatchAssessment["recommendation"],
  number
> = {
  strong_fit: 0,
  apply_with_original: 1,
  review_before_applying: 2,
  skip: 3,
};

const roleSuitabilityPriority: Record<
  MatchAssessment["dimensions"]["roleSuitability"]["state"],
  number
> = {
  exact: 0,
  adjacent: 1,
  unknown: 2,
  conflict: 3,
};

export function compareMatchRecommendationPriority(
  left: MatchAssessment,
  right: MatchAssessment,
): number {
  return (
    recommendationPriority[left.recommendation] -
    recommendationPriority[right.recommendation]
  );
}

export function compareMatchScores(
  left: MatchAssessment,
  right: MatchAssessment,
): number {
  return right.score - left.score;
}

export function compareMatchRoleSuitabilityPriority(
  left: MatchAssessment,
  right: MatchAssessment,
): number {
  return (
    roleSuitabilityPriority[left.dimensions.roleSuitability.state] -
    roleSuitabilityPriority[right.dimensions.roleSuitability.state]
  );
}

export function compareMatchAssessments(
  left: MatchAssessment,
  right: MatchAssessment,
): number {
  return (
    compareMatchRecommendationPriority(left, right) ||
    compareMatchRoleSuitabilityPriority(left, right) ||
    compareMatchScores(left, right)
  );
}
