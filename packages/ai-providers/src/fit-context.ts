import type { CandidateProfile, JobSearchPreferences } from "@nestor/contracts";

function plainEligibility(profile: CandidateProfile) {
  const facts = profile.workEligibility;
  const yesNo = (value: boolean | null) =>
    value === null ? "Not known" : value ? "Yes" : "No";
  return {
    "Countries where you can work": facts.authorizedWorkCountries,
    "Limited work permissions": (facts.limitedWorkPermissions ?? []).map(
      (permit) => ({
        Country: permit.country,
        Conditions: permit.conditions,
        "Will need sponsorship later": yesNo(permit.requiresFutureSponsorship),
      }),
    ),
    "Need visa sponsorship": yesNo(facts.requiresVisaSponsorship),
    "Willing to relocate": yesNo(facts.willingToRelocate),
    "Preferred places to relocate": facts.preferredRelocationRegions,
    "Willing to travel": yesNo(facts.willingToTravel),
    "Can work remotely": yesNo(facts.remoteEligible),
    "Notice period in days": facts.noticePeriodDays,
    "Available start date": facts.availableStartDate,
    "Security clearance": facts.securityClearance,
  };
}

function compactGoals(preferences: JobSearchPreferences) {
  return {
    "Target roles": preferences.targetRoles,
    "Kinds of work": preferences.jobFamilies,
    "Preferred industries": preferences.targetIndustries,
    "Preferred company stages": preferences.targetCompanyStages,
    "Companies to exclude": preferences.companyBlacklist,
    "Preferred companies": preferences.companyWhitelist,
    "Seniority levels": preferences.seniorityLevels,
    "Preferred places": preferences.locations,
    "Places to exclude": preferences.excludedLocations,
    "Work modes": preferences.workModes,
    "Employment types": preferences.employmentTypes,
    "Shift preference": preferences.shiftPreference ?? "any",
    "Weekly hours": {
      Minimum: preferences.weeklyHours?.minimum ?? null,
      Maximum: preferences.weeklyHours?.maximum ?? null,
    },
    "Pay preference": {
      "Pay basis":
        preferences.compensation.basis === "total_ote"
          ? "Total on-target earnings"
          : "Base salary",
      Minimum: preferences.compensation.minimum,
      Maximum: preferences.compensation.maximum,
      Interval: preferences.compensation.interval,
      Currency: preferences.compensation.currency,
      "Currency confirmed":
        preferences.compensation.currencyStatus === "explicit" ? "Yes" : "No",
    },
    "Remote work can be outside preferred places":
      preferences.discovery.remoteCountsAsAnyLocation !== false ? "Yes" : "No",
    ...(preferences.discovery.collectOnlyHardCriteriaMatches === true
      ? { "Only jobs matching hard criteria": "Yes" }
      : {}),
  };
}

/**
 * Complete evidence retained in legacy assessment fingerprints, with ids
 * and the imported resume. Contact
 * details, links, saved application answers and file metadata are left out:
 * no requirement is checked against them.
 */
function buildFullFitPerson(profile: CandidateProfile) {
  return {
    headline: profile.headline,
    summary: profile.summary,
    currentLocation: profile.currentLocation,
    currentCity: profile.currentCity,
    currentRegion: profile.currentRegion,
    currentCountry: profile.currentCountry,
    yearsExperience: profile.yearsExperience,
    workEligibility: plainEligibility(profile),
    // Preserve the released fit-input shape. The authoritative Profile store
    // supplies empty legacy answers; their retired UI/write path stays removed.
    savedEligibilityAnswers: {
      workAuthorization: profile.answerBank.workAuthorization,
      visaSponsorship: profile.answerBank.visaSponsorship,
      relocation: profile.answerBank.relocation,
      travel: profile.answerBank.travel,
      noticePeriod: profile.answerBank.noticePeriod,
      availability: profile.answerBank.availability,
    },
    narrative: profile.narrative,
    professionalSummary: profile.professionalSummary,
    skills: profile.skills,
    skillGroups: profile.skillGroups,
    experiences: profile.experiences
      .filter((experience) => !experience.isDraft)
      .map((experience) => ({
        id: experience.id,
        title: experience.title,
        companyName: experience.companyName,
        employmentType: experience.employmentType,
        location: experience.location,
        workMode: experience.workMode,
        startDate: experience.startDate,
        endDate: experience.isCurrent ? "present" : experience.endDate,
        summary: experience.summary,
        achievements: experience.achievements,
        skills: experience.skills,
        domainTags: experience.domainTags,
        peopleManagementScope: experience.peopleManagementScope,
        ownershipScope: experience.ownershipScope,
      })),
    education: profile.education
      .filter((education) => !education.isDraft)
      .map((education) => ({
        id: education.id,
        degree: education.degree,
        fieldOfStudy: education.fieldOfStudy,
        schoolName: education.schoolName,
        location: education.location,
        startDate: education.startDate,
        endDate: education.endDate,
        summary: education.summary,
      })),
    certifications: profile.certifications
      .filter((certification) => !certification.isDraft)
      .map((certification) => ({
        id: certification.id,
        name: certification.name,
        issuer: certification.issuer,
        issueDate: certification.issueDate,
        expiryDate: certification.expiryDate,
      })),
    projects: profile.projects.map((project) => ({
      id: project.id,
      name: project.name,
      projectType: project.projectType,
      role: project.role,
      summary: project.summary,
      outcome: project.outcome,
      skills: project.skills,
    })),
    proofBank: profile.proofBank.map((proof) => ({
      id: proof.id,
      title: proof.title,
      claim: proof.claim,
      heroMetric: proof.heroMetric,
      supportingContext: proof.supportingContext,
    })),
    spokenLanguages: profile.spokenLanguages,
    resumeText: profile.baseResume.textContent,
  };
}

/**
 * Evidence used by retained legacy assessment fingerprints. A verdict goes
 * stale when this changes: a new
 * phone number or saved answer does not ask the model again.
 */
export function buildFitVerdictContext(
  profile: CandidateProfile,
  preferences: JobSearchPreferences,
) {
  return {
    person: buildFullFitPerson(profile),
    goals: compactGoals(preferences),
  };
}
