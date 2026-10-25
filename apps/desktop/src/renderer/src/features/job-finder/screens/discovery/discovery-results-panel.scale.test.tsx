// @vitest-environment jsdom

import { performance } from "node:perf_hooks";

import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DISCOVERY_RESULTS_PAGE_SIZE } from "./discovery-results-panel";
import {
  DiscoveryResultsPanelWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

const JOB_COUNT = 1_000;
const DOM_COMMIT_BUDGET_MS = 2_000;

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-07-30T10:00:00.000Z",
};

function createJobs(count = JOB_COUNT): SavedJob[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index.toString().padStart(4, "0");

    return SavedJobSchema.parse({
      id: `dom_scale_job_${ordinal}`,
      source: "target_site",
      sourceJobId: `dom_scale_source_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/roles/${ordinal}`,
      applicationUrl: `https://jobs.example.test/roles/${ordinal}/apply`,
      title: `Senior Product Designer ${ordinal}`,
      company: `Scale Company ${index % 50}`,
      location: index % 2 === 0 ? "Remote" : "Budapest, Hungary",
      workMode: index % 2 === 0 ? ["remote"] : ["hybrid"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: "2026-07-30T10:00:00.000Z",
      salaryText: null,
      description: `Own product systems for role ${ordinal}.`,
      status: "discovered",
      matchAssessment: {
        score: 70 + (index % 30),
        judgment: {
          source: "batch",
          judgedAt: "2026-10-02T10:00:00.000Z",
          score: 70 + (index % 30),
          recommendation: "review_before_applying",
        },
        reasons: ["Relevant product design experience"],
        gaps: [],
      },
    });
  });
}

/**
 * The minimum evidence an assessment needs before its percentage is treated
 * as earned: one supported requirement plus a settled role-suitability state.
 */
const checkedAssessmentEvidence = {
  dimensions: {
    roleSuitability: {
      state: "exact",
      explanation: "The listing title matches a saved target role.",
      evidence: [],
    },
  },
  requirements: [
    {
      id: "skill_figma",
      category: "skill",
      label: "Figma",
      importance: "required",
      status: "supported",
      jobEvidence: "Figma is used daily.",
      resumeEvidence: [],
      explanation: "The resume contains explicit Figma evidence.",
    },
  ],
};

function getRenderedJobButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button[data-job-result-id]"),
  );
}

async function renderResults(
  jobs: readonly SavedJob[],
  selectedJob: SavedJob | null,
) {
  const rendered = render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      hasCompletedSearch
      jobs={jobs}
      onSelectJob={vi.fn()}
      selectedJob={selectedJob}
    />,
  );
  await flushFindJobsQueries();
  return rendered;
}

afterEach(() => {
  cleanup();
});

describe("DiscoveryResultsPanel workspace scale", () => {
  it("keeps a bulk shortlist single-flight until its mutation finishes", async () => {
    const jobs = createJobs().slice(0, DISCOVERY_RESULTS_PAGE_SIZE + 10);
    let finish!: () => void;
    const onShortlistJobs = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={jobs}
        onSelectJob={vi.fn()}
        onShortlistJobs={onShortlistJobs}
        selectedJob={jobs[0] ?? null}
      />,
    );
    await flushFindJobsQueries();
    // The page checkbox ticks every row on the page at once.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /^Select the [0-9]+ jobs on this page$/,
      }),
    );
    await flushFindJobsQueries();
    const button = screen.getByRole("button", {
      name: "Shortlist 50 selected",
    });
    fireEvent.click(button);
    await flushFindJobsQueries();
    fireEvent.click(button);
    await flushFindJobsQueries();
    expect(onShortlistJobs).toHaveBeenCalledTimes(1);
    expect(button.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
  });
  it("shortlists exactly the rows shown on the current page", async () => {
    const jobs = createJobs().slice(0, DISCOVERY_RESULTS_PAGE_SIZE + 10);
    const onShortlistJobs = vi.fn();
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={jobs}
        onSelectJob={vi.fn()}
        onShortlistJobs={onShortlistJobs}
        selectedJob={jobs[0] ?? null}
      />,
    );
    await flushFindJobsQueries();

    // The page checkbox ticks every row on the page at once.
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /^Select the [0-9]+ jobs on this page$/,
      }),
    );
    await flushFindJobsQueries();
    fireEvent.click(
      screen.getByRole("button", {
        name: `Shortlist ${DISCOVERY_RESULTS_PAGE_SIZE} selected`,
      }),
    );
    await flushFindJobsQueries();
    expect(onShortlistJobs).toHaveBeenCalledWith(
      jobs.slice(0, DISCOVERY_RESULTS_PAGE_SIZE).map((job) => job.id),
    );
  });

  it("bounds a 1,000-job React DOM commit to exactly one 50-row page", async () => {
    const jobs = createJobs();
    const startedAt = performance.now();
    const { container } = await renderResults(jobs, null);
    const durationMs = performance.now() - startedAt;
    const resultButtons = getRenderedJobButtons(container);

    console.info("job-finder-discovery-dom-scale", {
      durationMs: Math.round(durationMs),
      inputJobs: jobs.length,
      renderedJobButtons: resultButtons.length,
      renderedNodes: container.querySelectorAll("*").length,
    });

    expect(resultButtons).toHaveLength(DISCOVERY_RESULTS_PAGE_SIZE);
    expect(resultButtons[0]?.dataset.jobResultId).toBe("dom_scale_job_0000");
    expect(resultButtons.at(-1)?.dataset.jobResultId).toBe(
      "dom_scale_job_0049",
    );
    expect(screen.getByText("1–50 of 1000")).toBeTruthy();
    // The default "review before applying" verdict is the list baseline and
    // earns no per-row badge; only stronger or weaker verdicts are badged.
    expect(
      resultButtons.filter((button) =>
        button.textContent?.includes("Review before applying"),
      ),
    ).toHaveLength(0);
    expect(
      screen.getAllByLabelText("Overall fit: not assessed").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("70% fit")).toBeNull();
    expect(screen.queryByText("Role and requirements")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Previous" })
        .disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Next" }).disabled,
    ).toBe(false);
    expect(durationMs).toBeLessThan(DOM_COMMIT_BUDGET_MS);
  });

  it("suppresses provisional numbers while preserving authoritative labels", async () => {
    const catalogJob = createJobs(1)[0];
    if (!catalogJob) {
      throw new Error("Expected the scale fixture to include one catalog job.");
    }
    const authoritativeJob = SavedJobSchema.parse({
      ...catalogJob,
      id: `${catalogJob.id}_authoritative`,
      discoveryMethod: "browser_agent",
      matchAssessment: {
        ...catalogJob.matchAssessment,
        ...checkedAssessmentEvidence,
        contextFingerprint: "match_context_v4_candidate",
        postingFingerprint: "match_posting_v4_listing",
      },
    });

    const { container } = await renderResults(
      [catalogJob, authoritativeJob],
      null,
    );

    expect(screen.getByLabelText("Overall fit: not assessed")).toBeTruthy();
    expect(screen.getByText("Fit not assessed")).toBeTruthy();
    const provisionalResult = container.querySelector<HTMLButtonElement>(
      `[data-job-result-id="${catalogJob.id}"]`,
    );
    if (!provisionalResult) {
      throw new Error("Expected the provisional result row to be rendered.");
    }
    expect(provisionalResult.textContent).not.toContain("70% fit");
    expect(
      provisionalResult.querySelector('[aria-label="Overall fit: 70 percent"]'),
    ).toBeNull();
    expect(screen.getByLabelText("Overall fit: 70 percent")).toBeTruthy();
    expect(screen.getByText("70% fit")).toBeTruthy();
  });

  it("withholds the percentage when only the listing title was checkable", async () => {
    const titleOnlyJob = SavedJobSchema.parse({
      ...createJobs(1)[0],
      id: "dom_scale_job_title_only",
      discoveryMethod: "browser_agent",
      matchAssessment: {
        score: 54,
        reasons: [],
        gaps: [],
        contextFingerprint: "match_context_v4_candidate",
        postingFingerprint: "match_posting_v4_listing",
      },
    });

    const { container } = await renderResults([titleOnlyJob], null);
    const row = container.querySelector<HTMLButtonElement>(
      `[data-job-result-id="${titleOnlyJob.id}"]`,
    );
    if (!row) {
      throw new Error("Expected the title-only result row to be rendered.");
    }

    // The number is not printed anywhere on the row, and the band divider
    // above it — not a chip and a caption on every row — says what is missing
    // instead of asserting a confidence it has not earned.
    expect(row.textContent).not.toContain("54%");
    expect(screen.queryByText("Not judged yet")).toBeNull();
    // The reason is not painted on the row any more; it survives only in the
    // row's sr-only verdict line.
    expect(
      row.querySelector('[data-testid^="discovery-result-fit-reason-"]'),
    ).toBeNull();
    expect(
      row.querySelector('[data-testid^="discovery-result-fit-sr-"]')
        ?.textContent,
    ).toContain("The AI judges each job against your profile");
    const heading = screen.getByTestId("discovery-results-group-unchecked");
    expect(heading.textContent).toContain("Not yet assessed (1)");
    expect(heading.textContent).not.toContain(
      "The full requirements have not been assessed. Check the role and level before applying.",
    );
    expect(row.textContent).toContain("Overall fit: not judged yet");
  });

  it("cuts unbroken result labels to one line and exposes their full names", async () => {
    const [job] = createJobs(1);
    const longTitle = "SeniorProductDesignerWithoutAnyWordBreaks";
    const longCompany = "CompanyWithoutAnyWordBreaksEither";
    const longJob = {
      ...job,
      company: longCompany,
      title: longTitle,
    } as SavedJob;
    const { container } = await renderResults([longJob], null);

    const result = container.querySelector<HTMLButtonElement>(
      "[data-job-result-id]",
    );
    const title = result?.querySelector("strong");
    // The employer meta line is its own line in the shared lines stack now,
    // no longer the element immediately after the title, so it is selected by
    // identity rather than by DOM adjacency.
    const company = result?.querySelector(
      `[data-testid="discovery-result-employer-${longJob.id}"]`,
    );
    expect(result?.className).toContain("min-w-0");
    expect(title?.className).toContain("truncate");
    expect(title?.getAttribute("title")).toBe(longTitle);
    expect(company?.className).toContain("truncate");
    expect(company?.getAttribute("title")).toContain(longCompany);
  });

  it("keeps accessible next and previous paging bounded to 50 result buttons", async () => {
    const jobs = createJobs();
    const { container } = await renderResults(jobs, null);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flushFindJobsQueries();

    let resultButtons = getRenderedJobButtons(container);
    expect(resultButtons).toHaveLength(DISCOVERY_RESULTS_PAGE_SIZE);
    expect(resultButtons[0]?.dataset.jobResultId).toBe("dom_scale_job_0050");
    expect(resultButtons.at(-1)?.dataset.jobResultId).toBe(
      "dom_scale_job_0099",
    );
    expect(screen.getByText("51–100 of 1000")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await flushFindJobsQueries();

    resultButtons = getRenderedJobButtons(container);
    expect(resultButtons[0]?.dataset.jobResultId).toBe("dom_scale_job_0000");
    expect(screen.getByText("1–50 of 1000")).toBeTruthy();
  });

  it("moves ArrowDown across the 50-row page boundary while keeping the DOM bounded", async () => {
    const jobs = createJobs(51);
    const onSelectJob = vi.fn();
    const { container, rerender } = render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={onSelectJob}
        selectedJob={jobs[0] ?? null}
      />,
    );
    await flushFindJobsQueries();

    const lastPageOneButton = container.querySelector<HTMLButtonElement>(
      '[data-job-result-id="dom_scale_job_0049"]',
    );
    expect(lastPageOneButton).not.toBeNull();
    lastPageOneButton?.focus();

    fireEvent.keyDown(lastPageOneButton as HTMLButtonElement, {
      key: "ArrowDown",
    });
    await flushFindJobsQueries();

    expect(onSelectJob).toHaveBeenCalledWith("dom_scale_job_0050");
    expect(screen.getByText("51–51 of 51")).toBeTruthy();
    expect(getRenderedJobButtons(container)).toHaveLength(1);

    rerender(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={onSelectJob}
        selectedJob={jobs[50] ?? null}
      />,
    );
    await flushFindJobsQueries();

    await waitFor(() => {
      expect(document.activeElement).toBe(
        container.querySelector('[data-job-result-id="dom_scale_job_0050"]'),
      );
    });
    expect(
      container
        .querySelector('[data-job-result-id="dom_scale_job_0050"]')
        ?.getAttribute("aria-current"),
    ).toBe("true");
  });

  it("moves End to the final result page and focuses the mounted final row", async () => {
    const jobs = createJobs(51);
    const onSelectJob = vi.fn();
    const { container, rerender } = render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={onSelectJob}
        selectedJob={jobs[0] ?? null}
      />,
    );
    await flushFindJobsQueries();

    const firstButton = container.querySelector<HTMLButtonElement>(
      '[data-job-result-id="dom_scale_job_0000"]',
    );
    expect(firstButton).not.toBeNull();
    firstButton?.focus();

    fireEvent.keyDown(firstButton as HTMLButtonElement, { key: "End" });
    await flushFindJobsQueries();

    expect(onSelectJob).toHaveBeenCalledWith("dom_scale_job_0050");
    expect(screen.getByText("51–51 of 51")).toBeTruthy();
    expect(getRenderedJobButtons(container)).toHaveLength(1);

    rerender(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={onSelectJob}
        selectedJob={jobs[50] ?? null}
      />,
    );
    await flushFindJobsQueries();

    await waitFor(() => {
      expect(document.activeElement).toBe(
        container.querySelector('[data-job-result-id="dom_scale_job_0050"]'),
      );
    });
    expect(
      container
        .querySelector('[data-job-result-id="dom_scale_job_0050"]')
        ?.getAttribute("aria-controls"),
    ).toBe("discovery-selected-job-detail");
    expect(
      container
        .querySelector('[data-job-result-id="dom_scale_job_0050"]')
        ?.getAttribute("aria-current"),
    ).toBe("true");
  });

  it("resets only the result scroller while keeping pagination keyboard focus", async () => {
    const jobs = createJobs();
    const { container } = await renderResults(jobs, null);
    const scrollRegion = container.querySelector<HTMLElement>(
      "[data-job-results-scroll-region]",
    );
    const nextButton = screen.getByRole<HTMLButtonElement>("button", {
      name: "Next",
    });
    expect(scrollRegion).not.toBeNull();
    container.scrollTop = 120;
    if (scrollRegion) {
      scrollRegion.scrollTop = 640;
    }
    nextButton.focus();

    fireEvent.click(nextButton);
    await flushFindJobsQueries();

    expect(scrollRegion?.scrollTop).toBe(0);
    expect(container.scrollTop).toBe(120);
    expect(document.activeElement).toBe(nextButton);
    expect(screen.getByText("51–100 of 1000")).toBeTruthy();
  });

  it("keeps pagination sticky within the shared results and filters scroller", async () => {
    const jobs = createJobs();
    const { container } = await renderResults(jobs, null);
    const scrollRegion = container.querySelector(
      "[data-job-results-scroll-region]",
    );
    const resultStack = container.querySelector("[data-job-results-stack]");
    const pagination = container.querySelector("[data-job-results-pagination]");

    expect(resultStack).toBeTruthy();
    expect(resultStack?.className).not.toContain("overflow-hidden");
    expect(scrollRegion).toBeTruthy();
    expect(scrollRegion).toBe(
      screen.getByRole("region", { name: "Job results list" }),
    );
    expect(scrollRegion?.getAttribute("tabindex")).toBe("0");
    expect(scrollRegion?.className).toContain("min-h-[360px]");
    expect(scrollRegion?.className).toContain("overflow-y-auto");
    expect(pagination).toBeTruthy();
    expect(scrollRegion?.contains(pagination)).toBe(true);
    expect(pagination?.className).toContain("sticky");
    expect(pagination?.className).toContain("bottom-0");
    expect(pagination?.className).toContain("shrink-0");
    expect(pagination?.className).toContain("bg-(--surface-panel)");
  });

  it("opens directly on page 20 when the selected job is the final result", async () => {
    const jobs = createJobs();
    const { container } = await renderResults(jobs, jobs[999] ?? null);
    const resultButtons = getRenderedJobButtons(container);

    expect(resultButtons).toHaveLength(DISCOVERY_RESULTS_PAGE_SIZE);
    expect(resultButtons[0]?.dataset.jobResultId).toBe("dom_scale_job_0950");
    expect(resultButtons.at(-1)?.dataset.jobResultId).toBe(
      "dom_scale_job_0999",
    );
    expect(screen.getByText("951–1000 of 1000")).toBeTruthy();
    expect(
      container
        .querySelector('[data-job-result-id="dom_scale_job_0999"]')
        ?.getAttribute("aria-current"),
    ).toBe("true");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Next" }).disabled,
    ).toBe(true);
  });

  it("does not snap away from the current page when a refreshed job array keeps the same selection", async () => {
    const jobs = createJobs();
    const { container, rerender } = await renderResults(jobs, jobs[0] ?? null);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flushFindJobsQueries();
    expect(screen.getByText("51–100 of 1000")).toBeTruthy();
    const scrollRegion = container.querySelector<HTMLElement>(
      "[data-job-results-scroll-region]",
    );
    expect(scrollRegion).not.toBeNull();
    if (scrollRegion) {
      scrollRegion.scrollTop = 640;
    }

    const refreshedJobs = jobs.map((job) => ({ ...job }));
    rerender(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={refreshedJobs}
        onSelectJob={vi.fn()}
        selectedJob={refreshedJobs[0] ?? null}
      />,
    );
    await flushFindJobsQueries();

    const resultButtons = getRenderedJobButtons(container);
    expect(resultButtons[0]?.dataset.jobResultId).toBe("dom_scale_job_0050");
    expect(screen.getByText("51–100 of 1000")).toBeTruthy();
    expect(scrollRegion?.scrollTop).toBe(640);
  });

  it("resets the result scroller when an external selection opens another page", async () => {
    const jobs = createJobs();
    const { container, rerender } = await renderResults(jobs, jobs[0] ?? null);
    const scrollRegion = container.querySelector<HTMLElement>(
      "[data-job-results-scroll-region]",
    );
    expect(scrollRegion).not.toBeNull();
    if (scrollRegion) {
      scrollRegion.scrollTop = 640;
    }

    rerender(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={jobs[999] ?? null}
      />,
    );
    await flushFindJobsQueries();

    expect(screen.getByText("951–1000 of 1000")).toBeTruthy();
    expect(scrollRegion?.scrollTop).toBe(0);
  });

  it("keeps the result scroll position when selection changes within the same page", async () => {
    const jobs = createJobs();
    const { container, rerender } = await renderResults(jobs, jobs[50] ?? null);
    const scrollRegion = container.querySelector<HTMLElement>(
      "[data-job-results-scroll-region]",
    );
    expect(scrollRegion).not.toBeNull();
    if (scrollRegion) {
      scrollRegion.scrollTop = 640;
    }

    rerender(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={jobs[51] ?? null}
      />,
    );
    await flushFindJobsQueries();

    expect(screen.getByText("51–100 of 1000")).toBeTruthy();
    expect(scrollRegion?.scrollTop).toBe(640);
  });

  it("explains an all-hidden result set and offers a working reveal action", async () => {
    const onShowAlsoFound = vi.fn();

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        alsoFoundCount={3}
        hiddenAlsoFoundCount={3}
        jobs={[]}
        onSelectJob={vi.fn()}
        onShowAlsoFound={onShowAlsoFound}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    // No count beside an empty list; the empty state below says it all.
    expect(screen.queryByTestId("discovery-result-count")).toBeNull();
    // The jobs are still in the plan, so the list does not say "nothing".
    expect(screen.getByText("3 jobs kept, but they scored low")).toBeTruthy();
    expect(
      screen.queryByText("Nothing scored close to your targets"),
    ).toBeNull();
    expect(screen.queryByText("No matches from this search")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Show weaker matches (3)" }),
    );
    await flushFindJobsQueries();

    expect(onShowAlsoFound).toHaveBeenCalledTimes(1);
  });
});

it("lets a short result list take its content height below the split-pane width", async () => {
  await renderResults(createJobs(2), null);
  const scroller = document.querySelector("[data-job-results-scroll-region]")!;
  expect(scroller.className).not.toMatch(/(?:^|\s)min-h-\[/u);
  const stack = document.querySelector("[data-job-results-stack]")!;
  expect(stack.querySelector("ul")?.parentElement?.className).not.toMatch(
    /(?:^|\s)min-h-\[/u,
  );
});

it("selects all shown without a first tick and keeps the whole selection across a direct page jump", async () => {
  const jobs = createJobs();
  const onShortlistJobs = vi.fn(() => Promise.resolve());
  const { container } = render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      jobs={jobs}
      onSelectJob={vi.fn()}
      onShortlistJobs={onShortlistJobs}
      selectedJob={null}
    />,
  );
  await flushFindJobsQueries();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /^Select the [0-9]+ jobs on this page$/,
    }),
  );
  expect(screen.getByText("50 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Page 20" }));
  await flushFindJobsQueries();
  expect(screen.getByText("951–1000 of 1000")).toBeTruthy();
  expect(container.querySelectorAll("button[data-job-result-id]")).toHaveLength(
    50,
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /^Select the [0-9]+ jobs on this page$/,
    }),
  );
  expect(screen.getByText("100 selected")).toBeTruthy();
  await act(() =>
    Promise.resolve(
      fireEvent.click(
        screen.getByRole("button", { name: "Shortlist 100 selected" }),
      ),
    ),
  );
  await flushFindJobsQueries();
  expect(onShortlistJobs).toHaveBeenCalledExactlyOnceWith(
    [...jobs.slice(0, 50), ...jobs.slice(950)].map((job) => job.id),
  );
});
