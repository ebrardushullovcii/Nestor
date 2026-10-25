import type { ProfileCopilotPatchGroup } from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import {
  createUniqueId,
  extractRequestUrls,
  findPendingRelevantReviewItem,
  formatIdentityFieldLabel,
  getMatchingResolutionStatus,
  inferIdentityUrlField,
} from "./profile-copilot-helpers";

function buildUrlPatchGroup(
  input: ReviseCandidateProfileInput,
  url: string,
): ProfileCopilotPatchGroup | null {
  const field = inferIdentityUrlField(input.request, url);

  if (!field || input.profile[field] === url) {
    return null;
  }

  const matchingReviewItem = findPendingRelevantReviewItem(
    input,
    (item) => item.target.domain === "identity" && item.target.key === field,
  );
  const operations: ProfileCopilotPatchGroup["operations"] = [
    {
      operation: "replace_identity_fields",
      value: {
        [field]: url,
      },
    },
  ];

  if (matchingReviewItem) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: [matchingReviewItem.id],
      resolutionStatus: getMatchingResolutionStatus(matchingReviewItem, url),
    });
  }

  return {
    id: createUniqueId("profile_patch_group"),
    summary: `Update ${formatIdentityFieldLabel(field)}`,
    applyMode: "applied",
    operations,
    createdAt: new Date().toISOString(),
  };
}

export function buildUrlPatchReply(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup[] | null {
  const urls = extractRequestUrls(input.request);

  if (urls.length !== 1) {
    return null;
  }

  const patchGroup = buildUrlPatchGroup(input, urls[0]!);
  return patchGroup ? [patchGroup] : null;
}
