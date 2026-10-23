// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { SavedJob } from "@nestor/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  DiscoveryAssessmentContinuation,
  resetDiscoveryAutoJudgeForTests,
} from "./discovery-assessment-continuation";

beforeEach(() => resetDiscoveryAutoJudgeForTests());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function unreadJobs(count: number) {
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `unread_${index}`,
        discoveryMethod: "browser_agent",
        matchAssessment: { judgment: null },
      }) as SavedJob,
  );
}

it("judges jobs without a fit score on its own, once per session", async () => {
  let finish: () => void = () => undefined;
  const onJudgeAll = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <DiscoveryAssessmentContinuation
      jobs={unreadJobs(130)}
      isSearchRunning={false}
      onJudgeAll={onJudgeAll}
    />,
  );
  expect(onJudgeAll).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toContain(
    "Judging fit for 130 jobs",
  );
  expect(screen.queryByRole("button")).toBeNull();
  await act(() => {
    finish();
    return Promise.resolve();
  });
  view.unmount();

  render(
    <DiscoveryAssessmentContinuation
      jobs={unreadJobs(130)}
      isSearchRunning={false}
      onJudgeAll={onJudgeAll}
    />,
  );
  expect(onJudgeAll).toHaveBeenCalledOnce();
});

it("waits for a running search and judges again once it ends", () => {
  const onJudgeAll = vi.fn(() => new Promise<void>(() => undefined));
  const view = render(
    <DiscoveryAssessmentContinuation
      jobs={unreadJobs(3)}
      isSearchRunning
      onJudgeAll={onJudgeAll}
    />,
  );
  expect(onJudgeAll).not.toHaveBeenCalled();
  view.rerender(
    <DiscoveryAssessmentContinuation
      jobs={unreadJobs(3)}
      isSearchRunning={false}
      onJudgeAll={onJudgeAll}
    />,
  );
  expect(onJudgeAll).toHaveBeenCalledOnce();
});

it("offers one quiet retry when the pass could not run", async () => {
  const onJudgeAll = vi
    .fn()
    .mockRejectedValueOnce(new Error("Fit judging is unavailable right now."))
    .mockResolvedValueOnce(undefined);
  render(
    <DiscoveryAssessmentContinuation
      jobs={unreadJobs(1)}
      isSearchRunning={false}
      onJudgeAll={onJudgeAll}
    />,
  );
  await act(() => Promise.resolve());
  expect(screen.getByRole("status").textContent).toContain(
    "1 job has no fit score yet",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await Promise.resolve();
  });
  expect(onJudgeAll).toHaveBeenCalledTimes(2);
});

it("shows backend progress after returning to the page", () => {
  const fitJudgmentProgress = {
    planId: "plan",
    phase: "judging" as const,
    judged: 20,
    processed: 20,
    total: 130,
    startedAt: "2026-10-13T01:00:00.000Z",
    updatedAt: "2026-10-13T01:00:30.000Z",
  };
  const onJudgeAll = vi.fn(() => Promise.resolve());
  const view = render(
    <DiscoveryAssessmentContinuation
      jobs={unreadJobs(110)}
      isSearchRunning={false}
      fitJudgmentProgress={fitJudgmentProgress}
      onJudgeAll={onJudgeAll}
    />,
  );
  // A pass already running in main is not started again.
  expect(onJudgeAll).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain(
    "Judging fit · 20 of 130 scored",
  );
  view.rerender(
    <DiscoveryAssessmentContinuation
      jobs={unreadJobs(90)}
      isSearchRunning={false}
      fitJudgmentProgress={{
        ...fitJudgmentProgress,
        judged: 40,
        processed: 40,
        phase: "saving",
      }}
      onJudgeAll={onJudgeAll}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("40 of 130 scored");
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
  expect(screen.getByText("0s")).toBeTruthy();
  void act(() => vi.advanceTimersByTime(4000));
  expect(screen.getByText("4s")).toBeTruthy();
});

it("stays out of the way when every job has a score", () => {
  const onJudgeAll = vi.fn(() => Promise.resolve());
  const view = render(
    <DiscoveryAssessmentContinuation
      jobs={[]}
      isSearchRunning={false}
      onJudgeAll={onJudgeAll}
    />,
  );
  expect(onJudgeAll).not.toHaveBeenCalled();
  expect(view.container.textContent).toBe("");
});
