import { describe, expect, test } from "vitest";
import {
  createExtractionAiClient,
  createFreshStartSeedProfile,
  createResumeExtraction,
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("auto-applies safe literals from stored resume text while leaving higher-risk fields reviewable", async () => {
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createFreshStartSeedProfile(),
          headline: "Placeholder headline",
          portfolioUrl: null,
          linkedinUrl: null,
          // Untouched: nothing of the person's own is on it yet. A profile
          // with roles or skills on it is theirs, and an import asks before
          // replacing what it holds.
          experiences: [],
          education: [],
          certifications: [],
          projects: [],
          spokenLanguages: [],
          skills: [],
          baseResume: {
            ...createSeed().profile.baseResume,
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            textContent:
              "Jamie Rivers\nStaff Frontend Engineer\nBerlin, Germany\njamie@example.com\n+49 555 1234\nhttps://jamie.dev\nhttps://www.linkedin.com/in/jamie-rivers\n\n12 years of experience building React, TypeScript, and design systems for product teams.",
          },
        },
      },
    });

    const snapshot = await workspaceService.analyzeProfileFromResume();
    const run = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: run?.id ?? "",
    });

    expect(snapshot.profile.fullName).toBe("Jamie Rivers");
    expect(snapshot.profile.currentLocation).toBe("Berlin, Germany");
    expect(snapshot.profile.email).toBe("jamie@example.com");
    expect(snapshot.profile.phone).toBe("+49 555 1234");
    // A fresh profile takes the headline and summary too; nothing waits for
    // a confirmation click when there is no stored value to protect.
    expect(snapshot.profile.headline).toBe("Staff Frontend Engineer");
    expect(snapshot.profile.baseResume.extractionStatus).toBe("ready");
    expect(snapshot.searchPreferences.salaryCurrency).toBe("USD");
    expect(snapshot.latestResumeImportRun?.status).toBe("applied");
    expect(
      snapshot.latestResumeImportReviewCandidates.map(
        (candidate) => candidate.label,
      ),
    ).not.toContain("Headline");
    expect(
      candidates.some(
        (candidate) =>
          candidate.target.section === "identity" &&
          candidate.target.key === "fullName" &&
          candidate.value === "Jamie Rivers" &&
          candidate.resolution === "auto_applied",
      ),
    ).toBe(true);
    expect(
      candidates.some(
        (candidate) =>
          candidate.target.section === "identity" &&
          candidate.target.key === "headline" &&
          candidate.resolution === "auto_applied" &&
          candidate.resolutionReason === "applied_into_empty_profile",
      ),
    ).toBe(true);
  });

  test("derives country from an unambiguous state-backed resume location", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...createFreshStartSeedProfile(),
          baseResume: {
            ...seed.profile.baseResume,
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            textContent: [
              "Jamie Rivers",
              "Staff Product Designer",
              "New York, NY",
              "jamie@example.com",
            ].join("\n"),
          },
        },
      },
    });

    const snapshot = await workspaceService.analyzeProfileFromResume();

    expect(snapshot.profile.currentLocation).toBe("New York, NY");
    expect(snapshot.profile.currentCity).toBe("New York");
    expect(snapshot.profile.currentRegion).toBe("NY");
    expect(snapshot.profile.currentCountry).toBe("United States");
    expect(snapshot.profile.workEligibility.authorizedWorkCountries).toEqual(
      [],
    );
  });

  test("keeps saved links, projects, and languages when extracted records are invalid", async () => {
    const seed = createSeed();
    seed.profile.projects = [
      {
        id: "project_1",
        name: "Signal Design System",
        projectType: "Product",
        summary: "Unified the product UI layer.",
        role: "Lead designer",
        skills: ["Figma", "React"],
        outcome: "Improved release speed.",
        projectUrl: null,
        repositoryUrl: null,
        caseStudyUrl: null,
      },
    ];
    seed.profile.spokenLanguages = [
      {
        id: "language_1",
        language: "English",
        proficiency: "Native",
        interviewPreference: true,
        notes: null,
      },
    ];

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: createExtractionAiClient(
        createResumeExtraction({
          links: [{ label: "Broken link", url: "notaurl", kind: "portfolio" }],
          projects: [
            {
              name: null,
              projectType: "Portfolio",
              summary: "Ignored project",
              role: null,
              skills: [],
              outcome: null,
              projectUrl: null,
              repositoryUrl: null,
              caseStudyUrl: null,
            },
          ],
          spokenLanguages: [
            {
              language: null,
              proficiency: null,
              interviewPreference: false,
              notes: null,
            },
          ],
        }),
      ),
    });

    const snapshot = await workspaceService.analyzeProfileFromResume();

    expect(snapshot.profile.links).toEqual(seed.profile.links);
    expect(snapshot.profile.projects).toEqual(seed.profile.projects);
    expect(snapshot.profile.spokenLanguages).toEqual(
      seed.profile.spokenLanguages,
    );
  });

  test("retains the latest import run summary and unresolved candidate previews", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createFreshStartSeedProfile(),
          baseResume: {
            ...createSeed().profile.baseResume,
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            textContent:
              "Alex Vanguard\nFrontend Engineer\nBerlin, Germany\nalex@example.com\nBuilds resilient workflows for product teams.",
          },
        },
      },
    });

    const snapshot = await workspaceService.analyzeProfileFromResume();

    expect(snapshot.latestResumeImportRun?.status).toBe("applied");
    expect(
      snapshot.latestResumeImportRun?.candidateCounts.autoApplied,
    ).toBeGreaterThan(0);
    expect(snapshot.latestResumeImportRun?.candidateCounts.total).toBeGreaterThan(
      0,
    );
  });

  test("fresh-start sample imports auto-apply placeholder summary and avoid duplicate derived name review", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          id: "candidate_fresh_start",
          firstName: "New",
          lastName: "Candidate",
          fullName: "New Candidate",
          headline: "Import your resume to begin",
          summary:
            "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
          currentLocation: "Set your preferred location",
          timeZone: null,
          yearsExperience: 0,
          email: null,
          phone: null,
          portfolioUrl: null,
          linkedinUrl: null,
          personalWebsiteUrl: null,
          experiences: [],
          targetRoles: [],
          baseResume: {
            ...seed.profile.baseResume,
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            textContent: [
              "Jamie Rivers",
              "Staff Frontend Engineer",
              "Berlin, Germany",
              "jamie@example.com",
              "+49 555 1234",
              "https://jamie.example.test",
              "https://www.linkedin.com/in/jamie-rivers",
              "",
              "Summary",
              "Staff frontend engineer with 12 years of experience building React, TypeScript, and design systems for product teams.",
              "",
              "Experience",
              "Signal Systems",
              "Staff Frontend Engineer",
              "Led design system modernization and improved release confidence across shared UI workflows.",
            ].join("\n"),
          },
        },
        searchPreferences: {
          ...seed.searchPreferences,
          targetRoles: [],
          locations: [],
          workModes: [],
        },
      },
    });

    const snapshot = await workspaceService.analyzeProfileFromResume();

    expect(snapshot.profile.fullName).toBe("Jamie Rivers");
    expect(snapshot.profile.firstName).toBe("Jamie");
    expect(snapshot.profile.lastName).toBe("Rivers");
    expect(snapshot.profile.summary).toContain(
      "12 years of experience building React, TypeScript, and design systems",
    );
    expect(snapshot.profile.yearsExperience).toBe(12);
    const reviewLabels = snapshot.latestResumeImportReviewCandidates.map(
      (candidate) => candidate.label,
    );
    expect(reviewLabels).not.toContain("First name");
    expect(reviewLabels).not.toContain("Last name");
    expect(reviewLabels).not.toContain("Summary");
    expect(reviewLabels).not.toContain("Years of experience");
  });

  test("refresh imports keep earlier document bundles instead of overwriting them by id", async () => {
    const seed = createSeed();
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...createFreshStartSeedProfile(),
          baseResume: {
            ...seed.profile.baseResume,
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            textContent:
              "Jamie Rivers\nStaff Frontend Engineer\nBerlin, Germany\njamie@example.com",
          },
        },
      },
    });

    await workspaceService.analyzeProfileFromResume();
    await workspaceService.analyzeProfileFromResume();

    const runs = await repository.listResumeImportRuns({
      sourceResumeId: seed.profile.baseResume.id,
    });
    const bundles = await repository.listResumeImportDocumentBundles({
      sourceResumeId: seed.profile.baseResume.id,
    });

    expect(runs).toHaveLength(2);
    expect(bundles).toHaveLength(2);
    expect(new Set(bundles.map((bundle) => bundle.id)).size).toBe(2);
    expect(new Set(bundles.map((bundle) => bundle.runId)).size).toBe(2);
  });

  test("maps unresolved import candidates into persisted profile setup review items", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          experiences: [],
          targetRoles: [],
          baseResume: {
            ...createSeed().profile.baseResume,
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
            textContent:
              "Alex Vanguard\nFrontend Engineer\nBerlin, Germany\nalex@example.com\nBuilds resilient workflows for product teams.",
          },
        },
        searchPreferences: {
          ...createSeed().searchPreferences,
          targetRoles: [],
          jobFamilies: [],
          locations: [],
          workModes: [],
        },
        profileSetupState: {
          status: "not_started",
          currentStep: "import",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.analyzeProfileFromResume();

    expect(
      snapshot.profileSetupState.reviewItems.map((item) => item.label),
    ).toEqual(expect.arrayContaining(["Headline", "Work history"]));
    expect(
      snapshot.profileSetupState.reviewItems.find(
        (item) => item.label === "Headline",
      ),
    ).toEqual(
      expect.objectContaining({
        status: "pending",
        step: "essentials",
      }),
    );
  });

  test("reopens a previously resolved setup review item when the underlying field is cleared", async () => {
    const seed = createSeed();
    const latestRunId = "resume_import_run_email_reopen";
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          email: "alex@example.com",
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "answers",
          completedAt: null,
          reviewItems: [
            {
              id: "review_email",
              step: "essentials",
              target: {
                domain: "identity",
                key: "email",
                recordId: null,
              },
              label: "Email",
              reason: "Confirm the imported email before setup is complete.",
              severity: "recommended",
              status: "confirmed",
              proposedValue: "alex@example.com",
              sourceSnippet: "alex@example.com",
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-11T10:00:00.000Z",
              resolvedAt: "2026-04-11T10:05:00.000Z",
            },
          ],
          lastResumedAt: null,
        },
        resumeImportRuns: [
          {
            id: latestRunId,
            sourceResumeId: seed.profile.baseResume.id,
            sourceResumeFileName: seed.profile.baseResume.fileName,
            trigger: "refresh",
            status: "review_ready",
            startedAt: "2026-04-11T10:00:00.000Z",
            completedAt: "2026-04-11T10:04:00.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            warnings: [],
            errorMessage: null,
            candidateCounts: {
              total: 1,
              autoApplied: 0,
              needsReview: 1,
              rejected: 0,
              abstained: 0,
            },
          },
        ],
        resumeImportFieldCandidates: [
          {
            id: "candidate_email_reopen",
            runId: latestRunId,
            target: {
              section: "contact",
              key: "email",
              recordId: null,
            },
            label: "Email",
            sourceKind: "model_identity_summary",
            value: "alex@example.com",
            normalizedValue: null,
            valuePreview: "alex@example.com",
            evidenceText: "alex@example.com",
            sourceBlockIds: [],
            confidence: 0.88,
            confidenceBreakdown: {
              overall: 0.88,
              parserQuality: 0.92,
              evidenceQuality: 0.9,
              agreementScore: 0.86,
              normalizationRisk: 0.04,
              conflictRisk: 0.08,
              fieldSensitivity: "medium",
              recommendation: "needs_review",
            },
            notes: [],
            alternatives: [],
            resolution: "needs_review",
            resolutionReason: null,
            createdAt: "2026-04-11T10:02:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    });

    await workspaceService.saveProfile({
      ...seed.profile,
      email: null,
    });
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const emailReviewItem = snapshot.profileSetupState.reviewItems.find(
      (item) => item.label === "Email",
    );

    // Retired step ids migrate onto the visible step that owns them.
    expect(snapshot.profileSetupState.currentStep).toBe("extras");
    expect(emailReviewItem?.status).toBe("pending");
  });
});
