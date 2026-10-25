// @vitest-environment jsdom

import { act } from "react";
import type {
  AppearanceTheme,
  ApplicationCrmSettings,
  BrowserSessionState,
  JobFinderSettings,
  UpdateAiBehaviorInput,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import { JobFinderSettingsSchema } from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getStickyBottomChromeGapPx,
  SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CANCEL_CLASS,
  SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_PX,
} from "../../lib/job-finder-shell-gutters";
import { SettingsScreen } from "./settings-screen";

/** Tailwind's spacing scale: one step is 4px. */
const TAILWIND_SPACING_STEP_PX = 4;

const globalActScope = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  globalActScope.IS_REACT_ACT_ENVIRONMENT = true;
});

const WORKSPACE_BEHAVIOR_LABEL = "Browser & saved jobs";
const APPLICATION_AUTHORITY_LABEL =
  "Applying";

const browserSession = {
  source: "target_site",
  status: "idle",
  driver: "catalog_seed",
  label: "Idle",
  detail: null,
  lastCheckedAt: "2026-08-01T00:00:00.000Z",
} as unknown as BrowserSessionState;

function parseSettings(
  overrides: Partial<JobFinderSettings> = {},
): JobFinderSettings {
  return JobFinderSettingsSchema.parse({
    allowAutoSubmitOverride: false,
    appearanceTheme: "dark",
    fontPreset: "inter_requisite",
    humanReviewRequired: true,
    keepSessionAlive: false,
    resumeFormat: "pdf",
    resumeTemplateId: "classic_ats",
    ...overrides,
  });
}

function createCallbacks() {
  return {
    onResetWorkspace: vi.fn(),
    onSettingsDraftEdited: vi.fn(),
    onUpdateAppearanceTheme: vi.fn<
      (theme: AppearanceTheme) => Promise<boolean>
    >(() => Promise.resolve(true)),
    onUpdateApplicationDefaults: vi.fn<
      (input: UpdateApplicationDefaultsInput) => Promise<boolean>
    >(() => Promise.resolve(true)),
    onUpdateTrackerCrm: vi.fn<
      (crm: ApplicationCrmSettings) => Promise<boolean>
    >(() => Promise.resolve(true)),
    onUpdateWorkspaceBehavior: vi.fn<
      (input: UpdateWorkspaceBehaviorInput) => Promise<boolean>
    >(() => Promise.resolve(true)),
    onUpdateAiBehavior: vi.fn<
      (
        input: UpdateAiBehaviorInput,
        options?: { undo?: () => void },
      ) => Promise<boolean>
    >(() => Promise.resolve(true)),
  };
}

type Callbacks = ReturnType<typeof createCallbacks>;

function renderScreen(settings: JobFinderSettings, callbacks: Callbacks) {
  return render(
    <MemoryRouter>
      <SettingsScreen
        availableResumeTemplates={[]}
        browserSession={browserSession}
        isWorkspaceResetPending={false}
        onResetWorkspace={callbacks.onResetWorkspace}
        onSettingsDraftEdited={callbacks.onSettingsDraftEdited}
        onUpdateAiBehavior={(input, options) =>
          callbacks.onUpdateAiBehavior(input, options)
        }
        onUpdateAppearanceTheme={(theme) =>
          callbacks.onUpdateAppearanceTheme(theme)
        }
        onUpdateApplicationDefaults={(input) =>
          callbacks.onUpdateApplicationDefaults(input)
        }
        onUpdateTrackerCrm={(crm) => callbacks.onUpdateTrackerCrm(crm)}
        onUpdateWorkspaceBehavior={(input) =>
          callbacks.onUpdateWorkspaceBehavior(input)
        }
        settings={settings}
      />
    </MemoryRouter>,
  );
}

const unsavedBar = () =>
  document.querySelector<HTMLElement>("[data-settings-unsaved-bar]");

describe("Settings section nav is real navigation", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("marks exactly one current section and moves the marker on activation", () => {
    renderScreen(parseSettings(), createCallbacks());

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const links = within(nav).getAllByRole("link");

    const currentLinks = () =>
      links.filter((link) => link.getAttribute("aria-current") === "location");

    // A nav with no current item is a list, not navigation.
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]?.textContent).toBe("App & device");

    fireEvent.click(within(nav).getByRole("link", { name: "Tracker" }));

    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]?.textContent).toBe("Tracker");
  });

  it("underlines the current item like the Profile tabs, and gives only the danger zone a destructive tint", () => {
    renderScreen(parseSettings(), createCallbacks());

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const current = within(nav).getByRole("link", { name: "App & device" });
    const inactive = within(nav).getByRole("link", { name: "Tracker" });
    const dangerZone = within(nav).getByRole("link", {
      name: "Delete everything",
    });

    // Colour alone never carries the current item: it also gets the 2px
    // underline the line tabs use.
    expect(current.className).toContain("after:bg-primary");
    expect(current.className).toContain("after:opacity-100");
    expect(inactive.className).not.toContain("after:bg-primary");

    expect(dangerZone.className).toContain("text-(--destructive)");
    expect(inactive.className).not.toContain("text-(--destructive)");

    // The underline is an overlay, so the current item cannot nudge its
    // neighbours when the marker appears.
    for (const link of within(nav).getAllByRole("link")) {
      expect(link.className).toContain("after:absolute");
    }
  });

  it("names the sections in plain language and keeps account access person-owned", () => {
    renderScreen(parseSettings(), createCallbacks());

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(
      within(nav).getByRole("link", { name: APPLICATION_AUTHORITY_LABEL }),
    ).toBeTruthy();
    expect(
      within(nav).getByRole("link", { name: WORKSPACE_BEHAVIOR_LABEL }),
    ).toBeTruthy();

    const authority = screen.getByRole("region", {
      name: APPLICATION_AUTHORITY_LABEL,
    });
    expect(
      within(authority).getAllByText(/You control account creation/i).length,
    ).toBeTruthy();
    expect(
      within(authority).getAllByText(/without saving them/i).length,
    ).toBeTruthy();
    expect(
      within(authority).queryByRole("button", { name: /submit/i }),
    ).toBeNull();
  });
});

describe("Settings save ownership", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows no save button in a section with nothing to save", () => {
    renderScreen(parseSettings(), createCallbacks());

    for (const label of [
      "App & device",
      "AI behavior",
      "Resume look",
      WORKSPACE_BEHAVIOR_LABEL,
    ]) {
      const region = screen.getByRole("region", { name: label });
      expect(region.querySelector("[data-settings-save-state]")).toBeNull();
      expect(
        within(region).queryByRole("button", { name: /^Save / }),
      ).toBeNull();
    }
  });

  it("saves an AI behavior choice at once, with an Undo for the toast and no reminder", async () => {
    const callbacks = createCallbacks();
    renderScreen(parseSettings(), callbacks);

    const region = screen.getByRole("region", { name: "AI behavior" });
    const replies = within(region).getByRole("radiogroup", {
      name: "How the profile assistant replies",
    });
    fireEvent.click(
      within(replies)
        .getAllByRole("radio")
        .find((radio) => radio.getAttribute("aria-checked") !== "true")!,
    );

    expect(callbacks.onUpdateAiBehavior).toHaveBeenCalledTimes(1);
    expect(callbacks.onUpdateAiBehavior).toHaveBeenCalledWith(
      expect.objectContaining({ aiBehavior: expect.any(Object) as unknown }),
      { undo: expect.any(Function) as unknown },
    );
    await waitFor(() =>
      expect(within(region).getByText(/AI behavior saved/)).toBeTruthy(),
    );
    expect(
      within(region).queryByRole("button", { name: "Save AI behavior" }),
    ).toBeNull();
    expect(unsavedBar()).toBeNull();
  });

  it("names a section in the save reminder only while it owes a save, and the bar commits only it", async () => {
    const callbacks = createCallbacks();
    callbacks.onUpdateAiBehavior.mockResolvedValueOnce(false);
    renderScreen(parseSettings(), callbacks);

    expect(unsavedBar()).toBeNull();

    const ai = screen.getByRole("region", { name: "AI behavior" });
    const replies = within(ai).getByRole("radiogroup", {
      name: "How the profile assistant replies",
    });
    fireEvent.click(
      within(replies)
        .getAllByRole("radio")
        .find((radio) => radio.getAttribute("aria-checked") !== "true")!,
    );

    // The choice saved at once and failed: now it is outstanding.
    await waitFor(() => expect(unsavedBar()).not.toBeNull());
    const bar = unsavedBar();
    expect(bar?.getAttribute("data-settings-unsaved-count")).toBe("1");
    expect(bar?.textContent).toContain("Unsaved changes in AI behavior.");

    // The bar is pinned inside the viewport, so the commit never drifts
    // thousands of pixels away from the control it commits.
    expect(bar?.className).toContain("sticky");
    expect(bar?.className).toContain("bottom-3");

    fireEvent.click(
      within(bar as HTMLElement).getByRole("button", {
        name: "Save AI behavior",
      }),
    );

    await waitFor(() =>
      expect(callbacks.onUpdateAiBehavior).toHaveBeenCalledTimes(2),
    );
    expect(callbacks.onUpdateWorkspaceBehavior).not.toHaveBeenCalled();
    expect(callbacks.onUpdateApplicationDefaults).not.toHaveBeenCalled();

    await waitFor(() => expect(unsavedBar()).toBeNull());
  });

  it("saves a Browser & saved jobs switch when it is flipped", async () => {
    const callbacks = createCallbacks();
    renderScreen(parseSettings(), callbacks);

    const workspace = screen.getByRole("region", {
      name: WORKSPACE_BEHAVIOR_LABEL,
    });
    fireEvent.click(within(workspace).getAllByRole("switch")[0]!);

    await waitFor(() =>
      expect(callbacks.onUpdateWorkspaceBehavior).toHaveBeenCalledWith({
        discoveryOnly: false,
        keepSessionAlive: true,
      }),
    );
    // No Save press and no reminder: the switch acts like the theme.
    expect(
      within(workspace).queryByRole("button", {
        name: "Save browser & saved jobs",
      }),
    ).toBeNull();
    await waitFor(() => expect(unsavedBar()).toBeNull());
    expect(
      within(workspace).getByText("Browser & saved jobs saved."),
    ).toBeTruthy();
  });

  it("links the Tracker section into the same save ownership as every other section", async () => {
    const callbacks = createCallbacks();
    renderScreen(parseSettings(), callbacks);

    // Tracker was the fourth save on this page and used to publish nothing,
    // so the page-level bar could not name it and a Tracker edit could be
    // scrolled away from with no outstanding-change signal anywhere.
    const tracker = screen.getByRole("region", { name: "Tracker" });
    fireEvent.click(
      within(tracker).getByRole("checkbox", {
        name: /Mark applications for follow-up/,
      }),
    );

    const bar = unsavedBar();
    expect(bar?.getAttribute("data-settings-save-state")).toBe("dirty");
    expect(bar?.getAttribute("data-settings-unsaved-count")).toBe("1");
    expect(bar?.textContent).toContain("Unsaved changes in Tracker.");

    fireEvent.click(
      within(bar as HTMLElement).getByRole("button", {
        name: "Save tracker settings",
      }),
    );

    await waitFor(() =>
      expect(callbacks.onUpdateTrackerCrm).toHaveBeenCalledTimes(1),
    );
    expect(callbacks.onUpdateWorkspaceBehavior).not.toHaveBeenCalled();
    expect(callbacks.onUpdateAppearanceTheme).not.toHaveBeenCalled();

    await waitFor(() => expect(unsavedBar()).toBeNull());
    expect(within(tracker).getByText("Tracker settings saved.")).toBeTruthy();
  });

  it("names every dirty section and offers no save when more than one is outstanding", async () => {
    const callbacks = createCallbacks();
    callbacks.onUpdateAiBehavior.mockResolvedValueOnce(false);
    renderScreen(parseSettings(), callbacks);

    // AI behavior saves on click; a failed save leaves it outstanding.
    const ai = screen.getByRole("region", { name: "AI behavior" });
    const replies = within(ai).getByRole("radiogroup", {
      name: "How the profile assistant replies",
    });
    const unchecked = within(replies)
      .getAllByRole("radio")
      .find((radio) => radio.getAttribute("aria-checked") !== "true");
    fireEvent.click(unchecked!);
    await waitFor(() =>
      expect(
        within(ai).getByRole("button", { name: "Retry AI behavior" }),
      ).toBeTruthy(),
    );

    const tracker = screen.getByRole("region", { name: "Tracker" });
    fireEvent.click(
      within(tracker).getByRole("checkbox", {
        name: /Mark applications for follow-up/,
      }),
    );

    const bar = unsavedBar() as HTMLElement;
    expect(bar.getAttribute("data-settings-unsaved-count")).toBe("2");
    expect(bar.textContent).toContain("Unsaved changes in 2 sections");
    expect(bar.textContent).toContain("AI behavior");
    expect(bar.textContent).toContain("Tracker");

    // One button cannot honestly say what it would write, so the bar only
    // navigates while two sections are outstanding.
    const barButtons = within(bar).getAllByRole("button");
    expect(barButtons.map((button) => button.textContent)).toEqual([
      "Go to AI behavior",
      "Go to Tracker",
    ]);
    fireEvent.click(barButtons[0]!);
    expect(callbacks.onUpdateAiBehavior).toHaveBeenCalledTimes(1);
    expect(callbacks.onUpdateTrackerCrm).not.toHaveBeenCalled();
  });

  it("keeps the bar up while a failed section is still unsaved", async () => {
    const callbacks = createCallbacks();
    callbacks.onUpdateWorkspaceBehavior.mockResolvedValueOnce(false);
    renderScreen(parseSettings(), callbacks);

    const workspace = screen.getByRole("region", {
      name: WORKSPACE_BEHAVIOR_LABEL,
    });
    // The switch saves when flipped; this save fails.
    fireEvent.click(within(workspace).getAllByRole("switch")[0]!);

    await waitFor(() =>
      expect(
        within(workspace).getByText(
          "Browser & saved jobs were not saved. Retry before leaving this page.",
        ),
      ).toBeTruthy(),
    );
    expect(unsavedBar()).not.toBeNull();
  });
});

describe("Settings appearance preview", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete document.documentElement.dataset.theme;
  });

  it("applies and saves the theme on click", async () => {
    const callbacks = createCallbacks();
    renderScreen(parseSettings({ appearanceTheme: "dark" }), callbacks);

    const appDevice = screen.getByRole("region", { name: "App & device" });
    fireEvent.click(within(appDevice).getByRole("button", { name: "Light" }));

    // The click itself shows the theme and saves it; there is no separate
    // Save appearance press.
    expect(document.documentElement.dataset.theme).toBe("light");
    await waitFor(() =>
      expect(callbacks.onUpdateAppearanceTheme).toHaveBeenCalledWith("light"),
    );
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("reverts the preview when the save does not commit", async () => {
    const callbacks = createCallbacks();
    callbacks.onUpdateAppearanceTheme.mockResolvedValueOnce(false);
    renderScreen(parseSettings({ appearanceTheme: "dark" }), callbacks);

    const appDevice = screen.getByRole("region", { name: "App & device" });
    fireEvent.click(within(appDevice).getByRole("button", { name: "Light" }));

    // A failed save leaves the app wearing what is actually persisted.
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
    expect(
      within(appDevice).getByRole<HTMLButtonElement>("button", {
        name: "Retry appearance",
      }).disabled,
    ).toBe(false);
  });

  it("puts the saved theme back when the screen is left before its save lands", () => {
    const callbacks = createCallbacks();
    callbacks.onUpdateAppearanceTheme.mockReturnValueOnce(
      new Promise<boolean>(() => undefined),
    );
    const view = renderScreen(
      parseSettings({ appearanceTheme: "dark" }),
      callbacks,
    );

    const appDevice = screen.getByRole("region", { name: "App & device" });
    fireEvent.click(within(appDevice).getByRole("button", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => {
      view.unmount();
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("Settings save bar reaches the window bottom", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** `pb-8` -> 32, `-mb-10` -> -40. Absent -> 0. */
  function readSpacingPx(className: string, property: "mb" | "pb"): number {
    const match = new RegExp(`(?:^|\\s)(-?)${property}-(\\d+)(?:\\s|$)`).exec(
      ` ${className} `,
    );

    if (!match) {
      return 0;
    }

    return (
      Number(match[2]) * TAILWIND_SPACING_STEP_PX * (match[1] === "-" ? -1 : 1)
    );
  }

  it("keeps the dirty reminder compact and inside the settings scroll region", () => {
    // The bar is `sticky bottom-0`, and a sticky box is clamped to its
    // containing block. The shell's own `pb-10` on the scrolling `<main>` and
    // the route's former trailing `pb-8` both ended that block above the
    // window, so the bar came to rest 40px up with the page's own template
    // card rendering under and below it. Neither may return.
    renderScreen(parseSettings(), createCallbacks());
    fireEvent.click(
      within(
        screen.getByRole("region", { name: WORKSPACE_BEHAVIOR_LABEL }),
      ).getAllByRole("switch")[0]!,
    );

    const bar = unsavedBar();
    expect(bar?.className).toContain("sticky");
    expect(bar?.className).toContain("bottom-3");
    expect(bar?.className).toContain("max-w-3xl");

    const root = bar?.parentElement;
    expect(root?.tagName).toBe("SECTION");
    expect(root?.className).toContain(
      SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_CANCEL_CLASS,
    );

    const routeBottomMarginPx = readSpacingPx(root?.className ?? "", "mb");
    const routeTrailingPaddingPx = readSpacingPx(root?.className ?? "", "pb");

    expect(routeBottomMarginPx).toBe(-SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_PX);
    expect(
      getStickyBottomChromeGapPx({
        routeBottomMarginPx,
        routeTrailingPaddingPx,
        scrollOwnerBottomPaddingPx: SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_PX,
      }),
    ).toBe(0);

    // The bar is the last thing in the route: anything after it is content the
    // bar cannot cover at the end of the scroll.
    expect(root?.lastElementChild).toBe(bar);
  });

  it("reports the pre-fix layout as a gap the page renders through", () => {
    // The exact geometry the r15 capture measured: the bar's bottom edge 40px
    // above a 920px window while live cards kept painting to y=920.
    expect(
      getStickyBottomChromeGapPx({
        routeBottomMarginPx: 0,
        routeTrailingPaddingPx: 0,
        scrollOwnerBottomPaddingPx: SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_PX,
      }),
    ).toBe(SHELL_SCROLLING_ROUTE_BOTTOM_GUTTER_PX);
  });
});
