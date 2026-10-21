// @vitest-environment jsdom

import type {
  CampaignNotification,
  JobFinderRendererWorkspaceSnapshot,
  ReviewQueueItem,
} from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JobSearchHomeScreen,
  listCurrentUnreadNotifications,
} from "./job-search-home-screen";

afterEach(cleanup);

function workspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    activeCampaignId: "campaign-1",
    activityControl: { paused: false, pausedAt: null, reason: null },
    activeDiscoveryRun: null,
    activeSourceDebugRun: null,
    applicationRecords: [],
    applyJobResults: [],
    applyRuns: [],
    campaignNotifications: [],
    campaigns: [
      {
        id: "campaign-1",
        name: "Remote TypeScript",
        status: "active",
        jobIds: [],
        history: [],
      },
    ],
    dashboard: {
      activeCampaignCount: 1,
      activeCampaignId: "campaign-1",
      applicationsAppliedThisWeek: 0,
      applicationsAppliedToday: 0,
      applicationsReadyForApproval: 0,
      backgroundOperationCount: 0,
      generatedAt: "2026-08-15T09:00:00.000Z",
      interviewRate: null,
      jobsAwaitingReview: 0,
      jobsFoundToday: 0,
      needsYouCount: 0,
      recommendedNextAction: {
        detail: "Run the active search plan to collect relevant openings.",
        label: "Find jobs",
        route: "/job-finder/discovery",
      },
      responseRate: null,
      sourceHealth: { healthy: 1, needsAttention: 0, running: 0, total: 1 },
      upcomingFollowUps: 0,
      upcomingInterviews: 0,
    },
    discoveryJobs: [],
    recentDiscoveryRuns: [],
    recentSourceDebugRuns: [],
    reviewQueue: [],
    searchPreferences: {
      discovery: {
        targets: [
          {
            id: "target-1",
            label: "Replica board",
            url: "http://127.0.0.1/",
            enabled: true,
          },
        ],
        historyLimit: 5,
      },
    },
    settings: {},
    profileSetupState: {
      status: "completed",
      currentStep: "ready_check",
      completedAt: "2026-08-15T08:00:00.000Z",
      reviewItems: [],
      lastResumedAt: "2026-08-15T08:00:00.000Z",
    },
    resumeExportArtifacts: [],
    tailoredAssets: [],
    userActionRequests: [],
    latestResumeImportRun: null,
    intelligence: {
      groupedDecisions: [],
      safeguards: {
        companyApplicationCaps: [],
        simultaneousApplicationConflicts: [],
        listingSignals: [],
        abnormalFailurePauses: [],
        preparedBatchSampleReviews: [],
        contradictoryAnswerDetections: [],
        safeguardDismissals: [],
        updatedAt: null,
      },
      companies: [],
      outcomeEvents: [],
      resumeStrategies: [],
      resumeStrategySelections: [],
      rapidReviewLogs: [],
      outcomeAnalytics: null,
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function withReadyShortlist(ws: JobFinderRendererWorkspaceSnapshot, ids: string[]) {
  return {
    ...ws,
    campaigns: ws.campaigns.map((campaign) => ({ ...campaign, jobIds: ids })),
    discoveryJobs: ids.map((id) => ({
      id,
      title: id,
      company: "Employer",
      discoveryMethod: "browser_agent",
      matchAssessment: {
        score: 70,
        dimensions: { roleSuitability: { state: "exact" } },
        contextFingerprint: "ctx",
        postingFingerprint: "post",
      },
    })),
    recentDiscoveryRuns: [
      {
        id: "run-1",
        state: "completed",
        startedAt: "2026-08-15T09:30:00.000Z",
        completedAt: "2026-08-15T09:40:00.000Z",
        targetIds: ["target-1"],
        activity: [],
        targetExecutions: [],
        summary: {
          validJobsFound: ids.length,
          duplicatesMerged: 0,
          targetsPlanned: 1,
          targetsCompleted: 1,
        },
      },
    ],
    reviewQueue: ids.map(
      (id) =>
        ({
          jobId: id,
          title: id,
          company: "Employer",
          location: "Remote",
          matchScore: 70,
          applicationStatus: "drafting",
          assetStatus: "ready",
          progressPercent: null,
          resumeAssetId: `asset-${id}`,
          resumeApplicationMode: "tailored_per_job",
          resumeTailoringMode: null,
          resumeReview: { status: "needs_review" },
          updatedAt: "2026-08-15T10:00:00.000Z",
        }) as unknown as ReviewQueueItem,
    ),
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

function baseProps() {
  return {
    activityPending: false,
    onNavigate: vi.fn(),
    onPauseActivity: vi.fn(),
    onResumeActivity: vi.fn(),
    onSelectCampaign: vi.fn(),
  };
}

describe("JobSearchHomeScreen", () => {
  it("shows one source fix for a missing starting page without generic retry advice", () => {
    const ws = workspace();
    ws.searchPreferences.discovery.targets[0]!.staleReason =
      "Starting page returned HTTP 404";
    render(
      <JobSearchHomeScreen
        {...baseProps()}
        workspace={ws}
        discoveryRunFeedback={{
          status: "failed",
          detail:
            "Agent discovery failed: Starting page returned HTTP 404: http://127.0.0.1/gone/",
          headline: "Something unexpected stopped this search.",
          recovery: null,
          targetLabel: null,
        }}
      />,
    );
    expect(screen.getByText(/1 job source needs attention/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open job sources" }),
    ).toBeTruthy();
    expect(screen.queryByTestId("home-discovery-run-feedback")).toBeNull();
  });

  it("keeps the failing-sources line hidden once the person hides it, until another source fails", () => {
    window.localStorage.clear();
    const ws = workspace();
    ws.searchPreferences.discovery.targets[0]!.staleReason =
      "Starting page returned HTTP 404";
    const view = render(
      <JobSearchHomeScreen {...baseProps()} workspace={ws} />,
    );
    const line = screen.getByText(/1 job source needs attention/);
    // A quiet line: no red dot.
    expect(
      line
        .closest("[data-page-status-item]")
        ?.querySelector("[data-page-status-dot]"),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Hide for now: 1 job source needs attention/,
      }),
    );
    expect(screen.queryByText(/job source needs attention/)).toBeNull();

    view.unmount();
    render(<JobSearchHomeScreen {...baseProps()} workspace={ws} />);
    expect(screen.queryByText(/job source needs attention/)).toBeNull();

    cleanup();
    const another = workspace();
    another.searchPreferences.discovery.targets[0]!.staleReason =
      "Starting page returned HTTP 404";
    another.searchPreferences.discovery.targets[0]!.id = "target-other";
    render(<JobSearchHomeScreen {...baseProps()} workspace={another} />);
    expect(screen.getByText(/1 job source needs attention/)).toBeTruthy();
    window.localStorage.clear();
  });

  it("names a 404-only search failure once, on the next step", () => {
    const ws = workspace();
    ws.recentDiscoveryRuns = [
      {
        id: "run-404",
        campaignId: ws.activeCampaignId,
        state: "failed",
        runPhase: null,
        startedAt: "2026-08-15T09:30:00.000Z",
        completedAt: "2026-08-15T09:31:00.000Z",
        targetIds: ["target-1"],
        activity: [],
        targetExecutions: [
          {
            targetId: "target-1",
            state: "failed",
            jobsFound: 0,
            warning:
              "Agent discovery failed: Starting page returned HTTP 404: http://127.0.0.1/nope/",
          },
        ],
        summary: { targetsPlanned: 1, targetsCompleted: 0, validJobsFound: 0 },
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["recentDiscoveryRuns"];
    render(
      <JobSearchHomeScreen
        {...baseProps()}
        workspace={ws}
        discoveryRunFeedback={{
          status: "failed",
          detail:
            "Agent discovery failed: Starting page returned HTTP 404: http://127.0.0.1/nope/",
          headline: "The search stopped before it could finish.",
          recovery: null,
          targetLabel: null,
        }}
      />,
    );
    const card = screen.getByTestId("home-next-step");
    expect(card.getAttribute("data-home-next-step")).toBe("source_failed");
    expect(screen.queryByTestId("home-discovery-run-feedback")).toBeNull();
  });

  it("says a stopped search once, in the status line, without a callout", () => {
    const ws = workspace();
    ws.recentDiscoveryRuns = [
      {
        id: "run-stopped",
        campaignId: ws.activeCampaignId,
        state: "cancelled",
        runPhase: null,
        startedAt: "2026-08-15T09:30:00.000Z",
        completedAt: "2026-08-15T09:31:00.000Z",
        targetIds: ["target-1"],
        activity: [],
        targetExecutions: [],
        summary: { targetsPlanned: 1, targetsCompleted: 0, validJobsFound: 0 },
      },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["recentDiscoveryRuns"];
    render(
      <JobSearchHomeScreen
        {...baseProps()}
        workspace={ws}
        discoveryRunFeedback={{
          status: "cancelled",
          detail: null,
          headline: "The search stopped before it could finish.",
          recovery: null,
          targetLabel: null,
        }}
      />,
    );
    expect(screen.getByText(/Last search stopped early/)).toBeTruthy();
    expect(screen.queryByTestId("home-discovery-run-feedback")).toBeNull();
  });

  it("drops a search failure once a later search of the plan finished (sign-in carried on)", () => {
    const ws = workspace();
    const failedAt = Date.parse("2026-08-15T10:00:00.000Z");
    const feedback = {
      status: "failed" as const,
      recordedAtMs: failedAt,
      detail: "Stopped at a sign-in page.",
      headline: "The search stopped before it could finish.",
      recovery: null,
      targetLabel: null,
    };
    const { rerender } = render(
      <JobSearchHomeScreen
        {...baseProps()}
        workspace={ws}
        discoveryRunFeedback={feedback}
      />,
    );
    expect(screen.getByTestId("home-discovery-run-feedback")).toBeTruthy();
    const later = {
      ...ws,
      recentDiscoveryRuns: [
        {
          id: "run_after_sign_in",
          campaignId: ws.activeCampaignId,
          state: "completed",
          runPhase: null,
          startedAt: "2026-08-15T10:01:00.000Z",
          completedAt: "2026-08-15T10:02:00.000Z",
          targetIds: ["target-1"],
          activity: [],
          targetExecutions: [],
          summary: {
            validJobsFound: 10,
            duplicatesMerged: 0,
            targetsPlanned: 1,
            targetsCompleted: 1,
            durationMs: 60_000,
            warnings: [],
            report: { found: 10, new: 10, kept: 10, alreadyHere: 0 },
          },
        },
      ],
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    rerender(
      <JobSearchHomeScreen
        {...baseProps()}
        workspace={later}
        discoveryRunFeedback={feedback}
      />,
    );
    expect(screen.queryByTestId("home-discovery-run-feedback")).toBeNull();
  });

  it("puts the status under the title and runs the first search from the card", () => {
    const onRunDiscovery = vi.fn();
    render(
      <JobSearchHomeScreen
        {...baseProps()}
        onRunDiscovery={onRunDiscovery}
        workspace={workspace()}
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Home" }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Ready to search 1 source. Nothing has been searched yet.",
      ),
    ).toBeTruthy();
    const card = screen.getByTestId("home-next-step");
    expect(card.getAttribute("data-home-next-step")).toBe("first_search");
    fireEvent.click(within(card).getByRole("button", { name: "Search now" }));
    expect(onRunDiscovery).toHaveBeenCalledWith(undefined);
    // Nothing else is on the page yet: no tiles, no notifications, no pause.
    expect(screen.queryByTestId("home-pipeline")).toBeNull();
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Pause/ })).toBeNull();
  });

  it("starts Apply to all from Home with the ready jobs and shows the pending state", () => {
    let resolveApply: () => void = () => undefined;
    const onApplyToJobs = vi.fn(
      () => new Promise<void>((resolve) => (resolveApply = resolve)),
    );
    render(
      <JobSearchHomeScreen
        {...baseProps()}
        applicationAutomationMode="confirm_before_submit"
        onApplyToJobs={onApplyToJobs}
        workspace={withReadyShortlist(workspace(), ["job_a", "job_b"])}
      />,
    );
    const card = screen.getByTestId("home-next-step");
    expect(
      within(card).getByRole("heading", { name: "Apply to 2 ready jobs" }),
    ).toBeTruthy();
    expect(card.textContent).toContain("waits for your go-ahead");
    const button = within(card).getByRole("button", { name: "Apply to all 2" });
    fireEvent.click(button);
    expect(onApplyToJobs).toHaveBeenCalledWith(["job_a", "job_b"]);
    expect(
      button.getAttribute("aria-busy") ?? button.getAttribute("data-pending"),
    ).not.toBeNull();
    resolveApply();
  });

  it("says why a press on Home did nothing, with Dismiss, instead of staying silent", () => {
    const refusal = {
      message:
        "Nothing was started. The resume for 'Cedar Frontend Engineer' has a line waiting for your decision. Open it, keep or change the line, then apply.",
    };
    const { rerender } = render(
      <JobSearchHomeScreen
        {...baseProps()}
        actionState={refusal}
        workspace={workspace()}
      />,
    );
    const note = screen.getByTestId("home-action-message");
    expect(note.getAttribute("role")).toBe("status");
    expect(note.textContent).toContain("Nothing was started.");
    fireEvent.click(within(note).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("home-action-message")).toBeNull();
    // The same refusal from a second press is a new message and shows again.
    rerender(
      <JobSearchHomeScreen
        {...baseProps()}
        actionState={{ ...refusal }}
        workspace={workspace()}
      />,
    );
    expect(screen.getByTestId("home-action-message")).toBeTruthy();
  });

  it("names the saved mode and changes it with one press on the Applying settings", () => {
    const props = baseProps();
    render(
      <JobSearchHomeScreen
        {...props}
        applicationAutomationMode="autonomous_submit"
        onApplyToJobs={vi.fn()}
        workspace={withReadyShortlist(workspace(), ["job_a"])}
      />,
    );
    const card = screen.getByTestId("home-next-step");
    expect(card.textContent).toContain(
      "Job Finder fills in and sends each application",
    );
    fireEvent.click(
      within(card).getByRole("button", { name: "Change how it applies" }),
    );
    expect(props.onNavigate).toHaveBeenCalledWith(
      "/job-finder/settings#settings-application-authority",
    );
  });

  it("renders the pipeline with the sidebar's numbers and navigates from a tile", () => {
    const props = baseProps();
    render(
      <JobSearchHomeScreen
        {...props}
        workspace={withReadyShortlist(workspace(), ["job_a"])}
      />,
    );
    const pipeline = screen.getByTestId("home-pipeline");
    const tiles = within(pipeline).getAllByRole("button");
    expect(tiles.map((tile) => tile.textContent)).toEqual([
      "Find jobs1",
      "Shortlisted11 ready to apply",
      "Applications0",
    ]);
    fireEvent.click(tiles[1]!);
    expect(props.onNavigate).toHaveBeenCalledWith("/job-finder/review-queue");
  });

  it("lists running work with Stop and offers the pause there", () => {
    const props = baseProps();
    const onStopSearch = vi.fn();
    const ws = workspace();
    ws.activeDiscoveryRun = {
      id: "run-live",
      state: "running",
      runPhase: null,
      startedAt: "2026-08-15T11:58:00.000Z",
      completedAt: null,
      targetIds: ["target-1"],
      activity: [],
      targetExecutions: [],
      summary: { targetsPlanned: 1, targetsCompleted: 0 },
    } as unknown as JobFinderRendererWorkspaceSnapshot["activeDiscoveryRun"];
    render(
      <JobSearchHomeScreen
        {...props}
        onStopSearch={onStopSearch}
        workspace={ws}
      />,
    );
    const now = screen.getByTestId("home-now");
    expect(within(now).getByText("Searching Replica board")).toBeTruthy();
    fireEvent.click(within(now).getByRole("button", { name: "Stop" }));
    expect(onStopSearch).toHaveBeenCalledWith("run-live");
    fireEvent.click(
      within(now).getByRole("button", { name: "Pause new work" }),
    );
    expect(props.onPauseActivity).toHaveBeenCalledTimes(1);
  });

  it("offers one Resume while paused, on the next step instead of the header", () => {
    const props = baseProps();
    const ws = workspace();
    ws.activityControl = {
      paused: true,
      pausedAt: "2026-08-15T11:00:00.000Z",
      reason: "Paused by you.",
    };
    render(<JobSearchHomeScreen {...props} workspace={ws} />);
    const resumeButtons = screen.getAllByRole("button", { name: "Resume" });
    expect(resumeButtons).toHaveLength(1);
    expect(resumeButtons[0]!.closest("[data-page-header-actions]")).toBeNull();
    fireEvent.click(resumeButtons[0]!);
    expect(props.onResumeActivity).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Paused\./)).toBeTruthy();
  });

  it("keeps Try again for all in place beside a form waiting to be sent", () => {
    const props = baseProps();
    const onApplyToJobs = vi.fn(() => Promise.resolve());
    const ws = withReadyShortlist(workspace(), ["job_a", "job_b", "job_c"]);
    ws.applicationRecords = ["job_a", "job_b", "job_c"].map((jobId) => ({
      id: `record-${jobId}`,
      jobId,
      title: jobId,
      company: "Employer",
      status: "ready_for_review",
      lastAttemptState: jobId === "job_a" ? "ready" : "failed",
      automationMode: "prepare_only",
      questionSummary: { total: 0, answered: 0 },
      lastActionLabel: "Stopped",
      lastUpdatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applicationRecords"];
    ws.applyJobResults = ["job_a", "job_b", "job_c"].map((jobId) => ({
      id: `result-${jobId}`,
      runId: "apply-1",
      jobId,
      applicationRecordId: `record-${jobId}`,
      state: jobId === "job_a" ? "awaiting_review" : "failed",
      blockerReason: null,
      updatedAt: "2026-08-15T11:00:00.000Z",
    })) as unknown as JobFinderRendererWorkspaceSnapshot["applyJobResults"];
    render(
      <JobSearchHomeScreen
        {...props}
        onApplyToJobs={onApplyToJobs}
        workspace={ws}
      />,
    );
    const card = screen.getByTestId("home-next-step");
    expect(card.getAttribute("data-home-next-step")).toBe("send");
    fireEvent.click(
      within(card).getByRole("button", { name: "Try again for all 2" }),
    );
    expect(onApplyToJobs).toHaveBeenCalledWith(["job_b", "job_c"]);
    expect(props.onNavigate).not.toHaveBeenCalled();
  });

  it("shows notifications only while one is unread", () => {
    const notification = (
      id: string,
      unread: boolean,
    ): CampaignNotification => ({
      id,
      campaignId: "campaign-1",
      kind: "strong_match",
      title: `Strong match: ${id}`,
      body: null,
      createdAt: "2026-08-15T10:00:00.000Z",
      readAt: unread ? null : "2026-08-15T11:00:00.000Z",
      unread,
      jobId: null,
      sourceTargetId: null,
    });
    const props = {
      ...baseProps(),
      onMarkCampaignNotificationRead: vi.fn(),
      onMarkAllCampaignNotificationsRead: vi.fn(),
    };
    const { rerender } = render(
      <JobSearchHomeScreen
        {...props}
        campaignNotifications={[notification("a", false)]}
        workspace={workspace()}
      />,
    );
    expect(screen.queryByRole("region", { name: "Notifications" })).toBeNull();
    rerender(
      <JobSearchHomeScreen
        {...props}
        campaignNotifications={[
          notification("a", false),
          notification("b", true),
        ]}
        workspace={workspace()}
      />,
    );
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getByText("Strong match: b")).toBeTruthy();
    expect(within(region).queryByText("Strong match: a")).toBeNull();
  });
});

describe("listCurrentUnreadNotifications", () => {
  it("drops a failure note about a job that has since been sent", () => {
    const note = (id: string, jobId: string | null) =>
      ({
        id,
        campaignId: "c",
        kind: "blocked_work",
        title: "Failed: Cedar",
        body: "The application page could not be opened.",
        createdAt: "2026-09-25T00:00:00.000Z",
        unread: true,
        readAt: null,
        jobId,
        sourceTargetId: null,
      }) as unknown as CampaignNotification;
    const kept = listCurrentUnreadNotifications(
      [
        note("n_sent", "job_sent"),
        note("n_open", "job_open"),
        note("n_src", null),
      ],
      {
        applicationRecords: [
          {
            jobId: "job_sent",
            status: "submitted",
            lastAttemptState: "submitted",
          },
          {
            jobId: "job_open",
            status: "ready_for_review",
            lastAttemptState: "failed",
          },
        ],
      } as unknown as JobFinderRendererWorkspaceSnapshot,
    );
    expect(kept.map((entry) => entry.id)).toEqual(["n_open", "n_src"]);
  });

  it("drops a note about a hold that no longer exists (ADR 0051)", () => {
    const note = (id: string, body: string) =>
      ({
        id,
        campaignId: "c",
        kind: "blocked_work",
        title: "Blocked: QA Lead",
        body,
        createdAt: "2026-10-17T01:23:11.597Z",
        unread: true,
        readAt: null,
        jobId: "job_qa",
        sourceTargetId: null,
      }) as unknown as CampaignNotification;
    const kept = listCurrentUnreadNotifications(
      [
        note(
          "n_retired",
          "The resume for 'QA Lead' leaves out 2 roles that Job Finder wants you to confirm first.",
        ),
        note("n_current", "The application page could not be opened."),
      ],
      {
        applicationRecords: [],
      } as unknown as JobFinderRendererWorkspaceSnapshot,
    );
    expect(kept.map((entry) => entry.id)).toEqual(["n_current"]);
  });

  it("drops a job's failure note once a newer attempt for that job started", () => {
    const note = {
      id: "n_failed_willow",
      campaignId: "c",
      kind: "blocked_work",
      title: "Failed: Willow",
      body: "The prepared application page is no longer open.",
      createdAt: "2026-09-27T00:24:18.426Z",
      unread: true,
      readAt: null,
      jobId: "job_willow",
      sourceTargetId: null,
    } as unknown as CampaignNotification;
    const workspace = (startedAt: readonly string[]) =>
      ({
        applicationRecords: [
          {
            jobId: "job_willow",
            status: "ready_for_review",
            lastAttemptState: "failed",
          },
        ],
        applyJobResults: startedAt.map((at) => ({
          jobId: "job_willow",
          startedAt: at,
        })),
      }) as unknown as JobFinderRendererWorkspaceSnapshot;

    // Only the attempt the note is about: it stays.
    expect(
      listCurrentUnreadNotifications(
        [note],
        workspace(["2026-09-27T00:14:47.900Z"]),
      ),
    ).toHaveLength(1);
    // A newer attempt started after the note: the note is over.
    expect(
      listCurrentUnreadNotifications(
        [note],
        workspace(["2026-09-27T00:14:47.900Z", "2026-09-27T00:26:00.000Z"]),
      ),
    ).toEqual([]);
  });

  it("drops a run's failure note once every job of that run was tried again", () => {
    const runNote = {
      id: "n_campaign_default_failed_apply_run_apply_run_1",
      campaignId: "campaign_default",
      kind: "blocked_work",
      title: "Failed: Application run",
      body: "The dedicated browser could not load this employer page.",
      createdAt: "2026-09-27T01:07:16.014Z",
      unread: true,
      readAt: null,
      jobId: null,
      sourceTargetId: null,
    } as unknown as CampaignNotification;
    const workspace = (startedAt: Record<string, string>) =>
      ({
        applicationRecords: [],
        applyRuns: [{ id: "apply_run_1", jobIds: ["job_a", "job_b"] }],
        applyJobResults: Object.entries(startedAt).map(([jobId, at]) => ({
          jobId,
          startedAt: at,
        })),
      }) as unknown as JobFinderRendererWorkspaceSnapshot;

    // Only one of the run's two jobs was tried again: the note stays.
    expect(
      listCurrentUnreadNotifications(
        [runNote],
        workspace({
          job_a: "2026-09-27T01:10:00.000Z",
          job_b: "2026-09-27T01:06:00.000Z",
        }),
      ),
    ).toHaveLength(1);
    expect(
      listCurrentUnreadNotifications(
        [runNote],
        workspace({
          job_a: "2026-09-27T01:10:00.000Z",
          job_b: "2026-09-27T01:10:00.000Z",
        }),
      ),
    ).toEqual([]);
  });

  it("drops a source's sign-in note once that sign-in resolved", () => {
    const note = {
      id: "n_blocked_src",
      campaignId: "c",
      kind: "blocked_work",
      title: "Blocked: Job source localhost/authboard",
      body: "Sign in from Needs you; the search carries on by itself.",
      createdAt: "2026-09-26T22:10:06.820Z",
      unread: true,
      readAt: null,
      jobId: null,
      sourceTargetId: "target_auth",
    } as unknown as CampaignNotification;
    const step = (state: string, resolvedAt: string | null) => ({
      scope: { type: "discovery_source", targetId: "target_auth" },
      state,
      resolvedAt,
      updatedAt: resolvedAt,
    });
    const workspace = (steps: unknown[]) =>
      ({
        applicationRecords: [],
        userActionRequests: steps,
      }) as unknown as JobFinderRendererWorkspaceSnapshot;

    expect(
      listCurrentUnreadNotifications(
        [note],
        workspace([step("resolved", "2026-09-26T22:10:59.041Z")]),
      ),
    ).toEqual([]);
    expect(
      listCurrentUnreadNotifications(
        [note],
        workspace([step("cancelled", "2026-09-26T22:11:00.000Z")]),
      ),
    ).toEqual([]);
    expect(
      listCurrentUnreadNotifications(
        [note],
        workspace([step("skipped", "2026-09-26T22:11:00.000Z")]),
      ),
    ).toEqual([]);
    // Still waiting for the sign-in: the note stays.
    expect(
      listCurrentUnreadNotifications(
        [note],
        workspace([
          step("resolved", "2026-09-26T22:10:59.041Z"),
          step("pending", null),
        ]),
      ),
    ).toHaveLength(1);
  });
});

it("keeps Home's description short and places the full summary on its status line", () => {
  const view = render(
    <JobSearchHomeScreen {...baseProps()} workspace={workspace()} />,
  );
  const description = view.container.querySelector("[data-page-header] p");
  expect(description?.textContent?.length).toBeLessThanOrEqual(90);
  expect(description?.textContent).toBe(
    "Your search, shortlisted jobs, and applications.",
  );
  expect(
    view.container.querySelector('[data-page-status-item="run-summary"]'),
  ).not.toBeNull();
});
