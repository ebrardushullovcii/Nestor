// @vitest-environment jsdom

import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import type { ApplicationRecord, ReviewQueueItem } from "@nestor/contracts";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApplicationsRecordsPanel } from "../screens/applications/applications-records-panel";
import { DiscoveryResultsPanel } from "../screens/discovery/discovery-results-panel";
import { ReviewQueueListPanel } from "../screens/review-queue/review-queue-list-panel";
import {
  jobFinderListRowBadgeSlotClassName,
  jobFinderListRowClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowTitleLineClassName,
} from "./list-row";

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

function createQueueItem(): ReviewQueueItem {
  return {
    jobId: "list_row_queue_01",
    title: "Role list_row_queue_01",
    company: "Acme",
    location: "Remote",
    resumeApplicationMode: "tailored_per_job",
    resumeReview: { status: "not_started" },
    assetStatus: "not_started",
    progressPercent: 0,
  } as unknown as ReviewQueueItem;
}

function createApplicationRecord(): ApplicationRecord {
  return {
    id: "list_row_application_01",
    jobId: "list_row_job_01",
    title: "Product Engineer",
    company: "Acme",
    status: "ready_for_review",
    lastActionLabel: "Resume approved",
    nextActionLabel: "Apply",
    lastUpdatedAt: "2026-08-09T08:00:00.000Z",
    lastAttemptState: "paused",
    questionSummary: {
      total: 0,
      required: 0,
      answered: 0,
      unansweredRequired: 0,
    },
    latestBlocker: null,
    consentSummary: { status: "none", pendingCount: 0 },
    replaySummary: {
      sourceInstructionArtifactId: null,
      lastUrl: null,
      checkpointCount: 0,
      evidenceCount: 0,
    },
    events: [],
    crm: null,
  } as unknown as ApplicationRecord;
}

/**
 * The structural half of a row's class list: the box (padding, border,
 * radius) and the layout mode. Colour, tint and focus tokens are deliberately
 * out of scope - selection styling belongs to the shared primitive, not to
 * this comparison.
 */
function structuralClasses(row: Element): string {
  return (row.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter((token) =>
      /^-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|border|border-[xytrbl]|rounded|grid|flex|block)(?:-|$)/.test(
        token,
      ),
    )
    .sort()
    .join(" ");
}

/**
 * Every element whose class tokens are a superset of `classes`. A list may add
 * its own sizing on top of a shared constant, so exact string equality would
 * only pin the lists that happen not to.
 */
function elementsCarrying(root: Element, classes: string): Element[] {
  const required = classes.split(/\s+/).filter((token) => token.length > 0);
  return [...root.querySelectorAll("*")].filter((element) => {
    const tokens = (element.getAttribute("class") ?? "").split(/\s+/);
    return required.every((token) => tokens.includes(token));
  });
}

function firstRow(container: HTMLElement): Element {
  const row = container.querySelector('[data-slot="selectable-row"]');
  if (!row) {
    throw new Error("Expected the panel to render a selectable row.");
  }
  return row;
}

function renderDiscoveryRow(): Element {
  const job = createSavedJob();
  const { container } = render(
    <DiscoveryResultsPanel
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
  return firstRow(container);
}

function renderReviewQueueRow(): Element {
  const { container } = render(
    <MemoryRouter>
      <ReviewQueueListPanel
        isJobPending={() => false}
        onSelectItem={vi.fn()}
        queue={[createQueueItem()]}
        selectedItem={null}
      />
    </MemoryRouter>,
  );
  return firstRow(container);
}

function renderApplicationsRow(): Element {
  const { container } = render(
    <MemoryRouter>
      <ApplicationsRecordsPanel
        activeFilter="all"
        applicationRecords={[createApplicationRecord()]}
        filterCounts={{
          all: 1,
          needs_action: 0,
          in_progress: 1,
          submitted: 0,
          manual_only: 0,
        }}
        hasAnyApplications
        onFilterChange={vi.fn()}
        onSelectRecord={vi.fn()}
        selectedRecord={null}
      />
    </MemoryRouter>,
  );
  return firstRow(container);
}

describe("one Job Finder list treatment", () => {
  it("renders Find jobs, Shortlisted and Applications rows with identical structural classes", () => {
    const discovery = structuralClasses(renderDiscoveryRow());
    cleanup();
    const reviewQueue = structuralClasses(renderReviewQueueRow());
    cleanup();
    const applications = structuralClasses(renderApplicationsRow());

    // The comparison must not pass vacuously on three empty strings.
    expect(discovery).not.toBe("");
    expect(reviewQueue).toBe(discovery);
    expect(applications).toBe(discovery);

    // And that shared shape comes from the shared constant, not from three
    // copies that happen to agree today.
    const shared = structuralClasses({
      getAttribute: () => jobFinderListRowClassName,
    } as unknown as Element);
    expect(shared).not.toBe("");
    for (const token of shared.split(" ")) {
      expect(discovery.split(" ")).toContain(token);
    }
  });

  it("puts every row's status badge in the one trailing title-line slot", () => {
    for (const [list, renderRow] of [
      ["Find jobs", renderDiscoveryRow],
      ["Shortlisted", renderReviewQueueRow],
      ["Applications", renderApplicationsRow],
    ] as const) {
      const row = renderRow();

      const badgeSlots = row.querySelectorAll(
        `[class="${jobFinderListRowBadgeSlotClassName}"]`,
      );
      // Exactly one badge slot per row: no second, floating badge line.
      expect(`${list}: ${badgeSlots.length}`).toBe(`${list}: 1`);

      const titleLine = badgeSlots[0]?.parentElement;
      expect(`${list}: ${titleLine?.getAttribute("class")}`).toBe(
        `${list}: ${jobFinderListRowTitleLineClassName}`,
      );
      // Trailing, not leading: the badge follows the title on its own line.
      expect(`${list}: ${titleLine?.lastElementChild === badgeSlots[0]}`).toBe(
        `${list}: true`,
      );

      cleanup();
    }
  });

  it("uses one title -> meta -> status line rhythm in all three lists", () => {
    for (const [list, renderRow] of [
      ["Find jobs", renderDiscoveryRow],
      ["Shortlisted", renderReviewQueueRow],
      ["Applications", renderApplicationsRow],
    ] as const) {
      const row = renderRow();
      const lines = elementsCarrying(row, jobFinderListRowLinesClassName);
      // Exactly one lines stack per row: one inner rhythm, not three.
      expect(`${list}: ${lines.length}`).toBe(`${list}: 1`);
      // And the title line lives inside it, so title -> meta -> status share
      // that single gap.
      expect(
        `${list}: ${lines[0]?.firstElementChild?.getAttribute("class")}`,
      ).toBe(`${list}: ${jobFinderListRowTitleLineClassName}`);

      cleanup();
    }
  });

  it("lets a badge-heavy row wrap its badges instead of crushing the title", () => {
    const job = createBadgeHeavyJob();
    const { container } = render(
      <DiscoveryResultsPanel
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

    const badgeSlot = firstRow(container).querySelector(
      `[class="${jobFinderListRowBadgeSlotClassName}"]`,
    );
    if (!badgeSlot) {
      throw new Error("Expected the row to render the shared badge slot.");
    }

    // Non-vacuous: this really is the crowded case the slot has to survive.
    expect(badgeSlot.childElementCount).toBeGreaterThanOrEqual(3);
    expect(badgeSlot.textContent).toContain("Strong fit");

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
