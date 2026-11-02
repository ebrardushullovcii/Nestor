import { useId } from "react";
import { Button } from "@renderer/components/ui/button";
import type { LearnedInstructionIntelligenceSummary } from "../../lib/source-intelligence-utils";
import { ProfileIntelligenceSummaries } from "./profile-intelligence-summaries";
import { ProfileTextarea } from "./profile-form-primitives";
import {
  type LearnedInstructionSection,
  normalizeEditableInstructionInput,
} from "./profile-source-debug-instruction-utils";

interface ProfileLearnedInstructionsPanelProps {
  editingInstruction: {
    field: LearnedInstructionSection["field"];
    normalizedKey: string;
  } | null;
  editingInstructionValue: string;
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
  instructionArtifactDescription: string;
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
  intelligenceSummaries: readonly LearnedInstructionIntelligenceSummary[];
  sections: readonly LearnedInstructionSection[];
  targetId: string;
}

export function ProfileLearnedInstructionsPanel({
  editingInstruction,
  editingInstructionValue,
  isEditingInstructionPending,
  isInstructionEditPending,
  isInstructionRemovePending,
  instructionArtifactDescription,
  onBeginEditingInstruction,
  onCancelEditingInstruction,
  onChangeEditingInstructionValue,
  onPersistEditedInstruction,
  onRemoveInstructionLine,
  intelligenceSummaries,
  sections,
  targetId,
}: ProfileLearnedInstructionsPanelProps) {
  const editingTextareaId = useId();

  if (sections.length === 0 && intelligenceSummaries.length === 0) {
    return null;
  }

  return (
    <section className="surface-card-tint grid h-full min-w-0 content-start gap-(--gap-field) rounded-(--radius-field) border border-(--surface-panel-border) p-3 md:col-span-2">
      <header className="grid gap-1">
        <p className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground">
          Saved guidance
        </p>
        <p className="text-(length:--text-small) leading-6 text-foreground-soft">
          {instructionArtifactDescription}
        </p>
      </header>
      <ProfileIntelligenceSummaries
        className="grid gap-3 rounded-(--radius-small) border border-(--surface-panel-border) px-3 py-3"
        intelligenceSummaries={intelligenceSummaries}
        listClassName="grid gap-2 text-(length:--text-small) leading-6 text-foreground-soft"
        sectionClassName="grid gap-2"
        titleClassName="text-xs  tracking-(--tracking-label) text-foreground-muted"
      />
      {sections.length > 0 ? (
        <div className="grid gap-3">
          {sections.map((section) => (
            <section
              key={`${targetId}_${section.label}`}
              className="grid gap-2"
            >
              <p className="text-xs tracking-(--tracking-label) text-foreground-muted">
                {section.label}
              </p>
              <ul className="grid gap-2 text-sm leading-6 text-foreground">
                {section.lines.map((line) => {
                  const isEditing =
                    editingInstruction?.field === section.field &&
                    editingInstruction.normalizedKey === line.normalizedKey;

                  return (
                    <li
                      key={`${targetId}_${section.label}_${line.normalizedKey}`}
                      className="surface-card-tint grid gap-3 rounded-(--radius-small) border border-(--surface-panel-border) px-3 py-2"
                    >
                      {isEditing ? (
                        <div className="grid gap-2">
                          <label
                            className="sr-only"
                            htmlFor={editingTextareaId}
                          >
                            {`Edit ${section.label.toLowerCase()} instruction`}
                          </label>
                          <ProfileTextarea
                            className="min-h-[7rem]"
                            id={editingTextareaId}
                            onChange={(event) =>
                              onChangeEditingInstructionValue(
                                event.target.value,
                              )
                            }
                            rows={4}
                            value={editingInstructionValue}
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button
                              disabled={
                                normalizeEditableInstructionInput(
                                  section.field,
                                  editingInstructionValue,
                                ).length === 0
                              }
                              pending={isEditingInstructionPending}
                              onClick={onPersistEditedInstruction}
                              type="button"
                              variant="secondary"
                            >
                              Save
                            </Button>
                            <Button
                              disabled={isEditingInstructionPending}
                              onClick={onCancelEditingInstruction}
                              type="button"
                              variant="ghost"
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <span className="min-w-0 flex-1">
                            {line.displayText}
                          </span>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <Button
                              aria-label={`Edit ${section.label.toLowerCase()}: ${line.displayText}`}
                              pending={isInstructionEditPending(section, line)}
                              onClick={() =>
                                onBeginEditingInstruction(section, line)
                              }
                              type="button"
                              variant="ghost"
                            >
                              Edit
                            </Button>
                            <Button
                              aria-label={`Remove ${section.label.toLowerCase()}: ${line.displayText}`}
                              pending={isInstructionRemovePending(
                                section,
                                line,
                              )}
                              onClick={() =>
                                onRemoveInstructionLine(section, line)
                              }
                              type="button"
                              variant="ghost"
                            >
                              Remove
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}
