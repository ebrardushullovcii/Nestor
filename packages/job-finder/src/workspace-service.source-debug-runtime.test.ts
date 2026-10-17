import {
  createCatalogBrowserSessionRuntime,
  type BrowserSessionRuntime,
} from "@nordri/browser-runtime";
import {
  DiscoveryRunResultSchema,
  JobPostingSchema,
  type DiscoveryRunResultInput,
  type SourceDebugProgressEvent,
} from "@nordri/contracts";
import { describe, expect, test } from "vitest";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createSeed,
  createStrongSourceDebugFindingsByPhase,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function createDiscoveryRunResult(input: DiscoveryRunResultInput) {
  return DiscoveryRunResultSchema.parse(input);
}

describe("createJobFinderWorkspaceService", () => {
  test("pauses source debug when the phase worker reports a login blocker", async () => {
    const baseRuntime = createCatalogBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source) {
        return Promise.resolve(
          createDiscoveryRunResult({
            source,
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:01:00.000Z",
            querySummary: "Agent discovery test run",
            warning:
              "Login required: Sign in before source debugging can continue.",
            jobs: [],
            agentMetadata: {
              steps: 1,
              incomplete: false,
              transcriptMessageCount: 3,
              reviewTranscript: [],
              compactionState: null,
              compactionUsedFallbackTrigger: false,
              phaseCompletionMode: "blocked_auth",
              phaseCompletionReason:
                "Login required: Sign in before source debugging can continue.",
              phaseEvidence: null,
              debugFindings: {
                summary:
                  "Login wall blocks further source debugging until the user signs in.",
                reliableControls: [],
                trickyFilters: [],
                navigationTips: [],
                applyTips: [],
                warnings: ["Sign in before continuing the source-debug run."],
              },
            },
          }),
        );
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );
    const attempts = await repository.listSourceDebugAttempts();

    expect(snapshot.activeSourceDebugRun?.state).toBe("paused_manual");
    expect(snapshot.activeSourceDebugRun?.manualPrerequisiteSummary).toContain(
      "Sign in",
    );
    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("paused_manual");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe("blocked_auth");
    expect(
      snapshot.searchPreferences.discovery.targets[0]?.instructionStatus,
    ).toBe("missing");
  });

  test("keeps the browser session open when source debug pauses for a manual prerequisite", async () => {
    const baseRuntime = createCatalogBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    let openSessionCalls = 0;
    let closeSessionCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      openSession(source, options) {
        void options;
        openSessionCalls += 1;
        return Promise.resolve({
          source,
          status: "ready",
          driver: "catalog_seed",
          label: "Browser session ready",
          detail: "Opened for source debug.",
          lastCheckedAt: "2026-03-20T10:05:00.000Z",
        });
      },
      closeSession(source) {
        closeSessionCalls += 1;
        return Promise.resolve({
          source,
          status: "unknown",
          driver: "catalog_seed",
          label: "Browser session closed",
          detail: "Closed after source debug.",
          lastCheckedAt: "2026-03-20T10:06:00.000Z",
        });
      },
      runAgentDiscovery(source) {
        return Promise.resolve(
          createDiscoveryRunResult({
            source,
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:01:00.000Z",
            querySummary: "Agent discovery test run",
            warning:
              "Login required: Sign in before source debugging can continue.",
            jobs: [],
            agentMetadata: {
              steps: 1,
              incomplete: false,
              transcriptMessageCount: 3,
              reviewTranscript: [],
              compactionState: null,
              compactionUsedFallbackTrigger: false,
              phaseCompletionMode: "blocked_auth",
              phaseCompletionReason:
                "Login required: Sign in before source debugging can continue.",
              phaseEvidence: null,
              debugFindings: {
                summary:
                  "Login wall blocks further source debugging until the user signs in.",
                reliableControls: [],
                trickyFilters: [],
                navigationTips: [],
                applyTips: [],
                warnings: ["Sign in before continuing the source-debug run."],
              },
            },
          }),
        );
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );

    expect(snapshot.activeSourceDebugRun?.state).toBe("paused_manual");
    expect(openSessionCalls).toBe(1);
    expect(closeSessionCalls).toBe(0);
  });

  test("source debug skips session preflight, passes skipSessionValidation to the runtime, and keeps internal agent failures out of learned guidance", async () => {
    const baseRuntime = createCatalogBrowserSessionRuntime({
      sessions: [
        {
          source: "target_site",
          status: "login_required",
          driver: "catalog_seed",
          label: "Browser session needs login",
          detail: "Sign in first.",
          lastCheckedAt: "2026-03-20T10:04:00.000Z",
        },
      ],
      catalog: [],
    });
    let openSessionCalls = 0;
    let closeSessionCalls = 0;
    const skipSessionValidationFlags: boolean[] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      openSession(source, options) {
        void options;
        openSessionCalls += 1;
        return Promise.resolve({
          source,
          status: "ready",
          driver: "catalog_seed",
          label: "Browser session ready",
          detail: "Opened for source debug.",
          lastCheckedAt: "2026-03-20T10:05:00.000Z",
        });
      },
      closeSession(source) {
        closeSessionCalls += 1;
        return Promise.resolve({
          source,
          status: "unknown",
          driver: "catalog_seed",
          label: "Browser session closed",
          detail: "Closed after source debug.",
          lastCheckedAt: "2026-03-20T10:06:00.000Z",
        });
      },
      runAgentDiscovery(source, options) {
        skipSessionValidationFlags.push(options.skipSessionValidation === true);
        return Promise.resolve(
          createDiscoveryRunResult({
            source,
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:01:00.000Z",
            querySummary: "Agent discovery test run",
            warning:
              "Discovery encountered an error: LLM call failed after 3 attempts: temporary upstream failure",
            jobs: [],
            agentMetadata: {
              steps: 2,
              incomplete: false,
              transcriptMessageCount: 5,
              reviewTranscript: [],
              compactionState: null,
              compactionUsedFallbackTrigger: false,
              phaseCompletionMode: "runtime_failed",
              phaseCompletionReason:
                "Discovery encountered an error: LLM call failed after 3 attempts: temporary upstream failure",
              phaseEvidence: null,
              debugFindings: null,
            },
          }),
        );
      },
    };
    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const artifactCountBefore = (
      await repository.listSourceInstructionArtifacts()
    ).length;
    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );
    const artifactsAfter = await repository.listSourceInstructionArtifacts();
    const latestArtifact = artifactsAfter.at(-1);
    const learnedLines = [
      ...(latestArtifact?.navigationGuidance ?? []),
      ...(latestArtifact?.searchGuidance ?? []),
      ...(latestArtifact?.detailGuidance ?? []),
      ...(latestArtifact?.applyGuidance ?? []),
      ...(latestArtifact?.warnings ?? []),
    ].join("\n");

    expect(openSessionCalls).toBe(1);
    expect(closeSessionCalls).toBe(1);
    expect(skipSessionValidationFlags.length).toBeGreaterThan(0);
    expect(skipSessionValidationFlags.every(Boolean)).toBe(true);
    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("failed");
    expect(artifactsAfter).toHaveLength(artifactCountBefore);
    expect(
      snapshot.searchPreferences.discovery.targets.find(
        (target) => target.id === "target_linkedin_default",
      ),
    ).toMatchObject({
      lastVerifiedAt: null,
      validatedInstructionId: null,
      draftInstructionId: null,
      lastDebugRunId: snapshot.recentSourceDebugRuns[0]?.id,
    });
    expect(learnedLines.toLowerCase()).not.toContain("agent runtime failed");
    expect(learnedLines.toLowerCase()).not.toContain("llm call failed");
    expect(learnedLines.toLowerCase()).not.toContain(
      "discovery encountered an error",
    );
  });

  test("closes the browser session after a successful source-debug run by default", async () => {
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_keepalive",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_keepalive",
          title: "Senior Product Designer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: "$180k - $220k",
          summary: "Validate keepalive on a successful source-debug run.",
          description: "Validate keepalive on a successful source-debug run.",
          keySkills: ["Figma", "React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    let openSessionCalls = 0;
    let closeSessionCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      openSession(source, options) {
        void options;
        openSessionCalls += 1;

        return Promise.resolve({
          source,
          status: "ready",
          driver: "catalog_seed",
          label: "Browser session ready",
          detail: "Opened for source debug.",
          lastCheckedAt: "2026-03-20T10:05:00.000Z",
        });
      },
      closeSession(source) {
        closeSessionCalls += 1;
        return Promise.resolve({
          source,
          status: "unknown",
          driver: "catalog_seed",
          label: "Browser session closed",
          detail: "Closed after source debug.",
          lastCheckedAt: "2026-03-20T10:06:00.000Z",
        });
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: createSeed(),
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );

    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("completed");
    expect(openSessionCalls).toBe(1);
    expect(closeSessionCalls).toBe(1);
  });

  test("keeps the browser session open after a successful source-debug run when keepSessionAlive is enabled", async () => {
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_keepalive",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_keepalive",
          title: "Senior Product Designer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: "$180k - $220k",
          summary: "Validate keepalive on a successful source-debug run.",
          description: "Validate keepalive on a successful source-debug run.",
          keySkills: ["Figma", "React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    let openSessionCalls = 0;
    let closeSessionCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      openSession(source, options) {
        void options;
        openSessionCalls += 1;

        return Promise.resolve({
          source,
          status: "ready",
          driver: "catalog_seed",
          label: "Browser session ready",
          detail: "Opened for source debug.",
          lastCheckedAt: "2026-03-20T10:05:00.000Z",
        });
      },
      closeSession(source) {
        closeSessionCalls += 1;
        return Promise.resolve({
          source,
          status: "unknown",
          driver: "catalog_seed",
          label: "Browser session closed",
          detail: "Closed after source debug.",
          lastCheckedAt: "2026-03-20T10:06:00.000Z",
        });
      },
    };
    const seed = createSeed();
    seed.settings.keepSessionAlive = true;
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );

    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("completed");
    expect(openSessionCalls).toBe(1);
    expect(closeSessionCalls).toBe(0);
  });

  test("streams named progress states while source debug is running", async () => {
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_progress",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_progress",
          title: "Senior Product Designer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: "$180k - $220k",
          summary: "Validate progress streaming.",
          description: "Validate progress streaming.",
          keySkills: ["Figma", "React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      async runAgentDiscovery(source, options) {
        options.onProgress?.({
          currentUrl:
            options.startingUrls[0] ?? "https://www.linkedin.com/jobs/",
          jobsFound: 0,
          stepCount: 1,
          currentAction: "thinking",
          message: "Planning the next browser action.",
          waitReason: "waiting_on_ai",
          targetId: null,
          adapterKind: source,
        });
        return baseRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });
    const streamedEvents: SourceDebugProgressEvent[] = [];

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
      undefined,
      (event) => {
        streamedEvents.push(event);
      },
    );

    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("completed");
    expect(
      streamedEvents.some((event) => event.waitReason === "starting_browser"),
    ).toBe(true);
    expect(
      streamedEvents.some((event) => event.waitReason === "waiting_on_ai"),
    ).toBe(true);
    expect(
      streamedEvents.some((event) => event.waitReason === "finalizing"),
    ).toBe(true);
    const latestRunId = snapshot.recentSourceDebugRuns[0]?.id;

    expect(latestRunId).toBeTruthy();

    const latestRun = await workspaceService.getSourceDebugRunDetails(
      latestRunId!,
    );

    expect(
      streamedEvents.some((event) =>
        event.message.includes("Reviewing the collected evidence"),
      ),
    ).toBe(latestRun.run.timing?.finalReviewMs != null);

    expect(latestRun.run.timing?.browserSetupMs).not.toBeNull();
    expect(latestRun.run.timing?.finalizationMs).not.toBeNull();
    expect(
      latestRun.run.timing?.waitReasonDurations.some(
        (entry) => entry.waitReason === "waiting_on_ai",
      ),
    ).toBe(true);
    expect(latestRun.attempts.length).toBeGreaterThan(0);
    expect(latestRun.run.phaseSummaries.length).toBeGreaterThan(0);
    expect(
      latestRun.attempts.every(
        (attempt) => attempt.timing != null && attempt.timing.eventCount > 0,
      ),
    ).toBe(true);
    expect(
      latestRun.run.phaseSummaries.every((summary) => summary.timing !== null),
    ).toBe(true);
  });

  test("runs replay and final review after a completed learning phase", async () => {
    const baseRuntime = createCatalogBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const phaseCalls: string[] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source, options) {
        const phase = options.taskPacket?.phase ?? "replay_verification";
        phaseCalls.push(phase);

        return Promise.resolve(
          createDiscoveryRunResult({
            source,
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:10.000Z",
            querySummary: `Phase ${phase}`,
            warning:
              phase === "access_auth_probe"
                ? "Auth restriction: guest session has limited visibility and sign in is needed for broader access."
                : null,
            jobs: [
              JobPostingSchema.parse({
                source,
                sourceJobId: `job_${phase}`,
                discoveryMethod: "browser_agent",
                canonicalUrl: `https://www.linkedin.com/jobs/view/${phase}`,
                title: "Senior Full Stack Engineer",
                company: "Signal Systems",
                location: "Remote",
                workMode: ["remote"],
                applyPath: "unknown",
                easyApplyEligible: false,
                postedAt: "2026-03-20T09:00:00.000Z",
                postedAtText: null,
                discoveredAt: "2026-03-20T10:04:00.000Z",
                salaryText: null,
                summary: `Evidence from ${phase}`,
                description: `Evidence from ${phase}`,
                keySkills: ["TypeScript"],
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
              }),
            ],
            agentMetadata: {
              steps: 3,
              incomplete: false,
              transcriptMessageCount: 4,
              reviewTranscript: [],
              compactionState: null,
              compactionUsedFallbackTrigger: false,
              phaseCompletionMode: "forced_finish",
              phaseCompletionReason:
                phase === "access_auth_probe"
                  ? "Phase goal satisfied: auth-limited guest surface was proven."
                  : `Phase ${phase} proved enough reusable evidence.`,
              phaseEvidence: null,
              debugFindings: {
                summary:
                  phase === "access_auth_probe"
                    ? "Guest session reaches jobs but broader access is restricted by sign-in prompts."
                    : `Summary for ${phase}`,
                reliableControls:
                  phase === "search_filter_probe"
                    ? ["Search by title control works on the listing route."]
                    : [],
                trickyFilters: [],
                navigationTips:
                  phase === "site_structure_mapping"
                    ? ["Use the recommended jobs collection route first."]
                    : [],
                applyTips: [],
                warnings:
                  phase === "access_auth_probe"
                    ? ["Sign in is needed for broader visibility."]
                    : [],
              },
            },
          }),
        );
      },
    };

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );
    const latestRunId = snapshot.recentSourceDebugRuns[0]?.id;
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);

    expect(phaseCalls).toEqual([
      "site_structure_mapping",
      "replay_verification",
    ]);
    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("completed");
    expect(latestArtifact?.status).toBe("validated");
    expect(latestRunId).toBeTruthy();

    const latestRun = await workspaceService.getSourceDebugRunDetails(
      latestRunId!,
    );

    expect(latestRun.run.timing?.finalReviewMs).not.toBeNull();
    expect(latestRun.attempts.map((attempt) => attempt.phase)).toEqual(
      phaseCalls,
    );
  });

  test("does not skip replay when the learning phase already has enough evidence", async () => {
    const baseRuntime = createCatalogBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const phaseCalls: string[] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source, options) {
        const phase = options.taskPacket?.phase ?? "replay_verification";
        phaseCalls.push(phase);

        return Promise.resolve(
          createDiscoveryRunResult({
            source,
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:10.000Z",
            querySummary: `Phase ${phase}`,
            warning: null,
            jobs: [
              JobPostingSchema.parse({
                source,
                sourceJobId: `job_${phase}`,
                discoveryMethod: "browser_agent",
                canonicalUrl: `https://www.linkedin.com/jobs/view/${phase}`,
                title: "Senior Full Stack Engineer",
                company: "Signal Systems",
                location: "Remote",
                workMode: ["remote"],
                applyPath:
                  phase === "apply_path_validation"
                    ? "external_redirect"
                    : "unknown",
                easyApplyEligible: false,
                postedAt: "2026-03-20T09:00:00.000Z",
                postedAtText: null,
                discoveredAt: "2026-03-20T10:04:00.000Z",
                salaryText: null,
                summary: `Evidence from ${phase}`,
                description: `Evidence from ${phase}`,
                keySkills: ["TypeScript"],
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
              }),
            ],
            agentMetadata: {
              steps: 3,
              incomplete: false,
              transcriptMessageCount: 4,
              reviewTranscript: [],
              compactionState: null,
              compactionUsedFallbackTrigger: false,
              phaseCompletionMode: "forced_finish",
              phaseCompletionReason: `Phase ${phase} proved enough reusable evidence.`,
              phaseEvidence: null,
              debugFindings: {
                summary: `Summary for ${phase}`,
                reliableControls:
                  phase === "search_filter_probe"
                    ? ["Search by title control works on the listing route."]
                    : [],
                trickyFilters: [],
                navigationTips:
                  phase === "site_structure_mapping"
                    ? ["Use the recommended jobs collection route first."]
                    : [],
                applyTips: [],
                warnings: [],
              },
            },
          }),
        );
      },
    };

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );
    const latestRunId = snapshot.recentSourceDebugRuns[0]?.id;
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);

    expect(phaseCalls).toEqual([
      "site_structure_mapping",
      "replay_verification",
    ]);
    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("completed");
    expect(latestArtifact?.status).toBe("validated");
    expect(latestRunId).toBeTruthy();

    const latestRun = await workspaceService.getSourceDebugRunDetails(
      latestRunId!,
    );

    expect(latestRun.run.timing?.finalReviewMs).not.toBeNull();
    expect(latestRun.attempts.map((attempt) => attempt.phase)).toEqual(
      phaseCalls,
    );
  });

  test("skips AI final review for fresh draft instructions when replay verification does not pass", async () => {
    const baseRuntime = createCatalogBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const phaseCalls: string[] = [];
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source, options) {
        const phase = options.taskPacket?.phase ?? "replay_verification";
        phaseCalls.push(phase);

        if (phase === "apply_path_validation") {
          return Promise.resolve(
            createDiscoveryRunResult({
              source,
              startedAt: "2026-03-20T10:00:00.000Z",
              completedAt: "2026-03-20T10:00:10.000Z",
              querySummary: `Phase ${phase}`,
              warning:
                "Apply path was visible but not stable enough to prove yet.",
              jobs: [
                JobPostingSchema.parse({
                  source,
                  sourceJobId: `job_${phase}`,
                  discoveryMethod: "browser_agent",
                  canonicalUrl: `https://www.linkedin.com/jobs/view/${phase}`,
                  title: "Senior Full Stack Engineer",
                  company: "Signal Systems",
                  location: "Remote",
                  workMode: ["remote"],
                  applyPath: "unknown",
                  easyApplyEligible: false,
                  postedAt: "2026-03-20T09:00:00.000Z",
                  postedAtText: null,
                  discoveredAt: "2026-03-20T10:04:00.000Z",
                  salaryText: null,
                  summary: `Evidence from ${phase}`,
                  description: `Evidence from ${phase}`,
                  keySkills: ["TypeScript"],
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
                }),
              ],
              agentMetadata: {
                steps: 3,
                incomplete: false,
                transcriptMessageCount: 4,
                reviewTranscript: [],
                compactionState: null,
                compactionUsedFallbackTrigger: false,
                phaseCompletionMode: "timed_out_with_partial_evidence",
                phaseCompletionReason:
                  "Apply path was visible but not stable enough to prove yet.",
                phaseEvidence: null,
                debugFindings: {
                  summary: "Apply entry still needs replay verification.",
                  reliableControls: [],
                  trickyFilters: [],
                  navigationTips: [],
                  applyTips: [],
                  warnings: [
                    "Apply path was visible but not stable enough to prove yet.",
                  ],
                },
              },
            }),
          );
        }

        if (phase === "replay_verification") {
          return Promise.resolve(
            createDiscoveryRunResult({
              source,
              startedAt: "2026-03-20T10:00:00.000Z",
              completedAt: "2026-03-20T10:00:10.000Z",
              querySummary: `Phase ${phase}`,
              warning:
                "Replay verification could not prove the route from scratch.",
              jobs: [],
              agentMetadata: {
                steps: 3,
                incomplete: true,
                transcriptMessageCount: 4,
                reviewTranscript: [],
                compactionState: null,
                compactionUsedFallbackTrigger: false,
                phaseCompletionMode: "timed_out_with_partial_evidence",
                phaseCompletionReason:
                  "Replay verification could not prove the route from scratch.",
                phaseEvidence: null,
                debugFindings: {
                  summary:
                    "Replay could not reproduce the earlier path cleanly.",
                  reliableControls: [],
                  trickyFilters: [],
                  navigationTips: [],
                  applyTips: [],
                  warnings: [
                    "Replay verification could not prove the route from scratch.",
                  ],
                },
              },
            }),
          );
        }

        return Promise.resolve(
          createDiscoveryRunResult({
            source,
            startedAt: "2026-03-20T10:00:00.000Z",
            completedAt: "2026-03-20T10:00:10.000Z",
            querySummary: `Phase ${phase}`,
            warning: null,
            jobs: [
              JobPostingSchema.parse({
                source,
                sourceJobId: `job_${phase}`,
                discoveryMethod: "browser_agent",
                canonicalUrl: `https://www.linkedin.com/jobs/view/${phase}`,
                title: "Senior Full Stack Engineer",
                company: "Signal Systems",
                location: "Remote",
                workMode: ["remote"],
                applyPath: "unknown",
                easyApplyEligible: false,
                postedAt: "2026-03-20T09:00:00.000Z",
                postedAtText: null,
                discoveredAt: "2026-03-20T10:04:00.000Z",
                salaryText: null,
                summary: `Evidence from ${phase}`,
                description: `Evidence from ${phase}`,
                keySkills: ["TypeScript"],
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
              }),
            ],
            agentMetadata: {
              steps: 3,
              incomplete: false,
              transcriptMessageCount: 4,
              reviewTranscript: [],
              compactionState: null,
              compactionUsedFallbackTrigger: false,
              phaseCompletionMode: "forced_finish",
              phaseCompletionReason: `Phase ${phase} proved enough reusable evidence.`,
              phaseEvidence: null,
              debugFindings: {
                summary: `Summary for ${phase}`,
                reliableControls:
                  phase === "search_filter_probe"
                    ? ["Search by title control works on the listing route."]
                    : [],
                trickyFilters: [],
                navigationTips:
                  phase === "site_structure_mapping"
                    ? ["Use the recommended jobs collection route first."]
                    : [],
                applyTips: [],
                warnings: [],
              },
            },
          }),
        );
      },
    };

    const { repository, workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.runSourceDebug(
      "target_linkedin_default",
    );
    const latestRunId = snapshot.recentSourceDebugRuns[0]?.id;
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);

    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("failed");
    expect(latestArtifact?.status).toBe("draft");
    expect(latestRunId).toBeTruthy();

    const latestRun = await workspaceService.getSourceDebugRunDetails(
      latestRunId!,
    );

    expect(phaseCalls).toEqual([
      "site_structure_mapping",
      "replay_verification",
    ]);
    expect(latestRun.run.timing?.finalReviewMs).toBeNull();
    expect(latestRun.attempts.map((attempt) => attempt.phase)).toEqual(
      phaseCalls,
    );
  });

  test("rejects starting a second source-debug run while one is already active", async () => {
    let releaseFirstRun!: () => void;
    const firstRunBlocked = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_concurrent",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_concurrent",
          title: "Staff Product Designer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: "$180k - $220k",
          summary: "Validate stable job detail routes.",
          description: "Validate stable job detail routes.",
          keySkills: ["Figma", "React"],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    let runCalls = 0;
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      async runAgentDiscovery(source, options) {
        runCalls += 1;
        if (runCalls === 1) {
          await firstRunBlocked;
        }
        return baseRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        savedJobs: [],
        tailoredAssets: [],
      },
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    const firstRunPromise = workspaceService.runSourceDebug(
      "target_linkedin_default",
    );
    await Promise.resolve();

    await expect(
      workspaceService.runSourceDebug("target_linkedin_default"),
    ).rejects.toThrow(/already in progress/i);

    releaseFirstRun();
    const snapshot = await firstRunPromise;

    expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("completed");
  });
});

test("cancellation with an ordinary runtime error does not mark a healthy source broken", async () => {
  const controller = new AbortController();
  const base = createCatalogBrowserSessionRuntime({
    sessions: [],
    catalog: [],
  });
  const { workspaceService } = createWorkspaceServiceHarness({
    seed: createSeed(),
    aiClient: createAgentAiClient(),
    browserRuntime: {
      ...base,
      runAgentDiscovery: () => {
        controller.abort();
        return Promise.reject(new Error("The operation was stopped"));
      },
    },
  });
  const snapshot = await workspaceService.runSourceDebug(
    "target_linkedin_default",
    controller.signal,
  );
  expect(snapshot.recentSourceDebugRuns[0]?.state).toBe("cancelled");
  expect(
    snapshot.searchPreferences.discovery.targets[0]?.staleReason,
  ).toBeNull();
});
