// @vitest-environment jsdom

import { MemoryRouter } from "react-router-dom";
import type {
  BrowserSessionState,
  JobDiscoveryTarget,
  JobSearchPreferences,
} from "@nestor/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiscoverySearchBar,
  getDiscoveryPlanOptions,
  getDiscoverySearchChips,
} from "./discovery-search-bar";

afterEach(() => {
  cleanup();
});

const browserSession: BrowserSessionState = {
  driver: "chrome_profile_agent",
  detail: "",
  label: "Managed browser",
  lastCheckedAt: "2026-09-01T00:00:00.000Z",
  source: "target_site",
  status: "unknown",
};

function target(
  overrides: Partial<JobDiscoveryTarget> = {},
): JobDiscoveryTarget {
  return {
    id: "target_wellfound",
    label: "Wellfound",
    startingUrl: "https://wellfound.com/jobs",
    enabled: true,
    adapterKind: "auto",
    customInstructions: null,
    instructionStatus: "draft",
    validatedInstructionId: null,
    draftInstructionId: null,
    lastDebugRunId: null,
    lastVerifiedAt: null,
    staleReason: null,
    ...overrides,
  } as JobDiscoveryTarget;
}

function preferences(
  overrides: Partial<JobSearchPreferences> = {},
): JobSearchPreferences {
  return {
    targetRoles: ["Senior Robotics Software Engineer", "Backend Engineer"],
    jobFamilies: [],
    locations: [],
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
    discovery: { historyLimit: 5, targets: [target()] },
    ...overrides,
  } as unknown as JobSearchPreferences;
}

function renderBar(
  overrides: Partial<Parameters<typeof DiscoverySearchBar>[0]> = {},
) {
  const onToggleSetup = vi.fn();
  const onRunAgentDiscovery = vi.fn();
  const onOpenBrowserSession = vi.fn();
  render(
    <DiscoverySearchBar
      browserSession={browserSession}
      isBrowserSessionPending={false}
      isSearchDisabled={false}
      isSearchPending={false}
      isSearchRunning={false}
      isSetupOpen={false}
      onOpenBrowserSession={onOpenBrowserSession}
      onRunAgentDiscovery={onRunAgentDiscovery}
      onToggleSetup={onToggleSetup}
      searchPreferences={preferences()}
      {...overrides}
    />,
    { wrapper: MemoryRouter },
  );
  return { onOpenBrowserSession, onRunAgentDiscovery, onToggleSetup };
}

describe("getDiscoverySearchChips", () => {
  it("summarizes the search in three chips a job seeker can read", () => {
    expect(getDiscoverySearchChips(preferences())).toEqual([
      { id: "roles", label: "2 search targets" },
      { id: "places", label: "Remote only" },
      { id: "sources", label: "1 enabled source" },
    ]);
  });

  it("says plainly when a search has nothing to search for", () => {
    const chips = getDiscoverySearchChips(
      preferences({
        targetRoles: [],
        jobFamilies: [],
        workModes: [],
        discovery: { historyLimit: 5, targets: [] },
      } as unknown as Partial<JobSearchPreferences>),
    );
    expect(chips.map((chip) => chip.label)).toEqual([
      "No search targets",
      "Anywhere",
      "No enabled sources",
    ]);
  });
});

describe("DiscoverySearchBar", () => {
  it("keeps result scope out of the bar: the results panel owns that toggle", () => {
    const onToggleResultScope = vi.fn();
    renderBar({
      hiddenResultCount: 42,
      onToggleResultScope,
      resultScope: "focused",
    });
    expect(screen.queryByTestId("discovery-result-scope-toggle")).toBeNull();
    expect(onToggleResultScope).not.toHaveBeenCalled();
  });

  it("opens the setup editor in place from one Search defaults chip, with no route change", () => {
    const { onToggleSetup } = renderBar();

    const chip = screen.getByRole("button", {
      name: "Roles, places & sources",
    });
    expect(chip.getAttribute("aria-controls")).toBe(
      "discovery-search-setup-panel",
    );
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    // The counts that used to be three chips ride along as the chip's title.
    expect(chip.getAttribute("title")).toContain("2 search targets");
    expect(chip.getAttribute("title")).toContain("1 enabled source");
    fireEvent.click(chip);
    expect(onToggleSetup).toHaveBeenCalledWith("roles");
    expect(
      screen.queryByRole("button", { name: "2 search targets" }),
    ).toBeNull();
  });

  it("closes an open editor from the same chip", () => {
    const { onToggleSetup } = renderBar({
      isSetupOpen: true,
      openSetupChipId: "places",
    });

    const chip = screen.getByRole("button", {
      name: "Roles, places & sources",
    });
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(chip);
    expect(onToggleSetup).toHaveBeenCalledWith(null);
  });

  it("keeps one search command and demotes the browser to a small link", () => {
    const { onOpenBrowserSession, onRunAgentDiscovery } = renderBar();

    // One label, one home: the action used to appear as "Search now" in the
    // page header, "Search jobs" inside the setup card, and again on compact.
    expect(screen.getAllByRole("button", { name: "Search now" })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("button", { name: "Search jobs" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search now" }));
    expect(onRunAgentDiscovery).toHaveBeenCalledTimes(1);

    // A browser that is merely not open is not the person's problem: the
    // search opens it. The link appears only when the browser needs them.
    expect(screen.queryByTestId("discovery-search-bar-browser")).toBeNull();
    expect(onOpenBrowserSession).not.toHaveBeenCalled();
  });

  it("names the browser only when it needs a sign-in or is blocked", () => {
    const { onOpenBrowserSession } = renderBar({
      browserSession: { ...browserSession, status: "login_required" },
    });

    const browserLink = screen.getByTestId("discovery-search-bar-browser");
    expect(browserLink.textContent).toBe("Browser needs sign-in");
    fireEvent.click(browserLink);
    expect(onOpenBrowserSession).toHaveBeenCalledTimes(1);
  });

  it("starts the run with the plain-language goal and run-scoped knobs", () => {
    const { onRunAgentDiscovery } = renderBar({
      searchPreferences: preferences({
        discovery: {
          historyLimit: 5,
          targets: [
            target(),
            target({
              id: "target_example",
              label: "Example Careers",
              startingUrl: "https://example.test/careers",
            }),
          ],
        },
      } as Partial<JobSearchPreferences>),
    });

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search focus (optional)" }),
      {
        target: { value: "around engineering" },
      },
    );
    // How picky a search is lives in Settings (AI behavior), so the bar no
    // longer offers a breadth choice of its own.
    expect(
      screen.queryByRole("radiogroup", { name: "Search breadth" }),
    ).toBeNull();
    const preferRecent = screen.getByRole("button", { name: "Prefer recent" });
    expect(preferRecent.getAttribute("title")).toContain(
      "Older or undated roles may still appear",
    );
    fireEvent.click(preferRecent);
    fireEvent.click(screen.getByRole("button", { name: "All sources" }));
    fireEvent.click(screen.getByLabelText("Example Careers"));
    fireEvent.click(screen.getByRole("button", { name: "Search now" }));

    expect(onRunAgentDiscovery).toHaveBeenCalledWith({
      intent: "around engineering",
      freshness: "recent",
      sourceIds: ["target_wellfound"],
    });
  });

  it("recovers the source selection when the selected source is disabled", () => {
    const second = target({ id: "target_example", label: "Example Careers" });
    const props = {
      browserSession,
      isBrowserSessionPending: false,
      isSearchDisabled: false,
      isSearchPending: false,
      isSearchRunning: false,
      isSetupOpen: false,
      onOpenBrowserSession: vi.fn(),
      onRunAgentDiscovery: vi.fn(),
      onToggleSetup: vi.fn(),
      searchPreferences: preferences({
        discovery: { historyLimit: 5, targets: [target(), second] },
      }),
    };
    const view = render(<DiscoverySearchBar {...props} />, {
      wrapper: MemoryRouter,
    });
    fireEvent.click(screen.getByRole("button", { name: "All sources" }));
    fireEvent.click(screen.getByLabelText("Example Careers"));
    view.rerender(
      <DiscoverySearchBar
        {...props}
        searchPreferences={preferences({
          discovery: {
            historyLimit: 5,
            targets: [target({ enabled: false }), second],
          },
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Search now" }));
    expect(props.onRunAgentDiscovery).toHaveBeenCalledWith({
      intent: "",
      freshness: "any",
      sourceIds: "all",
    });
  });

  it("recovers a cleared selection when only one enabled source remains", () => {
    const second = target({ id: "target_example", label: "Example Careers" });
    const props = {
      browserSession,
      isBrowserSessionPending: false,
      isSearchDisabled: false,
      isSearchPending: false,
      isSearchRunning: false,
      isSetupOpen: false,
      onOpenBrowserSession: vi.fn(),
      onRunAgentDiscovery: vi.fn(),
      onToggleSetup: vi.fn(),
      searchPreferences: preferences({
        discovery: { historyLimit: 5, targets: [target(), second] },
      }),
    };
    const view = render(<DiscoverySearchBar {...props} />, {
      wrapper: MemoryRouter,
    });
    fireEvent.click(screen.getByRole("button", { name: "All sources" }));
    fireEvent.click(screen.getByLabelText("Example Careers"));
    fireEvent.click(screen.getByLabelText("Wellfound"));
    expect(
      screen
        .getByRole("button", { name: "Search now" })
        .hasAttribute("disabled"),
    ).toBe(true);
    view.rerender(
      <DiscoverySearchBar {...props} searchPreferences={preferences()} />,
    );
    expect(
      screen
        .getByRole("button", { name: "Search now" })
        .hasAttribute("disabled"),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Search now" }));
    expect(props.onRunAgentDiscovery).toHaveBeenCalledWith({
      intent: "",
      freshness: "any",
      sourceIds: "all",
    });
  });

  it("omits the browser link on the offline catalog runtime", () => {
    // The setup panel already owns the "Offline catalog" fact, and there is
    // no live browser to open, so the bar shows no second copy of it.
    renderBar({
      browserSession: {
        ...browserSession,
        driver: "catalog_seed",
        status: "ready",
      },
    });

    expect(screen.queryByTestId("discovery-search-bar-browser")).toBeNull();
    expect(screen.queryByText("Offline catalog")).toBeNull();
    expect(screen.getByRole("button", { name: "Search now" })).toBeTruthy();
  });

  it("offers Stop beside a running search instead of a second Search", () => {
    const onStopSearch = vi.fn();
    renderBar({ isSearchRunning: true, onStopSearch });

    expect(screen.getByRole("button", { name: "Searching" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop search" }));
    expect(onStopSearch).toHaveBeenCalledTimes(1);
  });
});

describe("DiscoverySearchBar plan chip", () => {
  const plans = [
    { id: "plan_a", name: "Remote TypeScript", status: "active" as const },
    { id: "plan_b", name: "Focused frontend", status: "paused" as const },
    { id: "plan_c", name: "Old broad", status: "archived" as const },
  ];

  it("lists every non-archived plan and keeps an archived current plan visible", () => {
    expect(getDiscoveryPlanOptions(plans, "plan_a").map((p) => p.id)).toEqual([
      "plan_a",
      "plan_b",
    ]);
    expect(getDiscoveryPlanOptions(plans, "plan_c").map((p) => p.id)).toEqual([
      "plan_a",
      "plan_b",
      "plan_c",
    ]);
  });

  it("never shows a plan switch in the bar; Search plans owns that", () => {
    renderBar({
      campaigns: plans,
      activeCampaignId: "plan_a",
      onSelectCampaign: vi.fn(),
    });
    expect(screen.queryByLabelText("Search plan")).toBeNull();
    expect(screen.queryByTestId("discovery-search-plan")).toBeNull();
  });
});

it("links directly to Search plans beside search controls", () => {
  renderBar();
  expect(
    screen.getByRole("link", { name: "Search plans" }).getAttribute("href"),
  ).toBe("/job-finder/campaigns");
});

it("names the background plan on its Stop button", () => {
  const onStopSearch = vi.fn();
  renderBar({
    isSearchRunning: true,
    backgroundPlanName: "Local B",
    onStopSearch,
  });
  fireEvent.click(screen.getByRole("button", { name: "Stop Local B search" }));
  expect(onStopSearch).toHaveBeenCalledOnce();
});

it("labels an explicit plan source that is off in Profile without turning it off for this search", () => {
  const { onRunAgentDiscovery } = renderBar({
    profileSourceEnabled: { target_wellfound: false },
    searchPreferences: preferences({
      discovery: {
        historyLimit: 5,
        targets: [target(), target({ id: "second", label: "Second" })],
      },
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: /All .*sources/i }));
  expect(
    screen.getByRole("button", { name: "All sources in this plan" }),
  ).toBeTruthy();
  expect(
    screen.getByText("Off in Profile; this plan still searches it"),
  ).toBeTruthy();
  expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Search now" }));
  expect(onRunAgentDiscovery).toHaveBeenCalled();
});

it("searches one source out of many without unticking the rest", () => {
  const targets = Array.from({ length: 12 }, (_, index) =>
    target({ id: `source_${index}`, label: `Board ${index}` }),
  );
  const { onRunAgentDiscovery } = renderBar({
    searchPreferences: preferences({
      discovery: { historyLimit: 5, targets },
    }),
  });
  fireEvent.click(screen.getByRole("button", { name: /All .*sources/i }));
  fireEvent.click(screen.getByRole("button", { name: "No sources" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Find a source" }), {
    target: { value: "board 7" },
  });
  const boxes = screen.getAllByRole("checkbox");
  expect(boxes).toHaveLength(1);
  fireEvent.click(boxes[0]!);
  expect(screen.getByText("1 of 12 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Search now" }));
  expect(onRunAgentDiscovery).toHaveBeenCalledWith(
    expect.objectContaining({ sourceIds: ["source_7"] }),
  );
});

it("refreshes the selected sources when the plan adds a source without leaving Find jobs", () => {
  const first = target();
  const second = target({ id: "second", label: "Second source" });
  const third = target({ id: "third", label: "Third source" });
  const onRunAgentDiscovery = vi.fn();
  const props = {
    browserSession,
    isBrowserSessionPending: false,
    isSearchDisabled: false,
    isSearchPending: false,
    isSearchRunning: false,
    isSetupOpen: false,
    onOpenBrowserSession: vi.fn(),
    onRunAgentDiscovery,
    onToggleSetup: vi.fn(),
    activeCampaignId: "plan",
    searchPreferences: preferences({
      discovery: { historyLimit: 5, targets: [first, second] },
    }),
  };
  const view = render(<DiscoverySearchBar {...props} />, {
    wrapper: MemoryRouter,
  });
  fireEvent.click(screen.getByRole("button", { name: "All sources" }));
  fireEvent.click(screen.getByLabelText("Second source"));
  view.rerender(
    <DiscoverySearchBar
      {...props}
      searchPreferences={preferences({
        discovery: { historyLimit: 5, targets: [first, second, third] },
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "All sources" }));
  expect(screen.getByLabelText<HTMLInputElement>("Third source").checked).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Search now" }));
  expect(onRunAgentDiscovery).toHaveBeenCalledWith(
    expect.objectContaining({ sourceIds: "all" }),
  );
});
