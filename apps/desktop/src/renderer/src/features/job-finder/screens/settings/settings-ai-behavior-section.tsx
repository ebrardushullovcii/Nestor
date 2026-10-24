import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SETTINGS_AI_JOB_SEARCH_ANCHOR_ID } from "../../lib/job-finder-route-hrefs";
import {
  AiBehaviorPreferenceSchema,
  CoverLetterPreferenceSchema,
  type AiBehaviorPreference,
  type ApplicationAttestationKind,
  type CoverLetterLength,
  type CoverLetterPolicy,
  type CoverLetterPreference,
  type CoverLetterTone,
  type JobFinderSettings,
  type JobSearchPreferences,
  type JobSearchSelectivity,
  type ProfileAssistantInitiative,
  type ProfileAssistantReplyStyle,
  type ResumeApproach,
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
import {
  RESUME_APPROACH_OPTIONS,
  STRONG_REWRITE_WARNING,
} from "../../components/profile/profile-tailoring-copy";
import { useRegisterSettingsDirtySection } from "./settings-dirty-sections";
import { SettingsSectionSaveControl } from "./settings-section-save-control";
import {
  hasOutstandingSectionChanges,
  useSettingsSectionSave,
} from "./settings-section-save";

/**
 * Every choice about how the AI behaves, in one place.
 *
 * Four groups follow the person's own flow: the Profile chat, finding jobs,
 * resumes, applying. Each choice changes what the model is told and how it
 * talks; none changes what it is allowed to do. Sending an application,
 * signing in, and creating accounts stay the person's (ADR 0012, ADR 0022),
 * and every stretched resume line still needs their confirmation (ADR 0018).
 *
 * A choice saves the moment it is picked, like every other Settings switch,
 * and the saved line offers Undo. Typed text saves when the person pauses or
 * leaves the field. A Save button appears only to retry a failed save.
 */

export const SETTINGS_AI_BEHAVIOR_LABEL = "AI behavior";

const initiativeOptions: readonly ChoiceCardOption<ProfileAssistantInitiative>[] =
  [
    {
      id: "answer_only",
      label: "Only what I ask",
      detail: "Answers the question. No extra suggestions.",
    },
    {
      id: "suggest",
      label: "Suggest a little",
      detail: "Does what you ask, plus one related idea.",
    },
    {
      id: "proactive",
      label: "Proactive",
      detail: "Also points out gaps and offers fixes.",
    },
  ];

const replyStyleOptions: readonly ChoiceCardOption<ProfileAssistantReplyStyle>[] =
  [
    {
      id: "brief",
      label: "Brief",
      detail: "One or two sentences.",
    },
    {
      id: "conversational",
      label: "Conversational",
      detail: "Explains its reasoning.",
    },
  ];

const selectivityOptions: readonly ChoiceCardOption<JobSearchSelectivity>[] = [
  {
    id: "best_matches",
    label: "Best matches only",
    detail: "Fewer jobs. Title, place, and work mode must fit.",
  },
  {
    id: "balanced",
    label: "Balanced",
    detail: "Close matches plus roles you could grow into.",
  },
  {
    id: "wide_net",
    label: "Cast a wide net",
    detail: "Everything that could fit. You narrow it later.",
  },
];

const resumeApproachOptions: readonly ChoiceCardOption<ResumeApproach>[] = [
  {
    id: "original_resume",
    label: "Original",
    detail: "Your file, unchanged.",
  },
  {
    id: "conservative",
    label: "Light",
    detail: "Small edits. Every fact kept.",
  },
  {
    id: "balanced",
    label: "Tailored",
    detail: "Fuller rewrite. Every fact kept.",
  },
  {
    id: "aggressive",
    label: "Aggressive",
    detail: "May stretch, with your say-so.",
  },
];

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

/** Typed text saves this long after the last keystroke, or on leaving the field. */
const TEXT_SAVE_DELAY_MS = 800;

type AiBehaviorDraft = {
  behavior: AiBehaviorPreference;
  coverLetter: CoverLetterPreference;
  resumeApproach: ResumeApproach;
};

function toDraft(
  settings: JobFinderSettings,
  searchPreferences: Pick<JobSearchPreferences, "tailoringMode">,
): AiBehaviorDraft {
  return {
    behavior: AiBehaviorPreferenceSchema.parse(settings.aiBehavior ?? {}),
    coverLetter: CoverLetterPreferenceSchema.parse(settings.coverLetter ?? {}),
    resumeApproach:
      settings.resumeApplicationMode === "original_resume"
        ? "original_resume"
        : searchPreferences.tailoringMode,
  };
}

function toSavedInput(draft: AiBehaviorDraft): UpdateAiBehaviorInput {
  return {
    aiBehavior: draft.behavior,
    coverLetter: {
      tone: draft.coverLetter.tone,
      length: draft.coverLetter.length,
      language: draft.coverLetter.language?.trim()
        ? draft.coverLetter.language.trim()
        : null,
      sample: draft.coverLetter.sample?.trim()
        ? draft.coverLetter.sample.trim()
        : null,
    },
    resumeApproach: draft.resumeApproach,
  };
}

function describeResumeApproach(approach: ResumeApproach): string {
  return (
    RESUME_APPROACH_OPTIONS.find((option) => option.value === approach)
      ?.description ?? ""
  );
}

// Title and one line. Each group used to carry an uppercase eyebrow that
// repeated its own title ("RESUMES" over "Resumes").
function GroupHeading(props: { title: string; description: string }) {
  return (
    <div className="grid min-w-0 gap-1">
      <h4 className="font-semibold text-(--text-headline)">{props.title}</h4>
      <p className="max-w-[72ch] text-(length:--text-description) leading-5 text-foreground-soft">
        {props.description}
      </p>
    </div>
  );
}

function ChoiceField(props: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <p className="text-(length:--text-small) font-medium text-foreground">
        {props.label}
      </p>
      {props.children}
    </div>
  );
}

interface SettingsAiBehaviorSectionProps {
  /** Reports staged edits so a stale shell save retry is retired. */
  onSettingsDraftEdited?: () => void;
  onUpdateAiBehavior: (
    input: UpdateAiBehaviorInput,
  ) => Promise<boolean | void> | void;
  searchPreferences: Pick<JobSearchPreferences, "tailoringMode">;
  settings: JobFinderSettings;
}

export function SettingsAiBehaviorSection({
  onSettingsDraftEdited,
  onUpdateAiBehavior,
  searchPreferences,
  settings,
}: SettingsAiBehaviorSectionProps) {
  const toneId = useId();
  const lengthId = useId();
  const languageId = useId();
  const sampleId = useId();
  const saved = toDraft(settings, searchPreferences);
  const savedKey = JSON.stringify(toSavedInput(saved));
  const [draft, setDraft] = useState<AiBehaviorDraft>(saved);
  const [seededKey, setSeededKey] = useState(savedKey);
  // What the last save replaced, offered as Undo beside "saved".
  const [undoDraft, setUndoDraft] = useState<AiBehaviorDraft | null>(null);
  const { resetSectionSave, runSectionSave, saveState } =
    useSettingsSectionSave();

  // Saves run one at a time; a choice made while one is in flight is sent
  // when it ends. These refs let timers and that follow-up see the newest
  // draft and the values last sent.
  const latestDraftRef = useRef(draft);
  const sentRef = useRef({ draft: saved, key: savedKey });
  const inFlightRef = useRef(false);
  const textTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onUpdateRef = useRef(onUpdateAiBehavior);
  onUpdateRef.current = onUpdateAiBehavior;

  // Reseed only when the persisted values change from outside this section
  // (the Assistant, another window). Our own save coming back changes nothing
  // on screen, and an unrelated settings refresh never throws away a choice.
  // Done during render, so mounting does not render the section twice.
  if (seededKey !== savedKey) {
    setSeededKey(savedKey);
    if (!inFlightRef.current && savedKey !== sentRef.current.key) {
      sentRef.current = { draft: saved, key: savedKey };
      latestDraftRef.current = saved;
      setDraft(saved);
      setUndoDraft(null);
    }
  }

  const isSavePending = saveState.status === "saving";
  // Only a failed save is left outstanding; everything else is on its way.
  const hasUnsavedChanges =
    saveState.status === "failed" &&
    JSON.stringify(toSavedInput(draft)) !== savedKey;

  const sendLatest = (options: { offerUndo: boolean }) => {
    if (textTimerRef.current) {
      clearTimeout(textTimerRef.current);
      textTimerRef.current = null;
    }
    if (inFlightRef.current) {
      return;
    }
    const next = latestDraftRef.current;
    const input = toSavedInput(next);
    const key = JSON.stringify(input);
    if (key === sentRef.current.key) {
      return;
    }
    const previous = sentRef.current;
    sentRef.current = { draft: next, key };
    inFlightRef.current = true;
    let committed = false;
    void runSectionSave({
      execute: async () => {
        const result = await onUpdateRef.current(input);
        committed = result !== false;
        return result;
      },
      failedMessage:
        "AI behavior was not saved. Retry before leaving this page.",
      savedMessage: options.offerUndo
        ? "AI behavior saved. It applies from the next run."
        : "AI behavior change undone.",
    }).finally(() => {
      inFlightRef.current = false;
      if (!committed) {
        // Retry sends the newest draft again.
        sentRef.current = previous;
        return;
      }
      setUndoDraft(options.offerUndo ? previous.draft : null);
      // A choice made while this save ran goes out now.
      sendLatest({ offerUndo: true });
    });
  };

  const edit = (
    update: (current: AiBehaviorDraft) => AiBehaviorDraft,
    when: "now" | "after_typing" = "now",
  ) => {
    const next = update(latestDraftRef.current);
    latestDraftRef.current = next;
    setDraft(next);
    resetSectionSave();
    onSettingsDraftEdited?.();
    if (when === "now") {
      sendLatest({ offerUndo: true });
      return;
    }
    if (textTimerRef.current) clearTimeout(textTimerRef.current);
    textTimerRef.current = setTimeout(
      () => sendLatest({ offerUndo: true }),
      TEXT_SAVE_DELAY_MS,
    );
  };
  const editBehavior = <Group extends keyof AiBehaviorPreference>(
    group: Group,
    next: (
      current: AiBehaviorPreference[Group],
    ) => Partial<AiBehaviorPreference[Group]>,
  ) =>
    edit((current) => ({
      ...current,
      behavior: {
        ...current.behavior,
        [group]: {
          ...current.behavior[group],
          ...next(current.behavior[group]),
        },
      },
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
  const sendTypedText = () => sendLatest({ offerUndo: true });

  const undoLastSave = () => {
    if (!undoDraft) return;
    latestDraftRef.current = undoDraft;
    setDraft(undoDraft);
    setUndoDraft(null);
    sendLatest({ offerUndo: false });
  };

  // Typed text still waiting for its pause goes out when Settings closes.
  useEffect(
    () => () => {
      if (textTimerRef.current) clearTimeout(textTimerRef.current);
      if (inFlightRef.current) return;
      const input = toSavedInput(latestDraftRef.current);
      if (JSON.stringify(input) !== sentRef.current.key) {
        void onUpdateRef.current(input);
      }
    },
    [],
  );

  useRegisterSettingsDirtySection({
    anchorId: "settings-ai-behavior",
    isDirty: hasOutstandingSectionChanges(hasUnsavedChanges, saveState),
    isSaving: isSavePending,
    label: SETTINGS_AI_BEHAVIOR_LABEL,
    onSave: sendTypedText,
    order: 1,
    saveLabel: "Save AI behavior",
  });

  const writesLetters = draft.behavior.applying.coverLetterPolicy !== "never";

  return (
    <section
      className="surface-panel-shell relative grid min-w-0 content-start gap-4 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) px-4 py-4"
      data-testid="settings-ai-behavior"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 max-w-[72ch] flex-1 gap-1">
          <h3 className="min-w-0 font-semibold text-(--text-headline)">
            {SETTINGS_AI_BEHAVIOR_LABEL}
          </h3>
          <p className="text-(length:--text-description) leading-5 text-foreground-soft">
            How it talks, how picky it is when it searches, how far it rewrites
            your resume, and what it writes when it applies.
          </p>
        </div>
        <SettingsSectionSaveControl
          hasUnsavedChanges={hasUnsavedChanges}
          onSave={sendTypedText}
          onUndo={undoDraft ? undoLastSave : undefined}
          saveState={saveState}
          subject="AI behavior"
          effect="Applies from your next chat, search, resume, or application."
        />
      </div>

      <article
        className="grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-subtle) p-3.5"
        data-testid="settings-ai-profile-assistant"
      >
        <GroupHeading
          title="Assistant"
          description="The assistant in the side chat."
        />
        {/* Two separate choices, each under its own name. Side by side they
          read as one row of five cards. */}
        <ChoiceField label="Suggestions">
          <ChoiceCards
            aria-label="How much the assistant suggests"
            columns={3}
            onChange={(initiative) =>
              editBehavior("profileAssistant", () => ({ initiative }))
            }
            options={initiativeOptions}
            value={draft.behavior.profileAssistant.initiative}
          />
        </ChoiceField>
        <ChoiceField label="Reply length">
          <ChoiceCards
            aria-label="How the profile assistant replies"
            columns={3}
            onChange={(replyStyle) =>
              editBehavior("profileAssistant", () => ({ replyStyle }))
            }
            options={replyStyleOptions}
            value={draft.behavior.profileAssistant.replyStyle}
          />
        </ChoiceField>
      </article>

      <article
        className="scroll-mt-(--settings-subnav-offset) grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-subtle) p-3.5 outline-none"
        data-testid="settings-ai-job-search"
        id={SETTINGS_AI_JOB_SEARCH_ANCHOR_ID}
        tabIndex={-1}
      >
        <GroupHeading
          title="Finding jobs"
          description="How picky a search is. Best matches only also drops any job whose title, place, or work mode misses your preferences before it is saved; the other two keep those jobs and explain the gap."
        />
        <ChoiceCards
          aria-label="How picky a search is"
          columns={3}
          onChange={(selectivity) =>
            editBehavior("jobSearch", () => ({ selectivity }))
          }
          options={selectivityOptions}
          value={draft.behavior.jobSearch.selectivity}
        />
        <ToggleField
          checked={draft.behavior.jobSearch.remoteCountsAsAnyLocation}
          description="A remote role for your country or region counts as a match for your locations, even when the office is somewhere else."
          hint="Off means a remote posting still has to fit the places and work modes you listed."
          label="Count remote jobs as any location"
          onCheckedChange={(remoteCountsAsAnyLocation) =>
            editBehavior("jobSearch", () => ({ remoteCountsAsAnyLocation }))
          }
        />
      </article>

      <article
        className="grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-subtle) p-3.5"
        data-testid="settings-ai-resumes"
      >
        <GroupHeading
          title="Resumes"
          description="How far a resume for a job may go from the one you imported. This is the default for jobs you shortlist from now on; you can still pick a level job by job on Shortlisted."
        />
        <ChoiceCards
          aria-label="Default resume approach"
          columns={4}
          onChange={(resumeApproach) =>
            edit((current) => ({ ...current, resumeApproach }))
          }
          options={resumeApproachOptions}
          value={draft.resumeApproach}
        />
        {/* Aggressive gets its fuller warning below instead; printing both
            explained the same stretch twice. */}
        {draft.resumeApproach === "aggressive" ? null : (
          <p
            className="text-(length:--text-small) leading-5 text-foreground-soft"
            data-testid="settings-ai-resume-approach-description"
          >
            {describeResumeApproach(draft.resumeApproach)}
          </p>
        )}
        {draft.resumeApproach === "aggressive" ? (
          <p className="text-sm leading-6 text-(--warning-text)" role="status">
            {STRONG_REWRITE_WARNING}
          </p>
        ) : null}
      </article>

      <article
        className="grid min-w-0 gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-overlay-subtle) p-3.5"
        data-testid="settings-ai-applying"
      >
        <GroupHeading
          title="Applying"
          description="What Job Finder writes while it fills in an application. Whether it sends the application is a separate choice, under Applying below."
        />
        <div className="grid min-w-0 gap-3 lg:grid-cols-[3fr_2fr]">
          <Field>
            <FieldLabel>Cover letters</FieldLabel>
            <ChoiceCards
              aria-label="When to write a cover letter"
              columns={3}
              onChange={(coverLetterPolicy) =>
                editBehavior("applying", () => ({ coverLetterPolicy }))
              }
              options={coverLetterPolicyOptions}
              value={draft.behavior.applying.coverLetterPolicy}
            />
          </Field>
          <Field>
            <FieldLabel>Written answers</FieldLabel>
            <ChoiceCards
              aria-label="How long written answers are"
              columns={2}
              onChange={(writtenAnswerLength) =>
                editBehavior("applying", () => ({ writtenAnswerLength }))
              }
              options={writtenAnswerLengthOptions}
              value={draft.behavior.applying.writtenAnswerLength}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel>Declarations it may tick for you</FieldLabel>
          <p className="text-(length:--text-small) leading-5 text-muted-foreground">
            Any box not allowed here is left for you, and the run carries on
            with the rest of the form.
          </p>
          <div
            className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="settings-ai-declarations"
          >
            {declarationChoices.map((choice) => (
              <ToggleField
                checked={draft.behavior.applying.preApprovedDeclarations.includes(
                  choice.kind,
                )}
                description={choice.description}
                key={choice.kind}
                label={choice.label}
                onCheckedChange={(checked) =>
                  editBehavior("applying", (applying) => ({
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
              resume, your profile, and the posting already support; these
              change how it sounds, never what it claims.
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
      </article>
    </section>
  );
}
