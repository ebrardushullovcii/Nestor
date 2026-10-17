import { describe, expect, test } from "vitest";
import { ResumeImportModelRoleStateSchema } from "@nestor/contracts";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";
import {
  PROFILE_PLACEHOLDER_HEADLINE,
  PROFILE_PLACEHOLDER_LOCATION,
} from "./internal/workspace-defaults";

describe("createJobFinderWorkspaceService", () => {
  test("synchronizes resolved setup review items back into latest import candidates", async () => {
    const seed = createSeed();
    const latestRunId = "resume_import_run_sync_review_state";
    const reviewCandidateId = "candidate_headline_sync";
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          headline: "Senior systems designer",
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_headline_sync",
              step: "essentials",
              target: {
                domain: "identity",
                key: "headline",
                recordId: null,
              },
              label: "Headline",
              reason: "Confirm the imported headline before setup is complete.",
              severity: "recommended",
              status: "edited",
              proposedValue: "Principal Product Designer",
              sourceSnippet: "Principal Product Designer",
              sourceCandidateId: reviewCandidateId,
              sourceRunId: latestRunId,
              createdAt: "2026-04-12T09:00:00.000Z",
              resolvedAt: "2026-04-12T09:05:00.000Z",
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
            startedAt: "2026-04-12T08:50:00.000Z",
            completedAt: "2026-04-12T08:55:00.000Z",
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
            id: reviewCandidateId,
            runId: latestRunId,
            target: {
              section: "identity",
              key: "headline",
              recordId: null,
            },
            label: "Headline",
            sourceKind: "model_identity_summary",
            value: "Principal Product Designer",
            normalizedValue: null,
            valuePreview: "Principal Product Designer",
            evidenceText: "Principal Product Designer",
            sourceBlockIds: [],
            confidence: 0.82,
            confidenceBreakdown: {
              overall: 0.82,
              parserQuality: 0.9,
              evidenceQuality: 0.84,
              agreementScore: 0.8,
              normalizationRisk: 0.06,
              conflictRisk: 0.16,
              fieldSensitivity: "medium",
              recommendation: "needs_review",
            },
            notes: [],
            alternatives: [],
            resolution: "needs_review",
            resolutionReason: null,
            createdAt: "2026-04-12T08:52:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    });

    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const latestRun = await repository.getLatestResumeImportRun();
    const latestCandidates = await repository.listResumeImportFieldCandidates({
      runId: latestRun?.id ?? "",
    });

    expect(snapshot.profileSetupState.reviewItems[0]?.status).toBe("edited");
    expect(latestRun?.status).toBe("applied");
    expect(latestRun?.candidateCounts.needsReview).toBe(0);
    expect(latestCandidates[0]).toEqual(
      expect.objectContaining({
        resolution: "rejected",
        resolutionReason: "review_edited",
      }),
    );
  });

  test("applies the selected import conflict choice instead of only the recommended value", async () => {
    const seed = createSeed();
    const latestRunId = "resume_import_run_conflict_choice";
    const reviewCandidateId = "candidate_headline_conflict_choice";
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          headline: "Import your resume to begin",
          baseResume: {
            ...seed.profile.baseResume,
            id: "resume_conflict_choice",
          },
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_headline_conflict_choice",
              step: "essentials",
              target: {
                domain: "identity",
                key: "headline",
                recordId: null,
              },
              label: "Headline",
              reason: "Choose which imported headline to use.",
              severity: "recommended",
              status: "pending",
              proposedValue: "Senior Software Engineer",
              sourceSnippet: "Senior Software Engineer",
              sourceCandidateId: reviewCandidateId,
              sourceRunId: latestRunId,
              createdAt: "2026-04-12T09:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
        resumeImportRuns: [
          {
            id: latestRunId,
            sourceResumeId: "resume_conflict_choice",
            sourceResumeFileName: seed.profile.baseResume.fileName,
            trigger: "import",
            status: "review_ready",
            startedAt: "2026-04-12T08:50:00.000Z",
            completedAt: "2026-04-12T08:55:00.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            visionProviderKind: "deterministic",
            visionProviderLabel: "Test vision",
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
            id: reviewCandidateId,
            runId: latestRunId,
            target: {
              section: "identity",
              key: "headline",
              recordId: null,
            },
            label: "Headline",
            sourceKind: "model_identity_summary",
            value: "Senior Software Engineer",
            normalizedValue: null,
            valuePreview: "Senior Software Engineer",
            evidenceText: "Senior Software Engineer",
            sourceBlockIds: ["page_1_block_2"],
            confidence: 0.86,
            confidenceBreakdown: {
              overall: 0.86,
              parserQuality: 0.9,
              evidenceQuality: 0.84,
              agreementScore: 0.5,
              normalizationRisk: 0.08,
              conflictRisk: 0.45,
              fieldSensitivity: "medium",
              recommendation: "needs_review",
            },
            notes: [],
            alternatives: ["Staff Platform Engineer"],
            conflictChoices: [
              {
                id: "choice_document_text",
                label: "Headline",
                sourceLabel: "Document text",
                value: "Senior Software Engineer",
                valuePreview: "Senior Software Engineer",
                evidenceText: "Senior Software Engineer",
                confidence: 0.86,
                recommended: true,
                notes: [],
                sourceCandidateIds: [reviewCandidateId],
                visualEvidence: [],
              },
              {
                id: "choice_visual_scan",
                label: "Headline",
                sourceLabel: "Visual scan",
                value: "Staff Platform Engineer",
                valuePreview: "Staff Platform Engineer",
                evidenceText: "Staff Platform Engineer",
                confidence: 0.8,
                recommended: false,
                notes: [],
                sourceCandidateIds: ["candidate_visual_headline"],
                visualEvidence: [
                  {
                    branch: "vision",
                    sourceFileKind: "pdf",
                    pageNumber: 1,
                    regionHint: "top headline",
                    confidence: 0.8,
                    uncertaintyNotes: [],
                  },
                ],
              },
            ],
            visualEvidence: [],
            resolution: "needs_review",
            resolutionReason: "text_vs_visual_conflict_requires_review",
            createdAt: "2026-04-12T08:52:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    });

    await workspaceService.applyProfileSetupReviewAction(
      "review_headline_conflict_choice",
      "confirm",
      { selectedConflictChoiceId: "choice_visual_scan" },
    );

    const [profile, latestRun] = await Promise.all([
      repository.getProfile(),
      repository.getLatestResumeImportRun(),
    ]);
    const latestCandidates = await repository.listResumeImportFieldCandidates({
      runId: latestRun?.id ?? "",
    });

    expect(profile.headline).toBe("Staff Platform Engineer");
    expect(latestCandidates[0]).toEqual(
      expect.objectContaining({
        value: "Staff Platform Engineer",
        valuePreview: "Staff Platform Engineer",
        resolution: "auto_applied",
        resolutionReason: "review_confirmed",
      }),
    );
    expect(
      latestCandidates[0]?.conflictChoices?.find(
        (choice) => choice.id === "choice_visual_scan",
      )?.recommended,
    ).toBe(true);
    expect(latestCandidates[0]?.visualEvidence?.[0]?.regionHint).toBe(
      "top headline",
    );
  });

  test("confirming a recommended document-text conflict can complete an otherwise auto-applied import", async () => {
    const seed = createSeed();
    const latestRunId = "resume_import_run_full_name_conflict";
    const reviewCandidateId = "candidate_full_name_conflict";
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          id: "candidate_fresh_start",
          firstName: "New",
          lastName: "Candidate",
          middleName: null,
          fullName: "New Candidate",
          headline: "Senior Software Engineer",
          baseResume: {
            ...seed.profile.baseResume,
            id: "resume_full_name_conflict",
          },
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_full_name_conflict",
              step: "essentials",
              target: {
                domain: "identity",
                key: "fullName",
                recordId: null,
              },
              label: "Full name",
              reason: "Choose which imported full name to use.",
              severity: "recommended",
              status: "pending",
              proposedValue: "Owen Mercer",
              sourceSnippet: "Owen Mercer",
              sourceCandidateId: reviewCandidateId,
              sourceRunId: latestRunId,
              createdAt: "2026-04-12T09:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
        resumeImportRuns: [
          {
            id: latestRunId,
            sourceResumeId: "resume_full_name_conflict",
            sourceResumeFileName: seed.profile.baseResume.fileName,
            trigger: "import",
            status: "review_ready",
            startedAt: "2026-04-12T08:50:00.000Z",
            completedAt: "2026-04-12T08:55:00.000Z",
            primaryParserKind: "local_pdf_layout",
            parserKinds: ["local_pdf_layout"],
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            visionProviderKind: "openai_compatible_vision",
            visionProviderLabel: "Resume visual scan",
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
            id: reviewCandidateId,
            runId: latestRunId,
            target: {
              section: "identity",
              key: "fullName",
              recordId: null,
            },
            label: "Full name",
            sourceKind: "parser_literal",
            value: "Owen Mercer",
            normalizedValue: null,
            valuePreview: "Owen Mercer",
            evidenceText: "Owen Mercer",
            sourceBlockIds: ["block_name"],
            confidence: 0.99,
            confidenceBreakdown: {
              overall: 0.97,
              parserQuality: 0.95,
              evidenceQuality: 0.96,
              agreementScore: 0.5,
              normalizationRisk: 0.03,
              conflictRisk: 0.45,
              fieldSensitivity: "medium",
              recommendation: "auto_apply",
            },
            notes: [
              "Different values were found in document text and visual scan. Review the alternatives before accepting.",
            ],
            alternatives: ["Senior Software Engineer"],
            conflictChoices: [
              {
                id: "choice_document_text",
                label: "Full name",
                sourceLabel: "Document text",
                value: "Owen Mercer",
                valuePreview: "Owen Mercer",
                evidenceText: "Owen Mercer",
                confidence: 0.97,
                recommended: true,
                notes: [],
                sourceCandidateIds: [reviewCandidateId],
                visualEvidence: [],
              },
              {
                id: "choice_visual_scan",
                label: "Full name",
                sourceLabel: "Visual scan",
                value: "Senior Software Engineer",
                valuePreview: "Senior Software Engineer",
                evidenceText: "Senior Software Engineer",
                confidence: 0.72,
                recommended: false,
                notes: [],
                sourceCandidateIds: ["candidate_visual_full_name"],
                visualEvidence: [
                  {
                    branch: "vision",
                    sourceFileKind: "pdf",
                    pageNumber: 1,
                    regionHint: "top headline",
                    confidence: 0.72,
                    uncertaintyNotes: [],
                  },
                ],
              },
            ],
            visualEvidence: [],
            resolution: "needs_review",
            resolutionReason: "text_vs_visual_conflict_requires_review",
            createdAt: "2026-04-12T08:52:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    });

    await workspaceService.applyProfileSetupReviewAction(
      "review_full_name_conflict",
      "confirm",
      { selectedConflictChoiceId: "choice_document_text" },
    );

    const [profile, latestRun, latestCandidates] = await Promise.all([
      repository.getProfile(),
      repository.getLatestResumeImportRun(),
      repository.listResumeImportFieldCandidates({ runId: latestRunId }),
    ]);

    expect(profile.fullName).toBe("Owen Mercer");
    expect(profile.firstName).toBe("Owen");
    expect(profile.lastName).toBe("Mercer");
    expect(latestRun?.status).toBe("applied");
    expect(latestRun?.candidateCounts).toMatchObject({
      autoApplied: 1,
      needsReview: 0,
    });
    expect(latestCandidates[0]).toEqual(
      expect.objectContaining({
        value: "Owen Mercer",
        resolution: "auto_applied",
        resolutionReason: "review_confirmed",
      }),
    );
  });

  test("does not reopen resolved review items when saveProfileSetupState receives a stale payload", async () => {
    const seed = createSeed();
    const latestRunId = "resume_import_run_stale_setup_state";
    const reviewCandidateId = "candidate_headline_stale_setup_state";
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          headline: "Senior systems designer",
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_headline_stale_setup_state",
              step: "essentials",
              target: {
                domain: "identity",
                key: "headline",
                recordId: null,
              },
              label: "Headline",
              reason: "Confirm the imported headline before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: "Principal Product Designer",
              sourceSnippet: "Principal Product Designer",
              sourceCandidateId: reviewCandidateId,
              sourceRunId: latestRunId,
              createdAt: "2026-04-12T09:00:00.000Z",
              resolvedAt: null,
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
            startedAt: "2026-04-12T08:50:00.000Z",
            completedAt: "2026-04-12T08:55:00.000Z",
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
            id: reviewCandidateId,
            runId: latestRunId,
            target: {
              section: "identity",
              key: "headline",
              recordId: null,
            },
            label: "Headline",
            sourceKind: "model_identity_summary",
            value: "Principal Product Designer",
            normalizedValue: null,
            valuePreview: "Principal Product Designer",
            evidenceText: "Principal Product Designer",
            sourceBlockIds: [],
            confidence: 0.82,
            confidenceBreakdown: {
              overall: 0.82,
              parserQuality: 0.9,
              evidenceQuality: 0.84,
              agreementScore: 0.8,
              normalizationRisk: 0.06,
              conflictRisk: 0.16,
              fieldSensitivity: "medium",
              recommendation: "needs_review",
            },
            notes: [],
            alternatives: [],
            resolution: "needs_review",
            resolutionReason: null,
            createdAt: "2026-04-12T08:52:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    });

    const staleSnapshot = await workspaceService.getWorkspaceSnapshot();

    await workspaceService.applyProfileSetupReviewAction(
      "review_headline_stale_setup_state",
      "dismiss",
    );

    const updatedSnapshot = await workspaceService.saveProfileSetupState({
      ...staleSnapshot.profileSetupState,
      currentStep: "background",
      lastResumedAt: "2026-04-12T09:10:00.000Z",
    });

    const resolvedItem = updatedSnapshot.profileSetupState.reviewItems.find(
      (item) => item.id === "review_headline_stale_setup_state",
    );

    expect(updatedSnapshot.profileSetupState.currentStep).toBe("background");
    expect(resolvedItem?.status).toBe("dismissed");
  });

  test("keeps import-backed setup review items pending across step switches until the user resolves them", async () => {
    const seed = createSeed();
    const latestRunId = "resume_import_run_keep_pending";
    const reviewCandidateId = "candidate_headline_keep_pending";
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          headline: "Senior systems designer",
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_headline_keep_pending",
              step: "essentials",
              target: {
                domain: "identity",
                key: "headline",
                recordId: null,
              },
              label: "Headline",
              reason: "Confirm the imported headline before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: "Principal Product Designer",
              sourceSnippet: "Principal Product Designer",
              sourceCandidateId: reviewCandidateId,
              sourceRunId: latestRunId,
              createdAt: "2026-04-12T09:00:00.000Z",
              resolvedAt: null,
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
            startedAt: "2026-04-12T08:50:00.000Z",
            completedAt: "2026-04-12T08:55:00.000Z",
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
            id: reviewCandidateId,
            runId: latestRunId,
            target: {
              section: "identity",
              key: "headline",
              recordId: null,
            },
            label: "Headline",
            sourceKind: "model_identity_summary",
            value: "Principal Product Designer",
            normalizedValue: null,
            valuePreview: "Principal Product Designer",
            evidenceText: "Principal Product Designer",
            sourceBlockIds: [],
            confidence: 0.82,
            confidenceBreakdown: {
              overall: 0.82,
              parserQuality: 0.9,
              evidenceQuality: 0.84,
              agreementScore: 0.8,
              normalizationRisk: 0.06,
              conflictRisk: 0.16,
              fieldSensitivity: "medium",
              recommendation: "needs_review",
            },
            notes: [],
            alternatives: [],
            resolution: "needs_review",
            resolutionReason: null,
            createdAt: "2026-04-12T08:52:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    });

    await workspaceService.saveProfileSetupState({
      status: "in_progress",
      currentStep: "background",
      completedAt: null,
      reviewItems: [],
      lastResumedAt: "2026-04-12T09:10:00.000Z",
    });

    const updatedSnapshot = await workspaceService.saveProfileSetupState({
      status: "in_progress",
      currentStep: "essentials",
      completedAt: null,
      reviewItems: [],
      lastResumedAt: "2026-04-12T09:12:00.000Z",
    });

    const reviewItem = updatedSnapshot.profileSetupState.reviewItems.find(
      (item) => item.id === "review_headline_keep_pending",
    );

    expect(reviewItem?.status).toBe("pending");
    expect(reviewItem?.sourceCandidateId).toBe(reviewCandidateId);
    expect(updatedSnapshot.profileSetupState.currentStep).toBe("essentials");
  });

  test("marks pending setup review items as edited after an explicit save changes the target value", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          yearsExperience: 6,
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_years_experience_save",
              step: "essentials",
              target: {
                domain: "identity",
                key: "yearsExperience",
                recordId: null,
              },
              label: "Years of experience",
              reason:
                "Confirm the imported experience total before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: "6",
              sourceSnippet: "6+ years of experience",
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-14T09:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.saveProfileAndSearchPreferences(
      {
        ...seed.profile,
        yearsExperience: 7,
      },
      seed.searchPreferences,
    );

    const reviewItem = snapshot.profileSetupState.reviewItems.find(
      (item) => item.id === "review_years_experience_save",
    );

    expect(snapshot.profile.yearsExperience).toBe(7);
    expect(reviewItem?.status).toBe("edited");
    expect(reviewItem?.resolvedAt).toBeTruthy();
  });

  test("persists and resolves an explicitly saved zero years value", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          yearsExperience: 0,
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_years_experience_zero",
              step: "essentials",
              target: {
                domain: "identity",
                key: "yearsExperience",
                recordId: null,
              },
              label: "Years of experience",
              reason:
                "Add your years of experience so setup has a grounded seniority signal.",
              severity: "recommended",
              status: "pending",
              proposedValue: null,
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-14T09:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.saveProfileAndSearchPreferences(
      {
        ...seed.profile,
        yearsExperience: 0,
      },
      seed.searchPreferences,
    );

    const reviewItem = snapshot.profileSetupState.reviewItems.find(
      (item) => item.id === "review_years_experience_zero",
    );

    expect(snapshot.profile.yearsExperience).toBe(0);
    expect(reviewItem?.status).toBe("edited");
    expect(reviewItem?.resolvedAt).toBeTruthy();
  });

  test("keeps placeholder identity values from resolving pending setup review items", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          headline: PROFILE_PLACEHOLDER_HEADLINE,
          currentLocation: PROFILE_PLACEHOLDER_LOCATION,
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_headline_placeholder",
              step: "essentials",
              target: {
                domain: "identity",
                key: "headline",
                recordId: null,
              },
              label: "Headline",
              reason: "Confirm the imported headline before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: null,
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-14T09:00:00.000Z",
              resolvedAt: null,
            },
            {
              id: "review_location_placeholder",
              step: "essentials",
              target: {
                domain: "identity",
                key: "currentLocation",
                recordId: null,
              },
              label: "Location",
              reason: "Confirm the imported location before setup is complete.",
              severity: "critical",
              status: "pending",
              proposedValue: null,
              sourceSnippet: null,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-14T09:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.saveProfileAndSearchPreferences(
      {
        ...seed.profile,
        headline: PROFILE_PLACEHOLDER_HEADLINE,
        currentLocation: PROFILE_PLACEHOLDER_LOCATION,
      },
      seed.searchPreferences,
    );

    expect(
      snapshot.profileSetupState.reviewItems.find(
        (item) => item.id === "review_headline_placeholder",
      )?.status,
    ).toBe("pending");
    expect(
      snapshot.profileSetupState.reviewItems.find(
        (item) => item.id === "review_location_placeholder",
      )?.status,
    ).toBe("pending");
  });

  test("does not allow clearing a years-of-experience review item to an invalid null value", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          yearsExperience: 6,
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_years_experience_clear",
              step: "essentials",
              target: {
                domain: "identity",
                key: "yearsExperience",
                recordId: null,
              },
              label: "Years of experience",
              reason:
                "Confirm the imported experience total before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: "12",
              sourceSnippet: "12 years of experience",
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-14T09:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
      },
    });

    await expect(
      workspaceService.applyProfileSetupReviewAction(
        "review_years_experience_clear",
        "clear_value",
      ),
    ).rejects.toThrow("Years of experience cannot be cleared");
  });

  test("clearing an identity review item persists null instead of a placeholder string", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_headline_clear",
              step: "essentials",
              target: {
                domain: "identity",
                key: "headline",
                recordId: null,
              },
              label: "Headline",
              reason: "Confirm the imported headline before setup is complete.",
              severity: "critical",
              status: "pending",
              proposedValue: seed.profile.headline,
              sourceSnippet: seed.profile.headline,
              sourceCandidateId: null,
              sourceRunId: null,
              createdAt: "2026-04-14T09:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.applyProfileSetupReviewAction(
      "review_headline_clear",
      "clear_value",
    );

    // The cleared identity fact stays empty; no instructional placeholder is
    // re-persisted as a candidate fact.
    expect(snapshot.profile.headline).toBeNull();
  });

  test("marks pending portfolio review items as confirmed after an explicit save matches the proposed value", async () => {
    const seed = createSeed();
    const latestRunId = "resume_import_run_portfolio_resolution";
    const reviewCandidateId = "candidate_portfolio_resolution";
    const currentProfile = {
      ...seed.profile,
      portfolioUrl: null,
      links: [],
      applicationIdentity: {
        ...seed.profile.applicationIdentity,
        preferredLinkIds: [],
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: currentProfile,
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_portfolio_resolution",
              step: "essentials",
              target: {
                domain: "identity",
                key: "portfolioUrl",
                recordId: null,
              },
              label: "Portfolio URL",
              reason:
                "Confirm the imported portfolio URL before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: "https://jamie.dev",
              sourceSnippet: "https://jamie.dev",
              sourceCandidateId: reviewCandidateId,
              sourceRunId: latestRunId,
              createdAt: "2026-04-14T09:00:00.000Z",
              resolvedAt: null,
            },
          ],
          lastResumedAt: null,
        },
        resumeImportRuns: [
          {
            id: latestRunId,
            sourceResumeId: currentProfile.baseResume.id,
            sourceResumeFileName: currentProfile.baseResume.fileName,
            trigger: "refresh",
            status: "review_ready",
            startedAt: "2026-04-14T08:50:00.000Z",
            completedAt: "2026-04-14T08:55:00.000Z",
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
            id: reviewCandidateId,
            runId: latestRunId,
            target: {
              section: "contact",
              key: "portfolioUrl",
              recordId: null,
            },
            label: "Portfolio URL",
            sourceKind: "parser_literal",
            value: "https://jamie.dev",
            normalizedValue: null,
            valuePreview: "https://jamie.dev",
            evidenceText: "https://jamie.dev",
            sourceBlockIds: [],
            confidence: 0.92,
            confidenceBreakdown: {
              overall: 0.92,
              parserQuality: 0.96,
              evidenceQuality: 0.94,
              agreementScore: 0.9,
              normalizationRisk: 0.04,
              conflictRisk: 0.08,
              fieldSensitivity: "medium",
              recommendation: "needs_review",
            },
            notes: [],
            alternatives: [],
            resolution: "needs_review",
            resolutionReason: null,
            createdAt: "2026-04-14T08:52:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    });

    const snapshot = await workspaceService.saveProfileAndSearchPreferences(
      {
        ...currentProfile,
        portfolioUrl: "https://jamie.dev",
      },
      seed.searchPreferences,
    );
    const run = await repository.getLatestResumeImportRun();
    const candidates = await repository.listResumeImportFieldCandidates({
      runId: latestRunId,
    });
    const reviewItem = snapshot.profileSetupState.reviewItems.find(
      (item) => item.id === "review_portfolio_resolution",
    );

    expect(snapshot.profile.portfolioUrl).toBe("https://jamie.dev");
    expect(reviewItem?.status).toBe("confirmed");
    expect(reviewItem?.resolvedAt).toBeTruthy();
    expect(run?.status).toBe("applied");
    expect(candidates[0]).toEqual(
      expect.objectContaining({
        resolution: "auto_applied",
        resolutionReason: "review_confirmed",
      }),
    );
  });

  test("assistant-applied profile edits persist setup review resolution semantics on the saved snapshot", async () => {
    const seed = createSeed();
    const latestRunId = "resume_import_run_assistant_resolution";
    const reviewCandidateId = "candidate_headline_assistant_resolution";
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          headline: "Senior systems designer",
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "essentials",
          completedAt: null,
          reviewItems: [
            {
              id: "review_headline_assistant_resolution",
              step: "essentials",
              target: {
                domain: "identity",
                key: "headline",
                recordId: null,
              },
              label: "Headline",
              reason: "Confirm the imported headline before setup is complete.",
              severity: "recommended",
              status: "pending",
              proposedValue: "Principal Product Designer",
              sourceSnippet: "Principal Product Designer",
              sourceCandidateId: reviewCandidateId,
              sourceRunId: latestRunId,
              createdAt: "2026-04-12T09:00:00.000Z",
              resolvedAt: null,
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
            startedAt: "2026-04-12T08:50:00.000Z",
            completedAt: "2026-04-12T08:55:00.000Z",
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
            id: reviewCandidateId,
            runId: latestRunId,
            target: {
              section: "identity",
              key: "headline",
              recordId: null,
            },
            label: "Headline",
            sourceKind: "model_identity_summary",
            value: "Principal Product Designer",
            normalizedValue: null,
            valuePreview: "Principal Product Designer",
            evidenceText: "Principal Product Designer",
            sourceBlockIds: [],
            confidence: 0.82,
            confidenceBreakdown: {
              overall: 0.82,
              parserQuality: 0.9,
              evidenceQuality: 0.84,
              agreementScore: 0.8,
              normalizationRisk: 0.06,
              conflictRisk: 0.16,
              fieldSensitivity: "medium",
              recommendation: "needs_review",
            },
            notes: [],
            alternatives: [],
            resolution: "needs_review",
            resolutionReason: null,
            createdAt: "2026-04-12T08:52:00.000Z",
            resolvedAt: null,
          },
        ],
      },
    });

    const snapshot = await workspaceService.sendProfileCopilotMessage(
      'Update my headline to "Principal Product Designer"',
      {
        surface: "setup",
        step: "essentials",
      },
    );

    const resolvedItem = snapshot.profileSetupState.reviewItems.find(
      (item) => item.id === "review_headline_assistant_resolution",
    );

    expect(snapshot.profile.headline).toBe("Principal Product Designer");
    expect(resolvedItem?.status).toBe("confirmed");
    expect(resolvedItem?.resolvedAt).toBeTruthy();
  });

  test("turns an orphaned deferred vision branch into truthful restart guidance", async () => {
    const seed = createSeed();
    const runId = "resume_import_interrupted_vision";
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profile: {
          ...seed.profile,
          baseResume: {
            ...seed.profile.baseResume,
            analysisWarnings: [
              "Visual scan is still running after text import completed; text import is ready and visual reconciliation will continue in the background until the 600000ms vision provider deadline.",
              "Preferred locations",
            ],
          },
        },
        resumeImportRuns: [
          {
            id: runId,
            sourceResumeId: seed.profile.baseResume.id,
            sourceResumeFileName: seed.profile.baseResume.fileName,
            trigger: "import",
            status: "applied",
            startedAt: "2026-07-31T10:00:00.000Z",
            completedAt: "2026-07-31T10:00:05.000Z",
            primaryParserKind: "plain_text",
            parserKinds: ["plain_text"],
            analysisProviderKind: "deterministic",
            analysisProviderLabel: "Test AI",
            warnings: [
              "Visual scan is still running. Your text import is ready, and visual reconciliation will continue in the background for up to 10 minutes.",
            ],
            errorMessage: null,
            candidateCounts: {
              total: 0,
              autoApplied: 0,
              needsReview: 0,
              rejected: 0,
              abstained: 0,
            },
            modelRoles: ResumeImportModelRoleStateSchema.parse({
              vision: {
                status: "running",
                startedAt: "2026-07-31T10:00:01.000Z",
                completedAt: null,
                providerKind: "openai_compatible_vision",
                providerLabel: "Resume visual scan",
                warning:
                  "Visual scan is still running. Your text import is ready, and visual reconciliation will continue in the background for up to 10 minutes.",
                errorMessage: null,
                timeoutMs: 600_000,
                candidateCount: 0,
              },
            }),
          },
        ],
      },
    });

    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const persistedRun = await repository.getLatestResumeImportRun();

    expect(snapshot.latestResumeImportRun?.modelRoles?.vision.status).toBe(
      "failed",
    );
    expect(persistedRun?.modelRoles?.vision.status).toBe("failed");
    expect(persistedRun?.warnings).toEqual([
      "Visual scan stopped when the app closed. Your text import is ready; choose Refresh from resume to retry the visual scan.",
    ]);
    expect(snapshot.profile.baseResume.analysisWarnings).toEqual([
      "Preferred locations",
    ]);
  });
});
