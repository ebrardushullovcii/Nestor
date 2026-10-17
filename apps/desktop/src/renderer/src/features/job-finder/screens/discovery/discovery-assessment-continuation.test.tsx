// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { SavedJob } from "@nestor/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { DiscoveryAssessmentContinuation } from "./discovery-assessment-continuation";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("offers a bounded continuation and shows progress while a listing is being read", async () => {
  const jobs = Array.from(
    { length: 130 },
    (_, index) =>
      ({
        id: `unread_${index}`,
        discoveryMethod: "browser_agent",
        matchAssessment: { judgment: null },
      }) as SavedJob,
  );
  let release: () => void = () => undefined;
  const onAssess = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  render(
    <DiscoveryAssessmentContinuation
      jobs={jobs}
      isSearchRunning={false}
      onAssess={onAssess}
    />,
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Assess next 20 listings" }),
  );
  expect(onAssess).toHaveBeenCalledWith("unread_0");
  expect(
    screen.getByText(/Assessing listings · 0 of 20 finished/),
  ).toBeTruthy();
  await act(() => {
    release();
    return Promise.resolve();
  });
  expect(onAssess).toHaveBeenCalledWith("unread_1");
  expect(
    screen.getByText(/Assessing listings · 1 of 20 finished/),
  ).toBeTruthy();
});

it("does not offer another assessment while discovery is running", () => {
  const job = {
    id: "unread",
    discoveryMethod: "browser_agent",
    matchAssessment: {},
  } as SavedJob;
  render(
    <DiscoveryAssessmentContinuation
      jobs={[job]}
      isSearchRunning
      onAssess={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
});

it("keeps the whole-plan count while the next twenty begin with the visible page", async () => {
  const jobs = Array.from(
    { length: 100 },
    (_, index) =>
      ({
        id: `unread_${index}`,
        discoveryMethod: "browser_agent",
        matchAssessment: { score: 0, judgment: null },
      }) as SavedJob,
  );
  const onAssess = vi.fn(() => Promise.resolve());
  render(
    <DiscoveryAssessmentContinuation
      jobs={jobs}
      preferredJobs={[jobs[90]!, jobs[91]!, jobs[90]!]}
      isSearchRunning={false}
      onAssess={onAssess}
      onJudgeAll={() => Promise.resolve()}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Judge fit for all 100" }),
  ).toBeTruthy();
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Assess next 20 listings" }),
    );
    await Promise.resolve();
  });
  expect(onAssess).toHaveBeenCalledTimes(20);
  expect(onAssess.mock.calls.slice(0, 3)).toEqual([
    ["unread_90"],
    ["unread_91"],
    ["unread_0"],
  ]);
});

it("explains navigation and stops before the next listing after unmount", async () => {
  let release!: () => void;
  const onAssess = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const jobs = ["visible-first", "second"].map(
    (id) =>
      ({
        id,
        discoveryMethod: "browser_agent",
        matchAssessment: { judgment: null },
      }) as SavedJob,
  );
  const view = render(
    <DiscoveryAssessmentContinuation
      jobs={jobs}
      isSearchRunning={false}
      onAssess={onAssess}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Assess next 2 listings" }),
  );
  expect(
    screen.getByText(
      /Leaving this page stops the batch after the current listing/,
    ),
  ).toBeTruthy();
  view.unmount();
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(onAssess).toHaveBeenCalledExactlyOnceWith("visible-first");
});

it("uses the actual singular count and shows the service failure", async () => {
  const job = {
    id: "one",
    discoveryMethod: "browser_agent",
    matchAssessment: { judgment: null },
  } as SavedJob;
  render(
    <DiscoveryAssessmentContinuation
      jobs={[job]}
      isSearchRunning={false}
      onAssess={vi
        .fn()
        .mockRejectedValue(new Error("The AI is unavailable. Try again."))}
    />,
  );
  await act(() => {
    fireEvent.click(
      screen.getByRole("button", { name: "Assess next 1 listing" }),
    );
    return Promise.resolve();
  });
  expect(screen.getByRole("alert").textContent).toBe(
    "The AI is unavailable. Try again.",
  );
});

it("judges every unjudged job at once and says how many are left", async () => {
  const jobs = Array.from(
    { length: 130 },
    (_, index) =>
      ({
        id: `unread_${index}`,
        discoveryMethod: "browser_agent",
        matchAssessment: { judgment: null },
      }) as SavedJob,
  );
  let finish: () => void = () => undefined;
  const onJudgeAll = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <DiscoveryAssessmentContinuation
      jobs={jobs}
      isSearchRunning={false}
      onAssess={vi.fn()}
      onJudgeAll={onJudgeAll}
    />,
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Judge fit for all 130" }),
  );
  expect(onJudgeAll).toHaveBeenCalledOnce();
  expect(screen.getByText(/Judging fit · 130 left/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Assess next/ })).toBeNull();

  await act(() => {
    finish();
    return Promise.resolve();
  });
  expect(screen.queryByText(/Judging fit ·/)).toBeNull();
});

it("shows backend progress after returning to the page and keeps saved counts visible", () => {
  const fitJudgmentProgress = {
    planId: "plan",
    phase: "judging" as const,
    judged: 20,
    processed: 20,
    total: 130,
    startedAt: "2026-10-13T01:00:00.000Z",
    updatedAt: "2026-10-13T01:00:30.000Z",
  };
  const view = render(
    <DiscoveryAssessmentContinuation
      jobs={[]}
      isSearchRunning={false}
      fitJudgmentProgress={fitJudgmentProgress}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "20 of 130 scores saved",
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Waiting for the model",
  );
  view.rerender(
    <DiscoveryAssessmentContinuation
      jobs={[]}
      isSearchRunning={false}
      fitJudgmentProgress={{
        ...fitJudgmentProgress,
        judged: 40,
        processed: 40,
        phase: "saving",
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "40 of 130 scores saved",
  );
  expect(screen.getByRole("status").textContent).toContain("Saving this batch");
});

it("keeps elapsed time moving while a model batch is pending", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T01:00:00.000Z"));
  render(
    <DiscoveryAssessmentContinuation
      jobs={[]}
      isSearchRunning={false}
      fitJudgmentProgress={{
        planId: "plan",
        phase: "judging",
        judged: 0,
        processed: 0,
        total: 60,
        startedAt: "2026-10-13T01:00:00.000Z",
        updatedAt: "2026-10-13T01:00:00.000Z",
      }}
    />,
  );
  expect(screen.getByText("0s elapsed")).toBeTruthy();
  void act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByText("4s elapsed")).toBeTruthy();
  expect(screen.getByText(/0 of 60 scores saved/)).toBeTruthy();
});
