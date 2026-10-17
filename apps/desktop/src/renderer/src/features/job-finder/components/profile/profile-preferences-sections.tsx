import { workModeValues } from "@nestor/contracts";
import { useId } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Controller } from "react-hook-form";
import { FieldLabel } from "@renderer/components/ui/field";
import { CheckboxField } from "../checkbox-field";
import { FormSelect } from "../form-select";
import type { SearchPreferencesEditorValues } from "../../lib/profile-editor";
import {
  formatStatusLabel,
  joinListInput,
  parseListInput,
} from "../../lib/job-finder-utils";
import {
  ProfileInput,
  profileSelectTriggerClassName,
} from "./profile-form-primitives";
import {
  parseProfileLocationDraft,
  ProfileListEditor,
} from "./profile-list-editor";
import { PROFILE_WORK_CONSTRAINT_COPY } from "./profile-work-constraints-copy";
import {
  PROFILE_SECTION_SCROLL_AREA_ID,
  computeProfileDeepLinkScrollTop,
  resolveProfileDeepLinkClearancePx,
  resolveProfileScrollChromeMode,
} from "./profile-deep-link-focus";
import { ProfileSectionHeader } from "./profile-section-header";

const EXPECTED_SALARY_ANSWER_FIELD_ID = "profile-expected-salary-answer";
const EXPECTED_SALARY_ANSWER_FIELD_WRAPPER_ID =
  "profile-expected-salary-answer-field";

function setElementScrollTop(element: HTMLElement, top: number) {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ behavior: "auto", left: 0, top });
    return;
  }

  element.scrollTop = top;
}

function revealExpectedSalaryAnswerField(documentRef: Document = document) {
  const answerFieldWrapper = documentRef.getElementById(
    EXPECTED_SALARY_ANSWER_FIELD_WRAPPER_ID,
  );
  const answerField = documentRef.getElementById(
    EXPECTED_SALARY_ANSWER_FIELD_ID,
  );

  if (
    !(answerFieldWrapper instanceof HTMLElement) ||
    !(answerField instanceof HTMLElement)
  ) {
    return;
  }

  const view = documentRef.defaultView;

  if (
    !view ||
    resolveProfileScrollChromeMode(view.innerWidth) !== "internal-scroller"
  ) {
    answerFieldWrapper.scrollIntoView({ behavior: "auto", block: "center" });
    answerField.focus({ preventScroll: true });
    return;
  }

  const sectionScroller = documentRef.getElementById(
    PROFILE_SECTION_SCROLL_AREA_ID,
  );

  if (!(sectionScroller instanceof HTMLElement)) {
    return;
  }

  setElementScrollTop(
    sectionScroller,
    computeProfileDeepLinkScrollTop({
      anchorViewportTopPx: sectionScroller.getBoundingClientRect().top,
      clearanceBelowAnchorPx:
        resolveProfileDeepLinkClearancePx("internal-scroller"),
      scrollerScrollTopPx: sectionScroller.scrollTop,
      targetViewportTopPx: answerFieldWrapper.getBoundingClientRect().top,
    }),
  );
  answerField.focus({ preventScroll: true });
}

export function ProfilePreferencesTargetingSection(props: {
  preferencesForm: UseFormReturn<SearchPreferencesEditorValues>;
}) {
  const { control, register, setValue, watch } = props.preferencesForm;
  const minimumSalaryId = useId();
  const targetSalaryId = useId();
  const compensationIntervalId = useId();
  const salaryCurrencyId = useId();
  const listFieldOptions = {
    shouldDirty: true,
    shouldTouch: true,
    shouldValidate: true,
  } as const;

  return (
    <section className="grid content-start gap-(--gap-card)">
      <ProfileSectionHeader
        eyebrow="Job targets"
        title="Job preferences"
        description="Use this section to specify the roles, locations, and companies to focus on."
      />

      <article
        className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4"
        id="profile-target-roles"
      >
        <h3
          className="scroll-mt-4 text-[0.98rem] font-semibold text-(--text-headline) outline-none"
          id="profile-target-roles-heading"
          tabIndex={-1}
        >
          Target roles
        </h3>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <ProfileListEditor
            inputId="profile-setup-field-search-preferences-target-roles"
            label="Target roles"
            draftParser={parseProfileLocationDraft}
            onChange={(values) =>
              setValue("targetRoles", joinListInput(values), listFieldOptions)
            }
            placeholder="Add a target role"
            values={parseListInput(watch("targetRoles"))}
          />
          <ProfileListEditor
            label="Related role areas"
            onChange={(values) =>
              setValue("jobFamilies", joinListInput(values), listFieldOptions)
            }
            placeholder="Add a related role area"
            values={parseListInput(watch("jobFamilies"))}
          />
          <ProfileListEditor
            label="Seniority levels"
            onChange={(values) =>
              setValue(
                "seniorityLevels",
                joinListInput(values),
                listFieldOptions,
              )
            }
            placeholder="Add a seniority level"
            values={parseListInput(watch("seniorityLevels"))}
          />
          {/* "Part-time is the single most important thing about my
              search" — hours were folded in among the other criteria under a
              trade name. They get their own labelled control. */}
          <ProfileListEditor
            label="Hours (full-time, part-time)"
            onChange={(values) =>
              setValue(
                "employmentTypes",
                joinListInput(values),
                listFieldOptions,
              )
            }
            placeholder="Add full-time, part-time, contract…"
            values={parseListInput(watch("employmentTypes"))}
          />
          <label className="grid gap-1 text-sm">
            Shifts
            <select
              className={profileSelectTriggerClassName}
              {...register("shiftPreference")}
            >
              <option value="any">Any shift</option>
              <option value="day">Day shifts only</option>
              <option value="night">Night shifts only</option>
            </select>
          </label>
          <div className="grid gap-2">
            <p className="text-sm font-medium">Hours per week</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm">
                Minimum weekly hours
                <ProfileInput
                  type="number"
                  min={0}
                  max={168}
                  step="any"
                  {...register("minimumWeeklyHours")}
                />
              </label>
              <label className="grid gap-1 text-sm">
                Maximum weekly hours
                <ProfileInput
                  type="number"
                  min={0}
                  max={168}
                  step="any"
                  {...register("maximumWeeklyHours")}
                />
              </label>
            </div>
            <p className="text-xs text-foreground-muted">
              Leave blank if flexible. Job assessments explain conflicts with
              your shifts or hours.
            </p>
          </div>
        </div>
      </article>

      <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
        <h3 className="font-semibold text-(--text-headline)">
          Location preferences
        </h3>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <ProfileListEditor
            draftParser={parseProfileLocationDraft}
            inputId="profile-setup-field-search-preferences-locations"
            label="Preferred locations"
            onChange={(values) =>
              setValue("locations", joinListInput(values), listFieldOptions)
            }
            placeholder="Add a preferred location"
            values={parseListInput(watch("locations"))}
          />
          <ProfileListEditor
            draftParser={parseProfileLocationDraft}
            label="Excluded locations"
            onChange={(values) =>
              setValue(
                "excludedLocations",
                joinListInput(values),
                listFieldOptions,
              )
            }
            placeholder="Add an excluded location"
            values={parseListInput(watch("excludedLocations"))}
          />
        </div>
      </article>

      <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
        <h3 className="font-semibold text-(--text-headline)">
          Company preferences
        </h3>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <ProfileListEditor
            label="Industries"
            onChange={(values) =>
              setValue(
                "targetIndustries",
                joinListInput(values),
                listFieldOptions,
              )
            }
            placeholder="Add an industry"
            values={parseListInput(watch("targetIndustries"))}
          />
          <ProfileListEditor
            label="Company stages or sizes"
            onChange={(values) =>
              setValue(
                "targetCompanyStages",
                joinListInput(values),
                listFieldOptions,
              )
            }
            placeholder="Add a company stage or size"
            values={parseListInput(watch("targetCompanyStages"))}
          />
          <ProfileListEditor
            label="Preferred companies"
            onChange={(values) =>
              setValue(
                "companyWhitelist",
                joinListInput(values),
                listFieldOptions,
              )
            }
            placeholder="Add a preferred company"
            values={parseListInput(watch("companyWhitelist"))}
          />
          <ProfileListEditor
            label="Companies to exclude"
            onChange={(values) =>
              setValue(
                "companyBlacklist",
                joinListInput(values),
                listFieldOptions,
              )
            }
            placeholder="Add a company to exclude"
            values={parseListInput(watch("companyBlacklist"))}
          />
        </div>
      </article>

      <article
        className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4 scroll-mt-4 sm:scroll-mt-[8.25rem] xl:scroll-mt-4"
        id="profile-work-modes"
      >
        <div className="grid gap-1">
          <h3
            className="scroll-mt-4 text-[0.98rem] font-semibold text-(--text-headline) outline-none sm:scroll-mt-[8.25rem] xl:scroll-mt-4"
            id="profile-work-modes-heading"
            tabIndex={-1}
          >
            Where you work and pay
          </h3>
          <p className="text-sm leading-relaxed text-foreground-muted">
            These values guide job matching. The minimum is your consideration
            floor, not the salary answer sent with an application. Save that
            separately under{" "}
            <a
              className="font-medium text-foreground underline decoration-foreground/35 underline-offset-4 hover:decoration-foreground"
              href="#profile-expected-salary-answer-field"
              onClick={(event) => {
                const isUnmodifiedPrimaryActivation =
                  event.button === 0 &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey &&
                  !event.shiftKey;

                if (!isUnmodifiedPrimaryActivation) {
                  return;
                }

                event.preventDefault();
                revealExpectedSalaryAnswerField();
              }}
            >
              Reusable screener answers
            </a>
            .
          </p>
        </div>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <fieldset
            aria-describedby="profile-work-modes-description"
            className="grid gap-(--gap-field) md:col-span-2"
            id="profile-setup-field-search-preferences-work-modes"
          >
            <legend className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground">
              {PROFILE_WORK_CONSTRAINT_COPY.workModes.label}
            </legend>
            <p
              className="text-sm leading-6 text-foreground-soft"
              id="profile-work-modes-description"
            >
              {PROFILE_WORK_CONSTRAINT_COPY.workModes.description}
            </p>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {workModeValues.map((workMode) => (
                <Controller
                  key={workMode}
                  control={control}
                  name="workModes"
                  render={({ field }) => {
                    const selectedWorkModes = field.value ?? [];
                    return (
                      <CheckboxField
                        checked={selectedWorkModes.includes(workMode)}
                        label={formatStatusLabel(workMode)}
                        onCheckedChange={(checked) =>
                          field.onChange(
                            checked
                              ? [...selectedWorkModes, workMode]
                              : selectedWorkModes.filter(
                                  (value) => value !== workMode,
                                ),
                          )
                        }
                      />
                    );
                  }}
                />
              ))}
            </div>
          </fieldset>

          {/* The resume approach (original, light, tailored, aggressive) and
              how broadly a search collects live under Settings, AI behavior,
              with every other choice about how the AI works. */}
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={minimumSalaryId}>
              Minimum worth considering
            </FieldLabel>
            <ProfileInput
              id={minimumSalaryId}
              min="0"
              step="1"
              type="number"
              {...register("minimumSalaryUsd")}
            />
            <p className="text-xs leading-relaxed text-foreground-muted">
              Used as a matching floor. Strong-fit roles can still be reviewed
              deliberately.
            </p>
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={targetSalaryId}>
              Target compensation (optional)
            </FieldLabel>
            <ProfileInput
              id={targetSalaryId}
              min="0"
              step="1"
              type="number"
              {...register("targetSalaryUsd")}
            />
            <p className="text-xs leading-relaxed text-foreground-muted">
              Your preferred target. Matching still uses the minimum as the
              floor, and higher compensation is always welcome.
            </p>
          </div>
          <label className="grid gap-1 text-sm">
            Minimum pay counts as
            <select
              className={profileSelectTriggerClassName}
              {...register("compensationBasis")}
            >
              <option value="base">Base salary</option>
              <option value="total_ote">
                Total pay including commission (OTE)
              </option>
            </select>
          </label>
          <Controller
            control={control}
            name="compensationInterval"
            render={({ field }) => (
              <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
                <FieldLabel htmlFor={compensationIntervalId}>
                  Compensation interval
                </FieldLabel>
                <FormSelect
                  onValueChange={field.onChange}
                  options={[
                    { label: "Hourly", value: "hour" },
                    { label: "Daily", value: "day" },
                    { label: "Weekly", value: "week" },
                    { label: "Monthly", value: "month" },
                    { label: "Yearly", value: "year" },
                  ]}
                  triggerClassName={profileSelectTriggerClassName}
                  triggerId={compensationIntervalId}
                  value={field.value}
                />
              </div>
            )}
          />
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={salaryCurrencyId}>
              Compensation currency
            </FieldLabel>
            <ProfileInput
              id={salaryCurrencyId}
              maxLength={3}
              placeholder="USD or EUR"
              {...register("salaryCurrency")}
            />
            {!watch("salaryCurrency").trim() &&
            (watch("minimumSalaryUsd").trim() ||
              watch("targetSalaryUsd").trim()) ? (
              <p className="text-xs leading-5 text-(--warning-text)">
                Add a three-letter currency before relying on compensation
                matching.
              </p>
            ) : null}
          </div>
        </div>
      </article>
    </section>
  );
}
