// @vitest-environment jsdom

import { act } from "react";
import type {
  AppearanceTheme,
  ApplicationCrmSettings,
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
import { SettingsScreen } from "./settings-screen";

// Plain-language section labels. The renames change the tab names only; the
// prepare-only boundary is untouched.
const AI_BEHAVIOR_LABEL = "AI behavior";
const RESUME_LOOK_LABEL = "Resume look";

const globalActScope = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  globalActScope.IS_REACT_ACT_ENVIRONMENT = true;
});

function parseSettings(
  overrides: Partial<JobFinderSettings> = {},
): JobFinderSettings {
  return JobFinderSettingsSchema.parse({
    allowAutoSubmitOverride: false,
    fontPreset: "inter_requisite",
    humanReviewRequired: true,
    resumeFormat: "pdf",
    resumeTemplateId: "classic_ats",
    ...overrides,
  });
}

function createCallbacks() {
  return {
    onResetWorkspace: vi.fn(),
    // Production scoped saves resolve false when a save did not commit.
    onUpdateAiBehavior: vi.fn<
      (
        input: UpdateAiBehaviorInput,
        options?: { undo?: () => void },
      ) => Promise<boolean>
    >(() => Promise.resolve(true)),
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
  };
}

type Callbacks = ReturnType<typeof createCallbacks>;

function renderScreen(settings: JobFinderSettings, callbacks: Callbacks) {
  const renderWithSettings = (currentSettings: JobFinderSettings) => (
    <MemoryRouter>
      <SettingsScreen
        availableResumeTemplates={[]}
        browser={null}
        onResetWorkspace={callbacks.onResetWorkspace}
        onUpdateAiBehavior={(input, options) =>
          callbacks.onUpdateAiBehavior(input, options)
        }
        onUpdateAppearanceTheme={(theme) =>
          callbacks.onUpdateAppearanceTheme(theme)
        }
        onUpdateApplicationDefaults={(input) =>
          callbacks.onUpdateApplicationDefaults(input)
        }
        onUpdateWorkspaceBehavior={(input) =>
          callbacks.onUpdateWorkspaceBehavior(input)
        }
        settings={currentSettings}
      />
    </MemoryRouter>
  );
  const view = render(renderWithSettings(settings));

  return {
    rerender(nextSettings: JobFinderSettings) {
      view.rerender(renderWithSettings(nextSettings));
    },
    unmount() {
      view.unmount();
    },
  };
}

describe("SettingsScreen scoped section saves", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("sends only owned fields per scoped save and keeps other sections untouched", async () => {
    const callbacks = createCallbacks();
    const view = renderScreen(parseSettings(), callbacks);

    const appDevice = screen.getByRole("region", { name: "App & device" });
    // Nothing to save yet: no button.
    expect(
      within(appDevice).queryByRole("button", { name: "Save appearance" }),
    ).toBeNull();

    // The three themes are one segmented control of ordinary buttons with
    // aria-pressed, so they are addressable by role "button" and their
    // pressed state is exposed without radio semantics.
    const themeGroup = within(appDevice).getByRole("group");
    expect(
      themeGroup.hasAttribute("data-settings-appearance-theme-group"),
    ).toBe(true);
    const themeButtons = within(themeGroup).getAllByRole("button");
    expect(themeButtons.map((button) => button.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(
      themeButtons.map((button) => button.getAttribute("aria-pressed")),
    ).toEqual(["true", "false", "false"]);
    expect(within(appDevice).queryByRole("radiogroup")).toBeNull();
    expect(within(appDevice).queryAllByRole("radio")).toHaveLength(0);

    // A theme saves on click.
    fireEvent.click(within(appDevice).getByRole("button", { name: "Light" }));
    expect(
      within(appDevice)
        .getByRole("button", { name: "Light" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    await waitFor(() =>
      expect(callbacks.onUpdateAppearanceTheme).toHaveBeenCalledWith("light"),
    );
    await waitFor(() =>
      expect(
        within(appDevice).getByRole<HTMLButtonElement>("button", {
          name: "Dark",
        }).disabled,
      ).toBe(false),
    );

    fireEvent.click(within(appDevice).getByRole("button", { name: "Dark" }));
    await waitFor(() =>
      expect(callbacks.onUpdateAppearanceTheme).toHaveBeenCalledWith("dark"),
    );
    expect(callbacks.onUpdateApplicationDefaults).not.toHaveBeenCalled();
    expect(callbacks.onUpdateAiBehavior).not.toHaveBeenCalled();
    expect(callbacks.onUpdateWorkspaceBehavior).not.toHaveBeenCalled();

    const resumeLook = screen.getByRole("region", {
      name: RESUME_LOOK_LABEL,
    });

    expect(
      within(resumeLook).queryByRole("button", { name: "Save resume look" }),
    ).toBeNull();

    view.unmount();
  });

  it("keeps a picked AI behavior choice across an external settings refresh and sends only AI-owned fields", () => {
    const callbacks = createCallbacks();
    const initialSettings = parseSettings();
    const view = renderScreen(initialSettings, callbacks);

    const aiRegion = screen.getByRole("region", { name: AI_BEHAVIOR_LABEL });
    const proactiveChoice = within(aiRegion).getByRole("radio", {
      name: /^Proactive/,
    });
    fireEvent.click(proactiveChoice);
    expect(proactiveChoice.getAttribute("aria-checked")).toBe("true");
    // The choice saves when picked.
    expect(callbacks.onUpdateAiBehavior).toHaveBeenCalledTimes(1);

    // External refresh: persisted workspace behavior changed elsewhere.
    view.rerender(parseSettings({ collapseSideMenuWithAssistant: false }));

    const refreshedAiRegion = screen.getByRole("region", {
      name: AI_BEHAVIOR_LABEL,
    });
    const stillStagedChoice = within(refreshedAiRegion).getByRole("radio", {
      name: /^Proactive/,
    });
    // The staged choice survived the external settings prop refresh.
    expect(stillStagedChoice.getAttribute("aria-checked")).toBe("true");

    expect(within(screen.getByRole("region", { name: "App & device" }))
      .getByRole("switch", { name: "Collapse the side menu while the assistant is open" })
      .getAttribute("aria-checked")).toBe("false");

    expect(callbacks.onUpdateAiBehavior).toHaveBeenCalledTimes(1);
    expect(callbacks.onUpdateAiBehavior.mock.calls[0]?.[0]).toMatchObject({
      aiBehavior: {
        profileAssistant: { initiative: "proactive" },
      },
    });
    expect(callbacks.onUpdateAiBehavior.mock.calls[0]?.[1]?.undo).toEqual(
      expect.any(Function) as unknown,
    );
    // No whole JobFinderSettings payload and no workspace fields leaked.
    // The AI behavior section sends only its own slice now; cover letters
    // travel with the Applying writing controls.
    const payload = callbacks.onUpdateAiBehavior.mock
      .calls[0]?.[0] as UpdateAiBehaviorInput;
    expect(Object.keys(payload).sort()).toEqual(["aiBehavior"]);
    expect(callbacks.onUpdateWorkspaceBehavior).not.toHaveBeenCalled();
    expect(callbacks.onUpdateApplicationDefaults).not.toHaveBeenCalled();

    view.unmount();
  });

  it("reports saved then failed save truth for a scoped section without touching others", async () => {
    let rejectAi: ((error: unknown) => void) | null = null;
    const callbacks = createCallbacks();
    callbacks.onUpdateAiBehavior.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectAi = reject;
        }),
    );
    const view = renderScreen(
      parseSettings({ resumeApplicationMode: "tailored_per_job" }),
      callbacks,
    );

    const aiRegion = screen.getByRole("region", { name: AI_BEHAVIOR_LABEL });
    fireEvent.click(
      within(aiRegion).getByRole("radio", { name: /^Proactive/ }),
    );

    // The click started the save; it shows as pending until it settles.
    expect(
      within(aiRegion).getByRole("button", { name: "Saving AI behavior" }),
    ).toBeTruthy();
    expect(
      within(aiRegion).queryByRole("button", { name: "Retry AI behavior" }),
    ).toBeNull();

    await act(() => {
      rejectAi?.(new Error("save rejected"));
      return Promise.resolve();
    });

    const retrySave = within(aiRegion).getByRole<HTMLButtonElement>("button", {
      name: "Retry AI behavior",
    });
    expect(retrySave.disabled).toBe(false);
    expect(
      within(aiRegion).getByText(
        "AI behavior was not saved. Retry before leaving this page.",
      ),
    ).toBeTruthy();

    fireEvent.click(retrySave);
    await waitFor(() =>
      expect(callbacks.onUpdateAiBehavior).toHaveBeenCalledTimes(2),
    );

    view.unmount();
  });

  it("keeps appearance pending until its scoped save settles and reports a resolved false as failed", async () => {
    let resolveAppearance: ((saved: boolean) => void) | null = null;
    const callbacks = createCallbacks();
    callbacks.onUpdateAppearanceTheme.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAppearance = resolve;
        }),
    );
    const view = renderScreen(parseSettings(), callbacks);

    const appDevice = screen.getByRole("region", { name: "App & device" });
    // The click itself starts the save.
    fireEvent.click(within(appDevice).getByRole("button", { name: "Dark" }));

    // The pending state must last for the IPC promise, not end early.
    expect(
      within(appDevice)
        .getByRole<HTMLButtonElement>("button", {
          name: "Saving appearance",
        })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      within(appDevice)
        .getByRole<HTMLButtonElement>("button", { name: "Saving appearance" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    // A save in flight shows no status line: the pending button is the state.
    expect(within(appDevice).queryByRole("status")).toBeNull();

    await act(() => {
      resolveAppearance?.(false);
      return Promise.resolve();
    });

    expect(
      within(appDevice).getByText(
        "Appearance was not saved. Retry before leaving this page.",
      ),
    ).toBeTruthy();
    expect(
      within(appDevice)
        .getByRole("status")
        .getAttribute("data-settings-save-state"),
    ).toBe("failed");
    // A failed save keeps the staged choice dirty and retryable.
    expect(
      within(appDevice)
        .getByRole("button", { name: "Dark" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(appDevice).getByRole<HTMLButtonElement>("button", {
        name: "Retry appearance",
      }).disabled,
    ).toBe(false);

    view.unmount();
  });

  it("reports a resolved false AI behavior save as failed instead of saved", async () => {
    const callbacks = createCallbacks();
    callbacks.onUpdateAiBehavior.mockResolvedValueOnce(false);
    const view = renderScreen(parseSettings(), callbacks);

    const aiRegion = screen.getByRole("region", { name: AI_BEHAVIOR_LABEL });
    fireEvent.click(
      within(aiRegion).getByRole("radio", { name: /^Proactive/ }),
    );

    await waitFor(() =>
      expect(
        within(aiRegion).queryByRole("button", { name: "Retry AI behavior" }),
      ).not.toBeNull(),
    );
    expect(
      within(aiRegion).getByText(
        "AI behavior was not saved. Retry before leaving this page.",
      ),
    ).toBeTruthy();
    // No local saved message may appear for a resolved false.
    expect(within(aiRegion).queryByText(/AI behavior saved/)).toBeNull();
    // The staged choice survives the failed save.
    expect(
      within(aiRegion)
        .getByRole("radio", { name: /^Proactive/ })
        .getAttribute("aria-checked"),
    ).toBe("true");

    view.unmount();
  });


});
