// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  QueryJobListResult,
  WorkspaceJobListRow,
  WorkspaceStartupContext,
} from "@nestor/contracts";
import { FindJobsLaunch, selectFindJobsLaunchPage } from "./find-jobs-launch";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function row(
  id: string,
  overrides: Partial<WorkspaceJobListRow> = {},
): WorkspaceJobListRow {
  return {
    id,
    status: "discovered",
    title: `Backend Engineer ${id}`,
    company: "Acme",
    location: "Remote",
    source: "target_site",
    sourceJobId: id,
    canonicalUrl: `https://jobs.example.test/${id}`,
    applicationUrl: null,
    workMode: [],
    postedAt: null,
    postedAtText: null,
    discoveredAt: "2026-10-20T10:00:00.000Z",
    firstSeenAt: "2026-10-20T10:00:00.000Z",
    lastSeenAt: "2026-10-20T10:00:00.000Z",
    salaryText: null,
    detailQuality: "full",
    resumeApplicationMode: null,
    resumeTailoringMode: null,
    planId: "plan_1",
    score: 72,
    recommendation: "review_before_applying",
    judged: true,
    scoreIsUpperBound: false,
    titleFamilyMatch: "same_family",
    locationReach: "in_area",
    listingClosed: false,
    resultGroup: "matches",
    ...overrides,
  } as WorkspaceJobListRow;
}

function page(rows: WorkspaceJobListRow[]): QueryJobListResult {
  return {
    rows,
    total: rows.length,
    counts: {
      discovery: rows.length,
      dismissed: 0,
      shortlisted: 0,
      applications: 0,
      companies: 0,
      all: rows.length,
    },
    revision: 1,
    resumeDrafts: [],
    applications: [],
    applyResults: [],
    facets: {
      recommendations: [],
      sources: [],
      workModes: [],
      activities: [],
      locationReach: [],
      assessed: 0,
      newSince: null,
    },
  };
}

const context = {
  activeCampaignId: "plan_1",
  campaigns: [{ id: "plan_1", mode: "precision" }],
  settings: {},
} as unknown as WorkspaceStartupContext;

describe("Find jobs while the workspace loads", () => {
  it("uses the focused or wide first page the screen will open on", () => {
    const focused = page([row("a")]);
    const wide = page([row("b")]);
    expect(
      selectFindJobsLaunchPage({ context, findJobs: { focused, wide } }),
    ).toBe(focused);
    const scale = {
      ...context,
      campaigns: [{ id: "plan_1", mode: "scale" }],
    } as unknown as WorkspaceStartupContext;
    expect(
      selectFindJobsLaunchPage({ context: scale, findJobs: { focused, wide } }),
    ).toBe(wide);
  });

  it("stays on the loading state when it cannot be the same page", () => {
    const findJobs = (rows: WorkspaceJobListRow[]) => ({
      focused: page(rows),
      wide: page(rows),
    });
    // A band heading or a withheld score would differ from the loaded list.
    expect(
      selectFindJobsLaunchPage({
        context,
        findJobs: findJobs([row("a"), row("b", { resultGroup: "unchecked" })]),
      }),
    ).toBeNull();
    expect(
      selectFindJobsLaunchPage({
        context,
        findJobs: findJobs([row("a", { judged: false })]),
      }),
    ).toBeNull();
    // Another sort, saved search text or saved filters.
    localStorage.setItem(
      "nestor.job-finder.discovery.results-sort.v1",
      JSON.stringify({ field: "recent", direction: "desc" }),
    );
    expect(
      selectFindJobsLaunchPage({ context, findJobs: findJobs([row("a")]) }),
    ).toBeNull();
    localStorage.clear();
    localStorage.setItem(
      "nestor.job-finder.collection.discovery-results.v1",
      JSON.stringify({ density: "comfortable", query: "rust", savedViews: [] }),
    );
    expect(
      selectFindJobsLaunchPage({ context, findJobs: findJobs([row("a")]) }),
    ).toBeNull();
    localStorage.clear();
    localStorage.setItem(
      "nestor.job-finder.discovery.result-filters.v2",
      JSON.stringify({
        scopes: [
          {
            id: "plan_1",
            activity: [],
            recommendation: [],
            source: ["Acme careers"],
            workMode: [],
          },
        ],
      }),
    );
    expect(
      selectFindJobsLaunchPage({ context, findJobs: findJobs([row("a")]) }),
    ).toBeNull();
  });

  it("shows each row's title, employer and fit with the first one open", () => {
    render(
      <FindJobsLaunch
        page={page([
          row("a"),
          row("b", { score: 64, scoreIsUpperBound: true }),
        ])}
      />,
    );
    const list = within(
      screen.getByRole("region", { name: "Job results list" }),
    );
    const items = list.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("Backend Engineer a");
    expect(items[0]!.textContent).toContain("72% fit");
    expect(items[0]!.textContent).toContain("Acme");
    expect(items[1]!.textContent).toContain("Up to 64% fit");
    expect(
      screen.getByRole("heading", { level: 2, name: "Backend Engineer a" }),
    ).toBeTruthy();
  });
});
