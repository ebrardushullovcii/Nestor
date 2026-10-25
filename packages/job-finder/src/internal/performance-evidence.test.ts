import {
  ApplicationAttemptSchema,
  DiscoveryRunRecordSchema,
  ResumeImportRunSchema,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { buildJobFinderPerformanceSnapshot } from "./performance-evidence";

type EvidenceWorkspace = Pick<
  JobFinderWorkspaceSnapshot,
  | "activeDiscoveryRun"
  | "applicationAttempts"
  | "latestResumeImportRun"
  | "recentDiscoveryRuns"
>;

const startedAt = "2026-08-09T10:00:00.000Z";
const completedAt = "2026-08-09T10:00:08.000Z";

function createWorkspace(): EvidenceWorkspace {
  const discoveryRun = DiscoveryRunRecordSchema.parse({
    id: "discovery-performance",
    state: "completed",
    startedAt,
    completedAt,
    targetIds: ["public-provider"],
    summary: {
      durationMs: 4_500,
      timing: {
        totalDurationMs: 4_500,
        firstActivityMs: 0,
        firstCandidateMs: 1_200,
        firstDistinctUsefulJobMs: 4_000,
        longestGapMs: 700,
        eventCount: 5,
        stageDurations: [
          { stage: "planning", durationMs: 300 },
          { stage: "extraction", durationMs: 2_100 },
          { stage: "persistence", durationMs: 600 },
        ],
      },
    },
  });

  return {
    activeDiscoveryRun: null,
    recentDiscoveryRuns: [discoveryRun],
    latestResumeImportRun: ResumeImportRunSchema.parse({
      id: "resume-import-performance",
      sourceResumeId: "resume-1",
      sourceResumeFileName: "candidate.pdf",
      status: "review_ready",
      startedAt,
      completedAt,
      timing: {
        totalMs: 0,
        textBranchMs: 0,
        literalExtractionMs: 0,
        reconciliationMs: 0,
        finalizationMs: 0,
        textStages: [
          {
            stage: "experience",
            status: "completed",
            durationMs: 0,
          },
        ],
      },
    }),
    applicationAttempts: [
      ApplicationAttemptSchema.parse({
        id: "attempt-performance",
        jobId: "job-1",
        state: "paused",
        summary: "Prepared without final submission.",
        detail: "Stopped at the final safe checkpoint.",
        startedAt,
        updatedAt: completedAt,
        completedAt,
        outcome: "approved",
        nextActionLabel: null,
        executionTimings: [
          {
            stage: "browser_preparation",
            startedAt,
            completedAt: "2026-08-09T10:00:02.000Z",
            durationMs: 2_000,
          },
          {
            stage: "form_preparation",
            startedAt: "2026-08-09T10:00:02.000Z",
            completedAt: "2026-08-09T10:00:07.000Z",
            durationMs: 5_000,
          },
          {
            stage: "total",
            startedAt,
            completedAt,
            durationMs: 8_000,
          },
        ],
      }),
    ],
  };
}

describe("buildJobFinderPerformanceSnapshot", () => {
  it("compares measured workflow stages without treating a measured zero as unavailable", () => {
    const snapshot = buildJobFinderPerformanceSnapshot({
      workspace: createWorkspace(),
      latestSourceDebugRun: null,
      generatedAt: completedAt,
      runtimeObservations: [
        {
          area: "persistence",
          durationMs: 12,
          recordedAt: completedAt,
          stageDurations: [
            {
              id: "persistence.workspace_snapshot_read",
              durationMs: 12,
            },
          ],
        },
      ],
    });
    const byArea = new Map(
      snapshot.evidence.map((entry) => [entry.area, entry]),
    );

    expect(byArea.get("resume_import")).toMatchObject({
      measurementStatus: "available",
      durationMs: 0,
      budgetStatus: "not_evaluated",
    });
    expect(byArea.get("discovery")).toMatchObject({
      measurementStatus: "available",
      durationMs: 4_500,
      budgetStatus: "warning",
    });
    expect(byArea.get("application_preparation")).toMatchObject({
      measurementStatus: "available",
      durationMs: 8_000,
    });
    expect(byArea.get("persistence")).toMatchObject({
      measurementStatus: "available",
      durationMs: 12,
      method: "runtime_observation",
    });
    expect(byArea.get("resume_generation")).toMatchObject({
      measurementStatus: "unavailable",
      durationMs: null,
      budgetStatus: "unavailable",
    });
    expect(byArea.get("ipc")?.durationMs).toBeNull();
    expect(byArea.get("renderer_commit")?.durationMs).toBeNull();
  });

  it("marks stage-only telemetry partial instead of inventing a total", () => {
    const workspace = createWorkspace();
    workspace.latestResumeImportRun = ResumeImportRunSchema.parse({
      ...workspace.latestResumeImportRun,
      timing: {
        ...workspace.latestResumeImportRun?.timing,
        totalMs: null,
      },
    });
    workspace.applicationAttempts = [
      ApplicationAttemptSchema.parse({
        ...workspace.applicationAttempts[0],
        executionTimings:
          workspace.applicationAttempts[0]?.executionTimings.filter(
            (timing) => timing.stage !== "total",
          ),
      }),
    ];

    const snapshot = buildJobFinderPerformanceSnapshot({
      workspace,
      latestSourceDebugRun: null,
      generatedAt: completedAt,
    });
    const byArea = new Map(
      snapshot.evidence.map((entry) => [entry.area, entry]),
    );

    expect(byArea.get("resume_import")).toMatchObject({
      measurementStatus: "partial",
      durationMs: null,
      unavailableReason: "total_not_recorded",
    });
    expect(byArea.get("application_preparation")).toMatchObject({
      measurementStatus: "partial",
      durationMs: null,
      unavailableReason: "total_not_recorded",
    });
  });

  it("aggregates generation, IPC, and renderer observations into the same ordered snapshot", () => {
    const snapshot = buildJobFinderPerformanceSnapshot({
      workspace: createWorkspace(),
      latestSourceDebugRun: null,
      generatedAt: completedAt,
      runtimeObservations: [
        {
          area: "resume_generation",
          durationMs: 3_200,
          recordedAt: completedAt,
          stageDurations: [
            { id: "resume_generation.provider", durationMs: 2_500 },
            { id: "resume_generation.grounding", durationMs: 400 },
            { id: "resume_generation.render", durationMs: 300 },
          ],
        },
        {
          area: "ipc",
          durationMs: 14,
          recordedAt: completedAt,
          stageDurations: [
            { id: "ipc.workspace_round_trip", durationMs: 14 },
          ],
        },
        {
          area: "renderer_commit",
          durationMs: 7,
          recordedAt: completedAt,
          stageDurations: [
            { id: "renderer.discovery_results_commit", durationMs: 7 },
          ],
        },
      ],
    });

    expect(snapshot.evidence.map((entry) => entry.area)).toEqual([
      "resume_import",
      "resume_generation",
      "discovery",
      "application_preparation",
      "persistence",
      "ipc",
      "renderer_commit",
    ]);
    expect(snapshot.evidence[1]).toMatchObject({
      measurementStatus: "available",
      durationMs: 3_200,
      stageDurations: [
        { id: "resume_generation.provider", durationMs: 2_500 },
        { id: "resume_generation.grounding", durationMs: 400 },
        { id: "resume_generation.render", durationMs: 300 },
      ],
    });
    expect(snapshot.evidence[5]).toMatchObject({
      measurementStatus: "available",
      durationMs: 14,
    });
    expect(snapshot.evidence[6]).toMatchObject({
      measurementStatus: "available",
      durationMs: 7,
    });
  });

  it("returns an explicit unavailable entry for every area when no timing exists", () => {
    const snapshot = buildJobFinderPerformanceSnapshot({
      workspace: {
        activeDiscoveryRun: null,
        recentDiscoveryRuns: [],
        latestResumeImportRun: null,
        applicationAttempts: [],
      },
      latestSourceDebugRun: null,
      generatedAt: completedAt,
    });

    expect(snapshot.evidence).toHaveLength(7);
    expect(
      snapshot.evidence.every(
        (entry) =>
          entry.measurementStatus === "unavailable" &&
          entry.durationMs === null &&
          entry.sampleCount === 0,
      ),
    ).toBe(true);
  });
});

it("passes persisted form-agent timings to Settings beside the existing workflow stages", () => {
  const workspace = createWorkspace();
  const agentTiming = {
    totalMs: 4200,
    modelMs: 3000,
    modelTurns: 3,
    auxiliaryModelMs: 400,
    auxiliaryModelCalls: 2,
    toolMs: 1000,
    pageReadMs: 300,
    pageReads: 12,
    writeMs: 100,
    uploadMs: 50,
    longestSteps: [{ toolName: "fill_fields", durationMs: 600 }],
    requests: [{ turn: 1, historyChars: 15000, observationChars: 2000 }],
  };
  workspace.applicationAttempts[0]!.agentTiming = agentTiming;
  const snapshot = buildJobFinderPerformanceSnapshot({
    workspace,
    latestSourceDebugRun: null,
    generatedAt: completedAt,
  });
  const evidence = snapshot.evidence.find(
    (entry) => entry.area === "application_preparation",
  );
  expect(evidence).toMatchObject({ durationMs: 8000, agentTiming });
  expect(evidence?.stageDurations).toHaveLength(2);
});
