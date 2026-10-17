import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { describe, expect, test, vi } from "vitest";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createSeed,
  createSourceInstructionArtifact,
  learnedRoutesIntelligence,
  createStrongSourceDebugFindingsByPhase,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("agent discovery uses the active draft-or-validated instructions for the matching target", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_linkedin_accepted_draft",
        label: "Draft target",
        startingUrl: "https://www.linkedin.com/jobs/",
        instructionStatus: "draft",
        validatedInstructionId: null,
        draftInstructionId: "instruction_linkedin_draft_accepted",
      },
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        id: "target_linkedin_validated",
        label: "Validated target",
        startingUrl: "https://www.linkedin.com/jobs/search/",
        instructionStatus: "validated",
        validatedInstructionId: "instruction_linkedin_validated",
        draftInstructionId: null,
      },
    ];
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_draft_accepted",
        targetId: "target_linkedin_accepted_draft",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_draft",
        basedOnAttemptIds: ["debug_attempt_draft"],
        notes: "Accepted draft guidance.",
        navigationGuidance: [
          "Use the accepted draft recommendation route first.",
        ],
        searchGuidance: [
          "Open the accepted draft collection before trying broader search.",
        ],
        detailGuidance: [],
        applyGuidance: [],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "v1",
          appSchemaVersion: "v1",
        },
        verification: null,
      }),
      createSourceInstructionArtifact({
        id: "instruction_linkedin_validated",
        targetId: "target_linkedin_validated",
        status: "validated",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: "2026-03-20T10:06:00.000Z",
        basedOnRunId: "debug_run_validated",
        basedOnAttemptIds: ["debug_attempt_validated"],
        notes: "Validated guidance.",
        navigationGuidance: ["Use the validated jobs search route directly."],
        searchGuidance: [
          "Use the validated location filter after opening the results page.",
        ],
        detailGuidance: [],
        applyGuidance: [],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "v1",
          appSchemaVersion: "v1",
        },
        verification: {
          id: "verification_linkedin_validated",
          replayRunId: "debug_run_replay_validated",
          verifiedAt: "2026-03-20T10:07:00.000Z",
          outcome: "passed",
          proofSummary: "Replay succeeded.",
          reason: null,
          versionInfo: {
            promptProfileVersion: "v1",
            toolsetVersion: "v1",
            adapterVersion: "v1",
            appSchemaVersion: "v1",
          },
        },
      }),
    ];

    const catalog =
      await createWorkspaceServiceHarness().browserRuntime.runDiscovery(
        "target_site",
        createSeed().searchPreferences,
      );
    const baseAgentRuntime = createAgentBrowserRuntime(catalog.jobs);
    const capturedInstructionsByLabel = new Map<string, readonly string[]>();
    const browserRuntime: BrowserSessionRuntime = {
      ...baseAgentRuntime,
      runAgentDiscovery(source, options) {
        capturedInstructionsByLabel.set(options.siteLabel, [
          ...(options.siteInstructions ?? []),
        ]);
        return baseAgentRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runAgentDiscovery(
      () => {},
      new AbortController().signal,
    );

    expect(capturedInstructionsByLabel.get("Draft target")).toEqual(
      expect.arrayContaining([
        "[Navigation] Use the accepted draft recommendation route first.",
        "[Search] Open the accepted draft collection before trying broader search.",
      ]),
    );
    expect(
      capturedInstructionsByLabel.get("Draft target")?.join("\n"),
    ).not.toContain("validated jobs search route directly");
    expect(capturedInstructionsByLabel.get("Validated target")).toEqual(
      expect.arrayContaining([
        "[Navigation] Use the validated jobs search route directly.",
        "[Search] Use the validated location filter after opening the results page.",
      ]),
    );
    expect(
      capturedInstructionsByLabel.get("Validated target")?.join("\n"),
    ).not.toContain("accepted draft recommendation route first");
  });

  test("source debug reuses learned route hints for later phases and keeps one safety step ceiling", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      startingUrl: "https://www.linkedin.com/jobs/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_linkedin_debug_seeded",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_debug_seeded",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_seeded",
        basedOnAttemptIds: ["debug_attempt_seeded"],
        notes: "Seeded route hints.",
        navigationGuidance: [
          "Use https://www.linkedin.com/jobs/collections/recommended/ to access the recommended jobs collection.",
        ],
        searchGuidance: [
          "Use https://www.linkedin.com/jobs/search/ to reach job results directly.",
        ],
        detailGuidance: [
          "Click job card to view full details and apply options.",
        ],
        applyGuidance: [
          "Apply button appears on job detail page after clicking a job card.",
        ],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "v1",
          appSchemaVersion: "v1",
        },
        verification: null,
        intelligence: learnedRoutesIntelligence([
          [
            "https://www.linkedin.com/jobs/collections/recommended/",
            "collection",
          ],
          ["https://www.linkedin.com/jobs/search/", "search"],
        ]),
      }),
    ];

    const capturedPhaseInputs = new Map<
      string,
      { startingUrls: readonly string[]; maxSteps: number }
    >();
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_seeded",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_seeded",
          title: "Senior Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Validate source-debug route seeding.",
          description: "Validate source-debug route seeding.",
          keySkills: ["React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source, options) {
        capturedPhaseInputs.set(
          options.taskPacket?.strategyLabel ?? options.siteLabel,
          {
            startingUrls: [...options.startingUrls],
            maxSteps: options.maxSteps,
          },
        );
        return baseRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runSourceDebug("target_linkedin_default");

    expect(capturedPhaseInputs.get("Site Structure Mapping")).toEqual({
      startingUrls: [
        "https://www.linkedin.com/jobs/collections/recommended/",
        "https://www.linkedin.com/jobs/",
        "https://www.linkedin.com/jobs/search/",
      ],
      maxSteps: 60,
    });
    expect(capturedPhaseInputs.get("Replay Verification")?.maxSteps).toBe(60);

    const latestRun = (await repository.listSourceDebugRuns())[0];
    const siteStructureAttempt = (
      await repository.listSourceDebugAttempts()
    ).find((attempt) => attempt.phase === "site_structure_mapping");
    const startEvidence = (await repository.listSourceDebugEvidenceRefs()).find(
      (entry) =>
        entry.attemptId === siteStructureAttempt?.id &&
        entry.label === "Starting URL",
    );

    expect(latestRun?.instructionArtifactId).toBeTruthy();
    expect(siteStructureAttempt?.attemptedActions).toContain(
      "Started from https://www.linkedin.com/jobs/collections/recommended/.",
    );
    expect(startEvidence?.url).toBe(
      "https://www.linkedin.com/jobs/collections/recommended/",
    );
  });

  test("source debug reuses exact same-host hinted routes for generic targets without fabricating jobs paths", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      id: "target_example_default",
      label: "Example Careers",
      startingUrl: "https://example.com/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_example_seeded",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_example_seeded",
        targetId: "target_example_default",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_example_seeded",
        basedOnAttemptIds: ["debug_attempt_example_seeded"],
        notes: "Seeded generic route hints.",
        navigationGuidance: [
          "Use https://example.com/careers/open-roles/ to access the jobs collection.",
        ],
        searchGuidance: [
          "Use https://example.com/careers/open-roles/search?team=product to reach filtered results.",
        ],
        detailGuidance: [
          "Open the role detail page from the careers collection.",
        ],
        applyGuidance: ["Apply starts from the role detail page."],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "v1",
          appSchemaVersion: "v1",
        },
        verification: null,
        intelligence: learnedRoutesIntelligence([
          ["https://example.com/careers/open-roles/", "collection"],
          [
            "https://example.com/careers/open-roles/search?team=product",
            "search",
          ],
        ]),
      }),
    ];

    const capturedPhaseInputs = new Map<
      string,
      { startingUrls: readonly string[]; maxSteps: number }
    >();
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "example_source_debug_seeded",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://example.com/careers/open-roles/frontend-engineer",
          title: "Frontend Engineer",
          company: "Example Co",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "external_redirect",
          easyApplyEligible: false,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Validate generic source-debug route seeding.",
          description: "Validate generic source-debug route seeding.",
          keySkills: ["React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source, options) {
        capturedPhaseInputs.set(
          options.taskPacket?.strategyLabel ?? options.siteLabel,
          {
            startingUrls: [...options.startingUrls],
            maxSteps: options.maxSteps,
          },
        );
        return baseRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runSourceDebug("target_example_default");

    expect(capturedPhaseInputs.get("Site Structure Mapping")).toEqual({
      startingUrls: [
        "https://example.com/careers/open-roles/",
        "https://example.com/",
        "https://example.com/careers/open-roles/search?team=product",
      ],
      maxSteps: 60,
    });
  });

  test("provider-backed targets validate through the public API without browser phases", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      id: "target_greenhouse_remote",
      label: "Remote Greenhouse",
      startingUrl: "https://job-boards.greenhouse.io/remote",
      instructionStatus: "missing",
      draftInstructionId: null,
      validatedInstructionId: null,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          jobs: [
            {
              id: 4622190,
              title: "Software Engineer",
              absolute_url:
                "https://job-boards.greenhouse.io/remote/jobs/4622190",
              location: { name: "Remote" },
              content: "<p>Build remote software.</p>",
            },
          ],
        }),
    } as Response);

    const capturedPhaseInputs = new Map<
      string,
      { startingUrls: readonly string[]; maxSteps: number }
    >();
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "greenhouse_source_debug_seeded",
          discoveryMethod: "catalog_seed",
          canonicalUrl: "https://job-boards.greenhouse.io/remote/jobs/4622190",
          title: "Software Engineer",
          company: "Remote",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "external_redirect",
          easyApplyEligible: false,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Validate provider-backed source-debug fast path.",
          description: "Validate provider-backed source-debug fast path.",
          keySkills: ["TypeScript"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source, options) {
        capturedPhaseInputs.set(
          options.taskPacket?.strategyLabel ?? options.siteLabel,
          {
            startingUrls: [...options.startingUrls],
            maxSteps: options.maxSteps,
          },
        );
        return baseRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runSourceDebug("target_greenhouse_remote");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capturedPhaseInputs.size).toBe(0);
    const latestRun = (await repository.listSourceDebugRuns())[0];
    expect(latestRun?.phases).toEqual(["replay_verification"]);
    expect(latestRun?.timing?.browserSetupMs).toBeNull();
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);
    expect(latestArtifact?.status).toBe("validated");
    expect(latestArtifact?.warnings).toEqual([]);
    fetchSpy.mockRestore();
  });

  test("search filter probe prefers proven collection routes when no search route hint exists", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      startingUrl: "https://www.linkedin.com/jobs/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_linkedin_collection_only",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_collection_only",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_collection_only",
        basedOnAttemptIds: ["debug_attempt_collection_only"],
        notes: "Collection-first route hint.",
        navigationGuidance: [
          'Click "Show all top job picks for you" to open https://www.linkedin.com/jobs/collections/recommended/.',
        ],
        searchGuidance: [
          "Recommendation routes are the primary way to access different job collections.",
        ],
        detailGuidance: [],
        applyGuidance: [],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "v1",
          appSchemaVersion: "v1",
        },
        verification: null,
        intelligence: learnedRoutesIntelligence([
          [
            "https://www.linkedin.com/jobs/collections/recommended/",
            "collection",
          ],
        ]),
      }),
    ];

    const capturedPhaseInputs = new Map<
      string,
      { startingUrls: readonly string[]; maxSteps: number }
    >();
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_collection_only",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_collection_only",
          title: "Senior Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Validate collection-first source-debug routing.",
          description: "Validate collection-first source-debug routing.",
          keySkills: ["React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source, options) {
        capturedPhaseInputs.set(
          options.taskPacket?.strategyLabel ?? options.siteLabel,
          {
            startingUrls: [...options.startingUrls],
            maxSteps: options.maxSteps,
          },
        );
        return baseRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runSourceDebug("target_linkedin_default");

    expect(capturedPhaseInputs.get("Site Structure Mapping")).toEqual({
      startingUrls: [
        "https://www.linkedin.com/jobs/collections/recommended/",
        "https://www.linkedin.com/jobs/",
      ],
      maxSteps: 60,
    });
  });
});
