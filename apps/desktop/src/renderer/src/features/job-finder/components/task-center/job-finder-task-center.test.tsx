// @vitest-environment jsdom

import type {
  ApplyRunSummary,
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { JobFinderTaskCenter } from "./job-finder-task-center";

// The fixtures' runs end on 31 July; Activity shows a finished run for a day.
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date"],
    now: new Date("2026-07-31T12:00:00.000Z"),
  });
});
afterEach(() => {
  vi.useRealTimers();
});

function createWorkspace(): JobFinderRendererWorkspaceSnapshot {
  const applyRun = {
    id: "apply_running",
    mode: "copilot",
    state: "running",
    jobIds: ["job_1"],
    currentJobId: "job_1",
    createdAt: "2026-07-31T10:00:00.000Z",
    updatedAt: "2026-07-31T10:00:04.000Z",
    completedAt: null,
    totalJobs: 1,
    pendingJobs: 1,
    blockedJobs: 0,
    failedJobs: 0,
  } as ApplyRunSummary;

  return {
    applicationRecords: [],
    applyRuns: [applyRun],
    discoveryJobs: [
      { id: "job_1", company: "Mercury", title: "Software Engineer" },
    ],
    latestResumeImportRun: null,
    searchPreferences: {
      discovery: { targets: [{ id: "source_1", label: "Mercury careers" }] },
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function createQuietWorkspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    applicationRecords: [],
    applyRuns: [],
    discoveryJobs: [],
    latestResumeImportRun: null,
    searchPreferences: {
      discovery: { targets: [] },
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("JobFinderTaskCenter", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  test("clears finished history and keeps it cleared after reopening", () => {
    const workspace = createQuietWorkspace();
    workspace.applyRuns = [
      {
        ...createWorkspace().applyRuns[0]!,
        state: "completed",
        pendingJobs: 0,
        updatedAt: "2026-07-31T10:00:02.000Z",
        completedAt: "2026-07-31T10:00:02.000Z",
      },
    ];
    const first = render(
      <JobFinderTaskCenter
        isResumeImportPending={false}
        workspace={workspace}
      />,
    );

    fireEvent.click(document.querySelector("summary") as HTMLElement);
    expect(
      document.querySelector('[data-task-kind="apply"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(document.querySelector('[data-task-kind="apply"]')).toBeNull();
    expect(screen.getByText(/Nothing is running/)).toBeTruthy();

    first.unmount();
    render(
      <JobFinderTaskCenter
        isResumeImportPending={false}
        workspace={workspace}
      />,
    );
    fireEvent.click(document.querySelector("summary") as HTMLElement);
    expect(document.querySelector('[data-task-kind="apply"]')).toBeNull();
  });

  test("exposes native keyboard focus and dispatches only supported cancel actions once", () => {
    const onCancelApplyRun = vi.fn();

    render(
      <JobFinderTaskCenter
        isResumeImportPending={false}
        onCancelApplyRun={onCancelApplyRun}
        workspace={createWorkspace()}
      />,
    );

    const summary = screen.getByLabelText("Activity: 1 running");
    expect(summary).toBeInstanceOf(HTMLElement);
    summary?.focus();
    expect(document.activeElement).toBe(summary);

    const applyTask = document.querySelector('[data-task-kind="apply"]');
    expect(applyTask).not.toBeNull();

    fireEvent.click(
      within(applyTask as HTMLElement).getByRole("button", {
        name: "Cancel task",
      }),
    );

    expect(onCancelApplyRun).toHaveBeenCalledOnce();
    expect(onCancelApplyRun).toHaveBeenCalledWith("apply_running");
    expect(
      within(applyTask as HTMLElement).getByRole<HTMLButtonElement>("button")
        .disabled,
    ).toBe(true);
    expect(screen.queryByText("History estimate")).toBeNull();
  });

  test("closes predictably with Escape, outside interaction, and the visible close control", () => {
    render(
      <>
        <button type="button">Outside control</button>
        <JobFinderTaskCenter
          isResumeImportPending={false}
          workspace={createWorkspace()}
        />
      </>,
    );

    const details = document.querySelector("details") as HTMLDetailsElement;
    const summary = screen.getByLabelText("Activity: 1 running");

    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);

    fireEvent.click(summary);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Outside control" }),
    );
    expect(details.open).toBe(false);

    fireEvent.click(summary);
    fireEvent.pointerDown(screen.getByRole("region", { name: "Activity" }), {
      bubbles: true,
    });
    expect(details.open).toBe(true);

    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("button", { name: "Close Activity" }));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(summary);

    const panel = screen.getByRole("region", { name: "Activity" });
    // Anchored under its own trigger and bounded at every width: as a fixed
    // bottom sheet it resolved against the header's backdrop filter and opened
    // upward over the title bar at the minimum window size.
    expect(panel.className).toContain("absolute");
    expect(panel.className).toContain("top-12");
    expect(panel.className).toContain("max-h-[min(38rem,calc(100vh-8rem))]");
    expect(panel.className).not.toContain("fixed");
    // An opaque surface, so nothing behind it ever shows through.
    expect(panel.className).toContain("surface-popover-solid");
  });

  test("re-enables cancellation when the owning operation reports a failure", async () => {
    const onCancelApplyRun = vi.fn(() => Promise.resolve(false));

    render(
      <JobFinderTaskCenter
        isResumeImportPending={false}
        onCancelApplyRun={onCancelApplyRun}
        workspace={createWorkspace()}
      />,
    );

    const applyTask = document.querySelector('[data-task-kind="apply"]');
    expect(applyTask).not.toBeNull();
    const cancelButton = within(applyTask as HTMLElement).getByRole(
      "button",
      { name: "Cancel task" },
    );
    fireEvent.click(cancelButton);
    await waitFor(() => expect(cancelButton).toHaveProperty("disabled", false));
    expect(
      within(applyTask as HTMLElement).getByRole("status").textContent,
    ).toContain(
      "Cancellation did not complete. Check the task, then try again.",
    );
    fireEvent.click(cancelButton);
    expect(onCancelApplyRun).toHaveBeenCalledTimes(2);
  });

  test("shows useful progress without unavailable capability clutter", () => {
    render(
      <JobFinderTaskCenter
        isResumeImportPending={false}
        workspace={createWorkspace()}
      />,
    );

    expect(screen.getByText("Activity", { selector: "h2" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(screen.getAllByText("Progress").length).toBeGreaterThan(0);
    expect(screen.queryByText("Pause")).toBeNull();
    expect(screen.queryByText("Not available")).toBeNull();
  });
});

test("Activity shows an item cancelled by the person without a failure count", () => {
  const workspace = createQuietWorkspace();
  workspace.applyRuns = [
    {
      ...createWorkspace().applyRuns[0]!,
      state: "completed",
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 0,
      failedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
    },
  ];
  workspace.applyJobResults = [
    {
      id: "cancelled_item",
      runId: workspace.applyRuns[0]!.id,
      jobId: "job_1",
      state: "cancelled",
      summary: "Cancelled by you",
      updatedAt: "2026-10-01T10:00:00.000Z",
    },
  ] as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
  render(
    <JobFinderTaskCenter
      isResumeImportPending={false}
      workspace={workspace}
    />,
  );
  fireEvent.click(document.querySelector("summary") as HTMLElement);
  const item = document.querySelector(
    '[data-task-kind="apply"]',
  ) as HTMLElement;
  expect(item.textContent).toContain("Cancelled by you");
  expect(item.textContent).toContain("1 cancelled");
  expect(item.textContent).not.toMatch(/failed|need attention|security check/i);
});
