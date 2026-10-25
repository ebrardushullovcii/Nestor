import { normalizeText, uniqueStrings } from "./shared";
export type {
  SourceInstructionFinalReviewPhaseContext,
  SourceInstructionQualityAssessment,
  SourceInstructionReviewOverride,
} from "./source-instruction-types";
export {
  parseSourceInstructionReviewOverride,
  readReviewOverrideStringArray,
} from "./source-instruction-types";

export function formatStatusLabel(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function splitCustomDiscoveryInstructions(value: string | null): string[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizeInstructionLine(value: string): string {
  return scrubBrokenInstructionRouteExamples(value)
    .replace(
      /([?&])(currentJobId|selectedJobId)=[^&#)\s]+(?=(?:[).,;!?\s]|$))/gi,
      (_match, prefix: string) => (prefix === "?" ? "?" : ""),
    )
    .replace(/\?&/g, "?")
    .replace(/&&+/g, "&")
    .replace(/[?&](?=(?:[).,;!?\s]|$))/g, "")
    .replace(
      /^(Reliable control|Filter note|Navigation note|Apply note|Visual evidence|Validated behavior|Validated navigation|Verification):\s*/i,
      "",
    )
    .replace(/\s*\(index\s+\d+\)/gi, "")
    .replace(/\s+at index\s+\d+\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function trimInstructionRouteToken(value: string): string {
  return value.replace(/[.,;:!?]+$/, "");
}

function isBrokenInstructionRouteToken(value: string): boolean {
  const trimmedValue = trimInstructionRouteToken(value);

  if (!trimmedValue) {
    return false;
  }

  try {
    const parsed = trimmedValue.startsWith("/")
      ? new URL(trimmedValue, "https://example.com")
      : new URL(trimmedValue);
    let pathname: string;
    try {
      pathname = decodeURIComponent(parsed.pathname).toLowerCase();
    } catch {
      pathname = parsed.pathname.toLowerCase();
    }
    const routeText = `${pathname}${parsed.search.toLowerCase()}`;

    return (
      /(^|\/)404($|\/)/.test(pathname) ||
      routeText.includes("not-found") ||
      /(^|\/)\{[^/]+\}($|\/)/.test(pathname) ||
      /(^|\/):[a-z0-9_-]+($|\/)/i.test(pathname)
    );
  } catch {
    return false;
  }
}

function scrubBrokenInstructionRouteExamples(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)\]>",]+/gi, (match) =>
      isBrokenInstructionRouteToken(match) ? "that route" : match,
    )
    .replace(/(^|[\s(])(\/[^\s)\]>",]+)/g, (match, prefix: string, route: string) =>
      isBrokenInstructionRouteToken(route) ? `${prefix}that route` : match,
    );
}

export function lineMentionsAnyKeyword(
  value: string,
  keywords: readonly string[],
): boolean {
  const normalized = normalizeText(value);
  return keywords.some((keyword) => normalized.includes(keyword));
}

export function isInternalSourceDebugFailure(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeText(value ?? "");

  return (
    normalized.includes("agent runtime failed") ||
    normalized.includes("llm call failed") ||
    normalized.includes("discovery encountered an error") ||
    normalized.includes("unknown error") ||
    normalized.includes("browser runtime does not support agent discovery") ||
    normalized.includes("ai client does not support tool calling") ||
    normalized.includes("no job extractor configured")
  );
}

export function filterSourceDebugWarnings(
  values: readonly (string | null | undefined)[],
): string[] {
  return uniqueStrings(
    values
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeInstructionLine(value))
      .filter(Boolean)
      .filter((value) => !isInternalSourceDebugFailure(value)),
  );
}

export function prefixedLines(prefix: string, values: readonly string[]): string[] {
  return values.map((value) => `${prefix}${normalizeInstructionLine(value)}`);
}
