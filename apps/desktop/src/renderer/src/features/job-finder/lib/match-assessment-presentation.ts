import type {
  FitRecommendation,
  JobRequirementEvidenceStatus,
  MatchLocationReach,
  RoleSuitabilityState,
  JobListRow,
  TitleFamilyMatch,
} from "@nestor/contracts";
import type { BadgeTone } from "./job-finder-types";
import { isProvisionalMatchAssessment } from "@nestor/job-finder/discovery-ordering";
import {
  FIT_NOT_JUDGED_REASON,
  getFitEvidenceDepth,
  type FitEvidenceDepth,
} from "@nestor/job-finder/discovery-result-bands";

export const fitRecommendationCopy: Record<
  FitRecommendation,
  { label: string; tone: BadgeTone }
> = {
  strong_fit: { label: "Strong fit", tone: "positive" },
  apply_with_original: { label: "Original resume is credible", tone: "active" },
  review_before_applying: {
    label: "Review before applying",
    tone: "neutral",
  },
  skip: { label: "Probably skip", tone: "critical" },
};

/**
 * Evidence depth and the not-judged reason now live in
 * `@nestor/job-finder/discovery-result-bands`, so a finished run's frozen
 * counts and this screen apply one rule. Re-exported because the renderer
 * already imports both from here.
 */
export {
  FIT_NOT_JUDGED_REASON,
  getFitEvidenceDepth,
  type FitEvidenceDepth,
};

export interface MatchAssessmentPresentation {
  /**
   * The assessment is not bound to the current profile and posting (a legacy
   * row or an offline catalog seed), so it describes some other state of the
   * world.
   */
  isProvisional: boolean;
  /** The model has not judged this job yet (ADR 0041). */
  isNotJudged: boolean;
  /**
   * No percentage may be printed as a headline. True for both of the states
   * above; every surface reads this one flag rather than re-deriving it.
   */
  isScoreWithheld: boolean;
  /**
   * The headline verdict. Never a percentage unless the number was earned:
   * a withheld score reads "Title match only" or "Fit not assessed" instead.
   */
  headlineScoreAriaLabel: string;
  headlineScoreLabel: string;
  /**
   * What is missing and what would change it. Null when the score stands on
   * its own evidence.
   */
  withheldReason: string | null;
  /**
   * The raw number with its own qualifier, for use *inside* the scoring
   * breakdown only — never as the row or inspector headline. Null when there
   * is no defensible number to show at all.
   */
  breakdownScoreLabel: string | null;
}

export const FIT_UNASSESSED_REASON =
  "This listing has not been checked against your current profile and the current listing text yet.";

/**
 * The one label a row the model has not judged yet uses, everywhere it
 * appears (ADR 0041). There is no number to show until the model has read the
 * listing against the profile.
 */
export const FIT_NOT_JUDGED_LABEL = "Not judged yet";

/**
 * Why several unrelated jobs can print the same number. The score stopped at
 * a ceiling an unresolved gap imposed, so it is the most this listing can
 * earn rather than a measurement that happens to tie.
 */
export const FIT_UPPER_BOUND_REASON =
  "This is the most this job can score while the gaps below are unresolved, so other jobs can show the same number.";

/**
 * Keeps the confidence qualifier next to every renderer score. A missing
 * binding, an offline catalog row, or a listing whose only readable evidence
 * was its own title can still be reviewed, but none of them earns a
 * percentage in the headline position.
 */
export function getMatchAssessmentPresentation(
  job: Pick<JobListRow, "discoveryMethod" | "matchAssessment">,
): MatchAssessmentPresentation {
  const hasAssessmentBinding = [
    job.matchAssessment.contextFingerprint,
    job.matchAssessment.postingFingerprint,
  ].every(
    (fingerprint) =>
      typeof fingerprint === "string" && fingerprint.trim().length > 0,
  );
  // Renderer presentation fails closed for legacy or malformed payloads that
  // may have been cast past the schema boundary. A score without both binding
  // fingerprints is never presented as an authoritative current assessment.
  return presentFitFacts({
    isProvisional: isProvisionalMatchAssessment(job) || !hasAssessmentBinding,
    isNotJudged: getFitEvidenceDepth(job.matchAssessment).isNotJudged,
    scoreIsUpperBound: Boolean(job.matchAssessment.scoreIsUpperBound),
    score: job.matchAssessment.score,
  });
}

/**
 * The fit wording from its four facts. Find jobs' query rows carry these
 * facts as columns, so a list row and the inspector say the same thing.
 */
export function presentFitFacts(facts: {
  isProvisional: boolean;
  isNotJudged: boolean;
  scoreIsUpperBound: boolean;
  score: number;
}): MatchAssessmentPresentation {
  const { isProvisional, isNotJudged, score } = facts;
  const isScoreWithheld = isProvisional || isNotJudged;

  if (isProvisional) {
    return {
      isProvisional,
      isNotJudged,
      isScoreWithheld,
      headlineScoreAriaLabel: "Overall fit: not assessed",
      headlineScoreLabel: "Fit not assessed",
      withheldReason: FIT_UNASSESSED_REASON,
      // An unbound assessment describes some other profile or listing text,
      // so even a qualified number would be misleading.
      breakdownScoreLabel: null,
    };
  }

  if (isNotJudged) {
    return {
      isProvisional,
      isNotJudged,
      isScoreWithheld,
      headlineScoreAriaLabel: `Overall fit: ${FIT_NOT_JUDGED_LABEL.toLowerCase()}`,
      headlineScoreLabel: FIT_NOT_JUDGED_LABEL,
      withheldReason: FIT_NOT_JUDGED_REASON,
      breakdownScoreLabel: null,
    };
  }

  // A ceiling is not a measurement: the number is the most this listing can
  // earn while its gaps stand, which is why unrelated jobs kept printing the
  // same "71% fit".
  if (facts.scoreIsUpperBound) {
    return {
      isProvisional,
      isNotJudged,
      isScoreWithheld,
      headlineScoreAriaLabel: `Overall fit: up to ${score} percent`,
      headlineScoreLabel: `Up to ${score}% fit`,
      withheldReason: FIT_UPPER_BOUND_REASON,
      breakdownScoreLabel: `Up to ${score}% fit`,
    };
  }

  return {
    isProvisional,
    isNotJudged,
    isScoreWithheld,
    headlineScoreAriaLabel: `Overall fit: ${score} percent`,
    headlineScoreLabel: `${score}% fit`,
    withheldReason: null,
    breakdownScoreLabel: `${score}% fit`,
  };
}

const TITLE_FAMILY_TIE_BREAK_REASON: Record<TitleFamilyMatch, string> = {
  same_family: "Job title matches one of your target roles.",
  adjacent: "Job title is close to your target roles, not an exact match.",
  unrelated: "Job title sits outside your target roles.",
};

const SENIORITY_TIE_BREAK_REASON: Partial<
  Record<JobRequirementEvidenceStatus, string>
> = {
  supported: "The level this role asks for matches your experience.",
  partial: "The level this role asks for is only a partial match.",
  missing: "The level this role asks for is above or below your experience.",
  conflict: "The level this role asks for conflicts with your experience.",
};

const LOCATION_REACH_TIE_BREAK_REASON: Partial<
  Record<MatchLocationReach, string>
> = {
  in_area: "This job is in one of the places you asked for.",
  remote_preferred: "This job is remote, which you asked for.",
  outside_area: "This job is outside the places you asked for.",
};

/**
 * The one strongest thing that separates this row from another row printing
 * the same percentage.
 *
 * Three rows read "26% fit" one under the other and two of them carried no
 * second line at all, so the order between them was something the person had
 * to take on trust. Every row that shares its number now states the strongest
 * fact behind its place in the list, in a fixed order of strength — the title
 * family first, then the level, then how much of the listing's own
 * requirements the resume backs, then the place. Recency is deliberately not
 * in the list: the row already prints the posting-date badge, so repeating it
 * here would spend the line on something already on screen.
 *
 * The scorer's own top sentence is the last resort, so a row is only silent
 * when the assessment itself said nothing.
 */
export function describeMatchTieBreakReason(
  job: Pick<JobListRow, "matchAssessment">,
): string | null {
  const assessment = job.matchAssessment;
  const titleFamily = assessment.titleFamilyMatch;
  if (titleFamily) {
    return TITLE_FAMILY_TIE_BREAK_REASON[titleFamily];
  }

  const requirements = assessment.requirements ?? [];
  const seniority = requirements.find(
    (requirement) => requirement?.category === "seniority",
  );
  if (seniority) {
    const reason = SENIORITY_TIE_BREAK_REASON[seniority.status];
    if (reason) {
      return reason;
    }
  }

  const skills = requirements.filter(
    (requirement) =>
      (requirement?.category === "skill" ||
        requirement?.category === "domain") &&
      requirement.status !== "unknown",
  );
  if (skills.length > 0) {
    const backed = skills.filter(
      (requirement) =>
        requirement.status === "supported" || requirement.status === "partial",
    ).length;
    return `Your resume backs ${backed} of the ${skills.length} skills this listing asks for.`;
  }

  const locationReason = LOCATION_REACH_TIE_BREAK_REASON[
    assessment.locationReach
  ];
  if (locationReason) {
    return locationReason;
  }

  return assessment.reasons?.[0] ?? assessment.gaps?.[0] ?? null;
}

export const roleSuitabilityCopy: Record<
  RoleSuitabilityState,
  { label: string; tone: BadgeTone }
> = {
  unknown: { label: "Unknown", tone: "neutral" },
  exact: { label: "Strong match", tone: "positive" },
  adjacent: { label: "Partial match", tone: "active" },
  conflict: { label: "Role conflict", tone: "critical" },
};

/**
 * The "Role and requirements" verdict, derived from the requirement evidence
 * that is printed directly beneath it.
 *
 * The title verdict alone used to write this line, so a listing whose title
 * matched exactly read "Strong match" above "1 of 3 supported" — two lines
 * about the same thing, disagreeing. The evidence count now decides: the
 * headline can only be as strong as the requirements that actually stand.
 */
export function getRoleAndRequirementsStatus(
  roleSuitability: RoleSuitabilityState,
  requirements: readonly { status: JobRequirementEvidenceStatus }[],
): { label: string; tone: BadgeTone } {
  const titleVerdict = roleSuitabilityCopy[roleSuitability];
  // A role-family conflict is already the worst verdict, and with no
  // requirements to read there is nothing that could contradict the title.
  if (roleSuitability === "conflict" || requirements.length === 0) {
    return titleVerdict;
  }

  const supportedCount = requirements.filter(
    (requirement) => requirement.status === "supported",
  ).length;
  if (supportedCount === requirements.length) {
    return titleVerdict;
  }
  if (supportedCount === 0) {
    return { label: "Needs evidence", tone: "critical" };
  }
  // Part of the evidence stands, so the line can never say "Strong match".
  return roleSuitability === "exact"
    ? roleSuitabilityCopy.adjacent
    : titleVerdict;
}
