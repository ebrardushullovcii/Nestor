import type { MouseEvent, ReactNode } from "react";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { cn } from "@renderer/lib/cn";

/**
 * One selection model for every job list (Find jobs, Shortlisted):
 *
 * - a checkbox column on every row whose whole strip is the click target;
 * - Shift+click on a checkbox or row selects the range from the last one
 *   ticked, Ctrl/Cmd+click on a row ticks it without opening it;
 * - a page checkbox above the rows: ticked when the whole page is selected,
 *   a dash when part of it is, empty otherwise;
 * - Ctrl/Cmd+A selects the page and Escape clears the selection while the
 *   list has focus.
 *
 * The lists used to differ: Find jobs had a bare checkbox floating beside each
 * row, Shortlisted hid its checkboxes behind a "Choose jobs" mode, and neither
 * had a select-all box or ranges.
 */

/** Width of the checkbox column; rows reserve it with `pl-10`. */
export const LIST_SELECTION_GUTTER_CLASS = "pl-10";

export interface SelectionGesture {
  shiftKey: boolean;
}

/**
 * Ticks or clears every id between the anchor and the target, inclusive, in
 * the order shown. Without an anchor on the page it toggles only the target.
 */
export function applySelectionRange(
  current: ReadonlySet<string>,
  orderedIds: readonly string[],
  anchorId: string | null,
  targetId: string,
  checked: boolean,
): Set<string> {
  const next = new Set(current);
  const targetIndex = orderedIds.indexOf(targetId);
  const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
  if (targetIndex < 0) return next;
  const [from, to] =
    anchorIndex < 0
      ? [targetIndex, targetIndex]
      : [
          Math.min(anchorIndex, targetIndex),
          Math.max(anchorIndex, targetIndex),
        ];
  for (const id of orderedIds.slice(from, to + 1)) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Whether a row click is a selection gesture rather than "open this job". */
export function isSelectionClick(event: MouseEvent): boolean {
  return event.shiftKey || event.ctrlKey || event.metaKey;
}

/** The checkbox column of one row. The whole strip toggles the row. */
export function ListRowSelectionCell({
  checked,
  disabled = false,
  label,
  onToggle,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onToggle: (gesture: SelectionGesture) => void;
}) {
  return (
    <div
      className={cn(
        "absolute inset-y-0 left-0 z-10 flex w-10 items-start justify-center pt-4",
        disabled ? "cursor-not-allowed" : "cursor-pointer",
      )}
      data-list-selection-cell
      onClick={(event) => {
        // A click on the strip beside the box counts as a click on the box.
        if (disabled || event.target !== event.currentTarget) return;
        onToggle({ shiftKey: event.shiftKey });
      }}
    >
      <Checkbox
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          if (!disabled) onToggle({ shiftKey: event.shiftKey });
        }}
      />
    </div>
  );
}

/** The page checkbox on its own, for a list whose toolbar holds it. */
export function ListPageCheckbox({
  pageIds,
  selectedIds,
  onSelectPage,
  onClearPage,
  noun,
}: {
  pageIds: readonly string[];
  selectedIds: ReadonlySet<string>;
  onSelectPage: () => void;
  onClearPage: () => void;
  /** Plural noun for the rows, such as "jobs". */
  noun: string;
}) {
  const selectedOnPage = pageIds.filter((id) => selectedIds.has(id)).length;
  const state: boolean | "indeterminate" =
    pageIds.length > 0 && selectedOnPage === pageIds.length
      ? true
      : selectedOnPage > 0
        ? "indeterminate"
        : false;
  return (
    <Checkbox
      aria-label={
        state === true
          ? `Clear the ${pageIds.length} ${noun} on this page`
          : `Select the ${pageIds.length} ${noun} on this page`
      }
      checked={state}
      disabled={pageIds.length === 0}
      onCheckedChange={() => (state === true ? onClearPage() : onSelectPage())}
      title={`Select ${noun} on this page · Shift+click for a range`}
    />
  );
}

/**
 * The page checkbox above the rows, with the selection count beside it and
 * room for page-level controls on the right.
 */
export function ListPageSelectionBar({
  pageIds,
  selectedIds,
  onSelectPage,
  onClearPage,
  noun,
  children,
}: {
  pageIds: readonly string[];
  selectedIds: ReadonlySet<string>;
  onSelectPage: () => void;
  onClearPage: () => void;
  /** Plural noun for the rows, such as "jobs". */
  noun: string;
  children?: ReactNode;
}) {
  const selectedOnPage = pageIds.filter((id) => selectedIds.has(id)).length;
  const state: boolean | "indeterminate" =
    pageIds.length > 0 && selectedOnPage === pageIds.length
      ? true
      : selectedOnPage > 0
        ? "indeterminate"
        : false;
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-3 border-b border-(--surface-panel-border) pr-3"
      data-list-page-selection
    >
      <div className="flex w-10 shrink-0 justify-center">
        <Checkbox
          aria-label={
            state === true
              ? `Clear the ${pageIds.length} ${noun} on this page`
              : `Select the ${pageIds.length} ${noun} on this page`
          }
          checked={state}
          disabled={pageIds.length === 0}
          onCheckedChange={() =>
            state === true ? onClearPage() : onSelectPage()
          }
          title={`Select ${noun} on this page · Shift+click for a range`}
        />
      </div>
      {/* With the list's own actions on this row, the hint moves to the
          checkbox's tooltip so the row stays one line. */}
      {selectedOnPage > 0 || !children ? (
        <span className="min-w-0 truncate text-(length:--text-small) text-foreground-muted">
          {selectedOnPage > 0
            ? `${selectedOnPage} of ${pageIds.length} on this page`
            : `Select ${noun} on this page · Shift+click for a range`}
        </span>
      ) : null}
      {children ? (
        <div className="ml-auto flex min-w-0 items-center justify-end gap-2">
          {children}
        </div>
      ) : null}
    </div>
  );
}
