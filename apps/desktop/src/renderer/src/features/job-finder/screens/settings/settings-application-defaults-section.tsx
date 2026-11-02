import { JOB_FINDER_SETTINGS_SECTIONS } from "@nestor/contracts";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import type {
  JobFinderSettings,
  ResumeTemplateDefinition,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import { FormSelect } from "../../components/form-select";
import { ResumeThemePicker } from "../../components/resume-theme-picker";
import { useRegisterSettingsDirtySection } from "./settings-dirty-sections";
import { SettingsSectionSaveControl } from "./settings-section-save-control";
import { SettingsRow } from "./settings-row";
import { SettingsWriteOnShortlist } from "./settings-write-on-shortlist";
import {
  hasOutstandingSectionChanges,
  useSettingsSectionSave,
} from "./settings-section-save";

/**
 * The look of a tailored resume: template and font.
 *
 * Whether a job gets a tailored resume at all, and how far the rewrite may
 * go, is an AI behavior choice and lives in that section. This one only
 * decides what the PDF looks like once it is written. Picking a template
 * or font saves it at once, like every other Settings choice; the Save
 * button remains only to retry a failed save.
 */

export const SETTINGS_RESUME_LOOK_LABEL =
  JOB_FINDER_SETTINGS_SECTIONS["application-defaults"].label;

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

interface SettingsApplicationDefaultsSectionProps {
  availableResumeTemplates: readonly ResumeTemplateDefinition[];
  onUpdateApplicationDefaults: (
    input: UpdateApplicationDefaultsInput,
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
  /** Saves the resume-writing switch at once. */
  onUpdateWorkspaceBehavior?: (
    input: UpdateWorkspaceBehaviorInput,
  ) => Promise<boolean | void> | void;
}

export function SettingsApplicationDefaultsSection({
  availableResumeTemplates,
  onUpdateApplicationDefaults,
  onUpdateWorkspaceBehavior,
  settings,
}: SettingsApplicationDefaultsSectionProps) {
  const fontPresetId = useId();
  const resumeTemplateLabelId = useId();
  const [draftFontPreset, setDraftFontPreset] = useState(settings.fontPreset);
  const [draftResumeTemplateId, setDraftResumeTemplateId] = useState(
    settings.resumeTemplateId,
  );
  const { resetSectionSave, runSectionSave, saveState } =
    useSettingsSectionSave();

  useEffect(() => {
    setDraftFontPreset(settings.fontPreset);
  }, [settings.fontPreset]);

  useEffect(() => {
    setDraftResumeTemplateId(settings.resumeTemplateId);
  }, [settings.resumeTemplateId]);

  const isSavePending = saveState.status === "saving";
  // Picks save at once; only a failed save is left outstanding to retry.
  const hasUnsavedChanges =
    saveState.status === "failed" &&
    (draftFontPreset !== settings.fontPreset ||
      draftResumeTemplateId !== settings.resumeTemplateId);
  const isFontPresetOption = (
    value: string,
  ): value is JobFinderSettings["fontPreset"] =>
    fontPresetOptions.some((fontPreset) => fontPreset.value === value);
  const isResumeTemplateOption = (
    value: string,
  ): value is JobFinderSettings["resumeTemplateId"] =>
    availableResumeTemplates.some((template) => template.id === value);
  const selectedFontPreset = fontPresetOptions.find(
    (fontPreset) => fontPreset.value === draftFontPreset,
  );
  const saveResumeLook = (
    fontPreset = draftFontPreset,
    resumeTemplateId = draftResumeTemplateId,
  ) => {
    if (isSavePending) {
      return;
    }
    void runSectionSave({
      execute: () =>
        onUpdateApplicationDefaults({
          fontPreset,
          resumeTemplateId,
        }),
      failedMessage:
        "Resume look was not saved. Retry before leaving this page.",
      savedMessage: "Resume look saved.",
    });
  };
  const pickFontPreset = (value: string) => {
    if (isSavePending || !isFontPresetOption(value)) return;
    setDraftFontPreset(value);
    resetSectionSave();
    saveResumeLook(value, draftResumeTemplateId);
  };
  const pickResumeTemplate = (value: string) => {
    if (isSavePending || !isResumeTemplateOption(value)) return;
    setDraftResumeTemplateId(value);
    resetSectionSave();
    saveResumeLook(draftFontPreset, value);
  };

  useRegisterSettingsDirtySection({
    anchorId: "settings-application-defaults",
    isDirty: hasOutstandingSectionChanges(hasUnsavedChanges, saveState),
    isSaving: isSavePending,
    label: SETTINGS_RESUME_LOOK_LABEL,
    onSave: () => saveResumeLook(),
    order: 2,
    saveLabel: "Save resume look",
  });

  return (
    <section className="surface-panel-shell relative grid min-w-0 content-start gap-3 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 max-w-[70ch] flex-1 gap-1">
          <h3
            className="min-w-0 font-semibold text-(--text-headline)"
          >
            {SETTINGS_RESUME_LOOK_LABEL}
          </h3>
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            The template is the default for new tailored resumes. The font
            applies to every generated resume, and changing it means approving
            existing drafts again. The resume level lives in Profile, under
            Preferences, and your files are in{" "}
            <Link
              className="text-(--link) underline underline-offset-2 hover:text-(--link-hover)"
              to={JOB_FINDER_ROUTE_PATHS.profile}
            >
              Profile
            </Link>
            .
          </p>
        </div>
        <SettingsSectionSaveControl
          hasUnsavedChanges={hasUnsavedChanges}
          onSave={() => saveResumeLook()}
          saveState={saveState}
          subject="resume look"
          effect="Template changes apply to new drafts. Font changes apply to all generated resumes."
        />
      </div>

      <div className="grid min-w-0 gap-2 border-t border-(--surface-panel-border) pt-4">
        <h4
          className="text-(length:--text-body) font-medium text-foreground"
          id={resumeTemplateLabelId}
        >
          Default resume template
        </h4>
        <ResumeThemePicker
          disabled={isSavePending}
          labelledBy={resumeTemplateLabelId}
          onChange={pickResumeTemplate}
          selectedThemeId={draftResumeTemplateId}
          themes={availableResumeTemplates}
        />
      </div>

      <div className="grid min-w-0 border-t border-(--surface-panel-border) pt-4">
        <SettingsRow
          control={
            <div className="w-64 max-w-full">
              <FormSelect
                disabled={isSavePending}
                onValueChange={pickFontPreset}
                options={fontPresetOptions.map((fontPreset) => ({
                  label: fontPreset.label,
                  value: fontPreset.value,
                }))}
                placeholder="Select font"
                triggerId={fontPresetId}
                value={draftFontPreset}
              />
            </div>
          }
          description={
            <>
              The font pairing for exported resumes. It changes how the PDF
              looks, not the wording. {selectedFontPreset?.description ?? ""}
            </>
          }
          label={<label htmlFor={fontPresetId}>Resume font</label>}
        />
      </div>
      {onUpdateWorkspaceBehavior ? (
        <SettingsWriteOnShortlist
          onUpdateWorkspaceBehavior={onUpdateWorkspaceBehavior}
          settings={settings}
        />
      ) : null}
    </section>
  );
}
