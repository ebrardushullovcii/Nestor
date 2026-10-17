// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  BrowserSessionState,
  JobSearchPreferences,
  SavedJob,
} from "@nestor/contracts";
import { SavedJobSchema } from "@nestor/contracts";
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
  DiscoveryFiltersPanel: () => (
    <section aria-label="Current search">Current search</section>
  ),
}));

import { DiscoveryScreen } from "./discovery-screen";

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
} as BrowserSessionState;

const searchPreferences = {
  targetRoles: ["Product Designer"],
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
} as unknown as JobSearchPreferences;

const job: SavedJob = SavedJobSchema.parse({
  id: "job_return",
  source: "target_site",
  sourceJobId: "source_return",
  canonicalUrl: "https://jobs.example.test/roles/return",
  applicationUrl: "https://jobs.example.test/roles/return/apply",
  title: "Product Engineer",
  company: "Acme",
  location: "Remote",
  workMode: ["remote"],
  applyPath: "external_redirect",
  easyApplyEligible: false,
  discoveredAt: "2026-08-01T10:00:00.000Z",
  salaryText: null,
  description: "Own product systems.",
  status: "discovered",
  matchAssessment: { score: 80, reasons: ["Relevant"], gaps: [] },
});

function renderScreen(options?: { onBackToRapidReview?: () => void }) {
  return render(
    <MemoryRouter>
      <DiscoveryScreen
        actionState={{ message: null }}
        activeRun={null}
        browserSession={browserSession}
        discoverySessions={[]}
        {...(options?.onBackToRapidReview
          ? { onBackToRapidReview: options.onBackToRapidReview }
          : {})}
        isBrowserSessionPending={false}
        isBrowserSessionPendingForTarget={() => false}
        isDiscoveryAllPending={false}
        isJobPending={() => false}
        isTargetPending={() => false}
        jobs={[job]}
        dismissedJobs={[]}
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
        selectedJob={job}
        sourceAccessPrompts={[]}
      />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("DiscoveryScreen rapid review return action", () => {
  it("renders the direct return action only when a return context exists", () => {
    renderScreen();

    expect(
      screen.queryByRole("button", { name: "Back to rapid review" }),
    ).toBeNull();
  });

  it("invokes the return handler from the rendered action", () => {
    const onBackToRapidReview = vi.fn();
    renderScreen({ onBackToRapidReview });

    fireEvent.click(
      screen.getByRole("button", { name: "Back to rapid review" }),
    );

    expect(onBackToRapidReview).toHaveBeenCalledTimes(1);
  });
});
