/**
 * Presentation of the three raw listing facts a job detail prints side by side.
 *
 * Boards hand these over exactly as their markup spelled them: an employment
 * type arrives as a machine value ("FULL_TIME"), a flattened card repeats the
 * same place in every slot it had ("Anywhere, Anywhere, Anywhere"), and the
 * same work mode can be captured twice ("remote, remote"). Nothing is dropped
 * here — only spelled in plain words and said once.
 */

const EMPLOYMENT_TYPE_LABELS: ReadonlyMap<string, string> = new Map([
  ["full time", "Full-time"],
  ["part time", "Part-time"],
  ["contract", "Contract"],
  ["contractor", "Contract"],
  ["contract to hire", "Contract to hire"],
  ["temporary", "Temporary"],
  ["temp", "Temporary"],
  ["permanent", "Permanent"],
  ["internship", "Internship"],
  ["intern", "Internship"],
  ["apprenticeship", "Apprenticeship"],
  ["freelance", "Freelance"],
  ["seasonal", "Seasonal"],
  ["volunteer", "Volunteer"],
  ["per diem", "Per diem"],
]);

const WORK_MODE_LABELS: ReadonlyMap<string, string> = new Map([
  ["remote", "Remote"],
  ["hybrid", "Hybrid"],
  ["onsite", "On-site"],
  ["on site", "On-site"],
  ["in person", "In person"],
]);

/** Machine spelling reduced to plain lowercase words: "FULL_TIME" -> "full time". */
function toComparableWords(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function toSentenceWords(value: string): string {
  const words = value
    .split(" ")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`);
  return words.join(" ");
}

/**
 * The employment type as a person would say it. An unknown value still reads
 * as words rather than as the machine spelling the board used.
 */
export function formatEmploymentTypeLabel(
  value: string | null | undefined,
): string | null {
  const comparable = toComparableWords(value ?? "");
  if (!comparable) {
    return null;
  }
  return EMPLOYMENT_TYPE_LABELS.get(comparable) ?? toSentenceWords(comparable);
}

/**
 * Says each part once, in the order it first appeared and in its first
 * spelling. "Anywhere, Anywhere, Anywhere" is one place, not three.
 */
export function collapseRepeatedListingParts(
  value: string | null | undefined,
): string | null {
  const parts = (value ?? "")
    .split(/\s*[,•·|]\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const key = toComparableWords(part);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(part);
  }
  return kept.length > 0 ? kept.join(", ") : null;
}

/**
 * The distinct places one stored location value names, in the order they
 * appear.
 *
 * A comma between a settlement and its region is part of one place name, so
 * splitting on every comma turned "Chicago, IL" into two locations: a chip
 * read "2 locations" above a panel listing "Chicago · IL". Only an explicit
 * list separator — a slash, a pipe, a semicolon, a bullet, or the word "or" —
 * starts a second place.
 */
export function splitListingLocationValues(
  value: string | null | undefined,
): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of (value ?? "").split(/\s*(?:[;/|•·]|\bor\b)\s*/iu)) {
    const place = part.replace(/\s+/gu, " ").trim().replace(/[,;]+$/u, "");
    const key = toComparableWords(place);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(place);
  }
  return kept;
}

/** How many places a stored location value actually names. */
export function countListingLocations(
  value: string | null | undefined,
): number {
  return splitListingLocationValues(value).length;
}

/** Work modes in plain words, each said once. */
export function formatWorkModeLabel(
  modes: readonly string[] | null | undefined,
): string | null {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const mode of modes ?? []) {
    const key = toComparableWords(mode);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(WORK_MODE_LABELS.get(key) ?? toSentenceWords(key));
  }
  return kept.length > 0 ? kept.join(", ") : null;
}
