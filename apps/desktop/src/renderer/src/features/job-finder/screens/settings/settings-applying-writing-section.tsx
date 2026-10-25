import { useId } from "react";
import {
  AiBehaviorPreferenceSchema,
  CoverLetterPreferenceSchema,
  type AiApplyingBehavior,
  type ApplicationAttestationKind,
  type CoverLetterLength,
  type CoverLetterPolicy,
  type CoverLetterPreference,
  type CoverLetterTone,
  type JobFinderSettings,
  type UpdateAiBehaviorInput,
  type WrittenAnswerLength,
} from "@nestor/contracts";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import {
  ChoiceCards,
  type ChoiceCardOption,
} from "../../components/choice-cards";
import { FormSelect } from "../../components/form-select";
import { ToggleField } from "../../components/toggle-field";
import { useAiBehaviorSliceSave } from "./settings-ai-behavior-draft";
import { SettingsSectionSaveControl } from "./settings-section-save-control";

/**
 * What Job Finder writes while it fills in an application: cover letters,
 * written answers, and the declarations it may tick. It lives inside the
 * Applying section, under the send choice it belongs with; it used to be
 * a second group also titled "Applying" inside AI behavior.
 */

const coverLetterPolicyOptions: readonly ChoiceCardOption<CoverLetterPolicy>[] =
  [
    {
      id: "when_required",
      label: "Only when required",
      detail: "Writes one if the form insists.",
    },
    {
      id: "when_possible",
      label: "Whenever there is room",
      detail: "Writes one for optional fields too.",
    },
    {
      id: "never",
      label: "Never",
      detail: "Leaves letter fields for you.",
    },
  ];

const writtenAnswerLengthOptions: readonly ChoiceCardOption<WrittenAnswerLength>[] =
  [
    {
      id: "short",
      label: "Short",
      detail: "A few direct sentences.",
    },
    {
      id: "full",
      label: "Full",
      detail: "A paragraph or two with specifics.",
    },
  ];

/**
 * The declarations a form can ask the person to make, in the words the person
 * would use. The first three are the routine ones every applicant accepts and
 * are on by default; the other three say something about the person and stay
 * off until they choose (ADR 0027).
 */
const declarationChoices: ReadonlyArray<{
  kind: ApplicationAttestationKind;
  label: string;
  description: string;
}> = [
  {
    kind: "truthfulness_certification",
    label: "My answers are true",
    description: '"I certify the information I gave is accurate."',
  },
  {
    kind: "privacy_notice_acknowledgement",
    label: "Privacy notice",
    description: '"I have read the candidate privacy notice."',
  },
  {
    kind: "terms_acceptance",
    label: "Site terms",
    description: '"I agree to the terms of use."',
  },
  {
    kind: "background_check_consent",
    label: "Background check",
    description:
      "Ticks background or reference check consent on forms for you. Turn it off to be asked each time.",
  },
  {
    kind: "equal_opportunity_self_identification",
    label: "Self-identification",
    description:
      "Voluntary gender, ethnicity, veteran and disability questions, answered from your profile.",
  },
  {
    kind: "marketing_contact_consent",
    label: "Marketing contact",
    description: '"Keep me informed about other opportunities."',
  },
];

const toneOptions: ReadonlyArray<{ label: string; value: CoverLetterTone }> = [
  { label: "Plain and professional", value: "plain_professional" },
  { label: "Warm", value: "warm" },
  { label: "Direct and brief", value: "direct" },
  { label: "Formal", value: "formal" },
];

const lengthOptions: ReadonlyArray<{
  label: string;
  value: CoverLetterLength;
}> = [
  { label: "Short — about 120 words", value: "short" },
  { label: "Standard — about a page", value: "standard" },
  { label: "Detailed — a fuller page", value: "detailed" },
];

type ApplyingWritingSlice = {
  applying: AiApplyingBehavior;
  coverLetter: CoverLetterPreference;
};

function seedSlice(settings: JobFinderSettings): ApplyingWritingSlice {
  return {
    applying: AiBehaviorPreferenceSchema.parse(settings.aiBehavior ?? {})
      .applying,
    coverLetter: CoverLetterPreferenceSchema.parse(settings.coverLetter ?? {}),
  };
}

function toInput(slice: ApplyingWritingSlice): UpdateAiBehaviorInput {
  return {
    aiBehavior: { applying: slice.applying },
    coverLetter: {
      tone: slice.coverLetter.tone,
      length: slice.coverLetter.length,
      language: slice.coverLetter.language?.trim()
        ? slice.coverLetter.language.trim()
        : null,
      sample: slice.coverLetter.sample?.trim()
        ? slice.coverLetter.sample.trim()
        : null,
    },
  };
}

export function SettingsApplyingWritingSection(props: {
  onSettingsDraftEdited?: () => void;
  onUpdateAiBehavior: (
    input: UpdateAiBehaviorInput,
    options?: { undo?: () => void },
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
}) {
  const toneId = useId();
  const lengthId = useId();
  const languageId = useId();
  const sampleId = useId();
  const { draft, edit, hasUnsavedChanges, saveState, sendTypedText } =
    useAiBehaviorSliceSave({
      settings: props.settings,
      seed: seedSlice,
      toInput,
      onUpdateAiBehavior: props.onUpdateAiBehavior,
      onSettingsDraftEdited: props.onSettingsDraftEdited,
      anchorId: "settings-application-authority",
      label: "Applying",
      order: 4,
      saveLabel: "Save applying writing",
      failedMessage:
        "Applying writing was not saved. Retry before leaving this page.",
      savedMessage: "Applying writing saved. It applies from the next run.",
      undoneMessage: "Applying writing change undone.",
    });

  const editApplying = (
    next: (current: AiApplyingBehavior) => Partial<AiApplyingBehavior>,
  ) =>
    edit((current) => ({
      ...current,
      applying: { ...current.applying, ...next(current.applying) },
    }));
  const editCoverLetter = (
    next: Partial<CoverLetterPreference>,
    when: "now" | "after_typing" = "now",
  ) =>
    edit(
      (current) => ({
        ...current,
        coverLetter: { ...current.coverLetter, ...next },
      }),
      when,
    );

  const writesLetters = draft.applying.coverLetterPolicy !== "never";

  return (
    <div
      className="grid min-w-0 gap-3 border-t border-(--surface-panel-border) pt-4"
      data-testid="settings-ai-applying"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <h4 className="font-semibold text-(--text-headline)">
            What it writes
          </h4>
          <p className="max-w-[72ch] text-(length:--text-description) leading-5 text-foreground-soft">
            What Job Finder writes while it fills in an application.
          </p>
        </div>
        <SettingsSectionSaveControl
          hasUnsavedChanges={hasUnsavedChanges}
          onSave={sendTypedText}
          saveState={saveState}
          subject="applying writing"
          effect="Applies from your next application."
        />
      </div>
      <div className="grid min-w-0 gap-3 lg:grid-cols-[3fr_2fr]">
        <Field>
          <FieldLabel>Cover letters</FieldLabel>
          <ChoiceCards
            aria-label="When to write a cover letter"
            columns={3}
            onChange={(coverLetterPolicy) =>
              editApplying(() => ({ coverLetterPolicy }))
            }
            options={coverLetterPolicyOptions}
            value={draft.applying.coverLetterPolicy}
          />
        </Field>
        <Field>
          <FieldLabel>Written answers</FieldLabel>
          <ChoiceCards
            aria-label="How long written answers are"
            columns={2}
            onChange={(writtenAnswerLength) =>
              editApplying(() => ({ writtenAnswerLength }))
            }
            options={writtenAnswerLengthOptions}
            value={draft.applying.writtenAnswerLength}
          />
        </Field>
      </div>

      <Field>
        <FieldLabel>Declarations it may tick for you</FieldLabel>
        <p className="text-(length:--text-small) leading-5 text-muted-foreground">
          Any box not allowed here is left for you, and the run carries on with
          the rest of the form.
        </p>
        <div
          className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="settings-ai-declarations"
        >
          {declarationChoices.map((choice) => (
            <ToggleField
              checked={draft.applying.preApprovedDeclarations.includes(
                choice.kind,
              )}
              description={choice.description}
              key={choice.kind}
              label={choice.label}
              onCheckedChange={(checked) =>
                editApplying((applying) => ({
                  preApprovedDeclarations: checked
                    ? [
                        ...new Set([
                          ...applying.preApprovedDeclarations,
                          choice.kind,
                        ]),
                      ]
                    : applying.preApprovedDeclarations.filter(
                        (kind) => kind !== choice.kind,
                      ),
                }))
              }
            />
          ))}
        </div>
      </Field>

      {writesLetters ? (
        <div
          className="grid min-w-0 gap-3 border-t border-(--surface-panel-border) pt-3"
          data-testid="settings-ai-cover-letter-style"
        >
          <p className="max-w-[72ch] text-(length:--text-description) leading-5 text-foreground-soft">
            How a letter should read. A letter only ever says things your
            resume, your profile, and the posting already support; these change
            how it sounds, never what it claims.
          </p>
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={toneId}>How it should sound</FieldLabel>
              <FormSelect
                onValueChange={(value) =>
                  editCoverLetter({ tone: value as CoverLetterTone })
                }
                options={toneOptions}
                triggerId={toneId}
                value={draft.coverLetter.tone}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={lengthId}>How long</FieldLabel>
              <FormSelect
                onValueChange={(value) =>
                  editCoverLetter({ length: value as CoverLetterLength })
                }
                options={lengthOptions}
                triggerId={lengthId}
                value={draft.coverLetter.length}
              />
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor={languageId}>Language</FieldLabel>
            <Input
              id={languageId}
              onBlur={sendTypedText}
              onChange={(event) =>
                editCoverLetter(
                  { language: event.target.value || null },
                  "after_typing",
                )
              }
              placeholder="Leave empty to match the job posting"
              value={draft.coverLetter.language ?? ""}
            />
            <p className="text-sm leading-5 text-foreground-soft">
              Left empty, letters are written in whatever language the posting
              uses, which is usually what the employer expects.
            </p>
          </Field>
          <Field>
            <FieldLabel htmlFor={sampleId}>
              A letter of your own, as an example
            </FieldLabel>
            <Textarea
              id={sampleId}
              maxLength={8_000}
              onBlur={sendTypedText}
              onChange={(event) =>
                editCoverLetter(
                  { sample: event.target.value || null },
                  "after_typing",
                )
              }
              placeholder="Paste a letter you wrote yourself"
              rows={5}
              value={draft.coverLetter.sample ?? ""}
            />
            <p className="text-sm leading-5 text-foreground-soft">
              Optional. Job Finder copies how you sound, not what you said —
              nothing from this letter is reused as a fact about another job.
            </p>
          </Field>
        </div>
      ) : null}
    </div>
  );
}
