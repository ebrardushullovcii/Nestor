// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  BrowserSessionState,
  DiscoveryRunRecord,
  JobSearchPreferences,
  PlanSafeguardPause,
  SavedJob,
} from "@nestor/contracts";
import {
  DiscoveryRunRecordSchema,
  DiscoveryTargetExecutionSchema,
  buildDiscoveryCardOnlyEvidenceWarning,
} from "@nestor/contracts";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "@renderer/components/ui/toast";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobFinderQueuedJobOutcome } from "@renderer/features/job-finder/lib/job-finder-types";

vi.mock(
  "@renderer/features/job-finder/components/locked-screen-layout",
  () => ({
    LockedScreenLayout: ({
      children,
      topContent,
    }: {
      children: ReactNode;
      topContent: ReactNode;
    }) => (
      <main>
        {topContent}
        {children}
      </main>
    ),
  }),
);
vi.mock("./discovery-activity-panel", () => ({
  DiscoveryHistoryModal: () => null,
}));
vi.mock("./discovery-detail-panel", () => ({
  DiscoveryDetailPanel: ({
    onQueueJob,
    queueFeedback,
    selectedJob,
  }: {
    onQueueJob: (jobId: string) => unknown;
    queueFeedback?: JobFinderQueuedJobOutcome | null;
    selectedJob: { id: string } | null;
  }) => (
    <section aria-label="Job details">
      <button onClick={() => onQueueJob(selectedJob?.id ?? "")} type="button">
        Mock shortlist decision
      </button>
      {queueFeedback ? (
        <p
          data-testid="mock-queue-action-message"
          role={queueFeedback.status === "failure" ? "alert" : "status"}
        >
          {queueFeedback.message}
        </p>
      ) : null}
    </section>
  ),
}));
vi.mock("./discovery-filters-panel", () => ({
  DiscoveryFiltersPanel: ({ headerAction }: { headerAction?: ReactNode }) => (
    <section aria-label="Current search">
      Current search
      {headerAction}
    </section>
  ),
}));
vi.mock("./discovery-results-panel", async () => {
  const { useFixtureListReport } =
    await import("./find-jobs-list-report.test-support");
  return {
    DiscoveryResultsPanel: (
      props: Parameters<typeof useFixtureListReport>[0] & {
        liveStatusLine?: string;
      },
    ) => {
      useFixtureListReport(props);
      return (
        <section aria-label="Job results">
          Job results {props.liveStatusLine}
        </section>
      );
    },
  };
});

import { clearJobDetailCache } from "../../hooks/use-job-detail";
import {
  createDiscoveryRunFailedFeedback,
  createDiscoveryRunStartedFeedback,
  type DiscoveryRunFeedback,
} from "./discovery-run-feedback";
import {
  DiscoveryScreenWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

const browserSession = {
  source: "target_site",
  status: "ready",
  driver: "chrome_profile_agent",
  label: "Browser ready",
  detail: "The browser is ready for source search.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
} as BrowserSessionState;

const searchPreferences = {
  targetRoles: ["Software Engineer"],
  jobFamilies: [],
  locations: ["Remote"],
  excludedLocations: [],
  workModes: ["remote"],
  seniorityLevels: [],
  targetIndustries: [],
  targetCompanyStages: [],
  employmentTypes: [],
  minimumSalaryUsd: null,
  targetSalaryUsd: null,
  salaryCurrency: "USD",
  compensation: {
    minimum: null,
    maximum: null,
    interval: "year",
    currency: "USD",
    currencyStatus: "inherited",
  },
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
  companyBlacklist: [],
  companyWhitelist: [],
  discovery: {
    historyLimit: 5,
    targets: [
      {
        id: "source_1",
        label: "Example Board",
        startingUrl: "https://jobs.example.com",
        enabled: true,
      },
    ],
  },
} as unknown as JobSearchPreferences;

function createJob(id: string): SavedJob {
  return {
    id,
    matchAssessment: { recommendation: "strong_fit" },
  } as unknown as SavedJob;
}

const runningRun = {
  id: "run_1",
  state: "running",
} as unknown as DiscoveryRunRecord;

// `campaignId` is explicit: the screen now scopes the finished banner to the
// runs of the selected plan (`run.campaignId === activeCampaignId`), and the
// contract defaults an unassigned run to `null`, never `undefined`. A fixture
// that omits the field matches no plan at all and would make these
// expectations pass without ever rendering the banner.
const cardOnlyRun = {
  id: "run_card_only",
  campaignId: null,
  state: "completed",
  startedAt: "2026-08-25T10:00:00.000Z",
  summary: {
    validJobsFound: 4,
    duplicatesMerged: 0,
    sourceHealth: [],
    warnings: [buildDiscoveryCardOnlyEvidenceWarning("Example Board")],
  },
} as unknown as DiscoveryRunRecord;

const cleanRun = {
  id: "run_clean",
  campaignId: null,
  state: "completed",
  startedAt: "2026-08-25T10:00:00.000Z",
  summary: {
    validJobsFound: 4,
    duplicatesMerged: 0,
    sourceHealth: [],
    warnings: [],
  },
} as unknown as DiscoveryRunRecord;

function createDeferredOutcome() {
  let resolve!: (outcome: JobFinderQueuedJobOutcome) => void;
  const promise = new Promise<JobFinderQueuedJobOutcome>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function buildScreen(overrides?: {
  actionState?: { message: string | null };
  activeCampaignId?: string | null;
  activeRun?: DiscoveryRunRecord | null;
  recentRuns?: readonly DiscoveryRunRecord[];
  safeguardPauses?: readonly PlanSafeguardPause[];
  activityPaused?: boolean;
  discoveryRunFeedback?: DiscoveryRunFeedback | null;
  isDiscoveryAllPending?: boolean;
  jobs?: readonly SavedJob[];
  onOpenBrowserSession?: () => void;
  onQueueJob?: (jobId: string) => void | Promise<JobFinderQueuedJobOutcome>;
  onRunAgentDiscovery?: () => void;
  onResumeActivity?: () => void;
  selectedJob?: SavedJob;
  searchSelectivity?: "wide_net" | "best_matches";
}) {
  const jobs = overrides?.jobs ?? [createJob("strong")];
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      ...window.nestor,
      jobFinder: {
        ...window.nestor?.jobFinder,
        getJobDetail: vi.fn((jobId: string, planId: string | null) =>
          Promise.resolve({
            job: jobs.find((job) => job.id === jobId),
            planId,
          }),
        ),
      },
    },
  });
  return (
    <MemoryRouter>
      <DiscoveryScreenWithJobs
        actionState={overrides?.actionState ?? { message: null }}
        activeCampaignId={overrides?.activeCampaignId ?? null}
        activeRun={overrides?.activeRun ?? null}
        {...(overrides?.activityPaused ? { activityPaused: true } : {})}
        browserSession={browserSession}
        {...(overrides?.discoveryRunFeedback
          ? { discoveryRunFeedback: overrides.discoveryRunFeedback }
          : {})}
        discoverySessions={[]}
        isBrowserSessionPending={false}
        isBrowserSessionPendingForTarget={() => false}
        isDiscoveryAllPending={overrides?.isDiscoveryAllPending ?? false}
        isJobPending={() => false}
        isTargetPending={() => false}
        jobs={overrides?.jobs ?? [createJob("strong")]}
        searchSelectivity={overrides?.searchSelectivity ?? null}
        liveEvents={[]}
        onDismissJob={vi.fn()}
        onRestoreDismissedJob={vi.fn()}
        onOpenBrowserSession={overrides?.onOpenBrowserSession ?? vi.fn()}
        onOpenBrowserSessionForTarget={vi.fn()}
        onQueueJob={overrides?.onQueueJob ?? vi.fn()}
        onRunAgentDiscovery={overrides?.onRunAgentDiscovery}
        {...(overrides?.onResumeActivity
          ? { onResumeActivity: overrides.onResumeActivity }
          : {})}
        onSelectJob={vi.fn()}
        recentRuns={overrides?.recentRuns ?? []}
        safeguardPauses={overrides?.safeguardPauses ?? []}
        searchPreferences={searchPreferences}
        selectedJob={overrides?.selectedJob ?? createJob("strong")}
        sourceAccessPrompts={[]}
      />
    </MemoryRouter>
  );
}

function renderScreen(overrides?: Parameters<typeof buildScreen>[0]) {
  return render(buildScreen(overrides));
}

afterEach(() => {
  cleanup();
  clearJobDetailCache();
  window.localStorage.clear();
});

it("keeps a dismissed failure gone after remount and shows a different run's failure", () => {
  const feedback = createDiscoveryRunFailedFeedback({
    detail: "Something unexpected stopped this search.",
    targetLabel: null,
  });
  const run = DiscoveryRunRecordSchema.parse({
    id: "dismissed-run",
    state: "failed",
    startedAt: "2026-10-13T01:00:00.000Z",
  });
  const view = renderScreen({
    discoveryRunFeedback: feedback,
    recentRuns: [run],
  });
  expect(screen.getByTestId("discovery-run-feedback")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss this notice" }));
  view.unmount();
  const reopened = renderScreen({
    discoveryRunFeedback: feedback,
    recentRuns: [run],
  });
  expect(screen.queryByTestId("discovery-run-feedback")).toBeNull();
  reopened.rerender(
    buildScreen({
      discoveryRunFeedback: feedback,
      recentRuns: [{ ...run, id: "new-run" }],
    }),
  );
  expect(screen.getByTestId("discovery-run-feedback")).toBeTruthy();
});

describe("DiscoveryScreen Search now truthful feedback", () => {
  it("clears an earlier failed source banner after its resumed plan completes", () => {
    const failedFeedback = {
      ...createDiscoveryRunFailedFeedback({
        detail: "The source needed a sign-in.",
        targetLabel: "Example Board",
      }),
      recordedAtMs: Date.parse("2026-08-28T10:01:00.000Z"),
    };
    renderScreen({
      discoveryRunFeedback: failedFeedback,
      recentRuns: [
        {
          ...cleanRun,
          completedAt: "2026-08-28T10:02:00.000Z",
          targetExecutions: [
            DiscoveryTargetExecutionSchema.parse({
              targetId: "source_1",
              adapterKind: "auto",
              state: "completed",
              completedAt: "2026-08-28T10:02:00.000Z",
            }),
          ],
        },
      ],
    });

    // The failure is superseded by the finished run, which needs nothing
    // from the person, so nothing is boxed over the results (ADR 0042).
    expect(screen.queryByTestId("discovery-run-feedback")).toBeNull();
    expect(screen.queryByText(/Search could not start/)).toBeNull();
  });

  it("replaces a finished banner with the active plan's safeguard pause", () => {
    const pausedRun = {
      ...cleanRun,
      campaignId: "campaign_paused",
    } as DiscoveryRunRecord;

    renderScreen({
      recentRuns: [pausedRun],
      safeguardPauses: [
        {
          id: "automatic_discovery_failures:campaign_paused",
          campaignId: "campaign_paused",
          planName: "Paused plan",
          title: "Paused after repeated failures (33.3% failed)",
          explanation: "Too many searches failed.",
          route: "/job-finder/safeguards",
        },
      ],
      activeCampaignId: "campaign_paused",
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain(
      "Search paused by a safety limit · Open Safeguards",
    );
    expect(status.textContent).not.toContain("Search finished");
    expect(
      screen
        .getByRole("link", { name: "Open Safeguards" })
        .getAttribute("href"),
    ).toBe("/job-finder/safeguards");
  });

  it("prevents duplicate clicks while any discovery run occupies the pipeline", () => {
    const onRunAgentDiscovery = vi.fn();
    const first = renderScreen({ onRunAgentDiscovery });

    const button = screen.getByRole("button", { name: "Search now" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(onRunAgentDiscovery).toHaveBeenCalledTimes(1);
    cleanup();
    clearJobDetailCache();

    renderScreen({ activeRun: runningRun, onRunAgentDiscovery });
    const runningButton = screen.getByRole("button", { name: "Searching" });
    expect(runningButton.hasAttribute("disabled")).toBe(true);
    fireEvent.click(runningButton);
    expect(onRunAgentDiscovery).toHaveBeenCalledTimes(1);
    void first;
  });

  it("boxes nothing over the results while a search starts", () => {
    renderScreen({
      discoveryRunFeedback: createDiscoveryRunStartedFeedback(),
    });

    // The search bar's Searching state and clock carry a run in flight.
    expect(screen.queryByTestId("discovery-run-feedback")).toBeNull();
    expect(screen.queryByText(/Search started/)).toBeNull();
  });

  it("renders a visible alert with a corrective action when the browser runtime is closed", () => {
    const onOpenBrowserSession = vi.fn();
    renderScreen({
      discoveryRunFeedback: createDiscoveryRunFailedFeedback({
        detail:
          "Error invoking remote method 'job-finder:run-agent-discovery': Error: The dedicated browser profile could not start.",
        targetLabel: null,
      }),
      onOpenBrowserSession,
    });

    const region = screen.getByRole("alert");
    expect(region.textContent).toContain(
      "The Job Finder browser could not start",
    );
    expect(region.textContent).not.toContain("remote method");

    fireEvent.click(
      screen.getByRole("button", { name: "Open the Job Finder browser" }),
    );
    expect(onOpenBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("deep-links missing sources to Profile job sources", () => {
    renderScreen({
      discoveryRunFeedback: createDiscoveryRunFailedFeedback({
        detail: "single_target: target not found or unavailable",
        targetLabel: "Removed Board",
      }),
    });

    expect(screen.getByRole("alert").textContent).toContain("Removed Board");
    const reviewLink = screen.getByRole("link", {
      name: "Review job sources",
    });
    expect(reviewLink.getAttribute("href")).toBe(
      "/job-finder/profile?section=sources&focus=job-sources",
    );
  });

  it("announces a search that finishes during the visit as a toast without claiming matches", () => {
    // The verdict is read from the selected plan's own frozen run report, so
    // the toast states the same numbers as Home, Search history and Tasks.
    const view = render(
      <ToastProvider>{buildScreen({ recentRuns: [] })}</ToastProvider>,
    );
    expect(document.querySelector("[data-toast]")).toBeNull();

    view.rerender(
      <ToastProvider>{buildScreen({ recentRuns: [cleanRun] })}</ToastProvider>,
    );

    const toast = document.querySelector("[data-toast]");
    expect(toast?.textContent).toContain("Search finished");
    expect(toast?.textContent).toContain("4 new jobs saved");
    expect(toast?.textContent).not.toMatch(/match/iu);
    expect(screen.queryByTestId("discovery-run-feedback")).toBeNull();
  });

  it("does not replay a search that finished before the visit", () => {
    render(
      <ToastProvider>{buildScreen({ recentRuns: [cleanRun] })}</ToastProvider>,
    );

    expect(document.querySelector("[data-toast]")).toBeNull();
    expect(screen.queryByTestId("discovery-run-feedback")).toBeNull();
  });

  it("leaves a finished run's evidence warning to Activity, not a box over the results", () => {
    const warning = buildDiscoveryCardOnlyEvidenceWarning("Example Board");
    renderScreen({ recentRuns: [cardOnlyRun] });

    // The warning needs nothing from the person; Activity and Home's source
    // health carry it (ADR 0042).
    expect(screen.queryByTestId("discovery-run-notice")).toBeNull();
    expect(screen.queryByText(warning)).toBeNull();
  });

  it("keeps an earlier run's warning off a search that is still running", () => {
    renderScreen({
      discoveryRunFeedback: createDiscoveryRunStartedFeedback(),
      recentRuns: [cardOnlyRun],
    });

    expect(screen.queryByTestId("discovery-run-notice")).toBeNull();
  });

  it("shows no run notice when the newest run recorded no warning", () => {
    renderScreen({ recentRuns: [cleanRun] });

    expect(screen.queryByTestId("discovery-run-notice")).toBeNull();
  });
});

describe("DiscoveryScreen Results-mode shortlist feedback", () => {
  it("renders only the clicked job's awaited success outcome next to the decision action", async () => {
    const onQueueJob = vi
      .fn<(jobId: string) => Promise<JobFinderQueuedJobOutcome>>()
      .mockResolvedValue({
        status: "success",
        message: "Job added to Shortlisted.",
      });
    renderScreen({ onQueueJob });

    fireEvent.click(
      await screen.findByRole("button", { name: "Mock shortlist decision" }),
    );
    expect(onQueueJob).toHaveBeenCalledWith("strong");

    const status = await screen.findByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    // Plain copy preserved verbatim from the request-local outcome.
    expect(status.textContent).toBe("Job added to Shortlisted.");
  });

  it("renders a failed shortlist as an alert on the same surface", async () => {
    const onQueueJob = vi
      .fn<(jobId: string) => Promise<JobFinderQueuedJobOutcome>>()
      .mockResolvedValue({
        status: "failure",
        message: "The requested Job Finder action failed.",
      });
    renderScreen({ onQueueJob });

    fireEvent.click(
      await screen.findByRole("button", { name: "Mock shortlist decision" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The requested Job Finder action failed.");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps attribution job-scoped and exclusive of setup feedback", async () => {
    const onQueueJob = vi
      .fn<(jobId: string) => Promise<JobFinderQueuedJobOutcome>>()
      .mockImplementation((jobId: string) =>
        Promise.resolve({
          status: "success",
          message: `Job added to Shortlisted. (${jobId})`,
        }),
      );
    const jobA = createJob("strong_a");
    const jobB = createJob("strong_b");
    const { rerender } = renderScreen({
      jobs: [jobA, jobB],
      onQueueJob,
      selectedJob: jobA,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Mock shortlist decision" }),
    );
    expect(await screen.findByRole("status").then((el) => el.textContent)).toBe(
      "Job added to Shortlisted. (strong_a)",
    );

    // The outcome is keyed to its own row: inspecting another job never shows
    // the previous job's outcome as if it were that row's.
    rerender(
      buildScreen({
        jobs: [jobA, jobB],
        onQueueJob,
        selectedJob: jobB,
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();

    // Modes are exclusive: setup keeps its own footer status, so switching to
    // Search setup removes the Results surface instead of doubling it.
    fireEvent.click(
      document.querySelector(
        '[data-discovery-search-chip="roles"]',
      ) as HTMLElement,
    );
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Back to results$/u }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores a search completion writing the shared route message while a shortlist is pending", async () => {
    const deferred = createDeferredOutcome();
    const onQueueJob = vi
      .fn<(jobId: string) => Promise<JobFinderQueuedJobOutcome>>()
      .mockReturnValue(deferred.promise);
    const { rerender } = renderScreen({ onQueueJob });

    fireEvent.click(
      await screen.findByRole("button", { name: "Mock shortlist decision" }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("mock-queue-action-message")).toBeNull();

    // A concurrent search completes and writes the shared route-scoped
    // message; it appears only on its own route surface and is never
    // adopted as the shortlist outcome.
    rerender(
      buildScreen({
        actionState: {
          message: "Search finished and results were saved on this device.",
        },
        onQueueJob,
      }),
    );
    expect(screen.queryByTestId("mock-queue-action-message")).toBeNull();
    expect(
      screen.getByTestId("discovery-route-action-status").textContent,
    ).toContain("Search finished and results were saved on this device.");

    deferred.resolve({
      status: "failure",
      message: "The requested Job Finder action failed.",
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The requested Job Finder action failed.");
    // The row keeps its own failure; the route surface stays separate.
    expect(
      screen.getByTestId("discovery-route-action-status").textContent,
    ).toContain("Search finished");
  });

  it("renders a failed Resume activity on the shared route surface in results mode", () => {
    const onResumeActivity = vi.fn();
    const { rerender } = renderScreen({
      activityPaused: true,
      onResumeActivity,
    });

    fireEvent.click(screen.getByRole("button", { name: /resume activity/iu }));
    expect(onResumeActivity).toHaveBeenCalledTimes(1);

    // The controller resolves the refusal as a route-owned status; Results
    // mode must show it instead of leaving a silent no-op.
    rerender(
      buildScreen({
        actionState: {
          message: "Activity could not be resumed. Try again.",
        },
        activityPaused: true,
        onResumeActivity,
      }),
    );

    const status = screen.getByTestId("discovery-route-action-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toContain(
      "Activity could not be resumed. Try again.",
    );
    // The pause truth stays visible on the status line, never masked by it.
    expect(
      document.querySelector('[data-page-status-item="activity-paused"]'),
    ).toBeTruthy();
  });

  it("keeps a finished search off both the results and the search-setup editor", () => {
    renderScreen({ recentRuns: [cleanRun] });

    expect(screen.queryByTestId("discovery-run-feedback")).toBeNull();

    fireEvent.click(
      document.querySelector(
        '[data-discovery-search-chip="roles"]',
      ) as HTMLElement,
    );

    // No results are on screen while the editor is open, so a banner about
    // them has nowhere to belong.
    expect(screen.queryByTestId("discovery-run-feedback")).toBeNull();
  });

  it("keeps one shared route message surface across Results and Search setup", () => {
    const { rerender } = renderScreen({
      actionState: { message: "Reading selected sources…" },
    });

    const assertSingleSurface = () => {
      const surfaces = screen.getAllByTestId("discovery-route-action-status");
      expect(surfaces).toHaveLength(1);
      expect(screen.getAllByText("Reading selected sources…")).toHaveLength(1);
    };

    assertSingleSurface();

    fireEvent.click(
      document.querySelector(
        '[data-discovery-search-chip="roles"]',
      ) as HTMLElement,
    );
    assertSingleSurface();

    fireEvent.click(screen.getByRole("button", { name: /^Back to results$/u }));
    assertSingleSurface();

    // Clearing the route message removes the one surface entirely.
    rerender(buildScreen({ actionState: { message: null } }));
    expect(screen.queryByTestId("discovery-route-action-status")).toBeNull();
  });

  it("labels overlapping out-of-order shortlists with their own outcomes", async () => {
    const deferredA = createDeferredOutcome();
    const deferredB = createDeferredOutcome();
    const onQueueJob = vi
      .fn<(jobId: string) => Promise<JobFinderQueuedJobOutcome>>()
      .mockImplementation((jobId: string) =>
        jobId === "strong_a" ? deferredA.promise : deferredB.promise,
      );
    const jobA = createJob("strong_a");
    const jobB = createJob("strong_b");
    const { rerender } = renderScreen({
      jobs: [jobA, jobB],
      onQueueJob,
      selectedJob: jobA,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Mock shortlist decision" }),
    );
    rerender(
      buildScreen({ jobs: [jobA, jobB], onQueueJob, selectedJob: jobB }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Mock shortlist decision" }),
    );

    // B fails first while A is still in flight: B's failure shows on B.
    deferredB.resolve({
      status: "failure",
      message: "Shortlisting strong_b failed. Try again.",
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Shortlisting strong_b failed. Try again.");

    // A resolves later: it must not overwrite or re-label B's visible failure.
    deferredA.resolve({
      status: "success",
      message: "Job added to Shortlisted.",
    });
    await vi.waitFor(() => {
      expect(onQueueJob).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "Shortlisting strong_b failed. Try again.",
    );

    // Returning to A shows only A's own resolved success.
    rerender(
      buildScreen({ jobs: [jobA, jobB], onQueueJob, selectedJob: jobA }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Job added to Shortlisted.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("source-specific stale errors and provider timeouts", () => {
  it("keeps a different source's error and clears it when its own search succeeds", () => {
    const feedback = {
      ...createDiscoveryRunFailedFeedback({
        detail: "The source is unavailable.",
        targetLabel: "Example Board",
        targetId: "source_1",
      }),
      recordedAtMs: Date.parse("2026-10-01T10:00:00.000Z"),
    };
    const completed = (targetId: string) =>
      DiscoveryRunRecordSchema.parse({
        id: "run_later",
        state: "completed",
        startedAt: "2026-10-01T10:01:00.000Z",
        completedAt: "2026-10-01T10:02:00.000Z",
        targetExecutions: [
          {
            targetId,
            adapterKind: "auto",
            state: "completed",
            completedAt: "2026-10-01T10:02:00.000Z",
          },
        ],
      });
    const view = renderScreen({
      discoveryRunFeedback: feedback,
      recentRuns: [completed("other_source")],
    });
    expect(screen.getByTestId("discovery-run-feedback").textContent).toContain(
      "Search could not start for Example Board.",
    );
    view.rerender(
      buildScreen({
        discoveryRunFeedback: feedback,
        recentRuns: [completed("source_1")],
      }),
    );
    // The failure is superseded by the finished run, which needs nothing
    // from the person, so nothing is boxed over the results (ADR 0042).
    expect(screen.queryByTestId("discovery-run-feedback")).toBeNull();
    expect(screen.queryByText(/Search could not start/)).toBeNull();
  });
  it("tells the person a timed-out plan kept jobs and can be searched again", () => {
    const onRunAgentDiscovery = vi.fn();
    renderScreen({
      onRunAgentDiscovery,
      jobs: [createJob("saved_before_timeout")],
      recentRuns: [
        DiscoveryRunRecordSchema.parse({
          id: "run_timeout",
          state: "failed",
          startedAt: "2026-10-01T10:01:00.000Z",
          completedAt: "2026-10-01T10:02:00.000Z",
          summary: {
            jobsPersisted: 1,
            validJobsFound: 1,
            warnings: [
              "Model request timed out after 120s of silence from the AI service",
            ],
          },
        }),
      ],
    });
    const banner = screen.getByTestId("discovery-run-feedback");
    expect(banner.textContent).toContain("The AI service stopped responding.");
    expect(banner.textContent).toContain(
      "Jobs found so far are saved. Search again to continue.",
    );
    expect(banner.textContent).not.toMatch(/internet|check your connection/i);
    fireEvent.click(screen.getByRole("button", { name: "Search now" }));
    expect(onRunAgentDiscovery).toHaveBeenCalledOnce();
  });
});

it.each(["reading_listings", "judging_fit"] as const)(
  "shows live %s counts after sources complete",
  (phase) => {
    const run = DiscoveryRunRecordSchema.parse({
      id: "progress",
      state: "running",
      startedAt: "2026-10-05T10:00:00.000Z",
      targetIds: [],
      activity: [
        {
          id: "progress-event",
          runId: "progress",
          timestamp: "2026-10-05T10:00:30.000Z",
          kind: "progress",
          stage: "extraction",
          message: "Work continues",
          progress: { phase, completed: 12, total: 60 },
        },
      ],
    });
    renderScreen({ activeRun: run, isDiscoveryAllPending: true });
    expect(
      screen.getAllByText(
        new RegExp(
          `${phase === "reading_listings" ? "Reading listings" : "Judging fit"} 12 of 60`,
        ),
      ),
    ).toHaveLength(2);
  },
);

it.each([false, true])(
  "announces jobs moved to weaker matches once when a search finishes (shown: %s)",
  async (alreadyShown) => {
    const before = createJob("one");
    const after = {
      ...before,
      discoveryMethod: "json_ld",
      matchAssessment: {
        score: 20,
        recommendation: "skip",
        contextFingerprint: "context",
        postingFingerprint: "posting",
        judgment: {
          source: "batch",
          score: 20,
          role: "conflict",
          preferences: "conflict",
          locationReach: "outside_area",
        },
      },
    } as unknown as SavedJob;
    const view = render(
      <ToastProvider>
        {buildScreen({
          activeRun: runningRun,
          jobs: [before],
          searchSelectivity: alreadyShown ? "wide_net" : "best_matches",
        })}
      </ToastProvider>,
    );
    await flushFindJobsQueries();
    view.rerender(
      <ToastProvider>
        {buildScreen({
          activeRun: null,
          jobs: [after],
          searchSelectivity: alreadyShown ? "wide_net" : "best_matches",
        })}
      </ToastProvider>,
    );
    await flushFindJobsQueries();
    expect(
      screen.getAllByText("1 job moved to weaker matches after the fit check."),
    ).toHaveLength(1);
    view.rerender(
      <ToastProvider>
        {buildScreen({
          activeRun: null,
          jobs: [after],
          searchSelectivity: alreadyShown ? "wide_net" : "best_matches",
        })}
      </ToastProvider>,
    );
    await flushFindJobsQueries();
    expect(
      screen.getAllByText("1 job moved to weaker matches after the fit check."),
    ).toHaveLength(1);
  },
);

it("announces jobs that leave the plan once at the end of a search", async () => {
  const view = render(
    <ToastProvider>
      {buildScreen({ activeRun: runningRun, jobs: [createJob("leaving")] })}
    </ToastProvider>,
  );
  await flushFindJobsQueries();
  view.rerender(
    <ToastProvider>{buildScreen({ activeRun: null, jobs: [] })}</ToastProvider>,
  );
  await flushFindJobsQueries();
  expect(
    screen.getAllByText("1 job left this plan after the fit check."),
  ).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "Show weaker matches" }),
  ).toBeNull();
  view.rerender(
    <ToastProvider>{buildScreen({ activeRun: null, jobs: [] })}</ToastProvider>,
  );
  await flushFindJobsQueries();
  expect(
    screen.getAllByText("1 job left this plan after the fit check."),
  ).toHaveLength(1);
});
