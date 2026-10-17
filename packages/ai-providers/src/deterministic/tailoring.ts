import type {
  CandidateProfile,
  JobPosting,
  ResumeDraftPatch,
} from "@nestor/contracts";
import type {
  CreateResumeDraftInput,
  ResumeGenerationStrategyPolicy,
  ResumeAssistantReply,
  ReviseResumeDraftInput,
  TailorResumeInput,
} from "../shared";
import {
  ResumeAssistantReplySchema,
  TailoredResumeDraftSchema,
} from "../shared";
import { clampScore, uniqueStrings } from "./utils";
import {
  compactNarrativeToSentences,
  dropTruncatedVariants,
  orderSkillsByJobRelevance,
  splitInlineBulletSummary,
  stripLeadingBulletGlyphs,
  summaryDuplicatesBullets,
} from "./resume-narrative-presentation";
import {
  filterCandidateFacingResumeKeywords,
  filterGroundedVisibleSkills,
} from "./resume-skill-grounding";
import { inferSkills } from "./resume-parser-skills";
import { deriveResumeCoveragePlan } from "./resume-coverage";
import type { ResumeCoverageClassification } from "../shared";

/**
 * Purely typographic repair of dotted technology tokens carried out of an
 * extracted resume, where "ASP.NET Core" often arrives as "ASP .NET Core" and
 * a comma list arrives as "C#,.NET". A keyword-matching ATS reads those as
 * different tokens from the SKILLS block, which spells the same technology
 * canonically.
 *
 * This never adds, removes, or reinterprets a claim: it only closes a stray
 * space before a dotted suffix and opens a missing space after a comma. The
 * grounding comparison normalizes every non-alphanumeric run to a single
 * space, so the repaired text stays exactly as supported by saved evidence as
 * the text it replaces.
 */
export function normalizeTechnologyTokenSpacing(value: string): string {
  return (
    value
      // Only exact product names are closed up. A general "word + dotted
      // suffix" rule would also eat the ordinary space in "Migrated .NET
      // services", which is a different, correct token.
      .replace(/\b(ASP|VB)[ \t]+(\.NET)\b/gi, "$1$2")
      .replace(
        /\b(Node|Vue|Next|Nuxt|Nest|Ember|Backbone|Three)[ \t]+(\.js)\b/gi,
        "$1$2",
      )
      // A missing space after a comma between two words. The lookahead
      // excludes digits so thousands separators ("1,000") stay intact.
      .replace(/([A-Za-z#+)\]]|\d)[ \t]*,[ \t]*(?=[A-Za-z.#+])/g, "$1, ")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function tokenizeForQuality(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function isProfessionalResumeNarrative(
  value: string | null | undefined,
): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return false;
  }

  const hasFirstPersonVoice = /\b(?:i|i'm|i've|me|my|mine)\b/i.test(trimmed);
  const hasCareerChangeMeta =
    /\b(?:decid(?:e|ed|ing)|passion|return(?:ed|ing)?|transition(?:ed|ing)?\s+back)\b/i.test(
      trimmed,
    );
  const isLocationOnly =
    /^(?:remote|hybrid|onsite|on-site)(?:(?:\s+in)|\s*,)?\s*[a-z\s,-]+$/i.test(
      trimmed,
    );

  return !isLocationOnly && !(hasFirstPersonVoice && hasCareerChangeMeta);
}

function shouldKeepExperienceSummary(input: {
  summary: string | null | undefined;
  bullets: readonly string[];
}): boolean {
  if (!isProfessionalResumeNarrative(input.summary)) {
    return false;
  }

  const tokens = tokenizeForQuality(input.summary);
  if (tokens.length === 0) {
    return false;
  }

  if (tokens.length >= 5) {
    return true;
  }

  return input.bullets.length === 0;
}

function calculateQualityOverlap(
  left: string | null | undefined,
  right: string | null | undefined,
): number {
  const leftTokens = [...new Set(tokenizeForQuality(left))];
  const rightTokens = new Set(tokenizeForQuality(right));

  if (leftTokens.length === 0 || rightTokens.size === 0) {
    return 0;
  }

  const matched = leftTokens.filter((token) => rightTokens.has(token)).length;
  return matched / Math.max(Math.min(leftTokens.length, rightTokens.size), 1);
}

function buildProofBullet(input: {
  claim: string | null | undefined;
  heroMetric: string | null | undefined;
  fallback: string;
}): string {
  const claim = input.claim?.trim() || input.fallback.trim();
  const heroMetric = input.heroMetric?.trim() || "";

  if (!heroMetric) {
    return claim;
  }

  const claimTokens = tokenizeForQuality(claim);
  const metricTokens = tokenizeForQuality(heroMetric);
  const includesMetricTokens =
    metricTokens.length > 0 &&
    claimTokens.some((_, index) =>
      metricTokens.every(
        (token, tokenIndex) => claimTokens[index + tokenIndex] === token,
      ),
    );

  if (metricTokens.length === 0 || includesMetricTokens) {
    return claim;
  }

  const normalizedHeroMetric = /[.!?]$/.test(heroMetric)
    ? heroMetric
    : `${heroMetric}.`;

  return `${claim}${/[.!?]$/.test(claim) ? "" : "."} ${normalizedHeroMetric}`;
}

function shouldKeepSupportingContext(
  value: string | null | undefined,
): boolean {
  return tokenizeForQuality(value).length >= 8;
}

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const monthByName: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function formatMonthYear(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  if (/^\d{4}$/.test(trimmed)) {
    return trimmed;
  }

  if (/^present$/i.test(trimmed)) {
    return "Present";
  }

  const yearMonthMatch = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(trimmed);
  const monthYearSlashMatch = /^(\d{1,2})\/(\d{4})$/.exec(trimmed);
  const namedMonthMatch = /^([a-zA-Z]+)\.?\s+(\d{4})$/.exec(trimmed);

  if (yearMonthMatch) {
    const month = monthNames[Number(yearMonthMatch[2]) - 1];
    return month ? `${month} ${yearMonthMatch[1]}` : null;
  }

  if (monthYearSlashMatch) {
    const month = monthNames[Number(monthYearSlashMatch[1]) - 1];
    return month ? `${month} ${monthYearSlashMatch[2]}` : null;
  }

  if (namedMonthMatch) {
    const monthName = namedMonthMatch[1];
    const monthNumber = monthName ? monthByName[monthName.toLowerCase()] : null;
    const month = monthNumber ? monthNames[monthNumber - 1] : null;
    return month ? `${month} ${namedMonthMatch[2]}` : null;
  }

  return null;
}

function formatDateRange(
  start: string | null | undefined,
  end: string | null | undefined,
): string | null {
  return (
    [formatMonthYear(start), formatMonthYear(end)]
      .filter(Boolean)
      .join(" – ") || null
  );
}

const QUALITY_OVERLAP_THRESHOLD = 0.72;
/**
 * Visible skill budgets. Grounding decides eligibility; these only decide
 * how many grounded skills the one-page layout shows before the rest are
 * reported as "not shown".
 */
export const VISIBLE_CORE_SKILL_LIMIT = 10;
export const VISIBLE_ADDITIONAL_SKILL_LIMIT = 14;
const EXPERIENCE_IMPACT_SIGNAL_PATTERN =
  /\b(?:accelerated|cut|decreased|delivered|eliminated|grew|improved|increased|lowered|optimized|outperformed|raised|reduced|saved|scaled|shortened)\b/i;
const EXPERIENCE_GENERIC_OPENING_PATTERN =
  /^(?:adopted|assisted|collaborated|helped|managed end-to-end|participated|responsible for|worked (?:on|with))\b/i;
const EXPERIENCE_PROJECT_HEADING_PATTERN =
  /^[^.!?]{2,80}\([^)]{2,80}\)\s*[–—]\s*[^.!?]{2,120}$/u;

function looksLikeProjectHeading(value: string): boolean {
  return EXPERIENCE_PROJECT_HEADING_PATTERN.test(value.trim());
}

function scoreExperienceBullet(
  value: string,
  targetTerms: readonly string[],
): number {
  const tokens = new Set(tokenizeForQuality(value));
  const metricCount =
    value.match(
      /(?:\$\s?\d[\d,.]*|\b\d+(?:\.\d+)?\s?%|\b\d+\+|\b\d+\s*(?:days?|weeks?|months?|hours?|minutes?|seconds?|users?|customers?|tickets?|projects?|developers?|teams?))/gi,
    )?.length ?? 0;
  const targetOverlap = uniqueStrings(targetTerms)
    .flatMap(tokenizeForQuality)
    .filter((token) => token.length >= 3 && tokens.has(token)).length;
  const hasImpactSignal = EXPERIENCE_IMPACT_SIGNAL_PATTERN.test(value);
  const isGenericOpening = EXPERIENCE_GENERIC_OPENING_PATTERN.test(value);
  const hasUsefulLength = value.length >= 55 && value.length <= 240;

  return (
    Math.min(9, metricCount * 3) +
    Math.min(4, targetOverlap) +
    (hasImpactSignal ? 3 : 0) +
    (hasUsefulLength ? 1 : 0) -
    (isGenericOpening && metricCount === 0 ? 3 : 0)
  );
}

function isDistinctQualityLine(
  value: string,
  existing: readonly string[],
): boolean {
  const metricSignature = (line: string) =>
    new Set(
      line
        .toLowerCase()
        .match(/(?:\$\s?\d[\d,.]*|\b\d+(?:\.\d+)?\s?%|\b\d+\+)/g) ?? [],
    );
  const candidateMetrics = metricSignature(value);

  return existing.every((entry) => {
    const overlap = calculateQualityOverlap(value, entry);
    const repeatedMetric = [...candidateMetrics].some((metric) =>
      metricSignature(entry).has(metric),
    );
    return overlap < QUALITY_OVERLAP_THRESHOLD && !repeatedMetric;
  });
}

function scoreTargetRelevance(
  value: string | null | undefined,
  targetTerms: readonly string[],
): number {
  const valueTokens = new Set(tokenizeForQuality(value));

  return uniqueStrings(targetTerms)
    .flatMap(tokenizeForQuality)
    .filter((token) => token.length >= 3 && valueTokens.has(token)).length;
}

function buildExperienceBullets(input: {
  experience: CandidateProfile["experiences"][number];
  proofBank: CandidateProfile["proofBank"];
  maxBullets?: number;
  targetTerms?: readonly string[];
  usedBulletSignatures?: Set<string>;
  sourceAchievements: readonly string[];
  sourceIdsByText: Map<string, string[]>;
}): string[] {
  const canonicalBullets = dropTruncatedVariants(
    input.experience.achievements.map(stripLeadingBulletGlyphs).filter(Boolean),
  );
  const narrativeBullets = canonicalBullets.filter(
    (bullet) => !looksLikeProjectHeading(bullet),
  );
  // Prefer accomplishment prose over project-heading fragments, but never
  // erase the only canonical evidence available for a role.
  const baseBullets =
    narrativeBullets.length > 0 ? narrativeBullets : canonicalBullets;
  const matchedProofs: Array<CandidateProfile["proofBank"][number]> = [];
  const usedProofIds = new Set<string>();

  const enrichedBullets = uniqueStrings(
    baseBullets.map((bullet) => {
      const matchingProof = input.proofBank
        .filter((proof) => !usedProofIds.has(proof.id))
        .map((proof) => ({
          overlap: calculateQualityOverlap(
            [proof.claim, proof.heroMetric].filter(Boolean).join(" "),
            bullet,
          ),
          proof,
        }))
        .filter(({ overlap }) => overlap >= QUALITY_OVERLAP_THRESHOLD)
        .sort((left, right) => right.overlap - left.overlap)[0]?.proof;

      const sourceIds = input.sourceAchievements.flatMap((source, index) =>
        stripLeadingBulletGlyphs(source) === bullet
          ? [`experience:${input.experience.id}:achievement:${index}`]
          : [],
      );
      if (!matchingProof) {
        input.sourceIdsByText.set(
          normalizeTechnologyTokenSpacing(bullet),
          sourceIds,
        );
        return bullet;
      }

      usedProofIds.add(matchingProof.id);
      matchedProofs.push(matchingProof);

      // Keep the complete source clause when adding a saved metric. Coverage
      // is bookkeeping of this transformation, never a wording comparison.
      const enriched = buildProofBullet({
        claim: bullet,
        heroMetric: matchingProof.heroMetric,
        fallback: bullet,
      });
      input.sourceIdsByText.set(
        normalizeTechnologyTokenSpacing(enriched),
        sourceIds,
      );
      return enriched;
    }),
  );

  const supportingContextBullets: string[] = [];

  for (const proof of matchedProofs) {
    const candidate = proof.supportingContext?.trim();
    if (!candidate || !shouldKeepSupportingContext(candidate)) {
      continue;
    }

    if (
      !isDistinctQualityLine(candidate, [
        ...enrichedBullets,
        ...supportingContextBullets,
      ])
    ) {
      continue;
    }

    supportingContextBullets.push(candidate);
  }

  const maxBullets = input.maxBullets ?? 3;
  const selectedBullets: string[] = [];
  const rankedEnrichedBullets = enrichedBullets
    .map((bullet, index) => ({
      bullet,
      index,
      score: scoreExperienceBullet(bullet, input.targetTerms ?? []),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ bullet }) => bullet);

  for (const bullet of dropTruncatedVariants([
    ...rankedEnrichedBullets,
    ...supportingContextBullets,
  ])) {
    const signature = tokenizeForQuality(bullet).join(" ");
    if (signature && input.usedBulletSignatures?.has(signature)) {
      continue;
    }

    selectedBullets.push(bullet);
    if (signature) {
      input.usedBulletSignatures?.add(signature);
    }

    if (selectedBullets.length >= maxBullets) {
      break;
    }
  }

  return selectedBullets.map(normalizeTechnologyTokenSpacing);
}

function shouldExportCoverageClassification(
  classification: ResumeCoverageClassification,
): boolean {
  return classification === "detailed" || classification === "compact";
}

const COMPACT_SUMMARY_BUDGET = 150;

/**
 * Compacts a role narrative to whole sentences under the budget. A sentence
 * is never cut mid-clause: the earlier character slice produced fragments
 * such as "…connecting modern UIs to secure APIs that." in exported PDFs.
 */
function compactExperienceSummary(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim() ?? "";
  if (!isProfessionalResumeNarrative(trimmed)) {
    return null;
  }

  return compactNarrativeToSentences(trimmed, COMPACT_SUMMARY_BUDGET);
}

/**
 * Legacy profiles can carry an inline "● item ● item" list, or a long
 * paragraph, inside the role summary while the role has no real bullets.
 * Present that content as bullets with at most one short lead sentence so
 * neither the deterministic draft nor the PDF prints glyph-laden prose.
 */
function presentExperienceNarrative(
  experience: CandidateProfile["experiences"][number],
): CandidateProfile["experiences"][number] {
  const achievements = uniqueStrings(
    experience.achievements.map(stripLeadingBulletGlyphs).filter(Boolean),
  );
  const split = splitInlineBulletSummary(
    experience.summary,
    achievements.length,
  );
  if (!split) {
    return achievements.length === experience.achievements.length &&
      achievements.every(
        (value, index) => value === experience.achievements[index],
      )
      ? experience
      : { ...experience, achievements };
  }

  return {
    ...experience,
    summary: split.summary,
    achievements: uniqueStrings([...achievements, ...split.bullets]),
  };
}

function parseChronologyMonth(value: string | null | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  if (/^(present|current|now)$/i.test(trimmed)) {
    return Number.MAX_SAFE_INTEGER;
  }

  const monthYearSlashMatch = /^(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (monthYearSlashMatch) {
    const month = Number(monthYearSlashMatch[1]);
    return month >= 1 && month <= 12
      ? Number(monthYearSlashMatch[2]) * 12 + month
      : null;
  }

  const namedMonthMatch = /^([A-Za-z]+)\.?\s+(\d{4})$/i.exec(trimmed);
  if (namedMonthMatch) {
    const monthName = namedMonthMatch[1]?.toLowerCase() ?? "";
    const month = monthByName[monthName] ?? null;
    return month && month >= 1 && month <= 12
      ? Number(namedMonthMatch[2]) * 12 + month
      : null;
  }

  const yearMonthMatch = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(trimmed);
  if (yearMonthMatch) {
    const month = Number(yearMonthMatch[2]);
    return month >= 1 && month <= 12
      ? Number(yearMonthMatch[1]) * 12 + month
      : null;
  }

  const yearMatch = /^(\d{4})$/.exec(trimmed);
  if (yearMatch) {
    return Number(yearMatch[1]) * 12 + 1;
  }

  return null;
}

function compareExperienceReverseChronology(
  left: CandidateProfile["experiences"][number],
  right: CandidateProfile["experiences"][number],
): number {
  const leftMonth =
    (left.isCurrent
      ? Number.MAX_SAFE_INTEGER
      : parseChronologyMonth(left.endDate)) ??
    parseChronologyMonth(left.startDate) ??
    Number.MIN_SAFE_INTEGER;
  const rightMonth =
    (right.isCurrent
      ? Number.MAX_SAFE_INTEGER
      : parseChronologyMonth(right.endDate)) ??
    parseChronologyMonth(right.startDate) ??
    Number.MIN_SAFE_INTEGER;

  if (rightMonth !== leftMonth) {
    return rightMonth - leftMonth;
  }

  const leftStart =
    parseChronologyMonth(left.startDate) ?? Number.MIN_SAFE_INTEGER;
  const rightStart =
    parseChronologyMonth(right.startDate) ?? Number.MIN_SAFE_INTEGER;
  if (rightStart !== leftStart) {
    return rightStart - leftStart;
  }

  return `${left.companyName ?? ""}\u0000${left.title}\u0000${left.id}`.localeCompare(
    `${right.companyName ?? ""}\u0000${right.title}\u0000${right.id}`,
  );
}

function createPatchId(prefix: string): string {
  return `${prefix}_${typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`}`;
}

function strategyHeadline(
  input: Pick<TailorResumeInput, "profile" | "job"> & {
    strategy?: ResumeGenerationStrategyPolicy | null;
  },
): string | null {
  switch (input.strategy?.headlinePolicy) {
    case "fixed":
      return input.profile.headline;
    case "role_family_template":
      return input.strategy.roleFamily;
    case "per_job_tailored":
      return input.job.title || input.profile.headline;
    default:
      return input.profile.headline;
  }
}

function shouldExportStrategyCoverage(
  classification: ResumeCoverageClassification,
  strategy?: ResumeGenerationStrategyPolicy | null,
): boolean {
  if (!strategy) {
    return shouldExportCoverageClassification(classification);
  }

  switch (strategy.coveragePolicy) {
    case "base_omissions":
      return classification === "detailed";
    case "role_family_recommended":
      return classification === "detailed" || classification === "compact";
    case "full_tailoring":
      return classification !== "omitted";
  }
}

function strategySkillCandidates(input: {
  profile: CandidateProfile;
  job: JobPosting;
  strategy?: ResumeGenerationStrategyPolicy | null;
}): string[] {
  switch (input.strategy?.skillsPolicy) {
    case "base_only":
      return [...input.profile.skills, ...input.profile.skillGroups.coreSkills];
    case "role_family_expanded":
      return [
        ...input.profile.skills,
        ...input.profile.skillGroups.coreSkills,
        ...input.profile.skillGroups.tools,
        ...input.profile.skillGroups.languagesAndFrameworks,
        ...input.profile.skillGroups.highlightedSkills,
      ];
    case "per_job_tailored":
      return [
        ...input.job.keySkills,
        ...input.profile.skills,
        ...input.profile.skillGroups.coreSkills,
        ...input.profile.skillGroups.tools,
        ...input.profile.skillGroups.languagesAndFrameworks,
        ...input.profile.skillGroups.highlightedSkills,
        ...input.profile.projects.flatMap((project) => project.skills),
      ];
    default:
      return [
        ...input.job.keySkills,
        ...input.profile.skills,
        ...input.profile.skillGroups.coreSkills,
      ];
  }
}

function baseResumeSkills(input: { resumeText: string | null }): string[] {
  return input.resumeText?.trim() ? inferSkills(input.resumeText, []) : [];
}

function filterStrategyVisibleSkills(
  input: { profile: TailorResumeInput["profile"]; resumeText: string | null },
  skills: readonly string[],
  limit: number,
): string[] {
  const profileSkills = filterGroundedVisibleSkills(
    input.profile,
    skills,
    limit,
  );
  const baseSkills = baseResumeSkills(input);
  const normalizedRequested = new Set(
    skills.map((skill) => skill.trim().toLowerCase()).filter(Boolean),
  );
  return uniqueStrings([
    ...baseSkills.filter((skill) =>
      normalizedRequested.has(skill.trim().toLowerCase()),
    ),
    ...profileSkills,
  ]).slice(0, limit);
}

export function buildDeterministicResumeText(
  profile: CandidateProfile,
  job: JobPosting,
  summary: string,
  experienceHighlights: readonly string[],
  coreSkills: readonly string[],
  targetedKeywords: readonly string[],
  experienceEntries: readonly {
    title: string | null;
    employer: string | null;
    location: string | null;
    dateRange: string | null;
    summary: string | null;
    bullets: readonly string[];
  }[] = [],
  projectEntries: readonly {
    name: string | null;
    role: string | null;
    summary: string | null;
    outcome: string | null;
    bullets: readonly string[];
  }[] = [],
  educationEntries: readonly {
    school: string | null;
    degree: string | null;
    fieldOfStudy: string | null;
    location: string | null;
    dateRange: string | null;
    summary: string | null;
  }[] = [],
  certificationEntries: readonly {
    name: string | null;
    issuer: string | null;
    dateRange: string | null;
  }[] = [],
  additionalSkills: readonly string[] = [],
  languages: readonly string[] = [],
  headline: string | null = profile.headline,
): string {
  const candidateFacingTargetedKeywords =
    filterCandidateFacingResumeKeywords(targetedKeywords);
  const formatHeading = (
    parts: readonly (string | null)[],
    right?: string | null,
  ) => {
    const left = parts.filter(Boolean).join(" — ");
    if (left && right) {
      return `${left} | ${right}`;
    }
    return left || right || null;
  };

  const experienceSection =
    experienceEntries.length > 0 || experienceHighlights.length > 0
      ? [
          "Experience",
          ...experienceEntries.flatMap((entry) => [
            formatHeading(
              [entry.title, entry.employer],
              formatHeading([entry.location], entry.dateRange),
            ),
            entry.summary,
            ...entry.bullets.map((line) => `- ${line}`),
            "",
          ]),
          ...experienceHighlights.map((line) => `- ${line}`),
          "",
        ]
      : [];

  return [
    profile.fullName,
    headline,
    [profile.currentLocation, profile.email, profile.phone]
      .filter(Boolean)
      .join(" | "),
    "",
    "Summary",
    summary,
    "",
    ...experienceSection,
    coreSkills.length > 0 ? `Core Skills: ${coreSkills.join(", ")}` : null,
    additionalSkills.length > 0
      ? `Additional Skills: ${additionalSkills.join(", ")}`
      : null,
    languages.length > 0 ? `Languages: ${languages.join(", ")}` : null,
    "",
    ...(projectEntries.length > 0
      ? [
          "Projects",
          ...projectEntries.flatMap((entry) => [
            formatHeading([entry.name, entry.role]),
            [entry.summary, entry.outcome].filter(Boolean).join(" "),
            ...entry.bullets.map((line) => `- ${line}`),
            "",
          ]),
        ]
      : []),
    ...(educationEntries.length > 0
      ? [
          "Education",
          ...educationEntries.flatMap((entry) => [
            formatHeading(
              [
                entry.school,
                [entry.degree, entry.fieldOfStudy].filter(Boolean).join(", ") ||
                  null,
              ],
              formatHeading([entry.location], entry.dateRange),
            ),
            entry.summary,
            "",
          ]),
        ]
      : []),
    ...(certificationEntries.length > 0
      ? [
          "Certifications",
          ...certificationEntries.map((entry) =>
            formatHeading([entry.name, entry.issuer], entry.dateRange),
          ),
          "",
        ]
      : []),
    candidateFacingTargetedKeywords.length > 0
      ? `Keywords: ${candidateFacingTargetedKeywords.join(", ")}`
      : null,
  ]
    .filter((value): value is string =>
      Boolean(value && value.trim().length > 0),
    )
    .join("\n");
}

export function buildDeterministicTailoredResume(
  input: TailorResumeInput & {
    strategy?: ResumeGenerationStrategyPolicy | null;
  },
) {
  const effectiveSearchPreferences = input.strategy
    ? {
        ...input.searchPreferences,
        tailoringMode: input.strategy.tailoringStrength,
      }
    : input.searchPreferences;
  // Job-named skills claim the visible slots first so a grounded, relevant
  // skill such as Docker or xUnit is not pushed out by profile ordering.
  const orderedSkillCandidates = orderSkillsByJobRelevance(
    strategySkillCandidates(input),
    input.job,
  );
  const coreSkills = input.strategy
    ? filterStrategyVisibleSkills(
        input,
        orderedSkillCandidates,
        VISIBLE_CORE_SKILL_LIMIT,
      )
    : filterGroundedVisibleSkills(
        input.profile,
        orderedSkillCandidates,
        VISIBLE_CORE_SKILL_LIMIT,
      );
  const targetedKeywords = filterCandidateFacingResumeKeywords(
    input.strategy
      ? input.strategy.skillsPolicy === "per_job_tailored"
        ? filterStrategyVisibleSkills(input, input.job.keySkills, 6)
        : input.strategy.skillsPolicy === "role_family_expanded"
          ? filterStrategyVisibleSkills(
              input,
              [
                ...input.profile.skillGroups.coreSkills,
                ...input.profile.skillGroups.tools,
                ...input.profile.skillGroups.languagesAndFrameworks,
              ],
              6,
            )
          : []
      : uniqueStrings(input.job.keySkills).slice(0, 6),
  );
  const additionalSkillCandidates =
    input.strategy?.skillsPolicy === "base_only"
      ? []
      : [
          ...input.profile.skillGroups.tools,
          ...input.profile.skillGroups.languagesAndFrameworks,
          ...input.profile.skillGroups.highlightedSkills,
          ...input.profile.projects.flatMap((project) => project.skills),
          ...(input.strategy?.skillsPolicy === "per_job_tailored"
            ? input.job.keySkills
            : []),
        ];
  const orderedAdditionalSkillCandidates = orderSkillsByJobRelevance(
    additionalSkillCandidates,
    input.job,
  );
  const additionalSkills = input.strategy
    ? filterStrategyVisibleSkills(
        input,
        orderedAdditionalSkillCandidates,
        VISIBLE_ADDITIONAL_SKILL_LIMIT,
      )
    : filterGroundedVisibleSkills(
        input.profile,
        orderedAdditionalSkillCandidates,
        VISIBLE_ADDITIONAL_SKILL_LIMIT + VISIBLE_CORE_SKILL_LIMIT,
      )
        .filter(
          (skill) =>
            !coreSkills.some(
              (coreSkill) => coreSkill.toLowerCase() === skill.toLowerCase(),
            ),
        )
        .slice(0, VISIBLE_ADDITIONAL_SKILL_LIMIT);
  const languages = uniqueStrings(
    input.profile.spokenLanguages
      .map((entry) =>
        [entry.language, entry.proficiency].filter(Boolean).join(" — "),
      )
      .filter(Boolean),
  );
  const targetTerms = [
    input.job.title,
    ...input.job.keySkills,
    ...input.job.responsibilities,
    ...input.job.minimumQualifications,
  ];
  const preferredStoredSummary =
    input.profile.professionalSummary.fullSummary ??
    input.profile.professionalSummary.shortValueProposition ??
    input.profile.summary ??
    null;
  const summary = preferredStoredSummary ?? "";
  const experienceHighlights: string[] = [];
  const coverageMetadata = deriveResumeCoveragePlan({
    profile: input.profile,
    searchPreferences: effectiveSearchPreferences,
    job: input.job,
  });
  const coverageByRecordId = new Map(
    coverageMetadata.map((decision) => [decision.profileRecordId, decision]),
  );
  const usedBulletSignatures = new Set<string>();
  // The most recent detailed role is the one a recruiter reads first and the
  // one closest to the target, so it gets the widest budget of its own saved
  // achievements instead of tying with older roles and rendering as the
  // thinnest block on the page. Only that role's own evidence is used; no
  // bullet is invented to fill the extra slot.
  let hasSeenDetailedRole = false;
  const experienceEntries = [...input.profile.experiences]
    .sort(compareExperienceReverseChronology)
    .flatMap((storedExperience) => {
      const coverage = coverageByRecordId.get(storedExperience.id);
      if (
        !coverage ||
        !shouldExportStrategyCoverage(coverage.classification, input.strategy)
      ) {
        return [];
      }

      const experience = presentExperienceNarrative(storedExperience);
      const isCompact = coverage.classification === "compact";
      const isLeadDetailedRole = !isCompact && !hasSeenDetailedRole;
      if (!isCompact) {
        hasSeenDetailedRole = true;
      }
      const sourceIdsByText = new Map<string, string[]>();
      const bullets = buildExperienceBullets({
        experience,
        sourceAchievements: storedExperience.achievements,
        sourceIdsByText,
        proofBank: input.profile.proofBank,
        maxBullets: isCompact ? 1 : isLeadDetailedRole ? 4 : 3,
        targetTerms,
        usedBulletSignatures,
      });
      const candidateSummary = isCompact
        ? compactExperienceSummary(experience.summary)
        : shouldKeepExperienceSummary({
              summary: experience.summary,
              bullets,
            })
          ? experience.summary
          : null;

      return [
        {
          title: experience.title,
          employer: experience.companyName,
          location: experience.location,
          dateRange: formatDateRange(
            experience.startDate,
            experience.isCurrent ? "Present" : experience.endDate,
          ),
          summary:
            candidateSummary &&
            !summaryDuplicatesBullets(candidateSummary, bullets)
              ? candidateSummary
              : null,
          bullets,
          bulletSourceAchievementIds: bullets.map(
            (bullet) => sourceIdsByText.get(bullet) ?? [],
          ),
          profileRecordId: experience.id,
        },
      ];
    });
  const projectEntries = input.profile.projects
    .map((project, index) => ({
      project,
      index,
      score: scoreTargetRelevance(
        [
          project.name,
          project.role,
          project.summary,
          project.outcome,
          ...project.skills,
        ]
          .filter(Boolean)
          .join(" "),
        targetTerms,
      ),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 2)
    .map(({ project }) => ({
      name: project.name,
      role: project.role,
      summary: project.summary,
      outcome: project.outcome,
      bullets: [],
      profileRecordId: project.id,
    }));
  const educationEntries = input.profile.education.map((entry) => ({
    school: entry.schoolName,
    degree: entry.degree,
    fieldOfStudy: entry.fieldOfStudy,
    location: entry.location,
    dateRange: formatDateRange(entry.startDate, entry.endDate),
    summary: entry.summary,
    profileRecordId: entry.id,
  }));
  const certificationEntries = input.profile.certifications.map((entry) => ({
    name: entry.name,
    issuer: entry.issuer,
    dateRange: formatDateRange(entry.issueDate, entry.expiryDate),
    profileRecordId: entry.id,
  }));
  const fullText = buildDeterministicResumeText(
    input.profile,
    input.job,
    summary,
    experienceHighlights,
    coreSkills,
    targetedKeywords,
    experienceEntries,
    projectEntries,
    educationEntries,
    certificationEntries,
    additionalSkills,
    languages,
    strategyHeadline(input),
  );

  return TailoredResumeDraftSchema.parse({
    label: "Tailored Resume",
    summary,
    experienceHighlights,
    coreSkills,
    targetedKeywords,
    experienceEntries,
    projectEntries,
    educationEntries,
    certificationEntries,
    coverageMetadata,
    additionalSkills,
    languages,
    fullText,
    compatibilityScore: clampScore(
      78 + Math.min(input.job.keySkills.length * 3, 18),
    ),
    notes: [
      "Used the built-in deterministic resume tailorer.",
      ...(input.strategy
        ? [
            `Applied resume strategy "${input.strategy.strategyName}" (${input.strategy.effectiveSource}: ${input.strategy.effectiveReason}).`,
            `Strategy policies: ${input.strategy.headlinePolicy} headline, ${input.strategy.skillsPolicy} skills, ${input.strategy.coveragePolicy} coverage, ${input.strategy.tailoringStrength} tailoring.`,
          ]
        : []),
    ],
  });
}

export function composeDeterministicFullText(input: {
  coreSkills: readonly string[];
  experienceHighlights: readonly string[];
  experienceEntries?: readonly {
    title: string | null;
    employer: string | null;
    location: string | null;
    dateRange: string | null;
    summary: string | null;
    bullets: readonly string[];
  }[];
  projectEntries?: readonly {
    name: string | null;
    role: string | null;
    summary: string | null;
    outcome: string | null;
    bullets: readonly string[];
  }[];
  educationEntries?: readonly {
    school: string | null;
    degree: string | null;
    fieldOfStudy: string | null;
    location: string | null;
    dateRange: string | null;
    summary: string | null;
  }[];
  certificationEntries?: readonly {
    name: string | null;
    issuer: string | null;
    dateRange: string | null;
  }[];
  additionalSkills?: readonly string[];
  languages?: readonly string[];
  label?: string | null;
  notes?: readonly string[];
  summary: string;
  targetedKeywords: readonly string[];
}) {
  const stringifyEntry = (parts: readonly (string | null | undefined)[]) =>
    parts.filter(Boolean).join(" | ");
  const candidateFacingTargetedKeywords = filterCandidateFacingResumeKeywords(
    input.targetedKeywords,
  );

  return [
    input.label ?? null,
    input.summary,
    ...(input.experienceEntries ?? []).flatMap((entry) => [
      stringifyEntry([
        entry.title,
        entry.employer,
        entry.location,
        entry.dateRange,
      ]),
      entry.summary,
      ...entry.bullets,
    ]),
    ...input.experienceHighlights,
    input.coreSkills.length > 0
      ? `Core skills: ${input.coreSkills.join(", ")}`
      : null,
    input.additionalSkills && input.additionalSkills.length > 0
      ? `Additional skills: ${input.additionalSkills.join(", ")}`
      : null,
    input.languages && input.languages.length > 0
      ? `Languages: ${input.languages.join(", ")}`
      : null,
    ...(input.projectEntries ?? []).flatMap((entry) => [
      stringifyEntry([entry.name, entry.role]),
      [entry.summary, entry.outcome].filter(Boolean).join(" "),
      ...entry.bullets,
    ]),
    ...(input.educationEntries ?? []).flatMap((entry) => [
      stringifyEntry([
        entry.school,
        [entry.degree, entry.fieldOfStudy].filter(Boolean).join(", "),
        entry.location,
        entry.dateRange,
      ]),
      entry.summary,
    ]),
    ...(input.certificationEntries ?? []).map((entry) =>
      stringifyEntry([entry.name, entry.issuer, entry.dateRange]),
    ),
    candidateFacingTargetedKeywords.length > 0
      ? `Targeted keywords: ${candidateFacingTargetedKeywords.join(", ")}`
      : null,
    ...(input.notes ?? []),
  ]
    .filter((entry): entry is string =>
      Boolean(entry && entry.trim().length > 0),
    )
    .join("\n\n");
}

export function buildDeterministicStructuredResumeDraft(
  input: CreateResumeDraftInput,
) {
  const baseDraft = buildDeterministicTailoredResume(input);
  const evidence = input.evidence;
  const researchTerms = uniqueStrings([
    ...(input.researchContext?.domainVocabulary ?? []),
    ...(input.researchContext?.priorityThemes ?? []),
  ]).slice(0, 6);
  const summary = baseDraft.summary;
  const experienceHighlights: string[] = [];
  const coreSkills = input.strategy
    ? baseDraft.coreSkills
    : filterGroundedVisibleSkills(
        input.profile,
        orderSkillsByJobRelevance(
          [...(evidence?.skills ?? []), ...baseDraft.coreSkills],
          input.job,
        ),
        VISIBLE_CORE_SKILL_LIMIT,
      );
  const targetedKeywords = filterCandidateFacingResumeKeywords(
    input.strategy
      ? baseDraft.targetedKeywords
      : uniqueStrings([
          ...(evidence?.keywords ?? []),
          ...researchTerms,
          ...baseDraft.targetedKeywords,
        ]).slice(0, 8),
  );
  const notes = uniqueStrings([
    ...baseDraft.notes,
    ...(researchTerms.length > 0
      ? [
          "Incorporated bounded employer research vocabulary into deterministic draft creation.",
        ]
      : []),
  ]);
  const fullText = composeDeterministicFullText({
    label: baseDraft.label,
    summary,
    experienceHighlights,
    coreSkills,
    experienceEntries: baseDraft.experienceEntries,
    projectEntries: baseDraft.projectEntries,
    educationEntries: baseDraft.educationEntries,
    certificationEntries: baseDraft.certificationEntries,
    additionalSkills: baseDraft.additionalSkills,
    languages: baseDraft.languages,
    targetedKeywords,
    notes,
  });

  return TailoredResumeDraftSchema.parse({
    ...baseDraft,
    summary,
    experienceHighlights,
    coreSkills,
    targetedKeywords,
    experienceEntries: baseDraft.experienceEntries,
    projectEntries: baseDraft.projectEntries,
    educationEntries: baseDraft.educationEntries,
    certificationEntries: baseDraft.certificationEntries,
    additionalSkills: baseDraft.additionalSkills,
    languages: baseDraft.languages,
    fullText,
    notes,
  });
}

export function buildDeterministicResumeAssistantReply(
  input: ReviseResumeDraftInput,
): ResumeAssistantReply {
  const lowerRequest = input.request.toLowerCase();
  const patches: ResumeDraftPatch[] = [];
  const summarySection =
    input.draft.sections.find((section) => section.kind === "summary") ?? null;
  const experienceSection =
    input.draft.sections.find((section) => section.kind === "experience") ??
    null;

  const isSummaryShorteningRequest =
    /\bshort(?:en|er)?\b.*\bsummary\b|\bsummary\b.*\bshort(?:en|er)?\b/.test(
      lowerRequest,
    );

  if (
    summarySection &&
    !summarySection.locked &&
    (lowerRequest.includes("summary") ||
      lowerRequest.includes("ats") ||
      isSummaryShorteningRequest)
  ) {
    const currentSummary =
      summarySection.text ?? `${input.job.title} alignment summary`;
    const tightenedSummary = tightenSentence(currentSummary);
    if (tightenedSummary !== currentSummary) {
      patches.push({
        id: createPatchId("assistant_patch_summary"),
        draftId: input.draft.id,
        operation: "replace_section_text",
        targetSectionId: summarySection.id,
        targetEntryId: null,
        anchorEntryId: null,
        targetBulletId: null,
        anchorBulletId: null,
        position: null,
        newText: tightenedSummary,
        newIncluded: null,
        newLocked: null,
        newBullets: null,
        appliedAt: new Date().toISOString(),
        origin: "assistant",
        conflictReason: null,
      });
    }
  }

  const isExperienceShorteningRequest =
    lowerRequest.includes("shorten") &&
    (lowerRequest.includes("experience") || lowerRequest.includes("bullet"));

  if (
    experienceSection &&
    !experienceSection.locked &&
    (lowerRequest.includes("bullet") ||
      lowerRequest.includes("experience") ||
      isExperienceShorteningRequest)
  ) {
    const ordinalPatterns = [
      "first",
      "1st",
      "second",
      "2nd",
      "third",
      "3rd",
      "fourth",
      "4th",
    ];
    const requestedOrdinalIndex = ordinalPatterns.findIndex((pattern) =>
      lowerRequest.includes(pattern),
    );
    const unlockedEntryBullets = experienceSection.entries.flatMap((entry) =>
      entry.locked
        ? []
        : entry.bullets
            .filter((bullet) => !bullet.locked)
            .map((bullet) => ({ bullet, entryId: entry.id })),
    );
    const unlockedBullets = experienceSection.bullets
      .filter((bullet) => !bullet.locked)
      .map((bullet) => ({ bullet, entryId: null as string | null }));
    const candidateBullets =
      unlockedEntryBullets.length > 0 ? unlockedEntryBullets : unlockedBullets;
    const keywordMatchedBullet =
      candidateBullets.find((item) =>
        item.bullet.text
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((token) => token.length >= 3)
          .some((token) => lowerRequest.includes(token)),
      ) ?? null;
    const targetBullet =
      requestedOrdinalIndex >= 0
        ? (candidateBullets[requestedOrdinalIndex] ?? null)
        : (keywordMatchedBullet ?? candidateBullets[0] ?? null);

    if (targetBullet) {
      const tightenedBullet = tightenSentence(targetBullet.bullet.text);
      if (tightenedBullet === targetBullet.bullet.text) {
        return ResumeAssistantReplySchema.parse({
          content:
            "I could not safely turn that request into a grounded patch, so no changes were applied.",
          patches,
        });
      }

      patches.push({
        id: createPatchId("assistant_patch_bullet"),
        draftId: input.draft.id,
        operation: "update_bullet",
        targetSectionId: experienceSection.id,
        targetEntryId: targetBullet.entryId,
        anchorEntryId: null,
        targetBulletId: targetBullet.bullet.id,
        anchorBulletId: null,
        position: null,
        newText: tightenedBullet,
        newIncluded: null,
        newLocked: null,
        newBullets: null,
        appliedAt: new Date().toISOString(),
        origin: "assistant",
        conflictReason: null,
      });
    }
  }

  const content = patches.length
    ? // Grounded-ness is decided by the export gate in Job Finder, not here: the
      // provider only reports how many edits it proposed.
      `Prepared ${patches.length} proposed resume edit${patches.length === 1 ? "" : "s"} for your review.`
    : "I could not safely turn that request into a grounded patch, so no changes were applied.";

  return ResumeAssistantReplySchema.parse({
    content,
    patches,
  });
}

function tightenSentence(value: string): string {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/\b(aligned to|tailored for|focused on)\b/gi, "for")
    .trim()
    .replace(/[.]{2,}/g, ".");

  if (normalized.length <= 240) {
    return /[.!?;]$/.test(normalized) ? normalized : `${normalized}.`;
  }

  const maximumContentLength = 239;
  const window = normalized.slice(0, maximumContentLength);
  const boundaryCandidates = [
    ...window.matchAll(/[.!?](?=\s|$)/g),
    ...window.matchAll(/[,;:](?=\s|$)/g),
    ...window.matchAll(/[—–](?=\s|$)/g),
    ...window.matchAll(/\s+(?=(?:and|but|while|whereas|which|who|that)\b)/gi),
  ]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined && index >= 55)
    .sort((left, right) => right - left);

  for (const boundaryIndex of boundaryCandidates) {
    const candidate = window
      .slice(0, boundaryIndex + 1)
      .trim()
      .replace(/[,;:—–-]+$/, "")
      .trim();

    if (
      candidate.length >= 55 &&
      !/\b(?:and|but|for|or|nor|to|with|who|which|that)$/i.test(candidate)
    ) {
      return /[.!?]$/.test(candidate) ? candidate : `${candidate}.`;
    }
  }

  // Returning the complete normalized sentence is safer than manufacturing a
  // fragment when the source contains no sentence or clause boundary.
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}
