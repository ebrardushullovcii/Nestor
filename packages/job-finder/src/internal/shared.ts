import { normalizeText } from "@nestor/job-list-policy/text";
export { normalizeText } from "@nestor/job-list-policy/text";

export function tokenize(value: string): string[] {
  return normalizeText(value).split(/\s+/).filter(Boolean);
}

export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();

  return values.flatMap((value) => {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return [];
    }

    const key = trimmedValue.toLowerCase();

    if (seen.has(key)) {
      return [];
    }

    seen.add(key);
    return [trimmedValue];
  });
}

export function createUniqueId(prefix: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  return `${prefix}_${suffix}`;
}

/**
 * Source-generic absence phrasing.
 *
 * Discovery stores a readable placeholder ("Location not stated", "Employer
 * not listed") when a board exposes no value at all, so by the time the text
 * reaches matching it is never an empty string. Reading that placeholder as a
 * real value produced a fabricated conflict — the app claiming it had compared
 * a location it never saw. Absence must read as unknown, never as evidence,
 * and never as a conflict, on every board.
 */
const absentFieldTextPattern =
  /^(?:[-–—]+|n\/?a|tbd|unknown|none|null|undefined|(?:[\p{L} ]{0,24}?)not\s+(?:stated|listed|specified|provided|disclosed|given|available|mentioned|set|shared|posted|defined))$/iu;

export function isAbsentFieldText(value: string): boolean {
  const normalized = value
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.:;,]+$/u, "");
  if (normalized.length === 0) {
    return true;
  }
  return absentFieldTextPattern.test(normalized);
}
