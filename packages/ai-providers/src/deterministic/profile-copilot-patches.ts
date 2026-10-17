import {
  type ProfileCopilotPatchGroup,
  type ProfileCopilotReply,
} from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import { buildGenericExplicitFieldPatchGroups } from "./profile-copilot-field-updates";
import { buildJobSourcePatchReply } from "./profile-copilot-job-sources";
import { buildNaturalSearchPreferenceReply } from "./profile-copilot-natural-preferences";
import {
  buildSpecializedPatchResults,
  type SpecializedPatchResult,
} from "./profile-copilot-specialized-patches";
import { buildUrlPatchReply } from "./profile-copilot-url-patches";

function normalizePatchReply(
  reply: ProfileCopilotPatchGroup[] | ProfileCopilotReply | null,
): ProfileCopilotPatchGroup[] {
  if (!reply) {
    return [];
  }

  return "content" in reply ? [] : reply;
}

/**
 * Patch-builder output: plain groups, a complete reply (natural-language
 * specialists), or groups plus a salary clarification question that must be
 * surfaced even when other intents produced groups.
 */
export type DeterministicPatchReply =
  | ProfileCopilotPatchGroup[]
  | ProfileCopilotReply
  | SpecializedPatchResult;

export function isSpecializedPatchResult(
  reply: DeterministicPatchReply,
): reply is SpecializedPatchResult {
  return (
    !Array.isArray(reply) &&
    "groups" in reply &&
    "clarificationQuestion" in reply
  );
}

export function buildDeterministicPatchReply(
  input: ReviseCandidateProfileInput,
): DeterministicPatchReply | null {
  const naturalPreferenceReply = buildNaturalSearchPreferenceReply(input);
  if (naturalPreferenceReply) {
    return naturalPreferenceReply;
  }

  const jobSourceReply = buildJobSourcePatchReply(input);
  const specializedResult = buildSpecializedPatchResults(input);
  const urlPatchReply = buildUrlPatchReply(input);
  const genericFieldPatchGroups = buildGenericExplicitFieldPatchGroups(input);
  const specializedGroups = specializedResult?.groups ?? [];
  const clarificationQuestion =
    specializedResult?.clarificationQuestion ?? null;
  const patchGroups = [
    ...specializedGroups,
    ...normalizePatchReply(urlPatchReply),
    ...genericFieldPatchGroups,
    ...normalizePatchReply(jobSourceReply),
  ];

  if (patchGroups.length > 0 || clarificationQuestion !== null) {
    return clarificationQuestion !== null
      ? { groups: patchGroups, clarificationQuestion }
      : patchGroups;
  }

  return jobSourceReply && "content" in jobSourceReply ? jobSourceReply : null;
}
