import type {
  TailoredResumeCoverageMetadata,
  WorkHistoryReviewSuggestionAction,
  WorkHistoryReviewSuggestionKind,
} from "@nestor/contracts";
import { fnv1a32 } from "@nestor/core";

/**
 * Draft-independent identity of a projected work-history review suggestion:
 * exactly the fields an acknowledgment must reproduce (profile record, kind,
 * action, and the FNV-1a hash of the canonical message) for
 * `matchWorkHistoryReviewAcknowledgment` to keep satisfying it.
 */
export interface WorkHistoryReviewSuggestionIdentity {
  id: string;
  profileRecordId: string;
  kind: WorkHistoryReviewSuggestionKind;
  action: WorkHistoryReviewSuggestionAction;
  message: string;
  messageContentHash: string;
}

/**
 * Projects work-history review suggestion identities from tailored coverage
 * metadata with the same derivation rules `buildWorkHistoryReviewSuggestions`
 * applies when it attaches section/entry context. Living in a leaf module
 * keeps that derivation shared between suggestion projection and acknowledgment
 * carry-forward without a workspace-helpers <-> workspace-structure import
 * cycle.
 */
export function projectWorkHistoryReviewSuggestionIdentities(
  coverageMetadata: readonly TailoredResumeCoverageMetadata[],
): WorkHistoryReviewSuggestionIdentity[] {
  return coverageMetadata
    .flatMap((metadata): WorkHistoryReviewSuggestionIdentity[] => {
      const message = metadata.reviewGuidance[0] ?? metadata.reasons[0] ?? null;

      if (!message || metadata.classification === "detailed") {
        return [];
      }

      const kind = metadata.coversMeaningfulGap
        ? "gap_coverage"
        : metadata.classification === "compact"
          ? "compact_recommended"
          : "weak_fit";
      const action =
        metadata.classification === "suggested_hidden" ||
        metadata.classification === "omitted"
          ? "consider_showing"
          : "keep_compact";

      return [
        {
          id: `work_history_review_${metadata.profileRecordId}`,
          profileRecordId: metadata.profileRecordId,
          kind,
          action,
          message,
          messageContentHash: fnv1a32(message),
        },
      ];
    })
    .filter(
      (identity, index, identities) =>
        identities.findIndex((entry) => entry.id === identity.id) === index,
    );
}
