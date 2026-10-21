import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@renderer/components/ui/select";
import { matchesApplicationsFilter } from "./applications-screen-helpers";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  isApplicationTrackedAsSentByPerson,
  isApplicationWithdrawnByPerson,
  type ApplicationCrmStageDefinition,
  type ApplicationRecord,
  type ApplyJobResultListRow,
} from "@nestor/contracts";
import {
  applicationCrmDataForView,
  applicationCrmStageLabelForView,
  APPLICATION_CRM_STAGE_ORDER,
  APPLICATION_CRM_STAGE_NAMES,
  nextTrackerStepLabel,
  trackedHiringStageBadge,
} from "./applications-crm-model";
import type { ApplyMode } from "../../lib/apply-mode-contracts-stub";
import { resolveApplyStatePresentation } from "./apply-state";
import type { ApplyRunContext } from "./applications-recovery-state";
import { Input } from "@renderer/components/ui/input";
import { matchesCollectionSearch } from "../../components/collection-search-toolbar";
import { Button } from "@renderer/components/ui/button";
import {
  SelectableRow,
  SelectableRowLine,
} from "@renderer/components/ui/selectable-row";
import { cn } from "@renderer/lib/utils";
import { EmptyState } from "../../components/empty-state";
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
import {
  CollectionPagination,
  JOB_LIST_PAGE_SIZE,
} from "../../components/collection-pagination";
import {
  focusCollectionItem,
  getAdjacentCollectionItemId,
} from "../../lib/collection-keyboard-navigation";
import { StatusBadge } from "../../components/status-badge";
import { Link } from "react-router-dom";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import { getAttemptLabel } from "../../lib/job-finder-utils";
import {
  formatApplicationEmployerAriaLabel,
  formatApplicationEmployerLine,
} from "../../lib/job-employer-location-display";
import {
  APPLICATION_FILTER_LABELS,
  APPLICATION_FILTERS,
  formatApplicationFilterAccessibleLabel,
  type ApplicationsViewFilter,
} from "./applications-filters";
import {
  getApplicationNextStepLabel,
  getApplicationReadableNextStepLabel,
  getApplicationStagePresentation,
} from "./applications-status";

interface ApplicationsRecordsPanelProps {
  progressNow?: number | undefined;
  activeFilter: ApplicationsViewFilter;
  applicationRecords: readonly ApplicationRecord[];
  /** Stages the person named in the tracker, shown by those names. */
  customStages?: readonly ApplicationCrmStageDefinition[];
  discoveryJobs?: ReadonlyArray<{
    id: string;
    canonicalUrl: string;
    location?: string;
  }>;
  filterCounts: Record<ApplicationsViewFilter, number>;
  hasAnyApplications: boolean;
  /**
   * Older preparation history that belongs to no application record. It is
   * explained once at the end of the list, not above it.
   */
  hasUnassignedLegacyHistory?: boolean;
  searchPlanName?: string | undefined;
  hasOtherPlanApplications?: boolean | undefined;
  /**
   * What a run is doing right now for a job, by job id. A row whose
   * application is being filled in says so, instead of repeating the saved
   * "prepare when you are ready" next step from before the run started.
   */
  liveRunLinesByJobId?: ReadonlyMap<string, string>;
  /**
   * The newest run result per record, so a row reads one of the five apply
   * states (ADR 0022) from what the run recorded rather than the older
   * "Needs recovery" / "Waiting on consent" vocabulary.
   */
  latestApplyResultByRecordId?: ReadonlyMap<string, ApplyJobResultListRow>;
  /** What each result's run is doing, so a planned job is never "Filling in". */
  readApplyRunContext?: (
    result: ApplyJobResultListRow | null,
  ) => ApplyRunContext | null;
  /** The mode chosen in Settings; decides what a finished fill means. */
  applyMode?: ApplyMode;
  onFilterChange: (filter: ApplicationsViewFilter) => void;
  onSelectRecord: (recordId: string) => void;
  selectedRecord: ApplicationRecord | null;
}

export function ApplicationsRecordsPanel({
  activeFilter,
  applicationRecords: sourceRecords,
  customStages,
  progressNow,
  discoveryJobs = [],
  hasAnyApplications,
  hasUnassignedLegacyHistory = false,
  searchPlanName,
  hasOtherPlanApplications,
  liveRunLinesByJobId,
  latestApplyResultByRecordId,
  readApplyRunContext,
  onFilterChange,
  onSelectRecord,
  selectedRecord,
}: ApplicationsRecordsPanelProps) {
  const [query, setQuery] = useState("");
  const [pipelineStage, setPipelineStage] = useState("all");
  function stateFor(record: ApplicationRecord) {
    const result = latestApplyResultByRecordId?.get(record.id) ?? null;
    return result
      ? resolveApplyStatePresentation({
          ...(progressNow === undefined ? {} : { now: progressNow }),
          mode:
            record.automationMode === "autonomous_submit"
              ? "apply_for_me"
              : "fill_only",
          result,
          run: readApplyRunContext?.(result) ?? null,
          recordCrm: record.crm,
          recordLatestBlocker: record.latestBlocker,
          recordLastActionLabel: record.lastActionLabel,
          pendingQuestionCount: Math.max(
            0,
            record.questionSummary.total - record.questionSummary.answered,
          ),
          recordFailure:
            record.lastAttemptState === "failed"
              ? {
                  lastActionLabel: record.lastActionLabel,
                  lastUpdatedAt: record.lastUpdatedAt,
                }
              : null,
        })
      : null;
  }
  const searchedRecords = sourceRecords.filter(
    (record) =>
      !record.crm?.archivedAt &&
      (pipelineStage === "all" ||
        applicationCrmDataForView(record).stage === pipelineStage) &&
      matchesCollectionSearch(query, [
        record.title,
        record.company,
        applicationCrmStageLabelForView(record, customStages),
      ]),
  );
  const filterCounts = Object.fromEntries(
    APPLICATION_FILTERS.map((filter) => [
      filter,
      searchedRecords.filter((record) =>
        matchesApplicationsFilter(record, filter, stateFor(record)?.kind),
      ).length,
    ]),
  ) as Record<ApplicationsViewFilter, number>;
  const applicationRecords = searchedRecords.filter((record) =>
    matchesApplicationsFilter(record, activeFilter, stateFor(record)?.kind),
  );
  const recordCount = applicationRecords.length;
  const filterGroupId = useId();
  const [page, setPage] = useState(1);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const recordsRegionRef = useRef<HTMLUListElement | null>(null);
  const pageCount = Math.max(1, Math.ceil(recordCount / JOB_LIST_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const relatedJobsById = useMemo(
    () => new Map(discoveryJobs.map((job) => [job.id, job] as const)),
    [discoveryJobs],
  );
  const selectedRecordId = selectedRecord?.id ?? null;
  const selectedRecordIndex = useMemo(
    () =>
      selectedRecordId
        ? applicationRecords.findIndex(
            (record) => record.id === selectedRecordId,
          )
        : -1,
    [applicationRecords, selectedRecordId],
  );
  useEffect(() => {
    setPage(1);
  }, [activeFilter, query, pipelineStage]);
  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, pageCount));
  }, [pageCount]);
  const lastPagedSelection = useRef<string | null>(null);
  useEffect(() => {
    if (lastPagedSelection.current === selectedRecordId) return;
    if (selectedRecordIndex < 0) return;
    lastPagedSelection.current = selectedRecordId;
    setPage(Math.floor(selectedRecordIndex / JOB_LIST_PAGE_SIZE) + 1);
  }, [selectedRecordId, selectedRecordIndex]);
  useEffect(() => {
    if (!pendingFocusId) return;
    // Scoped to this panel's list region so the deferred frame can never
    // land focus in another surface's rows.
    focusCollectionItem(pendingFocusId, { region: recordsRegionRef.current });
    setPendingFocusId(null);
  }, [currentPage, pendingFocusId]);
  const handleRecordRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, recordId: string) => {
      const nextRecordId = getAdjacentCollectionItemId(
        applicationRecords.map((record) => record.id),
        recordId,
        event.key,
      );
      if (!nextRecordId) return;
      event.preventDefault();
      const nextIndex = applicationRecords.findIndex(
        (record) => record.id === nextRecordId,
      );
      setPage(Math.floor(nextIndex / JOB_LIST_PAGE_SIZE) + 1);
      onSelectRecord(nextRecordId);
      setPendingFocusId(nextRecordId);
    },
    [applicationRecords, onSelectRecord],
  );
  // A filter is shown only when choosing it would change the list: a view
  // that holds some but not all of the applications, plus the active one so
  // the current choice never disappears. "All 4" beside "Waiting on you 0"
  // offered two buttons that could not change anything.
  const nonArchivedRecords = useMemo(
    () => sourceRecords.filter((record) => !record.crm?.archivedAt),
    [sourceRecords],
  );
  // Judged on every unarchived application, not the searched ones, so the
  // chips do not come and go while the person types.
  const choiceCounts = Object.fromEntries(
    APPLICATION_FILTERS.map((filter) => [
      filter,
      nonArchivedRecords.filter((record) =>
        matchesApplicationsFilter(record, filter, stateFor(record)?.kind),
      ).length,
    ]),
  ) as Record<ApplicationsViewFilter, number>;
  const filterChoices = APPLICATION_FILTERS.filter(
    (filterOption) =>
      filterOption !== "all" &&
      (filterOption === activeFilter ||
        (choiceCounts[filterOption] > 0 &&
          choiceCounts[filterOption] < choiceCounts.all)),
  );
  const visibleFilters: readonly ApplicationsViewFilter[] =
    filterChoices.length > 0 || activeFilter !== "all"
      ? ["all", ...filterChoices]
      : [];
  // The stage picker lists only the stages the applications are in, and only
  // shows when they are in more than one.
  const presentStages = useMemo(
    () =>
      new Set(
        nonArchivedRecords.map(
          (record) => applicationCrmDataForView(record).stage,
        ),
      ),
    [nonArchivedRecords],
  );
  const stageOptions = APPLICATION_CRM_STAGE_ORDER.filter(
    (stage) => presentStages.has(stage) || stage === pipelineStage,
  );
  const showsStagePicker = presentStages.size > 1 || pipelineStage !== "all";
  const showsSearch = nonArchivedRecords.length > 1 || query.length > 0;
  const showsToolbar =
    showsSearch || showsStagePicker || visibleFilters.length > 0;
  const pagedRecords = useMemo(
    () =>
      applicationRecords.slice(
        (currentPage - 1) * JOB_LIST_PAGE_SIZE,
        currentPage * JOB_LIST_PAGE_SIZE,
      ),
    [applicationRecords, currentPage],
  );

  return (
    // `xl:h-full` left a short list as a tall empty bordered rectangle beside
    // a scrolling detail pane. Capping instead of filling lets the panel end
    // where its content ends while a long list still scrolls inside it, and
    // `sticky`/`self-start` keep it pinned to the top of its column instead of
    // riding away with any surrounding scroll and leaving a dead half-screen.
    // The column is sized by its content and capped by the viewport, not
    // stretched to it: a 470x780 panel holding one 100px card left ~670px of
    // empty space beside a detail pane that needed the room.
    <section className="surface-panel-shell @container/tracker relative flex min-w-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) xl:sticky xl:top-0 xl:max-h-full xl:min-h-0 xl:self-start">
      {/* One toolbar row. The page title and the "All" chip already say what
          this list is and how many it holds, so the panel repeats neither.
          A narrow column wraps the chips onto a second, shorter line. */}
      {hasAnyApplications && showsToolbar ? (
        <div
          aria-labelledby={filterGroupId}
          className="flex min-h-12 w-full min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b border-(--surface-panel-border) px-3 py-2"
          data-applications-list-toolbar
          role="group"
        >
          <span className="sr-only" id={filterGroupId}>
            Application filters
          </span>
          {showsSearch ? (
            <Input
              size="toolbar"
              className="min-w-40 flex-1"
              aria-label="Search applications"
              placeholder="Search applications"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {showsStagePicker ? (
            <Select value={pipelineStage} onValueChange={setPipelineStage}>
              <SelectTrigger
                aria-label="Hiring stage"
                size="toolbar"
                className="w-36"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stages</SelectItem>
                {stageOptions.map((stage) => (
                  <SelectItem key={stage} value={stage}>
                    {APPLICATION_CRM_STAGE_NAMES[stage]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {visibleFilters.map((filterOption) => (
            <Button
              aria-label={formatApplicationFilterAccessibleLabel(
                filterOption,
                filterCounts[filterOption],
              )}
              aria-pressed={activeFilter === filterOption}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full ring-inset focus-visible:ring-inset",
                activeFilter === filterOption
                  ? null
                  : "border-(--border-strong)",
              )}
              key={filterOption}
              onClick={() => onFilterChange(filterOption)}
              size="xs"
              type="button"
              variant={activeFilter === filterOption ? "secondary" : "ghost"}
            >
              {APPLICATION_FILTER_LABELS[filterOption]}
              <span className="rounded-full border border-current/15 px-1.5 py-px font-mono text-[10px] font-bold uppercase leading-none tracking-(--tracking-badge)">
                {filterCounts[filterOption]}
              </span>
            </Button>
          ))}
        </div>
      ) : null}
      {applicationRecords.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-start p-6">
          {!hasAnyApplications && hasOtherPlanApplications && searchPlanName ? (
            <EmptyState
              title={`No applications in ${searchPlanName}`}
              description="Your applications in other search plans are still saved."
            >
              <Button asChild size="sm" type="button" variant="primary">
                <Link to={`${JOB_FINDER_ROUTE_PATHS.applications}?scope=all`}>
                  Show all applications
                </Link>
              </Button>
            </EmptyState>
          ) : hasAnyApplications ? (
            <EmptyState
              title="No applications in this view"
              description="Try another filter to review the rest of your application history."
            />
          ) : (
            // The two ways out belong inside the empty state, not stranded
            // under it: a dashed box with nothing in it read as the end of the
            // panel, and its actions read as unrelated page furniture.
            <EmptyState
              title="Nothing applied to yet"
              description="Press Apply on a shortlisted job and it shows up here, with what Job Finder did and what it needs from you."
            >
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button asChild size="sm" type="button" variant="primary">
                  <Link to={JOB_FINDER_ROUTE_PATHS.reviewQueue}>
                    Open Shortlisted
                  </Link>
                </Button>
                <Button
                  asChild
                  className="border-(--border-strong)"
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Link to={JOB_FINDER_ROUTE_PATHS.discovery}>Find jobs</Link>
                </Button>
              </div>
            </EmptyState>
          )}
        </div>
      ) : (
        <ul
          aria-label="Applications"
          className={cn(
            jobFinderListRegionClassName,
            "min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
          )}
          data-locked-pane-scroll-region
          ref={recordsRegionRef}
        >
          {pagedRecords.map((record) => {
            // One of the five apply states when a run has recorded one; the
            // older stage words only for a record no run has touched yet.
            const latestResult =
              latestApplyResultByRecordId?.get(record.id) ?? null;
            const applyState = latestResult
              ? resolveApplyStatePresentation({
                  ...(progressNow === undefined ? {} : { now: progressNow }),
                  recordCrm: record.crm,
                  recordLatestBlocker: record.latestBlocker,
                  mode:
                    record.automationMode === "autonomous_submit"
                      ? "apply_for_me"
                      : "fill_only",
                  result: latestResult,
                  run: readApplyRunContext?.(latestResult) ?? null,
                  pendingQuestionCount:
                    record.questionSummary.total -
                    record.questionSummary.answered,
                  recordLastActionLabel: record.lastActionLabel,
                  recordFailure:
                    record.lastAttemptState === "failed"
                      ? {
                          lastActionLabel: record.lastActionLabel,
                          lastUpdatedAt: record.lastUpdatedAt,
                        }
                      : null,
                })
              : null;
            const hiringStage = trackedHiringStageBadge(record, customStages);
            const stage = hiringStage
              ? hiringStage
              : applyState
                ? {
                    label: applyState.title,
                    tone:
                      applyState.kind === "applied"
                        ? ("positive" as const)
                        : applyState.cancelledByPerson
                          ? ("muted" as const)
                          : applyState.formClosed
                            ? ("warning" as const)
                            : applyState.kind === "could_not_apply"
                            ? ("critical" as const)
                            : applyState.kind === "needs_you"
                              ? ("warning" as const)
                              : ("active" as const),
                  }
                : getApplicationStagePresentation(record);
            // One status word per row. The stage badge is it; a second badge
            // restating the same state a different way ("Needs follow-up"
            // beside "Needs you") is the duplicate pill that made every row
            // read as two conflicting states. The attempt detail stays in the
            // panel and in the row's assistive description.
            const attemptLabel =
              applyState?.title ?? getAttemptLabel(record.lastAttemptState);
            const liveLine =
              applyState && applyState.kind !== "filling_in"
                ? null
                : (liveRunLinesByJobId?.get(record.jobId) ?? null);
            // A job its batch never reached has one next step; the record's
            // own label still named the approval that batch started from.
            const preparationNextStep =
              applyState?.kind === "applied"
                ? "View application"
                : ((applyState?.kind === "could_not_apply"
                    ? applyState.actionLabel
                    : null) ??
                  applyState?.questionsLeftLabel ??
                  getApplicationReadableNextStepLabel(
                    getApplicationNextStepLabel(record),
                  ) ??
                  getApplicationNextStepLabel(record));
            // Sent or withdrawn, by the person's own record: what comes next
            // is on the tracker, not the preparation step the run left behind.
            const nextStepLabel =
              isApplicationTrackedAsSentByPerson(record.crm) ||
              isApplicationWithdrawnByPerson(record.crm)
                ? nextTrackerStepLabel(record)
                : preparationNextStep;
            // A form that closed before a send was seen is not a failed
            // application, whatever stage the run left on the tracker.
            const rowStageLabel =
              applyState?.kind === "applied" || applyState?.formClosed
                ? stage.label
                : applicationCrmStageLabelForView(record, customStages);
            const recordStateDescriptionId = `applications-record-${record.id}-state-description`;
            const relatedJob = relatedJobsById.get(record.jobId);
            const employerLine = [
              formatApplicationEmployerLine({
                company: record.company,
                ...(relatedJob?.canonicalUrl
                  ? { canonicalUrl: relatedJob.canonicalUrl }
                  : {}),
              }),
              relatedJob?.location,
            ]
              .filter(Boolean)
              .join(" · ");
            const employerAriaLabel = [
              formatApplicationEmployerAriaLabel({
                title: record.title,
                company: record.company,
                ...(relatedJob?.canonicalUrl
                  ? { canonicalUrl: relatedJob.canonicalUrl }
                  : {}),
              }),
              relatedJob?.location,
            ]
              .filter(Boolean)
              .join(" · ");

            return (
              <li key={record.id} className="min-w-0">
                {/* Shared selectable-row primitive: identical box metrics in
                    both states, selection carried by a tint plus an inset
                    accent bar, and every content line always occupying its
                    slot. Selecting row 1 then row 2 used to move every row
                    below by tens of pixels. */}
                <SelectableRow
                  aria-describedby={recordStateDescriptionId}
                  className={jobFinderListRowClassName}
                  aria-keyshortcuts="ArrowUp ArrowDown Home End"
                  aria-label={`View details for ${employerAriaLabel}`}
                  data-collection-item-id={record.id}
                  onClick={() => onSelectRecord(record.id)}
                  onKeyDown={(event) =>
                    handleRecordRowKeyDown(event, record.id)
                  }
                  selected={selectedRecord?.id === record.id}
                >
                  <div className={jobFinderListRowLinesClassName}>
                    {/* Title line, with the one badge slot trailing it - the
                        same slot Find jobs and Shortlisted use. The row's own
                        description below already reads "Stage <label>", so no
                        second "Stage" label is announced beside the badge. */}
                    <div className={jobFinderListRowTitleLineClassName}>
                      <strong className={jobFinderListRowTitleClassName}>
                        {record.title}
                      </strong>
                      <div className={jobFinderListRowBadgeSlotClassName}>
                        <StatusBadge
                          tone={
                            liveLine && !applyState?.plannedStanding
                              ? "active"
                              : stage.tone
                          }
                        >
                          {rowStageLabel}
                        </StatusBadge>
                      </div>
                    </div>
                    <SelectableRowLine
                      className={jobFinderListRowMetaClassName}
                    >
                      {employerLine}
                    </SelectableRowLine>
                    {/* One status line only: the stage badge already names the
                        state, so the latest-activity sentence (which often
                        repeated this exact next step) is not shown twice. */}
                    <SelectableRowLine
                      className={cn(
                        jobFinderListRowStatusClassName,
                        "font-medium text-primary",
                      )}
                    >
                      {liveLine
                        ? `Now: ${liveLine}`
                        : nextStepLabel
                          ? `Next: ${nextStepLabel}`
                          : null}
                    </SelectableRowLine>
                  </div>
                  <span className="sr-only" id={recordStateDescriptionId}>
                    {/* The visible badge is deduplicated; the description
                        still names a failed attempt for assistive tech, since
                        "Needs recovery" alone does not say why. */}
                    {attemptLabel &&
                    !(
                      rowStageLabel === "Needs you" &&
                      attemptLabel === "Needs follow-up"
                    )
                      ? `Status ${rowStageLabel}. Preparation attempt ${attemptLabel}.`
                      : `Status ${rowStageLabel}.`}
                  </span>
                </SelectableRow>
              </li>
            );
          })}
        </ul>
      )}
      {hasUnassignedLegacyHistory ? (
        <p className="border-t border-(--surface-panel-border) px-3 py-2 text-(length:--text-small) leading-5 text-foreground-muted">
          Unassigned legacy preparation history is retained for audit only. It
          is not attached to an application record and has no action controls.
        </p>
      ) : null}
      {recordCount > 0 ? (
        <CollectionPagination
          itemLabel="applications"
          onPageChange={setPage}
          page={currentPage}
          pageSize={JOB_LIST_PAGE_SIZE}
          totalCount={recordCount}
        />
      ) : null}
    </section>
  );
}
