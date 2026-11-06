import { dateRangePattern, experienceSectionAliases } from "./constants";
import {
  cleanLine,
  findSectionBodyLinesByAliases,
  isBulletLine,
  normalizeLocationLabel,
  splitInlineBulletLine,
  splitLines,
  stripBulletPrefix,
  uniqueStrings,
} from "./utils";
import { inferSkills } from "./resume-parser-skills";

/**
 * Upper bound for achievements retained per role. Real resumes routinely list
 * eight to ten bullets on the most recent role; truncating at six silently
 * dropped evidence the tailoring step could have used.
 */
const MAX_EXPERIENCE_ACHIEVEMENTS = 10;

const roleTitlePattern =
  /\b(engineer|developer|designer|manager|director|analyst|consultant|specialist|architect|officer|lead|support|administrator|scientist|qa|agent|intern|internship|co-op|coordinator|assistant|clerk|representative|teacher|student|supervisor|associate|technician)\b/i;

type ResumeExperienceWorkMode = "remote" | "hybrid" | "onsite" | "flexible";

const experienceSkillEvidencePatterns: ReadonlyArray<{
  skill: string;
  pattern: RegExp;
}> = [
  {
    skill: "Performance Optimization",
    pattern:
      /\b(?:page[- ]load|load time|bundle(?:s| size)?|core web vitals|render(?:ing)? time|latency)\b/i,
  },
  {
    skill: "Accessibility",
    pattern: /\baccessib(?:le|ility)\b|\baxe\b/i,
  },
];

function inferWorkModesFromText(value: string): ResumeExperienceWorkMode[] {
  const modes: ResumeExperienceWorkMode[] = [];

  if (/\bremote\b/i.test(value)) {
    modes.push("remote");
  }

  if (/\bhybrid\b/i.test(value)) {
    modes.push("hybrid");
  }

  if (/\b(?:on[- ]?site|in[- ]?office)\b/i.test(value)) {
    modes.push("onsite");
  }

  if (/\bflexible\b/i.test(value)) {
    modes.push("flexible");
  }

  return modes;
}

function inferExperienceSkills(
  experienceText: string,
  resumeText: string,
): string[] {
  const directSkills = inferSkills(experienceText, []);
  const declaredResumeSkills = inferSkills(resumeText, []);
  const evidenceBackedDeclaredSkills = experienceSkillEvidencePatterns.flatMap(
    ({ skill, pattern }) =>
      declaredResumeSkills.some(
        (declaredSkill) => declaredSkill.toLowerCase() === skill.toLowerCase(),
      ) && pattern.test(experienceText)
        ? [skill]
        : [],
  );

  return uniqueStrings([...directSkills, ...evidenceBackedDeclaredSkills]);
}

function looksLikeRoleTitle(value: string): boolean {
  const cleaned = cleanLine(
    value.replace(/^[-|,]+\s*/, "").replace(/\([^)]*\)\s*$/g, ""),
  );

  return (
    cleaned.length > 0 &&
    (roleTitlePattern.test(cleaned) || /^.+?\s+at\s+.+$/i.test(cleaned))
  );
}

function parseCompanyAndLocation(segment: string): {
  companyName: string | null;
  location: string | null;
} {
  const cleaned = cleanCompanyName(segment.replace(/\([^)]*\)\s*$/g, ""));

  if (!cleaned) {
    return { companyName: null, location: null };
  }

  const parts = cleaned
    .split(",")
    .map((part) => cleanLine(part))
    .filter(Boolean);
  let parsedLocation: string | null = null;
  let companyName = cleanCompanyName(cleaned);

  for (let index = 1; index < parts.length; index += 1) {
    const candidateSuffix = parts.slice(index).join(", ");
    const candidateLocation = normalizeLocationLabel(candidateSuffix);
    if (!candidateLocation) {
      continue;
    }

    parsedLocation = candidateLocation;
    companyName = cleanCompanyName(parts.slice(0, index).join(", ") || cleaned);
    break;
  }

  return {
    companyName: companyName || null,
    location: parsedLocation,
  };
}

function cleanCompanyName(value: string | null | undefined): string {
  return cleanLine(value ?? "")
    .replace(
      /\s+[–—-]\s*(?:\d{1,2}\/\d{4}|\d{4}(?:-\d{2}(?:-\d{2})?)?)\s*$/i,
      "",
    )
    .replace(/\s+[–—-]\s*(?=\d)/g, " ")
    .replace(/\s+[–—-]\s*$/g, "")
    .trim();
}

function isStandaloneTitle(value: string): boolean {
  const cleaned = cleanLine(
    value.replace(/^[-|,]+\s*/, "").replace(/\([^)]*\)\s*$/g, ""),
  );

  if (!cleaned || !looksLikeRoleTitle(cleaned) || /[.!?;:]$/.test(cleaned)) {
    return false;
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) {
    return false;
  }

  return words.every((word, index) => {
    if (
      index > 0 &&
      index < words.length - 1 &&
      /^[a-z&]{1,3}$/.test(word) &&
      ["of", "and", "for", "&"].includes(word)
    ) {
      return true;
    }

    if (/^[A-Z][A-Za-z0-9&.'()/-]*$/.test(word)) {
      return true;
    }

    return /[A-Z]/.test(word) && word === word.toUpperCase();
  });
}

function looksLikeCompanyHeader(value: string): boolean {
  const cleaned = cleanLine(value);
  if (isLocationOnlyLine(cleaned)) return false;
  const normalized = cleaned
    .replace(/[(),]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|co|company|gmbh|plc)\b\.?/gi, "")
    .trim();
  if (!normalized || /[.!?;:]$/.test(normalized)) {
    return false;
  }

  if (!normalized) {
    return false;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) {
    return false;
  }

  const connectorWords = new Set(["of", "and", "the", "for", "at", "&"]);
  return words.every((word, index) => {
    if (connectorWords.has(word.toLowerCase())) {
      return index > 0;
    }

    return /^[A-Z][A-Za-z0-9&.'()/-]*$/.test(word);
  });
}

export function normalizeHeadlineText(value: string): string {
  const normalized = cleanLine(
    value
      .replace(
        /\s+[–—-]\s+(?:\d{1,2}\/\d{4}|\d{4})\s+[–—-]\s+(?:current|present|\d{1,2}\/\d{4}|\d{4}).*$/i,
        "",
      )
      .replace(/\s+[–—-]\s+current$/i, ""),
  );

  const knownCaseMap: Record<string, string> = {
    react: "React",
    "next.js": "Next.js",
    "node.js": "Node.js",
    node: "Node",
    ".net": ".NET",
    "asp.net": "ASP.NET",
    javascript: "JavaScript",
    typescript: "TypeScript",
    qa: "QA",
    ui: "UI",
    ux: "UX",
  };

  const formatSegment = (segment: string): string => {
    if (segment.includes("-")) {
      return segment
        .split("-")
        .map((part) => formatSegment(part))
        .join("-");
    }

    const match = segment.match(/^([^A-Za-z0-9.]*)((?:[A-Za-z0-9.]+))(.*)$/);

    if (!match) {
      return segment;
    }

    const prefix = match[1] ?? "";
    const core = match[2] ?? "";
    const suffix = match[3] ?? "";
    const lowerCore = core.toLowerCase();
    const formattedCore =
      knownCaseMap[lowerCore] ??
      (lowerCore.length > 0
        ? `${lowerCore[0]?.toUpperCase() ?? ""}${lowerCore.slice(1)}`
        : core);

    return `${prefix}${formattedCore}${suffix}`;
  };

  return normalized
    .split(/\s+/)
    .map((token) => token.split("/").map(formatSegment).join("/"))
    .join(" ");
}

function splitEmbeddedExperienceLine(line: string): string[] {
  const cleaned = cleanLine(
    line
      .replace(/(?<=[A-Za-z%])(?=\.NET\b)/g, " ")
      .replace(/([.!?])(?=\.NET\b)/g, "$1 "),
  );

  if (!cleaned || !dateRangePattern.test(cleaned)) {
    return cleaned ? [cleaned] : [];
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);

  const looksLikeSplitPrefix = (value: string): boolean => {
    const prefix = cleanLine(value.replace(/[.]+$/g, ""));

    return (
      /[.!?]$/.test(value) ||
      isCompanyMarkerLine(prefix) ||
      /^[A-Z][A-Z\s.'-]+,\s*[A-Z][A-Z\s.'-]+\.?$/i.test(value)
    );
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const header = cleanLine(tokens.slice(index).join(" "));

    if (!header || !dateRangePattern.test(header)) {
      continue;
    }

    const parsedHeader = parseExperienceHeader(header, header, null);
    const tokenCount = header.split(/\s+/).length;

    if (!parsedHeader.title || !looksLikeRoleTitle(parsedHeader.title)) {
      continue;
    }

    if (tokenCount < 2 || tokenCount > 18) {
      continue;
    }

    const prefix = cleanLine(tokens.slice(0, index).join(" "));

    if (prefix && !looksLikeSplitPrefix(prefix)) {
      continue;
    }

    if (!prefix || header === cleaned) {
      continue;
    }

    return [prefix, header].filter(Boolean);
  }

  return [cleaned];
}

function normalizeExperienceSectionLines(lines: readonly string[]): string[] {
  return lines
    .flatMap((line) => splitInlineBulletLine(line))
    .flatMap((line) => splitEmbeddedExperienceLine(line));
}

function parseDateRange(line: string) {
  const match = line.match(dateRangePattern);

  if (!match) {
    return { startDate: null, endDate: null, isCurrent: false };
  }

  const startDate = match[1] ?? null;
  const rawEndDate = match[2] ?? null;
  const isCurrent = rawEndDate ? /current|present/i.test(rawEndDate) : false;

  return { startDate, endDate: isCurrent ? null : rawEndDate, isCurrent };
}

function looksLikeInlineLocation(value: string): boolean {
  return /^[A-Z][A-Z\s.'-]+,\s*[A-Z][A-Z\s.'-]+$/i.test(value);
}

function extractLeadingInlineLocation(value: string): {
  location: string | null;
  remainder: string;
} | null {
  const cleaned = cleanLine(value.replace(/\s*[.]+\s*$/g, ""));
  const match = cleaned.match(
    /^([A-Z][A-Z\s.'-]+,\s*[A-Z][A-Z\s.'-]+)\s+(.+)$/i,
  );

  if (!match) {
    return null;
  }

  const location = normalizeLocationLabel(match[1] ?? null);
  const remainder = cleanLine(match[2] ?? "");

  if (!location || !remainder) {
    return null;
  }

  return { location, remainder };
}

function extractTrailingRoleTitle(value: string): {
  title: string;
  prefix: string;
  location: string | null;
} | null {
  const leadingLocation = extractLeadingInlineLocation(value);
  const cleaned = cleanLine(leadingLocation?.remainder ?? value);

  if (!leadingLocation && !hasPollutedTitleSignals(cleaned)) {
    return null;
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  let best: { title: string; prefix: string; location: string | null } | null =
    null;

  for (
    let start = Math.max(0, tokens.length - 8);
    start < tokens.length;
    start += 1
  ) {
    const candidate = cleanLine(tokens.slice(start).join(" "));
    const normalizedCandidate = normalizeHeadlineText(candidate);

    if (!candidate || candidate.length > 72 || /[,:]/.test(candidate)) {
      continue;
    }

    if (!looksLikeRoleTitle(normalizedCandidate)) {
      continue;
    }

    best = {
      title: normalizedCandidate,
      prefix: cleanLine(tokens.slice(0, start).join(" ")),
      location: leadingLocation?.location ?? null,
    };
  }

  return best;
}

function hasPollutedTitleSignals(value: string): boolean {
  const cleaned = cleanLine(value);

  return (
    cleaned.length > 72 ||
    /[,:]/.test(cleaned) ||
    /\d/.test(cleaned) ||
    /%/.test(cleaned) ||
    /\.\./.test(cleaned) ||
    looksLikeInlineLocation(cleaned)
  );
}

function isCompanyMarkerLine(line: string): boolean {
  const cleaned = cleanLine(line.replace(/^[^A-Za-z0-9]+/, ""));
  if (looksLikeRoleTitle(cleaned.split(/\s+[–—-]\s+/)[0] ?? "")) return false;
  return /^[A-Za-z0-9&.'()/-]+(?:\s+[A-Za-z0-9&.'()/-]+)*\s*[–—-]\s*[A-Z][A-Za-z\s.'-]+,\s*[A-Z][A-Za-z\s.'-]+$/.test(
    cleaned,
  );
}

function parseCompanyMarker(line: string) {
  const cleaned = cleanLine(line.replace(/^[^A-Za-z0-9]+/, ""));
  const match = cleaned.match(
    /^([A-Za-z0-9&.'()/-]+(?:\s+[A-Za-z0-9&.'()/-]+)*)\s*[–—-]\s*([A-Z][A-Za-z\s.'-]+,\s*[A-Z][A-Za-z\s.'-]+)$/,
  );

  if (!match) {
    return { companyName: null, location: null };
  }

  return {
    companyName: cleanCompanyName(match[1] ?? "") || null,
    location: normalizeLocationLabel(match[2] ?? null),
  };
}

function parseExperienceHeader(
  line: string,
  dateSourceLine: string,
  companyContext: {
    companyName: string | null;
    location: string | null;
  } | null,
) {
  const dateRange = parseDateRange(dateSourceLine || line);
  const inlineDateMatch = line.match(dateRangePattern);
  const dateSourceMatch = dateSourceLine.match(dateRangePattern);
  const beforeDate = cleanLine(
    inlineDateMatch?.index !== undefined
      ? line.slice(0, inlineDateMatch.index).replace(/[|,()–—-]+\s*$/g, "")
      : line,
  );
  const afterDate = cleanLine(
    inlineDateMatch?.index !== undefined
      ? line
          .slice(inlineDateMatch.index + inlineDateMatch[0].length)
          .replace(/^\s*[|,()–—-]+\s*/g, "")
      : dateSourceMatch?.index !== undefined
        ? dateSourceLine
            .slice(dateSourceMatch.index + dateSourceMatch[0].length)
            .replace(/^\s*[|,()–—-]+\s*/g, "")
        : "",
  );
  const trailingLocationMatch = line.match(
    /[|,–—-]+\s*([A-Z][A-Z\s.'-]+,\s*[A-Z][A-Z\s.'-]+)\s*$/i,
  );
  const inferredLocation =
    (looksLikeInlineLocation(afterDate)
      ? normalizeLocationLabel(afterDate)
      : null) ??
    (/^remote$/i.test(afterDate) ? normalizeLocationLabel(afterDate) : null) ??
    normalizeLocationLabel(trailingLocationMatch?.[1] ?? null) ??
    companyContext?.location ??
    null;
  const workMode = inferWorkModesFromText(
    [line, dateSourceLine, inferredLocation ?? ""].join(" "),
  );
  const beforeParts = beforeDate
    .split(/\s+[–—-]\s+/)
    .map((part) => cleanLine(part))
    .filter(Boolean);

  if (beforeParts.length >= 2) {
    const trailingPart = beforeParts[beforeParts.length - 1] ?? "";
    const precedingPart = beforeParts[beforeParts.length - 2] ?? "";
    const trailingRole = extractTrailingRoleTitle(precedingPart);

    if (
      beforeParts.length >= 3 &&
      trailingRole &&
      !looksLikeRoleTitle(trailingPart)
    ) {
      const companyAndLocation = parseCompanyAndLocation(trailingPart);

      return {
        dateRange,
        workMode,
        companyName:
          companyAndLocation.companyName ?? companyContext?.companyName ?? null,
        location:
          companyAndLocation.location ??
          trailingRole.location ??
          inferredLocation,
        title: trailingRole.title,
      };
    }

    const first = beforeParts[0] ?? "";
    const remainder = cleanLine(beforeParts.slice(1).join(" - ")) || null;
    const companyFirst =
      !looksLikeRoleTitle(first) && looksLikeRoleTitle(remainder ?? "");
    const titleFirst =
      looksLikeRoleTitle(first) && !looksLikeRoleTitle(remainder ?? "");

    if (companyFirst) {
      const companyAndLocation = parseCompanyAndLocation(first);
      const repairedRemainder = extractTrailingRoleTitle(remainder ?? "");

      return {
        dateRange,
        workMode,
        companyName:
          companyAndLocation.companyName ?? companyContext?.companyName ?? null,
        location:
          companyAndLocation.location ??
          repairedRemainder?.location ??
          inferredLocation,
        title:
          repairedRemainder?.title ??
          (remainder ? normalizeHeadlineText(remainder) : null),
      };
    }

    if (titleFirst) {
      const companyAndLocation = parseCompanyAndLocation(remainder ?? "");

      return {
        dateRange,
        workMode,
        companyName:
          companyAndLocation.companyName ?? companyContext?.companyName ?? null,
        location: companyAndLocation.location ?? inferredLocation,
        title: normalizeHeadlineText(first) || null,
      };
    }

    const title = normalizeHeadlineText(beforeParts[0] ?? "") || null;
    const companyName =
      cleanCompanyName(beforeParts.slice(1).join(" - ")) ||
      companyContext?.companyName ||
      null;
    const repairedTitle = extractTrailingRoleTitle(beforeDate);

    return {
      dateRange,
      workMode,
      companyName,
      location: repairedTitle?.location ?? inferredLocation,
      title:
        title && !hasPollutedTitleSignals(title)
          ? title
          : (repairedTitle?.title ?? title),
    };
  }

  const combinedRole = beforeDate.match(
    /^(.+?)\s+at\s+(.+)$|^([^,]+),\s*(.+)$/i,
  );
  if (
    combinedRole &&
    (combinedRole[1] !== undefined ||
      (looksLikeRoleTitle(combinedRole[3] ?? "") &&
        (!companyContext ||
          /\b(?:Inc|LLC|Ltd|GmbH|Corp|Co|University|College|Company|Corporation)\b/i.test(
            combinedRole[4] ?? "",
          ))))
  ) {
    const employer = parseCompanyAndLocation(
      combinedRole[2] ?? combinedRole[4] ?? "",
    );
    return {
      dateRange,
      workMode,
      companyName: employer.companyName,
      location: employer.location ?? inferredLocation,
      title: normalizeHeadlineText(combinedRole[1] ?? combinedRole[3] ?? ""),
    };
  }
  if (companyContext) {
    const repairedTitle = extractTrailingRoleTitle(beforeDate);

    return {
      dateRange,
      workMode,
      companyName: companyContext.companyName,
      location: repairedTitle?.location ?? companyContext.location,
      title:
        repairedTitle?.title ??
        (beforeDate ? normalizeHeadlineText(beforeDate) : null),
    };
  }

  const repairedTitle = extractTrailingRoleTitle(beforeDate);

  return {
    dateRange,
    workMode,
    companyName: null,
    location: repairedTitle?.location ?? inferredLocation,
    title:
      repairedTitle?.title ??
      (beforeDate ? normalizeHeadlineText(beforeDate) : null),
  };
}

function mergeWrappedDetailLines(lines: readonly string[]): string[] {
  const merged: string[] = [];

  for (const line of lines) {
    const cleaned = cleanLine(stripBulletPrefix(line));

    if (!cleaned) {
      continue;
    }

    const isBullet = isBulletLine(line);

    if (isBullet || merged.length === 0) {
      merged.push(cleaned);
      continue;
    }

    merged[merged.length - 1] = cleanLine(
      `${merged[merged.length - 1]} ${cleaned}`,
    );
  }

  return merged;
}

function looksLikeStandaloneLocationHeader(value: string): boolean {
  const cleaned = cleanLine(value.replace(/^[-|,]+\s*/, ""));

  return (
    /^(?:remote|hybrid|onsite|on-site)$/i.test(cleaned) ||
    looksLikeInlineLocation(cleaned)
  );
}

function findExperienceHeaderStart(
  lines: readonly string[],
  dateLineIndex: number,
): number {
  const dateLine = cleanLine(lines[dateLineIndex] ?? "");
  const dateMatch = dateLine.match(dateRangePattern);
  const inlinePrefix = cleanLine(
    dateMatch?.index === undefined ? "" : dateLine.slice(0, dateMatch.index),
  ).replace(/[|,()–—-]+\s*$/g, "");

  if (inlinePrefix) {
    const previous = cleanLine(lines[dateLineIndex - 1] ?? "");
    return isCompanyMarkerLine(previous) ? dateLineIndex - 1 : dateLineIndex;
  }

  const previous = cleanLine(lines[dateLineIndex - 1] ?? "");
  const twoBack = cleanLine(lines[dateLineIndex - 2] ?? "");
  const threeBack = cleanLine(lines[dateLineIndex - 3] ?? "");

  // A short role line followed by an employer and its city is a dated
  // record even when the occupation is outside the parser's vocabulary.
  if (
    previous.split(",").length >= 3 &&
    twoBack &&
    twoBack.length <= 80 &&
    !isBulletLine(twoBack) &&
    !dateRangePattern.test(twoBack) &&
    !isLocationOnlyLine(twoBack) &&
    !/[.!?;:]$/.test(twoBack)
  )
    return dateLineIndex - 2;

  if (
    looksLikeStandaloneLocationHeader(previous) &&
    ((looksLikeRoleTitle(twoBack) && looksLikeCompanyHeader(threeBack)) ||
      (looksLikeCompanyHeader(twoBack) && looksLikeRoleTitle(threeBack)))
  ) {
    return dateLineIndex - 3;
  }

  if (
    looksLikeRoleTitle(previous) &&
    (isCompanyMarkerLine(twoBack) || looksLikeCompanyHeader(twoBack))
  ) {
    return dateLineIndex - 2;
  }

  if (looksLikeCompanyHeader(previous) && looksLikeRoleTitle(twoBack)) {
    return dateLineIndex - 2;
  }

  if (
    previous &&
    (looksLikeRoleTitle(previous) ||
      isCompanyMarkerLine(previous) ||
      /\s+[–—-]\s+/.test(previous))
  ) {
    return dateLineIndex - 1;
  }

  return dateLineIndex;
}

function splitExperienceBlocks(lines: readonly string[]): string[][] {
  const dateLineIndexes = lines.flatMap((line, index) =>
    dateRangePattern.test(line) ? [index] : [],
  );
  const headerStarts = dateLineIndexes.map((dateLineIndex) =>
    Math.max(0, findExperienceHeaderStart(lines, dateLineIndex)),
  );

  return dateLineIndexes.map((dateLineIndex, index) => {
    const startIndex = headerStarts[index] ?? dateLineIndex;
    const endIndex = headerStarts[index + 1] ?? lines.length;
    return lines.slice(startIndex, endIndex);
  });
}

function parseStackedExperienceHeader(
  headerLines: readonly string[],
  dateLine: string,
) {
  const normalizedHeaderLines = headerLines.map(cleanLine).filter(Boolean);
  if (
    normalizedHeaderLines.length === 2 &&
    (normalizedHeaderLines[1]?.split(",").length ?? 0) >= 3
  ) {
    const employer = parseCompanyAndLocation(normalizedHeaderLines[1] ?? "");
    if (employer.companyName && employer.location)
      return parseExperienceHeader(
        normalizedHeaderLines[0] ?? "",
        dateLine,
        employer,
      );
  }
  const trailingLocation = looksLikeStandaloneLocationHeader(
    normalizedHeaderLines.at(-1) ?? "",
  )
    ? normalizeLocationLabel(normalizedHeaderLines.at(-1) ?? null)
    : null;
  const identityLines = trailingLocation
    ? normalizedHeaderLines.slice(0, -1)
    : normalizedHeaderLines;

  if (identityLines.length < 2) {
    return null;
  }

  let roleIndex = identityLines.findIndex(isStandaloneTitle);
  if (roleIndex === -1) {
    roleIndex = identityLines.findIndex(looksLikeRoleTitle);
  }

  if (roleIndex === -1) {
    return null;
  }

  const companyIndex = identityLines.findIndex(
    (line, index) =>
      index !== roleIndex &&
      (isCompanyMarkerLine(line) || looksLikeCompanyHeader(line)),
  );

  if (companyIndex === -1) {
    return null;
  }

  const companyLine = identityLines[companyIndex] ?? "";
  const companyContext = isCompanyMarkerLine(companyLine)
    ? parseCompanyMarker(companyLine)
    : {
        companyName: cleanCompanyName(companyLine) || null,
        location: trailingLocation,
      };

  return parseExperienceHeader(identityLines[roleIndex] ?? dateLine, dateLine, {
    companyName: companyContext.companyName,
    location: trailingLocation ?? companyContext.location,
  });
}

// "Lisbon, Portugal", "Remote", "Berlin, Germany · Hybrid": a line that names
// only a place. Under a role's dates it is the role's location, never its
// summary; as a summary it reached the tailored resume as "Lisbon, Portugal".
const LOCATION_ONLY_LINE_PATTERN =
  /^(?:(?:remote|hybrid|on-?site)|[\p{L}][\p{L}\s.'’-]{1,30}(?:,\s*[\p{L}][\p{L}\s.'’-]{1,30}){1,2}(?:\s*(?:[·|/•-]|\(|,)\s*(?:remote|hybrid|on-?site)\)?)?)$/iu;

export function isLocationOnlyLine(line: string): boolean {
  const trimmed = stripBulletPrefix(cleanLine(line));
  return (
    trimmed.length > 0 &&
    trimmed.length <= 80 &&
    !roleTitlePattern.test(trimmed) &&
    trimmed.split(/\s+/u).length <= 6 &&
    LOCATION_ONLY_LINE_PATTERN.test(trimmed)
  );
}

function inferUndatedExperienceEntries(
  lines: readonly string[],
  resumeText: string,
) {
  const entries: Array<{
    companyName: string | null;
    companyUrl: null;
    title: string | null;
    employmentType: null;
    location: string | null;
    workMode: ResumeExperienceWorkMode[];
    startDate: null;
    endDate: null;
    isCurrent: false;
    summary: string | null;
    achievements: string[];
    skills: string[];
    domainTags: string[];
    peopleManagementScope: null;
    ownershipScope: null;
  }> = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const companyLine = cleanLine(lines[index] ?? "");
    const titleLine = cleanLine(lines[index + 1] ?? "");

    if (!companyLine || !titleLine) {
      continue;
    }

    if (
      isLocationOnlyLine(companyLine) ||
      isBulletLine(companyLine) ||
      isBulletLine(titleLine) ||
      looksLikeRoleTitle(companyLine) ||
      !looksLikeRoleTitle(titleLine)
    ) {
      continue;
    }

    const detailLines: string[] = [];
    let detailIndex = index + 2;

    while (detailIndex < lines.length) {
      const detailLine = cleanLine(lines[detailIndex] ?? "");

      if (
        !detailLine ||
        (isStandaloneTitle(detailLine) && detailLines.length > 0)
      ) {
        break;
      }

      if (
        looksLikeCompanyHeader(detailLine) &&
        looksLikeRoleTitle(cleanLine(lines[detailIndex + 1] ?? ""))
      ) {
        break;
      }

      detailLines.push(detailLine);
      detailIndex += 1;
    }

    entries.push({
      companyName: companyLine,
      companyUrl: null,
      title: normalizeHeadlineText(titleLine) || null,
      employmentType: null,
      location: null,
      workMode: inferWorkModesFromText(
        [companyLine, titleLine, ...detailLines].join("\n"),
      ),
      startDate: null,
      endDate: null,
      isCurrent: false,
      summary:
        detailLines[0] !== undefined && !isLocationOnlyLine(detailLines[0])
          ? detailLines[0]
          : null,
      achievements: uniqueStrings(
        detailLines
          .slice(1)
          .filter((line) => line.length >= 24)
          .slice(0, MAX_EXPERIENCE_ACHIEVEMENTS),
      ),
      skills: inferExperienceSkills(
        [companyLine, titleLine, ...detailLines].join("\n"),
        resumeText,
      ),
      domainTags: [],
      peopleManagementScope: null,
      ownershipScope: null,
    });

    index = Math.max(index, detailIndex - 1);
  }

  return entries;
}

export function inferExperienceEntries(resumeText: string) {
  const sectionLines = normalizeExperienceSectionLines(
    findSectionBodyLinesByAliases(
      splitLines(resumeText),
      experienceSectionAliases,
    ),
  );
  let previousCompanyContext: {
    companyName: string | null;
    location: string | null;
  } | null = null;
  const datedEntries = splitExperienceBlocks(sectionLines)
    .map((block) => {
      const companyContext = isCompanyMarkerLine(block[0] ?? "")
        ? parseCompanyMarker(block[0] ?? "")
        : null;
      const normalizedBlock = block
        .map((line) => cleanLine(line))
        .filter(Boolean);
      const dateLineIndex = normalizedBlock.findIndex((line) =>
        dateRangePattern.test(line),
      );
      const dateLine =
        dateLineIndex === -1
          ? companyContext
            ? (normalizedBlock[1] ?? "")
            : (normalizedBlock[0] ?? "")
          : (normalizedBlock[dateLineIndex] ?? "");
      const headerContextLines = normalizedBlock.slice(
        0,
        dateLineIndex === -1 ? 1 : dateLineIndex,
      );
      const nonMarkerHeaderLine =
        [...headerContextLines]
          .reverse()
          .find((line) => !isCompanyMarkerLine(line)) ?? null;
      const headerLine = companyContext
        ? (nonMarkerHeaderLine ?? dateLine)
        : cleanLine(headerContextLines.join(" - ")) ||
          (normalizedBlock[0] ?? "");
      const parsedHeader =
        parseStackedExperienceHeader(headerContextLines, dateLine) ??
        parseExperienceHeader(headerLine, dateLine, companyContext);
      const header = {
        ...parsedHeader,
        companyName:
          parsedHeader.companyName ??
          previousCompanyContext?.companyName ??
          null,
        location:
          parsedHeader.location ??
          (!parsedHeader.companyName
            ? previousCompanyContext?.location
            : null) ??
          null,
      };
      if (header.companyName) {
        previousCompanyContext = {
          companyName: header.companyName,
          location: header.location,
        };
      }
      const rawDetailLines = block
        .slice(
          Math.max(
            companyContext ? 2 : 1,
            dateLineIndex === -1 ? (companyContext ? 2 : 1) : dateLineIndex + 1,
          ),
        )
        .filter((line) => line.length > 0 && !isCompanyMarkerLine(line));
      const detailLines = mergeWrappedDetailLines(rawDetailLines);
      const firstDetailIsBullet = isBulletLine(rawDetailLines[0] ?? "");
      const firstDetail = detailLines[0] ?? null;
      const firstDetailIsLocation =
        firstDetail !== null &&
        !firstDetailIsBullet &&
        isLocationOnlyLine(firstDetail);
      const summaryLine =
        !firstDetailIsBullet && !firstDetailIsLocation ? firstDetail : null;
      const achievementLines =
        summaryLine || firstDetailIsLocation
          ? detailLines.slice(1)
          : detailLines;

      return {
        companyName: cleanCompanyName(header.companyName) || null,
        companyUrl: null,
        title: header.title,
        employmentType: null,
        location:
          header.location ??
          (firstDetailIsLocation ? normalizeLocationLabel(firstDetail) : null),
        workMode: header.workMode,
        startDate: header.dateRange.startDate,
        endDate: header.dateRange.endDate,
        isCurrent: header.dateRange.isCurrent,
        summary: summaryLine,
        achievements: uniqueStrings(
          achievementLines
            .filter((line) => line.length >= 24)
            .slice(0, MAX_EXPERIENCE_ACHIEVEMENTS),
        ),
        skills: inferExperienceSkills(block.join("\n"), resumeText),
        domainTags: [],
        peopleManagementScope: null,
        ownershipScope: null,
      };
    })
    .filter(
      (entry) =>
        (entry.title || entry.companyName || entry.summary) &&
        !isLocationOnlyLine(entry.title ?? ""),
    );

  if (datedEntries.length > 0) {
    return datedEntries;
  }

  return inferUndatedExperienceEntries(sectionLines, resumeText).filter(
    (entry) => entry.title || entry.companyName || entry.summary,
  );
}
