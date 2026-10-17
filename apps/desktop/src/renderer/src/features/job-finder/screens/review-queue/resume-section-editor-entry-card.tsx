import { useEffect, useRef } from "react";
import { Lock, LockOpen, MoveDown, MoveUp } from "lucide-react";
import type {
  ResumeDraftEntry,
  ResumeDraftSection,
  WorkHistoryReviewSuggestion,
} from "@nestor/contracts";
import { getResumeEntryFieldTargetId } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Field, FieldLabel } from "@renderer/components/ui/field";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import { cn } from "@renderer/lib/cn";
import {
  createResumeDraftPatch,
  normalizeNullableText,
  updateEntryField,
  updateEntrySummary,
} from "./resume-section-editor-helpers";
import { ResumeBulletListEditor } from "./resume-section-editor-bullet-list";

interface ResumeEntryEditorCardProps {
  controlIdPrefix: string;
  disabled: boolean;
  entry: ResumeDraftEntry;
  entryIndex: number;
  isSelected: boolean;
  section: ResumeDraftSection;
  showGeneratedMarkers: boolean;
  workHistoryReviewSuggestions: readonly WorkHistoryReviewSuggestion[];
  onChange: (nextSection: ResumeDraftSection) => void;
  onPatch: (
    patch: ReturnType<typeof createResumeDraftPatch>,
    revisionReason?: string | null,
  ) => void;
  onSelectEntry: (sectionId: string, entryId: string) => void;
  registerEntryRef: (entryId: string, node: HTMLElement | null) => void;
}

export function ResumeEntryEditorCard(props: ResumeEntryEditorCardProps) {
  const {
    controlIdPrefix,
    disabled,
    entry,
    entryIndex,
    isSelected,
    section,
    showGeneratedMarkers,
    workHistoryReviewSuggestions,
    onChange,
    onPatch,
    onSelectEntry,
    registerEntryRef,
  } = props;
  const fieldDisabled = disabled || section.locked || entry.locked;
  const rowLocked = disabled || section.locked;
  const moveUpDisabled = rowLocked || entryIndex <= 0;
  const moveDownDisabled =
    rowLocked || entryIndex >= section.entries.length - 1;
  // A selected card is the one being edited, and a locked card has to keep its
  // own way back out, so both keep the secondary actions painted.
  const showSecondaryActions = isSelected || entry.locked;
  const previousEndDateByEntryIdRef = useRef(new Map<string, string | null>());
  const reviewHeading =
    section.kind === "experience"
      ? "Work-history review"
      : `${section.label} review`;
  const workHistoryHeadingId = `work_history_review_heading_${entry.id}`;
  const handleEntryFocusCapture = () => {
    onSelectEntry(section.id, entry.id);
  };

  useEffect(() => {
    const entryIds = new Set(
      section.entries.map((sectionEntry) => sectionEntry.id),
    );
    for (const entryId of previousEndDateByEntryIdRef.current.keys()) {
      if (!entryIds.has(entryId)) {
        previousEndDateByEntryIdRef.current.delete(entryId);
      }
    }
  }, [section.entries]);

  return (
    <article
      className={cn(
        "group surface-card grid gap-2.5 rounded-(--radius-field) border border-(--surface-panel-border) p-2.5 transition-colors",
        isSelected && "border-primary/35 bg-primary/5",
        // A hidden entry used to look exactly like a kept one, so Hide entry
        // and Show entry both appeared to do nothing: the only thing that
        // moved was the button's own label.
        !entry.included && "border-dashed opacity-60",
      )}
      data-resume-editor-entry={entry.id}
      data-resume-editor-entry-hidden={entry.included ? "false" : "true"}
      onFocusCapture={handleEntryFocusCapture}
      onMouseDownCapture={() => onSelectEntry(section.id, entry.id)}
      ref={(node) => {
        registerEntryRef(entry.id, node);
      }}
      tabIndex={-1}
    >
      <div className="grid min-w-0 gap-2">
        {entry.included ? null : (
          <p
            className="text-(length:--text-body) leading-6 text-foreground"
            data-resume-editor-entry-hidden-note
          >
            Hidden — this entry stays in your draft but is left off the resume.
          </p>
        )}
        <Field className="min-w-0">
          <FieldLabel htmlFor={`${controlIdPrefix}_entry_title_${entry.id}`}>
            Title
          </FieldLabel>
          <Input
            data-resume-editor-target={getResumeEntryFieldTargetId(
              section.id,
              entry.id,
              "title",
            )}
            id={`${controlIdPrefix}_entry_title_${entry.id}`}
            disabled={fieldDisabled}
            value={entry.title ?? ""}
            onChange={(event) =>
              onChange(
                updateEntryField(
                  section,
                  entry.id,
                  "title",
                  normalizeNullableText(event.currentTarget.value),
                ),
              )
            }
          />
        </Field>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            className="h-8"
            disabled={disabled || section.locked}
            onClick={() => {
              onPatch(
                createResumeDraftPatch({
                  entryId: entry.id,
                  idPrefix: `resume_patch_entry_include_${entry.id}`,
                  newIncluded: !entry.included,
                  operation: "toggle_include",
                  sectionId: section.id,
                }),
                `${entry.included ? "Hidden" : "Shown"} entry`,
              );
            }}
            aria-label={`${entry.included ? "Hide" : "Show"} ${entry.title?.trim() || "this entry"}`}
            aria-pressed={entry.included}
            type="button"
            variant="secondary"
          >
            {entry.included ? "Hide entry" : "Show entry"}
          </Button>
          {/* One primary action per entry line. Lock and the two reorder
              controls made every row four competing buttons wide, so they
              recede until this card is the one being worked on. They stay
              mounted, enabled and in the tab order at all times: hovering the
              card or moving focus into the group paints them, and a card that
              is selected or locked shows them outright, so nothing is ever
              only reachable with a mouse. */}
          <div
            className={cn(
              "flex flex-wrap items-center gap-1.5",
              !showSecondaryActions &&
                "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none",
            )}
            data-resume-editor-entry-secondary-actions
          >
            <Button
              className="h-8"
              disabled={disabled || section.locked}
              onClick={() =>
                onPatch(
                  createResumeDraftPatch({
                    entryId: entry.id,
                    idPrefix: `resume_patch_entry_lock_${entry.id}`,
                    newLocked: !entry.locked,
                    operation: "set_lock",
                    sectionId: section.id,
                  }),
                  `${entry.locked ? "Unlocked" : "Locked"} entry`,
                )
              }
              aria-pressed={entry.locked}
              type="button"
              variant="secondary"
            >
              {entry.locked ? (
                <LockOpen className="size-4" />
              ) : (
                <Lock className="size-4" />
              )}
              {entry.locked ? "Unlock" : "Lock"}
            </Button>
            <Button
              aria-label={`Move ${entry.title ?? "entry"} up`}
              className="h-8"
              disabled={moveUpDisabled}
              onClick={() => {
                const anchor =
                  entryIndex > 0 ? section.entries[entryIndex - 1] : null;
                if (!anchor) {
                  return;
                }

                onPatch(
                  createResumeDraftPatch({
                    anchorEntryId: anchor.id,
                    entryId: entry.id,
                    idPrefix: `resume_patch_entry_up_${entry.id}`,
                    operation: "move_entry",
                    position: "before",
                    sectionId: section.id,
                  }),
                  "Moved entry up",
                );
              }}
              type="button"
              variant="secondary"
            >
              <MoveUp className="size-4" />
            </Button>
            <Button
              aria-label={`Move ${entry.title ?? "entry"} down`}
              className="h-8"
              disabled={moveDownDisabled}
              onClick={() => {
                const anchor = section.entries[entryIndex + 1] ?? null;
                if (!anchor) {
                  return;
                }

                onPatch(
                  createResumeDraftPatch({
                    anchorEntryId: anchor.id,
                    entryId: entry.id,
                    idPrefix: `resume_patch_entry_down_${entry.id}`,
                    operation: "move_entry",
                    position: "after",
                    sectionId: section.id,
                  }),
                  "Moved entry down",
                );
              }}
              type="button"
              variant="secondary"
            >
              <MoveDown className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {workHistoryReviewSuggestions.length > 0 ? (
        <div
          aria-labelledby={workHistoryHeadingId}
          className="grid gap-1 border-l-2 border-(--warning-border) py-1 pl-3 text-(length:--text-body) leading-6 text-foreground"
          role="region"
        >
          <h3 className="text-foreground" id={workHistoryHeadingId}>
            {reviewHeading}
          </h3>
          <p className="text-foreground-soft">
            {[
              entry.title,
              entry.subtitle,
              [entry.startDate, entry.isCurrent ? "Present" : entry.endDate]
                .filter(Boolean)
                .join("–") || entry.dateRange,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {workHistoryReviewSuggestions.map((suggestion) => (
            <p key={suggestion.id}>
              {suggestion.kind === "date_quality" ? "Date quality: " : null}
              {suggestion.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field className="min-w-0">
          <FieldLabel htmlFor={`${controlIdPrefix}_entry_subtitle_${entry.id}`}>
            Organization or subtitle
          </FieldLabel>
          <Input
            data-resume-editor-target={getResumeEntryFieldTargetId(
              section.id,
              entry.id,
              "subtitle",
            )}
            id={`${controlIdPrefix}_entry_subtitle_${entry.id}`}
            disabled={fieldDisabled}
            value={entry.subtitle ?? ""}
            onChange={(event) =>
              onChange(
                updateEntryField(
                  section,
                  entry.id,
                  "subtitle",
                  normalizeNullableText(event.currentTarget.value),
                ),
              )
            }
          />
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor={`${controlIdPrefix}_entry_location_${entry.id}`}>
            Location
          </FieldLabel>
          <Input
            data-resume-editor-target={getResumeEntryFieldTargetId(
              section.id,
              entry.id,
              "location",
            )}
            id={`${controlIdPrefix}_entry_location_${entry.id}`}
            disabled={fieldDisabled}
            value={entry.location ?? ""}
            onChange={(event) =>
              onChange(
                updateEntryField(
                  section,
                  entry.id,
                  "location",
                  normalizeNullableText(event.currentTarget.value),
                ),
              )
            }
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
        <Field className="min-w-0">
          <FieldLabel
            htmlFor={`${controlIdPrefix}_entry_start_date_${entry.id}`}
          >
            Start date
          </FieldLabel>
          <Input
            data-resume-editor-target={getResumeEntryFieldTargetId(
              section.id,
              entry.id,
              "startDate",
            )}
            id={`${controlIdPrefix}_entry_start_date_${entry.id}`}
            disabled={fieldDisabled}
            value={entry.startDate ?? ""}
            onChange={(event) =>
              onChange(
                updateEntryField(
                  section,
                  entry.id,
                  "startDate",
                  normalizeNullableText(event.currentTarget.value),
                ),
              )
            }
          />
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor={`${controlIdPrefix}_entry_end_date_${entry.id}`}>
            End date
          </FieldLabel>
          <Input
            data-resume-editor-target={getResumeEntryFieldTargetId(
              section.id,
              entry.id,
              "endDate",
            )}
            id={`${controlIdPrefix}_entry_end_date_${entry.id}`}
            disabled={fieldDisabled || entry.isCurrent}
            value={entry.endDate ?? ""}
            onChange={(event) => {
              previousEndDateByEntryIdRef.current.delete(entry.id);
              onChange(
                updateEntryField(
                  section,
                  entry.id,
                  "endDate",
                  normalizeNullableText(event.currentTarget.value),
                ),
              );
            }}
          />
        </Field>
        <label className="flex min-h-10 min-w-0 items-center gap-2 whitespace-nowrap text-(length:--text-small) font-semibold uppercase tracking-(--tracking-caps) text-foreground-soft sm:col-span-2">
          <Checkbox
            checked={entry.isCurrent}
            data-resume-editor-target={getResumeEntryFieldTargetId(
              section.id,
              entry.id,
              "isCurrent",
            )}
            disabled={fieldDisabled}
            id={`${controlIdPrefix}_entry_current_${entry.id}`}
            onCheckedChange={(checked) => {
              const isCurrent = checked === true;
              if (isCurrent) {
                previousEndDateByEntryIdRef.current.set(
                  entry.id,
                  entry.endDate,
                );
              }
              const restoredEndDate = isCurrent
                ? null
                : (previousEndDateByEntryIdRef.current.get(entry.id) ??
                  entry.endDate);
              if (!isCurrent) {
                previousEndDateByEntryIdRef.current.delete(entry.id);
              }

              onChange(
                updateEntryField(
                  updateEntryField(section, entry.id, "isCurrent", isCurrent),
                  entry.id,
                  "endDate",
                  restoredEndDate,
                ),
              );
            }}
          />
          Current role / present
        </label>
      </div>

      <Field className="min-w-0">
        <FieldLabel htmlFor={`${controlIdPrefix}_entry_summary_${entry.id}`}>
          Entry summary
        </FieldLabel>
        <Textarea
          className="min-h-[3.9rem] [field-sizing:content]"
          data-resume-editor-target={getResumeEntryFieldTargetId(
            section.id,
            entry.id,
            "summary",
          )}
          id={`${controlIdPrefix}_entry_summary_${entry.id}`}
          disabled={fieldDisabled}
          rows={2}
          value={entry.summary ?? ""}
          onChange={(event) =>
            onChange(
              updateEntrySummary(
                section,
                entry.id,
                normalizeNullableText(event.currentTarget.value),
              ),
            )
          }
        />
      </Field>

      <div className="grid gap-2">
        <p className="text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground">
          Entry bullets
        </p>
        {/* The per-row controls stay icons so a long entry does not become a
            wall of repeated words; naming them once here means the row is
            readable without hovering each glyph. */}
        {entry.bullets.length > 0 ? (
          <p
            className="text-(length:--text-body) leading-6 text-foreground-soft"
            data-resume-entry-bullet-actions-legend
          >
            Each row: show or hide, lock, move up, move down.
          </p>
        ) : null}
        <ResumeBulletListEditor
          bulletRows={entry.bullets}
          controlIdPrefix={controlIdPrefix}
          disabled={fieldDisabled}
          entryId={entry.id}
          section={section}
          showGeneratedMarkers={showGeneratedMarkers}
          onChange={onChange}
          onPatch={onPatch}
        />
      </div>
    </article>
  );
}
