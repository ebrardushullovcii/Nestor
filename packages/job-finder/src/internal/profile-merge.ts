import { normalizePublicLinkUrl } from "@nestor/contracts";
import type {
  ResumeProfileExtraction,
  TailoredResumeDraft,
} from "@nestor/ai-providers";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  type CandidateProfile,
  type JobSearchPreferences,
  type SavedJob,
} from "@nestor/contracts";
import {
  areEquivalentEducationRecords,
  areEquivalentExperienceRecords,
  scoreEducationRecordCompleteness,
  scoreExperienceRecordCompleteness,
} from "./resume-record-identity";
import { inferAdministrativeAreaCountry } from "./location-normalization";
import { partitionStrengthsAndSkills } from "./profile-setup-strengths-partition";
import { normalizeText, uniqueStrings } from "./shared";

const KNOWN_COUNTRY_LIKE_LOCATION_PARTS = new Set([
  "kosovo",
  "albania",
  "germany",
  "france",
  "italy",
  "spain",
  "portugal",
  "netherlands",
  "belgium",
  "switzerland",
  "austria",
  "uk",
  "united kingdom",
  "england",
  "usa",
  "united states",
  "canada",
  "australia",
  "japan",
  "india",
  "singapore",
]);

export function buildTailoredResumeText(
  profile: CandidateProfile,
  job: SavedJob,
  previewSections: Array<{ heading: string; lines: string[] }>,
): string {
  const sections = previewSections
    .map(
      (section) => `${section.heading}
${section.lines.join("\n")}`,
    )
    .join("\n\n");

  return `${profile.fullName ?? ""}\n${profile.headline ?? ""}\n${profile.currentLocation ?? ""}\n\nTarget Role: ${job.title} at ${job.company}\n\n${sections}\n`;
}

export function buildPreviewSectionsFromDraft(draft: TailoredResumeDraft) {
  return [
    {
      heading: "Summary",
      lines: [draft.summary],
    },
    {
      heading: "Experience Highlights",
      lines: [...draft.experienceHighlights],
    },
    {
      heading: "Core Skills",
      lines: [...draft.coreSkills],
    },
    {
      heading: "Targeted Keywords",
      lines: [...draft.targetedKeywords],
    },
  ].filter((section) => section.lines.length > 0);
}

/**
 * The email and phone applications use usually repeat the primary ones. When
 * the primary changes in a save that leaves the application one alone, and
 * the application one was that old value (or empty), it follows. Otherwise
 * the person chose a different address on purpose and it stays. Without this
 * "my email is now ..." changed the profile while every application kept
 * sending the old address.
 */
export function followPrimaryContacts(
  currentProfile: CandidateProfile,
  nextProfile: CandidateProfile,
): CandidateProfile {
  const follow = (input: {
    currentPrimary: string | null;
    nextPrimary: string | null;
    currentPreferred: string | null;
    nextPreferred: string | null;
    normalize: (value: string | null) => string;
  }): string | null => {
    const primaryChanged =
      input.normalize(input.currentPrimary) !==
      input.normalize(input.nextPrimary);
    const preferredUntouched =
      input.normalize(input.currentPreferred) ===
      input.normalize(input.nextPreferred);
    const preferredMirroredPrimary =
      !input.normalize(input.currentPreferred) ||
      input.normalize(input.currentPreferred) ===
        input.normalize(input.currentPrimary);
    return primaryChanged && preferredUntouched && preferredMirroredPrimary
      ? input.nextPrimary
      : input.nextPreferred;
  };
  const preferredEmail = follow({
    currentPrimary: currentProfile.email,
    nextPrimary: nextProfile.email,
    currentPreferred: currentProfile.applicationIdentity.preferredEmail,
    nextPreferred: nextProfile.applicationIdentity.preferredEmail,
    normalize: (value) => normalizeText(value ?? ""),
  });
  const preferredPhone = follow({
    currentPrimary: currentProfile.phone,
    nextPrimary: nextProfile.phone,
    currentPreferred: currentProfile.applicationIdentity.preferredPhone,
    nextPreferred: nextProfile.applicationIdentity.preferredPhone,
    normalize: (value) => (value ?? "").replace(/\D/gu, ""),
  });
  if (
    preferredEmail === nextProfile.applicationIdentity.preferredEmail &&
    preferredPhone === nextProfile.applicationIdentity.preferredPhone
  ) {
    return nextProfile;
  }
  return {
    ...nextProfile,
    applicationIdentity: {
      ...nextProfile.applicationIdentity,
      preferredEmail,
      preferredPhone,
    },
  };
}

export function normalizeProfileBeforeSave(
  currentProfile: CandidateProfile,
  proposedProfile: CandidateProfile,
): CandidateProfile {
  const nextProfile = followPrimaryContacts(currentProfile, proposedProfile);
  const resumeChanged =
    currentProfile.baseResume.id !== nextProfile.baseResume.id ||
    currentProfile.baseResume.storagePath !==
      nextProfile.baseResume.storagePath ||
    currentProfile.baseResume.textContent !==
      nextProfile.baseResume.textContent;

  if (!resumeChanged) {
    return CandidateProfileSchema.parse(nextProfile);
  }

  const nextResumeText = nextProfile.baseResume.textContent;

  return CandidateProfileSchema.parse({
    ...nextProfile,
    baseResume: {
      ...nextProfile.baseResume,
      textUpdatedAt: nextResumeText ? new Date().toISOString() : null,
      extractionStatus: nextResumeText ? "not_started" : "needs_text",
      lastAnalyzedAt: null,
      analysisWarnings: [],
    },
  });
}

export function buildExtractionId(
  prefix: string,
  index: number,
  parts: ReadonlyArray<string | null | undefined>,
): string {
  const slug = parts
    .map((part) => normalizeText(part ?? "").replaceAll(" ", "_"))
    .filter(Boolean)
    .join("_")
    .slice(0, 48);

  return `${prefix}_${slug || index + 1}`;
}

/**
 * An id no other card in the list already has. Ids are built from the
 * record's own words, so a card the person reworded (a split role keeps its
 * old id) and the resume's original reading of it used to get the same id,
 * and the Profile editor could no longer tell the two cards apart.
 */
export function uniqueRecordId(
  records: ReadonlyArray<{ id: string }>,
  id: string,
): string {
  const taken = new Set(records.map((record) => record.id));
  if (!taken.has(id)) {
    return id;
  }
  let suffix = 2;
  while (taken.has(`${id}_${suffix}`)) {
    suffix += 1;
  }
  return `${id}_${suffix}`;
}

function keepMostCompleteInPlace<TRecord>(
  records: readonly TRecord[],
  isSameRecord: (left: TRecord, right: TRecord) => boolean,
  completeness: (record: TRecord) => number,
): TRecord[] {
  const kept: TRecord[] = [];
  for (const record of records) {
    const duplicateIndex = kept.findIndex((existing) =>
      isSameRecord(existing, record),
    );
    if (duplicateIndex === -1) {
      kept.push(record);
      continue;
    }
    const existing = kept[duplicateIndex];
    if (
      existing !== undefined &&
      completeness(record) > completeness(existing)
    ) {
      kept[duplicateIndex] = record;
    }
  }
  return kept;
}

export function normalizeRecordKey(
  parts: ReadonlyArray<string | null | undefined>,
): string {
  return parts
    .map((part) => normalizeText(part ?? ""))
    .filter(Boolean)
    .join("|");
}

function safeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry] : [],
  );
}

function preferLongerText(
  existing: string | null | undefined,
  incoming: string | null | undefined,
): string | null {
  const current = existing?.trim() ?? "";
  const next = incoming?.trim() ?? "";

  if (!current) {
    return next || null;
  }

  if (!next) {
    return current;
  }

  return next.length > current.length ? next : current;
}

function mergeWorkModes(
  existing: CandidateProfile["experiences"][number]["workMode"] | undefined,
  incoming: CandidateProfile["experiences"][number]["workMode"] | undefined,
): CandidateProfile["experiences"][number]["workMode"] {
  return [...new Set([...(existing ?? []), ...(incoming ?? [])])];
}

export function toValidUrlOrNull(
  value: string | null | undefined,
): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(normalizePublicLinkUrl(value)).toString();
  } catch {
    return null;
  }
}

const POSTAL_CODE_SUFFIX_PATTERN =
  /\s+(?:\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d|\d{4,6})$/;

/**
 * Removes a trailing postal code from an administrative-area token so an
 * imported line such as "Cedar Park, TX 78613" yields the region "TX" instead
 * of "TX 78613". The unsplit line stays available as the displayed location.
 */
function stripPostalCodeSuffix(part: string | null | undefined): string | null {
  if (!part) {
    return part ?? null;
  }

  const stripped = part.replace(POSTAL_CODE_SUFFIX_PATTERN, "").trim();
  return stripped.length > 0 ? stripped : part;
}

export function parseLocationParts(location: string | null | undefined): {
  currentCity: string | null;
  currentRegion: string | null;
  currentCountry: string | null;
} {
  if (!location) {
    return {
      currentCity: null,
      currentRegion: null,
      currentCountry: null,
    };
  }

  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return {
      currentCity: null,
      currentRegion: null,
      currentCountry: null,
    };
  }

  if (parts.length === 1) {
    return {
      currentCity: parts[0] ?? null,
      currentRegion: null,
      currentCountry: null,
    };
  }

  if (parts.length === 2) {
    const normalizedSecondPart = parts[1]?.toLowerCase() ?? "";

    if (KNOWN_COUNTRY_LIKE_LOCATION_PARTS.has(normalizedSecondPart)) {
      return {
        currentCity: parts[0] ?? null,
        currentRegion: null,
        currentCountry: parts[1] ?? null,
      };
    }

    const region = stripPostalCodeSuffix(parts[1]);

    return {
      currentCity: parts[0] ?? null,
      currentRegion: region,
      currentCountry: inferAdministrativeAreaCountry([region]),
    };
  }

  return {
    currentCity: parts[0] ?? null,
    currentRegion: stripPostalCodeSuffix(parts[1]),
    currentCountry: parts[parts.length - 1] ?? null,
  };
}

export function mergeExperienceRecords(
  existing: CandidateProfile["experiences"],
  extracted: ResumeProfileExtraction["experiences"],
): CandidateProfile["experiences"] {
  // Duplicate saved cards collapse into the more complete one, in the place
  // the first of them held: sorting by completeness first reordered the
  // person's whole work history on every import.
  const merged = keepMostCompleteInPlace(
    existing,
    areEquivalentExperienceRecords,
    scoreExperienceRecordCompleteness,
  );

  extracted.forEach((entry, index) => {
    const key = normalizeRecordKey([
      entry.companyName,
      entry.title,
      entry.startDate,
    ]);
    const matchIndex = merged.findIndex(
      (existingEntry) =>
        ("id" in entry && entry.id === existingEntry.id) ||
        normalizeRecordKey([
          existingEntry.companyName,
          existingEntry.title,
          existingEntry.startDate,
        ]) === key ||
        areEquivalentExperienceRecords(existingEntry, entry),
    );
    const match = matchIndex === -1 ? null : (merged[matchIndex] ?? null);
    const nextEntry = {
      id:
        match?.id ??
        uniqueRecordId(
          merged,
          buildExtractionId("experience", index, [
            entry.companyName,
            entry.title,
            entry.startDate,
          ]),
        ),
      companyName: entry.companyName ?? match?.companyName ?? null,
      companyUrl: entry.companyUrl ?? match?.companyUrl ?? null,
      title: entry.title ?? match?.title ?? null,
      employmentType: entry.employmentType ?? match?.employmentType ?? null,
      location: entry.location ?? match?.location ?? null,
      workMode: mergeWorkModes(match?.workMode, entry.workMode),
      startDate: entry.startDate ?? match?.startDate ?? null,
      endDate: entry.endDate ?? match?.endDate ?? null,
      isCurrent: entry.isCurrent,
      isDraft:
        !(entry.companyName ?? match?.companyName) &&
        !(entry.title ?? match?.title),
      summary: preferLongerText(match?.summary, entry.summary),
      achievements: uniqueStrings([
        ...safeStringArray(match?.achievements),
        ...safeStringArray(entry.achievements),
      ]),
      skills: uniqueStrings([
        ...safeStringArray(match?.skills),
        ...safeStringArray(entry.skills),
      ]),
      domainTags: uniqueStrings([
        ...safeStringArray(match?.domainTags),
        ...safeStringArray(entry.domainTags),
      ]),
      peopleManagementScope:
        entry.peopleManagementScope ?? match?.peopleManagementScope ?? null,
      ownershipScope: entry.ownershipScope ?? match?.ownershipScope ?? null,
    };

    if (matchIndex === -1) {
      merged.push(nextEntry);
      return;
    }

    merged.splice(matchIndex, 1, nextEntry);
  });

  return merged;
}

export function mergeEducationRecords(
  existing: CandidateProfile["education"],
  extracted: ResumeProfileExtraction["education"],
): CandidateProfile["education"] {
  const merged = keepMostCompleteInPlace(
    existing,
    areEquivalentEducationRecords,
    scoreEducationRecordCompleteness,
  );

  // The identity rules need a school. A record without one (a degree read
  // without its school) still matches the very same reading on re-import.
  const sameReading = (
    left: CandidateProfile["education"][number],
    right: ResumeProfileExtraction["education"][number],
  ) => {
    const key = (record: typeof left | typeof right) =>
      [
        record.schoolName,
        record.degree,
        record.fieldOfStudy,
        record.startDate,
        record.endDate,
      ]
        .map((part) => normalizeText(part ?? ""))
        .join("|");
    return (
      Boolean(left.degree || left.fieldOfStudy) && key(left) === key(right)
    );
  };

  extracted.forEach((entry, index) => {
    const matchIndex = merged.findIndex(
      (existingEntry) =>
        areEquivalentEducationRecords(existingEntry, entry) ||
        sameReading(existingEntry, entry),
    );
    const match = matchIndex === -1 ? null : (merged[matchIndex] ?? null);
    const nextEntry = {
      id:
        match?.id ??
        uniqueRecordId(
          merged,
          buildExtractionId("education", index, [
            entry.schoolName,
            entry.degree,
            entry.startDate,
          ]),
        ),
      schoolName: entry.schoolName ?? match?.schoolName ?? null,
      degree: entry.degree ?? match?.degree ?? null,
      fieldOfStudy: preferLongerText(match?.fieldOfStudy, entry.fieldOfStudy),
      location: entry.location ?? match?.location ?? null,
      startDate: entry.startDate ?? match?.startDate ?? null,
      endDate: entry.endDate ?? match?.endDate ?? null,
      isDraft: !(entry.schoolName ?? match?.schoolName),
      summary: preferLongerText(match?.summary, entry.summary),
    };

    if (matchIndex === -1) {
      merged.push(nextEntry);
      return;
    }

    merged.splice(matchIndex, 1, nextEntry);
  });

  return merged;
}

/**
 * The saved record an imported one updates: an exact match first; failing
 * that, the one record with the same name, when exactly one not already
 * matched in this import has it. Taking the first same-name card overwrote
 * a 2019 certificate with the 2022 one saved beside it.
 */
function findMatchingRecordIndex<T>(
  records: readonly T[],
  claimed: ReadonlySet<number>,
  isExactMatch: (record: T) => boolean,
  hasSameName: (record: T) => boolean,
): number {
  const exactIndex = records.findIndex(isExactMatch);
  if (exactIndex !== -1) {
    return exactIndex;
  }
  const sameName = records.flatMap((record, index) =>
    !claimed.has(index) && hasSameName(record) ? [index] : [],
  );
  return sameName.length === 1 ? (sameName[0] ?? -1) : -1;
}

/**
 * The import reads certificates; it never takes away the ones the person
 * already has. A second import used to replace the whole list with the
 * resume's, so a certificate added in Profile or by the Assistant vanished.
 * A reading that matches a saved certificate updates it; a new one is added.
 */
export function mergeCertificationRecords(
  existing: CandidateProfile["certifications"],
  extracted: ResumeProfileExtraction["certifications"],
): CandidateProfile["certifications"] {
  const next = [...existing];
  const claimed = new Set<number>();
  extracted.forEach((entry, index) => {
    const fullKey = normalizeRecordKey([
      entry.name,
      entry.issuer,
      entry.issueDate,
    ]);
    const nameKey = normalizeRecordKey([entry.name]);
    const matchIndex = findMatchingRecordIndex(
      next,
      claimed,
      (saved) =>
        normalizeRecordKey([saved.name, saved.issuer, saved.issueDate]) ===
        fullKey,
      (saved) =>
        nameKey.length > 0 && normalizeRecordKey([saved.name]) === nameKey,
    );
    const match = matchIndex === -1 ? null : (next[matchIndex] ?? null);
    const name = entry.name ?? match?.name ?? null;
    const record = {
      id:
        match?.id ??
        uniqueRecordId(
          next,
          buildExtractionId("certification", index, [
            entry.name,
            entry.issuer,
            entry.issueDate,
          ]),
        ),
      name,
      issuer: entry.issuer ?? match?.issuer ?? null,
      issueDate: entry.issueDate ?? match?.issueDate ?? null,
      expiryDate: entry.expiryDate ?? match?.expiryDate ?? null,
      credentialUrl:
        toValidUrlOrNull(entry.credentialUrl) ?? match?.credentialUrl ?? null,
      isDraft: !name,
    };
    if (matchIndex === -1) {
      claimed.add(next.length);
      next.push(record);
    } else {
      claimed.add(matchIndex);
      next.splice(matchIndex, 1, record);
    }
  });
  return next;
}

/** Additive, like certificates: an import never drops a saved link. */
export function mergeLinkRecords(
  existing: CandidateProfile["links"],
  extracted: ResumeProfileExtraction["links"],
): CandidateProfile["links"] {
  const next = [...existing];
  extracted.forEach((entry, index) => {
    const url = toValidUrlOrNull(entry.url);

    if (!url) {
      return;
    }

    const key = normalizeRecordKey([url]);
    const matchIndex = next.findIndex(
      (saved) => normalizeRecordKey([saved.url]) === key,
    );
    const match = matchIndex === -1 ? null : (next[matchIndex] ?? null);
    const label = entry.label ?? match?.label ?? null;
    const record = {
      id:
        match?.id ??
        uniqueRecordId(
          next,
          buildExtractionId("link", index, [entry.label, url]),
        ),
      label,
      url,
      kind: entry.kind ?? match?.kind ?? null,
      isDraft: !label || !url,
    };
    if (matchIndex === -1) {
      next.push(record);
    } else {
      next.splice(matchIndex, 1, record);
    }
  });

  return next;
}

/** Additive, like certificates: an import never drops a saved project. */
export function mergeProjectRecords(
  existing: CandidateProfile["projects"],
  extracted: ResumeProfileExtraction["projects"],
): CandidateProfile["projects"] {
  const next = [...existing];
  const claimed = new Set<number>();
  extracted.forEach((entry, index) => {
    if (!entry.name) {
      return;
    }

    const key = normalizeRecordKey([entry.name, entry.role]);
    const nameKey = normalizeRecordKey([entry.name]);
    const matchIndex = findMatchingRecordIndex(
      next,
      claimed,
      (saved) => normalizeRecordKey([saved.name, saved.role]) === key,
      (saved) => normalizeRecordKey([saved.name]) === nameKey,
    );
    const match = matchIndex === -1 ? null : (next[matchIndex] ?? null);
    const record = {
      id:
        match?.id ??
        uniqueRecordId(
          next,
          buildExtractionId("project", index, [entry.name, entry.role]),
        ),
      name: entry.name,
      projectType: entry.projectType ?? match?.projectType ?? null,
      summary: entry.summary ?? match?.summary ?? null,
      role: entry.role ?? match?.role ?? null,
      skills: uniqueStrings([
        ...safeStringArray(match?.skills),
        ...safeStringArray(entry.skills),
      ]),
      outcome: entry.outcome ?? match?.outcome ?? null,
      projectUrl: entry.projectUrl ?? match?.projectUrl ?? null,
      repositoryUrl: entry.repositoryUrl ?? match?.repositoryUrl ?? null,
      caseStudyUrl: entry.caseStudyUrl ?? match?.caseStudyUrl ?? null,
    };
    if (matchIndex === -1) {
      claimed.add(next.length);
      next.push(record);
    } else {
      claimed.add(matchIndex);
      next.splice(matchIndex, 1, record);
    }
  });

  return next;
}

/** Additive, like certificates: an import never drops a saved language. */
export function mergeLanguageRecords(
  existing: CandidateProfile["spokenLanguages"],
  extracted: ResumeProfileExtraction["spokenLanguages"],
): CandidateProfile["spokenLanguages"] {
  const next = [...existing];
  extracted.forEach((entry, index) => {
    if (!entry.language) {
      return;
    }

    const key = normalizeRecordKey([entry.language]);
    const matchIndex = next.findIndex(
      (saved) => normalizeRecordKey([saved.language]) === key,
    );
    const match = matchIndex === -1 ? null : (next[matchIndex] ?? null);
    const record = {
      id:
        match?.id ??
        uniqueRecordId(
          next,
          buildExtractionId("language", index, [entry.language]),
        ),
      language: entry.language,
      proficiency: entry.proficiency ?? match?.proficiency ?? null,
      interviewPreference:
        entry.interviewPreference || (match?.interviewPreference ?? false),
      notes: entry.notes ?? match?.notes ?? null,
    };
    if (matchIndex === -1) {
      next.push(record);
    } else {
      next.splice(matchIndex, 1, record);
    }
  });

  return next;
}

export function mergeResumeExtractionIntoWorkspace(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  extraction: ResumeProfileExtraction,
): {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
} {
  const profileTargetRoles =
    extraction.targetRoles.length > 0
      ? uniqueStrings(extraction.targetRoles)
      : profile.targetRoles;
  const locationFallback =
    extraction.currentLocation ?? profile.currentLocation;
  const profileLocations =
    extraction.preferredLocations.length > 0
      ? uniqueStrings(extraction.preferredLocations)
      : profile.locations.length > 0
        ? profile.locations
        : locationFallback
          ? uniqueStrings([locationFallback])
          : [];
  const preferenceLocations =
    extraction.preferredLocations.length > 0
      ? uniqueStrings(extraction.preferredLocations)
      : searchPreferences.locations.length > 0
        ? searchPreferences.locations
        : profileLocations;
  const locationParts = parseLocationParts(
    extraction.currentLocation ?? profile.currentLocation,
  );
  const extractedSkills = uniqueStrings([
    ...extraction.skills,
    ...extraction.skillGroups.coreSkills,
    ...extraction.skillGroups.tools,
    ...extraction.skillGroups.languagesAndFrameworks,
    ...extraction.skillGroups.highlightedSkills,
    ...extraction.skillGroups.softSkills,
  ]);
  const mergedStrengths =
    extraction.professionalSummary.strengths.length > 0
      ? uniqueStrings(extraction.professionalSummary.strengths)
      : profile.professionalSummary.strengths;
  // Named technologies belong in Skills, which is what the profile tells the
  // user; relocate them instead of leaving the imported data contradicting
  // its own helper text.
  const partitionedSkills = partitionStrengthsAndSkills({
    skillGroupValues: [
      ...extraction.skillGroups.coreSkills,
      ...extraction.skillGroups.tools,
      ...extraction.skillGroups.languagesAndFrameworks,
      ...extraction.skillGroups.highlightedSkills,
      ...profile.skills,
    ],
    skills: extractedSkills,
    strengths: mergedStrengths,
  });
  const mergedSkills = partitionedSkills.skills;

  return {
    profile: CandidateProfileSchema.parse({
      ...profile,
      firstName: extraction.firstName ?? profile.firstName,
      lastName: extraction.lastName ?? profile.lastName,
      middleName: extraction.middleName ?? profile.middleName,
      fullName: extraction.fullName ?? profile.fullName,
      headline: extraction.headline ?? profile.headline,
      summary: extraction.summary ?? profile.summary,
      currentLocation: extraction.currentLocation ?? profile.currentLocation,
      currentCity: locationParts.currentCity ?? profile.currentCity,
      currentRegion: locationParts.currentRegion ?? profile.currentRegion,
      currentCountry: locationParts.currentCountry ?? profile.currentCountry,
      timeZone: extraction.timeZone ?? profile.timeZone,
      yearsExperience: extraction.yearsExperience ?? profile.yearsExperience,
      email: extraction.email,
      phone: extraction.phone,
      portfolioUrl: extraction.portfolioUrl,
      linkedinUrl: extraction.linkedinUrl,
      githubUrl: extraction.githubUrl ?? profile.githubUrl,
      personalWebsiteUrl:
        extraction.personalWebsiteUrl ?? profile.personalWebsiteUrl,
      professionalSummary: {
        ...profile.professionalSummary,
        shortValueProposition:
          extraction.professionalSummary.shortValueProposition ??
          profile.professionalSummary.shortValueProposition,
        fullSummary:
          extraction.professionalSummary.fullSummary ??
          extraction.summary ??
          profile.professionalSummary.fullSummary,
        careerThemes:
          extraction.professionalSummary.careerThemes.length > 0
            ? uniqueStrings(extraction.professionalSummary.careerThemes)
            : profile.professionalSummary.careerThemes,
        leadershipSummary:
          extraction.professionalSummary.leadershipSummary ??
          profile.professionalSummary.leadershipSummary,
        domainFocusSummary:
          extraction.professionalSummary.domainFocusSummary ??
          profile.professionalSummary.domainFocusSummary,
        strengths: partitionedSkills.strengths,
      },
      skillGroups: {
        coreSkills:
          extraction.skillGroups.coreSkills.length > 0
            ? uniqueStrings(extraction.skillGroups.coreSkills)
            : profile.skillGroups.coreSkills,
        tools:
          extraction.skillGroups.tools.length > 0
            ? uniqueStrings(extraction.skillGroups.tools)
            : profile.skillGroups.tools,
        languagesAndFrameworks:
          extraction.skillGroups.languagesAndFrameworks.length > 0
            ? uniqueStrings(extraction.skillGroups.languagesAndFrameworks)
            : profile.skillGroups.languagesAndFrameworks,
        softSkills:
          extraction.skillGroups.softSkills.length > 0
            ? uniqueStrings(extraction.skillGroups.softSkills)
            : profile.skillGroups.softSkills,
        highlightedSkills:
          extraction.skillGroups.highlightedSkills.length > 0
            ? uniqueStrings(extraction.skillGroups.highlightedSkills)
            : profile.skillGroups.highlightedSkills,
      },
      targetRoles: profileTargetRoles,
      locations: profileLocations,
      skills: mergedSkills.length > 0 ? mergedSkills : profile.skills,
      experiences: mergeExperienceRecords(
        profile.experiences,
        extraction.experiences,
      ),
      education: mergeEducationRecords(profile.education, extraction.education),
      certifications: mergeCertificationRecords(
        profile.certifications,
        extraction.certifications,
      ),
      links: mergeLinkRecords(profile.links, extraction.links),
      projects: mergeProjectRecords(profile.projects, extraction.projects),
      spokenLanguages: mergeLanguageRecords(
        profile.spokenLanguages,
        extraction.spokenLanguages,
      ),
      baseResume: {
        ...profile.baseResume,
        extractionStatus: "ready",
        lastAnalyzedAt: new Date().toISOString(),
        analysisProviderKind: extraction.analysisProviderKind,
        analysisProviderLabel: extraction.analysisProviderLabel,
        analysisWarnings: uniqueStrings(extraction.notes),
      },
    }),
    searchPreferences: JobSearchPreferencesSchema.parse({
      ...searchPreferences,
      targetRoles:
        extraction.targetRoles.length > 0
          ? uniqueStrings(extraction.targetRoles)
          : searchPreferences.targetRoles.length > 0
            ? searchPreferences.targetRoles
            : profileTargetRoles,
      locations: preferenceLocations,
      salaryCurrency:
        extraction.salaryCurrency ?? searchPreferences.salaryCurrency,
    }),
  };
}
