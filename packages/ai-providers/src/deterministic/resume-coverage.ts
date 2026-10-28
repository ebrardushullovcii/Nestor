import type {
  CandidateProfile,
  JobPosting,
  JobSearchPreferences,
  ResumeCareerFamilyFit,
  ResumeCoverageClassification,
  ResumeCoverageDecision,
} from "@nestor/contracts";

interface WorkHistoryRange {
  startMonth: number | null;
  endMonth: number | null;
  sortMonth: number;
}

interface ScoredExperience {
  experience: CandidateProfile["experiences"][number];
  originalIndex: number;
  range: WorkHistoryRange;
  careerFamilyFit: ResumeCareerFamilyFit;
  hasGroundedTechnicalEvidence: boolean;
}

const MEANINGFUL_GAP_MONTHS = 6;

const STOP_WORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "into",
  "role",
  "roles",
  "senior",
  "staff",
  "principal",
  "lead",
  "manager",
  "specialist",
  "remote",
  "hybrid",
  "onsite",
  "full",
  "time",
]);

const FAMILY_TERMS: Record<string, readonly string[]> = {
  software: [
    "api",
    "application",
    "automation",
    "backend",
    "cloud",
    "code",
    "coding",
    "database",
    "developer",
    "devops",
    "dotnet",
    "engineer",
    "engineering",
    "frontend",
    "front-end",
    "fullstack",
    "full-stack",
    "javascript",
    "kubernetes",
    "microservices",
    "platform",
    "programmer",
    "python",
    "react",
    "software",
    "system",
    "systems",
    "typescript",
    "web",
  ],
  data: [
    "analytics",
    "analyst",
    "bi",
    "dashboard",
    "data",
    "dbt",
    "experiment",
    "experimentation",
    "looker",
    "metrics",
    "python",
    "sql",
  ],
  design: [
    "accessibility",
    "designer",
    "design",
    "figma",
    "product",
    "prototype",
    "research",
    "ui",
    "user",
    "ux",
  ],
  product: [
    "customer",
    "growth",
    "market",
    "operations",
    "product",
    "roadmap",
    "saas",
    "stakeholder",
    "strategy",
    "workflow",
  ],
};

const BROAD_TECHNICAL_TERMS = new Set(
  Object.values(FAMILY_TERMS).flatMap((terms) => terms),
);

function tokenizeForCoverage(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .replace(/\.net/g, " dotnet ")
    .replace(/c#/g, " csharp ")
    .replace(/node\.js/g, " nodejs ")
    .replace(/next\.js/g, " nextjs ")
    .replace(/[^a-z0-9+#.-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function uniqueTokens(
  values: readonly (string | null | undefined)[],
): string[] {
  return [...new Set(values.flatMap((value) => tokenizeForCoverage(value)))];
}

function normalizePhrase(value: string): string {
  return tokenizeForCoverage(value).join(" ");
}

function countOverlap(
  left: readonly string[],
  right: ReadonlySet<string>,
): number {
  return left.filter((token) => right.has(token)).length;
}

function detectTargetFamilies(tokens: ReadonlySet<string>): string[] {
  const detected = Object.entries(FAMILY_TERMS).flatMap(([family, terms]) => {
    const hits = terms.filter((term) =>
      tokens.has(normalizePhrase(term)),
    ).length;
    return hits > 0 ? [family] : [];
  });

  return detected.length > 0
    ? detected
    : ["software", "data", "design", "product"];
}

function parseMonthIndex(value: string | null | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  if (/^(present|current|now)$/i.test(trimmed)) {
    return Number.MAX_SAFE_INTEGER;
  }

  const monthYearMatch = /^(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (monthYearMatch) {
    const month = Number(monthYearMatch[1]);
    if (month >= 1 && month <= 12) {
      return Number(monthYearMatch[2]) * 12 + month;
    }
  }

  const yearMonthMatch = /^(\d{4})-(\d{2})/.exec(trimmed);
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
  const namedMonthMatch = /^([a-zA-Z]+)\.?\s+(\d{4})$/.exec(trimmed);
  if (namedMonthMatch) {
    const month = monthByName[namedMonthMatch[1]?.toLowerCase() ?? ""];
    if (month) {
      return Number(namedMonthMatch[2]) * 12 + month;
    }
  }

  return null;
}

function getRange(
  experience: CandidateProfile["experiences"][number],
): WorkHistoryRange {
  const startMonth = parseMonthIndex(experience.startDate);
  const endMonth = experience.isCurrent
    ? Number.MAX_SAFE_INTEGER
    : (parseMonthIndex(experience.endDate) ?? startMonth);

  return {
    startMonth,
    endMonth,
    sortMonth: endMonth ?? startMonth ?? Number.MIN_SAFE_INTEGER,
  };
}

function buildExperienceText(
  experience: CandidateProfile["experiences"][number],
): string {
  return [
    experience.title,
    experience.companyName,
    experience.employmentType,
    experience.summary,
    ...experience.achievements,
    ...experience.skills,
    ...experience.domainTags,
    experience.peopleManagementScope,
    experience.ownershipScope,
  ]
    .filter(Boolean)
    .join(" ");
}

function hasUsableWorkHistory(
  experience: CandidateProfile["experiences"][number],
): boolean {
  return Boolean(experience.title?.trim());
}

function hasSkillPhraseOverlap(input: {
  experience: CandidateProfile["experiences"][number];
  job: Pick<JobPosting, "keySkills">;
}): boolean {
  const roleText = normalizePhrase(buildExperienceText(input.experience));
  const paddedRoleText = ` ${roleText} `;
  return input.job.keySkills.some((skill) => {
    const normalizedSkill = normalizePhrase(skill);
    return (
      normalizedSkill.length > 0 &&
      paddedRoleText.includes(` ${normalizedSkill} `)
    );
  });
}

function classifyCareerFamilyFit(input: {
  experience: CandidateProfile["experiences"][number];
  job: Pick<JobPosting, "keySkills">;
  targetTokens: ReadonlySet<string>;
  targetFamilies: readonly string[];
}): Pick<ScoredExperience, "careerFamilyFit" | "hasGroundedTechnicalEvidence"> {
  const roleTokens = uniqueTokens([buildExperienceText(input.experience)]);
  const roleTokenSet = new Set(roleTokens);
  const titleTokens = new Set(tokenizeForCoverage(input.experience.title));
  const targetOverlap = countOverlap(roleTokens, input.targetTokens);
  const hasSkillOverlap = hasSkillPhraseOverlap({
    experience: input.experience,
    job: input.job,
  });
  const familyHits = input.targetFamilies.reduce((count, family) => {
    const terms = FAMILY_TERMS[family] ?? [];
    return (
      count +
      terms.filter((term) => roleTokenSet.has(normalizePhrase(term))).length
    );
  }, 0);
  const titleFamilyHits = input.targetFamilies.reduce((count, family) => {
    const terms = FAMILY_TERMS[family] ?? [];
    return (
      count +
      terms.filter((term) => titleTokens.has(normalizePhrase(term))).length
    );
  }, 0);
  const broadTechnicalHits = roleTokens.filter((token) =>
    BROAD_TECHNICAL_TERMS.has(token),
  ).length;
  const hasGroundedTechnicalEvidence =
    broadTechnicalHits > 0 ||
    input.experience.skills.length > 0 ||
    input.experience.domainTags.length > 0 ||
    /\b(api|automation|database|software|system|web|workflow|platform|dashboard|application|cloud|deploy|test|qa|performance|accessibility|design system)\b/i.test(
      buildExperienceText(input.experience),
    );

  if (hasSkillOverlap || titleFamilyHits > 0 || targetOverlap >= 3) {
    return {
      careerFamilyFit: "strong",
      hasGroundedTechnicalEvidence,
    };
  }

  if (targetOverlap > 0 || familyHits > 0 || hasGroundedTechnicalEvidence) {
    return {
      careerFamilyFit: "weak",
      hasGroundedTechnicalEvidence,
    };
  }

  return {
    careerFamilyFit: "unrelated",
    hasGroundedTechnicalEvidence,
  };
}

function overlapsGap(input: {
  candidate: ScoredExperience;
  newer: ScoredExperience;
  older: ScoredExperience;
}): boolean {
  const newerStart = input.newer.range.startMonth;
  const olderEnd = input.older.range.endMonth;
  const candidateStart = input.candidate.range.startMonth;
  const candidateEnd = input.candidate.range.endMonth;

  if (
    newerStart === null ||
    olderEnd === null ||
    candidateStart === null ||
    candidateEnd === null ||
    olderEnd === Number.MAX_SAFE_INTEGER
  ) {
    return false;
  }

  const gapMonths = newerStart - olderEnd - 1;
  if (gapMonths < MEANINGFUL_GAP_MONTHS) {
    return false;
  }

  const gapStart = olderEnd + 1;
  const gapEnd = newerStart - 1;

  return candidateStart <= gapEnd && candidateEnd >= gapStart;
}

function coversMeaningfulGap(input: {
  candidate: ScoredExperience;
  defaultIncluded: readonly ScoredExperience[];
}): boolean {
  const sortedIncluded = [...input.defaultIncluded].sort(
    (left, right) => right.range.sortMonth - left.range.sortMonth,
  );

  for (let index = 0; index < sortedIncluded.length - 1; index += 1) {
    const newer = sortedIncluded[index];
    const older = sortedIncluded[index + 1];

    if (!newer || !older) {
      continue;
    }

    if (overlapsGap({ candidate: input.candidate, newer, older })) {
      return true;
    }
  }

  return false;
}

function buildTargetTokens(input: {
  profile: Pick<CandidateProfile, "targetRoles">;
  searchPreferences: Pick<JobSearchPreferences, "targetRoles" | "jobFamilies">;
  job: Pick<
    JobPosting,
    | "title"
    | "keySkills"
    | "summary"
    | "responsibilities"
    | "minimumQualifications"
    | "preferredQualifications"
  >;
}): string[] {
  return uniqueTokens([
    input.job.title,
    input.job.summary,
    ...input.job.keySkills,
    ...input.job.responsibilities,
    ...input.job.minimumQualifications,
    ...input.job.preferredQualifications,
    ...input.searchPreferences.targetRoles,
    ...input.searchPreferences.jobFamilies,
    ...input.profile.targetRoles,
  ]);
}

function buildTargetFamilyTokens(input: {
  profile: Pick<CandidateProfile, "targetRoles">;
  searchPreferences: Pick<JobSearchPreferences, "targetRoles" | "jobFamilies">;
  job: Pick<JobPosting, "title" | "keySkills">;
}): string[] {
  return uniqueTokens([
    input.job.title,
    ...input.job.keySkills,
    ...input.searchPreferences.targetRoles,
    ...input.searchPreferences.jobFamilies,
    ...input.profile.targetRoles,
  ]);
}

function buildGuidance(input: {
  classification: ResumeCoverageClassification;
  careerFamilyFit: ResumeCareerFamilyFit;
  coversMeaningfulGap: boolean;
  isOlderStrongFit: boolean;
  tailoringMode: JobSearchPreferences["tailoringMode"];
}): string[] {
  const guidance: string[] = [];

  if (input.classification === "suggested_hidden") {
    if (input.coversMeaningfulGap) {
      guidance.push(
        "Hidden by default for review: this role can close a meaningful work-history gap, but it should stay compact if shown.",
      );
    } else {
      guidance.push(
        "Hidden by default for review: this role has a weaker career-family fit for the target job.",
      );
    }
  }

  if (input.classification === "compact") {
    if (input.coversMeaningfulGap) {
      guidance.push(
        "Compact gap-coverage role: keep it brief unless the employer needs full continuity.",
      );
    } else if (input.careerFamilyFit === "weak") {
      guidance.push(
        input.tailoringMode === "aggressive"
          ? "Compact strong-rewrite role: phrasing is grounded in stored facts, so review before expanding it."
          : "Compact weak-fit role: keep only the most grounded transferable detail.",
      );
    } else if (input.careerFamilyFit === "unrelated") {
      guidance.push(
        "Compact continuity role: preserve the grounded title, employer, dates, and only verified detail.",
      );
    } else if (input.isOlderStrongFit) {
      guidance.push(
        "Compact older strong-fit role: included for career coverage without crowding recent experience.",
      );
    }
  }

  return guidance;
}

export function deriveResumeCoveragePlan(input: {
  profile: Pick<CandidateProfile, "experiences" | "targetRoles">;
  searchPreferences: Pick<
    JobSearchPreferences,
    "targetRoles" | "jobFamilies" | "tailoringMode"
  >;
  job: Pick<
    JobPosting,
    | "title"
    | "keySkills"
    | "summary"
    | "responsibilities"
    | "minimumQualifications"
    | "preferredQualifications"
  >;
}): ResumeCoverageDecision[] {
  const targetTokens = new Set(buildTargetTokens(input));
  const targetFamilies = detectTargetFamilies(
    new Set(buildTargetFamilyTokens(input)),
  );
  const scored = input.profile.experiences
    .map((experience, originalIndex): ScoredExperience => {
      const fit = classifyCareerFamilyFit({
        experience,
        job: input.job,
        targetTokens,
        targetFamilies,
      });

      return {
        experience,
        originalIndex,
        range: getRange(experience),
        ...fit,
      };
    })
    .sort((left, right) => {
      const dateSort = right.range.sortMonth - left.range.sortMonth;
      return dateSort === 0
        ? left.originalIndex - right.originalIndex
        : dateSort;
    });
  const strongFit = scored.filter(
    (entry) => entry.careerFamilyFit === "strong",
  );
  const defaultIncluded = scored.filter(
    (entry) =>
      entry.careerFamilyFit === "strong" ||
      hasUsableWorkHistory(entry.experience),
  );
  const strongRankById = new Map(
    strongFit.map((entry, index) => [entry.experience.id, index]),
  );

  return scored.map((entry): ResumeCoverageDecision => {
    const strongRank = strongRankById.get(entry.experience.id) ?? -1;
    // Keep strongRank === 1 as a compact-only case: only isOlderStrongFit feeds the
    // older-fit guidance path in buildGuidance(...), so guidance starts at strongRank >= 2.
    const isOlderStrongFit =
      entry.careerFamilyFit === "strong" && strongRank >= 2;
    const isDetailedStrongFit =
      entry.careerFamilyFit === "strong" &&
      (entry.experience.isCurrent || strongRank === 0);
    const coversGap =
      entry.careerFamilyFit !== "strong" &&
      coversMeaningfulGap({
        candidate: entry,
        defaultIncluded: defaultIncluded.filter(
          (included) => included.experience.id !== entry.experience.id,
        ),
      });
    let classification: ResumeCoverageClassification;
    const reasons: string[] = [];

    if (isDetailedStrongFit) {
      classification = "detailed";
      reasons.push("closest to the job you want, and recent");
    } else if (entry.careerFamilyFit === "strong") {
      classification = "compact";
      reasons.push("close to the job you want, but older");
    } else if (coversGap) {
      reasons.push("kept so a 6+ month gap in your dates is covered");
      classification = hasUsableWorkHistory(entry.experience)
        ? "compact"
        : "suggested_hidden";
    } else if (
      entry.careerFamilyFit === "weak" &&
      entry.hasGroundedTechnicalEvidence
    ) {
      reasons.push(
        "further from this job, but the technical detail is backed by your saved evidence",
      );
      classification = "compact";
    } else if (entry.careerFamilyFit === "weak") {
      reasons.push(
        "further from this job, with little role-specific detail saved",
      );
      // Aggressive keeps the role visible for continuity; hiding it left the
      // person's real experience off the resume or showed a title with no
      // bullets. Length is settled by bullets, not by dropping the role.
      classification = hasUsableWorkHistory(entry.experience)
        ? "compact"
        : "omitted";
    } else {
      reasons.push("not close to this job and not needed to cover a gap");
      classification = hasUsableWorkHistory(entry.experience)
        ? "compact"
        : "omitted";
    }

    if (coversGap) {
      reasons.push("covers a meaningful work-history gap");
    }

    return {
      profileRecordId: entry.experience.id,
      classification,
      careerFamilyFit: entry.careerFamilyFit,
      reasons,
      reviewGuidance: buildGuidance({
        classification,
        careerFamilyFit: entry.careerFamilyFit,
        coversMeaningfulGap: coversGap,
        isOlderStrongFit,
        tailoringMode: input.searchPreferences.tailoringMode,
      }),
      coversMeaningfulGap: coversGap,
    };
  });
}
