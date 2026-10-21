// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { JobListRow } from "@nestor/contracts";
import { findNextTriageJobId, useDiscoveryTriage } from "./discovery-triage";

// Rows whose id starts with "w" stand in for weaker matches.
vi.mock("./discovery-result-groups", () => ({
  isDiscoveryAlsoFoundResult: (job: JobListRow) => job.id.startsWith("w"),
}));

afterEach(() => vi.restoreAllMocks());

function row(id: string, status = "discovered"): JobListRow {
  return { id, title: `Role ${id}`, status, detailRevision: "1" } as unknown as JobListRow;
}

it("finds the next open job after this one, wrapping to the top", () => {
  const open = (id: string) => id !== "b";
  expect(findNextTriageJobId(["a", "b", "c"], "a", open)).toBe("c");
  expect(findNextTriageJobId(["a", "b", "c"], "c", open)).toBe("a");
  expect(findNextTriageJobId(["a", "b", "c"], "c", open, -1)).toBe("a");
  expect(findNextTriageJobId(["a"], "a", open)).toBeNull();
});

it("shortlists, moves on at once, counts it, and undoes it", async () => {
  vi.stubGlobal("nestor", {
    jobFinder: { getJobDetail: vi.fn(() => new Promise(() => undefined)) },
  });
  const jobs = [row("a"), row("b"), row("c", "drafting"), row("d")];
  const onSelectJob = vi.fn();
  const onQueueJob = vi.fn(() =>
    Promise.resolve({ status: "success" as const, message: "Added" }),
  );
  const onRemoveFromShortlist = vi.fn(() => Promise.resolve());
  const { result, rerender } = renderHook(
    ({ inspected }: { inspected: JobListRow }) =>
      useDiscoveryTriage({
        enabled: true,
        jobs,
        orderedJobIds: jobs.map((job) => job.id),
        inspectedJob: inspected,
        reviewQueue: [],
        campaignId: "plan",
        onSelectJob,
        onQueueJob,
        onDismissJob: vi.fn(),
        onRestoreDismissedJob: vi.fn(),
        onRemoveFromShortlist,
      }),
    { initialProps: { inspected: jobs[0]! } },
  );
  // "c" is already in Shortlisted, so it is not one to go through.
  expect(result.current).toMatchObject({ goneThrough: 0, total: 3 });

  act(() => result.current!.onShortlist!());
  // The request goes out once the next job has painted.
  await act(() =>
    vi.waitFor(() =>
      expect(onQueueJob).toHaveBeenCalledWith("a", { quiet: true }),
    ),
  );
  expect(onSelectJob).toHaveBeenLastCalledWith("b");
  rerender({ inspected: jobs[1]! });
  expect(result.current).toMatchObject({ goneThrough: 1, total: 3 });
  // Skip passes over the job already in Shortlisted.
  act(() => result.current!.onSkip!());
  expect(onSelectJob).toHaveBeenLastCalledWith("d");

  act(() => result.current!.undo!.onUndo());
  expect(onRemoveFromShortlist).toHaveBeenCalledWith(["a"]);
  expect(onSelectJob).toHaveBeenLastCalledWith("a");
});

it("acts on S, X, J and U outside text fields only", async () => {
  vi.stubGlobal("nestor", {
    jobFinder: { getJobDetail: vi.fn(() => new Promise(() => undefined)) },
  });
  const jobs = [row("a"), row("b")];
  const onSelectJob = vi.fn();
  const onDismissJob = vi.fn();
  renderHook(() =>
    useDiscoveryTriage({
      enabled: true,
      jobs,
      orderedJobIds: ["a", "b"],
      inspectedJob: jobs[0]!,
      reviewQueue: [],
      campaignId: null,
      onSelectJob,
      onQueueJob: vi.fn(),
      onDismissJob,
      onRestoreDismissedJob: vi.fn(),
    }),
  );
  const input = document.createElement("input");
  document.body.append(input);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
  expect(onDismissJob).not.toHaveBeenCalled();
  input.remove();
  // A held key does not decide job after job.
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x", repeat: true }));
  });
  expect(onSelectJob).not.toHaveBeenCalled();

  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
  });
  await act(() =>
    vi.waitFor(() => expect(onDismissJob).toHaveBeenCalledWith("a")),
  );
  expect(onSelectJob).toHaveBeenLastCalledWith("b");
  // A modifier makes it someone else's shortcut.
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", ctrlKey: true }));
  });
  expect(onSelectJob).toHaveBeenCalledTimes(1);
});

it("counts progress within the open job's group, so weaker matches do not bury it", () => {
  vi.stubGlobal("nestor", {
    jobFinder: { getJobDetail: vi.fn(() => new Promise(() => undefined)) },
  });
  const jobs = [row("a"), row("b"), row("w1"), row("w2"), row("w3")];
  const { result, rerender } = renderHook(
    ({ inspected }: { inspected: JobListRow }) =>
      useDiscoveryTriage({
        enabled: true,
        jobs,
        orderedJobIds: jobs.map((job) => job.id),
        inspectedJob: inspected,
        reviewQueue: [],
        campaignId: null,
        onSelectJob: vi.fn(),
        onQueueJob: vi.fn(),
        onDismissJob: vi.fn(() => Promise.resolve()),
        onRestoreDismissedJob: vi.fn(),
      }),
    { initialProps: { inspected: jobs[0]! } },
  );
  expect(result.current).toMatchObject({ goneThrough: 0, total: 2, weaker: false });
  act(() => result.current!.onNotInterested!());
  rerender({ inspected: jobs[1]! });
  expect(result.current).toMatchObject({ goneThrough: 1, total: 2, weaker: false });
  rerender({ inspected: jobs[2]! });
  expect(result.current).toMatchObject({ goneThrough: 0, total: 3, weaker: true });
});
