import { afterEach, describe, expect, test, vi } from "vitest";
import { getSystemPrefersDark, resolveAppearanceTheme } from "./theme";

describe("theme helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("defaults system preference fallback to dark when matchMedia is unavailable", () => {
    vi.stubGlobal("window", {});

    expect(getSystemPrefersDark()).toBe(true);
    expect(resolveAppearanceTheme("system", getSystemPrefersDark())).toBe(
      "dark",
    );
  });

  test("resolves system preference from the current media query when available", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn().mockReturnValue({
        matches: false,
      }),
    });

    expect(getSystemPrefersDark()).toBe(false);
    expect(resolveAppearanceTheme("system", getSystemPrefersDark())).toBe(
      "light",
    );
  });

  test("prefers explicit override when provided for desktop test flows", () => {
    vi.stubGlobal("window", {
      nestor: {
        jobFinder: {
          test: {
            getSystemThemeOverride: () => "dark",
          },
        },
      },
      matchMedia: vi.fn().mockReturnValue({
        matches: false,
      }),
    });

    expect(getSystemPrefersDark()).toBe(true);
    expect(resolveAppearanceTheme("system", getSystemPrefersDark())).toBe(
      "dark",
    );
  });
});
