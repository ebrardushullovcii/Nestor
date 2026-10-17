import {
  ArrowDownAZ,
  ChevronDown,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
} from "lucide-react";
import type { ResumeDraftSection } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { StatusBadge } from "../../components/status-badge";
import { createResumeDraftPatch } from "./resume-section-editor-helpers";

interface ResumeSectionHeaderActionsProps {
  bodyId: string;
  disabled: boolean;
  isExpanded: boolean;
  section: ResumeDraftSection;
  onPatch: (
    patch: ReturnType<typeof createResumeDraftPatch>,
    revisionReason?: string | null,
  ) => void;
  onToggleExpanded: () => void;
}

// Section actions appear once per section, not once per row, so they can
// afford their visible names: a row of bare glyphs made the section header
// unreadable while the per-bullet rows stay icon-only for density.
// Quiet, small, one line: the section list repeats this toolbar ten times, so
// each button carries a one-word visible label and the full verb in its
// accessible name and tooltip.
const sectionActionClassName = "text-foreground-soft";

export function ResumeSectionHeaderActions(
  props: ResumeSectionHeaderActionsProps,
) {
  const { bodyId, disabled, isExpanded, section, onPatch, onToggleExpanded } =
    props;
  const includeLabel = section.included ? "Hide section" : "Show section";
  const lockLabel = section.locked ? "Unlock section" : "Lock section";
  const hasEntries = section.entries.length > 0;
  const isManualOrder = section.entryOrderMode === "manual";
  const resetOrderDisabled = disabled || section.locked || !isManualOrder;

  return (
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {/* The section title is the disclosure control. A one-page resume had
            roughly ten viewports of always-open field editors below it; only
            the section being reviewed needs to be open. */}
        <h3 className="min-w-0">
          <button
            aria-controls={bodyId}
            aria-expanded={isExpanded}
            className="flex min-w-0 items-center gap-1.5 rounded-(--radius-field) font-display text-(length:--text-item) font-semibold text-(--text-headline) outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-resume-section-toggle={section.id}
            onClick={onToggleExpanded}
            type="button"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
                isExpanded ? null : "-rotate-90",
              )}
            />
            <span className="min-w-0 truncate">{section.label}</span>
          </button>
        </h3>
        {/* Only non-default states earn a chip: "Shown", "Editable", and
            "Chronology" repeat the default on every header and turned the
            section list into a wall of status noise. */}
        {section.included ? null : (
          <StatusBadge tone="muted">Hidden</StatusBadge>
        )}
        {section.locked ? <StatusBadge tone="muted">Locked</StatusBadge> : null}
        {hasEntries && isManualOrder ? (
          <StatusBadge tone="muted">Manual order</StatusBadge>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        <Button
          aria-label={includeLabel}
          className={sectionActionClassName}
          disabled={disabled || section.locked}
          onClick={() =>
            onPatch(
              createResumeDraftPatch({
                idPrefix: `resume_patch_section_include_${section.id}`,
                newIncluded: !section.included,
                operation: "toggle_include",
                sectionId: section.id,
              }),
              `${section.included ? "Hidden" : "Shown"} section`,
            )
          }
          size="xs"
          title={
            section.locked
              ? "Unlock this section before hiding it"
              : includeLabel
          }
          type="button"
          variant="ghost"
        >
          {section.included ? (
            <EyeOff className="size-3.5" />
          ) : (
            <Eye className="size-3.5" />
          )}
          {section.included ? "Hide" : "Show"}
        </Button>
        <Button
          aria-label={lockLabel}
          aria-pressed={section.locked}
          className={sectionActionClassName}
          disabled={disabled}
          onClick={() =>
            onPatch(
              createResumeDraftPatch({
                idPrefix: `resume_patch_section_lock_${section.id}`,
                newLocked: !section.locked,
                operation: "set_lock",
                sectionId: section.id,
              }),
              `${section.locked ? "Unlocked" : "Locked"} section`,
            )
          }
          size="xs"
          title={lockLabel}
          type="button"
          variant="ghost"
        >
          {section.locked ? (
            <LockOpen className="size-3.5" />
          ) : (
            <Lock className="size-3.5" />
          )}
          {section.locked ? "Unlock" : "Lock"}
        </Button>
        {/* The per-section "Rewrite" was one of three unlabelled-blast-radius
            AI entry points on this screen. Every AI action now belongs to the
            single Assistant, which states what it replaces before it runs. */}
        {/* Only offered once the order has actually been changed: a disabled
            "Reset order" on every untouched section was a dead control. */}
        {hasEntries && isManualOrder ? (
          <Button
            aria-label="Reset to chronology"
            className={sectionActionClassName}
            disabled={resetOrderDisabled}
            onClick={() => {
              if (resetOrderDisabled) {
                return;
              }

              onPatch(
                createResumeDraftPatch({
                  idPrefix: `resume_patch_section_entry_order_reset_${section.id}`,
                  operation: "reset_entry_order",
                  sectionId: section.id,
                }),
                "Reset entry order to chronology",
              );
            }}
            size="xs"
            title="Reset to chronology"
            type="button"
            variant="ghost"
          >
            <ArrowDownAZ className="size-3.5" />
            Reset order
          </Button>
        ) : null}
      </div>
    </header>
  );
}
