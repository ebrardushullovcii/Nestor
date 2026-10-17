// @vitest-environment jsdom

import type {
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceSyncResult,
} from "@nestor/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useJobFinderWorkspace } from "./use-job-finder-workspace";

function identified<T>(id: string): T {
  return { id } as T;
}

function createCampaignWorkspace(input: {
  campaignIds: readonly string[];
  activeCampaignId: string | null;
  generatedAt?: string;
}): JobFinderRendererWorkspaceSnapshot {
  return {
    generatedAt: input.generatedAt ?? "2026-08-09T10:00:00.000Z",
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
    reviewQueue: [],
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
    campaigns: input.campaignIds.map(identified),
    activeCampaignId: input.activeCampaignId,
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function snapshotResult(
  currentRevision: number,
  snapshot: JobFinderRendererWorkspaceSnapshot,
): JobFinderWorkspaceSyncResult {
  return {
    kind: "snapshot",
    currentRevision,
    reason: "initial",
    snapshot,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

const DELETED_CAMPAIGN_ID = "campaign-deleted";

function initialCampaignWorkspace(): JobFinderRendererWorkspaceSnapshot {
  return createCampaignWorkspace({
    campaignIds: ["campaign-kept", DELETED_CAMPAIGN_ID],
    activeCampaignId: DELETED_CAMPAIGN_ID,
  });
}

describe("useJobFinderWorkspace campaign deletion", () => {
  const syncWorkspace =
    vi.fn<
      (baseRevision: number | null) => Promise<JobFinderWorkspaceSyncResult>
    >();
  const deleteJobSearchCampaign =
    vi.fn<(campaignId: string) => Promise<boolean>>();
  const getWorkspace = vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();
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
          deleteJobSearchCampaign,
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

  async function renderReadyWorkspace(
    initialWorkspace: JobFinderRendererWorkspaceSnapshot,
  ) {
    syncWorkspace.mockResolvedValueOnce(snapshotResult(1, initialWorkspace));
    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    return result;
  }

  it("refreshes the workspace after a confirmed deletion so the campaign disappears", async () => {
    const refreshed = createCampaignWorkspace({
      campaignIds: ["campaign-kept"],
      activeCampaignId: "campaign-kept",
      generatedAt: "2026-08-09T10:05:00.000Z",
    });
    const result = await renderReadyWorkspace(initialCampaignWorkspace());
    syncWorkspace.mockResolvedValueOnce(snapshotResult(2, refreshed));
    deleteJobSearchCampaign.mockResolvedValueOnce(true);

    let deleted!: boolean;
    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      deleted =
        await result.current.actions.deleteCampaign(DELETED_CAMPAIGN_ID);
    });

    expect(deleted).toBe(true);
    expect(deleteJobSearchCampaign).toHaveBeenCalledWith(DELETED_CAMPAIGN_ID);
    // The initial load plus the post-delete refresh.
    expect(syncWorkspace).toHaveBeenCalledTimes(2);
    expect(syncWorkspace).toHaveBeenNthCalledWith(2, 1);
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.current.workspace.campaigns.map(({ id }) => id)).toEqual([
      "campaign-kept",
    ]);
  });

  it("adopts the backend-selected fallback active campaign after deletion", async () => {
    const refreshed = createCampaignWorkspace({
      campaignIds: ["campaign-fallback"],
      activeCampaignId: "campaign-fallback",
      generatedAt: "2026-08-09T10:06:00.000Z",
    });
    const result = await renderReadyWorkspace(initialCampaignWorkspace());
    syncWorkspace.mockResolvedValueOnce(snapshotResult(3, refreshed));
    deleteJobSearchCampaign.mockResolvedValueOnce(true);

    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      await result.current.actions.deleteCampaign(DELETED_CAMPAIGN_ID);
    });

    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.current.workspace.activeCampaignId).toBe("campaign-fallback");
    expect(result.current.workspace.generatedAt).toBe(
      "2026-08-09T10:06:00.000Z",
    );
  });

  it("keeps the local snapshot untouched when the backend refuses the deletion", async () => {
    const initialWorkspace = initialCampaignWorkspace();
    const result = await renderReadyWorkspace(initialWorkspace);
    deleteJobSearchCampaign.mockResolvedValueOnce(false);

    let deleted!: boolean;
    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      deleted =
        await result.current.actions.deleteCampaign(DELETED_CAMPAIGN_ID);
    });

    expect(deleted).toBe(false);
    expect(syncWorkspace).toHaveBeenCalledTimes(1);
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.current.workspace).toBe(initialWorkspace);
    expect(result.current.workspace.activeCampaignId).toBe(DELETED_CAMPAIGN_ID);
  });

  it("propagates a failed deletion without refreshing the workspace", async () => {
    const initialWorkspace = initialCampaignWorkspace();
    const result = await renderReadyWorkspace(initialWorkspace);
    deleteJobSearchCampaign.mockRejectedValueOnce(
      new Error("delete failed on the database"),
    );

    let failure: unknown = null;
    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      failure = await result.current.actions
        .deleteCampaign(DELETED_CAMPAIGN_ID)
        .then(
          () => null,
          (error: unknown) => error,
        );
    });

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("delete failed on the database");
    expect(syncWorkspace).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.current.workspace).toBe(initialWorkspace);
  });

  it("does not let a slower deletion refresh overwrite a newer committed snapshot", async () => {
    const result = await renderReadyWorkspace(initialCampaignWorkspace());

    const slowRefresh = deferred<JobFinderWorkspaceSyncResult>();
    syncWorkspace.mockImplementationOnce(() => slowRefresh.promise);
    deleteJobSearchCampaign.mockResolvedValueOnce(true);

    let deletePromise!: Promise<boolean>;
    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      deletePromise =
        result.current.actions.deleteCampaign(DELETED_CAMPAIGN_ID);
      // Flush the bridge response so the post-delete refresh request begins
      // before the newer action below interleaves.
      await Promise.resolve();
    });
    expect(syncWorkspace).toHaveBeenCalledTimes(2);

    const newerWorkspace = createCampaignWorkspace({
      campaignIds: ["campaign-newer"],
      activeCampaignId: "campaign-newer",
      generatedAt: "2026-08-09T10:07:00.000Z",
    });
    const newerAction = deferred<JobFinderRendererWorkspaceSnapshot>();
    checkBrowserSession.mockImplementationOnce(() => newerAction.promise);

    let newerActionPromise!: Promise<JobFinderRendererWorkspaceSnapshot>;
    act(() => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      newerActionPromise = result.current.actions.checkBrowserSession();
    });

    await act(async () => {
      newerAction.resolve(newerWorkspace);
      await newerActionPromise;
    });

    // The stale post-delete snapshot loses to the newer committed action.
    await act(async () => {
      slowRefresh.resolve(snapshotResult(9, initialCampaignWorkspace()));
      await deletePromise;
    });

    expect(await deletePromise).toBe(true);
    expect(syncWorkspace).toHaveBeenCalledTimes(2);
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(result.current.status).toBe("ready");
    if (result.current.status !== "ready") {
      throw new Error("unreachable");
    }
    expect(result.current.workspace.activeCampaignId).toBe("campaign-newer");
    expect(result.current.workspace.campaigns.map(({ id }) => id)).toEqual([
      "campaign-newer",
    ]);
  });
});
