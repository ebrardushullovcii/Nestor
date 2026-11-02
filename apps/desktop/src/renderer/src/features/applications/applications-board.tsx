import {
  type TrackerFilterInput,
  type TrackerRow,
  type TrackerStatus,
  type TrackerStatusCounts,
} from "@nestor/contracts";
import { X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";

import { Button } from "@renderer/components/ui/button";
import { useStoreList } from "@renderer/features/job-lists";
import { ListEmpty } from "@renderer/features/job-lists/list-empty";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";
import { cn } from "@renderer/lib/cn";

import { useSetStatus } from "./application-detail";
import {
  countGroup,
  describeDue,
  describeStatus,
  formatDay,
  STAGE_DOT,
  STAGE_GROUPS,
} from "./tracker-format";

type Group = (typeof STAGE_GROUPS)[number];

const CARD_PAGE = 30;
const DRAG_TYPE = "application/x-nestor-job";

/** While a card is dragged over a stage: the focus ring's colour and tint. */
const DROP_TARGET_CLASS = "ring-2 ring-(--ring) bg-(--accent-tint)";

/** Where a drop on this stage moves a card; Applying and Closed take none. */
function dropStatus(group: Group): Exclude<TrackerStatus, "applying"> | null {
  return group.id === "applying" ||
    group.id === "not_sent" ||
    group.id === "closed"
    ? null
    : (group.statuses[0] as Exclude<TrackerStatus, "applying">);
}

/** A stage's colour dot, the same as its colour on Home. */
export function StageDot(props: { stage: string }) {
  const dot = STAGE_DOT[props.stage];
  if (!dot) return null;
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-full"
      data-stage-dot={props.stage}
      style={{
        background: dot.fill,
        ...(dot.edge
          ? dot.ring === "dashed"
            ? { border: `1.5px dashed ${dot.edge}` }
            : { boxShadow: `inset 0 0 0 ${dot.ring ? 2 : 1}px ${dot.edge}` }
          : {}),
      }}
    />
  );
}

/** Drag-over state for one drop target. */
function useDrop(target: Exclude<TrackerStatus, "applying"> | null) {
  const setStatus = useSetStatus();
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragLeave: () => setOver(false),
      onDragOver: (event: ReactDragEvent) => {
        if (!target || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDrop: (event: ReactDragEvent) => {
        setOver(false);
        const id = Number(event.dataTransfer.getData(DRAG_TYPE));
        if (target && Number.isInteger(id))
          void setStatus({ ids: [id] }, target);
      },
    },
  };
}

/**
 * The board: one column per stage that has applications, each at least
 * 220px wide with its colour dot, name and count, and its own list read a
 * page at a time, so a stage of 500 scrolls in place. Stages with nothing in
 * them fold into one compact strip of drop targets at the end, read left to
 * right like every other label. Drag a card to another stage to move it.
 */
export function ApplicationsBoard(props: {
  filter: Omit<TrackerFilterInput, "statuses">;
  counts: TrackerStatusCounts;
  activeId: number | null;
  onActivate: (id: number) => void;
  /** The one next step on an empty board. */
  emptyAction: { label: string; onClick: () => void };
  /** Room on the right for the details sheet, so every column scrolls clear of it. */
  sheetOpen?: boolean;
}) {
  const total = STAGE_GROUPS.reduce(
    (sum, group) => sum + countGroup(props.counts, group.statuses),
    0,
  );
  if (total === 0)
    return (
      <div
        aria-label="Applications by stage"
        className="surface-panel-shell grid min-h-0 flex-1 place-items-center rounded-(--radius-panel) border border-(--surface-panel-border) p-8"
        data-board-empty
        role="region"
      >
        <ListEmpty
          action={props.emptyAction}
          detail="Approve resumes in Shortlisted and Apply sends them; each one gets a card here, in the stage it has reached."
          title="No applications yet"
        />
      </div>
    );
  const occupied = STAGE_GROUPS.filter(
    (group) => countGroup(props.counts, group.statuses) > 0,
  );
  const empty = STAGE_GROUPS.filter(
    (group) =>
      !group.onlyWhenAny && countGroup(props.counts, group.statuses) === 0,
  );
  return (
    <div
      aria-label="Applications by stage"
      className={cn(
        "flex min-h-0 min-w-0 flex-1 gap-3 overflow-x-auto pb-2",
        props.sheetOpen && "pr-[29rem]",
      )}
      role="region"
    >
      {occupied.map((group) => (
        <BoardColumn
          activeId={props.activeId}
          filter={props.filter}
          group={group}
          key={group.id}
          onActivate={props.onActivate}
        />
      ))}
      {empty.length > 0 ? (
        <section
          aria-label="Stages with no applications"
          className="flex w-44 shrink-0 flex-col gap-1 self-start px-1 pt-2"
          data-board-empty-stages
        >
          <h3 className="px-2 text-(length:--text-small) font-medium text-foreground-soft">
            Empty stages
          </h3>
          <ul className="grid list-none gap-0.5 p-0">
            {empty.map((group) => (
              <EmptyStage group={group} key={group.id} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function EmptyStage(props: { group: Group }) {
  const target = dropStatus(props.group);
  const drop = useDrop(target);
  return (
    <li
      aria-label={`${props.group.label}, 0`}
      className={cn(
        // A quiet line, not a placeholder box; it still takes a drop.
        "flex h-8 items-center gap-2 rounded-(--radius-field) border border-transparent px-2 text-(length:--text-small) text-foreground-soft transition-colors duration-(--duration-fast)",
        drop.over && DROP_TARGET_CLASS,
      )}
      data-board-stage={props.group.id}
      title={target ? "Drop an application here." : undefined}
      {...drop.handlers}
    >
      <StageDot stage={props.group.id} />
      <span className="min-w-0 flex-1 truncate">{props.group.label}</span>
    </li>
  );
}

function BoardColumn(props: {
  group: Group;
  filter: Omit<TrackerFilterInput, "statuses">;
  activeId: number | null;
  onActivate: (id: number) => void;
}) {
  const { group } = props;
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

  const target = dropStatus(group);
  const drop = useDrop(target);

  return (
    <section
      aria-label={`${group.label}, ${list.total}`}
      className={cn(
        // As tall as its cards (up to the board's height, then it scrolls):
        // a stage with one card is not a full-height empty well.
        "flex max-h-full min-h-0 max-w-sm min-w-55 flex-[1_1_15rem] flex-col self-start rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--surface-well) transition-[box-shadow,background-color] duration-(--duration-fast)",
        drop.over && DROP_TARGET_CLASS,
      )}
      data-board-stage={group.id}
      {...drop.handlers}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <StageDot stage={group.id} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {group.label}
        </h3>
        <span className="text-xs tabular-nums text-foreground-soft">
          {list.total.toLocaleString()}
        </span>
      </header>
      <ul className="grid min-h-0 flex-1 list-none content-start gap-2 overflow-y-auto px-2 pb-2">
        {list.error ? (
          // What failed and the way on, in the column that failed; the
          // other columns and their cards stay usable.
          <li
            className="grid justify-items-start gap-2 px-1 py-2 text-(length:--text-small) text-foreground"
            data-list-read-error
            role="alert"
          >
            <span>Couldn’t read this stage.</span>
            <Button
              onClick={() => void list.refresh()}
              size="toolbar"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          </li>
        ) : !list.loading && list.rows.length === 0 ? (
          <li className="px-1 py-2 text-(length:--text-small) text-foreground-muted">
            None here match the filters.
          </li>
        ) : null}
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
        "grid w-full gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-card px-3 py-2 text-left text-sm outline-none transition-colors duration-(--duration-fast) hover:border-(--control-border) focus-ring",
        props.active &&
          "border-(--row-selected-bar) ring-1 ring-(--row-selected-bar)",
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
