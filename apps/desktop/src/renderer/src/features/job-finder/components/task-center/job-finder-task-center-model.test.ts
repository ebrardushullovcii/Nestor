import type {
  JobFinderRendererWorkspaceSnapshot,
  ResumeImportRun,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";
import {
  buildJobFinderTaskCenterModel,
  describeTaskCenterCounts,
} from "./job-finder-task-center-model";

function createWorkspace(
  overrides: Partial<JobFinderRendererWorkspaceSnapshot> = {},
): JobFinderRendererWorkspaceSnapshot {
  return {
    discoveryJobs: [],
    latestResumeImportRun: null,
    searchPreferences: {
      discovery: {
        targets: [
          { id: "source_a", label: "Mercury careers" },
          { id: "source_b", label: "Aircall careers" },
        ],
      },
    },
    ...overrides,
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function findTask(
  model: ReturnType<typeof buildJobFinderTaskCenterModel>,
  kind:
    | "discovery"
    | "source_check"
    | "resume_import"
    | "safeguards"
    | "tailored_drafts",
) {
  const task = model.items.find((item) => item.kind === kind);
  expect(task).toBeDefined();
  return task!;
}

describe("buildJobFinderTaskCenterModel", () => {
  test("keeps a persisted running import active after navigation clears the local pending flag", () => {
    const run = {
      id: "resume_stale",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "candidate.pdf",
      status: "extracting",
      startedAt: "2026-07-31T09:00:00.000Z",
      completedAt: null,
      candidateCounts: {
        total: 0,
        autoApplied: 0,
        needsReview: 0,
        rejected: 0,
      },
    } as unknown as ResumeImportRun;

    const model = buildJobFinderTaskCenterModel({
      workspace: createWorkspace({ latestResumeImportRun: run }),
      isResumeImportPending: false,
    });
    const task = findTask(model, "resume_import");

    expect(task.status).toBe("active");
    expect(task.stageLabel).toBe("Building profile suggestions");
    expect(task.resumeRoute).toBeNull();
    expect(task.historyEstimateLabel).toBeNull();
  });

  test("shows a resume estimate only from the previous completed import while a new import is active", () => {
    const priorRun = {
      id: "resume_prior",
      sourceResumeId: "resume_1",
      sourceResumeFileName: "prior.pdf",
      status: "review_ready",
      startedAt: "2026-07-30T09:00:00.000Z",
      completedAt: "2026-07-30T09:00:30.000Z",
      timing: { totalMs: 30_000 },
      candidateCounts: {
        total: 12,
        autoApplied: 8,
        needsReview: 4,
        rejected: 0,
      },
    } as unknown as ResumeImportRun;

    const task = findTask(
      buildJobFinderTaskCenterModel({
        workspace: createWorkspace({ latestResumeImportRun: priorRun }),
        isResumeImportPending: true,
        resumeImportProgress: {
          stage: "building_profile",
          message: "Building suggestions",
          occurredAt: "2026-07-31T10:00:04.000Z",
        },
      }),
      "resume_import",
    );

    expect(task.status).toBe("active");
    expect(task.stageLabel).toBe("Building profile suggestions");
    expect(task.countLabel).toBe("Counts available after extraction");
    expect(task.historyEstimateLabel).toBe(
      "about 30s from 1 previous completed import",
    );
  });
});

describe("describeTaskCenterCounts", () => {
  test("never renders a zero beside a real count", () => {
    expect(describeTaskCenterCounts({ activeCount: 2, pausedCount: 0 })).toBe(
      "2 running",
    );
    // Paused work is the person's queue and Needs you already counts it.
    expect(describeTaskCenterCounts({ activeCount: 0, pausedCount: 3 })).toBe(
      null,
    );
    expect(describeTaskCenterCounts({ activeCount: 2, pausedCount: 3 })).toBe(
      "2 running",
    );
    expect(describeTaskCenterCounts({ activeCount: 0, pausedCount: 0 })).toBe(
      null,
    );
  });
});
