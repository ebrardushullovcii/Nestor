import { useId } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import type { ProfileEditorValues } from "../../lib/profile-editor";
import { joinListInput, parseListInput } from "../../lib/job-finder-utils";
import { ProfileBasicsFields, ProfileLinkField } from "./profile-basics-fields";
import { ProfileOptionalSection } from "./profile-optional-section";
import {
  ProfileFieldHint,
  ProfileInput,
  ProfileTextarea,
} from "./profile-form-primitives";
import { ProfileListEditor } from "./profile-list-editor";
import { ProfileSectionHeader } from "./profile-section-header";

interface ProfileCoreTabProps {
  profileForm: UseFormReturn<ProfileEditorValues>;
}

function buildProfileCoreFieldId(field: string) {
  return `profile-core-field-${field}`;
}

// Below the first screen: the browser skips their layout and paint until they
// come near it and keeps the real height once shown, so nothing moves.
const PROFILE_LATER_SECTION_CLASS =
  "grid content-start gap-(--gap-card) [content-visibility:auto] [contain-intrinsic-size:auto_640px]";

export function ProfileCoreTab({ profileForm }: ProfileCoreTabProps) {
  const { control, register, setValue, watch } = profileForm;
  const listFieldOptions = {
    shouldDirty: true,
    shouldTouch: true,
    shouldValidate: true,
  } as const;
  const shortSummaryHintId = useId();
  const professionalStoryHintId = useId();
  const careerThemesId = useId();
  const nextChapterSummaryId = useId();
  const leadershipSummaryId = useId();
  const careerTransitionSummaryId = useId();
  const fullSummary = useWatch({ control, name: "summary.fullSummary" }) ?? "";
  const shortSummary =
    useWatch({ control, name: "summary.shortValueProposition" }) ?? "";
  const professionalStory =
    useWatch({ control, name: "narrative.professionalStory" }) ?? "";
  const isSameSummaryText = (left: string, right: string) =>
    left.trim().replace(/\s+/g, " ").toLowerCase() ===
    right.trim().replace(/\s+/g, " ").toLowerCase();
  const shortSummaryDiffers =
    shortSummary.trim().length > 0 &&
    !isSameSummaryText(shortSummary, fullSummary);
  const professionalStoryDiffers =
    professionalStory.trim().length > 0 &&
    !isSameSummaryText(professionalStory, fullSummary);
  const hasDifferingSummaryVariants =
    shortSummaryDiffers || professionalStoryDiffers;

  return (
    <div className="grid gap-6">
      <section className="grid content-start gap-(--gap-card)">
        <ProfileSectionHeader eyebrow="Basics" title="Personal details" />

        {/* One shared field list with guided setup › Basics: same fields,
            same order, same labels. */}
        <ProfileBasicsFields
          idPrefix="profile-core-field"
          profileForm={profileForm}
        />

        <ProfileOptionalSection
          description="Keep the main profile focused on the details Job Finder uses most often. Open this only when an application needs the extras."
          title="More personal details"
        >
          <div className="grid gap-(--gap-content) md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={buildProfileCoreFieldId("middle-name")}>
                Middle name
              </FieldLabel>
              <ProfileInput
                id={buildProfileCoreFieldId("middle-name")}
                {...register("identity.middleName")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={buildProfileCoreFieldId("time-zone")}>
                Time zone
              </FieldLabel>
              <ProfileInput
                id={buildProfileCoreFieldId("time-zone")}
                {...register("identity.timeZone")}
              />
            </Field>
            <div className="md:col-span-2">
              <ProfileLinkField
                field="personalWebsiteUrl"
                id={buildProfileCoreFieldId("extra-website")}
                label="Extra website"
                profileForm={profileForm}
              />
            </div>
          </div>
        </ProfileOptionalSection>
      </section>

      <section className={PROFILE_LATER_SECTION_CLASS}>
        <ProfileSectionHeader
          eyebrow="Your story"
          title="Positioning"
          description="How you describe the way you work. Your professional summary is edited once, in Basics above."
        />

        <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
          <div className="grid gap-1">
            <p className="text-[0.98rem] font-semibold text-(--text-headline)">
              Strengths
            </p>
            {/* The rule lives in the panel that owns the field, not floating
                between the summary and the chip box where it read as a second
                sentence about the summary. */}
            <ProfileFieldHint>
              Short phrases about how you work. Resumes use these in your
              summary; named technologies belong in Skills further down.
            </ProfileFieldHint>
          </div>
          <ProfileListEditor
            label="Strengths"
            onChange={(values) =>
              setValue("summary.strengths", joinListInput(values), {
                ...listFieldOptions,
                shouldValidate: false,
              })
            }
            placeholder="Add a strength"
            values={parseListInput(watch("summary.strengths"))}
          />
        </article>

        {/* One summary field owns the resume text. Older variants are never
            deleted silently: they stay retrievable here, and only while they
            actually differ from the summary above. */}
        {hasDifferingSummaryVariants ? (
          <ProfileOptionalSection
            description="Older wordings kept from an earlier version of your profile. Nothing reads these automatically; copy anything you still want into the professional summary above."
            title="Previous versions"
          >
            <div className="grid gap-(--gap-content)">
              {shortSummaryDiffers ? (
                <Field>
                  <FieldLabel
                    htmlFor={buildProfileCoreFieldId("short-summary")}
                  >
                    Short summary
                  </FieldLabel>
                  <ProfileTextarea
                    aria-describedby={shortSummaryHintId}
                    id={buildProfileCoreFieldId("short-summary")}
                    className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                    rows={3}
                    {...register("summary.shortValueProposition")}
                  />
                  <ProfileFieldHint id={shortSummaryHintId}>
                    One or two lines, kept from an earlier profile version.
                  </ProfileFieldHint>
                </Field>
              ) : null}
              {professionalStoryDiffers ? (
                <Field>
                  <FieldLabel
                    htmlFor={buildProfileCoreFieldId("professional-story")}
                  >
                    Professional story
                  </FieldLabel>
                  <ProfileTextarea
                    aria-describedby={professionalStoryHintId}
                    id={buildProfileCoreFieldId("professional-story")}
                    className="min-h-(--textarea-default) max-h-(--textarea-default)"
                    rows={5}
                    {...register("narrative.professionalStory")}
                  />
                  <ProfileFieldHint id={professionalStoryHintId}>
                    The longer background, used for cover letters and screener
                    answers rather than the resume.
                  </ProfileFieldHint>
                </Field>
              ) : null}
            </div>
          </ProfileOptionalSection>
        ) : null}

        <ProfileOptionalSection
          description="Add the extra context that helps with targeted rewriting, without keeping the main summary path overloaded."
          title="More context for tailoring"
        >
          <div className="grid gap-(--gap-content) md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={careerThemesId}>Career themes</FieldLabel>
              <ProfileTextarea
                id={careerThemesId}
                className="min-h-(--textarea-tall) max-h-(--textarea-tall)"
                rows={4}
                {...register("summary.careerThemes")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={nextChapterSummaryId}>
                Next chapter
              </FieldLabel>
              <ProfileTextarea
                id={nextChapterSummaryId}
                className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                rows={4}
                {...register("narrative.nextChapterSummary")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={leadershipSummaryId}>
                Leadership experience
              </FieldLabel>
              <ProfileTextarea
                id={leadershipSummaryId}
                className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                rows={4}
                {...register("summary.leadershipSummary")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={careerTransitionSummaryId}>
                Career transition context
              </FieldLabel>
              <ProfileTextarea
                id={careerTransitionSummaryId}
                className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                rows={4}
                {...register("narrative.careerTransitionSummary")}
              />
            </Field>
            <Field className="md:col-span-2">
              <FieldLabel htmlFor={buildProfileCoreFieldId("industry-focus")}>
                Industry focus
              </FieldLabel>
              <ProfileTextarea
                id={buildProfileCoreFieldId("industry-focus")}
                className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                rows={4}
                {...register("summary.domainFocusSummary")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={buildProfileCoreFieldId("differentiators")}>
                Differentiators
              </FieldLabel>
              <ProfileTextarea
                id={buildProfileCoreFieldId("differentiators")}
                className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                rows={4}
                {...register("narrative.differentiators")}
              />
            </Field>
            <Field>
              <FieldLabel
                htmlFor={buildProfileCoreFieldId("motivation-themes")}
              >
                Motivation themes
              </FieldLabel>
              <ProfileTextarea
                id={buildProfileCoreFieldId("motivation-themes")}
                className="min-h-(--textarea-compact) max-h-(--textarea-compact)"
                rows={4}
                {...register("narrative.motivationThemes")}
              />
            </Field>
          </div>
        </ProfileOptionalSection>
      </section>

      <section className={PROFILE_LATER_SECTION_CLASS}>
        <ProfileSectionHeader
          eyebrow="Skills"
          title="Skills"
          description="One list of skills, kept where resumes and application forms read it."
        />

        <article className="surface-card-tint grid gap-4 rounded-(--radius-panel) border border-(--surface-panel-border) p-4">
          <p className="text-[0.98rem] font-semibold text-(--text-headline)">
            Main skills
          </p>
          <ProfileFieldHint>
            One list is enough. This is the list resumes and application forms
            read; the optional groupings below only change wording order.
          </ProfileFieldHint>
          <ProfileListEditor
            label="Main skills"
            onChange={(values) =>
              setValue("profileSkills", joinListInput(values), listFieldOptions)
            }
            placeholder="Add a skill"
            values={parseListInput(watch("profileSkills"))}
          />
        </article>

        <ProfileOptionalSection
          description="Ways to group the same skills. Nothing here adds a skill to your resume on its own; Main skills above stays the source of truth."
          title="Optional skill groupings"
        >
          <div className="grid gap-(--gap-content) md:grid-cols-2">
            <ProfileListEditor
              label="Skills to emphasize for target roles"
              onChange={(values) =>
                setValue(
                  "skillGroups.highlightedSkills",
                  joinListInput(values),
                  listFieldOptions,
                )
              }
              placeholder="Add a highlighted skill"
              values={parseListInput(watch("skillGroups.highlightedSkills"))}
            />
            <ProfileListEditor
              label="Core strengths"
              onChange={(values) =>
                setValue(
                  "skillGroups.coreSkills",
                  joinListInput(values),
                  listFieldOptions,
                )
              }
              placeholder="Add a core strength"
              values={parseListInput(watch("skillGroups.coreSkills"))}
            />
            <ProfileListEditor
              label="Tools and platforms"
              onChange={(values) =>
                setValue(
                  "skillGroups.tools",
                  joinListInput(values),
                  listFieldOptions,
                )
              }
              placeholder="Add a tool"
              values={parseListInput(watch("skillGroups.tools"))}
            />
            <ProfileListEditor
              label="Languages and frameworks"
              onChange={(values) =>
                setValue(
                  "skillGroups.languagesAndFrameworks",
                  joinListInput(values),
                  listFieldOptions,
                )
              }
              placeholder="Add a language or framework"
              values={parseListInput(
                watch("skillGroups.languagesAndFrameworks"),
              )}
            />
            <ProfileListEditor
              label="Soft skills"
              onChange={(values) =>
                setValue(
                  "skillGroups.softSkills",
                  joinListInput(values),
                  listFieldOptions,
                )
              }
              placeholder="Add a soft skill"
              values={parseListInput(watch("skillGroups.softSkills"))}
            />
          </div>
        </ProfileOptionalSection>
      </section>
    </div>
  );
}
