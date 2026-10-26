import { useState } from "react";
import type { ActivityFeed, ActivityMove } from "@nestor/contracts";

import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { StatusBadge } from "../status-badge";
import { refreshActivityFeed } from "../../lib/use-activity-feed";
import {
  describeMove,
  describeMovedOn,
  describeUndo,
  toActivityItems,
  type ActivityItem,
} from "./activity-items";

const CLEARED_ACTIVITY_STORAGE_KEY = "nestor.job-finder.cleared-activity.v2";

function readClearedIds(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(CLEARED_ACTIVITY_STORAGE_KEY) ?? "[]",
    );
    return new Set(
      Array.isArray(stored)
        ? stored.filter((value): value is string => typeof value === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}

function ActivityRow(props: {
  item: ActivityItem;
  onOpen: (item: ActivityItem) => void;
}) {
  const { item } = props;
  return (
    <li>
      <button
        className="grid w-full gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-2.5 text-left outline-none transition-colors hover:border-primary/50 hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/40"
        data-activity-kind={item.kind}
        data-activity-status={item.status}
        onClick={() => props.onOpen(item)}
        type="button"
      >
        <span className="flex items-start justify-between gap-2">
          <strong className="min-w-0 break-words font-semibold text-foreground">
            {item.title}
          </strong>
          <StatusBadge tone={item.tone}>{item.badge}</StatusBadge>
        </span>
        <span className="break-words text-(length:--text-small) text-foreground-soft">
          {item.detail}
        </span>
      </button>
    </li>
  );
}

function MoveRow(props: { move: ActivityMove }) {
  const { move } = props;
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();
  const { title, detail } = describeMove(move);
  const movedOn = describeMovedOn(move);
  async function undo() {
    setUndoing(true);
    setError(null);
    try {
      const result = await window.nestor.jobs.run("undo_move", {
        moveId: move.id,
      });
      const partial = describeUndo(move, result.moved);
      if (partial) showToast({ ...partial, tone: "warning" });
      // The move is spent; the next read drops it.
      refreshActivityFeed();
    } catch {
      setError("Undo did not work. Try again.");
      setUndoing(false);
    }
  }
  return (
    <li className="grid gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/40 px-3 py-2.5">
      <span className="flex items-start justify-between gap-2">
        <span className="grid min-w-0 gap-0.5">
          <strong className="break-words font-semibold text-foreground">
            {title}
          </strong>
          <span className="break-words text-(length:--text-small) text-foreground-soft">
            {detail}
          </span>
          {movedOn ? (
            <span className="text-(length:--text-small) text-foreground-muted">
              {movedOn}
            </span>
          ) : null}
        </span>
        {move.stillThere > 0 ? (
          <Button
            disabled={undoing}
            onClick={() => void undo()}
            pending={undoing}
            size="compact"
            type="button"
            variant="secondary"
          >
            Undo
          </Button>
        ) : (
          <span className="shrink-0 text-(length:--text-small) text-foreground-muted">
            Moved on since
          </span>
        )}
      </span>
      {error ? (
        <span
          className="text-(length:--text-small) text-destructive"
          role="alert"
        >
          {error}
        </span>
      ) : null}
    </li>
  );
}

/**
 * The open Activity panel's rows: what Job Finder is doing, then what it
 * finished in the last day. Each opens the screen that shows that work.
 */
export function ActivityPanel(props: {
  failed: boolean;
  feed: ActivityFeed | null;
  onOpen: (href: string) => void;
}) {
  const [clearedIds, setClearedIds] = useState(readClearedIds);
  if (!props.feed)
    return props.failed ? (
      <p
        className="flex flex-wrap items-center justify-between gap-2 px-1 text-(length:--text-small) text-foreground-soft"
        role="alert"
      >
        Activity could not be read.
        <Button
          onClick={refreshActivityFeed}
          size="compact"
          type="button"
          variant="secondary"
        >
          Try again
        </Button>
      </p>
    ) : (
      <p className="px-1 text-(length:--text-small) text-foreground-soft">
        Loading activity…
      </p>
    );
  const { running, finished } = toActivityItems(props.feed);
  const visibleFinished = finished.filter((item) => !clearedIds.has(item.id));
  const open = (item: ActivityItem) => props.onOpen(item.href);

  function clearFinished() {
    const next = new Set(clearedIds);
    for (const item of visibleFinished) next.add(item.id);
    setClearedIds(next);
    try {
      window.localStorage.setItem(
        CLEARED_ACTIVITY_STORAGE_KEY,
        JSON.stringify([...next].slice(-200)),
      );
    } catch {
      // The panel still clears this session when local storage is unavailable.
    }
  }

  return (
    <div className="grid gap-4">
      <section aria-label="Running now" className="grid gap-2">
        <h3 className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
          Running now
        </h3>
        {running.length === 0 ? (
          <p className="text-(length:--text-small) text-foreground-soft">
            Nothing is running. Searches, resume writing and applications show
            here while they work.
          </p>
        ) : (
          <ul className="grid gap-2">
            {running.map((item) => (
              <ActivityRow item={item} key={item.id} onOpen={open} />
            ))}
          </ul>
        )}
      </section>
      {visibleFinished.length > 0 ? (
        <section aria-label="Finished in the last day" className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
              Finished in the last day
            </h3>
            <Button
              onClick={clearFinished}
              size="compact"
              type="button"
              variant="ghost"
            >
              Clear finished
            </Button>
          </div>
          <ul className="grid gap-2">
            {visibleFinished.map((item) => (
              <ActivityRow item={item} key={item.id} onOpen={open} />
            ))}
          </ul>
        </section>
      ) : null}
      {props.feed.moves.length > 0 ? (
        <section aria-label="Your recent moves" className="grid gap-2">
          <h3 className="text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted">
            Your recent moves
          </h3>
          <ul className="grid gap-2">
            {props.feed.moves.map((move) => (
              <MoveRow key={move.id} move={move} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
