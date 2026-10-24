import type {
  JobRequirementEvidenceStatus,
  MatchLocationReach,
  TitleFamilyMatch,
  JobListMatchAssessment,
} from "@nestor/contracts";
export type TieBreakAssessment = Pick<
  JobListMatchAssessment,
  "titleFamilyMatch" | "locationReach" | "reasons" | "gaps"
> & {
  requirements: Array<
    Pick<JobListMatchAssessment["requirements"][number], "category" | "status">
  >;
};
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
  assessment: TieBreakAssessment,
): string | null {
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

  const locationReason =
    LOCATION_REACH_TIE_BREAK_REASON[assessment.locationReach];
  if (locationReason) {
    return locationReason;
  }

  return assessment.reasons?.[0] ?? assessment.gaps?.[0] ?? null;
}
