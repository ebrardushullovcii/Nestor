import {
  ResumeImportRunSchema,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { buildJobFinderPerformanceSnapshot } from "./performance-evidence";

type EvidenceWorkspace = Pick<
  JobFinderWorkspaceSnapshot,
  "latestResumeImportRun"
>;

const startedAt = "2026-08-09T10:00:00.000Z";
const completedAt = "2026-08-09T10:00:08.000Z";

function createWorkspace(): EvidenceWorkspace {

  return {
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
    // Searches run on the job store; the old run timings are gone.
    expect(byArea.get("discovery")).toMatchObject({
      measurementStatus: "unavailable",
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

});

