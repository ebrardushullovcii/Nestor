// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "./theme-provider";
import { SYSTEM_THEME_CHANGE_EVENT } from "@renderer/lib/theme";

describe("ThemeProvider", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let systemThemeOverride: "dark" | "light" | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    root = null;
    container?.remove();
    container = null;
    window.localStorage.clear();
    Reflect.deleteProperty(window, "nestor");
    systemThemeOverride = null;
    vi.unstubAllGlobals();
  });

  function installThemeBridge() {
    Object.assign(window, {
      nestor: {
        jobFinder: {
          test: {
            getSystemThemeOverride: () => systemThemeOverride,
          },
        },
      },
    });
  }

  function renderThemeProvider(
    preference: "system" | "light" | "dark" = "system",
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    return act(() => {
      root?.render(
        <ThemeProvider preference={preference}>
          <div>theme test</div>
        </ThemeProvider>,
      );
    });
  }

  test("keeps explicit system-theme override after mount even when matchMedia reports light", () => {
    const mediaQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue(mediaQuery),
    });
    systemThemeOverride = "dark";
    installThemeBridge();

    renderThemeProvider();

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(
      container?.firstElementChild?.getAttribute("data-resolved-theme"),
    ).toBe("dark");
  });

  test("reacts to runtime override updates from the desktop test bridge", () => {
    const mediaQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue(mediaQuery),
    });
    installThemeBridge();

    renderThemeProvider();
    expect(document.documentElement.dataset.theme).toBe("light");

    act(() => {
      systemThemeOverride = "dark";
      window.dispatchEvent(new Event(SYSTEM_THEME_CHANGE_EVENT));
    });

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(
      container?.firstElementChild?.getAttribute("data-resolved-theme"),
    ).toBe("dark");
  });
});
