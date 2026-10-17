import { SavedJobSchema } from "@nestor/contracts";
// @vitest-environment jsdom

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JobSearchPreferences,
  SavedJob,
  SourceAccessPrompt,
} from "@nestor/contracts";
import {
  DiscoveryFiltersPanel,
  getDiscoveryOtherActiveCriteria,
} from "./discovery-filters-panel";
import { DiscoverySearchSections } from "./discovery-filters-panel-sections";
import { DiscoveryResultsPanel } from "./discovery-results-panel";
import {
  DISCOVERY_OFFLINE_CATALOG_NOTICE,
  DISCOVERY_OFFLINE_SETUP_NOTICE,
} from "./discovery-search-readiness";

function CurrentPath() {
  const location = useLocation();
  return (
    <span data-testid="current-path">
      {location.pathname}
      {location.search}
    </span>
  );
}

describe("DiscoveryFiltersPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("makes the current-search details an independent wheel and keyboard scroll region", () => {
    const searchPreferences: JobSearchPreferences = {
      targetRoles: ["Software Engineer"],
      jobFamilies: [],
      locations: ["Remote"],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: { historyLimit: 5, targets: [] },
    };

    const {
      container,
      getAllByRole,
      getByRole,
      getByText,
      queryByRole,
      queryByText,
    } = render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <DiscoveryFiltersPanel
                  activeRun={null}
                  browserSession={{
                    source: "target_site",
                    status: "unknown",
                    driver: "catalog_seed",
                    label: "Browser optional",
                    detail: "The browser is only needed for sign-in.",
                    lastCheckedAt: "2026-03-20T10:00:00.000Z",
                  }}
                  discoverySessions={[]}
                  isBrowserSessionPending={false}
                  isBrowserSessionPendingForTarget={() => false}
                  isDiscoveryAllPending={false}
                  isTargetPending={() => false}
                  planEditorHref="/job-finder/campaigns?campaignId=plan-a"
                  onOpenBrowserSession={vi.fn()}
                  onOpenBrowserSessionForTarget={vi.fn()}
                  onRunAgentDiscovery={vi.fn()}
                  onViewProgress={vi.fn()}
                  searchPreferences={searchPreferences}
                  sourceAccessPrompts={[]}
                />
                <CurrentPath />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const scrollRegion = getByRole("region", {
      name: "Current search details",
    });
    expect(
      scrollRegion.getAttribute("data-locked-pane-scroll-region"),
    ).not.toBeNull();
    expect(scrollRegion.getAttribute("tabindex")).toBe("0");
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(scrollRegion.className).toContain("overscroll-contain");

    // Action hierarchy in Search setup: when no sources are enabled, Add
    // sources is the primary command, Search jobs stays disabled/secondary,
    // the offline catalog has no browser action, and Search history stays a
    // quiet secondary control rather than a lone underlined link.
    const searchButtons = getAllByRole("button", { name: "Search jobs" });
    expect(searchButtons).toHaveLength(1);
    expect(searchButtons[0]?.getAttribute("data-variant")).toBe("secondary");
    const addSourceActions = getAllByRole("button", { name: "Add sources" });
    expect(
      addSourceActions.some(
        (action) => action.getAttribute("data-variant") === "primary",
      ),
    ).toBe(true);
    expect(
      queryByRole("button", { name: "Open the Job Finder browser" }),
    ).toBeNull();
    expect(queryByText("Search unavailable")).not.toBeNull();
    const historyButton = getByRole("button", { name: "Search history" });
    expect(historyButton.getAttribute("data-variant")).toBe("outline");
    expect(historyButton.className).not.toContain("col-span-2");

    // The decorative Browser/Search scope pill is gone; the status badge
    // carries a non-color glyph instead.
    expect(queryByText("Search")).toBeNull();
    expect(
      container.querySelector(
        "[data-testid='discovery-browser-status'] svg[aria-hidden='true']",
      ),
    ).not.toBeNull();
    expect(queryByText(/^Other active criteria/)).toBeNull();

    fireEvent.click(getByRole("button", { name: "Edit your places" }));
    expect(getByText("/job-finder/campaigns?campaignId=plan-a")).toBeTruthy();
  });

  it("describes complete filters as review-only when the runtime is catalog-only", () => {
    const searchPreferences: JobSearchPreferences = {
      targetRoles: ["Software Engineer"],
      jobFamilies: [],
      locations: ["Remote"],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: "catalog-source",
            label: "Catalog source",
            startingUrl: "https://example.com/jobs",
            enabled: true,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "draft",
            validatedInstructionId: null,
            draftInstructionId: null,
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
        ],
      },
    };

    const { getByRole, getByText, queryByText } = render(
      <MemoryRouter>
        <DiscoveryFiltersPanel
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "catalog_seed",
            label: "Offline catalog",
            detail: "The browser is only needed for sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isTargetPending={() => false}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onViewProgress={vi.fn()}
          searchPreferences={searchPreferences}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );

    expect(getByText(DISCOVERY_OFFLINE_SETUP_NOTICE)).toBeTruthy();
    expect(
      getByRole("button", { name: "Search jobs" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(queryByText(/Search setup is ready/iu)).toBeNull();
  });

  it("discloses configured omitted preferences and hard exclusions in a collapsed native control", () => {
    const searchPreferences: JobSearchPreferences = {
      targetRoles: ["Software Engineer"],
      jobFamilies: ["Engineering"],
      locations: ["Remote"],
      excludedLocations: ["Antarctica"],
      workModes: ["remote"],
      seniorityLevels: ["Senior"],
      targetIndustries: ["Climate tech"],
      targetCompanyStages: ["Series B"],
      employmentTypes: ["Full-time"],
      minimumSalaryUsd: 120_000,
      targetSalaryUsd: 160_000,
      salaryCurrency: "USD",
      compensation: {
        minimum: 120_000,
        maximum: 160_000,
        interval: "year",
        currency: "USD",
        currencyStatus: "explicit",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: ["Blocked Corp"],
      companyWhitelist: ["Preferred Inc"],
      discovery: {
        collectOnlyHardCriteriaMatches: true,
        historyLimit: 5,
        runJobBudget: 500,
        targets: [],
      },
    };
    const criteria = getDiscoveryOtherActiveCriteria(searchPreferences);

    // Hours are no longer folded in here: they have their own labelled row on
    // the open panel, so this disclosure holds only the criteria that stay
    // secondary.
    expect(criteria.preferences.map(({ label }) => label)).toEqual([
      "Kinds of role",
      "Seniority",
      "Industries",
      "Company stages",
      "Preferred companies",
      "Minimum compensation",
      "Target compensation",
      "Collection limit",
    ]);
    expect(criteria.hardExclusions.map(({ label }) => label)).toEqual([
      "Excluded locations",
      "Excluded companies",
      "Strict collection",
    ]);

    const { container, getByRole, getByText } = render(
      <MemoryRouter>
        <DiscoveryFiltersPanel
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "catalog_seed",
            label: "Browser optional",
            detail: "The browser is only needed for sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isTargetPending={() => false}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onViewProgress={vi.fn()}
          searchPreferences={searchPreferences}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );

    const disclosure = container.querySelector("details");
    const summary = getByText(
      "Other active criteria (11, including 3 hard exclusions)",
    );
    expect(disclosure?.open).toBe(false);
    expect(summary.tagName).toBe("SUMMARY");

    fireEvent.click(summary);

    expect(disclosure?.open).toBe(true);
    expect(
      getByRole("region", { name: "Other search preferences" }).textContent,
    ).toContain("Minimum compensation: 120,000 USD per year");
    expect(
      getByRole("region", { name: "Other search preferences" }).textContent,
    ).toContain("Collection limit: 500 jobs per run");
    expect(
      getByRole("region", { name: "Hard exclusions" }).textContent,
    ).toContain("Excluded companies: Blocked Corp");
    expect(
      getByRole("region", { name: "Hard exclusions" }).textContent,
    ).toContain("Strict collection: Only jobs meeting hard criteria");
  });

  it("renders saved criteria as one flat read-only summary line per section", () => {
    const longSource =
      "https://careers.example.test/this-is-an-extremely-long-source-label-without-spaces";
    const { container } = render(
      <MemoryRouter>
        <DiscoverySearchSections
          sectionHeadingPrefix="discovery-filter"
          sections={[
            {
              empty: "No sources",
              label: "Sources",
              values: [longSource, "Greenhouse"],
            },
          ]}
        />
      </MemoryRouter>,
    );

    // Saved values are inert facts, not controls: one plain text summary with
    // strong contrast, wrapping support for long tokens, and no border,
    // tooltip, hover target, or interactive descendant.
    const summary = container.querySelector("section p");
    expect(summary?.textContent).toBe(`${longSource} · Greenhouse`);
    expect(summary?.className).toContain("text-foreground");
    expect(summary?.className).toContain("[overflow-wrap:anywhere]");
    expect(container.querySelector("[title]")).toBeNull();
    expect(summary?.querySelector("button, a, span")).toBeNull();
  });

  it("renders an empty setup section as one compact row with an inline edit action", () => {
    const { container, getByRole } = render(
      <MemoryRouter>
        <DiscoverySearchSections
          sectionHeadingPrefix="discovery-filter"
          sections={[
            {
              editAction: {
                href: "/job-finder/profile?section=preferences&focus=target-roles",
                label: "Add roles",
              },
              empty: "No roles added yet.",
              label: "Roles",
              values: [],
            },
          ]}
        />
      </MemoryRouter>,
    );

    const section = container.querySelector("section");
    expect(section?.className).toContain("py-2.5");
    expect(section?.className).not.toContain("py-4");
    expect(section?.textContent).toContain("No roles added yet.");
    // A real button, so Enter and Space activate it the way the browser
    // activates every other control in the panel.
    const editAction = getByRole("button", { name: "Add roles" });
    expect(editAction.tagName).toBe("BUTTON");
    expect(editAction.getAttribute("type")).toBe("button");
  });

  it("opens the role editor from the keyboard-activatable Add roles control", () => {
    function LocationProbe() {
      const location = useLocation();
      return (
        <span
          data-test-location
        >{`${location.pathname}${location.search}`}</span>
      );
    }

    const { container, getByRole } = render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <LocationProbe />
        <Routes>
          <Route
            element={
              <DiscoverySearchSections
                sectionHeadingPrefix="discovery-filter"
                sections={[
                  {
                    editAction: {
                      href: "/job-finder/profile?section=preferences&focus=target-roles",
                      label: "Add roles",
                    },
                    empty: "No roles added yet.",
                    label: "Roles",
                    values: [],
                  },
                ]}
              />
            }
            path="/job-finder/discovery"
          />
          <Route element={<span>Profile</span>} path="/job-finder/profile" />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(getByRole("button", { name: "Add roles" }));

    expect(container.querySelector("[data-test-location]")?.textContent).toBe(
      "/job-finder/profile?section=preferences&focus=target-roles",
    );
  });

  it("gives hours their own labelled row instead of hiding them in the disclosure", () => {
    const searchPreferences: JobSearchPreferences = {
      targetRoles: ["Software Engineer"],
      jobFamilies: [],
      locations: ["Chicago, IL"],
      excludedLocations: [],
      workModes: ["hybrid"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: ["Part-time", "Contract"],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: { historyLimit: 5, targets: [] },
    };

    // The stored preference is the one Preferences writes; nothing is
    // recomputed or duplicated for this row.
    expect(
      getDiscoveryOtherActiveCriteria(searchPreferences).preferences.map(
        ({ label }) => label,
      ),
    ).not.toContain("Full-time or part-time");

    const { getByRole, queryByText } = render(
      <MemoryRouter>
        <DiscoveryFiltersPanel
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "catalog_seed",
            label: "Browser optional",
            detail: "The browser is only needed for sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isTargetPending={() => false}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onViewProgress={vi.fn()}
          searchPreferences={searchPreferences}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );

    const hours = getByRole("region", { name: "Full-time or part-time" });
    expect(hours.textContent).toContain("Part-time");
    expect(hours.textContent).toContain("Contract");
    expect(
      within(hours).getByRole("button", { name: "Edit hours" }),
    ).toBeTruthy();
    // The old trade name is gone from the panel entirely.
    expect(queryByText("Employment types")).toBeNull();
  });

  it("says unset hours are not a missing setup step", () => {
    const searchPreferences: JobSearchPreferences = {
      targetRoles: ["Software Engineer"],
      jobFamilies: [],
      locations: ["Chicago, IL"],
      excludedLocations: [],
      workModes: ["hybrid"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: { historyLimit: 5, targets: [] },
    };

    const { getByRole } = render(
      <MemoryRouter>
        <DiscoveryFiltersPanel
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "catalog_seed",
            label: "Browser optional",
            detail: "The browser is only needed for sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isTargetPending={() => false}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onViewProgress={vi.fn()}
          searchPreferences={searchPreferences}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );

    const hours = getByRole("region", { name: "Full-time or part-time" });
    expect(hours.textContent).toContain(
      "Not set — results can be full-time or part-time.",
    );
    expect(
      within(hours)
        .getByRole("button", { name: "Set hours" })
        .getAttribute("data-variant"),
    ).toBe("secondary");
  });

  it("surfaces inline recovery actions for every empty setup section", () => {
    const emptySearchPreferences: JobSearchPreferences = {
      targetRoles: [],
      jobFamilies: [],
      locations: [],
      excludedLocations: [],
      workModes: [],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: { historyLimit: 5, targets: [] },
    };

    const { getByRole, getAllByRole } = render(
      <MemoryRouter>
        <DiscoveryFiltersPanel
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "catalog_seed",
            label: "Browser optional",
            detail: "The browser is only needed for sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isTargetPending={() => false}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={vi.fn()}
          onRunAgentDiscovery={vi.fn()}
          onViewProgress={vi.fn()}
          searchPreferences={emptySearchPreferences}
          sourceAccessPrompts={[]}
        />
      </MemoryRouter>,
    );

    expect(getByRole("button", { name: "Add roles" }).tagName).toBe("BUTTON");
    // Only the first empty section is the primary start; the rest are
    // secondary so the column has one obvious next step.
    expect(
      getByRole("button", { name: "Add roles" }).getAttribute("data-variant"),
    ).toBe("primary");
    expect(
      getByRole("button", { name: "Edit your places" }).getAttribute(
        "data-variant",
      ),
    ).toBe("secondary");
    expect(
      getByRole("button", { name: "Set work modes" }).getAttribute(
        "data-variant",
      ),
    ).toBe("secondary");
    expect(getByRole("button", { name: "Edit your places" })).toBeTruthy();
    expect(getByRole("button", { name: "Set work modes" })).toBeTruthy();
    expect(
      getAllByRole("button", { name: "Add sources" }).length,
    ).toBeGreaterThan(0);

    // Sources saved but all disabled must not read as "no sources added yet".
    cleanup();
    const disabledOnlyPreferences: JobSearchPreferences = {
      ...emptySearchPreferences,
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: "target_disabled",
            label: "Paused Board",
            startingUrl: "https://paused.example/jobs",
            enabled: false,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "draft",
            validatedInstructionId: null,
            draftInstructionId: null,
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
        ],
      },
    };

    const { getByText: getDisabledText, getAllByRole: getDisabledAllByRole } =
      render(
        <MemoryRouter>
          <DiscoveryFiltersPanel
            activeRun={null}
            browserSession={{
              source: "target_site",
              status: "unknown",
              driver: "catalog_seed",
              label: "Browser optional",
              detail: "The browser is only needed for sign-in.",
              lastCheckedAt: "2026-03-20T10:00:00.000Z",
            }}
            discoverySessions={[]}
            isBrowserSessionPending={false}
            isBrowserSessionPendingForTarget={() => false}
            isDiscoveryAllPending={false}
            isTargetPending={() => false}
            onOpenBrowserSession={vi.fn()}
            onOpenBrowserSessionForTarget={vi.fn()}
            onRunAgentDiscovery={vi.fn()}
            onViewProgress={vi.fn()}
            searchPreferences={disabledOnlyPreferences}
            sourceAccessPrompts={[]}
          />
        </MemoryRouter>,
      );

    expect(getDisabledText("1 source saved, none enabled yet.")).toBeTruthy();
    const enableSourceActions = getDisabledAllByRole("button", {
      name: "Enable sources",
    });
    expect(enableSourceActions.length).toBeGreaterThan(0);
    expect(
      enableSourceActions.every((action) => action.tagName === "BUTTON"),
    ).toBe(true);
  });

  it("shows a source-aware sign-in prompt near the search controls", () => {
    const onOpenBrowserSessionForTarget = vi.fn();
    const onRunDiscoveryForTarget = vi.fn();
    const searchPreferences: JobSearchPreferences = {
      targetRoles: ["Principal Designer"],
      jobFamilies: [],
      locations: ["Remote"],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: "target_linkedin_default",
            label: "LinkedIn",
            startingUrl: "https://www.linkedin.com/jobs/search/",
            enabled: true,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "draft",
            validatedInstructionId: null,
            draftInstructionId: "instruction_1",
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
        ],
      },
    };
    const sourceAccessPrompt: SourceAccessPrompt = {
      targetId: "target_linkedin_default",
      targetLabel: "LinkedIn",
      targetUrl: "https://www.linkedin.com/jobs/search/",
      state: "prompt_login_required",
      summary: "Sign in to LinkedIn before the next search can continue.",
      detail: "Please sign in first.",
      actionLabel: "Sign in to LinkedIn",
      rerunLabel: "Search again after sign-in",
      updatedAt: "2026-03-20T10:01:00.000Z",
    };

    const { container } = render(
      <MemoryRouter>
        <DiscoveryFiltersPanel
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "login_required",
            driver: "catalog_seed",
            label: "Browser session needs sign-in",
            detail: "A saved source needs sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          discoverySessions={[
            {
              adapterKind: "target_site",
              status: "login_required",
              driver: "chrome_profile_agent",
              label: "Browser session needs sign-in",
              detail: "A saved source needs sign-in.",
              lastCheckedAt: "2026-03-20T10:00:00.000Z",
            },
          ]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isTargetPending={() => false}
          onOpenBrowserSession={vi.fn()}
          onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
          onRunAgentDiscovery={vi.fn()}
          onRunDiscoveryForTarget={onRunDiscoveryForTarget}
          onViewProgress={vi.fn()}
          searchPreferences={searchPreferences}
          sourceAccessPrompts={[sourceAccessPrompt]}
        />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain(
      "Sign in to LinkedIn before the next search can continue.",
    );
    expect(container.textContent).toContain("Please sign in first.");
    expect(container.textContent).toContain("I'm signed in — retry LinkedIn");
    expect(
      container.textContent?.match(
        /Sign in to LinkedIn before the next search can continue\./g,
      ),
    ).toHaveLength(1);

    const signInPrompt = container.querySelector<HTMLElement>(
      '[role="status"][aria-live="polite"]',
    );
    if (!signInPrompt) {
      throw new Error("Expected the source sign-in prompt status region.");
    }

    const signInButton = within(signInPrompt).getByRole("button", {
      name: /sign in to linkedin/i,
    });

    fireEvent.click(signInButton);

    expect(onOpenBrowserSessionForTarget).toHaveBeenCalledWith(
      "target_linkedin_default",
    );

    fireEvent.click(
      within(signInPrompt).getByRole("button", {
        name: /i'm signed in — retry linkedin/i,
      }),
    );

    expect(onRunDiscoveryForTarget).toHaveBeenCalledWith(
      "target_linkedin_default",
    );
    expect(container.textContent).toContain(
      "Job Finder waits here and never handles your credentials.",
    );

    // Run one source offers a real secondary button beside the source name,
    // not label-shaped text inside a full-width row.
    const runOneSource = within(container).getByRole("button", {
      name: "Run discovery for LinkedIn",
    });
    expect(runOneSource.textContent).toBe("Search only this source");
    expect(runOneSource.getAttribute("data-variant")).toBe("secondary");
    expect(runOneSource.className).toContain("shrink-0");
  });

  it("ignores disabled-target prompts for the primary sign-in CTA", () => {
    const onOpenBrowserSession = vi.fn();
    const onOpenBrowserSessionForTarget = vi.fn();
    const searchPreferences: JobSearchPreferences = {
      targetRoles: ["Principal Designer"],
      jobFamilies: [],
      locations: ["Remote"],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: "target_disabled",
            label: "Disabled source",
            startingUrl: "https://disabled.example/jobs",
            enabled: false,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "draft",
            validatedInstructionId: null,
            draftInstructionId: null,
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
          {
            id: "target_enabled",
            label: "Enabled source",
            startingUrl: "https://enabled.example/jobs",
            enabled: true,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "draft",
            validatedInstructionId: null,
            draftInstructionId: null,
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
        ],
      },
    };
    const sourceAccessPrompts: SourceAccessPrompt[] = [
      {
        targetId: "target_disabled",
        targetLabel: "Disabled source",
        targetUrl: "https://disabled.example/jobs",
        state: "prompt_login_required",
        summary: "Sign in to Disabled source.",
        detail: null,
        actionLabel: "Sign in to Disabled source",
        rerunLabel: "search again",
        updatedAt: "2026-03-20T10:01:00.000Z",
      },
      {
        targetId: "target_enabled",
        targetLabel: "Enabled source",
        targetUrl: "https://enabled.example/jobs",
        state: "prompt_login_required",
        summary: "Sign in to Enabled source.",
        detail: null,
        actionLabel: "Sign in to Enabled source",
        rerunLabel: "search again",
        updatedAt: "2026-03-20T10:02:00.000Z",
      },
    ];

    const { getAllByRole, container } = render(
      <MemoryRouter>
        <DiscoveryFiltersPanel
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "login_required",
            driver: "chrome_profile_agent",
            label: "Browser session needs sign-in",
            detail: "A saved source needs sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isTargetPending={() => false}
          onOpenBrowserSession={onOpenBrowserSession}
          onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
          onRunAgentDiscovery={vi.fn()}
          onRunDiscoveryForTarget={vi.fn()}
          onViewProgress={vi.fn()}
          searchPreferences={searchPreferences}
          sourceAccessPrompts={sourceAccessPrompts}
        />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("Sign in to Enabled source.");
    expect(container.textContent).not.toContain("Sign in to Disabled source.");

    const primaryPrompt = getAllByRole("status").find((element) =>
      element.textContent?.includes("Sign in to Enabled source."),
    );
    expect(primaryPrompt).toBeDefined();

    if (!primaryPrompt) {
      throw new Error("Expected enabled-source sign-in prompt to be rendered.");
    }

    const enabledSourceButton = within(primaryPrompt).getByRole("button", {
      name: /sign in to enabled source/i,
    });

    fireEvent.click(enabledSourceButton);

    expect(onOpenBrowserSessionForTarget).toHaveBeenCalledWith(
      "target_enabled",
    );
    expect(onOpenBrowserSession).not.toHaveBeenCalled();
  });

  it("keeps the main browser CTA generic when sign-in is only recommended", () => {
    const onOpenBrowserSession = vi.fn();
    const onOpenBrowserSessionForTarget = vi.fn();
    const searchPreferences: JobSearchPreferences = {
      targetRoles: ["Principal Designer"],
      jobFamilies: [],
      locations: ["Remote"],
      excludedLocations: [],
      workModes: ["remote"],
      seniorityLevels: [],
      targetIndustries: [],
      targetCompanyStages: [],
      employmentTypes: [],
      minimumSalaryUsd: null,
      targetSalaryUsd: null,
      salaryCurrency: "USD",
      compensation: {
        minimum: null,
        maximum: null,
        interval: "year",
        currency: "USD",
        currencyStatus: "inherited",
      },
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      companyBlacklist: [],
      companyWhitelist: [],
      discovery: {
        historyLimit: 5,
        targets: [
          {
            id: "target_greenhouse",
            label: "GreenHouse",
            startingUrl: "https://boards.greenhouse.io/remotecoin/jobs",
            enabled: true,
            adapterKind: "auto",
            customInstructions: null,
            instructionStatus: "draft",
            validatedInstructionId: null,
            draftInstructionId: null,
            lastDebugRunId: null,
            lastVerifiedAt: null,
            staleReason: null,
          },
        ],
      },
    };
    const sourceAccessPrompts: SourceAccessPrompt[] = [
      {
        targetId: "target_greenhouse",
        targetLabel: "GreenHouse",
        targetUrl: "https://boards.greenhouse.io/remotecoin/jobs",
        state: "prompt_login_recommended",
        summary:
          "Open the Job Finder browser for GreenHouse if you want better search coverage on the next run.",
        detail:
          "Jobs are visible without login, but the browser can improve coverage.",
        actionLabel: "Open the Job Finder browser for GreenHouse",
        rerunLabel: "Search again for fuller results",
        updatedAt: "2026-03-20T10:01:00.000Z",
      },
    ];

    const { getByRole, queryByRole, getByText, queryByText } = render(
      <MemoryRouter>
        <DiscoveryFiltersPanel
          activeRun={null}
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "chrome_profile_agent",
            label: "Browser starting",
            detail:
              "The dedicated browser profile is closed. It will reopen automatically when the next run starts.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          discoverySessions={[]}
          isBrowserSessionPending={false}
          isBrowserSessionPendingForTarget={() => false}
          isDiscoveryAllPending={false}
          isTargetPending={() => false}
          onOpenBrowserSession={onOpenBrowserSession}
          onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
          onRunAgentDiscovery={vi.fn()}
          onRunDiscoveryForTarget={vi.fn()}
          onViewProgress={vi.fn()}
          searchPreferences={searchPreferences}
          sourceAccessPrompts={sourceAccessPrompts}
        />
      </MemoryRouter>,
    );

    expect(
      getByText(
        "The browser can improve coverage for sources that support sign-in.",
      ),
    ).toBeTruthy();
    expect(
      queryByText(
        "Open the Job Finder browser. Useful if a job site needs you to sign in.",
      ),
    ).toBeNull();
    // The chip states what is not open; the heading above it says which
    // thing this block is about.
    expect(getByText("Browser not open")).toBeTruthy();
    expect(getByText("Job Finder browser")).toBeTruthy();
    expect(queryByRole("button", { name: "Sign in to GreenHouse" })).toBeNull();

    fireEvent.click(
      getByRole("button", { name: "Open the Job Finder browser" }),
    );

    expect(onOpenBrowserSession).toHaveBeenCalledTimes(1);
    expect(onOpenBrowserSessionForTarget).not.toHaveBeenCalled();
  });

  it("shows a primary recovery action inside blocked results", () => {
    const onRecoveryAction = vi.fn();
    const { container, getByText } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "login_required",
            driver: "chrome_profile_agent",
            label: "Browser session needs sign-in",
            detail: "A saved source needs sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          jobs={[]}
          onRecoveryAction={onRecoveryAction}
          onSelectJob={vi.fn()}
          recoveryActionLabel="Sign in to LinkedIn"
          recoveryActionNextStep="Then search again after sign-in."
          recoveryActionPending={false}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(getByText("Next step")).toBeTruthy();
    fireEvent.click(
      within(container).getByRole("button", { name: "Sign in to LinkedIn" }),
    );
    expect(onRecoveryAction).toHaveBeenCalledTimes(1);
  });

  it("keeps a primary recovery action visible when blocked state still shows stale results", () => {
    const onRecoveryAction = vi.fn();
    const { container, getByText } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "login_required",
            driver: "chrome_profile_agent",
            label: "Browser session needs sign-in",
            detail: "A saved source needs sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          jobs={[
            SavedJobSchema.parse({
              id: "job_1",
              source: "target_site",
              sourceJobId: "job_1",
              discoveryMethod: "catalog_seed",
              collectionMethod: "fallback_search",
              canonicalUrl: "https://example.com/job-1",
              applicationUrl: "https://example.com/job-1/apply",
              title: "Principal Designer",
              company: "Acme",
              location: "Remote",
              workMode: ["remote"],
              easyApplyEligible: true,
              discoveredAt: "2026-03-20T10:00:00.000Z",
              firstSeenAt: "2026-03-20T10:00:00.000Z",
              lastSeenAt: "2026-03-20T10:00:00.000Z",
              lastVerifiedActiveAt: "2026-03-20T10:00:00.000Z",
              employmentType: null,
              salaryText: null,
              normalizedCompensation: {
                currency: null,
                interval: null,
                minAmount: null,
                maxAmount: null,
                minAnnualUsd: null,
                maxAnnualUsd: null,
              },
              detailQuality: "card_only",
              summary: "Strong fit",
              seniority: null,
              postedAt: null,
              postedAtText: null,
              providerUpdatedAt: null,
              description: "Lead design systems work.",
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              atsProvider: null,
              providerKey: null,
              providerBoardToken: null,
              providerIdentifier: null,
              titleTriageOutcome: "pass",
              sourceIntelligence: null,
              screeningHints: {
                sponsorshipText: null,
                requiresSecurityClearance: null,
                relocationText: null,
                travelText: null,
                remoteGeographies: [],
                requiresConsentInterrupt: null,
                requiresConsentInterruptKind: null,
              },
              keywordSignals: [],
              keySkills: [],
              benefits: [],
              matchAssessment: {
                scorerVersion: 2,
                contextFingerprint: null,
                postingFingerprint: null,
                score: 92,
                scoreIsUpperBound: false,
                locationReach: "unknown",
                compensationFit: {
                  state: "not_requested",
                  confidence: "unavailable",
                  minimumSalaryUsd: null,
                  listingMinimumAnnualUsd: null,
                  listingCurrency: null,
                  explanation: "No minimum salary preference is configured.",
                },
                dimensions: {
                  roleSuitability: {
                    state: "unknown",
                    explanation:
                      "Role suitability is unavailable in this fixture.",
                    evidence: [],
                  },
                  preferenceAlignment: {
                    state: "unknown",
                    explanation:
                      "Preference alignment is unavailable in this fixture.",
                    evidence: [],
                  },
                  applicationEffort: {
                    level: "unknown",
                    explanation:
                      "Application effort is unavailable in this fixture.",
                    evidence: [],
                  },
                  evidenceConfidence: {
                    level: "unavailable",
                    explanation:
                      "Evidence confidence is unavailable in this fixture.",
                    evidence: [],
                    supportedCount: 0,
                    partialCount: 0,
                    missingCount: 0,
                    unknownCount: 0,
                    conflictCount: 0,
                  },
                },
                reasons: ["Strong fit"],
                gaps: [],
                recommendation: "strong_fit",
                recommendationRationale: "No hard blockers detected.",
                requirements: [],
              },
              status: "discovered",
              applyPath: "easy_apply",
              provenance: [],
              discoveryFeedback: null,
              resumeApplicationMode: null,
              latestMatchAssessmentAudit: null,
              listingDetailFetch: null,
            }),
          ]}
          onRecoveryAction={onRecoveryAction}
          onSelectJob={vi.fn()}
          recoveryActionLabel="Sign in to LinkedIn"
          recoveryActionNextStep="Then search again after sign-in."
          recoveryActionPending={false}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(getByText(/last completed search/i)).toBeTruthy();
    fireEvent.click(
      within(container).getAllByRole("button", {
        name: "Sign in to LinkedIn",
      })[0]!,
    );
    expect(onRecoveryAction).toHaveBeenCalledTimes(1);
  });

  it("prioritizes missing search setup over browser startup copy", () => {
    const { getByText, getByRole, queryByText } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "chrome_profile_agent",
            label: "Browser starting",
            detail: "Preparing browser runtime.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          jobs={[]}
          onSelectJob={vi.fn()}
          searchSetupBlocker={{
            title: "Add a target role before searching",
            description:
              "Add at least one target role in Profile so Find jobs can aim the next search.",
            actionLabel: "Edit search in Profile",
            actionHref: "/job-finder/profile?section=sources&focus=job-sources",
            nextStep: "Then search again.",
          }}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(getByText("Add a target role before searching")).toBeTruthy();
    expect(
      getByText(
        "Add at least one target role in Profile so Find jobs can aim the next search.",
      ),
    ).toBeTruthy();
    expect(queryByText("Browser is starting")).toBeNull();
    expect(
      (
        getByRole("link", {
          name: "Edit search in Profile",
        }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("/job-finder/profile?section=sources&focus=job-sources");
  });

  it("shows a ready first-search state before any completed run", () => {
    const { getByText, queryByText } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "ready",
            driver: "chrome_profile_agent",
            label: "Browser ready",
            detail: "Ready when needed.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          jobs={[]}
          onSelectJob={vi.fn()}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(getByText("Ready for your first search")).toBeTruthy();
    expect(queryByText("No matches from this search")).toBeNull();
  });

  it("shows no matches only after a completed search", () => {
    const { getByRole, getByText, queryByText } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "ready",
            driver: "chrome_profile_agent",
            label: "Browser ready",
            detail: "Ready when needed.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          hasCompletedSearch
          jobs={[]}
          onSelectJob={vi.fn()}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(getByText("No matches from this search")).toBeTruthy();
    expect(getByRole("link", { name: "Edit your places" })).toBeTruthy();
    expect(queryByText("Ready for your first search")).toBeNull();
  });

  it("keeps completed-source matches visible while the remaining sources run", () => {
    const progressiveJob = {
      id: "job_progressive",
      title: "Senior Product Designer",
      company: "Acme",
      location: "Remote",
      matchAssessment: { score: 88 },
      status: "discovered",
      applyPath: "external_redirect",
      salaryText: null,
      workMode: ["remote"],
      provenance: [],
      postedAt: "2026-07-15T00:00:00.000Z",
      postedAtText: null,
    } as unknown as SavedJob;
    const { getByRole, getByText, queryByRole } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "ready",
            driver: "chrome_profile_agent",
            label: "Browser ready",
            detail: "Ready when needed.",
            lastCheckedAt: "2026-07-16T10:00:00.000Z",
          }}
          isSearchInProgress
          jobs={[progressiveJob]}
          onSelectJob={vi.fn()}
          selectedJob={progressiveJob}
        />
      </MemoryRouter>,
    );

    // One plain status line under the Results header (ADR 0042).
    expect(getByText(/^1 result shown\./)).toBeTruthy();
    expect(getByText(/remaining sources/i)).toBeTruthy();
    expect(getByText("Senior Product Designer")).toBeTruthy();
    expect(queryByRole("listbox")).toBeNull();
    expect(
      getByRole("button", { name: /senior product designer/i }).getAttribute(
        "aria-current",
      ),
    ).toBe("true");
    expect(
      getByRole("button", { name: /senior product designer/i }).getAttribute(
        "data-job-result-id",
      ),
    ).toBe("job_progressive");
  });

  it("does not treat the catalog runtime as browser startup or a live-search-ready state", () => {
    const { getByText, queryByText } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "catalog_seed",
            label: "Browser optional",
            detail: "The browser is only needed for sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          jobs={[]}
          onSelectJob={vi.fn()}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(getByText("Job Finder cannot search right now")).toBeTruthy();
    expect(getByText(DISCOVERY_OFFLINE_SETUP_NOTICE)).toBeTruthy();
    expect(queryByText("Browser is starting")).toBeNull();
    expect(queryByText("No matches from this search")).toBeNull();
    expect(queryByText("Ready for your first search")).toBeNull();
  });

  it("keeps saved-earlier rows honest without inventing source, activity, or fit evidence", () => {
    const catalogJob = {
      id: "catalog-job",
      title: "Catalog role",
      company: "Example Company",
      location: "Remote",
      canonicalUrl: "https://example.com/jobs/catalog-role",
      workMode: ["remote"],
      status: "discovered",
      applyPath: "external_redirect",
      salaryText: null,
      postedAt: null,
      postedAtText: null,
      providerUpdatedAt: null,
      provenance: [],
      matchAssessment: {
        score: 92,
        recommendation: "strong_fit",
        reasons: ["Role evidence"],
        gaps: [],
      },
    } as unknown as SavedJob;

    const { getAllByRole, getAllByText, queryByText } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "unknown",
            driver: "catalog_seed",
            label: "Offline catalog",
            detail: "The browser is only needed for sign-in.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          jobs={[catalogJob]}
          onSelectJob={vi.fn()}
          selectedJob={catalogJob}
        />
      </MemoryRouter>,
    );

    const offlineCatalogStatus = getAllByRole("status").find((status) =>
      status.textContent?.includes(DISCOVERY_OFFLINE_CATALOG_NOTICE),
    );

    expect(offlineCatalogStatus).toBeTruthy();
    expect(offlineCatalogStatus?.id).toBe("discovery-offline-catalog-notice");
    expect(offlineCatalogStatus?.textContent).toContain("Search unavailable.");
    expect(offlineCatalogStatus?.textContent).toContain(
      "Job Finder cannot search right now; try again in a moment.",
    );
    // The status line lives in the Results header, not a padded box.
    expect(offlineCatalogStatus?.getAttribute("data-testid")).toBe(
      "discovery-results-status-line",
    );
    expect(getAllByText("Source unavailable").length).toBeGreaterThan(0);
    expect(getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(getAllByText("Fit not assessed").length).toBeGreaterThan(0);
    expect(queryByText("92% fit")).toBeNull();
  });

  it("shows live search progress instead of an empty result verdict", () => {
    const { getByText, queryByText } = render(
      <MemoryRouter>
        <DiscoveryResultsPanel
          browserSession={{
            source: "target_site",
            status: "ready",
            driver: "chrome_profile_agent",
            label: "Browser ready",
            detail: "Ready when needed.",
            lastCheckedAt: "2026-03-20T10:00:00.000Z",
          }}
          hasCompletedSearch
          isSearchInProgress
          jobs={[]}
          onSelectJob={vi.fn()}
          selectedJob={null}
        />
      </MemoryRouter>,
    );

    expect(getByText("Searching your sources")).toBeTruthy();
    expect(queryByText("No matches from this search")).toBeNull();
  });
});
