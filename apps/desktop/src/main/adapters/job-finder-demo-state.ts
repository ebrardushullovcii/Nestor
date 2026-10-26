import {
  JobFinderRepositoryStateSchema,
  type JobFinderRepositoryState,
} from "@nestor/contracts";
import {
  JOB_FINDER_DEMO_CONSENT_RESUME_PATH,
  JOB_FINDER_DEMO_EXPORT_RESUME_SHA256,
  JOB_FINDER_DEMO_READY_RESUME_PATH,
  JOB_FINDER_DEMO_RESUME_FORMAT,
  JOB_FINDER_DEMO_SOURCE_RESUME_PATH,
  JOB_FINDER_DEMO_SOURCE_RESUME_SHA256,
} from "./job-finder-demo-resume-files";
import { createEmptyJobFinderRepositoryState } from "./job-finder-initial-state";

const demoDiscoveryTarget = {
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
} as const;

const demoSeedProvenance = {
  targetId: demoDiscoveryTarget.id,
  adapterKind: demoDiscoveryTarget.adapterKind,
  resolvedAdapterKind: "target_site",
  startingUrl: demoDiscoveryTarget.startingUrl,
  collectionMethod: "fallback_search",
} as const;

const demoResumeDraftSections = [
  {
    id: "section_summary",
    kind: "summary",
    label: "Summary",
    text: "Systems-focused product designer with deep workflow automation and design-systems experience.",
    bullets: [],
    entries: [],
    origin: "deterministic_fallback",
    locked: false,
    included: true,
    sortOrder: 0,
    entryOrderMode: "chronology",
    profileRecordId: null,
    sourceRefs: [],
    updatedAt: "2026-03-20T10:04:00.000Z",
  },
  {
    id: "section_experience",
    kind: "experience",
    label: "Experience",
    text: null,
    bullets: [],
    entries: [
      {
        id: "entry_coreledger_recent",
        entryType: "experience",
        title: ".NET Developer",
        subtitle: "CoreLedger",
        location: "Prishtina, Kosovo",
        dateRange: "Aug 2019 - Jan 2022",
        summary:
          "Built workflow applications and maintained production services.",
        bullets: [
          {
            id: "bullet_coreledger_recent",
            text: "Authored quick fixes that restored business-critical services while preserving release reliability.",
            origin: "deterministic_fallback",
            locked: false,
            included: true,
            sourceRefs: [],
            updatedAt: "2026-03-20T10:04:00.000Z",
          },
        ],
        origin: "deterministic_fallback",
        locked: false,
        included: true,
        sortOrder: 1,
        profileRecordId: "experience_coreledger_recent",
        sourceRefs: [],
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
      {
        id: "entry_signal_systems",
        entryType: "experience",
        title: "Senior systems designer",
        subtitle: "Signal Systems",
        location: "London, UK",
        dateRange: "2020 - Present",
        summary: "Leads design systems and workflow platform improvements.",
        bullets: [
          {
            id: "bullet_signal_rollout",
            text: "Led design-system rollout across core workflow surfaces used by design and operations teams.",
            origin: "deterministic_fallback",
            locked: false,
            included: true,
            sourceRefs: [],
            updatedAt: "2026-03-20T10:04:00.000Z",
          },
        ],
        origin: "deterministic_fallback",
        locked: false,
        included: true,
        sortOrder: 0,
        profileRecordId: "experience_1",
        sourceRefs: [],
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
      {
        id: "entry_coreledger_older",
        entryType: "experience",
        title: ".NET Developer",
        subtitle: "CoreLedger Legacy",
        location: "Prishtina, Kosovo",
        dateRange: "2016 - 2018",
        summary: "Maintained earlier .NET applications.",
        bullets: [
          {
            id: "bullet_coreledger_older",
            text: "Maintained legacy .NET services and supported incident recovery.",
            origin: "deterministic_fallback",
            locked: false,
            included: true,
            sourceRefs: [],
            updatedAt: "2026-03-20T10:04:00.000Z",
          },
        ],
        origin: "deterministic_fallback",
        locked: false,
        included: true,
        sortOrder: 2,
        profileRecordId: "experience_coreledger_older",
        sourceRefs: [],
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ],
    origin: "deterministic_fallback",
    locked: false,
    included: true,
    sortOrder: 1,
    entryOrderMode: "chronology",
    profileRecordId: null,
    sourceRefs: [],
    updatedAt: "2026-03-20T10:04:00.000Z",
  },
] as const;

const orderedDemoResumeDraftSections = demoResumeDraftSections.map((section) =>
  section.id === "section_experience"
    ? {
        ...section,
        entries: [...section.entries].sort(
          (left, right) => left.sortOrder - right.sortOrder,
        ),
      }
    : section,
);

export function createResumeWorkspaceDemoState(): JobFinderRepositoryState {
  const emptyState = createEmptyJobFinderRepositoryState();

  return JobFinderRepositoryStateSchema.parse({
    ...emptyState,
    profile: {
      ...emptyState.profile,
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
      applicationIdentity: {
        preferredEmail: "alex@example.com",
        preferredPhone: "+44 7700 900123",
        preferredLinkIds: ["link_1"],
      },
      baseResume: {
        ...emptyState.profile.baseResume,
        id: "resume_1",
        fileName: "alex-vanguard.pdf",
        uploadedAt: "2026-03-20T10:00:00.000Z",
        storagePath: JOB_FINDER_DEMO_SOURCE_RESUME_PATH,
        sha256: JOB_FINDER_DEMO_SOURCE_RESUME_SHA256,
        textContent:
          "Alex Vanguard\nSenior systems designer\nLondon, UK\nalex@example.com\n+44 7700 900123\nhttps://alex.example.com\nhttps://www.linkedin.com/in/alex-vanguard\n\n10 years of experience building resilient workflow tools with Figma, React, and design systems.",
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
        {
          id: "experience_coreledger_recent",
          companyName: "CoreLedger",
          companyUrl: null,
          title: ".NET Developer",
          employmentType: "Full-time",
          location: "Prishtina, Kosovo",
          workMode: ["hybrid"],
          startDate: "2019-08",
          endDate: "2022-01",
          isCurrent: false,
          isDraft: false,
          summary:
            "Built workflow applications and maintained production services.",
          achievements: [
            "Authored quick fixes that restored business-critical services while preserving release reliability.",
          ],
          skills: [".NET", "C#", "SQL"],
          domainTags: ["web applications"],
          peopleManagementScope: null,
          ownershipScope: null,
        },
        {
          id: "experience_coreledger_older",
          companyName: "CoreLedger Legacy",
          companyUrl: null,
          title: ".NET Developer",
          employmentType: "Full-time",
          location: "Prishtina, Kosovo",
          workMode: ["hybrid"],
          startDate: "2016-01",
          endDate: "2018-12",
          isCurrent: false,
          isDraft: false,
          summary: "Maintained earlier .NET applications.",
          achievements: [
            "Maintained legacy .NET services and supported incident recovery.",
          ],
          skills: [".NET", "C#"],
          domainTags: ["web applications"],
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
    },
    searchPreferences: {
      ...emptyState.searchPreferences,
      targetRoles: [
        "Principal Designer",
        "Senior Product Designer",
        "Principal UX Engineer",
      ],
      locations: ["Remote", "London"],
      workModes: ["remote", "hybrid"],
      seniorityLevels: ["senior"],
      minimumSalaryUsd: 170000,
      salaryCurrency: "USD",
      companyWhitelist: ["Signal Systems"],
      discovery: {
        historyLimit: 5,
        targets: [demoDiscoveryTarget],
      },
    },
    savedJobs: [
      {
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
        },
        keywordSignals: [
          {
            id: "job_ready_signal_design_systems",
            label: "Design Systems",
            kind: "skill",
            weight: 5,
          },
          {
            id: "job_ready_signal_workflow_platform",
            label: "Workflow platform",
            kind: "domain",
            weight: 4,
          },
        ],
        benefits: ["Remote-first collaboration"],
        status: "ready_for_review",
        matchAssessment: {
          score: 96,
          reasons: ["Strong design-systems overlap"],
          gaps: [],
        },
        provenance: [
          {
            ...demoSeedProvenance,
            discoveredAt: "2026-03-20T09:05:00.000Z",
          },
        ],
      },
      {
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
        },
        keywordSignals: [
          {
            id: "job_generating_react",
            label: "React",
            kind: "skill",
            weight: 5,
          },
          {
            id: "job_generating_portfolio",
            label: "Portfolio review",
            kind: "qualification",
            weight: 3,
          },
        ],
        benefits: ["Hybrid London team"],
        status: "drafting",
        matchAssessment: {
          score: 88,
          reasons: ["Strong platform overlap"],
          gaps: ["Accessibility leadership"],
        },
        provenance: [
          {
            ...demoSeedProvenance,
            discoveredAt: "2026-03-20T08:05:00.000Z",
          },
        ],
      },
    ],
    tailoredAssets: [],
    resumeDrafts: [],
    resumeDraftRevisions: [],
    resumeExportArtifacts: [],
    resumeResearchArtifacts: [],
    resumeValidationResults: [],
    resumeAssistantMessages: [],
    applicationRecords: [],
    applicationAttempts: [],
    sourceDebugRuns: [],
    sourceDebugAttempts: [],
    sourceInstructionArtifacts: [],
    sourceDebugEvidenceRefs: [],
    resumeImportRuns: [],
    resumeImportDocumentBundles: [],
    resumeImportFieldCandidates: [],
    settings: {
      ...emptyState.settings,
      resumeTemplateId: "classic_ats",
      resumeFormat: "pdf",
      fontPreset: "inter_requisite",
      appearanceTheme: "system",
      humanReviewRequired: true,
      keepSessionAlive: false,
      allowAutoSubmitOverride: false,
      discoveryOnly: false,
    },
    discovery: {
      sessions: [],
      activeSourceDebugRun: null,
      recentSourceDebugRuns: [],
    },
  });
}

/**
 * Prepare-only apply lineage for the demo queue.
 *
 * The loader used to reset the workspace with zero rows in every apply table,
 * so Applications could only ever render its empty state and the browser
 * hand-off — the one place that names "the Job Finder browser" and offers
 * "Check whether this step is done" — was unreachable without actually running
 * a preparation against a live employer page. These rows are plainly synthetic
 * (`demo_` identifiers, example.com-shaped LinkedIn demo URLs) and describe two
 * *paused* outcomes only: one where the user must finish a conflicting field in
 * the open application, and one where the site blocked automatic preparation.
 *
 * Nothing here ever claims a submission: every result stays `awaiting_review`,
 * every attempt stays `paused` with a null outcome, `submittedJobs` is 0, and
 * both privacy receipts keep `finalSubmitAuthorized`, `finalSubmitOccurred`,
 * and `accountCreationAuthorized` false with no external writes.
 */
const DEMO_APPLY_RUN_ID = "apply_run_demo_apply_queue";
const DEMO_READY_RESULT_ID = "apply_result_demo_job_ready";
const DEMO_READY_RECORD_ID = "application_record_demo_job_ready";
const DEMO_BLOCKED_RESULT_ID = "apply_result_demo_job_consent_queue";
const DEMO_BLOCKED_RECORD_ID = "application_record_demo_job_consent_queue";
const DEMO_APPLY_ORIGIN = "https://www.linkedin.com/";

function createDemoPrivacyReceipt(input: {
  jobId: string;
  resultId: string;
  applicationRecordId: string;
  safePath: string;
  exportArtifactId: string;
  fileName: string;
}) {
  return {
    schemaVersion: 1,
    generatedAt: "2026-03-20T10:12:00.000Z",
    lineage: {
      runId: DEMO_APPLY_RUN_ID,
      jobId: input.jobId,
      resultId: input.resultId,
      applicationRecordId: input.applicationRecordId,
    },
    destination: {
      origin: DEMO_APPLY_ORIGIN,
      safePath: input.safePath,
    },
    resume: {
      source: "tailored_export",
      sourceDocumentId: null,
      exportArtifactId: input.exportArtifactId,
      fileName: input.fileName,
      sha256: JOB_FINDER_DEMO_EXPORT_RESUME_SHA256,
    },
    stayedLocal: [],
    modelUse: [],
    externalWrites: [],
    accountCreationAuthorized: false,
    finalSubmitAuthorized: false,
    finalSubmitOccurred: false,
    submissionOutcome: null,
  };
}

const demoApplyRun = {
  id: DEMO_APPLY_RUN_ID,
  campaignId: null,
  mode: "copilot",
  state: "paused_for_user_review",
  jobIds: ["job_ready", "job_consent_queue"],
  currentJobId: "job_ready",
  submitApprovalId: null,
  visualCheckpointsEnabled: false,
  createdAt: "2026-03-20T10:10:00.000Z",
  updatedAt: "2026-03-20T10:12:00.000Z",
  completedAt: null,
  summary: "Preparation paused for your review",
  detail:
    "Job Finder prepared both applications and stopped before the employer's submit control.",
  totalJobs: 2,
  pendingJobs: 2,
  submittedJobs: 0,
  skippedJobs: 0,
  blockedJobs: 0,
  failedJobs: 0,
};

const demoApplyJobResults = [
  {
    id: DEMO_READY_RESULT_ID,
    runId: DEMO_APPLY_RUN_ID,
    jobId: "job_ready",
    applicationRecordId: DEMO_READY_RECORD_ID,
    queuePosition: 0,
    state: "awaiting_review",
    summary: "Finish this application step yourself",
    // Matches the manual-field-finish classification, which is what puts the
    // "Open the Job Finder browser" / "Check whether this step is done" pair
    // on Applications.
    detail:
      "Two prefilled application values need manual review because they conflict with your saved profile. Review the conflicting answers and finish this application step yourself in the open application.",
    startedAt: "2026-03-20T10:10:00.000Z",
    updatedAt: "2026-03-20T10:12:00.000Z",
    completedAt: null,
    applicationPreparationStartedAt: "2026-03-20T10:10:00.000Z",
    applicationPreparationStartedLocalDate: "2026-03-20",
    blockerReason: "required_human_input",
    blockerSummary:
      "Job Finder could not safely save this prepared step without your review.",
    listingSignalEvidence: null,
    visualObservationSets: [],
    visualCheckpoints: [],
    latestQuestionCount: 6,
    latestAnswerCount: 4,
    pendingConsentRequestCount: 0,
    artifactCount: 1,
    latestCheckpointId: null,
    privacyReceipt: createDemoPrivacyReceipt({
      jobId: "job_ready",
      resultId: DEMO_READY_RESULT_ID,
      applicationRecordId: DEMO_READY_RECORD_ID,
      safePath: "/jobs/view/linkedin_signal_ready/apply",
      exportArtifactId: "resume_export_job_ready",
      fileName: "job-ready-resume.pdf",
    }),
  },
  {
    id: DEMO_BLOCKED_RESULT_ID,
    runId: DEMO_APPLY_RUN_ID,
    jobId: "job_consent_queue",
    applicationRecordId: DEMO_BLOCKED_RECORD_ID,
    queuePosition: 1,
    state: "blocked",
    summary: "The job site blocked automatic preparation",
    detail:
      "The job site's service worker blocked automatic preparation. Reset the browser in Safeguards, then finish on the site.",
    startedAt: "2026-03-20T10:11:00.000Z",
    updatedAt: "2026-03-20T10:12:00.000Z",
    completedAt: null,
    applicationPreparationStartedAt: "2026-03-20T10:11:00.000Z",
    applicationPreparationStartedLocalDate: "2026-03-20",
    blockerReason: "site_protection",
    blockerSummary:
      "A site service worker stopped the prepared step before it could be saved.",
    listingSignalEvidence: null,
    visualObservationSets: [],
    visualCheckpoints: [],
    latestQuestionCount: 3,
    latestAnswerCount: 3,
    pendingConsentRequestCount: 0,
    artifactCount: 1,
    latestCheckpointId: null,
    privacyReceipt: createDemoPrivacyReceipt({
      jobId: "job_consent_queue",
      resultId: DEMO_BLOCKED_RESULT_ID,
      applicationRecordId: DEMO_BLOCKED_RECORD_ID,
      safePath: "/jobs/view/linkedin_consent_queue/apply",
      exportArtifactId: "resume_export_job_consent_queue",
      fileName: "job-consent-queue-resume.pdf",
    }),
  },
];

const demoApplicationRecords = [
  {
    id: DEMO_READY_RECORD_ID,
    jobId: "job_ready",
    title: "Senior Product Designer",
    company: "Signal Systems",
    status: "ready_for_review",
    lastActionLabel: "Preparation paused for your review",
    nextActionLabel:
      "Finish the conflicting step in the open application, then check whether it is done.",
    lastUpdatedAt: "2026-03-20T10:12:00.000Z",
    lastAttemptState: "paused",
    questionSummary: {
      total: 6,
      required: 5,
      answered: 4,
      unansweredRequired: 1,
    },
    latestBlocker: {
      code: "requires_manual_review",
      summary:
        "Two prefilled application values conflict with your saved profile.",
    },
    events: [
      {
        id: "application_event_demo_job_ready_paused",
        at: "2026-03-20T10:12:00.000Z",
        title: "Preparation paused",
        detail:
          "Job Finder stopped before the employer's submit control and left the step for you.",
        emphasis: "warning",
      },
    ],
  },
  {
    id: DEMO_BLOCKED_RECORD_ID,
    jobId: "job_consent_queue",
    title: "Staff Product Designer",
    company: "Consent Labs",
    status: "ready_for_review",
    lastActionLabel: "Automatic prep paused",
    nextActionLabel:
      "Open Safeguards to reset the Job Finder browser, then finish on the site.",
    lastUpdatedAt: "2026-03-20T10:12:00.000Z",
    lastAttemptState: "paused",
    questionSummary: {
      total: 3,
      required: 3,
      answered: 3,
      unansweredRequired: 0,
    },
    latestBlocker: {
      code: "requires_manual_review",
      summary: "The job site blocked automatic preparation.",
    },
    events: [
      {
        id: "application_event_demo_job_consent_queue_blocked",
        at: "2026-03-20T10:12:00.000Z",
        title: "Automatic prep paused",
        detail:
          "The job site blocked automatic preparation before anything was submitted.",
        emphasis: "warning",
      },
    ],
  },
];

const demoApplicationAttempts = [
  {
    id: "application_attempt_demo_job_ready",
    jobId: "job_ready",
    applicationRecordId: DEMO_READY_RECORD_ID,
    state: "paused",
    summary: "Paused for your review",
    detail:
      "Job Finder prepared the application and stopped before the employer's submit control.",
    startedAt: "2026-03-20T10:10:00.000Z",
    updatedAt: "2026-03-20T10:12:00.000Z",
    completedAt: null,
    outcome: null,
    blocker: {
      code: "requires_manual_review",
      summary:
        "Two prefilled application values conflict with your saved profile.",
      detail:
        "Finish the affected step yourself in the open application, then check whether it is done.",
      url: "https://www.linkedin.com/jobs/view/linkedin_signal_ready/apply",
    },
    nextActionLabel:
      "Finish the conflicting step in the open application, then check whether it is done.",
  },
  {
    id: "application_attempt_demo_job_consent_queue",
    jobId: "job_consent_queue",
    applicationRecordId: DEMO_BLOCKED_RECORD_ID,
    state: "paused",
    summary: "Automatic prep paused",
    detail:
      "The job site blocked automatic preparation before anything was submitted.",
    startedAt: "2026-03-20T10:11:00.000Z",
    updatedAt: "2026-03-20T10:12:00.000Z",
    completedAt: null,
    outcome: null,
    blocker: {
      code: "requires_manual_review",
      summary: "The job site blocked automatic preparation.",
      detail:
        "Reset the browser in Safeguards, then finish on the site yourself.",
      url: "https://www.linkedin.com/jobs/view/linkedin_consent_queue/apply",
    },
    nextActionLabel:
      "Open Safeguards to reset the Job Finder browser, then finish on the site.",
  },
];

/**
 * The pending browser step Applications reads to enable "Check whether this
 * step is done". Credentials stay browser-only and both submit and
 * account-creation authority stay false, exactly as the schema requires.
 */
const demoBrowserStepUserActionRequest = {
  schemaVersion: 1,
  id: "user_action_demo_job_ready_browser_step",
  dedupeKey: "user_action_demo_job_ready_browser_step",
  revision: 1,
  kind: "manual_answer",
  state: "awaiting_user",
  requirement: "required",
  scope: {
    type: "application",
    runId: DEMO_APPLY_RUN_ID,
    jobId: "job_ready",
    applicationRecordId: DEMO_READY_RECORD_ID,
    resultId: DEMO_READY_RESULT_ID,
    replayCheckpointId: null,
    source: "target_site",
  },
  verification: {
    type: "form_control_state",
    controlFingerprint: "demo_apply_queue_conflicting_field",
    expectedState: "answered",
    expectedPageFingerprint: null,
  },
  title: "Finish the conflicting application step",
  summary:
    "Two prefilled values conflict with your saved profile. Finish that step in the open application, then check whether it is done.",
  instructions: [],
  actionUrl: "https://www.linkedin.com/jobs/view/linkedin_signal_ready/apply",
  displayOrigin: DEMO_APPLY_ORIGIN,
  credentialsPolicy: "browser_only",
  submitAuthorized: false,
  accountCreationAuthorized: false,
  attemptCount: 0,
  maxAttempts: 3,
  createdAt: "2026-03-20T10:12:00.000Z",
  updatedAt: "2026-03-20T10:12:00.000Z",
  openedAt: null,
  resolvedAt: null,
  expiresAt: null,
};

export function createApplyQueueDemoState(): JobFinderRepositoryState {
  const resumeDemoState = createResumeWorkspaceDemoState();
  const readySavedJob = resumeDemoState.savedJobs.find(
    (job) => job.id === "job_ready",
  );
  const generatingSavedJob = resumeDemoState.savedJobs.find(
    (job) => job.id === "job_generating",
  );

  if (!readySavedJob || !generatingSavedJob) {
    throw new Error(
      "Resume workspace demo state is missing required saved jobs.",
    );
  }

  return JobFinderRepositoryStateSchema.parse({
    ...resumeDemoState,
    savedJobs: [
      readySavedJob,
      {
        ...readySavedJob,
        id: "job_consent_queue",
        sourceJobId: "linkedin_consent_queue",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_consent_queue/apply",
        title: "Staff Product Designer",
        company: "Consent Labs",
        employerWebsiteUrl: "https://consentlabs.example.com",
        employerDomain: "consentlabs.example.com",
        summary:
          "Guide a workflow platform that pauses on account-consent questions.",
        description:
          "Guide a workflow platform that asks whether you already have an account before continuing the application.",
        keywordSignals: [
          {
            id: "job_consent_queue_consent_gate",
            label: "Existing account decision",
            kind: "qualification",
            weight: 4,
          },
        ],
        screeningHints: {
          ...readySavedJob.screeningHints,
          requiresConsentInterrupt: true,
          requiresConsentInterruptKind: "existing_account_decision",
        },
        status: "ready_for_review",
        matchAssessment: {
          score: 93,
          reasons: ["Strong workflow automation overlap"],
          gaps: [],
        },
      },
      {
        ...generatingSavedJob,
        id: "job_not_ready_queue",
        sourceJobId: "linkedin_not_ready_queue",
        canonicalUrl:
          "https://www.linkedin.com/jobs/view/linkedin_not_ready_queue",
        applicationUrl:
          "https://www.linkedin.com/jobs/view/linkedin_not_ready_queue/apply",
        title: "Lead UX Strategist",
        company: "Northwind Labs",
        status: "ready_for_review",
      },
    ],
    tailoredAssets: [
      {
        id: "asset_job_ready",
        jobId: "job_ready",
        kind: "resume",
        status: "ready",
        label: "Tailored Resume",
        version: "v1",
        templateName: "Chronology Classic",
        compatibilityScore: 96,
        progressPercent: 100,
        updatedAt: "2026-03-20T10:04:00.000Z",
        storagePath: JOB_FINDER_DEMO_READY_RESUME_PATH,
        contentText: "Ready tailored resume for job_ready",
        previewSections: [],
        generationMethod: "deterministic",
        notes: [],
      },
      {
        id: "asset_job_consent_queue",
        jobId: "job_consent_queue",
        kind: "resume",
        status: "ready",
        label: "Tailored Resume",
        version: "v1",
        templateName: "Chronology Classic",
        compatibilityScore: 95,
        progressPercent: 100,
        updatedAt: "2026-03-20T10:04:00.000Z",
        storagePath: JOB_FINDER_DEMO_CONSENT_RESUME_PATH,
        contentText: "Ready tailored resume for job_consent_queue",
        previewSections: [],
        generationMethod: "deterministic",
        notes: [],
      },
    ],
    resumeDrafts: [
      {
        id: "resume_draft_job_ready",
        jobId: "job_ready",
        status: "approved",
        templateId: "classic_ats",
        sections: orderedDemoResumeDraftSections,
        targetPageCount: 2,
        generationMethod: "deterministic",
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_job_ready",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
      {
        id: "resume_draft_job_consent_queue",
        jobId: "job_consent_queue",
        status: "approved",
        templateId: "classic_ats",
        sections: orderedDemoResumeDraftSections,
        targetPageCount: 2,
        generationMethod: "deterministic",
        approvedAt: "2026-03-20T10:04:00.000Z",
        approvedExportId: "resume_export_job_consent_queue",
        staleReason: null,
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
      },
    ],
    resumeExportArtifacts: [
      {
        id: "resume_export_job_ready",
        draftId: "resume_draft_job_ready",
        jobId: "job_ready",
        format: JOB_FINDER_DEMO_RESUME_FORMAT,
        filePath: JOB_FINDER_DEMO_READY_RESUME_PATH,
        sha256: JOB_FINDER_DEMO_EXPORT_RESUME_SHA256,
        pageCount: 1,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
      {
        id: "resume_export_job_consent_queue",
        draftId: "resume_draft_job_consent_queue",
        jobId: "job_consent_queue",
        format: JOB_FINDER_DEMO_RESUME_FORMAT,
        filePath: JOB_FINDER_DEMO_CONSENT_RESUME_PATH,
        sha256: JOB_FINDER_DEMO_EXPORT_RESUME_SHA256,
        pageCount: 1,
        templateId: "classic_ats",
        exportedAt: "2026-03-20T10:04:00.000Z",
        isApproved: true,
      },
    ],
    applyRuns: [demoApplyRun],
    applyJobResults: demoApplyJobResults,
    applicationRecords: demoApplicationRecords,
    applicationAttempts: demoApplicationAttempts,
    userActionRequests: [demoBrowserStepUserActionRequest],
  });
}

/**
 * Test-only seed for the real Apply prerequisite journey. The approved resume
 * intentionally leaves one synthetic, unrelated role out so Apply must pause
 * until the user acknowledges that omission in Resume Studio.
 */
export function createWorkHistoryReviewDriveState(): JobFinderRepositoryState {
  const base = createApplyQueueDemoState();

  return JobFinderRepositoryStateSchema.parse({
    ...base,
    profile: {
      ...base.profile,
      experiences: [
        ...base.profile.experiences,
        {
          id: "experience_synthetic_sales_omission",
          companyName: "Synthetic Market",
          companyUrl: null,
          title: "Sales Operations Associate",
          employmentType: "Full-time",
          location: "Remote",
          workMode: ["remote"],
          startDate: "2015-01",
          endDate: "2015-12",
          isCurrent: false,
          isDraft: false,
          summary: "Maintained synthetic customer operations reporting.",
          achievements: [
            "Prepared weekly pipeline reporting for account teams.",
          ],
          skills: [],
          domainTags: [],
          peopleManagementScope: null,
          ownershipScope: null,
        },
      ],
    },
    resumeDrafts: base.resumeDrafts.map((draft) =>
      draft.jobId === "job_ready"
        ? {
            ...draft,
            sections: draft.sections.map((section) =>
              section.id === "section_summary"
                ? {
                    ...section,
                    text: base.profile.summary,
                    origin: "imported" as const,
                  }
                : section.id === "section_experience"
                  ? {
                      ...section,
                      entries: [
                        ...section.entries.map((entry) =>
                          entry.id === "entry_signal_systems"
                            ? {
                                ...entry,
                                summary: base.profile.experiences[0]!.summary,
                                bullets: entry.bullets.map((bullet) => ({
                                  ...bullet,
                                  text: base.profile.experiences[0]!
                                    .achievements[0]!,
                                })),
                              }
                            : entry,
                        ),
                        {
                          id: "entry_synthetic_sales_omission",
                          entryType: "experience",
                          title: "Sales Operations Associate",
                          subtitle: "Synthetic Market",
                          location: "Remote",
                          dateRange: "2015",
                          summary:
                            "Maintained synthetic customer operations reporting.",
                          bullets: [],
                          origin: "deterministic_fallback",
                          locked: false,
                          included: false,
                          sortOrder: 3,
                          profileRecordId:
                            "experience_synthetic_sales_omission",
                          sourceRefs: [],
                          updatedAt: "2026-03-20T10:04:00.000Z",
                        },
                      ],
                    }
                  : section,
            ),
          }
        : draft,
    ),
    resumeValidationResults: [
      ...base.resumeValidationResults.filter(
        (validation) => validation.draftId !== "resume_draft_job_ready",
      ),
      {
        id: "resume_validation_job_ready_work_history",
        draftId: "resume_draft_job_ready",
        issues: [
          {
            id: "issue_work_history_review_experience_synthetic_sales_omission",
            severity: "info",
            category: "work_history_review",
            sectionId: "section_experience",
            entryId: "entry_synthetic_sales_omission",
            bulletId: null,
            message:
              "Hidden by default for review: this role has a weaker career-family fit for the target job.",
          },
        ],
        draftContentHash: null,
        claimAssessments: [],
        coverageComparison: null,
        pageCount: 1,
        validatedAt: "2026-03-20T10:04:00.000Z",
      },
    ],
  });
}

/** Test-only state for driving the real search/apply agents against a local synthetic site. */
function isLoopbackUrl(value: string | null | undefined): boolean {
  if (!value) return true;
  const hostname = new URL(value).hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

/**
 * The browser-drive seed is pressed for real (Apply to all, a row's Try
 * again), so every job in it must lead to the local replica sites. On
 * 2026-10-23 two seeded jobs still carried the apply-queue demo's
 * linkedin.com addresses and a queue started a run on one.
 */
export function assertDriveSeedStaysLocal(
  state: Pick<JobFinderRepositoryState, "savedJobs">,
): void {
  const leaving = state.savedJobs.filter(
    (job) =>
      !isLoopbackUrl(job.applicationUrl) ||
      !isLoopbackUrl(job.canonicalUrl) ||
      !isLoopbackUrl(job.employerWebsiteUrl),
  );
  if (leaving.length > 0) {
    throw new Error(
      `Browser-drive seed jobs must use loopback addresses: ${leaving.map((job) => job.id).join(", ")}`,
    );
  }
}

export function createAgentOwnedBrowserDriveState(input: {
  sourceUrl: string;
  applicationUrl: string;
  secondaryApplicationUrl?: string;
  /** Match the local site's listing when a harness drives a real send. */
  jobTitle?: string;
  jobCompany?: string;
  /** Extra jobs on Find jobs (not shortlisted), for selection checks. */
  foundJobs?: readonly {
    title: string;
    company: string;
    applicationUrl: string;
  }[];
}): JobFinderRepositoryState {
  // This seed drives the real Apply pipeline, so it must carry the same
  // approved, on-disk resume lineage as the apply-queue demo. Starting from
  // the resume-workspace seed left every live drive blocked before browser
  // launch because that seed intentionally has no generated assets.
  const base = createApplyQueueDemoState();
  const sourceOrigin = new URL(input.sourceUrl).origin;
  // Jobs the inputs do not name keep their place in the seed but point at
  // the local source site, never at the demo's real job board.
  const localJobAddress = (
    job: (typeof base.savedJobs)[number],
  ): (typeof base.savedJobs)[number] => ({
    ...job,
    canonicalUrl: `${sourceOrigin}/jobs/${job.id}`,
    applicationUrl: `${sourceOrigin}/jobs/${job.id}/apply`,
    employerWebsiteUrl: sourceOrigin,
    employerDomain: new URL(sourceOrigin).hostname,
  });
  const state = JobFinderRepositoryStateSchema.parse({
    ...base,
    searchPreferences: {
      ...base.searchPreferences,
      discovery: {
        ...base.searchPreferences.discovery,
        runJobBudget: 2,
        targets: base.searchPreferences.discovery.targets.map((target) => ({
          ...target,
          startingUrl: input.sourceUrl,
        })),
      },
    },
    savedJobs: [
      ...base.savedJobs.map((job) =>
        job.id === "job_ready"
          ? {
              ...job,
              title: input.jobTitle ?? "Platform Engineer",
              company: input.jobCompany ?? "Northwind Tools",
              summary:
                "Own a dependable internal platform spanning TypeScript, React, workflow automation, and design systems.",
              description:
                "Own dependable internal platforms used by product, engineering, and operations. Build TypeScript and React workflow tools, improve design-system foundations, automate operational work, and make production services easier to run. The team values measurable adoption, reliable incident recovery, and clear cross-functional leadership.",
              keySkills: [
                "TypeScript",
                "React",
                "Workflow Automation",
                "Design Systems",
                "Platform Reliability",
              ],
              responsibilities: [
                "Own the internal platform roadmap.",
                "Build workflow automation for product and operations teams.",
                "Improve the reliability and adoption of shared design-system infrastructure.",
              ],
              minimumQualifications: [
                "Experience building TypeScript and React platforms.",
                "Evidence of workflow automation and production reliability work.",
              ],
              preferredQualifications: [
                "Experience leading cross-functional platform initiatives.",
              ],
              canonicalUrl: `${input.sourceUrl.replace(/\/$/u, "")}/jobs/platform-engineer`,
              applicationUrl: input.applicationUrl,
              employerWebsiteUrl: input.applicationUrl,
              employerDomain: new URL(input.applicationUrl).hostname,
            }
          : job.id === "job_consent_queue" && input.secondaryApplicationUrl
            ? {
                ...job,
                title: "Staff Product Designer",
                company: "Contoso Labs",
                canonicalUrl: `${input.sourceUrl.replace(/\/$/u, "")}/jobs/staff-product-designer`,
                applicationUrl: input.secondaryApplicationUrl,
                employerWebsiteUrl: input.secondaryApplicationUrl,
                employerDomain: new URL(input.secondaryApplicationUrl).hostname,
                screeningHints: {
                  ...job.screeningHints,
                  requiresConsentInterrupt: false,
                  requiresConsentInterruptKind: null,
                },
              }
            : localJobAddress(job),
      ),
      ...(input.foundJobs ?? []).map((found, index) => ({
        ...base.savedJobs[0]!,
        id: `job_found_${index + 1}`,
        sourceJobId: `found_${index + 1}`,
        title: found.title,
        company: found.company,
        canonicalUrl: found.applicationUrl,
        applicationUrl: found.applicationUrl,
        employerWebsiteUrl: found.applicationUrl,
        employerDomain: new URL(found.applicationUrl).hostname,
        status: "discovered" as const,
        resumeApplicationMode: undefined,
      })),
    ],
    // Browser-drive fixtures start from approved resume lineage, not from the
    // apply-queue demo's historical runs. Carrying those old run ids into a
    // fresh Electron drive made startup recovery log "Unknown apply run" and
    // polluted Needs you with tasks the harness never created.
    applyRuns: [],
    applyJobResults: [],
    applySubmitApprovals: [],
    applicationAuthorityEnvelopes: [],
    submissionPreflights: [],
    submissionExecutionGrants: [],
    submissionIdempotencyRecords: [],
    submissionArmedMarkers: [],
    submissionOutcomeRecords: [],
    applicationQuestionRecords: [],
    applicationAnswerRecords: [],
    applicationArtifactRefs: [],
    applicationReplayCheckpoints: [],
    applicationConsentRequests: [],
    applicationRecords: [],
    applicationAttempts: [],
    userActionRequests: [],
    userActionEvents: [],
  });
  assertDriveSeedStaysLocal(state);
  return state;
}

/**
 * Isolated Electron drive seed for aggressive tailoring. Same synthetic Alex
 * Vanguard workspace as the apply-queue demo, with listing-asked skills and
 * wording stretches already on the ready draft so the studio can be driven
 * without a live model call.
 */
export function createAggressiveTailoringDriveState(): JobFinderRepositoryState {
  const base = createApplyQueueDemoState();
  const listingSkills = ["Terraform", "Kubernetes"] as const;
  const now = "2026-03-20T10:04:00.000Z";

  return JobFinderRepositoryStateSchema.parse({
    ...base,
    searchPreferences: {
      ...base.searchPreferences,
      tailoringMode: "aggressive",
    },
    savedJobs: base.savedJobs.map((job) =>
      job.id === "job_ready"
        ? {
            ...job,
            keySkills: [...job.keySkills, ...listingSkills],
            description: `${job.description} You'll work with Terraform daily. Strong Framer prototyping and 11 years of professional experience required.`,
            minimumQualifications: [
              ...job.minimumQualifications,
              "Hands-on experience with Terraform and Kubernetes.",
              "11 years of professional experience.",
            ],
          }
        : job,
    ),
    resumeDrafts: base.resumeDrafts.map((draft) =>
      draft.jobId === "job_ready"
        ? {
            ...draft,
            status: "draft",
            approvedAt: null,
            approvedExportId: null,
            generationMethod: "ai",
            sections: [
              ...draft.sections.map((section) =>
                section.id === "section_experience"
                  ? {
                      ...section,
                      entries: section.entries.map((entry) =>
                        entry.id === "entry_signal_systems"
                          ? {
                              ...entry,
                              origin: "ai_generated",
                              bullets: [
                                {
                                  id: "bullet_signal_rollout",
                                  text: "Championed resilient delivery improvements across organizations.",
                                  origin: "ai_generated",
                                  locked: false,
                                  included: true,
                                  sourceRefs: [],
                                  lastGeneratedContentHash: null,
                                  updatedAt: now,
                                },
                                {
                                  id: "bullet_years_framer",
                                  text: "Designed resilient workflow tools in Framer across 11 years of professional experience.",
                                  origin: "ai_generated",
                                  locked: false,
                                  included: true,
                                  sourceRefs: [],
                                  lastGeneratedContentHash: null,
                                  updatedAt: now,
                                },
                              ],
                            }
                          : entry,
                      ),
                    }
                  : section,
              ),
              {
                id: "section_skills",
                kind: "skills",
                label: "Core Skills",
                text: null,
                bullets: listingSkills.map((skill) => ({
                  id: `skill_${skill.toLowerCase()}`,
                  text: skill,
                  origin: "ai_generated",
                  locked: false,
                  included: true,
                  sourceRefs: [],
                  lastGeneratedContentHash: null,
                  updatedAt: now,
                })),
                entries: [],
                origin: "ai_generated",
                locked: false,
                included: true,
                sortOrder: 3,
                entryOrderMode: "chronology",
                profileRecordId: null,
                sourceRefs: [],
                updatedAt: now,
              },
            ],
          }
        : draft,
    ),
  });
}
