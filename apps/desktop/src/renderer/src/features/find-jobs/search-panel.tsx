import {
  JobSearchSettingsSchema,
  type JobSearchSettings,
  type JobSearchStatus,
} from "@nestor/contracts";
import { CircleStop, Plus, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ProgressBar } from "@renderer/components/ui/progress-bar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "@renderer/components/ui/segmented-control";

import { describeAge, plural } from "@renderer/features/job-lists";
import { FitText } from "@renderer/components/ui/fit-text";
import { cn } from "@renderer/lib/cn";
import { JOB_FINDER_ROUTE_PATHS } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import { SitePicker } from "./site-picker";
import { SiteResults, useKeepReading } from "./site-results";

const DEPTH: readonly SegmentedControlOption<JobSearchSettings["depth"]>[] = [
  {
    value: "quick",
    label: "Quick",
    title:
      "Quick: reads the newest listings on each site. Fast; Keep reading gets the rest later.",
  },
  {
    value: "thorough",
    label: "Thorough",
    title: "Thorough: reads every listing on each site. Slower.",
  },
];
const POSTED: readonly SegmentedControlOption<
  JobSearchSettings["postedWithin"]
>[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "any", label: "Any time" },
];

const DEFAULT_SETTINGS = JobSearchSettingsSchema.parse({});

function Choice(props: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2", props.className)}>
      <span className="text-(length:--text-small) text-foreground-muted">
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

/**
 * A running search in plain words: "Reading 3 of 5 sites · 4 new jobs". The
 * reader's machinery (HTTP and browser queues) stays in the site report.
 */
function runningLine(status: JobSearchStatus): {
  text: string;
  detail: string | undefined;
  percent: number | null;
} {
  const search = status.search!;
  const checkingFit =
    search.sourcesTotal > 0 && search.sourcesDone === search.sourcesTotal;
  const needsYou = status.progress?.needsYou ?? 0;
  const failed = status.progress?.failed ?? 0;
  const working = status.sources.filter((s) => s.state === "searching");
  const parts = [
    checkingFit
      ? `Checking fit · ${plural(search.sourcesTotal, "site")} read`
      : `Reading ${Math.min(search.sourcesDone + 1, search.sourcesTotal).toLocaleString()} of ${plural(search.sourcesTotal, "site")}`,
    plural(search.added, "new job"),
    ...(search.scored > 0 ? [`${search.scored.toLocaleString()} scored`] : []),
    ...(failed > 0 ? [`${failed.toLocaleString()} could not be read`] : []),
    ...(needsYou > 0
      ? [`${plural(needsYou, "site")} ${needsYou === 1 ? "needs" : "need"} you`]
      : []),
  ];
  return {
    text: parts.join(" · "),
    detail:
      working.length > 0
        ? `Now: ${working.map((s) => (s.message ? `${s.label}: ${s.message}` : s.label)).join(" · ")}`
        : undefined,
    percent:
      !checkingFit && search.sourcesTotal > 0
        ? (search.sourcesDone / search.sourcesTotal) * 100
        : null,
  };
}

/**
 * The last search's outcome in shorter words for a narrow line, longest
 * first: the full line, then without the merged and already-saved counts,
 * then only when it ran. A line is shown whole or replaced by a shorter one,
 * never cut mid-word.
 */
export function lastSearchLines(status: JobSearchStatus): string[] {
  const full = lastSearchLine(status);
  const search = status.search;
  if (!full || !search) return [];
  const when = describeAge(search.finishedAt ?? search.startedAt) ?? "";
  const short = `Last search ${when}: ${
    search.state === "failed"
      ? "stopped with a problem"
      : search.added === 0
        ? "nothing new"
        : plural(search.added, "new job")
  }${search.state === "stopped" ? " (stopped)" : ""}.`;
  return [...new Set([full, short, `Searched ${when}.`])];
}

export function lastSearchLine(status: JobSearchStatus): string | null {
  const search = status.search;
  if (!search || search.state === "running") return null;
  const when = describeAge(search.finishedAt ?? search.startedAt) ?? "";
  const failed = status.progress?.failed ?? 0;
  const needsYou = status.progress?.needsYou ?? 0;
  const problems = [
    ...(failed > 0
      ? [
          `${failed} of ${plural(search.sourcesTotal, "site")} could not be read`,
        ]
      : []),
    ...(needsYou > 0
      ? [`${plural(needsYou, "site")} ${needsYou === 1 ? "needs" : "need"} you`]
      : []),
  ].join("; ");
  const outcome = problems
    ? `${plural(search.added, "new job")}; ${problems}`
    : search.state === "failed"
      ? `stopped with a problem${search.error ? `: ${search.error}` : ""}`
      : search.added === 0
        ? "nothing new"
        : `${plural(search.added, "new job")}`;
  const stopped = search.state === "stopped" ? " (stopped)" : "";
  return `Last search ${when}: ${outcome}${stopped}${
    search.merged > 0 ? `, ${plural(search.merged, "duplicate")} merged` : ""
  }${
    (search.alreadySaved ?? 0) > 0
      ? `, ${(search.alreadySaved ?? 0).toLocaleString()} already saved`
      : ""
  }.`;
}

/**
 * One row of choices before a search - anything specific, which sites, how
 * long each gets, how recent a listing must be - and the button that starts
 * it, then one status line: the last search's outcome, or this search's
 * progress while it runs. How close a fit to show is not a search choice:
 * it only decides which found jobs the list shows (ADR 0041), so it lives
 * with the list's own tools, and a search records it as its pickiness.
 * The card keeps one height from idle to running to done: the choices stay
 * (held while a search runs), Search turns into Stop, the progress replaces
 * the "Last search…" line, and a hairline along the card's bottom edge shows
 * how far it got. "What each site found" opens over the list instead of
 * pushing it down.
 */
export function SearchPanel(props: {
  status: JobSearchStatus;
  starting: boolean;
  error: string | null;
  onStart: (settings: JobSearchSettings) => void;
  onStop: () => void;
  /** Turned-on sites, once known; 0 makes "Add a job site" the way on. */
  siteTotal?: number | null;
  onSiteTotal?: (total: number) => void;
  /**
   * The status line stands elsewhere (beside the list's tabs, where a wide
   * screen has room), so the card is one row of choices.
   */
  statusApart?: boolean;
}) {
  const navigate = useNavigate();
  const noSites = props.siteTotal === 0;
  const last = props.status.search?.settings ?? null;
  const [settings, setSettings] = useState<JobSearchSettings>(
    last ?? DEFAULT_SETTINGS,
  );
  const [adopted, setAdopted] = useState(last !== null);
  useEffect(() => {
    // The last search's choices arrive after the first paint.
    if (!adopted && last) {
      setSettings({ ...last, note: "" });
      setAdopted(true);
    }
  }, [adopted, last]);
  const set = <K extends keyof JobSearchSettings>(
    key: K,
    value: JobSearchSettings[K],
  ) => setSettings((current) => ({ ...current, [key]: value }));

  const running = props.status.search?.state === "running";
  const progress = running ? runningLine(props.status) : null;

  return (
    <section
      aria-label="Search"
      className={cn(
        // shrink-0: the page column is a flex column; a card that clips
        // (overflow-hidden) could otherwise be squeezed to a sliver when
        // larger text or zoom leaves the column short of height.
        "@container/search surface-panel-shell relative shrink-0 overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) px-3 pt-3",
        props.statusApart ? "pb-3" : "pb-2",
      )}
      data-search-running={running || undefined}
    >
      {/* One wrapping row set. Wide: the choices and Search, then the
          status line under them. Narrow (1024 beside the docked assistant):
          the note, sites and depth, then Posted, the status line and Search,
          so the card is two rows, not three. */}
      <form
        className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running) props.onStart(settings);
        }}
      >
        <fieldset className="contents" disabled={running}>
          <Input
            aria-label="Anything specific for this search"
            className="order-1 min-w-40 flex-1"
            maxLength={500}
            onChange={(event) => set("note", event.target.value)}
            placeholder="Anything specific? (optional)"
            size="toolbar"
            value={settings.note}
          />
          <div className="order-2 shrink-0">
            <SitePicker
              onChange={(value) => set("sites", value)}
              {...(props.onSiteTotal
                ? { onEnabledTotal: props.onSiteTotal }
                : {})}
              value={settings.sites}
            />
          </div>
          <SegmentedControl
            className="order-3 shrink-0"
            label="How to search"
            onValueChange={(value) => set("depth", value)}
            options={DEPTH}
            value={settings.depth}
          />
          {/* Wide, the three dates are one segmented choice. In a narrow
              card they fold into one compact menu that opens the second
              row. */}
          <div className="hidden @3xl/search:contents">
            <Choice className="order-3" label="Posted">
              <SegmentedControl
                label="What to keep by posting date"
                onValueChange={(value) => set("postedWithin", value)}
                options={POSTED}
                value={settings.postedWithin}
              />
            </Choice>
          </div>
          <div className="contents @3xl/search:hidden">
            <Select
              disabled={running}
              onValueChange={(value) =>
                set("postedWithin", value as JobSearchSettings["postedWithin"])
              }
              value={settings.postedWithin}
            >
              <SelectTrigger
                aria-label="Posted: what to keep by posting date"
                className="order-5 w-auto shrink-0"
                size="toolbar"
              >
                <span className="text-foreground-muted">Posted</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POSTED.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </fieldset>
        {running ? (
          <Button
            className="order-7 ml-auto @3xl/search:order-4"
            onClick={props.onStop}
            size="toolbar"
            title="Stop this search. Jobs found so far stay."
            type="button"
            variant="outline"
          >
            <CircleStop aria-hidden="true" />
            Stop search
          </Button>
        ) : noSites ? (
          // A search reads the sites turned on in Profile; with none, the
          // way on is adding one, not a Search that cannot work.
          <Button
            className="order-7 ml-auto @3xl/search:order-4"
            onClick={() => void navigate(JOB_FINDER_ROUTE_PATHS.profileSources)}
            size="toolbar"
            type="button"
          >
            <Plus aria-hidden="true" />
            Add a job site
          </Button>
        ) : (
          <Button
            className="order-7 ml-auto @3xl/search:order-4"
            disabled={
              "ids" in settings.sites && settings.sites.ids.length === 0
            }
            pending={props.starting}
            size="toolbar"
            type="submit"
          >
            <Search aria-hidden="true" />
            Search
          </Button>
        )}
        {props.statusApart ? null : (
          <>
            <div
              aria-hidden="true"
              className="order-4 h-0 basis-full @3xl/search:order-5"
            />
            {/* Its own row at every width: beside Posted and Search in a
                narrow card (1024 beside the docked assistant) it had no
                room left and no line fitted, so the last search vanished. */}
            <SearchStatus
              className="order-8 min-w-0 basis-full @3xl/search:order-6"
              error={props.error}
              noSites={noSites}
              status={props.status}
            />
          </>
        )}
      </form>
      {progress ? (
        <ProgressBar
          ariaLabel="Search progress"
          className="absolute inset-x-0 bottom-0 h-0.5 bg-(--surface-progress-track)"
          indeterminate={progress.percent === null}
          percent={progress.percent}
        />
      ) : null}
    </section>
  );
}

/**
 * The search's one status line: an error, this search's progress while it
 * runs, or the last search's outcome; then Keep reading and "What each site
 * found". Each line is shown whole or in shorter words, never cut mid-word.
 */
export function SearchStatus(props: {
  status: JobSearchStatus;
  error: string | null;
  noSites: boolean;
  className?: string;
}) {
  const more = useKeepReading();
  const [fitPending, setFitPending] = useState(false);
  const [fitError, setFitError] = useState<string | null>(null);
  const partial = props.status.progress?.partial ?? 0;
  const running = props.status.search?.state === "running";
  const stoppedWithSites =
    props.status.search?.state === "stopped" &&
    props.status.search.sourcesDone < props.status.search.sourcesTotal;
  const remaining = props.status.fitChecking ?? 0;
  const fitting = props.status.fitRunning === true;
  const progress = running ? runningLine(props.status) : null;
  const scoreRetry = !running && !fitting && remaining > 0;
  const fitAction = (command: "retry_fit" | "stop_search") => {
    setFitPending(true);
    setFitError(null);
    void window.nestor.jobs
      .run(command, {})
      .catch(() => {
        setFitError(
          "Could not continue fit scoring. Your saved jobs are kept.",
        );
      })
      .finally(() => setFitPending(false));
  };
  const failed = (props.status.progress?.failed ?? 0) > 0;
  const extra = `${
    scoreRetry
      ? ` ${props.status.fitError ? "Fit scoring did not finish. " : ""}${plural(remaining, "saved job")} ${remaining === 1 ? "needs" : "need"} a fit score. Retry fit continues from saved listings.`
      : ""
  }${
    partial > 0
      ? ` Quick stopped early on ${plural(partial, "site")} with more listings.`
      : ""
  }`;
  const lines = lastSearchLines(props.status);
  const idle =
    lines.length > 0
      ? [`${lines[0]}${extra}`, ...lines]
      : props.noSites
        ? // The card's Add a job site and the list below say it once.
          []
        : [
            "No search yet. Choose your sites and press Search.",
            "No search yet.",
          ];
  const progressParts = progress?.text.split(" · ") ?? [];
  return (
    <div
      className={cn("flex min-h-8 min-w-0 items-center gap-2", props.className)}
      data-search-status
    >
      {props.error || fitError ? (
        <p
          className="min-w-0 flex-1 truncate text-(length:--text-small) text-(--warning-text)"
          role="alert"
          title={props.error ?? fitError ?? undefined}
        >
          {props.error ?? fitError}
        </p>
      ) : !running && fitting ? (
        <p role="status" className="min-w-0 flex-1 text-(length:--text-small)">
          {`Checking fit for ${plural(remaining, "saved job")}…`}
        </p>
      ) : progress ? (
        <FitText
          candidates={[
            progress.text,
            progressParts.slice(0, 2).join(" · "),
            progressParts[0] ?? "",
          ].filter((line, index, all) => line && all.indexOf(line) === index)}
          className="text-(length:--text-small) text-foreground"
          lineProps={{
            "aria-live": "polite",
            "data-search-progress": true,
          }}
          {...(progress.detail ? { title: progress.detail } : {})}
        />
      ) : idle.length === 0 ? (
        <span className="flex-1" />
      ) : (
        <FitText
          candidates={[...new Set(idle)]}
          className={cn(
            "text-(length:--text-small)",
            failed ? "text-(--warning-text)" : "text-foreground-muted",
          )}
        />
      )}
      {scoreRetry ? (
        <Button
          className="shrink-0"
          disabled={fitPending}
          size="toolbar"
          type="button"
          variant="outline"
          onClick={() => fitAction("retry_fit")}
          title={
            props.status.fitError ??
            "Continue scoring saved listings without reading sites again"
          }
        >
          Retry fit
        </Button>
      ) : !running && fitting ? (
        <Button
          className="shrink-0"
          disabled={fitPending}
          size="toolbar"
          type="button"
          variant="outline"
          onClick={() => fitAction("stop_search")}
        >
          Stop fit
        </Button>
      ) : null}
      {!running && (partial > 0 || failed || stoppedWithSites) ? (
        <Button
          className="shrink-0"
          pending={more.pending}
          size="toolbar"
          type="button"
          variant="outline"
          onClick={() => more.keepReading()}
          title={more.error ?? undefined}
        >
          {failed || stoppedWithSites
            ? "Continue unfinished sites"
            : partial === 1
              ? "Keep reading it"
              : "Keep reading them"}
        </Button>
      ) : null}
      {props.status.search !== null ? (
        <SiteResults
          revision={props.status.sourceRevision}
          searchId={props.status.search.id}
          showFailures={failed}
        />
      ) : null}
    </div>
  );
}
