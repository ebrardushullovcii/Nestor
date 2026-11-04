import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  JobSearchSourcePage,
  JobSearchSourceState,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { Disclosure } from "@renderer/components/ui/disclosure";
import { Input } from "@renderer/components/ui/input";
import {
  Popover,
  type PopoverPlacement,
} from "@renderer/components/ui/popover";
import { useEffectWhileKeptRouteShown } from "@renderer/features/job-finder/lib/kept-route-visibility";
import { cn } from "@renderer/lib/cn";
import { plural } from "@renderer/features/job-lists";
import { SiteIcon } from "@renderer/features/job-finder/components/site-icon";
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
    return "This site took too long to respond. Other sites carried on.";
  if (/\bHTTP 404\b|\bpage not found\b/iu.test(message ?? ""))
    return "The page was not found.";
  if (/\bHTTP 410\b/iu.test(message ?? ""))
    return "This page is no longer available.";
  if (/\bHTTP [45]\d{2}\b/iu.test(message ?? ""))
    return "The site returned an error.";
  if (
    /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|ENOTFOUND/iu.test(
      message ?? "",
    )
  )
    return "This site could not be reached.";
  if (message?.includes("title or hiring employer could not be read"))
    return "The vacancy title or hiring employer could not be identified on this page.";
  return describeFailure(message, {
    unknownSentence: "This site could not be read completely.",
  }).sentence;
}

/**
 * What a site's listings came to, in plain words: new ones that match your
 * search, ones that don't, ones found before, and pages it couldn't read.
 */
export function describeCounts(source: {
  related: number;
  unrelated: number;
  seen: number;
  failedReads: number;
}): string {
  return [
    `${source.related.toLocaleString()} new ${source.related === 1 ? "match" : "matches"} for your search`,
    `${source.unrelated.toLocaleString()} not a match`,
    `${source.seen.toLocaleString()} found before`,
    ...(source.failedReads
      ? [`${plural(source.failedReads, "page")} couldn’t be read`]
      : []),
  ].join(" · ");
}

/**
 * A site without a name of its own reads by what its address names: the
 * last part of its path ("…/atlas" is "Atlas"), else its host without
 * "www." and port. A name someone gave it is kept as it is.
 */
export function siteDisplayName(label: string, url: string): string {
  const bare = label.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    return bare || url;
  }
  const host = parsed.hostname.replace(/^www\./u, "");
  const looksLikeAddress =
    !bare ||
    /^https?:\/\//iu.test(bare) ||
    bare.replace(/\/+$/u, "") ===
      `${parsed.host}${parsed.pathname}`.replace(/\/+$/u, "") ||
    bare === parsed.host ||
    bare === host;
  if (!looksLikeAddress) return bare;
  const segment = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (segment) {
    const words = decodeURIComponent(segment).replace(/[-_]+/gu, " ").trim();
    if (words && !/^\d+$/u.test(words))
      return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return host;
}

/** Only an opened page is read. A search status never transports all 900 sites. */
export function SiteResults(props: {
  searchId: string;
  revision: number;
  /** Some sites failed: the report opens on them, and the button says so. */
  showFailures?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  // Opens beside the search card, over the list, instead of pushing the
  // jobs down the page.
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const open = placement !== null;
  const [text, setText] = useState("");
  const [state, setState] = useState<JobSearchSourceState["state"] | null>(
    props.showFailures ? "failed" : null,
  );
  useEffect(() => {
    setState(props.showFailures ? "failed" : null);
  }, [props.searchId, props.showFailures]);
  useEffectWhileKeptRouteShown(() => () => setPlacement(null), []);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") {
          setPlacement(null);
          trigger.current?.focus();
        }
        return;
      }
      const target = event.target as Node;
      if (
        !surface.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        setPlacement(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
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
    <>
      <Button
        aria-expanded={open}
        aria-haspopup="dialog"
        className={cn(props.showFailures && "text-(--warning-text)")}
        onClick={() => {
          if (open) {
            setPlacement(null);
            return;
          }
          const rect = trigger.current!.getBoundingClientRect();
          const width = Math.min(560, window.innerWidth - 16);
          setPlacement({
            top: rect.bottom + 6,
            left: Math.max(
              8,
              Math.min(rect.right - width, window.innerWidth - width - 8),
            ),
            width,
            maxHeight: Math.max(280, window.innerHeight - rect.bottom - 24),
          });
        }}
        ref={trigger}
        size="toolbar"
        type="button"
        variant="ghost"
      >
        What each site found
        <ChevronDown aria-hidden="true" />
      </Button>
      <Popover
        className="grid content-start gap-3 p-3 text-sm text-foreground-soft"
        label="What each site found"
        open={open}
        placement={placement ?? { top: 0, left: 0 }}
        ref={surface}
      >
        <div className="grid gap-3" aria-label="Per-site search results">
          <div className="flex gap-2">
            <Input
              aria-label="Find a searched site"
              className="min-w-0 flex-1"
              placeholder="Find a site"
              size="toolbar"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <select
              className="h-8 rounded-(--radius-button) border border-(--control-border) bg-transparent px-2 text-(length:--text-small)"
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
          {/* Divider rows, as Activity lists its work: one hairline
              between sites, no card per site. */}
          <ul className="grid list-none divide-y divide-(--surface-panel-border) p-0">
            {page.rows.map((source) => (
              <li key={source.sourceId} className="px-2 py-2" data-site-result>
                <Disclosure
                  className="w-full"
                  defaultOpen={
                    source.state === "failed" || source.state === "needs_you"
                  }
                  summary={
                    <span className="min-w-0 whitespace-normal">
                      <SiteIcon
                        className="mr-1.5 inline-block -translate-y-px align-middle"
                        url={source.url}
                      />
                      <strong className="text-foreground">
                        {siteDisplayName(source.label, source.url)}
                      </strong>{" "}
                      · {LABELS[source.state]} ·{" "}
                      {plural(source.cards, "listing")} ·{" "}
                      {plural(source.added, "new job")}
                      {source.hidden
                        ? ` · ${source.hidden} hidden for you`
                        : ""}
                    </span>
                  }
                  summaryClassName="h-auto min-h-8 w-full py-1 text-left"
                  contentClassName="px-2 pb-2 pt-1"
                >
                  <p className="break-all text-xs text-foreground-muted">
                    {source.url}
                  </p>
                  <p className="mt-1">{describeCounts(source)}</p>
                  {source.state === "failed" ? (
                    <p className="mt-1">{failureReason(source.message)}</p>
                  ) : source.message ? (
                    <p className="mt-1 whitespace-pre-wrap">{source.message}</p>
                  ) : null}
                  {["partial", "failed", "stopped"].includes(source.state) ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span>
                        {source.state === "partial"
                          ? "This site's coverage is unfinished."
                          : "Saved results are kept. Continue this site's unfinished work."}
                      </span>
                      <Button
                        size="toolbar"
                        variant="outline"
                        pending={more.pending}
                        onClick={() =>
                          more.keepReading(Number(source.sourceId))
                        }
                      >
                        {source.state === "partial"
                          ? "Keep reading"
                          : "Continue site"}
                      </Button>
                    </div>
                  ) : null}
                  {source.state === "failed" && source.message ? (
                    <Disclosure
                      className="mt-2 text-xs text-foreground-muted"
                      summary={TECHNICAL_DETAILS_LABEL}
                    >
                      <p className="whitespace-pre-wrap break-words">
                        {source.message}
                      </p>
                    </Disclosure>
                  ) : null}
                </Disclosure>
              </li>
            ))}
          </ul>
          {!page.rows.length && !error ? (
            <p>No sites match this filter.</p>
          ) : null}
          {/* Paging only when there is more than one page. */}
          <nav
            aria-label="Site result pages"
            className={cn(
              "flex items-center justify-between gap-3",
              index === 0 && page.nextCursor === null && "hidden",
            )}
          >
            <Button
              size="toolbar"
              variant="ghost"
              disabled={index === 0}
              onClick={() => setIndex((value) => value - 1)}
            >
              Previous sites
            </Button>
            <span className="tabular-nums">
              {page.total
                ? `${index * 25 + 1}–${index * 25 + page.rows.length} of ${page.total.toLocaleString()}`
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
      </Popover>
    </>
  );
}
