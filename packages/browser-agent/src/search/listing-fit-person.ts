import type { CandidateProfile } from "@nestor/contracts";

/** Evidence for fit, shared with its invalidation key. No contact or file metadata. */
export function buildListingFitPerson(profile: CandidateProfile) {
  return {
    headline: profile.headline,
    summary: profile.summary,
    narrative: profile.narrative,
    professionalSummary: profile.professionalSummary,
    location: profile.currentLocation,
    currentCity: profile.currentCity,
    currentRegion: profile.currentRegion,
    currentCountry: profile.currentCountry,
    yearsExperience: profile.yearsExperience,
    workEligibility: profile.workEligibility,
    skills: profile.skills,
    skillGroups: profile.skillGroups,
    experiences: profile.experiences.filter((entry) => !entry.isDraft),
    education: profile.education.filter((entry) => !entry.isDraft),
    certifications: profile.certifications.filter((entry) => !entry.isDraft),
    projects: profile.projects,
    proofBank: profile.proofBank,
    spokenLanguages: profile.spokenLanguages,
    // A few extracted skills or roles do not prove that every resume fact was
    // imported. Retain its evidence; explicit structured edits take precedence.
    resume: profile.baseResume.textContent,
  };
}
