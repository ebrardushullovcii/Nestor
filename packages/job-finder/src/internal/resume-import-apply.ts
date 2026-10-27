import {
  CandidateProfileSchema,
  CandidateWorkEligibilitySchema,
  isFreshStartCandidateProfile,
  CompensationPreferenceSchema,
  JobSearchPreferencesSchema,
  type CandidateProfile,
  type JobSearchPreferences,
  type ResumeImportFieldCandidate,
  type ResumeImportRun,
  type WorkMode,
  workModeValues,
} from "@nestor/contracts";

import {
  mergeCertificationRecords,
  mergeEducationRecords,
  mergeExperienceRecords,
  mergeLanguageRecords,
  mergeLinkRecords,
  mergeProjectRecords,
  parseLocationParts,
} from "./profile-merge";
import { partitionStrengthsAndSkills } from "./profile-setup-strengths-partition";
import { toCandidateListValues, toStringArray } from "./resume-import-common";
import {
  candidateScore,
  isListTarget,
  isRecordTarget,
  shouldPreferCandidateOverExistingValue,
} from "./resume-import-reconciliation";
import { normalizeText, uniqueStrings } from "./shared";

type ResolvedResumeImportSelection = {
  scalarFields: Partial<
    Pick<
      CandidateProfile,
      | "firstName"
      | "lastName"
      | "middleName"
      | "fullName"
      | "headline"
      | "summary"
      | "currentCity"
      | "currentRegion"
      | "currentCountry"
      | "currentLocation"
      | "timeZone"
      | "yearsExperience"
      | "email"
      | "phone"
      | "portfolioUrl"
      | "linkedinUrl"
      | "githubUrl"
      | "personalWebsiteUrl"
    >
  > & {
    salaryCurrency?: string | null;
    employmentTypes?: { values: string[]; explicit: boolean };
    compensation?: {
      value: JobSearchPreferences["compensation"];
      explicit: boolean;
    };
    targetRoles?: string[];
    locations?: string[];
    workModes?: string[];
    skills?: string[];
    skillGroups?: CandidateProfile["skillGroups"];
    narrative?: Partial<CandidateProfile["narrative"]>;
    /**
     * Work-eligibility facts the resume states outright. `explicit` marks a
     * value the person is confirming from review right now; an imported value
     * only fills an empty answer and never replaces one the person saved.
     */
    workEligibility?: {
      limitedWorkPermissions?: {
        values: NonNullable<
          CandidateProfile["workEligibility"]["limitedWorkPermissions"]
        >;
        explicit: boolean;
      };
      authorizedWorkCountries?: { values: string[]; explicit: boolean };
      requiresVisaSponsorship?: { value: boolean; explicit: boolean };
    };
    applicationIdentity?: {
      preferredEmail?: string | null;
      preferredPhone?: string | null;
      preferredLinkUrls?: string[];
    };
  };
  experiences: CandidateProfile["experiences"];
  education: CandidateProfile["education"];
  certifications: CandidateProfile["certifications"];
  links: CandidateProfile["links"];
  projects: CandidateProfile["projects"];
  spokenLanguages: CandidateProfile["spokenLanguages"];
  proofBank: CandidateProfile["proofBank"];
};

function isProofPointValue(value: object): value is {
  title?: unknown;
  claim?: unknown;
  heroMetric?: unknown;
  supportingContext?: unknown;
  roleFamilies?: unknown;
  projectIds?: unknown;
  linkIds?: unknown;
} {
  if (value === null || Array.isArray(value)) {
    return false;
  }

  return "title" in value || "claim" in value || "heroMetric" in value;
}

function buildResolvedSelection(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  candidates: readonly ResumeImportFieldCandidate[],
  confirmedCandidateId: string | null = null,
): ResolvedResumeImportSelection {
  const autoApplied = candidates.filter(
    (candidate) => candidate.resolution === "auto_applied",
  );
  const selection: ResolvedResumeImportSelection = {
    scalarFields: {},
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: [],
    proofBank: [],
  };

  const scalarCandidates = new Map<string, ResumeImportFieldCandidate>();

  for (const candidate of autoApplied) {
    const key = `${candidate.target.section}.${candidate.target.key}`;

    if (isRecordTarget(candidate)) {
      const value = candidate.value;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }

      switch (candidate.target.section) {
        case "experience":
          selection.experiences.push({
            ...value,
            ...(profile.experiences.some(
              (record) => record.id === candidate.target.recordId,
            )
              ? { id: candidate.target.recordId }
              : {}),
          } as CandidateProfile["experiences"][number]);
          break;
        case "education":
          if (candidate.target.key === "record") {
            selection.education.push(
              value as CandidateProfile["education"][number],
            );
          }
          break;
        case "certification":
          selection.certifications.push(
            value as CandidateProfile["certifications"][number],
          );
          break;
        case "link":
          selection.links.push(value as CandidateProfile["links"][number]);
          break;
        case "project":
          selection.projects.push(
            value as CandidateProfile["projects"][number],
          );
          break;
        case "language":
          selection.spokenLanguages.push(
            value as CandidateProfile["spokenLanguages"][number],
          );
          break;
        case "proof_point":
          if (!isProofPointValue(value)) {
            break;
          }

          if (
            typeof value.title === "string" &&
            value.title.trim().length > 0 &&
            typeof value.claim === "string" &&
            value.claim.trim().length > 0
          ) {
            selection.proofBank.push({
              title: value.title,
              claim: value.claim,
              heroMetric:
                typeof value.heroMetric === "string" ? value.heroMetric : null,
              supportingContext:
                typeof value.supportingContext === "string"
                  ? value.supportingContext
                  : null,
              roleFamilies: toStringArray(value.roleFamilies),
              projectIds: toStringArray(value.projectIds),
              linkIds: toStringArray(value.linkIds),
            } as CandidateProfile["proofBank"][number]);
          }
          break;
      }
      continue;
    }

    if (isListTarget(candidate)) {
      switch (candidate.target.key) {
        case "record":
          if (candidate.target.section === "skill") {
            selection.scalarFields.skills = uniqueStrings([
              ...(selection.scalarFields.skills ?? []),
              ...toStringArray(candidate.value),
            ]);
          }
          break;
        case "targetRoles":
          selection.scalarFields.targetRoles = uniqueStrings([
            ...(selection.scalarFields.targetRoles ?? []),
            ...toCandidateListValues(candidate),
          ]);
          break;
        case "locations":
          selection.scalarFields.locations = uniqueStrings([
            ...(selection.scalarFields.locations ?? []),
            ...toCandidateListValues(candidate),
          ]);
          break;
        case "employmentTypes": {
          const existing = selection.scalarFields.employmentTypes;
          const explicit = candidate.id === confirmedCandidateId;
          if (!existing?.explicit || explicit) {
            selection.scalarFields.employmentTypes = {
              values: explicit
                ? toStringArray(candidate.value)
                : uniqueStrings([
                    ...(existing?.values ?? []),
                    ...toStringArray(candidate.value),
                  ]),
              explicit,
            };
          }
          break;
        }
        case "workModes":
          selection.scalarFields.workModes = uniqueStrings([
            ...(selection.scalarFields.workModes ?? []),
            ...toCandidateListValues(candidate)
              .map((entry) => entry.trim().toLowerCase())
              .filter((entry): entry is WorkMode =>
                (workModeValues as readonly string[]).includes(entry),
              ),
          ]);
          break;
        case "skills":
          selection.scalarFields.skills = uniqueStrings([
            ...(selection.scalarFields.skills ?? []),
            ...toStringArray(candidate.value),
          ]);
          break;
        default: {
          const existingSkillGroups = selection.scalarFields.skillGroups ?? {
            coreSkills: [],
            tools: [],
            languagesAndFrameworks: [],
            softSkills: [],
            highlightedSkills: [],
          };
          const nextValues = toStringArray(candidate.value);
          if (candidate.target.key === "skillGroups.coreSkills") {
            existingSkillGroups.coreSkills = uniqueStrings([
              ...existingSkillGroups.coreSkills,
              ...nextValues,
            ]);
          }
          if (candidate.target.key === "skillGroups.tools") {
            existingSkillGroups.tools = uniqueStrings([
              ...existingSkillGroups.tools,
              ...nextValues,
            ]);
          }
          if (candidate.target.key === "skillGroups.languagesAndFrameworks") {
            existingSkillGroups.languagesAndFrameworks = uniqueStrings([
              ...existingSkillGroups.languagesAndFrameworks,
              ...nextValues,
            ]);
          }
          if (candidate.target.key === "skillGroups.softSkills") {
            existingSkillGroups.softSkills = uniqueStrings([
              ...existingSkillGroups.softSkills,
              ...nextValues,
            ]);
          }
          if (candidate.target.key === "skillGroups.highlightedSkills") {
            existingSkillGroups.highlightedSkills = uniqueStrings([
              ...existingSkillGroups.highlightedSkills,
              ...nextValues,
            ]);
          }
          selection.scalarFields.skillGroups = existingSkillGroups;
        }
      }
      continue;
    }

    const existing = scalarCandidates.get(key);
    if (key === "search_preferences.compensation") {
      if (candidate.id === confirmedCandidateId) {
        scalarCandidates.set(key, candidate);
        continue;
      }
      if (existing?.id === confirmedCandidateId) continue;
    }

    if (!existing) {
      scalarCandidates.set(key, candidate);
      continue;
    }

    const preferNext = shouldPreferCandidateOverExistingValue(
      profile,
      searchPreferences,
      candidate,
    );
    const preferExisting = shouldPreferCandidateOverExistingValue(
      profile,
      searchPreferences,
      existing,
    );

    if (preferNext && !preferExisting) {
      scalarCandidates.set(key, candidate);
      continue;
    }

    if (
      preferNext === preferExisting &&
      candidateScore(candidate) > candidateScore(existing)
    ) {
      scalarCandidates.set(key, candidate);
    }
  }

  for (const [key, candidate] of scalarCandidates) {
    const value = candidate.value;
    switch (key) {
      // Resume headers are often set in capitals; that is styling, not a
      // spelling, and it followed people onto every form and generated PDF.
      case "identity.firstName":
        if (typeof value === "string") {
          selection.scalarFields.firstName = normalizeShoutedName(value);
        }
        break;
      case "identity.lastName":
        if (typeof value === "string") {
          selection.scalarFields.lastName = normalizeShoutedName(value);
        }
        break;
      case "identity.middleName":
        selection.scalarFields.middleName =
          typeof value === "string" ? normalizeShoutedName(value) : null;
        break;
      case "identity.fullName":
        if (typeof value === "string") {
          selection.scalarFields.fullName = normalizeShoutedName(value);
        }
        break;
      case "identity.headline":
        if (typeof value === "string") {
          selection.scalarFields.headline = value;
        }
        break;
      case "identity.summary":
        if (typeof value === "string") {
          selection.scalarFields.summary = value;
        }
        break;
      case "identity.yearsExperience": {
        // Models regularly answer "8" or "8+" for a numeric field; dropping
        // the string silently left Years empty after an otherwise good read.
        const years =
          typeof value === "number"
            ? value
            : typeof value === "string"
              ? Number.parseFloat(value.replace(/[^0-9.]/g, ""))
              : Number.NaN;
        if (Number.isFinite(years) && years > 0) {
          selection.scalarFields.yearsExperience = years;
        }
        break;
      }
      case "location.currentLocation":
        if (typeof value === "string") {
          selection.scalarFields.currentLocation = value;
        }
        break;
      case "location.currentCity":
      case "location.currentRegion":
      case "location.currentCountry":
        selection.scalarFields[
          candidate.target.key as
            | "currentCity"
            | "currentRegion"
            | "currentCountry"
        ] = typeof value === "string" ? value : null;
        break;
      case "location.timeZone":
        selection.scalarFields.timeZone =
          typeof value === "string" ? value : null;
        break;
      case "contact.email":
        selection.scalarFields.email = typeof value === "string" ? value : null;
        break;
      case "contact.phone":
        selection.scalarFields.phone = typeof value === "string" ? value : null;
        break;
      case "contact.portfolioUrl":
        selection.scalarFields.portfolioUrl =
          typeof value === "string" ? value : null;
        break;
      case "contact.linkedinUrl":
        selection.scalarFields.linkedinUrl =
          typeof value === "string" ? value : null;
        break;
      case "contact.githubUrl":
        selection.scalarFields.githubUrl =
          typeof value === "string" ? value : null;
        break;
      case "contact.personalWebsiteUrl":
        selection.scalarFields.personalWebsiteUrl =
          typeof value === "string" ? value : null;
        break;
      case "search_preferences.compensation": {
        const parsed = CompensationPreferenceSchema.safeParse(value);
        if (parsed.success)
          selection.scalarFields.compensation = {
            value: parsed.data,
            explicit: candidate.id === confirmedCandidateId,
          };
        break;
      }
      case "search_preferences.salaryCurrency":
        selection.scalarFields.salaryCurrency =
          typeof value === "string" ? value : null;
        break;
      case "application_identity.preferredEmail":
        selection.scalarFields.applicationIdentity = {
          ...(selection.scalarFields.applicationIdentity ?? {}),
          preferredEmail: typeof value === "string" ? value : null,
        };
        break;
      case "application_identity.preferredPhone":
        selection.scalarFields.applicationIdentity = {
          ...(selection.scalarFields.applicationIdentity ?? {}),
          preferredPhone: typeof value === "string" ? value : null,
        };
        break;
      case "application_identity.preferredLinkUrls":
        selection.scalarFields.applicationIdentity = {
          ...(selection.scalarFields.applicationIdentity ?? {}),
          preferredLinkUrls: toStringArray(value),
        };
        break;
      case "narrative.professionalStory":
        selection.scalarFields.narrative = {
          ...(selection.scalarFields.narrative ?? {}),
          professionalStory: typeof value === "string" ? value : null,
        };
        break;
      case "narrative.nextChapterSummary":
        selection.scalarFields.narrative = {
          ...(selection.scalarFields.narrative ?? {}),
          nextChapterSummary: typeof value === "string" ? value : null,
        };
        break;
      case "narrative.careerTransitionSummary":
        selection.scalarFields.narrative = {
          ...(selection.scalarFields.narrative ?? {}),
          careerTransitionSummary: typeof value === "string" ? value : null,
        };
        break;
      case "work_eligibility.authorizedWorkCountries": {
        const values = uniqueStrings(toStringArray(value));
        if (values.length > 0) {
          selection.scalarFields.workEligibility = {
            ...(selection.scalarFields.workEligibility ?? {}),
            authorizedWorkCountries: {
              values,
              explicit: candidate.id === confirmedCandidateId,
            },
          };
        }
        break;
      }
      case "work_eligibility.limitedWorkPermissions": {
        const parsed =
          CandidateWorkEligibilitySchema.shape.limitedWorkPermissions.safeParse(
            value,
          );
        if (parsed.success && parsed.data?.length) {
          selection.scalarFields.workEligibility = {
            ...selection.scalarFields.workEligibility,
            limitedWorkPermissions: {
              values: parsed.data,
              explicit: candidate.id === confirmedCandidateId,
            },
          };
        }
        break;
      }
      case "work_eligibility.requiresVisaSponsorship":
        if (typeof value === "boolean") {
          selection.scalarFields.workEligibility = {
            ...(selection.scalarFields.workEligibility ?? {}),
            requiresVisaSponsorship: {
              value,
              explicit: candidate.id === confirmedCandidateId,
            },
          };
        }
        break;
    }
  }

  return selection;
}

function mergeImportedWorkEligibility(
  current: CandidateProfile["workEligibility"],
  imported: ResolvedResumeImportSelection["scalarFields"]["workEligibility"],
): CandidateProfile["workEligibility"] {
  if (!imported) {
    return current;
  }
  const countries = imported.authorizedWorkCountries;
  const sponsorship = imported.requiresVisaSponsorship;
  return {
    ...current,
    limitedWorkPermissions:
      imported.limitedWorkPermissions &&
      (imported.limitedWorkPermissions.explicit ||
        !current.limitedWorkPermissions?.length)
        ? imported.limitedWorkPermissions.values
        : current.limitedWorkPermissions,
    authorizedWorkCountries:
      countries &&
      (countries.explicit || current.authorizedWorkCountries.length === 0)
        ? countries.values
        : current.authorizedWorkCountries,
    requiresVisaSponsorship:
      sponsorship &&
      (sponsorship.explicit || current.requiresVisaSponsorship === null)
        ? sponsorship.value
        : current.requiresVisaSponsorship,
  };
}

function mergeProofBankEntries(
  existing: CandidateProfile["proofBank"],
  extracted: CandidateProfile["proofBank"],
): CandidateProfile["proofBank"] {
  if (extracted.length === 0) {
    return existing;
  }

  const existingByKey = new Map(
    existing.map((entry) => [
      normalizeText(`${entry.title}|${entry.claim}`),
      entry,
    ]),
  );

  return extracted.map((entry, index) => {
    const key = normalizeText(`${entry.title}|${entry.claim}`);
    const match = existingByKey.get(key);
    return {
      id:
        match?.id ??
        `proof_${index}_${normalizeText(entry.title).replaceAll(" ", "_")}`,
      title: entry.title,
      claim: entry.claim,
      heroMetric: entry.heroMetric,
      supportingContext: entry.supportingContext,
      roleFamilies: uniqueStrings(entry.roleFamilies),
      projectIds: uniqueStrings(entry.projectIds),
      linkIds: uniqueStrings(entry.linkIds),
    };
  });
}

function mergeResolvedSelectionIntoWorkspace(
  profile: CandidateProfile,
  searchPreferences: JobSearchPreferences,
  selection: ResolvedResumeImportSelection,
  analysisProviderKind: ResumeImportRun["analysisProviderKind"],
  analysisProviderLabel: ResumeImportRun["analysisProviderLabel"],
  analysisWarnings: readonly string[],
  candidates: readonly ResumeImportFieldCandidate[],
): {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
} {
  const currentLocation =
    selection.scalarFields.currentLocation ?? profile.currentLocation;
  const fullName = selection.scalarFields.fullName ?? profile.fullName;
  const [derivedFirstName, ...remainingNameParts] =
    typeof fullName === "string"
      ? fullName.trim().split(/\s+/).filter(Boolean)
      : [];
  const derivedLastName =
    remainingNameParts.length > 0
      ? remainingNameParts[remainingNameParts.length - 1]
      : null;
  const derivedMiddleName =
    remainingNameParts.length > 1
      ? remainingNameParts.slice(0, -1).join(" ")
      : null;
  const locationParts = parseLocationParts(currentLocation);
  // Named technologies belong in Skills, not Strengths — the profile tells the
  // user exactly that, so an applied import must not contradict it.
  const partitionedSkills = partitionStrengthsAndSkills({
    skillGroupValues: [
      ...(selection.scalarFields.skillGroups?.coreSkills ?? []),
      ...(selection.scalarFields.skillGroups?.tools ?? []),
      ...(selection.scalarFields.skillGroups?.languagesAndFrameworks ?? []),
      ...(selection.scalarFields.skillGroups?.highlightedSkills ?? []),
      ...profile.skills,
    ],
    skills: selection.scalarFields.skills?.length
      ? uniqueStrings(selection.scalarFields.skills)
      : profile.skills,
    strengths: selection.scalarFields.skillGroups?.highlightedSkills.length
      ? selection.scalarFields.skillGroups.highlightedSkills
      : profile.professionalSummary.strengths,
  });
  const namedLinks = [
    ["Website", "website", selection.scalarFields.personalWebsiteUrl],
    ["Portfolio", "portfolio", selection.scalarFields.portfolioUrl],
  ] as const;
  const importedLinks = [...selection.links];
  for (const [label, kind, url] of namedLinks) {
    if (
      url &&
      ![...profile.links, ...importedLinks].some((link) => link.url === url)
    ) {
      importedLinks.push({
        id: `import_${kind}`,
        label,
        kind,
        url,
        isDraft: false,
      });
    }
  }
  const mergedLinks = mergeLinkRecords(profile.links, importedLinks);
  const preferredLinkUrls = uniqueStrings(
    selection.scalarFields.applicationIdentity?.preferredLinkUrls ?? [],
  );
  const nextLinkedinUrl =
    selection.scalarFields.linkedinUrl !== undefined
      ? selection.scalarFields.linkedinUrl
      : profile.linkedinUrl;
  const rawPersonalWebsiteUrl =
    selection.scalarFields.personalWebsiteUrl !== undefined
      ? selection.scalarFields.personalWebsiteUrl
      : profile.personalWebsiteUrl;
  const nextPersonalWebsiteUrl =
    nextLinkedinUrl &&
    rawPersonalWebsiteUrl &&
    nextLinkedinUrl === rawPersonalWebsiteUrl
      ? null
      : rawPersonalWebsiteUrl;
  const preferredLinkIds =
    preferredLinkUrls.length > 0
      ? mergedLinks
          .filter((entry) => entry.url && preferredLinkUrls.includes(entry.url))
          .map((entry) => entry.id)
      : profile.applicationIdentity.preferredLinkIds.length > 0
        ? profile.applicationIdentity.preferredLinkIds
        : mergedLinks
            .filter((entry) => entry.kind && entry.kind !== "other")
            .slice(0, 3)
            .map((entry) => entry.id);

  const nextEmail =
    selection.scalarFields.email !== undefined
      ? selection.scalarFields.email
      : profile.email;
  const nextPhone =
    selection.scalarFields.phone !== undefined
      ? selection.scalarFields.phone
      : profile.phone;
  const resolvePreferredContact = (input: {
    existingPreferred: string | null;
    existingPrimary: string | null;
    importedPreferred: string | null | undefined;
    importedPrimary: string | null | undefined;
    kind: "email" | "phone";
  }): string | null => {
    if (input.importedPreferred !== undefined) {
      return input.importedPreferred;
    }

    if (input.importedPrimary !== undefined) {
      const normalizeContact = (value: string | null): string =>
        input.kind === "phone"
          ? (value ?? "").replace(/\D/gu, "")
          : normalizeText(value ?? "");
      const normalizedPreferred = normalizeContact(input.existingPreferred);
      const normalizedPrimary = normalizeContact(input.existingPrimary);

      if (!normalizedPreferred || normalizedPreferred === normalizedPrimary) {
        return input.importedPrimary;
      }
    }

    return input.existingPreferred ?? input.existingPrimary;
  };

  return {
    profile: CandidateProfileSchema.parse({
      ...profile,
      firstName:
        selection.scalarFields.firstName ??
        (selection.scalarFields.fullName
          ? (derivedFirstName ?? profile.firstName)
          : profile.firstName),
      lastName:
        selection.scalarFields.lastName ??
        (selection.scalarFields.fullName
          ? (derivedLastName ?? profile.lastName)
          : profile.lastName),
      middleName:
        selection.scalarFields.middleName !== undefined
          ? selection.scalarFields.middleName
          : selection.scalarFields.fullName
            ? derivedMiddleName
            : profile.middleName,
      fullName,
      headline: selection.scalarFields.headline ?? profile.headline,
      summary: selection.scalarFields.summary ?? profile.summary,
      currentLocation,
      currentCity:
        selection.scalarFields.currentCity !== undefined
          ? selection.scalarFields.currentCity
          : (locationParts.currentCity ?? profile.currentCity),
      currentRegion:
        selection.scalarFields.currentRegion !== undefined
          ? selection.scalarFields.currentRegion
          : (locationParts.currentRegion ?? profile.currentRegion),
      currentCountry:
        selection.scalarFields.currentCountry !== undefined
          ? selection.scalarFields.currentCountry
          : (locationParts.currentCountry ?? profile.currentCountry),
      timeZone:
        selection.scalarFields.timeZone !== undefined
          ? selection.scalarFields.timeZone
          : profile.timeZone,
      yearsExperience:
        selection.scalarFields.yearsExperience ??
        (isFreshStartCandidateProfile(profile) && profile.yearsExperience === 0
          ? null
          : profile.yearsExperience),
      email: nextEmail,
      phone: nextPhone,
      portfolioUrl:
        selection.scalarFields.portfolioUrl !== undefined
          ? selection.scalarFields.portfolioUrl
          : profile.portfolioUrl,
      linkedinUrl: nextLinkedinUrl,
      githubUrl:
        selection.scalarFields.githubUrl !== undefined
          ? selection.scalarFields.githubUrl
          : profile.githubUrl,
      personalWebsiteUrl: nextPersonalWebsiteUrl,
      professionalSummary: {
        ...profile.professionalSummary,
        fullSummary:
          selection.scalarFields.summary ??
          profile.professionalSummary.fullSummary,
        strengths: partitionedSkills.strengths,
      },
      narrative: {
        ...profile.narrative,
        ...(selection.scalarFields.narrative ?? {}),
      },
      proofBank: mergeProofBankEntries(profile.proofBank, selection.proofBank),
      // A resume that says "EU citizen, no sponsorship needed" answers the two
      // questions every application form asks; saved answers are never
      // replaced by an import.
      workEligibility: mergeImportedWorkEligibility(
        profile.workEligibility,
        selection.scalarFields.workEligibility,
      ),
      applicationIdentity: {
        ...profile.applicationIdentity,
        preferredEmail: resolvePreferredContact({
          existingPreferred: profile.applicationIdentity.preferredEmail,
          existingPrimary: profile.email,
          importedPreferred:
            selection.scalarFields.applicationIdentity?.preferredEmail,
          importedPrimary: selection.scalarFields.email,
          kind: "email",
        }),
        preferredPhone: resolvePreferredContact({
          existingPreferred: profile.applicationIdentity.preferredPhone,
          existingPrimary: profile.phone,
          importedPreferred:
            selection.scalarFields.applicationIdentity?.preferredPhone,
          importedPrimary: selection.scalarFields.phone,
          kind: "phone",
        }),
        preferredLinkIds,
      },
      skillGroups: {
        ...profile.skillGroups,
        ...(selection.scalarFields.skillGroups ?? {}),
      },
      targetRoles: selection.scalarFields.targetRoles?.length
        ? uniqueStrings(selection.scalarFields.targetRoles)
        : profile.targetRoles,
      locations: selection.scalarFields.locations?.length
        ? uniqueStrings(selection.scalarFields.locations)
        : profile.locations,
      skills: partitionedSkills.skills,
      experiences: mergeExperienceRecords(
        profile.experiences,
        selection.experiences,
      ),
      education: mergeEducationRecords(profile.education, selection.education),
      certifications: mergeCertificationRecords(
        profile.certifications,
        selection.certifications,
      ),
      links: mergedLinks,
      projects: mergeProjectRecords(profile.projects, selection.projects),
      spokenLanguages: mergeLanguageRecords(
        profile.spokenLanguages,
        selection.spokenLanguages,
      ),
      baseResume: {
        ...profile.baseResume,
        ...(candidates.some(
          (candidate) => candidate.sourceKind === "model_identity_summary",
        )
          ? {
              sourceIdentity: {
                fullName:
                  candidates.find(
                    (candidate) =>
                      candidate.sourceKind === "model_identity_summary" &&
                      candidate.target.section === "identity" &&
                      candidate.target.key === "fullName" &&
                      typeof candidate.value === "string",
                  )?.value ?? null,
                email:
                  candidates.find(
                    (candidate) =>
                      candidate.sourceKind === "model_identity_summary" &&
                      candidate.target.section === "contact" &&
                      candidate.target.key === "email" &&
                      typeof candidate.value === "string",
                  )?.value ?? null,
              },
            }
          : {}),
        extractionStatus: "ready",
        lastAnalyzedAt: new Date().toISOString(),
        analysisProviderKind,
        analysisProviderLabel,
        analysisWarnings: [...analysisWarnings],
      },
    }),
    searchPreferences: JobSearchPreferencesSchema.parse({
      ...searchPreferences,
      targetRoles: selection.scalarFields.targetRoles?.length
        ? uniqueStrings(selection.scalarFields.targetRoles)
        : searchPreferences.targetRoles,
      locations: selection.scalarFields.locations?.length
        ? uniqueStrings(selection.scalarFields.locations)
        : searchPreferences.locations,
      // A header that literally says "Remote" answers the work-mode question
      // the person would otherwise be asked; saved choices are never replaced.
      workModes:
        searchPreferences.workModes.length === 0 &&
        selection.scalarFields.workModes?.length
          ? uniqueStrings(selection.scalarFields.workModes)
          : searchPreferences.workModes,
      employmentTypes:
        selection.scalarFields.employmentTypes?.explicit ||
        searchPreferences.employmentTypes.length === 0
          ? (selection.scalarFields.employmentTypes?.values ??
            searchPreferences.employmentTypes)
          : searchPreferences.employmentTypes,
      compensation:
        selection.scalarFields.compensation?.explicit ||
        (searchPreferences.compensation.minimum === null &&
          searchPreferences.compensation.currency === null)
          ? (selection.scalarFields.compensation?.value ??
            searchPreferences.compensation)
          : searchPreferences.compensation,
      salaryCurrency:
        selection.scalarFields.salaryCurrency ??
        searchPreferences.salaryCurrency,
    }),
  };
}

/**
 * "DANA KIM" → "Dana Kim". Only words that are entirely upper case change;
 * "McKay", "de la Cruz" and initials like "J." stay as written.
 */
export function normalizeShoutedName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((word) =>
      word.length > 1 && word === word.toUpperCase() && /\p{L}/u.test(word)
        ? word
            .toLowerCase()
            .replace(
              /(^|[-'’])(\p{L})/gu,
              (_match: string, separator: string, letter: string) =>
                `${separator}${letter.toUpperCase()}`,
            )
        : word,
    )
    .join(" ");
}

export function applyResolvedResumeImportCandidatesToWorkspace(input: {
  profile: CandidateProfile;
  searchPreferences: JobSearchPreferences;
  candidates: readonly ResumeImportFieldCandidate[];
  analysisProviderKind: ResumeImportRun["analysisProviderKind"];
  analysisProviderLabel: ResumeImportRun["analysisProviderLabel"];
  analysisWarnings: readonly string[];
  /**
   * The review item the person is confirming right now. Only its value may
   * replace saved eligibility or search preferences. Other candidates only
   * fill empty answers, so confirming a later item never
   * undoes an edit the person made after an earlier one.
   */
  confirmedCandidateId?: string | null;
}) {
  const resolvedSelection = buildResolvedSelection(
    input.profile,
    input.searchPreferences,
    input.candidates,
    input.confirmedCandidateId ?? null,
  );

  return mergeResolvedSelectionIntoWorkspace(
    input.profile,
    input.searchPreferences,
    resolvedSelection,
    input.analysisProviderKind,
    input.analysisProviderLabel,
    input.analysisWarnings,
    input.candidates,
  );
}
