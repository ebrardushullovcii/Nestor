import type {
  JobListMatchAssessment,
  ListingActivity,
  SavedJob,
} from "@nestor/contracts";

import { isProvisionalMatchAssessment } from "./discovery-ordering";
import { isTargetTitleFamily } from "./internal/discovery-title-family";

type DiscoveryBandJob = Pick<SavedJob, "discoveryMethod"> & {
  matchAssessment: JobListMatchAssessment;
  listingActivity?: ListingActivity;
};

function isClosedDiscoveryJob(job: DiscoveryBandJob): boolean {
  return (
    job.listingActivity?.status === "closed" ||
    job.matchAssessment.judgment?.listingClosed === true
  );
}

/**
 * How results are banded for counting and for display.
 *
 * This used to live only in the renderer, which meant the run's own frozen
 * accounting could not say how many of the kept jobs were worth opening
 * without a second implementation. One implementation lives here and the
 * renderer reads it, so the number a finished run recorded and the number
 * Find jobs shows are the same rule applied to the same rows.
 */

/**
 * Floor for the default Results view. A job whose current assessment scores
 * below this is a clear mismatch for the saved targets even when the scorer
 * stopped short of a hard `skip`; it stays reachable through
 * "Show mismatches" and is never removed from the workspace. Withheld scores
 * are not judged by this floor: an offline catalog row, an unbound score, and
 * a title-only listing all fail to earn a percentage, and hiding a row for a
 * number the app has just refused to print would hide it for a reason the app
 * says it cannot assess.
 */
export const DISCOVERY_CLEAR_MISMATCH_SCORE_FLOOR = 35;

/**
 * Above the mismatch floor but still clearly behind the leading results.
 * Rows in this band are honest results, not filler to hide, but presenting
 * them in one flat list next to a 64% engineering match reads as though the
 * app considers a 36% role from another profession comparable. They keep
 * their place in the ranked list under an explicit divider instead.
 */
export const DISCOVERY_WEAKER_MATCH_SCORE_FLOOR = 50;

export const FIT_NOT_JUDGED_REASON =
  "The AI judges each job against your profile and goals after a search. Choose Judge fit to do this one now.";

export interface FitEvidenceDepth {
  /** The model has not judged this job yet (ADR 0041). */
  isNotJudged: boolean;
  /** One-line explanation for a job without a verdict. */
  reason: string;
  verifiedDimensionCount: number;
}

/**
 * How much of the score was actually verified against evidence.
 *
 * A headline "54% fit" printed above "The listing text was not captured",
 * "Salary not stated" and "Location not stated" is a number the app cannot
 * stand behind. This is the single place that decides whether a percentage
 * has been earned, so the row, the inspector, the breakdown and the run's own
 * frozen counts cannot disagree.
 */
export function getFitEvidenceDepth(
  assessment: JobListMatchAssessment,
): FitEvidenceDepth {
  // Every field is read defensively: this runs for every row on the screen,
  // including legacy and partial payloads that were cast past the schema
  // boundary. A missing dimension counts as "not verified", never as a crash.
  const dimensions = assessment.dimensions;
  const roleSuitability = dimensions?.roleSuitability?.state;
  const evidenceConfidence = dimensions?.evidenceConfidence?.level;
  const compensationFit = assessment.compensationFit?.state;
  // A requirement only counts once it was actually decided against captured
  // listing evidence. The existence of a row proves nothing: the scorer emits
  // a location requirement purely because the user saved a place, and its
  // status stays "unknown" when the listing never stated one. Saved
  // location/work-mode comparisons are preference checks rather than proof
  // that the listing exposed anything, exactly as the evidence-confidence
  // dimension already treats them.
  const decidedRequirementCount = (assessment.requirements ?? []).filter(
    (requirement) =>
      (requirement?.status === "supported" ||
        requirement?.status === "partial" ||
        requirement?.status === "missing" ||
        requirement?.status === "conflict") &&
      requirement?.category !== "location" &&
      requirement?.category !== "work_mode",
  ).length;
  const verifiedChecks = [
    decidedRequirementCount > 0,
    roleSuitability === "exact" || roleSuitability === "conflict",
    // Preference alignment is built from the location and work-mode facets
    // excluded above, so it is the same saved-preference check and is left
    // out for the same reason: a footer's "Remote" link must not earn a "%".
    compensationFit === "meets_minimum" || compensationFit === "below_minimum",
    evidenceConfidence === "moderate" || evidenceConfidence === "high",
  ];
  const verifiedDimensionCount = verifiedChecks.filter(Boolean).length;

  return {
    // Only the model's verdict earns a number (ADR 0041); a job it has not
    // judged yet shows none, whatever else was read.
    isNotJudged: !assessment.judgment,
    reason: FIT_NOT_JUDGED_REASON,
    verifiedDimensionCount,
  };
}

/**
 * No percentage may be printed as a headline for this row, and no band may
 * be earned or lost because of one.
 */
export function isMatchScoreWithheld(
  job: Pick<SavedJob, "discoveryMethod"> & {
    matchAssessment: JobListMatchAssessment;
  },
): boolean {
  // Fails closed for legacy or malformed payloads that may have been cast
  // past the schema boundary: a score without both binding fingerprints is
  // never presented as an authoritative current assessment.
  const hasAssessmentBinding = [
    job.matchAssessment.contextFingerprint,
    job.matchAssessment.postingFingerprint,
  ].every(
    (fingerprint) =>
      typeof fingerprint === "string" && fingerprint.trim().length > 0,
  );
  const isProvisional =
    isProvisionalMatchAssessment(job) || !hasAssessmentBinding;
  return isProvisional || getFitEvidenceDepth(job.matchAssessment).isNotJudged;
}

export type DiscoveryResultGroupId =
  | "matches"
  | "unchecked"
  | "weaker"
  | "mismatches";

/**
 * The listing is in a place the person asked for and its title sits in the
 * same or an adjacent occupational family as a saved target role.
 *
 * "Clear mismatches" says the row conflicts with the saved roles, locations
 * or requirements, and is hidden on that claim. A Chicago paid-media manager
 * returned for a Chicago marketing-manager search conflicts with neither: it
 * is the search's own subject, scored low. Demoting it there for a number
 * alone told the person their own request was a mismatch, so the score floor
 * does not apply to it. The verdict is the scorer's own — the title family it
 * recorded and the location reach it measured — so this stays source-generic.
 */
function isRequestedRoleInRequestedPlace(job: DiscoveryBandJob): boolean {
  return (
    job.matchAssessment?.locationReach === "in_area" &&
    isTargetTitleFamily(job.matchAssessment)
  );
}

export function isDiscoveryClearMismatch(job: DiscoveryBandJob): boolean {
  if (isClosedDiscoveryJob(job)) {
    return true;
  }
  // A row with no assessment at all is not a judgement against it.
  if (!job.matchAssessment) {
    return false;
  }
  // An explicit `skip` rests on an observed conflict rather than on the
  // number, so it still bands as a mismatch.
  if (job.matchAssessment.recommendation === "skip") {
    return true;
  }

  return (
    !isMatchScoreWithheld(job) &&
    job.matchAssessment.score < DISCOVERY_CLEAR_MISMATCH_SCORE_FLOOR &&
    !isRequestedRoleInRequestedPlace(job)
  );
}

/**
 * Bands a single row into one of four honest populations.
 *
 * A row whose score is withheld is neither recommended nor demoted by that
 * score. Promoting it to the leading band claims the app checked something it
 * never opened; demoting it to "also found" hides it for a number the app has
 * just refused to print. It therefore gets its own band, which says exactly
 * what is true: the title matched and nothing else was checked yet.
 *
 * A hard `skip` still bands as a mismatch even with a withheld score, because
 * that verdict rests on an observed conflict rather than on the number.
 */
export function getDiscoveryResultGroup(
  job: DiscoveryBandJob,
): DiscoveryResultGroupId {
  if (isDiscoveryClearMismatch(job)) {
    return "mismatches";
  }

  if (!job.matchAssessment) {
    return "unchecked";
  }

  if (isMatchScoreWithheld(job)) {
    // No verdict yet, so no judgement for or against it (ADR 0041).
    return "unchecked";
  }

  return job.matchAssessment.score < DISCOVERY_WEAKER_MATCH_SCORE_FLOOR
    ? "weaker"
    : "matches";
}

/**
 * The rows the app is willing to recommend opening: checked evidence *and* a
 * score it is prepared to print. Nothing else earns this band.
 */
export function isDiscoveryWorthOpeningResult(job: DiscoveryBandJob): boolean {
  return getDiscoveryResultGroup(job) === "matches";
}

/** How many results are in the leading band — the honest headline number. */
export function countDiscoveryStrongMatches(jobs: readonly SavedJob[]): number {
  let count = 0;
  for (const job of jobs) {
    if (isDiscoveryWorthOpeningResult(job)) {
      count += 1;
    }
  }
  return count;
}
