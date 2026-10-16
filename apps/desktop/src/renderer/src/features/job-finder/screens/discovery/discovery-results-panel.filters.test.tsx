// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  JobDiscoveryTargetSchema,
  SavedJobSchema,
  type FitRecommendation,
  type JobDiscoveryTarget,
  type ListingActivity,
  type SavedJob,
  type JobListRow,
  type WorkMode,
} from "@nordri/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscoveryResultsPanel } from "./discovery-results-panel";

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
};

const primarySource = JobDiscoveryTargetSchema.parse({
  id: "primary-source",
  label: "Primary board",
  startingUrl: "https://primary.example.test/jobs",
});
const longSource = JobDiscoveryTargetSchema.parse({
  id: "long-source",
  label: "An exceptionally long configured source label for specialist roles",
  startingUrl: "https://specialist.example.test/jobs",
});

function createJob(
  id: string,
  recommendation: FitRecommendation,
  workMode: readonly WorkMode[],
  source: JobDiscoveryTarget | null,
  listingActivity: ListingActivity = { status: "unknown" },
): SavedJob & { listingActivity: ListingActivity } {
  return {
    ...SavedJobSchema.parse({
      id,
      source: "target_site",
      sourceJobId: `source-${id}`,
      canonicalUrl: `https://jobs.example.test/${id}`,
      applicationUrl: `https://jobs.example.test/${id}/apply`,
      title: `Engineer ${id}`,
      company: `Company ${id}`,
      location: workMode.includes("remote") ? "Remote" : "Berlin",
      workMode,
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: "2026-08-23T10:00:00.000Z",
      salaryText: null,
      description: `Role ${id}`,
      status: "discovered",
      provenance: source
        ? [
            {
              targetId: source.id,
              adapterKind: "auto",
              startingUrl: source.startingUrl,
              discoveredAt: "2026-08-23T10:00:00.000Z",
              collectionMethod: "careers_page",
            },
          ]
        : [],
      matchAssessment: {
        score: recommendation === "strong_fit" ? 90 : 65,
        recommendation,
        reasons: ["Relevant experience"],
        gaps: [],
      },
    }),
    listingActivity,
  };
}

function renderResults(
  jobs: readonly JobListRow[],
  options?: {
    facetScopeId?: string | null;
    onDisplayedSelectedJobIdChange?: (jobId: string | null) => void;
    selectedJob?: SavedJob | null;
  },
) {
  return render(
    <DiscoveryResultsPanel
      browserSession={browserSession}
      discoveryTargets={[primarySource, longSource]}
      facetScopeId={options?.facetScopeId ?? null}
      hasCompletedSearch
      jobs={jobs}
      {...(options?.onDisplayedSelectedJobIdChange
        ? {
            onDisplayedSelectedJobIdChange:
              options.onDisplayedSelectedJobIdChange,
          }
        : {})}
      onSelectJob={vi.fn()}
      selectedJob={options?.selectedJob ?? null}
    />,
  );
}

function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
}

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

describe("DiscoveryResultsPanel triage filters", () => {
  it("shows a one-view note when listing evidence changes the score", () => {
    const base = createJob("rescored", "strong_fit", ["remote"], primarySource);
    const rescored: SavedJob = {
      ...base,
      latestMatchAssessmentAudit: {
        version: 1,
        recordedAt: "2026-08-23T10:05:00.000Z",
        status: "assessment_changed",
        causeConfidence: "known",
        rankingSignalChanged: true,
        summary: "The captured listing changed the fit score.",
        reasons: ["More listing evidence became available."],
        previousMetadata: {
          scorerVersion: 4,
          contextFingerprint: "match_context_candidate",
          postingFingerprint: "match_posting_title_only",
        },
        currentMetadata: {
          scorerVersion: 4,
          contextFingerprint: "match_context_candidate",
          postingFingerprint: "match_posting_captured",
        },
        inputChanges: [
          {
            code: "listing_evidence_changed",
            scope: "listing_evidence",
            certainty: "known",
            title: "Listing evidence changed",
            detail: "The full listing was captured.",
            previousValue: "match_posting_title_only",
            currentValue: "match_posting_captured",
          },
        ],
        previousRank: 2,
        currentRank: 1,
        outputChanges: [
          {
            code: "score_changed",
            subject: "score",
            title: "Fit score changed",
            detail: "The fit score changed after the listing was read.",
            previousValue: "71",
            currentValue: "84",
          },
        ],
      },
    };
    const { container } = renderResults([
      { ...rescored, rescoredAfterListingRead: true },
    ]);

    expect(screen.getByText("Rescored after reading the listing")).toBeTruthy();
    const row = container.querySelector<HTMLButtonElement>(
      'button[data-job-result-id="rescored"]',
    );
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLButtonElement);
    expect(screen.queryByText("Rescored after reading the listing")).toBeNull();
  });

  it("shortlists selected rows and every shown row with keyboard-operable controls", () => {
    const jobs = [
      createJob("one", "strong_fit", ["remote"], primarySource),
      createJob("two", "review_before_applying", ["hybrid"], longSource),
    ];
    const onShortlistJobs = vi.fn();
    const { unmount } = render(
      <DiscoveryResultsPanel
        browserSession={browserSession}
        discoveryTargets={[primarySource, longSource]}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        onShortlistJobs={onShortlistJobs}
        selectedJob={null}
      />,
    );

    const first = screen.getByRole("checkbox", { name: "Select Engineer one" });
    first.focus();
    fireEvent.keyDown(first, { key: " " });
    fireEvent.click(first);
    fireEvent.click(
      screen.getByRole("button", { name: /^Shortlist \d+ selected$/u }),
    );
    expect(onShortlistJobs).toHaveBeenCalledWith(["one"]);

    unmount();
    onShortlistJobs.mockClear();
    render(
      <DiscoveryResultsPanel
        browserSession={browserSession}
        discoveryTargets={[primarySource, longSource]}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        onShortlistJobs={onShortlistJobs}
        selectedJob={null}
      />,
    );
    // Bulk actions appear only while a row is ticked, in place of the
    // toolbar, so ticking a row never moves the list.
    expect(
      screen.queryByRole("group", { name: "Bulk shortlist actions" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Engineer two" }),
    );
    const bar = screen.getByRole("group", { name: "Bulk shortlist actions" });
    expect(bar.textContent).toContain("1 selected");
    expect(screen.queryByRole("searchbox")).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select the 2 jobs on this page" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Shortlist 2 selected" }),
    );
    expect(onShortlistJobs).toHaveBeenCalledWith(["one", "two"]);
  });

  it("hides every matching job as not interested, across pages, in one request", async () => {
    const jobs = [
      createJob("one", "strong_fit", ["remote"], primarySource),
      createJob("two", "review_before_applying", ["hybrid"], longSource),
    ];
    const onDismissJobs = vi.fn(() => Promise.resolve());
    render(
      <DiscoveryResultsPanel
        browserSession={browserSession}
        discoveryTargets={[primarySource, longSource]}
        hasCompletedSearch
        jobs={jobs}
        onDismissJobs={onDismissJobs}
        onSelectJob={vi.fn()}
        onShortlistJobs={vi.fn()}
        selectedJob={null}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Engineer one" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Select all 2" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Mark 2 selected as not interested",
      }),
    );
    await vi.waitFor(() =>
      expect(onDismissJobs).toHaveBeenCalledExactlyOnceWith(["one", "two"]),
    );
  });

  it("clears the selection and brings the search toolbar back", () => {
    render(
      <DiscoveryResultsPanel
        browserSession={browserSession}
        discoveryTargets={[primarySource, longSource]}
        hasCompletedSearch
        jobs={[createJob("one", "strong_fit", ["remote"], primarySource)]}
        onSelectJob={vi.fn()}
        onShortlistJobs={vi.fn()}
        selectedJob={null}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Engineer one" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(
      screen.queryByRole("group", { name: "Bulk shortlist actions" }),
    ).toBeNull();
    expect(screen.getByRole("searchbox")).toBeTruthy();
  });

  it("combines categories with AND and selections within a category with OR", () => {
    const jobs = [
      createJob("strong-remote", "strong_fit", ["remote"], primarySource),
      createJob(
        "review-remote",
        "review_before_applying",
        ["remote"],
        primarySource,
      ),
      createJob("strong-hybrid", "strong_fit", ["hybrid"], longSource),
    ];
    const { container } = renderResults(jobs);
    openFilters();

    fireEvent.click(screen.getByRole("checkbox", { name: "Strong fit" }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Review before applying" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Primary board" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Remote" }));

    expect(screen.getByLabelText("4 active filters")).toBeTruthy();
    expect(screen.getByText("2 of 3 jobs")).toBeTruthy();
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "button[data-job-result-id]",
        ),
        (button) => button.dataset.jobResultId,
      ),
    ).toEqual(["review-remote", "strong-remote"]);
  });

  it("shows a truthful no-results state and clears every filter", () => {
    const jobs = [
      createJob("remote", "strong_fit", ["remote"], primarySource),
      createJob("hybrid", "review_before_applying", ["hybrid"], longSource),
    ];
    const { container } = renderResults(jobs);
    openFilters();

    fireEvent.click(screen.getByRole("checkbox", { name: "Primary board" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hybrid" }));

    expect(screen.getByText("0 of 2 jobs")).toBeTruthy();
    expect(screen.getByText("No jobs match these filters")).toBeTruthy();
    expect(
      container.querySelectorAll("button[data-job-result-id]"),
    ).toHaveLength(0);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear filters" })[0]!,
    );

    expect(screen.queryByText("No jobs match these filters")).toBeNull();
    expect(
      container.querySelectorAll("button[data-job-result-id]"),
    ).toHaveLength(2);
    expect(screen.queryByLabelText(/active filters?/u)).toBeNull();
  });

  it("keeps long source labels complete and filterable", () => {
    const job = createJob("specialist", "strong_fit", ["remote"], longSource);
    // A second source, or the facet has nothing to narrow and is not offered.
    renderResults([
      job,
      createJob("generalist", "strong_fit", ["remote"], primarySource),
    ]);
    openFilters();

    const sourceCheckbox = screen.getByRole("checkbox", {
      name: longSource.label,
    });
    const sourceLabel = sourceCheckbox.closest("label");

    expect(sourceLabel?.getAttribute("title")).toBe(longSource.label);
    expect(sourceLabel?.querySelector("span")?.className).toContain(
      "break-words",
    );
    fireEvent.click(sourceCheckbox);
    expect(screen.getByText("1 of 2 jobs")).toBeTruthy();
  });

  it("opens filters outside the toolbar and searches long source lists without clearing selections", () => {
    const { container } = renderResults([
      createJob("specialist", "strong_fit", ["remote"], longSource),
      createJob("generalist", "strong_fit", ["remote"], primarySource),
    ]);
    const trigger = screen.getByRole("button", { name: /^Filters/ });
    openFilters();
    const popup = screen.getByRole("dialog", { name: "Filter jobs" });
    expect(container.contains(popup)).toBe(false);
    expect(
      screen
        .getByTestId("discovery-results-filter-groups")
        .querySelectorAll("fieldset"),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "Primary board" }));
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search sources" }),
      { target: { value: "specialist" } },
    );
    expect(
      screen.queryByRole("checkbox", { name: "Primary board" }),
    ).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: longSource.label }),
    ).toBeTruthy();
    expect(screen.getByText("1 of 2 jobs")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filter jobs" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByText("1 of 2 jobs")).toBeTruthy();
  });
  it("resets pagination and retains a selected job that matches the filter", () => {
    const jobs = Array.from({ length: 55 }, (_, index) =>
      createJob(
        `page-${index.toString().padStart(2, "0")}`,
        "strong_fit",
        index === 54 ? ["hybrid"] : ["remote"],
        index === 54 ? longSource : primarySource,
      ),
    );
    const onDisplayedSelectedJobIdChange = vi.fn();
    const selectedJob = jobs[54]!;
    const { container } = renderResults(jobs, {
      onDisplayedSelectedJobIdChange,
      selectedJob,
    });

    expect(screen.getByText("51–55 of 55")).toBeTruthy();
    openFilters();
    onDisplayedSelectedJobIdChange.mockClear();
    fireEvent.click(screen.getByRole("checkbox", { name: longSource.label }));

    expect(
      screen.queryByRole("navigation", { name: "Job result pages" }),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-job-result-id="page-54"]')
        ?.getAttribute("aria-current"),
    ).toBe("true");
    expect(onDisplayedSelectedJobIdChange).not.toHaveBeenCalledWith(null);
  });

  it("filters all five activity states and combines activity with other categories", () => {
    const activities: readonly ListingActivity[] = [
      {
        status: "active",
        observedAt: "2026-08-23T10:00:00.000Z",
        evidence: "last_seen_at",
      },
      {
        status: "inactive",
        observedAt: "2026-08-22T10:00:00.000Z",
        ledgerEntryId: "ledger_1",
        provenance: "discovery_ledger",
        explanation: "Missing from the complete refresh.",
      },
      {
        status: "stale",
        observedAt: "2026-08-21T10:00:00.000Z",
        signalId: "signal_stale",
        provenance: "browser",
        explanation: "An expiry notice was visible.",
        detail: null,
        confidence: 0.8,
      },
      {
        status: "closed",
        observedAt: "2026-08-20T10:00:00.000Z",
        signalId: "signal_closed",
        provenance: "provider",
        explanation: "The provider marked it closed.",
        detail: null,
        confidence: 1,
      },
      { status: "unknown" },
    ];
    const jobs = activities.map((activity) =>
      createJob(
        activity.status,
        activity.status === "closed" ? "review_before_applying" : "strong_fit",
        ["remote"],
        primarySource,
        activity,
      ),
    );
    const { container } = renderResults(jobs);
    expect(
      screen.getByLabelText(
        /Closed listing status observed .*Reported closed by the job site's own listing feed on .*The provider marked it closed\./i,
      ),
    ).toBeTruthy();
    openFilters();

    for (const label of ["Active", "Inactive", "Stale", "Closed", "Unknown"]) {
      expect(screen.getByRole("checkbox", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("checkbox", { name: "Inactive" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Stale" }));
    expect(screen.getByText("2 of 5 jobs")).toBeTruthy();
    expect(
      Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          "button[data-job-result-id]",
        ),
        (button) => button.dataset.jobResultId,
      ),
    ).toEqual(["inactive", "stale"]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Strong fit" }));
    expect(screen.getByLabelText("3 active filters")).toBeTruthy();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear filters" })[0]!,
    );
    expect(
      container.querySelectorAll("button[data-job-result-id]"),
    ).toHaveLength(5);
  });
});

const FACET_FILTERS_STORAGE_KEY =
  "nordri.job-finder.discovery.result-filters.v2";
const LEGACY_FACET_FILTERS_STORAGE_KEY =
  "nordri.job-finder.discovery.result-filters.v1";

function readFacetScopesById(): Record<string, Record<string, unknown>> {
  const raw = window.localStorage.getItem(FACET_FILTERS_STORAGE_KEY);
  expect(raw).toBeTruthy();
  const parsed = JSON.parse(raw!) as {
    version: number;
    scopes: ReadonlyArray<Record<string, unknown>>;
  };
  expect(parsed.version).toBe(2);
  return Object.fromEntries(
    parsed.scopes.map((scope) => [scope.id as string, scope]),
  );
}

describe("DiscoveryResultsPanel facet target size", () => {
  it("gives every facet checkbox a >=24px square hit area inside spaced rows", () => {
    renderResults([
      createJob("strong-remote", "strong_fit", ["remote"], primarySource),
      createJob(
        "review-hybrid",
        "review_before_applying",
        ["hybrid"],
        longSource,
      ),
    ]);
    openFilters();

    // Every row shares one listing status, so that facet is not offered.
    const fieldsets = screen
      .getByTestId("discovery-results-filter-groups")
      .querySelectorAll("fieldset");
    expect(fieldsets).toHaveLength(3);

    let checkboxCount = 0;
    for (const fieldset of fieldsets) {
      const rows = fieldset.querySelector(".grid");
      // Row spacing keeps the enlarged targets visually separated.
      expect(rows?.className).toContain("gap-1");
      for (const input of fieldset.querySelectorAll('input[type="checkbox"]')) {
        checkboxCount += 1;
        // WCAG 2.5.8: every pointer target is at least 24x24 CSS pixels.
        expect(input.closest("label")?.className).toContain("min-h-8");
      }
    }
    expect(checkboxCount).toBe(6);
  });
});

describe("DiscoveryResultsPanel facet persistence", () => {
  const persistenceJobs = [
    createJob("strong-remote", "strong_fit", ["remote"], primarySource),
    createJob(
      "review-hybrid",
      "review_before_applying",
      ["hybrid"],
      longSource,
    ),
  ];

  function planPanelElement(facetScopeId: string) {
    return (
      <DiscoveryResultsPanel
        browserSession={browserSession}
        discoveryTargets={[primarySource, longSource]}
        facetScopeId={facetScopeId}
        hasCompletedSearch
        jobs={persistenceJobs}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />
    );
  }

  function renderPlanPanel(facetScopeId: string) {
    return render(planPanelElement(facetScopeId));
  }

  it("restores facet selections per plan across remount and clears them truthfully", () => {
    renderResults(persistenceJobs, { facetScopeId: "plan-a" });
    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Strong fit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Remote" }));
    expect(screen.getByText("1 of 2 jobs")).toBeTruthy();

    expect(readFacetScopesById()["plan-a"]).toEqual({
      id: "plan-a",
      activity: [],
      recommendation: ["strong_fit"],
      source: [],
      workMode: ["remote"],
    });

    cleanup();
    renderResults(persistenceJobs, { facetScopeId: "plan-a" });
    expect(screen.getByLabelText("2 active filters")).toBeTruthy();
    expect(screen.getByText("1 of 2 jobs")).toBeTruthy();
    openFilters();
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Strong fit" })
        .checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Remote" })
        .checked,
    ).toBe(true);

    fireEvent.click(
      screen.getAllByRole("button", { name: "Clear filters" })[0]!,
    );
    // Clearing stays truthful: the plan's own stored selection empties too.
    expect(readFacetScopesById()["plan-a"]).toEqual({
      id: "plan-a",
      activity: [],
      recommendation: [],
      source: [],
      workMode: [],
    });
    expect(screen.queryByLabelText(/active filters?/u)).toBeNull();
    // With no query or filters left, the header returns to the plain count.
    expect(screen.getByText("2 jobs")).toBeTruthy();
  });

  it("restores only facets still valid and present, dropping the rest everywhere", () => {
    window.localStorage.setItem(
      FACET_FILTERS_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        scopes: [
          {
            id: "plan-seed",
            activity: [],
            recommendation: ["strong_fit", "not_a_recommendation"],
            source: ["Primary board", "Retired board"],
            workMode: ["remote", "onsite", "telepathy"],
          },
        ],
      }),
    );

    renderResults(persistenceJobs, { facetScopeId: "plan-seed" });
    openFilters();

    // Still offered by a visible result: applied.
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Strong fit" })
        .checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Primary board" })
        .checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Remote" })
        .checked,
    ).toBe(true);
    // No longer offered by any visible result, or outside the facet's known
    // value space: dropped from the UI and the stored snapshot alike.
    expect(
      screen.queryByRole("checkbox", { name: "Retired board" }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "On-site" })).toBeNull();
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Hybrid" })
        .checked,
    ).toBe(false);
    expect(screen.getByText("1 of 2 jobs")).toBeTruthy();

    expect(readFacetScopesById()["plan-seed"]).toEqual({
      id: "plan-seed",
      activity: [],
      recommendation: ["strong_fit"],
      source: ["Primary board"],
      workMode: ["remote"],
    });
  });

  it("keeps each plan's facets isolated across remounts and live plan switches", () => {
    const mountedPanel = renderPlanPanel("plan-a");
    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Strong fit" }));
    expect(screen.getByLabelText("1 active filter")).toBeTruthy();

    // A live plan switch on the mounted panel restores plan B's own (empty)
    // set instead of inheriting plan A's selection.
    mountedPanel.rerender(planPanelElement("plan-b"));
    expect(screen.queryByLabelText(/active filters?/u)).toBeNull();
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Strong fit" })
        .checked,
    ).toBe(false);

    // Plan B selects its own value while plan A's snapshot stays intact.
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Review before applying" }),
    );
    mountedPanel.rerender(planPanelElement("plan-a"));
    expect(screen.getByLabelText("1 active filter")).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Strong fit" })
        .checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Review before applying",
      }).checked,
    ).toBe(false);

    const scopes = readFacetScopesById();
    expect(scopes["plan-a"]?.recommendation).toEqual(["strong_fit"]);
    expect(scopes["plan-b"]?.recommendation).toEqual([
      "review_before_applying",
    ]);
    cleanup();

    // A remount under plan B restores B's persisted set, never A's.
    renderResults(persistenceJobs, { facetScopeId: "plan-b" });
    openFilters();
    expect(screen.getByLabelText("1 active filter")).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", {
        name: "Review before applying",
      }).checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Strong fit" })
        .checked,
    ).toBe(false);
  });

  it("migrates the legacy unscoped snapshot into the active plan once", () => {
    window.localStorage.setItem(
      LEGACY_FACET_FILTERS_STORAGE_KEY,
      JSON.stringify({
        activity: [],
        recommendation: ["strong_fit"],
        source: ["Primary board"],
        workMode: ["remote"],
      }),
    );

    renderResults(persistenceJobs, { facetScopeId: "plan-migrated" });
    expect(screen.getByLabelText("3 active filters")).toBeTruthy();

    // The scoped snapshot now owns the migrated values...
    expect(readFacetScopesById()["plan-migrated"]).toEqual({
      id: "plan-migrated",
      activity: [],
      recommendation: ["strong_fit"],
      source: ["Primary board"],
      workMode: ["remote"],
    });
    // ...and the legacy global key is gone, so no other plan can inherit it.
    expect(
      window.localStorage.getItem(LEGACY_FACET_FILTERS_STORAGE_KEY),
    ).toBeNull();
  });

  it("never prunes a facet because another active facet hides its rows", () => {
    renderResults(persistenceJobs, { facetScopeId: "plan-prune" });
    openFilters();
    // Primary board offers only the remote job; Hybrid excludes every
    // Primary-board row. Options derive from the unfiltered scoped
    // collection, so both selections must survive together as a truthful
    // zero-result state instead of being silently erased.
    fireEvent.click(screen.getByRole("checkbox", { name: "Primary board" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hybrid" }));
    expect(screen.getByText("0 of 2 jobs")).toBeTruthy();
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Primary board" })
        .checked,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Hybrid" })
        .checked,
    ).toBe(true);

    const scopes = readFacetScopesById();
    expect(scopes["plan-prune"]?.source).toEqual(["Primary board"]);
    expect(scopes["plan-prune"]?.workMode).toEqual(["hybrid"]);
  });
});

describe("DiscoveryResultsPanel toolbar", () => {
  it("offers no density switch: one row shape, one less decision", () => {
    renderResults([
      createJob("strong-remote", "strong_fit", ["remote"], primarySource),
    ]);

    expect(screen.queryByRole("group", { name: "List density" })).toBeNull();
  });
});

describe("DiscoveryResultsPanel facet saved views", () => {
  it("offers no saved-view chrome and keeps the plan's own facet snapshot", () => {
    renderResults(
      [
        createJob("strong-remote", "strong_fit", ["remote"], primarySource),
        createJob(
          "review-hybrid",
          "review_before_applying",
          ["hybrid"],
          longSource,
        ),
      ],
      { facetScopeId: "plan-views" },
    );
    openFilters();
    fireEvent.click(screen.getByRole("checkbox", { name: "Strong fit" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Primary board" }));
    expect(screen.getByText("1 of 2 jobs")).toBeTruthy();

    // Named views were list-management chrome on a handful of rows; the
    // per-plan facet snapshot that actually survives navigation stays.
    expect(screen.queryByRole("button", { name: /Saved views/u })).toBeNull();
    expect(readFacetScopesById()["plan-views"]).toEqual({
      id: "plan-views",
      activity: [],
      recommendation: ["strong_fit"],
      source: ["Primary board"],
      workMode: [],
    });
  });
});
