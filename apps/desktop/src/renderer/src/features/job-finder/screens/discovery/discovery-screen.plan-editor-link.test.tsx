// @vitest-environment jsdom

import { fireEvent, cleanup, render, screen } from "@testing-library/react";
import type { JobSearchPreferences, SavedJob } from "@nestor/contracts";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  campaignPlanEditorHref,
  JOB_FINDER_ROUTE_PATHS,
} from "../../lib/job-finder-route-hrefs";

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
  DiscoveryDetailPanel: () => null,
}));
vi.mock("./discovery-filters-panel", () => ({
  DiscoveryFiltersPanel: ({ planEditorHref }: { planEditorHref?: string }) => (
    <section aria-label="Current search">
      <a data-testid="filters-plan-editor-link" href={planEditorHref}>
        Edit your places
      </a>
    </section>
  ),
}));
vi.mock("./discovery-results-panel", async () => {
  const { useFixtureListReport } =
    await import("./find-jobs-list-report.test-support");
  return {
    DISCOVERY_OFFLINE_CATALOG_NOTICE_ID: "discovery-offline-catalog-notice",
    DISCOVERY_SEARCH_SETUP_BLOCKER_ID: "discovery-search-setup-blocker",
    DiscoveryResultsPanel: (
      props: Parameters<typeof useFixtureListReport>[0] & {
        editPlanHref?: string | null;
      },
    ) => {
      useFixtureListReport(props);
      return (
        <section aria-label="Job results">
          <a
            data-testid="results-plan-editor-link"
            href={props.editPlanHref ?? ""}
          >
            Edit your places
          </a>
        </section>
      );
    },
  };
});

import {
  DiscoveryScreenWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

const searchPreferences: JobSearchPreferences = {
  targetRoles: ["Marketing Manager"],
  jobFamilies: [],
  locations: ["Chicago, IL"],
  excludedLocations: [],
  workModes: ["hybrid", "onsite"],
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
  discovery: { historyLimit: 5, targets: [] },
};

const job = {
  id: "job_1",
  title: "Marketing Manager",
  company: "Envisionit",
  location: "Chicago, IL",
  status: "discovered",
  matchAssessment: { recommendation: "strong_fit", score: 81 },
} as unknown as SavedJob;

afterEach(cleanup);

describe("Find jobs links to the selected plan's editor", () => {
  async function renderScreen(jobs: readonly SavedJob[]) {
    const rendered = render(
      <MemoryRouter>
        <DiscoveryScreenWithJobs
          actionState={{ message: null }}
          activeCampaignId="plan_chicago"
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "ready",
            driver: "chrome_profile_agent",
            label: "Browser ready",
            detail: "Browser session is ready.",
            lastCheckedAt: "2026-09-13T10:00:00.000Z",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isJobPending={() => false}
          isTargetPending={() => false}
          jobs={jobs}
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
          selectedJob={jobs[0] ?? null}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );
    await flushFindJobsQueries();
    return rendered;
  }

  // General setup lives on Profile; result recovery edits this plan's places.
  it("points the search-setup panel's places link at Profile preferences", async () => {
    await renderScreen([]);
    fireEvent.click(
      screen.getByRole("button", { name: "Roles, places & sources" }),
    );

    expect(
      screen.getByTestId("filters-plan-editor-link").getAttribute("href"),
    ).toBe(JOB_FINDER_ROUTE_PATHS.profileWorkModes);
  });

  it("points the results panel's places link at this plan's editor", async () => {
    await renderScreen([job]);

    expect(
      screen.getByTestId("results-plan-editor-link").getAttribute("href"),
    ).toBe(campaignPlanEditorHref("plan_chicago"));
  });
});
