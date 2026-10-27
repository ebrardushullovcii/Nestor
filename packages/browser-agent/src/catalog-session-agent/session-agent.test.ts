import type {
  BrowserSessionState,
  ApplyExecutionResult,
  JobPosting,
  ApplicationResumeArtifact,
  SavedJob,
} from "@nestor/contracts";
import { SavedJobSchema } from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import { createProfile } from "../agent.test-fixtures";
import { createCatalogSessionAgent } from "./session-agent";

function createReadySession(): BrowserSessionState {
  return {
    source: "target_site",
    status: "ready",
    driver: "catalog_seed",
    label: "Ready",
    detail: "Catalog session is ready.",
    lastCheckedAt: "2026-04-15T10:00:00.000Z",
  };
}

function createBlockedSession(): BrowserSessionState {
  return {
    ...createReadySession(),
    status: "blocked",
    label: "Blocked",
    detail: "Sign-in is required before automation can continue.",
  };
}

function createCatalogJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    source: "target_site",
    sourceJobId: "catalog_job_1",
    discoveryMethod: "catalog_seed",
    listingDetailFetch: null,
    listingDetailCapture: { state: "not_attempted", textHash: null },
    canonicalUrl: "https://jobs.example.com/roles/catalog_job_1",
    applicationUrl: "https://jobs.example.com/roles/catalog_job_1/apply",
    title: "Lead Designer",
    company: "Signal Systems",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-03-20T10:01:00.000Z",
    firstSeenAt: "2026-03-20T10:01:00.000Z",
    lastSeenAt: "2026-03-20T10:01:00.000Z",
    lastVerifiedActiveAt: "2026-03-20T10:01:00.000Z",
    salaryText: "$180k",
    detailQuality: "card_only",
    normalizedCompensation: {
      currency: "USD",
      interval: "year",
      minAmount: 180000,
      maxAmount: 180000,
      minAnnualUsd: 180000,
      maxAnnualUsd: 180000,
    },
    description: "Lead product design for operational software.",
    summary: "Lead product design.",
    keySkills: ["Figma"],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
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
      requiresConsentInterrupt: null,
      requiresConsentInterruptKind: null,
    },
    keywordSignals: [],
    benefits: [],
    ...overrides,
    providerUpdatedAt: overrides.providerUpdatedAt ?? null,
  };
}

function createSavedJob(overrides: Partial<SavedJob> = {}): SavedJob {
  return SavedJobSchema.parse({
    id: "job_1",
    source: "target_site",
    sourceJobId: "target_job_1",
    discoveryMethod: "catalog_seed",
    canonicalUrl: "https://jobs.example.com/roles/target_job_1",
    applicationUrl: "https://jobs.example.com/roles/target_job_1/apply",
    title: "Lead Designer",
    company: "Signal Systems",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "easy_apply",
    easyApplyEligible: true,
    postedAt: "2026-03-20T10:00:00.000Z",
    postedAtText: null,
    discoveredAt: "2026-03-20T10:01:00.000Z",
    firstSeenAt: "2026-03-20T10:01:00.000Z",
    lastSeenAt: "2026-03-20T10:01:00.000Z",
    lastVerifiedActiveAt: "2026-03-20T10:01:00.000Z",
    salaryText: "$180k",
    normalizedCompensation: {
      currency: "USD",
      interval: "year",
      minAmount: 180000,
      maxAmount: 180000,
      minAnnualUsd: 180000,
      maxAnnualUsd: 180000,
    },
    summary: "Lead product design.",
    description: "Lead product design for operational software.",
    keySkills: ["Figma"],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
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
    status: "ready_for_review",
    matchAssessment: {
      score: 94,
      reasons: ["Strong overlap"],
      gaps: [],
    },
    provenance: [],
    ...overrides,
  });
}

function createResumeArtifact(): ApplicationResumeArtifact {
  return {
    id: "application_resume_1",
    jobId: "job_1",
    source: "tailored_export",
    sourceDocumentId: null,
    exportArtifactId: "resume_export_1",
    fileName: "resume.pdf",
    filePath: "/tmp/resume.pdf",
    approvedAt: "2026-03-20T10:07:00.000Z",
  };
}

function expectPreSubmitCheckpoint(result: ApplyExecutionResult) {
  expect(result.state).toBe("paused");
  expect(result.outcome).toBeNull();
  expect(result.submittedAt).toBeNull();
  expect(result.summary).toMatch(/paused before final submit/i);
  expect(
    result.checkpoints.some((checkpoint) => checkpoint.state === "submitted"),
  ).toBe(false);
}

describe("createCatalogSessionAgent", () => {
  test("persists only the approved resume filename in catalog receipts", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [],
    });
    const resumeArtifact = createResumeArtifact();

    const result = await agent.executeEasyApply("target_site", {
      job: createSavedJob(),
      resumeArtifact,
      profile: createProfile(),
      settings: {
        resumeFormat: "pdf",
        resumeTemplateId: "classic_ats",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
      },
    });
    const serialized = JSON.stringify(result);
    const resumeQuestion = result.questions.find(
      (question) => question.kind === "resume",
    );

    expect(serialized).not.toContain(resumeArtifact.filePath);
    expect(serialized).not.toContain("/tmp/");
    expect(resumeQuestion?.submittedAnswer).toBe(resumeArtifact.fileName);
    expect(resumeQuestion?.suggestedAnswers[0]?.text).toBe(
      resumeArtifact.fileName,
    );
    expect(resumeQuestion?.suggestedAnswers[0]?.provenance[0]?.snippet).toBe(
      resumeArtifact.fileName,
    );
    expect(
      result.checkpoints.find((checkpoint) =>
        checkpoint.id.endsWith("_resume_attached"),
      )?.detail,
    ).toContain(resumeArtifact.fileName);
  });

  test("rejects promise-based discovery calls when the session is not ready", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createBlockedSession(),
      listCatalogJobs: () => [],
    });

    await expect(
      agent.runDiscovery("target_site", {
        targetRoles: ["Designer"],
        jobFamilies: [],
        locations: ["Remote"],
        workModes: ["remote"],
        seniorityLevels: [],
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        companyBlacklist: [],
        companyWhitelist: [],
        excludedLocations: [],
        minimumSalaryUsd: null,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        compensation: {
          minimum: null,
          maximum: null,
          interval: "year",
          currency: "USD",
          currencyStatus: "inherited",
        },
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        discovery: {
          targets: [],
          historyLimit: 5,
        },
      }),
    ).rejects.toThrow(/not ready for automation/i);
  });

  test("pauses when detected screening questions extend beyond the old keyword shortlist", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [],
    });

    const result = await agent.executeEasyApply("target_site", {
      job: createSavedJob({
        description:
          "Lead product design for operational software. This application asks about relocation support before submission.",
      }),
      resumeArtifact: createResumeArtifact(),
      profile: createProfile(),
      settings: {
        resumeFormat: "pdf",
        resumeTemplateId: "classic_ats",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
      },
    });

    expect(result.state).toBe("paused");
    expect(result.blocker?.code).toBe("requires_manual_review");
    expect(result.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resume",
          status: "submitted",
          submittedAnswer: "resume.pdf",
        }),
        expect.objectContaining({
          kind: "relocation",
          status: "detected",
        }),
      ]),
    );
    expect(result.nextActionLabel).toMatch(/review the prepared answers/i);
  });

  test("prepare-only application flow attaches resume and pauses before final submit", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [],
    });

    const result = await agent.executeApplicationFlow("target_site", {
      job: createSavedJob(),
      resumeArtifact: createResumeArtifact(),
      profile: createProfile(),
      settings: {
        resumeFormat: "pdf",
        resumeTemplateId: "classic_ats",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
      },
      mode: "prepare_only",
    });

    expect(result.state).toBe("paused");
    expect(result.outcome).toBeNull();
    expect(result.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "resume",
          status: "submitted",
          submittedAnswer: "resume.pdf",
        }),
      ]),
    );
    expect(result.checkpoints.at(-1)).toEqual(
      expect.objectContaining({
        label: "Prepared application for final review",
        state: "paused",
      }),
    );
    expect(result.summary).toMatch(/paused before final submit/i);
  });

  test("keeps every catalog agent apply entrypoint and mode non-submitting", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [],
    });
    const input = {
      job: createSavedJob(),
      resumeArtifact: createResumeArtifact(),
      profile: createProfile(),
      settings: {
        resumeFormat: "pdf" as const,
        resumeTemplateId: "classic_ats" as const,
        fontPreset: "inter_requisite" as const,
        appearanceTheme: "system" as const,
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
      },
    };

    expectPreSubmitCheckpoint(
      await agent.executeEasyApply("target_site", input),
    );
    expectPreSubmitCheckpoint(
      await agent.executeApplicationFlow("target_site", {
        ...input,
        mode: "prepare_only",
      }),
    );
    expectPreSubmitCheckpoint(
      await agent.executeApplicationFlow("target_site", {
        ...input,
        mode: "submit_when_ready",
      }),
    );
  });

  test("prepare-only application flow retains review-ready questions without submitting", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [],
    });

    const result = await agent.executeApplicationFlow("target_site", {
      job: createSavedJob({
        description:
          "Lead product design for operational software. This application asks about relocation support before submission.",
      }),
      resumeArtifact: createResumeArtifact(),
      profile: createProfile(),
      settings: {
        resumeFormat: "pdf",
        resumeTemplateId: "classic_ats",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
      },
      mode: "prepare_only",
    });

    expect(result.state).toBe("paused");
    expect(result.outcome).toBeNull();
    expect(result.blocker?.code).toBe("requires_manual_review");
    expect(result.questions.map((question) => question.kind)).toEqual(
      expect.arrayContaining(["resume", "relocation"]),
    );
    expect(result.nextActionLabel).toMatch(/review the prepared answers/i);
    expect(result.checkpoints.at(-1)?.label).toBe(
      "Captured review-ready questions",
    );
  });

  test("prepare-only application flow pauses for consent-gated steps", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [],
    });

    const result = await agent.executeApplicationFlow("target_site", {
      job: createSavedJob({
        description:
          "Lead product design for operational software. This application asks whether you already have an account before continuing.",
      }),
      resumeArtifact: createResumeArtifact(),
      profile: createProfile(),
      settings: {
        resumeFormat: "pdf",
        resumeTemplateId: "classic_ats",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
      },
      mode: "prepare_only",
    });

    expect(result.state).toBe("paused");
    expect(result.blocker?.code).toBe("missing_consent");
    expect(result.consentDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "requested",
          kind: "manual_follow_up",
        }),
      ]),
    );
    expect(result.nextActionLabel).toMatch(/consent request/i);
    expect(result.checkpoints.at(-1)?.label).toBe("Paused for consent");
  });

  test("prepare-only application flow retains recovery context on retry runs", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [],
    });

    const result = await agent.executeApplicationFlow("target_site", {
      job: createSavedJob(),
      resumeArtifact: createResumeArtifact(),
      profile: createProfile(),
      settings: {
        resumeFormat: "pdf",
        resumeTemplateId: "classic_ats",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
      },
      mode: "prepare_only",
      recoveryContext: {
        previousRunId: "apply_run_previous",
        previousResultId: "apply_result_previous",
        previousRunMode: "copilot",
        previousRunState: "paused_for_user_review",
        latestCheckpoint: {
          label: "Paused for manual review",
          detail: "Unsupported questions were detected before submission.",
          url: "https://jobs.example.com/roles/target_job_1/apply/review",
          jobState: "blocked",
          createdAt: "2026-04-19T10:00:00.000Z",
        },
        checkpointUrls: [
          "https://jobs.example.com/roles/target_job_1/apply",
          "https://jobs.example.com/roles/target_job_1/apply/review",
        ],
        retainedVisualEvidence: [],
        blockerSummary:
          "Additional questions are ready for review before final submit.",
      },
    });

    expect(result.replay.lastUrl).toBe(
      "https://jobs.example.com/roles/target_job_1/apply/review",
    );
    expect(result.replay.checkpointUrls).toEqual(
      expect.arrayContaining([
        "https://jobs.example.com/roles/target_job_1/apply",
        "https://jobs.example.com/roles/target_job_1/apply/review",
      ]),
    );
    expect(result.checkpoints[0]).toEqual(
      expect.objectContaining({
        label: "Resumed from retained apply context",
        state: "in_progress",
      }),
    );
  });

  test("rejects easy apply when the session is not ready", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createBlockedSession(),
      listCatalogJobs: () => [],
    });

    await expect(
      agent.executeEasyApply("target_site", {
        job: createSavedJob(),
        resumeArtifact: createResumeArtifact(),
        profile: createProfile(),
        settings: {
          resumeFormat: "pdf",
          resumeTemplateId: "classic_ats",
          fontPreset: "inter_requisite",
          appearanceTheme: "system",
          humanReviewRequired: true,
          allowAutoSubmitOverride: false,
        },
      }),
    ).rejects.toThrow(/not ready for automation/i);
  });

  test("runAgentDiscovery rejects when no starting URL is provided", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [],
    });

    await expect(
      agent.runAgentDiscovery("target_site", {
        searchPreferences: {
          targetRoles: ["Designer"],
          locations: ["Remote"],
          companyBlacklist: [],
        },
        targetJobCount: 5,
        startingUrls: [],
        siteLabel: "Target Site",
      }),
    ).rejects.toThrow(/requires at least one starting URL/i);
  });

  test("runAgentDiscovery only returns easy apply eligible jobs", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [
        createCatalogJob(),
        createCatalogJob({
          sourceJobId: "catalog_job_2",
          canonicalUrl: "https://jobs.example.com/roles/catalog_job_2",
          easyApplyEligible: false,
        }),
        createCatalogJob({
          sourceJobId: "catalog_job_3",
          canonicalUrl: "https://jobs.example.com/roles/catalog_job_3",
          applicationUrl: "https://jobs.example.com/roles/catalog_job_3/apply",
          applyPath: "external_redirect",
        }),
      ],
    });

    const result = await agent.runAgentDiscovery("target_site", {
      searchPreferences: {
        targetRoles: ["Designer"],
        locations: ["Remote"],
        companyBlacklist: [],
      },
      targetJobCount: 5,
      startingUrls: ["https://jobs.example.com/search"],
      siteLabel: "Target Site",
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.sourceJobId).toBe("catalog_job_1");
  });

  test("runAgentDiscovery excludes canonical exact blacklist matches before its job budget", async () => {
    const agent = createCatalogSessionAgent({
      getSessionState: () => createReadySession(),
      listCatalogJobs: () => [
        createCatalogJob({
          sourceJobId: "blacklisted",
          canonicalUrl: "https://jobs.example.com/roles/blacklisted",
          company: "Cafe\u0301   Works",
        }),
        createCatalogJob({
          sourceJobId: "available",
          canonicalUrl: "https://jobs.example.com/roles/available",
          company: "Café Works, Inc.",
          employerDomain: "cafe.example",
        }),
      ],
    });

    const result = await agent.runAgentDiscovery("target_site", {
      searchPreferences: {
        targetRoles: ["Designer"],
        locations: ["Remote"],
        companyBlacklist: ["  CAFÉ---WORKS  "],
      },
      targetJobCount: 1,
      startingUrls: ["https://jobs.example.com/search"],
      siteLabel: "Target Site",
    });

    expect(result.jobs.map((entry) => entry.sourceJobId)).toEqual([
      "available",
    ]);
  });
});
