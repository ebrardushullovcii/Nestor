import type { ResumeProfileExtraction } from "@nestor/ai-providers";
import type { JobFinderRepositorySeed } from "@nestor/db";
import type {
  SavedJob,
  SavedJobDiscoveryProvenance,
  SourceDebugPhase,
  SourceInstructionArtifact,
} from "@nestor/contracts";
import {
  FRESH_START_CANDIDATE_PROFILE_ID,
  JobFinderDiscoveryStateSchema,
  JobFinderIntelligenceStateSchema,
  SavedJobDiscoveryProvenanceSchema,
  SavedJobSchema,
  SourceInstructionArtifactSchema,
} from "@nestor/contracts";

export type SourceDebugPhaseMap<TValue> = Partial<
  Record<SourceDebugPhase, TValue>
>;

export function createSavedJob(
  input: (typeof SavedJobSchema)["_input"],
): SavedJob {
  return SavedJobSchema.parse(input);
}

export function createSavedJobDiscoveryProvenance(
  input: (typeof SavedJobDiscoveryProvenanceSchema)["_input"],
): SavedJobDiscoveryProvenance {
  return SavedJobDiscoveryProvenanceSchema.parse(input);
}

export function createSourceInstructionArtifact(
  input: (typeof SourceInstructionArtifactSchema)["_input"],
): SourceInstructionArtifact {
  return SourceInstructionArtifactSchema.parse(input);
}

/**
 * The routes a source check's review recorded, as the artifact stores them
 * (ADR 0041): each with the kind the model gave it.
 */
export function learnedRoutesIntelligence(
  routes: ReadonlyArray<
    readonly [
      url: string,
      kind: "anchor" | "listing" | "search" | "collection" | "detail" | "apply",
    ]
  >,
) {
  const startingRoutes = routes.map(([url, kind]) => ({
    url,
    kind,
    label: "Route the review recorded",
    confidence: 0.9,
  }));
  return {
    collection: {
      startingRoutes,
      searchRouteTemplates: startingRoutes.filter(
        (route) => route.kind === "search",
      ),
    },
  };
}

export function toPhaseId(
  strategyLabel: string | null | undefined,
): SourceDebugPhase | null {
  const normalized = strategyLabel
    ?.trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z_]/g, "");

  switch (normalized) {
    case "access_auth_probe":
    case "site_structure_mapping":
    case "search_filter_probe":
    case "job_detail_validation":
    case "apply_path_validation":
    case "replay_verification":
      return normalized;
    default:
      return null;
  }
}

export function createSeed(): JobFinderRepositorySeed {
  return {
    profile: {
      id: "candidate_1",
      firstName: "Alex",
      lastName: "Vanguard",
      middleName: null,
      fullName: "Alex Vanguard",
      preferredDisplayName: null,
      headline: "Senior systems designer",
      summary: "Builds resilient workflows.",
      currentLocation: "London, UK",
      currentCity: null,
      currentRegion: null,
      currentCountry: null,
      timeZone: null,
      yearsExperience: 10,
      email: "alex@example.com",
      secondaryEmail: null,
      phone: "+44 7700 900123",
      portfolioUrl: "https://alex.example.com",
      linkedinUrl: "https://www.linkedin.com/in/alex-vanguard",
      githubUrl: null,
      personalWebsiteUrl: null,
      narrative: {
        professionalStory:
          "Design systems and workflow tooling leader who helps product teams ship clearer, more resilient operating systems.",
        nextChapterSummary:
          "Targeting remote senior product design roles with strong systems, platform, and workflow ownership.",
        careerTransitionSummary:
          "Leaning further into workflow platform and systems roles because that is where recent impact has been strongest.",
        differentiators: [
          "Connects product strategy with design-system execution",
          "Turns workflow pain into reusable system patterns",
        ],
        motivationThemes: ["workflow automation", "design systems"],
      },
      proofBank: [
        {
          id: "proof_1",
          title: "Design-system rollout",
          claim:
            "Led design-system rollout across core product surfaces used by design and operations teams.",
          heroMetric:
            "Adoption reached 80% of core product surfaces within two quarters.",
          supportingContext:
            "Worked across product, engineering, and operations to standardize component and content patterns.",
          roleFamilies: ["product design", "design systems", "platform"],
          projectIds: [],
          linkIds: ["link_1"],
        },
      ],
      answerBank: {
        workAuthorization:
          "Authorized to work in the United Kingdom and open to remote roles across Europe.",
        visaSponsorship:
          "Do not currently require visa sponsorship for UK-based roles.",
        relocation:
          "Open to relocation for the right platform or systems role.",
        travel:
          "Open to occasional travel for workshops and planning meetings.",
        noticePeriod: "Available after a 30-day notice period.",
        availability: "Available to interview now and start within 30 days.",
        salaryExpectations:
          "Targeting senior remote roles in the 180k-220k USD range depending on scope and package.",
        selfIntroduction:
          "I am a systems-focused product designer with 10 years of experience building workflow tools, design systems, and operations platforms.",
        careerTransition:
          "I am moving deeper into workflow platform roles because that is where my strongest measurable impact has been.",
        customAnswers: [],
      },
      applicationIdentity: {
        preferredEmail: "alex@example.com",
        preferredPhone: "+44 7700 900123",
        preferredLinkIds: ["link_1"],
      },
      baseResume: {
        id: "resume_1",
        fileName: "alex-vanguard.pdf",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        storagePath: "/tmp/alex-vanguard.pdf",
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        textContent:
          "Alex Vanguard\nSenior systems designer\nLondon, UK\nalex@example.com\n+44 7700 900123\nhttps://alex.example.com\nhttps://www.linkedin.com/in/alex-vanguard\n\n10 years of experience building resilient workflow tools with Figma, React, and design systems.",
        textUpdatedAt: "2026-03-20T10:00:00.000Z",
        extractionStatus: "ready",
        lastAnalyzedAt: "2026-03-20T10:01:00.000Z",
        analysisProviderKind: null,
        analysisProviderLabel: null,
        analysisWarnings: [],
      },
      workEligibility: {
        authorizedWorkCountries: [],
        requiresVisaSponsorship: null,
        willingToRelocate: null,
        preferredRelocationRegions: [],
        willingToTravel: null,
        remoteEligible: null,
        noticePeriodDays: null,
        availableStartDate: null,
        securityClearance: null,
      },
      professionalSummary: {
        shortValueProposition: null,
        fullSummary: null,
        careerThemes: [],
        leadershipSummary: null,
        domainFocusSummary: null,
        strengths: [],
      },
      skillGroups: {
        coreSkills: [],
        tools: [],
        languagesAndFrameworks: [],
        softSkills: [],
        highlightedSkills: [],
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
          achievements: ["Led design-system rollout across core surfaces."],
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
      certifications: [],
      links: [
        {
          id: "link_1",
          label: "Portfolio",
          url: "https://alex.example.com",
          kind: "portfolio",
          isDraft: false,
        },
      ],
      projects: [],
      spokenLanguages: [],
    },
    searchPreferences: {
      targetRoles: [
        "Principal Designer",
        "Senior Product Designer",
        "Principal UX Engineer",
      ],
      jobFamilies: [],
      locations: ["Remote", "London"],
      excludedLocations: [],
      workModes: ["remote", "hybrid"],
      seniorityLevels: ["senior"],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: 170000,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: 170000,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: ["Signal Systems"],
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: "target_linkedin_default",
            label: "Primary target",
            startingUrl: "https://www.linkedin.com/jobs/search/",
            enabled: true,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "missing",
            validatedInstructionId: null,
            draftInstructionId: null,
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
        ],
      },
    },
    profileSetupState: {
      status: "completed",
      currentStep: "targeting",
      completedAt: "2026-03-20T10:02:00.000Z",
      reviewItems: [],
      lastResumedAt: null,
    },
    savedJobs: [
      createSavedJob({
        id: "job_ready",
        source: "target_site",
        sourceJobId: "linkedin_signal_ready",
        discoveryMethod: "catalog_seed",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_signal_ready",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_signal_ready/apply",
        title: "Senior Product Designer",
        company: "Signal Systems",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T09:00:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T09:05:00.000Z",
        firstSeenAt: "2026-03-20T09:05:00.000Z",
        lastSeenAt: "2026-03-20T09:05:00.000Z",
        lastVerifiedActiveAt: "2026-03-20T09:05:00.000Z",
        salaryText: "$180k - $220k",
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 180000,
          maxAmount: 220000,
          minAnnualUsd: 180000,
          maxAnnualUsd: 220000,
        },
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
        employerWebsiteUrl: "https://signalsystems.example.com",
        employerDomain: "signalsystems.example.com",
        atsProvider: null,
        screeningHints: {
          sponsorshipText: null,
          requiresSecurityClearance: null,
          relocationText: null,
          travelText: null,
          remoteGeographies: ["Europe"],
          requiresConsentInterrupt: null,
          requiresConsentInterruptKind: null,
        },
        keywordSignals: [
          {
            id: "job_ready_design_systems",
            label: "Design Systems",
            kind: "skill",
            weight: 5,
          },
          {
            id: "job_ready_workflow_platform",
            label: "Workflow platform",
            kind: "domain",
            weight: 4,
          },
        ],
        benefits: ["Remote-first collaboration"],
        status: "ready_for_review",
        matchAssessment: {
          score: 96,
          reasons: ["Strong design systems overlap"],
          gaps: [],
        },
        provenance: [],
      }),
      createSavedJob({
        id: "job_generating",
        source: "target_site",
        sourceJobId: "linkedin_northwind_generating",
        discoveryMethod: "catalog_seed",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_northwind_generating",
        applicationUrl: null,
        title: "Principal UX Engineer",
        company: "Northwind Labs",
        location: "Hybrid, London",
        workMode: ["hybrid"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-03-20T08:00:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-03-20T08:05:00.000Z",
        firstSeenAt: "2026-03-20T08:05:00.000Z",
        lastSeenAt: "2026-03-20T08:05:00.000Z",
        lastVerifiedActiveAt: "2026-03-20T08:05:00.000Z",
        salaryText: "$175k - $205k",
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 175000,
          maxAmount: 205000,
          minAnnualUsd: 175000,
          maxAnnualUsd: 205000,
        },
        summary: "Lead cross-functional UI platform work.",
        description:
          "Lead cross-functional UI platform work with portfolio review required.",
        keySkills: ["React"],
        responsibilities: ["Lead UI platform architecture."],
        minimumQualifications: ["Deep React experience."],
        preferredQualifications: ["Accessibility leadership experience."],
        seniority: "Principal",
        employmentType: "Full-time",
        department: "Engineering",
        team: "UI Platform",
        employerWebsiteUrl: "https://northwind.example.com",
        employerDomain: "northwind.example.com",
        atsProvider: null,
        screeningHints: {
          sponsorshipText: null,
          requiresSecurityClearance: null,
          relocationText: null,
          travelText: null,
          remoteGeographies: [],
          requiresConsentInterrupt: null,
          requiresConsentInterruptKind: null,
        },
        keywordSignals: [
          {
            id: "job_generating_react",
            label: "React",
            kind: "skill",
            weight: 5,
          },
        ],
        benefits: ["Hybrid London team"],
        status: "drafting",
        matchAssessment: {
          score: 88,
          reasons: ["Strong platform overlap"],
          gaps: ["Accessibility leadership"],
        },
        provenance: [],
      }),
    ],
    tailoredAssets: [
      {
        id: "asset_ready",
        jobId: "job_ready",
        kind: "resume",
        status: "ready",
        label: "Tailored Resume",
        version: "v2",
        templateName: "Chronology Classic",
        compatibilityScore: 97,
        progressPercent: 100,
        updatedAt: "2026-03-20T10:01:00.000Z",
        storagePath: "/tmp/job-ready-resume.pdf",
        contentText: "Resume text",
        previewSections: [],
        generationMethod: "deterministic",
        notes: [],
        failureMessage: null,
        failedAt: null,
      },
      {
        id: "asset_generating",
        jobId: "job_generating",
        kind: "resume",
        status: "generating",
        label: "Tailored Resume",
        version: "v1",
        templateName: "Chronology Classic",
        compatibilityScore: null,
        progressPercent: 62,
        updatedAt: "2026-03-20T10:02:00.000Z",
        storagePath: null,
        contentText: null,
        previewSections: [],
        generationMethod: "deterministic",
        notes: [],
        failureMessage: null,
        failedAt: null,
      },
    ],
    resumeDrafts: [],
    resumeDraftRevisions: [],
    resumeExportArtifacts: [],
    resumeResearchArtifacts: [],
    resumeValidationResults: [],
    resumeAssistantMessages: [],
    applyRuns: [],
    applyJobResults: [],
    applySubmitApprovals: [],
    applicationQuestionRecords: [],
    applicationAnswerRecords: [],
    applicationArtifactRefs: [],
    applicationReplayCheckpoints: [],
    applicationConsentRequests: [],
    applicationAuthorityEnvelopes: [],
    submissionPreflights: [],
    submissionExecutionGrants: [],
    submissionIdempotencyRecords: [],
    submissionArmedMarkers: [],
    submissionOutcomeRecords: [],
    applicationRecords: [],
    applicationAttempts: [],
    userActionRequests: [],
    userActionEvents: [],
    sourceDebugRuns: [],
    sourceDebugAttempts: [],
    sourceInstructionArtifacts: [],
    sourceDebugEvidenceRefs: [],
    resumeImportRuns: [],
    resumeImportDocumentBundles: [],
    resumeImportFieldCandidates: [],
    profileCopilotMessages: [],
    profileRevisions: [],
    settings: {
      resumeFormat: "pdf",
      resumeTemplateId: "classic_ats",
      fontPreset: "inter_requisite",
      appearanceTheme: "system",
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
      keepSessionAlive: false,
      discoveryOnly: false,
    },
    discovery: JobFinderDiscoveryStateSchema.parse({
      sessions: [],
      activeSourceDebugRun: null,
      recentSourceDebugRuns: [],
    }),
    campaigns: [],
    activeCampaignId: null,
    campaignNotifications: [],
    activityControl: { paused: false, pausedAt: null, reason: null },
    intelligence: JobFinderIntelligenceStateSchema.parse({}),
  };
}

/**
 * Seed profile in the canonical first-run state, mirroring
 * `createFreshStartCandidateProfile()`: no persisted identity facts and no
 * preferred application contact. Fixtures that model a first resume import
 * must start from this shape so the resume identity gate legitimately lets the
 * imported resume establish the profile identity instead of failing closed on
 * a mismatch with a different seeded person.
 */
export function createFreshStartSeedProfile(): JobFinderRepositorySeed["profile"] {
  const profile = createSeed().profile;

  return {
    ...profile,
    id: FRESH_START_CANDIDATE_PROFILE_ID,
    firstName: null,
    middleName: null,
    lastName: null,
    fullName: null,
    preferredDisplayName: null,
    headline: null,
    summary: null,
    currentLocation: null,
    currentCity: null,
    currentRegion: null,
    currentCountry: null,
    yearsExperience: 0,
    email: null,
    secondaryEmail: null,
    phone: null,
    applicationIdentity: {
      ...profile.applicationIdentity,
      preferredEmail: null,
      preferredPhone: null,
    },
    baseResume: {
      ...profile.baseResume,
      extractionStatus: "not_started",
      lastAnalyzedAt: null,
    },
  };
}

export function createResumeExtraction(
  overrides: Partial<ResumeProfileExtraction> = {},
): ResumeProfileExtraction {
  return {
    firstName: null,
    lastName: null,
    middleName: null,
    fullName: null,
    headline: null,
    summary: null,
    currentLocation: null,
    timeZone: null,
    salaryCurrency: null,
    yearsExperience: null,
    email: null,
    phone: null,
    portfolioUrl: null,
    linkedinUrl: null,
    githubUrl: null,
    personalWebsiteUrl: null,
    professionalSummary: {
      shortValueProposition: null,
      fullSummary: null,
      careerThemes: [],
      leadershipSummary: null,
      domainFocusSummary: null,
      strengths: [],
    },
    skillGroups: {
      coreSkills: [],
      tools: [],
      languagesAndFrameworks: [],
      softSkills: [],
      highlightedSkills: [],
    },
    skills: [],
    targetRoles: [],
    preferredLocations: [],
    experiences: [],
    education: [],
    certifications: [],
    links: [],
    projects: [],
    spokenLanguages: [],
    analysisProviderKind: "deterministic",
    analysisProviderLabel: "Stub extraction",
    notes: [],
    ...overrides,
  };
}
