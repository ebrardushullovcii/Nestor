import {
  ProfileCopilotReplySchema,
  type ProfileCopilotContext,
  type ProfileCopilotPatchGroup,
  type ProfileCopilotRelevantReviewItem,
} from "@nestor/contracts";

import type { ReviseCandidateProfileInput } from "../shared";

export function createUniqueId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  return `${prefix}_${suffix}`;
}

export function trimNonEmptyString(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeFactText(
  value: string | number | boolean | null | undefined,
): string {
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value).trim().toLowerCase();
  }

  return "";
}

export function getMatchingResolutionStatus(
  item: ProfileCopilotRelevantReviewItem,
  nextValue: string | number | boolean,
): "confirmed" | "edited" {
  return normalizeFactText(item.proposedValue) === normalizeFactText(nextValue)
    ? "confirmed"
    : "edited";
}

export function normalizeCompanyName(value: string | null | undefined): string {
  return normalizeFactText(value).replace(/[^a-z0-9]/g, "");
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a compacted name (see normalizeCompanyName) inside free text with
 * whole-word boundaries on both ends. Internal separators stay flexible so
 * "NorthLane" matches "north lane" and "Meta, Inc." matches "meta inc",
 * but a short name can never match as a substring of a longer word: "Meta"
 * does not match "metadata" because there is no word boundary inside it.
 */
function compactNameMatchesText(text: string, compactName: string): boolean {
  if (!text || !compactName) {
    return false;
  }

  const pattern = new RegExp(
    `\\b${[...compactName].map((char) => escapeRegExpLiteral(char)).join("[^a-z0-9]*")}\\b`,
    "i",
  );

  return pattern.test(text);
}

export function parseIsoLikeMonth(
  value: string | null | undefined,
): number | null {
  const normalized = normalizeFactText(value);

  if (!normalized) {
    return null;
  }

  if (normalized === "present" || normalized === "current") {
    return null;
  }

  const isoMatch = normalized.match(/^(\d{4})-(\d{2})/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);

    if (Number.isFinite(year) && Number.isFinite(month)) {
      return year * 12 + month;
    }
  }

  const monthYearMatch = normalized.match(
    /^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{4})$/,
  );
  if (!monthYearMatch) {
    return null;
  }

  const monthNumberByName: Record<string, number> = {
    jan: 1,
    january: 1,
    feb: 2,
    february: 2,
    mar: 3,
    march: 3,
    apr: 4,
    april: 4,
    may: 5,
    jun: 6,
    june: 6,
    jul: 7,
    july: 7,
    aug: 8,
    august: 8,
    sep: 9,
    sept: 9,
    september: 9,
    oct: 10,
    october: 10,
    nov: 11,
    november: 11,
    dec: 12,
    december: 12,
  };

  const month = monthNumberByName[monthYearMatch[1] ?? ""];
  const year = Number(monthYearMatch[2]);

  if (!month || !Number.isFinite(year)) {
    return null;
  }

  return year * 12 + month;
}

export function formatDurationMonths(totalMonths: number): string {
  if (totalMonths <= 0) {
    return "less than a month";
  }

  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const parts: string[] = [];

  if (years > 0) {
    parts.push(`${years} year${years === 1 ? "" : "s"}`);
  }

  if (months > 0) {
    parts.push(`${months} month${months === 1 ? "" : "s"}`);
  }

  return parts.join(" and ");
}

export function buildDateRangeLabel(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  isCurrent: boolean,
): string {
  const startLabel = trimNonEmptyString(startDate) ?? "an unknown start";
  const endLabel = isCurrent
    ? "present"
    : (trimNonEmptyString(endDate) ?? "an unknown end");
  return `${startLabel} to ${endLabel}`;
}

export function findMentionedExperience(input: ReviseCandidateProfileInput) {
  return (
    input.profile.experiences.find((experience) => {
      const company = normalizeCompanyName(experience.companyName);
      const title = normalizeCompanyName(experience.title);
      return Boolean(
        (company && compactNameMatchesText(input.request, company)) ||
        (title && compactNameMatchesText(input.request, title)),
      );
    }) ?? null
  );
}

export function describeContext(context: ProfileCopilotContext): string {
  if (context.surface === "setup") {
    return `setup ${context.step.replaceAll("_", " ")}`;
  }

  if (context.surface === "profile") {
    return `${context.section} profile section`;
  }

  return "profile";
}

export function buildReviewSummary(
  input: ReviseCandidateProfileInput,
): string | null {
  const pending = input.relevantReviewItems.filter(
    (item) => item.status === "pending",
  );

  if (pending.length === 0) {
    return null;
  }

  const topLabels = pending.slice(0, 2).map((item) => item.label);
  const suffix =
    pending.length > topLabels.length
      ? ` and ${pending.length - topLabels.length} more`
      : "";

  return `${topLabels.join(" and ")}${suffix}`;
}

export function buildNoChangeReply(input: ReviseCandidateProfileInput) {
  const contextLabel = describeContext(input.context);
  const reviewSummary = buildReviewSummary(input);
  const request = input.request.trim();
  const quotedRequest = request.length > 0 ? `“${request}”` : "that request";
  const isQuestion =
    request.endsWith("?") ||
    /^(what|which|who|where|when|why|how|should|could|can|do|does|is|are|would)\b/i.test(
      request,
    );

  if (isQuestion) {
    const asksAboutRoles = /\b(role|roles|job|jobs|career|search)\b/i.test(
      request,
    );
    const groundedRoles = Array.from(
      new Set(
        [
          ...input.searchPreferences.targetRoles,
          ...input.searchPreferences.jobFamilies,
          ...input.profile.targetRoles,
          ...input.profile.experiences.map((experience) => experience.title),
        ]
          .map((value) => value?.trim() ?? "")
          .filter(Boolean),
      ),
    ).slice(0, 4);

    return ProfileCopilotReplySchema.parse({
      content: asksAboutRoles
        ? groundedRoles.length > 0
          ? `Based on your saved profile, I would start with ${groundedRoles.join(", ")}. You do not have to save a target title: Find jobs can infer a starting search from your experience, and explicit roles are only useful when you want to narrow it.`
          : "You do not need to choose a target title before searching. Find jobs can use your saved experience as the starting point; add a role only when you want to narrow the search."
        : reviewSummary
          ? `Based on the saved ${contextLabel} context, the clearest next items are ${reviewSummary}. I can answer questions here without changing your profile, or propose a structured edit when you ask for one.`
          : `I can answer questions about the saved ${contextLabel} context without changing your profile. I do not have enough grounded evidence to answer that specific question yet; add the missing detail or ask me to review a particular saved section.`,
      patchGroups: [],
    });
  }

  return ProfileCopilotReplySchema.parse({
    content: reviewSummary
      ? `I reviewed ${quotedRequest} in the ${contextLabel} context, but I could not turn it into a safe structured profile edit yet. The next highest-value items are ${reviewSummary}.`
      : `I reviewed ${quotedRequest} in the ${contextLabel} context, but I could not turn it into a safe structured profile edit yet.`,
    patchGroups: [],
  });
}

export function extractTrailingInteger(request: string): number | null {
  const match = request.match(/(\d{1,2})(?:\+)?(?:[.!?])?\s*$/);
  const value = Number(match?.[1] ?? Number.NaN);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function findPendingRelevantReviewItem(
  input: ReviseCandidateProfileInput,
  predicate: (item: ProfileCopilotRelevantReviewItem) => boolean,
): ProfileCopilotRelevantReviewItem | null {
  return (
    input.relevantReviewItems.find(
      (item) => item.status === "pending" && predicate(item),
    ) ?? null
  );
}

export function findPendingRelevantReviewItems(
  input: ReviseCandidateProfileInput,
  predicate: (item: ProfileCopilotRelevantReviewItem) => boolean,
): ProfileCopilotRelevantReviewItem[] {
  return input.relevantReviewItems.filter(
    (item) => item.status === "pending" && predicate(item),
  );
}

export function detectRequestedWorkMode(
  request: string,
): "remote" | "hybrid" | "onsite" | null {
  const normalized = request.toLowerCase();

  if (/\bremote\b/.test(normalized)) {
    return "remote";
  }

  if (/\bhybrid\b/.test(normalized)) {
    return "hybrid";
  }

  if (/\bonsite\b|on-site|in office|in-office/.test(normalized)) {
    return "onsite";
  }

  return null;
}

export function detectRequestedVisaSponsorship(
  request: string,
): boolean | null {
  const normalized = normalizeFactText(request);

  if (!/\b(visa|sponsorship|sponsor)\b/.test(normalized)) {
    return null;
  }

  const negativePatterns = [
    /\b(?:do not|don't|dont)\s+need\s+(?:a\s+)?visa\b/,
    /\b(?:do not|don't|dont)\s+need\s+sponsorship\b/,
    /\b(?:do not|don't|dont)\s+want\s+(?:a\s+)?visa\b/,
    /\bno\s+(?:visa|sponsorship)\b/,
    /\bwithout\s+(?:visa\s+)?sponsorship\b/,
    /\bno\s+need\s+for\s+(?:visa\s+)?sponsorship\b/,
  ] as const;
  const positivePatterns = [
    /\bneed\s+(?:a\s+)?visa\b/,
    /\bneed\s+sponsorship\b/,
    /\brequire\s+(?:visa\s+)?sponsorship\b/,
    /\brequires\s+(?:visa\s+)?sponsorship\b/,
    /\bwill\s+need\s+(?:visa\s+)?sponsorship\b/,
  ] as const;

  if (negativePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  if (positivePatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return null;
}

export function detectRequestedRemoteEligibility(
  request: string,
): boolean | null {
  const normalized = normalizeFactText(request);

  if (!/\bremote\b/.test(normalized)) {
    return null;
  }

  const positivePatterns = [
    /\b(?:i am|i'm|im)?\s*(?:fine|okay|ok|happy|able|available)\s+(?:to\s+)?work(?:ing)?\s+remote\b/,
    /\bcan\s+work\s+remote\b/,
    /\bprefer(?:red|ing)?\s+remote\b/,
    /\bremote\s+eligible\b/,
    /\b(?:fully\s+)?remote\s+is\s+fine\b/,
  ] as const;
  const negativePatterns = [
    /\b(?:can(?:not|'t)|cannot|won't|will not|not)\s+work\s+remote\b/,
    /\bnot\s+remote\b/,
  ] as const;

  if (negativePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  if (positivePatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return detectRequestedWorkMode(request) === "remote" ? true : null;
}

export function extractRequestUrls(request: string): string[] {
  return [...request.matchAll(/https?:\/\/[^\s)]+/gi)]
    .map((match) => match[0]?.replace(/[.,!?]+$/g, "") ?? "")
    .filter((value) => value.length > 0);
}

export type IdentityUrlField =
  | "githubUrl"
  | "linkedinUrl"
  | "portfolioUrl"
  | "personalWebsiteUrl";

export function inferIdentityUrlField(
  request: string,
  url: string,
): IdentityUrlField | null {
  const normalized = normalizeFactText(request);

  if (/github\.com/i.test(url)) {
    return "githubUrl";
  }

  if (/linkedin\.com/i.test(url)) {
    return "linkedinUrl";
  }

  if (
    /(behance\.net|dribbble\.com|artstation\.com|adobe\.com\/portfolio)/i.test(
      url,
    )
  ) {
    return "portfolioUrl";
  }

  if (/\bportfolio\b|\bshowcase\b/.test(normalized)) {
    return "portfolioUrl";
  }

  if (
    /\b(personal website|website|site|homepage|personal page)\b/.test(
      normalized,
    )
  ) {
    return "personalWebsiteUrl";
  }

  return null;
}

export function formatIdentityFieldLabel(
  field:
    | IdentityUrlField
    | "timeZone"
    | "requiresVisaSponsorship"
    | "remoteEligible",
): string {
  switch (field) {
    case "githubUrl":
      return "GitHub URL";
    case "linkedinUrl":
      return "LinkedIn URL";
    case "portfolioUrl":
      return "portfolio URL";
    case "personalWebsiteUrl":
      return "personal website";
    case "timeZone":
      return "time zone";
    case "requiresVisaSponsorship":
      return "visa sponsorship preference";
    case "remoteEligible":
      return "remote eligibility";
  }
}

export function looksLikeExplicitAnswer(request: string): boolean {
  const normalized = request.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  return (
    normalized.includes(":") ||
    /^set\b/.test(normalized) ||
    /^update\b/.test(normalized) ||
    /^change\b/.test(normalized) ||
    /^make\b/.test(normalized) ||
    /^use\b/.test(normalized) ||
    /^mark\b/.test(normalized) ||
    /^it should be\b/.test(normalized) ||
    /^this should be\b/.test(normalized) ||
    /^my .* should be\b/.test(normalized)
  );
}

export function sanitizeDerivedDetail(
  value: string | null | undefined,
): string | null {
  return trimNonEmptyString(value);
}

export function detectRequestedYearsExperience(request: string): number | null {
  const numberWords: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
  };
  const normalized = request.toLowerCase();

  if (
    !/\b(years?\s+of\s+experience|years?\s+experience|yoe|experience)\b/.test(
      normalized,
    )
  ) {
    return null;
  }

  const correctedRange = normalized.match(
    /\bfrom\s+(\d{1,2}|[a-z]+)\s+years?(?:\s+of\s+experience)?\s+to\s+(\d{1,2}|[a-z]+)\b/,
  );
  if (correctedRange) {
    const rawNext = correctedRange[2] ?? "";
    const next = /^\d{1,2}$/u.test(rawNext)
      ? Number(rawNext)
      : numberWords[rawNext];
    if (Number.isInteger(next) && next !== undefined) {
      return next;
    }
  }

  const trailingInteger = extractTrailingInteger(request);

  if (!looksLikeExplicitAnswer(request) && trailingInteger === null) {
    return null;
  }

  const patterns = [
    /:\s*(\d{1,2})(?:\+)?\s*$/i,
    /\b(?:experience|years?(?:\s+of\s+experience)?)(?:\s+to\s+be|\s+as|\s+at|\s+is|\s+should\s+be)?\s+(\d{1,2})(?:\+)?(?:\s+years?)?(?:\b|$)/i,
    /\bto\s+(?:only\s+)?(\d{1,2})(?:\+)?(?:\s+years?(?:\s+of\s+experience)?)?(?:[.!?])?\s*$/i,
    /\bshould be\s+(?:only\s+)?(\d{1,2})(?:\+)?(?:\s+years?(?:\s+of\s+experience)?)?(?:[.!?])?\s*$/i,
    /\bas\s+(?:only\s+)?(\d{1,2})(?:\+)?(?:\s+years?(?:\s+of\s+experience)?)?(?:[.!?])?\s*$/i,
  ] as const;

  for (const pattern of patterns) {
    const match = request.match(pattern);
    const value = Number(match?.[1] ?? Number.NaN);

    if (Number.isInteger(value) && value >= 0) {
      return value;
    }
  }

  return trailingInteger;
}

export function formatPatchGroupSummaryList(
  patchGroups: readonly ProfileCopilotPatchGroup[],
): string {
  const summaries = patchGroups.map((patchGroup) => patchGroup.summary);

  if (summaries.length <= 1) {
    return summaries[0] ?? "";
  }

  if (summaries.length === 2) {
    return `${summaries[0]} and ${summaries[1]}`;
  }

  return `${summaries.slice(0, -1).join(", ")}, and ${summaries[summaries.length - 1]}`;
}

export function requestLooksLikeWorkModePreferenceEdit(
  request: string,
): boolean {
  const normalized = normalizeFactText(request);

  if (
    /preferred locations|locations to search|target locations|excluded locations/.test(
      normalized,
    )
  ) {
    return false;
  }

  return /\b(work mode|workstyle|work style|prefer(?:red|ed)?|remote work|hybrid work|onsite work|on site work)\b/.test(
    normalized,
  );
}

export function requestLooksLikeLocationListEdit(request: string): boolean {
  const normalized = normalizeFactText(request);

  return /preferred locations|locations to search|target locations|excluded locations/.test(
    normalized,
  );
}

export function deriveRequestedDetail(request: string): string | null {
  const colonIndex = request.indexOf(":");

  if (colonIndex >= 0) {
    return sanitizeDerivedDetail(request.slice(colonIndex + 1));
  }

  const quoted = request.match(/["“](.+?)["”]/);

  if (quoted) {
    return sanitizeDerivedDetail(quoted[1] ?? "");
  }

  const explicitAssignmentMatch = request.match(
    /\b(?:to|as|should be|use)\s+(.+)$/i,
  );

  return explicitAssignmentMatch
    ? sanitizeDerivedDetail(explicitAssignmentMatch[1] ?? "")
    : null;
}
