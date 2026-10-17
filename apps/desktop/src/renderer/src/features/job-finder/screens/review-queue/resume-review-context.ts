import type {
  ResumeCoverageRoleComparison,
  ResumeDraft,
  WorkHistoryReviewSuggestion,
} from "@nestor/contracts";

export function describeReviewRole(
  suggestion: WorkHistoryReviewSuggestion,
  sections: ResumeDraft["sections"],
  roles: readonly ResumeCoverageRoleComparison[],
) {
  const entry = sections
    .flatMap((section) => section.entries)
    .find(
      (candidate) => candidate.profileRecordId === suggestion.profileRecordId,
    );
  const role = roles.find(
    (candidate) => candidate.profileRecordId === suggestion.profileRecordId,
  );
  const dates = entry
    ? [entry.startDate, entry.isCurrent ? "Present" : entry.endDate]
        .filter(Boolean)
        .join("–")
    : "";
  return {
    title: entry?.title?.trim() || role?.title || "Role details unavailable",
    detail: [entry?.subtitle?.trim() || role?.employer, dates]
      .filter(Boolean)
      .join(" · "),
  };
}

export function listGeneratedReviewLines(draft: ResumeDraft) {
  return draft.sections.flatMap((section) => [
    ...section.bullets.map((bullet) => ({ bullet, context: section.label })),
    ...section.entries.flatMap((entry) =>
      entry.bullets.map((bullet) => ({
        bullet,
        context: [section.label, entry.title, entry.subtitle]
          .filter(Boolean)
          .join(" · "),
      })),
    ),
  ]);
}
