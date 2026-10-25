// @vitest-environment jsdom

import type {
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceSyncResult,
} from "@nestor/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useJobFinderWorkspace } from "./use-job-finder-workspace";

function createWorkspace(input: {
  assetStatus: "not_started" | "failed";
  generatedAt: string;
}): JobFinderRendererWorkspaceSnapshot {
  return {
    generatedAt: input.generatedAt,
    hydration: { phase: "complete", deferredCollections: [] },
    discoveryRunState: "idle",
    activeDiscoveryRun: null,
    discoverySessions: [],
    sourceAccessPrompts: [],
    latestResumeImportRun: null,
    discoveryJobs: [],
    dismissedDiscoveryJobs: [],
    companyJobs: [],
    recentDiscoveryRuns: [],
    reviewQueue: [{ jobId: "job_1", assetStatus: input.assetStatus }],
    applyRuns: [],
    applyJobResults: [],
    applicationRecords: [],
    applicationAttempts: [],
    userActionRequests: [],
    userActionEvents: [],
    selectedDiscoveryJobId: null,
    selectedReviewJobId: null,
    selectedApplyRunId: null,
    selectedApplicationRecordId: null,
    campaigns: [],
    activeCampaignId: null,
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function snapshotResult(
  currentRevision: number,
  snapshot: JobFinderRendererWorkspaceSnapshot,
): JobFinderWorkspaceSyncResult {
  return { kind: "snapshot", currentRevision, reason: "initial", snapshot };
}

describe("useJobFinderWorkspace after a failed action", () => {
  const syncWorkspace =
    vi.fn<
      (baseRevision: number | null) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const generateResume =
    vi.fn<(jobId: string) => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const getWorkspace =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const checkBrowserSession =
    vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        ping: vi.fn(() => Promise.resolve({ platform: "win32" as const })),
        jobFinder: {
          syncWorkspace,
          generateResume,
          getWorkspace,
          checkBrowserSession,
        },
      } as unknown as Window["nestor"],
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "nestor");
  });

  it("re-syncs so a resume run that failed shows its recorded failure", async () => {
    syncWorkspace.mockResolvedValueOnce(
      snapshotResult(
        1,
        createWorkspace({
          assetStatus: "not_started",
          generatedAt: "2026-09-24T10:00:00.000Z",
        }),
      ),
    );
    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Main saved the failed asset, then rejected the call.
    syncWorkspace.mockResolvedValueOnce(
      snapshotResult(
        2,
        createWorkspace({
          assetStatus: "failed",
          generatedAt: "2026-09-24T10:02:00.000Z",
        }),
      ),
    );
    generateResume.mockRejectedValueOnce(
      new Error("Your profile changed while this resume was being written."),
    );

    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      await expect(
        result.current.actions.generateResume("job_1"),
      ).rejects.toThrow("Your profile changed");
    });

    await waitFor(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      expect(result.current.workspace.reviewQueue[0]?.assetStatus).toBe(
        "failed",
      );
    });
    expect(syncWorkspace).toHaveBeenLastCalledWith(null);
  });
});
