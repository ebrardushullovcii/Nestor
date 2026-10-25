import type { ResumeProfileExtraction } from "../shared";
import { ResumeProfileExtractionSchema } from "../shared";
import { uniqueStrings } from "./utils";

function pickNullableValue<TValue>(
  primaryValue: TValue | null | undefined,
  fallbackValue: TValue | null | undefined,
  preferFallbackValues: boolean,
): TValue | null {
  return preferFallbackValues
    ? (fallbackValue ?? primaryValue ?? null)
    : (primaryValue ?? fallbackValue ?? null);
}

function pickArrayValue<TValue>(
  primaryValue: readonly TValue[],
  fallbackValue: readonly TValue[] | undefined,
  preferFallbackValues: boolean,
): TValue[] {
  if (preferFallbackValues) {
    return fallbackValue && fallbackValue.length > 0
      ? [...fallbackValue]
      : [...primaryValue];
  }

  return primaryValue.length > 0 ? [...primaryValue] : [...(fallbackValue ?? [])];
}

function normalizeComparableText(value: string | null): string {
  return value?.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() ?? "";
}

function textsOverlap(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);

  if (!normalizedLeft || !normalizedRight) {
    return false;
  }

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft)
  );
}

function datesCompatible(left: string | null, right: string | null): boolean {
  return left === right || !left || !right;
}

function findExperienceMatchIndex(
  entry: ResumeProfileExtraction["experiences"][number],
  fallback: readonly ResumeProfileExtraction["experiences"][number][],
  matchedFallbackIndices: ReadonlySet<number>,
): number {
  const exactMatchIndex = fallback.findIndex((fb, idx) => {
    if (matchedFallbackIndices.has(idx)) return false;
    const titleMatch =
      (entry.title && fb.title && entry.title.toLowerCase() === fb.title.toLowerCase()) ||
      (!entry.title && !fb.title);
    const startMatch =
      (entry.startDate && fb.startDate && entry.startDate === fb.startDate) ||
      (!entry.startDate && !fb.startDate);
    return titleMatch && startMatch;
  });

  if (exactMatchIndex !== -1) {
    return exactMatchIndex;
  }

  return fallback.findIndex((fb, idx) => {
    if (matchedFallbackIndices.has(idx)) return false;

    const titleMatch = textsOverlap(entry.title, fb.title);
    const companyMatch = textsOverlap(entry.companyName, fb.companyName);

    return (
      (titleMatch && datesCompatible(entry.startDate, fb.startDate)) ||
      (companyMatch && datesCompatible(entry.startDate, fb.startDate)) ||
      (titleMatch && companyMatch)
    );
  });
}

function findEducationMatchIndex(
  entry: ResumeProfileExtraction["education"][number],
  fallback: readonly ResumeProfileExtraction["education"][number][],
  matchedFallbackIndices: ReadonlySet<number>,
): number {
  const normalize = (s: string | null) => s?.toLowerCase().trim() ?? "";

  const exactMatchIndex = fallback.findIndex((fb, idx) => {
    if (matchedFallbackIndices.has(idx)) return false;
    return normalize(entry.schoolName) === normalize(fb.schoolName) && normalize(entry.location) === normalize(fb.location);
  });

  if (exactMatchIndex !== -1) {
    return exactMatchIndex;
  }

  return fallback.findIndex((fb, idx) => {
    if (matchedFallbackIndices.has(idx)) return false;

    const schoolMatch = textsOverlap(entry.schoolName, fb.schoolName);
    const locationMatch = datesCompatible(entry.location, fb.location) || textsOverlap(entry.location, fb.location);

    return schoolMatch && locationMatch;
  });
}

function mergeExperienceExtractionEntries(
  primary: readonly ResumeProfileExtraction["experiences"][number][],
  fallback: readonly ResumeProfileExtraction["experiences"][number][],
  preferFallbackValues = false,
) {
  if (primary.length === 0) {
    return fallback;
  }

  const matchedFallbackIndices = new Set<number>();
  const merged = primary.map((entry) => {
    const matchIndex = findExperienceMatchIndex(entry, fallback, matchedFallbackIndices);

    if (matchIndex !== -1) {
      matchedFallbackIndices.add(matchIndex);
    }

    const match = matchIndex !== -1 ? fallback[matchIndex] : null;

    return {
      ...entry,
      title: entry.title ?? match?.title ?? null,
      companyName: pickNullableValue(entry.companyName, match?.companyName, preferFallbackValues),
      companyUrl: pickNullableValue(entry.companyUrl, match?.companyUrl, preferFallbackValues),
      location: pickNullableValue(entry.location, match?.location, preferFallbackValues),
      workMode: pickArrayValue(entry.workMode, match?.workMode, preferFallbackValues),
      employmentType: pickNullableValue(entry.employmentType, match?.employmentType, preferFallbackValues),
      startDate: entry.startDate ?? match?.startDate ?? null,
      endDate: pickNullableValue(entry.endDate, match?.endDate, preferFallbackValues),
      isCurrent: (entry.isCurrent || match?.isCurrent) ?? false,
      summary: pickNullableValue(entry.summary, match?.summary, preferFallbackValues),
      achievements: pickArrayValue(entry.achievements, match?.achievements, preferFallbackValues),
      skills: pickArrayValue(entry.skills, match?.skills, preferFallbackValues),
      domainTags: pickArrayValue(entry.domainTags, match?.domainTags, preferFallbackValues),
      peopleManagementScope: pickNullableValue(entry.peopleManagementScope, match?.peopleManagementScope, preferFallbackValues),
      ownershipScope: pickNullableValue(entry.ownershipScope, match?.ownershipScope, preferFallbackValues),
    };
  });

  const unmatchedFallback = fallback.filter((_, idx) => !matchedFallbackIndices.has(idx));
  return [...merged, ...unmatchedFallback];
}

function mergeEducationExtractionEntries(
  primary: readonly ResumeProfileExtraction["education"][number][],
  fallback: readonly ResumeProfileExtraction["education"][number][],
  preferFallbackValues = false,
) {
  if (primary.length === 0) {
    return fallback;
  }

  const matchedFallbackIndices = new Set<number>();
  const merged = primary.map((entry) => {
    const matchIndex = findEducationMatchIndex(entry, fallback, matchedFallbackIndices);

    if (matchIndex !== -1) {
      matchedFallbackIndices.add(matchIndex);
    }

    const match = matchIndex !== -1 ? fallback[matchIndex] : null;

    return {
      ...entry,
      schoolName: pickNullableValue(entry.schoolName, match?.schoolName, preferFallbackValues),
      location: pickNullableValue(entry.location, match?.location, preferFallbackValues),
      summary: pickNullableValue(entry.summary, match?.summary, preferFallbackValues),
      degree: pickNullableValue(entry.degree, match?.degree, preferFallbackValues),
      fieldOfStudy: pickNullableValue(entry.fieldOfStudy, match?.fieldOfStudy, preferFallbackValues),
      startDate: pickNullableValue(entry.startDate, match?.startDate, preferFallbackValues),
      endDate: pickNullableValue(entry.endDate, match?.endDate, preferFallbackValues),
    };
  });

  const unmatchedFallback = fallback.filter((_, idx) => !matchedFallbackIndices.has(idx));
  return [...merged, ...unmatchedFallback];
}

function mergeLinkExtractionEntries(
  primary: readonly ResumeProfileExtraction["links"][number][],
  fallback: readonly ResumeProfileExtraction["links"][number][],
) {
  if (primary.length === 0) {
    return fallback;
  }

  const matchedFallbackIndices = new Set<number>();
  const merged = primary.map((entry, index) => {
    const matchIndex = entry.url == null
      ? (!matchedFallbackIndices.has(index) && index < fallback.length && fallback[index]?.url == null ? index : -1)
      : fallback.findIndex((candidate, fallbackIndex) => {
        return candidate.url === entry.url && !matchedFallbackIndices.has(fallbackIndex);
      });

    if (matchIndex !== -1) {
      matchedFallbackIndices.add(matchIndex);
    }

    const match = matchIndex !== -1 ? fallback[matchIndex] : null;

    return {
      ...entry,
      label: entry.label ?? match?.label ?? null,
      url: entry.url ?? match?.url ?? null,
      kind: entry.kind ?? match?.kind ?? null,
    };
  });

  const unmatchedFallback = fallback.filter((_, index) => !matchedFallbackIndices.has(index));
  return [...merged, ...unmatchedFallback];
}

function scoreExperienceEntries(entries: readonly ResumeProfileExtraction["experiences"][number][]): number {
  if (entries.length === 0) {
    return 0;
  }

  const total = entries.reduce((score, entry) => {
    return (
      score +
      (entry.companyName ? 2 : 0) +
      (entry.title ? 1 : 0) +
      (entry.location ? 1 : 0) +
      (entry.summary ? 2 : 0) +
      Math.min(entry.achievements.length, 2) +
      Math.min(entry.skills.length, 2)
    );
  }, 0);

  return total / entries.length;
}

function scoreEducationEntries(entries: readonly ResumeProfileExtraction["education"][number][]): number {
  if (entries.length === 0) {
    return 0;
  }

  const total = entries.reduce((score, entry) => {
    return score + (entry.schoolName ? 2 : 0) + (entry.degree ? 1 : 0) + (entry.fieldOfStudy ? 1 : 0);
  }, 0);

  return total / entries.length;
}

function choosePreferredHeadline(primary: string | null, fallback: string | null): string | null {
  if (!primary) {
    return fallback;
  }

  if (primary.length > 60 || primary.includes("|")) {
    return fallback ?? primary;
  }

  return primary;
}

export function completeResumeExtraction(
  primary: ResumeProfileExtraction,
  fallback: ResumeProfileExtraction,
): ResumeProfileExtraction {
  const preferFallbackExperiences = scoreExperienceEntries(primary.experiences) < scoreExperienceEntries(fallback.experiences);
  const preferFallbackEducation = scoreEducationEntries(primary.education) < scoreEducationEntries(fallback.education);
  const mergedExperiences = mergeExperienceExtractionEntries(
    primary.experiences,
    fallback.experiences,
    preferFallbackExperiences,
  );
  const mergedEducation = mergeEducationExtractionEntries(
    primary.education,
    fallback.education,
    preferFallbackEducation,
  );

  return ResumeProfileExtractionSchema.parse({
    ...primary,
    firstName: primary.firstName ?? fallback.firstName,
    lastName: primary.lastName ?? fallback.lastName,
    middleName: primary.middleName ?? fallback.middleName,
    fullName: primary.fullName ?? fallback.fullName,
    headline: choosePreferredHeadline(primary.headline, fallback.headline),
    summary: primary.summary ?? fallback.summary,
    currentLocation: primary.currentLocation ?? fallback.currentLocation,
    timeZone: primary.timeZone ?? fallback.timeZone,
    salaryCurrency: primary.salaryCurrency ?? fallback.salaryCurrency,
    yearsExperience: primary.yearsExperience ?? fallback.yearsExperience,
    email: primary.email ?? fallback.email,
    phone: primary.phone ?? fallback.phone,
    portfolioUrl: primary.portfolioUrl ?? fallback.portfolioUrl,
    linkedinUrl: primary.linkedinUrl ?? fallback.linkedinUrl,
    githubUrl: primary.githubUrl ?? fallback.githubUrl,
    personalWebsiteUrl: primary.personalWebsiteUrl ?? fallback.personalWebsiteUrl,
    professionalSummary: {
      shortValueProposition:
        primary.professionalSummary.shortValueProposition ?? fallback.professionalSummary.shortValueProposition,
      fullSummary: primary.professionalSummary.fullSummary ?? fallback.professionalSummary.fullSummary,
      careerThemes:
        primary.professionalSummary.careerThemes.length > 0
          ? primary.professionalSummary.careerThemes
          : fallback.professionalSummary.careerThemes,
      leadershipSummary:
        primary.professionalSummary.leadershipSummary ?? fallback.professionalSummary.leadershipSummary,
      domainFocusSummary:
        primary.professionalSummary.domainFocusSummary ?? fallback.professionalSummary.domainFocusSummary,
      strengths:
        primary.professionalSummary.strengths.length > 0
          ? primary.professionalSummary.strengths
          : fallback.professionalSummary.strengths,
    },
    skillGroups: {
      coreSkills:
        primary.skillGroups.coreSkills.length > 0 ? primary.skillGroups.coreSkills : fallback.skillGroups.coreSkills,
      tools: primary.skillGroups.tools.length > 0 ? primary.skillGroups.tools : fallback.skillGroups.tools,
      languagesAndFrameworks:
        primary.skillGroups.languagesAndFrameworks.length > 0
          ? primary.skillGroups.languagesAndFrameworks
          : fallback.skillGroups.languagesAndFrameworks,
      softSkills:
        primary.skillGroups.softSkills.length > 0 ? primary.skillGroups.softSkills : fallback.skillGroups.softSkills,
      highlightedSkills:
        primary.skillGroups.highlightedSkills.length > 0
          ? primary.skillGroups.highlightedSkills
          : fallback.skillGroups.highlightedSkills,
    },
    skills: uniqueStrings([...primary.skills, ...fallback.skills]),
    targetRoles: primary.targetRoles.length > 0 ? primary.targetRoles : fallback.targetRoles,
    preferredLocations:
      primary.preferredLocations.length > 0 ? primary.preferredLocations : fallback.preferredLocations,
    experiences: mergedExperiences,
    education: mergedEducation,
    certifications:
      primary.certifications.length > 0 ? primary.certifications : fallback.certifications,
    links: mergeLinkExtractionEntries(primary.links, fallback.links),
    projects: primary.projects.length > 0 ? primary.projects : fallback.projects,
    spokenLanguages:
      primary.spokenLanguages.length > 0 ? primary.spokenLanguages : fallback.spokenLanguages,
    notes: uniqueStrings([...primary.notes, ...fallback.notes]),
  });
}
