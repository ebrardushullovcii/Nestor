import { buildValuePreview } from "@nestor/ai-providers";
import {
  ResumeImportFieldCandidateSchema,
  hasProfileSetupPlaceholderValue,
  isFreshStartCandidateProfile,
  type CandidateProfile,
  type JobSearchPreferences,
  type ResumeDocumentBundle,
  type ResumeImportConflictChoice,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";

import {
  areEquivalentRecordCandidates,
  isClearlyResumeDateRange,
  isObject,
  cleanImportedValue,
  stringifyCandidateTarget,
  toCandidateListValues,
  toNarrativeStringArray,
  toStringArray,
} from "./resume-import-common";
import {
  canonicalizeRecordDateText,
  areEquivalentEducationRecords,
  areEquivalentExperienceRecords,
  scoreEducationRecordCompleteness,
  scoreExperienceRecordCompleteness,
} from "./resume-record-identity";
export {
  normalizeSharedMemoryCandidates,
  promoteGroundedSharedMemoryCandidates,
} from "./resume-import-shared-memory-candidates";
import {
  validateResumeImportSourceCandidate,
  splitImportedRole,
} from "./resume-import-source-validation";
import { normalizeText, uniqueStrings } from "./shared";
import {
  PROFILE_PLACEHOLDER_HEADLINE,
  PROFILE_PLACEHOLDER_LOCATION,
  PROFILE_PLACEHOLDER_SUMMARY,
} from "./workspace-defaults";
import {
  findResumeImportIdentityConflicts,
  isLikelyPersonName as isLikelyPersonNameFromIdentity,
} from "./resume-identity";

function recordFieldText(value: unknown, key: string): string {
  if (!isObject(value)) {
    return "";
  }
  const field = value[key];
  return typeof field === "string" ? normalizeText(field) : "";
}

/**
 * Read from the resume's own text: by the model (ADR 0041), or by the regex
 * pass in runs recorded before the model read every section.
 */
function isDocumentTextCandidate(
  candidate: ResumeImportFieldCandidate,
): boolean {
  return (
    candidate.sourceKind === "parser_literal" ||
    candidate.sourceKind === "model_identity_summary" ||
    candidate.sourceKind === "model_experience" ||
    candidate.sourceKind === "model_background"
  );
}

export function candidateScore(candidate: ResumeImportFieldCandidate): number {
  const sourceBonus = candidate.sourceKind === "vision_omni" ? 0.015 : 0;
  const evidenceBonus = candidate.sourceBlockIds.length > 0 ? 0.01 : 0;
  const recommendationBonus =
    candidate.confidenceBreakdown?.recommendation === "auto_apply"
      ? 0.03
      : candidate.confidenceBreakdown?.recommendation === "abstain"
        ? -0.05
        : 0;
  return (
    candidate.confidence + sourceBonus + evidenceBonus + recommendationBonus
  );
}

function candidateOverallConfidence(
  candidate: ResumeImportFieldCandidate,
): number {
  return candidate.confidenceBreakdown?.overall ?? candidate.confidence;
}

function recommendationForCandidate(
  candidate: ResumeImportFieldCandidate,
): NonNullable<
  ResumeImportFieldCandidate["confidenceBreakdown"]
>["recommendation"] {
  return (
    candidate.confidenceBreakdown?.recommendation ??
    (candidateOverallConfidence(candidate) < 0.35 ? "abstain" : "needs_review")
  );
}

function existingScalarValueForCandidate(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): unknown {
  switch (`${candidate.target.section}.${candidate.target.key}`) {
    case "identity.fullName":
      return profile.fullName;
    case "identity.firstName":
      return profile.firstName;
    case "identity.middleName":
      return profile.middleName;
    case "identity.lastName":
      return profile.lastName;
    case "identity.headline":
      return profile.headline;
    case "identity.summary":
      return profile.summary;
    case "identity.yearsExperience":
      return profile.yearsExperience;
    case "location.currentCity":
      return profile.currentCity;
    case "location.currentRegion":
      return profile.currentRegion;
    case "location.currentCountry":
      return profile.currentCountry;
    case "location.currentLocation":
      return profile.currentLocation;
    case "location.timeZone":
      return profile.timeZone;
    case "contact.email":
      return profile.email;
    case "contact.phone":
      return profile.phone;
    case "contact.portfolioUrl":
      return profile.portfolioUrl;
    case "contact.linkedinUrl":
      return profile.linkedinUrl;
    case "contact.githubUrl":
      return profile.githubUrl;
    case "contact.personalWebsiteUrl":
      return profile.personalWebsiteUrl;
    case "application_identity.preferredEmail":
      return profile.applicationIdentity.preferredEmail;
    case "application_identity.preferredPhone":
      return profile.applicationIdentity.preferredPhone;
    case "narrative.professionalStory":
      return profile.narrative.professionalStory;
    case "narrative.nextChapterSummary":
      return profile.narrative.nextChapterSummary;
    case "narrative.careerTransitionSummary":
      return profile.narrative.careerTransitionSummary;
    case "search_preferences.targetRoles":
      return searchPreferences.targetRoles;
    case "search_preferences.locations":
      return searchPreferences.locations;
    case "search_preferences.workModes":
      return searchPreferences.workModes;
    case "search_preferences.employmentTypes":
      return searchPreferences.employmentTypes;
    case "search_preferences.compensation":
      return searchPreferences.compensation.minimum === null &&
        searchPreferences.compensation.currency === null
        ? null
        : searchPreferences.compensation;
    case "search_preferences.salaryCurrency":
      return searchPreferences.salaryCurrency;
    case "work_eligibility.authorizedWorkCountries":
      return profile.workEligibility.authorizedWorkCountries;
    case "work_eligibility.requiresVisaSponsorship":
      return profile.workEligibility.requiresVisaSponsorship;
    case "work_eligibility.limitedWorkPermissions":
      return profile.workEligibility.limitedWorkPermissions;
    default:
      return undefined;
  }
}

function isEmptyWorkEligibilityValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isPlaceholderScalarValue(
  _profile: CandidateProfile,
  candidate: ResumeImportFieldCandidate,
  currentValue: unknown,
): boolean {
  // A stored placeholder is empty no matter what else was saved since.
  // Requiring a fully fresh-start profile here stranded the placeholder
  // headline forever once the name alone had been written (a deferred
  // vision pass or a second import could never replace it).
  if (candidate.target.key === "yearsExperience") {
    return typeof currentValue === "number" && currentValue <= 0;
  }

  if (typeof currentValue !== "string") {
    return false;
  }

  switch (candidate.target.key) {
    case "firstName":
      return normalizeText(currentValue) === "new";
    case "lastName":
      return normalizeText(currentValue) === "candidate";
    case "fullName":
      return normalizeText(currentValue) === "new candidate";
    case "headline":
      return currentValue === PROFILE_PLACEHOLDER_HEADLINE;
    case "summary":
      return currentValue === PROFILE_PLACEHOLDER_SUMMARY;
    case "currentLocation":
      return currentValue === PROFILE_PLACEHOLDER_LOCATION;
    default:
      return false;
  }
}

function scalarValueConflictsWithWorkspace(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): boolean {
  const currentValue = existingScalarValueForCandidate(
    profile,
    searchPreferences,
    candidate,
  );

  if (currentValue === undefined || currentValue === null) {
    return false;
  }

  if (isPlaceholderScalarValue(profile, candidate, currentValue)) {
    return false;
  }

  if (typeof currentValue === "string" && typeof candidate.value === "string") {
    return normalizeText(currentValue) !== normalizeText(candidate.value);
  }

  if (typeof currentValue === "number" && typeof candidate.value === "number") {
    return currentValue !== candidate.value;
  }
  if (
    candidate.target.key === "compensation" &&
    isObject(currentValue) &&
    isObject(candidate.value)
  ) {
    return Object.entries(candidate.value).some(
      ([key, value]) => currentValue[key] !== value,
    );
  }

  if (
    candidate.target.key === "employmentTypes" &&
    Array.isArray(currentValue) &&
    currentValue.length > 0
  ) {
    return !normalizedStringValuesMatch(
      toStringArray(currentValue),
      toStringArray(candidate.value),
    );
  }
  return false;
}

function scalarValueMatchesWorkspace(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): boolean {
  const currentValue = existingScalarValueForCandidate(
    profile,
    searchPreferences,
    candidate,
  );

  if (
    currentValue === undefined ||
    currentValue === null ||
    isPlaceholderScalarValue(profile, candidate, currentValue)
  ) {
    return false;
  }

  if (typeof currentValue === "string" && typeof candidate.value === "string") {
    return normalizeText(currentValue) === normalizeText(candidate.value);
  }

  if (
    typeof currentValue === "boolean" &&
    typeof candidate.value === "boolean"
  ) {
    return currentValue === candidate.value;
  }

  if (
    (candidate.target.section === "work_eligibility" ||
      candidate.target.key === "employmentTypes") &&
    Array.isArray(currentValue) &&
    currentValue.length > 0
  ) {
    return normalizedStringValuesMatch(
      currentValue.filter(
        (entry): entry is string => typeof entry === "string",
      ),
      toStringArray(candidate.value),
    );
  }

  if (
    candidate.target.key === "compensation" &&
    isObject(currentValue) &&
    isObject(candidate.value)
  ) {
    return Object.entries(candidate.value).every(
      ([key, value]) => currentValue[key] === value,
    );
  }
  return (
    typeof currentValue === "number" &&
    typeof candidate.value === "number" &&
    currentValue === candidate.value
  );
}

export function shouldPreferCandidateOverExistingValue(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): boolean {
  const currentValue = existingScalarValueForCandidate(
    profile,
    searchPreferences,
    candidate,
  );

  if (currentValue === undefined || currentValue === null) {
    return true;
  }

  if (isPlaceholderScalarValue(profile, candidate, currentValue)) {
    return true;
  }

  if (isDocumentTextCandidate(candidate) && hasSufficientEvidence(candidate)) {
    if (
      typeof currentValue === "string" &&
      typeof candidate.value === "string"
    ) {
      return normalizeText(currentValue) !== normalizeText(candidate.value);
    }

    return currentValue !== candidate.value;
  }

  return !scalarValueConflictsWithWorkspace(
    profile,
    searchPreferences,
    candidate,
  );
}

type EducationCandidateFieldKind = "degree" | "fieldOfStudy" | "location";

function educationEvidenceTokens(value: string): string[] {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "at",
    "degree",
    "in",
    "of",
    "s",
    "the",
  ]);
  return normalizeText(value)
    .split(/\s+/)
    .map((token) =>
      token === "bachelors"
        ? "bachelor"
        : token === "masters"
          ? "master"
          : token,
    )
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function normalizeSupportedEducationValue(
  candidate: ResumeImportFieldCandidate,
  value: unknown,
  kind: EducationCandidateFieldKind,
): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const trimmed = value.trim();
  const evidenceText = candidate.evidenceText?.trim();
  if (evidenceText && kind === "location") {
    const evidenceTokens = new Set(educationEvidenceTokens(evidenceText));
    const valueTokens = educationEvidenceTokens(trimmed);
    if (
      valueTokens.length === 0 ||
      !valueTokens.every((token) => evidenceTokens.has(token))
    ) {
      return null;
    }
  }

  const normalized = normalizeText(trimmed);
  const degreeMarker =
    /\b(?:associate|associates|bachelor|bachelors|master|masters|doctor|doctorate|phd|degree|diploma|certificate|bsc|bba|msc|mba|ba|bs|ma|ms)\b/;

  if (kind === "degree") {
    return trimmed;
  }

  if (kind === "fieldOfStudy") {
    const firstToken = normalized.split(/\s+/)[0] ?? "";
    return degreeMarker.test(firstToken) ? null : trimmed;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (
    trimmed.length > 80 ||
    tokens.length > 8 ||
    /[@\d]|https?:\/\//i.test(trimmed) ||
    /\b(?:bachelor|master|degree|computer|science|engineering|business|administration|technology|studies)\b/.test(
      normalized,
    )
  ) {
    return null;
  }

  return trimmed;
}

function readAliasString(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim().length > 0) {
      return entry;
    }
  }
  return null;
}

/** A date the model wrote as text or as a bare year number (2013). */
function readAliasDateText(
  value: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "number" && Number.isInteger(entry)) {
      return String(entry);
    }
    if (typeof entry === "string" && entry.trim().length > 0) {
      return entry;
    }
  }
  return null;
}

/**
 * "AWS Certified Solutions Architect - Associate (2022)": the year is when it
 * was issued, not part of its name. Left in the name, the same certificate
 * read twice (once with the year, once without) became two cards, and
 * neither carried the date.
 */
export function splitCertificationNameYear(name: string | null): {
  name: string | null;
  year: string | null;
} {
  if (!name) {
    return { name, year: null };
  }
  const match =
    /^(.*?\S)\s*(?:\(\s*((?:19|20)\d{2})\s*\)|[,–—-]\s*((?:19|20)\d{2}))\s*$/u.exec(
      name.trim(),
    );
  const year = match?.[2] ?? match?.[3] ?? null;
  return match?.[1] && year
    ? { name: match[1].trim(), year }
    : { name, year: null };
}

function normalizeRecordCandidateValue(
  candidate: ResumeImportFieldCandidate,
  bundle?: ResumeDocumentBundle,
  readByModel = false,
): ResumeImportFieldCandidate["value"] {
  const parsedValue = (() => {
    if (typeof candidate.value !== "string") {
      return candidate.value;
    }

    try {
      const parsed: unknown = JSON.parse(candidate.value);
      return isObject(parsed) ? parsed : candidate.value;
    } catch {
      return candidate.value;
    }
  })();

  if (!isObject(parsedValue)) {
    return candidate.value;
  }

  switch (candidate.target.section) {
    case "experience": {
      const value = parsedValue;
      // The model names the same facts under different keys from one run to
      // the next (company/employer, highlights/bullets, current/present).
      // Reading the aliases keeps the employer and the bullets instead of
      // silently dropping them into an empty card.
      const rawEndDate = readAliasString(value, ["endDate", "end", "to"]);
      const endDateSaysCurrent =
        rawEndDate !== null &&
        /^(?:present|current|now|ongoing)$/i.test(rawEndDate.trim());
      const rawTitle = readAliasString(value, [
        "title",
        "role",
        "position",
        "jobTitle",
      ]);
      const savedCompany = readAliasString(value, [
        "companyName",
        "company",
        "employer",
        "organization",
        "organisation",
      ]);
      // The model splits title from employer itself (ADR 0041); the rule
      // split only stands in when no model read the resume.
      const splitRole = readByModel
        ? { title: rawTitle ?? "", companyName: null }
        : splitImportedRole(rawTitle ?? "", savedCompany, bundle);
      return {
        companyName:
          readAliasString(value, [
            "companyName",
            "company",
            "employer",
            "organization",
            "organisation",
          ]) ?? splitRole.companyName,
        companyUrl: readAliasString(value, ["companyUrl", "companyWebsite"]),
        title: splitRole.title || null,
        employmentType: readAliasString(value, ["employmentType", "type"]),
        location: readAliasString(value, ["location"]),
        workMode: toStringArray(value.workMode ?? value.workModes),
        startDate: canonicalizeRecordDateText(
          readAliasString(value, ["startDate", "start", "from"]),
        ),
        endDate: endDateSaysCurrent
          ? null
          : canonicalizeRecordDateText(rawEndDate),
        isCurrent:
          value.isCurrent === true ||
          value.current === true ||
          value.isPresent === true ||
          endDateSaysCurrent,
        summary: readAliasString(value, ["summary", "description", "overview"]),
        achievements: toNarrativeStringArray(
          value.achievements ??
            value.highlights ??
            value.bullets ??
            value.responsibilities ??
            value.accomplishments,
        ),
        skills: toStringArray(
          value.skills ?? value.technologies ?? value.tools,
        ),
        domainTags: toStringArray(
          value.domainTags ?? value.domains ?? value.industries,
        ),
        peopleManagementScope:
          typeof value.peopleManagementScope === "string"
            ? value.peopleManagementScope
            : null,
        ownershipScope:
          typeof value.ownershipScope === "string"
            ? value.ownershipScope
            : null,
      };
    }
    case "education": {
      const value = parsedValue;
      // The model names the school "institution" in some runs and the dates
      // "startYear"/"endYear" in others. Reading only the canonical keys
      // imported "BSc Software Engineering" with no school at all.
      const schoolName = readAliasString(value, [
        "schoolName",
        "school",
        "institution",
        "institutionName",
        "university",
        "college",
      ]);
      const rawDegree = readAliasString(value, [
        "degree",
        "qualification",
        "degreeName",
      ]);
      const degreeYear = rawDegree?.match(/^(.*?\S)[,\s]+((?:19|20)\d{2})$/);
      const cleanDegree = degreeYear?.[1] ?? rawDegree;
      const degreeWithField = cleanDegree?.match(
        /^(.*?(?:degree|associate of (?:applied science|arts|science)|bachelor of (?:arts|science)|master of (?:arts|science)))(?:\s+in\s+|,\s+)(.+)$/i,
      );
      const degree = normalizeSupportedEducationValue(
        candidate,
        degreeWithField?.[1] ?? cleanDegree,
        "degree",
      );
      const rawField =
        readAliasString(value, ["fieldOfStudy", "field", "major", "subject"]) ??
        degreeWithField?.[2];
      const fieldYear = rawField?.match(/^(.*?\S)[,\s]+((?:19|20)\d{2})$/);
      const fieldOfStudy = normalizeSupportedEducationValue(
        candidate,
        fieldYear?.[1] ?? rawField,
        "fieldOfStudy",
      );
      const location = normalizeSupportedEducationValue(
        candidate,
        value.location,
        "location",
      );
      const rawSummary = readAliasString(value, ["summary", "description"]);
      return {
        schoolName,
        degree,
        fieldOfStudy,
        location:
          location &&
          schoolName &&
          normalizeText(location) === normalizeText(schoolName)
            ? null
            : location,
        startDate: canonicalizeRecordDateText(
          readAliasDateText(value, ["startDate", "start", "from", "startYear"]),
        ),
        endDate: canonicalizeRecordDateText(
          readAliasDateText(value, [
            "endDate",
            "end",
            "to",
            "endYear",
            "graduationDate",
            "graduationYear",
          ]) ??
            fieldYear?.[2] ??
            degreeYear?.[2],
        ),
        summary:
          rawSummary &&
          candidate.evidenceText &&
          normalizeText(rawSummary) === normalizeText(candidate.evidenceText)
            ? null
            : rawSummary,
      };
    }
    case "certification": {
      const value = parsedValue;
      const { name, year } = splitCertificationNameYear(
        readAliasString(value, [
          "name",
          "title",
          "certification",
          "certificate",
        ]),
      );
      return {
        name,
        issuer: readAliasString(value, [
          "issuer",
          "issuingOrganization",
          "organization",
          "authority",
          "provider",
        ]),
        issueDate:
          canonicalizeRecordDateText(
            readAliasDateText(value, [
              "issueDate",
              "issued",
              "issuedAt",
              "dateIssued",
              "date",
              "year",
            ]),
          ) ?? year,
        expiryDate: canonicalizeRecordDateText(
          readAliasDateText(value, [
            "expiryDate",
            "expires",
            "expirationDate",
            "validUntil",
          ]),
        ),
        credentialUrl: readAliasString(value, ["credentialUrl", "url", "link"]),
      };
    }
    case "link": {
      const value = parsedValue;
      return {
        label: typeof value.label === "string" ? value.label : null,
        url: typeof value.url === "string" ? value.url : null,
        kind: typeof value.kind === "string" ? value.kind : null,
      };
    }
    case "project": {
      const value = parsedValue;
      return {
        name: readAliasString(value, ["name", "title"]),
        projectType: readAliasString(value, ["projectType", "type", "context"]),
        summary: readAliasString(value, ["summary", "description"]),
        role: readAliasString(value, ["role", "contribution"]),
        skills: toStringArray(
          value.skills ?? value.technologies ?? value.tools,
        ),
        outcome: readAliasString(value, ["outcome", "impact", "results"]),
        projectUrl:
          typeof value.projectUrl === "string" ? value.projectUrl : null,
        repositoryUrl:
          typeof value.repositoryUrl === "string" ? value.repositoryUrl : null,
        caseStudyUrl:
          typeof value.caseStudyUrl === "string" ? value.caseStudyUrl : null,
      };
    }
    case "language": {
      const value = parsedValue;
      return {
        language: typeof value.language === "string" ? value.language : null,
        proficiency:
          typeof value.proficiency === "string" ? value.proficiency : null,
        interviewPreference: value.interviewPreference === true,
        notes: typeof value.notes === "string" ? value.notes : null,
      };
    }
    case "proof_point": {
      const value = parsedValue;
      return {
        title: typeof value.title === "string" ? value.title : null,
        claim: typeof value.claim === "string" ? value.claim : null,
        heroMetric:
          typeof value.heroMetric === "string" ? value.heroMetric : null,
        supportingContext:
          typeof value.supportingContext === "string"
            ? value.supportingContext
            : null,
        roleFamilies: toStringArray(value.roleFamilies),
        projectIds: toStringArray(value.projectIds),
        linkIds: toStringArray(value.linkIds),
      };
    }
    default:
      return candidate.value;
  }
}

function normalizeRecordCandidateForReconciliation(
  candidate: ResumeImportFieldCandidate,
  bundle?: ResumeDocumentBundle,
  readByModel = false,
): ResumeImportFieldCandidate {
  // Some providers emit one named skill object per candidate. Normalize it
  // to the supported single-skill record before ranking and applying it;
  // otherwise a slug key can be marked applied without reaching the profile.
  if (
    candidate.target.section === "skill" &&
    isObject(candidate.value) &&
    typeof candidate.value.name === "string" &&
    candidate.value.name.trim()
  ) {
    const value = candidate.value.name.trim();
    return ResumeImportFieldCandidateSchema.parse({
      ...candidate,
      target: {
        ...candidate.target,
        key: "record",
        recordId: candidate.target.recordId ?? candidate.target.key,
      },
      value,
      normalizedValue: value,
      valuePreview: value,
    });
  }
  if (!isRecordTarget(candidate)) {
    return candidate;
  }

  const value = normalizeRecordCandidateValue(candidate, bundle, readByModel);
  // The model sometimes keys a structured record by a slug ("experiences",
  // "albanian") instead of "record". Same section, same object shape, same
  // person's job: it must group with the deterministic twin instead of
  // showing up beside it as a second copy to confirm.
  const target =
    candidate.target.key !== "record" && isObject(value)
      ? {
          section: candidate.target.section,
          key: "record",
          recordId: candidate.target.recordId ?? candidate.target.key,
        }
      : candidate.target;
  if (value === candidate.value && target === candidate.target) {
    return candidate;
  }

  return ResumeImportFieldCandidateSchema.parse({
    ...candidate,
    target,
    value,
    valuePreview: buildValuePreview(value),
  });
}

export const FOLDED_INTO_RECORD_REASON = "folded_into_record_candidate";

/** Keys that name the thing a record is about, per section. */
const LOOSE_RECORD_IDENTITY_KEYS: Readonly<Record<string, readonly string[]>> =
  {
    experience: [
      "companyName",
      "company",
      "employer",
      "organization",
      "title",
      "role",
      "position",
      "jobTitle",
    ],
    education: [
      "schoolName",
      "school",
      "institution",
      "institutionName",
      "university",
      "college",
      "degree",
      "qualification",
      "degreeName",
    ],
    certification: ["name", "title", "certification", "certificate"],
    project: ["name", "title"],
    language: ["language"],
    link: ["url"],
  };

const LOOSE_RECORD_SECTIONS = new Set(Object.keys(LOOSE_RECORD_IDENTITY_KEYS));

/** A role or degree is never one field; a link or a language can be. */
const LOOSE_RECORD_MINIMUM_FIELDS: Readonly<Record<string, number>> = {
  experience: 2,
  education: 2,
};

function isLooseRecordFieldCandidate(
  candidate: ResumeImportFieldCandidate,
): boolean {
  return (
    LOOSE_RECORD_SECTIONS.has(candidate.target.section) &&
    candidate.target.key !== "record" &&
    Boolean(candidate.target.recordId?.trim()) &&
    candidate.value !== null &&
    !isObject(candidate.value)
  );
}

function looseRecordLabel(
  section: string,
  value: Record<string, unknown>,
): string | null {
  const text = (keys: readonly string[]) =>
    keys
      .map((key) => value[key])
      .find(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
      ?.trim() ?? null;
  const parts =
    section === "experience"
      ? [
          text(["companyName", "company", "employer", "organization"]),
          text(["title", "role", "position", "jobTitle"]),
        ]
      : section === "education"
        ? [
            text(["schoolName", "school", "institution", "university"]),
            text(["degree", "qualification", "degreeName"]),
          ]
        : [text(LOOSE_RECORD_IDENTITY_KEYS[section] ?? [])];
  const label = parts.filter(Boolean).join(" — ");
  return label.length > 0 ? label : null;
}

/**
 * The model is asked for one object per role, but some runs return a role as
 * loose fields instead: experience.companyName, experience.title and so on,
 * sharing one recordId. Each loose field became its own required setup item
 * ("Confirm acme title"), none of them could be applied, and none matched the
 * saved role, so importing the same resume again asked the person to confirm
 * twenty-three values already on their profile. Loose fields from one source
 * that share a section and recordId are one record: fold them into it, so
 * the record is matched, merged or reviewed like any other. The loose fields
 * are kept, rejected with the fold as the reason.
 */
function foldLooseRecordFieldCandidates(
  candidates: readonly ResumeImportFieldCandidate[],
): {
  candidates: ResumeImportFieldCandidate[];
  foldedAway: ResumeImportFieldCandidate[];
} {
  const groups = new Map<string, ResumeImportFieldCandidate[]>();
  const kept: ResumeImportFieldCandidate[] = [];

  for (const candidate of candidates) {
    if (!isLooseRecordFieldCandidate(candidate)) {
      kept.push(candidate);
      continue;
    }
    const groupKey = [
      candidate.runId,
      candidate.sourceKind,
      candidate.target.section,
      candidate.target.recordId?.trim(),
    ].join("|");
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), candidate]);
  }

  const existingIds = new Set(candidates.map((candidate) => candidate.id));
  const folded: ResumeImportFieldCandidate[] = [];
  const foldedAway: ResumeImportFieldCandidate[] = [];

  for (const group of groups.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }
    const section = first.target.section;
    const value: Record<string, ResumeImportFieldCandidate["value"]> = {};
    let ambiguous = false;
    for (const candidate of group) {
      const key = candidate.target.key;
      const previous = value[key];
      if (
        previous !== undefined &&
        JSON.stringify(previous) !== JSON.stringify(candidate.value)
      ) {
        ambiguous = true;
        break;
      }
      value[key] = candidate.value;
    }
    const hasIdentity = (LOOSE_RECORD_IDENTITY_KEYS[section] ?? []).some(
      (key) => {
        const entry = value[key];
        return typeof entry === "string" && entry.trim().length > 0;
      },
    );
    const fieldCount = Object.keys(value).length;
    if (
      ambiguous ||
      !hasIdentity ||
      fieldCount < (LOOSE_RECORD_MINIMUM_FIELDS[section] ?? 1)
    ) {
      kept.push(...group);
      continue;
    }

    const recordId = first.target.recordId?.trim() ?? "record";
    const foldedId =
      `${first.runId}_${first.sourceKind}_${section}_record_${recordId}_folded`
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "_");
    foldedAway.push(...group);
    // The second reconciliation pass sees the record the first pass made.
    if (existingIds.has(foldedId)) {
      continue;
    }
    existingIds.add(foldedId);
    const lowest = group.reduce((current, candidate) =>
      candidateOverallConfidence(candidate) <
      candidateOverallConfidence(current)
        ? candidate
        : current,
    );
    const evidenceText = uniqueStrings(
      group.flatMap((candidate) =>
        candidate.evidenceText ? [candidate.evidenceText] : [],
      ),
    ).join(" | ");
    folded.push(
      ResumeImportFieldCandidateSchema.parse({
        id: foldedId,
        runId: first.runId,
        target: { section, key: "record", recordId },
        label: looseRecordLabel(section, value) ?? first.label,
        sourceKind: first.sourceKind,
        value,
        normalizedValue: null,
        valuePreview: buildValuePreview(value),
        evidenceText: evidenceText.length > 0 ? evidenceText : null,
        sourceBlockIds: uniqueStrings(
          group.flatMap((candidate) => candidate.sourceBlockIds),
        ),
        confidence: Math.min(...group.map((candidate) => candidate.confidence)),
        confidenceBreakdown: lowest.confidenceBreakdown ?? null,
        notes: uniqueStrings([
          ...group.flatMap((candidate) => candidate.notes),
          "Read as separate fields; combined into one record.",
        ]),
        alternatives: [],
        conflictChoices: [],
        visualEvidence: group.flatMap(
          (candidate) => candidate.visualEvidence ?? [],
        ),
        resolution: "needs_review",
        resolutionReason: null,
        createdAt: first.createdAt,
        resolvedAt: null,
      }),
    );
  }

  return { candidates: [...kept, ...folded], foldedAway };
}

/**
 * Two extractions of the same record rarely agree on which fields they
 * filled: the model reads the summary and dates, the text reader finds the
 * employer line. The winner keeps its own values and takes what it lacks
 * from its siblings, so applying one record never drops the company name
 * only the other copy knew.
 */
const RECORD_FILLABLE_FIELDS = new Set([
  "companyName",
  "companyUrl",
  "location",
  "employmentType",
  "workMode",
  "startDate",
  "endDate",
  "schoolName",
  "degree",
  "fieldOfStudy",
  "url",
  "label",
  "language",
  "proficiency",
  "name",
  "projectType",
  "role",
  "issuer",
  "issueDate",
  "expiryDate",
  "credentialUrl",
  "achievements",
  "skills",
  "isCurrent",
]);

function enrichRecordCandidateFromSiblings(
  winner: ResumeImportFieldCandidate,
  siblings: readonly ResumeImportFieldCandidate[],
): ResumeImportFieldCandidate {
  if (!isObject(winner.value) || siblings.length === 0) {
    return winner;
  }
  const merged: Record<string, unknown> = { ...winner.value };
  let changed = false;
  let keepEmployerEmpty = false;

  if (winner.target.section === "experience") {
    const winnerCompany = recordFieldText(winner.value, "companyName");
    const winnerTitle = recordFieldText(winner.value, "title");
    for (const sibling of siblings) {
      if (!isObject(sibling.value)) {
        continue;
      }
      const siblingCompany = recordFieldText(sibling.value, "companyName");
      const siblingTitle = recordFieldText(sibling.value, "title");
      if (
        winnerCompany &&
        winnerTitle &&
        !siblingCompany &&
        siblingTitle === `${winnerCompany} ${winnerTitle}`
      ) {
        merged.companyName = null;
        merged.title = sibling.value.title;
        keepEmployerEmpty = true;
        changed = true;
        break;
      }
      if (
        !winnerCompany &&
        winnerTitle &&
        siblingCompany &&
        siblingTitle &&
        winnerTitle === `${siblingCompany} ${siblingTitle}`
      ) {
        keepEmployerEmpty = true;
      }
    }
  }

  for (const sibling of siblings) {
    if (!isObject(sibling.value)) {
      continue;
    }
    for (const [key, siblingValue] of Object.entries(sibling.value)) {
      // Prose (summary, notes) is never borrowed: the text reader's version
      // is the raw paragraph, often first person or a bare location line.
      if (!RECORD_FILLABLE_FIELDS.has(key)) {
        continue;
      }
      if (key === "companyName" && keepEmployerEmpty) {
        continue;
      }
      const current = merged[key];
      if (Array.isArray(current) && Array.isArray(siblingValue)) {
        const union = uniqueStrings([
          ...current.filter(
            (entry): entry is string => typeof entry === "string",
          ),
          ...siblingValue.filter(
            (entry): entry is string => typeof entry === "string",
          ),
        ]);
        if (union.length !== current.length) {
          merged[key] = union;
          changed = true;
        }
        continue;
      }
      const currentEmpty =
        current === null ||
        current === undefined ||
        current === false ||
        (typeof current === "string" && current.trim().length === 0);
      const siblingFilled =
        siblingValue !== null &&
        siblingValue !== undefined &&
        siblingValue !== false &&
        !(typeof siblingValue === "string" && siblingValue.trim().length === 0);
      // Only gaps are filled. A sibling's longer summary is not better: the
      // text reader's version is often the raw first-person paragraph.
      if (currentEmpty && siblingFilled) {
        merged[key] = siblingValue;
        changed = true;
      }
    }
  }
  if (!changed) {
    return winner;
  }
  return ResumeImportFieldCandidateSchema.parse({
    ...winner,
    value: merged,
    valuePreview: buildValuePreview(merged),
    // Revalidation must see the evidence for the fields borrowed from the
    // other reading, even when the school/year-only reading ranked first.
    ...(winner.target.section === "education"
      ? {
          evidenceText:
            uniqueStrings(
              [winner, ...siblings].flatMap((candidate) =>
                candidate.evidenceText ? [candidate.evidenceText] : [],
              ),
            ).join("\n") || null,
          sourceBlockIds: uniqueStrings(
            [winner, ...siblings].flatMap(
              (candidate) => candidate.sourceBlockIds,
            ),
          ),
        }
      : {}),
  });
}

function hasMeaningfulRecordValue(
  candidate: ResumeImportFieldCandidate,
): boolean {
  if (
    !isRecordTarget(candidate) ||
    candidate.target.section !== "education" ||
    !isObject(candidate.value)
  ) {
    return true;
  }
  return ["schoolName", "degree", "fieldOfStudy"].some(
    (key) => recordFieldText(candidate.value, key).length > 0,
  );
}

/**
 * A profile an import may fill without asking: the first-run seed with none
 * of the person's own details in it yet. The seed keeps its reserved id after
 * the first import, so the id alone said "fresh" forever: importing again
 * (Replace resume, Import again) overwrote an email the person had changed,
 * dropped a certificate the Assistant had added, and re-added roles they had
 * merged or split, as second cards beside the edited ones.
 */
export function isUntouchedFreshStartProfile(
  profile: CandidateProfile,
): boolean {
  if (!isFreshStartCandidateProfile(profile)) {
    return false;
  }
  const hasOwnText = (value: string | null | undefined) =>
    typeof value === "string" && value.trim().length > 0;
  const hasOwnName =
    hasOwnText(profile.fullName) &&
    !hasProfileSetupPlaceholderValue("fullName", profile.fullName);
  return !(
    hasOwnName ||
    hasOwnText(profile.email) ||
    hasOwnText(profile.phone) ||
    profile.experiences.length > 0 ||
    profile.education.length > 0 ||
    profile.certifications.length > 0 ||
    profile.projects.length > 0 ||
    profile.spokenLanguages.length > 0 ||
    profile.skills.length > 0
  );
}

function isEmptyRecordSection(
  profile: CandidateProfile,
  section: ResumeImportFieldCandidate["target"]["section"],
): boolean {
  switch (section) {
    case "experience":
      return profile.experiences.length === 0;
    case "education":
      return profile.education.length === 0;
    case "certification":
      return profile.certifications.length === 0;
    case "link":
      return profile.links.length === 0;
    case "project":
      return profile.projects.length === 0;
    case "language":
      return profile.spokenLanguages.length === 0;
    default:
      return false;
  }
}

// Form answers and preferred contact details stay suggestions even into an
// empty profile: screener answers are answered in Needs you, not silently
// pre-filled from a resume. Narrative and proof points are profile content
// the import is meant to build, so they fill like everything else.
const SHARED_MEMORY_SECTIONS = new Set(["answer_bank", "application_identity"]);

function hasTrustworthyVisualEvidence(
  candidate: ResumeImportFieldCandidate,
  bundle?: ResumeDocumentBundle,
): boolean {
  const evidence = candidate.visualEvidence ?? [];
  const confidence = candidate.confidenceBreakdown;
  return (
    candidate.sourceKind === "vision_omni" &&
    bundle !== undefined &&
    candidate.sourceBlockIds.length === 0 &&
    candidate.confidence >= 0.9 &&
    candidate.alternatives.length === 0 &&
    !candidate.notes.some((note) =>
      /\b(?:inferred|inference|derived|assumed|estimated|uncertain|guessed|ambiguous)\b/i.test(
        note,
      ),
    ) &&
    confidence?.recommendation !== "abstain" &&
    (confidence?.normalizationRisk ?? 0) <= 0.2 &&
    (confidence?.conflictRisk ?? 0) <= 0.2 &&
    evidence.length > 0 &&
    evidence.every(
      (reference) =>
        reference.branch === "vision" &&
        reference.sourceFileKind === bundle.sourceFileKind &&
        bundle.pages.some((page) => page.pageNumber === reference.pageNumber) &&
        (reference.confidence ?? 0) >= 0.9 &&
        reference.uncertaintyNotes.length === 0 &&
        Boolean(reference.regionHint?.trim()) &&
        (reference.sourceFileKind !== "pdf" || (reference.pageNumber ?? 0) > 0),
    )
  );
}

/**
 * Importing into an empty profile fills it. The review-first policy above
 * exists to protect values the person already typed; on a fresh profile there
 * is nothing to protect, and asking someone to confirm forty rows of their
 * own resume one by one is the friction the import was meant to remove. The
 * winner of every group is applied, the person edits what is wrong on the
 * form, and only shared-memory suggestions and identity mismatches still
 * wait. The same applies to a scalar whose stored value is still empty.
 */
function promoteImportCandidatesIntoEmptyProfile(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidates: readonly ResumeImportFieldCandidate[],
  bundle?: ResumeDocumentBundle,
): ResumeImportFieldCandidate[] {
  const freshStart = isUntouchedFreshStartProfile(profile);
  const emptySections = new Set<string>(
    (
      [
        ["experience", profile.experiences.length],
        ["education", profile.education.length],
        ["certification", profile.certifications.length],
        ["link", profile.links.length],
        ["project", profile.projects.length],
        ["language", profile.spokenLanguages.length],
        ["proof_point", profile.proofBank.length],
      ] as const
    )
      .filter(([, count]) => count === 0)
      .map(([section]) => section),
  );
  const resolvedAt = new Date().toISOString();

  return candidates.map((candidate) => {
    if (candidate.resolutionReason === "grounded_completeness_suggestion")
      return candidate;
    // The composite score measures native parser/text-block quality, which is
    // low for a scanned PDF even when the visual pass reads it clearly. Such
    // evidence may fill missing fields without changing the saved score or
    // making an uncertain/conflicting scan eligible for automatic import.
    const trustworthyVisualEvidence = hasTrustworthyVisualEvidence(
      candidate,
      bundle,
    );
    // No block-evidence requirement for scalar and list fills: inferred
    // values (a headline, a summary, target roles) have no source block by
    // nature, and one wrong block id from the model used to veto the fill
    // entirely. Promotion only writes into empty fields, so the person
    // edits what's wrong on the form instead of confirming their own
    // resume field by field. Record candidates still need evidence: an
    // unevidenced record applied through a merge path can write nothing
    // and silently swallow the suggestion.
    if (
      candidate.resolution !== "needs_review" ||
      SHARED_MEMORY_SECTIONS.has(candidate.target.section) ||
      candidate.resolutionReason === "import_shape_requires_review" ||
      candidate.resolutionReason?.startsWith("identity_mismatch") ||
      candidate.resolutionReason ===
        "text_vs_visual_conflict_requires_review" ||
      (candidate.conflictChoices?.length ?? 0) > 1 ||
      (candidateOverallConfidence(candidate) < 0.6 &&
        !trustworthyVisualEvidence) ||
      (isRecordTarget(candidate) && !hasSufficientEvidence(candidate)) ||
      (candidate.target.section === "skill" &&
        candidate.target.key === "record" &&
        !shouldAutoApplySkillRecordCandidate(candidate))
    ) {
      return candidate;
    }
    const isRecord = isRecordTarget(candidate);
    const existingValue = existingScalarValueForCandidate(
      profile,
      searchPreferences,
      candidate,
    );
    const existingIsEmpty =
      existingValue === null ||
      existingValue === undefined ||
      (typeof existingValue === "string" &&
        existingValue.trim().length === 0) ||
      (Array.isArray(existingValue) && existingValue.length === 0) ||
      isPlaceholderScalarValue(profile, candidate, existingValue);
    // Search-preference lists replace the stored list when applied, so on
    // a profile in use they only fill an empty list and never replace
    // roles the person saved. A fresh-start import builds targeting from
    // the resume, defaults included. Skill lists union-merge and may
    // always top up.
    const replacesExistingList =
      isListTarget(candidate) &&
      candidate.target.section === "search_preferences";
    const eligible = isRecord
      ? freshStart || emptySections.has(candidate.target.section)
      : replacesExistingList
        ? freshStart || existingIsEmpty
        : freshStart || isListTarget(candidate) || existingIsEmpty;
    if (
      !eligible ||
      (["employmentTypes", "compensation"].includes(candidate.target.key) &&
        scalarValueConflictsWithWorkspace(
          profile,
          searchPreferences,
          candidate,
        )) ||
      (trustworthyVisualEvidence &&
        !isRecord &&
        !isListTarget(candidate) &&
        !existingIsEmpty)
    ) {
      return candidate;
    }
    return ResumeImportFieldCandidateSchema.parse({
      ...candidate,
      resolution: "auto_applied",
      resolutionReason: "applied_into_empty_profile",
      resolvedAt,
    });
  });
}

// One branch can leave the issuer in a certificate's name while another
// separates the same source fields. Match the exact name-plus-issuer pair;
// a dash alone is not a reason to split a qualification level.
function normalizeCertificationNamesFromSiblings(
  candidates: readonly ResumeImportFieldCandidate[],
): ResumeImportFieldCandidate[] {
  return candidates.map((candidate) => {
    if (
      candidate.target.section !== "certification" ||
      !isObject(candidate.value)
    )
      return candidate;
    const name = recordFieldText(candidate.value, "name");
    const sibling = candidates.find((other) => {
      if (
        other.id === candidate.id ||
        other.target.section !== "certification" ||
        !isObject(other.value)
      )
        return false;
      const otherName = recordFieldText(other.value, "name");
      const issuer = recordFieldText(other.value, "issuer");
      return (
        otherName.length > 0 &&
        issuer.length > 0 &&
        name === `${otherName} ${issuer}`
      );
    });
    if (!sibling || !isObject(sibling.value)) return candidate;
    const value = {
      ...candidate.value,
      name: sibling.value.name ?? null,
      issuer: candidate.value.issuer ?? sibling.value.issuer ?? null,
    };
    return {
      ...candidate,
      value,
      normalizedValue: value,
      valuePreview: buildValuePreview(value),
    };
  });
}

function isSchoolOnlyEducationCandidate(
  candidate: ResumeImportFieldCandidate,
): boolean {
  return (
    candidate.target.section === "education" &&
    isObject(candidate.value) &&
    recordFieldText(candidate.value, "schoolName").length > 0 &&
    [
      "degree",
      "fieldOfStudy",
      "startDate",
      "endDate",
      "summary",
      "location",
    ].every((key) => recordFieldText(candidate.value, key).length === 0)
  );
}

function isRedundantUnstructuredRecordCandidate(
  candidate: ResumeImportFieldCandidate,
  candidates: readonly ResumeImportFieldCandidate[],
): boolean {
  if (!isRecordTarget(candidate)) return false;
  if (isSchoolOnlyEducationCandidate(candidate)) {
    const school = recordFieldText(candidate.value, "schoolName");
    const complete = candidates.filter(
      (other) =>
        other.id !== candidate.id &&
        other.target.section === "education" &&
        !isSchoolOnlyEducationCandidate(other) &&
        recordFieldText(other.value, "schoolName") === school,
    );
    return (
      complete.length > 0 &&
      complete.every(
        (other) =>
          complete[0] !== undefined &&
          areEquivalentRecordCandidates(complete[0], other),
      )
    );
  }
  if (
    isObject(candidate.value) &&
    ["project", "certification"].includes(candidate.target.section)
  ) {
    const name = recordFieldText(candidate.value, "name");
    const containedNames = new Set(
      candidates.flatMap((other) => {
        const otherName = recordFieldText(other.value, "name");
        return other.id !== candidate.id &&
          other.target.section === candidate.target.section &&
          otherName.length > 3 &&
          name !== otherName &&
          name.includes(otherName)
          ? [otherName]
          : [];
      }),
    );
    return containedNames.size >= 2;
  }
  if (typeof candidate.value !== "string") return false;

  const evidence = normalizeText(candidate.value);
  if (!evidence) {
    return false;
  }

  const structured = candidates.filter(
    (other) =>
      other.id !== candidate.id &&
      other.target.section === candidate.target.section &&
      other.target.key === candidate.target.key &&
      isObject(other.value) &&
      hasSufficientEvidence(other),
  );
  if (
    structured.some(
      (other) => normalizeText(other.evidenceText ?? "") === evidence,
    )
  )
    return true;
  const names = new Set(
    structured.flatMap((other) => {
      const name = recordFieldText(
        other.value,
        candidate.target.section === "education" ? "schoolName" : "name",
      );
      return name.length > 3 && evidence.includes(name) ? [name] : [];
    }),
  );
  return (
    ["project", "certification", "education"].includes(
      candidate.target.section,
    ) &&
    (names.size >= 2 || names.has(evidence))
  );
}

function isAutoApplyLiteralField(
  candidate: ResumeImportFieldCandidate,
): boolean {
  return [
    "firstName",
    "middleName",
    "lastName",
    "fullName",
    "email",
    "phone",
    "linkedinUrl",
    "githubUrl",
    "portfolioUrl",
    "personalWebsiteUrl",
    "currentLocation",
    "preferredEmail",
    "preferredPhone",
  ].includes(candidate.target.key);
}

function hasSufficientEvidence(candidate: ResumeImportFieldCandidate): boolean {
  return (
    candidate.sourceBlockIds.length > 0 ||
    (candidate.visualEvidence?.length ?? 0) > 0
  );
}

function isLikelyPersonNamePart(value: string): boolean {
  const trimmed = value.trim();

  return (
    trimmed.length > 0 &&
    /^\p{Lu}[\p{L}\p{M}.'’ʼ-]*$/u.test(trimmed) &&
    !/\b(?:senior|junior|staff|principal|lead|head|chief|associate|intern|engineer|developer|designer|manager|director|analyst|consultant|specialist|architect|technical|product|platform|frontend|front[- ]end|backend|back[- ]end|full[- ]stack)\b/iu.test(
      trimmed,
    )
  );
}

function shouldAutoApplyPlaceholderReplacement(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): boolean {
  if (!isFreshStartCandidateProfile(profile)) {
    return false;
  }

  const recommendation = recommendationForCandidate(candidate);

  if (recommendation === "abstain") {
    return false;
  }

  const placeholderReviewBypassKey = `${candidate.target.section}.${candidate.target.key}`;
  const canBypassNeedsReviewForFreshStart =
    recommendation === "auto_apply" ||
    placeholderReviewBypassKey === "identity.headline" ||
    placeholderReviewBypassKey === "identity.summary" ||
    placeholderReviewBypassKey === "identity.yearsExperience";

  if (!canBypassNeedsReviewForFreshStart) {
    return false;
  }

  const currentValue = existingScalarValueForCandidate(
    profile,
    searchPreferences,
    candidate,
  );

  if (!isPlaceholderScalarValue(profile, candidate, currentValue)) {
    return false;
  }

  if (!hasSufficientEvidence(candidate)) {
    return false;
  }

  const overall = candidateOverallConfidence(candidate);

  switch (placeholderReviewBypassKey) {
    case "identity.firstName":
    case "identity.middleName":
    case "identity.lastName":
      return (
        typeof candidate.value === "string" &&
        isLikelyPersonNamePart(candidate.value) &&
        overall >= 0.8
      );
    case "identity.fullName":
      return (
        typeof candidate.value === "string" &&
        isLikelyPersonName(candidate.value) &&
        overall >= 0.82
      );
    case "identity.headline": {
      if (typeof candidate.value !== "string") {
        return false;
      }

      const trimmed = candidate.value.trim();
      return (
        trimmed.length > 0 &&
        trimmed.length <= 72 &&
        trimmed.split(/\s+/).length <= 10 &&
        !/[@]|https?:\/\//i.test(trimmed) &&
        overall >= 0.75
      );
    }
    case "identity.summary":
      return (
        typeof candidate.value === "string" &&
        candidate.value.trim().length >= 48 &&
        overall >= 0.74
      );
    case "identity.yearsExperience":
      return (
        typeof candidate.value === "number" &&
        candidate.value > 0 &&
        overall >= 0.75
      );
    case "location.currentLocation":
      return (
        typeof candidate.value === "string" &&
        isLikelyLocationValue(candidate.value) &&
        overall >= 0.75
      );
    default:
      return false;
  }
}

function canAutoApplyDespiteWorkspaceConflict(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): boolean {
  if (
    !scalarValueConflictsWithWorkspace(profile, searchPreferences, candidate)
  ) {
    return true;
  }

  // A literal the resume states (an email, a phone) may replace a stored
  // value only on a profile nobody has touched yet. Importing again used to
  // put the resume's old email back over the one the person had just
  // changed; now the difference waits for review, as the import promises.
  return (
    isUntouchedFreshStartProfile(profile) &&
    isDocumentTextCandidate(candidate) &&
    isAutoApplyLiteralField(candidate) &&
    hasSufficientEvidence(candidate)
  );
}

function isLikelyPersonName(value: string): boolean {
  return isLikelyPersonNameFromIdentity(value);
}

function isStrongLiteralIdentityCandidate(
  candidate: ResumeImportFieldCandidate,
): boolean {
  return (
    isDocumentTextCandidate(candidate) &&
    candidate.target.section === "identity" &&
    candidate.target.key === "fullName" &&
    typeof candidate.value === "string" &&
    isLikelyPersonName(candidate.value) &&
    hasSufficientEvidence(candidate) &&
    candidateOverallConfidence(candidate) >= 0.82
  );
}

function getDerivedNameParts(fullName: string): {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
} {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  return {
    firstName: parts[0] ?? null,
    middleName: parts.length > 2 ? parts.slice(1, -1).join(" ") : null,
    lastName: parts.length > 1 ? (parts[parts.length - 1] ?? null) : null,
  };
}

function isLikelyLocationValue(value: string): boolean {
  const cleaned = value
    .trim()
    .replace(/^Address:\s*/i, "")
    .replace(/\s*\([^)]*\)\s*$/u, "")
    .trim();

  if (!cleaned || cleaned.length > 80) {
    return false;
  }

  if (/[@]|https?:\/\//i.test(cleaned)) {
    return false;
  }

  if (/[.!?]/.test(cleaned)) {
    return false;
  }

  if (
    /\b(recently|decided|return|passion|experience|building|driven|improving)\b/i.test(
      cleaned,
    )
  ) {
    return false;
  }

  return (
    /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Za-z][A-Za-z\s.'-]+$/.test(cleaned) ||
    /^[A-Za-z][A-Za-z\s.'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(
      cleaned,
    ) ||
    /^[A-Za-z][A-Za-z\s.'-]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?$/.test(cleaned)
  );
}

export function isListTarget(candidate: ResumeImportFieldCandidate): boolean {
  if (
    candidate.target.section === "skill" &&
    candidate.target.key === "record"
  ) {
    return true;
  }

  return [
    "targetRoles",
    "locations",
    "workModes",
    "employmentTypes",
    "skills",
    "skillGroups.coreSkills",
    "skillGroups.tools",
    "skillGroups.languagesAndFrameworks",
    "skillGroups.softSkills",
    "skillGroups.highlightedSkills",
  ].includes(candidate.target.key);
}

export function isRecordTarget(candidate: ResumeImportFieldCandidate): boolean {
  return [
    "experience",
    "education",
    "certification",
    "link",
    "project",
    "language",
    "proof_point",
  ].includes(candidate.target.section);
}

function normalizedStringValuesMatch(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftValues = new Set(left.map(normalizeText).filter(Boolean));
  const rightValues = new Set(right.map(normalizeText).filter(Boolean));
  return (
    leftValues.size === rightValues.size &&
    [...leftValues].every((value) => rightValues.has(value))
  );
}

function listCandidateMatchesWorkspace(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): boolean {
  const values = toCandidateListValues(candidate);
  if (values.length === 0) {
    return false;
  }

  switch (`${candidate.target.section}.${candidate.target.key}`) {
    case "search_preferences.targetRoles":
      return (
        normalizedStringValuesMatch(values, profile.targetRoles) &&
        normalizedStringValuesMatch(values, searchPreferences.targetRoles)
      );
    case "search_preferences.locations":
      return (
        normalizedStringValuesMatch(values, profile.locations) &&
        normalizedStringValuesMatch(values, searchPreferences.locations)
      );
    case "search_preferences.workModes":
      return normalizedStringValuesMatch(values, searchPreferences.workModes);
    case "skill.skills":
    case "skill.record":
      return normalizedStringValuesMatch(values, profile.skills);
    case "skill.skillGroups.coreSkills":
      return normalizedStringValuesMatch(
        values,
        profile.skillGroups.coreSkills,
      );
    case "skill.skillGroups.tools":
      return normalizedStringValuesMatch(values, profile.skillGroups.tools);
    case "skill.skillGroups.languagesAndFrameworks":
      return normalizedStringValuesMatch(
        values,
        profile.skillGroups.languagesAndFrameworks,
      );
    case "skill.skillGroups.softSkills":
      return normalizedStringValuesMatch(
        values,
        profile.skillGroups.softSkills,
      );
    case "skill.skillGroups.highlightedSkills":
      return normalizedStringValuesMatch(
        values,
        profile.skillGroups.highlightedSkills,
      );
    default:
      return false;
  }
}

// Record identity means the same role or school, not the same saved facts.
// An import may omit saved details, but new or changed details need review.
function recordDetailsAlreadySaved(
  saved: Record<string, unknown>,
  incoming: ResumeImportFieldCandidate["value"],
): boolean {
  if (!isObject(incoming)) return false;
  return Object.entries(incoming).every(([key, value]) => {
    if (key === "id" || key === "isDraft" || value === null) return true;
    if (Array.isArray(value)) {
      const savedValues = new Set(toStringArray(saved[key]).map(normalizeText));
      return toStringArray(value).every((item) =>
        savedValues.has(normalizeText(item)),
      );
    }
    if (typeof value === "string") {
      if (!value.trim()) return true;
      if (key === "startDate" || key === "endDate") {
        return (
          canonicalizeRecordDateText(value) ===
          canonicalizeRecordDateText(saved[key])
        );
      }
      return (
        normalizeText(value) ===
        normalizeText(typeof saved[key] === "string" ? saved[key] : "")
      );
    }
    // False is the normalized default when a resume does not say ongoing.
    // A stated end date is compared above; explicit ongoing status matters.
    if (key === "isCurrent") return value !== true || saved[key] === true;
    return value === saved[key];
  });
}

function recordCandidateMatchesWorkspace(
  profile: CandidateProfile,
  candidate: ResumeImportFieldCandidate,
): boolean {
  if (candidate.target.section === "experience") {
    return profile.experiences.some(
      (record) =>
        areEquivalentExperienceRecords(record, candidate.value) &&
        recordDetailsAlreadySaved(record, candidate.value),
    );
  }

  if (candidate.target.section === "education") {
    if (isSchoolOnlyEducationCandidate(candidate)) {
      return (
        profile.education.filter(
          (record) =>
            recordFieldText(record, "schoolName") ===
            recordFieldText(candidate.value, "schoolName"),
        ).length === 1
      );
    }
    return profile.education.some(
      (record) =>
        areEquivalentEducationRecords(record, candidate.value) &&
        recordDetailsAlreadySaved(record, candidate.value),
    );
  }

  return false;
}

function candidateMatchesWorkspace(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): boolean {
  return (
    scalarValueMatchesWorkspace(profile, searchPreferences, candidate) ||
    listCandidateMatchesWorkspace(profile, searchPreferences, candidate) ||
    recordCandidateMatchesWorkspace(profile, candidate)
  );
}

function shouldAutoApply(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
): boolean {
  if (candidate.resolutionReason === "grounded_completeness_suggestion")
    return false;
  if (
    shouldAutoApplyPlaceholderReplacement(profile, searchPreferences, candidate)
  ) {
    return true;
  }

  // A sentence the resume states outright fills an empty eligibility answer.
  // It never replaces one the person saved; that difference waits for review.
  if (candidate.target.section === "work_eligibility") {
    return (
      isDocumentTextCandidate(candidate) &&
      hasSufficientEvidence(candidate) &&
      isEmptyWorkEligibilityValue(
        existingScalarValueForCandidate(profile, searchPreferences, candidate),
      )
    );
  }

  if (candidate.target.section === "narrative") {
    return false;
  }

  if (candidate.target.section === "proof_point") {
    return false;
  }

  if (candidate.target.section === "answer_bank") {
    return false;
  }

  if (
    candidate.target.section === "application_identity" &&
    candidate.target.key === "preferredLinkUrls"
  ) {
    return false;
  }

  if (recommendationForCandidate(candidate) !== "auto_apply") {
    return false;
  }

  if (!hasSufficientEvidence(candidate)) {
    return false;
  }

  if (
    !canAutoApplyDespiteWorkspaceConflict(profile, searchPreferences, candidate)
  ) {
    return false;
  }

  if (isRecordTarget(candidate) || isListTarget(candidate)) {
    return false;
  }

  if (isAutoApplyLiteralField(candidate)) {
    switch (candidate.target.key) {
      case "fullName":
        return (
          typeof candidate.value === "string" &&
          isLikelyPersonName(candidate.value) &&
          candidateOverallConfidence(candidate) >= 0.82
        );
      case "currentLocation":
        return (
          typeof candidate.value === "string" &&
          isLikelyLocationValue(candidate.value) &&
          candidateOverallConfidence(candidate) >= 0.8
        );
      default:
        return candidateOverallConfidence(candidate) >= 0.82;
    }
  }

  return false;
}

/** A record date as a month count; a bare year spans its whole year. */
function recordMonth(value: unknown, edge: "start" | "end"): number | null {
  const text = canonicalizeRecordDateText(value);
  const match = text ? /^(\d{4})(?:-(\d{2}))?$/.exec(text) : null;
  if (!match) {
    return null;
  }
  const month = match[2] ? Number(match[2]) : edge === "start" ? 1 : 12;
  return Number(match[1]) * 12 + month - 1;
}

/** The months a role covers; null when its dates cannot be read. */
function roleSpan(value: {
  startDate?: unknown;
  endDate?: unknown;
  isCurrent?: unknown;
}): { start: number; end: number } | null {
  const start = recordMonth(value.startDate, "start");
  if (start === null) {
    return null;
  }
  const endText =
    typeof value.endDate === "string" ? value.endDate.trim().toLowerCase() : "";
  if (
    value.isCurrent === true ||
    endText === "present" ||
    endText === "current"
  ) {
    return { start, end: Number.POSITIVE_INFINITY };
  }
  const end = recordMonth(value.endDate, "end");
  return end === null ? null : { start, end };
}

const COMPANY_SUFFIX_WORDS = new Set([
  "inc",
  "ltd",
  "llc",
  "plc",
  "gmbh",
  "ag",
  "sa",
  "bv",
  "co",
  "corp",
  "corporation",
  "company",
  "limited",
]);

function companyWords(value: unknown): string {
  return typeof value === "string"
    ? normalizeText(value)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .split(" ")
        .filter((word) => word && !COMPANY_SUFFIX_WORDS.has(word))
        .join(" ")
    : "";
}

function sameCompany(left: string, right: string): boolean {
  if (!left || !right) {
    return true;
  }
  return (
    left === right ||
    ` ${left} `.includes(` ${right} `) ||
    ` ${right} `.includes(` ${left} `)
  );
}

/**
 * True when a role the import read cannot be a saved role the person merged,
 * split or retitled: it has a company and readable dates, and no saved card
 * at that company covers any of those months. Anything unclear is treated as
 * an overlap, so it waits for review.
 */
function overlapsNoSavedRole(
  profile: CandidateProfile,
  value: ResumeImportFieldCandidate["value"],
): boolean {
  if (!isObject(value)) {
    return false;
  }
  const company = companyWords(value.companyName);
  const span = roleSpan(value);
  if (!company || !span) {
    return false;
  }
  return profile.experiences.every((saved) => {
    if (!sameCompany(companyWords(saved.companyName), company)) {
      return true;
    }
    const savedSpan = roleSpan(saved);
    return (
      savedSpan !== null &&
      (savedSpan.end < span.start || span.end < savedSpan.start)
    );
  });
}

function shouldMergeRecordCandidate(
  profile: CandidateProfile,
  candidate: ResumeImportFieldCandidate,
): boolean {
  if (!isRecordTarget(candidate)) {
    return false;
  }

  if (!isObject(candidate.value)) {
    return false;
  }

  // Roles and schools the person already has are theirs: one the import
  // reads that matches none of them may be a role they merged, split or
  // retitled, so it waits for review instead of landing beside the edited
  // card. A role at a company none of their cards covers for those dates
  // cannot be one of those, so it is added like on a first import.
  // Certificates, links, projects and languages are only ever added (see
  // profile-merge), so a new one can still land on its own.
  if (
    (candidate.target.section === "experience" ||
      candidate.target.section === "education") &&
    !isUntouchedFreshStartProfile(profile) &&
    !isEmptyRecordSection(profile, candidate.target.section) &&
    !(
      candidate.target.section === "experience" &&
      overlapsNoSavedRole(profile, candidate.value)
    )
  ) {
    return false;
  }

  const overall = candidateOverallConfidence(candidate);

  switch (candidate.target.section) {
    case "experience": {
      const value = candidate.value;
      const hasCompany =
        typeof value.companyName === "string" &&
        value.companyName.trim().length > 0;
      const hasTitle =
        typeof value.title === "string" && value.title.trim().length > 0;
      const hasDates =
        (typeof value.startDate === "string" &&
          value.startDate.trim().length > 0) ||
        (typeof value.endDate === "string" &&
          value.endDate.trim().length > 0) ||
        value.isCurrent === true;
      const completeness = scoreExperienceRecordCompleteness(candidate.value);
      const hasSubstantiveDetails =
        (typeof value.summary === "string" &&
          value.summary.trim().length >= 24) ||
        toNarrativeStringArray(value.achievements).length > 0 ||
        toStringArray(value.skills).length > 0;
      const requiredCompleteness = hasDates
        ? hasSubstantiveDetails
          ? 4
          : 5
        : 3;
      const requiredOverall = hasDates && hasSubstantiveDetails ? 0.68 : 0.72;

      return (
        isFreshStartCandidateProfile(profile) &&
        hasCompany &&
        hasTitle &&
        (hasDates || hasSubstantiveDetails) &&
        completeness >= requiredCompleteness &&
        overall >= requiredOverall &&
        hasSufficientEvidence(candidate)
      );
    }
    case "education": {
      const value = candidate.value;
      const hasSchool =
        typeof value.schoolName === "string" &&
        value.schoolName.trim().length > 0;
      const hasDegree =
        typeof value.degree === "string" && value.degree.trim().length > 0;
      const hasField =
        typeof value.fieldOfStudy === "string" &&
        value.fieldOfStudy.trim().length > 0;
      const completeness = scoreEducationRecordCompleteness(candidate.value);

      return (
        isFreshStartCandidateProfile(profile) &&
        hasSchool &&
        (hasDegree || hasField) &&
        completeness >= 2 &&
        overall >= 0.62 &&
        hasSufficientEvidence(candidate)
      );
    }
    case "certification": {
      const value = candidate.value;
      const hasName =
        typeof value.name === "string" && value.name.trim().length > 0;
      return hasName && overall >= 0.6 && hasSufficientEvidence(candidate);
    }
    case "link": {
      const value = candidate.value;
      const hasUrl =
        typeof value.url === "string" && value.url.trim().length > 0;
      return hasUrl && overall >= 0.72 && hasSufficientEvidence(candidate);
    }
    case "project": {
      const value = candidate.value;
      const hasName =
        typeof value.name === "string" && value.name.trim().length > 0;
      return hasName && overall >= 0.58 && hasSufficientEvidence(candidate);
    }
    case "language": {
      const value = candidate.value;
      const hasLanguage =
        typeof value.language === "string" && value.language.trim().length > 0;
      return hasLanguage && overall >= 0.7 && hasSufficientEvidence(candidate);
    }
    case "proof_point": {
      const value = candidate.value;
      const hasTitle =
        typeof value.title === "string" && value.title.trim().length > 0;
      const hasClaim =
        typeof value.claim === "string" && value.claim.trim().length > 0;
      return (
        hasTitle &&
        hasClaim &&
        overall >= 0.88 &&
        hasSufficientEvidence(candidate)
      );
    }
    default:
      return false;
  }
}

function shouldMergeListCandidate(
  candidate: ResumeImportFieldCandidate,
): boolean {
  if (candidate.target.section === "search_preferences") {
    return false;
  }

  if (
    candidate.target.section === "skill" &&
    candidate.target.key === "record"
  ) {
    return false;
  }

  if (!isListTarget(candidate)) {
    return false;
  }

  const values = toCandidateListValues(candidate);
  if (values.length === 0) {
    return false;
  }

  if (
    candidate.target.section === "skill" &&
    candidate.target.key === "skills" &&
    values.length === 1 &&
    candidate.notes.includes("deterministic_stage_fallback")
  ) {
    return candidateOverallConfidence(candidate) >= 0.82;
  }

  return candidateOverallConfidence(candidate) >= 0.58;
}

function shouldAutoApplySkillRecordCandidate(
  candidate: ResumeImportFieldCandidate,
): boolean {
  return (
    candidate.target.section === "skill" &&
    candidate.target.key === "record" &&
    typeof candidate.value === "string" &&
    candidate.value.trim().length > 0 &&
    candidateOverallConfidence(candidate) >= 0.82 &&
    hasSufficientEvidence(candidate)
  );
}

function recordCandidateCompletenessScore(
  candidate: ResumeImportFieldCandidate,
): number {
  switch (candidate.target.section) {
    case "experience":
      return scoreExperienceRecordCompleteness(candidate.value);
    case "education":
      return scoreEducationRecordCompleteness(candidate.value);
    default:
      return 0;
  }
}

function compareRecordCandidates(
  left: ResumeImportFieldCandidate,
  right: ResumeImportFieldCandidate,
): number {
  const scoreDelta = candidateScore(right) - candidateScore(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const completenessDelta =
    recordCandidateCompletenessScore(right) -
    recordCandidateCompletenessScore(left);
  if (completenessDelta !== 0) {
    return completenessDelta;
  }

  return left.id.localeCompare(right.id);
}

function groupCandidatesForReconciliation(
  candidates: readonly ResumeImportFieldCandidate[],
): ResumeImportFieldCandidate[][] {
  const groups: ResumeImportFieldCandidate[][] = [];
  const scalarGroups = new Map<string, ResumeImportFieldCandidate[]>();

  for (const candidate of candidates) {
    if (isRecordTarget(candidate)) {
      const existingGroup = groups.find((group) =>
        candidate.target.section === "education"
          ? group.every((existing) =>
              areEquivalentRecordCandidates(existing, candidate),
            )
          : group.some((existing) =>
              areEquivalentRecordCandidates(existing, candidate),
            ),
      );

      if (existingGroup) {
        existingGroup.push(candidate);
        continue;
      }

      groups.push([candidate]);
      continue;
    }

    const key = stringifyCandidateTarget(candidate);
    const current = scalarGroups.get(key) ?? [];
    current.push(candidate);
    scalarGroups.set(key, current);
  }

  groups.push(...scalarGroups.values());
  return groups;
}

function resolutionReasonForCandidate(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
  resolution: ResumeImportFieldCandidate["resolution"],
): string {
  switch (resolution) {
    case "auto_applied":
      return "high_confidence_literal_with_direct_evidence";
    case "abstained":
      return recommendationForCandidate(candidate) === "abstain"
        ? "composite_confidence_recommended_abstain"
        : "insufficient_confidence_or_evidence";
    case "rejected":
      if (candidateMatchesWorkspace(profile, searchPreferences, candidate)) {
        return "already_matches_workspace_value";
      }

      return scalarValueConflictsWithWorkspace(
        profile,
        searchPreferences,
        candidate,
      )
        ? "conflicts_with_existing_profile_value"
        : "lower_ranked_duplicate_candidate";
    case "needs_review": {
      if (isRecordTarget(candidate)) {
        return "record_candidates_require_review";
      }

      if (isListTarget(candidate)) {
        return scalarValueConflictsWithWorkspace(
          profile,
          searchPreferences,
          candidate,
        )
          ? "conflicts_with_existing_profile_value"
          : "list_candidates_require_review";
      }

      if (candidate.target.section === "narrative") {
        return "shared_memory_requires_review";
      }

      if (!hasSufficientEvidence(candidate)) {
        return "missing_grounded_evidence";
      }

      if (
        scalarValueConflictsWithWorkspace(profile, searchPreferences, candidate)
      ) {
        return "conflicts_with_existing_profile_value";
      }

      return "manual_review_required_by_confidence_policy";
    }
  }
}

function applyCandidateResolution(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidate: ResumeImportFieldCandidate,
  resolution: ResumeImportFieldCandidate["resolution"],
  resolutionReasonOverride?: string,
): ResumeImportFieldCandidate {
  const resolvedAt =
    resolution === "auto_applied" ? new Date().toISOString() : null;
  const normalizedValue = normalizeRecordCandidateValue(candidate);

  return ResumeImportFieldCandidateSchema.parse({
    ...candidate,
    value: normalizedValue,
    // The preview is what review cards show; regenerate it from the value
    // that will actually be applied so a card can never promise one text
    // and confirm another.
    valuePreview: buildValuePreview(normalizedValue),
    confidence:
      resolution === "abstained"
        ? Math.min(candidate.confidence, candidateOverallConfidence(candidate))
        : candidate.confidence,
    resolution,
    resolutionReason:
      (resolution === "needs_review" &&
      candidate.resolutionReason === "grounded_completeness_suggestion"
        ? candidate.resolutionReason
        : resolutionReasonOverride) ??
      resolutionReasonForCandidate(
        profile,
        searchPreferences,
        candidate,
        resolution,
      ),
    resolvedAt,
  });
}

function sourceLabelForCandidate(
  candidate: ResumeImportFieldCandidate,
): string {
  switch (candidate.sourceKind) {
    case "parser_literal":
    case "model_identity_summary":
    case "model_experience":
    case "model_background":
    case "model_shared_memory":
      return "Document text";
    case "vision_omni":
      return "Visual scan";
    case "adjudicator":
      return "Import comparison";
    case "reconciler":
      return "Import reconciliation";
    default: {
      const _exhaustive: never = candidate.sourceKind;
      throw new Error(`Unhandled sourceKind: ${String(_exhaustive)}`);
    }
  }
}

function toConflictChoice(
  candidate: ResumeImportFieldCandidate,
  recommended: boolean,
): ResumeImportConflictChoice {
  const valuePreview =
    candidate.valuePreview ?? buildValuePreview(candidate.value);

  return {
    id: `${candidate.id}_choice`,
    label: candidate.label,
    sourceLabel: sourceLabelForCandidate(candidate),
    value: candidate.value,
    valuePreview,
    evidenceText: candidate.evidenceText,
    confidence: candidateOverallConfidence(candidate),
    recommended,
    notes: candidate.notes,
    sourceCandidateIds: [candidate.id],
    visualEvidence: candidate.visualEvidence ?? [],
  };
}

function hasTextVisionMaterialConflict(
  candidates: readonly ResumeImportFieldCandidate[],
): boolean {
  const hasVision = candidates.some(
    (candidate) => candidate.sourceKind === "vision_omni",
  );
  const hasText = candidates.some(
    (candidate) => sourceLabelForCandidate(candidate) === "Document text",
  );

  if (!hasVision || !hasText) {
    return false;
  }

  const relevantCandidates = candidates.filter(
    (candidate) =>
      candidate.sourceKind === "vision_omni" ||
      sourceLabelForCandidate(candidate) === "Document text",
  );
  const normalizedValues = new Set(
    relevantCandidates.map((candidate) =>
      candidate.target.section === "identity" &&
      candidate.target.key === "fullName" &&
      typeof candidate.value === "string"
        ? candidate.value
            .normalize("NFKD")
            .replace(/\p{M}/gu, "")
            .toLocaleLowerCase()
            .replace(/\s+/g, " ")
            .trim()
        : normalizeText(
            candidate.valuePreview ??
              buildValuePreview(candidate.value) ??
              JSON.stringify(candidate.value),
          ),
    ),
  );
  return normalizedValues.size > 1;
}

function candidateSharesMaterialTextVisionConflict(
  candidate: ResumeImportFieldCandidate,
  candidates: readonly ResumeImportFieldCandidate[],
): boolean {
  const sameTargetCandidates = candidates.filter(
    (other) =>
      stringifyCandidateTarget(other) === stringifyCandidateTarget(candidate),
  );

  return hasTextVisionMaterialConflict(sameTargetCandidates);
}

function isTextVisionWinner(candidate: ResumeImportFieldCandidate): boolean {
  return (
    candidate.resolution === "auto_applied" ||
    candidate.resolution === "needs_review"
  );
}

function applyConflictChoicesToGroup(
  candidates: readonly ResumeImportFieldCandidate[],
  winner: ResumeImportFieldCandidate,
): ResumeImportFieldCandidate[] {
  if (
    !hasTextVisionMaterialConflict(candidates) ||
    candidates.some(
      (candidate) => isRecordTarget(candidate) || isListTarget(candidate),
    )
  ) {
    return [...candidates];
  }

  const recommendedCandidate =
    candidates.find(isStrongLiteralIdentityCandidate) ?? winner;
  if (recommendedCandidate.sourceKind === "adjudicator") {
    return [...candidates];
  }

  const ranked = [...candidates].sort(
    (left, right) => candidateScore(right) - candidateScore(left),
  );
  const choices = ranked.map((candidate) =>
    toConflictChoice(candidate, candidate.id === recommendedCandidate.id),
  );
  const alternativeValues = choices.flatMap((choice) =>
    choice.recommended ? [] : [choice.value],
  );

  return candidates.map((candidate) => {
    if (candidate.id !== recommendedCandidate.id) {
      return candidate;
    }

    return ResumeImportFieldCandidateSchema.parse({
      ...candidate,
      conflictChoices: choices,
      alternatives: alternativeValues,
      resolution: "needs_review",
      resolutionReason: "text_vs_visual_conflict_requires_review",
      resolvedAt: null,
      notes: uniqueStrings([
        ...candidate.notes,
        "Different values were found in document text and visual scan. Review the alternatives before accepting.",
      ]),
    });
  });
}

function appendResolvedConflictGroup(
  resolved: ResumeImportFieldCandidate[],
  groupResolved: readonly ResumeImportFieldCandidate[],
): void {
  const winner = groupResolved.find(isTextVisionWinner) ?? groupResolved[0];
  resolved.push(
    ...(winner
      ? applyConflictChoicesToGroup(groupResolved, winner)
      : groupResolved),
  );
}

function resolveRedundantFreshStartNamePartCandidates(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidates: readonly ResumeImportFieldCandidate[],
): ResumeImportFieldCandidate[] {
  if (!isFreshStartCandidateProfile(profile)) {
    return [...candidates];
  }

  const autoAppliedFullName = candidates.find(
    (candidate) =>
      candidate.target.section === "identity" &&
      candidate.target.key === "fullName" &&
      candidate.resolution === "auto_applied" &&
      typeof candidate.value === "string" &&
      isLikelyPersonName(candidate.value),
  );

  if (!autoAppliedFullName || typeof autoAppliedFullName.value !== "string") {
    return [...candidates];
  }

  const derivedNameParts = getDerivedNameParts(autoAppliedFullName.value);

  return candidates.map((candidate) => {
    if (
      candidate.resolution !== "needs_review" ||
      candidate.target.section !== "identity" ||
      typeof candidate.value !== "string"
    ) {
      return candidate;
    }

    const expectedValue = (() => {
      switch (candidate.target.key) {
        case "firstName":
          return derivedNameParts.firstName;
        case "middleName":
          return derivedNameParts.middleName;
        case "lastName":
          return derivedNameParts.lastName;
        default:
          return null;
      }
    })();

    if (
      !expectedValue ||
      normalizeText(candidate.value) !== normalizeText(expectedValue)
    ) {
      return candidate;
    }

    return applyCandidateResolution(
      profile,
      searchPreferences,
      candidate,
      "rejected",
    );
  });
}

export const DUPLICATE_LINK_REASON = "duplicate_link_candidate";

const GENERIC_LINK_KEYS = new Set(["portfolioUrl", "personalWebsiteUrl"]);
const NAMED_LINK_KEYS = ["linkedinUrl", "githubUrl"] as const;

function normalizeLinkForComparison(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");
}

/**
 * The model sometimes copies the GitHub or LinkedIn address into the generic
 * portfolio or personal-website slot as well, so Profile > Links showed the
 * same URL under two labels. A generic link that matches a named link, either
 * one already saved or one proposed in the same run, is not a second link.
 */
function isDuplicateLinkCandidate(
  profile: CandidateProfile,
  candidate: ResumeImportFieldCandidate,
  candidates: readonly ResumeImportFieldCandidate[],
): boolean {
  if (
    candidate.target.section !== "contact" ||
    !GENERIC_LINK_KEYS.has(candidate.target.key)
  ) {
    return false;
  }
  const value = normalizeLinkForComparison(candidate.value);
  if (!value) {
    return false;
  }
  for (const key of NAMED_LINK_KEYS) {
    if (normalizeLinkForComparison(profile[key]) === value) {
      return true;
    }
  }
  return candidates.some(
    (other) =>
      other.id !== candidate.id &&
      other.target.section === "contact" &&
      (NAMED_LINK_KEYS as readonly string[]).includes(other.target.key) &&
      normalizeLinkForComparison(other.value) === value,
  );
}

export function reconcileCandidates(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidates: readonly ResumeImportFieldCandidate[],
  bundle?: ResumeDocumentBundle,
  options: {
    /**
     * The model read every section (ADR 0041): its values stand, and the
     * rule checks against the resume text (skill fragments, role splitting,
     * location-shaped titles, activity sections) are not run over them.
     */
    readByModel?: boolean;
  } = {},
): ResumeImportFieldCandidate[] {
  const resolved: ResumeImportFieldCandidate[] = [];
  const { candidates: foldedCandidates, foldedAway } =
    foldLooseRecordFieldCandidates(
      candidates.map((candidate) => ({
        ...candidate,
        value: cleanImportedValue(
          candidate.value,
        ) as ResumeImportFieldCandidate["value"],
      })),
    );
  for (const candidate of foldedAway) {
    resolved.push(
      applyCandidateResolution(
        profile,
        searchPreferences,
        candidate,
        "rejected",
        FOLDED_INTO_RECORD_REASON,
      ),
    );
  }
  const normalizedCandidates: ResumeImportFieldCandidate[] = [];
  const recordCandidates = normalizeCertificationNamesFromSiblings(
    foldedCandidates.map((candidate) =>
      normalizeRecordCandidateForReconciliation(
        candidate,
        bundle,
        options.readByModel === true,
      ),
    ),
  );
  for (const normalized of recordCandidates) {
    if (!hasMeaningfulRecordValue(normalized)) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          normalized,
          "rejected",
          "empty_record_candidate",
        ),
      );
      continue;
    }
    if (isRedundantUnstructuredRecordCandidate(normalized, recordCandidates)) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          normalized,
          "rejected",
        ),
      );
      continue;
    }
    if (
      isSchoolOnlyEducationCandidate(normalized) &&
      recordCandidateMatchesWorkspace(profile, normalized)
    ) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          normalized,
          "rejected",
        ),
      );
      continue;
    }
    const checked = options.readByModel
      ? { candidate: normalized, reject: false, review: false }
      : validateResumeImportSourceCandidate(
          normalized,
          bundle,
          recordCandidates,
        );
    if (checked.reject || checked.review) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          checked.candidate,
          checked.reject ? "rejected" : "needs_review",
          checked.reject
            ? "invalid_source_structure"
            : "import_shape_requires_review",
        ),
      );
    } else normalizedCandidates.push(checked.candidate);
  }
  const identityConflicts = findResumeImportIdentityConflicts(
    profile,
    normalizedCandidates,
  );
  // A resume that names someone other than the person whose profile this is
  // is not theirs to merge: nothing from it, jobs and schools included, is
  // added until they review it.
  const differentPersonConflict = normalizedCandidates
    .filter((candidate) => candidate.target.key === "fullName")
    .map((candidate) => identityConflicts.get(candidate.id))
    .find((conflict): conflict is string => Boolean(conflict));
  const candidatesForGrouping: ResumeImportFieldCandidate[] = [];

  for (const candidate of normalizedCandidates) {
    if (!hasMeaningfulRecordValue(candidate)) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          "rejected",
          "empty_record_candidate",
        ),
      );
      continue;
    }

    if (
      candidate.target.key === "phone" &&
      isClearlyResumeDateRange(candidate.value)
    ) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          "rejected",
          "invalid_phone_candidate",
        ),
      );
      continue;
    }

    if (isDuplicateLinkCandidate(profile, candidate, normalizedCandidates)) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          "rejected",
          DUPLICATE_LINK_REASON,
        ),
      );
      continue;
    }

    const identityConflict = identityConflicts.get(candidate.id);
    if (
      identityConflict &&
      !candidateSharesMaterialTextVisionConflict(
        candidate,
        normalizedCandidates,
      )
    ) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          "needs_review",
          `identity_mismatch_requires_review: ${identityConflict}`,
        ),
      );
      continue;
    }

    if (candidateMatchesWorkspace(profile, searchPreferences, candidate)) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          "rejected",
        ),
      );
      continue;
    }

    if (
      isRedundantUnstructuredRecordCandidate(candidate, normalizedCandidates)
    ) {
      resolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          "rejected",
        ),
      );
      continue;
    }

    candidatesForGrouping.push(candidate);
  }

  for (const group of groupCandidatesForReconciliation(candidatesForGrouping)) {
    const sorted = [...group].sort(
      (left, right) => candidateScore(right) - candidateScore(left),
    );

    if (sorted.length === 0) {
      continue;
    }

    const first = sorted[0];
    if (!first) {
      continue;
    }

    if (isRecordTarget(first) || isListTarget(first)) {
      if (isRecordTarget(first)) {
        const rankedByRecord = [...sorted].sort(compareRecordCandidates);
        const rankedGroup = rankedByRecord.map((candidate, index) =>
          index === 0
            ? enrichRecordCandidateFromSiblings(
                candidate,
                rankedByRecord.slice(1),
              )
            : candidate,
        );
        const recordGroupResolved: ResumeImportFieldCandidate[] = [];

        rankedGroup.forEach((candidate, index) => {
          const recommendation = recommendationForCandidate(candidate);
          const shouldAutoApplyCollectionCandidate =
            index === 0 && shouldMergeRecordCandidate(profile, candidate);
          const resolution =
            recommendation === "abstain"
              ? "abstained"
              : shouldAutoApplyCollectionCandidate
                ? "auto_applied"
                : index === 0
                  ? "needs_review"
                  : "rejected";

          const resolvedCandidate = applyCandidateResolution(
            profile,
            searchPreferences,
            candidate,
            resolution,
          );
          recordGroupResolved.push(resolvedCandidate);
        });
        appendResolvedConflictGroup(resolved, recordGroupResolved);
        continue;
      }

      const listGroupResolved: ResumeImportFieldCandidate[] = [];
      for (const candidate of sorted) {
        const recommendation = recommendationForCandidate(candidate);
        const shouldAutoApplyCollectionCandidate =
          shouldMergeListCandidate(candidate) ||
          shouldAutoApplySkillRecordCandidate(candidate);
        const resolution =
          recommendation === "abstain"
            ? "abstained"
            : shouldAutoApplyCollectionCandidate
              ? "auto_applied"
              : "needs_review";

        const resolvedCandidate = applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          resolution,
        );
        listGroupResolved.push(resolvedCandidate);
      }
      appendResolvedConflictGroup(resolved, listGroupResolved);
      continue;
    }

    const autoApplicableIndex = sorted.findIndex((candidate) =>
      shouldAutoApply(profile, searchPreferences, candidate),
    );
    const winningIndex = autoApplicableIndex === -1 ? 0 : autoApplicableIndex;

    const groupResolved: ResumeImportFieldCandidate[] = [];
    sorted.forEach((candidate, index) => {
      const autoApply = index === winningIndex && autoApplicableIndex !== -1;
      const recommendation = recommendationForCandidate(candidate);

      if (index === winningIndex) {
        groupResolved.push(
          applyCandidateResolution(
            profile,
            searchPreferences,
            candidate,
            autoApply
              ? "auto_applied"
              : recommendation === "abstain"
                ? "abstained"
                : "needs_review",
          ),
        );
        return;
      }

      groupResolved.push(
        applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          recommendation === "abstain" ? "abstained" : "rejected",
        ),
      );
    });
    appendResolvedConflictGroup(resolved, groupResolved);
  }

  const promoted = promoteImportCandidatesIntoEmptyProfile(
    profile,
    searchPreferences,
    resolveRedundantFreshStartNamePartCandidates(
      profile,
      searchPreferences,
      resolved,
    ),
    bundle,
  );
  const reconciled = promoted;
  if (!differentPersonConflict) {
    return reconciled;
  }
  return reconciled.map((candidate) =>
    candidate.resolution === "auto_applied"
      ? applyCandidateResolution(
          profile,
          searchPreferences,
          candidate,
          "needs_review",
          `identity_mismatch_requires_review: ${differentPersonConflict}`,
        )
      : candidate,
  );
}
