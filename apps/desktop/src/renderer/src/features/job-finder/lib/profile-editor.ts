import { normalizePublicLinkUrl } from "@nestor/contracts";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  type ResumeImportFieldCandidateSummary,
  SourceInstructionStatusSchema,
  type CandidateProfile,
  type JobDiscoveryTarget,
  type JobSearchPreferences,
} from "@nestor/contracts";
import type {
  DiscoveryTargetEditorValue,
  ProofBankEntryFormEntry,
} from "./job-finder-types";
import {
  deriveJobSourceLabel,
  isGeneratedJobSourceLabel,
} from "./job-source-display-name";
import {
  booleanToSelect,
  buildFullName,
  joinListInput,
  parseListInput,
  parseRequiredNonNegativeInteger,
  parseTokenListInput,
  selectToBoolean,
  toCertificationFormEntries,
  toEducationFormEntries,
  toExperienceFormEntries,
  toLanguageFormEntries,
  toLinkFormEntries,
  toProjectFormEntries,
  uniqueList,
} from "./job-finder-utils";
import {
  applyReviewCandidates,
  buildComparableValueFingerprint,
  buildEducationFormFingerprint,
  buildExperienceFormFingerprint,
} from "./profile-editor-review-candidates";
import type {
  ProfileEditorValues,
  SearchPreferencesEditorValues,
} from "./profile-editor-types";

export type {
  ProfileEditorValues,
  SearchPreferencesEditorValues,
} from "./profile-editor-types";

const PROFILE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * Profile contact fields are optional, but a value that is present must be a
 * usable email address. The canonical profile contract intentionally accepts
 * non-empty text for backwards compatibility, so the editor owns this
 * user-facing validation before a save request is created.
 */
export function getProfileEmailValidationMessage(
  value: string,
  label = "Email",
): string | null {
  const normalizedValue = value.trim();

  return normalizedValue === "" || PROFILE_EMAIL_PATTERN.test(normalizedValue)
    ? null
    : `${label} must be a valid email address.`;
}

/**
 * Profile links are optional, but a value that is present must be a web
 * address. A scheme is optional ("example.com" is fine); spaces and a host
 * without a dot are not.
 */
export function getProfileLinkValidationMessage(
  value: string | null | undefined,
  label: string,
): string | null {
  const normalizedValue = (value ?? "").trim();
  if (normalizedValue === "") {
    return null;
  }
  const message = `${label} must be a web address, like example.com.`;
  if (/\s/u.test(normalizedValue)) {
    return message;
  }
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//iu.test(normalizedValue)
        ? normalizedValue
        : `https://${normalizedValue}`,
    );
    return /^https?:$/u.test(url.protocol) && url.hostname.includes(".")
      ? null
      : message;
  } catch {
    return message;
  }
}

export const PROFILE_LINK_FIELDS = [
  { field: "linkedinUrl", label: "LinkedIn URL" },
  { field: "portfolioUrl", label: "Website" },
  { field: "githubUrl", label: "GitHub URL" },
  { field: "personalWebsiteUrl", label: "Extra website" },
] as const;

function shouldPersistReviewCandidateEntry(input: {
  sourceCandidateId?: string | null | undefined;
  sourceCandidateFingerprint?: string | null | undefined;
  currentFingerprint: string;
}): boolean {
  if (!input.sourceCandidateId || !input.sourceCandidateFingerprint) {
    return true;
  }

  return input.currentFingerprint !== input.sourceCandidateFingerprint;
}

function isImportCandidateEntry(entry: {
  sourceCandidateId?: string | null | undefined;
}): boolean {
  return Boolean(entry.sourceCandidateId);
}

// Duplicate collapse is an import-candidate cleanup only. Records the user
// typed by hand are never removed here, even when two rows look identical:
// silently dropping a manual entry loses real user work. Import-candidate rows
// that repeat a fingerprint the list has already seen (manual or imported) are
// collapsed.
function dedupeImportCandidatesByFingerprint<
  TRecord extends { sourceCandidateId?: string | null | undefined },
>(records: readonly TRecord[]): TRecord[] {
  const seen = new Set<string>();

  return records.filter((record) => {
    const fingerprint = buildComparableValueFingerprint(record);

    if (!fingerprint) {
      return true;
    }

    const isDuplicateImportCandidate =
      isImportCandidateEntry(record) && seen.has(fingerprint);

    seen.add(fingerprint);

    return !isDuplicateImportCandidate;
  });
}

function toDiscoveryTargetEditorValues(
  searchPreferences: JobSearchPreferences,
): DiscoveryTargetEditorValue[] {
  return searchPreferences.discovery.targets.map((target) => ({
    id: target.id,
    label: target.label,
    startingUrl: target.startingUrl,
    enabled: target.enabled,
    adapterKind: "auto",
    customInstructions: target.customInstructions ?? "",
    instructionStatus: target.instructionStatus,
    validatedInstructionId: target.validatedInstructionId,
    draftInstructionId: target.draftInstructionId,
    lastDebugRunId: target.lastDebugRunId,
    lastVerifiedAt: target.lastVerifiedAt,
    staleReason: target.staleReason,
  }));
}

function toDiscoveryTargets(
  values: readonly DiscoveryTargetEditorValue[],
  persistedTargets: readonly JobDiscoveryTarget[],
): JobDiscoveryTarget[] {
  const persistedTargetById = new Map<string, JobDiscoveryTarget>();
  for (const persistedTarget of persistedTargets) {
    // Preserve the previous find() behavior if malformed persisted data contains duplicate IDs.
    if (!persistedTargetById.has(persistedTarget.id)) {
      persistedTargetById.set(persistedTarget.id, persistedTarget);
    }
  }

  return values.map((target) => {
    const parsedStatus = SourceInstructionStatusSchema.safeParse(
      target.instructionStatus,
    );
    const instructionStatus = parsedStatus.success
      ? parsedStatus.data
      : "missing";
    const startingUrl = target.startingUrl.trim();
    const persistedTarget = persistedTargetById.get(target.id);
    const startingUrlChanged =
      persistedTarget !== undefined &&
      persistedTarget.startingUrl.trim() !== startingUrl;
    const label = target.label.trim();
    const keptGeneratedLabel =
      startingUrlChanged &&
      persistedTarget !== undefined &&
      label === persistedTarget.label.trim() &&
      isGeneratedJobSourceLabel(label, persistedTarget.startingUrl);

    return {
      instructionStatus: startingUrlChanged ? "missing" : instructionStatus,
      id: target.id,
      label: keptGeneratedLabel ? deriveJobSourceLabel(startingUrl) : label,
      startingUrl,
      enabled: target.enabled,
      adapterKind: "auto",
      customInstructions: target.customInstructions.trim() || null,
      validatedInstructionId: startingUrlChanged
        ? null
        : target.validatedInstructionId,
      draftInstructionId: startingUrlChanged ? null : target.draftInstructionId,
      lastDebugRunId: startingUrlChanged ? null : target.lastDebugRunId,
      lastVerifiedAt: startingUrlChanged ? null : target.lastVerifiedAt,
      staleReason: startingUrlChanged
        ? "Starting page URL changed. Check this source again before reusing saved guidance."
        : target.staleReason,
    };
  });
}

function isValidSourceInstructionStatus(value: string): boolean {
  return SourceInstructionStatusSchema.safeParse(value).success;
}

// An "Add source" click materializes a blank draft row immediately. A draft
// the user never touched has nothing entered to lose, so it stays optional:
// it neither blocks the save nor persists. That optionality only applies to
// fresh drafts whose id is absent from the persisted baseline. A saved source
// cleared back to blank is a material edit: it must remain in validation,
// keep failing the save with the named completion error, and preserve its
// metadata until the user deletes it with explicit Remove.
function isEmptyDiscoveryTargetDraft(
  target: DiscoveryTargetEditorValue,
  persistedTargetIds: ReadonlySet<string>,
): boolean {
  return (
    !persistedTargetIds.has(target.id) &&
    !target.label.trim() &&
    !target.startingUrl.trim() &&
    !target.customInstructions.trim() &&
    !target.enabled
  );
}

function toProofBankFormEntries(
  profile: CandidateProfile,
): ProofBankEntryFormEntry[] {
  return profile.proofBank.map((entry) => ({
    id: entry.id,
    title: entry.title,
    claim: entry.claim,
    heroMetric: entry.heroMetric ?? "",
    supportingContext: entry.supportingContext ?? "",
    roleFamilies: joinListInput(entry.roleFamilies),
    projectIds: joinListInput(entry.projectIds),
    linkIds: joinListInput(entry.linkIds),
  }));
}

// A row the user started but did not finish must block the save with a named
// message instead of being dropped silently. Fully empty rows stay optional:
// there is nothing entered in them to lose.
function findIncompleteRowMessage<TEntry>(
  entries: readonly TEntry[],
  listLabel: string,
  requiredLabel: string,
  rowTitle: (entry: TEntry) => string,
  hasRequiredContent: (entry: TEntry) => boolean,
  hasAnyContent: (entry: TEntry) => boolean,
): string | null {
  for (const [index, entry] of entries.entries()) {
    if (!hasRequiredContent(entry) && hasAnyContent(entry)) {
      const title = rowTitle(entry).trim();

      return `Finish the incomplete ${listLabel} row "${
        title || `${requiredLabel} ${index + 1}`
      }" before saving.`;
    }
  }

  return null;
}

export function createProfileEditorValues(
  profile: CandidateProfile,
  reviewCandidates: readonly ResumeImportFieldCandidateSummary[] = [],
): ProfileEditorValues {
  const values: ProfileEditorValues = {
    identity: {
      currentCity: profile.currentCity ?? "",
      currentCountry: profile.currentCountry ?? "",
      currentLocation: profile.currentLocation ?? "",
      currentRegion: profile.currentRegion ?? "",
      email: profile.email ?? "",
      firstName: profile.firstName ?? "",
      githubUrl: profile.githubUrl ?? "",
      headline: profile.headline ?? "",
      lastName: profile.lastName ?? "",
      linkedinUrl: profile.linkedinUrl ?? "",
      middleName: profile.middleName ?? "",
      personalWebsiteUrl: profile.personalWebsiteUrl ?? "",
      phone: profile.phone ?? "",
      portfolioUrl: profile.portfolioUrl ?? "",
      preferredDisplayName: profile.preferredDisplayName ?? "",
      resumeText: profile.baseResume.textContent ?? "",
      secondaryEmail: profile.secondaryEmail ?? "",
      summary: profile.summary ?? "",
      timeZone: profile.timeZone ?? "",
      yearsExperience: profile.yearsExperience?.toString() ?? "",
    },
    eligibility: {
      limitedWorkPermissions: (
        profile.workEligibility.limitedWorkPermissions ?? []
      ).map((permission) => ({
        ...permission,
        requiresFutureSponsorship: booleanToSelect(
          permission.requiresFutureSponsorship,
        ),
      })),
      authorizedWorkCountries: joinListInput(
        profile.workEligibility.authorizedWorkCountries,
      ),
      availableStartDate: profile.workEligibility.availableStartDate ?? "",
      noticePeriodDays:
        profile.workEligibility.noticePeriodDays?.toString() ?? "",
      preferredRelocationRegions: joinListInput(
        profile.workEligibility.preferredRelocationRegions,
      ),
      remoteEligible: booleanToSelect(profile.workEligibility.remoteEligible),
      requiresVisaSponsorship: booleanToSelect(
        profile.workEligibility.requiresVisaSponsorship,
      ),
      securityClearance: profile.workEligibility.securityClearance ?? "",
      willingToRelocate: booleanToSelect(
        profile.workEligibility.willingToRelocate,
      ),
      willingToTravel: booleanToSelect(profile.workEligibility.willingToTravel),
    },
    applicationIdentity: {
      preferredEmail: profile.applicationIdentity.preferredEmail ?? "",
      preferredLinkIds: joinListInput(
        profile.applicationIdentity.preferredLinkIds,
      ),
      preferredPhone: profile.applicationIdentity.preferredPhone ?? "",
    },
    languages: toLanguageFormEntries(profile),
    links: toLinkFormEntries(profile),
    narrative: {
      careerTransitionSummary: profile.narrative.careerTransitionSummary ?? "",
      differentiators: joinListInput(profile.narrative.differentiators),
      motivationThemes: joinListInput(profile.narrative.motivationThemes),
      nextChapterSummary: profile.narrative.nextChapterSummary ?? "",
      professionalStory: profile.narrative.professionalStory ?? "",
    },
    profileSkills: joinListInput(
      profile.skills.map((skill) => skill.replace(/\.+$/u, "")),
    ),
    proofBank: toProofBankFormEntries(profile),
    projects: toProjectFormEntries(profile),
    records: {
      certifications: toCertificationFormEntries(profile),
      education: toEducationFormEntries(profile),
      experiences: toExperienceFormEntries(profile),
    },
    skillGroups: {
      coreSkills: joinListInput(profile.skillGroups.coreSkills),
      highlightedSkills: joinListInput(profile.skillGroups.highlightedSkills),
      languagesAndFrameworks: joinListInput(
        profile.skillGroups.languagesAndFrameworks,
      ),
      softSkills: joinListInput(profile.skillGroups.softSkills),
      tools: joinListInput(profile.skillGroups.tools),
    },
    summary: {
      careerThemes: joinListInput(profile.professionalSummary.careerThemes),
      domainFocusSummary: profile.professionalSummary.domainFocusSummary ?? "",
      fullSummary: profile.professionalSummary.fullSummary ?? "",
      leadershipSummary: profile.professionalSummary.leadershipSummary ?? "",
      shortValueProposition:
        profile.professionalSummary.shortValueProposition ?? "",
      strengths: joinListInput(profile.professionalSummary.strengths),
    },
  };

  return applyReviewCandidates(values, profile, reviewCandidates);
}

export function createSearchPreferencesEditorValues(
  searchPreferences: JobSearchPreferences,
): SearchPreferencesEditorValues {
  return {
    companyBlacklist: joinListInput(searchPreferences.companyBlacklist),
    companyWhitelist: joinListInput(searchPreferences.companyWhitelist),
    collectOnlyHardCriteriaMatches:
      searchPreferences.discovery.collectOnlyHardCriteriaMatches ?? false,
    employmentTypes: joinListInput(searchPreferences.employmentTypes),
    shiftPreference: searchPreferences.shiftPreference ?? "any",
    minimumWeeklyHours:
      searchPreferences.weeklyHours?.minimum?.toString() ?? "",
    maximumWeeklyHours:
      searchPreferences.weeklyHours?.maximum?.toString() ?? "",
    excludedLocations: joinListInput(searchPreferences.excludedLocations),
    jobFamilies: joinListInput(searchPreferences.jobFamilies),
    locations: joinListInput(searchPreferences.locations),
    minimumSalaryUsd: searchPreferences.compensation.minimum?.toString() ?? "",
    compensationBasis: searchPreferences.compensation.basis ?? "base",
    compensationInterval: searchPreferences.compensation.interval,
    salaryCurrency: searchPreferences.compensation.currency ?? "",
    seniorityLevels: joinListInput(searchPreferences.seniorityLevels),
    tailoringMode: searchPreferences.tailoringMode,
    discoveryTargets: toDiscoveryTargetEditorValues(searchPreferences),
    targetCompanyStages: joinListInput(searchPreferences.targetCompanyStages),
    targetIndustries: joinListInput(searchPreferences.targetIndustries),
    targetRoles: joinListInput(searchPreferences.targetRoles),
    targetSalaryUsd: searchPreferences.compensation.maximum?.toString() ?? "",
    workModes: searchPreferences.workModes,
  };
}

// The saved profile and preferences are the same object until the workspace
// changes them, and fingerprinting about 900 job sources each time a tab
// mounted its fields cost a Profile tab switch about 0.1 s.
const savedValueFingerprints = new WeakMap<object, string>();
function savedValueFingerprint(value: object): string {
  let fingerprint = savedValueFingerprints.get(value);
  if (fingerprint === undefined) {
    fingerprint = buildComparableValueFingerprint(value);
    savedValueFingerprints.set(value, fingerprint);
  }
  return fingerprint;
}

export function hasProfileDraftChanges(
  profile: CandidateProfile,
  draftProfile: CandidateProfile | undefined,
): boolean {
  // An untouched form saves the profile it was given.
  if (!draftProfile || draftProfile === profile) {
    return false;
  }

  return (
    savedValueFingerprint(profile) !==
    buildComparableValueFingerprint(draftProfile)
  );
}

export function hasSearchPreferencesDraftChanges(
  searchPreferences: JobSearchPreferences,
  draftSearchPreferences: JobSearchPreferences | undefined,
): boolean {
  if (!draftSearchPreferences || draftSearchPreferences === searchPreferences) {
    return false;
  }

  return (
    savedValueFingerprint(searchPreferences) !==
    buildComparableValueFingerprint(draftSearchPreferences)
  );
}

export function buildProfilePayload(
  profile: CandidateProfile,
  values: ProfileEditorValues,
): { payload?: CandidateProfile; validationMessage?: string } {
  const emailValidationMessage = getProfileEmailValidationMessage(
    values.identity.email,
  );
  if (emailValidationMessage) {
    return { validationMessage: emailValidationMessage };
  }

  const secondaryEmailValidationMessage = getProfileEmailValidationMessage(
    values.identity.secondaryEmail,
    "Secondary email",
  );
  if (secondaryEmailValidationMessage) {
    return { validationMessage: secondaryEmailValidationMessage };
  }

  const preferredEmailValidationMessage = getProfileEmailValidationMessage(
    values.applicationIdentity.preferredEmail,
    "Preferred application email",
  );
  if (preferredEmailValidationMessage) {
    return { validationMessage: preferredEmailValidationMessage };
  }

  for (const { field, label } of PROFILE_LINK_FIELDS) {
    const linkValidationMessage = getProfileLinkValidationMessage(
      values.identity[field],
      label,
    );
    if (linkValidationMessage) {
      return { validationMessage: linkValidationMessage };
    }
  }

  for (const link of values.links) {
    const message = getProfileLinkValidationMessage(
      link.url,
      link.label.trim() || "Public link",
    );
    if (message) return { validationMessage: message };
  }

  const incompleteRowMessage =
    findIncompleteRowMessage(
      values.projects,
      "project",
      "Project",
      (entry) => entry.name || entry.summary,
      (entry) => Boolean(entry.name.trim()),
      (entry) =>
        [
          entry.name,
          entry.projectType,
          entry.summary,
          entry.role,
          entry.skills,
          entry.outcome,
          entry.projectUrl,
          entry.repositoryUrl,
          entry.caseStudyUrl,
        ].some((value) => Boolean(value.trim())),
    ) ??
    findIncompleteRowMessage(
      values.languages,
      "language",
      "Language",
      (entry) => entry.language || entry.notes || entry.proficiency,
      (entry) => Boolean(entry.language.trim()),
      (entry) =>
        [entry.language, entry.proficiency, entry.notes].some((value) =>
          Boolean(value.trim()),
        ) || entry.interviewPreference,
    ) ??
    findIncompleteRowMessage(
      values.proofBank,
      "proof bank",
      "Proof",
      (entry) => entry.title || entry.claim || entry.heroMetric,
      (entry) => Boolean(entry.title.trim()) && Boolean(entry.claim.trim()),
      (entry) =>
        [
          entry.title,
          entry.claim,
          entry.heroMetric,
          entry.supportingContext,
          entry.roleFamilies,
          entry.projectIds,
          entry.linkIds,
        ].some((value) => Boolean(value.trim())),
    );

  if (incompleteRowMessage) {
    return { validationMessage: incompleteRowMessage };
  }

  const parsedYearsExperience = parseRequiredNonNegativeInteger(
    values.identity.yearsExperience,
  );
  if (
    parsedYearsExperience === null &&
    values.identity.yearsExperience.trim() !== ""
  ) {
    return {
      validationMessage:
        "Years of experience must be a whole number greater than or equal to 0.",
    };
  }

  const parsedNoticePeriodDays = parseRequiredNonNegativeInteger(
    values.eligibility.noticePeriodDays,
  );
  if (
    values.eligibility.noticePeriodDays.trim() &&
    parsedNoticePeriodDays === null
  ) {
    return {
      validationMessage:
        "Notice period must be a whole number greater than or equal to 0.",
    };
  }

  // `currentLocation` is a derived line, not an editable field: only city,
  // region and country are registered inputs. Recomposing it unconditionally
  // made an untouched profile differ from its own saved record forever
  // whenever the stored line carried detail the parts do not - an imported
  // "Cedar Park, TX 78613" recomposed to "Cedar Park, TX, United States" - so
  // Profile opened permanently dirty, "Unsaved changes on this page." was
  // always shown and Save was never disabled. The stored line therefore stays
  // authoritative until the user actually edits one of the parts it is built
  // from; the moment a part changes, the line is rebuilt exactly as before.
  const storedCurrentLocation = profile.currentLocation ?? "";
  const preservesStoredCurrentLocation =
    values.identity.currentCity.trim() === (profile.currentCity ?? "").trim() &&
    values.identity.currentRegion.trim() ===
      (profile.currentRegion ?? "").trim() &&
    values.identity.currentCountry.trim() ===
      (profile.currentCountry ?? "").trim() &&
    values.identity.currentLocation === storedCurrentLocation;

  const builtLocation = preservesStoredCurrentLocation
    ? storedCurrentLocation
    : (uniqueList([
        [
          values.identity.currentCity,
          values.identity.currentRegion,
          values.identity.currentCountry,
        ]
          .filter(Boolean)
          .join(", "),
        values.identity.currentLocation,
      ])[0] ?? values.identity.currentLocation.trim());
  // Main skills stay independently authoritative: the editor must never
  // resurrect a skill the user deleted from this field just because it also
  // appears in a skill group. Downstream consumers that need the full skill
  // pool derive that union themselves from `skills` plus `skillGroups`.
  const mainSkills = parseListInput(values.profileSkills).map((skill) =>
    skill.replace(/\.+$/u, ""),
  );
  const dedupedExperienceEntries = dedupeImportCandidatesByFingerprint(
    values.records.experiences.filter((entry) =>
      shouldPersistReviewCandidateEntry({
        sourceCandidateId: entry.sourceCandidateId,
        sourceCandidateFingerprint: entry.sourceCandidateFingerprint,
        currentFingerprint: buildExperienceFormFingerprint(entry),
      }),
    ),
  );
  const persistedExperiences = dedupedExperienceEntries.map((entry) => ({
    id: entry.id,
    companyName: entry.companyName.trim() || null,
    companyUrl: entry.companyUrl.trim() || null,
    title: entry.title.trim() || null,
    employmentType: entry.employmentType.trim() || null,
    location: entry.location.trim() || null,
    workMode: entry.workMode,
    startDate: entry.startDate.trim() || null,
    endDate: entry.isCurrent ? null : entry.endDate.trim() || null,
    isCurrent: entry.isCurrent,
    isDraft: !entry.companyName.trim() || !entry.title.trim(),
    summary: entry.summary.trim() || null,
    achievements: parseListInput(entry.achievements),
    skills: parseListInput(entry.skills),
    domainTags: parseListInput(entry.domainTags),
    peopleManagementScope: entry.peopleManagementScope.trim() || null,
    ownershipScope: entry.ownershipScope.trim() || null,
  }));
  const dedupedEducationEntries = dedupeImportCandidatesByFingerprint(
    values.records.education.filter((entry) =>
      shouldPersistReviewCandidateEntry({
        sourceCandidateId: entry.sourceCandidateId,
        sourceCandidateFingerprint: entry.sourceCandidateFingerprint,
        currentFingerprint: buildEducationFormFingerprint(entry),
      }),
    ),
  );
  const persistedEducation = dedupedEducationEntries.map((entry) => ({
    id: entry.id,
    schoolName: entry.schoolName.trim() || null,
    degree: entry.degree.trim() || null,
    fieldOfStudy: entry.fieldOfStudy.trim() || null,
    location: entry.location.trim() || null,
    startDate: entry.startDate.trim() || null,
    endDate: entry.endDate.trim() || null,
    isDraft: !entry.schoolName.trim(),
    summary: entry.summary.trim() || null,
  }));

  const draftFirstName = values.identity.firstName.trim();
  const draftMiddleName = values.identity.middleName.trim();
  const draftLastName = values.identity.lastName.trim();
  // Legacy workspaces can hold only an assembled full name with empty split
  // name records. When every split editor input stays blank, an unrelated
  // save must round-trip that stored full name instead of silently nulling
  // it, and it must never guess split parts from it. Any meaningfully present
  // split input assembles a new full name exactly as before, so deliberately
  // clearing previously stored split names keeps working.
  const preservesStoredFullName =
    !(profile.firstName ?? "").trim() &&
    !(profile.middleName ?? "").trim() &&
    !(profile.lastName ?? "").trim() &&
    !draftFirstName &&
    !draftMiddleName &&
    !draftLastName;

  const payload: CandidateProfile = {
    ...profile,
    firstName: draftFirstName || null,
    middleName: draftMiddleName || null,
    lastName: draftLastName || null,
    preferredDisplayName: values.identity.preferredDisplayName.trim() || null,
    fullName: preservesStoredFullName
      ? profile.fullName
      : buildFullName({
          firstName: values.identity.firstName,
          middleName: values.identity.middleName,
          lastName: values.identity.lastName,
        }) || null,
    headline: values.identity.headline.trim() || null,
    summary:
      values.summary.fullSummary.trim() ||
      values.identity.summary.trim() ||
      null,
    currentLocation: builtLocation || null,
    currentCity: values.identity.currentCity.trim() || null,
    currentRegion: values.identity.currentRegion.trim() || null,
    currentCountry: values.identity.currentCountry.trim() || null,
    timeZone: values.identity.timeZone.trim() || null,
    yearsExperience: parsedYearsExperience,
    email: values.identity.email.trim() || null,
    secondaryEmail: values.identity.secondaryEmail.trim() || null,
    phone: values.identity.phone.trim() || null,
    portfolioUrl: normalizePublicLinkUrl(values.identity.portfolioUrl) || null,
    linkedinUrl: values.identity.linkedinUrl.trim() || null,
    githubUrl: values.identity.githubUrl.trim() || null,
    personalWebsiteUrl: values.identity.personalWebsiteUrl.trim() || null,
    baseResume: {
      ...profile.baseResume,
      textContent: values.identity.resumeText.trim() || null,
    },
    workEligibility: {
      ...(values.eligibility.limitedWorkPermissions.length > 0 ||
      profile.workEligibility.limitedWorkPermissions
        ? {
            limitedWorkPermissions:
              values.eligibility.limitedWorkPermissions.map((permission) => ({
                country: permission.country.trim(),
                conditions: permission.conditions.trim(),
                requiresFutureSponsorship: selectToBoolean(
                  permission.requiresFutureSponsorship,
                ),
              })),
          }
        : {}),
      authorizedWorkCountries: parseListInput(
        values.eligibility.authorizedWorkCountries,
      ),
      requiresVisaSponsorship: selectToBoolean(
        values.eligibility.requiresVisaSponsorship,
      ),
      willingToRelocate: selectToBoolean(values.eligibility.willingToRelocate),
      preferredRelocationRegions: parseListInput(
        values.eligibility.preferredRelocationRegions,
      ),
      willingToTravel: selectToBoolean(values.eligibility.willingToTravel),
      remoteEligible: selectToBoolean(values.eligibility.remoteEligible),
      noticePeriodDays: parsedNoticePeriodDays,
      availableStartDate: values.eligibility.availableStartDate.trim() || null,
      securityClearance: values.eligibility.securityClearance.trim() || null,
    },
    applicationIdentity: {
      preferredEmail: values.applicationIdentity.preferredEmail.trim() || null,
      preferredPhone: values.applicationIdentity.preferredPhone.trim() || null,
      preferredLinkIds: parseListInput(
        values.applicationIdentity.preferredLinkIds,
      ),
    },
    professionalSummary: {
      shortValueProposition:
        values.summary.shortValueProposition.trim() || null,
      fullSummary: values.summary.fullSummary.trim() || null,
      careerThemes: parseListInput(values.summary.careerThemes),
      leadershipSummary: values.summary.leadershipSummary.trim() || null,
      domainFocusSummary: values.summary.domainFocusSummary.trim() || null,
      strengths: parseListInput(values.summary.strengths),
    },
    narrative: {
      professionalStory: values.narrative.professionalStory.trim() || null,
      nextChapterSummary: values.narrative.nextChapterSummary.trim() || null,
      careerTransitionSummary:
        values.narrative.careerTransitionSummary.trim() || null,
      differentiators: parseListInput(values.narrative.differentiators),
      motivationThemes: parseListInput(values.narrative.motivationThemes),
    },
    proofBank: values.proofBank
      .filter((entry) => entry.title.trim() && entry.claim.trim())
      .map((entry) => ({
        id: entry.id,
        title: entry.title.trim(),
        claim: entry.claim.trim(),
        heroMetric: entry.heroMetric.trim() || null,
        supportingContext: entry.supportingContext.trim() || null,
        roleFamilies: parseTokenListInput(entry.roleFamilies),
        projectIds: parseListInput(entry.projectIds),
        linkIds: parseListInput(entry.linkIds),
      })),
    skillGroups: {
      coreSkills: parseListInput(values.skillGroups.coreSkills),
      tools: parseListInput(values.skillGroups.tools),
      languagesAndFrameworks: parseListInput(
        values.skillGroups.languagesAndFrameworks,
      ),
      softSkills: parseListInput(values.skillGroups.softSkills),
      highlightedSkills: parseListInput(values.skillGroups.highlightedSkills),
    },
    skills: mainSkills,
    experiences: persistedExperiences,
    education: persistedEducation,
    certifications: values.records.certifications.map((entry) => ({
      id: entry.id,
      name: entry.name.trim() || null,
      issuer: entry.issuer.trim() || null,
      issueDate: entry.issueDate.trim() || null,
      expiryDate: entry.expiryDate.trim() || null,
      credentialUrl: entry.credentialUrl.trim() || null,
      isDraft: !entry.name.trim(),
    })),
    links: values.links.map((entry) => ({
      id: entry.id,
      label: entry.label.trim() || null,
      url: normalizePublicLinkUrl(entry.url) || null,
      kind: entry.kind ? entry.kind : null,
      isDraft: !entry.label.trim() || !entry.url.trim(),
    })),
    projects: values.projects
      .filter((entry) => entry.name.trim())
      .map((entry) => ({
        id: entry.id,
        name: entry.name.trim(),
        projectType: entry.projectType.trim() || null,
        summary: entry.summary.trim() || null,
        role: entry.role.trim() || null,
        skills: parseListInput(entry.skills),
        outcome: entry.outcome.trim() || null,
        projectUrl: entry.projectUrl.trim() || null,
        repositoryUrl: entry.repositoryUrl.trim() || null,
        caseStudyUrl: entry.caseStudyUrl.trim() || null,
      })),
    spokenLanguages: values.languages
      .filter((entry) => entry.language.trim())
      .map((entry) => ({
        id: entry.id,
        language: entry.language.trim(),
        proficiency: entry.proficiency.trim() || null,
        interviewPreference: entry.interviewPreference,
        notes: entry.notes.trim() || null,
      })),
  };

  const parsedPayload = CandidateProfileSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return {
      validationMessage:
        parsedPayload.error.issues[0]?.message ?? "Profile data is invalid.",
    };
  }

  return { payload: parsedPayload.data };
}

export function buildSearchPreferencesPayload(
  searchPreferences: JobSearchPreferences,
  values: SearchPreferencesEditorValues,
): { payload?: JobSearchPreferences; validationMessage?: string } {
  // Untouched "Add source" drafts are optional and never persist, so every
  // validation and persistence step below sees only rows the user entered.
  // Cleared persisted sources stay in validation: omitting them would delete
  // saved sources (and their guidance metadata) without explicit Remove.
  const persistedTargetIds = new Set(
    searchPreferences.discovery.targets.map((target) => target.id),
  );
  const meaningfulDiscoveryTargets = values.discoveryTargets.filter(
    (target) => !isEmptyDiscoveryTargetDraft(target, persistedTargetIds),
  );

  const incompleteTarget = meaningfulDiscoveryTargets.find((target) => {
    if (!target.label.trim()) {
      return true;
    }

    try {
      const url = new URL(target.startingUrl.trim());
      return url.protocol !== "http:" && url.protocol !== "https:";
    } catch {
      return true;
    }
  });

  if (incompleteTarget) {
    return {
      validationMessage: `Complete the name and public http or https URL for "${incompleteTarget.label.trim() || "New source"}" before saving.`,
    };
  }

  const invalidTargetStatus = meaningfulDiscoveryTargets.find(
    (target) => !isValidSourceInstructionStatus(target.instructionStatus),
  );

  if (invalidTargetStatus) {
    return {
      validationMessage: `Job source "${invalidTargetStatus.label.trim() || invalidTargetStatus.id}" has an invalid setup status.`,
    };
  }

  const parsedMinimumSalaryUsd = parseRequiredNonNegativeInteger(
    values.minimumSalaryUsd,
  );
  if (values.minimumSalaryUsd.trim() && parsedMinimumSalaryUsd === null) {
    return {
      validationMessage:
        "Minimum salary must be a whole number greater than or equal to 0.",
    };
  }

  const parsedTargetSalaryUsd = parseRequiredNonNegativeInteger(
    values.targetSalaryUsd,
  );
  if (values.targetSalaryUsd.trim() && parsedTargetSalaryUsd === null) {
    return {
      validationMessage:
        "Target salary must be a whole number greater than or equal to 0.",
    };
  }

  if (
    parsedMinimumSalaryUsd !== null &&
    parsedTargetSalaryUsd !== null &&
    parsedTargetSalaryUsd < parsedMinimumSalaryUsd
  ) {
    return {
      validationMessage:
        "Maximum compensation must be greater than or equal to minimum compensation.",
    };
  }

  const enteredCurrency = values.salaryCurrency.trim().toUpperCase();
  if (enteredCurrency && !/^[A-Z]{3}$/.test(enteredCurrency)) {
    return {
      validationMessage:
        "Compensation currency must be a three-letter code such as USD or EUR.",
    };
  }
  // With nothing entered in the compensation section, the user has not
  // expressed any compensation intent, so carry the canonical baseline
  // forward instead of erasing its inherited display currency (for example
  // the first-run USD default that pairs with an unset compensation currency).
  const preserveBaselineCompensation =
    !enteredCurrency &&
    parsedMinimumSalaryUsd === null &&
    parsedTargetSalaryUsd === null &&
    searchPreferences.compensation.minimum === null &&
    searchPreferences.compensation.maximum === null;
  const compensationCurrency = preserveBaselineCompensation
    ? (searchPreferences.compensation.currency ??
      searchPreferences.salaryCurrency)
    : enteredCurrency || null;
  const currencyStatus = preserveBaselineCompensation
    ? searchPreferences.compensation.currencyStatus
    : compensationCurrency === searchPreferences.compensation.currency
      ? searchPreferences.compensation.currencyStatus
      : compensationCurrency
        ? ("explicit" as const)
        : ("needs_clarification" as const);

  const payload: JobSearchPreferences = {
    ...searchPreferences,
    targetRoles: parseListInput(values.targetRoles),
    jobFamilies: parseListInput(values.jobFamilies),
    locations: parseListInput(values.locations),
    excludedLocations: parseListInput(values.excludedLocations),
    workModes: values.workModes,
    seniorityLevels: parseListInput(values.seniorityLevels),
    targetIndustries: parseListInput(values.targetIndustries),
    targetCompanyStages: parseListInput(values.targetCompanyStages),
    employmentTypes: parseListInput(values.employmentTypes),
    ...(values.shiftPreference !== "any" || searchPreferences.shiftPreference
      ? { shiftPreference: values.shiftPreference }
      : {}),
    ...(values.minimumWeeklyHours.trim() ||
    values.maximumWeeklyHours.trim() ||
    searchPreferences.weeklyHours
      ? {
          weeklyHours: {
            minimum: values.minimumWeeklyHours.trim()
              ? Number(values.minimumWeeklyHours)
              : null,
            maximum: values.maximumWeeklyHours.trim()
              ? Number(values.maximumWeeklyHours)
              : null,
          },
        }
      : {}),
    minimumSalaryUsd: parsedMinimumSalaryUsd,
    targetSalaryUsd: parsedTargetSalaryUsd,
    salaryCurrency: compensationCurrency,
    compensation: preserveBaselineCompensation
      ? values.compensationInterval ===
          searchPreferences.compensation.interval &&
        values.compensationBasis ===
          (searchPreferences.compensation.basis ?? "base")
        ? searchPreferences.compensation
        : {
            ...searchPreferences.compensation,
            ...(values.compensationBasis !== "base" ||
            searchPreferences.compensation.basis
              ? { basis: values.compensationBasis }
              : {}),
            interval: values.compensationInterval,
          }
      : {
          ...(values.compensationBasis !== "base" ||
          searchPreferences.compensation.basis
            ? { basis: values.compensationBasis }
            : {}),
          minimum: parsedMinimumSalaryUsd,
          maximum: parsedTargetSalaryUsd,
          interval: values.compensationInterval,
          currency: compensationCurrency,
          currencyStatus,
        },
    // The resume approach and the strict collection filter are saved from
    // Settings (AI behavior), not from this form. A profile save carries the
    // saved values through unchanged so it can never write back a stale copy
    // over a choice made in Settings while this form was open.
    tailoringMode: searchPreferences.tailoringMode,
    companyBlacklist: parseListInput(values.companyBlacklist),
    companyWhitelist: parseListInput(values.companyWhitelist),
    discovery: {
      ...searchPreferences.discovery,
      collectOnlyHardCriteriaMatches:
        searchPreferences.discovery.collectOnlyHardCriteriaMatches ?? false,
      targets: toDiscoveryTargets(
        meaningfulDiscoveryTargets,
        searchPreferences.discovery.targets,
      ),
    },
  };

  const parsedPayload = JobSearchPreferencesSchema.safeParse(payload);
  if (!parsedPayload.success) {
    return {
      validationMessage:
        parsedPayload.error.issues[0]?.message ??
        "Search preferences are invalid.",
    };
  }

  return { payload: parsedPayload.data };
}
