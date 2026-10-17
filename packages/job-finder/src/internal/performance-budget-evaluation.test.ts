import { DiscoveryRunRecordSchema } from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  buildDiscoveryPerformanceBudgetEvaluations,
  evaluatePerformanceBudget,
} from "./performance-budget-evaluation";
import { finalizeDiscoveryRun } from "./workspace-discovery-run-helpers";

describe("evaluatePerformanceBudget", () => {
  it("passes a deterministic result at the ten-percent boundary", () => {
    const result = evaluatePerformanceBudget({
      id: "score-20",
      label: "Twenty-job scoring",
      kind: "deterministic_regression",
      unit: "milliseconds",
      baseline: 100,
      observed: 110,
    });

    expect(result.status).toBe("pass");
    expect(result.limit).toBeCloseTo(110);
    expect(result.regressionPercent).toBeCloseTo(10);
  });

  it("fails a deterministic regression over ten percent", () => {
    const result = evaluatePerformanceBudget({
      id: "score-20",
      label: "Twenty-job scoring",
      kind: "deterministic_regression",
      unit: "milliseconds",
      baseline: 100,
      observed: 111,
    });

    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/exceeds the deterministic limit/i);
  });

  it("warns instead of failing a live miss with too few samples", () => {
    const result = evaluatePerformanceBudget({
      id: "first-visible",
      label: "First visible result",
      kind: "live_slo",
      unit: "milliseconds",
      limit: 3_000,
      observed: 3_400,
      sampleCount: 2,
      minimumSamples: 5,
    });

    expect(result.status).toBe("warning");
    expect(result.detail).toMatch(/only 2 of 5/i);
  });

  it("fails a live miss once the sample floor is met", () => {
    const result = evaluatePerformanceBudget({
      id: "first-visible",
      label: "First visible result",
      kind: "live_slo",
      unit: "milliseconds",
      limit: 3_000,
      observed: 3_400,
      sampleCount: 5,
      minimumSamples: 5,
    });

    expect(result.status).toBe("fail");
  });

  it("passes an in-budget live sample even before the sample floor", () => {
    const result = evaluatePerformanceBudget({
      id: "api-p95",
      label: "API source p95",
      kind: "live_slo",
      unit: "milliseconds",
      limit: 5_000,
      observed: 4_500,
      sampleCount: 1,
      minimumSamples: 5,
    });

    expect(result.status).toBe("pass");
  });
  it("turns low-sample discovery SLO misses into typed warnings", () => {
    const now = "2026-07-30T12:00:00.000Z";
    const run = DiscoveryRunRecordSchema.parse({
      id: "run-1",
      state: "completed",
      startedAt: now,
      completedAt: now,
      targetIds: ["api", "browser"],
      summary: {
        timing: {
          totalDurationMs: 35_000,
          firstActivityMs: 0,
          firstCandidateMs: 2_000,
          firstDistinctUsefulJobMs: 4_000,
          longestGapMs: 31_000,
          eventCount: 4,
        },
      },
      targetExecutions: [
        {
          targetId: "api",
          adapterKind: "auto",
          collectionMethod: "api",
          state: "completed",
          timing: {
            totalDurationMs: 6_000,
            firstActivityMs: 3_500,
            longestGapMs: 1_000,
            eventCount: 2,
          },
        },
        {
          targetId: "browser",
          adapterKind: "auto",
          collectionMethod: "listing_route",
          state: "completed",
          timing: {
            totalDurationMs: 35_000,
            firstActivityMs: 4_000,
            longestGapMs: 31_000,
            eventCount: 3,
          },
        },
      ],
    });

    const evaluations = buildDiscoveryPerformanceBudgetEvaluations([run]);

    expect(evaluations.map((entry) => [entry.id, entry.status])).toEqual([
      ["discovery-first-distinct-useful-job-p95", "warning"],
      ["discovery-api-duration-p95", "warning"],
      ["discovery-browser-gap-p95", "warning"],
    ]);
    expect(evaluations[0]?.observed).toBe(4_000);
    expect(evaluations[0]?.sampleCount).toBe(1);
  });

  it("aggregates distinct recent completed runs and ignores cancelled duplicates", () => {
    const now = "2026-07-30T12:00:00.000Z";
    const completedRuns = Array.from({ length: 5 }, (_, index) =>
      DiscoveryRunRecordSchema.parse({
        id: `run-${index}`,
        state: "completed",
        startedAt: now,
        completedAt: now,
        targetIds: [`api-${index}`],
        summary: {
          timing: {
            totalDurationMs: 5_500 + index,
            firstActivityMs: 0,
            firstCandidateMs: 1_500 + index,
            firstDistinctUsefulJobMs: 3_500 + index,
            longestGapMs: 500,
            eventCount: 4,
          },
        },
        targetExecutions: [
          {
            targetId: `api-${index}`,
            adapterKind: "auto",
            collectionMethod: "api",
            state: "completed",
            timing: {
              totalDurationMs: 5_500 + index,
              firstActivityMs: 0,
              firstCandidateMs: 1_500 + index,
              firstDistinctUsefulJobMs: 3_500 + index,
              longestGapMs: 500,
              eventCount: 4,
            },
          },
        ],
      }),
    );
    const cancelledRun = DiscoveryRunRecordSchema.parse({
      ...completedRuns[0],
      id: "cancelled-run",
      state: "cancelled",
      summary: {
        ...completedRuns[0]!.summary,
        timing: {
          ...completedRuns[0]!.summary.timing!,
          firstDistinctUsefulJobMs: 99_000,
        },
      },
    });

    const evaluations = buildDiscoveryPerformanceBudgetEvaluations([
      ...completedRuns,
      completedRuns[0]!,
      cancelledRun,
    ]);
    const usefulJobEvaluation = evaluations.find(
      (entry) => entry.id === "discovery-first-distinct-useful-job-p95",
    );
    const apiEvaluation = evaluations.find(
      (entry) => entry.id === "discovery-api-duration-p95",
    );

    expect(usefulJobEvaluation?.status).toBe("fail");
    expect(usefulJobEvaluation?.observed).toBe(3_504);
    expect(usefulJobEvaluation?.sampleCount).toBe(5);
    expect(apiEvaluation?.status).toBe("fail");
    expect(apiEvaluation?.observed).toBe(5_504);
    expect(apiEvaluation?.sampleCount).toBe(5);
  });
});

describe("discovery timing milestones", () => {
  it("separates first activity, first candidate, and first retained distinct job", () => {
    const run = DiscoveryRunRecordSchema.parse({
      id: "milestone-run",
      state: "running",
      startedAt: "2026-07-30T12:00:00.000Z",
      completedAt: null,
      targetIds: ["target-one", "target-two"],
      activity: [
        {
          id: "planning",
          runId: "milestone-run",
          timestamp: "2026-07-30T12:00:00.000Z",
          kind: "info",
          stage: "planning",
          message: "Planning discovery",
          jobsFound: 0,
          jobsPersisted: 0,
          jobsStaged: 0,
        },
        {
          id: "candidate-one",
          runId: "milestone-run",
          timestamp: "2026-07-30T12:00:01.200Z",
          kind: "progress",
          stage: "extraction",
          targetId: "target-one",
          message: "Collected candidates",
          jobsFound: 6,
          jobsPersisted: 0,
          jobsStaged: 0,
        },
        {
          id: "duplicates-only",
          runId: "milestone-run",
          timestamp: "2026-07-30T12:00:01.800Z",
          kind: "progress",
          stage: "persistence",
          targetId: "target-one",
          message: "All candidates were duplicates",
          jobsFound: 4,
          jobsPersisted: 0,
          jobsStaged: 0,
        },
        {
          id: "cumulative-staged-count",
          runId: "milestone-run",
          timestamp: "2026-07-30T12:00:02.600Z",
          kind: "progress",
          stage: "extraction",
          targetId: "target-two",
          message: "Collected another source",
          jobsFound: 2,
          jobsPersisted: 0,
          jobsStaged: 4,
        },
        {
          id: "useful-job",
          runId: "milestone-run",
          timestamp: "2026-07-30T12:00:04.200Z",
          kind: "success",
          stage: "persistence",
          targetId: "target-two",
          message: "Retained distinct jobs",
          jobsFound: 2,
          jobsPersisted: 0,
          jobsStaged: 2,
        },
      ],
    });

    const finalized = finalizeDiscoveryRun(
      run,
      "completed",
      "2026-07-30T12:00:06.000Z",
    );

    expect(finalized.summary.timing).toMatchObject({
      totalDurationMs: 6_000,
      firstActivityMs: 0,
      firstCandidateMs: 1_200,
      firstDistinctUsefulJobMs: 4_200,
    });
  });

  it("keeps candidate and useful-job milestones unknown when none qualify", () => {
    const run = DiscoveryRunRecordSchema.parse({
      id: "empty-milestone-run",
      state: "running",
      startedAt: "2026-07-30T12:00:00.000Z",
      completedAt: null,
      targetIds: ["target-one"],
      activity: [
        {
          id: "planning",
          runId: "empty-milestone-run",
          timestamp: "2026-07-30T12:00:00.000Z",
          kind: "info",
          stage: "planning",
          message: "Planning discovery",
        },
        {
          id: "empty-extraction",
          runId: "empty-milestone-run",
          timestamp: "2026-07-30T12:00:01.000Z",
          kind: "progress",
          stage: "extraction",
          targetId: "target-one",
          message: "No candidates found",
          jobsFound: 0,
        },
        {
          id: "empty-persistence",
          runId: "empty-milestone-run",
          timestamp: "2026-07-30T12:00:02.000Z",
          kind: "progress",
          stage: "persistence",
          targetId: "target-one",
          message: "Nothing retained",
          jobsPersisted: 0,
          jobsStaged: 0,
        },
      ],
    });

    const finalized = finalizeDiscoveryRun(
      run,
      "completed",
      "2026-07-30T12:00:03.000Z",
    );

    expect(finalized.summary.timing).toMatchObject({
      firstActivityMs: 0,
      firstCandidateMs: null,
      firstDistinctUsefulJobMs: null,
    });
  });
});
