// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDiscoveryListingDateBadge } from "./discovery-results-panel";
import {
  DiscoveryResultsPanelWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Ready when needed.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
};

function createJob(
  id: string,
  overrides?: Partial<{
    postedAt: string | null;
    postedAtText: string | null;
    providerUpdatedAt: string | null;
    score: number;
    title: string;
  }>,
): SavedJob {
  return SavedJobSchema.parse({
    id,
    source: "target_site",
    sourceJobId: `source-${id}`,
    canonicalUrl: `https://jobs.example.test/${id}`,
    applicationUrl: `https://jobs.example.test/${id}/apply`,
    title: overrides?.title ?? `Engineer ${id}`,
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
      score: overrides?.score ?? 80,
      recommendation: "strong_fit",
      reasons: ["Relevant experience"],
      gaps: [],
    },
    ...(overrides?.postedAt !== undefined
      ? { postedAt: overrides.postedAt }
      : {}),
    ...(overrides?.postedAtText !== undefined
      ? { postedAtText: overrides.postedAtText }
      : {}),
    ...(overrides?.providerUpdatedAt !== undefined
      ? { providerUpdatedAt: overrides.providerUpdatedAt }
      : {}),
  });
}

function visibleRowIds(): string[] {
  return Array.from(document.querySelectorAll("[data-job-result-id]")).flatMap(
    (element) => {
      const id = element.getAttribute("data-job-result-id");
      return id === null ? [] : [id];
    },
  );
}

function sortByRecent() {
  fireEvent.change(screen.getByLabelText("Sort results"), {
    target: { value: "recent" },
  });
}

// Ages are relative to today; a fixed day keeps these dates in one shape.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-12-01T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.localStorage?.clear();
});

describe("DiscoveryResultsPanel relative-label recency truth", () => {
  const relativeFresh = () =>
    createJob("relative-fresh", {
      // Exactly the contradiction scenario: a fresh-looking label with only a
      // hidden provider-update instant behind it.
      postedAt: null,
      postedAtText: "2 days ago",
      providerUpdatedAt: "2026-08-24T09:00:00.000Z",
      score: 95,
      title: "Fresh-looking role",
    });
  const datedOld = () =>
    createJob("dated-old", {
      postedAt: "2026-06-01T10:00:00.000Z",
      postedAtText: null,
      providerUpdatedAt: null,
      score: 60,
      title: "Dated older role",
    });

  it("marks a relative-label row as not date-ranked instead of implying Newest precision", async () => {
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[relativeFresh()]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    // The badge keeps the source's own words; the ranking caveat lives in
    // the tooltip instead of being printed on every such row.
    const badge = screen.getByText("Posted 2 days ago");
    expect(badge.textContent).toBe("Posted 2 days ago");
    const titleOwner = badge.closest("[title]");
    expect(titleOwner?.getAttribute("title")).toContain(
      "Newest cannot rank this listing by its posting date",
    );
  });

  it("never ranks the three-field row above an older dated row under Newest", async () => {
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[relativeFresh(), datedOld()]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    // Best match puts the higher-scoring relative-label row first…
    expect(visibleRowIds()).toEqual(["relative-fresh", "dated-old"]);

    sortByRecent();
    await flushFindJobsQueries();

    // …but Newest must not rank it by the hidden provider-update time.
    expect(visibleRowIds()).toEqual(["dated-old", "relative-fresh"]);

    // The dated row's badge stays plain; only the unrankable one is marked.
    expect(screen.getByText("Posted 01 Jun 2026")).toBeTruthy();
  });

  it("keeps rankable rows unmarked", async () => {
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[
          createJob("dated", {
            postedAt: "2026-06-01T10:00:00.000Z",
            postedAtText: null,
            providerUpdatedAt: null,
          }),
          createJob("absolute-label", {
            postedAt: null,
            postedAtText: "2026-08-20",
            providerUpdatedAt: "2026-08-24T09:00:00.000Z",
          }),
          createJob("provider-only", {
            postedAt: null,
            postedAtText: null,
            providerUpdatedAt: "2026-08-05T09:00:00.000Z",
          }),
        ]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    expect(screen.getByText("Posted 01 Jun 2026").textContent).toBe(
      "Posted 01 Jun 2026",
    );
    expect(screen.getByText("Posted 20 Aug 2026").textContent).toBe(
      "Posted 20 Aug 2026",
    );
    expect(screen.getByText("Updated 05 Aug 2026").textContent).toBe(
      "Updated 05 Aug 2026",
    );
    for (const text of ["Posted 01 Jun 2026", "Updated 05 Aug 2026"]) {
      expect(screen.getByText(text).closest("[title]")).toBeNull();
    }
  });
});

describe("getDiscoveryListingDateBadge", () => {
  it("flags exactly the three-field scenario as shown-but-unrankable", () => {
    expect(
      getDiscoveryListingDateBadge({
        postedAt: null,
        postedAtText: "2 days ago",
        providerUpdatedAt: "2026-08-24T09:00:00.000Z",
      }),
    ).toEqual({
      rankable: false,
      shown: true,
      text: "Posted 2 days ago",
    });
  });

  it("keeps absolute labels and structured dates fully rankable", () => {
    expect(
      getDiscoveryListingDateBadge({
        postedAt: null,
        postedAtText: "2026-08-20",
        providerUpdatedAt: "2026-08-24T09:00:00.000Z",
      }),
    ).toEqual({ rankable: true, shown: true, text: "Posted 20 Aug 2026" });
    expect(
      getDiscoveryListingDateBadge({
        postedAt: "2026-07-01T10:00:00.000Z",
        postedAtText: "2 days ago",
        providerUpdatedAt: "2026-08-24T09:00:00.000Z",
      }).rankable,
    ).toBe(true);
  });

  it("shows the provider update without a marker when no posting label exists", () => {
    expect(
      getDiscoveryListingDateBadge({
        postedAt: null,
        postedAtText: null,
        providerUpdatedAt: "2026-08-05T09:00:00.000Z",
      }),
    ).toEqual({ rankable: true, shown: true, text: "Updated 05 Aug 2026" });
  });

  it("hides entirely without any date evidence", () => {
    expect(
      getDiscoveryListingDateBadge({
        postedAt: null,
        postedAtText: null,
        providerUpdatedAt: null,
      }),
    ).toEqual({ rankable: false, shown: false, text: "" });
  });
});

it("says the posting date as plain text on the meta line, not as a badge", async () => {
  render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      jobs={[createJob("one", { postedAtText: "2 days ago" })]}
      onSelectJob={vi.fn()}
      selectedJob={null}
    />,
  );
  await flushFindJobsQueries();
  const date = screen.getByText("Posted 2 days ago");
  expect(date.closest('[data-slot="badge"]')).toBeNull();
  expect(date.getAttribute("data-testid")).toBe("discovery-result-date-one");
});
