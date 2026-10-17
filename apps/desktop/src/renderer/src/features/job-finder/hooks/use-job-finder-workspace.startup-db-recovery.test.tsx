// @vitest-environment jsdom

import type {
  JobFinderRendererWorkspaceSnapshot,
  DesktopPlatformPing,
} from "@nordri/contracts";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JobFinderStartupDatabaseRecoveryBlockedFact } from "../../../../../shared/job-finder-startup-db-recovery";
import { useJobFinderWorkspace } from "./use-job-finder-workspace";

function blockedFact(): JobFinderStartupDatabaseRecoveryBlockedFact {
  return {
    status: "blocked",
    incidentId: "incident-salvage-1",
    outcome: "salvage-required",
    candidates: [
      { kind: "backup", status: "valid", failedStage: null },
      { kind: "backup-prev", status: "missing", failedStage: null },
    ],
    quarantineBasenames: [],
  };
}

function workspaceSnapshot(): JobFinderRendererWorkspaceSnapshot {
  return {
    hydration: { phase: "complete", deferredCollections: [] },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function configureWindowNordri(overrides: {
  getWorkspaceBootstrap?: () => Promise<JobFinderRendererWorkspaceSnapshot>;
  getStartupDatabaseRecovery?: () => Promise<unknown>;
}) {
  Object.defineProperty(window, "nordri", {
    configurable: true,
    value: {
      ping: vi.fn<() => Promise<DesktopPlatformPing>>(() =>
        Promise.resolve({ ok: true, platform: "win32" as const }),
      ),
      jobFinder: {
        getWorkspaceBootstrap: overrides.getWorkspaceBootstrap,
        ...(overrides.getStartupDatabaseRecovery
          ? {
              getStartupDatabaseRecovery: overrides.getStartupDatabaseRecovery,
            }
          : {}),
      },
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { nordri?: unknown }).nordri;
});

describe("useJobFinderWorkspace startup database recovery", () => {
  it("carries the typed blocking incident when the workspace cannot open", async () => {
    configureWindowNordri({
      getWorkspaceBootstrap: vi.fn(() =>
        Promise.reject(
          new Error("Workspace database recovery required (salvage-required)."),
        ),
      ),
      getStartupDatabaseRecovery: vi.fn(() => Promise.resolve(blockedFact())),
    });

    const { result } = renderHook(() => useJobFinderWorkspace());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    if (result.current.status !== "error") {
      throw new Error("unreachable");
    }
    expect(result.current.startupDatabaseRecovery?.status).toBe("blocked");
    expect(result.current.startupDatabaseRecovery?.incidentId).toBe(
      "incident-salvage-1",
    );
    expect(result.current.startupDatabaseRecovery?.outcome).toBe(
      "salvage-required",
    );
    expect(typeof result.current.retry).toBe("function");
  });

  it("fails closed to the generic error when the recovery fact is malformed", async () => {
    configureWindowNordri({
      getWorkspaceBootstrap: vi.fn(() =>
        Promise.reject(new Error("Unable to load the workspace.")),
      ),
      getStartupDatabaseRecovery: vi.fn(() =>
        Promise.resolve({ status: "blocked", nonsense: true }),
      ),
    });

    const { result } = renderHook(() => useJobFinderWorkspace());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    if (result.current.status !== "error") {
      throw new Error("unreachable");
    }
    expect(result.current.startupDatabaseRecovery).toBeNull();
  });

  it("keeps the generic error when the preload bridge lacks the recovery API", async () => {
    configureWindowNordri({
      getWorkspaceBootstrap: vi.fn(() =>
        Promise.reject(new Error("Unable to load the workspace.")),
      ),
    });

    const { result } = renderHook(() => useJobFinderWorkspace());

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    if (result.current.status !== "error") {
      throw new Error("unreachable");
    }
    expect(result.current.startupDatabaseRecovery).toBeNull();
  });

  it("does not block a workspace that opened even if a stale incident was fetched", async () => {
    configureWindowNordri({
      getWorkspaceBootstrap: vi.fn(() => Promise.resolve(workspaceSnapshot())),
      getStartupDatabaseRecovery: vi.fn(() => Promise.resolve(blockedFact())),
    });

    const { result } = renderHook(() => useJobFinderWorkspace());

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current).not.toHaveProperty("startupDatabaseRecovery");
  });
});
