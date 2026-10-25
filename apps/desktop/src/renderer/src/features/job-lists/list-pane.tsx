import { Fragment, memo, useEffect, useRef, type ReactNode } from "react";

import { Checkbox } from "@renderer/components/ui/checkbox";
import { SelectableRow } from "@renderer/components/ui/selectable-row";
import {
  jobFinderListRegionClassName,
  jobFinderListRowBadgeSlotClassName,
  jobFinderListRowClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowMetaClassName,
  jobFinderListRowStatusClassName,
  jobFinderListRowTitleClassName,
  jobFinderListRowTitleLineClassName,
} from "@renderer/features/job-finder/components/list-row";
import {
  LIST_DETAIL_COLUMNS_CLASS,
  TABLE_DETAIL_COLUMNS_CLASS,
} from "@renderer/features/job-finder/components/list-detail-columns";
import { cn } from "@renderer/lib/cn";

import { isSelected, type ListSelection } from "./list-selection";

/** The id the list rows point at, so assistive tech knows where details go. */
export const LIST_DETAIL_REGION_ID = "list-detail";

/**
 * The one list and details layout: the list on the left, the selected row's
 * details on the right, stacked below 1280px. Every list screen uses it;
 * `table` gives the list most of the width.
 */
export function ListDetailLayout(props: {
  list: ReactNode;
  detail: ReactNode;
  table?: boolean;
}) {
  return (
    <div
      className={cn(
        "grid min-h-0 flex-1 gap-4 xl:grid-rows-[minmax(0,1fr)]",
        props.table ? TABLE_DETAIL_COLUMNS_CLASS : LIST_DETAIL_COLUMNS_CLASS,
      )}
    >
      {props.list}
      {props.detail}
    </div>
  );
}

/**
 * One row: a tick box, then title (with one badge slot), meta and status
 * lines. Selection never changes the row's size.
 */
export const ListRowFrame = memo(function ListRowFrame(props: {
  id: number;
  title: string;
  active: boolean;
  checked: boolean;
  onActivate: (id: number) => void;
  onToggle: (id: number, shiftKey: boolean) => void;
  /** Trailing on the title line: a score, a status badge. */
  badge?: ReactNode;
  /** Under the title: employer, place. */
  meta: string;
  /** Third line: why it fits, what it is waiting on. */
  status?: ReactNode;
  /** Right end of the third line: dates, sources. */
  trailing?: ReactNode;
}) {
  return (
    <li
      className="relative min-w-0 pl-10 [contain-intrinsic-size:auto_92px] [content-visibility:auto]"
      data-list-row-id={props.id}
    >
      <div
        className="absolute inset-y-0 left-0 z-10 flex w-10 cursor-pointer items-start justify-center pt-4"
        onClick={(event) => {
          if (event.target === event.currentTarget)
            props.onToggle(props.id, event.shiftKey);
        }}
      >
        <Checkbox
          aria-label={`Select ${props.title}`}
          checked={props.checked}
          onClick={(event) => {
            event.preventDefault();
            props.onToggle(props.id, event.shiftKey);
          }}
        />
      </div>
      <SelectableRow
        aria-controls={LIST_DETAIL_REGION_ID}
        className={jobFinderListRowClassName}
        onClick={() => props.onActivate(props.id)}
        selected={props.active}
        tabIndex={props.active ? 0 : -1}
      >
        <div className={jobFinderListRowLinesClassName}>
          <div className={jobFinderListRowTitleLineClassName}>
            <strong
              className={jobFinderListRowTitleClassName}
              title={props.title}
            >
              {props.title}
            </strong>
            {props.badge ? (
              <div className={jobFinderListRowBadgeSlotClassName}>
                {props.badge}
              </div>
            ) : null}
          </div>
          <span className={jobFinderListRowMetaClassName} title={props.meta}>
            {props.meta}
          </span>
          <div className="flex min-w-0 items-baseline gap-3">
            <span
              className={cn(
                jobFinderListRowStatusClassName,
                "flex-1 text-foreground-soft",
              )}
            >
              {props.status}
            </span>
            {props.trailing ? (
              <span className="shrink-0 text-(length:--text-small) text-foreground-muted">
                {props.trailing}
              </span>
            ) : null}
          </div>
        </div>
      </SelectableRow>
    </li>
  );
});

export interface ListRowState {
  active: boolean;
  checked: boolean;
}

/**
 * The list half of a list screen: a toolbar with the select-all box and the
 * count (or, with rows ticked, the bulk actions), the rows, and more rows as
 * the person scrolls to the end. Rows render through `renderRow`, usually
 * as a `ListRowFrame`.
 */
export function ListPane<Row extends { id: number }>(props: {
  label: string;
  rows: readonly Row[];
  total: number;
  totalCapped: boolean;
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  activeId: number | null;
  selection: ListSelection;
  selectedCount: number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  renderRow: (row: Row, state: ListRowState) => ReactNode;
  /** Filter, sort and other controls, shown when nothing is ticked. */
  toolbar?: ReactNode;
  /** Shown instead of the toolbar while rows are ticked. */
  bulkActions?: ReactNode;
  empty: ReactNode;
  /** Singular noun for the rows, e.g. "job". */
  noun?: string;
}) {
  const noun = props.noun ?? "job";
  const sentinel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const { onLoadMore, hasMore } = props;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, props.rows.length]);

  useEffect(() => {
    if (props.activeId === null) return;
    listRef.current
      ?.querySelector(`[data-list-row-id="${props.activeId}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [props.activeId]);

  const allChecked =
    props.rows.length > 0 &&
    (props.selection.all
      ? props.selection.ids.size === 0
      : props.rows.every((row) => props.selection.ids.has(row.id)));
  const capped = props.totalCapped ? "+" : "";
  const totalText = `${props.total.toLocaleString()}${capped}`;
  const selectedText = `${props.selectedCount.toLocaleString()}${
    props.selection.all ? capped : ""
  }`;

  return (
    <section
      aria-label={props.label}
      className="surface-panel-shell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) xl:h-full"
    >
      <header className="flex min-h-12 shrink-0 items-center gap-3 border-b border-(--surface-panel-border) py-2 pr-3">
        <div className="flex w-10 shrink-0 justify-center">
          <Checkbox
            aria-label={
              allChecked || props.selectedCount > 0
                ? "Clear the selection"
                : `Select all ${totalText} ${noun}s`
            }
            checked={
              allChecked
                ? true
                : props.selectedCount > 0
                  ? "indeterminate"
                  : false
            }
            disabled={props.rows.length === 0}
            onCheckedChange={() =>
              allChecked || props.selectedCount > 0
                ? props.onClearSelection()
                : props.onSelectAll()
            }
            title="Select all · Ctrl+A"
          />
        </div>
        {props.selectedCount > 0 ? (
          <div
            className="flex min-w-0 flex-1 items-center gap-2"
            data-selection-bar
          >
            <span className="shrink-0 text-(length:--text-small) font-medium text-foreground">
              {selectedText} selected
            </span>
            <div className="ml-auto flex items-center gap-2">
              {props.bulkActions}
            </div>
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 text-(length:--text-small) font-medium tabular-nums text-foreground">
              {props.loading
                ? "…"
                : `${totalText} ${noun}${props.total === 1 ? "" : "s"}`}
            </span>
            {props.toolbar}
          </div>
        )}
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-locked-pane-scroll-region
      >
        {props.rows.length === 0 && !props.loading ? (
          <div className="p-6">{props.empty}</div>
        ) : (
          <ul
            aria-label={props.label}
            className={jobFinderListRegionClassName}
            ref={listRef}
          >
            {props.rows.map((row) => (
              <Fragment key={row.id}>
                {props.renderRow(row, {
                  active: row.id === props.activeId,
                  checked: isSelected(props.selection, row.id),
                })}
              </Fragment>
            ))}
          </ul>
        )}
        {hasMore ? (
          <div
            className="py-4 text-center text-(length:--text-small) text-foreground-muted"
            ref={sentinel}
          >
            Loading more…
          </div>
        ) : null}
      </div>
    </section>
  );
}
