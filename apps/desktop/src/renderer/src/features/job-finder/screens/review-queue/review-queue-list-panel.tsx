import { estimateResumeBatchMinutesLeft } from "@nestor/contracts";
import type { ReviewQueueItem, TailoredAssetSummary } from "@nestor/contracts";
import { Button } from "@renderer/components/ui";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { cn } from "@renderer/lib/cn";
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  CollectionPagination,
  JOB_LIST_PAGE_SIZE,
} from "../../components/collection-pagination";
import {
  CollectionNoMatches,
  CollectionSearchToolbar,
  matchesCollectionSearch,
} from "../../components/collection-search-toolbar";
import { EmptyState } from "../../components/empty-state";
import { formatJobEmployerLocationLine } from "../../lib/job-employer-location-display";
import { jobFinderListRegionClassName } from "../../components/list-row";
import { usePersistedCollectionView } from "../../hooks/use-persisted-collection-view";
import { useStableCallback } from "../../hooks/use-stable-callback";
import { ReviewQueueRow } from "./review-queue-list-row";
import {
  applySelectionRange,
  ListPageCheckbox,
} from "../../components/list-selection";
import { useAssistantContextSource } from "../../assistant/assistant-provider";
import { buildListContext } from "../../assistant/assistant-context-capture";
import { stripInternalCodeParenthetical } from "./review-queue-mission-panel-helpers";
import {
  focusCollectionItem,
  getAdjacentCollectionItemId,
} from "../../lib/collection-keyboard-navigation";
import { Link } from "react-router-dom";
import { buildJobFinderContextRoute } from "../../lib/job-finder-context-navigation";
import {
  APPLICATION_PREPARATION_BATCH_LIMIT,
  describeQueueItemResumeLevel,
  describeTailoredDraftPreparationBlocker,
  getReviewQueueResumePolicyCaption,
  getReviewQueueRowCaption,
  getReviewQueueWorkflowStatus,
  findPossibleDuplicateJobIds,
  getShortlistStatusFilter,
  getTailoredDraftPreparationResultMessage,
  isQueueStageReady,
  isTailoredDraftPreparationEligible,
  SHORTLIST_STATUS_FILTER_LABELS,
  type ShortlistStatusFilter,
  type TailoredDraftPreparationViewState,
} from "./review-queue-status";

interface ReviewQueueListPanelProps {
  campaignId?: string;
  draftPreparation?: TailoredDraftPreparationViewState;
  isJobPending: (jobId: string) => boolean;
  /** Writes missing first resumes for the chosen jobs, or all eligible jobs. */
  onPrepareTailoredDrafts?: (jobIds?: readonly string[]) => void;
  /** Starts the application for every job whose resume is ready. */
  onApplyToAllReady?: (readyCount: number) => void;
  /** What Apply to all does in the mode saved in Settings, in one sentence. */
  applyAllOutcome?: string | null;
  isApplyToAllPending?: boolean;
  applicationBatchLimit?: number;
  onOpenSafeguards?: () => void;
  /** A safeguard holding every application start back, in plain words. */
  safeguardBlocker?: string | null;
  onSelectItem: (jobId: string) => void;
  /**
   * Opens a job without scrolling to it, for when a status tab or the search
   * leaves the open job out of the list. Defaults to `onSelectItem`.
   */
  onShowItem?: (jobId: string) => void;
  /** Moves the given jobs back to Find jobs. */
  onRemoveJobs?: (jobIds: readonly string[]) => Promise<void>;
  onStopTailoredDraftPreparation?: () => void;
  /**
   * Jobs whose application is already prepared. They stop counting as ready
   * to apply.
   */
  preparedJobIds?: ReadonlySet<string>;
  applicationPreparingJobIds?: ReadonlySet<string>;
  queue: readonly ReviewQueueItem[];
  selectedItem: ReviewQueueItem | null;
  tailoredAssets?: readonly TailoredAssetSummary[] | undefined;
}

export function ReviewQueueListPanel({
  campaignId = "",
  draftPreparation = {
    attemptedCount: 0,
    completedCount: 0,
    currentIndex: null,
    eligibleRemainingCount: 0,
    failedCount: 0,
    status: "idle",
    totalCount: 0,
  },
  isJobPending,
  onPrepareTailoredDrafts = () => undefined,
  onApplyToAllReady,
  applyAllOutcome = null,
  isApplyToAllPending = false,
  applicationBatchLimit = APPLICATION_PREPARATION_BATCH_LIMIT,
  onOpenSafeguards,
  safeguardBlocker = null,
  onSelectItem,
  onShowItem = onSelectItem,
  onRemoveJobs,
  onStopTailoredDraftPreparation = () => undefined,
  preparedJobIds,
  applicationPreparingJobIds,
  queue,
  selectedItem,
  tailoredAssets,
}: ReviewQueueListPanelProps) {
  const view = usePersistedCollectionView("shortlisted", "comfortable");
  const deferredQuery = useDeferredValue(view.query);
  // Per-job asset evidence lets legacy failed-without-detail restored rows
  // resolve to the same review-pending status as the selected detail panels.
  const assetsByJobId = useMemo(
    () => new Map((tailoredAssets ?? []).map((asset) => [asset.jobId, asset])),
    [tailoredAssets],
  );
  const unavailableApplicationJobIds = useMemo(
    () =>
      new Set([
        ...(preparedJobIds ?? []),
        ...(applicationPreparingJobIds ?? []),
      ]),
    [applicationPreparingJobIds, preparedJobIds],
  );
  // The same posting saved twice (one employer page reached through two
  // addresses) would get two resumes and two applications. Jobs with the same
  // title, employer and place are flagged so the person can remove one; the
  // same role in another country is a different posting and is not flagged.
  const possibleDuplicateJobIds = useMemo(
    () => findPossibleDuplicateJobIds(queue),
    [queue],
  );
  // Each job's row status and filter, worked out once per queue change. The
  // running state counts too: a job being rewritten used to read "Writing
  // resume" on its row while its tab still counted it as needing one.
  const statusByJobId = useMemo(
    () =>
      new Map(
        queue.map((item) => {
          const label = getReviewQueueWorkflowStatus(
            item,
            assetsByJobId.get(item.jobId),
            isJobPending(item.jobId),
            preparedJobIds,
            applicationPreparingJobIds,
          ).label;
          return [
            item.jobId,
            {
              label,
              filter: getShortlistStatusFilter(
                label,
                isTailoredDraftPreparationEligible(
                  item,
                  unavailableApplicationJobIds,
                ),
              ),
            },
          ] as const;
        }),
      ),
    [
      applicationPreparingJobIds,
      assetsByJobId,
      isJobPending,
      preparedJobIds,
      queue,
      unavailableApplicationJobIds,
    ],
  );
  const searchedQueue = useMemo(
    () =>
      queue.filter((item) =>
        matchesCollectionSearch(deferredQuery, [
          item.title,
          item.company,
          item.location,
          item.resumeApplicationMode,
          statusByJobId.get(item.jobId)?.label ?? "",
        ]),
      ),
    [deferredQuery, queue, statusByJobId],
  );
  const statusFilterCounts = useMemo(() => {
    const counts = new Map<ShortlistStatusFilter, number>([
      ["all", searchedQueue.length],
    ]);
    for (const item of searchedQueue) {
      const filter = statusByJobId.get(item.jobId)?.filter;
      if (filter) counts.set(filter, (counts.get(filter) ?? 0) + 1);
    }
    return counts;
  }, [searchedQueue, statusByJobId]);
  const [requestedStatusFilter, setStatusFilter] =
    useState<ShortlistStatusFilter>("all");
  // A filter whose last job moved on falls back to All instead of showing an
  // empty list the person did not ask for.
  const statusFilter =
    (statusFilterCounts.get(requestedStatusFilter) ?? 0) > 0
      ? requestedStatusFilter
      : "all";
  const visibleQueue = useMemo(
    () =>
      statusFilter === "all"
        ? searchedQueue
        : searchedQueue.filter(
            (item) => statusByJobId.get(item.jobId)?.filter === statusFilter,
          ),
    [searchedQueue, statusByJobId, statusFilter],
  );
  const statusFilterOptions = (
    Object.keys(SHORTLIST_STATUS_FILTER_LABELS) as ShortlistStatusFilter[]
  )
    .filter((filter) => (statusFilterCounts.get(filter) ?? 0) > 0)
    .map((filter) => ({
      value: filter,
      label: `${SHORTLIST_STATUS_FILTER_LABELS[filter]} ${statusFilterCounts.get(filter) ?? 0}`,
      ariaLabel: `${SHORTLIST_STATUS_FILTER_LABELS[filter]}: ${statusFilterCounts.get(filter) ?? 0} jobs`,
    }));
  const [queuePage, setQueuePage] = useState(1);
  const choosingResumeIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const queueListRegionRef = useRef<HTMLDivElement | null>(null);
  const queuePageCount = Math.max(
    1,
    Math.ceil(visibleQueue.length / JOB_LIST_PAGE_SIZE),
  );
  const currentQueuePage = Math.min(queuePage, queuePageCount);
  const selectedQueueIndex = useMemo(
    () =>
      selectedItem
        ? visibleQueue.findIndex((item) => item.jobId === selectedItem.jobId)
        : -1,
    [selectedItem, visibleQueue],
  );
  useEffect(() => {
    setQueuePage(1);
  }, [deferredQuery, statusFilter]);
  useEffect(() => {
    setQueuePage((currentPage) => Math.min(currentPage, queuePageCount));
  }, [queuePageCount]);
  useEffect(() => {
    if (selectedQueueIndex < 0) return;
    setQueuePage(Math.floor(selectedQueueIndex / JOB_LIST_PAGE_SIZE) + 1);
  }, [selectedQueueIndex]);
  // Choosing a status tab or searching opens the first job of the new list
  // when the open job is not in it: "Needs a resume" used to keep a "To
  // review" job in the detail. Only a change the person makes moves the
  // selection; a job leaving the tab because its resume started stays open.
  const listViewKey = `${statusFilter}|${deferredQuery}`;
  const lastListViewKeyRef = useRef(listViewKey);
  useEffect(() => {
    if (lastListViewKeyRef.current === listViewKey) return;
    lastListViewKeyRef.current = listViewKey;
    const firstJobId = visibleQueue[0]?.jobId;
    if (!firstJobId || selectedQueueIndex >= 0) return;
    onShowItem(firstJobId);
  }, [listViewKey, onShowItem, selectedQueueIndex, visibleQueue]);
  useEffect(() => {
    if (!pendingFocusId) return;
    // Scoped to this panel's scroll region so the deferred frame can never
    // land focus in another surface's rows.
    focusCollectionItem(pendingFocusId, {
      region: queueListRegionRef.current,
    });
    setPendingFocusId(null);
  }, [currentQueuePage, pendingFocusId]);
  const pagedVisibleQueue = useMemo(
    () =>
      visibleQueue.slice(
        (currentQueuePage - 1) * JOB_LIST_PAGE_SIZE,
        currentQueuePage * JOB_LIST_PAGE_SIZE,
      ),
    [currentQueuePage, visibleQueue],
  );
  // The shortlist for the assistant (ADR 0037): jobs ticked under "Choose
  // jobs" are the selection; the open job is focus, published by the screen.
  useAssistantContextSource(
    "shortlist-list",
    () => ({
      list: buildListContext({
        listKind: "shortlist",
        checkedIds: choosingResumeIdsRef.current,
        displayedIds: pagedVisibleQueue.map((item) => item.jobId),
        filteredIds: visibleQueue.map((item) => item.jobId),
        filterSummary: deferredQuery.trim()
          ? `matching "${deferredQuery.trim()}"`
          : null,
      }),
    }),
    { priority: 1 },
  );
  const [resumeSelection, setResumeSelection] = useState<{
    campaignId: string;
    jobIds: readonly string[];
  } | null>(null);
  const queueIds = useMemo(
    () => new Set(queue.map((item) => item.jobId)),
    [queue],
  );
  const eligibleResumeIds = new Set(
    queue
      .filter(
        (item) =>
          isTailoredDraftPreparationEligible(
            item,
            unavailableApplicationJobIds,
          ) && !isJobPending(item.jobId),
      )
      .map((item) => item.jobId),
  );
  // A stopped checkpoint records progress, not ownership of eligible jobs.
  // Its dismissible notice must never remove the normal generation controls.
  const draftEligibleCount = eligibleResumeIds.size;
  const pageJobIds = pagedVisibleQueue.map((item) => item.jobId);
  const filteredJobIds = visibleQueue.map((item) => item.jobId);
  // Any shortlisted job can be ticked; each action says how many of the
  // ticked jobs it applies to. Ticks stay when the page or filter changes and
  // are dropped for another plan or once a job leaves the shortlist.
  const selectedJobIds = new Set(
    resumeSelection?.campaignId === campaignId
      ? resumeSelection.jobIds.filter((id) => queueIds.has(id))
      : [],
  );
  choosingResumeIdsRef.current = selectedJobIds;
  const selectedEligibleIds = [...selectedJobIds].filter((id) =>
    eligibleResumeIds.has(id),
  );
  const selectionAnchorRef = useRef<string | null>(null);
  const toggleSelection = useStableCallback(
    (jobId: string, shiftKey: boolean) => {
      const next = applySelectionRange(
        selectedJobIds,
        pageJobIds,
        shiftKey ? selectionAnchorRef.current : null,
        jobId,
        !selectedJobIds.has(jobId),
      );
      selectionAnchorRef.current = jobId;
      setResumeSelection({ campaignId, jobIds: [...next] });
    },
  );
  const setSelectedJobIds = (jobIds: Iterable<string>) =>
    setResumeSelection({ campaignId, jobIds: [...new Set(jobIds)] });
  const clearSelection = () => setResumeSelection(null);
  const [isRemovingSelection, setIsRemovingSelection] = useState(false);
  const removeSelection = async () => {
    if (!onRemoveJobs || selectedJobIds.size === 0) return;
    setIsRemovingSelection(true);
    try {
      await onRemoveJobs([...selectedJobIds]);
      clearSelection();
    } catch {
      // The route message names what failed; the ticks stay for a retry.
    } finally {
      setIsRemovingSelection(false);
    }
  };
  const isSelecting = selectedJobIds.size > 0;
  const readyToApplyJobIds = useMemo(
    () => [
      ...new Set(
        queue
          .filter(
            (item) =>
              !isJobPending(item.jobId) &&
              isQueueStageReady(item, unavailableApplicationJobIds),
          )
          .map((item) => item.jobId),
      ),
    ],
    [isJobPending, queue, unavailableApplicationJobIds],
  );
  const totalReadyToApplyCount = readyToApplyJobIds.length;
  const readyToApplyCount = Math.min(
    totalReadyToApplyCount,
    applicationBatchLimit,
  );
  const safeguardBlockerSentence = safeguardBlocker?.trim()
    ? stripInternalCodeParenthetical(safeguardBlocker)
    : null;
  const draftPreparationBlocker = useMemo(
    () =>
      describeTailoredDraftPreparationBlocker(
        queue,
        unavailableApplicationJobIds,
      ),
    [queue, unavailableApplicationJobIds],
  );
  const isDraftPreparationRunning = draftPreparation.status === "running";
  const draftPreparationResultMessage = draftPreparation.providerBlock
    ? null
    : getTailoredDraftPreparationResultMessage(draftPreparation);
  const draftRunCount = draftEligibleCount;
  // The bulk buttons act on every shortlisted job. Say so only when some of
  // the jobs they would touch are not in the list on screen.
  const visibleJobIds = new Set(filteredJobIds);
  const showsApplyAllButton =
    readyToApplyCount > 0 &&
    Boolean(onApplyToAllReady) &&
    !safeguardBlockerSentence;
  const bulkActionsReachHiddenJobs =
    (draftEligibleCount > 0 &&
      [...eligibleResumeIds].some((id) => !visibleJobIds.has(id))) ||
    (showsApplyAllButton &&
      readyToApplyJobIds.some((id) => !visibleJobIds.has(id)));
  // The three row handlers keep one identity for the life of the panel. Each
  // closes over the queue, so a `useCallback` on it would be rebuilt whenever
  // any job changed and every row would re-render with it — which is exactly
  // what memoising the rows is meant to stop.
  const handleListKeyDown = useStableCallback(
    (event: KeyboardEvent<HTMLButtonElement>, jobId: string) => {
      const nextId = getAdjacentCollectionItemId(
        visibleQueue.map((item) => item.jobId),
        jobId,
        event.key,
      );
      if (!nextId) return;
      event.preventDefault();
      const nextIndex = visibleQueue.findIndex((item) => item.jobId === nextId);
      const nextPage = Math.floor(nextIndex / JOB_LIST_PAGE_SIZE) + 1;
      if (nextPage !== currentQueuePage) {
        setQueuePage(nextPage);
      }
      onSelectItem(nextId);
      setPendingFocusId(nextId);
    },
  );
  const selectItem = useStableCallback((jobId: string) => {
    onSelectItem(jobId);
  });
  // The "for all jobs" row appears only when it can do something: two or
  // more jobs, and at least one of them needs a resume or is ready to apply.
  const showsStatusTabs = queue.length > 1 && statusFilterOptions.length > 2;
  const showsAllJobsRow =
    (queue.length > 1 || isSelecting || isDraftPreparationRunning) &&
    (isSelecting ||
      isDraftPreparationRunning ||
      draftEligibleCount > 0 ||
      readyToApplyCount > 0 ||
      draftPreparationResultMessage !== null);

  const showsSelectionBar = queue.length > 1 && visibleQueue.length > 0;
  const bulkActions = showsAllJobsRow ? (
    <div className="contents" data-testid="shortlisted-all-jobs">
      {isDraftPreparationRunning ? (
        <>
          <p
            aria-live="polite"
            className="m-0 truncate text-(length:--text-small) text-primary"
            role="status"
            {...(draftPreparation.writingCount !== undefined
              ? {
                  title: `${draftPreparation.writingCount} writing · ${draftPreparation.processingCount ?? 0} finishing · ${draftPreparation.waitingCount ?? 0} waiting`,
                }
              : {})}
          >
            {draftPreparation.stopRequested
              ? "Stopping · finishing the resumes already started · "
              : "Writing resumes · "}
            {draftPreparation.completedCount + draftPreparation.failedCount} of{" "}
            {draftPreparation.totalCount} finished
            {(() => {
              const minutes = estimateResumeBatchMinutesLeft(
                draftPreparation.durationsMs ?? [],
                draftPreparation.totalCount -
                  draftPreparation.completedCount -
                  draftPreparation.failedCount,
                draftPreparation.elapsedMs === undefined
                  ? undefined
                  : {
                      elapsedMs: draftPreparation.elapsedMs,
                      completedCount:
                        draftPreparation.completedCount +
                        draftPreparation.failedCount,
                    },
              );
              return !draftPreparation.stopRequested && minutes !== null
                ? ` · about ${minutes} min left`
                : "";
            })()}
          </p>
          {draftPreparation.stopRequested ? null : (
            <Button
              onClick={onStopTailoredDraftPreparation}
              size="toolbar"
              title="Resumes already started still finish."
              type="button"
              variant="ghost"
            >
              Stop new resumes
            </Button>
          )}
        </>
      ) : isSelecting ? (
        <>
          <span className="text-(length:--text-small) font-medium text-foreground">
            {selectedJobIds.size} selected
          </span>
          {/* A "Create 0 resumes" button that can never be pressed
                        is a dead end; the note below says why there is none. */}
          {selectedEligibleIds.length > 0 ? (
            <Button
              onClick={() => {
                onPrepareTailoredDrafts(selectedEligibleIds);
                clearSelection();
              }}
              size="toolbar"
              type="button"
              variant="secondary"
            >
              {selectedEligibleIds.length === 1
                ? "Create 1 resume"
                : `Create ${selectedEligibleIds.length} resumes`}
            </Button>
          ) : null}
          {onRemoveJobs ? (
            <Button
              disabled={isRemovingSelection}
              onClick={() => void removeSelection()}
              pending={isRemovingSelection}
              size="toolbar"
              type="button"
              variant="outline"
            >
              Remove from shortlist
            </Button>
          ) : null}
          {filteredJobIds.some((id) => !selectedJobIds.has(id)) ? (
            <Button
              onClick={() =>
                setSelectedJobIds([...selectedJobIds, ...filteredJobIds])
              }
              size="toolbar"
              type="button"
              variant="ghost"
            >
              Select all {filteredJobIds.length}
            </Button>
          ) : null}
          {/* Same words as the Find jobs bar: "Clear". */}
          <Button
            aria-label="Clear selection"
            onClick={clearSelection}
            size="toolbar"
            type="button"
            variant="ghost"
          >
            Clear
          </Button>
        </>
      ) : (
        <>
          {draftEligibleCount > 0 ? (
            <Button
              data-testid="create-missing-resumes"
              disabled={draftPreparationBlocker !== null}
              onClick={() => onPrepareTailoredDrafts([...eligibleResumeIds])}
              size="toolbar"
              title={`${queuePageCount > 1 ? "Covers every page. " : ""}Stop any time; finished resumes are kept. Tick jobs to act on only some.`}
              type="button"
              variant="secondary"
            >
              {draftRunCount === 1
                ? "Create the missing resume"
                : `Create ${draftRunCount} missing resumes`}
            </Button>
          ) : null}
          {readyToApplyCount > 0 && onApplyToAllReady ? (
            safeguardBlockerSentence ? (
              <Button
                data-testid="apply-all-safeguards"
                onClick={() => onOpenSafeguards?.()}
                size="toolbar"
                type="button"
                variant="secondary"
              >
                Open Safeguards
              </Button>
            ) : (
              <Button
                data-testid="apply-all-ready"
                disabled={isApplyToAllPending}
                onClick={() => onApplyToAllReady(readyToApplyCount)}
                pending={isApplyToAllPending}
                size="toolbar"
                type="button"
                variant="secondary"
              >
                {readyToApplyCount === 1
                  ? "Apply to the 1 ready job"
                  : totalReadyToApplyCount > readyToApplyCount
                    ? `Apply to next ${readyToApplyCount} ready jobs`
                    : `Apply to all ${readyToApplyCount} ready jobs`}
              </Button>
            )
          ) : null}
        </>
      )}
    </div>
  ) : null;
  const bulkNoteLines = (
    <>
      {isSelecting && selectedEligibleIds.length < selectedJobIds.size ? (
        <p className="m-0 text-xs text-foreground-muted">
          {selectedEligibleIds.length === 0
            ? selectedJobIds.size === 1
              ? "The selected job already has a resume."
              : "The selected jobs already have resumes."
            : `${selectedEligibleIds.length} of the selected jobs need a resume; the others keep theirs.`}
        </p>
      ) : null}
      {showsAllJobsRow &&
      !isDraftPreparationRunning &&
      !isSelecting &&
      bulkActionsReachHiddenJobs ? (
        <p
          className="m-0 text-xs text-foreground-muted"
          data-testid="shortlist-bulk-filter-scope"
        >
          {draftEligibleCount > 0 && showsApplyAllButton
            ? "These buttons act on all shortlisted jobs, not just the ones shown."
            : "This button acts on all shortlisted jobs, not just the ones shown."}
        </p>
      ) : null}
      {showsAllJobsRow &&
      !isDraftPreparationRunning &&
      !isSelecting &&
      totalReadyToApplyCount > readyToApplyCount ? (
        <p className="m-0 text-xs text-foreground-muted">
          {totalReadyToApplyCount} ready jobs. {readyToApplyCount} start now;{" "}
          {totalReadyToApplyCount - readyToApplyCount} remain after this batch.
        </p>
      ) : null}
      {!isDraftPreparationRunning &&
      !isSelecting &&
      !safeguardBlockerSentence &&
      readyToApplyCount > 0 &&
      onApplyToAllReady &&
      applyAllOutcome ? (
        <p
          className="m-0 text-xs text-foreground-muted"
          data-testid="apply-all-outcome"
        >
          {applyAllOutcome}
        </p>
      ) : null}
      {!isSelecting && safeguardBlockerSentence && readyToApplyCount > 0 ? (
        <p
          className="m-0 text-xs text-foreground-muted"
          data-testid="apply-all-blocker"
        >
          {safeguardBlockerSentence}
        </p>
      ) : null}
      {draftPreparationResultMessage && !isDraftPreparationRunning ? (
        <p
          aria-live="polite"
          className="m-0 min-w-0 text-xs text-primary"
          role="status"
        >
          {draftPreparationResultMessage}
        </p>
      ) : null}
    </>
  );
  // Quiet notes under the actions, only when they add something the buttons
  // do not say.
  const bulkNotes = showsAllJobsRow ? (
    <div className="grid gap-1 px-3 empty:hidden [&:has(p)]:py-1.5">
      {bulkNoteLines}
    </div>
  ) : null;

  return (
    <section className="surface-panel-shell relative flex min-w-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) xl:h-full xl:min-h-0">
      {/* A search field, a density switch and named views are list
          management for a list that usually holds one to eight rows. Only the
          search survives, and only once there is more than one row to search.
          The page title already names the list, so no label row sits above
          it (ADR 0044). */}
      {queue.length > 1 ? (
        <CollectionSearchToolbar
          compact
          // The status tabs below already count the jobs ("All 200"); a
          // second "200 results" beside the search said it again.
          hideCompactCount={showsStatusTabs}
          placement="panel"
          label="Find a shortlisted job"
          leading={
            showsSelectionBar ? (
              <span className="flex w-6 shrink-0 justify-center">
                <ListPageCheckbox
                  noun="jobs"
                  onClearPage={() =>
                    setSelectedJobIds(
                      [...selectedJobIds].filter(
                        (id) => !pageJobIds.includes(id),
                      ),
                    )
                  }
                  onSelectPage={() =>
                    setSelectedJobIds([...selectedJobIds, ...pageJobIds])
                  }
                  pageIds={isDraftPreparationRunning ? [] : pageJobIds}
                  selectedIds={selectedJobIds}
                />
              </span>
            ) : undefined
          }
          viewActions={bulkActions ?? undefined}
          onQueryChange={view.setQuery}
          placeholder="Search jobs"
          query={view.query}
          totalCount={queue.length}
          visibleCount={visibleQueue.length}
        />
      ) : null}
      {showsStatusTabs ? (
        <div className="min-w-0 overflow-x-auto border-b border-(--surface-panel-border) px-3 py-1.5">
          <SegmentedControl
            label="Show shortlisted jobs by status"
            onValueChange={setStatusFilter}
            options={statusFilterOptions}
            value={statusFilter}
          />
        </div>
      ) : null}
      {/* The select-all box and the list's actions share the search row, the
          status tabs sit under it, and notes appear only when they add
          something: the jobs start two rows below the title instead of five. */}
      {showsAllJobsRow && queue.length <= 1 ? (
        <div className="flex min-h-10 min-w-0 flex-wrap items-center justify-end gap-2 border-b border-(--surface-panel-border) px-3 py-1.5">
          {bulkActions}
        </div>
      ) : null}
      {bulkNotes}
      {queue.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-5 pb-5 pt-4">
          <div className="grid w-full max-w-136 justify-items-center gap-4">
            <EmptyState
              title="No shortlisted jobs in this plan"
              description="Shortlist a job from Find jobs. It shows up here, ready for a resume and an application."
            />
            <Button asChild size="lg">
              <Link
                to={buildJobFinderContextRoute("/job-finder/discovery", {})}
              >
                Go to Find jobs
              </Link>
            </Button>
          </div>
        </div>
      ) : visibleQueue.length === 0 ? (
        <CollectionNoMatches
          noun="shortlisted jobs"
          onClear={() => {
            view.setQuery("");
            setStatusFilter("all");
          }}
          query={view.query}
        />
      ) : (
        <>
          <div
            className={cn(
              jobFinderListRegionClassName,
              "min-h-0 flex-1 overflow-x-hidden overflow-y-auto",
            )}
            data-locked-pane-scroll-region
            ref={queueListRegionRef}
            onKeyDown={(event) => {
              if (isDraftPreparationRunning) return;
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "a"
              ) {
                event.preventDefault();
                setSelectedJobIds([...selectedJobIds, ...pageJobIds]);
              } else if (event.key === "Escape" && selectedJobIds.size > 0) {
                event.preventDefault();
                clearSelection();
              }
            }}
          >
            {pagedVisibleQueue.map((item) => {
              // Every value the row renders is derived here and handed over as a
              // string or a boolean, so a step that changes one job's status
              // leaves the other rows' props identical and they skip the render.
              const isPending = isJobPending(item.jobId);
              const workflowStatus = getReviewQueueWorkflowStatus(
                item,
                assetsByJobId.get(item.jobId),
                isPending,
                preparedJobIds,
                applicationPreparingJobIds,
              );
              const statusLabel = item.listingAssessmentPending
                ? "Assessing listing"
                : workflowStatus.label;

              return (
                <ReviewQueueRow
                  employerLocationLine={formatJobEmployerLocationLine({
                    company: item.company,
                    location: item.location,
                    separator: " • ",
                  })}
                  checked={selectedJobIds.has(item.jobId)}
                  levelLabel={describeQueueItemResumeLevel(item)}
                  possibleDuplicate={possibleDuplicateJobIds.has(item.jobId)}
                  selectionDisabled={isDraftPreparationRunning}
                  onToggleSelection={toggleSelection}
                  jobId={item.jobId}
                  key={item.jobId}
                  onSelect={selectItem}
                  onSelectionKeyDown={handleListKeyDown}
                  resumePolicyCaption={getReviewQueueRowCaption(
                    statusLabel,
                    // While this job's resume is being (re)written the row's
                    // status already says so; the caption must not still read
                    // "Resume ready — Apply approves it" for the old text.
                    workflowStatus.label === "Writing resume"
                      ? "Writing the resume…"
                      : getReviewQueueResumePolicyCaption(
                          item,
                          assetsByJobId.get(item.jobId),
                        ),
                  )}
                  selected={selectedItem?.jobId === item.jobId}
                  showProgress={workflowStatus.label === "Writing resume"}
                  statusLabel={statusLabel}
                  statusTone={workflowStatus.tone}
                  title={item.title}
                />
              );
            })}
          </div>
        </>
      )}
      {queue.length > 0 && visibleQueue.length > 0 ? (
        <CollectionPagination
          itemLabel="shortlisted jobs"
          onPageChange={setQueuePage}
          page={currentQueuePage}
          pageSize={JOB_LIST_PAGE_SIZE}
          totalCount={visibleQueue.length}
        />
      ) : null}
    </section>
  );
}
