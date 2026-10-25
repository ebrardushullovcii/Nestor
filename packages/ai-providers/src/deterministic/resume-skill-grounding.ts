import type { CandidateProfile } from "@nestor/contracts";
import { uniqueStrings } from "./utils";

const QUANTIFIED_REQUIREMENT_PATTERN =
  /\b(?:a|an|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|\d+(?:[.,]\d+)?)\s*(?:\+|plus|or\s+more)?\s+(?:years?|yrs?|months?|mos?)\b/iu;

const SKILL_CANONICAL_ALIASES = new Map([
  ["postgres", "postgresql"],
  ["postgresql", "postgresql"],
  ["k8s", "kubernetes"],
  ["kubernetes", "kubernetes"],
]);

function normalizeSkillPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

export function canonicalSkillPhrase(value: string): string {
  const normalized = normalizeSkillPhrase(value);
  return SKILL_CANONICAL_ALIASES.get(normalized) ?? normalized;
}

export function skillsAreEquivalent(left: string, right: string): boolean {
  const canonicalLeft = canonicalSkillPhrase(left);
  const canonicalRight = canonicalSkillPhrase(right);
  return Boolean(
    canonicalLeft && canonicalRight && canonicalLeft === canonicalRight,
  );
}

const SPOKEN_LANGUAGE_CHROME_PATTERN =
  /mother\s*tongues?|^(?:other\s*)?languages?$|^(?:levels?|understanding|speaking|writing|listening|reading)\b|\b(?:a1 and a2|b1 and b2|c1 and c2|basic user|independent user|proficient user|cefr)\b/iu;

const SPOKEN_LANGUAGE_PROFICIENCY_LINE_PATTERN =
  /^[A-Za-z][A-Za-z .'-]{0,40}\s+[—–-]\s+(?:native|mother\s*tongue|fluent|conversational|basic|[ABC][12])\b/iu;

export function isSpokenLanguageResumeChrome(value: string): boolean {
  const normalized = value.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return (
    normalized.length > 0 && SPOKEN_LANGUAGE_CHROME_PATTERN.test(normalized)
  );
}

export function looksLikeSpokenLanguageSkillEntry(value: string): boolean {
  const trimmed = value.trim();
  return (
    isSpokenLanguageResumeChrome(trimmed) ||
    SPOKEN_LANGUAGE_PROFICIENCY_LINE_PATTERN.test(trimmed)
  );
}

function tokenizeSkillPhrase(value: string): string[] {
  return normalizeSkillPhrase(value).split(/\s+/).filter(Boolean);
}

function matchesCandidateSkill(
  candidateSkill: string,
  proposedSkill: string,
): boolean {
  const normalizedCandidate = canonicalSkillPhrase(candidateSkill);
  const normalizedProposed = canonicalSkillPhrase(proposedSkill);

  if (!normalizedCandidate || !normalizedProposed) {
    return false;
  }

  if (normalizedCandidate === normalizedProposed) {
    return true;
  }

  const candidateTokens = tokenizeSkillPhrase(candidateSkill);
  const proposedTokens = tokenizeSkillPhrase(proposedSkill);
  const smallerCount = Math.min(candidateTokens.length, proposedTokens.length);
  const largerCount = Math.max(candidateTokens.length, proposedTokens.length);
  const allowedDelta = smallerCount <= 3 ? 1 : 2;

  if (smallerCount === 0 || largerCount > 5) {
    return false;
  }

  const candidateTokenSet = new Set(candidateTokens);
  const proposedTokenSet = new Set(proposedTokens);
  const sharedCount = [...candidateTokenSet].filter((token) =>
    proposedTokenSet.has(token),
  ).length;

  return (
    sharedCount === smallerCount && largerCount - smallerCount <= allowedDelta
  );
}

export function buildCandidateSkillBank(
  profile: CandidateProfile | null | undefined,
): string[] {
  if (!profile) {
    return [];
  }

  return uniqueStrings([
    ...profile.skills,
    ...profile.skillGroups.coreSkills,
    ...profile.skillGroups.tools,
    ...profile.skillGroups.languagesAndFrameworks,
    ...profile.skillGroups.softSkills,
    ...profile.skillGroups.highlightedSkills,
    ...profile.experiences.flatMap((experience) => experience.skills),
    ...profile.projects.flatMap((project) => project.skills),
  ]);
}

export function filterGroundedVisibleSkills(
  profile: CandidateProfile | null | undefined,
  skills: readonly string[],
  limit = 8,
): string[] {
  const skillBank = buildCandidateSkillBank(profile);

  if (skillBank.length === 0) {
    return [];
  }

  return uniqueStrings([...skills])
    .filter((skill) => !looksLikeSpokenLanguageSkillEntry(skill))
    .filter((skill) =>
      skillBank.some((candidateSkill) =>
        matchesCandidateSkill(candidateSkill, skill),
      ),
    )
    .slice(0, limit);
}

/**
 * A job's quantified experience threshold is useful for fit assessment, but
 * it is not a candidate keyword or candidate evidence. Keep these
 * requirements out of generated text and the hidden keyword editor even when
 * a provider echoes them in its draft.
 */
// Schema enums that leak in as "keywords" ("FULL_TIME", "PART_TIME",
// "ON_SITE"): a resume never echoes them, and a suggestion built on them
// told a candidate to write FULL_TIME into their summary.
const SCHEMA_ENUM_KEYWORD_PATTERN =
  /^(?:[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|(?:full|part)[-\s]?time|contract(?:or)?|temporary|internship|remote|hybrid|on[-\s]?site)$/iu;

export function filterCandidateFacingResumeKeywords(
  keywords: readonly string[],
): string[] {
  return uniqueStrings(keywords).filter(
    (keyword) =>
      !QUANTIFIED_REQUIREMENT_PATTERN.test(keyword) &&
      !SCHEMA_ENUM_KEYWORD_PATTERN.test(keyword.trim()),
  );
}
