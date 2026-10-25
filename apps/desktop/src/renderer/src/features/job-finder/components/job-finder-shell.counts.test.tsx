// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  JobListRowSchema,
  type JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COUNT_VARIANT_CLASS } from "@renderer/components/ui/count";
import { cn } from "@renderer/lib/utils";

import {
  COMPACT_NAV_PILL_CLASS,
  DESTINATION_COUNT_ATTENTION_CLASS,
  DESTINATION_COUNT_INLINE_LAYOUT_CLASS,
  JobFinderShell,
  SHELL_HEADER_CLASS,
  SHELL_SIDEBAR_CLASS,
  SHELL_SIDEBAR_ROW_CLASS,
} from "./job-finder-shell";

const RENDERER_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function readSource(relativePath: string): string {
  return readFileSync(path.join(RENDERER_ROOT, relativePath), "utf8");
}

const SHELL_SOURCE = readSource(
  "features/job-finder/components/job-finder-shell.tsx",
);
const PAGE_SOURCE = readSource("pages/job-finder-page.tsx");

const windowControlsState = {
  isClosable: true,
  isFullScreen: false,
  isMaximized: false,
  isMinimizable: true,
} as const;

/**
 * A workspace with something in every population the shell badges, so a
 * regression cannot hide behind an empty collection.
 */
function createCountedWorkspace(): JobFinderRendererWorkspaceSnapshot {
  const job = JobListRowSchema.parse({
    id: "job_1",
    source: "target_site",
    sourceJobId: "synthetic",
    canonicalUrl: "https://example.test/synthetic",
    title: "Engineer I",
    company: "Acme",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    salaryText: null,
    discoveredAt: "2026-10-13T00:00:00.000Z",
    status: "discovered",
    matchAssessment: { score: 80 },
  });
  return {
    applicationRecords: [{ jobId: "job_1" }, { jobId: "job_2" }],
    campaigns: [
      { id: "campaign_1", jobIds: ["job_1", "job_2"], name: "My plan" },
      { id: "campaign_2", jobIds: [], name: "Second plan" },
    ],
    activeCampaignId: "campaign_1",
    campaignNotifications: [],
    discoveryJobs: [
      job,
      { ...job, id: "job_2", company: "Globex", title: "Engineer II" },
    ],
    intelligence: {
      companies: [
        {
          id: "company_1",
          mergeReviewCandidates: [{ decision: "pending" }],
        },
        { id: "company_2", mergeReviewCandidates: [] },
      ],
      groupedDecisions: [],
      outcomeEvents: [{ id: "outcome_1" }],
      resumeStrategies: [{ id: "strategy_1" }],
      safeguards: {
        abnormalFailurePauses: [],
        companyApplicationCaps: [{ id: "cap_1", limitReached: true }],
        contradictoryAnswerDetections: [],
        listingSignals: [],
        preparedBatchSampleReviews: [],
        safeguardDismissals: [],
        simultaneousApplicationConflicts: [],
        updatedAt: null,
      },
    },
    profileSetupState: {
      completedAt: null,
      currentStep: "import",
      lastResumedAt: null,
      reviewItems: [],
      status: "not_started",
    },
    reviewQueue: [{ jobId: "job_1" }],
    userActionRequests: [{ id: "request_1", state: "pending" }],
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

/**
 * The shell renders the wide sidebar and the compact top navigation from the
 * same definitions and hides the wrong one with CSS, so both are in the DOM at
 * every width in jsdom. Width therefore only decides which surface a user
 * sees; the class strings this file compares are the ones that would paint at
 * 1439px (compact navigation) and 1441px (sidebar).
 */
function renderShell(workspace: JobFinderRendererWorkspaceSnapshot) {
  return render(
    <MemoryRouter initialEntries={["/job-finder/home"]}>
      <JobFinderShell platform="win32" workspace={workspace}>
        <div>Current screen</div>
      </JobFinderShell>
    </MemoryRouter>,
  );
}

function getCompactNavigation(): HTMLElement {
  return screen.getByRole("navigation", { name: "Job Finder sections" });
}

function getSidebar(): HTMLElement {
  return screen.getByRole("complementary", { name: "Job Finder sidebar" });
}

beforeEach(() => {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      window: {
        close: vi.fn().mockResolvedValue(undefined),
        getControlsState: vi.fn().mockResolvedValue(windowControlsState),
        minimize: vi.fn().mockResolvedValue(windowControlsState),
        onControlsStateChange: vi.fn(() => vi.fn()),
        toggleMaximize: vi.fn().mockResolvedValue(windowControlsState),
      },
    },
    writable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("shell destination counts", () => {
  it("renders a visibly distinct treatment for attention counts", () => {
    renderShell(createCountedWorkspace());

    const sidebar = getSidebar();
    const findJobs = within(sidebar).getByRole("button", {
      name: /^Find jobs/,
    });
    const needsYou = screen.getByRole("button", { name: /^Needs you:/ });

    const inventoryBadge = findJobs.querySelector('[data-slot="count"]');
    const attentionBadge = needsYou.querySelector("span.tabular-nums");

    // The shape is the shared `<Count variant="pill">` primitive; the shell
    // adds only its own row placement. Composed the same way the component
    // does, so the exact painted string is still pinned.
    expect(inventoryBadge?.className).toBe(
      cn(COUNT_VARIANT_CLASS.pill, DESTINATION_COUNT_INLINE_LAYOUT_CLASS),
    );
    expect(attentionBadge?.className).toBe(DESTINATION_COUNT_ATTENTION_CLASS);
    expect(inventoryBadge?.className).not.toBe(attentionBadge?.className);

    // A bare number always means inventory, so the attention count also
    // carries a noun rather than standing alone beside the destination name.
    expect(attentionBadge?.textContent).toContain("unresolved");
    expect(needsYou.getAttribute("aria-label")).toMatch(
      /^Needs you: \d+ unresolved$/,
    );
    // The inventory count stays visual-only; the destination name is the sole
    // announced content.
    expect(inventoryBadge?.getAttribute("aria-hidden")).toBe("true");
  });

  it("never renders a badge at zero", () => {
    const workspace = createCountedWorkspace();
    // Empty every population the shell badges.
    (workspace as unknown as Record<string, unknown>).applicationRecords = [];
    (workspace as unknown as Record<string, unknown>).reviewQueue = [];
    (workspace as unknown as Record<string, unknown>).discoveryJobs = [];
    (workspace as unknown as Record<string, unknown>).userActionRequests = [];
    (workspace as unknown as Record<string, unknown>).campaigns = [
      { id: "campaign_1", jobIds: [], name: "Default plan" },
    ];
    (workspace as unknown as Record<string, unknown>).intelligence = {
      companies: [{ id: "company_1", mergeReviewCandidates: [] }],
      groupedDecisions: [],
      outcomeEvents: [],
      resumeStrategies: [],
      safeguards: {
        abnormalFailurePauses: [],
        companyApplicationCaps: [],
        contradictoryAnswerDetections: [],
        listingSignals: [],
        preparedBatchSampleReviews: [],
        safeguardDismissals: [],
        simultaneousApplicationConflicts: [],
        updatedAt: null,
      },
    };

    renderShell(workspace);

    for (const root of [getSidebar(), getCompactNavigation()]) {
      const counts = Array.from(
        root.querySelectorAll<HTMLElement>("span.tabular-nums"),
      );
      for (const count of counts) {
        expect(count.textContent?.trim()).not.toBe("0");
      }
    }
    // The lone default plan is not a count worth a badge either.
    expect(
      within(getSidebar())
        .queryByRole("button", { name: /^Search plans/ })
        ?.querySelector("span.tabular-nums"),
    ).toBeFalsy();
  });

  it("paints one identical count class at 1439px and 1441px", () => {
    renderShell(createCountedWorkspace());

    // 1439px paints the compact top navigation; 1441px paints the sidebar.
    const compactCount = within(getCompactNavigation())
      .getByRole("button", { name: /^Applications/ })
      .querySelector("span.tabular-nums");
    const wideCount = within(getSidebar())
      .getByRole("button", { name: /^Applications/ })
      .querySelector("span.tabular-nums");

    expect(compactCount?.textContent).toBe(wideCount?.textContent);
    // COMP-07: the same count used to be a plain number at 1441 and a filled
    // pill at 1439 — one number, two shapes, one breakpoint apart.
    expect(compactCount?.className).toBe(wideCount?.className);
    expect(compactCount?.className).toBe(
      cn(COUNT_VARIANT_CLASS.pill, DESTINATION_COUNT_INLINE_LAYOUT_CLASS),
    );
  });

  it("gives the More trigger the same pill class as its neighbours", () => {
    renderShell(createCountedWorkspace());

    const navigation = getCompactNavigation();
    const moreButton = within(navigation).getByRole("button", {
      name: /^More/,
    });
    const neighbour = within(navigation).getByRole("button", {
      name: /^Find jobs/,
    });

    for (const token of COMPACT_NAV_PILL_CLASS.split(/\s+/)) {
      expect(moreButton.className).toContain(token);
      expect(neighbour.className).toContain(token);
    }
    expect(moreButton.className).not.toContain("bg-(--surface-panel-raised)");
    expect(moreButton.className).not.toContain("min-h-10");
  });
});

describe("shell chrome ownership", () => {
  it("has the opening shell consume the exported chrome instead of copying it", () => {
    // The opening frame used to hold seventeen hand-copied class strings kept
    // honest only by a parity test. It now imports them, so the two shells
    // cannot drift and the geometry delta is 0 by construction.
    for (const exported of [
      "SHELL_HEADER_CLASS",
      "SHELL_HEADER_GRID_CLASS",
      "SHELL_BRAND_ROW_CLASS",
      "SHELL_SIDEBAR_CLASS",
      "SHELL_SIDEBAR_ROW_CLASS",
      "SHELL_SIDEBAR_ROW_COLLAPSED_CLASS",
      "SHELL_SIDEBAR_ROW_INACTIVE_CLASS",
      "SHELL_SIDEBAR_ROW_ACTIVE_CLASS",
      "SHELL_CONTENT_CLASS",
      "SHELL_MAIN_SCROLLING_CLASS",
      "SHELL_MAIN_LOCKED_CLASS",
      "SHELL_ROUTE_CONTAINER_BASE_CLASS",
      "COMPACT_NAV_PILL_CLASS",
      "COMPACT_NAV_PILL_ACTIVE_CLASS",
      "LOCKED_LAYOUT_SCREENS",
    ]) {
      expect(SHELL_SOURCE).toContain(`export const ${exported}`);
      expect(PAGE_SOURCE).toContain(exported);
    }
    // No `OPENING_SHELL_*` chrome copy survives.
    expect(PAGE_SOURCE).not.toMatch(/const OPENING_SHELL_[A-Z_]*CLASS\s*=/);

    // The strings the loaded shell actually paints are the exported ones.
    renderShell(createCountedWorkspace());
    expect(
      document.querySelector("[data-job-finder-shell-header]")?.className,
    ).toBe(SHELL_HEADER_CLASS);
    expect(getSidebar().className).toBe(SHELL_SIDEBAR_CLASS);
    expect(
      within(getSidebar())
        .getByRole("button", { name: /^Settings/ })
        .className.startsWith(SHELL_SIDEBAR_ROW_CLASS),
    ).toBe(true);
  });

  it("uses shared tokens for the sticky shell edges and the search scrim", () => {
    expect(SHELL_HEADER_CLASS).toContain(
      "border-(--surface-panel-shell-border)",
    );
    expect(SHELL_SIDEBAR_CLASS).toContain(
      "border-(--surface-panel-shell-border)",
    );
    // Class usage only: a docblock may still name the retired dilution to
    // explain why it was retired.
    for (const source of [SHELL_SOURCE, PAGE_SOURCE]) {
      expect(source).not.toMatch(/border-[a-z]+ border-border\/15/);
    }

    const globalSearchSource = readSource(
      "features/job-finder/components/job-finder-global-search.tsx",
    );
    expect(globalSearchSource).not.toContain("bg-black/40");
    expect(globalSearchSource).toContain("bg-(--modal-scrim)");
  });

  it("declares one route-section gap token on the route wrapper", () => {
    renderShell(createCountedWorkspace());

    const container = document.querySelector<HTMLElement>(
      "[data-job-finder-route-container]",
    );
    expect(container).toBeTruthy();
    expect(container?.style.getPropertyValue("--gap-route-section")).toBe(
      "var(--gap-card)",
    );
    expect(PAGE_SOURCE).toContain("SHELL_ROUTE_SECTION_GAP_STYLE");
  });
});
