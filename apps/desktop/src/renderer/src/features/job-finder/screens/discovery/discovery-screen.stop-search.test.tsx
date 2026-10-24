// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  BrowserSessionState,
  DiscoveryRunRecord,
  JobSearchPreferences,
  SavedJob,
} from "@nestor/contracts";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  DiscoveryDetailPanel: () => <section aria-label="Job details" />,
}));
vi.mock("./discovery-filters-panel", () => ({
  DiscoveryFiltersPanel: () => <section aria-label="Current search" />,
}));
vi.mock("./discovery-results-panel", async () => {
  const { useFixtureListReport } =
    await import("./find-jobs-list-report.test-support");
  return {
    DiscoveryResultsPanel: (
      props: Parameters<typeof useFixtureListReport>[0],
    ) => {
      useFixtureListReport(props);
      return <section aria-label="Job results" />;
    },
  };
});

import type { DiscoveryScreen } from "./discovery-screen";
import { COMMAND_PENDING_RELEASE_MS } from "@renderer/features/job-finder/lib/discovery-stop-state";
import { DISCOVERY_STOP_UNACKNOWLEDGED_LABEL } from "@renderer/features/job-finder/lib/status-copy";
import { DiscoveryScreenWithJobs } from "./find-jobs-query-fixture.test-support";

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

const completedRun = {
  id: "run_1",
  state: "completed",
} as unknown as DiscoveryRunRecord;

const plans = [
  {
    id: "plan_1",
    name: "Backend roles",
    status: "active",
    limits: { retainedJobTarget: 15 },
  },
  {
    id: "plan_2",
    name: "Platform roles",
    status: "active",
    limits: { retainedJobTarget: 15 },
  },
] as unknown as NonNullable<Parameters<typeof DiscoveryScreen>[0]["campaigns"]>;

function buildScreen(overrides?: {
  activeRun?: DiscoveryRunRecord | null;
  onCancelDiscovery?: (runId: string) => Promise<boolean>;
}) {
  return (
    <MemoryRouter>
      <DiscoveryScreenWithJobs
        actionState={{ message: null }}
        activeRun={overrides?.activeRun ?? null}
        activeCampaignId="plan_1"
        campaigns={plans}
        onSelectCampaign={vi.fn()}
        browserSession={browserSession}
        discoverySessions={[]}
        isBrowserSessionPending={false}
        isBrowserSessionPendingForTarget={() => false}
        isDiscoveryAllPending={false}
        isJobPending={() => false}
        isTargetPending={() => false}
        jobs={[createJob("strong")]}
        liveEvents={[]}
        {...(overrides?.onCancelDiscovery
          ? { onCancelDiscovery: overrides.onCancelDiscovery }
          : {})}
        onDismissJob={vi.fn()}
        onRestoreDismissedJob={vi.fn()}
        onOpenBrowserSession={vi.fn()}
        onOpenBrowserSessionForTarget={vi.fn()}
        onQueueJob={vi.fn()}
        onRunAgentDiscovery={vi.fn()}
        onSelectJob={vi.fn()}
        recentRuns={[]}
        searchPreferences={searchPreferences}
        selectedJob={createJob("strong")}
        sourceAccessPrompts={[]}
      />
    </MemoryRouter>
  );
}

function getStopSearchButton() {
  return screen.getByRole("button", { name: "Stop search" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("DiscoveryScreen stop search action", () => {
  it("keeps the idle header unchanged without any stop control", () => {
    render(
      buildScreen({
        onCancelDiscovery: vi.fn(() => Promise.resolve(true)),
      }),
    );

    const searchButton = screen.getByRole("button", { name: "Search now" });
    expect(searchButton.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Stop search" })).toBeNull();
  });

  it("exposes an operable Stop search beside the disabled Searching control while a run is active", () => {
    const onCancelDiscovery = vi.fn(() => Promise.resolve(true));
    render(buildScreen({ activeRun: runningRun, onCancelDiscovery }));

    const searching = screen.getByRole("button", { name: "Searching" });
    expect(searching.hasAttribute("disabled")).toBe(true);

    const stop = getStopSearchButton();
    expect(stop.hasAttribute("disabled")).toBe(false);
    expect(stop.getAttribute("data-pending")).toBeNull();
    expect(stop.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(stop);
    expect(onCancelDiscovery).toHaveBeenCalledTimes(1);
    expect(onCancelDiscovery).toHaveBeenCalledWith("run_1");
    // Stop means stop: no confirm dialog stands between the press and the
    // cancel request.
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("makes a requested stop inert and focus-stable, then re-arms after the run leaves running", () => {
    const onCancelDiscovery = vi.fn(() => Promise.resolve(true));
    const { rerender } = render(
      buildScreen({ activeRun: runningRun, onCancelDiscovery }),
    );

    const stop = getStopSearchButton();
    fireEvent.click(stop);
    // Pending convention: busy + aria-disabled while staying in the tab
    // order, so focus never drops to <body> mid-request.
    expect(stop.getAttribute("data-pending")).toBe("true");
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.hasAttribute("disabled")).toBe(false);

    fireEvent.click(stop);
    fireEvent.keyDown(stop, { key: "Enter" });
    expect(onCancelDiscovery).toHaveBeenCalledTimes(1);

    // The settled run clears the request; the next run gets a live stop.
    rerender(buildScreen({ activeRun: completedRun, onCancelDiscovery }));
    expect(screen.queryByRole("button", { name: "Stop search" })).toBeNull();

    rerender(
      buildScreen({
        activeRun: { ...runningRun, id: "run_2" },
        onCancelDiscovery,
      }),
    );
    const nextStop = getStopSearchButton();
    expect(nextStop.hasAttribute("disabled")).toBe(false);
    expect(nextStop.getAttribute("data-pending")).toBeNull();
    fireEvent.click(nextStop);
    expect(onCancelDiscovery).toHaveBeenCalledTimes(2);
  });

  it("bounds Stopping and releases every control once the stop goes unanswered", () => {
    vi.useFakeTimers();
    try {
      const onCancelDiscovery = vi.fn(() => Promise.resolve(true));
      const stoppingRun = {
        id: "run_1",
        state: "running",
        cancellationRequestedAt: new Date().toISOString(),
      } as unknown as DiscoveryRunRecord;

      const { rerender } = render(
        buildScreen({ activeRun: stoppingRun, onCancelDiscovery }),
      );

      // While the search may still be winding down the app says so and the
      // search controls stay held.
      expect(
        screen
          .getByTestId("discovery-header-stop-search")
          .getAttribute("data-pending"),
      ).toBe("true");
      expect(
        screen
          .getByRole("button", { name: "Prefer recent" })
          .hasAttribute("disabled"),
      ).toBe(true);

      vi.advanceTimersByTime(COMMAND_PENDING_RELEASE_MS);
      rerender(buildScreen({ activeRun: stoppingRun, onCancelDiscovery }));

      // Past the release window the counter and the Stopping control are gone,
      // the plan dropdown is operable again, and the app says what it knows.
      expect(screen.queryByTestId("discovery-header-stop-search")).toBeNull();
      expect(screen.queryByTestId("discovery-search-progress")).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "Prefer recent" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(
        screen
          .getByRole("button", { name: "Search now" })
          .hasAttribute("disabled"),
      ).toBe(false);
      expect(
        screen.getByTestId("discovery-search-stopped-notice").textContent,
      ).toBe(DISCOVERY_STOP_UNACKNOWLEDGED_LABEL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders no stop control when no upstream cancellation handler exists", () => {
    render(buildScreen({ activeRun: runningRun }));

    expect(screen.queryByRole("button", { name: "Stop search" })).toBeNull();
    expect(screen.getByRole("button", { name: "Searching" })).toBeTruthy();
  });
});
