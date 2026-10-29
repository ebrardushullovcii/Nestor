import { useCallback, useEffect, useState } from "react";
import type {
  JobSearchSourcePage,
  JobSearchSourceState,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { plural } from "@renderer/features/job-lists";
import {
  describeFailure,
  TECHNICAL_DETAILS_LABEL,
} from "@renderer/features/job-finder/lib/describe-failure";

const EMPTY: JobSearchSourcePage = { rows: [], nextCursor: null, total: 0 };
const LABELS: Record<JobSearchSourceState["state"], string> = {
  waiting: "Waiting",
  searching: "Working",
  done: "Done",
  failed: "Could not read",
  needs_you: "Needs you",
  // The person pressed Stop.
  stopped: "Stopped",
  // Quick stopped reading a healthy site early, on purpose.
  partial: "More to read",
};

/**
 * Keep reading: a full read of one site, or of every site the last Quick
 * search stopped early. The search panel shows the run it starts.
 */
export function useKeepReading() {
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const keepReading = useCallback((id?: number) => {
    setPending(true);
    setError(null);
    void window.nestor.jobs
      .run("keep_reading", id === undefined ? {} : { id })
      .catch((reason: unknown) =>
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not keep reading. Try again.",
        ),
      )
      .finally(() => setPending(false));
  }, []);
  return { keepReading, pending, error };
}
function failureReason(message: string | null): string {
  if (/\btimed? out\b|\btimeout\b|\btook too long\b/iu.test(message ?? ""))
    return "This site took too long to respond. Open it to check it loads, then search again. Other sites continue normally.";
  if (/\bHTTP 404\b|\bpage not found\b/iu.test(message ?? ""))
    return "Page not found. Check the URL.";
  if (/\bHTTP 410\b/iu.test(message ?? ""))
    return "This page is no longer available. Check the URL.";
  if (/\bHTTP [45]\d{2}\b/iu.test(message ?? ""))
    return "The site returned an error. Check the address or try again later.";
  if (
    /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|ENOTFOUND/iu.test(
      message ?? "",
    )
  )
    return "This site could not be reached. Check its address and your connection.";
  if (message?.includes("title or hiring employer could not be read"))
    return "The vacancy title or hiring employer could not be identified on this page.";
  return describeFailure(message, {
    unknownSentence:
      "This site could not be read completely. Check its address and try again.",
  }).sentence;
}

/** Only an opened page is read. A search status never transports all 900 sites. */
export function SiteResults(props: {
  searchId: string;
  revision: number;
  showFailures?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(props.showFailures)),
    [text, setText] = useState("");
  const [state, setState] = useState<JobSearchSourceState["state"] | null>(
    props.showFailures ? "failed" : null,
  );
  useEffect(() => {
    if (props.showFailures) {
      setOpen(true);
      setState("failed");
    }
  }, [props.searchId, props.showFailures]);
  const [cursors, setCursors] = useState([0]),
    [index, setIndex] = useState(0);
  const [page, setPage] = useState(EMPTY),
    [error, setError] = useState<string | null>(null);
  const more = useKeepReading();
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
      open={open}
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
              <option value="partial">More to read</option>
              <option value="done">Done</option>
              <option value="searching">Working</option>
            </select>
          </div>
          {error || more.error ? (
            <p role="alert">{error ?? more.error}</p>
          ) : null}
          <ul className="grid max-h-96 list-none gap-2 overflow-y-auto p-0">
            {page.rows.map((source) => (
              <li
                key={source.sourceId}
                className="rounded border p-3"
                data-site-result
              >
                <details
                  open={
                    source.state === "failed" || source.state === "needs_you"
                  }
                >
                  <summary className="cursor-pointer">
                    <strong>{source.label}</strong> · {LABELS[source.state]} ·{" "}
                    {plural(source.cards, "listing")} ·{" "}
                    {plural(source.added, "new job")}
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
                  {source.state === "failed" ? (
                    <p className="mt-1">{failureReason(source.message)}</p>
                  ) : source.message ? (
                    <p className="mt-1 whitespace-pre-wrap">{source.message}</p>
                  ) : null}
                  {source.state === "partial" ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span>This site has more listings.</span>
                      <Button
                        size="toolbar"
                        variant="outline"
                        pending={more.pending}
                        onClick={() =>
                          more.keepReading(Number(source.sourceId))
                        }
                      >
                        Keep reading
                      </Button>
                    </div>
                  ) : null}
                  {source.state === "failed" ? (
                    <p className="mt-2">
                      Check this URL in Profile → Job sources, then search
                      again. If a vacancy page cannot be read, try the board’s
                      main jobs URL.
                    </p>
                  ) : null}
                  {source.state === "failed" && source.message ? (
                    <details className="mt-2 text-xs text-foreground-muted">
                      <summary className="cursor-pointer">
                        {TECHNICAL_DETAILS_LABEL}
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap break-words">
                        {source.message}
                      </p>
                    </details>
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
