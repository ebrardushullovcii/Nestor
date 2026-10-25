import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AppearanceTheme } from "@nestor/contracts";
import {
  applyAppearancePreference,
  DARK_QUERY,
  getSystemPrefersDark,
  resolveAppearanceTheme,
  SYSTEM_THEME_CHANGE_EVENT,
  STORAGE_KEY,
  type ResolvedTheme,
} from "@renderer/lib/theme";

interface ThemeProviderProps {
  children: ReactNode;
  preference: AppearanceTheme;
}

export function ThemeProvider({ children, preference }: ThemeProviderProps) {
  const [systemPrefersDark, setSystemPrefersDark] =
    useState(getSystemPrefersDark);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const mediaQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia(DARK_QUERY)
        : null;
    const syncSystemPreference = () => {
      setSystemPrefersDark(getSystemPrefersDark());
    };

    syncSystemPreference();
    mediaQuery?.addEventListener("change", syncSystemPreference);
    window.addEventListener(SYSTEM_THEME_CHANGE_EVENT, syncSystemPreference);

    return () => {
      mediaQuery?.removeEventListener("change", syncSystemPreference);
      window.removeEventListener(
        SYSTEM_THEME_CHANGE_EVENT,
        syncSystemPreference,
      );
    };
  }, []);

  const resolvedTheme = useMemo<ResolvedTheme>(
    () => resolveAppearanceTheme(preference, systemPrefersDark),
    [preference, systemPrefersDark],
  );

  useEffect(() => {
    applyAppearancePreference(preference, systemPrefersDark);
    window.localStorage.setItem(STORAGE_KEY, preference);
  }, [preference, systemPrefersDark]);

  return (
    <div
      data-appearance-theme={preference}
      data-resolved-theme={resolvedTheme}
      className="contents"
    >
      {children}
    </div>
  );
}
