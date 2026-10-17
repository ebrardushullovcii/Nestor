// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useJobFinderWorkspace } from "./use-job-finder-workspace";

function createWorkspace(generatedAt: string): JobFinderRendererWorkspaceSnapshot {
  return {
    generatedAt,
    intelligence: { groupedDecisions: [] },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("useJobFinderWorkspace grouped manual-answer actions", () => {
  const projectGroupedManualAnswer =
    vi.fn<(command: unknown) => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const applyGroupedManualAnswer =
    vi.fn<(input: unknown) => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const snoozeGroupedDecision =
    vi.fn<(input: unknown) => Promise<JobFinderRendererWorkspaceSnapshot>>();
  const syncWorkspace =
    vi.fn<(baseRevision: number | null) => Promise<unknown>>();
  const getWorkspace = vi.fn<() => Promise<JobFinderRendererWorkspaceSnapshot>>();

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        ping: vi.fn(() => Promise.resolve({ platform: "win32" as const })),
        jobFinder: {
          syncWorkspace,
          getWorkspace,
          projectGroupedManualAnswer,
          applyGroupedManualAnswer,
          snoozeGroupedDecision,
        },
      } as unknown as Window["nestor"],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "nestor");
  });

  it("projects a grouped manual answer and commits the returned snapshot", async () => {
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: createWorkspace("2026-08-15T10:00:00.000Z"),
    });
    projectGroupedManualAnswer.mockResolvedValueOnce(
      createWorkspace("2026-08-15T10:01:00.000Z"),
    );
    const command = {
      groupKey: "group_1",
      requestId: "request_a",
      expectedRequestRevision: 1,
      answer: { type: "text" as const, value: "5 years" },
      saveScope: "reusable_profile" as const,
    };

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      await result.current.actions.projectGroupedManualAnswer(command);
    });

    expect(projectGroupedManualAnswer).toHaveBeenCalledWith(command);
    expect(result.current.status).toBe("ready");
    if (result.current.status === "ready") {
      expect(result.current.workspace.generatedAt).toBe(
        "2026-08-15T10:01:00.000Z",
      );
    }
  });

  it("applies a grouped manual answer through the workspace action runner", async () => {
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: createWorkspace("2026-08-15T10:00:00.000Z"),
    });
    applyGroupedManualAnswer.mockResolvedValueOnce(
      createWorkspace("2026-08-15T10:02:00.000Z"),
    );
    const input = {
      decisionId: "group_1:abc123",
      requestIds: ["request_a", "request_b"],
      expectedRequestRevisions: { request_a: 1, request_b: 1 },
      answer: { type: "text" as const, value: "5 years" },
    };

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      await result.current.actions.applyGroupedManualAnswer(input);
    });

    expect(applyGroupedManualAnswer).toHaveBeenCalledWith(input);
    expect(result.current.status).toBe("ready");
    if (result.current.status === "ready") {
      expect(result.current.workspace.generatedAt).toBe(
        "2026-08-15T10:02:00.000Z",
      );
    }
  });

  it("snoozes a grouped decision and commits the returned snapshot", async () => {
    syncWorkspace.mockResolvedValueOnce({
      kind: "snapshot",
      currentRevision: 1,
      reason: "initial",
      snapshot: createWorkspace("2026-08-15T10:00:00.000Z"),
    });
    snoozeGroupedDecision.mockResolvedValueOnce(
      createWorkspace("2026-08-15T10:03:00.000Z"),
    );
    const input = {
      decisionId: "group_1:abc123",
      expectedRevision: 1,
      until: "2026-08-17T10:00:00.000Z",
      reason: null,
    };

    const { result } = renderHook(() => useJobFinderWorkspace());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      if (result.current.status !== "ready") {
        throw new Error("Expected a ready Job Finder workspace.");
      }
      await result.current.actions.snoozeGroupedDecision(input);
    });

    expect(snoozeGroupedDecision).toHaveBeenCalledWith(input);
    expect(result.current.status).toBe("ready");
    if (result.current.status === "ready") {
      expect(result.current.workspace.generatedAt).toBe(
        "2026-08-15T10:03:00.000Z",
      );
    }
  });
});
