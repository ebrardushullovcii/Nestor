// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DISCOVERY_RESULTS_TOOLBAR_CONTROL_CLASS,
  DiscoveryResultsPanel,
} from "./discovery-results-panel";

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
};

function createJobs(count: number): SavedJob[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index.toString().padStart(3, "0");

    return SavedJobSchema.parse({
      id: `toolbar_job_${ordinal}`,
      source: "target_site",
      sourceJobId: `toolbar_source_${ordinal}`,
      canonicalUrl: `https://jobs.example.test/roles/${ordinal}`,
      applicationUrl: `https://jobs.example.test/roles/${ordinal}/apply`,
      title: `Engineer ${ordinal}`,
      company: "Mega Corp",
      location: "Remote",
      // Two work modes, so the Filters disclosure has something to offer.
      workMode: [index % 2 === 0 ? "remote" : "hybrid"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: "2026-08-01T10:00:00.000Z",
      postedAt: null,
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

function renderResults(jobs: readonly SavedJob[]) {
  return render(
    <DiscoveryResultsPanel
      browserSession={browserSession}
      discoveryTargets={[]}
      hasCompletedSearch
      jobs={jobs}
      onSelectJob={vi.fn()}
      selectedJob={null}
    />,
  );
}

/**
 * Every control placed directly on the results toolbar row, addressed
 * structurally rather than by name so a control added later is covered
 * automatically. The open filter panel's own actions are nested a level
 * deeper (`> details > div > … > button`) and are intentionally out of scope:
 * they belong to the disclosure's contents, not to the row.
 */
function getToolbarControls(): HTMLElement[] {
  const toolbar = screen.getByTestId("discovery-results-toolbar");

  return Array.from(
    toolbar.querySelectorAll<HTMLElement>(
      ":scope > details > summary, :scope > div > select, :scope > div > button",
    ),
  );
}

beforeEach(() => {
  window.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

describe("DiscoveryResultsPanel toolbar control metrics", () => {
  it("gives every toolbar control the one shared box metric", () => {
    renderResults(createJobs(3));

    const controls = getToolbarControls();
    // Filters disclosure, sort field, sort direction.
    expect(controls).toHaveLength(2);

    const sharedClasses = DISCOVERY_RESULTS_TOOLBAR_CONTROL_CLASS.split(" ");
    expect(
      controls.map((control) =>
        sharedClasses.filter((className) =>
          control.classList.contains(className),
        ),
      ),
    ).toEqual([sharedClasses, sharedClasses]);
  });

  it("keeps the toolbar row free of the heights and radii that made it ragged", () => {
    renderResults(createJobs(3));

    for (const control of getToolbarControls()) {
      // `h-6` was the sort-direction toggle's `xs` height (24px) beside a
      // 32px select; `min-h-8` let the Filters disclosure grow past its
      // neighbours; `rounded-md` was the `xs` radius instead of the shared
      // `--radius-button`.
      expect(control.className).not.toContain("h-6");
      expect(control.className).not.toContain("min-h-8");
      expect(control.className).not.toContain("rounded-md");
      expect(control.className).not.toContain("font-semibold");
    }
  });

  it("draws every toolbar boundary with an interactive border token", () => {
    renderResults(createJobs(3));

    for (const control of getToolbarControls()) {
      // A control's only boundary must clear the non-text contrast floor;
      // `--surface-panel-border` is inert chrome and can never carry it.
      expect(control.className).not.toContain("--surface-panel-border");
      expect(
        control.className.includes("border-(--control-border)") ||
          // The sort field keeps the editable-field trio it shares with the
          // search input directly above this row.
          control.className.includes("border-(--field-border)"),
      ).toBe(true);
    }
  });

  it("wraps the toolbar as whole control groups rather than splitting one", () => {
    renderResults(createJobs(3));

    const toolbar = screen.getByTestId("discovery-results-toolbar");
    // At the compact desktop width and at the 1024px minimum the row has to
    // reflow as two groups on two lines, not as four ragged fragments, and
    // the sort field and its direction toggle have to stay side by side.
    expect(toolbar.className).toContain("flex-wrap");
    expect(toolbar.className).toContain("gap-2");

    const sortGroup = screen.getByRole("combobox", {
      name: "Sort results",
    }).parentElement;
    expect(sortGroup?.className).toContain("flex-wrap");
    // The inner gap matches the row gap so the group reads as one band.
    expect(sortGroup?.className).toContain("gap-2");
    expect(sortGroup?.className).not.toContain("gap-1 ");
  });

  it("keeps the sort control semantics, options and aria wiring unchanged", () => {
    renderResults(createJobs(3));

    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Sort results",
    });
    expect(select.tagName).toBe("SELECT");
    expect(
      Array.from(select.options).map((option) => [option.value, option.text]),
    ).toEqual([
      ["fit", "Best match"],
      ["recent", "Newest first"],
      ["company", "Company A–Z"],
    ]);
    expect(select.value).toBe("fit");
    // Each option carries its own direction, so there is no flip control.
    expect(screen.queryByText("Highest first")).toBeNull();
  });
});
