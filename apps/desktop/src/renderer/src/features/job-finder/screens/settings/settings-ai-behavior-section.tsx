import type { ReactNode } from "react";
import { SETTINGS_AI_JOB_SEARCH_ANCHOR_ID } from "../../lib/job-finder-route-hrefs";
import {
  AiBehaviorPreferenceSchema,
  JOB_FINDER_SETTINGS_SECTIONS,
  type AiProfileAssistantBehavior,
  type JobFinderSettings,
  type ProfileAssistantInitiative,
  type UpdateAiBehaviorInput,
} from "@nestor/contracts";
import {
  ChoiceCards,
  type ChoiceCardOption,
} from "../../components/choice-cards";
import { ToggleField } from "../../components/toggle-field";
import { useAiBehaviorSliceSave } from "./settings-ai-behavior-draft";
import { SettingsSectionSaveControl } from "./settings-section-save-control";

/**
 * How the AI talks and judges, in one place.
 *
 * Three groups follow the person's own flow: the Profile chat, finding
 * jobs, resumes. What it writes while applying lives under Applying, with
 * the send choice it belongs to, and how picky a search is is chosen per
 * search on Find jobs. Each choice here changes what the model is told
 * and how it talks; none changes what it is allowed to do. Sending an
 * application, signing in, and creating accounts stay the person's
 * (ADR 0012, ADR 0022), and every stretched resume line still needs
 * their confirmation (ADR 0018).
 *
 * A choice saves the moment it is picked, like every other Settings
 * switch, and the saved toast offers Undo. A Save button appears only to
 * retry a failed save.
 */

export const SETTINGS_AI_BEHAVIOR_LABEL =
  JOB_FINDER_SETTINGS_SECTIONS["ai-behavior"].label;

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

type AiBehaviorSlice = {
  profileAssistant: AiProfileAssistantBehavior;
  remoteCountsAsAnyLocation: boolean;
};

function seedSlice(settings: JobFinderSettings): AiBehaviorSlice {
  const behavior = AiBehaviorPreferenceSchema.parse(settings.aiBehavior ?? {});
  return {
    profileAssistant: behavior.profileAssistant,
    remoteCountsAsAnyLocation: behavior.jobSearch.remoteCountsAsAnyLocation,
  };
}

function toInput(slice: AiBehaviorSlice): UpdateAiBehaviorInput {
  return {
    aiBehavior: {
      profileAssistant: slice.profileAssistant,
      jobSearch: {
        remoteCountsAsAnyLocation: slice.remoteCountsAsAnyLocation,
      },
    },
  };
}

interface SettingsAiBehaviorSectionProps {
  onUpdateAiBehavior: (
    input: UpdateAiBehaviorInput,
    options?: { undo?: () => void },
  ) => Promise<boolean | void> | void;
  settings: JobFinderSettings;
}

export function SettingsAiBehaviorSection({
  onUpdateAiBehavior,
  settings,
}: SettingsAiBehaviorSectionProps) {
  const { draft, edit, hasUnsavedChanges, saveState, sendTypedText } =
    useAiBehaviorSliceSave({
      settings,
      seed: seedSlice,
      toInput,
      onUpdateAiBehavior,
      anchorId: "settings-ai-behavior",
      label: SETTINGS_AI_BEHAVIOR_LABEL,
      order: 1,
      saveLabel: "Save AI behavior",
      failedMessage:
        "AI behavior was not saved. Retry before leaving this page.",
      savedMessage: "AI behavior saved. It applies from the next run.",
      undoneMessage: "AI behavior change undone.",
    });
  const editAssistant = (next: Partial<AiProfileAssistantBehavior>) =>
    edit((current) => ({
      ...current,
      profileAssistant: { ...current.profileAssistant, ...next },
    }));

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
            How much the assistant suggests, and how locations count when it
            searches.
          </p>
        </div>
        <SettingsSectionSaveControl
          hasUnsavedChanges={hasUnsavedChanges}
          onSave={sendTypedText}
          saveState={saveState}
          subject="AI behavior"
          effect="Applies from your next chat, search, or resume."
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
        <ChoiceField label="Suggestions">
          <ChoiceCards
            aria-label="How much the assistant suggests"
            columns={3}
            onChange={(initiative) => editAssistant({ initiative })}
            options={initiativeOptions}
            value={draft.profileAssistant.initiative}
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
          description="How locations count when a search judges fit. How picky a search is is chosen on Find jobs, before each search."
        />
        <ToggleField
          checked={draft.remoteCountsAsAnyLocation}
          description="A remote role for your country or region counts as a match for your locations, even when the office is somewhere else."
          hint="Off means a remote posting still has to fit the places and work modes you listed."
          label="Count remote jobs as any location"
          onCheckedChange={(remoteCountsAsAnyLocation) =>
            edit((current) => ({ ...current, remoteCountsAsAnyLocation }))
          }
        />
      </article>
    </section>
  );
}
