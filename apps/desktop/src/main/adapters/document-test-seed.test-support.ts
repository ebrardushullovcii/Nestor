import {
  CandidateProfileSchema,
  JobFinderSettingsSchema,
  SavedJobSchema,
  createFreshStartCandidateProfile,
} from "@nestor/contracts";

const AT = "2026-03-20T09:05:00.000Z";

/** A synthetic person, saved job and settings for document tests. */
export function createDocumentTestSeed() {
  const fresh = createFreshStartCandidateProfile();
  const profile = CandidateProfileSchema.parse({
    ...fresh,
    id: "candidate_1",
    firstName: "Alex",
    lastName: "Vanguard",
    fullName: "Alex Vanguard",
    headline: "Senior systems designer",
    summary:
      "Builds resilient workflows for design systems, workflow automation, and operations platforms.",
    currentLocation: "London, UK",
    yearsExperience: 10,
    email: "alex@example.com",
    phone: "+44 7700 900123",
    portfolioUrl: "https://alex.example.com",
    linkedinUrl: "https://www.linkedin.com/in/alex-vanguard",
    narrative: {
      professionalStory:
        "Design systems and workflow tooling leader who turns messy multi-team operations into clear product systems.",
      nextChapterSummary:
        "Looking for remote product-design roles that combine systems thinking, workflow automation, and cross-functional leadership.",
      careerTransitionSummary:
        "Open to roles that bridge product design and workflow platform ownership because that has been the strongest throughline of recent work.",
      differentiators: [
        "Turns ambiguous workflow pain into durable design systems",
        "Pairs product strategy with hands-on systems execution",
      ],
      motivationThemes: [
        "workflow automation",
        "design systems",
        "platform quality",
      ],
    },
    proofBank: [
      {
        id: "proof_1",
        title: "Design-system rollout",
        claim:
          "Led a design-system rollout across core workflow surfaces used by design and operations teams.",
        heroMetric:
          "Adoption reached 80% of core product surfaces within two quarters.",
        supportingContext:
          "Worked across product, engineering, and operations to standardize interaction and content patterns.",
        roleFamilies: ["product design", "design systems", "platform"],
        projectIds: [],
        linkIds: ["link_1"],
      },
    ],
    baseResume: {
      ...fresh.baseResume,
      id: "resume_1",
      fileName: "alex-vanguard.pdf",
      uploadedAt: "2026-03-20T10:00:00.000Z",
      textContent:
        "Alex Vanguard\nSenior systems designer\nLondon, UK\n\n10 years of experience building resilient workflow tools with Figma, React, and design systems.",
      textUpdatedAt: "2026-03-20T10:00:00.000Z",
      extractionStatus: "ready",
      lastAnalyzedAt: "2026-03-20T10:01:00.000Z",
      analysisWarnings: [],
    },
    targetRoles: ["Principal Designer"],
    locations: ["Remote"],
    skills: ["Figma", "React", "Design Systems"],
    experiences: [
      {
        id: "experience_1",
        companyName: "Signal Systems",
        companyUrl: null,
        title: "Senior systems designer",
        employmentType: "Full-time",
        location: "London, UK",
        workMode: ["hybrid"],
        startDate: "2020-01",
        endDate: null,
        isCurrent: true,
        isDraft: false,
        summary: "Builds resilient workflow tools.",
        achievements: [
          "Led design-system rollout across core workflow surfaces.",
        ],
        skills: ["Figma", "Design Systems"],
        domainTags: [],
        peopleManagementScope: null,
        ownershipScope: null,
      },
    ],
    education: [
      {
        id: "education_1",
        schoolName: "Royal College of Art",
        degree: "MA",
        fieldOfStudy: "Design Products",
        location: "London, UK",
        startDate: "2012-09",
        endDate: "2014-06",
        isDraft: false,
        summary: null,
      },
    ],
    links: [
      {
        id: "link_1",
        label: "Portfolio",
        url: "https://alex.example.com",
        kind: "portfolio",
        isDraft: false,
      },
    ],
  });
  const job = SavedJobSchema.parse({
    id: "job_ready",
    source: "target_site",
    sourceJobId: "signal_ready",
    discoveryMethod: "catalog_seed",
    canonicalUrl: "http://127.0.0.1:47950/jobs/signal_ready",
    applicationUrl: "http://127.0.0.1:47950/jobs/signal_ready/apply",
    title: "Senior Product Designer",
    company: "Signal Systems",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: AT,
    postedAtText: null,
    discoveredAt: AT,
    firstSeenAt: AT,
    lastSeenAt: AT,
    lastVerifiedActiveAt: AT,
    salaryText: null,
    summary: "Own the design system.",
    description: "Own the design system and workflow platform.",
    keySkills: ["Figma", "Design Systems"],
    responsibilities: ["Own the design system roadmap."],
    minimumQualifications: ["Strong product design systems experience."],
    preferredQualifications: ["Workflow-platform product background."],
    seniority: "Senior",
    employmentType: "Full-time",
    department: "Design",
    team: "Design Systems",
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
    },
    keywordSignals: [],
    benefits: [],
    status: "discovered",
    matchAssessment: {
      score: 96,
      reasons: ["Strong design-systems overlap"],
      gaps: [],
    },
    provenance: [],
  });
  const settings = JobFinderSettingsSchema.parse({
    resumeTemplateId: "classic_ats",
    resumeFormat: "pdf",
    fontPreset: "inter_requisite",
    appearanceTheme: "system",
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
  });
  return { profile, savedJobs: [job], settings };
}
