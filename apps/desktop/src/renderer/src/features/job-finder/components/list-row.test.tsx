// @vitest-environment jsdom

import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiscoveryResultsPanelWithJobs,
  flushFindJobsQueries,
} from "../screens/discovery/find-jobs-query-fixture.test-support";
import { jobFinderListRowBadgeSlotClassName } from "./list-row";

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

function createSavedJob(): SavedJob {
  return SavedJobSchema.parse({
    id: "list_row_job_01",
    source: "target_site",
    sourceJobId: "list_row_source_01",
    canonicalUrl: "https://jobs.example.test/roles/01",
    applicationUrl: "https://jobs.example.test/roles/01/apply",
    title: "Senior Product Designer",
    company: "Selection Company",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-07-30T10:00:00.000Z",
    salaryText: null,
    description: "Own product systems.",
    status: "discovered",
    discoveryMethod: "browser_agent",
    matchAssessment: {
      score: 80,
      reasons: ["Relevant product design experience"],
      gaps: [],
      contextFingerprint: "match_context_v4_candidate",
      postingFingerprint: "match_posting_v4_listing_01",
    },
  });
}

/**
 * The worst real badge load a Find jobs row can carry: a non-default
 * recommendation, a model judgment, a non-active listing, an
 * application status and a posting-date badge.
 */
function createBadgeHeavyJob(): SavedJob {
  return SavedJobSchema.parse({
    ...createSavedJob(),
    id: "list_row_badge_heavy_01",
    sourceJobId: "list_row_badge_heavy_source_01",
    status: "drafting",
    listingActivity: {
      status: "inactive",
      observedAt: "2026-07-30T10:00:00.000Z",
    },
    matchAssessment: {
      score: 91,
      recommendation: "strong_fit",
      reasons: ["Relevant product design experience"],
      gaps: [],
      contextFingerprint: "match_context_v4_candidate",
      postingFingerprint: "match_posting_v4_listing_heavy",
      judgment: {
        source: "batch",
        judgedAt: "2026-07-30T10:00:00.000Z",
        score: 91,
        recommendation: "strong_fit",
      },
    },
  });
}

function firstRow(container: HTMLElement): Element {
  const row = container.querySelector('[data-slot="selectable-row"]');
  if (!row) {
    throw new Error("Expected the panel to render a selectable row.");
  }
  return row;
}

describe("one Job Finder list treatment", () => {
  it("keeps a badge-heavy row to one verdict and says the rest on the meta line", async () => {
    const job = createBadgeHeavyJob();
    const { container } = render(
      <DiscoveryResultsPanelWithJobs
        browserSession={{
          source: "target_site",
          status: "ready",
          driver: "chrome_profile_agent",
          label: "Browser ready",
          detail: "Browser session is ready.",
          lastCheckedAt: "2026-07-30T10:00:00.000Z",
        }}
        hasCompletedSearch
        jobs={[job]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    const badgeSlot = firstRow(container).querySelector(
      `[class="${jobFinderListRowBadgeSlotClassName}"]`,
    );
    if (!badgeSlot) {
      throw new Error("Expected the row to render the shared badge slot.");
    }

    // The slot holds the fit and its one verdict badge. Shortlisted, the
    // posting date and a listing that went quiet are plain facts on the meta
    // line, so a row is no longer three stacked uppercase badges tall.
    expect(badgeSlot.childElementCount).toBe(2);
    expect(badgeSlot.textContent).toContain("Strong fit");
    expect(badgeSlot.textContent).not.toContain("Shortlisted");
    expect(
      firstRow(container).querySelector(
        `[data-testid="discovery-result-pipeline-${job.id}"]`,
      )?.textContent,
    ).toContain("Shortlisted");

    const slotClasses = (badgeSlot.getAttribute("class") ?? "").split(" ");
    // jsdom performs no layout, so the invariant is asserted on the box
    // contract instead of a measured width. `shrink-0` keeps the slot from
    // being squeezed narrower than its widest badge (which clipped labels to
    // "NEEDS APPR…" beside long titles); `max-w-[55%]` still caps it, so a
    // crowded slot wraps its badges inside that cap instead of growing.
    expect(slotClasses).toContain("shrink-0");
    expect(slotClasses).toContain("flex-wrap");
    // The title keeps at least 45% of the line no matter how many badges land.
    expect(slotClasses).toContain("max-w-[55%]");

    const title = badgeSlot.parentElement?.firstElementChild;
    expect(title?.tagName).toBe("STRONG");
    expect(title?.getAttribute("class")).toContain("min-w-0");
  });
});
