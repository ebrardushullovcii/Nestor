import { RotateCcw } from "lucide-react";
import type {
  ResumeCoverageClaimChange,
  ResumeCoverageComparison,
  ResumeCoverageRoleComparison,
} from "@nestor/contracts";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import {
  buildResumeCoverageComparisonRows,
  collectResumeCoveragePageLines,
  countResumeCoverageRemovedLines,
} from "./resume-coverage-comparison-rows";

const roleStatusLabel: Record<ResumeCoverageRoleComparison["status"], string> =
  {
    unchanged: "Kept",
    rewritten: "Reworded",
    compacted: "Shortened",
    hidden: "Hidden",
    missing: "Missing",
  };

/**
 * "18 REMOVED CLAIMS", "1/2 PAGES", and "3/3 ROLES" are scorer vocabulary.
 * "1/2 pages" in particular is unreadable — one of two, or one half? — beside
 * an export that is one page.
 */
function describePageFit(input: {
  pageCount: number | null;
  targetPageCount: number;
}): string | null {
  if (input.pageCount === null) {
    return null;
  }

  if (input.pageCount <= input.targetPageCount) {
    return input.pageCount === 1
      ? "Fits on one page"
      : `Fits on ${input.pageCount} pages`;
  }

  return `${input.pageCount} pages — ${input.targetPageCount} planned`;
}

function describeRoleCoverage(input: {
  visibleRoleCount: number;
  originalRoleCount: number;
}): string {
  if (
    input.visibleRoleCount === input.originalRoleCount &&
    input.originalRoleCount > 0
  ) {
    return `All ${input.originalRoleCount} roles shown`;
  }

  return `${input.visibleRoleCount} of ${input.originalRoleCount} roles shown`;
}

export function ResumeCoverageComparisonPanel(props: {
  comparison: ResumeCoverageComparison | null;
  disabled: boolean;
  onRestoreClaim: (
    role: ResumeCoverageRoleComparison,
    claim: ResumeCoverageClaimChange,
  ) => void;
  onRestoreRole: (role: ResumeCoverageRoleComparison) => void;
}) {
  const comparison = props.comparison;
  if (!comparison) {
    return null;
  }

  // The scorer's removedClaimCount counts every original line the tailored
  // text did not reproduce verbatim, so a reworded line was counted as
  // removed and listed as "not on the page" while its rewrite sat in the
  // preview beside it. Only lines with no wording left on the page count.
  const removedLineCount = countResumeCoverageRemovedLines(comparison.roles);
  // Every line the tailored resume put on the page, so a line moved under
  // another role is never listed here as missing from it.
  const pageLines = collectResumeCoveragePageLines(comparison.roles);
  const hasReviewItems =
    comparison.hiddenRoleCount > 0 ||
    comparison.missingRoleCount > 0 ||
    removedLineCount > 0 ||
    comparison.duplicateIssueCount > 0 ||
    comparison.pageImpact === "over_target";

  return (
    <details
      className="rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-fill-soft)"
      data-resume-coverage-comparison
      open={hasReviewItems}
    >
      <summary className="cursor-pointer list-none px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="grid gap-0.5">
            <strong className="text-sm text-(--text-headline)">
              Original vs tailored
            </strong>
            <span className="text-(length:--text-small) leading-5 text-foreground-soft">
              See what was kept, reworded, hidden, reordered, or removed before
              export.
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="outline">
              {describeRoleCoverage({
                originalRoleCount: comparison.originalRoleCount,
                visibleRoleCount: comparison.visibleRoleCount,
              })}
            </Badge>
            {removedLineCount > 0 ? (
              <Badge variant="default">
                {removedLineCount} line{removedLineCount === 1 ? "" : "s"}{" "}
                removed
              </Badge>
            ) : null}
            {describePageFit({
              pageCount: comparison.pageCount,
              targetPageCount: comparison.targetPageCount,
            }) ? (
              <Badge
                variant={
                  comparison.pageImpact === "over_target"
                    ? "default"
                    : "section"
                }
              >
                {describePageFit({
                  pageCount: comparison.pageCount,
                  targetPageCount: comparison.targetPageCount,
                })}
              </Badge>
            ) : null}
          </div>
        </div>
      </summary>

      <div className="grid gap-3 border-t border-(--surface-panel-border) p-3">
        {/* The dropped skills used to end this panel as an inert grey
            paragraph. They are now actionable "Add" chips beside the skills
            editor, so they are not repeated here as a list you cannot use. */}
        {comparison.addedKeywords.length > 0 ? (
          <div className="grid gap-1.5 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 p-2.5 text-(length:--text-small)">
            <p className="leading-5 text-foreground-soft">
              <strong className="text-foreground">Keywords added:</strong>{" "}
              {comparison.addedKeywords.join(", ")}
            </p>
          </div>
        ) : null}

        <div className="grid gap-2">
          {comparison.roles.map((role) => (
            <article
              className="grid gap-2 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/35 p-2.5"
              key={role.profileRecordId}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <strong className="block truncate text-sm text-(--text-headline)">
                    {role.title}
                  </strong>
                  <span className="text-(length:--text-small) text-foreground-soft">
                    {role.employer}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge
                    variant={
                      role.status === "missing" || role.status === "hidden"
                        ? "default"
                        : "outline"
                    }
                  >
                    {roleStatusLabel[role.status]}
                  </Badge>
                  {role.reordered ? (
                    <Badge variant="outline">Reordered</Badge>
                  ) : null}
                  {!role.included && role.entryId && role.sectionId ? (
                    <Button
                      disabled={props.disabled}
                      onClick={() => props.onRestoreRole(role)}
                      size="compact"
                      type="button"
                      variant="secondary"
                    >
                      <RotateCcw className="size-3.5" />
                      Show role
                    </Button>
                  ) : null}
                </div>
              </div>

              {role.reasons.length > 0 ? (
                <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                  {role.reasons[0]}
                </p>
              ) : null}

              {(() => {
                // One row per change, with the original line and the line
                // that replaced it side by side. A merge shows both originals
                // above the one sentence that now carries them, so nothing is
                // printed three times.
                const { rows } = buildResumeCoverageComparisonRows(role, {
                  pageLines,
                });
                const rewordedRows = rows.filter(
                  (row) => row.kind === "reworded",
                );
                const addedRows = rows.filter((row) => row.kind === "added");
                const removedRows = rows.filter(
                  (row) => row.kind === "removed",
                );

                return (
                  <>
                    {rewordedRows.length > 0 ? (
                      <div className="grid gap-1.5">
                        <span className="font-display text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground">
                          Reworded — still on the page
                        </span>
                        {rewordedRows.map((row, index) => (
                          <div
                            className="grid min-w-0 gap-0.5"
                            key={`${role.profileRecordId}_reworded_${index}`}
                          >
                            {row.originalLines.map((original, lineIndex) => (
                              <p
                                className="min-w-0 text-(length:--text-small) leading-5 text-foreground-muted"
                                key={`${role.profileRecordId}_reworded_${index}_${lineIndex}`}
                              >
                                Before: {original.text}
                              </p>
                            ))}
                            <p className="min-w-0 text-(length:--text-small) leading-5 text-foreground-soft">
                              Now: {row.tailoredLine?.text}
                            </p>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {addedRows.length > 0 ? (
                      <div className="grid gap-1">
                        <span className="font-display text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground">
                          Added
                        </span>
                        {addedRows.map((row, index) => (
                          <p
                            className="text-(length:--text-small) leading-5 text-foreground-soft"
                            key={`${role.profileRecordId}_added_${index}`}
                          >
                            + {row.tailoredLine?.text}
                          </p>
                        ))}
                      </div>
                    ) : null}

                    {removedRows.length > 0 ? (
                      <div className="grid gap-1.5">
                        <span className="font-display text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground">
                          Lines from your original resume that are not on the
                          page
                        </span>
                        {/* Restore used to sit inline at the end of the
                            sentence, so it read as the last word of the line
                            instead of an action. Each line now owns a
                            labelled control on its own row. */}
                        {removedRows.map((row, index) => {
                          const claim = row.originalLines[0];
                          if (!claim) return null;
                          return (
                            <div
                              className="grid min-w-0 gap-1"
                              key={`${role.profileRecordId}_removed_${index}`}
                            >
                              <p className="min-w-0 text-(length:--text-small) leading-5 text-foreground-soft">
                                − {claim.text}
                              </p>
                              {claim.restorable &&
                              role.entryId &&
                              role.sectionId ? (
                                <div className="flex justify-end">
                                  <Button
                                    aria-label={`Restore this line: ${claim.text}`}
                                    disabled={props.disabled}
                                    onClick={() =>
                                      props.onRestoreClaim(role, claim)
                                    }
                                    size="compact"
                                    type="button"
                                    variant="secondary"
                                  >
                                    <RotateCcw className="size-3.5" />
                                    Restore
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </>
                );
              })()}
            </article>
          ))}
        </div>
      </div>
    </details>
  );
}
