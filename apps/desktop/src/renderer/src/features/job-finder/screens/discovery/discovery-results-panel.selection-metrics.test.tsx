// @vitest-environment jsdom

import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  lastCheckedAt: "2026-07-30T10:00:00.000Z",
};

function createJob(index: number): SavedJob {
  const ordinal = index.toString().padStart(2, "0");
  return SavedJobSchema.parse({
    id: `selection_metrics_job_${ordinal}`,
    source: "target_site",
    sourceJobId: `selection_metrics_source_${ordinal}`,
    canonicalUrl: `https://jobs.example.test/roles/${ordinal}`,
    applicationUrl: `https://jobs.example.test/roles/${ordinal}/apply`,
    title: `Senior Product Designer ${ordinal}`,
    company: `Selection Company ${index}`,
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-07-30T10:00:00.000Z",
    salaryText: null,
    description: `Own product systems for role ${ordinal}.`,
    status: "discovered",
    discoveryMethod: "browser_agent",
    matchAssessment: {
      score: 80 - index,
      reasons: ["Relevant product design experience"],
      gaps: [],
      contextFingerprint: "match_context_v4_candidate",
      postingFingerprint: `match_posting_v4_listing_${ordinal}`,
    },
  });
}

async function renderResults(jobs: readonly SavedJob[], selected: SavedJob | null) {
  const rendered = render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      hasCompletedSearch
      jobs={jobs}
      onSelectJob={vi.fn()}
      selectedJob={selected}
    />,
  );
  await flushFindJobsQueries();
  return rendered;
}

function boxClasses(row: HTMLElement): string {
  return (row.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((token) =>
      /^-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|border|border-[xytrbl])(?:-|$)/.test(
        token,
      ),
    )
    .sort()
    .join(" ");
}

afterEach(() => {
  cleanup();
});

describe("Find jobs result rows adopt the shared selectable-row contract", () => {
  // jsdom performs no layout, so this is a class-signature invariant, not a
  // measured one: it proves the row declares the same box-metric classes in
  // both states. Rendered pixel geometry is the capture harness's job.
  it("keeps an identical box-metric class signature whether or not a row is selected", async () => {
    const jobs = [createJob(0), createJob(1)];
    const { container, rerender } = await renderResults(jobs, jobs[0] ?? null);

    const selectedFirst = container.querySelector<HTMLElement>(
      `[data-job-result-id="${jobs[0]!.id}"]`,
    );
    const unselectedSecond = container.querySelector<HTMLElement>(
      `[data-job-result-id="${jobs[1]!.id}"]`,
    );
    if (!selectedFirst || !unselectedSecond) {
      throw new Error("Expected both result rows to be rendered.");
    }

    // Selection is a tint plus an inset accent bar; it may never add or remove
    // a padding, margin or border-width class, because that reflows every row
    // below.
    expect(boxClasses(selectedFirst)).toBe(boxClasses(unselectedSecond));
    expect(selectedFirst.getAttribute("aria-current")).toBe("true");
    expect(selectedFirst.getAttribute("data-selected")).toBe("true");
    expect(unselectedSecond.getAttribute("aria-current")).toBeNull();
    expect(unselectedSecond.getAttribute("data-selected")).toBe("false");

    rerender(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={jobs[1] ?? null}
      />,
    );
    await flushFindJobsQueries();

    const movedFirst = container.querySelector<HTMLElement>(
      `[data-job-result-id="${jobs[0]!.id}"]`,
    );
    const movedSecond = container.querySelector<HTMLElement>(
      `[data-job-result-id="${jobs[1]!.id}"]`,
    );
    if (!movedFirst || !movedSecond) {
      throw new Error("Expected both result rows to survive the rerender.");
    }

    expect(boxClasses(movedFirst)).toBe(boxClasses(selectedFirst));
    expect(boxClasses(movedSecond)).toBe(boxClasses(unselectedSecond));
    expect(movedSecond.getAttribute("aria-current")).toBe("true");
    expect(movedFirst.getAttribute("aria-current")).toBeNull();
  });

  it("renders no content line conditionally on selection", async () => {
    const jobs = [createJob(0), createJob(1)];
    const { container } = await renderResults(jobs, jobs[0] ?? null);

    const lineCount = (jobId: string) =>
      container.querySelector<HTMLElement>(`[data-job-result-id="${jobId}"]`)
        ?.childElementCount ?? -1;

    expect(lineCount(jobs[0]!.id)).toBe(lineCount(jobs[1]!.id));
  });

  it("states the reconciling kept total beside the banded count", async () => {
    const jobs = [createJob(0), createJob(1)];
    await renderResults(jobs, null);

    // Home and Search history describe the same run as "n new jobs saved"; the
    // banded headline must add up to that same number.
    expect(screen.getByTestId("discovery-result-count").textContent).toContain(
      "2 jobs",
    );
  });
});
