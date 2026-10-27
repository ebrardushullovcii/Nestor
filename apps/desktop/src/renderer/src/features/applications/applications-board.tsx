import {
  type TrackerFilterInput,
  type TrackerRow,
  type TrackerStatus,
  type TrackerStatusCounts,
} from "@nestor/contracts";
import { X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@renderer/components/ui/button";
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
 * The board: one column per stage across the whole width, each with its own
 * list read a page at a time from the store, so a stage of 500 applications
 * scrolls in place. An empty stage folds to a thin labelled rail that still
 * takes a drop. Drag a card to another column to move it.
 */
export function ApplicationsBoard(props: {
  filter: Omit<TrackerFilterInput, "statuses">;
  activeId: number | null;
  onActivate: (id: number) => void;
  /** Room on the right for the details sheet, so every column scrolls clear of it. */
  sheetOpen?: boolean;
}) {
  return (
    <div
      aria-label="Applications by stage"
      className={cn(
        "flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto pb-2",
        props.sheetOpen && "pr-[29rem]",
      )}
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

  const empty = !list.loading && list.rows.length === 0;

  return (
    <section
      aria-label={`${group.label}, ${list.total}`}
      className={cn(
        "flex min-h-0 flex-col rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-well)",
        empty ? "w-10 shrink-0" : "min-w-44 flex-[1_1_14rem]",
        over && "border-(--focus-ring)",
      )}
      data-board-rail={empty || undefined}
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
      {empty ? (
        // Read top to bottom: the stage and its 0, with room for a drop.
        <header
          className="flex flex-1 items-center gap-2 py-3 text-sm [writing-mode:vertical-rl]"
          title={target ? "Drop an application here." : undefined}
        >
          <h3 className="font-semibold">{group.label}</h3>
          <span className="text-xs tabular-nums text-foreground-soft">0</span>
        </header>
      ) : (
        <>
          <header className="flex items-baseline justify-between px-3 py-2">
            <h3 className="truncate text-sm font-semibold">{group.label}</h3>
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
            <div aria-hidden ref={sentinel} />
          </ul>
        </>
      )}
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

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/**
 * The open card's details, as a sheet over the right of the board, so the
 * board keeps the whole width. Escape or the close button puts it away; in a
 * field, Escape leaves the field first.
 */
export function BoardDetailSheet(props: {
  onClose: () => void;
  children: ReactNode;
}) {
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    // Capture, so the list's own Escape (clear the ticks) waits its turn.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isTyping(event.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      onClose.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div
      aria-label="Application details"
      className="absolute inset-y-0 right-0 z-20 flex w-[28rem] max-w-full flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) bg-card shadow-xl"
      role="dialog"
    >
      <div className="flex shrink-0 justify-end px-2 pt-2">
        <Button
          aria-label="Close details"
          onClick={props.onClose}
          size="icon-sm"
          title="Close · Esc"
          type="button"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4">
        {props.children}
      </div>
    </div>
  );
}
