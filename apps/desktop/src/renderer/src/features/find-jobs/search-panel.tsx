import {
  JobSearchSettingsSchema,
  type JobSearchSettings,
  type JobSearchSourceState,
  type JobSearchStatus,
} from "@nestor/contracts";
import { Search, Square } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { ProgressBar } from "@renderer/components/ui/progress-bar";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "@renderer/components/ui/segmented-control";

import { describeAge, plural } from "@renderer/features/job-lists";
import { SitePicker } from "./site-picker";

const DEPTH: readonly SegmentedControlOption<JobSearchSettings["depth"]>[] = [
  { value: "quick", label: "Quick", title: "A short look at each site" },
  { value: "thorough", label: "Thorough", title: "Search each site fully" },
];
const PICKY: readonly SegmentedControlOption<JobSearchSettings["picky"]>[] = [
  { value: "open", label: "Any fit", title: "Keep anything that could fit" },
  { value: "balanced", label: "Good", title: "Show good fits first" },
  { value: "strict", label: "Strong", title: "Only strong fits" },
];
const POSTED: readonly SegmentedControlOption<
  JobSearchSettings["postedWithin"]
>[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "any", label: "Any time" },
];

const DEFAULT_SETTINGS = JobSearchSettingsSchema.parse({});

function Choice(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-(length:--text-small) text-foreground-muted">
        {props.label}
      </span>
      {props.children}
    </div>
  );
}

function RunningSearch(props: { status: JobSearchStatus; onStop: () => void }) {
  const search = props.status.search!;
  const checkingFit =
    search.sourcesTotal > 0 && search.sourcesDone === search.sourcesTotal;
  const percent =
    !checkingFit && search.sourcesTotal > 0
      ? (search.sourcesDone / search.sourcesTotal) * 100
      : null;
  const working = props.status.sources.filter((s) => s.state === "searching");
  const needsYou = props.status.sources.filter((s) => s.state === "needs_you");
  return (
    <div className="grid gap-2" data-search-running>
      <div className="flex min-w-0 items-center gap-3">
        <p
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-(length:--text-description) text-foreground"
        >
          <strong className="font-semibold">
            {checkingFit ? "Checking fit" : "Searching"}
          </strong>{" "}
          {search.sourcesDone} of {plural(search.sourcesTotal, "site")} ·{" "}
          {plural(search.added, "new job")}
          {search.merged > 0 ? ` · ${search.merged} already saved` : ""}
          {search.scored > 0 ? ` · ${search.scored} scored` : ""}
        </p>
        <Button
          onClick={props.onStop}
          size="sm"
          type="button"
          variant="outline"
        >
          <Square aria-hidden="true" />
          Stop
        </Button>
      </div>
      <ProgressBar
        ariaLabel="Search progress"
        indeterminate={percent === null}
        percent={percent}
      />
      {working.length > 0 || needsYou.length > 0 ? (
        <p className="truncate text-(length:--text-small) text-foreground-muted">
          {working.length > 0
            ? `Now: ${working.map((s) => (s.message ? `${s.label}: ${s.message}` : s.label)).join(" · ")}`
            : ""}
          {needsYou.length > 0
            ? `${working.length > 0 ? " · " : ""}Needs you: ${needsYou
                .map((s) => s.label)
                .join(", ")}`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

const SITE_STATE: Record<JobSearchSourceState["state"], string> = {
  waiting: "Not reached",
  searching: "Searching",
  done: "Done",
  failed: "Could not search",
  needs_you: "Needs you",
  stopped: "Stopped",
};

/** What each site found in the last search, and why one found nothing. */
function SiteResults(props: { sources: readonly JobSearchSourceState[] }) {
  return (
    <details className="text-(length:--text-small) text-foreground-soft">
      <summary className="cursor-pointer text-foreground-muted">
        What each site found
      </summary>
      <ul className="mt-2 grid list-none gap-1 p-0">
        {props.sources.map((source) => (
          <li className="flex min-w-0 gap-2" key={source.sourceId}>
            <span className="w-48 shrink-0 truncate font-medium text-foreground">
              {source.label}
            </span>
            <span className="shrink-0">
              {source.state === "done"
                ? `${plural(source.found, "listing")}, ${source.added} new${
                    source.hidden > 0 ? `, ${source.hidden} hidden` : ""
                  }`
                : SITE_STATE[source.state]}
            </span>
            {source.message ? (
              <span
                className="min-w-0 truncate text-foreground-muted"
                title={source.message}
              >
                · {source.message}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

function lastSearchLine(status: JobSearchStatus): string | null {
  const search = status.search;
  if (!search || search.state === "running") return null;
  const when = describeAge(search.finishedAt ?? search.startedAt) ?? "";
  const outcome =
    search.state === "failed"
      ? `stopped with a problem${search.error ? `: ${search.error}` : ""}`
      : search.added === 0
        ? "nothing new"
        : `${plural(search.added, "new job")}`;
  const stopped = search.state === "stopped" ? " (stopped)" : "";
  return `Last search ${when}: ${outcome}${stopped}${
    search.merged > 0 ? `, ${search.merged} already saved` : ""
  }.`;
}

/**
 * The few choices before a search and the one button that starts it. While
 * a search runs the same place shows how far it got and how to stop it.
 */
export function SearchPanel(props: {
  status: JobSearchStatus;
  starting: boolean;
  error: string | null;
  onStart: (settings: JobSearchSettings) => void;
  onStop: () => void;
}) {
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
  const summary = lastSearchLine(props.status);

  return (
    <section
      aria-label="Search"
      className="surface-panel-shell grid gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-3"
    >
      {running ? (
        <RunningSearch onStop={props.onStop} status={props.status} />
      ) : (
        <form
          className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            props.onStart(settings);
          }}
        >
          <Input
            aria-label="Anything specific for this search"
            className="min-w-56 flex-1"
            maxLength={500}
            onChange={(event) => set("note", event.target.value)}
            placeholder="Anything specific? (optional)"
            size="toolbar"
            value={settings.note}
          />
          <Choice label="Search">
            <SitePicker
              onChange={(value) => set("sites", value)}
              value={settings.sites}
            />
            <SegmentedControl
              label="How to search"
              onValueChange={(value) => set("depth", value)}
              options={DEPTH}
              value={settings.depth}
            />
          </Choice>
          <Choice label="Fit">
            <SegmentedControl
              label="How picky"
              onValueChange={(value) => set("picky", value)}
              options={PICKY}
              value={settings.picky}
            />
          </Choice>
          <Choice label="Posted">
            <SegmentedControl
              label="What to keep by posting date"
              onValueChange={(value) => set("postedWithin", value)}
              options={POSTED}
              value={settings.postedWithin}
            />
          </Choice>
          <Button
            className="ml-auto"
            disabled={
              "ids" in settings.sites && settings.sites.ids.length === 0
            }
            pending={props.starting}
            size="sm"
            type="submit"
          >
            <Search aria-hidden="true" />
            Search
          </Button>
        </form>
      )}
      {props.error ? (
        <p
          className="text-(length:--text-small) text-(--warning-text)"
          role="alert"
        >
          {props.error}
        </p>
      ) : !running && summary ? (
        <div className="grid gap-1">
          <p className="text-(length:--text-small) text-foreground-muted">
            {summary}
          </p>
          {props.status.search?.error &&
          props.status.search.state === "done" ? (
            <p
              role="status"
              className="text-(length:--text-small) text-(--warning-text)"
            >
              Some jobs still need a fit score. The next search will retry them.
            </p>
          ) : null}
          {props.status.sources.length > 0 ? (
            <SiteResults sources={props.status.sources} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
