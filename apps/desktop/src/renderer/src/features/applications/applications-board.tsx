import {
  type TrackerFilterInput,
  type TrackerRow,
  type TrackerStatus,
  type TrackerStatusCounts,
} from "@nestor/contracts";
import { useEffect, useRef, useState } from "react";

import { useStoreList } from "@renderer/features/job-lists";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { cn } from "@renderer/lib/cn";

import { useSetStatus } from "./application-detail";
import {
  describeDue,
  describeStatus,
  formatDay,
  STAGE_GROUPS,
} from "./tracker-format";

type Group = (typeof STAGE_GROUPS)[number];

const CARD_PAGE = 30;
const DRAG_TYPE = "application/x-nestor-job";

/**
 * The board: one column per stage, each with its own list read a page at a
 * time from the store, so a stage of 500 applications scrolls in place.
 * Drag a card to another column to move it.
 */
export function ApplicationsBoard(props: {
  filter: Omit<TrackerFilterInput, "statuses">;
  activeId: number | null;
  onActivate: (id: number) => void;
}) {
  return (
    <div
      aria-label="Applications by stage"
      className="grid min-h-0 min-w-0 flex-1 auto-cols-[minmax(14rem,1fr)] grid-flow-col gap-3 overflow-x-auto pb-2"
      role="region"
    >
      {STAGE_GROUPS.map((group) => (
        <BoardColumn
          activeId={props.activeId}
          filter={props.filter}
          group={group}
          key={group.id}
          onActivate={props.onActivate}
        />
      ))}
    </div>
  );
}

function BoardColumn(props: {
  group: Group;
  filter: Omit<TrackerFilterInput, "statuses">;
  activeId: number | null;
  onActivate: (id: number) => void;
}) {
  const { group } = props;
  const setStatus = useSetStatus();
  const [over, setOver] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const list = useStoreList<TrackerRow, TrackerStatusCounts>({
    key: JSON.stringify([group.id, props.filter]),
    load: ({ cursor, limit }) =>
      window.nestor.tracker.run("list_applications", {
        ...props.filter,
        statuses: [...group.statuses],
        cursor,
        limit: Math.min(limit, CARD_PAGE),
      }),
  });
  const { loadMore } = list;
  const hasMore = list.nextCursor !== null;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore();
      },
      { rootMargin: "400px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore, list.rows.length]);

  // Applying and Closed take no drops: Apply sends, and closing says why.
  const target: Exclude<TrackerStatus, "applying"> | null =
    group.id === "applying" || group.id === "closed"
      ? null
      : (group.statuses[0] as Exclude<TrackerStatus, "applying">);

  return (
    <section
      aria-label={`${group.label}, ${list.total}`}
      className={cn(
        "flex min-h-0 flex-col rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-well)",
        over && "border-(--focus-ring)",
      )}
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        if (!target || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        setOver(true);
      }}
      onDrop={(event) => {
        setOver(false);
        const id = Number(event.dataTransfer.getData(DRAG_TYPE));
        if (target && Number.isInteger(id))
          void setStatus({ ids: [id] }, target);
      }}
    >
      <header className="flex items-baseline justify-between px-3 py-2">
        <h3 className="text-sm font-semibold">{group.label}</h3>
        <span className="text-xs tabular-nums text-foreground-soft">
          {list.total.toLocaleString()}
        </span>
      </header>
      <ul className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto px-2 pb-2">
        {list.rows.map((row) => (
          <li key={row.id}>
            <BoardCard
              active={row.id === props.activeId}
              onActivate={props.onActivate}
              row={row}
            />
          </li>
        ))}
        {!list.loading && list.rows.length === 0 ? (
          <li className="px-1 py-3 text-xs text-foreground-muted">
            {target ? "Drop an application here." : "Nothing here."}
          </li>
        ) : null}
        <div aria-hidden ref={sentinel} />
      </ul>
    </section>
  );
}

function BoardCard(props: {
  row: TrackerRow;
  active: boolean;
  onActivate: (id: number) => void;
}) {
  const { row } = props;
  const status = describeStatus(row);
  return (
    <button
      aria-pressed={props.active}
      className={cn(
        "grid w-full gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-card px-3 py-2 text-left text-sm",
        props.active && "border-(--focus-ring) ring-1 ring-(--focus-ring)",
      )}
      draggable={row.status !== "applying"}
      onClick={() => props.onActivate(row.id)}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, String(row.id));
        event.dataTransfer.effectAllowed = "move";
      }}
      type="button"
    >
      <span className="truncate font-semibold">{row.company}</span>
      <span className="truncate text-foreground-soft">{row.title}</span>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-muted">
        {row.status === "applying" ||
        ["rejected", "withdrawn", "no_reply"].includes(row.status) ? (
          <StatusBadge className="whitespace-nowrap" tone={status.tone}>
            {status.label}
          </StatusBadge>
        ) : null}
        {row.nextAt ? (
          <span>
            {describeDue(row.nextAt)}: {row.nextTitle}
          </span>
        ) : (
          <span className="whitespace-nowrap">
            Since {formatDay(row.statusAt)}
          </span>
        )}
      </span>
    </button>
  );
}
