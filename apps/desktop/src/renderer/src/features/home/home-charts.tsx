import type { HomeActivityDay, TrackerStatus } from "@nestor/contracts";
import { useState } from "react";

import { cn } from "@renderer/lib/cn";
import { formatDate } from "@renderer/features/job-finder/lib/format-date";
import { formatHomePercent } from "./home-percent";

// A chart day ("2026-11-02") in the shared date wording, read at local noon
// so no time zone moves it to the day before.
const formatDay = (day: string) => formatDate(new Date(`${day}T12:00:00`));

/**
 * A clean top for the axis: 1, 2 or 5 times a power of ten, from the data
 * (at least 1). A floor of 4 drew one sent application as a stub on an
 * empty 0–4 scale, which read as an unfinished chart.
 */
export function niceMax(value: number): number {
  const target = Math.max(1, value);
  const power = 10 ** Math.floor(Math.log10(target));
  return (
    [1, 2, 5, 10].map((step) => step * power).find((n) => n >= target) ??
    10 * power
  );
}

/**
 * Sent per day over the last four weeks, with replies under it on the same
 * days: two single-series column charts sharing one time axis, never two
 * scales on one chart. Hovering or focusing a day shows both numbers.
 */
export function ActivityChart(props: { days: readonly HomeActivityDay[] }) {
  const { days } = props;
  const [hovered, setHovered] = useState<number | null>(null);
  const sentMax = niceMax(Math.max(...days.map((day) => day.sent)));
  const repliesMax = niceMax(Math.max(...days.map((day) => day.replies)));
  const totalSent = days.reduce((sum, day) => sum + day.sent, 0);
  const totalReplies = days.reduce((sum, day) => sum + day.replies, 0);
  const active = hovered === null ? null : days[hovered];

  const step = (by: number) =>
    setHovered((index) =>
      Math.min(days.length - 1, Math.max(0, (index ?? days.length) + by)),
    );

  return (
    <figure
      aria-label="Sent per day. Use the arrow keys to read each day."
      className="grid min-w-0 gap-3 rounded-(--radius-small) outline-none xl:flex-1 xl:grid-rows-[auto_minmax(0,1fr)_auto] focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-ring"
      onBlur={() => setHovered(null)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") step(-1);
        else if (event.key === "ArrowRight") step(1);
        else return;
        event.preventDefault();
      }}
      tabIndex={0}
    >
      <figcaption className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-semibold text-(--text-headline)">
          Sent per day
        </span>
        <span className="text-xs text-foreground-soft">
          Last 4 weeks · {totalSent.toLocaleString()} sent ·{" "}
          {totalReplies.toLocaleString()}{" "}
          {totalReplies === 1 ? "reply" : "replies"}
        </span>
      </figcaption>

      <div
        aria-hidden
        className="grid min-w-0 gap-2 xl:grid-rows-[minmax(4rem,1fr)_auto_auto_auto]"
      >
        <Columns
          days={days}
          height="h-40 xl:h-auto"
          hovered={hovered}
          max={sentMax}
          onHover={setHovered}
          pick={(day) => day.sent}
        />
        <div className="flex items-baseline justify-between text-xs text-foreground-soft">
          <span>Replies</span>
        </div>
        <Columns
          days={days}
          height="h-12"
          hovered={hovered}
          max={repliesMax}
          onHover={setHovered}
          pick={(day) => day.replies}
        />
        <div className="relative h-4 text-xs text-foreground-muted">
          {days.map((day, index) =>
            index % 7 === 0 || index === days.length - 1 ? (
              <span
                className={cn(
                  "absolute top-0 whitespace-nowrap tabular-nums",
                  index === days.length - 1 && "right-0",
                )}
                key={day.day}
                style={
                  index === days.length - 1
                    ? undefined
                    : { left: `${(index / days.length) * 100}%` }
                }
              >
                {index === days.length - 1 ? "Today" : formatDay(day.day)}
              </span>
            ) : null,
          )}
        </div>
      </div>

      <p aria-live="polite" className="min-h-5 text-xs text-foreground-soft">
        {active ? (
          <>
            <span className="font-semibold text-(--text-headline)">
              {active.sent.toLocaleString()} sent
            </span>
            {" · "}
            {active.replies.toLocaleString()}{" "}
            {active.replies === 1 ? "reply" : "replies"} ·{" "}
            {formatDay(active.day)}
          </>
        ) : (
          "Point at a day to see its numbers."
        )}
      </p>

      {/* The numbers for a screen reader. In a div: a table ignores the
          1px height of sr-only and kept its 30 rows' height, which added a
          blank screen of scroll under Home. */}
      <div className="sr-only">
        <table>
          <caption>Applications sent and replies per day</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Sent</th>
              <th scope="col">Replies</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{formatDay(day.day)}</th>
                <td>{day.sent}</td>
                <td>{day.replies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

function Columns(props: {
  days: readonly HomeActivityDay[];
  pick: (day: HomeActivityDay) => number;
  max: number;
  height: string;
  hovered: number | null;
  onHover: (index: number | null) => void;
}) {
  return (
    <div
      className={cn("relative min-w-0", props.height)}
      onPointerLeave={() => props.onHover(null)}
    >
      {/* Hairline grid at the top, the baseline and, where it is a whole
          number, the middle. */}
      {(props.max % 2 === 0 ? [0, 0.5, 1] : [0, 1]).map((at) => (
        <div
          className="absolute inset-x-0 border-t border-(--surface-panel-border)"
          key={at}
          style={{ top: `${at * 100}%` }}
        />
      ))}
      <span className="absolute -top-2 right-0 bg-(--surface-panel) pl-1 text-xs tabular-nums text-foreground-muted">
        {props.max.toLocaleString()}
      </span>
      <div className="absolute inset-0 flex items-end gap-0.5 pr-8">
        {props.days.map((day, index) => {
          const value = props.pick(day);
          return (
            <div
              className="flex h-full min-w-0 flex-1 items-end justify-center"
              key={day.day}
              onPointerEnter={() => props.onHover(index)}
            >
              <div
                className={cn(
                  "w-full max-w-6 rounded-t-xs bg-primary-fill transition-opacity",
                  props.hovered !== null &&
                    props.hovered !== index &&
                    "opacity-55",
                )}
                style={{
                  height:
                    value > 0 ? `max(2px, ${(value / props.max) * 100}%)` : 0,
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Where recently sent applications stand, in pipeline order. */
const STANDING: readonly {
  label: string;
  statuses: readonly TrackerStatus[];
  /**
   * One hue per stage, from the palette's chart tokens: waiting and closed
   * are neutral (mid and light), heard back is indigo (no status hue), an
   * offer is success green, and "Assessment or interview" carries both of
   * its stages' marks, the board's violet and plum side by side (split by
   * their counts in the bar, half and half in its legend dot), never one
   * stage's colour for both.
   */
  fill: string;
  /** A quiet fill below 3:1 on the card keeps a visible shape by its edge. */
  edge?: string;
}[] = [
  { label: "Applied", statuses: ["applied"], fill: "var(--chart-waiting)" },
  {
    label: "Heard back",
    statuses: ["replied"],
    fill: "var(--chart-heard-back)",
  },
  {
    label: "Assessment or interview",
    statuses: ["assessment", "interview"],
    fill: "linear-gradient(90deg, var(--chart-assessment) 50%, var(--chart-interview) 50%)",
  },
  { label: "Offer", statuses: ["offer"], fill: "var(--chart-offer)" },
  {
    label: "Closed",
    statuses: ["rejected", "withdrawn", "no_reply"],
    fill: "var(--chart-closed)",
    edge: "var(--chart-closed-edge)",
  },
];

/**
 * One part-to-whole bar: the applications sent in the last 30 days by where
 * each stands now, with a legend that is also the table of counts.
 */
export function StandingBar(props: { recent: Record<TrackerStatus, number> }) {
  const groups = STANDING.map((group) => {
    const count = group.statuses.reduce(
      (sum, status) => sum + props.recent[status],
      0,
    );
    // The merged stage's bar is split by how many are at each stage.
    const assessmentShare =
      group.statuses.length === 2 && group.statuses[0] === "assessment" && count
        ? Math.round((props.recent.assessment / count) * 100)
        : null;
    return {
      ...group,
      count,
      barFill:
        assessmentShare === null
          ? group.fill
          : `linear-gradient(90deg, var(--chart-assessment) ${assessmentShare}%, var(--chart-interview) ${assessmentShare}%)`,
    };
  });
  const total = groups.reduce((sum, group) => sum + group.count, 0);

  return (
    <figure className="grid min-w-0 content-start gap-3">
      <figcaption className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="text-sm font-semibold text-(--text-headline)">
          Where they stand
        </span>
        <span className="text-xs text-foreground-soft">
          {total.toLocaleString()} sent in the last 30 days
        </span>
      </figcaption>
      {total === 0 ? (
        <p className="text-sm text-foreground-soft">
          Nothing sent in the last 30 days yet.
        </p>
      ) : (
        <>
          {groups.filter((group) => group.count > 0).length === 1 ? (
            // One stage holds everything: not a solid slab of one colour,
            // but an outlined bar that says so in words.
            <SingleStandingBar
              group={groups.find((group) => group.count > 0) ?? groups[0]!}
              total={total}
            />
          ) : (
            <div aria-hidden className="flex h-6 min-w-0 gap-0.5">
              {groups
                .filter((group) => group.count > 0)
                .map((group, index, shown) => (
                  <div
                    className={cn(
                      "min-w-1",
                      index === 0 && "rounded-l-xs",
                      index === shown.length - 1 && "rounded-r-xs",
                    )}
                    key={group.label}
                    style={{
                      flexGrow: group.count,
                      background: group.barFill,
                      ...(group.edge
                        ? { boxShadow: `inset 0 0 0 1px ${group.edge}` }
                        : {}),
                    }}
                    title={`${group.label}: ${group.count}`}
                  />
                ))}
            </div>
          )}
          <table className="w-full text-sm">
            <caption className="sr-only">
              Applications sent in the last 30 days by where they stand now
            </caption>
            <tbody>
              {groups.map((group) => (
                <tr
                  className="border-t border-(--surface-panel-border) first:border-t-0"
                  key={group.label}
                >
                  <th
                    className="py-1.5 text-left font-normal text-(--text-headline)"
                    scope="row"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-3 shrink-0 rounded-full"
                        style={{
                          background: group.fill,
                          ...(group.edge
                            ? { boxShadow: `inset 0 0 0 1px ${group.edge}` }
                            : {}),
                        }}
                      />
                      {group.label}
                    </span>
                  </th>
                  <td className="py-1.5 text-right font-semibold tabular-nums text-(--text-headline)">
                    {group.count.toLocaleString()}
                  </td>
                  <td className="w-14 py-1.5 text-right tabular-nums text-foreground-muted">
                    {formatHomePercent(group.count, total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </figure>
  );
}

function SingleStandingBar(props: {
  group: { label: string; fill: string; edge?: string };
  total: number;
}) {
  const { group } = props;
  // A split mark (the merged stage) tints and edges the bar in its first
  // colour; its dot keeps both.
  const solid = group.fill.startsWith("linear-gradient")
    ? "var(--chart-assessment)"
    : group.fill;
  return (
    <div
      className="flex h-6 min-w-0 items-center gap-2 rounded-xs px-2 text-xs text-(--text-headline)"
      data-standing-single
      style={{
        background: `color-mix(in srgb, ${solid} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px ${group.edge ?? solid}`,
      }}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: group.fill }}
      />
      {props.total === 1
        ? `${group.label}: the 1 sent`
        : `${group.label}: all ${props.total.toLocaleString()}`}
    </div>
  );
}
