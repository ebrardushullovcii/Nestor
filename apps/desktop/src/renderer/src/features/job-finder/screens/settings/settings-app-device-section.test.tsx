// @vitest-environment jsdom

import type { JobFinderSettings } from "@nestor/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SettingsAppDeviceSection } from "./settings-app-device-section";

function settings(
  overrides: Partial<JobFinderSettings> = {},
): JobFinderSettings {
  return {
    resumeFormat: "pdf",
    resumeTemplateId: "classic_ats",
    fontPreset: "inter_requisite",
    appearanceTheme: "system",
    humanReviewRequired: true,
    allowAutoSubmitOverride: false,
    ...overrides,
  } as JobFinderSettings;
}

describe("App & device: side menu with the assistant", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the setting on when it was never stored", () => {
    render(
      <SettingsAppDeviceSection
        onUpdateAppearanceTheme={vi.fn()}
        onUpdateWorkspaceBehavior={vi.fn()}
        settings={settings()}
      />,
    );
    expect(
      screen
        .getByRole("switch", {
          name: "Collapse the side menu while the assistant is open",
        })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("saves the switch as soon as it is flipped, without Save appearance", () => {
    const onUpdateAppearanceTheme = vi.fn();
    const onUpdateWorkspaceBehavior = vi.fn().mockResolvedValue(true);
    render(
      <SettingsAppDeviceSection
        onUpdateAppearanceTheme={onUpdateAppearanceTheme}
        onUpdateWorkspaceBehavior={onUpdateWorkspaceBehavior}
        settings={settings()}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Collapse the side menu while the assistant is open",
    });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(onUpdateWorkspaceBehavior).toHaveBeenCalledWith({
      collapseSideMenuWithAssistant: false,
    });
    // Nothing is left waiting for a save.
    expect(
      screen.queryByRole("button", { name: "Save appearance" }),
    ).toBeNull();
    expect(onUpdateAppearanceTheme).not.toHaveBeenCalled();
  });

  it("goes back and says so when the save fails", async () => {
    const onUpdateWorkspaceBehavior = vi.fn().mockResolvedValue(false);
    render(
      <SettingsAppDeviceSection
        onUpdateAppearanceTheme={vi.fn()}
        onUpdateWorkspaceBehavior={onUpdateWorkspaceBehavior}
        settings={settings()}
      />,
    );
    const toggle = screen.getByRole("switch", {
      name: "Collapse the side menu while the assistant is open",
    });
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(
      screen.getByText("That change was not saved. Try the switch again."),
    ).toBeTruthy();
  });

  it("reads a stored off as off", () => {
    render(
      <SettingsAppDeviceSection
        onUpdateAppearanceTheme={vi.fn()}
        onUpdateWorkspaceBehavior={vi.fn()}
        settings={settings({ collapseSideMenuWithAssistant: false })}
      />,
    );
    expect(
      screen
        .getByRole("switch", {
          name: "Collapse the side menu while the assistant is open",
        })
        .getAttribute("aria-checked"),
    ).toBe("false");
  });
});

it("points to the persistent text enlargement controls", () => {
  render(
    <SettingsAppDeviceSection
      onUpdateAppearanceTheme={vi.fn()}
      settings={settings()}
    />,
  );
  expect(screen.getByText("Text size")).toBeTruthy();
  // No menu bar on Windows: the keys themselves are named.
  expect(screen.getByText(/Ctrl \+ and Ctrl − make text bigger/)).toBeTruthy();
});

describe("App & device: Speed", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts on Standard and says what it does", () => {
    render(
      <SettingsAppDeviceSection
        onUpdateAppearanceTheme={vi.fn()}
        onUpdateWorkspaceBehavior={vi.fn()}
        settings={settings()}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Standard" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText(/Works well on most computers/u)).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("saves a faster level at once and warns about memory and AI limits", async () => {
    const onUpdateWorkspaceBehavior = vi.fn().mockResolvedValue(true);
    render(
      <SettingsAppDeviceSection
        onUpdateAppearanceTheme={vi.fn()}
        onUpdateWorkspaceBehavior={onUpdateWorkspaceBehavior}
        settings={settings()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Maximum" }));
    expect(onUpdateWorkspaceBehavior).toHaveBeenCalledWith({
      speedLevel: "maximum",
    });
    expect(screen.getByRole("note").textContent).toMatch(
      /more memory and spends your AI limits faster/u,
    );
    expect(screen.getByText(/more memory than Standard/u)).toBeTruthy();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Maximum" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  it("goes back to the saved level when the save fails", async () => {
    render(
      <SettingsAppDeviceSection
        onUpdateAppearanceTheme={vi.fn()}
        onUpdateWorkspaceBehavior={vi.fn().mockResolvedValue(false)}
        settings={settings({ speedLevel: "faster" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Standard" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Faster" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(screen.getByText(/That change was not saved/u)).toBeTruthy();
  });
});
