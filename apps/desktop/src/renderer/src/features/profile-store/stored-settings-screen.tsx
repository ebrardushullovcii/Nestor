import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DesktopBrowserState } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { PageHeaderStack } from "@renderer/features/job-finder/components/page-header";
import { SettingsScreen } from "@renderer/features/job-finder/screens/settings/settings-screen";
import { listLocalResumeTemplates } from "../../../../shared/job-finder-resume-catalog";
import { useStoredSettings } from "./use-stored-settings";

const RESUME_TEMPLATES = listLocalResumeTemplates();

function useBrowserState(): DesktopBrowserState | null {
  const [state, setState] = useState<DesktopBrowserState | null>(null);
  useEffect(() => {
    const browser = window.nestor?.browser;
    if (!browser) return undefined;
    let live = true;
    void browser.getState().then(
      (next) => live && setState(next),
      () => undefined,
    );
    const stop = browser.onStateChanged(setState);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return state;
}

/** Settings owns its small read, independently of Profile and every job list. */
export function StoredSettingsScreen() {
  const store = useStoredSettings();
  const browser = useBrowserState();
  const navigate = useNavigate();
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
        availableResumeTemplates={RESUME_TEMPLATES}
        browser={browser}
        onResetWorkspace={async () => {
          await window.nestor.jobFinder.resetWorkspace();
          // Reset leaves nothing set up, so guided setup opens next.
          void navigate("/job-finder/profile/setup");
        }}
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
