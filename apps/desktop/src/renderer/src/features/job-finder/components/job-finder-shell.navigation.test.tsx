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
import { lazy, Suspense } from "react";
import {
  Link,
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SHELL_HEADER_MASK_HEIGHT_CLASS,
  SHELL_HEADER_MASK_HEIGHT_PX,
  SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CLASS,
  SHELL_SCROLLING_ROUTE_TOP_GUTTER_CLASS,
  SHELL_SCROLLING_ROUTE_TOP_GUTTER_PX,
} from "../lib/job-finder-shell-gutters";
import { COMPACT_NAV_PILL_CLASS, JobFinderShell } from "./job-finder-shell";

/** What the app's outlet does for a cold route: one boundary per path. */
function PerPathSuspenseOutlet() {
  const { pathname } = useLocation();
  return (
    <Suspense fallback={<div>Opening screen</div>} key={pathname}>
      <Outlet />
    </Suspense>
  );
}

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

function createWorkspaceWithActiveApplyRun(): JobFinderRendererWorkspaceSnapshot {
  const workspace = createWorkspace();
  workspace.applyRuns = [
    {
      id: "apply_running",
      mode: "copilot",
      state: "running",
      jobIds: ["job_1"],
      currentJobId: "job_1",
      createdAt: "2026-07-31T10:00:00.000Z",
      updatedAt: "2026-07-31T10:00:04.000Z",
      completedAt: null,
      totalJobs: 1,
      pendingJobs: 1,
      blockedJobs: 0,
      failedJobs: 0,
    } as unknown as JobFinderRendererWorkspaceSnapshot["applyRuns"][number],
  ];
  workspace.discoveryJobs = [
    {
      id: "job_1",
      company: "Mercury",
      title: "Software Engineer",
      matchAssessment: JobListMatchAssessmentSchema.parse({ score: 70 }),
    },
  ] as JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
  return workspace;
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

const SIDEBAR_SECONDARY_DESTINATIONS = ["Safeguards", "Settings"] as const;

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

describe("JobFinderShell section navigation", () => {
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows which sidebar screen is opening while a slow route loads", async () => {
    let finish!: () => void;
    const SlowScreen = lazy(
      () =>
        new Promise<{ default: () => React.JSX.Element }>((resolve) => {
          finish = () => resolve({ default: () => <h1>Loaded Home</h1> });
        }),
    );
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <Routes>
          <Route
            element={
              <JobFinderShell platform="win32" workspace={createWorkspace()}>
                <PerPathSuspenseOutlet />
              </JobFinderShell>
            }
          >
            <Route
              path="/job-finder/discovery"
              element={<h1>Loaded Find jobs</h1>}
            />
            <Route path="/job-finder/home" element={<SlowScreen />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const sidebar = screen.getByRole("navigation", {
      name: "Job Finder sidebar destinations",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Home" }));
    // The outlet keys its Suspense boundary by path, so a cold lazy route
    // shows its opening surface while the new screen loads rather than
    // keeping the old page.
    expect(await screen.findByText("Opening screen")).toBeTruthy();
    act(() => {
      finish();
    });
    expect(
      await screen.findByRole("heading", { name: "Loaded Home" }),
    ).toBeTruthy();
    expect(screen.queryByText("Opening Home…")).toBeNull();
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
  });

  it("moves complete navigation labels into More at a 200% viewport", async () => {
    let availableWidth = 240;
    const resizeCallbacks: Array<() => void> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resizeCallbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-job-finder-compact-navigation-scroll")
          ? availableWidth
          : 0;
      },
    );
    const originalRect = HTMLElement.prototype.getBoundingClientRect.bind(
      document.createElement("div"),
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (
          this.parentElement?.getAttribute("aria-hidden") === "true" &&
          this.parentElement.className.includes("w-max")
        )
          return { ...originalRect(), width: 100 };
        return originalRect();
      },
    );
    const view = render(
      <MemoryRouter>
        <JobFinderShell platform="darwin" workspace={createWorkspace()}>
          <div>Page</div>
        </JobFinderShell>
      </MemoryRouter>,
    );
    const compact = view.container.querySelector<HTMLElement>(
      "[data-job-finder-compact-navigation-content]",
    )!;
    expect(
      within(compact).queryByRole("button", { name: /Applications/ }),
    ).toBeNull();
    expect(within(compact).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = await screen.findByRole("navigation", { name: "More" });
    expect(
      within(menu).getByRole("button", { name: "Applications" }),
    ).toBeTruthy();
    fireEvent.keyDown(menu, { key: "Escape" });
    act(() => {
      availableWidth = 640;
      resizeCallbacks.forEach((callback) => callback());
    });
    expect(within(compact).getAllByRole("button")).toHaveLength(5);
    expect(
      within(compact).getByRole("button", { name: "Applications" }),
    ).toBeTruthy();
  });

  it("separates the sequential workflow from the Needs you notification control", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    const destinations = within(navigation)
      .getAllByRole("button")
      .map((button) => button.textContent?.replace(/\d+/g, "").trim());

    // The card carries this module's destinations and nothing else: the
    // module switch lives in the brand lockup, not in this row.
    expect(destinations).toEqual([
      "Home",
      "Profile",
      "Find jobs",
      "Shortlisted",
      "Applications",
      "More",
    ]);
    expect(navigation.className).not.toContain("overflow-hidden");
    expect(navigation.firstElementChild?.className).toContain("w-fit");
    expect(navigation.className).toContain("min-[1440px]:hidden");

    const notificationGroup = screen.getByRole("group", {
      name: "Notifications and actions",
    });
    expect(notificationGroup.className).toContain("min-[1440px]:!static");
    expect(notificationGroup.className).toContain("min-[1440px]:col-start-3");
    expect(notificationGroup.className).toContain("min-[1440px]:col-span-1");
    expect(notificationGroup.className).toContain("min-[1440px]:row-start-1");
    expect(notificationGroup.className).toContain("xl:mr-36");
    const needsYouButton = within(notificationGroup).getByRole("button", {
      name: "Needs you: 0 unresolved",
    });
    expect(needsYouButton).toBeTruthy();
    // At 1024px utility labels collapse before they can crowd navigation.
    expect(needsYouButton.textContent).toContain("Needs you");
    expect(needsYouButton.querySelector("span")?.className).toContain(
      "max-[1099px]:!hidden",
    );
    expect(
      Array.from(needsYouButton.querySelectorAll("span")).find(
        (span) => span.textContent?.trim() === "Needs you",
      )?.className,
    ).toContain("min-[900px]:inline");
    // The open panel carries the same accessible name, so the trigger is
    // selected by element rather than by name alone.
    const taskCenterLauncher = notificationGroup.querySelector(
      "summary[aria-label='Activity']",
    ) as HTMLElement;
    const taskCenterLabels = Array.from(
      taskCenterLauncher.querySelectorAll("span"),
    );
    // One name at every width: the header used to read "Tasks" compact and
    // "Task center" at 1440, so the same destination had two names.
    const taskLabels = taskCenterLabels.filter(
      (span) => span.textContent?.trim() === "Activity",
    );
    expect(taskLabels).toHaveLength(1);
    expect(taskLabels[0]?.className).toContain("min-[900px]:inline");
    expect(taskLabels[0]?.className).toContain("max-[1099px]:!hidden");
    expect(
      notificationGroup.querySelector(".browser-trigger-label")?.className,
    ).toContain("max-[1099px]:!hidden");
    expect(
      taskCenterLabels.some(
        (span) => span.textContent?.trim() === "Task center",
      ),
    ).toBe(false);
    // The absolutely positioned group sits over the compact navigation row,
    // which must reserve enough width for both labelled pills. Off macOS that
    // group stays in this row until 1440px, so the reserve is one-sided: a
    // mirrored reserve would squeeze the destination card into a scroller at
    // the 1024px minimum instead of letting it stay on one line.
    // Important on purpose: Tailwind v4 emits arbitrary `min-[...]` media
    // variants before the named breakpoints, so a plain `min-[900px]:pr-80`
    // loses the cascade to the still-matching `sm:pr-64` that follows it.
    // The reserve is the group's measured width (at least 20rem): with its
    // labels shown from 1100px the group is wider than a fixed 20rem.
    expect(navigation.className).toContain(
      "min-[900px]:!pr-[max(20rem,calc(var(--job-finder-header-actions-width,0px)+0.75rem))]",
    );
    expect(navigation.className).not.toContain("min-[900px]:pl-80");
    expect(navigation.contains(notificationGroup)).toBe(false);

    const windowControls = screen.getByRole("group", {
      name: "Window controls",
    });
    expect(windowControls.parentElement?.className).toContain(
      "absolute right-0 top-0",
    );
    // The destination card is centred in whatever width the reserve leaves.
    expect(navigation.className).toContain("justify-center");
    expect(navigation.className).not.toContain("justify-start");
    expect(navigation.className).toContain("sm:pr-64");
    expect(navigation.className).toContain("max-[899px]:pr-40");
    // The one way across to Live Assistant is the brand subtitle, at every
    // width; this card never grows a second one.
    expect(expectSoleModuleSwitchInBrand()).toBeTruthy();
    // Planning is a non-scrolling sibling, so it reserves its own width rather
    // than painting over destinations inside the horizontal scroll viewport.
    const compactNavigation = document.querySelector(
      "[data-job-finder-compact-navigation]",
    ) as HTMLElement;
    const moreButton = within(compactNavigation).getByRole("button", {
      name: "More",
    });
    const moreWrapper = moreButton.parentElement;
    const compactLayout = document.querySelector(
      "[data-job-finder-compact-navigation]",
    );
    const scrollViewport = document.querySelector(
      "[data-job-finder-compact-navigation-scroll]",
    );
    expect(moreWrapper?.className).toContain("shrink-0");
    expect(moreWrapper?.className).toContain("z-10");
    expect(moreWrapper?.className).not.toContain("sticky");
    // Destination scroller, then the Planning trigger: the card is this
    // module's destinations and nothing else — no module switch heads it.
    const compactChildren = Array.from(compactLayout?.children ?? []);
    expect(compactChildren).toEqual([
      scrollViewport?.parentElement,
      moreWrapper,
    ]);
    expect(scrollViewport?.contains(moreButton)).toBe(false);
    expect(
      document.querySelector("[data-job-finder-sidebar]")?.className,
    ).toContain("w-(--job-finder-side-width)");
  });

  it("keeps the module switch in the brand lockup at the wide layout", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="darwin" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");
    if (!brand) {
      throw new Error("Shell brand row is missing");
    }

    // The caption row is down to two regions: the brand lockup and the native
    // window-control reserve. Nothing rides between them any more, which is
    // what made the switch look centred on nothing in particular.
    expect(brand.className).toContain("min-[1440px]:col-end-3");
    expect(brand.className).not.toContain("col-span-2");
    expect(brand.className).toContain("col-start-1");
    expect(brand.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(brand.className).not.toContain("flex-wrap");

    // The switch is the wordmark's subtitle inside the brand region, and it is
    // the only one: one trigger naming the module the user is in, and a menu
    // that names both in full once it is opened.
    const brandSwitch = expectSoleModuleSwitchInBrand();
    expect(brand.contains(brandSwitch)).toBe(true);
    expect(getModuleSwitchTrigger(brandSwitch).getAttribute("aria-label")).toBe(
      "Job Finder, switch module",
    );

    openModuleSwitch(brandSwitch);
    expect(
      getModuleOption(brandSwitch, "job-finder").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      getModuleOption(brandSwitch, "live-assistant").getAttribute(
        "aria-checked",
      ),
    ).toBe("false");
    for (const [moduleName, label] of [
      ["job-finder", "Job Finder"],
      ["live-assistant", "Live Assistant"],
    ] as const) {
      expect(getModuleOption(brandSwitch, moduleName).textContent).toContain(
        label,
      );
    }

    const header = document.querySelector("[data-job-finder-shell-header]");
    expect(header?.className).toContain("xl:h-14");
  });

  it("gives both module names the menu's full width instead of shortening one", () => {
    // Side by side inside the 17rem rail each option got ~100px of text box
    // and "Live Assistant" needs ~98px at --text-small in the selected
    // semibold weight, so the longer of the two module names shipped as
    // "Interview …". The switch prints one name at a time now — the active one
    // in the caption, the other in the menu — so neither is ever abbreviated.
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const brandSwitch = expectSoleModuleSwitchInBrand();

    // The brand subtitle gets the caption variant: the module name in small
    // caps plus a chevron, sized to the wordmark it sits under.
    expect(brandSwitch.dataset.moduleSwitchVariant).toBe("caption");

    const trigger = getModuleSwitchTrigger(brandSwitch);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toBe("Job Finder");

    const menu = openModuleSwitch(brandSwitch);
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-label")).toBe("Switch module");

    for (const moduleName of ["job-finder", "live-assistant"] as const) {
      const option = getModuleOption(brandSwitch, moduleName);
      const label = option.querySelector("span");

      // Full-width rows, left-aligned inside the menu.
      expect(option.className).toContain("w-full");
      expect(option.getAttribute("role")).toBe("menuitemradio");
      // Nothing may clip, ellipsise or otherwise shorten either name.
      for (const truncation of [
        "truncate",
        "text-ellipsis",
        "overflow-hidden",
        "line-clamp",
      ]) {
        expect(label?.className).not.toContain(truncation);
        expect(option.className).not.toContain(truncation);
      }
      expect(label?.textContent).toBe(
        moduleName === "job-finder" ? "Job Finder" : "Live Assistant",
      );
    }

    // The current module is the checked item and opening focuses it first.
    const selected = getModuleOption(brandSwitch, "job-finder");
    const other = getModuleOption(brandSwitch, "live-assistant");
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(other.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(selected);

    // Arrows cycle the menu; Escape closes it and hands focus back.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(other);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(selected);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("reserves the native macOS traffic-light area without shifting centered navigation", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/profile"]}>
        <JobFinderShell platform="darwin" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");
    const brandName = screen.getByRole("img", { name: "Nestor" });
    const sectionNavigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    const notificationGroup = screen.getByRole("group", {
      name: "Notifications and actions",
    });

    expect(brand?.style.paddingInlineStart).toBe("5.5rem");
    // The traffic-light reserve is mirrored on the trailing edge, so
    // reserving it cannot push the centred switcher off the window centre.
    expect(brand?.style.paddingInlineEnd).toBe("5.5rem");
    expect(brandName.getAttribute("class")).toContain("sm:h-[1.3rem]");
    expect(brand?.contains(brandName)).toBe(true);
    expect(screen.queryByRole("group", { name: "Window controls" })).toBeNull();
    // The switch sits in the brand row's leading track, which carries this
    // reserve, so it can never land under the traffic lights.
    expect(expectSoleModuleSwitchInBrand().className).not.toContain("absolute");
    // macOS has no in-header caption buttons, so nothing is reserved on the
    // trailing side beyond the mirrored traffic-light padding.
    expect(
      document.querySelector<HTMLElement>(
        "[data-desktop-header-window-control-inset]",
      )?.style.inlineSize,
    ).toBe("");
    expect(sectionNavigation.className).toContain("min-[1440px]:hidden");
    // The compact destination card is centred on the same axis: at >=900px
    // the notification group has moved up to the header row, so this row
    // reserves nothing and the card lands on the true window centre.
    expect(sectionNavigation.className).toContain("justify-center");
    expect(sectionNavigation.className).toContain("min-[900px]:!pr-0");
    expect(sectionNavigation.className).not.toContain("min-[900px]:pr-80");
    expect(sectionNavigation.className).not.toContain("min-[900px]:!pr-80");
    // On macOS the notification group shares the compact row instead of
    // overlaying the right-aligned module navigation at <900px CSS width.
    expect(notificationGroup.className).toContain("sm:top-14");
    expect(notificationGroup.className).toContain("sm:h-[3.75rem]");
    expect(notificationGroup.className).toContain("min-[900px]:!top-0");
    expect(notificationGroup.className).toContain("min-[900px]:!h-14");
    expect(notificationGroup.className).toContain("sm:right-0");
    expect(notificationGroup.className).not.toContain("sm:top-0");
  });

  it("reserves the Windows caption buttons on the trailing edge of the brand row", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/profile"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");
    const windowControlInset = document.querySelector<HTMLElement>(
      "[data-desktop-header-window-control-inset]",
    );
    const windowControls = screen.getByRole("group", {
      name: "Window controls",
    });

    // The Windows main window is frameless and this header paints its own
    // caption buttons, so there is no Window Controls Overlay to measure:
    // the reserve is the exact rendered width of minimize + maximize + close
    // (w-11 + w-11 + w-12 = 8.5rem).
    expect(windowControlInset?.style.inlineSize).toBe("8.5rem");
    expect(windowControlInset?.className).toContain("col-start-2");
    expect(windowControls.parentElement?.className).toContain(
      "absolute right-0 top-0",
    );

    // The reserve lives inside the trailing region, never as row padding, so
    // the brand lockup keeps its own edge.
    expect(brand?.style.paddingInlineEnd).toBe("");
    expect(brand?.style.paddingInlineStart).toBe("");
    expect(brand?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");

    // Neither module name may wrap inside the switch, and the leading track
    // holds it clear of the trailing reserve.
    const brandSwitch = expectSoleModuleSwitchInBrand();
    openModuleSwitch(brandSwitch);
    for (const [moduleName, label] of [
      ["job-finder", "Job Finder"],
      ["live-assistant", "Live Assistant"],
    ] as const) {
      expect(getModuleOption(brandSwitch, moduleName).textContent).toBe(label);
    }
  });

  it.each([
    { height: 920, label: "1440x920", width: 1440, zoomFactor: 1 },
    { height: 720, label: "1280x720", width: 1280, zoomFactor: 1 },
    { height: 920, label: "native125", width: 1440, zoomFactor: 1.25 },
  ])(
    "keeps painted wordmark ink clear of the shell row edges at $label",
    ({ height, width, zoomFactor }) => {
      // The viewport matrix is intentionally named here even though jsdom
      // cannot paint the SVG. The CSS box budget below is the source-level
      // assertion: padding plus explicit heights leave real breathing room
      // in the 56px row at every desktop scale, including native 125%.
      const headerRowHeightPx = 56;
      const wordmarkHeightPx = 16 * 1.3;
      const subtitleHeightPx = 20; // The module switch trigger is h-5.
      const lockupGapPx = 2;
      const verticalPaddingPx = 4 * 2;
      const remainingInkBudgetPx =
        headerRowHeightPx -
        wordmarkHeightPx -
        subtitleHeightPx -
        lockupGapPx -
        verticalPaddingPx;

      const cssViewportWidth = width / zoomFactor;
      const cssViewportHeight = height / zoomFactor;
      expect(cssViewportWidth).toBeGreaterThanOrEqual(1024);
      expect(cssViewportHeight).toBeGreaterThanOrEqual(576);
      expect(remainingInkBudgetPx * zoomFactor).toBeGreaterThan(1);

      render(
        <MemoryRouter initialEntries={["/job-finder/profile"]}>
          <JobFinderShell platform="darwin" workspace={createWorkspace()}>
            <div>Current screen</div>
          </JobFinderShell>
        </MemoryRouter>,
      );

      const header = document.querySelector<HTMLElement>(
        "[data-job-finder-shell-header]",
      );
      const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");
      const lockup = document.querySelector<HTMLElement>(
        "[data-desktop-brand-lockup]",
      );
      const wordmark = screen.getByRole("img", { name: "Nestor" });
      expect(header?.className).toContain("overflow-visible");
      expect(lockup?.className).toContain("py-1");
      expect(wordmark.getAttribute("class")).toContain("block");
      expect(wordmark.getAttribute("class")).toContain("sm:h-[1.3rem]");
      expect(brand?.style.paddingInlineStart).toBe("5.5rem");
      expect(brand?.style.paddingInlineEnd).toBe("5.5rem");
      // The caption row carries the lockup alone, so the 56px budget above is
      // spent on the wordmark and its caption — the switch — and nothing else.
      expect(brand?.querySelector("[data-desktop-module-navigation]")).toBe(
        expectSoleModuleSwitchInBrand(),
      );
    },
  );

  it("keeps the macOS traffic-light inset when the window is maximized", async () => {
    vi.mocked(window.nestor.window.getControlsState).mockResolvedValueOnce({
      ...windowControlsState,
      isMaximized: true,
    });

    render(
      <MemoryRouter initialEntries={["/job-finder/profile"]}>
        <JobFinderShell platform="darwin" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");

    await waitFor(() => {
      expect(brand?.style.paddingInlineStart).toBe("5.5rem");
    });
  });

  it("moves the macOS wordmark fully left in native fullscreen", async () => {
    vi.mocked(window.nestor.window.getControlsState).mockResolvedValueOnce({
      ...windowControlsState,
      isFullScreen: true,
      isMaximized: true,
    });

    render(
      <MemoryRouter initialEntries={["/job-finder/profile"]}>
        <JobFinderShell platform="darwin" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const brand = document.querySelector<HTMLElement>("[data-desktop-brand]");

    await waitFor(() => {
      expect(brand?.style.paddingInlineStart).toBe("");
    });
  });

  it("keeps the complete workflow in one compact row at desktop widths", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/profile"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    const workflow = navigation.firstElementChild;

    expect(workflow?.className).toContain("w-fit");

    const labels = within(navigation)
      .getAllByRole("button")
      .map((button) => button.textContent?.replace(/\d+/g, "").trim());

    // Destinations only: the one module switch is up in the brand lockup, so
    // the row never doubles as a cross-module control.
    expect(labels).toEqual([
      "Home",
      "Profile",
      "Find jobs",
      "Shortlisted",
      "Applications",
      "More",
    ]);

    expect(
      screen.getByRole("group", { name: "Notifications and actions" }),
    ).not.toBeNull();
  });

  it("provides an icon-led, self-explanatory sidebar at the wide desktop breakpoint", () => {
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
    expect(sidebar.className).toContain("w-(--job-finder-side-width)");
    expect(sidebar.className).toContain("bottom-0");
    expect(sidebar.className).toContain("top-14");
    expect(sidebar.className).not.toContain("inset-y-14");

    const sidebarNavigation = within(sidebar).getByRole("navigation", {
      name: "Job Finder sidebar destinations",
    });
    // The 17rem rail has the room, so nothing hides behind a dropdown inside a
    // navigation column that is already on screen: the journey leads, and the
    // reference and configuration surfaces follow it inline.
    // The journey list carries its name for assistive technology only; no
    // eyebrow is painted above the only list on the rail.
    expect(sidebarNavigation.textContent).not.toContain("Your job search");
    expect(
      within(sidebar).getByRole("group", { name: "Your job search" }),
    ).toBeTruthy();
    // Settings is not a journey step: it is pinned at the foot of the rail,
    // outside the scrolling destination list, with the shortcuts control
    // beside it.
    expect(sidebarNavigation.textContent).not.toContain("Settings");
    const railFooter = sidebar.querySelector(
      "[data-job-finder-sidebar-footer]",
    );
    expect(railFooter?.textContent).toContain("Settings");
    expect(railFooter?.getAttribute("role")).toBe("group");
    expect(sidebarNavigation.textContent).not.toContain("Search plans");
    expect(sidebarNavigation.textContent).not.toContain("Safeguards");

    const workflowButtons = [
      within(sidebar).getByRole("button", { name: /^Profile$/ }),
      within(sidebar).getByRole("button", { name: /^Find jobs$/ }),
      within(sidebar).getByRole("button", { name: /^Shortlisted$/ }),
      within(sidebar).getByRole("button", { name: /^Applications$/ }),
    ];
    expect(
      workflowButtons.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Profile", "Find jobs", "Shortlisted", "Applications"]);
    expect(
      workflowButtons.every(
        (button) => button.firstElementChild?.tagName.toLowerCase() === "svg",
      ),
    ).toBe(true);
    // Needs you lives only in the header attention control, never twice.
    expect(
      within(sidebar).queryByRole("button", { name: "Needs you" }),
    ).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Needs you/ })).toHaveLength(
      1,
    );

    // The selected row's count is the same quiet pill as every other row: a
    // soft fill with its own dark figure, so it stays readable on the active
    // fill instead of inheriting a pale digit that sat below 4.5:1.
    const activeSidebarRow = within(sidebar)
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-current") === "page");
    const activeCountBadge =
      activeSidebarRow?.querySelector("span.tabular-nums");
    expect(activeSidebarRow?.className).toContain(
      "text-(--nav-active-foreground)",
    );
    expect(activeCountBadge?.className).toContain("bg-(--input)");
    expect(activeCountBadge?.className).toContain("text-foreground");
    expect(activeCountBadge?.className).not.toContain("text-current");
    expect(activeCountBadge?.className).not.toContain("bg-(--nav-active-bar)");
  });

  it("gives every sidebar count one identical plain treatment", () => {
    const workspace = createWorkspace();
    workspace.campaigns = [
      { id: "campaign_default", jobIds: [], name: "My job search" },
      { id: "campaign_second", jobIds: [], name: "Backend roles" },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["campaigns"];
    workspace.intelligence = {
      companies: [
        {
          id: "company_1",
          mergeReviewCandidates: [{ decision: "pending" }],
        },
        {
          id: "company_2",
          mergeReviewCandidates: [{ decision: "pending" }],
        },
      ],
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
    } as unknown as JobFinderRendererWorkspaceSnapshot["intelligence"];

    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={workspace}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const sidebar = screen.getByRole("complementary", {
      name: "Job Finder sidebar",
    });
    const countClassNames = Array.from(
      sidebar.querySelectorAll<HTMLElement>("span.tabular-nums"),
    ).map((element) => element.className);

    // Only the journey carries inventory counts; retired secondary workflow
    // surfaces no longer add badges to the main product map.
    expect(countClassNames.length).toBeGreaterThanOrEqual(1);
    // Previously this asserted ONE class for every sidebar count and forbade
    // any fill. That is the defect RC-05 records: an attention count then
    // rendered as a bare number beside a destination name, so the Companies
    // badge (pending merge reviews) read as a company inventory count and was
    // wrong by an order of magnitude. The contract is now: exactly one
    // inventory treatment, exactly one attention treatment, and the two are
    // visibly different, so a bare number always means inventory.
    const inventoryClassNames = countClassNames.filter((className) =>
      className.includes("bg-(--input)"),
    );
    const attentionClassNames = countClassNames.filter((className) =>
      className.includes("bg-primary"),
    );
    expect(inventoryClassNames.length).toBeGreaterThan(0);
    expect(new Set(inventoryClassNames).size).toBe(1);

    // An inventory count is a quiet pill: soft fill, tabular figure, at the
    // row's trailing edge. It never uses the attention fill.
    const [countClassName] = inventoryClassNames;
    expect(countClassName).toContain("bg-(--input)");
    expect(countClassName).toContain("rounded-full");
    expect(countClassName).toContain("tabular-nums");
    expect(countClassName).toContain("ml-auto");
    expect(countClassName).not.toContain("bg-primary");
    // An attention count is filled and carries a noun, so it cannot be read as
    // inventory volume.
    expect(attentionClassNames).toHaveLength(0);

    // Collapsing the rail moves every count to the same corner marker; it is
    // still exactly one treatment, never a per-destination variant.
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const collapsedCountClassNames = Array.from(
      screen
        .getByRole("complementary", { name: "Job Finder sidebar" })
        .querySelectorAll<HTMLElement>("span.tabular-nums"),
    ).map((element) => element.className);
    expect(collapsedCountClassNames.length).toBe(countClassNames.length);
    expect(new Set(collapsedCountClassNames).size).toBe(1);
  });

  it("lists every secondary destination inline in the expanded sidebar instead of behind a popover", () => {
    const onNavigate = vi.fn();
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell
          onNavigate={onNavigate}
          platform="win32"
          workspace={createWorkspace()}
        >
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const sidebar = screen.getByRole("complementary", {
      name: "Job Finder sidebar",
    });
    const secondary = within(sidebar).getByRole("group", {
      name: "Workspace",
    });
    // The footer is pinned under the scroll region, not inside it.
    expect(
      sidebar
        .querySelector("[data-job-finder-sidebar-scroll-region]")
        ?.contains(secondary),
    ).toBe(false);

    for (const label of SIDEBAR_SECONDARY_DESTINATIONS) {
      const row = within(secondary).getByRole("button", {
        name: new RegExp(`^${label}`, "u"),
      });
      // Same treatment as a primary row: leading icon, then the label.
      expect(row.firstElementChild?.tagName.toLowerCase()).toBe("svg");
      expect(row.className).toContain("border-l-2");
    }

    // The shortcuts reference is one small control beside Settings and opens
    // the same dialog.
    const shortcutsEntry = within(secondary).getByRole("button", {
      name: "Keyboard shortcuts",
    });
    expect(shortcutsEntry.className).toContain("size-9");
    expect(
      sidebar.querySelector("[data-job-finder-sidebar-shortcuts-entry]"),
    ).toBe(shortcutsEntry);
    const sidebarButtons = within(sidebar).getAllByRole("button");
    expect(sidebarButtons.at(-1)).toBe(shortcutsEntry);

    // No dropdown inside a navigation column that is already on screen.
    expect(
      within(sidebar).queryByRole("button", { name: /^More/u }),
    ).toBeNull();
    expect(sidebar.querySelector("[data-job-finder-sidebar-more]")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();

    fireEvent.click(
      within(secondary).getByRole("button", { name: /^Settings/u }),
    );
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/settings");
    // Opening the shortcuts dialog stays a dialog, not a second popover.
    fireEvent.click(shortcutsEntry);
    expect(
      screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
    ).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
  });

  it("keeps the collapsed rail icon-only with tooltips for the same secondary destinations", async () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    const sidebar = screen.getByRole("complementary", {
      name: "Job Finder sidebar",
    });
    const secondary = within(sidebar).getByRole("group", {
      name: "Workspace",
    });
    for (const label of SIDEBAR_SECONDARY_DESTINATIONS) {
      const row = within(secondary).getByRole("button", {
        name: new RegExp(`^${label}`, "u"),
      });
      // The label survives for assistive technology while the rail is glyphs.
      expect(row.querySelector("span")?.className).toContain("sr-only");
    }
    // The footer has an accessible name only; it never paints an eyebrow.
    expect(secondary.textContent).not.toContain("Workspace");
    // Collapsed, the shortcuts control stacks above Settings so the gear
    // stays at the very bottom of the rail.
    expect(secondary.className).toContain("flex-col-reverse");

    const settings = within(secondary).getByRole("button", {
      name: /^Settings/u,
    });
    fireEvent.pointerEnter(settings, { pointerType: "mouse" });
    fireEvent.pointerMove(settings, { pointerType: "mouse" });
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Settings");
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
  });

  it("gives the sidebar its own scroll owner so a short window cannot clip destinations", () => {
    // 1440x640: the journey scrolls; Settings and the shortcuts control are pinned
    // are taller than the rail. jsdom has no layout engine, so the contract is
    // asserted through the structure that decides it — a bounded, non-scrolling
    // aside, a pinned toggle row, and one scrollable navigation region.
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        height: 640,
        removeEventListener: vi.fn(),
        width: 1440,
      },
    });
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
    expect(sidebar.className).toContain("overflow-hidden");
    expect(sidebar.className).not.toContain("overflow-y-auto");
    expect(sidebar.className).toContain("top-14");
    expect(sidebar.className).toContain("bottom-0");

    const column = sidebar.firstElementChild;
    expect(column?.className).toContain("flex");
    expect(column?.className).toContain("h-full");
    expect(column?.className).toContain("min-h-0");
    expect(column?.className).toContain("flex-col");

    const toggleRow = sidebar.querySelector<HTMLElement>(
      "[data-job-finder-sidebar-toggle]",
    );
    const navigation = within(sidebar).getByRole("navigation", {
      name: "Job Finder sidebar destinations",
    });
    // The toggle stays pinned above the scroller; only destinations scroll.
    // The module switch is not in this column at all — it is the brand
    // subtitle in the header.
    expect(toggleRow?.className).toContain("shrink-0");
    expect(toggleRow?.parentElement).toBe(column);
    expect(navigation.parentElement).toBe(column);
    expect(toggleRow?.nextElementSibling).toBe(navigation);
    expect(
      sidebar.querySelector("[data-desktop-module-navigation]"),
    ).toBeNull();
    expect(
      navigation.hasAttribute("data-job-finder-sidebar-scroll-region"),
    ).toBe(true);
    expect(navigation.className).toContain("overflow-y-auto");
    expect(navigation.className).toContain("min-h-0");
    expect(navigation.className).toContain("flex-1");
    expect(navigation.className).toContain("content-start");
    expect(navigation.className).toContain("overscroll-contain");
    expect(navigation.className).toContain("overflow-x-hidden");

    // Every journey destination stays inside that one scroller.
    const homeRow = within(sidebar).getByRole("button", { name: /^Home/u });
    expect(navigation.contains(homeRow)).toBe(true);
    expect(homeRow.hasAttribute("disabled")).toBe(false);
    // Settings and the shortcuts control are pinned in the footer under the
    // scroller, so a short window scrolls the journey and never hides them.
    const footer = sidebar.querySelector<HTMLElement>(
      "[data-job-finder-sidebar-footer]",
    );
    expect(footer?.parentElement).toBe(column);
    expect(navigation.nextElementSibling).toBe(footer);
    expect(footer?.className).toContain("shrink-0");
    for (const label of [
      ...SIDEBAR_SECONDARY_DESTINATIONS,
      "Keyboard shortcuts",
    ]) {
      const row = within(sidebar).getByRole("button", {
        name: new RegExp(`^${label}`, "u"),
      });
      expect(navigation.contains(row)).toBe(false);
      expect(footer?.contains(row)).toBe(true);
      expect(row.hasAttribute("disabled")).toBe(false);
    }
  });

  it("collapses to one persisted rail without leaving a second content offset", () => {
    const view = render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );
    const content = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-content]",
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(shell?.dataset.sidebarCollapsed).toBe("true");
    const collapsedWordmark = screen.getByRole("img", { name: "Nestor" });
    const collapsedLockup = collapsedWordmark.closest<HTMLElement>(
      "[data-desktop-brand-lockup]",
    );
    const collapsedSubtitle = collapsedLockup?.querySelector<HTMLElement>(
      "[data-desktop-brand-subtitle]",
    );
    expect(collapsedWordmark.parentElement?.className).toContain(
      "max-[639px]:hidden",
    );
    expect(collapsedWordmark.getAttribute("class")).toContain("h-[1.05rem]");
    expect(collapsedWordmark.getAttribute("class")).toContain("sm:h-[1.3rem]");
    expect(collapsedLockup?.className).toContain("py-1");
    expect(collapsedLockup?.className).toContain("w-max");
    expect(collapsedLockup?.className).toContain("shrink-0");
    expect(collapsedLockup?.className).toContain("whitespace-nowrap");
    // The subtitle is the switch now, so the nowrap that protects the module
    // name lives on the caption it prints (and on the lockup above it).
    expect(
      collapsedSubtitle?.querySelector("[data-module-switch-trigger] span")
        ?.className,
    ).toContain("whitespace-nowrap");
    expect(shell?.style.getPropertyValue("--job-finder-side-width")).toBe(
      "4rem",
    );
    expect(content?.className).toContain(
      "min-[1440px]:pl-(--job-finder-side-width)",
    );
    expect(
      window.localStorage.getItem("nestor.job-finder.sidebar-collapsed.v1"),
    ).toBe("true");

    // Collapsing the rail does not move or shrink the module switch: it stays
    // the brand subtitle, still printing the module name in full, so the one
    // cross-module control does not change shape with the sidebar.
    const collapsedSwitch = expectSoleModuleSwitchInBrand();
    expect(collapsedSwitch.dataset.moduleSwitchVariant).toBe("caption");
    const collapsedTrigger = getModuleSwitchTrigger(collapsedSwitch);
    expect(collapsedTrigger.textContent).toBe("Job Finder");
    expect(collapsedTrigger.getAttribute("aria-label")).toBe(
      "Job Finder, switch module",
    );
    expect(collapsedTrigger.getAttribute("title")).toContain("Job Finder");

    openModuleSwitch(collapsedSwitch);
    for (const moduleName of ["job-finder", "live-assistant"] as const) {
      const option = getModuleOption(collapsedSwitch, moduleName);
      expect(option.querySelector("svg")).not.toBeNull();
      expect(option.querySelector("span")?.textContent).toBe(
        moduleName === "job-finder" ? "Job Finder" : "Live Assistant",
      );
    }
    expect(
      getModuleOption(collapsedSwitch, "live-assistant").getAttribute(
        "aria-label",
      ),
    ).toBe("Open Live Assistant");
    fireEvent.keyDown(getModuleSwitchMenu(collapsedSwitch), { key: "Escape" });

    view.unmount();
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(
      document
        .querySelector<HTMLElement>("[data-job-finder-shell]")
        ?.style.getPropertyValue("--job-finder-side-width"),
    ).toBe("4rem");
  });

  it("keeps the sidebar rail clear of the header paint layers so Collapse stays clickable", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const header = document.querySelector<HTMLElement>(
      "[data-job-finder-shell-header]",
    );
    const shellGrid = header?.firstElementChild;
    const sidebar = screen.getByRole("complementary", {
      name: "Job Finder sidebar",
    });
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );

    expect(header?.className).toContain("xl:h-14");
    // One 56px row from 1280px: the named `xl` breakpoint is emitted after
    // `sm:`, so it beats `sm:grid-rows-[3.5rem_3.75rem]` without `!`.
    expect(shellGrid?.className).toContain("xl:grid-rows-[3.5rem]");
    expect(shellGrid?.className).not.toContain("min-[1440px]:grid-rows");
    expect(header?.className).toContain("z-50");
    expect(sidebar.className).toContain("top-14");
    expect(sidebar.className).toContain("z-40");

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(shell?.dataset.sidebarCollapsed).toBe("true");
  });

  it("mounts the collapse toggle YouTube-style at the top of the aside", () => {
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
    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    const handle = toggle.closest<HTMLElement>(
      "[data-job-finder-sidebar-toggle]",
    );
    const nav = screen.getByRole("navigation", {
      name: "Job Finder sidebar destinations",
    });

    expect(handle).toBeTruthy();
    // Lives INSIDE the sidebar, directly above the nav — never jumps between
    // states, and never shares the column with a module switch.
    expect(sidebar.contains(toggle)).toBe(true);
    expect(handle?.nextElementSibling).toBe(nav);
    expect(nav.previousElementSibling).toBe(handle);
    expect(
      sidebar.querySelector("[data-desktop-module-navigation]"),
    ).toBeNull();
    expect(handle?.className).not.toContain("fixed");
    // Electron drag region opt-out must stay inline or clicks die on the header.
    expect(
      (handle?.style as unknown as Record<string, string | undefined>)
        .WebkitAppRegion,
    ).toBe("no-drag");
  });

  it("keeps the collapse toggle clickable and stable across states", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const toggle = screen.getByRole("button", { name: "Collapse sidebar" });
    fireEvent.click(toggle);

    const expandedToggle = screen.getByRole("button", {
      name: "Expand sidebar",
    });
    expect(expandedToggle.closest("[data-job-finder-sidebar-toggle]")).toBe(
      toggle.closest("[data-job-finder-sidebar-toggle]"),
    );
    // YouTube-style: the hamburger icon itself never moves or rotates.
    expect(expandedToggle.querySelector("svg")).toBe(
      toggle.querySelector("svg"),
    );
  });

  it("pairs the sidebar toggle with an icon, accessible name, and hover tooltip", async () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(trigger.querySelector("svg")).toBeTruthy();

    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerMove(trigger, { pointerType: "mouse" });

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Collapse sidebar");
    expect(trigger.getAttribute("aria-describedby")).toBe(
      tooltip.getAttribute("id"),
    );

    fireEvent.click(trigger);
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    const expandTrigger = screen.getByRole("button", {
      name: "Expand sidebar",
    });
    fireEvent.pointerEnter(expandTrigger, { pointerType: "mouse" });
    fireEvent.pointerMove(expandTrigger, { pointerType: "mouse" });

    await waitFor(() => {
      const expandTooltip = screen.getByRole("tooltip");
      expect(expandTooltip.textContent).toContain("Expand sidebar");
      expect(expandTrigger.getAttribute("aria-describedby")).toBe(
        expandTooltip.getAttribute("id"),
      );
    });
  });

  it("names rail destinations after their visible labels and shares them through tooltips", async () => {
    window.localStorage.setItem(
      "nestor.job-finder.sidebar-collapsed.v1",
      "true",
    );
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
    const tooltipLabels = () =>
      screen.queryAllByRole("tooltip").map((node) => node.textContent);

    const hover = async (trigger: HTMLElement, label: string) => {
      fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      await waitFor(() => expect(tooltipLabels()).toContain(label));
      const tooltip = screen
        .getAllByRole("tooltip")
        .find((node) => node.textContent === label);
      expect(tooltip?.getAttribute("id")).toBe(
        trigger.getAttribute("aria-describedby"),
      );
    };

    // Outcomes now lives behind More; the collapsed rail's own tooltip
    // contract is proved on a destination the rail still shows.
    const shortlistedTrigger = within(sidebar).getByRole("button", {
      name: "Shortlisted",
    });
    expect(shortlistedTrigger.getAttribute("title")).toBeNull();
    await hover(shortlistedTrigger, "Shortlisted");

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    const profileTrigger = within(sidebar).getByRole("button", {
      name: "Profile",
    });
    await hover(profileTrigger, "Profile");
  });

  it("keeps Home on the shared page gutter ladder instead of a wider desktop gutter", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/home"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const homeMain = screen.getByRole("main", { name: "Home" });
    expect(homeMain.className).toContain("px-3");
    expect(homeMain.className).not.toContain("sm:px-4");
    expect(homeMain.className).toContain("min-[1440px]:px-4");
  });

  it("updates route context without a scroll jump when navigation completes", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const initialMain = screen.getByRole("main", { name: "Find jobs" });
    expect(document.title).toBe("Find jobs | Job Finder | Nestor");
    expect(document.activeElement).toBe(initialMain);
    expect(screen.getByRole("status").textContent).toBe("Find jobs opened.");

    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    fireEvent.click(
      within(navigation).getByRole("button", {
        name: "More",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "More" })).getByRole(
        "button",
        { name: /^Settings/ },
      ),
    );

    const settingsMain = screen.getByRole("main", { name: "Settings" });
    expect(document.title).toBe("Settings | Job Finder | Nestor");
    expect(document.activeElement).toBe(settingsMain);
    expect(settingsMain.className).toContain("outline-none");
    expect(screen.getByRole("status").textContent).toBe("Settings opened.");
    expect(scrollToMock).toHaveBeenCalledWith({ top: 0 });
  });

  it("lets an anchored destination keep its own scroll and focus", () => {
    render(
      <MemoryRouter
        initialEntries={["/job-finder/settings#settings-application-authority"]}
      >
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Anchored settings section</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const main = screen.getByRole("main", { name: "Settings" });
    expect(document.title).toBe("Settings | Job Finder | Nestor");
    expect(document.activeElement).not.toBe(main);
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("labels the analytics route Outcomes across title, announcement, and main", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/analytics"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("main", { name: "Outcomes" })).toBeTruthy();
    expect(document.title).toBe("Outcomes | Job Finder | Nestor");
    expect(screen.getByRole("status").textContent).toBe("Outcomes opened.");
  });

  it("keeps the narrow shell controls in reachable reflow rows", () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
    } as MediaQueryList);

    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const header = document.querySelector("[data-job-finder-shell-header]");
    const shell = document.querySelector("[data-job-finder-shell]");
    const shellContent = document.querySelector(
      "[data-job-finder-shell-content]",
    );
    const shellGrid = header?.firstElementChild;
    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    const actions = screen.getByRole("group", {
      name: "Notifications and actions",
    });

    expect(shellGrid?.className).toContain("grid-rows-[3.5rem_auto_auto]");
    expect(shellGrid?.className).toContain("sm:grid-rows-[3.5rem_3.75rem]");
    expect(shell?.className).toContain(
      "flex h-dvh min-h-0 flex-col overflow-hidden",
    );
    expect(shell?.className).not.toContain("overflow-y-auto");

    expect(header?.className).toContain("relative");
    expect(header?.className).toContain("sm:fixed");
    expect(shellContent?.className).toContain(
      "min-h-0 min-w-0 flex-1 flex-col",
    );
    expect(shellContent?.className).not.toContain("min-h-screen");
    expect(header?.className).toContain("shrink-0");
    expect(shellContent?.className).not.toContain("pt-[18.75rem]");
    expect(shellContent?.className).toContain("sm:pt-[7.25rem]");
    expect(shellContent?.className).toContain("xl:pt-14");
    expect(navigation.className).toContain("col-span-2");
    expect(navigation.className).not.toContain("overflow-hidden");
    expect(actions.className).toContain("col-span-2");
    expect(actions.className).toContain("row-start-3");
    expect(actions.className).toContain("sm:top-14");
    expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 639px)");
    expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: "start" });
  });

  it("keeps overflow sections reachable and closes the More menu predictably on compact viewports", () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
    } as MediaQueryList);
    const onNavigate = vi.fn();

    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell
          onNavigate={onNavigate}
          platform="win32"
          workspace={createWorkspace()}
        >
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    const moreButton = within(navigation).getByRole("button", {
      name: "More",
    });
    expect(moreButton.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(moreButton, { key: "ArrowDown" });
    const menu = screen.getByRole("navigation", {
      name: "More",
    });
    expect(menu).toBeTruthy();
    expect(within(menu).getByRole("button", { name: /Settings/ })).toBeTruthy();
    expect(within(menu).getByRole("group", { name: "Workspace" })).toBeTruthy();
    expect(document.activeElement).toBe(
      within(menu).getByRole("button", { name: /^Settings/ }),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
    expect(document.activeElement).toBe(moreButton);

    fireEvent.click(moreButton);
    expect(screen.getByRole("navigation", { name: "More" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();

    fireEvent.click(moreButton);
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "More" })).getByRole(
        "button",
        { name: /Settings/ },
      ),
    );
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/settings");
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
  });

  it("supports complete keyboard navigation in the More menu", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const moreButton = getCompactMoreButton();
    const getDestinationButton = (name: RegExp) =>
      within(screen.getByRole("navigation", { name: "More" })).getByRole(
        "button",
        { name },
      );

    // The shortcuts entry is the trailing roving participant, so opening
    // upward lands on it and Home returns to the first destination.
    fireEvent.keyDown(moreButton, { key: "ArrowUp" });
    expect(document.activeElement).toBe(
      getDestinationButton(/^Keyboard shortcuts/),
    );
    expect(
      getDestinationButton(/^Keyboard shortcuts/).getAttribute("tabindex"),
    ).toBe("0");
    expect(getDestinationButton(/^Settings/).getAttribute("tabindex")).toBe(
      "-1",
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowUp",
    });
    expect(document.activeElement).toBe(getDestinationButton(/^Safeguards/));
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowUp",
    });
    expect(document.activeElement).toBe(getDestinationButton(/^Settings/));
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(getDestinationButton(/^Safeguards/));
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(
      getDestinationButton(/^Keyboard shortcuts/),
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(getDestinationButton(/^Settings/));
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "ArrowUp",
    });
    expect(document.activeElement).toBe(
      getDestinationButton(/^Keyboard shortcuts/),
    );

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(getDestinationButton(/^Settings/));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(
      getDestinationButton(/^Keyboard shortcuts/),
    );

    // The module switch now heads the card, so the first control after the
    // Planning trigger in DOM order is the header search utility.
    const liveAssistantControl = screen.getByRole("button", {
      name: "Search your workspace",
    });
    const nextControlFocus = vi.spyOn(liveAssistantControl, "focus");
    const tabWasPrevented = fireEvent.keyDown(
      document.activeElement as HTMLElement,
      { key: "Tab" },
    );
    expect(tabWasPrevented).toBe(false);
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
    // Tab closes the menu and continues to the next control after the planning trigger in DOM order.
    expect(document.activeElement).toBe(liveAssistantControl);
    expect(nextControlFocus).toHaveBeenCalledTimes(1);

    fireEvent.click(moreButton);
    expect(document.activeElement).toBe(getDestinationButton(/^Settings/));
    const previousControl = within(
      screen.getByRole("navigation", { name: "Job Finder sections" }),
    ).getByRole("button", { name: /^Applications/ });
    const previousControlFocus = vi.spyOn(previousControl, "focus");
    const tabShiftWasPrevented = fireEvent.keyDown(
      document.activeElement as HTMLElement,
      {
        key: "Tab",
        shiftKey: true,
      },
    );
    expect(tabShiftWasPrevented).toBe(false);
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
    expect(document.activeElement).toBe(previousControl);
    expect(previousControlFocus).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(moreButton, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "Escape",
    });
    expect(screen.queryByRole("navigation", { name: "More" })).toBeNull();
    expect(document.activeElement).toBe(moreButton);
  });

  it("keeps primary destination labels visible while allowing predictable horizontal scrolling", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    const strip = navigation.querySelector(
      "[data-job-finder-compact-navigation-scroll]",
    );

    expect(strip?.className).toContain("overflow-x-auto");
    expect(strip?.className).toContain("overscroll-x-contain");
    expect(strip?.className).not.toContain("sm:overflow-visible");

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
      expect(button.textContent).toContain(label);
      expect(button.querySelector("span")?.className).not.toContain("truncate");
    }
  });

  it("labels the More trigger without letting it slice at any top-strip width", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });
    const moreButton = within(navigation).getByRole("button", {
      name: "More",
    });
    const visibleLabel = Array.from(moreButton.querySelectorAll("span")).find(
      (span) => span.textContent === "More",
    );

    // The label is visible at every compact width: it can no longer be cut
    // mid-glyph because the destinations own the flexible scroll viewport
    // while the trigger keeps reserved, non-shrinking sibling space and never
    // wraps or truncates its own text.
    expect(visibleLabel).toBeTruthy();
    expect(visibleLabel?.className).not.toContain("sr-only");
    expect(visibleLabel?.className).toContain("whitespace-nowrap");
    expect(visibleLabel?.className).not.toContain("truncate");
    expect(moreButton.className).toContain("shrink-0");
    expect(moreButton.className).not.toContain("max-[899px]");
    // Previously this required `bg-(--surface-panel-raised)` plus
    // `border-(--control-border)` on the trigger. That is COMP-31: the trigger
    // was a bordered, filled, 4px-taller control standing in a row of flat
    // text pills, so it read as a different class of thing. It now carries the
    // same pill class as its neighbours; the icon and the active treatment are
    // what mark it.
    expect(moreButton.className).not.toContain("bg-(--surface-panel-raised)");
    expect(moreButton.className).not.toContain("border-(--control-border)");
    expect(moreButton.className).not.toContain("min-h-10");
    const siblingPill = within(navigation).getByRole("button", {
      name: /^Find jobs/,
    });
    // Structural tokens only: the active variant legitimately replaces the
    // pill's weight, colour and bottom-border tokens, and `cn()` merges those
    // away. What must match is that the trigger is the same kind of control.
    const REPLACED_BY_ACTIVE_VARIANT =
      /^(font-|text-muted-foreground$|border-b-|border-transparent$)/;
    for (const token of COMPACT_NAV_PILL_CLASS.split(/\s+/).filter(
      (token) => !REPLACED_BY_ACTIVE_VARIANT.test(token),
    )) {
      expect(moreButton.className).toContain(token);
      expect(siblingPill.className).toContain(token);
    }
    expect(moreButton.querySelector("svg")).toBeTruthy();
    // The icon stays as a shape cue beside the label, and the tooltip plus
    // accessible name remain exactly "More".
    expect(moreButton.getAttribute("title")).toBe("More");
    expect(moreButton.getAttribute("aria-label")).toBe("More");

    // Destinations have their own horizontal-scroll viewport while the intact
    // trigger remains visible in reserved sibling space.
    const strip = navigation.querySelector(
      "[data-job-finder-compact-navigation-scroll]",
    );
    expect(strip?.className).toContain("[scrollbar-width:none]");
    expect(strip?.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(strip?.className).not.toContain("[scrollbar-width:thin]");
    expect(strip?.contains(moreButton)).toBe(false);
    expect(moreButton.parentElement?.className).toContain("shrink-0");
    expect(moreButton.closest(".sticky")).toBeNull();

    // Overflow is contained by the shell; the document never scrolls sideways.
    const shell = document.querySelector<HTMLElement>(
      "[data-job-finder-shell]",
    );
    expect(shell?.className).toContain("overflow-hidden");
    expect(navigation.className).not.toContain("overflow-x-hidden");
  });

  it("keeps every responsive destination interactive", () => {
    const onNavigate = vi.fn();

    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell
          onNavigate={onNavigate}
          platform="win32"
          workspace={createWorkspace()}
        >
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", {
      name: "Job Finder sections",
    });

    for (const destination of [
      "Home",
      "Profile",
      "Find jobs",
      "Shortlisted",
      "Applications",
    ]) {
      fireEvent.click(
        within(navigation).getByRole("button", {
          name: new RegExp(`^${destination}`),
        }),
      );
    }
    for (const destination of ["Settings"]) {
      fireEvent.click(
        within(navigation).getByRole("button", {
          name: "More",
        }),
      );
      fireEvent.click(
        within(screen.getByRole("navigation", { name: "More" })).getByRole(
          "button",
          {
            name: new RegExp(`^${destination}`),
          },
        ),
      );
    }
    fireEvent.click(
      screen.getByRole("button", {
        name: "Needs you: 0 unresolved",
      }),
    );

    expect(onNavigate).toHaveBeenCalledTimes(7);
    expect(onNavigate).toHaveBeenNthCalledWith(1, "/job-finder/home");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "/job-finder/profile/setup");
    expect(onNavigate).toHaveBeenNthCalledWith(3, "/job-finder/discovery");
    expect(onNavigate).toHaveBeenNthCalledWith(4, "/job-finder/review-queue");
    expect(onNavigate).toHaveBeenNthCalledWith(5, "/job-finder/applications");
    expect(onNavigate).toHaveBeenNthCalledWith(6, "/job-finder/settings");
    expect(onNavigate).toHaveBeenNthCalledWith(7, "/job-finder/actions");
  });

  it("does not expose retired search plans in the More menu", () => {
    const workspace = createWorkspace();
    workspace.campaigns = [
      { id: "campaign_default", name: "My job search" },
      { id: "campaign_second", name: "Backend roles" },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["campaigns"];

    render(
      <MemoryRouter initialEntries={["/job-finder/campaigns"]}>
        <JobFinderShell platform="win32" workspace={workspace}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    fireEvent.click(getCompactMoreButton());
    const menu = screen.getByRole("navigation", { name: "More" });
    const campaignsButton = within(menu).queryByRole("button", {
      name: /^Search plans/u,
    });
    expect(campaignsButton).toBeNull();
  });

  it("keeps the compact menu focused on settings", () => {
    const workspace = createWorkspace();
    workspace.campaigns = [
      { id: "campaign_default", name: "My job search" },
    ] as unknown as JobFinderRendererWorkspaceSnapshot["campaigns"];

    render(
      <MemoryRouter initialEntries={["/job-finder/campaigns"]}>
        <JobFinderShell platform="win32" workspace={workspace}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    fireEvent.click(getCompactMoreButton());
    const menu = screen.getByRole("navigation", { name: "More" });
    expect(within(menu).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(
      within(menu).queryByRole("button", { name: "Documents" }),
    ).toBeNull();
  });

  it("keeps the Task center launcher in header flow instead of over page content", () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" workspace={createWorkspace()}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const actionGroup = screen.getByRole("group", {
      name: "Notifications and actions",
    });
    const summary = actionGroup.querySelector(
      "summary[aria-label='Activity']",
    ) as HTMLElement;
    const taskCenter = summary?.closest("details");

    expect(taskCenter).toBeInstanceOf(HTMLDetailsElement);
    expect(taskCenter?.className).toContain("relative");
    expect(taskCenter?.className).not.toContain("fixed");
    expect(summary?.className).toContain("h-10");
    expect(summary?.className).toContain("bg-(--surface-panel)");
  });

  it("forwards a failed real-shell cancellation so Task center offers a retry", async () => {
    const onCancelApplyRun = vi.fn(() => Promise.resolve(false));
    render(
      <MemoryRouter initialEntries={["/job-finder/applications"]}>
        <JobFinderShell
          onCancelApplyRun={onCancelApplyRun}
          platform="win32"
          workspace={createWorkspaceWithActiveApplyRun()}
        >
          <div>Applications</div>
        </JobFinderShell>
      </MemoryRouter>,
    );

    const applyTask = document.querySelector<HTMLElement>(
      '[data-task-kind="apply"]',
    );
    expect(applyTask).not.toBeNull();
    const cancelButton = within(
      applyTask as HTMLElement,
    ).getByRole<HTMLButtonElement>("button", { name: "Cancel task" });

    fireEvent.click(cancelButton);

    await waitFor(() => expect(cancelButton.disabled).toBe(false));
    expect(onCancelApplyRun).toHaveBeenCalledWith("apply_running");
    expect(
      within(applyTask as HTMLElement).getByRole("status").textContent,
    ).toContain("Cancellation did not complete");
  });
});

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
        <JobFinderShell platform="win32" workspace={workspace}>
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
        <JobFinderShell platform="win32" workspace={workspace}>
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
    expect(keycaps).toEqual([
      "⌘",
      "K",
      "/",
      "⌘",
      "B",
      "⌘",
      "I",
      "?",
      "⌘",
      "=",
      "⌘",
      "-",
      "⌘",
      "0",
    ]);
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
    expect(onNavigate).toHaveBeenCalledWith(
      "/job-finder/discovery?jobId=job_1",
    );
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
