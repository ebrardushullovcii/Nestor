import type {
  ExtractProfileFromResumeInput,
  ResumeProfileExtraction,
} from "../shared";
import { ResumeProfileExtractionSchema } from "../shared";
import {
  contactOrMetaPattern,
  headlineKeywordPattern,
  summarySectionAliases,
} from "./constants";
import {
  cleanLine,
  extractAllUrls,
  extractRegexMatch,
  findSectionBodyLinesByAliases,
  isResumeSectionHeading,
  normalizeLocationLabel,
  splitLines,
  uniqueStrings,
} from "./utils";
import { inferSkillGroups, inferSkills } from "./resume-parser-skills";
import {
  inferExperienceEntries,
  normalizeHeadlineText,
} from "./resume-parser-experience";
import {
  buildProfileExtractionNotes,
  inferCertifications,
  inferEducationEntries,
  inferGithubUrl,
  inferLinks,
  inferLocations,
  inferPersonalWebsiteUrl,
  inferProfessionalSummary,
  inferProjects,
  inferSalaryCurrencyFromLocation,
  inferSpokenLanguages,
  inferTimeZoneFromLocation,
} from "./resume-parser-profile-helpers";

type BuildDeterministicResumeProfileExtractionOptions = {
  preserveExistingValues?: boolean;
  now?: Date | (() => Date);
};

function resolveNow(input?: Date | (() => Date)): Date {
  if (!input) {
    return new Date();
  }

  return input instanceof Date ? input : input();
}

const experienceDateTokenPattern =
  /(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+)?(?:(\d{1,2})\/)?(\d{4})/i;

function toMonthIndex(month: string | undefined): number {
  switch ((month ?? "").toLowerCase()) {
    case "jan":
      return 0;
    case "feb":
      return 1;
    case "mar":
      return 2;
    case "apr":
      return 3;
    case "may":
      return 4;
    case "jun":
      return 5;
    case "jul":
      return 6;
    case "aug":
      return 7;
    case "sep":
    case "sept":
      return 8;
    case "oct":
      return 9;
    case "nov":
      return 10;
    case "dec":
      return 11;
    default:
      return 0;
  }
}

function parseExperienceDateToken(
  value: string | null,
): { year: number; month: number } | null {
  if (!value) {
    return null;
  }

  const cleanedValue = cleanLine(value);
  const isoMonthMatch = cleanedValue.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);

  if (isoMonthMatch) {
    const year = Number.parseInt(isoMonthMatch[1] ?? "", 10);
    const month = Number.parseInt(isoMonthMatch[2] ?? "", 10);

    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      month >= 1 &&
      month <= 12
    ) {
      return { year, month: month - 1 };
    }
  }

  const match = cleanedValue.match(experienceDateTokenPattern);

  if (!match) {
    return null;
  }

  const monthName = match[1];
  const numericMonth = Number.parseInt(match[2] ?? "", 10);
  const year = Number.parseInt(match[3] ?? "", 10);

  if (!Number.isFinite(year)) {
    return null;
  }

  if (
    Number.isFinite(numericMonth) &&
    numericMonth >= 1 &&
    numericMonth <= 12
  ) {
    return { year, month: numericMonth - 1 };
  }

  return { year, month: toMonthIndex(monthName) };
}

function inferYearsExperienceFromEntries(
  experiences: ReadonlyArray<{
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
  }>,
  now: Date,
): number | null {
  const datedRanges = experiences
    .map((experience) => {
      const start = parseExperienceDateToken(experience.startDate);
      if (!start) {
        return null;
      }

      const end = experience.isCurrent
        ? { year: now.getUTCFullYear(), month: now.getUTCMonth() }
        : (parseExperienceDateToken(experience.endDate) ?? start);

      const startTotalMonths = start.year * 12 + start.month;
      const endTotalMonths = end.year * 12 + end.month;

      if (endTotalMonths < startTotalMonths) {
        return null;
      }

      return {
        startTotalMonths,
        endTotalMonths,
      };
    })
    .filter(
      (range): range is { startTotalMonths: number; endTotalMonths: number } =>
        range !== null,
    )
    .sort((left, right) => left.startTotalMonths - right.startTotalMonths);

  if (datedRanges.length === 0) {
    return null;
  }

  let coveredMonths = 0;
  let currentRange = datedRanges[0];

  for (const range of datedRanges.slice(1)) {
    if (!currentRange) {
      currentRange = range;
      continue;
    }

    if (range.startTotalMonths <= currentRange.endTotalMonths + 1) {
      currentRange = {
        startTotalMonths: currentRange.startTotalMonths,
        endTotalMonths: Math.max(
          currentRange.endTotalMonths,
          range.endTotalMonths,
        ),
      };
      continue;
    }

    coveredMonths +=
      currentRange.endTotalMonths - currentRange.startTotalMonths + 1;
    currentRange = range;
  }

  if (currentRange) {
    coveredMonths +=
      currentRange.endTotalMonths - currentRange.startTotalMonths + 1;
  }

  if (coveredMonths < 12) {
    return null;
  }

  return Math.floor(coveredMonths / 12);
}

const nonNamePhrasePattern =
  /\b(software|engineer|developer|designer|manager|director|analyst|consultant|specialist|architect|consulting|technical|mentorship|leadership|performance|productivity|quality|security|platform|platforms|systems|cloud|devops|support|experience|summary|profile|skills|project|projects|work|professional|staff|senior|principal|lead|frontend|backend|full-stack|scale)\b/i;

function hasNearbyHeaderSignal(
  lines: readonly string[],
  index: number,
): boolean {
  return lines
    .slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
    .some((line, relativeIndex) => {
      const absoluteIndex = Math.max(0, index - 2) + relativeIndex;

      if (absoluteIndex === index) {
        return false;
      }

      return (
        /^\+?\d/.test(line) ||
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(line) ||
        /(?:https?:\/\/|(?:www\.)?(?:linkedin|github)\.com\/)/i.test(line) ||
        isLikelyHeaderLocation(trimTrailingContactFragments(line))
      );
    });
}

function isLikelyNameToken(value: string): boolean {
  return /^[A-Z][A-Za-z.'-]*$/.test(value) || /^[A-Z]{2,}$/.test(value);
}

function isLikelyHeaderName(value: string): boolean {
  const cleaned = cleanLine(value);

  if (!cleaned || cleaned.length > 56) {
    return false;
  }

  if (/@|https?:\/\//i.test(cleaned)) {
    return false;
  }

  if (
    /resume|curriculum|summary|profile|experience|birth|nationality|phone|email|address|skills|linkedin/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  if (nonNamePhrasePattern.test(cleaned)) {
    return false;
  }

  const parts = cleaned.split(/\s+/).filter(Boolean);
  return (
    parts.length >= 2 && parts.length <= 4 && parts.every(isLikelyNameToken)
  );
}

function extractNameFromHeaderLine(line: string): string | null {
  const cleaned = cleanLine(line);

  const tokens = cleaned.split(/\s+/).filter(Boolean);

  for (
    let tokenCount = 2;
    tokenCount <= Math.min(4, tokens.length);
    tokenCount += 1
  ) {
    const candidate = cleanLine(tokens.slice(0, tokenCount).join(" "));
    const remainder = cleanLine(tokens.slice(tokenCount).join(" "));

    if (!isLikelyHeaderName(candidate) || !remainder) {
      continue;
    }

    if (
      /^\+?\d/.test(remainder) ||
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(remainder) ||
      /(?:https?:\/\/|(?:www\.)?(?:linkedin|github)\.com\/)/i.test(remainder) ||
      isLikelyHeaderLocation(trimTrailingContactFragments(remainder))
    ) {
      return candidate;
    }
  }

  return null;
}

function trimTrailingContactFragments(value: string): string {
  return cleanLine(value.split(/\s*[·|]\s*/)[0] ?? value)
    .replace(
      /\s+(?:\(?\+?\d[\d\s().-]{7,}\d\)?|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|https?:\/\/\S+|(?:www\.)?(?:linkedin|github)\.com\/\S+).*$/i,
      "",
    )
    .trim();
}

function extractLocationFromHeaderLine(
  line: string,
  fullName: string | null,
): string | null {
  let candidate = cleanLine(line);

  if (fullName) {
    const escapedName = fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    candidate = candidate.replace(new RegExp(`^${escapedName}\\s+`, "i"), "");
  }

  const delimitedSegments = candidate
    .split(/\s*[|·]\s*/)
    .map((segment) => cleanLine(segment))
    .filter(Boolean)
    .reverse();

  for (const segment of delimitedSegments) {
    if (isLikelyHeaderLocation(segment)) return normalizeLocationLabel(segment);
    const segmentMatch = segment.match(
      /([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*,\s*(?:[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?|[A-Za-z][A-Za-z\s.'-]+))$/,
    );
    const segmentLocation = normalizeLocationLabel(
      segmentMatch?.[1] ?? segment,
    );

    if (isLikelyHeaderLocation(segmentLocation)) {
      return segmentLocation;
    }
  }

  candidate = trimTrailingContactFragments(candidate);
  if (isLikelyHeaderLocation(candidate))
    return normalizeLocationLabel(candidate);
  const match = candidate.match(
    /([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+)*,\s*(?:[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?|[A-Za-z][A-Za-z\s.'-]+))$/,
  );
  return normalizeLocationLabel(match?.[1] ?? candidate);
}

function isLikelyHeaderLocation(value: string | null): boolean {
  if (!value) {
    return false;
  }

  const cleaned = cleanLine(value);
  const firstSegment = cleanLine(cleaned.split(",")[0] ?? "");
  const secondSegment = cleanLine(cleaned.split(",").slice(1).join(","));

  if (!cleaned || cleaned.length > 96) {
    return false;
  }

  if (/[@]|https?:\/\//i.test(cleaned)) {
    return false;
  }

  if (
    /\b(recently|decided|return|passion|experience|building|driven|improving)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  if (
    /\b(engineer|developer|designer|manager|director|analyst|consultant|specialist|architect|intern|officer|scientist)\b/i.test(
      firstSegment,
    )
  ) {
    return false;
  }

  if (
    /\b(bachelor|master|ph\.?d|degree|university|college|school|academy)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  if (/\b(inc|corp|corporation|llc|ltd|gmbh|company)\b/i.test(secondSegment)) {
    return false;
  }

  return (
    /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+$/.test(
      cleaned,
    ) ||
    /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+$/.test(cleaned) ||
    /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(
      cleaned,
    ) ||
    /^[A-Za-z][A-Za-z\s.'-]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(cleaned)
  );
}

function inferCurrentLocation(
  lines: readonly string[],
  fullName: string | null,
): string | null {
  const firstSectionIndex = lines.findIndex(isResumeSectionHeading);
  const headerLines = lines.slice(
    0,
    firstSectionIndex >= 0 ? Math.min(firstSectionIndex, 8) : 8,
  );
  const addressLine = lines.find((line) => /^Address:/i.test(line));

  if (addressLine) {
    const cleaned = cleanLine(
      addressLine.replace(/^Address:\s*/i, "").replace(/\s*\([^)]*\)\s*$/g, ""),
    );

    if (cleaned) {
      return cleaned;
    }
  }

  for (const line of headerLines) {
    const headerLocation = extractLocationFromHeaderLine(line, fullName);

    if (isLikelyHeaderLocation(headerLocation)) {
      return headerLocation;
    }
  }

  if (fullName) {
    for (const line of headerLines) {
      const cleaned = cleanLine(line);
      const inlineMatch = cleaned.match(
        /^([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,3})\s+(.+)$/,
      );

      if (!inlineMatch) {
        continue;
      }

      const candidateName = cleanLine(inlineMatch[1] ?? "");

      if (candidateName.toLowerCase() !== fullName.toLowerCase()) {
        continue;
      }

      const locationCandidate = normalizeLocationLabel(
        trimTrailingContactFragments(inlineMatch[2] ?? ""),
      );

      if (isLikelyHeaderLocation(locationCandidate)) {
        return locationCandidate;
      }
    }
  }

  const locationHintPattern =
    /\b(?:[A-Z]{2}|UK|USA|UAE|Kosovo|Canada|Germany|France|India|Japan|Australia|Singapore|London|Toronto|Berlin|Paris|Prishtina|New York)\b|\b\d{5}(?:-\d{4})?\b/;
  const degreeOrSchoolPattern =
    /\b(?:Bachelor|Master|B\.?Sc|M\.?Sc|Ph\.?D|University|College|School|Academy)\b/i;
  const roleOrCompanyPattern =
    /\b(?:Engineer|Developer|Designer|Manager|Director|Analyst|Consultant|Specialist|Intern|Lead|Inc|Corp|LLC|Ltd|GmbH)\b/i;

  const fallbackLine = lines
    .slice(0, 12)
    .find(
      (line) =>
        /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+$/.test(line) &&
        !/–/.test(line) &&
        !contactOrMetaPattern.test(line) &&
        locationHintPattern.test(line) &&
        !degreeOrSchoolPattern.test(line) &&
        !roleOrCompanyPattern.test(line),
    );

  return normalizeLocationLabel(fallbackLine ?? null);
}

function inferPhone(
  resumeText: string,
  existingPhone: string | null,
): string | null {
  const labeledMatch = resumeText.match(
    /Phone:\s*([^\n]+?)(?:\s+Email:|\s+Website:|\s+Address:|$)/i,
  );

  if (labeledMatch?.[1]) {
    const cleaned = cleanLine(
      labeledMatch[1].replace(/\s*\((?:mobile|home|work)\)\s*$/i, ""),
    );

    if (cleaned) {
      return cleaned;
    }
  }

  return (
    extractRegexMatch(resumeText, /(\(?\+?\d[\d\s().-]{7,}\d\)?)/) ??
    existingPhone
  );
}

function inferPortfolioUrl(
  resumeText: string,
  personalWebsiteUrl?: string | null,
): string | null {
  const trimmedPersonalWebsiteUrl = personalWebsiteUrl?.trim() ?? "";
  if (trimmedPersonalWebsiteUrl) {
    return trimmedPersonalWebsiteUrl;
  }

  const portfolioSignals = [
    "portfolio",
    "showcase",
    "projects",
    "website",
    "site",
    "github",
    "gitlab",
    "behance",
    "dribbble",
    "codepen",
  ];
  const excludedDomains = [
    "linkedin.com",
    "coursera.org",
    "udemy.com",
    "skillshare.com",
    "pluralsight.com",
    "indeed.com",
    "glassdoor.com",
    "monster.com",
    "ziprecruiter.com",
  ];

  return (
    extractAllUrls(resumeText).find((url) => {
      try {
        const parsedUrl = new URL(url);
        const hostname = parsedUrl.hostname.toLowerCase();
        const haystack = `${hostname}${parsedUrl.pathname}`.toLowerCase();

        if (
          excludedDomains.some(
            (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
          )
        ) {
          return false;
        }

        return portfolioSignals.some((signal) => haystack.includes(signal));
      } catch {
        return false;
      }
    }) ?? null
  );
}

function inferName(lines: readonly string[]): string | null {
  const headerLines = lines.slice(0, 12);

  for (const line of headerLines) {
    const inlineName = extractNameFromHeaderLine(line);

    if (inlineName) {
      return inlineName;
    }
  }

  const rankedCandidates = headerLines
    .map((line, index) => {
      if (
        !isLikelyHeaderName(line) ||
        /^https?:\/\//i.test(line) ||
        /resume|curriculum|summary|profile|experience|birth|nationality|phone|email|address/i.test(
          line,
        )
      ) {
        return null;
      }

      const score =
        (index < 4 ? 3 : 0) +
        (hasNearbyHeaderSignal(headerLines, index) ? 4 : 0) +
        (line.split(/\s+/).length === 2 ? 1 : 0);

      return {
        line,
        score,
      };
    })
    .filter((candidate): candidate is { line: string; score: number } =>
      Boolean(candidate),
    )
    .sort((left, right) => right.score - left.score);

  return rankedCandidates[0]?.line ?? null;
}

/**
 * "DANA KIM" on a resume header is styling, not a spelling: shouted names
 * came through into form fields and onto generated PDFs. Only a word that is
 * entirely upper case is changed; "McKay" and "de la Cruz" stay as written.
 */
export function normalizeShoutedName(fullName: string | null): string | null {
  if (!fullName) {
    return fullName;
  }
  return fullName
    .trim()
    .split(/\s+/)
    .map((word) =>
      word.length > 1 && word === word.toUpperCase() && /\p{L}/u.test(word)
        ? word
            .toLowerCase()
            .replace(
              /(^|[-'’])(\p{L})/gu,
              (_match: string, separator: string, letter: string) =>
                `${separator}${letter.toUpperCase()}`,
            )
        : word,
    )
    .join(" ");
}

function parseNameParts(fullName: string | null) {
  if (!fullName) {
    return { firstName: null, lastName: null, middleName: null };
  }

  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return { firstName: null, lastName: null, middleName: null };
  }

  if (parts.length === 1) {
    return { firstName: parts[0] ?? null, lastName: null, middleName: null };
  }

  if (parts.length === 2) {
    return {
      firstName: parts[0] ?? null,
      lastName: parts[1] ?? null,
      middleName: null,
    };
  }

  return {
    firstName: parts[0] ?? null,
    lastName: parts[parts.length - 1] ?? null,
    middleName: parts.slice(1, -1).join(" ") || null,
  };
}

function isHeadlineCandidate(line: string): boolean {
  const sanitized = trimTrailingContactFragments(line);

  return (
    !sanitized.includes("@") &&
    !/^https?:\/\//i.test(sanitized) &&
    !contactOrMetaPattern.test(sanitized) &&
    headlineKeywordPattern.test(sanitized) &&
    sanitized.length <= 72 &&
    sanitized.split(/\s+/).length <= 10
  );
}

type HeadlineExperience = {
  isCurrent: boolean;
  title: string | null;
};

function inferHeadline(
  lines: readonly string[],
  experiences: readonly HeadlineExperience[],
): string | null {
  const firstSectionIndex = lines.findIndex((line) =>
    isResumeSectionHeading(line),
  );
  const headerLines =
    firstSectionIndex === -1
      ? lines.slice(0, 12)
      : lines.slice(0, firstSectionIndex);
  const headerCandidate = headerLines.find(isHeadlineCandidate);

  if (headerCandidate) {
    return normalizeHeadlineText(trimTrailingContactFragments(headerCandidate));
  }

  const primaryCurrentExperience =
    experiences.find(
      (experience) =>
        experience.isCurrent &&
        experience.title &&
        !/\b(?:consultant|part[ -]?time)\b/i.test(experience.title),
    ) ??
    experiences.find((experience) => experience.isCurrent && experience.title);
  const canonicalRoleTitle =
    primaryCurrentExperience?.title ??
    experiences.find((experience) => experience.title)?.title;

  return canonicalRoleTitle ? normalizeHeadlineText(canonicalRoleTitle) : null;
}

function inferSummary(lines: readonly string[]): string | null {
  const aboutLines = findSectionBodyLinesByAliases(
    lines,
    summarySectionAliases,
  ).filter(
    (line) =>
      !/date of birth|nationality|phone|email|website|address/i.test(line) &&
      !/^https?:\/\//i.test(line),
  );

  if (aboutLines.length > 0) {
    return cleanLine(aboutLines.join(" "));
  }

  const firstSectionIndex = lines.findIndex((line) =>
    isResumeSectionHeading(line),
  );
  const fallbackSearchLines =
    firstSectionIndex === -1 ? lines : lines.slice(0, firstSectionIndex);
  const fallbackStartIndex = fallbackSearchLines.findIndex(
    (line) =>
      line.length >= 48 &&
      !line.includes("@") &&
      !/^https?:\/\//i.test(line) &&
      !/date of birth|nationality|phone|email|website|address/i.test(line) &&
      !isResumeSectionHeading(line),
  );

  if (fallbackStartIndex === -1) {
    return null;
  }

  const collectedLines = [fallbackSearchLines[fallbackStartIndex]!];

  for (const line of fallbackSearchLines.slice(
    fallbackStartIndex + 1,
    fallbackStartIndex + 4,
  )) {
    if (
      isResumeSectionHeading(line) ||
      line.includes("@") ||
      /^https?:\/\//i.test(line) ||
      /date of birth|nationality|phone|email|website|address/i.test(line)
    ) {
      break;
    }

    if (line.length < 24) {
      break;
    }

    collectedLines.push(line);
  }

  return cleanLine(collectedLines.join(" "));
}

export function buildDeterministicResumeProfileExtraction(
  input: ExtractProfileFromResumeInput,
  analysisProviderKind: ResumeProfileExtraction["analysisProviderKind"],
  analysisProviderLabel: string,
  options?: BuildDeterministicResumeProfileExtractionOptions,
): ResumeProfileExtraction {
  const preserveExistingValues = options?.preserveExistingValues ?? true;
  const now = resolveNow(options?.now);
  input = {
    ...input,
    resumeText: input.resumeText
      .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
      .replace(/(?<!\w)([*_])([^\n]+?)\1(?!\w)/g, "$2")
      .replace(/^\s*#{1,6}\s+/gm, "")
      .replace(/\b(\d{1,2})\s*\r?\n\s*(\/\d{4})\b/g, "$1$2")
      .replace(/(\p{L})-\s*\r?\n\s*(?=\p{Ll})/gu, "$1"),
  };
  const lines = splitLines(input.resumeText);
  const fullName = normalizeShoutedName(inferName(lines));
  const nameParts = parseNameParts(fullName);
  const experiences = inferExperienceEntries(input.resumeText);
  const headline = inferHeadline(lines, experiences);
  const summary = inferSummary(lines);
  const currentLocation = inferCurrentLocation(lines, fullName);
  const skills = inferSkills(
    input.resumeText,
    preserveExistingValues ? input.existingProfile.skills : [],
  );
  const skillGroups = inferSkillGroups(input.resumeText, skills);
  const personalWebsiteUrl = inferPersonalWebsiteUrl(input.resumeText);
  const portfolioUrl = inferPortfolioUrl(input.resumeText, personalWebsiteUrl);
  const education = inferEducationEntries(input.resumeText);
  const certifications = inferCertifications(input.resumeText);
  const projects = inferProjects(input.resumeText);
  const notes = buildProfileExtractionNotes({
    fullName,
    headline,
    summary,
    currentLocation,
  });
  const parsedYearsExperience = Number.parseInt(
    extractRegexMatch(input.resumeText, /\b\d{1,2}\+?\s+years?\b/i)?.match(
      /\d+/,
    )?.[0] ?? "",
    10,
  );
  const extractedYearsExperience = Number.isNaN(parsedYearsExperience)
    ? inferYearsExperienceFromEntries(experiences, now)
    : parsedYearsExperience;
  const extractedEmail = extractRegexMatch(
    input.resumeText,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  );
  const extractedPhone = inferPhone(
    input.resumeText,
    preserveExistingValues ? input.existingProfile.phone : null,
  );
  const extractedGithubUrl = inferGithubUrl(input.resumeText);
  const extractedLinkedinUrl =
    extractAllUrls(input.resumeText).find((url) =>
      /^https?:\/\/(?:www\.)?linkedin\.com\//i.test(url),
    ) ?? null;
  const extractedTimeZone = inferTimeZoneFromLocation(currentLocation);
  const extractedSalaryCurrency =
    inferSalaryCurrencyFromLocation(currentLocation);
  const objectiveRoles = findSectionBodyLinesByAliases(lines, [
    "OBJECTIVE",
    "CAREER OBJECTIVE",
  ]).flatMap((line) => {
    const match = line.match(
      /(?:seeking|looking for|objective:)\s+(?:an?\s+)?(.+?)(?:\s+(?:roles?|positions?|jobs?|with|where|at)\b|[.!]|$)/i,
    );
    const role = cleanLine(match?.[1] ?? line);
    return role.length <= 80 && headlineKeywordPattern.test(role) ? [role] : [];
  });
  const extractedTargetRoles =
    objectiveRoles.length > 0
      ? uniqueStrings(objectiveRoles)
      : uniqueStrings(headline ? [headline] : []);
  const targetRoles =
    extractedTargetRoles.length > 0
      ? extractedTargetRoles
      : preserveExistingValues
        ? uniqueStrings(input.existingProfile.targetRoles)
        : [];
  const preferredLocations = currentLocation
    ? uniqueStrings([currentLocation])
    : preserveExistingValues
      ? inferLocations(
          currentLocation,
          input.existingProfile,
          input.existingSearchPreferences,
        )
      : [];

  return ResumeProfileExtractionSchema.parse({
    firstName: preserveExistingValues
      ? (nameParts.firstName ?? input.existingProfile.firstName)
      : nameParts.firstName,
    lastName: preserveExistingValues
      ? (nameParts.lastName ?? input.existingProfile.lastName)
      : nameParts.lastName,
    middleName: preserveExistingValues
      ? (nameParts.middleName ?? input.existingProfile.middleName)
      : nameParts.middleName,
    fullName: preserveExistingValues
      ? (fullName ?? input.existingProfile.fullName)
      : fullName,
    headline: preserveExistingValues
      ? (headline ?? input.existingProfile.headline)
      : headline,
    summary: preserveExistingValues
      ? (summary ?? input.existingProfile.summary)
      : summary,
    currentLocation: preserveExistingValues
      ? (currentLocation ?? input.existingProfile.currentLocation)
      : currentLocation,
    timeZone: preserveExistingValues
      ? (extractedTimeZone ?? input.existingProfile.timeZone)
      : extractedTimeZone,
    salaryCurrency: preserveExistingValues
      ? (extractedSalaryCurrency ??
        input.existingSearchPreferences.salaryCurrency)
      : extractedSalaryCurrency,
    yearsExperience: preserveExistingValues
      ? (extractedYearsExperience ?? input.existingProfile.yearsExperience)
      : extractedYearsExperience,
    email: preserveExistingValues
      ? (extractedEmail ?? input.existingProfile.email)
      : extractedEmail,
    phone: extractedPhone,
    portfolioUrl: preserveExistingValues
      ? (portfolioUrl ?? input.existingProfile.portfolioUrl)
      : portfolioUrl,
    linkedinUrl: preserveExistingValues
      ? (extractedLinkedinUrl ?? input.existingProfile.linkedinUrl)
      : extractedLinkedinUrl,
    githubUrl: preserveExistingValues
      ? (extractedGithubUrl ?? input.existingProfile.githubUrl)
      : extractedGithubUrl,
    personalWebsiteUrl: preserveExistingValues
      ? (personalWebsiteUrl ?? input.existingProfile.personalWebsiteUrl)
      : personalWebsiteUrl,
    professionalSummary: inferProfessionalSummary(
      summary,
      headline,
      skillGroups.highlightedSkills,
    ),
    skillGroups,
    skills,
    targetRoles,
    preferredLocations,
    experiences,
    education,
    certifications,
    links: inferLinks(input.resumeText),
    projects,
    spokenLanguages: inferSpokenLanguages(input.resumeText),
    analysisProviderKind,
    analysisProviderLabel,
    notes,
  });
}
