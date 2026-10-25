import type { WorkspaceListCounts } from "@nestor/contracts";
import { PageHeaderStack } from "../../components/page-header";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import { readRememberedNextStepHeight } from "./home-next-step-size";

/**
 * Home while the full workspace still loads: the same header, an empty Next
 * step card and the "Where you are" tiles with their real counts, read from
 * the database (ADR 0065). The full Home replaces it in place; each block
 * keeps its size and position, so nothing moves and no number changes.
 */
export function JobSearchHomeLaunch(props: {
  counts: WorkspaceListCounts;
  onNavigate: (route: string) => void;
}) {
  const stages = [
    {
      id: "discovery",
      label: "Find jobs",
      count: props.counts.discovery,
      route: JOB_FINDER_ROUTE_PATHS.discovery,
    },
    {
      id: "review-queue",
      label: "Shortlisted",
      count: props.counts.shortlisted,
      route: JOB_FINDER_ROUTE_PATHS.reviewQueue,
    },
    {
      id: "applications",
      label: "Applications",
      count: props.counts.applications,
      route: JOB_FINDER_ROUTE_PATHS.applications,
    },
  ];
  const showStages = stages.some((stage) => stage.count > 0);
  // The real card is often taller than this frame; holding its last height
  // keeps the tiles where they will be.
  const nextStepHeight = readRememberedNextStepHeight();

  return (
    <section
      className="grid min-w-0 max-w-[76rem] grid-cols-[minmax(0,1fr)] gap-5 pb-8 [&>[data-page-header-stack]]:-mb-2"
      data-home-launch
    >
      <PageHeaderStack
        description="Your search, shortlisted jobs, and applications."
        // The status line is there on the full Home; a blank one keeps the
        // card below where it will be.
        statusItems={[{ id: "run-summary", text: " " }]}
        title="Home"
      />
      <section
        aria-hidden="true"
        className="surface-panel-shell grid min-w-0 content-start gap-3 rounded-(--radius-panel) border border-primary/40 bg-primary/10 p-5"
        data-testid="home-next-step-launch"
        style={nextStepHeight ? { minHeight: nextStepHeight } : undefined}
      >
        <p className="text-(length:--text-small) font-semibold leading-5 text-muted-foreground">
          Next step
        </p>
        <div className="h-7 w-72 max-w-full rounded bg-(--surface-panel-raised)" />
        <div className="h-5 w-full max-w-[52ch] rounded bg-(--surface-panel-raised)" />
        <div className="h-11 w-40 rounded-(--radius-button) bg-(--surface-panel-raised)" />
      </section>
      {showStages ? (
        <nav
          aria-label="Where you are"
          className="grid min-w-0 gap-2 sm:grid-cols-3"
          data-testid="home-pipeline"
        >
          {stages.map((stage) => (
            <button
              className="surface-panel-shell grid min-w-0 content-start gap-0.5 rounded-(--radius-panel) border border-(--surface-panel-border) px-4 py-3 text-left outline-none transition-colors hover:border-(--control-border-hover) hover:bg-secondary/35 focus-visible:ring-2 focus-visible:ring-ring"
              data-home-stage={stage.id}
              key={stage.id}
              onClick={() => props.onNavigate(stage.route)}
              type="button"
            >
              <span className="text-(length:--text-small) text-foreground-soft">
                {stage.label}
              </span>
              <span className="text-(length:--text-heading-2) font-semibold tabular-nums leading-tight text-(--text-headline)">
                {stage.count}
              </span>
              {/* The detail line arrives with the full workspace. */}
              <span
                aria-hidden="true"
                className="min-w-0 break-words text-xs text-foreground-muted"
              >
                {" "}
              </span>
            </button>
          ))}
        </nav>
      ) : null}
    </section>
  );
}
