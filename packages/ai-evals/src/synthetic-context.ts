import {
  CandidateProfileSchema,
  JobFinderSettingsSchema,
  JobPostingSchema,
  JobSearchPreferencesSchema,
  ResumeDocumentBundleSchema,
  ResumeDraftSchema,
} from "@nestor/contracts";

export function createSyntheticCandidateProfile() {
  return CandidateProfileSchema.parse({
    id: "candidate_synthetic_eval",
    firstName: "Alex",
    lastName: "Vanguard",
    middleName: null,
    fullName: "Alex Vanguard",
    preferredDisplayName: null,
    headline: "Workflow engineer",
    summary: "Builds reliable and accessible automation.",
    currentLocation: "Example City",
    currentCity: "Example City",
    currentRegion: null,
    currentCountry: "Example Country",
    timeZone: "Etc/UTC",
    yearsExperience: 6,
    email: "alex.vanguard@example.com",
    secondaryEmail: null,
    phone: null,
    portfolioUrl: "https://example.com/alex",
    linkedinUrl: null,
    githubUrl: "https://example.com/alex/code",
    personalWebsiteUrl: null,
    narrative: {
      professionalStory:
        "Builds frontend workflows and developer tooling with careful accessibility testing.",
      nextChapterSummary: null,
      careerTransitionSummary: null,
      differentiators: ["Accessible product delivery", "Reliable automation"],
      motivationThemes: ["Useful software", "Clear collaboration"],
    },
    proofBank: [],
    answerBank: {
      workAuthorization: "Work eligibility must be confirmed per country.",
      visaSponsorship: null,
      relocation: "Remote worldwide; onsite only in Example City.",
      travel: null,
      noticePeriod: "Two weeks",
      availability: "Available after a two-week notice period.",
      salaryExpectations:
        "Minimum EUR 2,000 monthly; preferred EUR 3,000–4,000 monthly.",
      selfIntroduction: null,
      careerTransition: null,
      customAnswers: [],
    },
    applicationIdentity: {
      preferredEmail: "alex.vanguard@example.com",
      preferredPhone: null,
      preferredLinkIds: [],
    },
    baseResume: {
      id: "resume_synthetic_eval",
      fileName: "synthetic-resume.txt",
      uploadedAt: "2026-08-01T10:00:00.000Z",
      storagePath: null,
      textContent:
        "Alex Vanguard — Workflow engineer — React, TypeScript, accessibility.",
      textUpdatedAt: "2026-08-01T10:00:00.000Z",
      extractionStatus: "ready",
      lastAnalyzedAt: "2026-08-01T10:01:00.000Z",
      analysisProviderKind: "deterministic",
      analysisProviderLabel: "Synthetic evaluation fixture",
      analysisWarnings: [],
    },
    workEligibility: {
      authorizedWorkCountries: [],
      requiresVisaSponsorship: null,
      willingToRelocate: false,
      preferredRelocationRegions: ["Example City"],
      willingToTravel: true,
      remoteEligible: true,
      noticePeriodDays: 14,
      availableStartDate: null,
      securityClearance: null,
    },
    professionalSummary: {
      shortValueProposition:
        "Frontend engineer focused on accessible workflows and reliable automation.",
      fullSummary:
        "Builds React and TypeScript product workflows, automated tests, and developer tooling.",
      careerThemes: ["Frontend systems", "Automation", "Accessibility"],
      leadershipSummary: null,
      domainFocusSummary: "Product workflows and developer tooling",
      strengths: ["React", "TypeScript", "Playwright", "Accessibility"],
    },
    skillGroups: {
      coreSkills: ["React", "TypeScript"],
      tools: ["Playwright", "Git"],
      languagesAndFrameworks: ["TypeScript", "React"],
      softSkills: ["Collaboration"],
      highlightedSkills: ["Accessibility", "Automation"],
    },
    targetRoles: [
      "Software Engineer",
      "Frontend Engineer",
      "Full-stack Engineer",
    ],
    locations: ["Remote", "Example City"],
    skills: ["React", "TypeScript", "Playwright", "Accessibility"],
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: [
      {
        id: "language_english",
        language: "English",
        proficiency: "fluent",
        notes: null,
      },
    ],
  });
}

export function createSyntheticSearchPreferences() {
  return JobSearchPreferencesSchema.parse({
    targetRoles: [
      "Software Engineer",
      "Frontend Engineer",
      "Full-stack Engineer",
    ],
    jobFamilies: ["Software Engineering"],
    locations: ["Remote", "Example City"],
    excludedLocations: [],
    workModes: ["remote", "hybrid", "onsite"],
    seniorityLevels: ["Mid", "Senior"],
    targetIndustries: [],
    targetCompanyStages: [],
    employmentTypes: ["full_time"],
    minimumSalaryUsd: null,
    targetSalaryUsd: null,
    salaryCurrency: "EUR",
    compensation: {
      minimum: 2000,
      maximum: 4000,
      interval: "month",
      currency: "EUR",
      currencyStatus: "explicit",
    },
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    companyBlacklist: [],
    companyWhitelist: [],
    discovery: { historyLimit: 5, targets: [] },
  });
}

export function createSyntheticJobFinderSettings() {
  return JobFinderSettingsSchema.parse({
    resumeFormat: "html",
    resumeTemplateId: "classic_ats",
    fontPreset: "inter_requisite",
    appearanceTheme: "system",
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
    keepSessionAlive: true,
    discoveryOnly: false,
  });
}

export function createSyntheticJobPosting(input: {
  readonly title?: string;
  readonly description?: string;
  readonly keySkills?: readonly string[];
}) {
  return JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "job_synthetic_eval",
    discoveryMethod: "browser_agent",
    canonicalUrl: "https://jobs.example.com/jobs/synthetic-eval",
    applicationUrl: null,
    title: input.title ?? "Frontend Engineer",
    company: "Example Labs",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "unknown",
    easyApplyEligible: false,
    postedAt: "2026-08-01T10:00:00.000Z",
    postedAtText: null,
    discoveredAt: "2026-08-01T10:00:00.000Z",
    firstSeenAt: "2026-08-01T10:00:00.000Z",
    lastSeenAt: "2026-08-01T10:00:00.000Z",
    lastVerifiedActiveAt: "2026-08-01T10:00:00.000Z",
    salaryText: null,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    },
    summary: input.description ?? "Build reliable product interfaces.",
    description: input.description ?? "Build reliable product interfaces.",
    keySkills: [...(input.keySkills ?? ["React", "TypeScript"])],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: "https://example.com",
    employerDomain: "example.com",
    atsProvider: null,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    sourceIntelligence: null,
    collectionMethod: "fallback_search",
    titleTriageOutcome: "pass",
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
    },
    keywordSignals: [],
    benefits: [],
  });
}

export function createSyntheticResumeDraft(text: string, locked = false) {
  return ResumeDraftSchema.parse({
    id: "draft_synthetic_eval",
    jobId: "job_synthetic_eval",
    status: "draft",
    templateId: "classic_ats",
    identity: {
      fullName: "Alex Vanguard",
      headline: "Workflow engineer",
      location: "Example City",
      email: "alex.vanguard@example.com",
      phone: null,
      portfolioUrl: "https://example.com/alex",
      linkedinUrl: null,
      githubUrl: null,
      personalWebsiteUrl: null,
      additionalLinks: [],
    },
    sections: [
      {
        id: "section_summary",
        kind: "summary",
        label: "Professional summary",
        text,
        bullets: [],
        entries: [],
        origin: "user_edited",
        locked,
        included: true,
        sortOrder: 0,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [
          {
            id: "source_summary",
            sourceKind: "profile",
            sourceId: "candidate_synthetic_eval",
            snippet: text,
          },
        ],
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
    ],
    targetPageCount: 1,
    generationMethod: "manual",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  });
}

function inferSectionHint(
  line: string,
):
  | "identity"
  | "summary"
  | "experience"
  | "education"
  | "certifications"
  | "skills"
  | "projects"
  | "languages"
  | "contact"
  | "other" {
  const normalized = line.trim().toLowerCase();
  if (/^(summary|profile|selected impact)$/.test(normalized)) return "summary";
  if (/^(experience|work experience|përvoja)$/.test(normalized))
    return "experience";
  if (/^(education|arsimi|learning)$/.test(normalized)) return "education";
  if (/^(certifications?|credentials)$/.test(normalized))
    return "certifications";
  if (/^(skills|toolkit)$/.test(normalized)) return "skills";
  if (/^(projects|things i built)$/.test(normalized)) return "projects";
  if (/^(languages|gjuhët)$/.test(normalized)) return "languages";
  if (/[@]|https?:\/\//.test(normalized)) return "contact";
  return "other";
}

export function createSyntheticResumeDocumentBundle(resumeText: string) {
  const lines = resumeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let activeSection: ReturnType<typeof inferSectionHint> = "identity";
  const blocks = lines.map((line, index) => {
    const inferred = inferSectionHint(line);
    if (inferred !== "other" && inferred !== "contact")
      activeSection = inferred;
    const isHeading =
      inferred !== "other" ||
      (line.length < 40 && line === line.toLocaleUpperCase());
    return {
      id: `block_${index + 1}`,
      pageNumber: 1,
      readingOrder: index,
      text: line,
      kind: isHeading ? "heading" : "paragraph",
      sectionHint:
        inferred === "other"
          ? index === 0
            ? "identity"
            : activeSection
          : inferred,
      bbox: null,
      sourceParserKinds: ["plain_text"],
      sourceConfidence: 1,
    };
  });
  return ResumeDocumentBundleSchema.parse({
    id: "bundle_synthetic_eval",
    runId: "run_synthetic_eval",
    sourceResumeId: "resume_synthetic_eval",
    sourceFileKind: "plain_text",
    primaryParserKind: "plain_text",
    parserKinds: ["plain_text"],
    createdAt: "2026-08-01T10:00:00.000Z",
    languageHints: ["en"],
    warnings: [],
    pages: [
      {
        pageNumber: 1,
        text: resumeText,
        charCount: resumeText.length,
        parserKinds: ["plain_text"],
        usedOcr: false,
      },
    ],
    blocks,
    fullText: resumeText,
  });
}
