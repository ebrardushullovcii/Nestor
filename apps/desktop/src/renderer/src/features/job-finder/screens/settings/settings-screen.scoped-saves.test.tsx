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
import {
  ApplicationCrmSettingsSchema,
  JobFinderSettingsSchema,
} from "@nestor/contracts";
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
const WORKSPACE_BEHAVIOR_LABEL = "Browser & saved jobs";
const AI_BEHAVIOR_LABEL = "AI behavior";
const RESUME_LOOK_LABEL = "Resume look";

const globalActScope = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  globalActScope.IS_REACT_ACT_ENVIRONMENT = true;
});

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
        within(appDevice)
          .getByRole<HTMLButtonElement>("button", { name: "Dark" })
          .disabled,
      ).toBe(false),
    );

    fireEvent.click(within(appDevice).getByRole("button", { name: "Dark" }));
    await waitFor(() =>
      expect(callbacks.onUpdateAppearanceTheme).toHaveBeenCalledWith("dark"),
    );
    expect(callbacks.onUpdateApplicationDefaults).not.toHaveBeenCalled();
    expect(callbacks.onUpdateAiBehavior).not.toHaveBeenCalled();
    expect(callbacks.onUpdateWorkspaceBehavior).not.toHaveBeenCalled();

    const workspace = screen.getByRole("region", {
      name: WORKSPACE_BEHAVIOR_LABEL,
    });
    const resumeLook = screen.getByRole("region", {
      name: RESUME_LOOK_LABEL,
    });

    expect(
      within(resumeLook).queryByRole("button", { name: "Save resume look" }),
    ).toBeNull();

    // The switch saves when flipped, with only the fields it owns.
    const keepBrowserSwitch = within(workspace).getAllByRole("switch")[0]!;
    fireEvent.click(keepBrowserSwitch);
    expect(keepBrowserSwitch.getAttribute("aria-checked")).toBe("true");

    await waitFor(() =>
      expect(callbacks.onUpdateWorkspaceBehavior).toHaveBeenCalledWith({
        discoveryOnly: false,
        keepSessionAlive: true,
      }),
    );
    // No other section's save was triggered by the workspace save.
    expect(callbacks.onUpdateApplicationDefaults).not.toHaveBeenCalled();
    expect(callbacks.onUpdateAiBehavior).not.toHaveBeenCalled();

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
    view.rerender(parseSettings({ keepSessionAlive: true }));

    const refreshedAiRegion = screen.getByRole("region", {
      name: AI_BEHAVIOR_LABEL,
    });
    const stillStagedChoice = within(refreshedAiRegion).getByRole("radio", {
      name: /^Proactive/,
    });
    // The staged choice survived the external settings prop refresh.
    expect(stillStagedChoice.getAttribute("aria-checked")).toBe("true");

    const refreshedWorkspaceRegion = screen.getByRole("region", {
      name: WORKSPACE_BEHAVIOR_LABEL,
    });
    expect(
      within(refreshedWorkspaceRegion)
        .getAllByRole("switch")[0]
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(refreshedWorkspaceRegion).queryByRole("button", {
        name: "Save browser & saved jobs",
      }),
    ).toBeNull();

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
    const payload = callbacks.onUpdateAiBehavior.mock
      .calls[0]?.[0] as UpdateAiBehaviorInput;
    expect(Object.keys(payload).sort()).toEqual([
      "aiBehavior",
      "coverLetter",
    ]);
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
    fireEvent.click(within(aiRegion).getByRole("radio", { name: /^Proactive/ }));

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

  it("wires the tracker editor to the scoped CRM callback only", async () => {
    const callbacks = createCallbacks();
    const crmSettings = ApplicationCrmSettingsSchema.parse({});
    const view = renderScreen(
      parseSettings({ applicationCrm: crmSettings }),
      callbacks,
    );

    const tracker = screen.getByRole("region", { name: "Tracker" });
    const afterDaysInput = within(tracker).getByLabelText("After days");
    fireEvent.change(afterDaysInput, { target: { value: "7" } });

    fireEvent.click(
      within(tracker).getByRole<HTMLButtonElement>("button", {
        name: "Save tracker settings",
      }),
    );

    await waitFor(() =>
      expect(callbacks.onUpdateTrackerCrm).toHaveBeenCalledTimes(1),
    );
    expect(callbacks.onUpdateTrackerCrm).toHaveBeenCalledWith(
      expect.objectContaining({
        noResponseAutomation: { afterDays: 7, enabled: true },
      }),
    );
    expect(callbacks.onUpdateApplicationDefaults).not.toHaveBeenCalled();
    expect(callbacks.onUpdateAiBehavior).not.toHaveBeenCalled();
    expect(callbacks.onUpdateWorkspaceBehavior).not.toHaveBeenCalled();

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
    fireEvent.click(within(aiRegion).getByRole("radio", { name: /^Proactive/ }));

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

  it("keeps workspace behavior staged while its scoped save stays pending and when it resolves false", async () => {
    let resolveBehavior: ((saved: boolean) => void) | null = null;
    const callbacks = createCallbacks();
    callbacks.onUpdateWorkspaceBehavior.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveBehavior = resolve;
        }),
    );
    const view = renderScreen(parseSettings(), callbacks);

    const workspace = screen.getByRole("region", {
      name: WORKSPACE_BEHAVIOR_LABEL,
    });
    // Flipping the switch starts its save at once.
    fireEvent.click(within(workspace).getAllByRole("switch")[0]!);
    expect(callbacks.onUpdateWorkspaceBehavior).toHaveBeenCalledTimes(1);
    expect(
      within(workspace).getAllByRole("switch")[0]!.getAttribute("aria-checked"),
    ).toBe("true");

    await act(() => {
      resolveBehavior?.(false);
      return Promise.resolve();
    });

    expect(
      within(workspace).getByText(
        "Browser & saved jobs were not saved. Retry before leaving this page.",
      ),
    ).toBeTruthy();
    expect(
      within(workspace).getAllByRole("switch")[0]!.getAttribute("aria-checked"),
    ).toBe("true");

    view.unmount();
  });

  it("keeps tracker edits staged while the CRM save pends and when it resolves false", async () => {
    let resolveTracker: ((saved: boolean) => void) | null = null;
    const callbacks = createCallbacks();
    callbacks.onUpdateTrackerCrm.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveTracker = resolve;
        }),
    );
    const crmSettings = ApplicationCrmSettingsSchema.parse({});
    const view = renderScreen(
      parseSettings({ applicationCrm: crmSettings }),
      callbacks,
    );

    const tracker = screen.getByRole("region", { name: "Tracker" });
    fireEvent.change(within(tracker).getByLabelText("After days"), {
      target: { value: "9" },
    });
    fireEvent.click(
      within(tracker).getByRole<HTMLButtonElement>("button", {
        name: "Save tracker settings",
      }),
    );

    // Submit stays pending for the IPC promise. Tracker now uses the shared
    // settings save control, so the pending label matches every other section
    // ("Saving tracker settings") instead of a bespoke "Saving…".
    await act(async () => {});
    expect(
      within(tracker)
        .getByRole<HTMLButtonElement>("button", {
          name: "Saving tracker settings",
        })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    await act(() => {
      resolveTracker?.(false);
      return Promise.resolve();
    });

    expect(within(tracker).getByRole("status").textContent).toBe(
      "The application tracker settings could not be saved.",
    );
    // A failed save must not reset the staged tracker values.
    expect(
      within(tracker).getByLabelText<HTMLInputElement>("After days").value,
    ).toBe("9");
    // A failed save offers the retry, named the way every other section
    // names its retry.
    expect(
      within(tracker).getByRole<HTMLButtonElement>("button", {
        name: "Retry tracker settings",
      }).disabled,
    ).toBe(false);

    view.unmount();
  });

  it("resets tracker edits only after the CRM save resolves true", async () => {
    const callbacks = createCallbacks();
    callbacks.onUpdateTrackerCrm.mockResolvedValueOnce(true);
    const crmSettings = ApplicationCrmSettingsSchema.parse({});
    const view = renderScreen(
      parseSettings({ applicationCrm: crmSettings }),
      callbacks,
    );

    const tracker = screen.getByRole("region", { name: "Tracker" });
    fireEvent.change(within(tracker).getByLabelText("After days"), {
      target: { value: "9" },
    });
    fireEvent.click(
      within(tracker).getByRole<HTMLButtonElement>("button", {
        name: "Save tracker settings",
      }),
    );

    // Saved: the button goes away and nothing offers a retry.
    await waitFor(() =>
      expect(
        within(tracker).queryByRole("button", {
          name: "Save tracker settings",
        }),
      ).toBeNull(),
    );
    expect(
      within(tracker).queryByRole("button", { name: "Retry tracker settings" }),
    ).toBeNull();

    view.unmount();
  });
});
