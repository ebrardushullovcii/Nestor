import { createSourceDebugServiceHarness as createWorkspaceServiceHarness } from "./source-debug.test-support";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createAgentAiClient,
  createBrowserRuntime,
  createSeed,
} from "./workspace-service.test-support";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public provider source check", () => {
  test("validates a complete provider capability without launching the browser or waiting on AI", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets = [
      {
        id: "1",
        label: "Mercury Greenhouse",
        startingUrl: "https://job-boards.greenhouse.io/mercury",
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
    const providerJobs = Array.from({ length: 56 }, (_, index) => ({
      id: 1_000 + index,
      title:
        index === 0
          ? "Senior Frontend Engineer - Design Systems"
          : `Engineering role ${index + 1}`,
      absolute_url: `https://job-boards.greenhouse.io/mercury/jobs/${1_000 + index}`,
      location: { name: index % 2 === 0 ? "Remote" : "New York, NY" },
      updated_at: "2026-07-31T00:00:00.000Z",
      content: "<p>Build reliable financial products.</p>",
    }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ jobs: providerJobs }),
    } as Response);
    const baseRuntime = createBrowserRuntime();
    let openSessionCalls = 0;
    let agentDiscoveryCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      openSession(source, options) {
        openSessionCalls += 1;
        return baseRuntime.openSession(source, options);
      },
      runAgentDiscovery() {
        agentDiscoveryCalls += 1;
        throw new Error(
          "Public provider source checks must not launch agent discovery.",
        );
      },
    };
    const baseAiClient = createAgentAiClient();
    let aiReviewCalls = 0;
    const aiClient = {
      ...baseAiClient,
      chatWithTools(...args: Parameters<typeof baseAiClient.chatWithTools>) {
        aiReviewCalls += 1;
        return baseAiClient.chatWithTools(...args);
      },
    };
    const { repository, workspaceService, jobSites } =
      createWorkspaceServiceHarness({
        seed,
        browserRuntime,
        aiClient,
      });
    const progressEvents: Array<{ waitReason: string; jobsFound: number }> = [];

    const snapshot = await workspaceService.runSourceDebug(
      "1",
      undefined,
      (event) => progressEvents.push(event),
    );
    const artifacts = await repository.listSourceInstructionArtifacts();
    const attempts = await repository.listSourceDebugAttempts();
    const evidenceRefs = await repository.listSourceDebugEvidenceRefs();
    const artifact = artifacts.at(-1);
    const run = snapshot.recentSourceDebugRuns[0];

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(openSessionCalls).toBe(0);
    expect(agentDiscoveryCalls).toBe(0);
    expect(aiReviewCalls).toBe(0);
    expect(run).toMatchObject({
      state: "completed",
      phases: ["replay_verification"],
      activePhase: null,
    });
    expect(run?.timing).toMatchObject({
      browserSetupMs: null,
      finalReviewMs: null,
    });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      phase: "replay_verification",
      outcome: "succeeded",
      strategyLabel: "Public provider API verification",
    });
    expect(evidenceRefs).toHaveLength(4);
    expect(artifact).toMatchObject({
      status: "validated",
      warnings: [],
      intelligence: {
        provider: {
          key: "greenhouse",
          label: "Greenhouse",
          apiAvailability: "available",
          providerIdentifier: "mercury",
        },
        collection: {
          preferredMethod: "api",
        },
      },
    });
    expect(artifact?.navigationGuidance.join(" ")).toMatch(
      /repeatable listing entry path/i,
    );
    expect(artifact?.searchGuidance.join(" ")).toMatch(/filters locally/i);
    expect(artifact?.detailGuidance.join(" ")).toMatch(/canonical detail URL/i);
    expect(artifact?.applyGuidance.join(" ")).toMatch(
      /stop before any final submission/i,
    );
    expect(
      artifact?.warnings.some((warning) =>
        /entry path is still missing|search and filter coverage is still missing/i.test(
          warning,
        ),
      ),
    ).toBe(false);
    expect(progressEvents.map((event) => event.waitReason)).toEqual([
      "extracting_jobs",
      "finalizing",
    ]);
    expect(progressEvents.at(-1)?.jobsFound).toBe(56);
    expect(jobSites.get(1)).toMatchObject({
      instructionStatus: "validated",
      draftInstructionId: null,
    });
  });
});
