import { JOB_FIT_BANDS, type JobRow, type JobSort } from "@nestor/contracts";
import { memo } from "react";

import { Input } from "@renderer/components/ui/input";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "@renderer/components/ui/segmented-control";
import {
  Fit,
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

/** A fit floor in words: "Good fit" for 65, "Strong fit" for 85. */
export function describeFloor(floor: number): string {
  if (floor >= JOB_FIT_BANDS.strong) return "Strong fit";
  if (floor >= JOB_FIT_BANDS.good) return "Good fit";
  return `Fit ${floor}`;
}

/** The fit floors offered in the list, from widest to narrowest. */
const FLOOR_CHOICES = [
  {
    value: "any",
    label: "Any fit",
    title: "Show every found job, whatever its fit.",
  },
  {
    value: String(JOB_FIT_BANDS.good),
    label: "Good+",
    title: `Show good fits and up (scored ${JOB_FIT_BANDS.good} or more). Jobs not scored yet join once they are.`,
  },
  {
    value: String(JOB_FIT_BANDS.strong),
    label: "Strong",
    title: `Show strong fits only (scored ${JOB_FIT_BANDS.strong} or more). Jobs not scored yet join once they are.`,
  },
] as const satisfies readonly SegmentedControlOption<string>[];

/**
 * One Find jobs row in two lines: the title with its fit, then the
 * employer and place, then why it fits (which keeps at least half the line,
 * the place giving way first), with the age at the line's end. Where it
 * was listed lives in the details. Memoized, so a J press re-renders only
 * the row it leaves and the row it opens; the handlers must be stable.
 */
export const FindJobsRow = memo(function FindJobsRow(
  props: ListRowState & {
    row: JobRow;
    onActivate: (id: number) => void;
    onToggle: (id: number, shiftKey: boolean) => void;
  },
) {
  const { row } = props;
  const age = describeAge(row.postedAt ?? row.foundAt);
  const fitLabel = describeFit(row.fitScore, row.stage).label;
  const reason = row.stageNote
    ? `Hidden by the search: ${row.stageNote}`
    : (row.fitSummary ?? row.salaryText ?? "");
  return (
    <ListRowFrame
      active={props.active}
      checked={props.checked}
      exiting={props.exiting}
      motion={props.motion}
      index={props.index}
      setSize={props.setSize}
      top={props.top}
      // The title line is the title and its fit, nothing else: the age
      // waits at the end of the line under it. A narrower row drops the age
      // first and keeps the fit word ("Good fit") to about 320px; only
      // below that does the fit read as score and marks alone.
      badge={
        <Fit
          labelClassName="sr-only @xs/row:not-sr-only"
          score={row.fitScore}
          stage={row.stage}
        />
      }
      metaTrailing={
        age ? (
          <span
            className="hidden shrink-0 whitespace-nowrap text-(length:--text-small) text-foreground-soft @md/row:inline"
            data-row-age
            title={`${row.postedAt ? "Posted" : "Found"} ${age}`}
          >
            {age}
          </span>
        ) : null
      }
      id={row.id}
      nameParts={{
        badge:
          row.fitScore === null ? fitLabel : `${row.fitScore}, ${fitLabel}`,
        trailing: age,
      }}
      meta={describeWhere(row)}
      metaReason={reason || undefined}
      metaReasonShort={
        !row.stageNote && row.fitSummary ? (row.fitShort ?? null) : null
      }
      onActivate={props.onActivate}
      onToggle={props.onToggle}
      title={row.title}
    />
  );
});

/**
 * Filter, the fit floor and the sort, above the rows. The fit floor is the
 * one fit control on Find jobs: it decides which found jobs the list shows,
 * and the next search records it as how picky it was.
 */
export function FindJobsToolbar(props: {
  text: string;
  onText: (text: string) => void;
  sort: JobSort;
  sorts: readonly JobSort[];
  onSort: (sort: JobSort) => void;
  /** Null hides the fit floor control (tabs other than Found). */
  fitFloor: { floor: number | null } | null;
  onFloor: (floor: number | null) => void;
}) {
  const floor = props.fitFloor?.floor ?? null;
  const floorValue = floor === null ? "any" : String(floor);
  // A floor the assistant set that is not one of the three still shows.
  const floorOptions: readonly SegmentedControlOption<string>[] =
    floor === null ||
    FLOOR_CHOICES.some((choice) => choice.value === floorValue)
      ? FLOOR_CHOICES
      : [
          ...FLOOR_CHOICES,
          {
            value: floorValue,
            label: `${floor}+`,
            title: `Show jobs scored ${floor} or more.`,
          },
        ];
  // The fit floor and the sort keep their whole labels and travel together:
  // when the row is too narrow for both beside the filter (a narrow list, or
  // larger text), they wrap as a pair under a full-width filter, never one
  // control alone and never a sort squeezed to "E". Both rows then end at
  // the same right edge. In a window of 64rem and more (1024px at the
  // default text size) the sort is as wide as the choice it shows, so the
  // filter, the floor and the sort share one row at 1024 and up; with larger
  // text (a narrower window in rem) it keeps its longest choice's width.
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <Input
        aria-label="Filter jobs"
        // Takes nearly all the free room while the pair sits beside it;
        // wrapped, the pair below takes its row's room (the sort grows).
        className="min-w-20 flex-[999_1_0%]"
        data-find-jobs-filter
        onChange={(event) => props.onText(event.target.value)}
        placeholder="Filter  /"
        size="toolbar"
        title="Filter by title, company or place  /"
        value={props.text}
      />
      <div className="flex shrink-0 grow items-center gap-2">
        {props.fitFloor ? (
          <SegmentedControl
            className="shrink-0"
            data-find-jobs-fit-floor
            label="Show fit"
            onValueChange={(value) =>
              props.onFloor(value === "any" ? null : Number(value))
            }
            options={floorOptions}
            value={floorValue}
          />
        ) : null}
        <select
          aria-label="Sort"
          // With larger text, as wide as its longest choice, so picking one
          // never resizes it; in a wide window, as wide as its choice.
          className="h-8 shrink-0 grow rounded-(--radius-button) border border-(--field-border) bg-transparent px-2 text-xs text-foreground window-wide:field-sizing-content"
          data-find-jobs-sort
          onChange={(event) => props.onSort(event.target.value as JobSort)}
          value={props.sort}
        >
          {props.sorts.map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABEL[sort]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
