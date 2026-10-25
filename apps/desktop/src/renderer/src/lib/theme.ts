import type { AppearanceTheme } from "@nestor/contracts";
import { SYSTEM_THEME_CHANGE_EVENT } from "../../../shared/system-theme";

export const STORAGE_KEY = "nestor.appearance-theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";
export { SYSTEM_THEME_CHANGE_EVENT };

export type ResolvedTheme = "dark" | "light";

export function readSystemThemeOverride(): ResolvedTheme | null {
  if (typeof window === "undefined") {
    return null;
  }

  const nestorWindow = window as Window & {
    nestor?: {
      jobFinder?: {
        test?: {
          getSystemThemeOverride?: () => ResolvedTheme | null;
        };
      };
    };
  };
  const overrideValue =
    nestorWindow.nestor?.jobFinder?.test?.getSystemThemeOverride?.();

  return overrideValue === "dark" || overrideValue === "light"
    ? overrideValue
    : null;
}

export function getSystemPrefersDark() {
  const override = readSystemThemeOverride();

  if (override === "dark") {
    return true;
  }

  if (override === "light") {
    return false;
  }

  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return true;
  }

  return window.matchMedia(DARK_QUERY).matches;
}

export function readStoredAppearanceTheme(): AppearanceTheme | null {
  if (typeof window === "undefined") {
    return null;
  }

  const storedValue = window.localStorage.getItem(STORAGE_KEY);

  if (
    storedValue === "dark" ||
    storedValue === "light" ||
    storedValue === "system"
  ) {
    return storedValue;
  }

  return null;
}

export function resolveAppearanceTheme(
  preference: AppearanceTheme,
  prefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return prefersDark ? "dark" : "light";
  }

  return preference;
}

export function applyResolvedTheme(theme: ResolvedTheme) {
  if (typeof document === "undefined") {
    return;
  }

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function applyAppearancePreference(
  preference: AppearanceTheme,
  prefersDark: boolean,
) {
  applyResolvedTheme(resolveAppearanceTheme(preference, prefersDark));
}
