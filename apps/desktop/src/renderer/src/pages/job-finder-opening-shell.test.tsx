// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { JobFinderShell } from "@renderer/features/job-finder/components/job-finder-shell";
import { JobFinderOpeningShell } from "./job-finder-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "nestor");
});

function renderOpeningShell(
  platform: "darwin" | "linux" | "win32",
  initialEntry = "/job-finder/home",
  isMaximized = false,
  isFullScreen = false,
) {
  const controlsState = {
    isClosable: true,
    isFullScreen,
    isMaximized,
    isMinimizable: true,
  };
  const windowBridge = {
    close: vi.fn().mockResolvedValue({ ok: true }),
    getControlsState: vi.fn().mockResolvedValue(controlsState),
    minimize: vi.fn().mockResolvedValue(controlsState),
    onControlsStateChange: vi.fn(() => vi.fn()),
    toggleMaximize: vi.fn().mockResolvedValue(controlsState),
  };
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      ping: vi.fn().mockResolvedValue({ ok: true, platform }),
      window: windowBridge,
    },
  });
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <JobFinderOpeningShell />
    </MemoryRouter>,
  );
  return windowBridge;
}

describe("JobFinderOpeningShell platform geometry", () => {
  it("reserves the loaded shell frame instead of swapping from a centered loading card", () => {
    renderOpeningShell("darwin", "/job-finder");

    const header = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-header]",
    );
    const sidebar = document.querySelector<HTMLElement>(
      "[data-job-finder-sidebar]",
    );
    const content = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-content]",
    );

    expect(header?.className).toContain("fixed");
    expect(header?.className).toContain("min-[1440px]:h-14");
    const actions = document.querySelector("[data-job-finder-opening-actions]");
    expect(actions?.className).toContain("min-[1440px]:col-start-3");
    expect(actions?.className).toContain("min-[1440px]:col-span-1");
    expect(actions?.className).toContain("min-[1440px]:row-start-1");
    expect(sidebar?.className).toContain("w-(--job-finder-side-width)");
    expect(sidebar?.className).toContain("min-[1440px]:block");
    // The loaded shell marks this reserve important, because `sm:pt-[7.25rem]`
    // still matches at >=1440px and Tailwind emits it after arbitrary
    // variants. The opening frame has to carry the same importance or the
    // wide layout keeps the compact 116px reserve for one frame.
    expect(content?.className).toContain("min-[1440px]:!pt-14");
    expect(content?.className).toContain(
      "min-[1440px]:pl-(--job-finder-side-width)",
    );
    expect(screen.getByRole("status").textContent).toContain(
      "HomeSee progress, open tasks, and the best next step.",
    );
    expect(screen.queryByText("Loading Job Finder")).toBeNull();
    expect(
      document.querySelector("[data-job-finder-opening-placeholder]"),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-job-finder-sidebar] [aria-current="page"]')
        ?.textContent,
    ).toContain("Home");
  });

  it("paints both module names in full in the opening brand lockup", () => {
    // The first paint carries the same caption switch as the loaded shell, so
    // "Live Assistant" is never briefly shortened to "Interview …" and the
    // control does not relayout when the workspace arrives. It is the
    // wordmark's subtitle in the brand region, and it is the only one.
    renderOpeningShell("win32", "/job-finder/home");

    const brandSwitch = document.querySelector<HTMLElement>(
      "[data-desktop-brand] [data-desktop-brand-region] [data-desktop-brand-subtitle] [data-desktop-module-navigation]",
    );
    if (!brandSwitch) {
      throw new Error("Opening brand module switch is missing");
    }

    expect(brandSwitch.dataset.moduleSwitchVariant).toBe("caption");
    expect(
      document.querySelectorAll("[data-module-switch-trigger]"),
    ).toHaveLength(1);
    expect(
      document.querySelector(
        "[data-job-finder-sidebar] [data-desktop-module-navigation]",
      ),
    ).toBeNull();

    const trigger = brandSwitch.querySelector<HTMLButtonElement>(
      "[data-module-switch-trigger]",
    );
    if (!trigger) {
      throw new Error("Opening brand module switch trigger is missing");
    }
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-label")).toBe(
      "Job Finder, switch module",
    );
    expect(trigger.textContent).toBe("Job Finder");
    // Nothing is in the tree to name the other module until the menu opens.
    expect(
      document.querySelectorAll("[data-module-switch-option]"),
    ).toHaveLength(0);

    fireEvent.click(trigger);
    const menuId = trigger.getAttribute("aria-controls");
    const menu = menuId ? document.getElementById(menuId) : null;
    if (!menu) {
      throw new Error("Opening sidebar module switch menu is missing");
    }
    expect(menu.getAttribute("role")).toBe("menu");

    for (const [moduleName, label] of [
      ["job-finder", "Job Finder"],
      ["live-assistant", "Live Assistant"],
    ] as const) {
      const option = menu.querySelector<HTMLButtonElement>(
        `[data-module-switch-option="${moduleName}"]`,
      );
      const labelNode = option?.querySelector("span");
      expect(option?.className).toContain("w-full");
      expect(option?.getAttribute("role")).toBe("menuitemradio");
      for (const truncation of [
        "truncate",
        "text-ellipsis",
        "overflow-hidden",
        "line-clamp",
      ]) {
        expect(labelNode?.className).not.toContain(truncation);
        expect(option?.className).not.toContain(truncation);
      }
      expect(labelNode?.textContent).toBe(label);
    }
  });

  it("reserves the native traffic-light area on macOS", async () => {
    renderOpeningShell("darwin");
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-opening-shell]",
    );
    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");

    await waitFor(() => {
      expect(shell?.className).toContain("platform-darwin");
      expect(brand?.style.paddingInlineStart).toBe("5.5rem");
      // Mirrored on the trailing edge so the reserve cannot shift the centred
      // module switcher off the window centre.
      expect(brand?.style.paddingInlineEnd).toBe("5.5rem");
    });
    expect(screen.queryByRole("group", { name: "Window controls" })).toBeNull();
  });

  it("keeps the native traffic-light area reserved while macOS is maximized", async () => {
    renderOpeningShell("darwin", "/job-finder/home", true);
    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");

    await waitFor(() => {
      expect(brand?.style.paddingInlineStart).toBe("5.5rem");
    });
  });

  it("moves the opening wordmark fully left in native macOS fullscreen", async () => {
    renderOpeningShell("darwin", "/job-finder/home", true, true);
    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");

    await waitFor(() => {
      expect(brand?.style.paddingInlineStart).toBe("");
    });
  });

  it.each(["win32", "linux"] as const)(
    "does not reserve macOS traffic-light space on %s",
    async (platform) => {
      renderOpeningShell(platform);
      const shell = document.querySelector<HTMLElement>(
        "[data-job-finder-opening-shell]",
      );
      const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");

      await waitFor(() => {
        expect(shell?.className).toContain(`platform-${platform}`);
        expect(brand?.style.paddingInlineStart).toBe("");
        expect(brand?.style.paddingInlineEnd).toBe("");
      });
      const controls = screen.queryByRole("group", {
        name: "Window controls",
      });
      const windowControlInset = document.querySelector<HTMLElement>(
        "[data-desktop-header-window-control-inset]",
      );
      if (platform === "win32") {
        expect(controls).not.toBeNull();
        // The frameless Windows window has this header paint its own caption
        // buttons, so the trailing region reserves their exact width.
        expect(windowControlInset?.style.inlineSize).toBe("8.5rem");
      } else {
        expect(controls).toBeNull();
        expect(windowControlInset?.style.inlineSize).toBe("");
      }
    },
  );

  it("keeps native Windows controls available throughout workspace opening", async () => {
    const windowBridge = renderOpeningShell("win32");

    await screen.findByRole("group", { name: "Window controls" });
    fireEvent.click(screen.getByRole("button", { name: "Minimize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));

    expect(windowBridge.minimize).toHaveBeenCalledTimes(1);
    expect(windowBridge.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(windowBridge.close).toHaveBeenCalledTimes(1);
  });

  it("preserves the persisted collapsed rail width while opening", () => {
    window.localStorage.setItem(
      "nestor.job-finder.sidebar-collapsed.v1",
      "true",
    );
    renderOpeningShell("darwin");

    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-opening-shell]",
    );
    expect(shell?.style.getPropertyValue("--job-finder-side-width")).toBe(
      "4rem",
    );
  });
});

/**
 * The opening frame and the loaded shell paint the same chrome.
 *
 * Scope of this guard: it compares class token SETS, so membership and
 * importance markers are covered (`min-[900px]:pr-0` and `min-[900px]:!pr-0`
 * are different tokens and do not compare equal). It cannot judge stylesheet
 * emission order between two utilities that both match at one width — that is
 * `tailwind-variant-order.test.ts`'s job — and it cannot detect a faithfully
 * copied defect, because a copy that is wrong in the same way as its source
 * still compares equal. Coverage is therefore the thing to keep honest here:
 * every chrome element the opening frame re-declares belongs in the table
 * below.
 *
 * The reported defect was a first-paint jump: the skeleton drew a larger
 * wordmark at a different x, a module switcher off the loaded header's centred
 * track, and a rail grouped OVERVIEW / YOUR JOB SEARCH / YOUR DATA / SETUP AND
 * SAFETY with no pinned Settings footer and no Keyboard shortcuts control. Those are
 * all class strings and group tables that were hand-copied once and then
 * drifted, so this suite renders BOTH shells and requires the chrome to be
 * identical rather than trusting either copy.
 */
function renderLoadedShell(initialEntry = "/job-finder/home") {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      ping: vi.fn().mockResolvedValue({ ok: true, platform: "darwin" }),
      window: {
        close: vi.fn().mockResolvedValue(undefined),
        getControlsState: vi.fn().mockResolvedValue({
          isClosable: true,
          isFullScreen: false,
          isMaximized: false,
          isMinimizable: true,
        }),
        minimize: vi.fn().mockResolvedValue(undefined),
        onControlsStateChange: vi.fn(() => vi.fn()),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
  const { container } = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <JobFinderShell
        platform="darwin"
        workspace={
          {
            applicationRecords: [],
            discoveryJobs: [],
            profileSetupState: {
              completedAt: null,
              currentStep: "import",
              lastResumedAt: null,
              reviewItems: [],
              status: "not_started",
            },
            reviewQueue: [],
            userActionRequests: [],
          } as unknown as JobFinderRendererWorkspaceSnapshot
        }
      >
        <div />
      </JobFinderShell>
    </MemoryRouter>,
  );
  return container;
}

function renderOpeningShellContainer(initialEntry = "/job-finder/home") {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      ping: vi.fn().mockResolvedValue({ ok: true, platform: "darwin" }),
      window: {
        close: vi.fn().mockResolvedValue(undefined),
        getControlsState: vi.fn().mockResolvedValue({
          isClosable: true,
          isFullScreen: false,
          isMaximized: false,
          isMinimizable: true,
        }),
        minimize: vi.fn().mockResolvedValue(undefined),
        onControlsStateChange: vi.fn(() => vi.fn()),
        toggleMaximize: vi.fn().mockResolvedValue(undefined),
      },
    },
  });
  const { container } = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <JobFinderOpeningShell />
    </MemoryRouter>,
  );
  return container;
}

/**
 * The loaded shell is told its platform; the opening frame reads it from
 * `navigator.platform` and then confirms it through `ping()`. In Electron the
 * synchronous read already returns "MacIntel", so the first painted frame
 * carries `platform-darwin`; in jsdom `navigator.platform` is empty, so the
 * async confirmation has to settle before the chrome can be compared. That is
 * a test-environment gap, not a product one.
 */
async function renderSettledOpeningShell(
  initialEntry = "/job-finder/home",
): Promise<HTMLElement> {
  const container = renderOpeningShellContainer(initialEntry);
  await waitFor(() => {
    expect(
      container.querySelector("[data-job-finder-opening-shell]")?.className,
    ).toContain("platform-darwin");
  });
  return container;
}

/**
 * The class tokens on every box between the route's `<main>` and its `<h1>`,
 * innermost first. jsdom does no layout, so the title's offset is proved
 * structurally: the invariant (job-finder F73) is that exactly one box in this
 * chain supplies the 12px above a route title, wherever it lives. The shell
 * puts `pt-3` on `main` for scrolling routes and `pt-0` there for locked
 * routes, where `LockedScreenLayout` supplies the same `pt-3` itself.
 */
function titleOffsetChain(root: ParentNode): string[][] {
  const main = root.querySelector("main");
  const heading = main?.querySelector("h1");
  if (!main || !heading) {
    throw new Error("Missing route title");
  }
  const chain: string[][] = [];
  for (
    let node: HTMLElement | null = heading;
    node !== null;
    node = node.parentElement
  ) {
    chain.push(node.className.split(/\s+/u).filter(Boolean));
    if (node === main) {
      break;
    }
  }
  return chain;
}

function titleTopPaddingTokens(root: ParentNode): string[] {
  return titleOffsetChain(root)
    .flat()
    .filter((token) => /^pt-/u.test(token) && token !== "pt-0");
}

function classTokens(root: ParentNode, selector: string): string[] {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`Missing chrome element for selector: ${selector}`);
  }
  return element.className.split(/\s+/u).filter(Boolean).sort();
}

function sidebarStructure(root: ParentNode): string[] {
  const rail = root.querySelector<HTMLElement>("[data-job-finder-sidebar]");
  if (!rail) {
    throw new Error("Missing sidebar");
  }
  return Array.from(
    rail.querySelectorAll<HTMLElement>(
      '[role="group"], [data-job-finder-sidebar-scroll-region] button, [data-job-finder-sidebar-footer] button, [data-job-finder-sidebar-shortcuts-entry]',
    ),
  ).map((node) => {
    if (node.getAttribute("role") === "group") {
      return `group:${node.getAttribute("aria-label") ?? ""}`;
    }
    if (node.hasAttribute("data-job-finder-sidebar-shortcuts-entry")) {
      return "row:Keyboard shortcuts";
    }
    return `row:${(node.textContent ?? "").trim()}`;
  });
}

describe("JobFinderOpeningShell parity with the loaded shell", () => {
  beforeEach(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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
    vi.unstubAllGlobals();
  });

  it.each([
    ["header", "[data-job-finder-shell-header]"],
    ["header grid", "[data-job-finder-shell-header] > .job-finder-shell-grid"],
    ["brand row", "[data-desktop-brand]"],
    ["brand region", "[data-desktop-brand-region]"],
    [
      "brand subtitle",
      "[data-desktop-brand-region] [data-desktop-brand-subtitle]",
    ],
    [
      "module switcher",
      "[data-desktop-brand-region] [data-desktop-module-navigation]",
    ],
    ["window control inset", "[data-desktop-header-window-control-inset]"],
    ["root", "[data-job-finder-shell]"],
    // The two module options live in a menu that exists only while it is
    // open, so the element this parity table can compare at rest is the one
    // trigger each surface paints.
    [
      "module switch trigger",
      "[data-desktop-brand-region] [data-desktop-module-navigation] [data-module-switch-trigger]",
    ],
    ["sidebar", "[data-job-finder-sidebar]"],
    ["sidebar inner column", "[data-job-finder-sidebar] > div"],
    ["sidebar toggle row", "[data-job-finder-sidebar-toggle]"],
    ["sidebar destinations", "[data-job-finder-sidebar-scroll-region]"],
    ["sidebar footer", "[data-job-finder-sidebar-footer]"],
    [
      "sidebar journey list",
      '[data-job-finder-sidebar] section[aria-label="Your job search"] > div',
    ],
    ["sidebar footer settings row", "[data-job-finder-sidebar-footer] button"],
    [
      "active sidebar row",
      '[data-job-finder-sidebar-scroll-region] [aria-current="page"]',
    ],
    ["shell content", "[data-job-finder-shell-content]"],
    ["header mask", "[data-job-finder-shell-header-mask]"],
    ["route scroll owner", "[data-job-finder-shell-content] > main"],
    [
      "route container",
      "[data-job-finder-shell-content] > main > div:first-child",
    ],
  ])("paints the same %s as the loaded shell", async (_name, selector) => {
    const loaded = renderLoadedShell();
    const loadedTokens = classTokens(loaded, selector);
    cleanup();
    const opening = await renderSettledOpeningShell();

    expect(classTokens(opening, selector)).toEqual(loadedTokens);
  });

  it("paints the same compact destination row, apart from the audited reserve", async () => {
    const loaded = renderLoadedShell();
    const loadedTokens = classTokens(
      loaded,
      'nav[aria-label="Job Finder sections"]',
    );
    cleanup();
    const opening = await renderSettledOpeningShell();
    const openingTokens = classTokens(
      opening,
      'nav[aria-label="Job Finder sections"]',
    );
    const isReserve = (token: string) => /(?:^|:)!?pr-/u.test(token);

    expect(openingTokens.filter((token) => !isReserve(token))).toEqual(
      loadedTokens.filter((token) => !isReserve(token)),
    );
    // The trailing reserve is the one deliberate divergence, pinned on both
    // sides so neither can move unnoticed. The loaded shell's sm-band value is
    // dead weight that only ever applies between 640 and 899 — the band the
    // max-width utility owns — and wins there on emission order; it is an
    // audited exception in tailwind-variant-order.test.ts. The opening frame
    // states two non-overlapping bands instead, which resolves to the same
    // padding at every supported width (>=1024) with nothing to resolve.
    expect(loadedTokens.filter(isReserve)).toEqual([
      "max-[899px]:pr-40",
      "min-[900px]:!pr-0",
      "sm:pr-64",
    ]);
    expect(openingTokens.filter(isReserve)).toEqual([
      "max-[899px]:pr-40",
      "min-[900px]:pr-0",
    ]);
  });

  it("lists the same sidebar groups and destinations as the loaded rail", () => {
    const loaded = renderLoadedShell();
    const loadedStructure = sidebarStructure(loaded);
    cleanup();
    const opening = renderOpeningShellContainer();

    expect(loadedStructure).toContain("group:Workspace");
    expect(loadedStructure).toContain("row:Keyboard shortcuts");
    expect(sidebarStructure(opening)).toEqual(loadedStructure);
  });

  it.each([
    ["route scroll owner", "[data-job-finder-shell-content] > main"],
    [
      "route container",
      "[data-job-finder-shell-content] > main > div:first-child",
    ],
  ])(
    "paints the same %s as the loaded shell on a locked route",
    async (_name, selector) => {
      // Profile, Find jobs, Shortlisted and Applications own their own inner
      // scrolling, so the shell bounds the pane instead of applying the
      // scrolling route's 12/40px gutters. Cold-starting on one of them used
      // to paint the scrolling branch and snap on hydration.
      const loaded = renderLoadedShell("/job-finder/profile");
      const loadedTokens = classTokens(loaded, selector);
      cleanup();
      const opening = await renderSettledOpeningShell("/job-finder/profile");

      expect(classTokens(opening, selector)).toEqual(loadedTokens);
      // The two branches must really differ, or this case would pass against
      // a shell that had quietly lost its locked layout.
      expect(loadedTokens).not.toEqual(
        classTokens(renderLoadedShell("/job-finder/home"), selector),
      );
    },
  );

  it("carries the same rail width custom properties as the loaded shell", async () => {
    const loadedRoot = renderLoadedShell().querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );
    const loadedVars = [
      loadedRoot?.style.getPropertyValue("--job-finder-side-width"),
      loadedRoot?.style.getPropertyValue("--job-finder-side-width-sm"),
    ];
    cleanup();
    const openingRoot = (
      await renderSettledOpeningShell()
    ).querySelector<HTMLElement>("[data-job-finder-shell]");

    expect(loadedVars).toEqual(["17rem", "17rem"]);
    expect([
      openingRoot?.style.getPropertyValue("--job-finder-side-width"),
      openingRoot?.style.getPropertyValue("--job-finder-side-width-sm"),
    ]).toEqual(loadedVars);
  });

  it("gives every sidebar row the loaded row treatment, active and inactive", async () => {
    const rowClasses = (root: ParentNode) =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          "[data-job-finder-sidebar-scroll-region] button, [data-job-finder-sidebar-footer] button, [data-job-finder-sidebar-shortcuts-entry]",
        ),
      ).map((node) => node.className.split(/\s+/u).filter(Boolean).sort());
    // The shortcuts row is the one deliberately non-interactive row here: the
    // dialog belongs to the loaded shell, so the opening frame reserves the
    // row as an `aria-hidden` span. A span that lit up on hover would offer an
    // affordance it does not have, so its hover-only utilities are dropped —
    // and that difference is asserted below rather than waved through.
    const withoutHover = (tokens: string[]) =>
      tokens.filter((token) => !token.startsWith("hover:"));
    const HOVER_TOKENS = [
      "hover:bg-secondary/50",
      "hover:border-l-(--border-strong)",
      "hover:text-foreground",
    ];

    const loaded = renderLoadedShell();
    const loadedRows = rowClasses(loaded);
    cleanup();
    const opening = await renderSettledOpeningShell();
    const openingRows = rowClasses(opening);

    // Twelve destinations plus the shortcuts entry. Home is active and the
    // rest are not, so this single comparison covers the active fill and the
    // inactive hover treatment in one pass.
    expect(loadedRows.length).toBeGreaterThan(0);
    expect(openingRows).toHaveLength(loadedRows.length);
    const loadedShortcutsRow = loadedRows.at(-1) ?? [];
    const openingShortcutsRow = openingRows.at(-1) ?? [];

    expect(openingRows.slice(0, -1)).toEqual(loadedRows.slice(0, -1));
    expect(withoutHover(openingShortcutsRow)).toEqual(
      withoutHover(loadedShortcutsRow),
    );
    expect(
      loadedShortcutsRow.filter((token) => token.startsWith("hover:")),
    ).toEqual(HOVER_TOKENS);
    expect(
      openingShortcutsRow.filter((token) => token.startsWith("hover:")),
    ).toEqual([]);
  });

  it.each([
    ["root", "[data-job-finder-shell]"],
    ["sidebar inner column", "[data-job-finder-sidebar] > div"],
    ["sidebar toggle row", "[data-job-finder-sidebar-toggle]"],
    ["sidebar destinations", "[data-job-finder-sidebar-scroll-region]"],
    ["sidebar footer", "[data-job-finder-sidebar-footer]"],
    [
      "sidebar journey list",
      '[data-job-finder-sidebar] section[aria-label="Your job search"] > div',
    ],
    [
      "active sidebar row",
      '[data-job-finder-sidebar-scroll-region] [aria-current="page"]',
    ],
  ])(
    "paints the same collapsed %s as the loaded rail",
    async (_name, selector) => {
      window.localStorage.setItem(
        "nestor.job-finder.sidebar-collapsed.v1",
        "true",
      );
      const loaded = renderLoadedShell();
      const loadedTokens = classTokens(loaded, selector);
      cleanup();
      const opening = await renderSettledOpeningShell();

      expect(classTokens(opening, selector)).toEqual(loadedTokens);
    },
  );

  it.each([
    ["scrolling", "/job-finder/settings"],
    ["locked", "/job-finder/profile"],
    ["locked", "/job-finder/discovery"],
    ["locked", "/job-finder/applications"],
  ])(
    "puts exactly one 12px title offset above the %s route %s",
    async (_kind, route) => {
      // The capture caught this as a +12px dy on the h1 for the three locked
      // routes and 0 for Settings: the locked branch correctly moved the
      // gutter off `main`, but nothing put it back above the title, so the
      // opening title sat 12px high and snapped down on hydration. The
      // opening frame now goes through the real LockedScreenLayout, which
      // owns that offset.
      const opening = await renderSettledOpeningShell(route);

      expect(titleTopPaddingTokens(opening)).toEqual(["pt-3"]);
    },
  );

  it("routes the locked opening title through the real locked layout", async () => {
    const opening = await renderSettledOpeningShell("/job-finder/profile");
    const topContent = opening.querySelector<HTMLElement>(
      "[data-locked-screen-top-content]",
    );

    // The offset must come from the shared layout, not from a `pt-3` copied
    // onto the skeleton: a copy would satisfy the token count above while
    // still being free to drift away from the layout that owns the rule.
    expect(topContent).not.toBeNull();
    expect(topContent?.className).toContain("pt-3");
    // The loaded Profile h1 reads "Your profile", not the sidebar label, so the
    // opening shell paints the same text and hydration never swaps it.
    expect(topContent?.querySelector("h1")?.textContent).toBe("Your profile");
    expect(
      opening.querySelector("[data-locked-screen-scroll-area]"),
    ).not.toBeNull();
    // Scrolling routes must NOT gain the locked layout, or they would carry
    // the 12px twice.
    cleanup();
    const scrolling = await renderSettledOpeningShell("/job-finder/settings");
    expect(
      scrolling.querySelector("[data-locked-screen-top-content]"),
    ).toBeNull();
    expect(titleTopPaddingTokens(scrolling)).toEqual(["pt-3"]);
  });

  it("keeps the Home-shaped skeleton off every other route", () => {
    const openingBlocks = (root: ParentNode) =>
      Array.from(
        root.querySelectorAll<HTMLElement>("[data-job-finder-opening-block]"),
      ).map((node) => node.getAttribute("data-job-finder-opening-block"));

    // The primary-tinted recommended-next card is Home's, and it used to paint
    // on every route: cold-starting on Settings briefly showed a Home-shaped
    // card.
    expect(openingBlocks(renderOpeningShellContainer())).toEqual([
      "status",
      "recommended-next",
      "search",
      "notifications",
    ]);
    cleanup();
    expect(
      openingBlocks(renderOpeningShellContainer("/job-finder/settings")),
    ).toEqual(["status", "route-placeholder"]);
    cleanup();
    expect(
      openingBlocks(renderOpeningShellContainer("/job-finder/applications")),
    ).toEqual(["status", "route-placeholder"]);
  });

  it("stacks the Home skeleton in one column in the loaded block order", () => {
    const opening = renderOpeningShellContainer();
    const placeholder = opening.querySelector<HTMLElement>(
      "[data-job-finder-opening-placeholder]",
    );

    expect(
      Array.from(
        opening.querySelectorAll<HTMLElement>(
          "[data-page-header], [data-job-finder-opening-block]",
        ),
      ).map(
        (node) =>
          node.getAttribute("data-job-finder-opening-block") ?? "page-header",
      ),
    ).toEqual([
      "page-header",
      "status",
      "recommended-next",
      "search",
      "notifications",
    ]);
    // The loaded Home is a single-column stack; the skeleton used to open as a
    // two-column grid that collapsed the moment the workspace resolved.
    expect(placeholder?.className).not.toMatch(/(sm|md|lg|xl):grid-cols-/u);
  });
});
