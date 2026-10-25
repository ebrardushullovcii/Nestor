import { useEffect, useState } from "react";
import type {
  JobSearchSourcePage,
  JobSearchSourceState,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";

const EMPTY: JobSearchSourcePage = { rows: [], nextCursor: null, total: 0 };
const LABELS: Record<JobSearchSourceState["state"], string> = {
  waiting: "Waiting",
  searching: "Working",
  done: "Done",
  failed: "Could not read",
  needs_you: "Needs you",
  stopped: "Stopped",
};
/** Only an opened page is read. A search status never transports all 900 sites. */
export function SiteResults(props: { searchId: string; revision: number }) {
  const [open, setOpen] = useState(false),
    [text, setText] = useState("");
  const [state, setState] = useState<JobSearchSourceState["state"] | null>(
    null,
  );
  const [cursors, setCursors] = useState([0]),
    [index, setIndex] = useState(0);
  const [page, setPage] = useState(EMPTY),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCursors([0]);
    setIndex(0);
  }, [props.searchId, text, state]);
  const after = cursors[index] ?? 0;
  useEffect(() => {
    if (!open) return;
    let live = true;
    void window.nestor.jobs
      .run("list_search_sources", {
        searchId: props.searchId,
        text,
        state,
        after,
        limit: 25,
      })
      .then((next) => {
        if (live) {
          setPage(next);
          setError(null);
        }
      })
      .catch((reason: unknown) => {
        if (live)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load site results.",
          );
      });
    return () => {
      live = false;
    };
  }, [open, props.searchId, props.revision, text, state, after]);
  return (
    <details
      className="text-sm text-foreground-soft"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-foreground-muted">
        What each site found
      </summary>
      {open ? (
        <div className="mt-3 grid gap-3" aria-label="Per-site search results">
          <div className="flex gap-2">
            <Input
              aria-label="Find a searched site"
              placeholder="Find a site"
              size="toolbar"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <select
              className="rounded border bg-transparent px-2"
              aria-label="Site result filter"
              value={state ?? "all"}
              onChange={(event) =>
                setState(
                  event.target.value === "all"
                    ? null
                    : (event.target.value as JobSearchSourceState["state"]),
                )
              }
            >
              <option value="all">All sites</option>
              <option value="needs_you">Needs you</option>
              <option value="failed">Could not read</option>
              <option value="done">Done</option>
              <option value="searching">Working</option>
            </select>
          </div>
          {error ? <p role="alert">{error}</p> : null}
          <ul className="grid max-h-96 list-none gap-2 overflow-y-auto p-0">
            {page.rows.map((source) => (
              <li
                key={source.sourceId}
                className="rounded border p-3"
                data-site-result
              >
                <details>
                  <summary className="cursor-pointer">
                    <strong>{source.label}</strong> · {LABELS[source.state]} ·{" "}
                    {source.cards} listings · {source.added} new jobs
                    {source.hidden ? ` · ${source.hidden} saved hidden` : ""}
                  </summary>
                  <p className="mt-2 break-all text-xs text-foreground-muted">
                    {source.url}
                  </p>
                  <p className="mt-1">
                    {source.related} new related · {source.unrelated} unrelated
                    · {source.seen} already seen
                    {source.failedReads
                      ? ` · ${source.failedReads} reads need attention`
                      : ""}
                  </p>
                  {source.message ? (
                    <p className="mt-1 whitespace-pre-wrap">{source.message}</p>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
          {!page.rows.length && !error ? (
            <p>No sites match this filter.</p>
          ) : null}
          <nav
            aria-label="Site result pages"
            className="flex items-center justify-between gap-3"
          >
            <Button
              size="toolbar"
              variant="ghost"
              disabled={index === 0}
              onClick={() => setIndex((value) => value - 1)}
            >
              Previous sites
            </Button>
            <span>
              {page.total
                ? `${index * 25 + 1}–${index * 25 + page.rows.length} of ${page.total}`
                : "0 sites"}
            </span>
            <Button
              size="toolbar"
              variant="ghost"
              disabled={page.nextCursor === null}
              onClick={() => {
                if (page.nextCursor === null) return;
                setCursors((old) => [
                  ...old.slice(0, index + 1),
                  page.nextCursor!,
                ]);
                setIndex((value) => value + 1);
              }}
            >
              Next sites
            </Button>
          </nav>
        </div>
      ) : null}
    </details>
  );
}
