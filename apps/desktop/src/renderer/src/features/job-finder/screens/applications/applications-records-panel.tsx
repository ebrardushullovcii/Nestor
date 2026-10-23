import { APPLICATION_WORK_PAUSED_REASON } from "../../lib/application-work-paused";
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
  type ApplicationCrmMutationInput,
  type ApplicationCrmStageDefinition,
  type ApplicationRecord,
  type ApplyJobResultListRow,
  type JobFinderExactApplicationTarget,
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
import {
  pageNeedsPreparing,
  useApplicationPageStates,
} from "../../hooks/use-application-page-states";
import type { ApplyRunContext } from "./applications-recovery-state";
import {
  clearSettledApplicationFormOpenStates,
  describeFormOpenOutcome,
  formOpenPhaseLabel,
  openApplicationForm,
  resolveRowFormAction,
  useApplicationFormOpenStates,
  type FinishInBrowserHandler,
} from "./application-form-open";
import { getApplyResultDestinationUrl } from "./applications-detail-panel-helpers";
import { describeReopenPhase } from "../../lib/job-finder-browser-handoff-copy";
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
import {
  handleListSearchEscape,
  LIST_SEARCH_ATTRIBUTE,
} from "../../lib/list-search-focus";
import {
  listingRowMenuEntries,
  openRowContextMenu,
  type RowMenuEntry,
} from "../../lib/row-context-menu";
import { resolveApplicationMoveBack } from "./application-move-back";
import {
  isAnyString,
  useRememberedString,
} from "../../hooks/use-remembered-string";
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
  /** The mode chosen in Settings; a retry runs in it and is named for it. */
  applyMode?: ApplyMode;
  /**
   * The detail panel's own ways to open a form, so a row's Open form shows
   * the same steps and the same outcome as the panel.
   */
  onFinishInBrowser?: FinishInBrowserHandler;
  onStartApplyCopilot?: (input: JobFinderExactApplicationTarget) => void;
  isApplyPending?: boolean;
  /** All work is paused: a row's Try again waits for Continue. */
  applicationWorkPaused?: boolean;
  /** Applications -> Shortlisted for an unsent application. */
  onReturnToShortlist?: (record: ApplicationRecord) => void;
  /** Mark withdrawn and Archive, offered on a sent application's row. */
  onMutateApplicationCrm?: (
    command: ApplicationCrmMutationInput,
  ) => Promise<void>;
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
  applyMode,
  onFinishInBrowser,
  onStartApplyCopilot,
  isApplyPending = false,
  applicationWorkPaused = false,
  onReturnToShortlist,
  onMutateApplicationCrm,
  onFilterChange,
  onSelectRecord,
  selectedRecord,
}: ApplicationsRecordsPanelProps) {
  const formOpenStates = useApplicationFormOpenStates();
  // The record whose Prepare again was pressed here, until its run starts.
  const [preparingRecordId, setPreparingRecordId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!isApplyPending) setPreparingRecordId(null);
  }, [isApplyPending]);
  useEffect(() => clearSettledApplicationFormOpenStates, []);
  // Kept when moving to another screen and back, and after a restart.
  const [query, setQuery] = useRememberedString(
    "applications.query",
    "",
    isAnyString,
  );
  const [pipelineStage, setPipelineStage] = useRememberedString(
    "applications.stage",
    "all",
    isAnyString,
  );
  const latestResults = useMemo(
    () => [...(latestApplyResultByRecordId?.values() ?? [])],
    [latestApplyResultByRecordId],
  );
  const pageStates = useApplicationPageStates(latestResults);
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
          pageNeedsPreparing: pageNeedsPreparing(pageStates.get(result.id)),
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
    // The list fills its column like Find jobs and Shortlisted, so the three
    // list screens have the same frame and the pager sits in the same place.
    // A panel that ended under its last row made Applications look like a
    // different kind of page.
    <section className="surface-panel-shell @container/tracker relative flex min-w-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) xl:h-full xl:min-h-0">
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
              title="Search this list (/)"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) =>
                handleListSearchEscape(event, query, setQuery)
              }
              {...{ [LIST_SEARCH_ATTRIBUTE]: "" }}
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
                  ...(applyMode ? { nextRunMode: applyMode } : {}),
                  result: latestResult,
                  run: readApplyRunContext?.(latestResult) ?? null,
                  pageNeedsPreparing: pageNeedsPreparing(
                    pageStates.get(latestResult.id),
                  ),
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
            const formAction =
              latestResult && applyState
                ? resolveRowFormAction({
                    result: latestResult,
                    applyState,
                    canOpen: Boolean(onFinishInBrowser),
                    canPrepare: Boolean(onStartApplyCopilot),
                  })
                : null;
            const formOpenState = latestResult
              ? (formOpenStates.get(latestResult.id) ?? null)
              : null;
            const formOpenPhase =
              formAction?.kind === "prepare"
                ? isApplyPending && preparingRecordId === record.id
                  ? describeReopenPhase("opening")
                  : null
                : formOpenPhaseLabel(formOpenState);
            const formOpenOutcome =
              formAction?.kind === "open" &&
              formOpenState &&
              "outcome" in formOpenState
                ? formOpenState.outcome
                : null;
            const runFormAction = () => {
              if (!formAction || !latestResult || formOpenPhase) return;
              if (formAction.kind === "prepare") {
                if (applicationWorkPaused) return;
                setPreparingRecordId(record.id);
                onStartApplyCopilot?.({
                  jobId: record.jobId,
                  applicationRecordId: record.id,
                });
                return;
              }
              if (!onFinishInBrowser) return;
              void openApplicationForm(onFinishInBrowser, {
                jobId: latestResult.jobId,
                resultId: latestResult.id,
                runId: latestResult.runId,
                applicationRecordId:
                  latestResult.applicationRecordId ?? record.id,
                destinationUrl: getApplyResultDestinationUrl(
                  latestResult.privacyReceipt,
                ),
              });
            };
            // One way back per row: an unsent application returns to
            // Shortlisted; a sent one stays, and the menu says why.
            const moveBack = resolveApplicationMoveBack(
              record,
              applyState?.kind,
            );
            const mutateCrm = (
              mutation: ApplicationCrmMutationInput["mutation"],
            ) =>
              onMutateApplicationCrm?.({
                applicationRecordId: record.id,
                expectedRevision: applicationCrmDataForView(record).revision,
                mutation,
              });
            const moveBackMenu: RowMenuEntry[] =
              moveBack === "to_shortlisted" && onReturnToShortlist
                ? [
                    "separator",
                    {
                      id: "move-back-to-shortlisted",
                      label: "Move back to Shortlisted",
                      run: () => onReturnToShortlist(record),
                    },
                  ]
                : moveBack === "sent" && onMutateApplicationCrm
                  ? [
                      "separator",
                      {
                        id: "sent-stays",
                        label: "It was sent, so it cannot move back",
                        enabled: false,
                        run: () => undefined,
                      },
                      {
                        id: "mark-withdrawn",
                        label: "Mark withdrawn",
                        run: () =>
                          mutateCrm({
                            type: "set_stage",
                            stage: "withdrawn",
                            customStageId: null,
                            note: null,
                          }),
                      },
                      {
                        id: "archive",
                        label: "Archive",
                        run: () =>
                          mutateCrm({ type: "set_archived", archived: true }),
                      },
                    ]
                  : [];
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
                  as="div"
                  className={jobFinderListRowClassName}
                  onContextMenu={(event) =>
                    openRowContextMenu(event, [
                      {
                        id: "open",
                        label: "Open",
                        run: () => onSelectRecord(record.id),
                      },
                      ...(formAction
                        ? [
                            {
                              id: "open-form",
                              label: formAction.label,
                              run: runFormAction,
                            },
                          ]
                        : []),
                      ...moveBackMenu,
                      ...listingRowMenuEntries(relatedJob?.canonicalUrl),
                    ])
                  }
                  selected={selectedRecord?.id === record.id}
                >
                  <button
                    aria-current={
                      selectedRecord?.id === record.id ? "true" : undefined
                    }
                    aria-describedby={recordStateDescriptionId}
                    aria-keyshortcuts="ArrowUp ArrowDown Home End"
                    aria-label={`View details for ${employerAriaLabel}`}
                    className={cn(
                      jobFinderListRowLinesClassName,
                      "w-full text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
                    )}
                    data-collection-item-id={record.id}
                    onClick={() => onSelectRecord(record.id)}
                    onKeyDown={(event) =>
                      handleRecordRowKeyDown(event, record.id)
                    }
                    type="button"
                  >
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
                        repeated this exact next step) is not shown twice.
                        Opening the form from this row reports here, in the
                        same words the detail panel uses. */}
                    {formOpenPhase ? (
                      <SelectableRowLine
                        className={cn(
                          jobFinderListRowStatusClassName,
                          "flex items-center gap-2 pr-28 text-foreground-soft",
                        )}
                        role="status"
                      >
                        <span
                          aria-hidden="true"
                          className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none"
                        />
                        <span className="min-w-0 truncate">
                          {formOpenPhase}
                        </span>
                      </SelectableRowLine>
                    ) : formOpenOutcome && applyState ? (
                      <SelectableRowLine
                        className={cn(
                          jobFinderListRowStatusClassName,
                          "pr-28",
                          formOpenOutcome.kind === "opened_application_page"
                            ? "text-foreground-soft"
                            : "text-(--warning-text)",
                        )}
                        data-handoff-outcome={formOpenOutcome.kind}
                        role="status"
                        title={describeFormOpenOutcome(formOpenOutcome, {
                          readyToSend: applyState.kind === "ready_to_send",
                        })}
                      >
                        {describeFormOpenOutcome(formOpenOutcome, {
                          readyToSend: applyState.kind === "ready_to_send",
                        })}
                      </SelectableRowLine>
                    ) : (
                      <SelectableRowLine
                        className={cn(
                          jobFinderListRowStatusClassName,
                          "font-medium text-primary",
                          formAction ? "pr-28" : null,
                        )}
                      >
                        {/* The button beside this line already names the
                            step; "Next: Apply again" next to "Apply again"
                            said it twice. */}
                        {liveLine
                          ? `Now: ${liveLine}`
                          : formAction?.kind === "prepare" &&
                              applicationWorkPaused
                            ? APPLICATION_WORK_PAUSED_REASON
                            : nextStepLabel &&
                                nextStepLabel !== formAction?.label
                              ? `Next: ${nextStepLabel}`
                              : null}
                      </SelectableRowLine>
                    )}
                  </button>
                  {formAction ? (
                    <Button
                      className="absolute right-4 bottom-2.5"
                      data-testid="applications-row-form-action"
                      disabled={
                        formOpenPhase !== null ||
                        (formAction.kind === "prepare" && applicationWorkPaused)
                      }
                      onClick={runFormAction}
                      title={
                        formAction.kind === "prepare" && applicationWorkPaused
                          ? APPLICATION_WORK_PAUSED_REASON
                          : undefined
                      }
                      pending={formOpenPhase !== null}
                      size="xs"
                      type="button"
                      variant="secondary"
                    >
                      {formAction.label}
                    </Button>
                  ) : null}
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
