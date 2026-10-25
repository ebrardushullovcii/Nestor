import type {
  ResumeCoverageClaimChange,
  ResumeCoverageRoleComparison,
} from "@nestor/contracts";

/**
 * Pairs each line the tailored resume dropped with the line that replaced it.
 *
 * The scorer reports added and removed claims as two independent lists. A
 * reworded bullet therefore appeared in both: the header counted it as
 * removed ("17 lines removed" when 15 bullets were actually dropped) and the
 * panel listed it under "not on the page" while its rewritten form was
 * visible in the preview alongside. Two bullets merged into one sentence were
 * printed three times over four lines for the same reason.
 *
 * Pairing them here makes the arithmetic true: a line counts as removed only
 * when nothing on the page carries its wording.
 */

export interface ResumeCoverageComparisonRow {
  /**
   * "reworded" carries both sides. "removed" has original lines and no
   * replacement; "added" is new wording with no original behind it.
   */
  kind: "added" | "removed" | "reworded";
  /** Lines from the original resume, in their original order. */
  originalLines: readonly ResumeCoverageClaimChange[];
  /** The line on the page now, when there is one. */
  tailoredLine: ResumeCoverageClaimChange | null;
}

export interface ResumeCoverageComparisonRows {
  rows: readonly ResumeCoverageComparisonRow[];
  /** Original lines with no wording left on the page. The honest count. */
  removedLineCount: number;
  rewordedLineCount: number;
  addedLineCount: number;
  /**
   * Lines this role no longer shows because the tailored resume moved them
   * under another role. They are on the page, so they are neither listed as
   * removed nor counted — this count only exists so the behaviour is
   * observable in a test.
   */
  keptElsewhereLineCount: number;
}

/** Every line the tailored resume put on the page, across all roles. */
export function collectResumeCoveragePageLines(
  roles: readonly Pick<ResumeCoverageRoleComparison, "addedClaims">[],
): readonly string[] {
  return roles.flatMap((role) =>
    (role.addedClaims ?? []).map((claim) => claim.text),
  );
}

/**
 * Lines pair when most of the shorter line's meaningful words survive in the
 * other. Below this they are two different statements and each keeps its own
 * row.
 */
const PAIRING_SIMILARITY_THRESHOLD = 0.6;

function normalizeClaimText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9%+#.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeClaimText(value: string): Set<string> {
  return new Set(
    normalizeClaimText(value)
      .split(" ")
      // One- and two-letter words ("of", "a") match everything and would pair
      // unrelated lines, so they carry no weight here.
      .filter((token) => token.length > 2),
  );
}

function scoreClaimOverlap(left: string, right: string): number {
  const leftNormalized = normalizeClaimText(left);
  const rightNormalized = normalizeClaimText(right);
  if (!leftNormalized || !rightNormalized) {
    return 0;
  }
  if (
    leftNormalized === rightNormalized ||
    leftNormalized.includes(rightNormalized) ||
    rightNormalized.includes(leftNormalized)
  ) {
    // The original wording is literally on the page; it was never removed.
    return 1;
  }

  const leftTokens = tokenizeClaimText(left);
  const rightTokens = tokenizeClaimText(right);
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  if (smaller === 0) {
    return 0;
  }

  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      shared += 1;
    }
  }

  return shared / smaller;
}

/**
 * Builds the before/after rows for one role.
 *
 * An added line may absorb more than one original line — a merge — and then
 * owns a single row listing both originals, so the same claim is never
 * printed three times.
 */
export function buildResumeCoverageComparisonRows(
  role: Pick<ResumeCoverageRoleComparison, "addedClaims" | "removedClaims">,
  options: { pageLines?: readonly string[] } = {},
): ResumeCoverageComparisonRows {
  const addedClaims = role.addedClaims ?? [];
  const removedClaims = role.removedClaims ?? [];
  const originalsByAddedIndex = new Map<number, ResumeCoverageClaimChange[]>();
  const unmatchedRemoved: ResumeCoverageClaimChange[] = [];

  for (const removed of removedClaims) {
    let bestIndex = -1;
    let bestScore = 0;
    addedClaims.forEach((added, index) => {
      const sharesSource = removed.sourceAchievementIds?.some((id) =>
        added.sourceAchievementIds?.includes(id),
      );
      const score = sharesSource ? 2 : scoreClaimOverlap(removed.text, added.text);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0 && bestScore >= PAIRING_SIMILARITY_THRESHOLD) {
      const existing = originalsByAddedIndex.get(bestIndex) ?? [];
      existing.push(removed);
      originalsByAddedIndex.set(bestIndex, existing);
      continue;
    }

    unmatchedRemoved.push(removed);
  }

  // A line the tailored resume moved under a different role is still on the
  // page. Pairing inside one role could not see that, so all three sentences
  // of a moved group were listed as "not on the page" while the reader could
  // see them in the preview beside the list.
  const pageLines = options.pageLines ?? [];
  const keptElsewhere = unmatchedRemoved.filter((removed) =>
    pageLines.some(
      (line) =>
        scoreClaimOverlap(removed.text, line) >= PAIRING_SIMILARITY_THRESHOLD,
    ),
  );
  const trulyRemoved = unmatchedRemoved.filter(
    (removed) => !keptElsewhere.includes(removed),
  );

  const rows: ResumeCoverageComparisonRow[] = [];
  let rewordedLineCount = 0;
  let addedLineCount = 0;

  addedClaims.forEach((added, index) => {
    const originals = originalsByAddedIndex.get(index) ?? [];
    if (originals.length > 0) {
      rewordedLineCount += originals.length;
      rows.push({
        kind: "reworded",
        originalLines: originals,
        tailoredLine: added,
      });
      return;
    }

    addedLineCount += 1;
    rows.push({ kind: "added", originalLines: [], tailoredLine: added });
  });

  for (const removed of trulyRemoved) {
    rows.push({ kind: "removed", originalLines: [removed], tailoredLine: null });
  }

  return {
    rows,
    removedLineCount: trulyRemoved.length,
    rewordedLineCount,
    addedLineCount,
    keptElsewhereLineCount: keptElsewhere.length,
  };
}

/** The honest "N lines removed" total across every role in the comparison. */
export function countResumeCoverageRemovedLines(
  roles: readonly Pick<
    ResumeCoverageRoleComparison,
    "addedClaims" | "removedClaims"
  >[],
): number {
  const pageLines = collectResumeCoveragePageLines(roles);
  return roles.reduce(
    (total, role) =>
      total +
      buildResumeCoverageComparisonRows(role, { pageLines }).removedLineCount,
    0,
  );
}
