// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  BrowserSessionState,
  DiscoveryRunRecord,
  JobSearchPreferences,
  SavedJob,
} from "@nordri/contracts";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

// Job details load over IPC in the app; here the listed row is the detail.
vi.mock("../../hooks/use-job-detail", () => ({
  useJobDetail: (row: unknown) => ({
    job: row,
    error: null,
    loading: false,
    retry: () => undefined,
  }),
  clearJobDetailCache: () => undefined,
}));

const state = vi.hoisted(() => ({
  latestRunVerdicts: [] as unknown[],
  alsoFoundShown: [] as unknown[],
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
        <div data-locked-screen-scroll-area>
          {topContent}
          {children}
        </div>
      </main>
    ),
  }),
);
vi.mock("./discovery-activity-panel", () => ({
  DiscoveryHistoryModal: () => null,
}));
vi.mock("./discovery-detail-panel", () => ({
  DiscoveryDetailPanel: (props: { onBackToResults?: () => void }) => (
    <section aria-label="Job details">
      Job details<button onClick={props.onBackToResults}>Return to rows</button>
    </section>
  ),
}));
vi.mock("./discovery-filters-panel", () => ({
  DiscoveryFiltersPanel: () => (
    <section aria-label="Current search">Current search</section>
  ),
}));
vi.mock("./discovery-results-panel", () => ({
  DiscoveryResultsPanel: (props: {
    latestRunVerdict?: unknown;
    areAlsoFoundShown?: unknown;
    jobs: readonly SavedJob[];
    onSelectJob: (jobId: string) => void;
  }) => {
    state.latestRunVerdicts.push(props.latestRunVerdict);
    state.alsoFoundShown.push(props.areAlsoFoundShown);
    return (
      <section aria-label="Job results">
        Job results
        {props.jobs.map((job) => (
          <button
            key={job.id}
            data-collection-item-id={job.id}
            onClick={() => props.onSelectJob(job.id)}
          >
            {job.id}
          </button>
        ))}
      </section>
    );
  },
}));

import { DiscoveryScreen } from "./discovery-screen";

const browserSession = {
  source: "target_site",
  status: "unknown",
  driver: "chrome_profile_agent",
  label: "Browser not open",
  detail: "The browser is not open.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
} as BrowserSessionState;

const searchPreferences = {
  targetRoles: ["Software Engineer"],
  jobFamilies: [],
  locations: ["Remote"],
  excludedLocations: [],
  workModes: [],
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

interface ScreenOverrides {
  jobs?: readonly SavedJob[];
  selectedJob?: SavedJob;
  recentRuns?: readonly DiscoveryRunRecord[];
  searchSelectivity?: "best_matches" | "balanced" | "wide_net";
}

function buildScreen(overrides?: ScreenOverrides) {
  return (
    <MemoryRouter>
      <DiscoveryScreen
        actionState={{ message: null }}
        activeRun={null}
        browserSession={browserSession}
        companies={[]}
        discoverySessions={[]}
        isBrowserSessionPending={false}
        isBrowserSessionPendingForTarget={() => false}
        isDiscoveryAllPending={false}
        isJobPending={() => false}
        isTargetPending={() => false}
        jobs={overrides?.jobs ?? []}
        dismissedJobs={[]}
        liveEvents={[]}
        onDismissJob={vi.fn()}
        onRestoreDismissedJob={vi.fn()}
        onOpenBrowserSession={vi.fn()}
        onOpenBrowserSessionForTarget={vi.fn()}
        onQueueJob={vi.fn()}
        onRunAgentDiscovery={vi.fn()}
        onSelectJob={vi.fn()}
        recentRuns={overrides?.recentRuns ?? []}
        searchPreferences={searchPreferences}
        {...(overrides?.searchSelectivity
          ? { searchSelectivity: overrides.searchSelectivity }
          : {})}
        selectedJob={overrides?.selectedJob ?? null}
        sourceAccessPrompts={[]}
      />
    </MemoryRouter>
  );
}

function expectSetupView() {
  expect(screen.getByRole("region", { name: "Current search" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Job results" })).toBeNull();
}

function expectResultsView() {
  expect(screen.getByRole("region", { name: "Job results" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Current search" })).toBeNull();
}

afterEach(() => {
  cleanup();
});

describe("DiscoveryScreen first-result reveal", () => {
  it("opens on Results even when empty, and stays there when the first results arrive", () => {
    const view = render(buildScreen({ jobs: [] }));
    // The goal box and Search now are the setup; the defaults panel is one
    // click away, never the landing view.
    expectResultsView();

    view.rerender(buildScreen({ jobs: [createJob("first")] }));
    expectResultsView();
  });

  it("settles the route header when results arrive after Results was selected", () => {
    const view = render(buildScreen({ jobs: [] }));
    expectResultsView();

    const scrollArea = document.querySelector<HTMLElement>(
      "[data-locked-screen-scroll-area]",
    );
    const headerStack = document.querySelector<HTMLElement>(
      "[data-page-header-stack]",
    );
    if (!scrollArea || !headerStack) {
      throw new Error("Expected the locked route scroll area and header.");
    }

    scrollArea.scrollTop = 72;
    const headerRect = vi
      .spyOn(headerStack, "getBoundingClientRect")
      .mockReturnValue({ height: 120 } as DOMRect);

    view.rerender(buildScreen({ jobs: [createJob("first-results")] }));

    expect(scrollArea.scrollTop).toBe(120);
    headerRect.mockRestore();
  });

  it("never yanks the user back after they navigate away again", () => {
    const view = render(buildScreen({ jobs: [] }));
    expectResultsView();

    view.rerender(buildScreen({ jobs: [createJob("reveal")] }));
    expectResultsView();

    // The user deliberately returns to Search setup...
    fireEvent.click(
      document.querySelector(
        '[data-discovery-search-chip="roles"]',
      ) as HTMLElement,
    );
    expectSetupView();

    // ...and later empty→nonempty transitions must not repeat the reveal.
    view.rerender(buildScreen({ jobs: [] }));
    view.rerender(buildScreen({ jobs: [createJob("second")] }));
    expectSetupView();
  });

  it("keeps a workspace that opens with results on the Results view", () => {
    render(buildScreen({ jobs: [createJob("existing")] }));
    expectResultsView();

    // No reveal effect fires for an already-populated workspace, so
    // navigating to setup stays respected immediately.
    fireEvent.click(
      document.querySelector(
        '[data-discovery-search-chip="roles"]',
      ) as HTMLElement,
    );
    expectSetupView();
    cleanup();

    state.latestRunVerdicts.length = 0;
  });

  it("opens with the weaker matches shown only under Cast a wide net", () => {
    for (const [searchSelectivity, expected] of [
      ["wide_net", true],
      ["balanced", false],
      ["best_matches", false],
    ] as const) {
      state.alsoFoundShown.length = 0;
      render(buildScreen({ jobs: [createJob("one")], searchSelectivity }));
      expect(state.alsoFoundShown.at(-1)).toBe(expected);
      cleanup();
    }
  });

  it("passes the newest-run verdict down so failed runs cannot read as no-matches", () => {
    state.latestRunVerdicts.length = 0;
    const recentRuns = [
      {
        id: "run_old",
        state: "completed",
        startedAt: "2026-08-20T10:00:00.000Z",
      },
      {
        id: "run_new",
        state: "failed",
        startedAt: "2026-08-25T10:00:00.000Z",
      },
    ] as unknown as DiscoveryRunRecord[];

    render(buildScreen({ jobs: [createJob("one")], recentRuns }));

    expect(state.latestRunVerdicts.at(-1)).toEqual({
      hasEarlierCompleted: true,
      interruptState: "failed",
      kind: "interrupted",
    });
  });
});

it("reveals a selected detail at stacked widths and returns to its row", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  const scrollIntoView = vi.fn();
  const originalScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  try {
    const job = createJob("selected_row");
    render(buildScreen({ jobs: [job], selectedJob: job }));
    fireEvent.click(screen.getByRole("button", { name: "selected_row" }));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(scrollIntoView.mock.instances.at(-1)).toBe(
      screen.getByRole("region", { name: "Job details" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Return to rows" }));
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "center" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "selected_row" }),
    );
  } finally {
    if (originalScroll)
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScroll,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    vi.unstubAllGlobals();
  }
});
