import type { TriageStage } from "@nestor/contracts";
import { ExternalLink } from "lucide-react";
import { useRef } from "react";

import { Button } from "@renderer/components/ui/button";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";
import {
  DetailSheetBack,
  EmptyPane,
  type BesideList,
  ListReadError,
  Fit,
  LIST_DETAIL_REGION_ID,
  cleanDescription,
  describeAge,
  describeWorkModes,
  useJobDetail,
} from "@renderer/features/job-lists";
import type { TriageAction } from "./triage-actions";

function FactList(props: { title: string; items: readonly string[] }) {
  if (props.items.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <h3 className="text-(length:--text-small) font-semibold text-foreground">
        {props.title}
      </h3>
      <ul className="grid list-disc gap-1 pl-5 text-(length:--text-description) leading-6 text-foreground-soft">
        {props.items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The detail pane while a job loads, laid out block for block like the
 * loaded one: the header with title, place, facts and the two moves, then
 * the fit line and a few paragraphs.
 */
export function JobDetailSkeleton() {
  return (
    <section
      aria-busy="true"
      aria-label="Job details"
      className="surface-panel-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border)"
      data-job-detail-skeleton
      id={LIST_DETAIL_REGION_ID}
    >
      <div className="grid shrink-0 gap-3 border-b border-(--surface-panel-border) px-6 py-5">
        <div className="grid gap-1">
          <div className="flex min-h-[1lh] items-center text-(length:--text-heading-2) leading-[1.3]">
            <span className="skeleton block h-[0.8em] w-2/3" />
          </div>
          <div className="flex min-h-[1lh] items-center text-(length:--text-description)">
            <span className="skeleton block h-[0.8em] w-2/5" />
          </div>
          <div className="flex min-h-[1lh] items-center text-(length:--text-small)">
            <span className="skeleton block h-[0.8em] w-1/2" />
          </div>
        </div>
        <div className="flex min-h-[1lh] items-center text-(length:--text-heading-3)">
          <span className="skeleton block h-[0.8em] w-36" />
        </div>
        <div className="flex items-center gap-2">
          <span className="skeleton block h-8 w-28" />
          <span className="skeleton block h-8 w-20" />
          <span className="skeleton block h-8 w-28" />
        </div>
      </div>
      <div className="grid content-start gap-3 px-6 py-5">
        {["w-full", "w-11/12", "w-4/5", "w-full", "w-3/5"].map(
          (width, index) => (
            <span className={`skeleton block h-3.5 ${width}`} key={index} />
          ),
        )}
      </div>
    </section>
  );
}

/**
 * The detail half of Find jobs: what the job is, why it fits or not, where
 * it is listed, and the one or two moves that make sense from its stage.
 */
export function JobDetailPane(props: {
  jobId: number | null;
  stage: TriageStage;
  actions: readonly TriageAction[];
  onMove: (to: TriageStage) => void;
  /** The list is still loading: no "pick a job" while a job is on its way. */
  listLoading?: boolean;
  /** Stacked under a sheet: closes the sheet back to the list. */
  onBack?: () => void;
  /**
   * Rows are ticked: the bulk bar's "Shortlist 3" is the filled action, so
   * this job's own move steps down to outline.
   */
  bulkActive?: boolean;
  /** The list beside it: with nothing in it, there is nothing to pick. */
  list?: BesideList;
}) {
  const { job: loaded, error, retry } = useJobDetail(props.jobId);
  // Moving with J/K keeps the last job drawn until the next one arrives (a
  // few milliseconds), so the pane does not blink to a skeleton on every key.
  const shown = useRef(loaded);
  if (loaded) shown.current = loaded;
  if (props.jobId === null) shown.current = null;
  const job = loaded ?? shown.current;
  if (props.jobId === null) {
    if (props.listLoading) return <JobDetailSkeleton />;
    return (
      <EmptyPane className="h-full" label="Job details" list={props.list}>
        Pick a job to see it here.
      </EmptyPane>
    );
  }
  if (!job && error)
    return (
      <EmptyPane className="h-full" label="Job details" state>
        <ListReadError
          error={error}
          kept={null}
          onRetry={retry}
          what="This job"
        />
      </EmptyPane>
    );
  if (!job) return <JobDetailSkeleton />;

  // The row and the details read the same score.
  const score = job.fit?.score ?? job.fitScore;
  const posted = describeAge(job.postedAt);
  const facts = [
    job.salaryText,
    describeWorkModes(job.workModes),
    job.employmentType,
    job.seniority,
    posted ? `Posted ${posted}` : `Found ${describeAge(job.foundAt) ?? ""}`,
    job.sightings.length > 1
      ? `Listed on ${job.sightings.length} sites`
      : `Listed on ${job.sourceLabel}`,
  ].filter(Boolean);
  const description = cleanDescription(job.description, job);

  return (
    <section
      aria-busy={loaded ? undefined : true}
      aria-label="Job details"
      data-job-detail-id={job.id}
      className="surface-panel-shell flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border)"
      id={LIST_DETAIL_REGION_ID}
    >
      {props.onBack ? (
        // Stacked, the details are a sheet over the list: one way back to
        // it, with the open row still chosen and in view.
        <DetailSheetBack onBack={props.onBack} />
      ) : null}
      <header className="grid shrink-0 gap-3 border-b border-(--surface-panel-border) px-6 py-5">
        <div className="grid gap-1">
          <h2 className="font-display text-(length:--text-heading-2) font-semibold text-(--text-headline)">
            {job.title}
          </h2>
          <p className="text-(length:--text-description) text-foreground-soft">
            {[job.company, job.location].filter(Boolean).join(" · ")}
          </p>
          {facts.length > 0 ? (
            <p className="text-(length:--text-small) text-foreground-muted">
              {facts.join(" · ")}
            </p>
          ) : null}
        </div>
        <Fit
          className="justify-self-start"
          score={score}
          size="detail"
          stage={job.stage}
        />
        <div className="flex flex-wrap items-center gap-2">
          {props.actions.map((action, index) => (
            <Button
              // The keycap is decoration: the name is the action alone
              // ("Shortlist", not "ShortlistS"), the key is its shortcut.
              aria-keyshortcuts={action.key.toUpperCase()}
              key={action.to}
              onClick={() => props.onMove(action.to)}
              size="sm"
              title={`${action.label} · ${action.key.toUpperCase()}`}
              type="button"
              variant={index === 0 && !props.bulkActive ? "primary" : "outline"}
            >
              {action.label}
              <kbd
                aria-hidden="true"
                className="ml-1 rounded-(--radius-small) border border-current/30 px-1 font-sans text-(length:--text-tiny) opacity-70"
              >
                {action.key.toUpperCase()}
              </kbd>
            </Button>
          ))}
          <Button
            onClick={() => openUrlInJobFinderBrowser(job.url)}
            size="sm"
            title="Open listing · O"
            type="button"
            variant="ghost"
          >
            <ExternalLink aria-hidden="true" />
            Open listing
          </Button>
        </div>
      </header>
      <div
        className="@container/detail grid min-h-0 flex-1 content-start gap-6 overflow-y-auto px-6 py-5"
        data-locked-pane-scroll-region
      >
        {job.stageNote ? (
          <p className="rounded-(--radius-field) border border-(--surface-panel-border) bg-secondary px-3 py-2 text-(length:--text-small) text-foreground-soft">
            Hidden by the search: {job.stageNote}
          </p>
        ) : null}
        {job.fit ? (
          <div className="grid gap-3" data-job-fit>
            {job.fit.summary ? (
              <p className="max-w-prose text-(length:--text-description) leading-6 text-foreground">
                {job.fit.summary}
              </p>
            ) : null}
            <div className="grid gap-4 @xl/detail:grid-cols-2">
              <FactList items={job.fit.reasons} title="Why it fits" />
              <FactList items={job.fit.gaps} title="What's missing" />
            </div>
            <div className="grid gap-4 @xl/detail:grid-cols-2 @4xl/detail:grid-cols-3">
              <FactList
                items={job.fit.role ? [job.fit.role.explanation] : []}
                title="Role"
              />
              <FactList
                items={
                  job.fit.preferences ? [job.fit.preferences.explanation] : []
                }
                title="Preferences"
              />
              <FactList
                items={job.fit.coverage ? [job.fit.coverage.explanation] : []}
                title="Coverage"
              />
            </div>
          </div>
        ) : null}
        {job.sightings.length > 1 ? (
          <div className="grid gap-1.5">
            <h3 className="text-(length:--text-small) font-semibold text-foreground">
              Listed on {job.sightings.length} sites
            </h3>
            <ul className="grid gap-1 text-(length:--text-small)">
              {job.sightings.map((sighting) => (
                <li key={sighting.url}>
                  <button
                    className="text-left text-(--link) underline-offset-4 hover:underline"
                    onClick={() => openUrlInJobFinderBrowser(sighting.url)}
                    type="button"
                  >
                    {sighting.sourceLabel}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <FactList items={job.facts.responsibilities} title="What you'd do" />
        <FactList
          items={job.facts.minimumQualifications}
          title="What they ask for"
        />
        <FactList
          items={job.facts.preferredQualifications}
          title="Nice to have"
        />
        {description.length > 0 ? (
          <div className="grid gap-1.5" data-job-description>
            <h3
              className="text-(length:--text-small) font-semibold text-foreground"
            >
              About this job
            </h3>
            <div className="grid max-w-prose gap-2.5 text-(length:--text-description) leading-6 text-foreground-soft">
              {description.map((paragraph, index) => (
                <p className="whitespace-pre-line" key={index}>
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
