// @vitest-environment jsdom

import type { JobFinderSettings } from "@nestor/contracts";
import { ApplicationCrmSettingsSchema } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { HashRouter, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SUBNAV_BOTTOM_GAP_PX,
  SETTINGS_SUBNAV_SCROLL_OFFSET_FALLBACK_PX,
  SETTINGS_SUBNAV_OFFSET_VARIABLE,
  SETTINGS_UNSAVED_BAR_BOTTOM_GAP_PX,
  SETTINGS_UNSAVED_BAR_CLEARANCE_FALLBACK_PX,
  SETTINGS_UNSAVED_BAR_CLEARANCE_VARIABLE,
  SettingsScreen,
} from "./settings-screen";

vi.mock("./settings-app-device-section", () => ({
  SettingsAppDeviceSection: () => (
    <section data-testid="panel-app-device">App and device panel</section>
  ),
}));
vi.mock("./settings-ai-behavior-section", () => ({
  SETTINGS_AI_BEHAVIOR_LABEL: "AI behavior",
  SettingsAiBehaviorSection: () => (
    <section data-testid="panel-ai-behavior">AI behavior panel</section>
  ),
}));
vi.mock("./settings-application-defaults-section", () => ({
  SETTINGS_RESUME_LOOK_LABEL: "Resume look",
  SettingsApplicationDefaultsSection: () => (
    <section data-testid="panel-application-defaults">
      Resume look panel
    </section>
  ),
}));
vi.mock("./settings-apply-mode-section", () => ({
  // This section names its own region through the heading the user can see,
  // instead of an sr-only h2 repeating the same sentence above it.
  SettingsApplyModeSection: ({
    headingId,
    onSaveSalaryDisclosure,
  }: {
    onSaveSalaryDisclosure?: (value: "answer_from_profile") => Promise<void>;
    headingId?: string;
  }) => (
    <section data-testid="panel-application-authority">
      <h3 id={headingId}>Applying</h3>
      Apply mode panel
      <button
        type="button"
        onClick={() => void onSaveSalaryDisclosure?.("answer_from_profile")}
      >
        Change pay choice
      </button>
    </section>
  ),
}));
vi.mock("./settings-runtime-summary", () => ({
  SettingsRuntimeSummary: () => (
    <section data-testid="panel-diagnostics-runtime">
      Runtime summary panel
    </section>
  ),
}));
vi.mock("./settings-support-controls", () => ({
  SettingsSupportControls: () => (
    <section data-testid="panel-diagnostics-support">
      Support controls panel
    </section>
  ),
}));
vi.mock("./settings-workspace-controls", () => ({
  SettingsWorkspaceControls: (props: { onResetWorkspace: () => void }) => (
    <section data-testid="panel-danger-zone">
      Delete everything panel
      <button onClick={props.onResetWorkspace} type="button">
        Reset everything
      </button>
    </section>
  ),
}));
const sectionLabels = [
  "App & device",
  // Every choice about how the AI behaves, in one place.
  "AI behavior",
  "Resume look",
  // Plain-language tab names. The renames change the labels only: the
  // prepare-only boundary and every permission it describes are unchanged.
  "Applying",
  "Diagnostics",
  "Delete everything",
] as const;

const baseSettings = {
  applicationCrm: ApplicationCrmSettingsSchema.parse({}),
} as JobFinderSettings;

const baseProps = {
  availableResumeTemplates: [],
  browser: null,
  onResetWorkspace: vi.fn(),
  onUpdateAiBehavior: vi.fn(),
  onUpdateAppearanceTheme: vi.fn(),
  onUpdateApplicationDefaults: vi.fn(),
  onUpdateWorkspaceBehavior: vi.fn(),
  searchPreferences: { tailoringMode: "balanced" as const },
  settings: baseSettings,
};

describe("SettingsScreen information architecture", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not expose the retired Browser & saved jobs section", () => {
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("link", { name: "Browser & saved jobs" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "Browser & saved jobs" }),
    ).toBeNull();
  });

  it("exposes exactly six sticky section anchors whose labels match named landmarks", () => {
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", {
      name: "Settings sections",
    });
    const links = within(nav).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual([...sectionLabels]);

    for (const link of links) {
      const targetId = (link.getAttribute("href") ?? "").replace(/^#/, "");
      expect(targetId.length).toBeGreaterThan(0);
      const anchor = document.getElementById(targetId);
      expect(anchor).not.toBeNull();
      // Each anchor is a named region titled by a heading that matches the nav label.
      expect(screen.getByRole("region", { name: link.textContent ?? "" })).toBe(
        anchor,
      );
    }

    expect(within(nav).queryAllByRole("link")).toHaveLength(6);
  });

  it("keeps keyboard-reachable nav targets with visible focus and scroll offset", () => {
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", {
      name: "Settings sections",
    });

    for (const link of within(nav).getAllByRole("link")) {
      expect(link.getAttribute("href")).toMatch(/^#settings-/);
      // Comfortable pointer and touch targets at native zoom levels.
      expect(link.className).toContain("min-h-10");
      expect(link.className).toContain("min-w-10");
      // Focus is always visible for keyboard users.
      expect(link.className).toContain("focus-visible:ring-[3px]");
      expect(link.className).toContain("outline-none");
    }

    for (const label of sectionLabels) {
      const region = screen.getByRole("region", { name: label });
      // The subnav wraps at native zoom levels; the scroll margin is derived
      // from the measured nav height (or the raised wrap-aware fallback).
      expect(region.className).toContain(
        "scroll-mt-(--settings-subnav-offset)",
      );
      // One clearance at every width. The scroll owner already starts below
      // the fixed shell header, so a width-specific `+7.25rem` variant would
      // count that header height a second time.
      expect(region.className).not.toMatch(
        /(?:^|\s)(?:sm|md|lg|xl|min-\[)[^\s]*scroll-mt-/,
      );
      const heading = document.getElementById(
        region.getAttribute("aria-labelledby") ?? "",
      );
      expect(heading?.textContent).toBe(label);
    }

    const appDeviceRegion = screen.getByRole("region", {
      name: "App & device",
    });
    const settingsRoot = appDeviceRegion.parentElement;
    expect(settingsRoot).not.toBeNull();
    expect(
      (settingsRoot as HTMLElement).style.getPropertyValue(
        SETTINGS_SUBNAV_OFFSET_VARIABLE,
      ),
    ).toBe(`${SETTINGS_SUBNAV_SCROLL_OFFSET_FALLBACK_PX}px`);
  });

  it("styles the section links like the Profile tabs: an icon each and an underline on the current one", () => {
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", {
      name: "Settings sections",
    });
    const links = within(nav).getAllByRole("link");
    for (const link of links) {
      expect(link.querySelector("svg[aria-hidden='true']")).not.toBeNull();
      expect(link.className).toContain("text-(length:--text-body)");
      // No filled box for the current section any more.
      expect(link.className).not.toContain("bg-(--nav-active-surface)");
    }
    const current = links.find(
      (link) => link.getAttribute("aria-current") === "location",
    );
    expect(current?.textContent).toBe("App & device");
    expect(current?.className).toContain("after:bg-primary");
    expect(current?.className).toContain("after:opacity-100");
  });

  it("keeps the subnav sticky as one sideways-scrolling row, and raises the fallback clearance above the old fixed offset", () => {
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", {
      name: "Settings sections",
    });
    for (const token of [
      "sticky",
      "top-0",
      "z-30",
      // Opaque, with an edge: content must never be visible through the
      // sticky band or appear sliced by it.
      "bg-(--background)",
      "border-b",
    ]) {
      expect(nav.className).toContain(token);
    }
    // One row like the Profile section tabs: it scrolls sideways rather than
    // wrapping, without a scrollbar drawn under the tabs.
    const row = nav.querySelector("[data-settings-subnav-row]");
    expect(row?.className).toContain("overflow-x-auto");
    expect(row?.className).toContain("[scrollbar-width:none]");
    expect(row?.className).not.toContain("flex-wrap");
    expect(nav.className).not.toContain("bg-(--background)/95");
    expect(nav.className).not.toContain("backdrop-blur");

    // Regression: the sticky offset is `top-0` at every width and nothing may
    // re-add the shell header height on top of it. The scroll owner is the
    // shell's `<main>`, which already begins below the fixed header, so a
    // responsive `sm:top-[7.25rem]` counted that height twice: at scroll 0 the
    // band was pushed 33px below its own flow box and covered the first card's
    // top border, padding and heading by 21px at both 1440x920 and 1200x640.
    expect(nav.className).not.toMatch(
      /(?:^|\s)(?:sm|md|lg|xl|min-\[)[^\s]*:top-/,
    );
    expect(nav.className).not.toContain("7.25rem");

    // Two wrapped min-h-10 rows (40px each) + 4px row gap + 16px nav padding
    // + the 12px breathing gap. The old fixed scroll-mt-16 (64px) only ever
    // cleared a single-wrapped-row subnav and let a wrapped subnav cover
    // headings at native zoom levels.
    expect(SETTINGS_SUBNAV_SCROLL_OFFSET_FALLBACK_PX).toBeGreaterThan(64);
    expect(SETTINGS_SUBNAV_SCROLL_OFFSET_FALLBACK_PX).toBe(
      40 * 2 + 4 + 16 + SETTINGS_SUBNAV_BOTTOM_GAP_PX,
    );
  });

  // At 1200x640 the sticky "No unsaved changes" bar painted over the live text
  // of the last card, and no scroll position freed it: nothing below the last
  // section reserved the bar's own height. The bar stays sticky inside the
  // settings scroll owner, and the last section now carries that clearance.
  it("leaves no save bar or bottom clearance on a clean page", () => {
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );

    const bar = document.querySelector<HTMLElement>(
      "[data-settings-unsaved-bar]",
    );
    expect(bar).toBeNull();

    const lastSection = screen.getByRole("region", {
      name: "Delete everything",
    });
    expect(lastSection.className).toContain(
      "pb-(--settings-unsaved-bar-clearance)",
    );

    const settingsRoot = lastSection.parentElement as HTMLElement;
    // A clean page reserves no room for an absent reminder.
    expect(
      settingsRoot.style.getPropertyValue(
        SETTINGS_UNSAVED_BAR_CLEARANCE_VARIABLE,
      ),
    ).toBe("0px");
    expect(SETTINGS_UNSAVED_BAR_CLEARANCE_FALLBACK_PX).toBeGreaterThan(
      SETTINGS_UNSAVED_BAR_BOTTOM_GAP_PX,
    );
  });

  it("derives the section scroll clearance from the measured sticky subnav height", () => {
    const capturedCallbacks: ResizeObserverCallback[] = [];
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        capturedCallbacks.push(callback);
      }
      disconnect() {}
      observe() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      height: 96,
    } as DOMRect);

    try {
      render(
        <MemoryRouter>
          <SettingsScreen {...baseProps} />
        </MemoryRouter>,
      );
      // The observer reports after layout, as the browser does.
      act(() => {
        for (const callback of capturedCallbacks)
          callback([], {} as ResizeObserver);
      });

      const appDeviceRegion = screen.getByRole("region", {
        name: "App & device",
      });
      const settingsRoot = appDeviceRegion.parentElement as HTMLElement;
      expect(
        settingsRoot.style.getPropertyValue(SETTINGS_SUBNAV_OFFSET_VARIABLE),
      ).toBe(`${96 + SETTINGS_SUBNAV_BOTTOM_GAP_PX}px`);
      // Only the subnav needs measuring on a clean page.
      expect(
        settingsRoot.style.getPropertyValue(
          SETTINGS_UNSAVED_BAR_CLEARANCE_VARIABLE,
        ),
      ).toBe("0px");
      expect(capturedCallbacks).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("anchors wrap the real settings panels in the six-label order", () => {
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );

    expect(
      document
        .getElementById("settings-app-device")
        ?.contains(screen.getByTestId("panel-app-device")),
    ).toBe(true);
    expect(
      document
        .getElementById("settings-application-defaults")
        ?.contains(screen.getByTestId("panel-application-defaults")),
    ).toBe(true);
    expect(
      document
        .getElementById("settings-application-authority")
        ?.contains(screen.getByTestId("panel-application-authority")),
    ).toBe(true);
    expect(
      document
        .getElementById("settings-diagnostics")
        ?.contains(screen.getByTestId("panel-diagnostics-runtime")),
    ).toBe(true);
    expect(
      document
        .getElementById("settings-diagnostics")
        ?.contains(screen.getByTestId("panel-diagnostics-support")),
    ).toBe(true);
    expect(
      document
        .getElementById("settings-danger-zone")
        ?.contains(screen.getByTestId("panel-danger-zone")),
    ).toBe(true);

    const panels = [
      "panel-app-device",
      "panel-application-defaults",
      "panel-application-authority",
      "panel-diagnostics-runtime",
      "panel-diagnostics-support",
      "panel-danger-zone",
    ].map((testId) => screen.getByTestId(testId));
    for (let index = 1; index < panels.length; index += 1) {
      const previous = panels[index - 1]!;
      const current = panels[index]!;
      expect(
        previous.compareDocumentPosition(current) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("points the resume at Profile instead of embedding candidate assets", () => {
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );

    // The pointer to Profile lives in the Resume look section it concerns
    // (covered by that section's own test), not in a header meta line, so
    // the header stays one row.
    expect(document.querySelector("[data-page-header-meta]")).toBeNull();
    expect(
      document.querySelector("[data-page-header-stack]")?.querySelector("a"),
    ).toBeNull();

    expect(screen.queryByText("Add a file")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Choose file to import" }),
    ).toBeNull();
    for (const label of ["Candidate assets", "Defaults", "Runtime"]) {
      expect(
        screen
          .getByRole("navigation", { name: "Settings sections" })
          .textContent.includes(label),
      ).toBe(false);
    }
  });

  it("wires the danger zone reset control without destructive controls elsewhere", () => {
    const onResetWorkspace = vi.fn();
    render(
      <MemoryRouter>
        <SettingsScreen {...baseProps} onResetWorkspace={onResetWorkspace} />
      </MemoryRouter>,
    );

    const dangerZone = screen.getByRole("region", {
      name: "Delete everything",
    });
    const resetButton = within(dangerZone).getByRole<HTMLButtonElement>(
      "button",
      {
        name: "Reset everything",
      },
    );

    fireEvent.click(resetButton);
    expect(onResetWorkspace).toHaveBeenCalledOnce();
  });
});

const settingsRouteMarker = "settings-route-content";
const jobFinderHomeRouteMarker = "job-finder-home-route";
const ejectedRouteMarker = "unknown-route-fallback";

describe("SettingsScreen section anchor navigation", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  const renderSettingsHashRoute = () => {
    window.location.hash = "#/job-finder/settings";
    return render(
      <HashRouter>
        <Routes>
          <Route
            element={
              <div>
                <p>{settingsRouteMarker}</p>
                <SettingsScreen {...baseProps} />
              </div>
            }
            path="/job-finder/settings"
          />
          <Route
            element={<p>{jobFinderHomeRouteMarker}</p>}
            path="/job-finder"
          />
          <Route element={<p>{ejectedRouteMarker}</p>} path="*" />
        </Routes>
      </HashRouter>,
    );
  };

  const flushJsdomNavigationTimers = async () => {
    await act(async () => {
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    });
  };

  const stubSectionScrollAndFocus = (sectionId: string) => {
    const target = document.getElementById(sectionId);
    if (!target) {
      throw new Error(`Missing settings section target: ${sectionId}`);
    }
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    target.scrollIntoView = scrollIntoView;
    target.focus = focus;
    return { focus, scrollIntoView };
  };

  const expectRouteStaysOnSettings = () => {
    expect(window.location.hash).toBe("#/job-finder/settings");
    expect(screen.getByText(settingsRouteMarker)).not.toBeNull();
    expect(screen.queryByText(jobFinderHomeRouteMarker)).toBeNull();
    expect(screen.queryByText(ejectedRouteMarker)).toBeNull();
  };

  it("keeps the router on settings and scrolls and focuses each target section on plain clicks", async () => {
    renderSettingsHashRoute();

    const nav = screen.getByRole("navigation", {
      name: "Settings sections",
    });
    const links = within(nav).getAllByRole("link");
    expect(links).toHaveLength(6);

    for (const label of sectionLabels) {
      const link = within(nav).getByRole("link", { name: label });
      const sectionId = (link.getAttribute("href") ?? "").replace(/^#/, "");
      const { focus, scrollIntoView } = stubSectionScrollAndFocus(sectionId);

      const nativeActivationWasAllowed = fireEvent.click(link);
      await flushJsdomNavigationTimers();

      expect(nativeActivationWasAllowed).toBe(false);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
      expect(focus).toHaveBeenCalledTimes(1);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expectRouteStaysOnSettings();
    }
  });

  it("lands directly on Applying when a recovery link names that section", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });
    render(
      <MemoryRouter
        initialEntries={["/job-finder/settings#settings-application-authority"]}
      >
        <SettingsScreen {...baseProps} />
      </MemoryRouter>,
    );

    const applying = document.getElementById("settings-application-authority");
    expect(applying).not.toBeNull();
    expect(document.activeElement).toBe(applying);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it.each([
    { description: "alt-click", init: { altKey: true } },
    { description: "ctrl-click", init: { ctrlKey: true } },
    { description: "meta-click", init: { metaKey: true } },
    { description: "shift-click", init: { shiftKey: true } },
    {
      description: "ctrl-shift-click",
      init: { ctrlKey: true, shiftKey: true },
    },
    { description: "middle-click", init: { button: 1 } },
  ] as const)(
    "leaves $description native without scrolling or focusing",
    async ({ init }) => {
      renderSettingsHashRoute();

      const nav = screen.getByRole("navigation", {
        name: "Settings sections",
      });
      const link = within(nav).getByRole("link", { name: "Diagnostics" });
      const { focus, scrollIntoView } = stubSectionScrollAndFocus(
        "settings-diagnostics",
      );

      const nativeActivationWasAllowed = fireEvent.click(link, init);
      await flushJsdomNavigationTimers();

      expect(nativeActivationWasAllowed).toBe(true);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("still prevents default when the target section is missing so the route never changes", async () => {
    renderSettingsHashRoute();

    document.getElementById("settings-diagnostics")?.remove();
    const focusSpy = vi
      .spyOn(HTMLElement.prototype, "focus")
      .mockImplementation(() => {});
    const scrollIntoViewSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoViewSpy,
    });

    try {
      const nav = screen.getByRole("navigation", {
        name: "Settings sections",
      });
      const link = within(nav).getByRole("link", { name: "Diagnostics" });

      const nativeActivationWasAllowed = fireEvent.click(link);
      await flushJsdomNavigationTimers();

      expect(nativeActivationWasAllowed).toBe(false);
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
      expect(focusSpy).not.toHaveBeenCalled();
      expectRouteStaysOnSettings();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });
});

it("puts pay privacy in the Applying section", () => {
  render(
    <MemoryRouter>
      <SettingsScreen {...baseProps} />
    </MemoryRouter>,
  );
  fireEvent.click(
    within(screen.getByRole("region", { name: "Applying" })).getByRole(
      "button",
      {
        name: "Change pay choice",
      },
    ),
  );
  expect(baseProps.onUpdateApplicationDefaults).toHaveBeenCalledWith({
    salaryDisclosure: "answer_from_profile",
  });
});

it("keeps developer timing evidence out of user settings", () => {
  const view = render(
    <MemoryRouter>
      <SettingsScreen {...baseProps} />
    </MemoryRouter>,
  );
  expect(view.container.querySelector("[data-settings-timing]")).toBeNull();
  expect(screen.queryByText("Workflow timing evidence")).toBeNull();
});

it("scrolls the last focused tab fully into view with edge clearance", () => {
  cleanup();
  render(
    <MemoryRouter>
      <SettingsScreen {...baseProps} />
    </MemoryRouter>,
  );
  const row = document.querySelector<HTMLElement>(
    "[data-settings-subnav-row]",
  )!;
  const link = screen.getByRole("link", { name: "Delete everything" });
  Object.defineProperties(row, {
    clientWidth: { configurable: true, value: 300 },
    scrollWidth: { configurable: true, value: 1012 },
    offsetLeft: { configurable: true, value: 0 },
  });
  Object.defineProperties(link, {
    offsetLeft: { configurable: true, value: 800 },
    offsetWidth: { configurable: true, value: 200 },
  });
  fireEvent.focus(link);
  expect(row.scrollLeft).toBe(712);
  expect(row.className).toContain("px-3");
  expect(row.dataset.moreAfter).toBeUndefined();
});
