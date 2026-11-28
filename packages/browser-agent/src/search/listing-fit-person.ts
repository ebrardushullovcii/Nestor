import type {
  CandidateProfile,
  CandidateWorkEligibility,
} from "@nestor/contracts";

/**
 * An empty own-words rule is left out, so the fit key of every profile that
 * has none stays what it was and an upgrade spends no fits re-scoring.
 */
export function workEligibilityForModel(
  facts: CandidateWorkEligibility,
):
  | CandidateWorkEligibility
  | Omit<CandidateWorkEligibility, "workAuthorizationInOwnWords"> {
  if (facts.workAuthorizationInOwnWords) return facts;
  const { workAuthorizationInOwnWords: _empty, ...rest } = facts;
  void _empty;
  return rest;
}

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
    // Left out when empty, so a profile without it keeps its fit key.
    ...(profile.citizenshipCountries.length
      ? { citizenshipCountries: profile.citizenshipCountries }
      : {}),
    yearsExperience: profile.yearsExperience,
    workEligibility: workEligibilityForModel(profile.workEligibility),
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
