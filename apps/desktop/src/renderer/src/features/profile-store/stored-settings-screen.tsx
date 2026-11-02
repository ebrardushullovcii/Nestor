import { useEffect, useState } from "react";
import { FormSectionsSkeleton } from "@renderer/features/job-finder/components/route-skeleton";
import { useNavigate } from "react-router-dom";
import type { DesktopBrowserState } from "@nestor/contracts";
import { ListReadError } from "@renderer/features/job-lists";
import { useToast } from "@renderer/components/ui/toast";
import { PageHeaderStack } from "@renderer/features/job-finder/components/page-header";
import { SettingsScreen } from "@renderer/features/job-finder/screens/settings/settings-screen";
import { listLocalResumeTemplates } from "../../../../shared/job-finder-resume-catalog";
import { ScreenReadWarning } from "./screen-read-warning";
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
          description="Everything saves as you go: a choice when you pick it, typed text when you pause or leave the field."
        />
        {store.error ? (
          <div className="grid place-items-center p-10">
            <ListReadError
              error={store.error}
              kept={null}
              onRetry={() => void store.refresh()}
              what="Your settings"
            />
          </div>
        ) : (
          <>
            <p className="sr-only" role="status">
              Loading your settings…
            </p>
            <FormSectionsSkeleton tabs={4} />
          </>
        )}
      </section>
    );
  return (
    <>
      <ScreenReadWarning
        onRetry={() => void store.refresh()}
        readError={store.readError}
        saveError={store.error}
        what="Your settings"
      />
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
