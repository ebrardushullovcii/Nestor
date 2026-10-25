import type { SourceDebugWorkerAttempt } from "@nestor/contracts";
import { normalizeText, uniqueStrings } from "./shared";
import { lineMentionsAnyKeyword } from "./source-instruction-filtering";

export function warningSuggestsAuthRestriction(
  value: string | null | undefined,
): boolean {
  const normalized = normalizeText(value ?? "");

  return (
    normalized.includes("login required") ||
    normalized.includes("logged in") ||
    normalized.includes("authentication required") ||
    normalized.includes("session is not ready") ||
    normalized.includes("sign in") ||
    normalized.includes("auth restriction") ||
    normalized.includes("not authenticated")
  );
}

/** What the check itself reported, as it reported it. */
export function collectAttemptInstructionGuidance(
  attempt: SourceDebugWorkerAttempt | undefined,
): string[] {
  return uniqueStrings(
    [attempt?.resultSummary ?? "", ...(attempt?.confirmedFacts ?? [])]
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

const sourceDebugSearchControlKeywords = [
  "search",
  "filter",
  "keyword",
  "location",
  "industry",
  "department",
  "category",
  "chip",
  "dropdown",
  "input",
  "sort",
  "pagination",
  "all filters",
  "date posted",
  "experience",
  "company",
  "remote",
  "load more",
  "next page",
  "infinite scroll",
  "lazy load",
  "show all",
  "showall",
  "recommended",
  "recommendation",
  "prefilter",
  "preselected",
] as const;

export function isExplicitSearchProbeDisproof(value: string): boolean {
  const normalized = normalizeText(value);
  const hasNegativeSearchVerdict =
    /(^|\s)no\s+[^.]*\b(proven|confirmed|working|reliable)\b/.test(
      normalized,
    ) ||
    normalized.includes("no search filter control was proven") ||
    normalized.includes("no working search filter controls confirmed") ||
    normalized.includes("no filters confirmed to change result set");

  return (
    (hasNegativeSearchVerdict ||
      normalized.includes("no reliable") ||
      normalized.includes("could not confirm") ||
      normalized.includes("could not prove") ||
      normalized.includes("did not confirm") ||
      normalized.includes("did not prove") ||
      normalized.includes("not proven") ||
      normalized.includes("unproven") ||
      normalized.includes("not confirmed") ||
      normalized.includes("not clearly visible") ||
      normalized.includes("not clearly proven") ||
      normalized.includes("not conclusively proven") ||
      normalized.includes("not identified") ||
      normalized.includes("not tested") ||
      normalized.includes("did not reliably change") ||
      normalized.includes("did not change") ||
      normalized.includes("not reliable") ||
      normalized.includes("decorative")) &&
    lineMentionsAnyKeyword(normalized, sourceDebugSearchControlKeywords)
  );
}
