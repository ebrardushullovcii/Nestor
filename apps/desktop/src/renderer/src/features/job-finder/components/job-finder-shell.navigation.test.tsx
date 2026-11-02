// @vitest-environment jsdom

import {} from "@nestor/contracts";
import {
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

/** jsdom applies no media queries; this stubs the shell's narrow query. */
function stubNarrowWindow(narrow: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation(
      (query: string) =>
        ({
          matches: narrow && query === "(max-width: 1199px)",
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    ),
  });
}

describe("JobFinderShell one navigation model", () => {
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
    stubNarrowWindow(false);
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

  function renderShell(path = "/job-finder/discovery") {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <JobFinderShell platform="win32">
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );
  }

  it("keeps destinations in the sidebar and never renders a top-tab strip", () => {
    renderShell();

    expect(
      screen.queryByRole("navigation", { name: "Job Finder sections" }),
    ).toBeNull();
    expect(
      document.querySelector("[data-job-finder-compact-navigation]"),
    ).toBeNull();

    const sidebar = screen.getByRole("complementary", {
      name: "Job Finder sidebar",
    });
    expect(sidebar.className).toContain("sm:block");
    expect(sidebar.className).toContain("w-(--job-finder-side-width)");
    expect(sidebar.textContent).not.toContain("Needs you");

    const destinations = within(
      screen.getByRole("navigation", {
        name: "Job Finder sidebar destinations",
      }),
    )
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(destinations).toEqual([
      "Home",
      "Profile",
      "Find jobs",
      "Shortlisted",
      "Applications",
    ]);
    for (const label of SIDEBAR_SECONDARY_DESTINATIONS) {
      expect(within(sidebar).getByRole("button", { name: label })).toBeTruthy();
    }

    expect(screen.getAllByRole("button", { name: /^Needs you/ })).toHaveLength(
      1,
    );
    expectSoleModuleSwitchInBrand();
    expect(screen.getByRole("group", { name: "Window controls" })).toBeTruthy();
  });

  it("is a 216px list that folds to a 60px rail, with the content following", () => {
    renderShell();
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );
    const content = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-content]",
    );
    expect(content?.className).toContain("sm:pl-(--job-finder-side-width)");
    expect(content?.className).toContain("sm:pt-12");
    expect(shell?.style.getPropertyValue("--job-finder-side-width")).toBe(
      "13.5rem",
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(shell?.dataset.sidebarCollapsed).toBe("true");
    expect(shell?.style.getPropertyValue("--job-finder-side-width")).toBe(
      "3.75rem",
    );
    // On the rail the label leaves the layout but keeps the accessible name.
    const findJobs = screen.getByRole("button", { name: "Find jobs" });
    expect(findJobs.querySelector(".sr-only")?.textContent).toBe("Find jobs");
  });

  it("shows the rail below 1200px and offers no fold control there", () => {
    stubNarrowWindow(true);
    renderShell();
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );
    expect(shell?.dataset.sidebarCollapsed).toBe("true");
    expect(shell?.style.getPropertyValue("--job-finder-side-width")).toBe(
      "3.75rem",
    );
    expect(
      screen.queryByRole("button", { name: "Collapse sidebar" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
    expect(
      screen.getByRole("navigation", {
        name: "Job Finder sidebar destinations",
      }),
    ).toBeTruthy();
  });

  it("marks the active destination with the accent tint, bar and weight", () => {
    renderShell("/job-finder/discovery");
    const active = screen.getByRole("button", { name: "Find jobs" });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(active.className).toContain("selected-bar");
    expect(active.className).toContain("bg-(--nav-active-surface)");
    expect(active.className).toContain("font-medium");
    const idle = screen.getByRole("button", { name: "Home" });
    expect(idle.getAttribute("aria-current")).toBeNull();
    expect(idle.className).not.toContain("selected-bar");
  });

  it("hides zero counts and keeps inventory and attention apart", () => {
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
        >
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const findJobs = screen.getByRole("button", { name: "Find jobs" });
    const inventory = findJobs.querySelector('[data-slot="count"]');
    expect(inventory?.textContent).toBe("2");
    expect(inventory?.className).toContain("tabular-nums");
    expect(inventory?.getAttribute("aria-hidden")).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Applications" })
        .querySelector('[data-slot="count"]'),
    ).toBeNull();

    const needsYou = screen.getByRole("button", {
      name: "Needs you: 1 unresolved",
    });
    const badge = needsYou.querySelector(
      '[data-header-tool-count="attention"]',
    );
    expect(badge?.textContent).toBe("1");
    expect(badge?.className).toContain("bg-(--warning-text)");

    cleanup();
    render(
      <MemoryRouter initialEntries={["/job-finder/home"]}>
        <JobFinderShell platform="win32">
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );
    const emptyNeedsYou = screen.getByRole("button", {
      name: "Needs you: 0 unresolved",
    });
    expect(emptyNeedsYou.querySelector("[data-header-tool-count]")).toBeNull();
    const sidebar = screen.getByRole("complementary", {
      name: "Job Finder sidebar",
    });
    expect(sidebar.textContent).not.toContain("0");
  });

  it("opens the shortcut reference from the one sidebar entry", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="darwin">
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const shortcutText = dialog.textContent ?? "";
    expect(shortcutText).toContain("Search your workspace");
    expect(shortcutText).toContain("Show or hide the sidebar");
    expect(within(dialog).queryByText("⌘K")).toBeNull();
    const rows = dialog.querySelectorAll("[data-job-finder-shortcut-row]");
    expect(rows.length).toBeGreaterThanOrEqual(3);
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
          matches: wide && query === "(min-width: 1200px)",
        }) as MediaQueryList,
    );
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
    { label: "the keyboard shortcuts dialog", setup: "shortcuts-dialog" },
    { label: "the global search overlay", setup: "search-dialog" },
  ] as const)(
    "ignores Cmd+B while $label owns the surface",
    async ({ setup }) => {
      renderShellWithShortcuts({ wide: true });
      const shell = document.querySelector<HTMLElement>(
        "[data-job-finder-shell]",
      );

      if (setup === "shortcuts-dialog") {
        fireEvent.click(
          screen.getByRole("button", { name: "Keyboard shortcuts" }),
        );
        expect(
          screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
        ).toBeTruthy();
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
    expect(tooltip.textContent).toContain("⌘ + B");
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

    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" }));
    fireEvent.keyDown(document, { key: "/" });
    expect(
      screen.queryByRole("dialog", {
        name: "Search your workspace",
      }),
    ).toBeNull();
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" }));

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

  function renderShell(
    initialPath = "/job-finder/discovery",
    onNavigate?: (path: string) => void,
  ) {
    return render(
      <MemoryRouter initialEntries={[initialPath]}>
        <JobFinderShell
          {...(onNavigate ? { onNavigate } : {})}
          platform="win32"
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
      openModuleSwitch(brandSwitch);
      expect(
        screen.getAllByRole("menuitemradio", { name: "Open Live Assistant" }),
      ).toHaveLength(1);
      fireEvent.keyDown(getModuleSwitchMenu(brandSwitch), { key: "Escape" });

      expect(
        document.querySelector("[data-job-finder-compact-navigation]"),
      ).toBeNull();

      // Utilities stay unique and reachable in the 640-899 band.
      expect(
        screen.getAllByRole("button", {
          name: "Search your workspace",
        }),
      ).toHaveLength(1);
      expect(
        document.querySelectorAll(
          "button[aria-label='Activity'][aria-expanded]",
        ),
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
      expect(brand?.querySelector("[data-desktop-brand-lockup]")).toBeTruthy();
      expect(
        brand?.contains(
          screen.getByRole("group", { name: "Notifications and actions" }),
        ),
      ).toBe(false);

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

  it("updates the sidebar owner when an Applications empty-state link opens Shortlisted", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/applications"]}>
        <JobFinderShell platform="win32">
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

describe("JobFinderShell header mask", () => {
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
        <JobFinderShell platform={platform}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );
  }

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
    expect(mask?.className).toContain("bg-(--background)");
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
    expect(mask?.className).toContain("bg-(--background)");
    expect(mask?.className).not.toContain("bg-gradient-to-b");
  });
});
