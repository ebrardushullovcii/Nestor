import type { ProfileCopilotPatchGroup } from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import {
  createUniqueId,
  deriveRequestedDetail,
  detectRequestedRemoteEligibility,
  detectRequestedVisaSponsorship,
  detectRequestedWorkMode,
  detectRequestedYearsExperience,
  findMentionedExperience,
  findPendingRelevantReviewItem,
  findPendingRelevantReviewItems,
  formatIdentityFieldLabel,
  getMatchingResolutionStatus,
  looksLikeExplicitAnswer,
  normalizeFactText,
  requestLooksLikeLocationListEdit,
  requestLooksLikeWorkModePreferenceEdit,
  trimNonEmptyString,
} from "./profile-copilot-helpers";
import {
  buildSalaryCommandOutcome,
  type SalaryCommandOutcome,
} from "./profile-copilot-salary";
import { fieldDescriptors } from "./profile-copilot-field-updates";
import {
  segmentCommandClauses,
  type ForeignCommandFamily,
} from "./profile-copilot-field-updates-shared";

function extractSpecialistClauseText(
  input: ReviseCandidateProfileInput,
  family: ForeignCommandFamily,
): string | null {
  const clause = segmentCommandClauses(input.request, fieldDescriptors).find(
    (candidate) =>
      candidate.family === family && candidate.isAcceptedCommand,
  );

  return clause?.text ?? null;
}

function buildYearsExperiencePatchGroup(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup | null {
  const requestedYearsExperience = detectRequestedYearsExperience(
    input.request,
  );

  if (requestedYearsExperience === null) {
    return null;
  }

  const item = findPendingRelevantReviewItem(
    input,
    (reviewItem) =>
      reviewItem.target.domain === "identity" &&
      reviewItem.target.key === "yearsExperience",
  );
  const operations: ProfileCopilotPatchGroup["operations"] = [];

  if (requestedYearsExperience !== input.profile.yearsExperience) {
    operations.push({
      operation: "replace_identity_fields",
      value: {
        yearsExperience: requestedYearsExperience,
      },
    });
  }

  if (item) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: [item.id],
      resolutionStatus: getMatchingResolutionStatus(
        item,
        requestedYearsExperience,
      ),
    });
  }

  if (operations.length === 0) {
    return null;
  }

  return {
    id: createUniqueId("profile_patch_group"),
    summary: "Update years of experience",
    applyMode: "applied",
    operations,
    createdAt: new Date().toISOString(),
  };
}

function buildTargetSalaryPatchGroup(
  input: ReviseCandidateProfileInput,
): SalaryCommandOutcome {
  return buildSalaryCommandOutcome(input);
}

function buildExperienceWorkModePatchGroup(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup | null {
  const requestedWorkMode = detectRequestedWorkMode(input.request);
  const matchingExperience = findMentionedExperience(input);

  if (!requestedWorkMode || !matchingExperience) {
    return null;
  }

  const matchingItem = findPendingRelevantReviewItem(
    input,
    (item) =>
      item.target.domain === "experience" &&
      item.target.key === "record" &&
      item.target.recordId === matchingExperience.id,
  );
  const operations: ProfileCopilotPatchGroup["operations"] = [
    {
      operation: "upsert_experience_record",
      record: {
        ...matchingExperience,
        workMode: [requestedWorkMode],
      },
    },
  ];

  if (matchingItem) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: [matchingItem.id],
      resolutionStatus: "edited",
    });
  }

  return {
    id: createUniqueId("profile_patch_group"),
    summary: `Mark ${matchingExperience.companyName ?? "role"} as ${requestedWorkMode}`,
    applyMode: "needs_review",
    operations,
    createdAt: new Date().toISOString(),
  };
}

function buildCurrentLocationPatchGroup(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup | null {
  const normalizedRequest = input.request.toLowerCase();

  if (
    !/\blocation\b/.test(normalizedRequest) ||
    /preferred locations|excluded locations|relocation locations|relocation regions|relocation answer/.test(
      normalizedRequest,
    )
  ) {
    return null;
  }

  const locationClause = extractSpecialistClauseText(input, "current_location");

  if (!locationClause) {
    return null;
  }

  const detail =
    deriveRequestedDetail(locationClause) ?? trimNonEmptyString(locationClause);

  if (!detail || !looksLikeExplicitAnswer(locationClause)) {
    return null;
  }

  const item = findPendingRelevantReviewItem(
    input,
    (reviewItem) =>
      reviewItem.target.domain === "identity" &&
      reviewItem.target.key === "currentLocation",
  );
  const operations: ProfileCopilotPatchGroup["operations"] = [
    {
      operation: "replace_identity_fields",
      value: {
        currentLocation: detail,
      },
    },
  ];

  if (item) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: [item.id],
      resolutionStatus: getMatchingResolutionStatus(item, detail),
    });
  }

  return {
    id: createUniqueId("profile_patch_group"),
    summary: "Update displayed location",
    applyMode: "applied",
    operations,
    createdAt: new Date().toISOString(),
  };
}

function buildTargetRolesPatchGroup(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup | null {
  const normalizedRequest = normalizeFactText(input.request);

  if (!/target role|target roles|looking for/.test(normalizedRequest)) {
    return null;
  }

  const rolesClause = extractSpecialistClauseText(input, "target_roles");

  if (!rolesClause) {
    return null;
  }

  const detail =
    deriveRequestedDetail(rolesClause) ?? trimNonEmptyString(rolesClause);

  if (!detail || !looksLikeExplicitAnswer(rolesClause)) {
    return null;
  }

  const item = findPendingRelevantReviewItem(
    input,
    (reviewItem) =>
      reviewItem.target.domain === "search_preferences" &&
      reviewItem.target.key === "targetRoles",
  );
  const operations: ProfileCopilotPatchGroup["operations"] = [
    {
      operation: "replace_search_preferences_fields",
      value: {
        targetRoles: [detail],
      },
    },
  ];

  if (item) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: [item.id],
      resolutionStatus: getMatchingResolutionStatus(item, detail),
    });
  }

  return {
    id: createUniqueId("profile_patch_group"),
    summary: "Update target roles",
    applyMode: "applied",
    operations,
    createdAt: new Date().toISOString(),
  };
}

function buildWorkEligibilityPatchGroup(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup | null {
  if (/\bvisa sponsorship answer\b/i.test(input.request)) {
    return null;
  }

  const requestedVisaSponsorship = detectRequestedVisaSponsorship(
    input.request,
  );
  const requestedRemoteEligibility = detectRequestedRemoteEligibility(
    input.request,
  );
  const matchingExperience = findMentionedExperience(input);
  const workEligibilityValue: Record<string, boolean> = {};
  const workEligibilityReviewItemIds = new Set<string>();

  if (
    requestedVisaSponsorship !== null &&
    requestedVisaSponsorship !==
      input.profile.workEligibility.requiresVisaSponsorship
  ) {
    workEligibilityValue.requiresVisaSponsorship = requestedVisaSponsorship;
    findPendingRelevantReviewItems(
      input,
      (reviewItem) =>
        reviewItem.target.domain === "work_eligibility" &&
        reviewItem.target.key === "requiresVisaSponsorship",
    ).forEach((item) => workEligibilityReviewItemIds.add(item.id));
  }

  if (
    requestedRemoteEligibility !== null &&
    !matchingExperience &&
    !requestLooksLikeLocationListEdit(input.request) &&
    !requestLooksLikeWorkModePreferenceEdit(input.request) &&
    requestedRemoteEligibility !== input.profile.workEligibility.remoteEligible
  ) {
    workEligibilityValue.remoteEligible = requestedRemoteEligibility;
    findPendingRelevantReviewItems(
      input,
      (reviewItem) =>
        reviewItem.target.domain === "work_eligibility" &&
        reviewItem.target.key === "remoteEligible",
    ).forEach((item) => workEligibilityReviewItemIds.add(item.id));
  }

  if (Object.keys(workEligibilityValue).length === 0) {
    return null;
  }

  const operations: ProfileCopilotPatchGroup["operations"] = [
    {
      operation: "replace_work_eligibility_fields",
      value: workEligibilityValue,
    },
  ];

  if (workEligibilityReviewItemIds.size > 0) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: [...workEligibilityReviewItemIds],
      resolutionStatus: "edited",
    });
  }

  const updatedFields = Object.keys(workEligibilityValue) as Array<
    "requiresVisaSponsorship" | "remoteEligible"
  >;

  return {
    id: createUniqueId("profile_patch_group"),
    summary: `Update ${updatedFields.map(formatIdentityFieldLabel).join(" and ")}`,
    applyMode: "applied",
    operations,
    createdAt: new Date().toISOString(),
  };
}

function buildPreferredWorkModePatchGroup(
  input: ReviseCandidateProfileInput,
): ProfileCopilotPatchGroup | null {
  const requestedWorkMode = detectRequestedWorkMode(input.request);
  const matchingExperience = findMentionedExperience(input);

  if (
    !requestedWorkMode ||
    matchingExperience ||
    !requestLooksLikeWorkModePreferenceEdit(input.request)
  ) {
    return null;
  }

  const item = findPendingRelevantReviewItem(
    input,
    (reviewItem) => reviewItem.target.domain === "work_eligibility",
  );
  const nextRemoteEligible =
    requestedWorkMode === "remote"
      ? true
      : requestedWorkMode === "hybrid" || requestedWorkMode === "onsite"
        ? false
        : input.profile.workEligibility.remoteEligible;
  const operations: ProfileCopilotPatchGroup["operations"] = [];

  if (
    input.searchPreferences.workModes.length !== 1 ||
    input.searchPreferences.workModes[0] !== requestedWorkMode
  ) {
    operations.push({
      operation: "replace_search_preferences_fields",
      value: {
        workModes: [requestedWorkMode],
      },
    });
  }

  if (nextRemoteEligible !== input.profile.workEligibility.remoteEligible) {
    operations.push({
      operation: "replace_work_eligibility_fields",
      value: {
        remoteEligible: nextRemoteEligible,
      },
    });
  }

  if (item) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: [item.id],
      resolutionStatus: "edited",
    });
  }

  if (operations.length === 0) {
    return null;
  }

  return {
    id: createUniqueId("profile_patch_group"),
    summary: `Prefer ${requestedWorkMode} work mode`,
    applyMode: "needs_review",
    operations,
    createdAt: new Date().toISOString(),
  };
}

export interface SpecializedPatchResult {
  groups: ProfileCopilotPatchGroup[];
  clarificationQuestion: string | null;
}

export function buildSpecializedPatchResults(
  input: ReviseCandidateProfileInput,
): SpecializedPatchResult | null {
  const salaryOutcome = buildTargetSalaryPatchGroup(input);
  const groups = [
    buildExperienceWorkModePatchGroup(input),
    buildYearsExperiencePatchGroup(input),
    buildCurrentLocationPatchGroup(input),
    buildTargetRolesPatchGroup(input),
    salaryOutcome.kind === "group" ? salaryOutcome.group : null,
    buildWorkEligibilityPatchGroup(input),
    buildPreferredWorkModePatchGroup(input),
  ].filter((group): group is ProfileCopilotPatchGroup => group !== null);

  const clarificationQuestion =
    salaryOutcome.kind === "clarification" ? salaryOutcome.question : null;

  if (groups.length === 0 && clarificationQuestion === null) {
    return null;
  }

  return { groups, clarificationQuestion };
}
