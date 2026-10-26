import { createSourceDebugServiceHarness } from "./source-debug.test-support";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { describe, expect, test } from "vitest";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createSeed,
  createSourceInstructionArtifact,
  learnedRoutesIntelligence,
  createStrongSourceDebugFindingsByPhase,
  toEditableSourceInstructionArtifactInput,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("ignores wildcard and templated route hints when deriving starting urls", async () => {
    const seed = createSeed();
    seed.jobSites[0] = {
      ...seed.jobSites[0]!,
      startingUrl: "https://www.linkedin.com/jobs/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_linkedin_template_routes",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_template_routes",
        targetId: "1",
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
          [
            "https://www.linkedin.com/jobs/collections/recommended/",
            "collection",
          ],
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
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_template_routes",
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
    const { workspaceService } = createSourceDebugServiceHarness({
      seed: {
        ...seed,
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runSourceDebug("1");

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
    seed.jobSites[0] = {
      ...seed.jobSites[0]!,
      startingUrl: "https://www.linkedin.com/jobs/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_linkedin_unstable_job_route",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_unstable_job_route",
        targetId: "1",
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
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_unstable_job_route",
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
    const { workspaceService } = createSourceDebugServiceHarness({
      seed: {
        ...seed,
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runSourceDebug("1");

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
    seed.jobSites[0] = {
      ...seed.jobSites[0]!,
      id: "1",
      label: "Example Careers",
      startingUrl: "https://example.com/careers/",
      instructionStatus: "draft",
      draftInstructionId: "instruction_example_query_detail",
      validatedInstructionId: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_example_query_detail",
        targetId: "1",
        status: "draft",
        createdAt: "2026-03-20T10:04:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: null,
        basedOnRunId: "debug_run_example_query_detail",
        basedOnAttemptIds: ["debug_attempt_example_query_detail"],
        notes:
          "Detail route includes query params but should not become the search starting point.",
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
    const { workspaceService } = createSourceDebugServiceHarness({
      seed: {
        ...seed,
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.runSourceDebug("1");

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
    seed.jobSites = [
      {
        ...seed.jobSites[0]!,
        instructionStatus: "draft",
        validatedInstructionId: null,
        draftInstructionId: "instruction_linkedin_draft_editable",
      },
    ];
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_linkedin_draft_editable",
        targetId: "1",
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

    const { workspaceService } = createSourceDebugServiceHarness({ seed });
    const originalArtifact = seed.sourceInstructionArtifacts[0]!;

    const updatedSnapshot =
      await workspaceService.saveSourceInstructionArtifact("1", {
        ...toEditableSourceInstructionArtifactInput(originalArtifact),
        searchGuidance: ["Use the edited search guidance instead."],
      });
    const updatedArtifact = updatedSnapshot.sourceInstructionArtifacts.find(
      (artifact) => artifact.id === originalArtifact.id,
    );

    expect(updatedArtifact?.searchGuidance).toEqual([
      "Use the edited search guidance instead.",
    ]);
    expect(updatedArtifact?.status).toBe("draft");
    expect(updatedArtifact?.basedOnRunId).toBe("debug_run_editable");

    await expect(
      workspaceService.saveSourceInstructionArtifact("1", {
        ...toEditableSourceInstructionArtifactInput(originalArtifact),
        id: "instruction_not_bound_to_target",
      }),
    ).rejects.toThrow(/unknown source instruction/i);
  });
});
