import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { describe, expect, test } from "vitest";
import {
  createSavedJobDiscoveryProvenance,
  createAgentAiClient,
  createAgentBrowserRuntime,
  createSeed,
  createSourceInstructionArtifact,
  learnedRoutesIntelligence,
  createStrongSourceDebugFindingsByPhase,
  createWorkspaceServiceHarness,
  toEditableSourceInstructionArtifactInput,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("ignores wildcard and templated route hints when deriving starting urls", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      startingUrl: "https://www.linkedin.com/jobs/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_linkedin_template_routes",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_template_routes",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_template_routes",
        basedOnAttemptIds: ["debug_attempt_template_routes"],
        notes: "Template route hints should be ignored.",
        navigationGuidance: [
          "Collection routes (/jobs/collections/*) trigger auth gates and return no interactive elements.",
          "Job details can appear under /jobs/:jobId after a card click.",
          "Clicking 'Show all top job picks for you' opens /jobs/collections/recommended/.",
        ],
        searchGuidance: [
          "/jobs/search/?keywords=...&location=... reliably returns job cards with filter controls.",
          "/jobs/search/?keywords=:keyword&location=:location should not be treated as a concrete replay URL.",
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
          ["https://www.linkedin.com/jobs/collections/recommended/", "collection"],
          ["https://www.linkedin.com/jobs/:jobId", "listing"],
          [
            "https://www.linkedin.com/jobs/search/?keywords=:keyword&location=:location",
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
          sourceJobId: "linkedin_template_routes",
          discoveryMethod: "catalog_seed",
          canonicalUrl: "https://www.linkedin.com/jobs/view/linkedin_template_routes",
          title: "Senior Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Validate templated route filtering.",
          description: "Validate templated route filtering.",
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
        capturedPhaseInputs.set(options.taskPacket?.strategyLabel ?? options.siteLabel, {
          startingUrls: [...options.startingUrls],
          maxSteps: options.maxSteps,
        });
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

  test("replay verification strips unstable current-job query params from learned starting urls", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      startingUrl: "https://www.linkedin.com/jobs/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_linkedin_unstable_job_route",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_unstable_job_route",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_unstable_job_route",
        basedOnAttemptIds: ["debug_attempt_unstable_job_route"],
        notes: "Route hints include unstable selected-job params.",
        navigationGuidance: [
          "Collection route at /jobs/collections/recommended/?currentJobId=3973153031.",
        ],
        searchGuidance: [
          "Use direct URL search: /jobs/search/?keywords=React%20Next.js%20Developer&location=Pristina%2C%20Kosovo&currentJobId=438896875.",
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
            "https://www.linkedin.com/jobs/collections/recommended/?currentJobId=3973153031",
            "collection",
          ],
          [
            "https://www.linkedin.com/jobs/search/?keywords=React+Next.js+Developer&location=Pristina%2C+Kosovo&currentJobId=438896875",
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
          sourceJobId: "linkedin_unstable_job_route",
          discoveryMethod: "catalog_seed",
          canonicalUrl: "https://www.linkedin.com/jobs/view/linkedin_unstable_job_route",
          title: "Senior Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Validate unstable query stripping.",
          description: "Validate unstable query stripping.",
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
        capturedPhaseInputs.set(options.taskPacket?.strategyLabel ?? options.siteLabel, {
          startingUrls: [...options.startingUrls],
          maxSteps: options.maxSteps,
        });
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
        "https://www.linkedin.com/jobs/search/?keywords=React+Next.js+Developer&location=Pristina%2C+Kosovo",
      ],
      maxSteps: 60,
    });
    expect(capturedPhaseInputs.get("Replay Verification")).toEqual({
      startingUrls: [
        "https://www.linkedin.com/jobs/collections/recommended/",
        "https://www.linkedin.com/jobs/search/?keywords=React+Next.js+Developer&location=Pristina%2C+Kosovo",
        "https://www.linkedin.com/jobs/",
      ],
      maxSteps: 60,
    });
  });

  test("non-search same-host query urls are not promoted into search-filter starting urls", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      id: "target_example_query_detail",
      label: "Example Careers",
      startingUrl: "https://example.com/careers/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_example_query_detail",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_example_query_detail",
        targetId: "target_example_query_detail",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_example_query_detail",
        basedOnAttemptIds: ["debug_attempt_example_query_detail"],
        notes: "Detail route includes query params but should not become the search starting point.",
        navigationGuidance: [
          "Start at https://example.com/careers/open-roles/.",
        ],
        searchGuidance: [
          "Use https://example.com/careers/search?team=product to reach the filtered results list.",
        ],
        detailGuidance: [
          "Role details can open at https://example.com/careers/role/frontend-engineer?gh_jid=12345.",
        ],
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
          ["https://example.com/careers/open-roles/", "listing"],
          ["https://example.com/careers/search?team=product", "search"],
          [
            "https://example.com/careers/role/frontend-engineer?gh_jid=12345",
            "detail",
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
          sourceJobId: "example_query_detail",
          discoveryMethod: "catalog_seed",
          canonicalUrl: "https://example.com/careers/role/frontend-engineer",
          title: "Frontend Engineer",
          company: "Example Co",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "external_redirect",
          easyApplyEligible: false,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Validate query detail route handling.",
          description: "Validate query detail route handling.",
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
        capturedPhaseInputs.set(options.taskPacket?.strategyLabel ?? options.siteLabel, {
          startingUrls: [...options.startingUrls],
          maxSteps: options.maxSteps,
        });
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

    await workspaceService.runSourceDebug("target_example_query_detail");

    expect(capturedPhaseInputs.get("Site Structure Mapping")).toEqual({
      startingUrls: [
        "https://example.com/careers/open-roles/",
        "https://example.com/careers/",
        "https://example.com/careers/search?team=product",
      ],
      maxSteps: 60,
    });
  });

  test("saveSourceInstructionArtifact updates a bound target artifact and rejects unbound edits", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        instructionStatus: "draft",
        validatedInstructionId: null,
        draftInstructionId: "instruction_linkedin_draft_editable",
      },
    ];
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_draft_editable",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_editable",
        basedOnAttemptIds: ["debug_attempt_editable"],
        notes: "Editable draft guidance.",
        navigationGuidance: ["Start from the jobs homepage."],
        searchGuidance: ["Use the visible search box first."],
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
    ];

    const { workspaceService } = createWorkspaceServiceHarness({ seed });
    const originalArtifact = seed.sourceInstructionArtifacts[0]!;

    const updatedSnapshot = await workspaceService.saveSourceInstructionArtifact(
      "target_linkedin_default",
      {
        ...toEditableSourceInstructionArtifactInput(originalArtifact),
        searchGuidance: ["Use the edited search guidance instead."],
      },
    );
    const updatedArtifact = updatedSnapshot.sourceInstructionArtifacts.find(
      (artifact) => artifact.id === originalArtifact.id,
    );

    expect(updatedArtifact?.searchGuidance).toEqual([
      "Use the edited search guidance instead.",
    ]);
    expect(updatedArtifact?.status).toBe("draft");
    expect(updatedArtifact?.basedOnRunId).toBe("debug_run_editable");

    await expect(
      workspaceService.saveSourceInstructionArtifact("target_linkedin_default", {
        ...toEditableSourceInstructionArtifactInput(originalArtifact),
        id: "instruction_not_bound_to_target",
      }),
    ).rejects.toThrow(/unknown source instruction/i);
  });

  test("forwards validated source guidance into apply execution", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        instructionStatus: "validated",
        validatedInstructionId: "instruction_linkedin_validated",
      },
    ];
    seed.savedJobs = [
      {
        ...seed.savedJobs[0]!,
        provenance: [
            createSavedJobDiscoveryProvenance({
              targetId: "target_linkedin_default",
              adapterKind: "auto",
              resolvedAdapterKind: "target_site",
              startingUrl: "https://www.linkedin.com/jobs/search/",
              discoveredAt: "2026-03-20T10:04:00.000Z",
            }),
          ],
        },
      ...seed.savedJobs.slice(1),
    ];
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_validated",
        targetId: "target_linkedin_default",
        status: "validated",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
        acceptedAt: "2026-03-20T10:04:00.000Z",
        basedOnRunId: "debug_run_1",
        basedOnAttemptIds: ["debug_attempt_1"],
        notes: "Validated apply guidance for the target-site target.",
        navigationGuidance: [
          "Open the job detail page before acting on apply controls.",
        ],
        searchGuidance: [
          "Use the jobs search entrypoint rather than the site home feed.",
        ],
        detailGuidance: [
          "Prefer the dedicated jobs search entrypoint for this source.",
        ],
        applyGuidance: [
          "Use the Easy Apply branch when the listing exposes it; otherwise pause for review.",
        ],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "v1",
          appSchemaVersion: "v1",
        },
        verification: {
          id: "verification_linkedin_validated",
          replayRunId: "debug_run_replay_1",
          verifiedAt: "2026-03-20T10:04:00.000Z",
          outcome: "passed",
          proofSummary: "Replay reached the apply path successfully.",
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

    let capturedInstructions: readonly string[] = [];
    const fallbackRuntime = createWorkspaceServiceHarness().browserRuntime;
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...fallbackRuntime,
        async executeEasyApply(source, input) {
          capturedInstructions = input.instructions ?? [];
          return fallbackRuntime.executeEasyApply(
            source,
            input,
          );
        },
        async executeApplicationFlow(source, input) {
          capturedInstructions = input.instructions ?? [];
          return fallbackRuntime.executeApplicationFlow(
            source,
            input,
          );
        },
      },
    });

    const exportedSnapshot = await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);
    await workspaceService.approveApply("job_ready");

    expect(capturedInstructions).toEqual(
      expect.arrayContaining([
        "[Navigation] Open the job detail page before acting on apply controls.",
        "[Search] Use the jobs search entrypoint rather than the site home feed.",
        "[Detail] Prefer the dedicated jobs search entrypoint for this source.",
        "[Apply] Use the Easy Apply branch when the listing exposes it; otherwise pause for review.",
      ]),
    );
  });

  test("forwards a draft source guidance set into apply execution for its own target", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets = [
      {
        ...seed.searchPreferences.discovery.targets[0]!,
        instructionStatus: "draft",
        validatedInstructionId: null,
        draftInstructionId: "instruction_linkedin_draft_accepted",
      },
    ];
    seed.savedJobs = [
      {
        ...seed.savedJobs[0]!,
        provenance: [
            createSavedJobDiscoveryProvenance({
              targetId: "target_linkedin_default",
              adapterKind: "auto",
              resolvedAdapterKind: "target_site",
              startingUrl: "https://www.linkedin.com/jobs/",
              discoveredAt: "2026-03-20T10:04:00.000Z",
            }),
          ],
        },
      ...seed.savedJobs.slice(1),
    ];
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_draft_accepted",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:04:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_accepted_draft",
        basedOnAttemptIds: ["debug_attempt_accepted_draft"],
        notes: "Accepted draft apply guidance for the target-site target.",
        navigationGuidance: ["Open the accepted draft collection route first."],
        searchGuidance: [
          "Use the accepted draft jobs surface before refining filters.",
        ],
        detailGuidance: [
          "Open the job detail page after entering through the accepted draft route.",
        ],
        applyGuidance: [
          "Use the accepted draft Easy Apply entry when it is exposed on the detail page.",
        ],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "v1",
          appSchemaVersion: "v1",
        },
        verification: null,
      }),
    ];

    let capturedInstructions: readonly string[] = [];
    const fallbackRuntime = createWorkspaceServiceHarness().browserRuntime;
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...fallbackRuntime,
        async executeEasyApply(source, input) {
          capturedInstructions = input.instructions ?? [];
          return fallbackRuntime.executeEasyApply(
            source,
            input,
          );
        },
        async executeApplicationFlow(source, input) {
          capturedInstructions = input.instructions ?? [];
          return fallbackRuntime.executeApplicationFlow(
            source,
            input,
          );
        },
      },
    });

    const exportedSnapshot = await workspaceService.exportResumePdf("job_ready");
    const approvedExport = exportedSnapshot.resumeExportArtifacts.find(
      (artifact) => artifact.jobId === "job_ready",
    );

    expect(approvedExport).toBeTruthy();

    await workspaceService.approveResume("job_ready", approvedExport!.id);
    await workspaceService.approveApply("job_ready");

    expect(capturedInstructions).toEqual(
      expect.arrayContaining([
        "[Navigation] Open the accepted draft collection route first.",
        "[Search] Use the accepted draft jobs surface before refining filters.",
        "[Detail] Open the job detail page after entering through the accepted draft route.",
        "[Apply] Use the accepted draft Easy Apply entry when it is exposed on the detail page.",
      ]),
    );
  });
});
