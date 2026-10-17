import { useId } from "react";
import { SupportingFactsField } from "./supporting-facts-field";
import { candidateAnswerKindValues } from "@nestor/contracts";
import type {
  Control,
  UseFieldArrayReturn,
  UseFormReturn,
} from "react-hook-form";
import { Controller } from "react-hook-form";
import { Button } from "@renderer/components/ui/button";
import { FieldLabel } from "@renderer/components/ui/field";
import { EmptyState } from "../empty-state";
import { FormSelect } from "../form-select";
import type { BooleanSelectValue } from "../../lib/job-finder-types";
import type { ProfileEditorValues } from "../../lib/profile-editor";
import { formatStatusLabel } from "../../lib/job-finder-utils";
import {
  ProfileInput,
  ProfileTextarea,
  profileSelectTriggerClassName,
} from "./profile-form-primitives";
import { PROFILE_WORK_CONSTRAINT_COPY } from "./profile-work-constraints-copy";
import { ProfileOptionalSection } from "./profile-optional-section";
import type { ProfileFieldArrayKeyName } from "./profile-field-array-types";
import { ProfileRecordCard } from "./profile-record-card";
import { ProfileSectionHeader } from "./profile-section-header";
import { PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES } from "./profile-deep-link-focus";
import { PreferredApplicationLinksField } from "./preferred-application-links-field";
import { useProfileAppendedRecordOpenSignal } from "./use-profile-appended-record-open-signal";

const booleanSelectOptions = [
  { label: "Not set", value: "" },
  { label: "Yes", value: "yes" },
  { label: "No", value: "no" },
];

function BooleanSelectField(props: {
  control: Control<ProfileEditorValues>;
  description?: string;
  id?: string;
  label: string;
  name:
    | "eligibility.remoteEligible"
    | "eligibility.requiresVisaSponsorship"
    | "eligibility.willingToRelocate"
    | "eligibility.willingToTravel";
}) {
  const generatedId = useId();
  const fieldId = props.id ?? generatedId;
  const descriptionId = `${fieldId}-help`;

  return (
    <Controller
      control={props.control}
      name={props.name}
      render={({ field }) => (
        <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
          <FieldLabel htmlFor={fieldId}>{props.label}</FieldLabel>
          <FormSelect
            onValueChange={(value) =>
              field.onChange(value as BooleanSelectValue)
            }
            options={booleanSelectOptions}
            placeholder="Not set"
            {...(props.description
              ? { triggerAriaDescribedBy: descriptionId }
              : {})}
            triggerClassName={profileSelectTriggerClassName}
            triggerId={fieldId}
            value={field.value}
          />
          {props.description ? (
            <p
              className="text-xs leading-5 text-foreground-muted"
              id={descriptionId}
            >
              {props.description}
            </p>
          ) : null}
        </div>
      )}
    />
  );
}

export function ProfilePreferencesEligibilitySection(props: {
  busy: boolean;
  customAnswerArray: UseFieldArrayReturn<
    ProfileEditorValues,
    "answerBank.customAnswers",
    ProfileFieldArrayKeyName
  >;
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const {
    control: profileControl,
    getValues,
    register,
    watch,
  } = props.profileForm;
  const {
    forgetAppendedRecord,
    getAppendedRecordOpenSignal,
    markAppendedRecord,
  } = useProfileAppendedRecordOpenSignal();
  const authorizedWorkCountriesId =
    "profile-setup-field-eligibility-authorized-work-countries";
  const preferredRelocationRegionsId =
    "profile-setup-field-eligibility-preferred-relocation-regions";
  const securityClearanceId = useId();
  const noticePeriodId = useId();
  const availableStartDateId =
    "profile-setup-field-eligibility-available-start-date";
  const preferredApplicationEmailId =
    "profile-setup-field-application-identity-preferred-email";
  const preferredApplicationPhoneId =
    "profile-setup-field-application-identity-preferred-phone";
  const preferredApplicationLinksId =
    "profile-setup-field-application-identity-preferred-links";
  const workAuthorizationAnswerId = useId();
  const visaSponsorshipAnswerId =
    "profile-setup-field-answer-bank-visa-sponsorship";
  const relocationAnswerId = "profile-setup-field-answer-bank-relocation";
  const travelAnswerId = useId();
  const noticePeriodAnswerId = useId();
  const availabilityAnswerId = "profile-setup-field-answer-bank-availability";
  const salaryExpectationAnswerId = "profile-expected-salary-answer";
  const salaryExpectationAnswerHelpId = `${salaryExpectationAnswerId}-help`;
  const selfIntroductionAnswerId =
    "profile-setup-field-answer-bank-self-introduction";
  const careerTransitionAnswerId =
    "profile-setup-field-answer-bank-career-transition";

  function handleAddCustomAnswer() {
    const recordId = `answer_${crypto.randomUUID().slice(0, 8)}`;
    props.customAnswerArray.append({
      id: recordId,
      label: "",
      question: "",
      answer: "",
      kind: "other",
      roleFamilies: "",
      proofEntryIds: "",
    });
    markAppendedRecord(recordId);
  }

  function handleRemoveCustomAnswer(index: number) {
    forgetAppendedRecord(props.customAnswerArray.fields[index]?.id ?? "");
    props.customAnswerArray.remove(index);
  }

  return (
    <section className="grid content-start gap-(--gap-card)">
      <ProfileSectionHeader
        eyebrow="Preferences"
        title="Work eligibility"
        description="Record only legal work-authorization facts you know. Leave unknown answers Not set; Job Finder will not guess from your resume or your preferred work mode."
      />

      <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
        <h3 className="font-semibold text-(--text-headline)">Authorization</h3>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={authorizedWorkCountriesId}>
              {PROFILE_WORK_CONSTRAINT_COPY.authorizedWorkCountries.label}
            </FieldLabel>
            <ProfileTextarea
              aria-describedby={`${authorizedWorkCountriesId}-help`}
              className="min-h-(--textarea-tall) max-h-(--textarea-tall)"
              id={authorizedWorkCountriesId}
              placeholder={
                PROFILE_WORK_CONSTRAINT_COPY.authorizedWorkCountries.placeholder
              }
              rows={4}
              {...register("eligibility.authorizedWorkCountries")}
            />
            <p
              className="text-xs leading-5 text-foreground-muted"
              id={`${authorizedWorkCountriesId}-help`}
            >
              {PROFILE_WORK_CONSTRAINT_COPY.authorizedWorkCountries.description}
            </p>
          </div>
          <BooleanSelectField
            control={profileControl}
            description={
              PROFILE_WORK_CONSTRAINT_COPY.requiresVisaSponsorship.description
            }
            id="profile-setup-field-eligibility-requires-visa-sponsorship"
            label={PROFILE_WORK_CONSTRAINT_COPY.requiresVisaSponsorship.label}
            name="eligibility.requiresVisaSponsorship"
          />
          <BooleanSelectField
            control={profileControl}
            description={
              PROFILE_WORK_CONSTRAINT_COPY.remoteEligible.description
            }
            id="profile-setup-field-eligibility-remote-eligible"
            label={PROFILE_WORK_CONSTRAINT_COPY.remoteEligible.label}
            name="eligibility.remoteEligible"
          />
        </div>
        <div className="grid gap-3">
          <h4 className="text-sm font-medium">Limited work permission</h4>
          <p className="text-xs text-foreground-muted">
            Save student or other limited permits here. Job Finder checks these
            limits against each job and leaves uncertain authorization and
            sponsorship questions for you. Reusable answers do not override
            these limits.
          </p>
          {watch("eligibility.limitedWorkPermissions").map(
            (permission, index) => (
              <div className="grid gap-3" key={index}>
                <label className="grid gap-1 text-sm">
                  Permit country
                  <ProfileInput
                    {...register(
                      `eligibility.limitedWorkPermissions.${index}.country`,
                    )}
                    placeholder="Germany"
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Permit limits
                  <ProfileTextarea
                    {...register(
                      `eligibility.limitedWorkPermissions.${index}.conditions`,
                    )}
                    placeholder="Student work permission; include hours, dates and other limits you know"
                  />
                </label>
                <Controller
                  control={profileControl}
                  name={`eligibility.limitedWorkPermissions.${index}.requiresFutureSponsorship`}
                  render={({ field }) => (
                    <label className="grid gap-1 text-sm">
                      Will you need sponsorship for future work in this country?
                      <select
                        className={profileSelectTriggerClassName}
                        {...field}
                      >
                        <option value="">Not set</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </label>
                  )}
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    props.profileForm.setValue(
                      "eligibility.limitedWorkPermissions",
                      getValues("eligibility.limitedWorkPermissions").filter(
                        (_, itemIndex) => itemIndex !== index,
                      ),
                      { shouldDirty: true },
                    )
                  }
                >
                  Remove permit
                </Button>
              </div>
            ),
          )}
          <Button
            disabled={props.busy}
            type="button"
            variant="secondary"
            onClick={() =>
              props.profileForm.setValue(
                "eligibility.limitedWorkPermissions",
                [
                  ...getValues("eligibility.limitedWorkPermissions"),
                  {
                    country: "",
                    conditions: "",
                    requiresFutureSponsorship: "",
                  },
                ],
                { shouldDirty: true },
              )
            }
          >
            Add limited permission
          </Button>
        </div>
      </article>

      <ProfileOptionalSection
        defaultOpen={Boolean(getValues("eligibility.securityClearance"))}
        description="Only keep the screening details here that actually come up in your target roles."
        title="Extra screening details"
      >
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={securityClearanceId}>
              Security clearance
            </FieldLabel>
            <ProfileInput
              id={securityClearanceId}
              {...register("eligibility.securityClearance")}
            />
          </div>
        </div>
      </ProfileOptionalSection>

      <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
        <h3 className="font-semibold text-(--text-headline)">
          Relocation and travel
        </h3>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <BooleanSelectField
            control={profileControl}
            description={
              PROFILE_WORK_CONSTRAINT_COPY.willingToRelocate.description
            }
            id="profile-setup-field-eligibility-willing-to-relocate"
            label={PROFILE_WORK_CONSTRAINT_COPY.willingToRelocate.label}
            name="eligibility.willingToRelocate"
          />
          <BooleanSelectField
            control={profileControl}
            description={
              PROFILE_WORK_CONSTRAINT_COPY.willingToTravel.description
            }
            id="profile-setup-field-eligibility-willing-to-travel"
            label={PROFILE_WORK_CONSTRAINT_COPY.willingToTravel.label}
            name="eligibility.willingToTravel"
          />
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={preferredRelocationRegionsId}>
              {PROFILE_WORK_CONSTRAINT_COPY.preferredRelocationRegions.label}
            </FieldLabel>
            <ProfileTextarea
              aria-describedby={`${preferredRelocationRegionsId}-help`}
              className="min-h-(--textarea-tall) max-h-(--textarea-tall)"
              id={preferredRelocationRegionsId}
              placeholder={
                PROFILE_WORK_CONSTRAINT_COPY.preferredRelocationRegions
                  .placeholder
              }
              rows={4}
              {...register("eligibility.preferredRelocationRegions")}
            />
            <p
              className="text-xs leading-5 text-foreground-muted"
              id={`${preferredRelocationRegionsId}-help`}
            >
              {
                PROFILE_WORK_CONSTRAINT_COPY.preferredRelocationRegions
                  .description
              }
            </p>
          </div>
        </div>
      </article>

      <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
        <h3 className="font-semibold text-(--text-headline)">Availability</h3>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={noticePeriodId}>
              Notice period (days)
            </FieldLabel>
            <ProfileInput
              id={noticePeriodId}
              min="0"
              step="1"
              type="number"
              {...register("eligibility.noticePeriodDays")}
            />
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={availableStartDateId}>
              Available start date
            </FieldLabel>
            <ProfileInput
              id={availableStartDateId}
              placeholder="Leave blank if flexible"
              {...register("eligibility.availableStartDate")}
            />
          </div>
        </div>
      </article>

      <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
        <h3 className="font-semibold text-(--text-headline)">
          Application defaults
        </h3>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={preferredApplicationEmailId}>
              Preferred application email
            </FieldLabel>
            <ProfileInput
              id={preferredApplicationEmailId}
              placeholder="Leave blank to reuse your main email"
              {...register("applicationIdentity.preferredEmail")}
            />
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={preferredApplicationPhoneId}>
              Preferred application phone
            </FieldLabel>
            <ProfileInput
              id={preferredApplicationPhoneId}
              placeholder="Leave blank to reuse your main phone"
              {...register("applicationIdentity.preferredPhone")}
            />
          </div>
          <PreferredApplicationLinksField
            fieldId={preferredApplicationLinksId}
            profileForm={props.profileForm}
          />
        </div>
      </article>

      <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
        <h3 className="font-semibold text-(--text-headline)">
          Reusable screener answers
        </h3>
        <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={workAuthorizationAnswerId}>
              Work authorization answer
            </FieldLabel>
            <ProfileTextarea
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={workAuthorizationAnswerId}
              rows={4}
              {...register("answerBank.workAuthorization")}
            />
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={visaSponsorshipAnswerId}>
              Visa sponsorship answer
            </FieldLabel>
            <ProfileTextarea
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={visaSponsorshipAnswerId}
              rows={4}
              {...register("answerBank.visaSponsorship")}
            />
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={relocationAnswerId}>
              Relocation answer
            </FieldLabel>
            <ProfileTextarea
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={relocationAnswerId}
              rows={4}
              {...register("answerBank.relocation")}
            />
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={travelAnswerId}>Travel answer</FieldLabel>
            <ProfileTextarea
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={travelAnswerId}
              rows={4}
              {...register("answerBank.travel")}
            />
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={noticePeriodAnswerId}>
              Notice period answer
            </FieldLabel>
            <ProfileTextarea
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={noticePeriodAnswerId}
              rows={4}
              {...register("answerBank.noticePeriod")}
            />
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={availabilityAnswerId}>
              Availability answer
            </FieldLabel>
            <ProfileTextarea
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={availabilityAnswerId}
              rows={4}
              {...register("answerBank.availability")}
            />
          </div>
          <div
            className={`grid min-w-0 content-start gap-(--gap-field) h-full ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.base} ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.fixedHeader} ${PROFILE_DEEP_LINK_SCROLL_MARGIN_CLASSES.internalScroller}`}
            id="profile-expected-salary-answer-field"
          >
            <FieldLabel htmlFor={salaryExpectationAnswerId}>
              Expected salary answer (applications)
            </FieldLabel>
            <ProfileTextarea
              aria-describedby={salaryExpectationAnswerHelpId}
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={salaryExpectationAnswerId}
              rows={4}
              {...register("answerBank.salaryExpectations")}
            />
            <p
              className="text-xs leading-relaxed text-foreground-muted"
              id={salaryExpectationAnswerHelpId}
            >
              Reused when an application asks what you expect. It may be higher
              than your minimum job-search floor; the app still pauses for
              review before using it.
            </p>
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
            <FieldLabel htmlFor={selfIntroductionAnswerId}>
              Short self-introduction
            </FieldLabel>
            <ProfileTextarea
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={selfIntroductionAnswerId}
              rows={4}
              {...register("answerBank.selfIntroduction")}
            />
          </div>
          <div className="grid min-w-0 content-start gap-(--gap-field) h-full md:col-span-2">
            <FieldLabel htmlFor={careerTransitionAnswerId}>
              Career transition explanation
            </FieldLabel>
            <ProfileTextarea
              className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
              id={careerTransitionAnswerId}
              rows={4}
              {...register("answerBank.careerTransition")}
            />
          </div>
        </div>
      </article>

      <ProfileOptionalSection
        defaultOpen={props.customAnswerArray.fields.length > 0}
        description="Save a few custom answers here when recurring applications ask the same question in slightly different words."
        title="Custom answer library"
      >
        <div className="grid gap-4">
          <div className="flex justify-end">
            <Button
              disabled={props.busy}
              onClick={handleAddCustomAnswer}
              type="button"
              variant="secondary"
            >
              Add custom answer
            </Button>
          </div>

          {props.customAnswerArray.fields.length > 0 ? (
            props.customAnswerArray.fields.map((entry, index) => {
              function buildAnswerFieldId(field: string) {
                return `answer-record-${entry.id}-${field}`;
              }

              return (
                <ProfileRecordCard
                  id={`answer-record-${entry.id}`}
                  statusLabel={
                    watch(`answerBank.customAnswers.${index}.needsConfirmation`)
                      ? "Needs your confirmation"
                      : undefined
                  }
                  key={entry.fieldKey}
                  defaultOpen={index === 0}
                  forceOpenSignal={getAppendedRecordOpenSignal(entry.id)}
                  summary={
                    watch(
                      `answerBank.customAnswers.${index}.applicationScope.location`,
                    )
                      ? `Application location: ${watch(`answerBank.customAnswers.${index}.applicationScope.location`)}`
                      : watch(`answerBank.customAnswers.${index}.label`) ||
                        watch(`answerBank.customAnswers.${index}.question`) ||
                        ""
                  }
                  title={
                    watch(`answerBank.customAnswers.${index}.label`)?.trim() ||
                    `Custom answer ${index + 1}`
                  }
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                      Answer details
                    </p>
                    <Button
                      disabled={props.busy}
                      onClick={() => handleRemoveCustomAnswer(index)}
                      size="compact"
                      type="button"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </div>
                  {watch(
                    `answerBank.customAnswers.${index}.needsConfirmation`,
                  ) ? (
                    <div className="grid gap-2" role="alert">
                      <p className="text-sm text-(--warning-text)">
                        Job Finder chose this earlier. Review and confirm it
                        before it can be reused as your answer.
                      </p>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() =>
                          props.profileForm.setValue(
                            `answerBank.customAnswers.${index}.needsConfirmation`,
                            false,
                            { shouldDirty: true },
                          )
                        }
                      >
                        Confirm this is my answer
                      </Button>
                    </div>
                  ) : null}
                  <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
                    <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
                      <FieldLabel htmlFor={buildAnswerFieldId("label")}>
                        Label
                      </FieldLabel>
                      <ProfileInput
                        id={buildAnswerFieldId("label")}
                        {...register(`answerBank.customAnswers.${index}.label`)}
                      />
                    </div>
                    <Controller
                      control={profileControl}
                      name={`answerBank.customAnswers.${index}.kind`}
                      render={({ field }) => (
                        <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
                          <FieldLabel htmlFor={buildAnswerFieldId("kind")}>
                            Kind
                          </FieldLabel>
                          <FormSelect
                            onValueChange={field.onChange}
                            options={candidateAnswerKindValues.map((kind) => ({
                              label: formatStatusLabel(kind),
                              value: kind,
                            }))}
                            placeholder="Select kind"
                            triggerClassName={profileSelectTriggerClassName}
                            triggerId={buildAnswerFieldId("kind")}
                            value={field.value}
                          />
                        </div>
                      )}
                    />
                    <div className="grid min-w-0 content-start gap-(--gap-field) h-full md:col-span-2">
                      <FieldLabel htmlFor={buildAnswerFieldId("question")}>
                        Question
                      </FieldLabel>
                      <ProfileTextarea
                        id={buildAnswerFieldId("question")}
                        className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                        rows={4}
                        {...register(
                          `answerBank.customAnswers.${index}.question`,
                        )}
                      />
                    </div>
                    <div className="grid min-w-0 content-start gap-(--gap-field) h-full md:col-span-2">
                      <FieldLabel htmlFor={buildAnswerFieldId("answer")}>
                        Answer
                      </FieldLabel>
                      <ProfileTextarea
                        id={buildAnswerFieldId("answer")}
                        className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                        rows={4}
                        {...register(
                          `answerBank.customAnswers.${index}.answer`,
                        )}
                      />
                    </div>
                    <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
                      <FieldLabel htmlFor={buildAnswerFieldId("role-families")}>
                        Relevant role families
                      </FieldLabel>
                      <ProfileTextarea
                        id={buildAnswerFieldId("role-families")}
                        className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                        placeholder="Comma-separated role families, e.g. frontend, fullstack"
                        rows={4}
                        {...register(
                          `answerBank.customAnswers.${index}.roleFamilies`,
                        )}
                      />
                    </div>
                    <div className="grid min-w-0 content-start gap-(--gap-field) h-full">
                      <Controller
                        control={profileControl}
                        name={`answerBank.customAnswers.${index}.proofEntryIds`}
                        render={({ field }) => (
                          <SupportingFactsField
                            facts={watch("proofBank")}
                            onChange={field.onChange}
                            value={field.value}
                          />
                        )}
                      />
                    </div>
                  </div>
                </ProfileRecordCard>
              );
            })
          ) : (
            <EmptyState
              description="No reusable custom answers yet. Add one when you notice the same screener wording repeating across applications."
              title="No custom answers saved"
            />
          )}
        </div>
      </ProfileOptionalSection>
    </section>
  );
}
