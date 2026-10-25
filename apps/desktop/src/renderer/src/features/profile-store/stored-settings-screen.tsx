import type { ComponentProps } from "react";
import { Button } from "@renderer/components/ui/button";
import { SettingsScreen } from "@renderer/features/job-finder/screens/settings/settings-screen";
import { useStoredSettings } from "./use-stored-settings";

type SettingsPorts = Omit<
  ComponentProps<typeof SettingsScreen>,
  | "settings"
  | "onUpdateAppearanceTheme"
  | "onUpdateAiBehavior"
  | "onUpdateApplicationDefaults"
  | "onUpdateWorkspaceBehavior"
>;
/** Settings owns its small read, independently of Profile and every job list. */
export function StoredSettingsScreen(props: SettingsPorts) {
  const store = useStoredSettings();
  if (!store.settings)
    return (
      <section aria-label="Settings">
        <h1>Settings</h1>
        {store.error ? (
          <p role="alert">
            {store.error}{" "}
            <Button onClick={() => void store.refresh()}>Try again</Button>
          </p>
        ) : (
          <p role="status">Loading your settings…</p>
        )}
      </section>
    );
  return (
    <>
      {store.error ? <p role="alert">{store.error}</p> : null}
      <SettingsScreen
        {...props}
        settings={store.settings}
        onUpdateAppearanceTheme={store.updateAppearanceTheme}
        onUpdateAiBehavior={store.updateAiBehavior}
        onUpdateApplicationDefaults={store.updateApplicationDefaults}
        onUpdateWorkspaceBehavior={store.updateWorkspaceBehavior}
      />
    </>
  );
}
