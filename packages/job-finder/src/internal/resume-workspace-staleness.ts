import {
  ResumeDraftSchema,
  type CandidateProfile,
  type JobFinderSettings,
  type ResumeDraft,
  type SavedJob,
} from "@nestor/contracts";

function toProfileResumeStalenessSignature(profile: CandidateProfile) {
  return {
    fullName: profile.fullName,
    preferredDisplayName: profile.preferredDisplayName,
    headline: profile.headline,
    summary: profile.summary,
    currentLocation: profile.currentLocation,
    currentCity: profile.currentCity,
    currentRegion: profile.currentRegion,
    currentCountry: profile.currentCountry,
    timeZone: profile.timeZone,
    yearsExperience: profile.yearsExperience,
    email: profile.email,
    secondaryEmail: profile.secondaryEmail,
    phone: profile.phone,
    portfolioUrl: profile.portfolioUrl,
    linkedinUrl: profile.linkedinUrl,
    githubUrl: profile.githubUrl,
    personalWebsiteUrl: profile.personalWebsiteUrl,
    professionalSummary: profile.professionalSummary,
    narrative: profile.narrative,
    proofBank: profile.proofBank,
    skillGroups: profile.skillGroups,
    targetRoles: profile.targetRoles,
    locations: profile.locations,
    skills: profile.skills,
    experiences: profile.experiences,
    education: profile.education,
    certifications: profile.certifications,
    links: profile.links,
    projects: profile.projects,
    spokenLanguages: profile.spokenLanguages,
    baseResume: {
      id: profile.baseResume.id,
      fileName: profile.baseResume.fileName,
      storagePath: profile.baseResume.storagePath,
      textContent: profile.baseResume.textContent,
      textUpdatedAt: profile.baseResume.textUpdatedAt,
    },
  };
}

function toSettingsResumeStalenessSignature(settings: JobFinderSettings) {
  return {
    resumeFormat: settings.resumeFormat,
    fontPreset: settings.fontPreset,
  };
}

function toJobResumeStalenessSignature(job: SavedJob) {
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    workMode: job.workMode,
    applicationUrl: job.applicationUrl,
    salaryText: job.salaryText,
    normalizedCompensation: job.normalizedCompensation,
    summary: job.summary,
    description: job.description,
    keySkills: job.keySkills,
    keywordSignals: job.keywordSignals,
    responsibilities: job.responsibilities,
    minimumQualifications: job.minimumQualifications,
    preferredQualifications: job.preferredQualifications,
    seniority: job.seniority,
    employmentType: job.employmentType,
    department: job.department,
    team: job.team,
    employerWebsiteUrl: job.employerWebsiteUrl,
    employerDomain: job.employerDomain,
    atsProvider: job.atsProvider,
    screeningHints: job.screeningHints,
    benefits: job.benefits,
  };
}

export function hasResumeAffectingProfileChange(
  currentProfile: CandidateProfile,
  nextProfile: CandidateProfile,
): boolean {
  return (
    JSON.stringify(toProfileResumeStalenessSignature(currentProfile)) !==
    JSON.stringify(toProfileResumeStalenessSignature(nextProfile))
  );
}

export function hasResumeAffectingSettingsChange(
  currentSettings: JobFinderSettings,
  nextSettings: JobFinderSettings,
): boolean {
  return (
    JSON.stringify(toSettingsResumeStalenessSignature(currentSettings)) !==
    JSON.stringify(toSettingsResumeStalenessSignature(nextSettings))
  );
}

export function hasResumeAffectingJobChange(
  currentJob: SavedJob,
  nextJob: SavedJob,
): boolean {
  return (
    JSON.stringify(toJobResumeStalenessSignature(currentJob)) !==
    JSON.stringify(toJobResumeStalenessSignature(nextJob))
  );
}

export function buildStaleResumeDraft(
  draft: ResumeDraft,
  staleReason: string,
  updatedAt = new Date().toISOString(),
): ResumeDraft {
  return ResumeDraftSchema.parse({
    ...draft,
    status: "stale",
    approvedAt: null,
    approvedExportId: null,
    staleReason,
    updatedAt,
  });
}
