import {
  ProfileCopilotReplySchema,
  type ProfileCopilotPatchGroup,
  type ProfileCopilotReply,
} from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import {
  buildJobSourcePatchSummary,
  createUniqueId,
  describeContext,
  formatSourceLabels,
  inferRequestedJobSources,
  normalizeSourceLabel,
  normalizeSourceStartingUrl,
} from "./profile-copilot-helpers";

function buildExistingJobSourcesReply(
  input: ReviseCandidateProfileInput,
  requestedLabels: readonly string[],
) {
  const contextLabel = describeContext(input.context);
  const sourcesLabel = formatSourceLabels(requestedLabels);

  return ProfileCopilotReplySchema.parse({
    content: `The ${sourcesLabel} job source${requestedLabels.length === 1 ? " is" : "s are"} already saved in the ${contextLabel} context, so I did not add duplicates. You can review them under Job sources.`,
    patchGroups: [],
  });
}

export function buildJobSourcePatchReply(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup[] | ProfileCopilotReply | null {
  const requestedJobSources = inferRequestedJobSources(input.request);

  if (requestedJobSources.length === 0) {
    return null;
  }

  const now = new Date().toISOString();
  const currentTargets = input.searchPreferences.discovery.targets;
  const nextTargets = [...currentTargets];
  const addedLabels: string[] = [];
  const reEnabledLabels: string[] = [];

  for (const source of requestedJobSources) {
    const normalizedSourceLabel = normalizeSourceLabel(source.label);
    const normalizedSourceUrl = normalizeSourceStartingUrl(source.startingUrl);
    const existingTargetIndex = nextTargets.findIndex(
      (target) =>
        normalizeSourceStartingUrl(target.startingUrl) ===
          normalizedSourceUrl ||
        normalizeSourceLabel(target.label) === normalizedSourceLabel,
    );

    if (existingTargetIndex >= 0) {
      const existingTarget = nextTargets[existingTargetIndex]!;

      if (!existingTarget.enabled) {
        nextTargets[existingTargetIndex] = {
          ...existingTarget,
          enabled: true,
        };
        reEnabledLabels.push(existingTarget.label);
      }

      continue;
    }

    nextTargets.push({
      id: createUniqueId("target"),
      label: source.label,
      startingUrl: source.startingUrl,
      enabled: true,
      adapterKind: "auto",
      customInstructions: null,
      instructionStatus: "missing",
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: null,
      lastVerifiedAt: null,
      staleReason: null,
    });
    addedLabels.push(source.label);
  }

  if (
    nextTargets.length === currentTargets.length &&
    reEnabledLabels.length === 0
  ) {
    return buildExistingJobSourcesReply(
      input,
      requestedJobSources.map((source) => source.label),
    );
  }

  return [
    {
      id: createUniqueId("profile_patch_group"),
      summary: buildJobSourcePatchSummary({
        addedLabels,
        reEnabledLabels,
      }),
      applyMode: "needs_review",
      operations: [
        {
          operation: "replace_search_preferences_fields",
          value: {
            discovery: {
              ...input.searchPreferences.discovery,
              targets: nextTargets,
            },
          },
        },
      ],
      createdAt: now,
    },
  ];
}
