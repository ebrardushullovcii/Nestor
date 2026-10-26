import { preserveTechnologyTokens } from "@nestor/contracts";

const normalized = (text: string) =>
  preserveTechnologyTokens(text)
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const statements = (text: string) =>
  text
    .split(/[;\n]+|[.!?](?:\s+|$)/u)
    .map(normalized)
    .filter(Boolean);

/** Keep complete source statements, including their negations and conditions. */
export function factualSummaryIsSourced(
  answer: string,
  sources: readonly string[],
): boolean {
  const claims = statements(answer);
  const recorded = new Set(sources.flatMap(statements));
  return claims.length > 0 && claims.every((claim) => recorded.has(claim));
}

export function asksForSpecificStory(question: string): boolean {
  return /\b(?:tell (?:us|me) about a time|describe a situation)\b/iu.test(
    question,
  );
}
