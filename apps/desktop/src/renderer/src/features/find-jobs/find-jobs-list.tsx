import type { JobRow, JobSort } from "@nestor/contracts";
import { memo } from "react";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import {
  ListRowFrame,
  describeAge,
  describeFit,
  describeWhere,
  type ListRowState,
} from "@renderer/features/job-lists";

const SORT_LABEL: Record<JobSort, string> = {
  best_fit: "Best fit",
  newest: "Newest found",
  posted: "Newest posted",
  recent: "Recently moved",
};

export const FIND_JOBS_FILTER_SELECTOR = "[data-find-jobs-filter]";

/**
 * One Find jobs row: fit on the title line, why on the third. Memoized, so a
 * J press re-renders only the row it leaves and the row it opens; the
 * handlers must be stable.
 */
export const FindJobsRow = memo(function FindJobsRow(
  props: ListRowState & {
    row: JobRow;
    onActivate: (id: number) => void;
    onToggle: (id: number, shiftKey: boolean) => void;
  },
) {
  const { row } = props;
  const fit = describeFit(row.fitScore, row.stage);
  const age = describeAge(row.postedAt ?? row.foundAt);
  return (
    <ListRowFrame
      active={props.active}
      checked={props.checked}
      index={props.index}
      setSize={props.setSize}
      top={props.top}
      badge={
        <>
          {row.fitScore !== null ? (
            <span className="text-(length:--text-small) font-semibold tabular-nums text-(--text-headline)">
              {row.fitScore}
            </span>
          ) : null}
          <StatusBadge tone={fit.tone}>{fit.label}</StatusBadge>
        </>
      }
      id={row.id}
      meta={describeWhere(row)}
      onActivate={props.onActivate}
      onToggle={props.onToggle}
      status={
        <span title={row.stageNote ?? row.fitSummary ?? undefined}>
          {row.stageNote
            ? `Hidden by the search: ${row.stageNote}`
            : (row.fitSummary ?? row.salaryText ?? "")}
        </span>
      }
      title={row.title}
      trailing={[
        age ? `${row.postedAt ? "Posted" : "Found"} ${age}` : null,
        row.sourceCount > 1 ? `${row.sourceCount} sites` : row.sourceLabel,
      ]
        .filter(Boolean)
        .join(" · ")}
    />
  );
});

/** Filter, the fit floor and the sort, above the rows. */
export function FindJobsToolbar(props: {
  text: string;
  onText: (text: string) => void;
  sort: JobSort;
  sorts: readonly JobSort[];
  onSort: (sort: JobSort) => void;
  /** Null hides the fit floor control (tabs other than Found). */
  fitFloor: { floor: number | null; below: string | null } | null;
  onToggleFloor: () => void;
}) {
  return (
    <>
      <Input
        aria-label="Filter jobs"
        className="min-w-24 flex-1"
        data-find-jobs-filter
        onChange={(event) => props.onText(event.target.value)}
        placeholder="Filter by title, company, place  /"
        size="toolbar"
        value={props.text}
      />
      {props.fitFloor ? (
        <Button
          aria-pressed={props.fitFloor.floor !== null}
          onClick={props.onToggleFloor}
          size="toolbar"
          title={
            props.fitFloor.floor === null
              ? "Show only good fits (and jobs still being scored)"
              : "Show every fit"
          }
          type="button"
          variant={props.fitFloor.floor === null ? "outline" : "secondary"}
        >
          {props.fitFloor.floor === null
            ? "Any fit"
            : `Fit ${props.fitFloor.floor}+${
                props.fitFloor.below ? ` · ${props.fitFloor.below} below` : ""
              }`}
        </Button>
      ) : null}
      <select
        aria-label="Sort"
        className="h-8 rounded-(--radius-button) border border-(--control-border) bg-transparent px-2 text-xs text-foreground"
        onChange={(event) => props.onSort(event.target.value as JobSort)}
        value={props.sort}
      >
        {props.sorts.map((sort) => (
          <option key={sort} value={sort}>
            {SORT_LABEL[sort]}
          </option>
        ))}
      </select>
    </>
  );
}
