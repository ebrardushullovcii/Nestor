import { useEffect, useId, useState } from "react";
import type {
  JobFinderSettings,
  ResumeTemplateDefinition,
} from "@nestor/contracts";
import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { FormSelect } from "../../components/form-select";
import { ResumeThemePicker } from "../../components/resume-theme-picker";
import { ToggleField } from "../../components/toggle-field";
import type { JobFinderSaveState } from "@renderer/pages/job-finder-save-state";

const fontPresetOptions: ReadonlyArray<{
  description: string;
  label: string;
  value: JobFinderSettings["fontPreset"];
}> = [
  {
    description:
      "Clean, compact, and the safest default for high-volume applications.",
    label: "Clean sans",
    value: "inter_requisite",
  },
  {
    description:
      "A stronger display look that keeps more personality in the final PDF.",
    label: "Display sans",
    value: "space_grotesk_display",
  },
];

interface SettingsEditableDefaultsProps {
  actionMessage: string | null;
  availableResumeTemplates: readonly ResumeTemplateDefinition[];
  isSavePending: boolean;
  onSaveSettings: (settings: JobFinderSettings) => void;
  saveState: JobFinderSaveState;
  settings: JobFinderSettings;
}

export function SettingsEditableDefaults({
  actionMessage,
  availableResumeTemplates,
  isSavePending,
  onSaveSettings,
  saveState,
  settings,
}: SettingsEditableDefaultsProps) {
  const appearanceId = useId();
  const fontPresetId = useId();
  const resumeTemplateDomId = useId();
  const [settingsForm, setSettingsForm] = useState(settings);
  const appearanceThemeOptions: ReadonlyArray<{
    label: string;
    value: JobFinderSettings["appearanceTheme"];
  }> = [
    { label: "System", value: "system" },
    { label: "Light", value: "light" },
    { label: "Dark", value: "dark" },
  ];
  const isFontPresetOption = (
    value: string,
  ): value is JobFinderSettings["fontPreset"] =>
    fontPresetOptions.some((fontPreset) => fontPreset.value === value);
  const isResumeTemplateOption = (
    value: string,
  ): value is JobFinderSettings["resumeTemplateId"] =>
    availableResumeTemplates.some((template) => template.id === value);
  const isAppearanceThemeOption = (
    value: string,
  ): value is JobFinderSettings["appearanceTheme"] =>
    appearanceThemeOptions.some((option) => option.value === value);
  const updateSettingsForm = (
    updater: (current: JobFinderSettings) => JobFinderSettings,
  ) => {
    if (isSavePending) {
      return;
    }

    setSettingsForm(updater);
  };
  const selectedFontPreset = fontPresetOptions.find(
    (fontPreset) => fontPreset.value === settingsForm.fontPreset,
  );
  const selectedResumeApplicationMode =
    settingsForm.resumeApplicationMode ?? "tailored_per_job";
  const savedResumeApplicationMode =
    settings.resumeApplicationMode ?? "tailored_per_job";
  const hasUnsavedChanges =
    settingsForm.resumeTemplateId !== settings.resumeTemplateId ||
    settingsForm.fontPreset !== settings.fontPreset ||
    settingsForm.appearanceTheme !== settings.appearanceTheme ||
    settingsForm.keepSessionAlive !== settings.keepSessionAlive ||
    settingsForm.discoveryOnly !== settings.discoveryOnly ||
    selectedResumeApplicationMode !== savedResumeApplicationMode;
  const settingsSaveState =
    saveState.state !== "idle" && saveState.surface === "settings"
      ? saveState
      : null;
  const cvSaveButtonLabel =
    settingsSaveState?.state === "saving"
      ? "Saving resume preference"
      : settingsSaveState?.state === "failed"
        ? "Retry resume preference"
        : settingsSaveState?.state === "saved" && !hasUnsavedChanges
          ? "Resume preference saved"
          : "Save resume preference";
  const saveSettings = () => {
    onSaveSettings({
      ...settingsForm,
      resumeApplicationMode: selectedResumeApplicationMode,
    });
  };

  const {
    allowAutoSubmitOverride: savedAllowAutoSubmitOverride,
    appearanceTheme: savedAppearanceTheme,
    discoveryOnly: savedDiscoveryOnly,
    fontPreset: savedFontPreset,
    humanReviewRequired: savedHumanReviewRequired,
    keepSessionAlive: savedKeepSessionAlive,
    resumeApplicationMode: savedApplicationMode,
    resumeFormat: savedResumeFormat,
    resumeTemplateId: savedResumeTemplateId,
  } = settings;

  useEffect(() => {
    setSettingsForm({
      allowAutoSubmitOverride: savedAllowAutoSubmitOverride,
      appearanceTheme: savedAppearanceTheme,
      discoveryOnly: savedDiscoveryOnly,
      fontPreset: savedFontPreset,
      humanReviewRequired: savedHumanReviewRequired,
      keepSessionAlive: savedKeepSessionAlive,
      resumeApplicationMode: savedApplicationMode,
      resumeFormat: savedResumeFormat,
      resumeTemplateId: savedResumeTemplateId,
    });
  }, [
    savedAllowAutoSubmitOverride,
    savedAppearanceTheme,
    savedApplicationMode,
    savedDiscoveryOnly,
    savedFontPreset,
    savedHumanReviewRequired,
    savedKeepSessionAlive,
    savedResumeFormat,
    savedResumeTemplateId,
  ]);

  return (
    <section className="surface-panel-shell relative grid min-w-0 content-start gap-3 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="grid min-w-0 gap-3">
        <section className="grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-subtle) p-3.5">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 max-w-[72ch] flex-1 gap-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="min-w-0 text-[1.02rem] font-semibold text-(--text-headline)">
                  Resume used for applications
                </h2>
                <Badge variant="section">
                  Default for newly shortlisted jobs
                </Badge>
              </div>
              <p className="text-(length:--text-description) leading-5 text-foreground-soft">
                Choose whether each job gets a tailored resume or the exact file
                you imported in Profile. You still decide job by job before
                Apply Copilot opens the application.
              </p>
            </div>
            <div className="grid min-w-0 max-w-full justify-items-end gap-1.5">
              <Button
                disabled={!hasUnsavedChanges || isSavePending}
                pending={isSavePending}
                onClick={saveSettings}
                type="button"
                variant="primary"
              >
                {cvSaveButtonLabel}
              </Button>
              {settingsSaveState ? (
                <p
                  className={
                    settingsSaveState.state === "failed"
                      ? "min-w-0 max-w-80 break-words text-right text-xs leading-4 text-destructive"
                      : "min-w-0 max-w-80 break-words text-right text-xs leading-4 text-foreground-soft"
                  }
                  data-settings-save-state={settingsSaveState.state}
                  role="status"
                >
                  {settingsSaveState.message}
                </p>
              ) : null}
            </div>
          </div>

          <div
            className="grid min-w-0 gap-2.5 md:grid-cols-2"
            role="radiogroup"
            aria-label="Resume application mode"
          >
            <button
              aria-checked={
                selectedResumeApplicationMode === "tailored_per_job"
              }
              className={`grid min-w-0 min-h-32 gap-2 rounded-(--radius-field) border p-4 text-left transition-colors ${selectedResumeApplicationMode === "tailored_per_job" ? "border-primary/70 bg-primary/8" : "border-(--surface-panel-border) bg-background/45 hover:border-primary/35"}`}
              disabled={isSavePending}
              onClick={() =>
                updateSettingsForm((current) => ({
                  ...current,
                  resumeApplicationMode: "tailored_per_job",
                }))
              }
              role="radio"
              type="button"
            >
              <span className="font-semibold text-foreground">
                Tailor a resume for each job
              </span>
              <span className="text-(length:--text-description) leading-5 text-foreground-soft">
                Create, review, and approve a job-specific PDF before it can be
                attached.
              </span>
              <span className="label-mono-xs">
                {selectedResumeApplicationMode === "tailored_per_job"
                  ? savedResumeApplicationMode === "tailored_per_job"
                    ? "Saved default"
                    : "Selected · save to apply"
                  : "Job-specific rewriting"}
              </span>
            </button>
            <button
              aria-checked={selectedResumeApplicationMode === "original_resume"}
              className={`grid min-w-0 min-h-32 gap-2 rounded-(--radius-field) border p-4 text-left transition-colors ${selectedResumeApplicationMode === "original_resume" ? "border-primary/70 bg-primary/8" : "border-(--surface-panel-border) bg-background/45 hover:border-primary/35"}`}
              disabled={isSavePending}
              onClick={() =>
                updateSettingsForm((current) => ({
                  ...current,
                  resumeApplicationMode: "original_resume",
                }))
              }
              role="radio"
              type="button"
            >
              <span className="font-semibold text-foreground">
                Use my original resume unchanged
              </span>
              <span className="text-(length:--text-description) leading-5 text-foreground-soft">
                Skip resume generation. Shortlisted shows the imported file and
                Job Finder attaches that same file.
              </span>
              <span className="label-mono-xs">
                {selectedResumeApplicationMode === "original_resume"
                  ? savedResumeApplicationMode === "original_resume"
                    ? "Saved default · no rewriting"
                    : "Selected · save to apply"
                  : "No rewriting or job removal"}
              </span>
            </button>
          </div>

          {selectedResumeApplicationMode === "original_resume" ? (
            <div
              className="grid min-w-0 gap-1 rounded-(--radius-field) border border-primary/25 bg-primary/6 px-3.5 py-3 text-sm leading-5 text-foreground-soft"
              aria-live="polite"
            >
              <strong className="text-foreground">
                {savedResumeApplicationMode === "original_resume"
                  ? "Original resume is the saved application default."
                  : "Save this preference before leaving Settings."}
              </strong>
              <p>
                Original-resume mode preserves the imported file byte for byte.
                Newly shortlisted jobs start with this choice, while every
                current job keeps its own selection. Template and font choices
                below only apply when tailored-resume mode is selected.
              </p>
            </div>
          ) : null}
        </section>

        <section className="grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-subtle) p-3.5">
          <div className="grid gap-1">
            <h2 className="text-[1.02rem] font-semibold text-(--text-headline)">
              Default template picker
            </h2>
            <p className="max-w-(--workspace-state-card-max-width) text-(length:--text-description) leading-5 text-foreground-soft">
              Choose the starting resume template here. The preview uses sample
              resume content rendered through the same template engine used for
              exports. Appearance and font defaults sit just below.
            </p>
          </div>

          <Field>
            <FieldLabel id={resumeTemplateDomId}>
              Default resume template
            </FieldLabel>
            <div className="grid min-w-0 gap-2.5">
              <div className="flex flex-wrap gap-2">
                <Badge variant="section">Applies to new drafts</Badge>
                <Badge variant="section">Existing drafts unchanged</Badge>
              </div>
              <ResumeThemePicker
                disabled={isSavePending}
                labelledBy={resumeTemplateDomId}
                onChange={(value) =>
                  updateSettingsForm((current) => ({
                    ...current,
                    resumeTemplateId: isResumeTemplateOption(value)
                      ? value
                      : current.resumeTemplateId,
                  }))
                }
                selectedThemeId={settingsForm.resumeTemplateId}
                themes={availableResumeTemplates}
              />
            </div>
          </Field>

          <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field className="min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3.5 py-3">
              <FieldLabel htmlFor={appearanceId}>Appearance</FieldLabel>
              <FormSelect
                disabled={isSavePending}
                onValueChange={(value) =>
                  updateSettingsForm((current) => ({
                    ...current,
                    appearanceTheme: isAppearanceThemeOption(value)
                      ? value
                      : current.appearanceTheme,
                  }))
                }
                options={appearanceThemeOptions}
                placeholder="Select appearance"
                triggerId={appearanceId}
                value={settingsForm.appearanceTheme}
              />
              <p className="text-(length:--text-description) leading-5 text-foreground-soft">
                Use system if you want Job Finder to follow the OS, or pin a
                theme when you want a stable visual working environment.
              </p>
            </Field>
            <Field className="min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3.5 py-3">
              <FieldLabel htmlFor={fontPresetId}>Resume font</FieldLabel>
              <FormSelect
                disabled={isSavePending}
                onValueChange={(value) =>
                  updateSettingsForm((current) => ({
                    ...current,
                    fontPreset: isFontPresetOption(value)
                      ? value
                      : current.fontPreset,
                  }))
                }
                options={fontPresetOptions.map((fontPreset) => ({
                  label: fontPreset.label,
                  value: fontPreset.value,
                }))}
                placeholder="Select font"
                triggerId={fontPresetId}
                value={settingsForm.fontPreset}
              />
              <p className="text-(length:--text-description) leading-5 text-foreground-soft">
                Pick the default font pairing for exported resumes. It changes
                how the exported PDF looks, not the wording in your resume.
              </p>
            </Field>
            <div className="surface-card-tint min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) px-3.5 py-3">
              <span className="label-mono-xs">Selected font</span>
              <strong className="mt-1.5 block text-(length:--text-body) font-semibold text-foreground">
                {selectedFontPreset?.label ?? "Font not available"}
              </strong>
              <p className="mt-1.5 text-(length:--text-description) leading-5 text-foreground-soft">
                {selectedFontPreset?.description ??
                  "Choose the default font pairing for resume exports."}
              </p>
            </div>
            <div className="surface-card-tint min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) px-3.5 py-3">
              <span className="label-mono-xs">Workflow defaults</span>
              <strong className="mt-1.5 block text-(length:--text-body) font-semibold text-foreground">
                {selectedResumeApplicationMode === "original_resume"
                  ? "Original resume"
                  : "Tailored resume"}{" "}
                ·{" "}
                {settingsForm.keepSessionAlive
                  ? "Keep browser tabs"
                  : "Close tabs after runs"}
              </strong>
              <p className="mt-1.5 text-(length:--text-description) leading-5 text-foreground-soft">
                Decide whether the browser keeps its tabs between runs and
                whether new search results persist automatically.
              </p>
            </div>
          </div>
        </section>

        <section className="grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-subtle) p-3.5">
          <div className="grid gap-1">
            <h2 className="text-[1.02rem] font-semibold text-(--text-headline)">
              Workspace behavior
            </h2>
            <p className="max-w-[72ch] text-(length:--text-description) leading-5 text-foreground-soft">
              Keep only the defaults you actually want Job Finder to reuse
              between searches and application steps.
            </p>
          </div>

          <div className="grid min-w-0 gap-(--gap-content) md:grid-cols-2">
            <ToggleField
              checked={settingsForm.keepSessionAlive}
              description="Keep the agent’s tabs open after searches and application steps so the next run starts where the last one left off."
              disabled={isSavePending}
              hint="Off closes the tabs as soon as a run finishes and you are not looking at them. Sign-ins are kept either way."
              label="Keep browser tabs after runs"
              onCheckedChange={(checked) =>
                updateSettingsForm((current) => ({
                  ...current,
                  keepSessionAlive: checked,
                }))
              }
            />
            <ToggleField
              checked={settingsForm.discoveryOnly}
              description="Keep new search results temporary until you shortlist them."
              disabled={isSavePending}
              hint="Useful if you want a cleaner workspace with fewer saved jobs."
              label="Only keep jobs I shortlist"
              onCheckedChange={(checked) =>
                updateSettingsForm((current) => ({
                  ...current,
                  discoveryOnly: checked,
                }))
              }
            />
          </div>
        </section>
      </div>

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-border/10 pt-2.5">
        <div className="min-h-[1.5rem] min-w-0 flex-1 text-sm leading-6 text-foreground-soft">
          {actionMessage ? (
            <p className="text-primary" role="status">
              {actionMessage}
            </p>
          ) : hasUnsavedChanges ? (
            <p className="text-(--warning-text)" role="status">
              You have unsaved settings changes.
            </p>
          ) : (
            "All settings on this page are saved."
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Badge variant="section">Default for jobs shortlisted later</Badge>
          <Button
            disabled={!hasUnsavedChanges || isSavePending}
            variant="primary"
            pending={isSavePending}
            onClick={saveSettings}
            type="button"
          >
            Save settings
          </Button>
        </div>
      </div>
    </section>
  );
}
