// @vitest-environment jsdom

import {
  JobListMatchAssessmentSchema,
  type JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Link, MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHELL_HEADER_MASK_HEIGHT_CLASS,
  SHELL_HEADER_MASK_HEIGHT_PX,
  SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CLASS,
  SHELL_SCROLLING_ROUTE_TOP_GUTTER_CLASS,
  SHELL_SCROLLING_ROUTE_TOP_GUTTER_PX,
} from "../lib/job-finder-shell-gutters";
import { JobFinderShell } from "./job-finder-shell";

const windowControlsState = {
  isClosable: true,
  isFullScreen: false,
  isMaximized: false,
  isMinimizable: true,
} as const;
const scrollToMock = vi.fn();
const scrollIntoViewMock = vi.fn();

function createWorkspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    applicationRecords: [],
    discoveryJobs: Array.from({ length: 24 }, (_, index) => ({
      id: `job_${index}`,
      matchAssessment: JobListMatchAssessmentSchema.parse({ score: 70 }),
    })),
    profileSetupState: {
      completedAt: null,
      currentStep: "import",
      lastResumedAt: null,
      reviewItems: [],
      status: "not_started",
    },
    reviewQueue: [],
    userActionRequests: [],
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

/**
 * The module switch is the wordmark's subtitle inside the header brand
 * region — one instance at every width. The sidebar head, the compact
 * destination card and the collapsed rail carry none, so a person reads the
 * module they are in in exactly one place and the control never relayouts
 * across breakpoints.
 */
function getBrandModuleSwitch(): HTMLElement {
  const control = document.querySelector<HTMLElement>(
    "[data-desktop-brand] [data-desktop-brand-region] [data-desktop-brand-subtitle] [data-desktop-module-navigation]",
  );
  if (!control) {
    throw new Error("Brand module switch is missing");
  }
  return control;
}

/** Exactly one switch on screen, and it is the brand one. */
function expectSoleModuleSwitchInBrand(): HTMLElement {
  const control = getBrandModuleSwitch();
  expect(
    document.querySelectorAll("[data-desktop-module-navigation]"),
  ).toHaveLength(1);
  expect(
    document.querySelectorAll("[data-module-switch-trigger]"),
  ).toHaveLength(1);
  for (const surface of [
    "[data-job-finder-sidebar]",
    "[data-job-finder-compact-navigation]",
    "[data-job-finder-shell-content]",
  ]) {
    expect(
      document.querySelector(`${surface} [data-desktop-module-navigation]`),
    ).toBeNull();
  }
  return control;
}

/**
 * At rest each surface shows one trigger naming the module the user is in;
 * the two options live in a menu that is portalled to `document.body` only
 * while it is open. Tests therefore go through the trigger the way a person
 * does, and reach the menu through the trigger's `aria-controls`.
 */
function getModuleSwitchTrigger(control: HTMLElement): HTMLButtonElement {
  const trigger = control.querySelector<HTMLButtonElement>(
    "[data-module-switch-trigger]",
  );
  if (!trigger) {
    throw new Error("Module switch trigger is missing");
  }
  return trigger;
}

function getModuleSwitchMenu(control: HTMLElement): HTMLElement {
  const menuId = getModuleSwitchTrigger(control).getAttribute("aria-controls");
  const menu = menuId ? document.getElementById(menuId) : null;
  if (!menu) {
    throw new Error("Module switch menu is closed");
  }
  return menu;
}

function openModuleSwitch(control: HTMLElement): HTMLElement {
  const trigger = getModuleSwitchTrigger(control);
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
  return getModuleSwitchMenu(control);
}

function getModuleOption(
  control: HTMLElement,
  moduleName: "live-assistant" | "job-finder",
): HTMLButtonElement {
  const option = getModuleSwitchMenu(control).querySelector<HTMLButtonElement>(
    `[data-module-switch-option="${moduleName}"]`,
  );
  if (!option) {
    throw new Error(`Module switch option ${moduleName} is missing`);
  }
  return option;
}

const SIDEBAR_SECONDARY_DESTINATIONS = ["Settings"] as const;

/**
 * Only the compact top navigation renders a More trigger; the expanded sidebar
 * lists the same destinations inline. jsdom applies no media queries, so the
 * helper still names the surface it means.
 */
function getCompactMoreButton(): HTMLElement {
  const compactNavigation = document.querySelector(
    "[data-job-finder-compact-navigation]",
  );
  if (!compactNavigation) {
    throw new Error("Expected the compact navigation.");
  }
  return within(compactNavigation as HTMLElement).getByRole("button", {
    name: /^More/u,
  });
}

describe("JobFinderShell compact nav responsive contract", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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
    });

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function getSectionNavigation() {
    return screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
  }

  // jsdom cannot lay out pixels, so these are static DOM contracts per CSS
  // breakpoint bucket. Exact pixel geometry acceptance stays with
  // the Electron visual harness. 1152 is the native 125%-zoom CSS width
  // (physical 1440 / 1.25) that the stale [1120,1440) grid regime crushed.
  it.each([1119, 1152, 1279, 1280, 1439])(
    "keeps every core destination scrollable beside reserved Planning space at %spx",
    (width) => {
      expect(width).toBeLessThan(1440);
      render(
        <MemoryRouter initialEntries={["/job-finder/discovery"]}>
          <JobFinderShell platform="win32" workspace={createWorkspace()}>
            <div>Current screen</div>
          </JobFinderShell>
        </MemoryRouter>,
      );

      const navigation = getSectionNavigation();
      expect(navigation.className).toContain("min-[1440px]:hidden");

      const strip = navigation.querySelector(
        "[data-job-finder-compact-navigation-scroll]",
      );
      const contentRow = navigation.querySelector(
        "[data-job-finder-compact-navigation-content]",
      );
      expect(contentRow?.className).toContain("flex-nowrap");
      expect(strip?.className).toContain("overflow-x-auto");
      expect(strip?.className).toContain("overscroll-x-contain");

      const destinations = within(navigation)
        .getAllByRole("button")
        .map((button) => button.textContent?.replace(/\d+/g, "").trim());
      // Destinations only; the module switch is in the brand lockup above.
      expect(destinations).toEqual([
        "Home",
        "Profile",
        "Find jobs",
        "Shortlisted",
        "Applications",
        "More",
      ]);

      for (const label of [
        "Home",
        "Profile",
        "Find jobs",
        "Shortlisted",
        "Applications",
      ]) {
        const button = within(navigation).getByRole("button", {
          name: new RegExp(`^${label}`),
        });
        const labelSpan = button.querySelector("span");
        expect(labelSpan?.className).toContain("whitespace-nowrap");
        expect(button.className).toContain("shrink-0");
        expect(strip?.contains(button)).toBe(true);
      }

      const moreWrapper = within(navigation).getByRole("button", {
        name: "More",
      }).parentElement;
      expect(moreWrapper?.className).toContain("shrink-0");
      expect(moreWrapper?.className).toContain("z-10");
      expect(moreWrapper?.className).not.toContain("sticky");
      expect(strip?.contains(moreWrapper)).toBe(false);

      // Below the wide layout the one module switch is still the brand
      // subtitle, and it never enters this card or its destination scroller.
      const brandSwitch = expectSoleModuleSwitchInBrand();
      expect(navigation.contains(brandSwitch)).toBe(false);
      expect(strip?.contains(brandSwitch)).toBe(false);
      openModuleSwitch(brandSwitch);
      expect(
        getModuleOption(brandSwitch, "live-assistant").getAttribute(
          "aria-checked",
        ),
      ).toBe("false");
      fireEvent.keyDown(getModuleSwitchMenu(brandSwitch), { key: "Escape" });

      expect(
        screen.getAllByRole("button", { name: /^Needs you/ }),
      ).toHaveLength(1);
      expect(
        screen.getByRole("group", { name: "Window controls" }),
      ).toBeTruthy();
    },
  );

  it.each([1440])(
    "moves destinations to the sidebar and keeps one header attention control at %spx",
    (width) => {
      expect(width).toBeGreaterThanOrEqual(1440);
      render(
        <MemoryRouter initialEntries={["/job-finder/discovery"]}>
          <JobFinderShell platform="win32" workspace={createWorkspace()}>
            <div>Current screen</div>
          </JobFinderShell>
        </MemoryRouter>,
      );

      const sidebar = screen.getByRole("complementary", {
        name: "Job Finder sidebar",
      });
      expect(sidebar.className).toContain("min-[1440px]:block");
      expect(sidebar.className).not.toContain("min-[1120px]:block");
      expect(sidebar.className).toContain("w-(--job-finder-side-width)");
      expect(sidebar.textContent).not.toContain("Needs you");

      const navigation = getSectionNavigation();
      expect(navigation.className).toContain("min-[1440px]:hidden");

      expect(
        screen.getAllByRole("button", { name: /^Needs you/ }),
      ).toHaveLength(1);
      expect(
        screen.getByRole("group", { name: "Window controls" }),
      ).toBeTruthy();
      const shell = document.querySelector<HTMLElement>(
        "[data-job-finder-shell]",
      );
      const content = document.querySelector<HTMLElement>(
        "[data-job-finder-shell-content]",
      );
      expect(content?.className).toContain(
        "min-[1440px]:pl-(--job-finder-side-width)",
      );
      expect(content?.className).not.toContain(
        "min-[1120px]:pl-(--job-finder-side-width)",
      );
      expect(shell?.style.getPropertyValue("--job-finder-side-width")).toBe(
        "17rem",
      );

      fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
      expect(shell?.dataset.sidebarCollapsed).toBe("true");
      expect(shell?.style.getPropertyValue("--job-finder-side-width")).toBe(
        "4rem",
      );
      expect(content?.className).toContain(
        "min-[1440px]:pl-(--job-finder-side-width)",
      );
    },
  );

  it("does not advertise retired advanced routes through More", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/analytics"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const moreButton = getCompactMoreButton();
    expect(moreButton.className).not.toContain("bg-(--nav-active-surface)");
    expect(moreButton.getAttribute("aria-expanded")).toBe("false");
  });

  it("hides zero count badges while distinguishing inventory from attention counts", () => {
    const workspace = createWorkspace() as unknown as Record<string, unknown> &
      JobFinderRendererWorkspaceSnapshot;
    workspace.campaigns = [
      {
        id: "campaign_1",
        jobIds: ["job_1", "job_2"],
        name: "My plan",
      },
    ] as JobFinderRendererWorkspaceSnapshot["campaigns"];
    workspace.discoveryJobs = [
      {
        id: "job_1",
        company: "Acme",
        title: "Engineer I",
        matchAssessment: JobListMatchAssessmentSchema.parse({ score: 70 }),
      },
      {
        id: "job_2",
        company: "Globex",
        title: "Engineer II",
        matchAssessment: JobListMatchAssessmentSchema.parse({ score: 70 }),
      },
    ] as JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
    workspace.userActionRequests = [
      { id: "request_1", state: "pending" },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["userActionRequests"];

    render(
      <MemoryRouter initialEntries={["/job-finder/home"]}>
        <JobFinderShell
          needsYouCount={1}
          platform="win32"
          stageCounts={{
            found: 2,
            hidden: 0,
            shortlisted: 0,
            resume: 0,
            applied: 0,
          }}
          workspace={workspace}
        >
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const navigation = getSectionNavigation();
    const findJobsButton = within(navigation).getByRole("button", {
      name: /^Find jobs/,
    });
    const inventoryBadge = findJobsButton.querySelector("span:last-child");
    // The compact nav and the expanded sidebar paint the same number as the
    // same quiet pill, so one count never has two shapes one breakpoint apart
    // (COMP-07). The attention fill stays reserved for attention counts.
    expect(inventoryBadge?.className).toContain("bg-(--input)");
    expect(inventoryBadge?.className).toContain("rounded-full");
    expect(inventoryBadge?.className).toContain("tabular-nums");
    expect(inventoryBadge?.className).not.toContain("bg-primary");
    // Inventory volume is visual-only: hidden from assistive tech traversal
    // while the labeled destination stays the sole announced content.
    expect(inventoryBadge?.getAttribute("aria-hidden")).toBe("true");

    cleanup();
    render(
      <MemoryRouter initialEntries={["/job-finder/home"]}>
        <JobFinderShell
          needsYouCount={1}
          platform="win32"
          workspace={workspace}
        >
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const needsYouButton = screen.getByRole("button", {
      name: "Needs you: 1 unresolved",
    });
    // The badge element itself, not the noun span nested inside it: an
    // attention count now renders "1 unresolved" so the number can never be
    // read as inventory volume.
    const needsYouBadge = needsYouButton.querySelector("span.tabular-nums");
    expect(needsYouBadge?.className).toContain("bg-primary");
    expect(needsYouBadge?.getAttribute("aria-hidden")).toBeNull();
    expect(needsYouButton.textContent).toContain("1");

    const planningTrigger = within(getSectionNavigation()).getByRole("button", {
      name: "More",
    });
    fireEvent.click(planningTrigger);
    expect(
      within(screen.getByRole("navigation", { name: "More" })).getByRole(
        "button",
        { name: "Settings" },
      ),
    ).toBeTruthy();

    const emptyWorkspace = createWorkspace();
    cleanup();
    render(
      <MemoryRouter initialEntries={["/job-finder/home"]}>
        <JobFinderShell platform="win32" workspace={emptyWorkspace}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const compactNavigation = getSectionNavigation();
    for (const button of within(compactNavigation).getAllByRole("button")) {
      expect(button.textContent?.trim()).not.toContain("0");
    }
    const emptyNeedsYou = screen.getByRole("button", {
      name: "Needs you: 0 unresolved",
    });
    expect(emptyNeedsYou.textContent).not.toContain("0");
    const sidebar = screen.getByRole("complementary", {
      name: "Job Finder sidebar",
    });
    expect(sidebar.textContent).not.toContain("0");
  });

  it("keeps the shortcut reference out of the More menu and behind one entry", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="darwin" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    fireEvent.click(getCompactMoreButton());
    const menu = screen.getByRole("navigation", { name: "More" });
    // The menu carries destinations only: no shortcut table, and no
    // four-line tutorial paragraph above them.
    expect(menu.textContent).not.toContain("Show or hide the sidebar");
    expect(menu.textContent).not.toContain(
      "Set up search plans and resume approaches",
    );

    fireEvent.click(
      within(menu).getByRole("button", { name: /Keyboard shortcuts/ }),
    );
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();

    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const shortcutText = dialog.textContent ?? "";
    expect(shortcutText).toContain("Search your workspace");
    expect(shortcutText).toContain("Show or hide the sidebar");
    // Aliases are separate keycaps, each on the row whose scope it fires in,
    // never merged into one broken token beside a two-scope paragraph. A
    // modifier and its key are two physical keys, so they are two caps: "⌘K"
    // as one cap read as a single unfamiliar glyph-token.
    expect(within(dialog).queryByText("⌘K")).toBeNull();
    expect(within(dialog).queryByText("⌘B")).toBeNull();
    const keycaps = [...dialog.querySelectorAll("kbd")].map(
      (cap) => cap.textContent,
    );
    // The app-wide keys come first; the Find jobs keys follow, scoped to it.
    expect(keycaps.slice(0, 18)).toEqual([
      "⌘",
      "K",
      "/",
      "⌘",
      "B",
      "⌘",
      "I",
      "?",
      "Alt",
      "←",
      "Alt",
      "→",
      "⌘",
      "=",
      "⌘",
      "-",
      "⌘",
      "0",
    ]);
    for (const action of ["Shortlist", "Hide", "Undo the last move"]) {
      expect(within(dialog).getByText(action)).toBeTruthy();
    }
    expect(within(dialog).getAllByText("/")).toHaveLength(1);
    expect(shortcutText).not.toContain(
      "Anywhere in Job Finder; Outside text fields",
    );
    expect(shortcutText).not.toMatch(/approve|delete|submit/i);

    const rows = dialog.querySelectorAll("[data-job-finder-shortcut-row]");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      // Two columns, one scope line, no operable control inside a help row.
      expect(row.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
      expect(row.querySelectorAll("button, a")).toHaveLength(0);
    }
  });
});

describe("JobFinderShell keyboard shortcuts", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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
        // The palette reads saved jobs from the store: one found job.
        jobs: {
          run: vi.fn((_name: string, input: { stage: string }) =>
            Promise.resolve({
              rows:
                input.stage === "found"
                  ? [
                      {
                        id: 1,
                        stage: "found",
                        title: "Platform Engineer",
                        company: "Acme",
                        location: "Remote",
                      },
                    ]
                  : [],
            }),
          ),
        },
      },
    });

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubWideLayout(wide: boolean) {
    vi.mocked(window.matchMedia).mockImplementation(
      (query) =>
        ({
          matches: wide && query === "(min-width: 1440px)",
        }) as MediaQueryList,
    );
  }

  function createSearchableWorkspace(): JobFinderRendererWorkspaceSnapshot {
    const workspace = createWorkspace();
    workspace.activeCampaignId = "campaign-active";
    workspace.campaigns = [
      {
        description: "Active plan",
        id: "campaign-active",
        jobIds: ["job_1", "job_2"],
        mode: "precision",
        name: "Active plan",
        status: "active",
      },
    ] as JobFinderRendererWorkspaceSnapshot["campaigns"];
    workspace.discoveryJobs = [
      {
        id: "job_1",
        company: "Acme",
        title: "Platform Engineer",
        matchAssessment: JobListMatchAssessmentSchema.parse({ score: 70 }),
      },
      {
        id: "job_2",
        company: "Globex",
        title: "Field Engineer",
        matchAssessment: JobListMatchAssessmentSchema.parse({ score: 70 }),
      },
    ] as JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
    return workspace;
  }

  function renderShellWithShortcuts(
    options: { darwin?: boolean; wide?: boolean } = {},
  ) {
    stubWideLayout(options.wide ?? false);
    const onNavigate = vi.fn();
    const view = render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell
          onNavigate={onNavigate}
          platform={options.darwin ? "darwin" : "win32"}
          workspace={createSearchableWorkspace()}
        >
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );
    return { onNavigate, view };
  }

  it("toggles and persists the sidebar with Cmd/Ctrl+B only at the wide layout", () => {
    const { view } = renderShellWithShortcuts({ wide: true });
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );

    fireEvent.keyDown(document, { ctrlKey: true, key: "b" });
    expect(shell?.dataset.sidebarCollapsed).toBe("true");
    expect(
      window.localStorage.getItem("nestor.job-finder.sidebar-collapsed.v1"),
    ).toBe("true");

    fireEvent.keyDown(document, { metaKey: true, key: "b" });
    expect(shell?.dataset.sidebarCollapsed).toBe("false");
    expect(
      window.localStorage.getItem("nestor.job-finder.sidebar-collapsed.v1"),
    ).toBe("false");

    view.unmount();

    const narrowView = renderShellWithShortcuts({ wide: false });
    const narrowShell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );
    fireEvent.keyDown(document, { ctrlKey: true, key: "b" });
    expect(narrowShell?.dataset.sidebarCollapsed).toBe("false");
    narrowView.view.unmount();
  });

  it.each([
    { label: "an open Planning popover", setup: "more-menu" },
    { label: "the global search overlay", setup: "search-dialog" },
  ] as const)(
    "ignores Cmd+B while $label owns the surface",
    async ({ setup }) => {
      renderShellWithShortcuts({ wide: true });
      const shell = document.querySelector<HTMLElement>(
        "[data-job-finder-shell]",
      );

      if (setup === "more-menu") {
        fireEvent.click(getCompactMoreButton());
      } else {
        fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
        await waitFor(() =>
          expect(
            screen.getByRole("dialog", {
              name: "Search your workspace",
            }),
          ),
        );
      }

      fireEvent.keyDown(document, { ctrlKey: true, key: "b" });
      expect(shell?.dataset.sidebarCollapsed).toBe("false");
    },
  );

  it.each([
    { extra: { isComposing: true }, why: "IME composition" },
    { extra: {}, why: "defaultPrevented events" },
  ])("ignores Cmd+B during $why", ({ extra }) => {
    renderShellWithShortcuts({ wide: true });
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );

    if ("isComposing" in extra && extra.isComposing) {
      fireEvent.keyDown(document, {
        ctrlKey: true,
        isComposing: true,
        key: "b",
      });
    } else {
      const blocked = new KeyboardEvent("keydown", {
        cancelable: true,
        ctrlKey: true,
        key: "b",
      });
      blocked.preventDefault();
      document.dispatchEvent(blocked);
    }

    expect(shell?.dataset.sidebarCollapsed).toBe("false");
  });

  it("exposes the sidebar toggle shortcut through tooltip and aria-keyshortcuts", async () => {
    renderShellWithShortcuts({ darwin: true, wide: true });
    const trigger = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(trigger.getAttribute("aria-keyshortcuts")).toBe("Meta+b");

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("⌘B");
  });

  it("states the real Cmd+B scope in the shortcuts reference", async () => {
    renderShellWithShortcuts({ darwin: true, wide: true });

    // "?" opens the reference from anywhere outside an editable field.
    fireEvent.keyDown(document, { key: "?" });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });

    // The help must not overpromise: the combo only works at the wide layout,
    // outside overlays, search, and editable fields.
    expect(document.body.textContent).toContain(
      "Wide layout only, outside overlays, search, and editable fields",
    );
  });

  it("opens the grouped global search with Cmd/Ctrl+K, searches, and navigates", async () => {
    const { onNavigate } = renderShellWithShortcuts({});

    fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
    const dialog = await screen.findByRole("dialog", {
      name: "Search your workspace",
    });
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    const input = screen.getByRole("combobox", {
      name: "Search your workspace",
    });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "platform" } });
    expect(await screen.findByText("1 result")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/discovery?job=1");
    expect(
      screen.queryByRole("dialog", {
        name: "Search your workspace",
      }),
    ).toBeNull();
  });

  it("refocuses the search field instead of stacking overlays on repeated Cmd/Ctrl+K", async () => {
    renderShellWithShortcuts({});

    fireEvent.keyDown(document, { metaKey: true, key: "k" });
    await screen.findByRole("dialog", {
      name: "Search your workspace",
    });

    fireEvent.keyDown(document, { metaKey: true, key: "k" });

    expect(
      screen.getAllByRole("dialog", {
        name: "Search your workspace",
      }),
    ).toHaveLength(1);
    expect(document.activeElement).toBe(
      screen.getByRole("combobox", {
        name: "Search your workspace",
      }),
    );
  });

  it("closes the search overlay with Escape and restores focus to its opener", async () => {
    renderShellWithShortcuts({});

    const opener = screen.getByRole("button", {
      name: "Search your workspace",
    });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", {
      name: "Search your workspace",
    });

    fireEvent.keyDown(
      screen.getByRole("combobox", {
        name: "Search your workspace",
      }),
      { key: "Escape" },
    );

    expect(
      screen.queryByRole("dialog", {
        name: "Search your workspace",
      }),
    ).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("accepts the slash alias only outside editable, interactive, and modal contexts", async () => {
    const { view } = renderShellWithShortcuts({});

    fireEvent.keyDown(document.body, { key: "/" });
    await screen.findByRole("dialog", {
      name: "Search your workspace",
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", {
        name: "Search your workspace",
      }),
    ).toBeNull();

    view.unmount();

    const guarded = renderShellWithShortcuts({});
    const editableField = document.createElement("input");
    document.body.appendChild(editableField);
    editableField.focus();
    fireEvent.keyDown(editableField, { key: "/" });
    expect(
      screen.queryByRole("dialog", {
        name: "Search your workspace",
      }),
    ).toBeNull();

    fireEvent.click(getCompactMoreButton());
    expect(screen.getByRole("navigation", { name: "More" }));
    fireEvent.keyDown(document, { key: "/" });
    expect(
      screen.queryByRole("dialog", {
        name: "Search your workspace",
      }),
    ).toBeNull();
    expect(screen.getByRole("navigation", { name: "More" }));

    editableField.remove();
    guarded.view.unmount();
  });
});

describe("JobFinderShell responsive shell contract", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    scrollToMock.mockClear();
    scrollIntoViewMock.mockClear();
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
    });

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });

    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    Reflect.deleteProperty(window, "visualViewport");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function getSectionNavigation() {
    return screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
  }

  function getRouteScroller() {
    const scroller = document.querySelector<HTMLDivElement>(
      "[data-job-finder-compact-navigation-scroll]",
    );
    if (!scroller) {
      throw new Error("Compact route scroller is missing");
    }
    return scroller;
  }

  function setScrollGeometry(
    element: HTMLElement,
    geometry: { clientWidth: number; scrollLeft: number; scrollWidth: number },
  ) {
    for (const [key, value] of Object.entries(geometry)) {
      Object.defineProperty(element, key, { configurable: true, value });
    }
  }

  function stubVisualViewportSize(size: { height: number; width: number }) {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ...size,
      },
    });
  }

  function stubCapturingResizeObserver(): Array<{
    disconnected: boolean;
    target: Element;
    trigger: () => void;
  }> {
    const observations: Array<{
      disconnected: boolean;
      target: Element;
      trigger: () => void;
    }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe(target: Element) {
          const record = {
            disconnected: false,
            target,
            trigger: () => {
              this.callback([], this as unknown as ResizeObserver);
            },
          };
          observations.push(record);
        }

        unobserve() {}

        disconnect() {
          for (const record of observations) {
            record.disconnected = true;
          }
        }
      },
    );
    return observations;
  }

  function stubPlanningTriggerGeometry(button: HTMLElement) {
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
      bottom: 400,
      height: 40,
      left: 800,
      right: 900,
      toJSON: () => ({}),
      top: 360,
      width: 100,
      x: 800,
      y: 360,
    } as DOMRect);
  }

  function renderShell(
    initialPath = "/job-finder/discovery",
    onNavigate?: (path: string) => void,
  ) {
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <JobFinderShell
          {...(onNavigate ? { onNavigate } : {})}
          platform="win32"
          workspace={createWorkspace()}
        >
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );
  }

  it.each([639, 640, 899])(
    "keeps exactly one cross-module affordance, in the brand lockup, at %spx CSS",
    (width) => {
      expect(width).toBeLessThan(900);
      renderShell();

      // There is one switch in the whole shell — the brand subtitle — so no
      // width can produce a second cross-module control. At rest nothing
      // offers the other module by name; it waits in the one menu.
      expect(
        document.querySelectorAll("[data-module-switch-option]"),
      ).toHaveLength(0);
      expect(
        screen.getAllByRole("button", { name: "Job Finder, switch module" }),
      ).toHaveLength(1);

      const brandSwitch = expectSoleModuleSwitchInBrand();
      expect(getRouteScroller().contains(brandSwitch)).toBe(false);
      openModuleSwitch(brandSwitch);
      expect(
        screen.getAllByRole("menuitemradio", { name: "Open Live Assistant" }),
      ).toHaveLength(1);
      fireEvent.keyDown(getModuleSwitchMenu(brandSwitch), { key: "Escape" });

      const compactLayout = document.querySelector(
        "[data-job-finder-compact-navigation]",
      );
      const moreWrapper = getCompactMoreButton().parentElement;
      expect(Array.from(compactLayout?.children ?? [])).toEqual([
        getRouteScroller().parentElement,
        moreWrapper,
      ]);

      // Utilities stay unique and reachable in the 640-899 band.
      expect(
        screen.getAllByRole("button", {
          name: "Search your workspace",
        }),
      ).toHaveLength(1);
      expect(
        document.querySelectorAll("summary[aria-label='Activity']"),
      ).toHaveLength(1);
      expect(
        screen.getAllByRole("button", { name: /^Needs you/ }),
      ).toHaveLength(1);
    },
  );

  it.each([900, 1160, 1439])(
    "keeps the caption row's two regions at %spx CSS",
    (width) => {
      expect(width).toBeGreaterThanOrEqual(900);
      renderShell();

      // One alignment rule for the caption row at every width: the wordmark
      // (with the switch as its subtitle) owns the leading region and the
      // native window-control inset owns the trailing one. There is no middle
      // region left to drift.
      const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");
      expect(brand?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");

      const brandSwitch = expectSoleModuleSwitchInBrand();
      expect(brandSwitch.className).not.toContain("absolute");
      openModuleSwitch(brandSwitch);
      const moduleTwin = getModuleOption(brandSwitch, "live-assistant");
      expect(moduleTwin.getAttribute("aria-current")).toBeNull();
      expect(moduleTwin.getAttribute("aria-checked")).toBe("false");
    },
  );

  it("marks the current module selected and keeps both options keyboard operable", () => {
    renderShell();

    const brandSwitch = expectSoleModuleSwitchInBrand();
    const trigger = getModuleSwitchTrigger(brandSwitch);

    // At rest the switch states the module the user is in and offers to
    // change it; the menu is not in the tree yet.
    expect(trigger.getAttribute("aria-label")).toBe(
      "Job Finder, switch module",
    );
    expect(trigger.dataset.state).toBe("closed");
    expect(
      document.querySelectorAll("[data-module-switch-option]"),
    ).toHaveLength(0);

    // ArrowDown opens it from the keyboard alone and lands on the first item.
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.dataset.state).toBe("open");
    const menu = getModuleSwitchMenu(brandSwitch);
    const jobFinderOption = getModuleOption(brandSwitch, "job-finder");
    const liveAssistantOption = getModuleOption(brandSwitch, "live-assistant");
    expect(document.activeElement).toBe(jobFinderOption);

    // Job Finder is current: checked and named for where the user already is.
    // It carries no aria-current, because the destination rows around the
    // switch own that marker.
    expect(jobFinderOption.getAttribute("aria-checked")).toBe("true");
    expect(jobFinderOption.getAttribute("aria-label")).toBe("Job Finder");
    expect(jobFinderOption.getAttribute("aria-current")).toBeNull();
    expect(liveAssistantOption.getAttribute("aria-checked")).toBe("false");
    expect(liveAssistantOption.getAttribute("aria-label")).toBe(
      "Open Live Assistant",
    );

    // Arrow keys cycle the two items; Escape returns to the trigger.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(liveAssistantOption);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(jobFinderOption);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(liveAssistantOption);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("reveals the active route button when mounting mid-strip", () => {
    renderShell("/job-finder/applications");

    const applicationsButton = within(getSectionNavigation()).getByRole(
      "button",
      { name: /^Applications/ },
    );
    const nearestRevealTargets = scrollIntoViewMock.mock.calls
      .map((call: unknown[], index: number) =>
        (call[0] as { block?: string } | undefined)?.block === "nearest"
          ? scrollIntoViewMock.mock.contexts[index]
          : null,
      )
      .filter((target): target is HTMLElement => target instanceof HTMLElement);

    expect(nearestRevealTargets).toContain(applicationsButton);
  });

  it("reveals the newly active route after strip navigation", () => {
    renderShell();
    scrollIntoViewMock.mockClear();

    fireEvent.click(
      within(getSectionNavigation()).getByRole("button", {
        name: /^Applications/,
      }),
    );

    const applicationsButton = within(getSectionNavigation()).getByRole(
      "button",
      { name: /^Applications/ },
    );
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    const nearestRevealTargets = scrollIntoViewMock.mock.contexts.filter(
      (target) => target instanceof HTMLElement,
    );
    expect(nearestRevealTargets).toContain(applicationsButton);
  });

  it("updates the sidebar owner when an Applications empty-state link opens Shortlisted", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/applications"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <Link to="/job-finder/review-queue">Open Shortlisted</Link>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const sidebar = screen.getByRole("complementary", {
      name: "Job Finder sidebar",
    });
    const applicationsButton = within(sidebar).getByRole("button", {
      name: /^Applications/,
    });
    const shortlistedButton = within(sidebar).getByRole("button", {
      name: /^Shortlisted/,
    });

    expect(applicationsButton.getAttribute("aria-current")).toBe("page");
    expect(shortlistedButton.getAttribute("aria-current")).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Open Shortlisted" }));

    expect(shortlistedButton.getAttribute("aria-current")).toBe("page");
    expect(applicationsButton.getAttribute("aria-current")).toBeNull();
  });

  it("reveals a route button when keyboard focus reaches it", () => {
    renderShell();

    const shortlistedButton = within(getSectionNavigation()).getByRole(
      "button",
      { name: /^Shortlisted/ },
    );
    scrollIntoViewMock.mockClear();

    fireEvent.focus(shortlistedButton);

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
    expect(scrollIntoViewMock.mock.contexts[0]).toBe(shortlistedButton);
  });

  it("suppresses the classic scrollbar while reserving edge breathing room", () => {
    renderShell();

    const scroller = getRouteScroller();
    expect(scroller.className).toContain("[scrollbar-width:none]");
    expect(scroller.className).toContain("[-ms-overflow-style:none]");
    expect(scroller.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(scroller.className).not.toContain("[scrollbar-width:thin]");
    expect(scroller.className).toContain("px-1");

    const startFade = document.querySelector(
      "[data-job-finder-compact-navigation-fade-start]",
    );
    const endFade = document.querySelector(
      "[data-job-finder-compact-navigation-fade-end]",
    );
    expect(startFade?.getAttribute("aria-hidden")).toBe("true");
    expect(endFade?.getAttribute("aria-hidden")).toBe("true");
    expect(startFade?.className).toContain("opacity-0");
    expect(endFade?.className).toContain("opacity-0");
  });

  it("drives overflow fades from live geometry across start, middle, end, and no-overflow", () => {
    const observations = stubCapturingResizeObserver();
    const { unmount } = renderShell();

    const scroller = getRouteScroller();
    const content = document.querySelector<HTMLElement>(
      "[data-job-finder-compact-navigation-content]",
    );
    if (!content) {
      throw new Error("Compact route content wrapper is missing");
    }
    // Both the scrollport box and its content row are observed so badge or
    // label width changes refresh fades even when the box itself is stable.
    expect(observations.map((record) => record.target)).toContain(scroller);
    expect(observations.map((record) => record.target)).toContain(content);

    const startFade = document.querySelector<HTMLElement>(
      "[data-job-finder-compact-navigation-fade-start]",
    );
    const endFade = document.querySelector<HTMLElement>(
      "[data-job-finder-compact-navigation-fade-end]",
    );
    const runObservedResizes = () => {
      act(() => {
        for (const record of observations) {
          record.trigger();
        }
      });
    };

    setScrollGeometry(scroller, {
      clientWidth: 200,
      scrollLeft: 0,
      scrollWidth: 200,
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(startFade?.className).toContain("opacity-0");
    expect(endFade?.className).toContain("opacity-0");

    setScrollGeometry(scroller, {
      clientWidth: 200,
      scrollLeft: 0,
      scrollWidth: 320,
    });
    runObservedResizes();
    expect(startFade?.className).toContain("opacity-0");
    expect(endFade?.className).toContain("opacity-100");

    setScrollGeometry(scroller, {
      clientWidth: 200,
      scrollLeft: 60,
      scrollWidth: 320,
    });
    fireEvent.scroll(scroller);
    expect(startFade?.className).toContain("opacity-100");
    expect(endFade?.className).toContain("opacity-100");

    setScrollGeometry(scroller, {
      clientWidth: 200,
      scrollLeft: 120,
      scrollWidth: 320,
    });
    fireEvent.scroll(scroller);
    expect(startFade?.className).toContain("opacity-100");
    expect(endFade?.className).toContain("opacity-0");

    setScrollGeometry(scroller, {
      clientWidth: 200,
      scrollLeft: 0,
      scrollWidth: 200,
    });
    Object.defineProperty(content, "offsetWidth", {
      configurable: true,
      value: 200,
    });
    runObservedResizes();
    expect(startFade?.className).toContain("opacity-0");
    expect(endFade?.className).toContain("opacity-0");

    unmount();
    expect(observations.every((record) => record.disconnected)).toBe(true);
  });

  it("does not engage an internal scroll region at 1440x920", () => {
    stubVisualViewportSize({ height: 920, width: 1440 });
    renderShell();

    const moreButton = getCompactMoreButton();
    stubPlanningTriggerGeometry(moreButton);
    fireEvent.click(moreButton);

    const menu = screen.getByRole("navigation", { name: "More" });
    // Every destination is present, and none of the ~270px of non-navigation
    // content that used to stop the menu from showing itself.
    for (const label of SIDEBAR_SECONDARY_DESTINATIONS) {
      expect(
        within(menu).getByRole("button", { name: new RegExp(`^${label}`) }),
      ).toBeTruthy();
    }
    expect(menu.textContent).not.toContain("Show or hide the sidebar");
    expect(menu.textContent).not.toContain(
      "Set up search plans and resume approaches",
    );

    // Trigger bottom 400 in a 920px window: it stays below and takes the whole
    // 508px that is actually there, which comfortably clears the seven rows.
    expect(menu.getAttribute("data-side")).toBe("bottom");
    expect(Number.parseInt(menu.style.maxHeight, 10)).toBe(508);
    expect(Number.parseInt(menu.style.top, 10)).toBe(404);

    const scrollRegion = menu.querySelector<HTMLElement>(
      "[data-job-finder-more-menu-scroll-region]",
    );
    if (!scrollRegion) {
      throw new Error("More menu scroll region is missing");
    }
    Object.defineProperties(scrollRegion, {
      clientHeight: { configurable: true, value: 460 },
      scrollHeight: { configurable: true, value: 430 },
    });
    fireEvent.scroll(scrollRegion);
    expect(
      menu.querySelector("[data-bounded-floating-surface-scroll-hint]"),
    ).toBeNull();
  });

  it("keeps every More-menu item hittable at 1440x640", () => {
    // The reported defect: at wide + short viewports the surface was capped at
    // its available height, but its destination list was an unbounded block, so
    // the list grew past the row, the surface clipped it, and the footer entry
    // ("Keyboard shortcuts") painted across Safeguards and Settings. Neither
    // was hittable. jsdom has no layout engine, so the geometry is asserted
    // through the two things that actually decide it: the bounded placement the
    // surface is given, and the bounded row the list is rendered into.
    stubVisualViewportSize({ height: 640, width: 1440 });
    renderShell();

    const moreButton = getCompactMoreButton();
    stubPlanningTriggerGeometry(moreButton);
    fireEvent.click(moreButton);

    const menu = screen.getByRole("navigation", { name: "More" });
    const top = Number.parseInt(menu.style.top, 10);
    const maxHeight = Number.parseInt(menu.style.maxHeight, 10);

    // Trigger 360-400 in a 640px window: 228px below, 348px above. The surface
    // flips above and takes exactly the room that is there, no more.
    expect(menu.getAttribute("data-side")).toBe("top");
    expect(maxHeight).toBe(348);
    expect(top).toBe(8);
    expect(top + maxHeight).toBeLessThanOrEqual(640 - 8);
    // It must not grow over its own trigger either.
    expect(top + maxHeight).toBeLessThanOrEqual(360 - 4);

    // The surface is two rows: a bounded scroll row and an auto footer row.
    // Both bounds are required — without either one the list overflows its row
    // and the two rows paint on top of each other.
    expect(menu.className).toContain("grid-rows-[minmax(0,1fr)_auto]");
    expect(menu.className).toContain("overflow-hidden");

    const scrollRegion = menu.querySelector<HTMLElement>(
      "[data-job-finder-more-menu-scroll-region]",
    );
    if (!scrollRegion) {
      throw new Error("More menu scroll region is missing");
    }
    const scrollRow = scrollRegion.parentElement;
    expect(scrollRow?.className).toContain("grid-rows-[minmax(0,1fr)]");
    expect(scrollRow?.className).toContain("overflow-hidden");
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(scrollRegion.className).toContain("min-h-0");

    // The footer is its own row outside that scroller, so it can never be
    // overlapped by, or overlap, a destination.
    const shortcutsEntry = menu.querySelector<HTMLElement>(
      "[data-job-finder-more-menu-shortcuts-entry]",
    );
    expect(shortcutsEntry).toBeTruthy();
    expect(scrollRegion.contains(shortcutsEntry)).toBe(false);
    expect(shortcutsEntry?.className).toContain("shrink-0");

    // Every destination plus the footer entry is present and enabled, reachable
    // through the scroll region rather than by resizing the window.
    for (const label of SIDEBAR_SECONDARY_DESTINATIONS) {
      const item = within(menu).getByRole("button", {
        name: new RegExp(`^${label}`),
      });
      expect(scrollRegion.contains(item)).toBe(true);
      expect(item.hasAttribute("disabled")).toBe(false);
      expect(item.getAttribute("aria-hidden")).toBeNull();
    }
    expect(
      within(menu)
        .getByRole("button", { name: /Keyboard shortcuts/ })
        .hasAttribute("disabled"),
    ).toBe(false);

    // Arrow keys still walk the whole list, footer entry included, so the
    // scrolled-out rows stay reachable from the keyboard.
    const items = within(menu).getAllByRole("button");
    expect(items).toHaveLength(SIDEBAR_SECONDARY_DESTINATIONS.length + 1);
  });

  it("flips the More menu above its trigger and stays inside a short window", () => {
    // 1440x560: 148px below the trigger, 348px above it. The menu used to
    // hard-anchor below and show one of seven destinations.
    stubVisualViewportSize({ height: 560, width: 1440 });
    renderShell();

    const moreButton = getCompactMoreButton();
    stubPlanningTriggerGeometry(moreButton);
    fireEvent.click(moreButton);

    const menu = screen.getByRole("navigation", { name: "More" });
    expect(menu.getAttribute("data-side")).toBe("top");

    const top = Number.parseInt(menu.style.top, 10);
    const maxHeight = Number.parseInt(menu.style.maxHeight, 10);
    expect(maxHeight).toBe(348);
    expect(top).toBe(8);
    // Bounded on both edges: nothing paints past the window in either
    // direction, and the surface never covers its own trigger.
    expect(top).toBeGreaterThanOrEqual(8);
    expect(top + maxHeight).toBeLessThanOrEqual(560 - 8);

    // Every destination is still reachable, through the internal scroll
    // region rather than by resizing the window.
    const scrollRegion = menu.querySelector<HTMLElement>(
      "[data-job-finder-more-menu-scroll-region]",
    );
    expect(scrollRegion?.className).toContain("overflow-y-auto");
    for (const label of SIDEBAR_SECONDARY_DESTINATIONS) {
      expect(
        within(menu).getByRole("button", { name: new RegExp(`^${label}`) }),
      ).toBeTruthy();
    }
    expect(
      within(menu).getByRole("button", { name: /Keyboard shortcuts/ }),
    ).toBeTruthy();
  });

  it("shifts the More menu back inside a narrow viewport instead of clipping it", () => {
    stubVisualViewportSize({ height: 768, width: 1024 });
    renderShell();

    const moreButton = getCompactMoreButton();
    vi.spyOn(moreButton, "getBoundingClientRect").mockReturnValue({
      bottom: 120,
      height: 40,
      left: 1000,
      right: 1016,
      toJSON: () => ({}),
      top: 80,
      width: 16,
      x: 1000,
      y: 80,
    } as DOMRect);
    fireEvent.click(moreButton);

    const menu = screen.getByRole("navigation", { name: "More" });
    const left = Number.parseInt(menu.style.left, 10);
    const width = Number.parseInt(menu.style.width, 10);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + width).toBeLessThanOrEqual(1024 - 8);
  });

  it("prints the scroll hint at the edge it describes", () => {
    stubVisualViewportSize({ height: 560, width: 1024 });
    renderShell();

    const moreButton = getCompactMoreButton();
    stubPlanningTriggerGeometry(moreButton);
    fireEvent.click(moreButton);

    const menu = screen.getByRole("navigation", { name: "More" });
    const scrollRegion = menu.querySelector<HTMLElement>(
      "[data-job-finder-more-menu-scroll-region]",
    );
    if (!scrollRegion) {
      throw new Error("More menu scroll region is missing");
    }
    Object.defineProperties(scrollRegion, {
      clientHeight: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 600 },
    });

    fireEvent.scroll(scrollRegion);
    expect(
      menu.querySelector('[data-bounded-floating-surface-scroll-hint="end"]'),
    ).toBeTruthy();
    expect(
      menu.querySelector('[data-bounded-floating-surface-scroll-hint="start"]'),
    ).toBeNull();

    scrollRegion.scrollTop = 300;
    fireEvent.scroll(scrollRegion);
    // The "there is more above" hint prints at the top, not in the footer.
    expect(
      menu.querySelector('[data-bounded-floating-surface-scroll-hint="start"]'),
    ).toBeTruthy();
    expect(
      menu.querySelector('[data-bounded-floating-surface-scroll-hint="end"]'),
    ).toBeNull();
  });

  it("routes Live Assistant through the shell and makes the current module a no-op", () => {
    const onNavigate = vi.fn();
    renderShell("/job-finder/discovery", onNavigate);

    const brandSwitch = expectSoleModuleSwitchInBrand();

    openModuleSwitch(brandSwitch);
    fireEvent.click(getModuleOption(brandSwitch, "live-assistant"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("/live-assistant");
    // Choosing an item closes the menu either way.
    expect(
      getModuleSwitchTrigger(brandSwitch).getAttribute("aria-expanded"),
    ).toBe("false");

    // Selecting the module the user is already in never navigates.
    openModuleSwitch(brandSwitch);
    fireEvent.click(getModuleOption(brandSwitch, "job-finder"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(
      getModuleSwitchTrigger(brandSwitch).getAttribute("aria-expanded"),
    ).toBe("false");

    // Reopening reaches the same destination the second time too.
    openModuleSwitch(brandSwitch);
    fireEvent.click(getModuleOption(brandSwitch, "live-assistant"));
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenLastCalledWith("/live-assistant");
  });
});

/**
 * Resolve which `pr-*` utility actually wins at a given CSS width.
 *
 * jsdom applies no stylesheet, so a `toContain("min-[900px]:pr-0")` assertion
 * proves only that a class is present — which is exactly how the compact
 * destination card came to sit 127px left of the module switcher while its
 * test was green. Tailwind v4 emits arbitrary `min-[…]`/`max-[…]` media
 * variants BEFORE the named breakpoints (in the shipped stylesheet
 * `min-[900px]:pr-0` lands at byte 141431 and `sm:pr-64` at 149486), so at
 * >=900px both matched and the later `sm` rule won at equal specificity. Only
 * `!important` reverses that.
 */
function resolveWinningPaddingRight(
  className: string,
  widthPx: number,
): string | null {
  const BASE = 0;
  const ARBITRARY_MEDIA = 1;
  const NAMED_BREAKPOINT = 2;
  const NAMED_BREAKPOINT_MIN_WIDTH: Readonly<Record<string, number>> = {
    lg: 1024,
    md: 768,
    sm: 640,
    xl: 1280,
  };

  let winner: { important: boolean; rank: number; utility: string } | null =
    null;

  for (const token of className.split(/\s+/).filter(Boolean)) {
    const separator = token.lastIndexOf(":");
    const variant = separator < 0 ? null : token.slice(0, separator);
    const rawUtility = token.slice(separator + 1);
    const important = rawUtility.startsWith("!");
    const utility = important ? rawUtility.slice(1) : rawUtility;

    if (!/^pr-/.test(utility)) {
      continue;
    }

    let rank = BASE;

    if (variant !== null) {
      const min = /^min-\[(\d+)px\]$/.exec(variant);
      const max = /^max-\[(\d+)px\]$/.exec(variant);
      const named = NAMED_BREAKPOINT_MIN_WIDTH[variant];

      if (min) {
        if (widthPx < Number(min[1])) {
          continue;
        }
        rank = ARBITRARY_MEDIA;
      } else if (max) {
        if (widthPx > Number(max[1])) {
          continue;
        }
        rank = ARBITRARY_MEDIA;
      } else if (named !== undefined) {
        if (widthPx < named) {
          continue;
        }
        rank = NAMED_BREAKPOINT;
      } else {
        continue;
      }
    }

    const beats =
      winner === null ||
      (important && !winner.important) ||
      (important === winner.important && rank >= winner.rank);

    if (beats) {
      winner = { important, rank, utility };
    }
  }

  return winner?.utility ?? null;
}

describe("compact navigation shares the header switcher's axis", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }

    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewMock,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderShellFor(
    platform: "darwin" | "win32",
    route = "/job-finder/discovery",
  ) {
    render(
      <MemoryRouter initialEntries={[route]}>
        <JobFinderShell platform={platform} workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    return screen.getByRole("navigation", { name: "Job Finder sections" });
  }

  // The four compact widths the r15 capture measured. The row is
  // `justify-center` in a single full-width grid column with symmetric
  // gutters, so the card is on the window centre line exactly when the
  // trailing reserve resolves to zero.
  it.each([1024, 1152, 1200, 1280])(
    "reserves nothing beside the card at %ipx on macOS, where the pills moved up to the header row",
    (width) => {
      const navigation = renderShellFor("darwin");

      expect(resolveWinningPaddingRight(navigation.className, width)).toBe(
        "pr-0",
      );
    },
  );

  it.each([1024, 1152, 1200])(
    "keeps the one-sided reserve at %ipx off macOS, where the pills stay in this row",
    (width) => {
      const navigation = renderShellFor("win32");

      expect(resolveWinningPaddingRight(navigation.className, width)).toBe(
        "pr-[max(20rem,calc(var(--job-finder-header-actions-width,0px)+0.75rem))]",
      );
    },
  );

  // From 1280px the header is one row: the card sits on the brand row between
  // the brand and the icon-only actions, held there by margins, not padding.
  it("drops the reserve at 1280px off macOS, where the card moves up to the brand row", () => {
    const navigation = renderShellFor("win32");

    expect(resolveWinningPaddingRight(navigation.className, 1280)).toBe("pr-0");
    expect(navigation.className).toContain("xl:row-start-1");
    expect(navigation.className).toContain("xl:mr-[25rem]");
  });

  it("paints the header mask opaquely across the scrolling gutter and nowhere else", () => {
    // Between the fixed header's bottom edge and the first row of a scrolling
    // route sits the shell's own 12px `pt-3`. A route's sticky sub-navigation
    // cannot cover that band — sticky is clamped to its containing block,
    // which starts below the padding — so the page scrolls through it and the
    // mask must be opaque across all of it. It must also stop there: a fade
    // tail past the gutter landed on the first row of every route at scroll 0
    // and read as a shadow across its buttons and headings.
    // A scrolling route, where the shell owns both gutters.
    renderShellFor("darwin", "/job-finder/settings");

    const mask = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-header-mask]",
    );

    expect(mask?.className).toContain(SHELL_HEADER_MASK_HEIGHT_CLASS);
    expect(mask?.className).toContain("bg-(--shell-header-bg)");
    expect(mask?.className).not.toContain("bg-gradient-to-b");
    expect(SHELL_HEADER_MASK_HEIGHT_PX).toBe(
      SHELL_SCROLLING_ROUTE_TOP_GUTTER_PX,
    );

    const main = document.querySelector<HTMLElement>("main");
    expect(main?.className).toContain(SHELL_SCROLLING_ROUTE_TOP_GUTTER_CLASS);
    expect(main?.className).toContain(
      SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CLASS,
    );
  });

  it("stops the locked-layout header mask before the route's live controls", () => {
    renderShellFor("darwin", "/job-finder/applications");

    const mask = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-header-mask]",
    );

    expect(mask?.className).toContain(SHELL_HEADER_MASK_HEIGHT_CLASS);
    expect(mask?.className).toContain("bg-(--shell-header-bg)");
    expect(mask?.className).not.toContain("bg-gradient-to-b");
  });

  it("leaves the sub-900px reserve exactly as it was", () => {
    // Below the module switcher's own breakpoint there is no axis to share,
    // and this band is under the 1024px minimum supported width. It must not
    // change as a side effect of the fix above.
    expect(
      resolveWinningPaddingRight(renderShellFor("darwin").className, 800),
    ).toBe("pr-64");
    cleanup();
    expect(
      resolveWinningPaddingRight(renderShellFor("win32").className, 800),
    ).toBe("pr-64");
  });
});
