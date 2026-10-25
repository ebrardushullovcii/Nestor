// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { DiscoveryRunRecordSchema } from "@nestor/contracts";
import type { BrowserSessionState } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiscoveryLatestRunVerdict } from "./discovery-run-feedback";
import {
  DiscoveryResultsPanelWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

const browserSession: BrowserSessionState = {
  source: "target_site",
  status: "ready",
  driver: "chrome_profile_agent",
  label: "Browser ready",
  detail: "Ready when needed.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
};

async function renderEmptyResults(options?: {
  browserSession?: BrowserSessionState;
  hasCompletedSearch?: boolean;
  isSearchInProgress?: boolean;
  latestRunVerdict?: DiscoveryLatestRunVerdict | null;
  editPlanHref?: string;
  failureCalloutShown?: boolean;
}) {
  const rendered = render(
    <MemoryRouter>
      <DiscoveryResultsPanelWithJobs
        browserSession={options?.browserSession ?? browserSession}
        jobs={[]}
        onSelectJob={vi.fn()}
        selectedJob={null}
        {...(options?.editPlanHref
          ? { editPlanHref: options.editPlanHref }
          : {})}
        {...(options?.hasCompletedSearch ? { hasCompletedSearch: true } : {})}
        {...(options?.failureCalloutShown ? { failureCalloutShown: true } : {})}
        {...(options?.isSearchInProgress ? { isSearchInProgress: true } : {})}
        {...(options?.latestRunVerdict !== undefined
          ? { latestRunVerdict: options.latestRunVerdict }
          : {})}
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();
  return rendered;
}

afterEach(() => {
  cleanup();
});

describe("DiscoveryResultsPanel newest-run empty-state verdicts", () => {
  it("offers source setup when the offline catalog has no results", async () => {
    await renderEmptyResults({
      browserSession: {
        ...browserSession,
        driver: "catalog_seed",
        status: "unknown",
      },
    });

    expect(screen.getByText("Job Finder cannot search right now")).toBeTruthy();
    const emptyState = screen.getByRole("heading", {
      name: "Job Finder cannot search right now",
    }).parentElement?.parentElement;
    expect(emptyState?.className).toContain("min-h-0");
    expect(emptyState?.className).not.toContain("min-h-80");
    expect(
      screen
        .getByRole("link", { name: "Review job sources" })
        .getAttribute("href"),
    ).toBe("/job-finder/profile?section=sources&focus=job-sources");
    expect(
      screen.getByText(
        /check your saved job sites in profile, then try searching again/iu,
      ),
    ).toBeTruthy();
  });

  it("shows an explicit failed state instead of first-search or no-match copy", async () => {
    await renderEmptyResults({
      latestRunVerdict: {
        hasEarlierCompleted: false,
        interruptState: "failed",
        kind: "interrupted",
      },
    });

    expect(
      screen.getByText("The last search stopped before finishing"),
    ).toBeTruthy();
    expect(
      screen.getByText(/stopped before every enabled source was checked/),
    ).toBeTruthy();
    expect(screen.queryByText("No matches from this search")).toBeNull();
    expect(screen.queryByText("Ready for your first search")).toBeNull();
  });

  it("names cancellation as its own outcome", async () => {
    await renderEmptyResults({
      latestRunVerdict: {
        hasEarlierCompleted: false,
        interruptState: "cancelled",
        kind: "interrupted",
      },
    });

    expect(screen.getByText("The last search was cancelled")).toBeTruthy();
    expect(
      screen.getByText(/was cancelled before every enabled source was checked/),
    ).toBeTruthy();
    expect(screen.queryByText("No matches from this search")).toBeNull();
    expect(screen.queryByText("Ready for your first search")).toBeNull();
  });

  it("shows the stopped verdict without a second box about an earlier search", async () => {
    await renderEmptyResults({
      latestRunVerdict: {
        hasEarlierCompleted: true,
        interruptState: "cancelled",
        kind: "interrupted",
      },
    });

    expect(screen.queryByText(/An earlier completed search exists/)).toBeNull();
    expect(screen.getByText("The last search was cancelled")).toBeTruthy();
  });

  it("reports a zero-result completed run with failed sources as source failures", async () => {
    await renderEmptyResults({
      latestRunVerdict: {
        hasEarlierCompleted: false,
        interruptState: "sources_failed",
        kind: "interrupted",
      },
    });

    expect(
      screen.getByText("The last search finished, but sources failed"),
    ).toBeTruthy();
    expect(
      screen.getByText(/finished, but at least one enabled source failed/),
    ).toBeTruthy();
    expect(screen.queryByText("No matches from this search")).toBeNull();
  });

  it("defers to the failure callout instead of offering Search now beside it", async () => {
    const verdict: DiscoveryLatestRunVerdict = {
      hasEarlierCompleted: false,
      interruptState: "sources_failed",
      kind: "interrupted",
    };
    await renderEmptyResults({ latestRunVerdict: verdict });
    expect(screen.getByText(/Select Search now to try again\./)).toBeTruthy();
    cleanup();

    await renderEmptyResults({
      latestRunVerdict: verdict,
      failureCalloutShown: true,
    });
    expect(screen.queryByText(/Select Search now to try again/)).toBeNull();
    expect(
      screen.getByText(/The message above says what to do next\./),
    ).toBeTruthy();
  });

  it("keeps the degraded verdict without a second box about an earlier search", async () => {
    await renderEmptyResults({
      latestRunVerdict: {
        hasEarlierCompleted: true,
        interruptState: "sources_failed",
        kind: "interrupted",
      },
    });

    expect(
      screen.getByText("The last search finished, but sources failed"),
    ).toBeTruthy();
    expect(screen.queryByText(/An earlier completed search exists/)).toBeNull();
    expect(screen.queryByText("No matches from this search")).toBeNull();
  });

  it("keeps the no-match verdict only for a completed newest run", async () => {
    await renderEmptyResults({
      editPlanHref: "/job-finder/campaigns?campaignId=plan_chicago",
      latestRunVerdict: { kind: "completed" },
    });

    expect(screen.getByText("No matches from this search")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Edit your places" })
        .getAttribute("href"),
    ).toBe("/job-finder/campaigns?campaignId=plan_chicago");
    expect(
      screen.queryByText("The last search stopped before finishing"),
    ).toBeNull();
  });

  it("keeps the ready verdict only when no settled run exists", async () => {
    await renderEmptyResults({ latestRunVerdict: { kind: "none" } });

    expect(screen.getByText("Ready for your first search")).toBeTruthy();
    expect(screen.queryByText("No matches from this search")).toBeNull();
  });

  it("falls back to the legacy completed flag when no verdict is provided", async () => {
    await renderEmptyResults({ hasCompletedSearch: true });
    expect(screen.getByText("No matches from this search")).toBeTruthy();

    cleanup();

    await renderEmptyResults();
    expect(screen.getByText("Ready for your first search")).toBeTruthy();
  });

  it("keeps live progress above any terminal verdict while a run is active", async () => {
    await renderEmptyResults({
      isSearchInProgress: true,
      latestRunVerdict: {
        hasEarlierCompleted: false,
        interruptState: "failed",
        kind: "interrupted",
      },
    });

    expect(screen.getByText("Searching your sources")).toBeTruthy();
    expect(
      screen.queryByText("The last search stopped before finishing"),
    ).toBeNull();
  });

  it("treats a running newest run as live progress rather than a final verdict", async () => {
    await renderEmptyResults({ latestRunVerdict: { kind: "running" } });

    expect(screen.getByText("Searching your sources")).toBeTruthy();
    expect(screen.queryByText("Ready for your first search")).toBeNull();
    expect(screen.queryByText("No matches from this search")).toBeNull();
  });
});

it("keeps recorded source explanations and coverage after a no-match search", async () => {
  const run = DiscoveryRunRecordSchema.parse({
    id: "empty",
    state: "completed",
    scope: "run_all",
    startedAt: "2026-08-23T10:00:00.000Z",
    completedAt: "2026-08-23T10:01:00.000Z",
    targetIds: ["empty", "populated"],
    targetExecutions: [
      { targetId: "empty", adapterKind: "auto", state: "completed" },
      {
        targetId: "populated",
        adapterKind: "auto",
        state: "completed",
        jobsReviewed: 12,
      },
    ],
    activity: [
      {
        id: "empty-note",
        runId: "empty",
        timestamp: "2026-08-23T10:01:00.000Z",
        kind: "progress",
        stage: "target",
        targetId: "empty",
        terminalState: "completed",
        message: "No listings were published.",
      },
      {
        id: "populated-note",
        runId: "empty",
        timestamp: "2026-08-23T10:01:00.000Z",
        kind: "progress",
        stage: "target",
        targetId: "populated",
        terminalState: "completed",
        message: "No project management roles in the listings read.",
      },
    ],
    summary: { outcome: "completed", targetsPlanned: 2, targetsCompleted: 2 },
  });
  render(
    <MemoryRouter>
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[]}
        onSelectJob={vi.fn()}
        selectedJob={null}
        hasCompletedSearch
        latestRun={run}
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();
  expect(
    screen.getByTestId("discovery-source-summaries").hasAttribute("open"),
  ).toBe(false);
  fireEvent.click(
    screen.getByTestId("discovery-source-summaries").querySelector("summary")!,
  );
  expect(screen.getByText("No listings were published.")).toBeTruthy();
  expect(
    screen.getByText("No project management roles in the listings read."),
  ).toBeTruthy();
  expect(screen.getAllByText(/inspected not recorded/)).toHaveLength(2);
});

it("says no source could be searched when every source failed, and retries it directly", async () => {
  const run = DiscoveryRunRecordSchema.parse({
    id: "partial",
    state: "completed",
    scope: "run_all",
    startedAt: "2026-08-23T10:00:00.000Z",
    completedAt: "2026-08-23T10:01:00.000Z",
    targetIds: ["blocked"],
    targetExecutions: [
      { targetId: "blocked", adapterKind: "auto", state: "failed" },
    ],
    summary: { outcome: "completed", targetsPlanned: 1, targetsCompleted: 1 },
  });
  const onRetrySource = vi.fn();
  render(
    <MemoryRouter>
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[]}
        onSelectJob={vi.fn()}
        selectedJob={null}
        latestRun={run}
        onRetrySource={onRetrySource}
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();
  // Nothing was found, so it is not "Partial results".
  expect(screen.queryByText(/Partial results/)).toBeNull();
  expect(screen.getByText(/No source could be searched/)).toBeTruthy();
  expect(
    screen.getByTestId("discovery-source-summaries").hasAttribute("open"),
  ).toBe(false);
  fireEvent.click(screen.getByText(/No source could be searched/));
  fireEvent.click(screen.getByRole("button", { name: "Retry A job source" }));
  expect(onRetrySource).toHaveBeenCalledWith("blocked");
});

it.each(["running", "cancelled"] as const)(
  "uses accurate source status for a %s run, with plain errors and singular counts",
  async (state) => {
    const run = DiscoveryRunRecordSchema.parse({
      id: "source-copy",
      state,
      scope: "run_all",
      startedAt: "2026-08-23T10:00:00.000Z",
      targetIds: ["failed", "waiting"],
      targetExecutions: [
        {
          targetId: "failed",
          adapterKind: "auto",
          state: "failed",
          warning:
            "page.goto: Timeout 30000ms exceeded. Call log: \u001b[2m waiting",
          jobsReviewed: 1,
          jobsPersisted: 1,
          duplicatesMerged: 1,
        },
        { targetId: "waiting", adapterKind: "auto", state: "planned" },
      ],
      summary: {
        outcome: state === "cancelled" ? "cancelled" : "running",
        targetsPlanned: 2,
        targetsCompleted: 1,
      },
    });
    render(
      <MemoryRouter>
        <DiscoveryResultsPanelWithJobs
          browserSession={browserSession}
          jobs={[]}
          selectedJob={null}
          onSelectJob={vi.fn()}
          latestRun={run}
          isSearchInProgress={state === "running"}
        />
      </MemoryRouter>,
    );
    await flushFindJobsQueries();
    const summary = screen.getByTestId("discovery-source-summaries");
    expect(summary.hasAttribute("open")).toBe(false);
    fireEvent.click(summary.querySelector("summary")!);
    expect(
      screen.getByText(
        state === "running" ? /1 source failed so far/ : /Search stopped/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "inspected not recorded · 1 saved · rejected not recorded · 1 duplicate · deferred not recorded · pages covered not recorded.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/page.goto/)).toBeNull();
    if (state === "cancelled")
      expect(screen.getByText(/Not searched/)).toBeTruthy();
  },
);

it("searches again from an interrupted run without passing the click along", async () => {
  const run = DiscoveryRunRecordSchema.parse({
    id: "interrupted",
    state: "failed",
    runPhase: "interrupted",
    scope: "run_all",
    startedAt: "2026-08-23T10:00:00.000Z",
    completedAt: "2026-08-23T10:01:00.000Z",
    targetIds: ["board"],
    targetExecutions: [
      { targetId: "board", adapterKind: "auto", state: "failed" },
    ],
    summary: { outcome: "failed", targetsPlanned: 1, targetsCompleted: 0 },
  });
  const onSearchAgain = vi.fn();
  render(
    <MemoryRouter>
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[]}
        onSelectJob={vi.fn()}
        selectedJob={null}
        latestRun={run}
        onSearchAgain={onSearchAgain}
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();

  fireEvent.click(
    screen.getByRole("button", { name: "Search again from here" }),
  );
  // The click event used to arrive as the search request, which the app
  // cannot receive.
  expect(onSearchAgain).toHaveBeenCalledWith();
});

it("names a background plan even while the current plan has no results", async () => {
  render(
    <MemoryRouter>
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[]}
        selectedJob={null}
        onSelectJob={vi.fn()}
        liveStatusLine="Local B is searching in the background, started 2:08 AM."
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();
  expect(
    screen.getByTestId("discovery-results-status-line").textContent,
  ).toContain("Local B is searching in the background");
});
