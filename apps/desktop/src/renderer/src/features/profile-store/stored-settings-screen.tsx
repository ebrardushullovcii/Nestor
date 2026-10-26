import type { ComponentProps } from "react";
import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { PageHeaderStack } from "@renderer/features/job-finder/components/page-header";
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
  const { showToast } = useToast();
  if (!store.settings)
    return (
      <section aria-label="Settings">
        <PageHeaderStack
          title="Settings"
          description="Make Job Finder work the way you want."
        />
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
        onUpdateAiBehavior={async (input, options) => {
          const ok = await store.updateAiBehavior(input);
          if (ok && options?.undo)
            showToast({
              title: "Settings saved",
              tone: "success",
              action: { label: "Undo", onClick: options.undo },
            });
          return ok;
        }}
        onUpdateApplicationDefaults={store.updateApplicationDefaults}
        onUpdateWorkspaceBehavior={store.updateWorkspaceBehavior}
      />
    </>
  );
}
