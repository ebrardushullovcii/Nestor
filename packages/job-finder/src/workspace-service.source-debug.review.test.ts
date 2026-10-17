import {
  createDeterministicJobFinderAiClient,
  type JobFinderAiClient,
} from "@nestor/ai-providers";
import { describe, expect, test } from "vitest";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { createJobFinderWorkspaceService } from "./index";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createDocumentManager,
  createSeed,
  createSourceInstructionArtifact,
  createStrongSourceDebugFindingsByPhase,
  extractLatestUserPrompt,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("final source-instruction reviewer receives rich phase context and can override final curation", async () => {
    const repository = createInMemoryJobFinderRepository({
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
      resumeDrafts: [],
      resumeDraftRevisions: [],
      resumeExportArtifacts: [],
      resumeResearchArtifacts: [],
      resumeValidationResults: [],
      resumeAssistantMessages: [],
    });
    const reviewPrompts: string[] = [];
    const fallbackClient = createDeterministicJobFinderAiClient(
      "Tests use the deterministic fallback agent.",
    );
    const aiClient: JobFinderAiClient = {
      ...fallbackClient,
      chatWithTools(messages) {
        reviewPrompts.push(extractLatestUserPrompt(messages));
        return Promise.resolve({
          content: JSON.stringify({
            navigationGuidance: [
              "Use the curated recommendation collection before broader search.",
            ],
            searchGuidance: [
              "Use the keyword search box and visible location filter to change the result set reliably.",
            ],
            detailGuidance: [
              "Use same-host detail pages as the canonical source of job data.",
            ],
            applyGuidance: [
              "Use the on-site apply entry when the detail page exposes it.",
            ],
            warnings: [
              "Keep the source in draft if a future replay loses the collection route.",
            ],
          }),
          toolCalls: [],
        });
      },
    };
    const browserRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_review_case",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_review_case",
          title: "Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Reviewer context case.",
          description: "Reviewer context case.",
          keySkills: ["React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
        reviewTranscriptByPhase: {
          search_filter_probe: [
            "assistant: inspected the visible keyword search box and location filter",
            'tool call search_submit: {"success":true,"summary":"query changed results"}',
          ],
          replay_verification: [
            "assistant: replayed the same collection route and search flow",
            'tool call finish: {"success":true,"reason":"replay stayed stable"}',
          ],
        },
      },
    );
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime,
      aiClient,
      documentManager: createDocumentManager(),
    });

    await workspaceService.runSourceDebug("target_linkedin_default");
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);

    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain(
      "organize it into the final instruction artifact",
    );
    expect(reviewPrompts[0]).toContain(
      "full sequence of agent-led phase tests",
    );
    expect(reviewPrompts[0]).toContain("phaseTests");
    expect(reviewPrompts[0]).toContain("phaseGoal");
    expect(reviewPrompts[0]).toContain("successCriteria");
    expect(reviewPrompts[0]).toContain("2026-03-20T10:00:00.000Z");
    expect(reviewPrompts[0]).toContain(
      "assistant: inspected the visible keyword search box and location filter",
    );
    expect(reviewPrompts[0]).toContain("tool call finish");
    expect(reviewPrompts[0]).toContain("handoffCompaction");
    expect(latestArtifact?.navigationGuidance).toContain(
      "Use the curated recommendation collection before broader search.",
    );
    expect(latestArtifact?.warnings).toContain(
      "Keep the source in draft if a future replay loses the collection route.",
    );
    expect(latestArtifact?.intelligence?.collection).toBeDefined();
    expect(latestArtifact?.intelligence?.collection?.preferredMethod).toBe("listing_route");
    expect(latestArtifact?.intelligence?.collection?.startingRoutes.length).toBeGreaterThan(0);
  });

  test("skips the AI final reviewer when summary-first handoff still cannot fit the context budget", async () => {
    const repository = createInMemoryJobFinderRepository({
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
      resumeDrafts: [],
      resumeDraftRevisions: [],
      resumeExportArtifacts: [],
      resumeResearchArtifacts: [],
      resumeValidationResults: [],
      resumeAssistantMessages: [],
    });
    let reviewCallCount = 0;
    const fallbackClient = createDeterministicJobFinderAiClient(
      "Tests use the deterministic fallback agent.",
    );
    const aiClient: JobFinderAiClient = {
      ...fallbackClient,
      getStatus() {
        return {
          ...fallbackClient.getStatus(),
          modelContextWindowTokens: 200,
        };
      },
      chatWithTools() {
        reviewCallCount += 1;
        return Promise.resolve({
          content: JSON.stringify({
            navigationGuidance: ["This path should not run."],
            searchGuidance: [],
            detailGuidance: [],
            applyGuidance: [],
            warnings: [],
          }),
          toolCalls: [],
        });
      },
    };
    const browserRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_review_case_budget_exhausted",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_review_case_budget_exhausted",
          title: "Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Reviewer over-budget case.",
          description: "Reviewer over-budget case.",
          keySkills: ["React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
        reviewTranscriptByPhase: {
          search_filter_probe: Array.from({ length: 200 }, (_, index) =>
            `assistant: oversized transcript line ${index} with repeated evidence payload`,
          ),
          replay_verification: Array.from({ length: 200 }, (_, index) =>
            `assistant: oversized replay line ${index} with repeated verification payload`,
          ),
        },
      },
    );
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime,
      aiClient,
      documentManager: createDocumentManager(),
    });

    await workspaceService.runSourceDebug("target_linkedin_default");

    expect(reviewCallCount).toBe(0);
  });

  test("final source-instruction reviewer is told to write future-run instructions, and its lines stand as returned", async () => {
    const repository = createInMemoryJobFinderRepository({
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
      resumeDrafts: [],
      resumeDraftRevisions: [],
      resumeExportArtifacts: [],
      resumeResearchArtifacts: [],
      resumeValidationResults: [],
      resumeAssistantMessages: [],
    });
    const reviewPrompts: string[] = [];
    const fallbackClient = createDeterministicJobFinderAiClient(
      "Tests use the deterministic fallback agent.",
    );
    const aiClient: JobFinderAiClient = {
      ...fallbackClient,
      chatWithTools(messages) {
        reviewPrompts.push(extractLatestUserPrompt(messages));
        return Promise.resolve({
          content: JSON.stringify({
            ready: true,
            navigationGuidance: [
              "Use the show all collection route before broader search.",
            ],
            searchGuidance: [
              "Use the visible location filter to narrow the listings by city.",
            ],
            detailGuidance: [
              "Open same-host detail pages as the canonical source of job data.",
            ],
            applyGuidance: [
              "Use the on-site apply entry when the detail page exposes it.",
            ],
            warnings: [
              "Keep the source in draft if a future replay loses the collection route.",
            ],
          }),
          toolCalls: [],
        });
      },
    };
    const browserRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "source_debug_reviewer_noise_case",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://example.com/jobs/view/source_debug_reviewer_noise_case",
          title: "Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Reviewer noise cleanup case.",
          description: "Reviewer noise cleanup case.",
          keySkills: ["React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
        reviewTranscriptByPhase: {
          search_filter_probe: [
            "assistant: the visible location filter changes the result set",
            'tool call extract_jobs: {"success":true,"summary":"0 or 1 jobs extracted"}',
          ],
        },
      },
    );
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime,
      aiClient,
      documentManager: createDocumentManager(),
    });

    await workspaceService.runSourceDebug("target_linkedin_default");
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);
    const learnedLines = [
      ...(latestArtifact?.navigationGuidance ?? []),
      ...(latestArtifact?.searchGuidance ?? []),
      ...(latestArtifact?.detailGuidance ?? []),
      ...(latestArtifact?.applyGuidance ?? []),
      ...(latestArtifact?.warnings ?? []),
    ]
      .join("\n")
      .toLowerCase();

    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain(
      "reusable instructions for future discovery runs",
    );
    expect(reviewPrompts[0]).toContain("Never keep extracted-job counts");
    expect(learnedLines).toContain("show all collection route");
    expect(learnedLines).toContain("visible location filter");
    expect(learnedLines).toContain("same-host detail pages");
    expect(latestArtifact?.intelligence?.collection).toBeDefined();
    expect(latestArtifact?.intelligence?.collection?.preferredMethod).toBe("listing_route");
  });

  test("keeps timed-out partial evidence in draft and exposes completion metadata in run details", async () => {
    const repository = createInMemoryJobFinderRepository({
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
      resumeDrafts: [],
      resumeDraftRevisions: [],
      resumeExportArtifacts: [],
      resumeResearchArtifacts: [],
      resumeValidationResults: [],
      resumeAssistantMessages: [],
    });
    const browserRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_partial",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_partial",
          title: "Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "unknown",
          easyApplyEligible: false,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Partial evidence coverage.",
          description: "Partial evidence coverage.",
          keySkills: ["React"],
        },
      ],
      {
        debugFindingsByPhase: {
          access_auth_probe:
            createStrongSourceDebugFindingsByPhase().access_auth_probe ?? null,
          site_structure_mapping: {
            summary:
              "Show-all routes and recommendation collections were visible before timeout.",
            reliableControls: [
              "Show all top job picks route was visible on the jobs hub",
            ],
            trickyFilters: [],
            navigationTips: [
              "Recommendation collection route opened a reusable list surface",
            ],
            applyTips: [],
            warnings: [],
          },
          search_filter_probe: {
            summary:
              "Visible search and filter controls were observed before timeout.",
            reliableControls: [
              "Keyword search box was visible on the results surface",
            ],
            trickyFilters: [],
            navigationTips: [],
            applyTips: [],
            warnings: [],
          },
          job_detail_validation:
            createStrongSourceDebugFindingsByPhase().job_detail_validation ??
            null,
          apply_path_validation:
            createStrongSourceDebugFindingsByPhase().apply_path_validation ??
            null,
          replay_verification:
            createStrongSourceDebugFindingsByPhase().replay_verification ??
            null,
        },
        phaseCompletionModeByPhase: {
          site_structure_mapping: "timed_out_with_partial_evidence",
          search_filter_probe: "timed_out_with_partial_evidence",
        },
        phaseCompletionReasonByPhase: {
          site_structure_mapping:
            "The phase timed out before the worker returned a structured finish call.",
          search_filter_probe:
            "The phase timed out before the worker returned a structured finish call.",
        },
        phaseEvidenceByPhase: {
          site_structure_mapping: {
            visibleControls: [
              'button "Show all"',
              'searchbox "Search by title, skill, or company"',
            ],
            successfulInteractions: ['Clicked button "Show all"'],
            routeSignals: [
              "Control click opened https://www.linkedin.com/jobs/collections/recommended/",
            ],
            attemptedControls: ['Clicked button "Show all"'],
            warnings: [],
          },
          search_filter_probe: {
            visibleControls: [
              'searchbox "Search by title, skill, or company"',
              'combobox "Location"',
            ],
            successfulInteractions: [
              'Filled searchbox "Search by title, skill, or company" with "frontend engineer"',
            ],
            routeSignals: [
              "Search submit opened https://www.linkedin.com/jobs/search/",
            ],
            attemptedControls: [
              'Filled searchbox "Search by title, skill, or company"',
            ],
            warnings: [],
          },
        },
      },
    );
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime,
      aiClient: createAgentAiClient(),
      documentManager: createDocumentManager(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );
    const latestRunId =
      snapshot.searchPreferences.discovery.targets[0]?.lastDebugRunId;
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);

    expect(
      snapshot.searchPreferences.discovery.targets[0]?.instructionStatus,
    ).toBe("draft");
    expect(latestArtifact?.status).toBe("draft");
    expect(
      latestArtifact?.warnings.some((warning) =>
        /ran out of time before it could finish its report/i.test(warning),
      ),
    ).toBe(true);

    expect(latestRunId).toBeTruthy();
    if (!latestRunId) {
      return;
    }

    const details =
      await workspaceService.getSourceDebugRunDetails(latestRunId);
    const timedOutAttempts = details.attempts.filter(
      (attempt) => attempt.completionMode === "timed_out_with_partial_evidence",
    );

    expect(timedOutAttempts.length).toBeGreaterThan(0);
    expect(timedOutAttempts[0]?.completionReason).toContain(
      "timed out before the worker returned a structured finish call",
    );
    expect(timedOutAttempts[0]?.phaseEvidence?.visibleControls).toContain(
      'button "Show all"',
    );
  });

  test("final source-debug review switches to summary-first handoff when transcript context is too large", async () => {
    const repository = createInMemoryJobFinderRepository({
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
      resumeDrafts: [],
      resumeDraftRevisions: [],
      resumeExportArtifacts: [],
      resumeResearchArtifacts: [],
      resumeValidationResults: [],
      resumeAssistantMessages: [],
    });
    const reviewPrompts: string[] = [];
    const fallbackClient = createDeterministicJobFinderAiClient(
      "Tests use the deterministic fallback agent.",
    );
    const aiClient: JobFinderAiClient = {
      ...fallbackClient,
      getStatus() {
        return {
          ...fallbackClient.getStatus(),
          modelContextWindowTokens: 196_000,
        };
      },
      chatWithTools(messages) {
        reviewPrompts.push(extractLatestUserPrompt(messages));
        return Promise.resolve({
          content: JSON.stringify({
            navigationGuidance: ["Use the listing route first."],
            searchGuidance: [],
            detailGuidance: [],
            applyGuidance: [],
            warnings: [],
          }),
          toolCalls: [],
        });
      },
    };
    const browserRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_review_case_large_transcript",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_review_case_large_transcript",
          title: "Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Reviewer summary-first case.",
          description: "Reviewer summary-first case.",
          keySkills: ["React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
        reviewTranscriptByPhase: {
          search_filter_probe: Array.from({ length: 3500 }, (_, index) =>
            (`assistant: transcript line ${index} showing repeated route evidence with stable listing routes, visible filters, canonical detail confirmations, reusable collection routes, and durable replay notes for the final reviewer. `).repeat(4),
          ),
        },
      },
    );
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime,
      aiClient,
      documentManager: createDocumentManager(),
    });

    await workspaceService.runSourceDebug("target_linkedin_default");

    expect(reviewPrompts).toHaveLength(1);
    expect(reviewPrompts[0]).toContain('"mode": "summary_first"');
    expect(reviewPrompts[0]).not.toContain("transcript line 3499");
    expect(reviewPrompts[0]).toContain("do not ask for the missing raw transcript lines");
  });

  test("clears prior learned instructions for the target before a fresh source-debug run", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      instructionStatus: "validated",
      validatedInstructionId: "instruction_old_validated",
      draftInstructionId: "instruction_old_draft",
      lastVerifiedAt: "2026-03-20T10:05:00.000Z",
      staleReason: "Old verification state",
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_old_validated",
        targetId: "target_linkedin_default",
        status: "validated",
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: "2026-03-20T10:05:00.000Z",
        basedOnRunId: "old_run",
        basedOnAttemptIds: ["old_attempt"],
        notes: "Old validated instructions",
        navigationGuidance: ["Old navigation guidance"],
        searchGuidance: ["Old search guidance"],
        detailGuidance: ["Old detail guidance"],
        applyGuidance: ["Old apply guidance"],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "source-debug-v1",
          toolsetVersion: "browser-tools-v1",
          adapterVersion: "target-site-adapter-v1",
          appSchemaVersion: "job-finder-source-debug-v1",
        },
        verification: {
          id: "verification_old_validated",
          replayRunId: "old_run",
          verifiedAt: "2026-03-20T10:05:00.000Z",
          outcome: "passed",
          proofSummary: "Old replay verification succeeded.",
          reason: null,
          versionInfo: {
            promptProfileVersion: "source-debug-v1",
            toolsetVersion: "browser-tools-v1",
            adapterVersion: "target-site-adapter-v1",
            appSchemaVersion: "job-finder-source-debug-v1",
          },
        },
      }),
      createSourceInstructionArtifact({
        id: "instruction_old_draft",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:01:00.000Z",
        updatedAt: "2026-03-20T10:06:00.000Z",
        acceptedAt: null,
        basedOnRunId: "old_run_2",
        basedOnAttemptIds: ["old_attempt_2"],
        notes: "Old draft instructions",
        navigationGuidance: ["Old draft navigation guidance"],
        searchGuidance: [],
        detailGuidance: [],
        applyGuidance: [],
        warnings: ["Old warning"],
        versionInfo: {
          promptProfileVersion: "source-debug-v1",
          toolsetVersion: "browser-tools-v1",
          adapterVersion: "target-site-adapter-v1",
          appSchemaVersion: "job-finder-source-debug-v1",
        },
        verification: null,
      }),
    ];

    const repository = createInMemoryJobFinderRepository(seed);
    const browserRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_reset_1",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_reset_1",
          title: "Product Designer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "unknown",
          easyApplyEligible: false,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Reset coverage.",
          description: "Reset coverage.",
          keySkills: ["Figma"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    const workspaceService = createJobFinderWorkspaceService({
      repository,
      browserRuntime,
      aiClient: createAgentAiClient(),
      documentManager: createDocumentManager(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );
    const artifacts = await repository.listSourceInstructionArtifacts();

    expect(
      artifacts.some((artifact) => artifact.id === "instruction_old_validated"),
    ).toBe(false);
    expect(
      artifacts.some((artifact) => artifact.id === "instruction_old_draft"),
    ).toBe(false);
    expect(
      snapshot.searchPreferences.discovery.targets[0]?.validatedInstructionId,
    ).not.toBe("instruction_old_validated");
    expect(
      snapshot.searchPreferences.discovery.targets[0]?.draftInstructionId,
    ).not.toBe("instruction_old_draft");
    expect(
      snapshot.sourceInstructionArtifacts.every(
        (artifact) => artifact.targetId === "target_linkedin_default",
      ),
    ).toBe(true);
  });


});
