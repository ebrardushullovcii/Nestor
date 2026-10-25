import { useId } from "react";
import type {
  Control,
  UseFormReturn,
} from "react-hook-form";
import { Controller } from "react-hook-form";
import { Button } from "@renderer/components/ui/button";
import { ProfileOptionalSection } from "./profile-optional-section";
import { FieldLabel } from "@renderer/components/ui/field";
import { FormSelect } from "../form-select";
import type { BooleanSelectValue } from "../../lib/job-finder-types";
import type { ProfileEditorValues } from "../../lib/profile-editor";
import {
  ProfileInput,
  ProfileTextarea,
  profileSelectTriggerClassName,
} from "./profile-form-primitives";
import { PROFILE_WORK_CONSTRAINT_COPY } from "./profile-work-constraints-copy";
import { ProfileSectionHeader } from "./profile-section-header";
import { PreferredApplicationLinksField } from "./preferred-application-links-field";

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
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const { control: profileControl, register, watch, getValues } = props.profileForm;
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

    </section>
  );
}
