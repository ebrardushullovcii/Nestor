import {
  experienceSectionHeadingPattern,
  knownPersonalWebsitePlatformDomains,
  likelyPersonalWebsitePaths,
  nonExperienceSectionHeadingPattern,
  resumeSectionHeadings,
} from "./constants";

export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const normalized = value.trim();

    if (!normalized) {
      return [];
    }

    const key = normalized.toLowerCase();

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [normalized];
  });
}

export function cleanLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map(cleanLine).filter(Boolean);
}

/**
 * Bullet glyphs commonly emitted by PDF/DOCX text extraction. The plain dash
 * variants (`–`, `—`) only count when a space follows them so a wrapped date
 * range such as "– Current" is not mistaken for a list marker.
 */
const strongBulletGlyphClass = "[•●▪◦‣■□➢➤►]";
const bulletPrefixPattern = new RegExp(
  `^(?:${strongBulletGlyphClass}|[*-]|[–—](?=\\s))\\s*`,
);
const inlineBulletSplitPattern = new RegExp(
  `\\s+(?=${strongBulletGlyphClass}\\s)`,
);

export function isBulletLine(value: string): boolean {
  return bulletPrefixPattern.test(value.trimStart());
}

export function stripBulletPrefix(value: string): string {
  return value.trimStart().replace(bulletPrefixPattern, "");
}

/**
 * Splits a line that carries several bullet items inline ("… pace. ● Built
 * …") into one line per item. A mid-line glyph only starts a new item when
 * the preceding text ends a sentence or the following item is long enough to
 * read as prose, so contact rows and "Title • Company • Dates" headers that
 * use the glyph as a separator stay intact.
 */
export function splitInlineBulletLine(value: string): string[] {
  const cleaned = cleanLine(value);

  if (!cleaned) {
    return [];
  }

  const segments = cleaned.split(inlineBulletSplitPattern);

  if (segments.length === 1) {
    return [cleaned];
  }

  const result: string[] = [];

  for (const segment of segments) {
    const previous = result[result.length - 1];
    const wordCount = stripBulletPrefix(segment)
      .split(/\s+/)
      .filter(Boolean).length;

    if (previous === undefined || /[.;!?)]$/.test(previous) || wordCount >= 5) {
      result.push(segment);
      continue;
    }

    result[result.length - 1] = cleanLine(`${previous} ${segment}`);
  }

  return result;
}

export function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function extractRegexMatch(
  value: string,
  expression: RegExp,
): string | null {
  const match = value.match(expression);
  return cleanLine(match?.[0] ?? "") || null;
}

export function extractFirstUrl(
  value: string,
  expression: RegExp,
): string | null {
  const match = value.match(expression);
  return match?.[0] ?? null;
}

export function normalizeResumeSectionHeading(line: string): string {
  return cleanLine(line)
    .replace(/[:\-–—]+$/g, "")
    .trim()
    .toUpperCase();
}

export function isResumeSectionHeading(line: string): boolean {
  const normalized = normalizeResumeSectionHeading(line);

  return (
    resumeSectionHeadings.has(normalized) ||
    experienceSectionHeadingPattern.test(line.trim()) ||
    nonExperienceSectionHeadingPattern.test(line.trim())
  );
}

export function findSectionBodyLines(
  lines: readonly string[],
  heading: string,
): string[] {
  const normalizedHeading = normalizeResumeSectionHeading(heading);
  const startIndex = lines.findIndex(
    (line) => normalizeResumeSectionHeading(line) === normalizedHeading,
  );

  if (startIndex === -1) {
    return [];
  }

  const body: string[] = [];

  for (const line of lines.slice(startIndex + 1)) {
    if (isResumeSectionHeading(line)) {
      break;
    }

    body.push(line);
  }

  return body;
}

export function findSectionBodyLinesByAliases(
  lines: readonly string[],
  aliases: readonly string[],
): string[] {
  for (const alias of aliases) {
    const body = findSectionBodyLines(lines, alias);

    if (body.length > 0) {
      return body;
    }
  }

  return [];
}

export function titleCaseWords(value: string): string {
  return cleanLine(
    value
      .toLowerCase()
      .replace(/\b[a-z]/g, (character) => character.toUpperCase()),
  );
}

function titleCaseLocationToken(value: string): string {
  const leading = value.match(/^[^A-Za-z0-9]*/)?.[0] ?? "";
  const trailing = value.match(/[^A-Za-z0-9]*$/)?.[0] ?? "";
  const core = value.slice(leading.length, value.length - trailing.length);

  if (!core) {
    return value;
  }

  if (/^\d{5}(?:-\d{4})?$/.test(core)) {
    return `${leading}${core}${trailing}`;
  }

  if (/^[A-Z]{2,4}$/.test(core) || /^[A-Z](?:\.[A-Z])+\.?$/.test(core)) {
    return `${leading}${core.toUpperCase()}${trailing}`;
  }

  return `${leading}${titleCaseWords(core)}${trailing}`;
}

export function normalizeLocationLabel(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const cleaned = cleanLine(value);

  if (!cleaned) {
    return null;
  }

  return cleaned.split(/\s+/).map(titleCaseLocationToken).join(" ");
}

export function extractAllUrls(resumeText: string): string[] {
  const lines = splitLines(resumeText);
  const sectionStart = lines.findIndex(isResumeSectionHeading);
  const header = (
    sectionStart < 0 ? lines.slice(0, 12) : lines.slice(0, sectionStart)
  ).join("\n");
  // Bare domains are common contact values. Restrict them to the header so
  // software names such as Node.js in a skills section cannot become links.
  const bareUrls = header.split(/[\n|·•;]/).flatMap((part) => {
    const value = part
      .trim()
      .replace(/^(?:website|portfolio|linkedin|github)\s*:\s*/i, "")
      .replace(/[),.;]+$/, "");
    return /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>)]*)?$/i.test(value)
      ? [value]
      : [];
  });
  return uniqueStrings(
    [
      ...(resumeText.match(/https?:\/\/[^\s<>]+/gi) ?? []),
      ...bareUrls.map((url) => `https://${url}`),
    ].map((url) => url.replace(/[),.;]+$/, "")),
  );
}

export function isKnownPlatformDomain(hostname: string): boolean {
  return knownPersonalWebsitePlatformDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

export function hasLikelyPersonalWebsitePath(url: URL): boolean {
  if (url.search || url.hash) {
    return false;
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  return likelyPersonalWebsitePaths.has(normalizedPath.toLowerCase());
}

export function isLikelyPersonalWebsiteUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();

    if (isKnownPlatformDomain(hostname)) {
      return false;
    }

    return hasLikelyPersonalWebsitePath(parsedUrl);
  } catch {
    return false;
  }
}

export function buildGenericCanonicalUrl(
  url: string,
  baseUrl?: string,
): string {
  const trimmedUrl = url.trim();

  if (!trimmedUrl) {
    return "";
  }

  try {
    const parsedUrl = new URL(trimmedUrl, baseUrl);

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return "";
    }

    for (const key of [...parsedUrl.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) {
        parsedUrl.searchParams.delete(key);
      }
    }

    parsedUrl.hash = "";
    return parsedUrl.toString();
  } catch {
    return "";
  }
}

export function buildGenericJobId(url: string): string {
  const canonicalUrl = buildGenericCanonicalUrl(url);

  try {
    const parsedUrl = new URL(canonicalUrl);
    const interestingParamKeys = [
      "id",
      "job",
      "jobid",
      "job_id",
      "gh_jid",
      "req",
      "reqid",
      "opening",
    ];
    const interestingParams = interestingParamKeys
      .map((key) => parsedUrl.searchParams.get(key))
      .filter((value): value is string => Boolean(value?.trim()))
      .join("_");
    const rawValue = [parsedUrl.hostname, parsedUrl.pathname, interestingParams]
      .filter(Boolean)
      .join("_");

    return rawValue
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 160);
  } catch {
    return canonicalUrl
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 160);
  }
}

export function describeInvalidFieldCounts(
  fieldCounts: Map<string, number>,
): string {
  const rankedFields = [...fieldCounts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 5);

  return rankedFields.length > 0
    ? rankedFields.map(([field, count]) => `${field}(${count})`).join(", ")
    : "unknown_validation_failure";
}

export function buildInvalidJobSample(candidate: {
  canonicalUrl: string;
  title: string;
  company: string;
  location: string;
  summary: string | null;
  description: string;
}): string {
  return JSON.stringify({
    url: candidate.canonicalUrl,
    title: candidate.title,
    company: candidate.company,
    location: candidate.location,
    summaryLength: candidate.summary?.length ?? 0,
    descriptionLength: candidate.description.length,
  });
}
