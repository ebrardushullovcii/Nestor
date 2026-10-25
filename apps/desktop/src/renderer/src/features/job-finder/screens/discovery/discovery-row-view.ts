import type { WorkspaceJobListRow } from "@nestor/contracts";
import { createPerObjectCache } from "../../lib/identity-memo";
import { scrubJobAbsencePlaceholders } from "../../lib/job-employer-location-display";
import {
  presentFitFacts,
  type MatchAssessmentPresentation,
} from "../../lib/match-assessment-presentation";
import { joinUniqueSentences } from "../../lib/sentence-copy";

/**
 * What one Find jobs row prints, from the list columns the query returns
 * (ADR 0075). The inspector still reads the complete job by id.
 */
export interface DiscoveryRowView {
  fit: MatchAssessmentPresentation;
  /** One sentence saying why, or null when the score stands on its own. */
  reason: string | null;
  /** The fact behind the row's place when another row prints the same score. */
  tieBreakReason: string | null;
}

export const getDiscoveryRowView = createPerObjectCache(
  (row: WorkspaceJobListRow): DiscoveryRowView => {
    const fit = presentFitFacts({
      isProvisional: row.provisional,
      isNotJudged: !row.judged,
      scoreIsUpperBound: row.scoreIsUpperBound,
      score: row.score,
    });
    // What is missing when the score is withheld, otherwise the hard-conflict
    // reason. Rows whose score stands on its own evidence stay quiet.
    const reason =
      (row.recommendation === "skip"
        ? scrubJobAbsencePlaceholders(
            joinUniqueSentences([row.recommendationRationale ?? ""]),
          ) || null
        : null) ??
      (row.roleSuitabilityState !== null && row.roleSuitabilityState !== "exact"
        ? row.firstGap
        : null) ??
      fit.withheldReason ??
      null;
    return {
      fit,
      reason,
      tieBreakReason: row.scoreTied ? row.tieBreakReason : null,
    };
  },
);

/** Shortlisted, applied and in-progress jobs cannot be ticked for bulk work. */
export function isDiscoveryRowInPipeline(
  row: Pick<WorkspaceJobListRow, "status">,
): boolean {
  return ["drafting", "ready_for_review", "approved", "submitted"].includes(
    row.status,
  );
}
