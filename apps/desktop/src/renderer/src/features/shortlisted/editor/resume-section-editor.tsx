import { useId, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import type {
  ResumeDraftPatch,
  ResumeDraftSection,
  WorkHistoryReviewSuggestion,
} from "@nestor/contracts";
import { getResumeSectionTextTargetId } from "@nestor/contracts";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/cn";
import { EmptyState } from "@renderer/features/job-finder/components/empty-state";
import { ResumeBulletListEditor } from "./resume-section-editor-bullet-list";
import { ResumeEntryEditorCard } from "./resume-section-editor-entry-card";
import { ResumeSectionHeaderActions } from "./resume-section-editor-header";
import {
  normalizeNullableText,
  updateSectionText,
} from "./resume-section-editor-helpers";
import { useResumeEditorSelectionFocus } from "./use-resume-editor-selection-focus";

export function ResumeSectionEditor(props: {
  section: ResumeDraftSection;
  disabled: boolean;
  isExpanded: boolean;
  isSelected: boolean;
  selectionScrollKey?: number;
  selectedEntryId: string | null;
  selectedTargetId: string | null;
  showGeneratedMarkers: boolean;
  onChange: (nextSection: ResumeDraftSection) => void;
  onSelectEntry: (sectionId: string, entryId: string) => void;
  onSelectSection: (sectionId: string) => void;
  onToggleExpanded: (sectionId: string) => void;
  onPatch: (patch: ResumeDraftPatch, revisionReason?: string | null) => void;
  skillSuggestions?: ReactNode;
  workHistoryReviewSuggestions: readonly WorkHistoryReviewSuggestion[];
}) {
  const textId = useId();
  const controlIdPrefix = useId();
  const bodyId = useId();
  const hasEntries = props.section.entries.length > 0;
  const hasSectionText = Boolean(props.section.text?.trim());
  const { entryRefs, sectionRef } = useResumeEditorSelectionFocus(
    props.selectionScrollKey === undefined
      ? {
          isSelected: props.isSelected,
          selectedEntryId: props.selectedEntryId,
          selectedTargetId: props.selectedTargetId,
        }
      : {
          isSelected: props.isSelected,
          selectionScrollKey: props.selectionScrollKey,
          selectedEntryId: props.selectedEntryId,
          selectedTargetId: props.selectedTargetId,
        },
  );
  const handleSectionFocusCapture = (event: FocusEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button")) {
      return;
    }
    if (target?.dataset.resumeEditorTarget === props.selectedTargetId) {
      return;
    }

    props.onSelectSection(props.section.id);
  };
  // Selecting a section scrolls it into place. Keep action buttons still
  // between pointer down and up, and let the disclosure own its expansion.
  const handleSectionMouseDownCapture = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement | null)?.closest("button")) {
      return;
    }

    props.onSelectSection(props.section.id);
  };

  return (
    <article
      className={cn(
        "surface-card-tint grid min-w-0 gap-2.5 rounded-(--radius-field) border border-(--surface-panel-border) p-2.5 transition-colors",
        props.isSelected && "border-primary/35 bg-primary/5",
      )}
      data-resume-editor-section={props.section.id}
      data-resume-editor-section-expanded={props.isExpanded ? "true" : "false"}
      onFocusCapture={handleSectionFocusCapture}
      onMouseDownCapture={handleSectionMouseDownCapture}
      ref={sectionRef}
      tabIndex={-1}
    >
      <ResumeSectionHeaderActions
        bodyId={bodyId}
        disabled={props.disabled}
        isExpanded={props.isExpanded}
        section={props.section}
        onPatch={props.onPatch}
        onToggleExpanded={() => props.onToggleExpanded(props.section.id)}
      />

      {props.isExpanded ? (
        <div className="grid min-w-0 gap-2.5" id={bodyId}>
          {!hasEntries || props.section.kind === "summary" ? (
            <Field>
              <FieldLabel htmlFor={textId}>Section text</FieldLabel>
              <Textarea
                className="[field-sizing:content]"
                data-resume-editor-target={getResumeSectionTextTargetId(
                  props.section.id,
                )}
                id={textId}
                disabled={props.disabled || props.section.locked}
                rows={props.section.kind === "summary" ? 3 : 4}
                value={props.section.text ?? ""}
                onChange={(event) =>
                  props.onChange(
                    updateSectionText(
                      props.section,
                      normalizeNullableText(event.currentTarget.value),
                    ),
                  )
                }
              />
            </Field>
          ) : null}

          {hasEntries ? (
            <div className="grid gap-2.5">
              {props.section.entries.map((entry, entryIndex) => (
                <ResumeEntryEditorCard
                  key={entry.id}
                  controlIdPrefix={controlIdPrefix}
                  disabled={props.disabled}
                  entry={entry}
                  entryIndex={entryIndex}
                  isSelected={props.selectedEntryId === entry.id}
                  section={props.section}
                  showGeneratedMarkers={props.showGeneratedMarkers}
                  workHistoryReviewSuggestions={props.workHistoryReviewSuggestions.filter(
                    (suggestion) =>
                      suggestion.entryId === entry.id ||
                      (suggestion.entryId === null &&
                        suggestion.profileRecordId === entry.profileRecordId),
                  )}
                  onChange={props.onChange}
                  onPatch={props.onPatch}
                  onSelectEntry={props.onSelectEntry}
                  registerEntryRef={(entryId, node) => {
                    entryRefs.current[entryId] = node;
                  }}
                />
              ))}
            </div>
          ) : null}

          {props.section.bullets.length > 0 ||
          (!hasEntries && !hasSectionText) ? (
            <div className="grid gap-2.5">
              {props.section.bullets.length === 0 ? (
                <EmptyState
                  title="No bullets yet"
                  description="Add the main detail in the field above, or ask the Assistant to draft this section."
                />
              ) : (
                <ResumeBulletListEditor
                  bulletRows={props.section.bullets}
                  controlIdPrefix={controlIdPrefix}
                  density={
                    props.section.kind === "skills" ||
                    props.section.kind === "keywords"
                      ? "compact"
                      : "comfortable"
                  }
                  disabled={props.disabled}
                  section={props.section}
                  showGeneratedMarkers={props.showGeneratedMarkers}
                  onChange={props.onChange}
                  onPatch={props.onPatch}
                />
              )}
            </div>
          ) : null}

          {props.skillSuggestions}
        </div>
      ) : null}
    </article>
  );
}
