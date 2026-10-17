/**
 * Renderer-safe employer/location formatting for discovery and shortlist cards.
 * Absence placeholders stay out of the visible meta line; `/company/{slug}/…`
 * URLs can still recover an employer when the stored company is a placeholder.
 */

import {
  formatEmployerLabelFromSlug,
  sanitizeEmployerLabel,
} from "@nestor/contracts";

const EMPLOYER_ABSENCE_LABEL_PATTERN = /^employer not stated$/i;
const LOCATION_ABSENCE_LABEL_PATTERN = /^location not stated$/i;
const ABSENCE_PLACEHOLDER_IN_TEXT_PATTERN =
  /\b(?:employer|location)\s+not\s+stated\b/gi;

export function isEmployerAbsenceLabel(
  value: string | null | undefined,
): boolean {
  return EMPLOYER_ABSENCE_LABEL_PATTERN.test((value ?? "").trim());
}

export function isLocationAbsenceLabel(
  value: string | null | undefined,
): boolean {
  return LOCATION_ABSENCE_LABEL_PATTERN.test((value ?? "").trim());
}

/**
 * Removes stored absence placeholders from free-text surfaces (fit evidence,
 * reasons, gaps) so they never appear as fake employer/location labels.
 */
export function scrubJobAbsencePlaceholders(value: string): string {
  return value
    .replace(ABSENCE_PLACEHOLDER_IN_TEXT_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:·•])/g, "$1")
    .replace(/^[\s·•\-–—,:;]+|[\s·•\-–—,:;]+$/g, "")
    .trim();
}

export function scrubJobAbsencePlaceholdersList(
  values: readonly string[],
): string[] {
  return values
    .map((value) => scrubJobAbsencePlaceholders(value))
    .filter((value) => value.length > 0);
}

export function inferEmployerFromCanonicalUrl(
  canonicalUrl: string | null | undefined,
): string | null {
  const raw = (canonicalUrl ?? "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).trim())
      .filter(Boolean);
    const companyIndex = segments.findIndex(
      (segment) => segment.toLowerCase() === "company",
    );
    if (companyIndex < 0) {
      return null;
    }

    const slug = segments[companyIndex + 1];
    if (!slug || !/[a-z\p{L}]/iu.test(slug)) {
      return null;
    }

    const rest = segments.slice(companyIndex + 2);
    if (
      rest.length === 0 ||
      (rest.length === 1 && rest[0]?.toLowerCase() === "jobs")
    ) {
      return null;
    }

    return formatEmployerLabelFromSlug(slug);
  } catch {
    return null;
  }
}

export function resolveJobEmployerDisplay(input: {
  company: string | null | undefined;
  canonicalUrl?: string | null | undefined;
}): string | null {
  const company = sanitizeEmployerLabel(input.company);
  if (company) {
    return company;
  }

  return inferEmployerFromCanonicalUrl(input.canonicalUrl) ?? null;
}

export function resolveJobLocationDisplay(
  location: string | null | undefined,
): string | null {
  const value = (location ?? "").trim();
  if (!value || isLocationAbsenceLabel(value)) {
    return null;
  }

  // "Anywhere, Anywhere, United States" arrives when a board repeats a token
  // in city, region and country slots; print each part once.
  const seen = new Set<string>();
  const parts = value
    .split(/\s*,\s*/u)
    .map((part) => part.trim())
    .filter((part) => {
      const key = part.toLowerCase();
      if (!part || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  return parts.length > 0 ? parts.join(", ") : value;
}

export function formatJobEmployerLocationLine(input: {
  company: string | null | undefined;
  location: string | null | undefined;
  canonicalUrl?: string | null;
  separator?: string;
}): string {
  const parts = [
    resolveJobEmployerDisplay(input),
    resolveJobLocationDisplay(input.location),
  ].filter((part): part is string => Boolean(part));

  return parts.join(input.separator ?? " · ");
}

export function inferListingSourceHostLabel(
  canonicalUrl: string | null | undefined,
): string | null {
  const raw = (canonicalUrl ?? "").trim();
  if (!raw) {
    return null;
  }

  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./u, "");
    return host || null;
  } catch {
    return null;
  }
}

/**
 * Applications-facing employer line. Never shows absence placeholders.
 * Prefers a real company or `/company/{slug}/` inference, then
 * `Listing · {source}` when only the listing origin is known.
 */
export function formatApplicationEmployerLine(input: {
  company: string | null | undefined;
  canonicalUrl?: string | null | undefined;
  sourceLabels?: readonly string[];
}): string | null {
  const employer = resolveJobEmployerDisplay(input);
  if (employer) {
    return employer;
  }

  const sourceLabel = (input.sourceLabels ?? [])
    .map((label) => label.trim())
    .find((label) => label.length > 0);
  if (sourceLabel) {
    return `Listing · ${sourceLabel}`;
  }

  const host = inferListingSourceHostLabel(input.canonicalUrl);
  return host ? `Listing · ${host}` : null;
}

export function formatApplicationEmployerAriaLabel(input: {
  title: string;
  company: string | null | undefined;
  canonicalUrl?: string | null | undefined;
  sourceLabels?: readonly string[];
}): string {
  const employer = formatApplicationEmployerLine(input);
  return employer ? `${input.title} at ${employer}` : input.title;
}
