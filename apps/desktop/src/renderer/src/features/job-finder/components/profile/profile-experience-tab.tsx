import type { UseFieldArrayReturn, UseFormReturn } from "react-hook-form";
import { Controller } from "react-hook-form";
import { workModeValues } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { CheckboxField } from "../checkbox-field";
import { FormSelect } from "../form-select";
import { EmptyState } from "../empty-state";
import type { ProfileEditorValues } from "../../lib/profile-editor";
import {
  formatStatusLabel,
  joinListInput,
  parseListInput,
} from "../../lib/job-finder-utils";
import {
  ProfileAutoGrowTextarea,
  ProfileInput,
  profileSelectTriggerClassName,
} from "./profile-form-primitives";
import type { ProfileFieldArrayKeyName } from "./profile-field-array-types";
import { ProfileOptionalSection } from "./profile-optional-section";
import { ProfileListEditor } from "./profile-list-editor";
import { ProfileRecordCard } from "./profile-record-card";
import { ProfileSectionHeader } from "./profile-section-header";
import { useProfileAppendedRecordOpenSignal } from "./use-profile-appended-record-open-signal";

/**
 * Employment type is a short fixed list. An unrecognised stored value (an
 * older import, or a value typed before this became a select) is preserved as
 * its own option instead of being silently dropped.
 */
const EMPLOYMENT_TYPE_VALUES = [
  "Full-time",
  "Part-time",
  "Contract",
  "Internship",
  "Temporary",
  "Freelance",
  "Self-employed",
] as const;

function buildEmploymentTypeOptions(
  currentValue: string,
): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [
    { label: "Not set", value: "" },
    ...EMPLOYMENT_TYPE_VALUES.map((value) => ({ label: value, value })),
  ];
  const trimmed = currentValue.trim();

  if (
    trimmed.length > 0 &&
    !options.some(
      (option) => option.value.toLowerCase() === trimmed.toLowerCase(),
    )
  ) {
    options.push({ label: trimmed, value: trimmed });
  }

  return options;
}

interface ProfileExperienceTabProps {
  isProfileSetupPending?: boolean;
  experienceArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "records.experiences",
    ProfileFieldArrayKeyName
  >;
  focusRecordOpenSignal?: string | null;
  focusRecordId?: string | null;
  profileForm: UseFormReturn<ProfileEditorValues>;
  // Guided setup offers an honest continue path from an empty history; the
  // full Profile editor omits it and keeps the section-local actions only.
  // Explicitly accepts undefined so callers may pass a conditional value
  // under exactOptionalPropertyTypes.
  onContinueWithoutWorkHistory?: (() => void) | undefined;
}

const RECORD_MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2021-03" reads as "Mar 2021" on a card; anything else stays as typed. */
export function formatRecordMonth(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const match = value.trim().match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (!match) {
    return value.trim();
  }
  const month = RECORD_MONTH_NAMES[Number.parseInt(match[2] ?? "", 10) - 1];
  return month ? `${month} ${match[1]}` : value.trim();
}

export function ProfileExperienceTab({
  isProfileSetupPending = false,
  experienceArray,
  focusRecordId = null,
  focusRecordOpenSignal = null,
  profileForm,
  onContinueWithoutWorkHistory,
}: ProfileExperienceTabProps) {
  const { control, register, setValue, watch } = profileForm;
  const hasWorkHistory = experienceArray.fields.length > 0;
  const {
    forgetAppendedRecord,
    getAppendedRecordOpenSignal,
    markAppendedRecord,
  } = useProfileAppendedRecordOpenSignal();

  function buildExperienceFieldId(recordId: string, field: string) {
    return `experience-record-${recordId}-${field}`;
  }

  function handleAddExperience() {
    const recordId = `experience_${crypto.randomUUID().slice(0, 8)}`;
    experienceArray.append({
      id: recordId,
      companyName: "",
      companyUrl: "",
      title: "",
      employmentType: "",
      location: "",
      workMode: [],
      startDate: "",
      endDate: "",
      isCurrent: false,
      summary: "",
      achievements: "",
      skills: "",
      domainTags: "",
      peopleManagementScope: "",
      ownershipScope: "",
    });
    // New cards must open immediately; mount-only defaultOpen no longer opens
    // rows appended below the first one.
    markAppendedRecord(recordId);
  }

  function handleRemoveExperience(index: number) {
    forgetAppendedRecord(experienceArray.fields[index]?.id ?? "");
    experienceArray.remove(index);
  }

  function buildWorkModeFieldId(recordId: string, workMode: string) {
    return `experience-record-${recordId}-work-mode-${workMode}`;
  }

  function buildRoleSummary(index: number) {
    const title = watch(`records.experiences.${index}.title`)?.trim();
    const company = watch(`records.experiences.${index}.companyName`)?.trim();
    const location = watch(`records.experiences.${index}.location`)?.trim();
    const startDate = watch(`records.experiences.${index}.startDate`)?.trim();
    const endDate = watch(`records.experiences.${index}.endDate`)?.trim();
    const isCurrent = watch(`records.experiences.${index}.isCurrent`);
    // The card heading already shows the role title (or the company when
    // there is no title), so the subtitle must not repeat it verbatim.
    const cardTitle = title || company || `Role ${index + 1}`;
    const primaryLine =
      [title, company]
        .filter((value) => value && value !== cardTitle)
        .join(" - ") || "";
    const detailLine = [
      location,
      [
        formatRecordMonth(startDate),
        isCurrent ? "Present" : formatRecordMonth(endDate),
      ]
        .filter(Boolean)
        .join(" to "),
    ]
      .filter(Boolean)
      .join(" | ");

    if (primaryLine && detailLine) {
      // A middle dot, not a full stop: "DataHub. Remote, CA | Dec 2021 to
      // Feb 2026" read as a sentence that had ended, then carried on.
      return `${primaryLine} · ${detailLine}`;
    }

    return primaryLine || detailLine || "";
  }

  return (
    <section
      className="grid content-start gap-(--gap-card)"
      id="profile-setup-experience"
    >
      <ProfileSectionHeader
        eyebrow="Work history"
        title="Work history"
        description="One card per role. Expand a card to edit its details."
        action={
          hasWorkHistory ? (
            <Button
              disabled={isProfileSetupPending}
              pending={isProfileSetupPending}
              onClick={handleAddExperience}
              type="button"
              variant="secondary"
              className="h-11 px-4"
            >
              Add experience
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-4">
        {hasWorkHistory ? (
          experienceArray.fields.map((entry, index) => {
            const currentRole = watch(`records.experiences.${index}.isCurrent`);
            const recordTitle =
              watch(`records.experiences.${index}.title`)?.trim() ||
              watch(`records.experiences.${index}.companyName`)?.trim() ||
              `Role ${index + 1}`;

            return (
              <ProfileRecordCard
                id={`experience-record-${entry.id}`}
                key={entry.fieldKey}
                defaultOpen={
                  index === 0 || currentRole || entry.id === focusRecordId
                }
                forceOpenSignal={
                  entry.id === focusRecordId
                    ? focusRecordOpenSignal
                    : getAppendedRecordOpenSignal(entry.id)
                }
                summary={buildRoleSummary(index)}
                title={recordTitle}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                    Role details
                  </p>
                  <Button
                    aria-label={`Remove ${recordTitle}`}
                    className="text-destructive hover:text-destructive"
                    disabled={isProfileSetupPending}
                    pending={isProfileSetupPending}
                    onClick={() => handleRemoveExperience(index)}
                    size="compact"
                    type="button"
                    variant="outline"
                  >
                    Remove
                  </Button>
                </div>

                <div className="grid gap-(--gap-content) md:grid-cols-2">
                  <Field>
                    <FieldLabel
                      htmlFor={buildExperienceFieldId(entry.id, "company-name")}
                    >
                      Company
                    </FieldLabel>
                    <ProfileInput
                      id={buildExperienceFieldId(entry.id, "company-name")}
                      {...register(`records.experiences.${index}.companyName`)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={buildExperienceFieldId(entry.id, "company-url")}
                    >
                      Company URL (optional)
                    </FieldLabel>
                    <ProfileInput
                      id={buildExperienceFieldId(entry.id, "company-url")}
                      {...register(`records.experiences.${index}.companyUrl`)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={buildExperienceFieldId(entry.id, "title")}
                    >
                      Title
                    </FieldLabel>
                    <ProfileInput
                      id={buildExperienceFieldId(entry.id, "title")}
                      {...register(`records.experiences.${index}.title`)}
                    />
                  </Field>
                  <Controller
                    control={control}
                    name={`records.experiences.${index}.employmentType`}
                    render={({ field }) => {
                      const fieldId = buildExperienceFieldId(
                        entry.id,
                        "employment-type",
                      );
                      const currentValue = field.value ?? "";
                      return (
                        <div className="grid min-w-0 content-start gap-(--gap-field)">
                          <FieldLabel htmlFor={fieldId}>
                            Employment type
                          </FieldLabel>
                          {/* A four-value list, not free text: the old
                              placeholder was a comma list that read like the
                              value should be all four at once. */}
                          <FormSelect
                            onValueChange={field.onChange}
                            options={buildEmploymentTypeOptions(currentValue)}
                            placeholder="Not set"
                            triggerClassName={profileSelectTriggerClassName}
                            triggerId={fieldId}
                            value={currentValue}
                          />
                        </div>
                      );
                    }}
                  />
                  <Field>
                    <FieldLabel
                      htmlFor={buildExperienceFieldId(entry.id, "location")}
                    >
                      Location
                    </FieldLabel>
                    <ProfileInput
                      id={buildExperienceFieldId(entry.id, "location")}
                      placeholder="City or region shown on this role"
                      {...register(`records.experiences.${index}.location`)}
                    />
                  </Field>
                  <fieldset className="grid min-w-0 gap-(--gap-field)">
                    {/* Same casing as the field labels beside it. */}
                    <legend className="text-(length:--text-field-label) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                      Work mode at this job
                    </legend>
                    {/* A preference row, not a table header: the boxed
                        checkboxes drew a rule segment above every option. */}
                    <div className="flex min-h-11 flex-wrap items-center gap-x-5 gap-y-2">
                      {workModeValues.map((workMode) => (
                        <Controller
                          key={workMode}
                          control={control}
                          name={`records.experiences.${index}.workMode`}
                          render={({ field }) => (
                            <label
                              className="flex items-center gap-2 text-(length:--text-field) text-foreground-soft"
                              htmlFor={buildWorkModeFieldId(entry.id, workMode)}
                            >
                              <Checkbox
                                checked={field.value.includes(workMode)}
                                id={buildWorkModeFieldId(entry.id, workMode)}
                                onCheckedChange={(checked) =>
                                  field.onChange(
                                    checked === true
                                      ? [...field.value, workMode]
                                      : field.value.filter(
                                          (value) => value !== workMode,
                                        ),
                                  )
                                }
                              />
                              <span>{formatStatusLabel(workMode)}</span>
                            </label>
                          )}
                        />
                      ))}
                    </div>
                  </fieldset>
                  <Controller
                    control={control}
                    name={`records.experiences.${index}.isCurrent`}
                    render={({ field }) => (
                      <CheckboxField
                        checked={field.value}
                        className="md:col-span-2"
                        inputId={buildExperienceFieldId(entry.id, "is-current")}
                        label="Current role"
                        onCheckedChange={field.onChange}
                      />
                    )}
                  />
                  <Field>
                    <FieldLabel
                      htmlFor={buildExperienceFieldId(entry.id, "start-date")}
                    >
                      Start date
                    </FieldLabel>
                    <ProfileInput
                      id={buildExperienceFieldId(entry.id, "start-date")}
                      placeholder="YYYY-MM"
                      {...register(`records.experiences.${index}.startDate`)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={buildExperienceFieldId(entry.id, "end-date")}
                    >
                      End date
                    </FieldLabel>
                    <ProfileInput
                      id={buildExperienceFieldId(entry.id, "end-date")}
                      disabled={currentRole}
                      placeholder="YYYY-MM"
                      {...register(`records.experiences.${index}.endDate`)}
                    />
                  </Field>
                  <div className="md:col-span-2">
                    <ProfileOptionalSection
                      title="Team, ownership and industries"
                      description="Add scope when it helps explain this role."
                    >
                      <Field>
                        <FieldLabel
                          htmlFor={buildExperienceFieldId(
                            entry.id,
                            "people-management-scope",
                          )}
                        >
                          Team scope (optional)
                        </FieldLabel>
                        <ProfileInput
                          id={buildExperienceFieldId(
                            entry.id,
                            "people-management-scope",
                          )}
                          {...register(
                            `records.experiences.${index}.peopleManagementScope`,
                          )}
                        />
                      </Field>
                      <Field>
                        <FieldLabel
                          htmlFor={buildExperienceFieldId(
                            entry.id,
                            "ownership-scope",
                          )}
                        >
                          Ownership or budget scope (optional)
                        </FieldLabel>
                        <ProfileInput
                          id={buildExperienceFieldId(
                            entry.id,
                            "ownership-scope",
                          )}
                          {...register(
                            `records.experiences.${index}.ownershipScope`,
                          )}
                        />
                      </Field>
                      <Field className="md:col-span-2">
                        <FieldLabel
                          htmlFor={buildExperienceFieldId(
                            entry.id,
                            "domain-tags",
                          )}
                        >
                          Industries or domains
                        </FieldLabel>
                        <ProfileAutoGrowTextarea
                          id={buildExperienceFieldId(entry.id, "domain-tags")}
                          placeholder="Example: Healthcare, Payments"
                          rows={2}
                          {...register(
                            `records.experiences.${index}.domainTags`,
                          )}
                        />
                      </Field>
                    </ProfileOptionalSection>
                  </div>
                  <Field className="md:col-span-2">
                    <FieldLabel
                      htmlFor={buildExperienceFieldId(entry.id, "summary")}
                    >
                      Role overview
                    </FieldLabel>
                    <ProfileAutoGrowTextarea
                      id={buildExperienceFieldId(entry.id, "summary")}
                      placeholder="Optional. One or two lines about the role itself; achievements go below."
                      rows={2}
                      {...register(`records.experiences.${index}.summary`)}
                    />
                  </Field>
                  <ProfileListEditor
                    className="md:col-span-2"
                    displayMode="rows"
                    emptyMessage="No achievements added yet."
                    label="Achievements"
                    onChange={(values) =>
                      setValue(
                        `records.experiences.${index}.achievements`,
                        joinListInput(values),
                      )
                    }
                    placeholder="Add one achievement"
                    values={parseListInput(
                      watch(`records.experiences.${index}.achievements`),
                    )}
                  />
                  <ProfileListEditor
                    className="md:col-span-2"
                    emptyMessage="No skills added yet."
                    label="Skills used"
                    onChange={(values) =>
                      setValue(
                        `records.experiences.${index}.skills`,
                        joinListInput(values),
                      )
                    }
                    placeholder="Add one skill"
                    values={parseListInput(
                      watch(`records.experiences.${index}.skills`),
                    )}
                  />
                </div>
              </ProfileRecordCard>
            );
          })
        ) : (
          <EmptyState
            className="min-h-0"
            description="No formal roles yet is a fine place to start. Add one now if you have it, or move on and add it whenever you are ready."
            title="No work history yet"
          >
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Button
                disabled={isProfileSetupPending}
                pending={isProfileSetupPending}
                onClick={handleAddExperience}
                type="button"
                variant="secondary"
                className="h-11 px-4"
              >
                Add experience
              </Button>
              {onContinueWithoutWorkHistory ? (
                <Button
                  disabled={isProfileSetupPending}
                  onClick={onContinueWithoutWorkHistory}
                  type="button"
                  variant="ghost"
                  className="h-11 px-4"
                >
                  Continue without adding a role
                </Button>
              ) : null}
            </div>
          </EmptyState>
        )}
      </div>
    </section>
  );
}
