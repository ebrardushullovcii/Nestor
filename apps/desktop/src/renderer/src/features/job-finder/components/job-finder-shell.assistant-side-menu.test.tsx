// @vitest-environment jsdom

import type { LaunchContext } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const assistantState = vi.hoisted(() => ({
  value: { open: false, width: 400 } as { open: boolean; width: number },
}));

vi.mock("../assistant/assistant-provider", () => ({
  useAssistant: () => ({
    ...assistantState.value,
    toggle: () => undefined,
  }),
}));
vi.mock("../assistant/assistant-sidebar", () => ({
  AssistantSidebar: () => null,
}));
vi.mock("../assistant/assistant-toggle", () => ({
  AssistantToggle: () => null,
}));

import {
  JobFinderShell,
  SIDEBAR_COLLAPSED_STORAGE_KEY,
} from "./job-finder-shell";

const windowControlsState = {
  isClosable: true,
  isFullScreen: false,
  isMaximized: false,
  isMinimizable: true,
} as const;

function launchContext(
  collapseSideMenuWithAssistant?: boolean,
): LaunchContext {
  return {
    settings:
      collapseSideMenuWithAssistant === undefined
        ? {}
        : { collapseSideMenuWithAssistant },
  } as unknown as LaunchContext;
}

function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

function renderShell(context = launchContext()) {
  const view = render(
    <MemoryRouter initialEntries={["/job-finder/discovery"]}>
      <JobFinderShell platform="win32" startupContext={context}>
        <div>Current screen</div>
      </JobFinderShell>
    </MemoryRouter>,
  );
  const rerender = (next = context) =>
    view.rerender(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <JobFinderShell platform="win32" startupContext={next}>
          <div>Current screen</div>
        </JobFinderShell>
      </MemoryRouter>,
    );
  return { rerender };
}

function railCollapsed(): string | undefined {
  return document.querySelector<HTMLElement>("[data-job-finder-shell]")?.dataset
    .sidebarCollapsed;
}

function savedPreference(): string | null {
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
}

describe("side menu while the assistant is open", () => {
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
    assistantState.value = { open: false, width: 400 };
    setWindowWidth(1600);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("folds the menu when the assistant opens and unfolds it when it closes, without saving either", () => {
    const { rerender } = renderShell();
    expect(railCollapsed()).toBe("false");

    assistantState.value = { open: true, width: 400 };
    rerender();
    expect(railCollapsed()).toBe("true");
    expect(savedPreference()).toBeNull();

    assistantState.value = { open: false, width: 400 };
    rerender();
    expect(railCollapsed()).toBe("false");
    expect(savedPreference()).toBeNull();
  });

  it("folds the menu when the app starts with the assistant already open", () => {
    assistantState.value = { open: true, width: 400 };
    renderShell();
    expect(railCollapsed()).toBe("true");
    expect(savedPreference()).toBeNull();
  });

  it("lets the person's own toggle win and keeps it after the assistant closes", () => {
    const { rerender } = renderShell();
    assistantState.value = { open: true, width: 400 };
    rerender();
    expect(railCollapsed()).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(railCollapsed()).toBe("false");
    expect(savedPreference()).toBe("false");
    rerender();
    expect(railCollapsed()).toBe("false");

    // Folded by the person while open: closing the assistant keeps it folded.
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(savedPreference()).toBe("true");
    assistantState.value = { open: false, width: 400 };
    rerender();
    expect(railCollapsed()).toBe("true");
  });

  it("keeps a menu the person already folded folded after the assistant closes", () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
    const { rerender } = renderShell();
    assistantState.value = { open: true, width: 400 };
    rerender();
    assistantState.value = { open: false, width: 400 };
    rerender();
    expect(railCollapsed()).toBe("true");
  });

  it("does nothing when the setting is off, and unfolds when it is turned off while open", () => {
    const { rerender } = renderShell(launchContext(false));
    assistantState.value = { open: true, width: 400 };
    rerender(launchContext(false));
    expect(railCollapsed()).toBe("false");

    rerender(launchContext(true));
    expect(railCollapsed()).toBe("true");
    rerender(launchContext(false));
    expect(railCollapsed()).toBe("false");
    expect(savedPreference()).toBeNull();
  });

  it("leaves the menu alone below 1440px, where it is not a rail", () => {
    setWindowWidth(1200);
    const { rerender } = renderShell();
    assistantState.value = { open: true, width: 400 };
    rerender();
    expect(railCollapsed()).toBe("false");
  });

  it("leaves the menu alone when the assistant is too wide to dock beside the page", () => {
    const { rerender } = renderShell();
    assistantState.value = { open: true, width: 900 };
    rerender();
    expect(railCollapsed()).toBe("false");

    act(() => setWindowWidth(1800));
    expect(railCollapsed()).toBe("true");
  });
});
