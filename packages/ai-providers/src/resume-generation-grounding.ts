import { z } from "zod";
import { buildResumeSkillContextFilter } from "./resume-skill-context";

import { canonicalSkillPhrase } from "./deterministic/resume-skill-grounding";
import type { CreateResumeDraftInput, TailorResumeInput } from "./shared";

const EvidenceReferenceSchema = z.string().trim().min(1).max(300);
const EvidenceReferenceListSchema = z
  .array(EvidenceReferenceSchema)
  .min(1)
  .max(8);
const EvidenceLinkedTextSchema = z.object({
  text: z.string().trim().min(1).max(1_000),
  evidenceRefs: EvidenceReferenceListSchema,
  inferred: z.boolean().optional(),
  sourceAchievementIds: z.array(EvidenceReferenceSchema).optional(),
});

export type ResumeGenerationInput = CreateResumeDraftInput | TailorResumeInput;

export type ResumeGenerationEvidenceScope =
  | "profile"
  | "experience"
  | "project"
  | "proof"
  | "import_evidence";

export interface ResumeGenerationEvidenceItem {
  id: string;
  text: string;
  scope: ResumeGenerationEvidenceScope;
  profileRecordId: string | null;
}

export interface ParsedEvidenceLinkedText {
  text: string;
  evidenceRefs: string[];
  inferred: boolean;
  sourceAchievementIds: string[];
}

// Both sets are consulted with normalized tokens, so their entries are
// normalized the same way; a literal "predictable" would otherwise never meet
// the stem the text produces.

function normalizeNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

// Years-of-experience figures the aggressive relaxation may round up by at
// most one: a bare number ("4", "3+") directly followed by "year"/"years".
// Every other number keeps requiring verbatim evidence in every mode.

// A metric may only count as a rounded-up years figure when it is a pure
// integer (never "15%", "$4", or "4k"), the claim itself states it as years
// of experience, the cited evidence carries exactly one year less, and the
// target listing states the rounded figure as its own years requirement.

function pushEvidenceItem(
  items: ResumeGenerationEvidenceItem[],
  seenIds: Set<string>,
  item: Omit<ResumeGenerationEvidenceItem, "text"> & { text: unknown },
): void {
  const text = normalizeNullableText(item.text);
  if (!text || seenIds.has(item.id)) {
    return;
  }

  seenIds.add(item.id);
  items.push({ ...item, text });
}

export function buildResumeGenerationEvidenceCatalog(
  input: ResumeGenerationInput,
): ResumeGenerationEvidenceItem[] {
  const items: ResumeGenerationEvidenceItem[] = [];
  const seenIds = new Set<string>();
  const addProfileEvidence = (id: string, text: unknown) => {
    pushEvidenceItem(items, seenIds, {
      id,
      text,
      scope: "profile",
      profileRecordId: null,
    });
  };

  addProfileEvidence("profile:headline", input.profile.headline);
  addProfileEvidence("profile:summary", input.profile.summary);
  addProfileEvidence(
    "profile:yearsExperience",
    input.profile.yearsExperience !== null && input.profile.yearsExperience > 0
      ? `${input.profile.yearsExperience} years of professional experience.`
      : null,
  );
  addProfileEvidence(
    "profile:professionalSummary:shortValueProposition",
    input.profile.professionalSummary.shortValueProposition,
  );
  addProfileEvidence(
    "profile:professionalSummary:fullSummary",
    input.profile.professionalSummary.fullSummary,
  );
  addProfileEvidence(
    "profile:professionalSummary:leadershipSummary",
    input.profile.professionalSummary.leadershipSummary,
  );
  addProfileEvidence(
    "profile:professionalSummary:domainFocusSummary",
    input.profile.professionalSummary.domainFocusSummary,
  );
  input.profile.professionalSummary.careerThemes.forEach((text, index) => {
    addProfileEvidence(
      `profile:professionalSummary:careerTheme:${index}`,
      text,
    );
  });
  input.profile.professionalSummary.strengths.forEach((text, index) => {
    addProfileEvidence(`profile:professionalSummary:strength:${index}`, text);
  });
  addProfileEvidence(
    "profile:narrative:professionalStory",
    input.profile.narrative.professionalStory,
  );
  addProfileEvidence(
    "profile:narrative:careerTransitionSummary",
    input.profile.narrative.careerTransitionSummary,
  );
  input.profile.narrative.differentiators.forEach((text, index) => {
    addProfileEvidence(`profile:narrative:differentiator:${index}`, text);
  });
  addProfileEvidence(
    "profile:skills",
    input.profile.skills.length > 0 ? input.profile.skills.join(", ") : null,
  );
  for (const [group, skills] of [
    ["coreSkills", input.profile.skillGroups.coreSkills],
    ["tools", input.profile.skillGroups.tools],
    [
      "languagesAndFrameworks",
      input.profile.skillGroups.languagesAndFrameworks,
    ],
    ["softSkills", input.profile.skillGroups.softSkills],
    ["highlightedSkills", input.profile.skillGroups.highlightedSkills],
  ] as const) {
    addProfileEvidence(
      `profile:skillGroup:${group}`,
      skills.length > 0 ? skills.join(", ") : null,
    );
  }

  input.profile.experiences.forEach((experience) => {
    pushEvidenceItem(items, seenIds, {
      id: `experience:${experience.id}:summary`,
      text: experience.summary,
      scope: "experience",
      profileRecordId: experience.id,
    });
    experience.achievements.forEach((text, index) => {
      pushEvidenceItem(items, seenIds, {
        id: `experience:${experience.id}:achievement:${index}`,
        text,
        scope: "experience",
        profileRecordId: experience.id,
      });
    });
    pushEvidenceItem(items, seenIds, {
      id: `experience:${experience.id}:skills`,
      text: experience.skills.length > 0 ? experience.skills.join(", ") : null,
      scope: "experience",
      profileRecordId: experience.id,
    });
    pushEvidenceItem(items, seenIds, {
      id: `experience:${experience.id}:domainTags`,
      text:
        experience.domainTags.length > 0
          ? experience.domainTags.join(", ")
          : null,
      scope: "experience",
      profileRecordId: experience.id,
    });
  });

  input.profile.projects.forEach((project) => {
    pushEvidenceItem(items, seenIds, {
      id: `project:${project.id}:summary`,
      text: project.summary,
      scope: "project",
      profileRecordId: project.id,
    });
    pushEvidenceItem(items, seenIds, {
      id: `project:${project.id}:outcome`,
      text: project.outcome,
      scope: "project",
      profileRecordId: project.id,
    });
    pushEvidenceItem(items, seenIds, {
      id: `project:${project.id}:skills`,
      text: project.skills.length > 0 ? project.skills.join(", ") : null,
      scope: "project",
      profileRecordId: project.id,
    });
    pushEvidenceItem(items, seenIds, {
      id: `project:${project.id}:projectType`,
      text: project.projectType,
      scope: "project",
      profileRecordId: project.id,
    });
  });

  input.profile.proofBank.forEach((proof) => {
    for (const [field, text] of [
      ["claim", proof.claim],
      ["heroMetric", proof.heroMetric],
      ["supportingContext", proof.supportingContext],
    ] as const) {
      pushEvidenceItem(items, seenIds, {
        id: `proof:${proof.id}:${field}`,
        text,
        scope: "proof",
        profileRecordId: proof.id,
      });
    }
  });

  if ("evidence" in input && input.evidence) {
    for (const field of [
      "summary",
      "candidateSummary",
      "experience",
    ] as const) {
      input.evidence[field].forEach((text, index) => {
        pushEvidenceItem(items, seenIds, {
          id: `importEvidence:${field}:${index}`,
          text,
          scope: "import_evidence",
          profileRecordId: null,
        });
      });
    }
    for (const field of ["skills", "keywords"] as const) {
      pushEvidenceItem(items, seenIds, {
        id: `importEvidence:${field}`,
        text:
          input.evidence[field].length > 0
            ? input.evidence[field].join(", ")
            : null,
        scope: "import_evidence",
        profileRecordId: null,
      });
    }
  }

  if (input.resumeText?.trim()) {
    pushEvidenceItem(items, seenIds, {
      id: "baseResume:text",
      text: input.resumeText,
      scope: "import_evidence",
      profileRecordId: null,
    });
  }

  return items;
}

export function buildGroundedResumeRewriteModelPayload(
  input: ResumeGenerationInput,
) {
  return {
    ...(input.resumeText?.trim() ? { baseResumeText: input.resumeText } : {}),
    ...("language" in input
      ? {
          targetLanguage:
            input.language ?? "the language the listing is written in",
        }
      : {}),
    ...("languageFields" in input
      ? { languageFields: input.languageFields }
      : {}),
    targetJob: {
      title: input.job.title,
      company: input.job.company,
      description: compactJobDescriptionForModel(input.job.description),
      responsibilities: input.job.responsibilities,
      minimumQualifications: input.job.minimumQualifications,
      preferredQualifications: input.job.preferredQualifications,
      keySkills: input.job.keySkills,
      keywordSignals: input.job.keywordSignals,
      listingRequestedSkills: collectListingRequestedSkills(input.job),
    },
    ...("researchContext" in input && input.researchContext
      ? { researchContext: input.researchContext }
      : {}),
    groundingEvidence: {
      version: 1,
      items: buildResumeGenerationEvidenceCatalog(input),
    },
  };
}

export function parseEvidenceLinkedText(
  value: unknown,
  companionEvidenceRefs?: unknown,
): ParsedEvidenceLinkedText | null {
  const structured = EvidenceLinkedTextSchema.safeParse(value);
  if (structured.success) {
    return {
      text: structured.data.text,
      evidenceRefs: Array.from(new Set(structured.data.evidenceRefs)),
      inferred: structured.data.inferred === true,
      sourceAchievementIds: Array.from(
        new Set(structured.data.sourceAchievementIds ?? []),
      ),
    };
  }

  const text = normalizeNullableText(value);
  if (!text) {
    return null;
  }

  const parsedRefs = EvidenceReferenceListSchema.safeParse(
    companionEvidenceRefs,
  );
  return {
    text,
    evidenceRefs: parsedRefs.success
      ? Array.from(new Set(parsedRefs.data))
      : [],
    inferred: false,
    sourceAchievementIds: [],
  };
}

const MAX_LISTING_REQUESTED_SKILLS = 16;

/**
 * Listing fields the aggressive skills injector may harvest. Structured
 * `keySkills` come first; qualification and skill-prompt prose fill gaps when
 * extraction left those fields as sentences instead of a skill list.
 */
interface ListingRequestedSkillJob {
  location?: string | null;
  keySkills?: readonly string[] | null;
  keywordSignals?: readonly { kind: string; label: string }[] | null;
  minimumQualifications?: readonly string[] | null;
  preferredQualifications?: readonly string[] | null;
  responsibilities?: readonly string[] | null;
  description?: string | null;
  summary?: string | null;
  /** The job title and employer name are names, not skills the job asks for. */
  title?: string | null;
  company?: string | null;
}

function listingTextMentions(text: string, phrase: string): boolean {
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    escaped.length > 0 &&
    new RegExp(`(^|[^A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "iu").test(text)
  );
}

function stripListingNames(text: string, names: readonly string[]): string {
  return names.reduce((current, name) => current.split(name).join(" "), text);
}

const LISTING_SKILL_PROMPT_PATTERN =
  /\b(?:experience (?:with|in|using)|proficien(?:t|cy) (?:in|with)|familiar(?:ity)? with|knowledge of|skilled (?:in|with)|expertise (?:in|with)|hands-?on (?:with|in)|work(?:s|ed|ing)? (?:with|knowledge of)|written (?:in|with)|pipelines? (?:in|with|using)|must (?:have|know)|(?:required|preferred)\s*:?|(?:including|such as)|(?:tech(?:nology)? stack|stack)\s*:?)\s+([^.;:\n]+)/giu;

const LISTING_SKILL_TITLE_CASE_PATTERN =
  /\b(?:C(?:\+\+|#)|F#|\.[A-Za-z][A-Za-z0-9+#.]{1,}|[A-Z][A-Za-z0-9+#.]*(?:[+\-/.][A-Za-z0-9+#.]+)*)(?:\b(?![+#])|(?<=[+#]))/g;

const LISTING_SKILL_SHORT_TECH = new Set(["go", "qt", "c#", "f#", "c++"]);

const LISTING_SKILL_HR_ACRONYMS = new Set([
  "eeo",
  "pto",
  "usa",
  "usd",
  "uk",
  "eu",
  "nyc",
  "ceo",
  "cto",
  "vp",
  "hr",
  "nda",
  "doe",
  "tbd",
]);

const LISTING_SKILL_FLUFF_TOKENS = new Set([
  "a",
  "an",
  "and",
  "or",
  "the",
  "of",
  "in",
  "on",
  "to",
  "for",
  "with",
  "using",
  "via",
  "as",
  "at",
  "by",
  "from",
  "strong",
  "excellent",
  "outstanding",
  "proven",
  "evidence",
  "practical",
  "required",
  "preferred",
  "plus",
  "etc",
  "including",
  "such",
  "both",
  "either",
  "across",
  "within",
  "years",
  "year",
  "yrs",
  "yr",
  "bachelor",
  "bachelors",
  "master",
  "masters",
  "degree",
  "diploma",
  "phd",
  "doctorate",
  "equivalent",
  "related",
  "field",
  "ability",
  "abilities",
  "able",
  "must",
  "have",
  "has",
  "communication",
  "communications",
  "clear",
  "teamwork",
  "collaboration",
  "collaborative",
  "leadership",
  "stakeholder",
  "stakeholders",
  "ownership",
  "delivery",
  "problem",
  "solving",
  "attention",
  "detail",
  "self",
  "motivated",
  "fast",
  "paced",
  "equal",
  "opportunity",
  "benefits",
  "salary",
  "visa",
  "sponsorship",
  "clearance",
  "education",
  "university",
  "college",
  "environment",
  "passionate",
  "passion",
  "understanding",
  "track",
  "record",
  "background",
  "experience",
  "experiences",
  "knowledge",
  "skills",
  "skill",
  "work",
  "working",
  "authorization",
  "authorized",
  "deep",
  "solid",
  "hands",
  "minimum",
  "bonus",
  "nice",
  "candidate",
  "candidates",
  "team",
  "teams",
  "people",
  "customer",
  "customers",
  "business",
  "role",
  "position",
  "job",
  "our",
  "we",
  "you",
  "your",
  "english",
  "written",
  "verbal",
  "oral",
  "demonstrated",
  "own",
  "owning",
  "roadmap",
  "product",
  "design",
  "systems",
  "workflow",
  "platform",
  "cloud",
  "computer",
  "science",
  "engineering",
  "engineer",
  "developer",
  "software",
  "professional",
  "proficient",
  "proficiency",
  "expertise",
  "exposure",
  "fluency",
  "fluent",
  "competency",
  "competence",
  "familiarity",
  "familiar",
  "responsibility",
  "responsibilities",
  "qualification",
  "qualifications",
  "requirement",
  "requirements",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
]);

// Verbs and bare nouns that title-case harvest must not treat as skills
// ("Build pipelines…", "Services written in Go"). They are not affix fluff:
// stripping them would turn "Amazon Web Services" into "Amazon Web".
const LISTING_SKILL_STANDALONE_REJECT = new Set([
  "build",
  "built",
  "building",
  "service",
  "services",
  "certified",
  "certification",
  "certificate",
  "architect",
  "solutions",
]);

function isRejectedListingSkillToken(token: string): boolean {
  return (
    LISTING_SKILL_FLUFF_TOKENS.has(token) ||
    LISTING_SKILL_STANDALONE_REJECT.has(token)
  );
}

function listingSkillTokenKey(token: string): string {
  return token.toLowerCase().replace(/[^a-z0-9+#.]+/gu, "");
}

function stripListingSkillFluffAffixes(phrase: string): string {
  const tokens = phrase.split(/[\s,]+/u).filter(Boolean);
  while (tokens.length > 0) {
    const key = listingSkillTokenKey(tokens[0] ?? "");
    if (key.length < 2 || LISTING_SKILL_FLUFF_TOKENS.has(key)) {
      tokens.shift();
      continue;
    }
    break;
  }
  while (tokens.length > 0) {
    const key = listingSkillTokenKey(tokens[tokens.length - 1] ?? "");
    if (key.length < 2 || LISTING_SKILL_FLUFF_TOKENS.has(key)) {
      tokens.pop();
      continue;
    }
    break;
  }
  return tokens.join(" ");
}

function uniqueListingSkillNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = canonicalSkillPhrase(trimmed) || trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

function splitListingSkillList(tail: string): string[] {
  return tail
    .split(/\s*(?:,|;|\band\b|\bor\b)\s*/iu)
    .map((part) =>
      part
        .replace(/^(?:and|or|plus)\s+/iu, "")
        .replace(/^[:\-–—]\s*/u, "")
        .replace(/[.)]+$/u, "")
        .replace(/\s+/gu, " ")
        .trim(),
    )
    .filter((part) => part.length >= 2 && part.length <= 48);
}

function isInjectableListingSkillName(phrase: string): boolean {
  const trimmed = phrase.trim();
  return (
    looksLikeListingTechnology(trimmed, { fromPrompt: false }) ||
    looksLikeCompoundListingProductName(trimmed)
  );
}

function looksLikeCompoundListingProductName(phrase: string): boolean {
  const trimmed = phrase
    .replace(/^[^A-Za-z0-9+#.]+|[^A-Za-z0-9+#.]+$/gu, "")
    .trim();
  if (trimmed.length < 4 || trimmed.length > 48) {
    return false;
  }
  const tokens = trimmed.split(/[\s,]+/u).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 4) {
    return false;
  }
  const content = tokens.filter((token) => {
    const key = listingSkillTokenKey(token);
    return key.length >= 2 && !LISTING_SKILL_FLUFF_TOKENS.has(key);
  });
  if (content.length < 2) {
    return false;
  }
  return content.every((token) => {
    if (LISTING_SKILL_SHORT_TECH.has(listingSkillTokenKey(token))) {
      return true;
    }
    return /^(?:[A-Z]{2,6}|[A-Z][A-Za-z0-9+#.]*)$/u.test(token);
  });
}

function looksLikeListingTechnology(
  phrase: string,
  options: { fromPrompt: boolean },
): boolean {
  const trimmed = phrase
    .replace(/^[^A-Za-z0-9+#.]+|[^A-Za-z0-9+#.]+$/gu, "")
    .trim();
  if (trimmed.length < 2 || trimmed.length > 48) {
    return false;
  }
  if (/\d/u.test(trimmed) && /\byears?\b/iu.test(trimmed)) {
    return false;
  }

  if (
    !/\s/u.test(trimmed) &&
    trimmed.includes("-") &&
    !/[+#./]/u.test(trimmed)
  ) {
    const parts = trimmed.split("-").filter(Boolean);
    return parts.some((part) =>
      looksLikeListingTechnology(part, { fromPrompt: false }),
    );
  }

  const tokens = trimmed.split(/[\s,]+/u).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) {
    return false;
  }
  const lowerTokens = tokens.map((token) =>
    token.toLowerCase().replace(/[^a-z0-9+#.]+/gu, ""),
  );
  if (
    lowerTokens.every(
      (token) => isRejectedListingSkillToken(token) || token.length < 2,
    )
  ) {
    return false;
  }
  if (/[+#]/u.test(trimmed) || /\./u.test(trimmed) || /\//u.test(trimmed)) {
    return true;
  }
  if (tokens.length === 1 && /[A-Z][a-z]+[A-Z]/u.test(trimmed)) {
    return true;
  }
  if (tokens.length === 1) {
    const token = tokens[0] ?? "";
    const lower = token.toLowerCase();
    if (isRejectedListingSkillToken(lower)) {
      return false;
    }
    if (LISTING_SKILL_SHORT_TECH.has(listingSkillTokenKey(token))) {
      return true;
    }
    if (/^[A-Z]{2,6}$/u.test(token)) {
      return !LISTING_SKILL_HR_ACRONYMS.has(lower);
    }
    return /^[A-Z][A-Za-z0-9+#.]{2,}$/u.test(token);
  }
  if (options.fromPrompt) {
    return isInjectableListingSkillName(trimmed);
  }
  return tokens.every((token) =>
    looksLikeListingTechnology(token, { fromPrompt: false }),
  );
}

function collectPromptCapturedListingSkills(
  lines: readonly string[],
): string[] {
  const captured: string[] = [];
  for (const line of lines) {
    const matches = line.matchAll(LISTING_SKILL_PROMPT_PATTERN);
    for (const match of matches) {
      const tail = match[1];
      if (!tail) {
        continue;
      }
      for (const phrase of splitListingSkillList(tail)) {
        const stripped = stripListingSkillFluffAffixes(phrase);
        if (stripped && isInjectableListingSkillName(stripped)) {
          captured.push(stripped);
        }
      }
    }
  }
  return captured;
}

function collectTitleCaseListingSkills(lines: readonly string[]): string[] {
  const captured: string[] = [];
  for (const line of lines) {
    for (const match of line.matchAll(LISTING_SKILL_TITLE_CASE_PATTERN)) {
      const token = match[0];
      if (looksLikeListingTechnology(token, { fromPrompt: false })) {
        captured.push(token);
      }
    }
  }
  return captured;
}

/**
 * Technologies the listing itself asks for, including ones that only appear
 * in qualification prose rather than the structured `keySkills` array.
 * Bounded and de-duplicated so screening can see the job's stack without
 * scraping company boilerplate into the skills section.
 */
export function collectListingRequestedSkills(
  job: ListingRequestedSkillJob,
): string[] {
  const structured = [
    ...(job.keySkills ?? []),
    ...(job.keywordSignals ?? [])
      .filter((signal) => signal.kind === "skill" || signal.kind === "tool")
      .map((signal) => signal.label),
  ];
  const qualificationLines = [
    ...(job.minimumQualifications ?? []),
    ...(job.preferredQualifications ?? []),
  ];
  const skillPromptLines = [
    ...qualificationLines,
    ...(job.responsibilities ?? []),
    job.summary ?? "",
    job.description ?? "",
  ].filter((line) => line.trim().length > 0);

  // A page's description repeats the posting title and the employer name
  // ("Full-stack Engineer, Cloud Gardens"). A word that only appears there is
  // a name, not a requested skill, so it never becomes an Aggressive skill.
  const names = [job.title, job.company]
    .map((name) => name?.trim() ?? "")
    .filter((name) => name.length > 0);
  const textWithoutNames = stripListingNames(
    skillPromptLines.join("\n"),
    names,
  );
  const inferred = [
    ...collectPromptCapturedListingSkills(skillPromptLines),
    ...collectTitleCaseListingSkills(qualificationLines),
  ].filter(
    (skill) =>
      !names.some((name) => listingTextMentions(name, skill)) ||
      listingTextMentions(textWithoutNames, skill),
  );

  return uniqueListingSkillNames([...structured, ...inferred])
    .filter(buildResumeSkillContextFilter(job))
    .slice(0, MAX_LISTING_REQUESTED_SKILLS);
}

/**
 * Review and section-regeneration guidance for aggressive drafts. Stating the
 * same bounds as generation keeps a later edit from stripping listing-asked
 * technologies the candidate still has to confirm.
 */
export function describeAggressiveResumeEditPolicy(
  tailoringStrength:
    | "conservative"
    | "balanced"
    | "aggressive"
    | null
    | undefined,
): string | null {
  if (tailoringStrength !== "aggressive") {
    return null;
  }
  return [
    "This draft uses aggressive tailoring to help the resume clear screening for a first interview.",
    "Keep bounded stretches of saved evidence: you may state evidenced years of experience one year higher when the listing itself asks for that figure, and you may name any technology, library, framework, or tool the listing asks for — required or preferred, including technologies named only in qualifications — in both the prose and the skills section, whenever the saved evidence shows professional technical experience.",
    "Never invent employers, dates, titles, credentials, seniority, leadership, or a technology absent from both the saved evidence and the job listing.",
    "The candidate confirms every stretch before export; state what you changed plainly and do not lecture.",
  ].join(" ");
}

const MODEL_JOB_DESCRIPTION_MAX_CHARS = 6_000;
const REQUIREMENT_PARAGRAPH_SIGNAL =
  /\b(responsibilit|requirement|qualification|must have|nice to have|you will|you'll|you have|experience|skills?|proficien|familiar|years|degree|stack|tools?|technolog|what we.re looking for|who you are|about the role|about this role|the role)\b/iu;
const BOILERPLATE_PARAGRAPH_SIGNAL =
  /\b(equal opportunity|equal employment|discriminat|accommodation|privacy|cookie|benefits? (?:include|package)|401\(k\)|dental|vision insurance|paid time off|pto\b|unlimited vacation|about (?:us|the company)|our mission|we are a|founded in|backed by|series [a-f]\b|valuation)/iu;

/**
 * Keeps a long listing body inside a budget the model handles well, and keeps
 * the right parts: the paragraphs that describe the work and its requirements
 * stay, company boilerplate and benefits go first. Order is preserved so the
 * model still reads a coherent listing. Short bodies pass through untouched.
 */
export function compactJobDescriptionForModel(
  description: string,
  maxChars: number = MODEL_JOB_DESCRIPTION_MAX_CHARS,
): string {
  if (description.length <= maxChars) {
    return description;
  }
  const paragraphs = description
    .split(/\n{2,}|\n(?=• )/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const ranked = paragraphs.map((text, index) => ({
    index,
    text,
    priority: REQUIREMENT_PARAGRAPH_SIGNAL.test(text)
      ? 0
      : BOILERPLATE_PARAGRAPH_SIGNAL.test(text)
        ? 2
        : 1,
  }));
  const kept = new Set<number>();
  let used = 0;
  for (const priority of [0, 1, 2]) {
    for (const entry of ranked) {
      if (entry.priority !== priority) {
        continue;
      }
      const cost = entry.text.length + 2;
      if (used + cost > maxChars) {
        continue;
      }
      kept.add(entry.index);
      used += cost;
    }
  }
  const compacted = ranked
    .filter((entry) => kept.has(entry.index))
    .map((entry) => entry.text)
    .join("\n\n");
  return compacted.length > 0
    ? compacted
    : description.slice(0, maxChars).trimEnd();
}
