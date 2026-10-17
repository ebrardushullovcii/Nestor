// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  JobDiscoveryTargetSchema,
  SavedJobSchema,
  type BrowserSessionState,
  type JobSearchPreferences,
  type SavedJob,
} from "@nordri/contracts";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ToastProvider } from "@renderer/components/ui/toast";
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

const detailProbe = vi.hoisted(() => ({
  latest: null as { selectedJob: SavedJob | null } | null,
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
  DiscoveryDetailPanel: (props: {
    selectedJob: SavedJob | null;
    onAssessJobListing?: (id: string) => Promise<void>;
  }) => {
    detailProbe.latest = { selectedJob: props.selectedJob };
    // The screen unmounts the inspector when nothing is inspectable; an
    // unmounted panel is the same truth as a cleared selection.
    useEffect(
      () => () => {
        detailProbe.latest = { selectedJob: null };
      },
      [],
    );
    return (
      <section aria-label="Job details">
        Job details
        {props.onAssessJobListing && props.selectedJob ? (
          <button
            onClick={() =>
              void props.onAssessJobListing!(props.selectedJob!.id)
            }
          >
            Assess selected listing
          </button>
        ) : null}
      </section>
    );
  },
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

const JOB_COUNT = 60;

function createJobs(count = JOB_COUNT): SavedJob[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index.toString().padStart(3, "0");

    return SavedJobSchema.parse({
      id: `sync_job_${ordinal}`,
      source: "target_site",
      sourceJobId: `sync_source_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/roles/${ordinal}`,
      applicationUrl: `https://jobs.example.test/roles/${ordinal}/apply`,
      title: `Product Designer ${ordinal}`,
      company: index >= 55 ? "Northstar Labs" : `Sync Company ${index % 7}`,
      location: "Remote",
      workMode: ["remote"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: "2026-08-01T10:00:00.000Z",
      salaryText: null,
      description: `Own product systems for role ${ordinal}.`,
      status: "discovered",
      matchAssessment: {
        score: 100 - index,
        reasons: ["Relevant product design experience"],
        gaps: [],
      },
    });
  });
}

function renderScreen(options?: {
  jobs?: readonly SavedJob[];
  campaigns?: Parameters<typeof DiscoveryScreen>[0]["campaigns"];
  activeCampaignId?: string;
  onSelectJob?: (jobId: string) => void;
  searchPreferences?: JobSearchPreferences;
  selectedJob?: SavedJob | null;
}) {
  const jobs = options?.jobs ?? createJobs();
  return render(
    <MemoryRouter>
      <DiscoveryScreen
        actionState={{ message: null }}
        activeRun={null}
        {...(options?.campaigns ? { campaigns: options.campaigns } : {})}
        {...(options?.activeCampaignId
          ? { activeCampaignId: options.activeCampaignId }
          : {})}
        browserSession={browserSession}
        discoverySessions={[]}
        isBrowserSessionPending={false}
        isBrowserSessionPendingForTarget={() => false}
        isDiscoveryAllPending={false}
        isJobPending={() => false}
        isTargetPending={() => false}
        jobs={jobs}
        dismissedJobs={[]}
        liveEvents={[]}
        onDismissJob={vi.fn()}
        onRestoreDismissedJob={vi.fn()}
        onOpenBrowserSession={vi.fn()}
        onOpenBrowserSessionForTarget={vi.fn()}
        onQueueJob={vi.fn()}
        onRunAgentDiscovery={vi.fn()}
        onSelectJob={options?.onSelectJob ?? vi.fn()}
        recentRuns={[{ id: "run_1", state: "completed" } as never]}
        searchPreferences={options?.searchPreferences ?? searchPreferences}
        {...(options?.selectedJob !== undefined
          ? { selectedJob: options.selectedJob }
          : { selectedJob: jobs[0] ?? null })}
        sourceAccessPrompts={[]}
      />
    </MemoryRouter>,
  );
}

function getResultButton(jobId: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-job-result-id="${jobId}"]`,
  );
  if (!button) {
    throw new Error(`Expected result button for ${jobId}.`);
  }
  return button;
}

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
  detailProbe.latest = null;
});

describe("DiscoveryScreen inspector sync across pagination and search", () => {
  it("passes configured discovery targets into result attribution and falls back after removal", () => {
    const target = JobDiscoveryTargetSchema.parse({
      id: "target_private_board",
      label: "Private Product Roles",
      startingUrl: "https://careers.example.test/jobs",
    });
    const job = SavedJobSchema.parse({
      ...createJobs(1)[0]!,
      provenance: [
        {
          targetId: target.id,
          adapterKind: "auto",
          startingUrl: "https://fallback.example.test/jobs?q=product",
          discoveredAt: "2026-08-23T10:00:00.000Z",
          collectionMethod: "careers_page",
        },
      ],
    });
    const configuredPreferences = {
      ...searchPreferences,
      discovery: {
        ...searchPreferences.discovery,
        targets: [target],
      },
    };

    renderScreen({
      jobs: [job],
      searchPreferences: configuredPreferences,
      selectedJob: job,
    });

    expect(
      screen
        .getByTestId(`discovery-result-source-${job.id}`)
        .getAttribute("title"),
    ).toBe("Found on Private Product Roles");

    cleanup();
    renderScreen({
      jobs: [job],
      searchPreferences: {
        ...configuredPreferences,
        discovery: { ...configuredPreferences.discovery, targets: [] },
      },
      selectedJob: job,
    });

    expect(
      screen
        .getByTestId(`discovery-result-source-${job.id}`)
        .getAttribute("title"),
    ).toBe("Found on fallback.example.test");
  });

  it("keeps the selected job while moving to another results page", () => {
    const jobs = createJobs();
    const onSelectJob = vi.fn();
    renderScreen({ onSelectJob, selectedJob: jobs[0] ?? null });

    expect(detailProbe.latest?.selectedJob?.id).toBe("sync_job_000");
    expect(getResultButton("sync_job_000").getAttribute("aria-current")).toBe(
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("51–60 of 60")).toBeTruthy();
    // The inspector must now display a job that is actually on this page.
    const inspectedId = detailProbe.latest?.selectedJob?.id ?? null;
    expect(inspectedId).toBe("sync_job_000");
    expect(getResultButton("sync_job_050")).toBeTruthy();
    // The stale page-one job is no longer rendered, let alone selected.
    expect(
      document.querySelector('[data-job-result-id="sync_job_000"]'),
    ).toBeNull();
    // Synchronizing the inspector is derived view state; it must not write
    // an implicit selection into the workspace context.
    expect(onSelectJob).not.toHaveBeenCalled();
  });

  it("clears the stale inspector when a search filters every result out", async () => {
    renderScreen();

    expect(detailProbe.latest?.selectedJob?.id).toBe("sync_job_000");

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a job" }), {
      target: { value: "zzz-no-such-role" },
    });

    await waitFor(() => {
      expect(detailProbe.latest?.selectedJob).toBeNull();
    });
    expect(screen.getByText("0 of 60 jobs")).toBeTruthy();
  });

  it("inspects the strongest remaining job when a search narrows the pool", async () => {
    renderScreen();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a job" }), {
      target: { value: "Northstar" },
    });

    await waitFor(() => {
      expect(detailProbe.latest?.selectedJob?.id).toBe("sync_job_055");
    });
    expect(screen.getByText("5 of 60 jobs")).toBeTruthy();
    expect(getResultButton("sync_job_055").getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("keeps a deep-linked off-page selection inspected and opens its page", () => {
    const jobs = createJobs();
    renderScreen({ selectedJob: jobs[59] ?? null });

    expect(screen.getByText("51–60 of 60")).toBeTruthy();
    expect(detailProbe.latest?.selectedJob?.id).toBe("sync_job_059");
    expect(getResultButton("sync_job_059").getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("still inspects the exact job after an explicit click on another page", () => {
    const jobs = createJobs();
    const onSelectJob = vi.fn();
    const { rerender } = renderScreen({
      onSelectJob,
      selectedJob: jobs[0] ?? null,
    });

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(getResultButton("sync_job_052"));
    expect(onSelectJob).toHaveBeenCalledWith("sync_job_052");

    rerender(
      <MemoryRouter>
        <DiscoveryScreen
          actionState={{ message: null }}
          activeRun={null}
          browserSession={browserSession}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isJobPending={() => false}
          isTargetPending={() => false}
          jobs={jobs}
          dismissedJobs={[]}
          liveEvents={[]}
          onDismissJob={vi.fn()}
          onRestoreDismissedJob={vi.fn()}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onQueueJob={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onSelectJob={onSelectJob}
          recentRuns={[{ id: "run_1", state: "completed" } as never]}
          searchPreferences={searchPreferences}
          selectedJob={jobs[52] ?? null}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );

    expect(detailProbe.latest?.selectedJob?.id).toBe("sync_job_052");
    expect(getResultButton("sync_job_052").getAttribute("aria-current")).toBe(
      "true",
    );
  });
});

it("keeps the initial filtered row and inspector together", async () => {
  const jobs = createJobs(2);
  jobs[1]!.workMode = ["hybrid"];
  const view = renderScreen({
    jobs,
    selectedJob: jobs[0]!,
    activeCampaignId: "sync-plan",
  });
  fireEvent.click(screen.getByText("Filters"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Hybrid" }));
  await waitFor(() =>
    expect(detailProbe.latest?.selectedJob?.id).toBe(jobs[1]!.id),
  );
  expect(getResultButton(jobs[1]!.id).getAttribute("aria-current")).toBe(
    "true",
  );
  // A parent remount must not reset the inspector to the hidden requested job.
  view.unmount();
  renderScreen({ jobs, selectedJob: jobs[0]!, activeCampaignId: "sync-plan" });
  expect(detailProbe.latest?.selectedJob?.id).toBe(jobs[1]!.id);
  expect(getResultButton(jobs[1]!.id).getAttribute("aria-current")).toBe(
    "true",
  );
});

it("announces the assessed fit when the job moves to weaker matches", async () => {
  function World() {
    const [jobs, setJobs] = useState(createJobs(1));
    return (
      <ToastProvider>
        <MemoryRouter>
          <DiscoveryScreen
            actionState={{ message: null }}
            activeRun={null}
            browserSession={browserSession}
            discoverySessions={[]}
            isBrowserSessionPending={false}
            isBrowserSessionPendingForTarget={() => false}
            isDiscoveryAllPending={false}
            isJobPending={() => false}
            isTargetPending={() => false}
            jobs={jobs}
            dismissedJobs={[]}
            liveEvents={[]}
            onDismissJob={vi.fn()}
            onRestoreDismissedJob={vi.fn()}
            onOpenBrowserSession={vi.fn()}
            onOpenBrowserSessionForTarget={vi.fn()}
            onQueueJob={vi.fn()}
            onRunAgentDiscovery={vi.fn()}
            onSelectJob={vi.fn()}
            recentRuns={[{ id: "run_1", state: "completed" } as never]}
            searchPreferences={searchPreferences}
            selectedJob={jobs[0] ?? null}
            searchSelectivity="best_matches"
            onAssessJobListing={() => {
              setJobs([
                {
                  ...jobs[0]!,
                  matchAssessment: {
                    ...jobs[0]!.matchAssessment,
                    score: 20,
                    recommendation: "skip",
                    judgment: {
                      ...jobs[0]!.matchAssessment.judgment!,
                      score: 20,
                      recommendation: "skip",
                      role: "conflict",
                      judgedAt: "2026-10-05T12:00:00.000Z",
                    },
                  },
                },
              ]);
              return Promise.resolve();
            }}
            sourceAccessPrompts={[]}
          />
        </MemoryRouter>
      </ToastProvider>
    );
  }
  render(<World />);
  fireEvent.click(
    screen.getByRole("button", { name: "Assess selected listing" }),
  );
  expect(
    await screen.findByText("Assessed: 20% fit, moved to weaker matches"),
  ).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "Show weaker matches" }).length,
  ).toBeGreaterThan(0);
});
