// @vitest-environment jsdom

import type {
  ApplyRunSummary,
  DiscoveryRunRecord,
  JobFinderRendererWorkspaceSnapshot,
} from "@nordri/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { JobFinderTaskCenter } from "./job-finder-task-center";
import type { TailoredDraftPreparationViewState } from "../../screens/review-queue/review-queue-status";

function createWorkspace(): JobFinderRendererWorkspaceSnapshot {
  const discoveryRun = {
    id: "discovery_running",
    state: "running",
    startedAt: "2026-07-31T10:00:00.000Z",
    completedAt: null,
    targetIds: ["source_1"],
    targetExecutions: [],
    activity: [],
    summary: {
      targetsPlanned: 1,
      targetsCompleted: 0,
      validJobsFound: 2,
      durationMs: 0,
    },
  } as unknown as DiscoveryRunRecord;
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
    activeDiscoveryRun: discoveryRun,
    applicationRecords: [],
    applyRuns: [applyRun],
    discoveryJobs: [
      { id: "job_1", company: "Mercury", title: "Software Engineer" },
    ],
    latestResumeImportRun: null,
    recentDiscoveryRuns: [],
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
    recentDiscoveryRuns: [],
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
    workspace.recentDiscoveryRuns = [
      {
        id: "finished_search",
        state: "completed",
        startedAt: "2026-07-31T10:00:00.000Z",
        completedAt: "2026-07-31T10:00:02.000Z",
        targetIds: ["source_1"],
        targetExecutions: [],
        activity: [],
        summary: {
          targetsPlanned: 1,
          targetsCompleted: 1,
          validJobsFound: 2,
          durationMs: 2_000,
        },
      } as unknown as DiscoveryRunRecord,
    ];
    workspace.searchPreferences.discovery.targets = [
      {
        id: "source_1",
        label: "Example jobs",
      } as JobFinderRendererWorkspaceSnapshot["searchPreferences"]["discovery"]["targets"][number],
    ];
    const first = render(
      <JobFinderTaskCenter
        isDiscoveryPending={false}
        isResumeImportPending={false}
        workspace={workspace}
      />,
    );

    fireEvent.click(document.querySelector("summary") as HTMLElement);
    expect(
      document.querySelector('[data-task-kind="discovery"]'),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear finished" }));
    expect(document.querySelector('[data-task-kind="discovery"]')).toBeNull();
    expect(screen.getByText(/Nothing is running/)).toBeTruthy();

    first.unmount();
    render(
      <JobFinderTaskCenter
        isDiscoveryPending={false}
        isResumeImportPending={false}
        workspace={workspace}
      />,
    );
    fireEvent.click(document.querySelector("summary") as HTMLElement);
    expect(document.querySelector('[data-task-kind="discovery"]')).toBeNull();
  });

  test("exposes native keyboard focus and dispatches only supported cancel actions once", () => {
    const onCancelApplyRun = vi.fn();
    const onCancelDiscovery = vi.fn();

    render(
      <JobFinderTaskCenter
        isDiscoveryPending
        isResumeImportPending={false}
        onCancelApplyRun={onCancelApplyRun}
        onCancelDiscovery={onCancelDiscovery}
        workspace={createWorkspace()}
      />,
    );

    const summary = screen.getByLabelText("Activity: 2 running");
    expect(summary).toBeInstanceOf(HTMLElement);
    summary?.focus();
    expect(document.activeElement).toBe(summary);

    const discoveryTask = document.querySelector(
      '[data-task-kind="discovery"]',
    );
    const applyTask = document.querySelector('[data-task-kind="apply"]');
    expect(discoveryTask).not.toBeNull();
    expect(applyTask).not.toBeNull();

    fireEvent.click(
      within(discoveryTask as HTMLElement).getByRole("button", {
        name: "Cancel task",
      }),
    );
    fireEvent.click(
      within(applyTask as HTMLElement).getByRole("button", {
        name: "Cancel task",
      }),
    );

    expect(onCancelDiscovery).toHaveBeenCalledOnce();
    expect(onCancelDiscovery).toHaveBeenCalledWith("discovery_running");
    expect(onCancelApplyRun).toHaveBeenCalledOnce();
    expect(onCancelApplyRun).toHaveBeenCalledWith("apply_running");
    expect(
      within(discoveryTask as HTMLElement).getByRole<HTMLButtonElement>(
        "button",
      ).disabled,
    ).toBe(true);
    expect(discoveryTask?.getAttribute("data-task-status")).toBe("stopping");
    expect(
      within(discoveryTask as HTMLElement).getAllByText("Stopping"),
    ).toHaveLength(2);
    expect(
      within(applyTask as HTMLElement).getByRole<HTMLButtonElement>("button")
        .disabled,
    ).toBe(true);
    expect(screen.queryByText("History estimate")).toBeNull();
  });

  test("routes a cancelled task to its truthful restart surface and closes the popover", async () => {
    const onNavigate = vi.fn();
    const workspace = createWorkspace();
    workspace.activeDiscoveryRun = null;
    workspace.recentDiscoveryRuns = [
      {
        ...(workspace.recentDiscoveryRuns[0] as DiscoveryRunRecord),
        id: "discovery_cancelled",
        state: "cancelled",
        startedAt: "2026-07-31T10:00:00.000Z",
        completedAt: "2026-07-31T10:00:02.000Z",
        targetIds: ["source_1"],
        targetExecutions: [],
        activity: [],
        summary: {
          targetsPlanned: 1,
          targetsCompleted: 0,
          validJobsFound: 2,
          durationMs: 2_000,
        },
      } as unknown as DiscoveryRunRecord,
    ];
    workspace.applyRuns = [];

    render(
      <JobFinderTaskCenter
        isDiscoveryPending={false}
        isResumeImportPending={false}
        onNavigate={onNavigate}
        workspace={workspace}
      />,
    );

    const summary = document.querySelector("summary") as HTMLElement;
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole("button", { name: "Open Find jobs" }));
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/discovery");
    await waitFor(() =>
      expect(
        (document.querySelector("details") as HTMLDetailsElement).open,
      ).toBe(false),
    );
  });

  test("prepares the unfinished jobs from a safety-limit pause and keeps review one click away", () => {
    const onNavigate = vi.fn();
    const onPrepareRemainingJobs = vi.fn();
    const workspace = createWorkspace();
    workspace.activeDiscoveryRun = null;
    workspace.recentDiscoveryRuns = [];
    workspace.applyRuns = [
      {
        ...workspace.applyRuns[0]!,
        state: "paused_for_user_review",
        jobIds: ["job_1", "job_2"],
        totalJobs: 2,
        pendingJobs: 2,
        currentJobId: null,
      },
    ];
    workspace.discoveryJobs.push({
      id: "job_2",
      company: "Venus",
      title: "Platform Engineer",
    } as JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number]);
    // The safety limit here is a sample waiting to be reviewed.
    workspace.intelligence = {
      ...workspace.intelligence,
      safeguards: {
        companyApplicationCaps: [],
        simultaneousApplicationConflicts: [],
        listingSignals: [],
        abnormalFailurePauses: [],
        contradictoryAnswerDetections: [],
        safeguardDismissals: [],
        updatedAt: null,
        preparedBatchSampleReviews: [
          {
            batchId: workspace.applyRuns[0]!.id,
            reviewCompleted: false,
          },
        ],
      },
    } as unknown as JobFinderRendererWorkspaceSnapshot["intelligence"];

    render(
      <JobFinderTaskCenter
        isDiscoveryPending={false}
        isResumeImportPending={false}
        onNavigate={onNavigate}
        onPrepareRemainingJobs={onPrepareRemainingJobs}
        workspace={workspace}
      />,
    );

    fireEvent.click(document.querySelector("summary") as HTMLElement);
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare remaining jobs" }),
    );
    expect(onPrepareRemainingJobs).toHaveBeenCalledWith(["job_1", "job_2"]);

    fireEvent.click(document.querySelector("summary") as HTMLElement);
    fireEvent.click(
      screen.getByRole("button", { name: "Review prepared sample" }),
    );
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/safeguards");
  });

  test("closes predictably with Escape, outside interaction, and the visible close control", () => {
    render(
      <>
        <button type="button">Outside control</button>
        <JobFinderTaskCenter
          isDiscoveryPending
          isResumeImportPending={false}
          workspace={createWorkspace()}
        />
      </>,
    );

    const details = document.querySelector("details") as HTMLDetailsElement;
    const summary = screen.getByLabelText("Activity: 2 running");

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
    const onCancelDiscovery = vi.fn(() => Promise.resolve(false));

    render(
      <JobFinderTaskCenter
        isDiscoveryPending
        isResumeImportPending={false}
        onCancelDiscovery={onCancelDiscovery}
        workspace={createWorkspace()}
      />,
    );

    const discoveryTask = document.querySelector(
      '[data-task-kind="discovery"]',
    );
    expect(discoveryTask).not.toBeNull();
    const cancelButton = within(discoveryTask as HTMLElement).getByRole(
      "button",
      { name: "Cancel task" },
    );
    fireEvent.click(cancelButton);
    await waitFor(() => expect(cancelButton).toHaveProperty("disabled", false));
    expect(
      within(discoveryTask as HTMLElement).getByRole("status").textContent,
    ).toContain(
      "Cancellation did not complete. Check the task, then try again.",
    );
    fireEvent.click(cancelButton);
    expect(onCancelDiscovery).toHaveBeenCalledTimes(2);
  });

  test("keeps the panel open and explains when task navigation fails", async () => {
    const onNavigate = vi.fn(() => Promise.reject(new Error("route failed")));
    const workspace = createWorkspace();
    workspace.activeDiscoveryRun = null;
    workspace.recentDiscoveryRuns = [
      {
        id: "discovery_failed",
        state: "failed",
        startedAt: "2026-07-31T10:00:00.000Z",
        completedAt: "2026-07-31T10:00:02.000Z",
        targetIds: ["source_1"],
        targetExecutions: [],
        activity: [],
        summary: {
          targetsPlanned: 1,
          targetsCompleted: 0,
          validJobsFound: 0,
          durationMs: 2_000,
        },
      } as unknown as DiscoveryRunRecord,
    ];
    workspace.applyRuns = [];

    render(
      <JobFinderTaskCenter
        isDiscoveryPending={false}
        isResumeImportPending={false}
        onNavigate={onNavigate}
        workspace={workspace}
      />,
    );

    const details = document.querySelector("details") as HTMLDetailsElement;
    fireEvent.click(document.querySelector("summary") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Open Find jobs" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "That page could not open. Try again.",
    );
    expect(details.open).toBe(true);
  });

  test("shows useful progress without unavailable capability clutter", () => {
    render(
      <JobFinderTaskCenter
        isDiscoveryPending
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

  test("tracks an active tailored-drafts batch with progress, failures, and a working Stop control", async () => {
    const onStopTailoredDraftPreparation = vi.fn();
    const preparation: TailoredDraftPreparationViewState = {
      attemptedCount: 3,
      completedCount: 2,
      currentIndex: 3,
      eligibleRemainingCount: 0,
      failedCount: 1,
      status: "running",
      totalCount: 5,
    };

    const { rerender } = render(
      <JobFinderTaskCenter
        isDiscoveryPending={false}
        isResumeImportPending={false}
        onStopTailoredDraftPreparation={onStopTailoredDraftPreparation}
        tailoredDraftPreparation={preparation}
        workspace={createQuietWorkspace()}
      />,
    );

    const summary = screen.getByLabelText("Activity: 1 running");
    expect(summary).toBeInstanceOf(HTMLElement);
    const task = document.querySelector('[data-task-kind="tailored_drafts"]');
    expect(task).not.toBeNull();
    expect(
      within(task as HTMLElement).getByText("2 of 5 prepared · 1 failed"),
    ).toBeInstanceOf(HTMLElement);

    const stopButton = within(task as HTMLElement).getByRole("button", {
      name: "Stop",
    });
    fireEvent.click(stopButton);
    expect(onStopTailoredDraftPreparation).toHaveBeenCalledOnce();
    expect(
      within(task as HTMLElement).getByRole<HTMLButtonElement>("button", {
        name: "Stop",
      }).disabled,
    ).toBe(true);

    rerender(
      <JobFinderTaskCenter
        isDiscoveryPending={false}
        isResumeImportPending={false}
        onStopTailoredDraftPreparation={onStopTailoredDraftPreparation}
        tailoredDraftPreparation={{
          ...preparation,
          status: "stopped",
        }}
        workspace={createQuietWorkspace()}
      />,
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-task-kind="tailored_drafts"]'),
      ).toBeNull(),
    );
  });

  test("hides the tailored-drafts task when no batch run is active", () => {
    render(
      <JobFinderTaskCenter
        isDiscoveryPending={false}
        isResumeImportPending={false}
        tailoredDraftPreparation={{
          attemptedCount: 3,
          completedCount: 3,
          currentIndex: null,
          eligibleRemainingCount: 0,
          failedCount: 0,
          status: "completed",
          totalCount: 3,
        }}
        workspace={createQuietWorkspace()}
      />,
    );

    expect(
      document.querySelector('[data-task-kind="tailored_drafts"]'),
    ).toBeNull();
    // Nothing running: the chip names itself and renders no count at all.
    const summary = document.querySelector("summary") as HTMLElement;
    expect(summary.getAttribute("aria-label")).toBe("Activity");
    expect(summary.textContent).not.toMatch(/\d/);
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
      isDiscoveryPending={false}
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
