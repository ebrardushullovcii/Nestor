import { useState } from "react";
import type { ActivityFeed } from "@nestor/contracts";

import { Button } from "@renderer/components/ui/button";
import { StatusBadge } from "../status-badge";
import { toActivityItems, type ActivityItem } from "./activity-items";

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

/**
 * The open Activity panel's rows: what Job Finder is doing, then what it
 * finished in the last day. Each opens the screen that shows that work.
 */
export function ActivityPanel(props: {
  feed: ActivityFeed | null;
  onOpen: (href: string) => void;
}) {
  const [clearedIds, setClearedIds] = useState(readClearedIds);
  if (!props.feed)
    return (
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
        <section aria-label="Finished today" className="grid gap-2">
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
    </div>
  );
}
