import { useEffect, useId, useState } from "react";
import type {
  JobFinderSettings,
  UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import { ToggleField } from "../../components/toggle-field";
import { useRegisterSettingsDirtySection } from "./settings-dirty-sections";
import { SettingsSectionSaveControl } from "./settings-section-save-control";
import {
  hasOutstandingSectionChanges,
  useSettingsSectionSave,
} from "./settings-section-save";

interface SettingsWorkspaceBehaviorSectionProps {
  /** Reports staged behavior edits so a stale shell save retry is retired. */
  onSettingsDraftEdited?: () => void;
  onUpdateWorkspaceBehavior: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
}

export function SettingsWorkspaceBehaviorSection({
  onSettingsDraftEdited,
  onUpdateWorkspaceBehavior,
  settings,
}: SettingsWorkspaceBehaviorSectionProps) {
  const sectionHeadingId = useId();
  const [draftKeepSessionAlive, setDraftKeepSessionAlive] = useState(
    settings.keepSessionAlive,
  );
  const [draftDiscoveryOnly, setDraftDiscoveryOnly] = useState(
    settings.discoveryOnly,
  );
  const { resetSectionSave, runSectionSave, saveState } =
    useSettingsSectionSave();

  useEffect(() => {
    setDraftKeepSessionAlive(settings.keepSessionAlive);
  }, [settings.keepSessionAlive]);

  useEffect(() => {
    setDraftDiscoveryOnly(settings.discoveryOnly);
  }, [settings.discoveryOnly]);

  const isSavePending = saveState.status === "saving";
  const hasUnsavedChanges =
    draftKeepSessionAlive !== settings.keepSessionAlive ||
    draftDiscoveryOnly !== settings.discoveryOnly;
  const saveBehavior = (input: UpdateWorkspaceBehaviorInput) => {
    void runSectionSave({
      execute: () => onUpdateWorkspaceBehavior(input),
      failedMessage:
        "Browser & saved jobs were not saved. Retry before leaving this page.",
      savedMessage: "Browser & saved jobs saved.",
    });
  };
  // A switch acts when flipped, like the theme: it saves at once instead of
  // waiting for a Save press. A failed save keeps the choice and offers Retry.
  const flipSwitch = (next: {
    discoveryOnly: boolean;
    keepSessionAlive: boolean;
  }) => {
    if (isSavePending) {
      return;
    }
    setDraftDiscoveryOnly(next.discoveryOnly);
    setDraftKeepSessionAlive(next.keepSessionAlive);
    resetSectionSave();
    onSettingsDraftEdited?.();
    if (
      next.discoveryOnly !== settings.discoveryOnly ||
      next.keepSessionAlive !== settings.keepSessionAlive
    ) {
      saveBehavior(next);
    }
  };
  // Retry after a failed save.
  const saveWorkspaceBehavior = () => {
    if (!hasUnsavedChanges || isSavePending) {
      return;
    }
    saveBehavior({
      discoveryOnly: draftDiscoveryOnly,
      keepSessionAlive: draftKeepSessionAlive,
    });
  };

  useRegisterSettingsDirtySection({
    anchorId: "settings-workspace-behavior",
    isDirty: hasOutstandingSectionChanges(hasUnsavedChanges, saveState),
    isSaving: isSavePending,
    label: "Browser & saved jobs",
    onSave: saveWorkspaceBehavior,
    order: 3,
    saveLabel: "Save browser & saved jobs",
  });

  return (
    <section className="surface-panel-shell grid min-w-0 content-start gap-3 rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 max-w-[72ch] flex-1 gap-1">
          <h3
            className="min-w-0 font-semibold text-(--text-headline)"
            id={sectionHeadingId}
          >
            Browser and saved jobs
          </h3>
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            Keep only the defaults you actually want Job Finder to reuse between
            searches and application steps.
          </p>
        </div>
        <SettingsSectionSaveControl
          hasUnsavedChanges={hasUnsavedChanges}
          onSave={saveWorkspaceBehavior}
          saveState={saveState}
          subject="browser & saved jobs"
          effect="Applies from your next search or application run."
        />
      </div>

      <div className="grid min-w-0 gap-(--gap-content) md:grid-cols-2">
        <ToggleField
          checked={draftKeepSessionAlive}
          description="Keep the agent’s tabs open after searches and application steps so the next run starts where the last one left off."
          disabled={isSavePending}
          hint="Off closes finished tabs when you are not looking at them. Unfinished applications and saved sign-ins are kept."
          label="Keep browser tabs after runs"
          onCheckedChange={(checked) =>
            flipSwitch({
              discoveryOnly: draftDiscoveryOnly,
              keepSessionAlive: checked,
            })
          }
        />
        <ToggleField
          checked={draftDiscoveryOnly}
          description="Keep new search results temporary until you shortlist them."
          disabled={isSavePending}
          hint="Useful if you want a cleaner workspace with fewer saved jobs."
          label="Only keep jobs I shortlist"
          onCheckedChange={(checked) =>
            flipSwitch({
              discoveryOnly: checked,
              keepSessionAlive: draftKeepSessionAlive,
            })
          }
        />
      </div>
    </section>
  );
}
