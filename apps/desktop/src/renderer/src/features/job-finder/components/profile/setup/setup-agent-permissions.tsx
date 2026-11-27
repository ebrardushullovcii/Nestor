import { useState } from "react";
import {
  browserAgentPermissionsOf,
  type BrowserAgentPermissions,
} from "@nestor/contracts";
import { useStoredSettings } from "@renderer/features/profile-store/use-stored-settings";
import { browserPermissionChoices } from "../../../screens/settings/settings-ai-behavior-section";
import { ToggleField } from "../../toggle-field";

/**
 * What the agent may do on its own, shown once during setup. A new profile
 * starts with all of it on (the owner's "full access" default); each row is
 * the same switch as in Settings and saves the moment it changes, so the
 * person sees what the agent will do and turns off what they would rather
 * do themselves.
 */
export function SetupAgentPermissions() {
  const store = useStoredSettings();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const settings = store.settings;
  const permissions = browserAgentPermissionsOf(settings);
  const answersPay = settings?.salaryDisclosure === "answer_from_profile";
  const save = (work: () => Promise<boolean>) => {
    setSaving(true);
    setError(null);
    void work()
      .then((ok) => {
        if (!ok) setError("That did not save. Try the switch again.");
      })
      .finally(() => setSaving(false));
  };
  const setPermission = (
    key: keyof BrowserAgentPermissions,
    checked: boolean,
  ) =>
    save(
      async () =>
        (await store.updateAiBehavior({
          aiBehavior: { browserPermissions: { [key]: checked } },
        })) !== false,
    );
  return (
    <section
      aria-labelledby="profile-setup-agent-permissions-heading"
      className="grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 p-4"
      data-profile-setup-block="agent-permissions"
    >
      <div className="grid gap-1">
        <h3
          className="text-sm font-semibold text-foreground"
          id="profile-setup-agent-permissions-heading"
        >
          What the agent may do for you
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-foreground-soft">
          All on, so searches and applications carry on without waiting for you.
          Turn off anything you would rather do yourself; the agent then hands
          you the page. You can change these later in Settings › AI behavior.
        </p>
      </div>
      {settings ? (
        <div className="grid min-w-0">
          {browserPermissionChoices.map((choice) => (
            <ToggleField
              checked={permissions[choice.key]}
              description={choice.description}
              disabled={saving}
              key={choice.key}
              label={choice.label}
              onCheckedChange={(checked) => setPermission(choice.key, checked)}
            />
          ))}
          <ToggleField
            checked={answersPay}
            description="Fills expected and current pay questions from your saved facts. Off: they wait for you."
            disabled={saving}
            label="Answer pay questions"
            onCheckedChange={(checked) =>
              save(() =>
                store.updateApplicationDefaults({
                  salaryDisclosure: checked
                    ? "answer_from_profile"
                    : "pause_for_user",
                }),
              )
            }
          />
        </div>
      ) : (
        <p className="text-sm text-foreground-soft" role="status">
          {store.readError ?? "Loading…"}
        </p>
      )}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
