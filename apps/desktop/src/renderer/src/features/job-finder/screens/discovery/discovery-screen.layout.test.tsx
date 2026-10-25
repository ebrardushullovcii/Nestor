// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  BrowserSessionState,
  JobSearchPreferences,
  SavedJob,
} from "@nestor/contracts";
import type { ReactNode } from "react";
// The real screen header renders a router Link for visible source recovery,
// so every full-screen render needs router context (same as the other
// DiscoveryScreen suites).
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIST_DETAIL_COLUMNS_CLASS } from "../../components/list-detail-columns";

// Job details load over IPC in the app; here the listed row is the detail.
vi.mock("../../hooks/use-job-detail", () => ({
  useJobDetail: (row: unknown) => ({
    job: row,
    error: null,
    loading: false,
    retry: () => undefined,
  }),
  clearJobDetailCache: () => undefined,
  prefetchJobDetail: () => undefined,
}));

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
  DiscoveryDetailPanel: () => (
    <section aria-label="Job details">Job details</section>
  ),
}));
vi.mock("./discovery-filters-panel", () => ({
  DiscoveryFiltersPanel: () => (
    <section aria-label="Current search">Current search</section>
  ),
}));
vi.mock("./discovery-results-panel", async () => {
  const { useFixtureListReport } = await import(
    "./find-jobs-list-report.test-support"
  );
  return {
  DISCOVERY_OFFLINE_CATALOG_NOTICE_ID: "discovery-offline-catalog-notice",
  DISCOVERY_SEARCH_SETUP_BLOCKER_ID: "discovery-search-setup-blocker",
  DiscoveryResultsPanel: (
    props: Parameters<typeof useFixtureListReport>[0] & {
      browserSession: BrowserSessionState;
      hiddenJobsControl?: ReactNode;
      searchSetupBlocker?: {
        actionLabel?: string | null;
        title: string;
      } | null;
    },
  ) => {
    const jobs = useFixtureListReport(props);
    const { browserSession, hiddenJobsControl, searchSetupBlocker } = props;
    return (
    <section aria-label="Job results">
      Job results
      {hiddenJobsControl}
      {searchSetupBlocker ? (
        <div id="discovery-search-setup-blocker">
          <p>{searchSetupBlocker.title}</p>
          {searchSetupBlocker.actionLabel ? (
            <a href="/job-finder/profile?section=sources&focus=job-sources">
              {searchSetupBlocker.actionLabel}
            </a>
          ) : null}
        </div>
      ) : null}
      {browserSession.driver === "catalog_seed" && jobs.length > 0 ? (
        <div id="discovery-offline-catalog-notice" role="status">
          Offline catalog · review-only. Catalog jobs are review-only.
        </div>
      ) : null}
    </section>
    );
  },
  };
});

import {
  DiscoveryScreenWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

const browserSession = {
  source: "target_site",
  status: "ready",
  driver: "chrome_profile_agent",
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-07-31T10:00:00.000Z",
} as BrowserSessionState;

const searchPreferences: JobSearchPreferences = {
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
    targets: [],
  },
};

function createJob(
  id: string,
  recommendation: SavedJob["matchAssessment"]["recommendation"],
): SavedJob {
  return {
    id,
    matchAssessment: { recommendation },
  } as unknown as SavedJob;
}

async function renderEstablishedResults() {
  const selectedJob = createJob("strong", "strong_fit");
  const hiddenMismatch = createJob("mismatch", "skip");

  const rendered = render(
    <MemoryRouter>
      <DiscoveryScreenWithJobs
        actionState={{ message: null }}
        activeRun={null}
        browserSession={browserSession}
        discoverySessions={[]}
        isBrowserSessionPending={false}
        isBrowserSessionPendingForTarget={() => false}
        isDiscoveryAllPending={false}
        isJobPending={() => false}
        isTargetPending={() => false}
        jobs={[selectedJob, hiddenMismatch]}
        liveEvents={[]}
        onDismissJob={vi.fn()}
        onRestoreDismissedJob={vi.fn()}
        onOpenBrowserSession={vi.fn()}
        onOpenBrowserSessionForTarget={vi.fn()}
        onQueueJob={vi.fn()}
        onRunAgentDiscovery={vi.fn()}
        onSelectJob={vi.fn()}
        recentRuns={[]}
        searchPreferences={searchPreferences}
        selectedJob={selectedJob}
        sourceAccessPrompts={[]}
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();
  return rendered;
}

afterEach(() => {
  cleanup();
});

describe("DiscoveryScreen established-results layout", () => {
  it("keeps populated offline provenance on one results surface and describes disabled search", async () => {
    const catalogJob = createJob("catalog", "review_before_applying");

    render(
      <MemoryRouter>
        <DiscoveryScreenWithJobs
          actionState={{ message: null }}
          activeRun={null}
          browserSession={{
            ...browserSession,
            driver: "catalog_seed",
            status: "unknown",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isJobPending={() => false}
          isTargetPending={() => false}
          jobs={[catalogJob]}
          liveEvents={[]}
          onDismissJob={vi.fn()}
          onRestoreDismissedJob={vi.fn()}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onQueueJob={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onSelectJob={vi.fn()}
          recentRuns={[]}
          searchPreferences={searchPreferences}
          selectedJob={catalogJob}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );
    await flushFindJobsQueries();

    const offlineNotice = document.getElementById(
      "discovery-offline-catalog-notice",
    );
    const searchButton = screen.getByRole("button", { name: "Search now" });

    expect(document.querySelector("[data-page-header-status]")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(offlineNotice?.textContent).toContain(
      "Offline catalog · review-only.",
    );
    expect(searchButton.hasAttribute("disabled")).toBe(true);
    expect(searchButton.getAttribute("aria-describedby")).toBe(
      "discovery-offline-catalog-notice",
    );
  });

  it("keeps the zero-result source blocker on one surface with a valid search description", async () => {
    const selectedJob = createJob("strong", "strong_fit");
    const view = render(
      <MemoryRouter>
        <DiscoveryScreenWithJobs
          actionState={{ message: null }}
          activeRun={null}
          browserSession={browserSession}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isJobPending={() => false}
          isTargetPending={() => false}
          jobs={[selectedJob]}
          liveEvents={[]}
          onDismissJob={vi.fn()}
          onRestoreDismissedJob={vi.fn()}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onQueueJob={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onSelectJob={vi.fn()}
          recentRuns={[]}
          searchPreferences={searchPreferences}
          selectedJob={selectedJob}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );
    await flushFindJobsQueries();

    // Results mode stays mounted while the last visible job disappears, which
    // is the path that previously rendered the same source blocker twice.
    view.rerender(
      <MemoryRouter>
        <DiscoveryScreenWithJobs
          actionState={{ message: null }}
          activeRun={null}
          browserSession={browserSession}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isJobPending={() => false}
          isTargetPending={() => false}
          jobs={[]}
          liveEvents={[]}
          onDismissJob={vi.fn()}
          onRestoreDismissedJob={vi.fn()}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onQueueJob={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onSelectJob={vi.fn()}
          recentRuns={[]}
          searchPreferences={searchPreferences}
          selectedJob={null}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );
    await flushFindJobsQueries();

    const searchButton = screen.getByRole("button", { name: "Search now" });
    const blocker = document.getElementById("discovery-search-setup-blocker");
    expect(document.querySelector("[data-page-header-status]")).toBeNull();
    expect(searchButton.getAttribute("aria-describedby")).toBe(
      "discovery-search-setup-blocker",
    );
    expect(blocker).toBeTruthy();
    expect(blocker?.contains(screen.getByText("Add a job source"))).toBe(true);
    expect(
      screen.getAllByRole("link", { name: "Add a job source" }),
    ).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Job details" })).toBeNull();
  });

  it("offers exact employer reversal separately from restoring a hidden job", async () => {
    const onRemoveEmployerExclusion = vi.fn();
    const onRestoreDismissedJob = vi.fn();
    const hiddenJob = {
      ...createJob("hidden", "skip"),
      title: "Hidden role",
      discoveryFeedback: {
        version: 1,
        revision: 1,
        reasons: ["company"],
        recordedAt: "2026-08-23T10:00:00.000Z",
        priorStatus: "discovered",
        employerExclusion: {
          normalizedCompanyName: "example co",
          displayCompanyName: "Example Co",
          addedByThisFeedback: true,
        },
      },
    } as SavedJob;
    render(
      <MemoryRouter>
        <DiscoveryScreenWithJobs
          actionState={{ message: null }}
          activeRun={null}
          browserSession={browserSession}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isJobPending={() => false}
          isTargetPending={() => false}
          jobs={[createJob("visible", "strong_fit")]}
          dismissedJobs={[hiddenJob]}
          liveEvents={[]}
          onDismissJob={vi.fn()}
          onRestoreDismissedJob={onRestoreDismissedJob}
          onRemoveEmployerExclusion={onRemoveEmployerExclusion}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onQueueJob={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onSelectJob={vi.fn()}
          recentRuns={[]}
          searchPreferences={searchPreferences}
          selectedJob={null}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );
    await flushFindJobsQueries();
    fireEvent.click(screen.getByText(/^Hidden \(\d+\)$/u));
    await flushFindJobsQueries();
    // Why it was hidden comes with the job's own record, read by id.
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Allow this employer in future searches",
      }),
    );
    await flushFindJobsQueries();
    expect(onRemoveEmployerExclusion).toHaveBeenCalledWith({
      jobId: "hidden",
      normalizedCompanyName: "example co",
    });
    expect(onRestoreDismissedJob).not.toHaveBeenCalled();
  });

  it("defaults to a two-pane results workspace and opens search setup as a separate mode", async () => {
    await renderEstablishedResults();

    const resultsPane = screen.getByRole("region", {
      name: "Job results",
    }).parentElement;
    const detailsPane = screen.getByRole("region", {
      name: "Job details",
    }).parentElement;

    if (!resultsPane || !detailsPane) {
      throw new Error("Expected the results and details panes.");
    }
    const layout = resultsPane.parentElement;
    if (!layout) {
      throw new Error("Expected the established discovery grid.");
    }

    expect(Array.from(layout.children)).toEqual([resultsPane, detailsPane]);
    expect(screen.queryByRole("region", { name: "Current search" })).toBeNull();
    expect(layout.className).toContain("grid-cols-1");
    expect(layout.className).toContain(LIST_DETAIL_COLUMNS_CLASS);
    expect(layout.className).not.toContain("lg:grid-cols-");
    expect(layout.className).not.toContain("2xl:grid-cols-");
    expect(layout.className).toContain("min-h-0");
    expect(layout.className).not.toContain("min-h-124");
    expect(layout.className).toContain("xl:h-full");
    expect(layout.className).toContain("xl:min-h-0");
    expect(layout.className).toContain("xl:overflow-hidden");
    for (const pane of [resultsPane, detailsPane]) {
      expect(pane.className).not.toMatch(/(?:^|\s)(?:\w+:)?order-/u);
    }

    // Search setup is a disclosure opened from the bar, not a peer tab.
    fireEvent.click(screen.getByRole("button", { name: "Roles, places & sources" }));
    await flushFindJobsQueries();
    expect(screen.getByRole("region", { name: "Current search" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Job results" })).toBeNull();
  });

  it("renders the shared header grammar: stack, one divider, one interactive search bar", async () => {
    const view = await renderEstablishedResults();

    const main = view.container.querySelector("main");
    if (!main) {
      throw new Error("Expected the mocked layout main.");
    }
    const stack = main.querySelector("[data-page-header-stack]");
    const header = main.querySelector("[data-page-header]");
    const actions = main.querySelector("[data-page-header-actions]");
    const subnav = main.querySelector("[data-page-header-subnav]");
    const dividers = main.querySelectorAll("[data-page-header-divider]");
    const workspace = document.getElementById("discovery-workspace-content");

    expect(stack).toBeTruthy();
    expect(header).toBeTruthy();
    // No route-level action cluster: the search bar owns the one command.
    expect(actions).toBeNull();
    // One title row: title and description side by side, no grid switch.
    expect(header?.className).toContain("min-h-8");
    expect(header?.className).toContain("items-center");
    expect(header?.className).not.toMatch(/grid-cols-/u);
    expect(header?.firstElementChild?.querySelector("h1")?.textContent).toBe(
      "Find jobs",
    );
    expect(subnav?.textContent).toContain("Search now");
    expect(dividers).toHaveLength(1);
    expect(subnav?.className).toContain("mt-(--gap-page-header-aux)");
    expect(stack?.className).toContain("mb-(--gap-page-header-body)");
    expect(main.children[0]).toBe(stack);
    expect(main.children[1]).toBe(workspace);

    // The tab strip is gone: no Results/Search setup peers remain.
    expect(screen.queryByRole("button", { name: "Results" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search setup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit search" })).toBeNull();

    const searchButtons = screen.getAllByRole("button", {
      name: "Search now",
    });
    expect(searchButtons).toHaveLength(1);

    for (const chip of Array.from(
      document.querySelectorAll("[data-discovery-search-chip]"),
    )) {
      expect(chip.getAttribute("aria-controls")).toBe(
        "discovery-search-setup-panel",
      );
    }
    expect(workspace?.getAttribute("id")).toBe("discovery-workspace-content");
    expect(
      workspace?.contains(screen.getByRole("region", { name: "Job results" })),
    ).toBe(true);
  });
});
