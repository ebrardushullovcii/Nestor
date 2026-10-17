import { round3SearchRun } from "../../lib/discovery-round3.test-fixture";
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiscoveryResultsPanel,
  getDiscoveryProgressCountLabel,
} from "./discovery-results-panel";

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Ready when needed.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
};

const COLLECTION_VIEW_STORAGE_KEY =
  "nestor.job-finder.collection.discovery-results.v1";

function createJob(id: string, title: string): SavedJob {
  return SavedJobSchema.parse({
    id,
    source: "target_site",
    sourceJobId: `source-${id}`,
    canonicalUrl: `https://jobs.example.test/${id}`,
    applicationUrl: `https://jobs.example.test/${id}/apply`,
    title,
    company: `Company ${id}`,
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-08-23T10:00:00.000Z",
    salaryText: null,
    description: `Role ${id}`,
    status: "discovered",
    provenance: [],
    matchAssessment: {
      score: 90,
      recommendation: "strong_fit",
      reasons: ["Relevant experience"],
      gaps: [],
    },
  });
}

function renderStreamingResults(jobs: readonly SavedJob[]) {
  return render(
    <DiscoveryResultsPanel
      browserSession={browserSession}
      isSearchInProgress
      jobs={jobs}
      onSelectJob={vi.fn()}
      selectedJob={jobs[0] ?? null}
    />,
  );
}

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

describe("DiscoveryResultsPanel streaming progress count", () => {
  it("shows distinct source references for otherwise identical rows", () => {
    renderStreamingResults([
      {
        ...createJob("324107", "People Operations Manager"),
        company: "Bonial",
      },
      {
        ...createJob("487864", "People Operations Manager"),
        company: "Bonial",
      },
    ]);
    expect(screen.getByText(/Reference source-324107/)).toBeTruthy();
    expect(screen.getByText(/Reference source-487864/)).toBeTruthy();
  });

  it("reports the raw total only when nothing filters the list", () => {
    renderStreamingResults([
      createJob("alpha", "Engineer alpha"),
      createJob("beta", "Designer beta"),
    ]);

    expect(
      screen.getByTestId("discovery-results-status-line").textContent,
    ).toContain("2 results shown.");
  });

  it("singularizes a single streaming match", () => {
    renderStreamingResults([createJob("alpha", "Engineer alpha")]);

    expect(
      screen.getByTestId("discovery-results-status-line").textContent,
    ).toContain("1 result shown.");
  });

  it("reports the visible subset when a persisted query hides results", () => {
    window.localStorage.setItem(
      COLLECTION_VIEW_STORAGE_KEY,
      JSON.stringify({
        density: "comfortable",
        query: "designer",
        savedViews: [],
      }),
    );
    renderStreamingResults([
      createJob("alpha", "Engineer alpha"),
      createJob("beta", "Designer beta"),
    ]);

    // The persisted query survives remounts, so the callout must never claim
    // the raw total while the visible list is narrower.
    expect(
      screen.getByTestId("discovery-results-status-line").textContent,
    ).toContain("1 result shown.");
    expect(screen.getByText("Designer beta")).toBeTruthy();
    expect(screen.queryByText("Engineer alpha")).toBeNull();
  });

  it("returns to the raw total after the query is cleared mid-run", () => {
    window.localStorage.setItem(
      COLLECTION_VIEW_STORAGE_KEY,
      JSON.stringify({
        density: "comfortable",
        query: "designer",
        savedViews: [],
      }),
    );
    renderStreamingResults([
      createJob("alpha", "Engineer alpha"),
      createJob("beta", "Designer beta"),
    ]);
    expect(
      screen.getByTestId("discovery-results-status-line").textContent,
    ).toContain("1 result shown.");

    fireEvent.change(screen.getByLabelText("Find a job"), {
      target: { value: "" },
    });

    expect(
      screen.getByTestId("discovery-results-status-line").textContent,
    ).toContain("2 results shown.");
    expect(screen.getByText("Engineer alpha")).toBeTruthy();
  });
});

describe("getDiscoveryProgressCountLabel", () => {
  it("keeps identical totals phrased as the full result set", () => {
    expect(getDiscoveryProgressCountLabel(0, 0)).toBe("0 listings found.");
    expect(getDiscoveryProgressCountLabel(1, 1)).toBe("1 listing found.");
    expect(getDiscoveryProgressCountLabel(7, 7)).toBe("7 listings found.");
  });

  it("phrases filtered subsets as visible-of-total", () => {
    expect(getDiscoveryProgressCountLabel(0, 2)).toBe("0 of 2 listings shown.");
    expect(getDiscoveryProgressCountLabel(1, 2)).toBe("1 of 2 listings shown.");
    expect(getDiscoveryProgressCountLabel(3, 4)).toBe("3 of 4 listings shown.");
  });
});

it("reads the same report for the live line and source summary regardless of displayed inventory", () => {
  const run = round3SearchRun();
  render(
    <DiscoveryResultsPanel
      browserSession={browserSession}
      isSearchInProgress
      jobs={[createJob("one", "Designer")]}
      latestRun={{ ...run, state: "running" }}
      onSelectJob={vi.fn()}
      selectedJob={null}
    />,
  );
  expect(
    screen.getByTestId("discovery-results-status-line").textContent,
  ).toContain("25 new to you · 22 kept by this plan · 27 duplicates merged");
  fireEvent.click(
    screen.getByTestId("discovery-source-summaries").querySelector("summary")!,
  );
  expect(
    screen.getByTestId("discovery-source-summaries").textContent,
  ).toContain(
    "52 inspected · 25 saved · 0 rejected · 27 duplicates · 0 deferred · 7 pages covered",
  );
  expect(screen.queryByText(/28 listings recorded/)).toBeNull();
});
