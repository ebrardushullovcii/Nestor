import { createSourceDebugServiceHarness as createWorkspaceServiceHarness } from "./source-debug.test-support";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createSeed,
  createStrongSourceDebugFindingsByPhase,
} from "./workspace-service.test-support";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public provider source check fallback", () => {
  test("runs complete browser coverage when the provider API is unavailable", async () => {
    const seed = createSeed();
    seed.jobSites = [
      {
        id: "1",
        label: "Public provider fallback",
        startingUrl: "https://job-boards.greenhouse.io/fallback-board",
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
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "provider_fallback_job_1",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://job-boards.greenhouse.io/fallback-board/jobs/1001",
          title: "Senior Frontend Engineer",
          company: "Fallback Board",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "external_redirect",
          easyApplyEligible: false,
          postedAt: "2026-07-31T00:00:00.000Z",
          discoveredAt: "2026-07-31T00:00:01.000Z",
          salaryText: null,
          summary: "Build accessible frontend systems.",
          description: "Build accessible frontend systems.",
          keySkills: ["React", "TypeScript"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    const phaseLabels: string[] = [];
    let openSessionCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      openSession(source, options) {
        openSessionCalls += 1;
        return baseRuntime.openSession(source, options);
      },
      runAgentDiscovery(source, options) {
        phaseLabels.push(options.siteLabel);
        return baseRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runSourceDebug("1");

    expect(openSessionCalls).toBe(1);
    expect(
      phaseLabels.some((label) => /site structure mapping/i.test(label)),
    ).toBe(true);
    expect(
      phaseLabels.some((label) => /replay verification/i.test(label)),
    ).toBe(true);
    expect(snapshot.recentSourceDebugRuns[0]?.phases).toEqual([
      "site_structure_mapping",
      "replay_verification",
    ]);
  });
});
