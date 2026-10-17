// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModuleSwitch } from "./module-switch";
import type { ModuleSwitchProps } from "./module-switch";

// This project does not enable testing-library auto-cleanup, and the menu
// portals into document.body, so an un-torn-down render leaks into the next
// test's queries.
afterEach(() => {
  cleanup();
});

function renderSwitch(props: Partial<ModuleSwitchProps> = {}) {
  const onSelectModule = vi.fn();
  render(
    <ModuleSwitch
      activeModule="job-finder"
      onSelectModule={onSelectModule}
      {...props}
    />,
  );
  return { onSelectModule, trigger: getTrigger() };
}

function getTrigger(): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    "[data-module-switch-trigger]",
  );
  if (!trigger) {
    throw new Error("Module switch trigger is missing");
  }
  return trigger;
}

function getMenu(): HTMLElement {
  const menu = screen.getByRole("menu", { name: "Switch module" });
  return menu;
}

function getOption(
  moduleName: "live-assistant" | "job-finder",
): HTMLButtonElement {
  const option = document.querySelector<HTMLButtonElement>(
    `[data-module-switch-option="${moduleName}"]`,
  );
  if (!option) {
    throw new Error(`Module switch option ${moduleName} is missing`);
  }
  return option;
}

describe("ModuleSwitch", () => {
  it("states the active module and offers to switch it", () => {
    const { trigger } = renderSwitch();

    const group = screen.getByRole("group", { name: "Nestor modules" });
    expect(group.dataset.moduleSwitchVariant).toBe("caption");
    expect(group.contains(trigger)).toBe(true);

    expect(trigger.getAttribute("aria-label")).toBe(
      "Job Finder, switch module",
    );
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.dataset.state).toBe("closed");
    expect(trigger.textContent).toBe("Job Finder");

    // The menu is not in the tree until it is opened, so nothing at rest
    // names the module the user is not in.
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      document.querySelectorAll("[data-module-switch-option]"),
    ).toHaveLength(0);
  });

  it("opens on click, checks the current module, and focuses the first item", () => {
    const { trigger } = renderSwitch();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.dataset.state).toBe("open");
    const menu = getMenu();
    expect(trigger.getAttribute("aria-controls")).toBe(menu.id);

    const jobFinder = getOption("job-finder");
    const liveAssistant = getOption("live-assistant");
    expect(jobFinder.getAttribute("role")).toBe("menuitemradio");
    expect(jobFinder.getAttribute("aria-checked")).toBe("true");
    expect(jobFinder.getAttribute("aria-label")).toBe("Job Finder");
    expect(liveAssistant.getAttribute("aria-checked")).toBe("false");
    expect(liveAssistant.getAttribute("aria-label")).toBe(
      "Open Live Assistant",
    );
    expect(document.activeElement).toBe(jobFinder);
  });

  it("closes again when the trigger is pressed a second time", () => {
    const { trigger } = renderSwitch();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens from the keyboard with ArrowDown and with ArrowUp", () => {
    const { trigger } = renderSwitch();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(getOption("job-finder"));

    fireEvent.keyDown(getMenu(), { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(getOption("job-finder"));
  });

  it("cycles the items with the arrow keys", () => {
    const { trigger } = renderSwitch();

    fireEvent.click(trigger);
    const menu = getMenu();
    const jobFinder = getOption("job-finder");
    const liveAssistant = getOption("live-assistant");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(liveAssistant);
    // Past the last item the focus wraps rather than stopping.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(jobFinder);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(liveAssistant);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(jobFinder);
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const { trigger } = renderSwitch();

    fireEvent.click(trigger);
    fireEvent.keyDown(getMenu(), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when focus tabs out of the menu", () => {
    const { trigger } = renderSwitch();

    fireEvent.click(trigger);
    fireEvent.keyDown(getMenu(), { key: "Tab" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("calls onSelectModule once when the other module is chosen", () => {
    const { onSelectModule, trigger } = renderSwitch();

    fireEvent.click(trigger);
    fireEvent.click(getOption("live-assistant"));

    expect(onSelectModule).toHaveBeenCalledTimes(1);
    expect(onSelectModule).toHaveBeenCalledWith("live-assistant");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes without calling onSelectModule when the current module is chosen", () => {
    const { onSelectModule, trigger } = renderSwitch();

    fireEvent.click(trigger);
    fireEvent.click(getOption("job-finder"));

    expect(onSelectModule).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a mousedown outside the trigger and the menu", () => {
    const { trigger } = renderSwitch();

    fireEvent.click(trigger);
    // A mousedown inside the menu must not read as an outside click, or
    // choosing an item would close the menu before the click lands.
    fireEvent.mouseDown(getOption("live-assistant"));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the rail variant as an icon trigger with no caption text", () => {
    const { trigger } = renderSwitch({ variant: "rail" });

    expect(
      screen.getByRole("group", { name: "Nestor modules" }).dataset
        .moduleSwitchVariant,
    ).toBe("rail");
    expect(trigger.textContent).toBe("");
    expect(trigger.querySelectorAll("svg").length).toBeGreaterThan(0);
    // The name is still announced and still offered in the menu.
    expect(trigger.getAttribute("aria-label")).toBe(
      "Job Finder, switch module",
    );

    fireEvent.click(trigger);
    expect(getOption("live-assistant").textContent).toBe("Live Assistant");
  });

  it("treats the legacy row and stacked variants as the caption variant", () => {
    for (const variant of ["row", "stacked"] as const) {
      renderSwitch({ variant });
      expect(
        screen.getByRole("group", { name: "Nestor modules" }).dataset
          .moduleSwitchVariant,
      ).toBe("caption");
      expect(getTrigger().textContent).toBe("Job Finder");
      cleanup();
    }
  });

  it("names Live Assistant as the active module when that is where the user is", () => {
    const { trigger } = renderSwitch({ activeModule: "live-assistant" });

    expect(trigger.getAttribute("aria-label")).toBe(
      "Live Assistant, switch module",
    );
    expect(trigger.textContent).toBe("Live Assistant");

    fireEvent.click(trigger);
    expect(getOption("live-assistant").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(getOption("job-finder").getAttribute("aria-label")).toBe(
      "Open Job Finder",
    );
  });
});
