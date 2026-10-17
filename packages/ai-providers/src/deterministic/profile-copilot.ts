import { ProfileCopilotReplySchema, type ProfileCopilotReply } from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import {
  buildNoChangeReply,
  formatPatchGroupSummaryList,
} from "./profile-copilot-helpers";
import { buildDeterministicAssessmentReply } from "./profile-copilot-assessment";
import {
  buildDeterministicPatchReply,
  isSpecializedPatchResult,
} from "./profile-copilot-patches";

function describeChanges(
  patchGroups: ProfileCopilotReply["patchGroups"],
  input: ReviseCandidateProfileInput,
): string {
  const appliedPatchGroups = patchGroups.filter((patchGroup) => patchGroup.applyMode === "applied");
  const reviewPatchGroups = patchGroups.filter((patchGroup) => patchGroup.applyMode !== "applied");
  const summaryList = formatPatchGroupSummaryList(patchGroups);
  const contextLabel =
    input.context.surface === "setup"
      ? `setup ${input.context.step.replaceAll("_", " ")}`
      : input.context.surface === "profile"
        ? `${input.context.section} profile section`
        : "profile";

  if (appliedPatchGroups.length > 0 && reviewPatchGroups.length === 0) {
    return `I applied ${appliedPatchGroups.length === 1 ? "one safe change" : `${appliedPatchGroups.length} safe changes`} for the ${contextLabel} context: ${summaryList}.`;
  }

  if (appliedPatchGroups.length === 0 && reviewPatchGroups.length > 0) {
    return `I prepared ${reviewPatchGroups.length === 1 ? "this change" : `${reviewPatchGroups.length} changes`} for review in the ${contextLabel} context: ${summaryList}.`;
  }

  return `I applied ${appliedPatchGroups.length} safe change${appliedPatchGroups.length === 1 ? "" : "s"} and prepared ${reviewPatchGroups.length} more for review in the ${contextLabel} context: ${summaryList}.`;
}

export function buildDeterministicProfileCopilotReply(
  input: ReviseCandidateProfileInput,
): ProfileCopilotReply {
  const assessmentReply = buildDeterministicAssessmentReply(input);
  if (assessmentReply) {
    return assessmentReply;
  }

  const patchReply = buildDeterministicPatchReply(input);

  if (patchReply && isSpecializedPatchResult(patchReply)) {
    const clarificationQuestion = patchReply.clarificationQuestion;
    const content =
      clarificationQuestion && patchReply.groups.length > 0
        ? `${describeChanges(patchReply.groups, input)} ${clarificationQuestion}`
        : (clarificationQuestion ?? describeChanges(patchReply.groups, input));

    return ProfileCopilotReplySchema.parse({
      content,
      patchGroups: patchReply.groups,
    });
  }

  if (patchReply && "content" in patchReply) {
    return patchReply;
  }

  if (!patchReply) {
    return buildNoChangeReply(input);
  }

  const normalizedPatchGroups = Array.isArray(patchReply) ? patchReply : [patchReply];
  const content = describeChanges(normalizedPatchGroups, input);

  return ProfileCopilotReplySchema.parse({
    content,
    patchGroups: normalizedPatchGroups,
  });
}
