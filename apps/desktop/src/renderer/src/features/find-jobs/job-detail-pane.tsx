import type { TriageStage } from "@nestor/contracts";
import { ExternalLink } from "lucide-react";

import { Button } from "@renderer/components/ui/button";
import { openUrlInJobFinderBrowser } from "@renderer/features/job-finder/components/open-outside-links";
import { StatusBadge } from "@renderer/features/job-finder/components/status-badge";

import {
  LIST_DETAIL_REGION_ID,
  describeAge,
  describeFit,
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
 * The detail half of Find jobs: what the job is, why it fits or not, where
 * it is listed, and the one or two moves that make sense from its stage.
 */
export function JobDetailPane(props: {
  jobId: number | null;
  stage: TriageStage;
  actions: readonly TriageAction[];
  onMove: (to: TriageStage) => void;
}) {
  const job = useJobDetail(props.jobId);
  if (props.jobId === null) {
    return (
      <section
        aria-label="Job details"
        className="surface-panel-shell hidden min-h-0 place-items-center rounded-(--radius-panel) border border-(--surface-panel-border) p-8 text-center text-(length:--text-description) text-foreground-muted xl:grid"
        id={LIST_DETAIL_REGION_ID}
      >
        Pick a job to see it here.
      </section>
    );
  }
  if (!job) {
    return (
      <section
        aria-busy="true"
        aria-label="Job details"
        className="surface-panel-shell min-h-0 rounded-(--radius-panel) border border-(--surface-panel-border)"
        id={LIST_DETAIL_REGION_ID}
      />
    );
  }

  const fit = describeFit(job.fit?.score ?? null, job.stage);
  const posted = describeAge(job.postedAt);
  const facts = [
    job.salaryText,
    describeWorkModes(job.workModes),
    job.employmentType,
    job.seniority,
    posted ? `Posted ${posted}` : `Found ${describeAge(job.foundAt) ?? ""}`,
  ].filter(Boolean);

  return (
    <section
      aria-label="Job details"
      data-job-detail-id={job.id}
      className="surface-panel-shell flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) xl:h-full"
      id={LIST_DETAIL_REGION_ID}
    >
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
        <div className="flex flex-wrap items-center gap-2">
          {props.actions.map((action, index) => (
            <Button
              key={action.to}
              onClick={() => props.onMove(action.to)}
              size="sm"
              title={`${action.label} · ${action.key.toUpperCase()}`}
              type="button"
              variant={index === 0 ? "primary" : "outline"}
            >
              {action.label}
              <kbd className="ml-1 rounded border border-current/30 px-1 text-[10px] opacity-70">
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
      <div className="grid min-h-0 flex-1 content-start gap-6 overflow-y-auto px-6 py-5">
        {job.stageNote ? (
          <p className="rounded-(--radius-field) border border-(--surface-panel-border) bg-secondary px-3 py-2 text-(length:--text-small) text-foreground-soft">
            Hidden by the search: {job.stageNote}
          </p>
        ) : null}
        <div className="grid gap-2" data-job-fit>
          <div className="flex items-center gap-2">
            {job.fit ? (
              <span className="text-(length:--text-heading-3) font-semibold tabular-nums text-(--text-headline)">
                {job.fit.score}
              </span>
            ) : null}
            <StatusBadge tone={fit.tone}>{fit.label}</StatusBadge>
          </div>
          {job.fit?.summary ? (
            <p className="text-(length:--text-description) leading-6 text-foreground">
              {job.fit.summary}
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <FactList items={job.fit?.reasons ?? []} title="Why it fits" />
            <FactList items={job.fit?.gaps ?? []} title="What's missing" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <FactList
              items={job.fit?.role ? [job.fit.role.explanation] : []}
              title="Role"
            />
            <FactList
              items={
                job.fit?.preferences ? [job.fit.preferences.explanation] : []
              }
              title="Preferences"
            />
            <FactList
              items={job.fit?.coverage ? [job.fit.coverage.explanation] : []}
              title="Coverage"
            />
          </div>
        </div>
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
        <div className="grid gap-1.5">
          <h3 className="text-(length:--text-small) font-semibold text-foreground">
            About this job
          </h3>
          <p className="whitespace-pre-line text-(length:--text-description) leading-7 text-foreground-soft">
            {job.description}
          </p>
        </div>
      </div>
    </section>
  );
}
