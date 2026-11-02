import { useFormState, useWatch, type UseFormReturn } from "react-hook-form";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import {
  getProfileEmailValidationMessage,
  getProfileLinkValidationMessage,
  type ProfileEditorValues,
} from "../../lib/profile-editor";
import {
  ProfileAutoGrowTextarea,
  ProfileFieldHint,
  ProfileInput,
} from "./profile-form-primitives";

/**
 * The one canonical Basics field list. Guided setup and Profile › Basics both
 * render it, so the same data has one field set, one order, and one set of
 * labels on both surfaces — "go back and change it" needs no re-learning.
 *
 * Deliberately absent: a separate "Displayed location" input. The location
 * shown on resumes is derived from city, region, and country, and is printed
 * back as read-only text rather than being a fourth editable field holding the
 * same address (with a postal code nobody asked for).
 */
const PROFILE_BASICS_SUMMARY_HINT =
  "This is the summary generated resumes use. Edit it here and every tailored resume starts from it.";

function formatProfileDisplayedLocation(input: {
  city: string;
  country: string;
  region: string;
}): string {
  return [input.city, input.region, input.country]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

function BasicsGroup(props: { children: React.ReactNode; title: string }) {
  return (
    <article className="grid gap-4 border-t border-(--surface-panel-border) pt-5 first:border-t-0 first:pt-0">
      <p className="text-base font-semibold text-(--text-headline)">
        {props.title}
      </p>
      {props.children}
    </article>
  );
}

export function ProfileLinkField(props: {
  field: "linkedinUrl" | "portfolioUrl" | "githubUrl" | "personalWebsiteUrl";
  id: string;
  label: string;
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const { control, register } = props.profileForm;
  const value = useWatch({ control, name: `identity.${props.field}` });
  const message = getProfileLinkValidationMessage(value, props.label);
  const errorId = `${props.id}-error`;
  return (
    <Field>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <ProfileInput
        aria-describedby={message ? errorId : undefined}
        aria-invalid={message ? true : undefined}
        id={props.id}
        inputMode="url"
        {...register(`identity.${props.field}`)}
      />
      {message ? (
        <p
          className="text-xs leading-5 text-destructive"
          id={errorId}
          role="alert"
        >
          {message}
        </p>
      ) : null}
    </Field>
  );
}

export function ProfileBasicsFields(props: {
  /** Namespaces the field ids so setup and Profile never collide. */
  idPrefix: string;
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const { control, register, setValue } = props.profileForm;
  const fieldId = (field: string) => `${props.idPrefix}-${field}`;
  const emailValue = useWatch({ control, name: "identity.email" });
  const emailValidationMessage = getProfileEmailValidationMessage(emailValue);
  const emailErrorId = `${fieldId("email")}-error`;
  const summaryHintId = `${fieldId("professional-summary")}-hint`;
  const city = useWatch({ control, name: "identity.currentCity" }) ?? "";
  const region = useWatch({ control, name: "identity.currentRegion" }) ?? "";
  const country = useWatch({ control, name: "identity.currentCountry" }) ?? "";
  const storedLocation = (
    useWatch({ control, name: "identity.currentLocation" }) ?? ""
  ).trim();
  const { dirtyFields } = useFormState({
    control,
    name: [
      "identity.currentCity",
      "identity.currentRegion",
      "identity.currentCountry",
    ],
  });
  const hasEditedLocationParts = Boolean(
    dirtyFields.identity?.currentCity ||
    dirtyFields.identity?.currentRegion ||
    dirtyFields.identity?.currentCountry,
  );
  // Mirrors `buildProfileUpdatePayload`: the stored line stays authoritative
  // until one of the parts it is built from is actually edited. Composing the
  // hint unconditionally made it contradict the record it described — an
  // imported "Cedar Park, TX 78613" was announced as "Cedar Park, TX, United
  // States" even though nothing on the page had changed and nothing would be
  // saved.
  const displayedLocation =
    !hasEditedLocationParts && storedLocation
      ? storedLocation
      : formatProfileDisplayedLocation({
          city,
          country,
          region,
        });

  return (
    <div className="grid gap-(--gap-card)">
      <BasicsGroup title="Name and headline">
        <div className="grid gap-(--gap-content) md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={fieldId("first-name")}>First name</FieldLabel>
            <ProfileInput
              id={fieldId("first-name")}
              placeholder="Your first name"
              {...register("identity.firstName")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fieldId("last-name")}>Last name</FieldLabel>
            <ProfileInput
              id={fieldId("last-name")}
              placeholder="Your last name"
              {...register("identity.lastName")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fieldId("preferred-name")}>
              Preferred full name
            </FieldLabel>
            <ProfileInput
              id={fieldId("preferred-name")}
              placeholder="Full name to use on resumes and applications"
              {...register("identity.preferredDisplayName")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fieldId("headline")}>Headline</FieldLabel>
            <ProfileInput
              id={fieldId("headline")}
              {...register("identity.headline")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fieldId("years-experience")}>
              Years of experience
            </FieldLabel>
            <ProfileInput
              id={fieldId("years-experience")}
              min="0"
              step="1"
              type="number"
              {...register("identity.yearsExperience")}
            />
          </Field>
        </div>
      </BasicsGroup>

      <BasicsGroup title="Contact">
        <div className="grid gap-(--gap-content) md:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={fieldId("email")}>Email</FieldLabel>
            <ProfileInput
              aria-describedby={
                emailValidationMessage ? emailErrorId : undefined
              }
              aria-invalid={emailValidationMessage ? true : undefined}
              id={fieldId("email")}
              inputMode="email"
              type="email"
              {...register("identity.email")}
            />
            {emailValidationMessage ? (
              <p
                className="text-xs leading-5 text-destructive"
                id={emailErrorId}
                role="alert"
              >
                {emailValidationMessage}
              </p>
            ) : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={fieldId("phone")}>Phone</FieldLabel>
            <ProfileInput
              id={fieldId("phone")}
              {...register("identity.phone")}
            />
          </Field>
        </div>
      </BasicsGroup>

      <BasicsGroup title="Location">
        <div className="grid gap-(--gap-content) md:grid-cols-3">
          <Field>
            <FieldLabel htmlFor={fieldId("city")}>City</FieldLabel>
            <ProfileInput
              id={fieldId("city")}
              {...register("identity.currentCity")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fieldId("region")}>State or region</FieldLabel>
            <ProfileInput
              id={fieldId("region")}
              {...register("identity.currentRegion")}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={fieldId("country")}>Country</FieldLabel>
            <ProfileInput
              id={fieldId("country")}
              {...register("identity.currentCountry")}
            />
          </Field>
        </div>
        <ProfileFieldHint>
          {displayedLocation
            ? `Shown on your profile and resumes as “${displayedLocation}”. Job Finder does not use it as a preferred search location unless you add it in Job targets.`
            : "Shown on your profile and resumes. Job Finder does not use it as a preferred search location unless you add it in Job targets."}
        </ProfileFieldHint>
      </BasicsGroup>

      <BasicsGroup title="Links">
        <div className="grid gap-(--gap-content) md:grid-cols-3">
          <ProfileLinkField
            field="linkedinUrl"
            id={fieldId("linkedin-url")}
            label="LinkedIn URL"
            profileForm={props.profileForm}
          />
          <ProfileLinkField
            field="portfolioUrl"
            id={fieldId("website")}
            label="Website"
            profileForm={props.profileForm}
          />
          <ProfileLinkField
            field="githubUrl"
            id={fieldId("github-url")}
            label="GitHub URL"
            profileForm={props.profileForm}
          />
        </div>
      </BasicsGroup>

      <BasicsGroup title="Summary">
        <Field>
          <FieldLabel htmlFor={fieldId("professional-summary")}>
            Professional summary
          </FieldLabel>
          {/* Sized to its own content: a fixed box clipped an eight-line
              summary mid-word behind an inner scrollbar, inside a page that
              already scrolls. */}
          <ProfileAutoGrowTextarea
            aria-describedby={summaryHintId}
            id={fieldId("professional-summary")}
            rows={4}
            {...register("summary.fullSummary", {
              // One summary, two stored fields: keep the legacy plain summary
              // in step with the professional summary so nothing downstream
              // reads a stale copy of a paragraph the user just rewrote.
              onChange: (event: { target: { value: string } }) =>
                setValue("identity.summary", event.target.value, {
                  shouldDirty: true,
                  shouldTouch: true,
                }),
            })}
          />
          <ProfileFieldHint id={summaryHintId}>
            {PROFILE_BASICS_SUMMARY_HINT}
          </ProfileFieldHint>
        </Field>
      </BasicsGroup>
    </div>
  );
}
