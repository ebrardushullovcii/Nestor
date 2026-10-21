import { memo, type KeyboardEvent } from "react";
import {
  ProgressBar,
  SelectableRow,
  SelectableRowLine,
} from "@renderer/components/ui";
import { cn } from "@renderer/lib/cn";
import {
  jobFinderListRowBadgeSlotClassName,
  jobFinderListRowClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowMetaClassName,
  jobFinderListRowStatusClassName,
  jobFinderListRowTitleClassName,
  jobFinderListRowTitleLineClassName,
} from "../../components/list-row";
import { StatusBadge } from "../../components/status-badge";
import {
  isSelectionClick,
  LIST_SELECTION_GUTTER_CLASS,
  ListRowSelectionCell,
} from "../../components/list-selection";
import type { BadgeTone } from "../../lib/job-finder-types";

/**
 * One Shortlisted row.
 *
 * A resume run changes individual jobs, and the whole list used to re-render
 * on every one of those steps. The row takes only already-derived, comparable
 * values, so React's shallow prop check is enough to skip the rows the step
 * did not touch. Nothing here is recomputed from the queue.
 *
 * Every prop is a string, a boolean, null, or a handler the panel keeps
 * stable across renders. Adding an object or an inline function to this list
 * silently un-memoises every row, so derive it in the panel instead.
 */
export interface ReviewQueueRowProps {
  /** Whether the row's checkbox is ticked. */
  checked: boolean;
  /** Disables the checkbox while a resume batch runs. */
  selectionDisabled: boolean;
  onToggleSelection: (jobId: string, shiftKey: boolean) => void;
  employerLocationLine: string | null;
  /** The resume level the job uses, when the row can know it. */
  levelLabel: string | null;
  /** Another shortlisted job has the same title, employer and place. */
  possibleDuplicate: boolean;
  jobId: string;
  onSelect: (jobId: string) => void;
  onSelectionKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    jobId: string,
  ) => void;
  /**
   * What the badge cannot say about the resume (kept wording, a kept
   * previous resume, lines to decide), or null when it would only repeat it.
   */
  resumePolicyCaption: string | null;
  selected: boolean;
  showProgress: boolean;
  statusLabel: string;
  statusTone: BadgeTone;
  title: string;
}

const POSSIBLE_DUPLICATE_DETAIL =
  "Another shortlisted job has the same title, employer and place.";

function ReviewQueueRowComponent({
  checked,
  selectionDisabled,
  onToggleSelection,
  employerLocationLine,
  levelLabel,
  possibleDuplicate,
  jobId,
  onSelect,
  onSelectionKeyDown,
  resumePolicyCaption,
  selected,
  showProgress,
  statusLabel,
  statusTone,
  title,
}: ReviewQueueRowProps) {
  const metaParts = [employerLocationLine, levelLabel].filter(
    (part): part is string => Boolean(part),
  );
  return (
    // Selection is a tint plus an inset accent bar owned by the shared
    // primitive. The row's padding, margin and border-width are identical in
    // both states, so selecting a row can no longer resize it or move every
    // row below it.
    <div className={cn("relative min-w-0", LIST_SELECTION_GUTTER_CLASS)}>
      <ListRowSelectionCell
        checked={checked}
        disabled={selectionDisabled}
        label={`Select ${title}`}
        onToggle={({ shiftKey }) => onToggleSelection(jobId, shiftKey)}
      />
      <SelectableRow
        as="div"
        className={cn(jobFinderListRowClassName, "text-foreground")}
        selected={selected}
      >
        <button
          aria-current={selected ? "true" : undefined}
          aria-keyshortcuts="ArrowUp ArrowDown Home End"
          className={cn(
            jobFinderListRowLinesClassName,
            "w-full text-left outline-none transition-colors hover:bg-transparent focus-visible:ring-[3px] focus-visible:ring-ring/40",
          )}
          data-collection-item-id={jobId}
          onClick={(event) => {
            // Ctrl/Cmd+click ticks the row and Shift+click ticks a range,
            // without opening it.
            if (!selectionDisabled && isSelectionClick(event)) {
              event.preventDefault();
              onToggleSelection(jobId, event.shiftKey);
              return;
            }
            onSelect(jobId);
          }}
          onKeyDown={(event) => onSelectionKeyDown(event, jobId)}
          type="button"
        >
          {/* Title line, with the one badge slot trailing it - the same slot
            Find jobs and Applications use. The badge renders for every row,
            selected or not: hiding it on the selected row made that row look
            stripped of its state rather than merely selected. */}
          <div className={jobFinderListRowTitleLineClassName}>
            <strong className={jobFinderListRowTitleClassName}>{title}</strong>
            <div className={jobFinderListRowBadgeSlotClassName}>
              <SelectableRowLine className="flex justify-end">
                <StatusBadge
                  className="max-w-none shrink-0 whitespace-nowrap"
                  tone={statusTone}
                >
                  {statusLabel}
                </StatusBadge>
              </SelectableRowLine>
            </div>
          </div>
          {metaParts.length > 0 || possibleDuplicate ? (
            <span className={jobFinderListRowMetaClassName}>
              {metaParts.join(" · ")}
              {/* A quiet fact, not a warning: removing one of the two is the
                person's call and nothing is blocked meanwhile (issue #50). */}
              {possibleDuplicate ? (
                <span
                  className="text-foreground-muted"
                  data-testid="review-queue-possible-duplicate"
                  title={POSSIBLE_DUPLICATE_DETAIL}
                >
                  {metaParts.length > 0 ? " · " : ""}
                  Possible duplicate
                  <span className="sr-only">. {POSSIBLE_DUPLICATE_DETAIL}</span>
                </span>
              ) : null}
            </span>
          ) : null}
          {resumePolicyCaption ? (
            <SelectableRowLine
              className={cn(
                jobFinderListRowStatusClassName,
                "text-foreground-soft",
              )}
            >
              {resumePolicyCaption}
            </SelectableRowLine>
          ) : null}
          {showProgress ? (
            <div className="grid min-w-0 w-full gap-1.5">
              {/* Row-level progress had no real percentage behind it either; it
                only needs to say "this one is running". */}
              <ProgressBar
                ariaLabel="Resume preparation in progress"
                className="h-1.5 w-full overflow-hidden rounded-full bg-(--surface-progress-track)"
                indeterminate
              />
            </div>
          ) : null}
        </button>
      </SelectableRow>
    </div>
  );
}

export const ReviewQueueRow = memo(ReviewQueueRowComponent);
