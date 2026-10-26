import { describe, expect, it } from "vitest";
import type {
  JobFinderPerformanceSnapshot,
  JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { buildJobFinderDiagnosticExport } from "./build-diagnostic-export";

const secretCorpus = [
  "hunter2-secret-password",
  "C:\\Users\\person\\private-resume.pdf",
  "https://jobs.example/apply?token=super-secret",
  "raw resume body private payload",
  "data:image/png;base64,screenshot-secret",
  "transcript audio bytes",
  "browser-local-storage-secret",
];

function createWorkspace(): JobFinderWorkspaceSnapshot {
  return {
    profileSetupState: { status: "completed" },
    browserSession: { status: "ready", detail: secretCorpus[6] },
    searchPreferences: {
      discovery: { targets: [{ secret: secretCorpus[2] }] },
    },
    discoveryJobs: [{ description: secretCorpus[3] }],
    reviewQueue: [],
    applicationRecords: [],
    applicationAttempts: [
      {
        executionTimings: [{ stage: "total", durationMs: 123 }],
        visualEvidence: [{ dataUrl: secretCorpus[4] }],
      },
    ],
    userActionRequests: [{ state: "resolved", credential: secretCorpus[0] }],
    userActionEvents: [{}],
    agentProvider: {
      ready: true,
      baseUrl: secretCorpus[2],
      detail: secretCorpus[0],
    },
    visionProvider: { ready: false, detail: secretCorpus[4] },
    latestResumeImportRun: {
      state: "completed",
      timing: { totalMs: 456 },
      sourcePath: secretCorpus[1],
      extractedText: secretCorpus[3],
    },
    resumeExportArtifacts: [{ filePath: secretCorpus[1] }],
    applyJobResults: [{}],
    recentSourceDebugRuns: [{}],
  } as unknown as JobFinderWorkspaceSnapshot;
}

const performance = {
  generatedAt: "2026-07-31T12:00:00.000Z",
  latestDiscoveryRun: { summary: { durationMs: 789 } },
  latestSourceDebugRun: { rawEvidence: secretCorpus.join("|") },
  budgetEvaluations: [
    {
      id: "first-visible-p95",
      status: "warning",
      unit: "milliseconds",
      observed: 4_000,
      limit: 3_000,
      sampleCount: 1,
      minimumSamples: 5,
      detail: secretCorpus.join("|"),
    },
  ],
  evidence: [
    {
      area: "discovery",
      measurementStatus: "available",
      durationMs: 789,
      recordedAt: "2026-07-31T12:00:00.000Z",
      method: "discovery_run",
      sampleCount: 1,
      budgetStatus: "warning",
      budgetEvaluationIds: ["first-visible-p95"],
      stageDurations: [{ id: "discovery.extraction", durationMs: 500 }],
    },
    {
      area: "renderer_commit",
      measurementStatus: "unavailable",
      durationMs: null,
      recordedAt: null,
      method: "none",
      sampleCount: 0,
      budgetStatus: "unavailable",
      budgetEvaluationIds: [],
      stageDurations: [],
      unavailableReason: "no_recorded_measurement",
    },
  ],
} as unknown as JobFinderPerformanceSnapshot;

describe("buildJobFinderDiagnosticExport", () => {
  it("exports only aggregate allowlisted diagnostics and a truthful manifest", () => {
    const diagnostic = buildJobFinderDiagnosticExport({
      workspace: createWorkspace(),
      performance,
      generatedAt: "2026-07-31T12:00:00.000Z",
      build: {
        appVersion: "0.1.0",
        electronVersion: "37.0.0",
        chromiumVersion: "138.0.0",
        nodeVersion: "22.0.0",
        platform: "win32",
        architecture: "x64",
      },
    });

    expect(diagnostic.timings).toEqual({
      latestDiscoveryDurationMs: 789,
      latestResumeImportDurationMs: 456,
      latestApplyDurationMs: 123,
    });
    expect(diagnostic.performance).toEqual({
      measurements: [
        {
          area: "discovery",
          measurementStatus: "available",
          durationMs: 789,
          recordedAt: "2026-07-31T12:00:00.000Z",
          sampleCount: 1,
          budgetStatus: "warning",
          stageDurations: [{ id: "discovery.extraction", durationMs: 500 }],
        },
        {
          area: "renderer_commit",
          measurementStatus: "unavailable",
          durationMs: null,
          recordedAt: null,
          sampleCount: 0,
          budgetStatus: "unavailable",
          stageDurations: [],
        },
      ],
      budgetEvaluations: [
        {
          id: "first-visible-p95",
          status: "warning",
          unit: "milliseconds",
          observed: 4_000,
          limit: 3_000,
          sampleCount: 1,
          minimumSamples: 5,
        },
      ],
    });
    expect(diagnostic.redactionManifest).toMatchObject({
      policy: "strict_allowlist_v1",
      localOnly: true,
      transmitted: false,
    });
    expect(diagnostic.capabilities).toMatchObject({
      finalSubmissionAuthorized: false,
      accountCreationAuthorized: false,
    });
    const serialized = JSON.stringify(diagnostic);
    for (const secret of secretCorpus) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain("baseUrl");
    expect(serialized).not.toContain("visualEvidence");
  });

  it("does not copy warning detail or arbitrary warning payloads", () => {
    const diagnostic = buildJobFinderDiagnosticExport({
      workspace: createWorkspace(),
      performance,
      build: {
        appVersion: "0.1.0",
        electronVersion: "37.0.0",
        chromiumVersion: "138.0.0",
        nodeVersion: "22.0.0",
        platform: "win32",
        architecture: "x64",
      },
    });
    expect(diagnostic.warnings).toEqual([
      {
        category: "performance_budget",
        code: "performance_budget_1",
        status: "warning",
      },
      {
        category: "provider_availability",
        code: "vision_not_ready",
        status: "warning",
      },
    ]);
  });
});

it("exports waiting form memory without page contents", () => {
  const memory = {
    recordedAt: performance.generatedAt,
    budgetBytes: 805306368,
    totalBytes: 1024,
    measurementComplete: true,
    overBudget: false,
    tabs: [
      {
        tabId: "synthetic",
        processId: 42,
        processBytes: 1024,
        backgroundThrottled: true,
      },
    ],
  };
  const result = buildJobFinderDiagnosticExport({
    workspace: createWorkspace(),
    performance: { ...performance, waitingFormMemory: memory },
    build: {
      appVersion: "test",
      electronVersion: "test",
      chromiumVersion: "test",
      nodeVersion: "test",
      platform: "darwin",
      architecture: "arm64",
    },
    generatedAt: performance.generatedAt,
  });
  expect(result.performance.waitingFormMemory).toEqual(memory);
});
