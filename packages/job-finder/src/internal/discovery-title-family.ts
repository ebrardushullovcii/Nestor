import type {
  JobListMatchAssessment,
  TitleFamilyMatch,
} from "@nordri/contracts";

/**
 * Whether the listing's role is the kind of work the person asked for, read
 * from the model's verdict (ADR 0041): `titleFamilyMatch` records it, and the
 * role dimension carries the same verdict. `null` means not judged.
 */
export function resolveTitleFamilyMatch(
  assessment: Pick<JobListMatchAssessment, "titleFamilyMatch"> &
    Partial<Pick<JobListMatchAssessment, "dimensions">>,
): TitleFamilyMatch | null {
  const recorded = assessment.titleFamilyMatch;
  if (recorded) {
    return recorded;
  }

  const roleSuitability = assessment.dimensions?.roleSuitability?.state;
  if (roleSuitability === "exact") {
    return "same_family";
  }
  if (roleSuitability === "adjacent") {
    return "adjacent";
  }
  if (roleSuitability === "conflict") {
    return "unrelated";
  }

  return null;
}

/**
 * Whether this row's title is one the saved targets asked for. Used to keep a
 * role in the main results while its listing text is still unread: only a
 * title the scorer positively placed outside the saved families is demoted
 * for the absence of a score.
 */
export function isTargetTitleFamily(
  assessment: Parameters<typeof resolveTitleFamilyMatch>[0],
): boolean {
  const family = resolveTitleFamilyMatch(assessment);
  return family === "same_family" || family === "adjacent";
}
