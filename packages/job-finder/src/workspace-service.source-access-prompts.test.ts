import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { describe, expect, test, vi } from "vitest";
import {
  createAgentAiClient,
  createSeed,
  createSourceInstructionArtifact,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService source access prompts", () => {
  test("derives a login-required source access prompt from a paused manual auth blocker", async () => {
    const seed = createSeed();
    const linkedinTarget = seed.searchPreferences.discovery.targets[0];
    if (!linkedinTarget) {
      throw new Error("Expected the default LinkedIn target in the test seed.");
    }
    seed.searchPreferences.discovery.targets[0] = {
      ...linkedinTarget,
      label: "LinkedIn",
      lastDebugRunId: "source_debug_run_login_required",
    };
    seed.sourceDebugRuns = [
      {
        id: "source_debug_run_login_required",
        targetId: "target_linkedin_default",
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
        targetLabel: "LinkedIn",
        targetUrl: "https://www.linkedin.com/jobs/search/",
        targetHostname: "www.linkedin.com",
        manualPrerequisiteSummary: "Please sign in first.",
        finalSummary: "Manual login is required before discovery can continue.",
        attemptIds: ["attempt_login_required"],
        phaseSummaries: [],
        instructionArtifactId: null,
        timing: null,
      },
    ];
    seed.discovery = {
      ...seed.discovery,
      recentSourceDebugRuns: seed.sourceDebugRuns,
      activeSourceDebugRun: seed.sourceDebugRuns[0] ?? null,
    };
    seed.sourceDebugAttempts = [
      {
        id: "attempt_login_required",
        runId: "source_debug_run_login_required",
        targetId: "target_linkedin_default",
        phase: "access_auth_probe",
        startedAt: "2026-03-20T10:00:00.000Z",
        completedAt: "2026-03-20T10:01:00.000Z",
        outcome: "blocked_auth",
        completionMode: "blocked_auth",
        completionReason: "Please sign in first.",
        strategyLabel: "Access auth probe",
        strategyFingerprint: "access_auth_probe:target_site:default",
        confirmedFacts: [],
        attemptedActions: [],
        blockerSummary: "Please sign in first.",
        resultSummary:
          "Login wall blocks further discovery until the user signs in.",
        confidenceScore: 86,
        nextRecommendedStrategies: [],
        avoidStrategyFingerprints: [],
        evidenceRefIds: [],
        phaseEvidence: null,
        visualEvidence: [],
        compactionState: null,
        timing: null,
      },
    ];

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.getWorkspaceSnapshot();

    expect(snapshot.sourceAccessPrompts).toEqual([
      expect.objectContaining({
        targetId: "target_linkedin_default",
        targetLabel: "LinkedIn",
        state: "prompt_login_required",
        detail: "Please sign in first.",
      }),
    ]);
  });

  test("derives a login-recommended prompt from auth-limited but job-bearing source evidence", async () => {
    const seed = createSeed();
    const linkedinTarget = seed.searchPreferences.discovery.targets[0];
    if (!linkedinTarget) {
      throw new Error("Expected the default LinkedIn target in the test seed.");
    }
    seed.searchPreferences.discovery.targets[0] = {
      ...linkedinTarget,
      label: "LinkedIn",
      lastDebugRunId: "source_debug_run_login_recommended",
      draftInstructionId: "instruction_login_recommended",
      instructionStatus: "draft",
    };
    seed.sourceDebugRuns = [
      {
        id: "source_debug_run_login_recommended",
        targetId: "target_linkedin_default",
        state: "completed",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:02:00.000Z",
        completedAt: "2026-03-20T10:02:00.000Z",
        activePhase: null,
        phases: [
          "access_auth_probe",
          "site_structure_mapping",
          "search_filter_probe",
          "job_detail_validation",
        ],
        targetLabel: "LinkedIn",
        targetUrl: "https://www.linkedin.com/jobs/search/",
        targetHostname: "www.linkedin.com",
        manualPrerequisiteSummary: null,
        finalSummary:
          "Guest session reaches jobs but broader access is restricted by sign-in prompts.",
        attemptIds: ["attempt_login_recommended"],
        phaseSummaries: [],
        instructionArtifactId: "instruction_login_recommended",
        timing: null,
      },
    ];
    seed.discovery = {
      ...seed.discovery,
      recentSourceDebugRuns: seed.sourceDebugRuns,
      activeSourceDebugRun: null,
    };
    seed.sourceDebugAttempts = [
      {
        id: "attempt_login_recommended",
        runId: "source_debug_run_login_recommended",
        targetId: "target_linkedin_default",
        phase: "access_auth_probe",
        startedAt: "2026-03-20T10:00:00.000Z",
        completedAt: "2026-03-20T10:01:00.000Z",
        outcome: "succeeded",
        completionMode: "forced_finish",
        completionReason: "Auth-limited guest surface was proven.",
        strategyLabel: "Access auth probe",
        strategyFingerprint: "access_auth_probe:target_site:default",
        confirmedFacts: [
          "Guest session reaches jobs but broader access is restricted by sign-in prompts.",
        ],
        attemptedActions: [],
        blockerSummary: null,
        resultSummary:
          "Guest session reaches jobs but broader access is restricted by sign-in prompts.",
        confidenceScore: 84,
        nextRecommendedStrategies: [],
        avoidStrategyFingerprints: [],
        evidenceRefIds: [],
        phaseEvidence: {
          visibleControls: [],
          successfulInteractions: [],
          routeSignals: [],
          attemptedControls: [],
          warnings: ["Sign in is needed for broader access."],
          visualFindings: [],
        },
        visualEvidence: [],
        compactionState: null,
        timing: null,
      },
    ];
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_login_recommended",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:01:00.000Z",
        updatedAt: "2026-03-20T10:02:00.000Z",
        acceptedAt: null,
        basedOnRunId: "source_debug_run_login_recommended",
        basedOnAttemptIds: ["attempt_login_recommended"],
        notes: null,
        navigationGuidance: ["Use the jobs homepage or search route first."],
        searchGuidance: [
          "Guest session reaches jobs, but sign in is needed for broader access.",
        ],
        detailGuidance: [],
        applyGuidance: [],
        warnings: ["Sign in is needed for broader access."],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "target_site-adapter-v1",
          appSchemaVersion: "v1",
        },
        verification: null,
        intelligence: {
          provider: null,
          collection: {
            preferredMethod: "listing_route",
            rankedMethods: ["listing_route", "fallback_search"],
            startingRoutes: [
              {
                url: "https://www.linkedin.com/jobs/search/",
                label: "Jobs search",
                kind: "search",
                confidence: 0.82,
              },
            ],
            searchRouteTemplates: [
              {
                url: "https://www.linkedin.com/jobs/search/",
                label: "Jobs search",
                kind: "search",
                confidence: 0.82,
              },
            ],
            detailRoutePatterns: [],
            listingMarkers: [],
          },
          apply: {
            applyPath: "unknown",
            authMarkers: ["Sign in is needed for broader access."],
            consentMarkers: [],
            questionSurfaceHints: [],
            resumeUploadHints: [],
          },
          reliability: {
            selectorFingerprints: [],
            stableControlNames: [],
            failureFingerprints: [],
            verifiedAt: null,
            freshnessNotes: [],
          },
          overrides: {
            forceMethod: null,
            deniedRoutePatterns: [],
            extraStartingRoutes: [
              "https://www.linkedin.com/jobs/collections/recommended/",
            ],
          },
        },
      }),
    ];

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: createAgentAiClient(),
    });

    const snapshot = await workspaceService.getWorkspaceSnapshot();

    expect(snapshot.sourceAccessPrompts).toEqual([
      expect.objectContaining({
        targetId: "target_linkedin_default",
        targetUrl: "https://www.linkedin.com/jobs/collections/recommended/",
        state: "prompt_login_recommended",
        summary:
          "Open the Job Finder browser for LinkedIn if you want better search coverage on the next run.",
        actionLabel: "Open the Job Finder browser for LinkedIn",
      }),
    ]);
  });

  test("opens the browser session at the resolved source entry url for a targeted sign-in action", async () => {
    const openSession = vi.fn(
      (source: string, options?: { targetUrl?: string | null }) =>
        Promise.resolve({
          source: source as "target_site",
          status: "ready" as const,
          driver: "catalog_seed" as const,
          label: "Browser session ready",
          detail: options?.targetUrl ?? null,
          lastCheckedAt: "2026-03-20T10:05:00.000Z",
        }),
    );
    const browserRuntime: BrowserSessionRuntime = {
      closeSession: vi.fn(),
      executeApplicationFlow: vi.fn(),
      executeEasyApply: vi.fn(),
      getSessionState: vi.fn(),
      openSession,
      runDiscovery: vi.fn(),
    };
    const seed = createSeed();
    const linkedinTarget = seed.searchPreferences.discovery.targets[0];
    if (!linkedinTarget) {
      throw new Error("Expected the default LinkedIn target in the test seed.");
    }
    seed.searchPreferences.discovery.targets[0] = {
      ...linkedinTarget,
      label: "LinkedIn",
      draftInstructionId: "instruction_targeted_open",
      instructionStatus: "draft",
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_targeted_open",
        targetId: "target_linkedin_default",
        status: "draft",
        createdAt: "2026-03-20T10:01:00.000Z",
        updatedAt: "2026-03-20T10:02:00.000Z",
        acceptedAt: null,
        basedOnRunId: "run_targeted_open",
        basedOnAttemptIds: ["attempt_targeted_open"],
        notes: null,
        navigationGuidance: [],
        searchGuidance: [],
        detailGuidance: [],
        applyGuidance: [],
        warnings: [],
        versionInfo: {
          promptProfileVersion: "v1",
          toolsetVersion: "v1",
          adapterVersion: "target_site-adapter-v1",
          appSchemaVersion: "v1",
        },
        verification: null,
        intelligence: {
          provider: null,
          collection: {
            preferredMethod: "listing_route",
            rankedMethods: ["listing_route", "fallback_search"],
            startingRoutes: [
              {
                url: "https://www.linkedin.com/jobs/collections/recommended/",
                label: "Recommended jobs",
                kind: "collection",
                confidence: 0.83,
              },
            ],
            searchRouteTemplates: [
              {
                url: "https://www.linkedin.com/jobs/search/",
                label: "Jobs search",
                kind: "search",
                confidence: 0.8,
              },
            ],
            detailRoutePatterns: [],
            listingMarkers: [],
          },
          apply: {
            applyPath: "unknown",
            authMarkers: [],
            consentMarkers: [],
            questionSurfaceHints: [],
            resumeUploadHints: [],
          },
          reliability: {
            selectorFingerprints: [],
            stableControlNames: [],
            failureFingerprints: [],
            verifiedAt: null,
            freshnessNotes: [],
          },
          overrides: {
            forceMethod: null,
            deniedRoutePatterns: [],
            extraStartingRoutes: [
              "https://www.linkedin.com/jobs/collections/recommended/",
            ],
          },
        },
      }),
    ];

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await workspaceService.openBrowserSession({
      targetId: "target_linkedin_default",
    });

    expect(openSession).toHaveBeenCalledWith("target_site", {
      targetUrl: "https://www.linkedin.com/jobs/collections/recommended/",
    });
  });

  test("persists blocked browser status when a targeted browser open fails", async () => {
    const openSession = vi.fn(() =>
      Promise.reject(new Error("navigation failed")),
    );
    const getSessionState = vi.fn(() =>
      Promise.resolve({
        source: "target_site" as const,
        status: "blocked" as const,
        driver: "chrome_profile_agent" as const,
        label: "Browser navigation failed",
        detail: "navigation failed",
        lastCheckedAt: "2026-03-20T10:05:00.000Z",
      }),
    );
    const browserRuntime: BrowserSessionRuntime = {
      closeSession: vi.fn(),
      executeApplicationFlow: vi.fn(),
      executeEasyApply: vi.fn(),
      runDiscovery: vi.fn(),
      openSession,
      getSessionState,
    };
    const seed = createSeed();
    const linkedinTarget = seed.searchPreferences.discovery.targets[0];
    if (!linkedinTarget) {
      throw new Error("Expected the default LinkedIn target in the test seed.");
    }

    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      browserRuntime,
      aiClient: createAgentAiClient(),
    });

    await expect(
      workspaceService.openBrowserSession({
        targetId: linkedinTarget.id,
      }),
    ).rejects.toThrow("navigation failed");

    const snapshot = await workspaceService.getWorkspaceSnapshot();

    expect(getSessionState).toHaveBeenCalledWith("target_site");
    expect(snapshot.browserSession).toMatchObject({
      status: "blocked",
      label: "Browser navigation failed",
      detail: "navigation failed",
    });
  });
});
