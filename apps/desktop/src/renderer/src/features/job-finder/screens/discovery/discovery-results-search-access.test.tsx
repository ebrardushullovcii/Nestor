// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SavedJob } from "@nestor/contracts";

import {
  DISCOVERY_DETAIL_HEADING_ID,
  DISCOVERY_DETAIL_REGION_ID,
  DISCOVERY_STACKED_LAYOUT_MEDIA_QUERY,
} from "./discovery-accessibility";
import {
  DiscoveryResultsPanelWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-07-31T10:00:00.000Z",
};

const resultJob = {
  id: "job_search_again",
  title: "Senior Product Designer",
  company: "Acme",
  location: "Remote",
  matchAssessment: {
    score: 88,
    recommendation: "strong_fit",
    reasons: ["Strong role and skill match."],
    gaps: [],
  },
  status: "discovered",
  applyPath: "external_redirect",
  salaryText: null,
  workMode: ["remote"],
  postedAt: "2026-07-31T00:00:00.000Z",
  postedAtText: null,
} as unknown as SavedJob;

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
  Reflect.deleteProperty(window, "matchMedia");
  vi.clearAllMocks();
});

async function renderResultsWithDetailRegion(input: {
  onSelectJob: (jobId: string) => void;
}) {
  const rendered = render(
    <>
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={[resultJob]}
        onSelectJob={input.onSelectJob}
        selectedJob={resultJob}
      />
      <section aria-label="Job details" id={DISCOVERY_DETAIL_REGION_ID}>
        <h2 id={DISCOVERY_DETAIL_HEADING_ID} tabIndex={-1}>
          Senior Product Designer
        </h2>
      </section>
    </>,
  );
  await flushFindJobsQueries();
  return rendered;
}

function getDetailRegion(): HTMLElement {
  const detailRegion = document.getElementById(DISCOVERY_DETAIL_REGION_ID);
  if (!detailRegion) {
    throw new Error("Expected discovery detail region.");
  }
  return detailRegion;
}

describe("DiscoveryResultsPanel narrow search access", () => {
  it("keeps the also-found control inside the aligned results panel", async () => {
    const onToggleAlsoFound = vi.fn();

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hiddenAlsoFoundCount={6}
        jobs={[resultJob]}
        alsoFoundCount={6}
        onSelectJob={vi.fn()}
        onToggleAlsoFound={onToggleAlsoFound}
        selectedJob={resultJob}
      />,
    );
    await flushFindJobsQueries();

    const resultsPanel = screen.getByRole("region", { name: "Results" });
    expect(within(resultsPanel).getByText("1 job")).toBeTruthy();
    fireEvent.click(
      within(resultsPanel).getByRole("button", {
        name: /Show weaker matches/u,
      }),
    );
    await flushFindJobsQueries();
    expect(onToggleAlsoFound).toHaveBeenCalledOnce();
  });

  it("leaves the route-level search action to the page header", async () => {
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={[resultJob]}
        onSelectJob={vi.fn()}
        selectedJob={resultJob}
      />,
    );
    await flushFindJobsQueries();

    expect(screen.queryByRole("button", { name: "Search again" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Search now" })).toBeNull();
  });

  it("hands keyboard result activation directly to the related job detail without moving mouse focus", async () => {
    const onSelectJob = vi.fn();

    render(
      <>
        <DiscoveryResultsPanelWithJobs
          browserSession={browserSession}
          hasCompletedSearch
          jobs={[resultJob]}
          onSelectJob={onSelectJob}
          selectedJob={resultJob}
        />
        <section aria-label="Job details" id={DISCOVERY_DETAIL_REGION_ID}>
          <h2 id={DISCOVERY_DETAIL_HEADING_ID} tabIndex={-1}>
            Senior Product Designer
          </h2>
        </section>
      </>,
    );
    await flushFindJobsQueries();

    expect(screen.getByRole("region", { name: "Results" })).toBeTruthy();
    const resultButton = screen.getByRole("button", {
      name: /Senior Product Designer/i,
    });
    const detailHeading = screen.getByRole("heading", {
      name: "Senior Product Designer",
    });

    expect(resultButton.getAttribute("aria-controls")).toBe(
      DISCOVERY_DETAIL_REGION_ID,
    );
    resultButton.focus();
    fireEvent.click(resultButton, { detail: 1 });
    await flushFindJobsQueries();
    expect(document.activeElement).toBe(resultButton);

    fireEvent.click(resultButton, { detail: 0 });
    await flushFindJobsQueries();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(detailHeading);
    });
    expect(onSelectJob).toHaveBeenCalledTimes(2);
  });

  it("claims keyboard detail focus with preventScroll and reveals instantly inside the stacked layout", async () => {
    const onSelectJob = vi.fn();
    const matchMediaMock = vi.fn(() => ({ matches: true }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMediaMock,
    });

    await renderResultsWithDetailRegion({ onSelectJob });

    const detailHeading = screen.getByRole("heading", {
      name: "Senior Product Designer",
    });
    const detailRegion = getDetailRegion();
    const headingFocusSpy = vi.spyOn(detailHeading, "focus");
    const regionScrollIntoViewMock = vi.fn();
    detailRegion.scrollIntoView = regionScrollIntoViewMock;

    const resultButton = screen.getByRole("button", {
      name: /Senior Product Designer/i,
    });
    resultButton.focus();
    fireEvent.click(resultButton, { detail: 0 });
    await flushFindJobsQueries();

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(detailHeading);
    });
    // Controlled claim: the browser must not perform its own ancestor jumps.
    expect(headingFocusSpy).toHaveBeenCalledWith({ preventScroll: true });
    // Stacked reveal stays instant for reduced motion: no smooth behavior is
    // ever requested anywhere on this path.
    expect(regionScrollIntoViewMock).not.toHaveBeenCalled();
    expect(matchMediaMock).toHaveBeenCalledWith(
      DISCOVERY_STACKED_LAYOUT_MEDIA_QUERY,
    );
  });

  it("reveals the job detail region after pointer activation below the two-pane breakpoint without moving focus", async () => {
    const onSelectJob = vi.fn();
    const matchMediaMock = vi.fn(() => ({ matches: true }));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: matchMediaMock,
    });

    await renderResultsWithDetailRegion({ onSelectJob });

    const scrollIntoViewMock = vi.fn();
    getDetailRegion().scrollIntoView = scrollIntoViewMock;
    const resultButton = screen.getByRole("button", {
      name: /Senior Product Designer/i,
    });
    resultButton.focus();

    fireEvent.click(resultButton, { detail: 1 });
    await flushFindJobsQueries();

    await vi.waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "start" });
    });
    expect(matchMediaMock).toHaveBeenCalledWith(
      DISCOVERY_STACKED_LAYOUT_MEDIA_QUERY,
    );
    expect(document.activeElement).toBe(resultButton);
    expect(onSelectJob).toHaveBeenCalledWith("job_search_again");
  });

  it("keeps pointer activation from scrolling at the wide two-pane breakpoint", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });

    await renderResultsWithDetailRegion({ onSelectJob: vi.fn() });

    const scrollIntoViewMock = vi.fn();
    getDetailRegion().scrollIntoView = scrollIntoViewMock;
    const resultButton = screen.getByRole("button", {
      name: /Senior Product Designer/i,
    });
    resultButton.focus();

    fireEvent.click(resultButton, { detail: 1 });
    await flushFindJobsQueries();
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(resultButton);
  });

  it("searches the current result pool without changing the selected job", async () => {
    const secondJob = {
      ...resultJob,
      id: "job_backend",
      title: "Backend Engineer",
      company: "Northstar",
    } as SavedJob;

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={[resultJob, secondJob]}
        onSelectJob={vi.fn()}
        selectedJob={resultJob}
      />,
    );
    await flushFindJobsQueries();

    fireEvent.change(screen.getByRole("searchbox", { name: "Find a job" }), {
      target: { value: "Northstar" },
    });
    await flushFindJobsQueries();

    expect(screen.getByText("1 of 2 jobs")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Backend Engineer/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Senior Product Designer/i }),
    ).toBeNull();
  });

  it("offers no list-management chrome beside the two controls that matter", async () => {
    const secondJob = {
      ...resultJob,
      id: "job_backend_compare",
      title: "Backend Engineer",
      company: "Northstar",
      matchAssessment: {
        ...resultJob.matchAssessment,
        score: 81,
      },
    } as SavedJob;

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={[resultJob, secondJob]}
        onSelectJob={vi.fn()}
        selectedJob={resultJob}
      />,
    );
    await flushFindJobsQueries();

    // Compare and Saved views were list-management chrome for a workspace
    // holding a handful of rows; both are deleted rather than restyled.
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Top job comparison" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /Saved views/u })).toBeNull();
  });
});

it("offers hidden weaker matches that fit the text instead of saying they were found elsewhere", async () => {
  const onToggleAlsoFound = vi.fn();
  render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      jobs={[resultJob]}
      hiddenAlsoFoundJobs={[
        { ...resultJob, id: "weaker", title: "Backend Engineer" },
      ]}
      alsoFoundCount={1}
      hiddenAlsoFoundCount={1}
      onToggleAlsoFound={onToggleAlsoFound}
      onSelectJob={vi.fn()}
      selectedJob={null}
    />,
  );
  await flushFindJobsQueries();
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a job" }), {
    target: { value: "Backend" },
  });
  await flushFindJobsQueries();
  expect(
    screen.getByText("1 hidden weaker match fits this text."),
  ).toBeTruthy();
  expect(document.body.textContent).not.toContain("found elsewhere");
  fireEvent.click(screen.getByRole("button", { name: "Show weaker matches" }));
  expect(onToggleAlsoFound).toHaveBeenCalledOnce();
});
