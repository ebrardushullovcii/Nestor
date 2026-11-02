import { MousePointer2 } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@renderer/lib/cn";

import { LIST_DETAIL_REGION_ID } from "./list-pane";

/**
 * What the list beside an empty details pane holds: rows to pick from, none
 * (the list says why, with its own action), or nothing read (the list shows
 * the error and Try again).
 */
export type BesideList = "rows" | "empty" | "failed";

/** The list's state from its rows, loading and error. */
export function besideList(list: {
  rows: readonly unknown[];
  loading: boolean;
  error?: string | null | undefined;
}): BesideList {
  if (list.rows.length > 0 || list.loading) return "rows";
  return list.error ? "failed" : "empty";
}

/**
 * The one empty details pane, beside every list (Find jobs, Shortlisted,
 * Applications, Needs you, job sites): the same frame as a filled pane, a
 * quiet pointer glyph and one sentence saying what to pick. A pane whose
 * read failed (`state`) holds that state instead, in the same frame.
 *
 * Beside a list with nothing in it (`list`), there is nothing to pick: the
 * pane says so quietly, without the pointer, and leaves the explanation and
 * the way on to the list ("Pick a job…" beside "0 jobs" asked the
 * impossible).
 */
export function EmptyPane(props: {
  /** The pane's accessible name, e.g. "Job details". */
  label: string;
  children: ReactNode;
  className?: string;
  id?: string;
  /** A whole state (an error with Try again) in place of the sentence. */
  state?: boolean;
  /** The list beside it; "rows" (the default) asks to pick one. */
  list?: BesideList | undefined;
}) {
  const list = props.list ?? "rows";
  return (
    <section
      aria-label={props.label}
      className={cn(
        "surface-panel-shell grid min-h-48 min-w-0 place-items-center rounded-(--radius-panel) border border-(--surface-panel-border) p-8 text-center split:h-full",
        props.className,
      )}
      data-empty-pane={list === "rows" ? "" : list}
      id={props.id ?? LIST_DETAIL_REGION_ID}
    >
      {props.state ? (
        props.children
      ) : list !== "rows" ? (
        <p className="max-w-xs text-(length:--text-description) text-foreground-muted">
          {list === "failed"
            ? "Nothing to show until the list is read."
            : "Nothing to open here yet."}
        </p>
      ) : (
        <div className="grid max-w-xs justify-items-center gap-2">
          {/* A plain pointer: the sparkle-rayed one read as the assistant's
              mark, which means something else in this app. */}
          <MousePointer2
            aria-hidden="true"
            className="size-5 text-foreground-muted"
          />
          <p className="text-(length:--text-description) text-foreground-soft">
            {props.children}
          </p>
        </div>
      )}
    </section>
  );
}
