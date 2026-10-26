import { describe, expect, test } from "vitest";
import {
  JobFinderApplyConsentActionInputSchema,
  JobFinderApplyCopilotActionInputSchema,
  JobFinderApplyQueueActionInputSchema,
  ApplyRunSchema,
  JobFinderApplyRunActionInputSchema,
  JobFinderApplyRunDetailsQuerySchema,
  JobFinderAgentDiscoveryOutcomeSchema,
  JobFinderAgentDiscoveryResultSchema,
  JobFinderOpenBrowserSessionInputSchema,
  JobFinderJobResumeApplicationModeInputSchema,
  ApplyJobResultSchema,
  ApplicationAttemptSchema,
  JobFinderWorkspaceSnapshotSchema,
  JobSearchCampaignSchema,
  getDefaultCampaignConfiguration,
  JobFinderDashboardSummarySchema,
  UpdateApplicationDefaultsInputSchema,
} from "./index";
import { createApplyRunFixture, createSubmittedAttempt } from "./test-fixtures";

describe("contracts workspace snapshot schema", () => {
  test("the Apply setting accepts fill or send and rejects the engine-only prepare capability", () => {
    for (const mode of ["confirm_before_submit", "autonomous_submit"]) {
      expect(
        UpdateApplicationDefaultsInputSchema.parse({
          applicationAutomationMode: mode,
        }).applicationAutomationMode,
      ).toBe(mode);
    }
    expect(() =>
      UpdateApplicationDefaultsInputSchema.parse({
        applicationAutomationMode: "prepare_only",
      }),
    ).toThrow();
  });
  test("parses a dashboard summary with no daily preparation capacity", () => {
    const base = {
      generatedAt: "2026-03-20T10:05:00.000Z",
      activeCampaignId: "campaign-test",
      activeCampaignCount: 1,
      jobsFoundToday: 0,
      jobsAwaitingReview: 0,
      applicationsReadyForApproval: 0,
      applicationsAppliedToday: 0,
      applicationsAppliedThisWeek: 0,
      needsYouCount: 0,
      upcomingInterviews: 0,
      upcomingFollowUps: 0,
      responseRate: null,
      interviewRate: null,
      sourceHealth: { healthy: 0, needsAttention: 0, running: 0, total: 0 },
      backgroundOperationCount: 0,
      recommendedNextAction: {
        label: "Find jobs",
        detail: "Start the active campaign.",
        route: "/job-finder/discovery",
      },
    };

    expect(
      JobFinderDashboardSummarySchema.safeParse({
        ...base,
      }).success,
    ).toBe(true);
  });
  test("parses a per-job CV mode selection", () => {
    expect(
      JobFinderJobResumeApplicationModeInputSchema.parse({
        jobId: "job-1",
        resumeApplicationMode: "original_resume",
      }),
    ).toEqual({
      jobId: "job-1",
      resumeApplicationMode: "original_resume",
    });
  });

  test("parses a job finder workspace snapshot", () => {
    const attempt = ApplicationAttemptSchema.parse(createSubmittedAttempt());
    const applyRun = ApplyRunSchema.parse(createApplyRunFixture());
    const visualEvidence = {
      snapshotId: "visual_snapshot_apply_1",
      observationSetId: "visual_observation_apply_1",
      summary: "Visible submission control stayed disabled before review.",
      capturedAt: "2026-03-20T10:03:00.000Z",
      storagePath: null,
      retention: "temporary" as const,
      redactionLevel: "sensitive" as const,
      confidence: 0.73,
      reconciliationStatus: "not_compared" as const,
    };
    const applyJobResult = ApplyJobResultSchema.parse({
      id: "apply_result_1",
      runId: applyRun.id,
      jobId: "job_1",
      queuePosition: 0,
      state: "awaiting_review",
      summary: "Prepared for review.",
      detail: "Visual checkpoint was captured before final submit.",
      startedAt: "2026-03-20T10:02:00.000Z",
      updatedAt: "2026-03-20T10:03:00.000Z",
      completedAt: null,
      blockerReason: null,
      blockerSummary: null,
      visualObservationSets: [
        {
          id: visualEvidence.observationSetId,
          snapshotId: visualEvidence.snapshotId,
          observedAt: visualEvidence.capturedAt,
          url: "https://jobs.example.com/roles/target_job_1/apply",
          purpose: "apply_checkpoint",
          providerKind: "deterministic",
          providerLabel: "Deterministic browser visual analysis",
          summary: visualEvidence.summary,
          blockers: [],
          visibleControls: [],
          jobCardClues: [],
          applyPathClues: [],
          fieldControls: ["Resume upload control is visible."],
          validationErrors: [],
          buttonStates: ["Submission control appears disabled."],
          questionContexts: [],
          recoveryNotes: [],
          uncertainty: [],
          observations: [],
          reconciliations: [],
          rejectedOutputReasons: [],
        },
      ],
      visualCheckpoints: [
        {
          id: "apply_visual_checkpoint_1",
          label: "Apply page visual checkpoint",
          purpose: "apply_checkpoint",
          snapshotId: visualEvidence.snapshotId,
          observationSetId: visualEvidence.observationSetId,
          summary: visualEvidence.summary,
          capturedAt: visualEvidence.capturedAt,
          retained: false,
          storagePath: null,
          blockers: [],
          fieldControls: ["Resume upload control is visible."],
          validationErrors: [],
          buttonStates: ["Submission control appears disabled."],
          questionContextIds: [],
          reconciliations: [],
        },
      ],
      latestQuestionCount: 0,
      latestAnswerCount: 0,
      pendingConsentRequestCount: 0,
      artifactCount: 0,
      latestCheckpointId: null,
    });

    const generatedAt = "2026-03-20T10:05:00.000Z";
    const campaign = JobSearchCampaignSchema.parse({
      id: "campaign-test",
      name: "Test campaign",
      mode: "precision",
      status: "active",
      createdAt: generatedAt,
      updatedAt: generatedAt,
      searchPreferences: {
        minimumSalaryUsd: null,
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
      },
      sourceTargetIds: [],
      ...getDefaultCampaignConfiguration("precision"),
      progress: { lastUpdatedAt: generatedAt },
    });
    const workspace = JobFinderWorkspaceSnapshotSchema.parse({
      module: "job-finder",
      generatedAt,
      agentProvider: {
        kind: "deterministic",
        ready: true,
        label: "Built-in deterministic agent fallback",
        model: null,
        baseUrl: null,
        detail: "Tests",
      },
      availableResumeTemplates: [
        {
          id: "classic_ats",
          label: "Chronology Classic",
          familyId: "chronology_classic",
          familyLabel: "Chronology Classic",
          familyDescription: "Calm ATS-safe layouts.",
          variantLabel: "Recruiter Standard",
          description:
            "Single-column, conservative, and recruiter-friendly for high parsing reliability.",
          fitSummary: "A clean all-rounder.",
          avoidSummary: "Less distinctive for project-led portfolios.",
          bestFor: ["General applications", "Recruiter-heavy funnels"],
          visualTags: ["Minimal", "Balanced"],
          density: "balanced",
          deliveryLane: "apply_safe",
          atsConfidence: "high",
          applyEligible: true,
          approvalEligible: true,
          benchmarkEligible: true,
          sortOrder: 10,
        },
      ],
      campaigns: [campaign],
      activeCampaignId: campaign.id,
      dashboard: {
        generatedAt,
        activeCampaignId: campaign.id,
        activeCampaignCount: 1,
        jobsFoundToday: 0,
        jobsAwaitingReview: 0,
        applicationsReadyForApproval: 0,
        applicationsAppliedToday: 0,
        applicationsAppliedThisWeek: 0,
        needsYouCount: 0,
        upcomingInterviews: 0,
        upcomingFollowUps: 0,
        responseRate: null,
        interviewRate: null,
        sourceHealth: {
          healthy: 0,
          needsAttention: 0,
          running: 0,
          total: 0,
        },
        backgroundOperationCount: 0,
        recommendedNextAction: {
          label: "Find jobs",
          detail: "Start the active campaign.",
          route: "/job-finder/discovery",
        },
      },
      profile: {
        id: "candidate_1",
        firstName: "Alex",
        lastName: "Vanguard",
        middleName: null,
        fullName: "Alex Vanguard",
        headline: "Senior systems designer",
        summary: "Builds resilient workflows.",
        currentLocation: "London, UK",
        yearsExperience: 10,
        email: "alex@example.com",
        phone: null,
        portfolioUrl: null,
        linkedinUrl: null,
        baseResume: {
          id: "resume_1",
          fileName: "alex-vanguard.pdf",
          uploadedAt: "2026-03-20T10:00:00.000Z",
          storagePath: "/tmp/alex-vanguard.pdf",
          textContent: "Resume text",
          textUpdatedAt: "2026-03-20T10:00:00.000Z",
          extractionStatus: "ready",
          lastAnalyzedAt: "2026-03-20T10:01:00.000Z",
          analysisProviderKind: null,
          analysisProviderLabel: null,
          analysisWarnings: [],
        },
        targetRoles: ["Principal Designer"],
        locations: ["Remote"],
        skills: ["Figma", "React"],
        experiences: [
          {
            id: "experience_1",
            companyName: "Signal Systems",
            companyUrl: null,
            title: "Senior Product Designer",
            employmentType: "Full-time",
            location: "London, UK",
            workMode: "hybrid",
            startDate: "2021-01",
            endDate: null,
            isCurrent: true,
            summary: "Owns workflow tooling and design systems.",
            achievements: ["Improved designer-engineer handoff quality"],
            skills: ["Figma", "Design Systems"],
            domainTags: [],
            peopleManagementScope: null,
            ownershipScope: null,
          },
        ],
        education: [
          {
            id: "education_1",
            schoolName: "University of the Arts London",
            degree: "BA",
            fieldOfStudy: "Interaction Design",
            location: "London, UK",
            startDate: "2010-09",
            endDate: "2013-06",
            summary: null,
          },
        ],
        certifications: [
          {
            id: "certification_1",
            name: "UX Certification",
            issuer: "NN/g",
            issueDate: "2020-04",
            expiryDate: null,
            credentialUrl: null,
          },
        ],
        links: [
          {
            id: "link_1",
            label: "Portfolio",
            url: "https://alex.example.com",
            kind: "portfolio",
          },
        ],
        projects: [],
        spokenLanguages: [],
      },
      searchPreferences: {
        targetRoles: ["Principal Designer"],
        jobFamilies: [],
        locations: ["Remote"],
        excludedLocations: [],
        workModes: ["remote"],
        seniorityLevels: ["senior"],
        targetIndustries: [],
        targetCompanyStages: [],
        employmentTypes: [],
        minimumSalaryUsd: 170000,
        targetSalaryUsd: null,
        salaryCurrency: "USD",
        approvalMode: "review_before_submit",
        tailoringMode: "balanced",
        companyBlacklist: [],
        companyWhitelist: [],
      },
      profileSetupState: {
        status: "completed",
        currentStep: "ready_check",
        completedAt: "2026-03-20T10:03:00.000Z",
        reviewItems: [],
        lastResumedAt: null,
      },
      profileCopilotMessages: [
        {
          id: "profile_message_1",
          role: "assistant",
          content: "I suggested a tighter headline and proof point.",
          context: { surface: "profile", section: "basics" },
          patchGroups: [],
          createdAt: "2026-03-20T10:03:30.000Z",
        },
      ],
      profileRevisions: [
        {
          id: "profile_revision_1",
          createdAt: "2026-03-20T10:03:45.000Z",
          reason: "Assistant request: tighten headline",
          trigger: "assistant_patch",
          messageId: "profile_message_1",
          patchGroupId: "profile_patch_group_1",
          restoredFromRevisionId: null,
        },
      ],
      browserSession: {
        source: "target_site",
        status: "ready",
        driver: "catalog_seed",
        label: "Browser session ready",
        detail: "Validated recently.",
        lastCheckedAt: "2026-03-20T10:04:00.000Z",
      },
      sourceAccessPrompts: [
        {
          targetId: "target_1",
          targetLabel: "KosovaJob",
          targetUrl: "https://kosovajob.com/",
          state: "prompt_login_required",
          summary: "Sign in before the next search can continue.",
          detail: "Please sign in first.",
          actionLabel: "Sign in to KosovaJob",
          rerunLabel: "Search again after sign-in",
          updatedAt: "2026-03-20T10:01:00.000Z",
        },
      ],
      discoveryJobs: [
        {
          id: "job_1",
          source: "target_site",
          sourceJobId: "target_job_1",
          discoveryMethod: "catalog_seed",
          canonicalUrl: "https://jobs.example.com/roles/target_job_1",
          title: "Senior Product Designer",
          company: "Signal Systems",
          location: "Remote",
          workMode: "remote",
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          postedAtText: null,
          discoveredAt: "2026-03-20T10:01:00.000Z",
          salaryText: "$180k - $220k",
          summary: "Own the design system.",
          description: "Own the design system and workflow platform.",
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
          benefits: [],
          status: "ready_for_review",
          matchAssessment: {
            score: 96,
            reasons: ["Strong product design overlap"],
            gaps: [],
          },
        },
      ],
      activeSourceDebugRun: {
        id: "source_debug_run_1",
        targetId: "target_1",
        state: "paused_manual",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:01:00.000Z",
        completedAt: "2026-03-20T10:01:00.000Z",
        activePhase: "access_auth_probe",
        phases: [
          "access_auth_probe",
          "site_structure_mapping",
          "search_filter_probe",
          "job_detail_validation",
          "apply_path_validation",
          "replay_verification",
        ],
        targetLabel: "KosovaJob",
        targetUrl: "https://kosovajob.com/",
        targetHostname: "kosovajob.com",
        manualPrerequisiteSummary: "Please sign in first.",
        finalSummary: "Manual login is required before debugging can continue.",
        attemptIds: ["source_debug_attempt_1"],
        phaseSummaries: [],
        instructionArtifactId: null,
      },
      recentSourceDebugRuns: [],
      selectedDiscoveryJobId: "job_1",
      reviewQueue: [
        {
          jobId: "job_1",
          title: "Senior Product Designer",
          company: "Signal Systems",
          location: "Remote",
          matchScore: 96,
          applicationStatus: "ready_for_review",
          assetStatus: "ready",
          progressPercent: 100,
          resumeAssetId: "asset_1",
          resumeReview: {
            status: "approved",
            approvedAt: "2026-03-20T10:03:30.000Z",
            approvedExportId: "resume_export_1",
            approvedFormat: "pdf",
            approvedFilePath: "/tmp/alex-signal.pdf",
          },
          updatedAt: "2026-03-20T10:03:00.000Z",
        },
      ],
      selectedReviewJobId: "job_1",
      tailoredAssets: [
        {
          id: "asset_1",
          jobId: "job_1",
          kind: "resume",
          status: "ready",
          label: "Tailored Resume",
          version: "v1",
          templateName: "Chronology Classic",
          compatibilityScore: 98,
          progressPercent: 100,
          updatedAt: "2026-03-20T10:03:00.000Z",
          storagePath: null,
          contentText: "Tailored resume body",
          generationMethod: "ai_assisted",
          notes: ["Generated from stored resume text."],
          previewSections: [
            {
              heading: "Summary",
              lines: ["Lead cross-functional UX systems work."],
            },
          ],
        },
      ],
      resumeDrafts: [
        {
          id: "resume_draft_1",
          jobId: "job_1",
          status: "approved",
          templateId: "classic_ats",
          targetPageCount: 2,
          generationMethod: "ai",
          approvedAt: "2026-03-20T10:03:30.000Z",
          approvedExportId: "resume_export_1",
          staleReason: null,
          createdAt: "2026-03-20T10:02:00.000Z",
          updatedAt: "2026-03-20T10:03:30.000Z",
        },
      ],
      resumeExportArtifacts: [
        {
          id: "resume_export_1",
          draftId: "resume_draft_1",
          jobId: "job_1",
          format: "pdf",
          filePath: "/tmp/alex-signal.pdf",
          pageCount: 2,
          templateId: "classic_ats",
          exportedAt: "2026-03-20T10:03:10.000Z",
          isApproved: true,
        },
      ],
      resumeResearchArtifacts: [
        {
          id: "resume_research_1",
          jobId: "job_1",
          sourceUrl: "https://signalsystems.example.com/about",
          pageTitle: "About Signal Systems",
          fetchedAt: "2026-03-20T10:01:30.000Z",
          fetchStatus: "success",
          domainVocabulary: ["workflow platform"],
          priorityThemes: ["design systems"],
        },
      ],
      applyRuns: [applyRun],
      applyJobResults: [applyJobResult],
      applicationRecords: [
        {
          id: "application_1",
          jobId: "job_5",
          title: "Lead Product Designer",
          company: "Northwind Labs",
          status: "interview",
          lastActionLabel: "Technical screen scheduled",
          nextActionLabel: "Join meeting",
          lastUpdatedAt: "2026-03-20T10:04:00.000Z",
          lastAttemptState: "submitted",
          events: [
            {
              id: "event_1",
              at: "2026-03-20T10:04:00.000Z",
              title: "Technical screen scheduled",
              detail: "Interview confirmed for tomorrow.",
              emphasis: "positive",
            },
          ],
        },
      ],
      applicationAttempts: [attempt],
      selectedApplyRunId: "apply_run_1",
      selectedApplicationRecordId: "application_1",
      settings: {
        resumeFormat: "html",
        resumeTemplateId: "classic_ats",
        fontPreset: "inter_requisite",
        appearanceTheme: "system",
        humanReviewRequired: true,
        allowAutoSubmitOverride: false,
        keepSessionAlive: true,
      },
    });

    expect(workspace.discoveryJobs).toHaveLength(1);
    expect(workspace.companyJobs).toEqual([]);
    expect(workspace.profile.experiences[0]?.workMode).toEqual(["hybrid"]);
    expect(workspace.discoveryJobs[0]?.workMode).toEqual(["remote"]);
    expect(workspace.reviewQueue[0]?.assetStatus).toBe("ready");
    expect(workspace.activeSourceDebugRun?.state).toBe("paused_manual");
    expect(workspace.sourceAccessPrompts[0]?.state).toBe(
      "prompt_login_required",
    );
  });

  test("parses open-browser-session payloads with optional target scope", () => {
    expect(JobFinderOpenBrowserSessionInputSchema.parse({})).toEqual({
      targetId: null,
    });

    expect(
      JobFinderOpenBrowserSessionInputSchema.parse({
        targetId: "target_linkedin_default",
      }),
    ).toEqual({
      targetId: "target_linkedin_default",
    });
  });

  test("keeps the agent discovery outcome closed to completed or cancelled", () => {
    expect(JobFinderAgentDiscoveryOutcomeSchema.options).toEqual([
      "completed",
      "cancelled",
    ]);
    expect(
      JobFinderAgentDiscoveryOutcomeSchema.safeParse("failed").success,
    ).toBe(false);
    expect(
      JobFinderAgentDiscoveryOutcomeSchema.safeParse("running").success,
    ).toBe(false);
  });

  test("requires both outcome and snapshot on agent discovery results", () => {
    expect(
      JobFinderAgentDiscoveryResultSchema.safeParse({
        outcome: "completed",
      }).success,
    ).toBe(false);
    expect(
      JobFinderAgentDiscoveryResultSchema.safeParse({
        outcome: "failed",
        snapshot: {},
      }).success,
    ).toBe(false);
  });

  test("parses apply run details query payloads", () => {
    expect(
      JobFinderApplyRunDetailsQuerySchema.parse({
        runId: "apply_run_1",
        jobId: "job_1",
        applicationRecordId: "application_1",
      }),
    ).toEqual({
      runId: "apply_run_1",
      jobId: "job_1",
      applicationRecordId: "application_1",
    });

    expect(() =>
      JobFinderApplyRunDetailsQuerySchema.parse({
        runId: "apply_run_1",
        jobId: "job_1",
      }),
    ).toThrow();
  });

  test("parses apply run action payloads", () => {
    expect(
      JobFinderApplyRunActionInputSchema.parse({
        runId: "apply_run_1",
        jobId: "job_1",
        applicationRecordId: "application_1",
      }),
    ).toEqual({
      runId: "apply_run_1",
      jobId: "job_1",
      applicationRecordId: "application_1",
    });
  });

  test("parses apply copilot visual opt-in payloads", () => {
    expect(
      JobFinderApplyCopilotActionInputSchema.parse({
        jobId: "job_1",
      }),
    ).toEqual({
      jobId: "job_1",
      visualCheckpointsEnabled: false,
    });

    expect(
      JobFinderApplyCopilotActionInputSchema.parse({
        jobId: "job_1",
        visualCheckpointsEnabled: true,
      }),
    ).toEqual({
      jobId: "job_1",
      visualCheckpointsEnabled: true,
    });

    expect(
      JobFinderApplyCopilotActionInputSchema.parse({
        jobId: "job_1",
        startNewApplication: true,
      }),
    ).toMatchObject({
      jobId: "job_1",
      startNewApplication: true,
    });

    expect(() =>
      JobFinderApplyCopilotActionInputSchema.parse({
        jobId: "job_1",
        applicationRecordId: "application_1",
        startNewApplication: true,
      }),
    ).toThrow();
  });

  test("parses apply queue action payloads", () => {
    expect(
      JobFinderApplyQueueActionInputSchema.parse({
        jobIds: ["job_1", "job_2"],
        applicationAutomationMode: "confirm_before_submit",
      }),
    ).toEqual({
      jobIds: ["job_1", "job_2"],
      applicationAutomationMode: "confirm_before_submit",
    });
  });

  test("parses apply consent action payloads", () => {
    expect(
      JobFinderApplyConsentActionInputSchema.parse({
        requestId: "consent_1",
        runId: "apply_run_1",
        jobId: "job_1",
        applicationRecordId: "application_1",
        action: "approve",
      }),
    ).toEqual({
      requestId: "consent_1",
      runId: "apply_run_1",
      jobId: "job_1",
      applicationRecordId: "application_1",
      action: "approve",
    });

    expect(
      JobFinderApplyConsentActionInputSchema.parse({
        requestId: "consent_1",
        runId: "apply_run_1",
        jobId: "job_1",
        applicationRecordId: "application_1",
        action: "decline",
      }),
    ).toEqual({
      requestId: "consent_1",
      runId: "apply_run_1",
      jobId: "job_1",
      applicationRecordId: "application_1",
      action: "decline",
    });
  });
});
