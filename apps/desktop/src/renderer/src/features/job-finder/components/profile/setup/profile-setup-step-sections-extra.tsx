import type { UseFormReturn } from "react-hook-form";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@renderer/components/ui/card";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES } from "../../../lib/job-finder-scroll-reveal";
import type { ProfileEditorValues } from "../../../lib/profile-editor";
import type { ProfileBackgroundArrays } from "../profile-field-array-types";
import {
  ProfileAutoGrowTextarea,
  ProfileInput,
  ProfileTextarea,
} from "../profile-form-primitives";
import { ProfileOptionalSection } from "../profile-optional-section";
import { ProfileRecordCard } from "../profile-record-card";
import { PreferredApplicationLinksField } from "../preferred-application-links-field";
import type { RenderFooter } from "./profile-setup-step-sections";

const PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME = Object.values(
  JOB_FINDER_REVEAL_SCROLL_MARGIN_CLASSES,
).join(" ");

function ProfileSetupStorySection(props: {
  backgroundArrays: ProfileBackgroundArrays;
  isProfileSetupPending: boolean;
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const professionalStoryId =
    "profile-setup-field-narrative-professional-story";
  const nextChapterId = "profile-setup-field-narrative-next-chapter";
  const differentiatorsId = "profile-setup-field-narrative-differentiators";
  const careerTransitionId = "profile-setup-field-narrative-career-transition";
  const motivationThemesId = "profile-setup-field-narrative-motivation-themes";

  return (
    <section aria-labelledby="profile-setup-extras-story-heading">
      <div className="grid gap-1 border-b border-border/30 pb-4">
        <h3
          className="font-semibold text-foreground"
          id="profile-setup-extras-story-heading"
        >
          Your story, in your own words
        </h3>
        <p className="text-sm leading-6 text-foreground-soft">
          Anything you write here is reused in resumes and application answers.
        </p>
      </div>
      <div className="grid gap-4 pt-4">
        <Field className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}>
          <FieldLabel htmlFor={professionalStoryId}>
            Professional story
          </FieldLabel>
          <ProfileAutoGrowTextarea
            className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}
            id={professionalStoryId}
            placeholder="Example: I solve problems, keep work organized, and help my team."
            rows={3}
            {...props.profileForm.register("narrative.professionalStory")}
          />
        </Field>
        <div className="grid gap-(--gap-content) md:grid-cols-2">
          <Field className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}>
            <FieldLabel htmlFor={nextChapterId}>
              What you&apos;re looking for next
            </FieldLabel>
            <ProfileAutoGrowTextarea
              className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}
              id={nextChapterId}
              placeholder="Example: A role where I can use my experience and keep learning."
              rows={3}
              {...props.profileForm.register("narrative.nextChapterSummary")}
            />
          </Field>
          <Field className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}>
            <FieldLabel htmlFor={differentiatorsId}>
              What sets you apart
            </FieldLabel>
            <ProfileAutoGrowTextarea
              className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}
              id={differentiatorsId}
              placeholder="Example: I communicate clearly and deliver work on time."
              rows={3}
              {...props.profileForm.register("narrative.differentiators")}
            />
          </Field>
          <Field className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}>
            <FieldLabel htmlFor={careerTransitionId}>
              If you&apos;re changing direction
            </FieldLabel>
            <ProfileAutoGrowTextarea
              className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}
              id={careerTransitionId}
              placeholder="Example: Moving into a new field after training and project work."
              rows={3}
              {...props.profileForm.register(
                "narrative.careerTransitionSummary",
              )}
            />
          </Field>
          <Field className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}>
            <FieldLabel htmlFor={motivationThemesId}>
              What motivates you
            </FieldLabel>
            <ProfileAutoGrowTextarea
              className={PROFILE_SETUP_REVEAL_SCROLL_MARGIN_CLASS_NAME}
              id={motivationThemesId}
              placeholder="Example: Useful work and a supportive team."
              rows={3}
              {...props.profileForm.register("narrative.motivationThemes")}
            />
          </Field>
        </div>

        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                Saved evidence
              </p>
              <p className="text-sm text-foreground-soft">
                Save an achievement with numbers once and reuse it everywhere.
              </p>
            </div>
            <Button
              disabled={props.isProfileSetupPending}
              onClick={() =>
                props.backgroundArrays.proofBankArray.append({
                  id: `proof_${crypto.randomUUID().slice(0, 8)}`,
                  title: "",
                  claim: "",
                  heroMetric: "",
                  supportingContext: "",
                  roleFamilies: "",
                  projectIds: "",
                  linkIds: "",
                })
              }
              type="button"
              variant="secondary"
            >
              Add evidence
            </Button>
          </div>

          {props.backgroundArrays.proofBankArray.fields.length > 0 ? (
            props.backgroundArrays.proofBankArray.fields.map((entry, index) => (
              <ProfileRecordCard
                id={`proof-record-${entry.id}`}
                key={entry.fieldKey}
                summary={
                  props.profileForm.watch(`proofBank.${index}.heroMetric`) ||
                  props.profileForm.watch(`proofBank.${index}.claim`) ||
                  props.profileForm.watch(
                    `proofBank.${index}.supportingContext`,
                  ) ||
                  "Add the claim and strongest supporting detail."
                }
                title={
                  props.profileForm.watch(`proofBank.${index}.title`)?.trim() ||
                  `Proof ${index + 1}`
                }
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <p className="text-(length:--text-field-label) font-medium uppercase tracking-[0.16em] text-foreground-muted">
                    Proof details
                  </p>
                  <Button
                    disabled={props.isProfileSetupPending}
                    onClick={() =>
                      props.backgroundArrays.proofBankArray.remove(index)
                    }
                    size="compact"
                    type="button"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                </div>
                <div className="grid gap-(--gap-content) md:grid-cols-2 md:items-start">
                  <Field>
                    <FieldLabel htmlFor={`proof-record-${entry.id}-title`}>
                      Title
                    </FieldLabel>
                    <ProfileInput
                      id={`proof-record-${entry.id}-title`}
                      {...props.profileForm.register(
                        `proofBank.${index}.title`,
                      )}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={`proof-record-${entry.id}-hero-metric`}
                    >
                      Hero metric
                    </FieldLabel>
                    <ProfileInput
                      id={`proof-record-${entry.id}-hero-metric`}
                      {...props.profileForm.register(
                        `proofBank.${index}.heroMetric`,
                      )}
                    />
                  </Field>
                  <Field className="md:col-span-2">
                    <FieldLabel htmlFor={`proof-record-${entry.id}-claim`}>
                      Claim
                    </FieldLabel>
                    <ProfileTextarea
                      id={`proof-record-${entry.id}-claim`}
                      rows={4}
                      {...props.profileForm.register(
                        `proofBank.${index}.claim`,
                      )}
                    />
                  </Field>
                  <Field className="md:col-span-2">
                    <FieldLabel
                      htmlFor={`proof-record-${entry.id}-supporting-context`}
                    >
                      Supporting context
                    </FieldLabel>
                    <ProfileTextarea
                      id={`proof-record-${entry.id}-supporting-context`}
                      rows={4}
                      {...props.profileForm.register(
                        `proofBank.${index}.supportingContext`,
                      )}
                    />
                  </Field>
                  <Field>
                    <FieldLabel
                      htmlFor={`proof-record-${entry.id}-role-families`}
                    >
                      Relevant role families
                    </FieldLabel>
                    <ProfileTextarea
                      id={`proof-record-${entry.id}-role-families`}
                      rows={4}
                      {...props.profileForm.register(
                        `proofBank.${index}.roleFamilies`,
                      )}
                    />
                  </Field>
                </div>
              </ProfileRecordCard>
            ))
          ) : (
            <p
              className="text-sm leading-6 text-foreground-muted"
              data-profile-setup-proof-bank-empty
            >
              Nothing saved yet — choose Add evidence to record an achievement
              with numbers.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function ProfileSetupApplicationLinksSection(props: {
  profileForm: UseFormReturn<ProfileEditorValues>;
}) {
  const preferredEmailId =
    "profile-setup-field-application-identity-preferred-email";
  const preferredPhoneId =
    "profile-setup-field-application-identity-preferred-phone";
  const preferredLinksId =
    "profile-setup-field-application-identity-preferred-links";
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={preferredEmailId}>
          Preferred application email
        </FieldLabel>
        <ProfileInput
          id={preferredEmailId}
          {...props.profileForm.register("applicationIdentity.preferredEmail")}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={preferredPhoneId}>
          Preferred application phone
        </FieldLabel>
        <ProfileInput
          id={preferredPhoneId}
          {...props.profileForm.register("applicationIdentity.preferredPhone")}
        />
      </Field>
      <PreferredApplicationLinksField
        fieldId={preferredLinksId}
        profileForm={props.profileForm}
      />
    </div>
  );
}

/**
 * The optional last step. "Your story" and "Screener answers" used to be two
 * separate steps a first-time user had to walk through before finishing; they
 * are one skippable step now, and setup can be finished without opening it.
 */
export function ProfileSetupExtrasStep(props: {
  backgroundArrays: ProfileBackgroundArrays;
  isProfileSetupPending: boolean;
  profileForm: UseFormReturn<ProfileEditorValues>;
  renderFooter: RenderFooter;
}) {
  return (
    <Card className="rounded-(--radius-panel) border-border/40">
      <CardHeader className="gap-2 border-b border-border/30 pb-5">
        <CardTitle>Extras — all optional</CardTitle>
        <CardDescription>
          Skip this step and nothing breaks: you can finish setup without it and
          add any of it later in Profile. Filling it in gives resumes and
          application answers your own words to work from.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 pt-6">
        <ProfileOptionalSection
          title="Your story and saved evidence"
          description="Add your own words and reusable achievements when you need them."
        >
          <ProfileSetupStorySection
            backgroundArrays={props.backgroundArrays}
            isProfileSetupPending={props.isProfileSetupPending}
            profileForm={props.profileForm}
          />
        </ProfileOptionalSection>
        <ProfileOptionalSection
          title="Application links"
          description="Choose the contact details and links applications should use."
        >
          <ProfileSetupApplicationLinksSection
            profileForm={props.profileForm}
          />
        </ProfileOptionalSection>
        {props.renderFooter()}
      </CardContent>
    </Card>
  );
}
