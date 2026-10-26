import type { JobSearchPreferences } from "@nestor/contracts";
import type {
  BooleanSelectValue,
  CertificationFormEntry,
  DiscoveryTargetEditorValue,
  EducationFormEntry,
  ExperienceFormEntry,
  LanguageFormEntry,
  LinkFormEntry,
  ProjectFormEntry,
  ProofBankEntryFormEntry,
} from "./job-finder-types";

export interface ProfileEditorValues {
  identity: {
    currentCity: string;
    currentCountry: string;
    currentLocation: string;
    currentRegion: string;
    email: string;
    firstName: string;
    githubUrl: string;
    headline: string;
    lastName: string;
    linkedinUrl: string;
    middleName: string;
    personalWebsiteUrl: string;
    phone: string;
    portfolioUrl: string;
    preferredDisplayName: string;
    resumeText: string;
    secondaryEmail: string;
    summary: string;
    timeZone: string;
    yearsExperience: string;
  };
  eligibility: {
    authorizedWorkCountries: string;
    limitedWorkPermissions: {
      country: string;
      conditions: string;
      requiresFutureSponsorship: BooleanSelectValue;
    }[];
    availableStartDate: string;
    noticePeriodDays: string;
    preferredRelocationRegions: string;
    remoteEligible: BooleanSelectValue;
    requiresVisaSponsorship: BooleanSelectValue;
    securityClearance: string;
    willingToRelocate: BooleanSelectValue;
    willingToTravel: BooleanSelectValue;
  };
  languages: LanguageFormEntry[];
  links: LinkFormEntry[];
  narrative: {
    careerTransitionSummary: string;
    differentiators: string;
    motivationThemes: string;
    nextChapterSummary: string;
    professionalStory: string;
  };
  profileSkills: string;
  proofBank: ProofBankEntryFormEntry[];
  projects: ProjectFormEntry[];
  records: {
    certifications: CertificationFormEntry[];
    education: EducationFormEntry[];
    experiences: ExperienceFormEntry[];
  };
  applicationIdentity: {
    preferredEmail: string;
    preferredLinkIds: string;
    preferredPhone: string;
  };
  skillGroups: {
    coreSkills: string;
    highlightedSkills: string;
    languagesAndFrameworks: string;
    softSkills: string;
    tools: string;
  };
  summary: {
    careerThemes: string;
    domainFocusSummary: string;
    fullSummary: string;
    leadershipSummary: string;
    shortValueProposition: string;
    strengths: string;
  };
}

export interface SearchPreferencesEditorValues {
  companyBlacklist: string;
  companyWhitelist: string;
  collectOnlyHardCriteriaMatches: boolean;
  employmentTypes: string;
  shiftPreference: "day" | "night" | "any";
  minimumWeeklyHours: string;
  maximumWeeklyHours: string;
  excludedLocations: string;
  jobFamilies: string;
  locations: string;
  minimumSalaryUsd: string;
  compensationBasis: "base" | "total_ote";
  compensationInterval: JobSearchPreferences["compensation"]["interval"];
  salaryCurrency: string;
  seniorityLevels: string;
  tailoringMode: JobSearchPreferences["tailoringMode"];
  targetCompanyStages: string;
  targetIndustries: string;
  discoveryTargets: DiscoveryTargetEditorValue[];
  targetRoles: string;
  targetSalaryUsd: string;
  workModes: JobSearchPreferences["workModes"];
}
