import type {
  CandidateProfile,
  CandidateReusableAnswer,
} from "@nestor/contracts";

export type AnswerMemoryMatch = {
  candidate: CandidateReusableAnswer | null;
  confidence: "high" | "review" | "none";
  conflictingCandidates: readonly CandidateReusableAnswer[];
  provenance: string;
  priorQuestion: string | null;
  scope: string;
  status: "exact" | "fuzzy" | "no_match" | "conflict" | "stale";
};

function normalizeQuestion(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function questionTokens(value: string): ReadonlySet<string> {
  return new Set(
    normalizeQuestion(value)
      .split(" ")
      .filter((token) => token.length > 2),
  );
}

function similarity(left: string, right: string): number {
  const leftTokens = questionTokens(left);
  const rightTokens = questionTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  );
  const union = new Set([...leftTokens, ...rightTokens]);
  return intersection.length / union.size;
}

function describeScope(answer: CandidateReusableAnswer): string {
  return answer.roleFamilies.length > 0
    ? answer.roleFamilies.join(", ")
    : "All role families";
}

function isStale(
  answer: CandidateReusableAnswer,
  proofEntryIds: ReadonlySet<string>,
): boolean {
  return answer.proofEntryIds.some(
    (proofEntryId) => !proofEntryIds.has(proofEntryId),
  );
}

export function resolveAnswerMemoryMatch(
  profile: CandidateProfile,
  prompt: string,
): AnswerMemoryMatch {
  const normalizedPrompt = normalizeQuestion(prompt);
  const proofEntryIds = new Set(profile.proofBank.map((entry) => entry.id));
  const exact = profile.answerBank.customAnswers.filter((answer) =>
    [answer.question, answer.label].some(
      (value) => normalizeQuestion(value) === normalizedPrompt,
    ),
  );
  const exactTexts = new Set(exact.map((answer) => answer.answer.trim()));

  if (exactTexts.size > 1) {
    return {
      candidate: null,
      confidence: "none",
      conflictingCandidates: exact,
      provenance: "Conflicting answers in Profile",
      priorQuestion: exact[0]?.question ?? null,
      scope: "Review in Profile before reuse",
      status: "conflict",
    };
  }

  const exactCandidate = exact[0] ?? null;
  if (exactCandidate) {
    const stale = isStale(exactCandidate, proofEntryIds);
    return {
      candidate: exactCandidate,
      confidence: stale ? "review" : "high",
      conflictingCandidates: [],
      provenance: "Saved explicitly in Profile",
      priorQuestion: exactCandidate.question,
      scope: describeScope(exactCandidate),
      status: stale ? "stale" : "exact",
    };
  }

  const fuzzy = profile.answerBank.customAnswers
    .map((answer) => ({ answer, score: similarity(prompt, answer.question) }))
    .filter((entry) => entry.score >= 0.55)
    .sort((left, right) => right.score - left.score);
  const fuzzyCandidate = fuzzy[0]?.answer ?? null;
  if (fuzzyCandidate) {
    return {
      candidate: fuzzyCandidate,
      confidence: "review",
      conflictingCandidates: [],
      provenance: "Similar saved question in Profile",
      priorQuestion: fuzzyCandidate.question,
      scope: describeScope(fuzzyCandidate),
      status: isStale(fuzzyCandidate, proofEntryIds) ? "stale" : "fuzzy",
    };
  }

  return {
    candidate: null,
    confidence: "none",
    conflictingCandidates: [],
    provenance: "No saved answer matched",
    priorQuestion: null,
    scope: "Not saved for reuse",
    status: "no_match",
  };
}
