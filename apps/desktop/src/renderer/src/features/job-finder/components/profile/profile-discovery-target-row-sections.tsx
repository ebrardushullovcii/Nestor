import type { ChangeEventHandler } from "react";
import { CheckboxField } from "../checkbox-field";
import { FieldLabel } from "@renderer/components/ui/field";
import { ProfileInput, ProfileTextarea } from "./profile-form-primitives";
import type {
  LearnedInstructionIntelligenceSummary,
  LearnedInstructionField,
  LearnedInstructionSection,
} from "./profile-source-debug-instruction-utils";
import { describeLearnedInstructionUsage } from "./profile-source-debug-instruction-utils";
import { ProfileLearnedInstructionsPanel } from "./profile-learned-instructions-panel";

interface DiscoveryTargetFormFieldsProps {
  customInstructions: string;
  labelValue: string;
  instructionStatusSummary: string;
  instructionsId: string;
  labelId: string;
  onCustomInstructionsChange: ChangeEventHandler<HTMLTextAreaElement>;
  onLabelChange: ChangeEventHandler<HTMLInputElement>;
  onStartingUrlChange: ChangeEventHandler<HTMLInputElement>;
  startingUrl: string;
  startingUrlId: string;
  targetEnabled: boolean;
  onToggleEnabled: (checked: boolean) => void;
}

export function DiscoveryTargetFormFields(
  props: DiscoveryTargetFormFieldsProps,
) {
  const {
    customInstructions,
    labelValue,
    instructionStatusSummary,
    instructionsId,
    labelId,
    onCustomInstructionsChange,
    onLabelChange,
    onStartingUrlChange,
    onToggleEnabled,
    startingUrl,
    startingUrlId,
    targetEnabled,
  } = props;

  return (
    <>
      <div className="grid gap-(--gap-content) md:col-span-2 lg:grid-cols-2 lg:items-start">
        <div className="grid h-full min-w-0 content-start gap-(--gap-field)">
          <FieldLabel htmlFor={labelId}>Source name</FieldLabel>
          <ProfileInput
            id={labelId}
            onChange={onLabelChange}
            placeholder="LinkedIn or Stripe Careers"
            value={labelValue}
          />
        </div>
        <div className="grid h-full min-w-0 content-start gap-(--gap-field) lg:col-start-1">
          <FieldLabel htmlFor={startingUrlId}>Starting page URL</FieldLabel>
          <ProfileInput
            id={startingUrlId}
            onChange={onStartingUrlChange}
            placeholder="https://jobs.example.com/search"
            value={startingUrl}
          />
          <p className="text-(length:--text-small) leading-5 text-foreground-muted">
            Paste the public page that lists this company or board's open jobs.
            For example: https://job-boards.greenhouse.io/company
          </p>
        </div>
        <div className="grid h-full min-w-0 content-start gap-(--gap-field) lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <FieldLabel htmlFor={instructionsId}>Source notes</FieldLabel>
          <ProfileTextarea
            className="min-h-(--textarea-tall)"
            id={instructionsId}
            onChange={onCustomInstructionsChange}
            placeholder="Optional: add notes like 'skip contract roles' or 'focus on remote jobs'."
            rows={4}
            value={customInstructions}
          />
        </div>
        <div className="grid gap-2 lg:col-start-2">
          <CheckboxField
            checked={targetEnabled}
            label="Include this source in searches"
            onCheckedChange={onToggleEnabled}
          />
          <p
            aria-live="polite"
            aria-atomic="true"
            className="text-(length:--text-description) leading-6 text-foreground-soft"
            role="status"
          >
            <strong>{instructionStatusSummary}</strong>
          </p>
        </div>
      </div>
    </>
  );
}

interface DiscoveryTargetInstructionsProps {
  editingInstruction: {
    field: LearnedInstructionField;
    normalizedKey: string;
  } | null;
  editingInstructionValue: string;
  intelligenceSummaries: readonly LearnedInstructionIntelligenceSummary[];
  instructionArtifact: Parameters<typeof describeLearnedInstructionUsage>[0];
  isEditingInstructionPending: boolean;
  isInstructionEditPending: (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => boolean;
  isInstructionRemovePending: (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => boolean;
  isInstructionSavePending: boolean;
  onBeginEditingInstruction: (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => void;
  onCancelEditingInstruction: () => void;
  onChangeEditingInstructionValue: (value: string) => void;
  onPersistEditedInstruction: () => void;
  onRemoveInstructionLine: (
    section: LearnedInstructionSection,
    line: LearnedInstructionSection["lines"][number],
  ) => void;
  sections: readonly LearnedInstructionSection[];
  targetId: string;
}

export function DiscoveryTargetInstructions(
  props: DiscoveryTargetInstructionsProps,
) {
  return (
    <ProfileLearnedInstructionsPanel
      editingInstruction={props.editingInstruction}
      editingInstructionValue={props.editingInstructionValue}
      intelligenceSummaries={props.intelligenceSummaries}
      instructionArtifactDescription={describeLearnedInstructionUsage(
        props.instructionArtifact,
      )}
      isEditingInstructionPending={props.isEditingInstructionPending}
      isInstructionEditPending={props.isInstructionEditPending}
      isInstructionRemovePending={props.isInstructionRemovePending}
      isInstructionSavePending={props.isInstructionSavePending}
      onBeginEditingInstruction={props.onBeginEditingInstruction}
      onCancelEditingInstruction={props.onCancelEditingInstruction}
      onChangeEditingInstructionValue={props.onChangeEditingInstructionValue}
      onPersistEditedInstruction={props.onPersistEditedInstruction}
      onRemoveInstructionLine={props.onRemoveInstructionLine}
      sections={props.sections}
      targetId={props.targetId}
    />
  );
}
