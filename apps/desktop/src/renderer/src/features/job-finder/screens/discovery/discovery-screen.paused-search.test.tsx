// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  BrowserSessionState,
  JobSearchPreferences,
  SavedJob,
} from "@nestor/contracts";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  DiscoveryFiltersPanel: ({ activityPaused }: { activityPaused?: boolean }) => (
    <section aria-label="Current search">
      {activityPaused ? "setup-search-paused" : "setup-search-available"}
    </section>
  ),
}));
vi.mock("./discovery-results-panel", () => ({
  DiscoveryResultsPanel: () => (
    <section aria-label="Job results">Job results</section>
  ),
}));

import { DiscoveryScreen } from "./discovery-screen";

const browserSession = {
  source: "target_site",
  status: "ready",
  driver: "chrome_profile_agent",
  label: "Browser ready",
  detail: "The browser is ready for source search.",
  lastCheckedAt: "2026-08-25T10:00:00.000Z",
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

function buildScreen(overrides?: {
  activityPaused?: boolean;
  isActivityPausePending?: boolean;
  onResumeActivity?: () => void;
}) {
  return (
    <MemoryRouter>
      <DiscoveryScreen
        actionState={{ message: null }}
        {...(overrides?.activityPaused ? { activityPaused: true } : {})}
        activeRun={null}
        browserSession={browserSession}
        {...(overrides?.isActivityPausePending
          ? { isActivityPausePending: true }
          : {})}
        discoverySessions={[]}
        isBrowserSessionPending={false}
        isBrowserSessionPendingForTarget={() => false}
        isDiscoveryAllPending={false}
        isJobPending={() => false}
        isTargetPending={() => false}
        jobs={[createJob("strong")]}
        dismissedJobs={[]}
        liveEvents={[]}
        onDismissJob={vi.fn()}
        onRestoreDismissedJob={vi.fn()}
        onOpenBrowserSession={vi.fn()}
        onOpenBrowserSessionForTarget={vi.fn()}
        onQueueJob={vi.fn()}
        onRunAgentDiscovery={vi.fn()}
        {...(overrides?.onResumeActivity
          ? { onResumeActivity: overrides.onResumeActivity }
          : {})}
        onSelectJob={vi.fn()}
        recentRuns={[]}
        searchPreferences={searchPreferences}
        selectedJob={createJob("strong")}
        sourceAccessPrompts={[]}
      />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
});

function pausedItem() {
  return document.querySelector('[data-page-status-item="activity-paused"]');
}

describe("DiscoveryScreen paused search availability", () => {
  it("states the pause once on the status line with Resume and disables the header search with a visible reason", () => {
    const onResumeActivity = vi.fn();
    render(buildScreen({ activityPaused: true, onResumeActivity }));

    // One amber status item, not a status line plus a banner.
    const item = pausedItem();
    expect(
      item?.closest("[data-page-header-status]")?.getAttribute("role"),
    ).toBe("status");
    expect(item?.getAttribute("data-tone")).toBe("warning");
    expect(item?.textContent).toMatch(/paused/i);
    expect(screen.queryByTestId("discovery-paused-banner")).toBeNull();
    expect(screen.getAllByText(/paused/i)).toHaveLength(1);

    const searchButton = screen.getByRole("button", { name: "Search now" });
    expect(searchButton.hasAttribute("disabled")).toBe(true);
    expect(searchButton.getAttribute("aria-describedby")).toBe(
      "discovery-header-search-paused-reason",
    );

    const reason = document.getElementById(
      "discovery-header-search-paused-reason",
    );
    expect(reason?.textContent).toBe(
      "Paused. New searches and applications wait until you resume.",
    );

    fireEvent.click(screen.getByRole("button", { name: /resume activity/i }));
    expect(onResumeActivity).toHaveBeenCalledTimes(1);
  });

  it("keeps the paused truth visible in setup mode and reports the pause to the setup panel", () => {
    render(buildScreen({ activityPaused: true }));

    fireEvent.click(
      document.querySelector(
        '[data-discovery-search-chip="roles"]',
      ) as HTMLElement,
    );

    // Setup mode renders the filters panel; the pause stays on the line.
    expect(screen.getByText(/setup-search-paused/i)).toBeTruthy();
    expect(pausedItem()).toBeTruthy();
  });

  it("offers no banner and keeps search available when activity is running again", () => {
    render(buildScreen({}));

    expect(pausedItem()).toBeNull();
    expect(document.querySelector("[data-page-header-status]")).toBeNull();
    const searchButton = screen.getByRole("button", { name: "Search now" });
    expect(searchButton.hasAttribute("disabled")).toBe(false);

    fireEvent.click(
      document.querySelector(
        '[data-discovery-search-chip="roles"]',
      ) as HTMLElement,
    );
    expect(screen.getByText(/setup-search-available/i)).toBeTruthy();
  });

  it("renders a pending Resume control while the resume request is in flight", () => {
    render(
      buildScreen({
        activityPaused: true,
        isActivityPausePending: true,
        onResumeActivity: vi.fn(),
      }),
    );

    const resumeButton = screen.getByRole("button", {
      name: "Resume activity",
    });
    // The shared Button marks in-flight controls via aria-busy/data-pending
    // plus aria-disabled instead of relying on color alone.
    expect(resumeButton?.getAttribute("data-pending")).toBe("true");
    expect(resumeButton?.getAttribute("aria-busy")).toBe("true");
  });
});
