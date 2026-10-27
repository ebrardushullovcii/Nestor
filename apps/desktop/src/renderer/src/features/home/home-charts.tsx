import type { HomeActivityDay, TrackerStatus } from "@nestor/contracts";
import { useState } from "react";

import { cn } from "@renderer/lib/cn";
import { formatHomePercent } from "./home-percent";

const dayLabel = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const weekdayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const formatDay = (day: string) => dayLabel.format(new Date(`${day}T00:00Z`));

/** A clean top for the axis: 1, 2 or 5 times a power of ten, at least 4. */
function niceMax(value: number): number {
  const target = Math.max(4, value);
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
      className="grid min-w-0 gap-3 rounded-(--radius-small) outline-none focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-ring"
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

      <div aria-hidden className="grid min-w-0 gap-2">
        <Columns
          days={days}
          height="h-40"
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
        <div className="relative h-4 text-[0.6875rem] text-foreground-muted">
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
            {weekdayLabel.format(new Date(`${active.day}T00:00Z`))}
          </>
        ) : (
          "Point at a day to see its numbers."
        )}
      </p>

      <table className="sr-only">
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
      {/* Hairline grid at the top, the middle and the baseline. */}
      {[0, 0.5, 1].map((at) => (
        <div
          className="absolute inset-x-0 border-t border-(--surface-panel-border)"
          key={at}
          style={{ top: `${at * 100}%` }}
        />
      ))}
      <span className="absolute -top-2 right-0 bg-(--surface-panel) pl-1 text-[0.6875rem] tabular-nums text-foreground-muted">
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
                  "w-full max-w-6 rounded-t-[4px] bg-primary-fill transition-opacity",
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
  /** Share of the accent; the further along, the darker. Closed is gray. */
  fill: string;
}[] = [
  {
    label: "Waiting",
    statuses: ["applied"],
    fill: "color-mix(in oklab, var(--primary-fill) 28%, var(--surface-panel))",
  },
  {
    label: "Heard back",
    statuses: ["replied"],
    fill: "color-mix(in oklab, var(--primary-fill) 52%, var(--surface-panel))",
  },
  {
    label: "Assessment or interview",
    statuses: ["assessment", "interview"],
    fill: "color-mix(in oklab, var(--primary-fill) 76%, var(--surface-panel))",
  },
  { label: "Offer", statuses: ["offer"], fill: "var(--primary-fill)" },
  {
    label: "Closed",
    statuses: ["rejected", "withdrawn", "no_reply"],
    fill: "color-mix(in oklab, var(--muted-foreground) 45%, var(--surface-panel))",
  },
];

/**
 * One part-to-whole bar: the applications sent in the last 30 days by where
 * each stands now, with a legend that is also the table of counts.
 */
export function StandingBar(props: { recent: Record<TrackerStatus, number> }) {
  const groups = STANDING.map((group) => ({
    ...group,
    count: group.statuses.reduce(
      (sum, status) => sum + props.recent[status],
      0,
    ),
  }));
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
          <div aria-hidden className="flex h-6 min-w-0 gap-0.5">
            {groups
              .filter((group) => group.count > 0)
              .map((group, index, shown) => (
                <div
                  className={cn(
                    "min-w-1",
                    index === 0 && "rounded-l-[4px]",
                    index === shown.length - 1 && "rounded-r-[4px]",
                  )}
                  key={group.label}
                  style={{ flexGrow: group.count, background: group.fill }}
                  title={`${group.label}: ${group.count}`}
                />
              ))}
          </div>
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
                    className="py-1.5 text-left font-normal text-foreground-soft"
                    scope="row"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[2px]"
                        style={{ background: group.fill }}
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
