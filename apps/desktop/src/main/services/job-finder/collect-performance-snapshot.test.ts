import { describe, expect, it, vi } from "vitest";
import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";

import { collectJobFinderPerformanceSnapshot } from "./collect-performance-snapshot";

const generatedAt = "2026-08-09T10:00:00.000Z";

describe("collectJobFinderPerformanceSnapshot", () => {
  it("measures the existing workspace read and leaves unobserved runtime areas unavailable", async () => {
    const workspace = {
      latestResumeImportRun: null,
      applicationAttempts: [],
      activeSourceDebugRun: null,
      recentSourceDebugRuns: [],
    } as unknown as JobFinderWorkspaceSnapshot;
    const service = {
      getWorkspaceSnapshot: vi.fn().mockResolvedValue(workspace),
      getSourceDebugRunDetails: vi.fn(),
    };
    const nowMs = vi
      .fn<() => number>()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(112.5);

    const result = await collectJobFinderPerformanceSnapshot({
      service,
      generatedAt,
      nowMs,
    });
    const persistence = result.performance.evidence.find(
      (entry) => entry.area === "persistence",
    );
    const ipc = result.performance.evidence.find(
      (entry) => entry.area === "ipc",
    );

    expect(result.workspace).toBe(workspace);
    expect(persistence).toMatchObject({
      measurementStatus: "available",
      durationMs: 12.5,
      recordedAt: generatedAt,
      budgetStatus: "not_evaluated",
      stageDurations: [
        {
          id: "persistence.workspace_snapshot_read",
          durationMs: 12.5,
        },
      ],
    });
    expect(ipc).toMatchObject({
      measurementStatus: "unavailable",
      durationMs: null,
    });
    expect(service.getSourceDebugRunDetails).not.toHaveBeenCalled();
  });
});

it("includes native waiting-form measurements in the timing snapshot", async () => {
  const memory = {
    recordedAt: generatedAt,
    totalBytes: 1024,
    budgetBytes: 805306368,
    measurementComplete: true,
    overBudget: false,
    tabs: [
      {
        tabId: "synthetic",
        processId: 1,
        processBytes: 1024,
        backgroundThrottled: true,
      },
    ],
  };
  const workspace = {
    latestResumeImportRun: null,
    applicationAttempts: [],
    activeSourceDebugRun: null,
    recentSourceDebugRuns: [],
  } as unknown as JobFinderWorkspaceSnapshot;
  const result = await collectJobFinderPerformanceSnapshot({
    service: {
      getWorkspaceSnapshot: () => Promise.resolve(workspace),
      getSourceDebugRunDetails: vi.fn(),
    },
    waitingFormMemory: () => Promise.resolve(memory),
    generatedAt,
  });
  expect(result.performance.waitingFormMemory).toEqual(memory);
});
