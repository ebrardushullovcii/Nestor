// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  JobDiscoveryTargetSchema,
  SavedJobSchema,
  type JobDiscoveryTarget,
  type SavedJob,
} from "@nordri/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscoveryResultsPanel } from "./discovery-results-panel";

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
};

const JOB_COUNT = 60;

function createJobs(count = JOB_COUNT): SavedJob[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index.toString().padStart(3, "0");

    return SavedJobSchema.parse({
      id: `sort_job_${ordinal}`,
      source: "target_site",
      sourceJobId: `sort_source_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/roles/${ordinal}`,
      applicationUrl: `https://jobs.example.test/roles/${ordinal}/apply`,
      title: `Engineer ${ordinal}`,
      // The alphabetically-first company sits on the second page so sorting
      // has to pull it back onto page one.
      company: index === count - 1 ? "Aardvark Co" : "Mega Corp",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt:
        index % 10 === 0
          ? `2026-08-${(20 - index / 10).toString().padStart(2, "0")}T10:00:00.000Z`
          : "2026-08-01T10:00:00.000Z",
      postedAt:
        index % 10 === 0
          ? `2026-08-${(20 - index / 10).toString().padStart(2, "0")}T10:00:00.000Z`
          : null,
      salaryText: null,
      description: `Own systems for role ${ordinal}.`,
      status: "discovered",
      matchAssessment: {
        score: 100 - index,
        reasons: ["Relevant experience"],
        gaps: [],
      },
    });
  });
}

function renderResults(
  jobs: readonly SavedJob[],
  options?: {
    discoveryTargets?: readonly JobDiscoveryTarget[];
    onDisplayedSelectedJobIdChange?: (selectedJobId: string | null) => void;
    onSelectJob?: (jobId: string) => void;
    selectedJob?: SavedJob | null;
  },
) {
  return render(
    <DiscoveryResultsPanel
      browserSession={browserSession}
      discoveryTargets={options?.discoveryTargets ?? []}
      hasCompletedSearch
      jobs={jobs}
      {...(options?.onDisplayedSelectedJobIdChange
        ? {
            onDisplayedSelectedJobIdChange:
              options.onDisplayedSelectedJobIdChange,
          }
        : {})}
      onSelectJob={options?.onSelectJob ?? vi.fn()}
      selectedJob={
        options?.selectedJob !== undefined ? options.selectedJob : null
      }
    />,
  );
}

function getFirstResultJobId(): string | null {
  return (
    document.querySelector<HTMLButtonElement>("button[data-job-result-id]")
      ?.dataset.jobResultId ?? null
  );
}

beforeEach(() => {
  window.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

describe("DiscoveryResultsPanel result sorting", () => {
  it("keeps both assessment controls in the toolbar on every results page", () => {
    const onJudge = vi.fn(() => Promise.resolve());
    const onAssess = vi.fn(() => Promise.resolve());
    render(
      <DiscoveryResultsPanel
        browserSession={browserSession}
        hasCompletedSearch
        jobs={createJobs()}
        selectedJob={null}
        onSelectJob={vi.fn()}
        onJudgeUnjudgedJobs={onJudge}
        onAssessJobListing={onAssess}
      />,
    );
    const all = screen.getByRole("button", { name: "Judge fit for all 60" });
    const next = screen.getByRole("button", {
      name: "Assess next 20 listings",
    });
    expect(all.closest("header")).toBe(next.closest("header"));
    expect(all.closest("header")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      screen
        .getByRole("button", { name: "Judge fit for all 60" })
        .closest("header"),
    ).not.toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Assess next 20 listings" })
        .closest("header"),
    ).not.toBeNull();
  });
  it("shows a compact source line with the full configured name available to assistive technology", () => {
    const source = JobDiscoveryTargetSchema.parse({
      id: "target_results_source",
      label: "A configured source name that can exceed the row width",
      startingUrl: "https://configured.example.test/jobs",
    });
    const job = SavedJobSchema.parse({
      ...createJobs(1)[0]!,
      provenance: [
        {
          targetId: source.id,
          adapterKind: "auto",
          startingUrl: "https://configured.example.test/jobs?q=private",
          discoveredAt: "2026-08-23T10:00:00.000Z",
          collectionMethod: "careers_page",
        },
      ],
    });

    renderResults([job], { discoveryTargets: [source] });

    const sourceLine = screen.getByTestId(`discovery-result-source-${job.id}`);
    expect(sourceLine.textContent).toContain(
      "Found on A configured source name that can exceed the row width",
    );
    expect(sourceLine.getAttribute("title")).toBe(
      "Found on A configured source name that can exceed the row width",
    );
    expect(sourceLine.querySelector(".truncate")).toBeTruthy();
  });

  it("names an unknown employer plainly instead of a 'Listing ·' company", () => {
    const source = JobDiscoveryTargetSchema.parse({
      id: "target_wellfound",
      label: "Wellfound",
      startingUrl: "https://wellfound.example.test/jobs",
    });
    const job = SavedJobSchema.parse({
      ...createJobs(1)[0]!,
      // The stored absence placeholders the extraction layer keeps when a
      // board never states an employer or location.
      company: "Employer not stated",
      location: "Location not stated",
      provenance: [
        {
          targetId: source.id,
          adapterKind: "auto",
          startingUrl: "https://wellfound.example.test/jobs",
          discoveredAt: "2026-08-23T10:00:00.000Z",
          collectionMethod: "careers_page",
        },
      ],
    });

    renderResults([job], { discoveryTargets: [source] });

    const sourceLine = screen.getByTestId(`discovery-result-source-${job.id}`);
    expect(sourceLine.textContent).toContain("Employer not listed ·");
    expect(sourceLine.textContent).toContain("Found on Wellfound");
    expect(sourceLine.textContent).not.toContain("Listing ·");
    // The row's own source line must not be the palest text on the screen;
    // it sits at the same softness as the employer line above it.
    expect(sourceLine.className).toContain("text-foreground-soft");
    expect(sourceLine.getAttribute("title")).toBe(
      "Employer not listed · Wellfound",
    );
  });

  it("keeps the shipped best-match ranking as the default sort", () => {
    renderResults(createJobs());

    expect(
      screen.getByRole<HTMLSelectElement>("combobox", {
        name: "Sort results",
      }).value,
    ).toBe("fit");
    expect(getFirstResultJobId()).toBe("sort_job_000");
    expect(screen.getByText("1–50 of 60")).toBeTruthy();
  });

  it("styles the compact sort select with canonical field tokens and focus hierarchy", () => {
    renderResults(createJobs(2));

    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Sort results",
    });
    for (const className of [
      // Compact toolbar geometry is an allowed variant.
      "h-8",
      "rounded-(--radius-button)",
      "px-2",
      "text-xs",
      // Border, fill, and focus must match the app-wide editable field trio.
      "border-(--field-border)",
      "bg-(--field)",
      "outline-none",
      "focus-visible:border-(--field-focus-border)",
      "focus-visible:bg-(--field-strong)",
      "focus-visible:shadow-[var(--field-focus-shadow)]",
    ]) {
      expect(select.classList.contains(className)).toBe(true);
    }
    expect(select.className).not.toContain("bg-transparent");
    expect(select.className).not.toContain("--surface-panel-border");
  });

  it("re-orders by company across page boundaries and restarts pagination", () => {
    const jobs = createJobs();
    const { container } = renderResults(jobs);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(getFirstResultJobId()).toBe("sort_job_049");

    fireEvent.change(screen.getByRole("combobox", { name: "Sort results" }), {
      target: { value: "company" },
    });

    expect(getFirstResultJobId()).toBe("sort_job_059");
    expect(screen.getByText("1–50 of 60")).toBeTruthy();
    expect(
      container.querySelectorAll("button[data-job-result-id]"),
    ).toHaveLength(50);
  });

  it("orders recency newest-first using available listing dates", () => {
    renderResults(createJobs(12));

    expect(screen.getByRole("option", { name: "Newest first" })).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Sort results" }), {
      target: { value: "recent" },
    });

    // postedAt steps down from 2026-08-20 for every tenth job; newest wins.
    expect(getFirstResultJobId()).toBe("sort_job_000");
  });

  it("keeps the inspected job when sorting moves the selection off-page", () => {
    const jobs = createJobs().map((job, index) =>
      index === 0
        ? ({ ...job, company: "Zeta Corp" } as SavedJob)
        : ({ ...job, company: "Alpha Co" } as SavedJob),
    );
    const onDisplayedSelectedJobIdChange = vi.fn();

    renderResults(jobs, {
      onDisplayedSelectedJobIdChange,
      selectedJob: jobs[0] ?? null,
    });
    expect(onDisplayedSelectedJobIdChange).toHaveBeenCalledWith("sort_job_000");

    onDisplayedSelectedJobIdChange.mockClear();
    fireEvent.change(screen.getByRole("combobox", { name: "Sort results" }), {
      target: { value: "company" },
    });

    // The selected Zeta job sinks to the end of the list (page two); the
    // inspector keeps the same job ID until another row is selected.
    expect(onDisplayedSelectedJobIdChange).not.toHaveBeenCalled();
  });
});
