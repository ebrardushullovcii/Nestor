import {
  AiBehaviorPreferenceSchema,
  type QueryJobListResult,
  type WorkspaceJobListRow,
  type WorkspaceStartupContext,
} from "@nestor/contracts";
import { SelectableRow } from "@renderer/components/ui";
import { cn } from "@renderer/lib/cn";
import { LIST_DETAIL_COLUMNS_CLASS } from "../../components/list-detail-columns";
import {
  jobFinderListRegionClassName,
  jobFinderListRowBadgeSlotClassName,
  jobFinderListRowClassName,
  jobFinderListRowLinesClassName,
  jobFinderListRowMetaClassName,
  jobFinderListRowStatusClassName,
  jobFinderListRowTitleClassName,
  jobFinderListRowTitleLineClassName,
} from "../../components/list-row";
import { ListRowSelectionCell } from "../../components/list-selection";
import { LockedScreenLayout } from "../../components/locked-screen-layout";
import { PageHeaderStack } from "../../components/page-header";
import { StatusBadge } from "../../components/status-badge";
import { readPersistedCollectionQuery } from "../../hooks/use-persisted-collection-view";
import { isNewSinceVisit, readVisit } from "../../hooks/use-since-last-visit";
import { formatJobEmployerLocationLine } from "../../lib/job-employer-location-display";
import type { LaunchReads } from "../../lib/launch-reads";
import { fitRecommendationCopy } from "../../lib/match-assessment-presentation";
import { hasPersistedDiscoveryFacetFilters } from "./discovery-results-panel";
import { readPersistedSort } from "./discovery-results-sort";
import { resolveDiscoveryListOpensWide } from "./discovery-screen";

/**
 * The page of Find jobs the person will see first, from the database, while
 * the full list still loads (ADR 0065). Only when it is provably that page:
 * Best match with no saved search text or filters, and every row in the
 * leading band of judged matches (no band heading above it, every score
 * printed as is). The read-path comparison on both owner-size copies matched
 * that page row for row. Otherwise the screen keeps its loading state.
 */
export function selectFindJobsLaunchPage(
  reads: Pick<LaunchReads, "context" | "findJobs">,
): QueryJobListResult | null {
  const { context, findJobs } = reads;
  if (!context || !findJobs) return null;
  if (readPersistedSort().field !== "fit") return null;
  if (readPersistedCollectionQuery("discovery-results").trim()) return null;
  if (hasPersistedDiscoveryFacetFilters(context.activeCampaignId)) return null;
  const page = opensWide(context) ? findJobs.wide : findJobs.focused;
  if (page.rows.length === 0) return null;
  const leadingMatches = page.rows.every(
    (row) => row.resultGroup === "matches" && row.judged,
  );
  return leadingMatches ? page : null;
}

function opensWide(context: WorkspaceStartupContext): boolean {
  const selectivity = AiBehaviorPreferenceSchema.parse(
    context.settings?.aiBehavior ?? {},
  ).jobSearch.selectivity;
  const mode =
    context.campaigns.find((plan) => plan.id === context.activeCampaignId)
      ?.mode ?? "precision";
  return resolveDiscoveryListOpensWide(selectivity, mode);
}

function fitLabel(row: WorkspaceJobListRow): string {
  return row.scoreIsUpperBound
    ? `Up to ${row.score}% fit`
    : `${row.score}% fit`;
}

/**
 * Same frame as the loaded screen: header, the search bar's space, the list
 * with its rows where the real rows land, and the details pane. Rows cannot
 * be acted on yet; the full screen replaces this in place.
 */
export function FindJobsLaunch(props: { page: QueryJobListResult }) {
  const previousVisitEnd = readVisit("discovery");
  const first = props.page.rows[0]!;
  return (
    <LockedScreenLayout
      contentClassName="xl:overflow-hidden"
      lockContentHeight
      topContent={
        <PageHeaderStack
          description="Search your job sources, then shortlist the jobs you want to apply to."
          subnav={
            <div
              aria-hidden="true"
              className="surface-panel-shell h-12 rounded-(--radius-panel) border border-(--surface-panel-border)"
            />
          }
          title="Find jobs"
        />
      }
    >
      <div
        aria-busy="true"
        className={cn(
          "grid min-h-0 min-w-0 grid-cols-1 items-stretch gap-4 xl:h-full xl:min-h-0 xl:overflow-hidden",
          LIST_DETAIL_COLUMNS_CLASS,
        )}
        data-find-jobs-launch
      >
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <section
            aria-label="Results"
            className="surface-panel-shell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) xl:h-full xl:min-h-0"
          >
            <header className="shrink-0 border-b border-(--surface-panel-border)">
              <div className="min-h-12" />
              {/* The latest search's summary line sits here in the loaded
                  list; a list with jobs always has one. */}
              <div className="px-3 pb-2">
                <div className="h-3.5" />
              </div>
            </header>
            <div
              aria-label="Job results list"
              className="overscroll-contain xl:min-h-[360px] xl:flex-1 xl:overflow-y-auto"
              data-find-jobs-launch-list
              role="region"
            >
              <ul className={cn(jobFinderListRegionClassName, "xl:min-h-full")}>
                {props.page.rows.map((row, index) => (
                  <FindJobsLaunchRow
                    isNew={isNewSinceVisit(row, previousVisitEnd)}
                    key={row.id}
                    row={row}
                    selected={index === 0}
                  />
                ))}
              </ul>
            </div>
            {/* Where the pager sits in the loaded list. */}
            <div className="h-11 shrink-0 border-t border-(--surface-panel-border)" />
          </section>
        </div>
        <section
          aria-label="Job details"
          className="surface-panel-shell hidden min-h-0 min-w-0 rounded-(--radius-panel) border border-(--surface-panel-border) p-6 xl:block"
        >
          <h2 className="min-w-0 break-words text-(length:--text-section-title) font-semibold tracking-[-0.03em] text-(--text-headline)">
            {first.title}
          </h2>
        </section>
      </div>
    </LockedScreenLayout>
  );
}

function FindJobsLaunchRow(props: {
  isNew: boolean;
  row: WorkspaceJobListRow;
  selected: boolean;
}) {
  const { row } = props;
  const recommendation =
    row.recommendation && row.recommendation !== "review_before_applying"
      ? fitRecommendationCopy[row.recommendation]
      : null;
  const employerLocationLine = formatJobEmployerLocationLine({
    company: row.company,
    location: row.location,
    canonicalUrl: row.canonicalUrl,
    separator: " • ",
  });
  return (
    <li className="relative min-w-0 pl-10">
      <ListRowSelectionCell
        checked={false}
        disabled
        label={`Select ${row.title}`}
        onToggle={() => undefined}
      />
      <SelectableRow
        aria-disabled="true"
        className={jobFinderListRowClassName}
        data-launch-job-id={row.id}
        selected={props.selected}
      >
        <div className={jobFinderListRowLinesClassName}>
          <div className={jobFinderListRowTitleLineClassName}>
            <strong
              className={jobFinderListRowTitleClassName}
              title={row.title}
            >
              {props.isNew ? (
                <span
                  className="mr-1.5 inline-block size-2 rounded-full bg-(--info-text) align-middle"
                  title="New since your last visit"
                >
                  <span className="sr-only">New: </span>
                </span>
              ) : null}
              {row.title}
            </strong>
            <div className={jobFinderListRowBadgeSlotClassName}>
              <span className="text-(length:--text-small) font-semibold tabular-nums text-(--text-headline)">
                {fitLabel(row)}
              </span>
              {recommendation ? (
                <StatusBadge tone={recommendation.tone}>
                  {recommendation.label}
                </StatusBadge>
              ) : null}
            </div>
          </div>
          <span
            className={cn(
              jobFinderListRowMetaClassName,
              "flex min-w-0 flex-nowrap items-baseline gap-x-1.5",
            )}
          >
            <span className="min-w-0 truncate font-medium">
              {employerLocationLine || "Employer not listed"}
            </span>
          </span>
          {/* The reason line arrives with the full list; it keeps its
              height so rows are one height from the start. */}
          <span
            className={cn(
              jobFinderListRowStatusClassName,
              "min-h-[1lh] text-foreground-soft",
            )}
          />
        </div>
      </SelectableRow>
    </li>
  );
}
