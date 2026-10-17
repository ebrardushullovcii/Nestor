import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import type {
  JobFinderSettings,
  ResumeTemplateDefinition,
  UpdateApplicationDefaultsInput,
} from "@nestor/contracts";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { FormSelect } from "../../components/form-select";
import { ResumeThemePicker } from "../../components/resume-theme-picker";
import { useRegisterSettingsDirtySection } from "./settings-dirty-sections";
import { SettingsSectionSaveControl } from "./settings-section-save-control";
import {
  hasOutstandingSectionChanges,
  useSettingsSectionSave,
} from "./settings-section-save";

/**
 * The look of a tailored resume: template and font.
 *
 * Whether a job gets a tailored resume at all, and how far the rewrite may
 * go, is an AI behavior choice and lives in that section. This one only
 * decides what the PDF looks like once it is written.
 */

export const SETTINGS_RESUME_LOOK_LABEL = "Resume look";

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
  /** Reports staged default edits so a stale shell save retry is retired. */
  onSettingsDraftEdited?: () => void;
  onUpdateApplicationDefaults: (
    input: UpdateApplicationDefaultsInput,
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
}

export function SettingsApplicationDefaultsSection({
  availableResumeTemplates,
  onSettingsDraftEdited,
  onUpdateApplicationDefaults,
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
  const hasUnsavedChanges =
    draftFontPreset !== settings.fontPreset ||
    draftResumeTemplateId !== settings.resumeTemplateId;
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
  const updateStagedDrafts = (updater: () => void) => {
    if (isSavePending) {
      return;
    }
    updater();
    resetSectionSave();
    onSettingsDraftEdited?.();
  };
  const saveResumeLook = () => {
    if (!hasUnsavedChanges || isSavePending) {
      return;
    }
    void runSectionSave({
      execute: () =>
        onUpdateApplicationDefaults({
          fontPreset: draftFontPreset,
          resumeTemplateId: draftResumeTemplateId,
        }),
      failedMessage:
        "Resume look was not saved. Retry before leaving this page.",
      savedMessage: "Resume look saved.",
    });
  };

  useRegisterSettingsDirtySection({
    anchorId: "settings-application-defaults",
    isDirty: hasOutstandingSectionChanges(hasUnsavedChanges, saveState),
    isSaving: isSavePending,
    label: SETTINGS_RESUME_LOOK_LABEL,
    onSave: saveResumeLook,
    order: 2,
    saveLabel: "Save resume look",
  });

  return (
    <section className="surface-panel-shell relative grid min-w-0 content-start gap-3 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 max-w-[72ch] flex-1 gap-1">
          <h3 className="min-w-0 font-semibold text-(--text-headline)">
            {SETTINGS_RESUME_LOOK_LABEL}
          </h3>
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            The template is the default for new tailored resumes. The font
            applies to all generated resumes; changing it requires approving
            existing drafts again. Resume rewriting is set under AI behavior.
            Your resume and any extra files for applications are managed in{" "}
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
          onSave={saveResumeLook}
          saveState={saveState}
          subject="resume look"
          effect="Template changes apply to new drafts. Font changes apply to all generated resumes."
        />
      </div>

      <Field>
        <FieldLabel id={resumeTemplateLabelId}>
          Default resume template
        </FieldLabel>
        <p className="max-w-(--workspace-state-card-max-width) text-(length:--text-description) leading-5 text-foreground-soft">
          The preview uses example content so you can see the layout.
        </p>
        <div className="grid min-w-0 gap-2.5">
          <ResumeThemePicker
            disabled={isSavePending}
            labelledBy={resumeTemplateLabelId}
            onChange={(value) =>
              updateStagedDrafts(() =>
                setDraftResumeTemplateId(
                  isResumeTemplateOption(value) ? value : draftResumeTemplateId,
                ),
              )
            }
            selectedThemeId={draftResumeTemplateId}
            themes={availableResumeTemplates}
          />
        </div>
      </Field>

      <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Field className="min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3.5 py-3">
          <FieldLabel htmlFor={fontPresetId}>Resume font</FieldLabel>
          <FormSelect
            disabled={isSavePending}
            onValueChange={(value) =>
              updateStagedDrafts(() =>
                setDraftFontPreset(
                  isFontPresetOption(value) ? value : draftFontPreset,
                ),
              )
            }
            options={fontPresetOptions.map((fontPreset) => ({
              label: fontPreset.label,
              value: fontPreset.value,
            }))}
            placeholder="Select font"
            triggerId={fontPresetId}
            value={draftFontPreset}
          />
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            Pick the default font pairing for exported resumes. It changes how
            the exported PDF looks, not the wording in your resume.
          </p>
        </Field>
        <div className="surface-card-tint min-w-0 rounded-(--radius-field) border border-(--surface-panel-border) px-3.5 py-3 md:col-span-2">
          <span className="label-mono-xs">Selected font</span>
          <strong className="mt-1.5 block text-(length:--text-body) font-semibold text-foreground">
            {selectedFontPreset?.label ?? "Font not available"}
          </strong>
          <p className="mt-1.5 text-(length:--text-description) leading-5 text-foreground-soft">
            {selectedFontPreset?.description ??
              "Choose the default font pairing for resume exports."}
          </p>
        </div>
      </div>

      {hasUnsavedChanges && saveState.status !== "saving" ? (
        <p
          className="min-h-[1.5rem] min-w-0 text-sm leading-6 text-(--warning-text)"
          role="status"
        >
          You have unsaved resume look changes.
        </p>
      ) : (
        <div className="min-h-[1.5rem]" />
      )}
    </section>
  );
}
