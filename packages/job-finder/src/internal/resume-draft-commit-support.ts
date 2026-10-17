import {
  ResumeValidationResultSchema,
  type ResumeDraft,
  type ResumeValidationIssue,
  type ResumeValidationResult,
} from "@nestor/contracts";

/**
 * A timestamp strictly after `previousIso`, so a draft revision written in
 * the same millisecond as the last one still sorts after it.
 */
export function createMonotonicTimestamp(
  previousIso: string | null | undefined,
): string {
  const now = Date.now();
  const parsedPrevious = previousIso
    ? new Date(previousIso).getTime()
    : Number.NaN;
  const previous = Number.isNaN(parsedPrevious) ? now : parsedPrevious + 1;
  return new Date(Math.max(now, previous)).toISOString();
}

/**
 * Keeps the work-history review guidance of the previous validation for the
 * entries that still exist, so a draft mutation does not drop it.
 */
export function preserveWorkHistoryReviewGuidance(input: {
  validation: ResumeValidationResult;
  previousValidation: ResumeValidationResult | null;
  draft: ResumeDraft;
}): ResumeValidationResult {
  const existingIssueIds = new Set(
    input.validation.issues.map((issue) => issue.id),
  );
  const entryIds = new Set(
    input.draft.sections.flatMap((section) =>
      section.entries.map((entry) => entry.id),
    ),
  );
  const preservedIssues: ResumeValidationIssue[] = (
    input.previousValidation?.issues ?? []
  )
    .filter((issue) => issue.category === "work_history_review")
    .filter((issue) => !issue.entryId || entryIds.has(issue.entryId))
    .filter((issue) => !existingIssueIds.has(issue.id));

  if (preservedIssues.length === 0) {
    return input.validation;
  }

  return ResumeValidationResultSchema.parse({
    ...input.validation,
    issues: [...input.validation.issues, ...preservedIssues],
  });
}
