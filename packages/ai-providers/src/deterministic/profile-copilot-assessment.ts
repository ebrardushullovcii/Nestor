import {
  ProfileCopilotReplySchema,
  type ProfileCopilotPatchGroup,
  type ProfileCopilotReply,
} from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";
import { inferTimeZoneFromLocation } from "./resume-parser-profile-helpers";
import {
  buildDateRangeLabel,
  createUniqueId,
  detectRequestedVisaSponsorship,
  findMentionedExperience,
  findPendingRelevantReviewItems,
  formatDurationMonths,
  normalizeFactText,
  parseIsoLikeMonth,
  trimNonEmptyString,
  type IdentityUrlField,
} from "./profile-copilot-helpers";

function buildExperienceFactReply(input: ReviseCandidateProfileInput) {
  const normalizedRequest = normalizeFactText(input.request);
  if (
    !/how long|tenure|worked on|worked at|work on|time at|when did i work/.test(
      normalizedRequest,
    )
  ) {
    return null;
  }

  const experience = findMentionedExperience(input);
  if (!experience) {
    return null;
  }

  const startMonth = parseIsoLikeMonth(experience.startDate);
  const endMonth = experience.isCurrent
    ? (() => {
        const now = new Date();
        return now.getUTCFullYear() * 12 + (now.getUTCMonth() + 1);
      })()
    : parseIsoLikeMonth(experience.endDate);
  const durationMonths =
    startMonth && endMonth ? Math.max(0, endMonth - startMonth) : null;
  const companyLabel = experience.companyName ?? "that company";
  const titleLabel = experience.title ?? "that role";
  const dateRange = buildDateRangeLabel(
    experience.startDate,
    experience.endDate,
    experience.isCurrent,
  );
  const workMode =
    experience.workMode.length > 0
      ? ` The saved work mode is ${experience.workMode.join(", ")}.`
      : "";

  return ProfileCopilotReplySchema.parse({
    content:
      durationMonths !== null
        ? `You have ${titleLabel} at ${companyLabel} saved from ${dateRange}, which is about ${formatDurationMonths(durationMonths)}.${workMode}`
        : `You have ${titleLabel} at ${companyLabel} saved from ${dateRange}.${workMode}`,
    patchGroups: [],
  });
}

function findLinkUrlByKind(
  input: ReviseCandidateProfileInput,
  kind: IdentityUrlField,
): string | null {
  const matchingLink = input.profile.links.find((link) => {
    if (!link.url) {
      return false;
    }

    switch (kind) {
      case "githubUrl":
        return /github\.com/i.test(link.url) || link.kind === "github";
      case "linkedinUrl":
        return /linkedin\.com/i.test(link.url) || link.kind === "linkedin";
      case "portfolioUrl":
        return link.kind === "portfolio";
      case "personalWebsiteUrl":
        return link.kind === "website";
    }
  });

  return trimNonEmptyString(matchingLink?.url);
}

function requestAsksForProfileGapAudit(request: string): boolean {
  const normalized = normalizeFactText(request);

  return (
    /\b(look at|review|scan|check)\b.*\b(profile|cv|resume)\b/.test(
      normalized,
    ) ||
    /\bhelp\b.*\b(fill\b.*\bmissing|missing\b.*\bprofile)\b/.test(normalized) ||
    /\bwhat(?:\s+of\s+those)?\s+needs\s+to\s+be\s+updated\b/.test(normalized) ||
    /\banything\s+missing\b/.test(normalized) ||
    /\bwhat(?:'s| is)\s+missing\b/.test(normalized) ||
    /\bfill\s+out\b.*\bmissing\b/.test(normalized) ||
    /\bwhat\s+should\s+i\s+fix\b/.test(normalized) ||
    /\bwhat\s+should\s+i\s+update\b/.test(normalized) ||
    /\bsafely\s+inferr?ed\b/.test(normalized) ||
    /\bstep\s+by\s+step\b/.test(normalized) ||
    /\bfew\s+fields\b/.test(normalized)
  );
}

function buildProfileGapHighlights(
  input: ReviseCandidateProfileInput,
): string[] {
  const highlights: string[] = [];

  if (
    !input.profile.githubUrl &&
    !input.profile.portfolioUrl &&
    !input.profile.personalWebsiteUrl
  ) {
    highlights.push("GitHub, portfolio, or personal website link");
  } else if (!input.profile.githubUrl) {
    highlights.push("GitHub URL");
  }

  if (input.profile.workEligibility.requiresVisaSponsorship === null) {
    highlights.push("visa sponsorship preference");
  }

  if (
    input.profile.workEligibility.remoteEligible === null &&
    input.searchPreferences.workModes.length === 0
  ) {
    highlights.push("remote or hybrid preference");
  } else if (input.searchPreferences.workModes.length === 0) {
    highlights.push("preferred work mode");
  }

  if (input.searchPreferences.targetSalaryUsd === null) {
    highlights.push("expected salary");
  }

  if (
    !input.profile.timeZone &&
    !inferTimeZoneFromLocation(input.profile.currentLocation)
  ) {
    highlights.push("time zone");
  }

  if (!input.profile.workEligibility.availableStartDate) {
    highlights.push("availability or notice period");
  }

  if (!input.profile.professionalSummary.shortValueProposition) {
    highlights.push("short value proposition");
  }

  return highlights.slice(0, 5);
}

function buildSafeInferencePatchGroup(input: ReviseCandidateProfileInput): {
  patchGroup: ProfileCopilotPatchGroup;
  details: string[];
} | null {
  const identityValue: Record<string, string> = {};
  const details: string[] = [];
  const inferredTimeZone = !input.profile.timeZone
    ? inferTimeZoneFromLocation(input.profile.currentLocation)
    : null;

  if (inferredTimeZone) {
    identityValue.timeZone = inferredTimeZone;
    details.push(
      `set time zone to ${inferredTimeZone} from ${input.profile.currentLocation}`,
    );
  }

  const inferredGithubUrl = !input.profile.githubUrl
    ? findLinkUrlByKind(input, "githubUrl")
    : null;
  if (inferredGithubUrl) {
    identityValue.githubUrl = inferredGithubUrl;
    details.push("promoted your saved GitHub link into the main GitHub field");
  }

  const inferredLinkedInUrl = !input.profile.linkedinUrl
    ? findLinkUrlByKind(input, "linkedinUrl")
    : null;
  if (inferredLinkedInUrl) {
    identityValue.linkedinUrl = inferredLinkedInUrl;
    details.push(
      "promoted your saved LinkedIn link into the main LinkedIn field",
    );
  }

  const inferredPortfolioUrl = !input.profile.portfolioUrl
    ? findLinkUrlByKind(input, "portfolioUrl")
    : null;
  if (inferredPortfolioUrl) {
    identityValue.portfolioUrl = inferredPortfolioUrl;
    details.push(
      "promoted your saved portfolio link into the main portfolio field",
    );
  }

  const inferredWebsiteUrl = !input.profile.personalWebsiteUrl
    ? findLinkUrlByKind(input, "personalWebsiteUrl")
    : null;
  if (inferredWebsiteUrl) {
    identityValue.personalWebsiteUrl = inferredWebsiteUrl;
    details.push(
      "promoted your saved website link into the main website field",
    );
  }

  const identityKeys = Object.keys(identityValue);

  if (identityKeys.length === 0) {
    return null;
  }

  const matchingReviewItems = findPendingRelevantReviewItems(
    input,
    (item) =>
      item.target.domain === "identity" &&
      identityKeys.includes(item.target.key),
  );
  const operations: ProfileCopilotPatchGroup["operations"] = [
    {
      operation: "replace_identity_fields",
      value: identityValue,
    },
  ];

  if (matchingReviewItems.length > 0) {
    operations.push({
      operation: "resolve_review_items",
      reviewItemIds: matchingReviewItems.map((item) => item.id),
      resolutionStatus: "edited",
    });
  }

  return {
    patchGroup: {
      id: createUniqueId("profile_patch_group"),
      summary:
        identityKeys.length === 1 && identityKeys[0] === "timeZone"
          ? "Set time zone from current location"
          : "Fill safe inferred profile details",
      applyMode: "applied",
      operations,
      createdAt: new Date().toISOString(),
    },
    details,
  };
}

function buildProfileAssessmentReply(
  input: ReviseCandidateProfileInput,
): ProfileCopilotReply | null {
  if (!requestAsksForProfileGapAudit(input.request)) {
    return null;
  }

  const safeInference = buildSafeInferencePatchGroup(input);
  const highlights = buildProfileGapHighlights(input);
  const lines: string[] = [];

  if (safeInference) {
    lines.push(
      `I filled the safest inferred ${safeInference.details.length === 1 ? "detail" : "details"} I could: ${safeInference.details.join("; ")}.`,
    );
  } else {
    lines.push(
      "Here are the highest-value fields to update next based on what is already saved.",
    );
  }

  if (highlights.length > 0) {
    lines.push("Top missing or still-unclear fields:");
    highlights.forEach((highlight) => lines.push(`- ${highlight}`));
  } else {
    lines.push(
      "The profile is already in decent shape, so the next pass should focus on polishing higher-signal details instead of filling obvious gaps.",
    );
  }

  lines.push(
    "If you want to go step by step, send one concrete value such as your GitHub URL, 'set visa sponsorship to no', or 'set my expected salary to 2000'.",
  );

  return ProfileCopilotReplySchema.parse({
    content: lines.join("\n"),
    patchGroups: safeInference ? [safeInference.patchGroup] : [],
  });
}

function buildVisaClarificationReply(
  input: ReviseCandidateProfileInput,
): ProfileCopilotReply | null {
  const normalized = normalizeFactText(input.request);

  if (
    !/\b(update|change|set|fix)\b/.test(normalized) ||
    !/\bvisa|sponsorship\b/.test(normalized)
  ) {
    return null;
  }

  if (detectRequestedVisaSponsorship(input.request) !== null) {
    return null;
  }

  return ProfileCopilotReplySchema.parse({
    content:
      "I can update visa sponsorship once you tell me which one is correct: `I need visa sponsorship` or `I do not need visa sponsorship`.",
    patchGroups: [],
  });
}

export function buildDeterministicAssessmentReply(
  input: ReviseCandidateProfileInput,
): ProfileCopilotReply | null {
  return (
    buildVisaClarificationReply(input) ??
    buildProfileAssessmentReply(input) ??
    buildExperienceFactReply(input)
  );
}
