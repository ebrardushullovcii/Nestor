import type { CandidateProfile, JobPosting } from "@nestor/contracts";
import { buildCandidateSkillBank } from "./deterministic/resume-skill-grounding";

export type ResumeSkillContextJob = {
  [Field in
    | "location"
    | "summary"
    | "description"
    | "responsibilities"
    | "minimumQualifications"
    | "preferredQualifications"]?: Readonly<JobPosting[Field]> | null;
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  return Boolean(phrase && ` ${text} `.includes(` ${phrase} `));
}

// These are field/clause markers, not a vocabulary of permitted competencies.
const CONTEXT_CLAUSE_PATTERN =
  /\b(?:authori[sz]ed to work|work authori[sz]ation|work eligibility|eligible to work|right to work|visa sponsorship|citizenship|citizens? of|based in|located in|resid(?:e|ing|ent) in|location\s*:)[^;.!?\n]*/giu;
const NEXT_SKILL_CLAUSE_PATTERN =
  /(?:,\s*|\s+(?:and|but)\s+)(?=(?:experience|proficien(?:t|cy)|familiar(?:ity)?|knowledge|expertise|skills?|must (?:know|have))\b)/iu;

/**
 * Ignore places and eligibility when deciding whether a generated entry is a
 * competency. A homograph can still be a skill when independently supported
 * outside that context (for example Go in a technical requirement).
 */
export function buildResumeSkillContextFilter(
  job: ResumeSkillContextJob,
  profile?: CandidateProfile | null,
): (skill: string) => boolean {
  const prose = [
    job.summary ?? "",
    job.description ?? "",
    ...(job.responsibilities ?? []),
    ...(job.minimumQualifications ?? []),
    ...(job.preferredQualifications ?? []),
    profile?.summary ?? "",
    ...(profile?.experiences.flatMap((entry) => [
      entry.summary ?? "",
      ...entry.achievements,
    ]) ?? []),
    ...(profile?.projects.flatMap((entry) => [
      entry.summary ?? "",
      entry.outcome ?? "",
    ]) ?? []),
  ].join("\n");
  const contexts = [
    job.location,
    profile?.currentLocation,
    profile?.currentCity,
    profile?.currentRegion,
    profile?.currentCountry,
    ...(profile?.locations ?? []),
    ...(profile?.experiences.map((entry) => entry.location) ?? []),
    ...(profile?.education.map((entry) => entry.location) ?? []),
    ...(profile?.workEligibility.authorizedWorkCountries ?? []),
    ...(profile?.workEligibility.preferredRelocationRegions ?? []),
    profile?.answerBank.workAuthorization,
    profile?.answerBank.visaSponsorship,
    ...Array.from(
      prose.matchAll(CONTEXT_CLAUSE_PATTERN),
      (match) => match[0].split(NEXT_SKILL_CLAUSE_PATTERN)[0],
    ),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(/[,;|]+/u))
    .map(normalize);
  // The country may also be repeated in listing headers without the eligibility
  // marker. Remove the place itself as well as the marked clause before looking
  // for independent competency evidence.
  for (const context of [...contexts]) {
    const place = context
      .match(
        /\b(?:work in|citizens? of|based in|located in|resid(?:e|ing|ent) in|location) (?:the )?(.+)/u,
      )?.[1]
      ?.split(/\b(?:with|without|requiring)\b/u)[0]
      ?.trim();
    if (place) contexts.push(place);
  }
  const proseWithoutMarkedContext = prose.replace(
    CONTEXT_CLAUSE_PATTERN,
    (clause) => {
      const context = clause.split(NEXT_SKILL_CLAUSE_PATTERN)[0] ?? clause;
      return clause.slice(context.length);
    },
  );
  const explicitSkillText = Array.from(
    proseWithoutMarkedContext.matchAll(
      /\b(?:experience (?:with|in|using)|proficien(?:t|cy) (?:in|with)|knowledge of|expertise (?:in|with))\s+([^;.!?\n]+)/giu,
    ),
    (match) => normalize(match[1] ?? ""),
  ).join(" ");
  let competencyText = normalize(prose);
  for (const context of [...contexts].sort((a, b) => b.length - a.length)) {
    competencyText = ` ${competencyText} `
      .split(` ${context} `)
      .join(" ")
      .trim();
  }
  competencyText = normalize(competencyText);
  const savedSkills = buildCandidateSkillBank(profile).map(normalize);
  return (skill) => {
    const candidate = normalize(skill);
    return (
      !contexts.some((context) => containsPhrase(context, candidate)) ||
      containsPhrase(competencyText, candidate) ||
      containsPhrase(explicitSkillText, candidate) ||
      savedSkills.includes(candidate)
    );
  };
}
