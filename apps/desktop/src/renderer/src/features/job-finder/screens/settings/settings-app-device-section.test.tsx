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
    keepSessionAlive: false,
    discoveryOnly: false,
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
    const save = screen.getByRole("button", { name: "Save appearance" });

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(onUpdateWorkspaceBehavior).toHaveBeenCalledWith({
      collapseSideMenuWithAssistant: false,
    });
    // Nothing is left waiting for Save appearance.
    expect((save as HTMLButtonElement).disabled).toBe(true);
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
  expect(screen.getByText(/View → Zoom In/)).toBeTruthy();
});
