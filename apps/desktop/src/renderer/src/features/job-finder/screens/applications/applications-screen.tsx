import { LIST_DETAIL_COLUMNS_CLASS } from "../../components/list-detail-columns";
import { projectApplicationRecordsActivity } from "@nestor/contracts";
import type { ReactNode } from "react";
import { useQuestionAnswerDrafts } from "../actions/use-question-answer-drafts";
import { isSameSiteApplicationActive } from "../actions/actions-screen";
import { formatElapsedMinutes } from "./applications-recovery-state";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportFormat,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  ApplicationAttemptListRow,
  ApplicationAutomationMode,
  ApplicationRecord,
  ApplyRunDetails,
  ClearApplicationAnswerCommandInput,
  CompanyEntity,
  GlobalDailyApplicationPreparationCapacity,
  JobFinderRendererWorkspaceSnapshot,
  RecordOutcomeInput,
  SaveApplicationAnswerCommandInput,
  JobFinderApplyConsentActionInput,
  JobFinderApplyRunActionInput,
  JobFinderApplyRunDetailsQuery,
  JobFinderExactApplicationTarget,
  UserActionCommandInput,
} from "@nestor/contracts";
import {
  isListableCompanyName,
  isApplicationTrackedAsSentByPerson,
  PREPARED_PAGE_CLOSED_SUMMARY,
} from "@nestor/contracts";
import { ArrowLeft } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { LockedScreenLayout } from "../../components/locked-screen-layout";
import { EmptyState } from "../../components/empty-state";
import {
  PageHeaderStack,
  type PageStatusItem,
} from "../../components/page-header";
import { ApplicationsDetailPanel } from "./applications-detail-panel";
import type {
  ConfirmFinishedInBrowserStatus,
  FinishInBrowserHandler,
  FinishInBrowserInput,
} from "./applications-detail-panel-recovery-actions-section";
import {
  APPLICATION_FILTER_LABELS,
  APPLICATION_FILTERS,
  type ApplicationsViewFilter,
} from "./applications-filters";
import { useRememberedString } from "../../hooks/use-remembered-string";

const isApplicationsViewFilter = (
  value: string,
): value is ApplicationsViewFilter =>
  (APPLICATION_FILTERS as readonly string[]).includes(value);
import {
  getLatestApplicationAttemptForRecord,
  matchesApplicationsFilter,
  pickLatestIsoTimestamp,
  resolveUnambiguousApplicationRecordIdByJobId,
  resolveVisibleRouteActionMessage,
} from "./applications-screen-helpers";
import { useApplicationsApplyRunDetails } from "./use-applications-apply-run-details";
import { ApplicationsRecordsPanel } from "./applications-records-panel";
import { StatusBadge } from "../../components/status-badge";
import { countApplyRunItemsNeedingYou } from "../../lib/needs-you-count";
import {
  ApplicationsCrmViews,
  type ApplicationCrmView,
} from "./applications-crm-views";
import { ApplicationsCrmDetail } from "./applications-crm-detail";
import type { ApplyMode } from "../../lib/apply-mode-contracts-stub";
import {
  resolveApplyStatePresentation,
  WAITING_FOR_BROWSER_TAB_SUMMARY,
} from "./apply-state";
import { buildApplyRunContextReader } from "./applications-recovery-state";
import { ApplyQueueStrip } from "../../components/apply-queue-strip";
import {
  listApplyQueueWaitingJobIds,
  type ApplyQueueControlAction,
} from "../../lib/apply-queue-view";
import { useAssistantContextSource } from "../../assistant/assistant-provider";
import { buildListContext } from "../../assistant/assistant-context-capture";

/** Statuses an application reaches once it was sent and can have an outcome. */
const OUTCOME_STATUSES = new Set<string>([
  "submitted",
  "assessment",
  "interview",
  "rejected",
  "offer",
  "withdrawn",
]);

export function ApplicationsScreen(props: {
  homeTimeZone?: string;
  scopeControl?: ReactNode;
  actionMessage?: string | null;
  searchPlanName?: string | undefined;
  hasOtherPlanApplications?: boolean;
  applicationAttempts: readonly ApplicationAttemptListRow[];
  applicationRecords: readonly ApplicationRecord[];
  applyRuns: JobFinderRendererWorkspaceSnapshot["applyRuns"];
  applyJobResults: JobFinderRendererWorkspaceSnapshot["applyJobResults"];
  /** The person's pause, so a job held by it reads Paused, not Filling in. */
  activityControl?:
    | JobFinderRendererWorkspaceSnapshot["activityControl"]
    | null;
  /**
   * Live user-action requests, so the finished-run summary counts this run's
   * share of the same Needs you population the header badge totals.
   */
  userActionRequests?: JobFinderRendererWorkspaceSnapshot["userActionRequests"];
  companies?: readonly CompanyEntity[];
  dailyPreparationCapacity: GlobalDailyApplicationPreparationCapacity | null;
  discoveryJobs: JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
  isApplyPending: boolean;
  isApplyRequestPending: (requestId: string) => boolean;
  isApplyRunPending: (runId: string) => boolean;
  onApproveApplyRun: (input: JobFinderApplyRunActionInput) => void;
  onCancelApplyRun: (input: JobFinderApplyRunActionInput) => void;
  onGetApplyRunDetails: (
    input: JobFinderApplyRunDetailsQuery,
  ) => Promise<ApplyRunDetails>;
  /**
   * Sends an application the person chose to look over first. Absent unless
   * they allowed Job Finder to send at all.
   */
  onSubmitPreparedApplication?: (jobId: string) => Promise<void>;
  /** Prepares the application again when its page is no longer open. */
  onPrepareApplicationAgain?: (jobId: string) => Promise<void>;
  onSaveApplicationAnswer: (
    command: SaveApplicationAnswerCommandInput,
  ) => Promise<ApplyRunDetails>;
  onClearApplicationAnswer: (
    command: ClearApplicationAnswerCommandInput,
  ) => Promise<ApplyRunDetails>;
  onExportApplicationPacket: (
    input: JobFinderApplyRunDetailsQuery,
  ) => Promise<void>;
  onResolveSubmissionOutcome?: (
    uncertainOutcomeId: string,
    resolution: "submitted" | "not_submitted",
  ) => Promise<void>;
  onResolveApplyConsentRequest: (
    input: JobFinderApplyConsentActionInput,
  ) => void;
  onRevokeApplyRunApproval: (input: JobFinderApplyRunActionInput) => void;
  applicationAutomationMode?: ApplicationAutomationMode;
  onStartAutoApplyQueue: (
    jobIds: string[],
    applicationAutomationMode?: ApplicationAutomationMode,
  ) => void;
  /** The Apply queue (ADR 0058), shown above the list with its controls. */
  applyQueue?: JobFinderRendererWorkspaceSnapshot["applyQueue"];
  onControlApplyQueue?: (action: ApplyQueueControlAction) => void;
  onRaiseDailyLimit?: () => void;
  onStartApplyCopilot: (input: JobFinderExactApplicationTarget) => void;
  onReviewResumePdf?: (jobId: string) => void;
  onOpenCompany?: (companyId: string) => void;
  /**
   * The workspace's most recently updated run. Not used to pick a record's
   * attempt (see effectiveSelectedApplyRunId); kept for callers.
   */
  selectedApplyRunId: string | null;
  onSelectRecord: (recordId: string) => void;
  selectedAttempt: ApplicationAttemptListRow | null;
  selectedRecord: ApplicationRecord | null;
  crmSettings?: ApplicationCrmSettings;
  onMutateApplicationCrm?: (
    command: ApplicationCrmMutationInput,
  ) => Promise<void>;
  onMutateApplicationCrmBulkStage?: (
    command: ApplicationCrmBulkStageMutationInput,
  ) => Promise<void>;
  onExportApplicationCrm?: (
    format: ApplicationCrmExportFormat,
    recordId: string,
  ) => Promise<void>;
  onRecordOutcome?: (input: RecordOutcomeInput) => Promise<void>;
  isRecordOutcomePending?: (jobId: string) => boolean;
  outcomeCampaignId?: string | null;
  getOutcomeResumeStrategyId?: (jobId: string) => string | null;
  /** Outcomes the person recorded for one application. */
  getRecordedOutcomes?: (applicationRecordId: string) => readonly {
    id: string;
    outcome: string;
    occurredAt: string;
    note: string | null;
  }[];
  safeguardsBlockerCount?: number;
  onOpenSafeguards?: () => void;
  /** Opens Outcomes, which has no navigation entry of its own. */
  onOpenOutcomes?: () => void;
  onOpenNeedsYou?: () => void;
  onPerformUserAction?: (
    command: UserActionCommandInput,
  ) => void | Promise<void>;
  isUserActionPending?: (requestId: string) => boolean;
  onAllowSiteSaves?: (host: string | null) => void;
  /**
   * Opens or focuses the managed Job Finder browser on the paused application
   * so the user can finish a field the site tried to save on its own. It
   * reports what the hand-off actually did; the declared return type has to
   * match the leaf's or that outcome is under-reported on the way down.
   */
  onFinishInBrowser?: FinishInBrowserHandler;
  /**
   * Confirms the browser-owned step the user was sent out to finish, running
   * the same verification Needs you runs. The screen that sends the user to
   * the browser is the screen that takes them back in.
   */
  onConfirmFinishedInBrowser?: (input: FinishInBrowserInput) => void;
  /** True while a pending browser step exists for the visible result. */
  canConfirmFinishedInBrowser?: boolean;
  /** The pending browser step is a sign-in Job Finder watches by itself. */
  browserStepContinuesOnItsOwn?: boolean;
  confirmFinishedInBrowserStatus?: ConfirmFinishedInBrowserStatus;
  confirmFinishedInBrowserBlockerText?: string | null;
  /** The mode chosen in Settings; decides what a finished fill means. */
  applyMode?: ApplyMode;
  /** Route-owned tracker mode, so "Open tracker" is a link, not a tab. */
  requestedRecordId?: string | null;
  workspaceView?: "workflow" | "crm";
  onWorkspaceViewChange?: (view: "workflow" | "crm") => void;
}) {
  const {
    applicationAttempts,
    applicationRecords,
    applyRuns,
    applyJobResults,
    userActionRequests,
    dailyPreparationCapacity,
    discoveryJobs,
    isApplyPending,
    isApplyRequestPending,
    isApplyRunPending,
    onApproveApplyRun,
    onCancelApplyRun,
    onGetApplyRunDetails,
    onSaveApplicationAnswer,
    onSubmitPreparedApplication,
    onPrepareApplicationAgain,
    onClearApplicationAnswer,
    onExportApplicationPacket,
    onResolveSubmissionOutcome,
    onResolveApplyConsentRequest,
    onRevokeApplyRunApproval,
    onStartAutoApplyQueue,
    onStartApplyCopilot,
    onReviewResumePdf,
    onSelectRecord,
    selectedAttempt,
    selectedRecord,
  } = props;
  const [activeFilter, setActiveFilter] = useRememberedString(
    "applications.filter",
    "all",
    isApplicationsViewFilter,
  );
  // Preparation is the product; the stage tracker is a deferred power surface
  // reached explicitly, not a peer tab that splits one application into two
  // competing screens. The route owns the mode so the tracker keeps a link.
  const [localWorkspaceView, setLocalWorkspaceView] = useState<
    "workflow" | "crm"
  >("workflow");
  const workspaceView = props.workspaceView ?? localWorkspaceView;
  const setWorkspaceView = (view: "workflow" | "crm") => {
    setLocalWorkspaceView(view);
    props.onWorkspaceViewChange?.(view);
  };
  const [crmView, setCrmView] = useState<ApplicationCrmView>("table");
  const [crmVisibleRecordIds, setCrmVisibleRecordIds] = useState<
    readonly string[] | null
  >(null);
  const [
    selectedApplyRunIdByApplicationRecordId,
    setSelectedApplyRunIdByApplicationRecordId,
  ] = useState<Record<string, string>>({});
  const selectRecordAndRevealDetails = useCallback(
    (recordId: string) => {
      onSelectRecord(recordId);
      if (
        typeof window.matchMedia !== "function" ||
        window.matchMedia("(min-width: 1280px)").matches
      ) {
        return;
      }
      window.requestAnimationFrame(() => {
        document
          .getElementById("applications-detail-content")
          ?.scrollIntoView({ block: "start" });
      });
    },
    [onSelectRecord],
  );
  const handleCrmVisibleRecordIdsChange = useCallback(
    (recordIds: readonly string[]) => {
      setCrmVisibleRecordIds((current) =>
        current !== null &&
        current.length === recordIds.length &&
        current.every((id, index) => id === recordIds[index])
          ? current
          : recordIds,
      );
    },
    [],
  );
  // The words for a job whose application is being filled in right now, so
  // the list never shows a stale "prepare when you are ready" beside a
  // running preparation.
  const [progressNow, setProgressNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setProgressNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const liveRunLinesByJobId = useMemo(() => {
    const runningRunIds = new Set(
      applyRuns.filter((run) => run.state === "running").map((run) => run.id),
    );
    const lines = new Map<string, string>();
    for (const result of applyJobResults) {
      if (!runningRunIds.has(result.runId)) continue;
      // Started but held until the browser has a free tab: say that.
      const elapsed = formatElapsedMinutes(result.startedAt, progressNow);
      if (result.summary === WAITING_FOR_BROWSER_TAB_SUMMARY) {
        lines.set(
          result.jobId,
          `${WAITING_FOR_BROWSER_TAB_SUMMARY}${elapsed ? ` (${elapsed})` : ""}.`,
        );
        continue;
      }
      if (result.state === "planned") {
        lines.set(
          result.jobId,
          props.activityControl?.paused
            ? "Paused before this application. It carries on when you resume."
            : `Waiting its turn${elapsed ? ` (${elapsed})` : ""}.`,
        );
        continue;
      }
      if (result.state !== "filling" && result.state !== "submitting") continue;
      lines.set(
        result.jobId,
        `Preparing${elapsed ? ` (${elapsed})` : ""}${result.detail?.trim() ? ` · ${result.detail.trim()}` : ""}`,
      );
    }
    const jobsById = new Map(discoveryJobs.map((job) => [job.id, job]));
    for (const request of userActionRequests ?? []) {
      if (
        request.kind !== "manual_answer" ||
        request.state !== "verifying" ||
        request.scope.type !== "application"
      )
        continue;
      const job = jobsById.get(request.scope.jobId);
      const waiting =
        job && isSameSiteApplicationActive(job, applyJobResults, jobsById);
      const elapsed = formatElapsedMinutes(request.updatedAt, progressNow);
      lines.set(
        request.scope.jobId,
        `${waiting ? "Waiting its turn" : "Inserting your answer"}${elapsed ? ` (${elapsed})` : ""}.`,
      );
    }
    return lines;
  }, [
    applyJobResults,
    applyRuns,
    props.activityControl?.paused,
    progressNow,
    userActionRequests,
    discoveryJobs,
  ]);
  const applyMode: ApplyMode = props.applyMode ?? "fill_only";
  // The newest run result per record, so each row reads one of the five
  // apply states from what the run recorded.
  const latestApplyResultByRecordId = useMemo(() => {
    const latest = new Map<
      string,
      JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
    >();
    const runsById = new Map(applyRuns.map((run) => [run.id, run]));
    for (const result of applyJobResults) {
      if (!result.applicationRecordId) continue;
      const current = latest.get(result.applicationRecordId);
      const currentStart = current
        ? (runsById.get(current.runId)?.createdAt ?? current.startedAt)
        : "";
      const resultStart =
        runsById.get(result.runId)?.createdAt ?? result.startedAt;
      if (
        !current ||
        (result.privacyReceipt?.finalSubmitOccurred === true &&
          result.privacyReceipt.submissionOutcome?.outcome !==
            "outcome_uncertain") ||
        (current.privacyReceipt?.finalSubmitOccurred !== true &&
          (currentStart < resultStart ||
            (current.runId === result.runId &&
              current.updatedAt < result.updatedAt)))
      ) {
        latest.set(result.applicationRecordId, result);
      }
    }
    return latest;
  }, [applyJobResults, applyRuns]);
  // What each result's run is doing: a planned job waits its turn, is held
  // by the person's pause, or was left behind by a batch that stopped.
  const readApplyRunContext = useMemo(
    () =>
      buildApplyRunContextReader({
        applyRuns,
        applyJobResults,
        activityControl: props.activityControl ?? null,
      }),
    [applyJobResults, applyRuns, props.activityControl],
  );
  // Retained records can predate terminal-result synchronization. Tracker uses
  // the same newest attempt as Preparation without rewriting saved history.
  const crmApplicationRecords = useMemo(
    () =>
      projectApplicationRecordsActivity({
        records: applicationRecords,
        results: applyJobResults,
        runs: applyRuns,
      }),
    [applicationRecords, applyJobResults, applyRuns],
  );
  // Bulk retry: every application whose last run ended where a fresh run
  // could differ. One control, so a batch that failed on a bad network night
  // is not ten separate "Try again" presses.
  const retryableJobIds = useMemo(() => {
    const running = new Set(
      applyRuns
        .filter((run) => run.state === "running")
        .flatMap((run) => run.jobIds),
    );
    for (const jobId of listApplyQueueWaitingJobIds(props.applyQueue))
      running.add(jobId);
    const jobIds: string[] = [];
    for (const record of applicationRecords) {
      if (running.has(record.jobId)) continue;
      const result = latestApplyResultByRecordId.get(record.id);
      if (!result) continue;
      // A form whose page closed while it waited on the person may have been
      // sent by them; only they can say, one application at a time.
      if (result.blockerSummary === PREPARED_PAGE_CLOSED_SUMMARY) continue;
      if (isApplicationTrackedAsSentByPerson(record.crm)) continue;
      const presentation = resolveApplyStatePresentation({
        now: progressNow,
        recordCrm: record.crm,
        recordLatestBlocker: record.latestBlocker,
        mode:
          record.automationMode === "autonomous_submit"
            ? "apply_for_me"
            : "fill_only",
        result,
        run: readApplyRunContext(result),
        recordLastActionLabel: record.lastActionLabel,
        recordFailure:
          record.lastAttemptState === "failed"
            ? {
                lastActionLabel: record.lastActionLabel,
                lastUpdatedAt: record.lastUpdatedAt,
              }
            : null,
      });
      if (
        !presentation.cancelledByPerson &&
        presentation.kind === "could_not_apply" &&
        presentation.action === "try_again" &&
        !jobIds.includes(record.jobId)
      ) {
        jobIds.push(record.jobId);
      }
    }
    return jobIds;
  }, [
    applicationRecords,
    applyRuns,
    latestApplyResultByRecordId,
    readApplyRunContext,
  ]);
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        APPLICATION_FILTERS.map((filter) => [
          filter,
          applicationRecords.filter((record) =>
            matchesApplicationsFilter(
              record,
              filter,
              latestApplyResultByRecordId.has(record.id)
                ? resolveApplyStatePresentation({
                    now: progressNow,
                    recordCrm: record.crm,
                    recordLatestBlocker: record.latestBlocker,
                    mode:
                      record.automationMode === "autonomous_submit"
                        ? "apply_for_me"
                        : "fill_only",
                    result: latestApplyResultByRecordId.get(record.id) ?? null,
                    run: readApplyRunContext(
                      latestApplyResultByRecordId.get(record.id) ?? null,
                    ),
                    pendingQuestionCount: Math.max(
                      0,
                      record.questionSummary.total -
                        record.questionSummary.answered,
                    ),
                    recordLastActionLabel: record.lastActionLabel,
                    recordFailure:
                      record.lastAttemptState === "failed"
                        ? {
                            lastActionLabel: record.lastActionLabel,
                            lastUpdatedAt: record.lastUpdatedAt,
                          }
                        : null,
                  }).kind
                : undefined,
            ),
          ).length,
        ]),
      ) as Record<ApplicationsViewFilter, number>,
    [applicationRecords, latestApplyResultByRecordId, readApplyRunContext],
  );
  const { answerDrafts, restoredApplications, updateAnswerDraft } =
    useQuestionAnswerDrafts({
      applicationAttempts,
      requests: userActionRequests ?? [],
      onGetApplyRunDetails,
    });
  const latestAutomaticRun = useMemo(
    () =>
      [...applyRuns]
        .filter((run) => run.mode !== "copilot")
        .sort(
          (left, right) =>
            new Date(right.createdAt).getTime() -
            new Date(left.createdAt).getTime(),
        )[0] ?? null,
    [applyRuns],
  );
  const latestAutomaticResults = useMemo(
    () =>
      latestAutomaticRun
        ? applyJobResults.filter(
            (result) => result.runId === latestAutomaticRun.id,
          )
        : [],
    [applyJobResults, latestAutomaticRun],
  );
  // One owner for "needs you": the run summary counts this run's share of the
  // population the header badge totals, rather than its own blocked/failed
  // result states, which reported "5 need attention" beside "Needs you: 4
  // unresolved" for the same five jobs.
  const latestRunAttentionResults = latestAutomaticResults.filter(
    (result) =>
      !result.applicationRecordId ||
      latestApplyResultByRecordId.get(result.applicationRecordId)?.id ===
        result.id,
  );
  const latestRunAttentionRecords = applicationRecords.filter((record) =>
    latestRunAttentionResults.some(
      (result) => result.applicationRecordId === record.id,
    ),
  );
  const latestRunAttentionRequests = (userActionRequests ?? []).filter(
    (request) => {
      const scope = request.scope;
      return (
        scope.type === "application" &&
        scope.runId === latestAutomaticRun?.id &&
        (!scope.applicationRecordId ||
          latestRunAttentionResults.some(
            (result) =>
              result.applicationRecordId === scope.applicationRecordId,
          ))
      );
    },
  );
  const latestRunAttentionCount = latestAutomaticRun
    ? countApplyRunItemsNeedingYou({
        applicationRecords: latestRunAttentionRecords,
        applyJobResults: latestRunAttentionResults,
        requests: latestRunAttentionRequests,
        runId: latestAutomaticRun.id,
        runJobIds: new Set(latestAutomaticRun.jobIds),
      })
    : 0;
  const filteredApplicationRecords = useMemo(
    () =>
      applicationRecords.filter((record) =>
        matchesApplicationsFilter(
          record,
          activeFilter,
          latestApplyResultByRecordId.has(record.id)
            ? resolveApplyStatePresentation({
                now: progressNow,
                recordCrm: record.crm,
                recordLatestBlocker: record.latestBlocker,
                mode:
                  record.automationMode === "autonomous_submit"
                    ? "apply_for_me"
                    : "fill_only",
                result: latestApplyResultByRecordId.get(record.id) ?? null,
                run: readApplyRunContext(
                  latestApplyResultByRecordId.get(record.id) ?? null,
                ),
                pendingQuestionCount: Math.max(
                  0,
                  record.questionSummary.total -
                    record.questionSummary.answered,
                ),
                recordLastActionLabel: record.lastActionLabel,
                recordFailure:
                  record.lastAttemptState === "failed"
                    ? {
                        lastActionLabel: record.lastActionLabel,
                        lastUpdatedAt: record.lastUpdatedAt,
                      }
                    : null,
              }).kind
            : undefined,
        ),
      ),
    [
      activeFilter,
      applicationRecords,
      latestApplyResultByRecordId,
      readApplyRunContext,
    ],
  );
  const [explicitlyHiddenRecordId, setExplicitlyHiddenRecordId] = useState<
    string | null
  >(null);
  const handleFilterChange = (filter: ApplicationsViewFilter) => {
    const result = selectedRecord
      ? latestApplyResultByRecordId.get(selectedRecord.id)
      : null;
    const state = result
      ? resolveApplyStatePresentation({
          now: progressNow,
          mode: applyMode,
          result,
          run: readApplyRunContext(result),
          recordCrm: selectedRecord?.crm,
          recordLatestBlocker: selectedRecord?.latestBlocker ?? null,
          recordLastActionLabel: selectedRecord?.lastActionLabel ?? null,
        }).kind
      : undefined;
    setExplicitlyHiddenRecordId(
      selectedRecord &&
        !matchesApplicationsFilter(selectedRecord, filter, state)
        ? selectedRecord.id
        : null,
    );
    setActiveFilter(filter);
  };
  const isSelectedRecordHiddenByFilter =
    selectedRecord !== null &&
    filteredApplicationRecords.length > 0 &&
    !filteredApplicationRecords.some(
      (record) => record.id === selectedRecord.id,
    );
  const shouldPreserveHiddenSelection =
    workspaceView === "workflow" &&
    isSelectedRecordHiddenByFilter &&
    explicitlyHiddenRecordId === selectedRecord?.id;
  const effectiveSelectedRecord = shouldPreserveHiddenSelection
    ? null
    : (selectedRecord ?? filteredApplicationRecords[0] ?? null);
  // The applications list as the person sees it, for the assistant (ADR 0037).
  useAssistantContextSource("applications", () => ({
    focus: effectiveSelectedRecord
      ? {
          kind: "application",
          id: effectiveSelectedRecord.id,
          label: `${effectiveSelectedRecord.title} at ${effectiveSelectedRecord.company}`,
        }
      : null,
    // The open application is focus, never selection. The tracker table
    // publishes its ticked rows with a higher priority when it is shown.
    list: buildListContext({
      listKind: "applications",
      checkedIds: [],
      displayedIds: filteredApplicationRecords.map((record) => record.id),
      filteredIds: filteredApplicationRecords.map((record) => record.id),
      filterSummary: activeFilter === "all" ? null : `Filter: ${activeFilter}`,
    }),
  }));
  const effectiveSelectedAttempt = (() => {
    if (!effectiveSelectedRecord) {
      return null;
    }

    // Exact lineage from route selection stays authoritative.
    if (
      selectedAttempt &&
      selectedAttempt.applicationRecordId === effectiveSelectedRecord.id
    ) {
      return selectedAttempt;
    }

    // Otherwise the latest associated attempt may come from legacy history
    // whose applicationRecordId is null but whose job ownership is unique.
    return getLatestApplicationAttemptForRecord(
      effectiveSelectedRecord,
      applicationAttempts,
      applicationRecords,
    );
  })();
  const isSelectedRecordInCrmView =
    crmVisibleRecordIds !== null &&
    effectiveSelectedRecord !== null &&
    crmVisibleRecordIds.includes(effectiveSelectedRecord.id);
  const applyRunsById = useMemo(
    () => new Map(applyRuns.map((run) => [run.id, run])),
    [applyRuns],
  );
  const unambiguousRecordIdByJobId = useMemo(
    () => resolveUnambiguousApplicationRecordIdByJobId(applicationRecords),
    [applicationRecords],
  );
  const scopedApplyRunIds = useMemo(
    () => new Set(applyRuns.map((run) => run.id)),
    [applyRuns],
  );
  const applyResultsForSelectedRecord = useMemo(() => {
    if (!effectiveSelectedRecord) {
      return [];
    }

    return [...applyJobResults]
      .filter((result) => {
        if (result.applicationRecordId) {
          // Exact lineage is authoritative and is never re-attributed.
          return result.applicationRecordId === effectiveSelectedRecord.id;
        }

        // Legacy results predate application records; attach them only when
        // one scoped record owns the job inside a scoped run. Multiple records
        // for the same job keep ownership ambiguous, so nothing attaches.
        return (
          scopedApplyRunIds.has(result.runId) &&
          unambiguousRecordIdByJobId.get(result.jobId) ===
            effectiveSelectedRecord.id
        );
      })
      .sort(
        (left, right) =>
          Number(right.privacyReceipt?.finalSubmitOccurred === true) -
            Number(left.privacyReceipt?.finalSubmitOccurred === true) ||
          new Date(right.updatedAt).getTime() -
            new Date(left.updatedAt).getTime(),
      );
  }, [
    applyJobResults,
    effectiveSelectedRecord,
    scopedApplyRunIds,
    unambiguousRecordIdByJobId,
  ]);
  const effectiveSelectedApplyRunId = useMemo(() => {
    if (!effectiveSelectedRecord) {
      return null;
    }

    const applicationRecordId = effectiveSelectedRecord.id;
    const locallySelectedRunId =
      selectedApplyRunIdByApplicationRecordId[applicationRecordId] ?? null;

    if (
      locallySelectedRunId &&
      applyResultsForSelectedRecord.some(
        (result) => result.runId === locallySelectedRunId,
      )
    ) {
      return locallySelectedRunId;
    }

    // Otherwise the record's newest attempt. The workspace-wide selection is
    // the most recently *updated* run, which after a Try again is often the
    // older batch (a late write to it moves it forward). Following it here
    // aimed "Open the Job Finder browser" at the earlier, failed attempt, so
    // the kept page of the newer one was never handed to the person.
    return applyResultsForSelectedRecord[0]?.runId ?? null;
  }, [
    applyResultsForSelectedRecord,
    effectiveSelectedRecord,
    selectedApplyRunIdByApplicationRecordId,
  ]);
  const effectiveSelectedApplyResult = useMemo(
    () =>
      applyResultsForSelectedRecord.find(
        (result) => result.runId === effectiveSelectedApplyRunId,
      ) ??
      applyResultsForSelectedRecord[0] ??
      null,
    [applyResultsForSelectedRecord, effectiveSelectedApplyRunId],
  );
  const applyRunHistory = useMemo(
    () =>
      applyResultsForSelectedRecord.map((result) => ({
        result,
        run: applyRunsById.get(result.runId) ?? null,
      })),
    [applyResultsForSelectedRecord, applyRunsById],
  );
  const latestApplyRunIdForSelectedRecord =
    applyResultsForSelectedRecord[0]?.runId ?? null;
  const effectiveSelectedJobId = effectiveSelectedRecord?.jobId ?? null;
  const effectiveSelectedRunId = effectiveSelectedApplyResult?.runId ?? null;
  const selectedApplyRun = effectiveSelectedRunId
    ? (applyRunsById.get(effectiveSelectedRunId) ?? null)
    : null;
  const effectiveSelectedRunUpdatedAt = pickLatestIsoTimestamp(
    selectedApplyRun?.updatedAt,
    effectiveSelectedApplyResult?.updatedAt,
  );
  const {
    applyRunDetails,
    applyRunDetailsError,
    applyRunDetailsStatus,
    applyRunDetailsTarget,
    replaceApplyRunDetails,
  } = useApplicationsApplyRunDetails({
    jobId: effectiveSelectedJobId,
    applicationRecordId: effectiveSelectedRecord?.id ?? null,
    onGetApplyRunDetails,
    runId: effectiveSelectedRunId,
    runUpdatedAt: effectiveSelectedRunUpdatedAt,
  });
  const showLatestAttemptDetails =
    !effectiveSelectedApplyRunId ||
    !latestApplyRunIdForSelectedRecord ||
    effectiveSelectedApplyRunId === latestApplyRunIdForSelectedRecord;

  const handleSelectApplyRun = useCallback(
    (runId: string) => {
      if (!effectiveSelectedRecord) {
        return;
      }

      setSelectedApplyRunIdByApplicationRecordId((current) => ({
        ...current,
        [effectiveSelectedRecord.id]: runId,
      }));
    },
    [effectiveSelectedRecord],
  );

  useEffect(() => {
    if (
      !effectiveSelectedRecord ||
      effectiveSelectedRecord.id === selectedRecord?.id
    ) {
      return;
    }

    onSelectRecord(effectiveSelectedRecord.id);
  }, [effectiveSelectedRecord, onSelectRecord, selectedRecord?.id]);

  const hasCrmTrackerControls = Boolean(
    props.crmSettings &&
    props.onMutateApplicationCrm &&
    props.onExportApplicationCrm,
  );
  const hasUnassignedLegacyLineage =
    applicationAttempts.some(
      (attempt) =>
        !attempt.applicationRecordId &&
        !unambiguousRecordIdByJobId.has(attempt.jobId),
    ) ||
    applyJobResults.some(
      (result) =>
        !result.applicationRecordId &&
        (!unambiguousRecordIdByJobId.has(result.jobId) ||
          !scopedApplyRunIds.has(result.runId)),
    );
  // Retry, queue, and copilot refusals and backend errors are written as
  // route-owned statuses by the page controller; Applications owns their one
  // visible presentation. The controller's route scoping keeps sibling-route
  // messages from ever arriving here.
  const visibleActionMessage = resolveVisibleRouteActionMessage({
    actionMessage: props.actionMessage ?? null,
    dailyPreparationCapacity,
    latestRunAttentionCount,
  });
  // Conditions owned elsewhere, the latest automatic run and the bulk retry
  // are items on the header's status line, not boxes above the list
  // (ADR 0044). The tracker records stages by hand, which none of them stop.
  const applicationsStatusItems: PageStatusItem[] = [];
  if (workspaceView === "workflow") {
    const holdCount = props.safeguardsBlockerCount ?? 0;
    if (holdCount > 0) {
      applicationsStatusItems.push({
        id: "safeguard-holds",
        tone: "critical",
        text: `${holdCount} safeguard ${holdCount === 1 ? "hold is" : "holds are"} pausing some work`,
        ...(props.onOpenSafeguards
          ? {
              action: {
                kind: "link",
                label: "Open Safeguards",
                onClick: props.onOpenSafeguards,
              },
            }
          : {}),
      });
    }
    const retryCount = retryableJobIds.length;
    if (applicationRecords.length > 0 && retryCount > 1) {
      // One press queues them all; the Apply queue goes ten at a time and
      // waits for tomorrow at the daily limit (ADR 0058).
      applicationsStatusItems.push({
        id: "bulk-retry",
        tone: "warning",
        text: `${retryCount} applications need another try`,
        action: {
          kind: "button",
          label: `Try again for all ${retryCount}`,
          disabled: isApplyPending,
          onClick: () =>
            onStartAutoApplyQueue(
              retryableJobIds,
              props.applicationAutomationMode ?? "prepare_only",
            ),
        },
      });
    }
    // Completed runs belong in Activity; the run is named here only while
    // the person has an unresolved step in it.
    if (latestAutomaticRun && latestRunAttentionCount > 0) {
      const total = latestAutomaticRun.totalJobs;
      applicationsStatusItems.push({
        id: "latest-automatic-run",
        text: `Last automatic run: ${total} ${total === 1 ? "job" : "jobs"}, ${latestRunAttentionCount} ${latestRunAttentionCount === 1 ? "needs" : "need"} you`,
        action: {
          kind: "link",
          label: "Show them",
          onClick: () => handleFilterChange("needs_action"),
        },
      });
    }
  }
  const crmEmptyState = !hasCrmTrackerControls
    ? {
        title: "Tracking tools unavailable",
        description:
          "Application tracking tools are not available right now, so this pane has nothing to manage.",
      }
    : applicationRecords.length === 0
      ? {
          title: "No applications to track yet",
          description:
            "Shortlist a job or prepare an application and its local stages, notes, and exports will appear here.",
        }
      : !effectiveSelectedRecord
        ? {
            title: "No application selected",
            description:
              "Choose an application in the tracker to review and update its local stages, notes, and reminders.",
          }
        : {
            title: "No application selected in this view",
            description:
              "The application you had selected is not shown by this view's search or lifecycle filter, so its tracking tools are unavailable here. Clearing the search box, switching the lifecycle view, or choosing Show all applications will bring it back.",
          };

  return (
    <LockedScreenLayout
      contentClassName={
        workspaceView === "crm" ? "overflow-y-auto" : "xl:overflow-hidden"
      }
      // Applications is a two-pane route like Find jobs and Shortlisted, so it
      // needs the same viewport bound they pass. Without it the grid's `1fr`
      // row resolves to max-content, the workspace grid's `xl:h-full` resolves
      // against an indefinite height, `xl:overflow-hidden` clips nothing, and
      // the panes marked `data-locked-pane-scroll-region` never get a scroll
      // range — so the whole route scrolled as one page and the detail pane's
      // recovery action fell below the fold on any record with a long status
      // stack.
      lockContentHeight
      topContent={
        <>
          {/* One list, one state per application. The stage tracker — table,
              board, calendar, saved views, columns, export — is a separate
              destination reached by name, not a peer tab that renders a CRM
              beside a single record. */}
          <PageHeaderStack
            subnav={props.scopeControl}
            actions={
              workspaceView === "crm" ? (
                <Button
                  data-testid="applications-close-tracker"
                  onClick={() => setWorkspaceView("workflow")}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  <ArrowLeft aria-hidden="true" className="size-4" />
                  Back to Applications
                </Button>
              ) : applicationRecords.length > 0 ? (
                <>
                  {/* Outcomes has no navigation entry; it is reached from
                      here once something has been sent and can have one. */}
                  {props.onOpenOutcomes &&
                  applicationRecords.some((record) =>
                    OUTCOME_STATUSES.has(record.status),
                  ) ? (
                    <Button
                      className="border-(--control-border)"
                      data-testid="applications-open-outcomes"
                      onClick={props.onOpenOutcomes}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      See outcomes
                    </Button>
                  ) : null}
                  <Button
                    className="border-(--control-border)"
                    data-testid="applications-open-tracker"
                    onClick={() => setWorkspaceView("crm")}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Open tracker
                  </Button>
                </>
              ) : null
            }
            description={
              workspaceView === "crm"
                ? "Stages you record yourself, with notes, reminders and export. It never submits anything."
                : "Track your applications and where each one stands."
            }
            statusItems={applicationsStatusItems}
            title={workspaceView === "crm" ? "Tracker" : "Applications"}
          />
          {workspaceView === "workflow" && props.onControlApplyQueue ? (
            <ApplyQueueStrip
              dailyLimit={dailyPreparationCapacity?.limit ?? null}
              onControl={props.onControlApplyQueue}
              onRaiseLimit={() => props.onRaiseDailyLimit?.()}
              pending={isApplyPending}
              queue={props.applyQueue}
            />
          ) : null}
          {visibleActionMessage ? (
            <p
              aria-atomic="true"
              aria-live="polite"
              className="min-w-0 break-words rounded-(--radius-small) border border-primary/25 bg-primary/5 px-3 py-2 text-(length:--text-small) leading-6 text-foreground"
              data-testid="applications-route-action-status"
              role="status"
            >
              {visibleActionMessage}
            </p>
          ) : null}
        </>
      }
    >
      <div
        className={
          workspaceView === "crm"
            ? "grid min-w-0 items-stretch gap-4"
            : `grid min-w-0 items-stretch gap-4 xl:h-full xl:min-h-0 ${LIST_DETAIL_COLUMNS_CLASS} xl:items-start xl:overflow-hidden`
        }
        id="applications-workspace-content"
      >
        {workspaceView === "crm" ? (
          <ApplicationsCrmViews
            {...(props.homeTimeZone
              ? { homeTimeZone: props.homeTimeZone }
              : {})}
            {...(props.onMutateApplicationCrmBulkStage
              ? { onBulkChange: props.onMutateApplicationCrmBulkStage }
              : {})}
            {...(props.onMutateApplicationCrmBulkStage
              ? {
                  onBulkStageChange: async (recordIds, stage) => {
                    const recordsById = new Map(
                      applicationRecords.map((record) => [record.id, record]),
                    );
                    const missingRecordIds = recordIds.filter(
                      (recordId) => !recordsById.has(recordId),
                    );
                    if (missingRecordIds.length > 0) {
                      throw new Error(
                        "Some selected applications are no longer available. Refresh and try again.",
                      );
                    }
                    await props.onMutateApplicationCrmBulkStage?.({
                      items: recordIds.map((recordId) => ({
                        applicationRecordId: recordId,
                        expectedRevision:
                          recordsById.get(recordId)?.crm?.revision ?? 0,
                      })),
                      stage,
                      customStageId: null,
                      note: "Updated from the application tracker bulk action.",
                    });
                  },
                }
              : {})}
            {...(props.crmSettings
              ? { customStages: props.crmSettings.customStages }
              : {})}
            {...(props.onMutateApplicationCrm
              ? {
                  onCompleteReminder: async (recordId, reminderId) => {
                    const record = applicationRecords.find(
                      (entry) => entry.id === recordId,
                    );
                    const reminder = record?.crm?.reminders.find(
                      (entry) => entry.id === reminderId,
                    );
                    if (!record?.crm || !reminder) {
                      throw new Error(
                        "That reminder is no longer saved. Refresh and try again.",
                      );
                    }
                    const now = new Date().toISOString();
                    await props.onMutateApplicationCrm?.({
                      applicationRecordId: record.id,
                      expectedRevision: record.crm.revision,
                      mutation: {
                        type: "upsert_reminder",
                        reminder: {
                          ...reminder,
                          status: "completed",
                          updatedAt: now,
                          completedAt: now,
                        },
                      },
                    });
                  },
                }
              : {})}
            onSelectRecord={onSelectRecord}
            onViewChange={setCrmView}
            onVisibleRecordIdsChange={handleCrmVisibleRecordIdsChange}
            requestedRecordId={props.requestedRecordId ?? null}
            records={crmApplicationRecords}
            discoveryJobs={discoveryJobs}
            selectedRecordId={effectiveSelectedRecord?.id ?? null}
            view={crmView}
          />
        ) : (
          <ApplicationsRecordsPanel
            progressNow={progressNow}
            {...(props.crmSettings
              ? { customStages: props.crmSettings.customStages }
              : {})}
            activeFilter={activeFilter}
            applicationRecords={crmApplicationRecords}
            filterCounts={filterCounts}
            hasAnyApplications={applicationRecords.length > 0}
            searchPlanName={props.searchPlanName}
            hasOtherPlanApplications={props.hasOtherPlanApplications}
            liveRunLinesByJobId={liveRunLinesByJobId}
            latestApplyResultByRecordId={latestApplyResultByRecordId}
            readApplyRunContext={readApplyRunContext}
            applyMode={applyMode}
            hasUnassignedLegacyHistory={hasUnassignedLegacyLineage}
            onFilterChange={handleFilterChange}
            onSelectRecord={selectRecordAndRevealDetails}
            selectedRecord={effectiveSelectedRecord}
            discoveryJobs={discoveryJobs}
          />
        )}
        {workspaceView === "crm" ? (
          isSelectedRecordInCrmView &&
          effectiveSelectedRecord &&
          props.crmSettings &&
          props.onMutateApplicationCrm &&
          props.onExportApplicationCrm ? (
            <div
              className="min-h-0 overflow-auto pr-1"
              data-locked-pane-scroll-region
            >
              <ApplicationsCrmDetail
                {...(props.homeTimeZone
                  ? { homeTimeZone: props.homeTimeZone }
                  : {})}
                isRecordOutcomePending={
                  props.isRecordOutcomePending?.(
                    effectiveSelectedRecord.jobId,
                  ) ?? false
                }
                key={effectiveSelectedRecord.id}
                onExport={props.onExportApplicationCrm}
                onMutate={props.onMutateApplicationCrm}
                {...(props.onRecordOutcome
                  ? { onRecordOutcome: props.onRecordOutcome }
                  : {})}
                outcomeResumeStrategyId={
                  props.getOutcomeResumeStrategyId?.(
                    effectiveSelectedRecord.jobId,
                  ) ?? null
                }
                recordedOutcomes={
                  props.getRecordedOutcomes?.(effectiveSelectedRecord.id) ?? []
                }
                outcomeCampaignId={props.outcomeCampaignId ?? null}
                record={
                  crmApplicationRecords.find(
                    (record) => record.id === effectiveSelectedRecord.id,
                  ) ?? effectiveSelectedRecord
                }
                relatedJobCanonicalUrl={
                  discoveryJobs.find(
                    (job) => job.id === effectiveSelectedRecord.jobId,
                  )?.canonicalUrl ?? null
                }
                settings={props.crmSettings}
              />
            </div>
          ) : (
            <div className="min-h-0 overflow-auto pr-1">
              <EmptyState
                description={crmEmptyState.description}
                title={crmEmptyState.title}
              />
            </div>
          )
        ) : shouldPreserveHiddenSelection ? (
          <section className="surface-panel-shell relative flex min-w-0 flex-col gap-6 overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) px-8 py-5 xl:h-full xl:min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1">
                <p className="label-mono-xs">Details</p>
                <strong className="text-(length:--text-body) text-muted-foreground">
                  Filtered selection
                </strong>
              </div>
              <StatusBadge tone="muted">Not shown</StatusBadge>
            </div>
            <div className="flex min-h-0 flex-1 items-start justify-center pt-12">
              <EmptyState
                title="Selected application not shown by this filter"
                description={`The selected application is not shown by the ${APPLICATION_FILTER_LABELS[activeFilter]} filter. Try another filter to review it.`}
              />
            </div>
          </section>
        ) : (
          <ApplicationsDetailPanel
            progressNow={progressNow}
            {...(props.crmSettings
              ? { customStages: props.crmSettings.customStages }
              : {})}
            activeFilter={activeFilter}
            readApplyRunContext={readApplyRunContext}
            answerDraft={(() => {
              const request = userActionRequests?.find(
                (entry) =>
                  entry.kind === "manual_answer" &&
                  entry.scope.type === "application" &&
                  entry.scope.applicationRecordId === selectedRecord?.id &&
                  ["pending", "awaiting_user", "still_blocked"].includes(
                    entry.state,
                  ),
              );
              return request ? answerDrafts.current.get(request.id) : undefined;
            })()}
            answerDraftRestored={
              selectedRecord
                ? (userActionRequests ?? []).some(
                    (entry) =>
                      entry.kind === "manual_answer" &&
                      entry.scope.type === "application" &&
                      entry.scope.applicationRecordId === selectedRecord.id &&
                      restoredApplications.has(entry.id),
                  )
                : false
            }
            onAnswerDraftChange={(draft) => {
              const request = userActionRequests?.find(
                (entry) =>
                  entry.kind === "manual_answer" &&
                  entry.scope.type === "application" &&
                  entry.scope.applicationRecordId === selectedRecord?.id &&
                  ["pending", "awaiting_user", "still_blocked"].includes(
                    entry.state,
                  ),
              );
              if (request) return updateAnswerDraft(request, draft);
            }}
            applyRunDetails={applyRunDetails}
            applyRunDetailsTarget={applyRunDetailsTarget}
            applyRunDetailsError={applyRunDetailsError}
            applyRunDetailsStatus={applyRunDetailsStatus}
            applicationRecords={applicationRecords}
            applyJobResults={applyJobResults}
            dailyPreparationCapacity={dailyPreparationCapacity}
            discoveryJobs={discoveryJobs}
            applyRunHistory={applyRunHistory}
            effectiveSelectedApplyResult={effectiveSelectedApplyResult}
            hasAnyApplications={applicationRecords.length > 0}
            hasVisibleApplications={filteredApplicationRecords.length > 0}
            isApplyPending={isApplyPending}
            isApplyRequestPending={isApplyRequestPending}
            isApplyRunPending={isApplyRunPending}
            onApproveApplyRun={onApproveApplyRun}
            onCancelApplyRun={onCancelApplyRun}
            {...(props.onOpenCompany
              ? { onOpenCompany: props.onOpenCompany }
              : {})}
            selectedRecordCompanyId={
              effectiveSelectedRecord
                ? ((props.companies ?? []).find(
                    (company) =>
                      isListableCompanyName(company.canonicalName) &&
                      company.applicationRecordIds.includes(
                        effectiveSelectedRecord.id,
                      ),
                  )?.id ?? null)
                : null
            }
            onExportApplicationPacket={onExportApplicationPacket}
            {...(onResolveSubmissionOutcome
              ? { onResolveSubmissionOutcome }
              : {})}
            onSaveApplicationAnswer={async (command) => {
              replaceApplyRunDetails(await onSaveApplicationAnswer(command));
            }}
            onClearApplicationAnswer={async (command) => {
              replaceApplyRunDetails(await onClearApplicationAnswer(command));
            }}
            onResolveApplyConsentRequest={onResolveApplyConsentRequest}
            {...(onSubmitPreparedApplication
              ? { onSubmitPreparedApplication }
              : {})}
            {...(onPrepareApplicationAgain
              ? { onPrepareApplicationAgain }
              : {})}
            onRevokeApplyRunApproval={onRevokeApplyRunApproval}
            onStartAutoApplyQueue={(jobIds) =>
              onStartAutoApplyQueue(
                jobIds,
                props.applicationAutomationMode ?? "prepare_only",
              )
            }
            applyMode={applyMode}
            onSelectApplyRun={handleSelectApplyRun}
            onStartApplyCopilot={onStartApplyCopilot}
            {...(onReviewResumePdf ? { onReviewResumePdf } : {})}
            applicationAttempts={applicationAttempts}
            {...(props.onOpenNeedsYou
              ? { onOpenNeedsYou: props.onOpenNeedsYou }
              : {})}
            {...(userActionRequests ? { userActionRequests } : {})}
            {...(props.onPerformUserAction
              ? { onPerformUserAction: props.onPerformUserAction }
              : {})}
            {...(props.isUserActionPending
              ? { isUserActionPending: props.isUserActionPending }
              : {})}
            {...(props.onAllowSiteSaves
              ? { onAllowSiteSaves: props.onAllowSiteSaves }
              : {})}
            {...(props.onOpenSafeguards
              ? { onOpenSafeguards: props.onOpenSafeguards }
              : {})}
            canConfirmFinishedInBrowser={
              props.canConfirmFinishedInBrowser ?? false
            }
            browserStepContinuesOnItsOwn={
              props.browserStepContinuesOnItsOwn ?? false
            }
            confirmFinishedInBrowserStatus={
              props.confirmFinishedInBrowserStatus ?? "idle"
            }
            confirmFinishedInBrowserBlockerText={
              props.confirmFinishedInBrowserBlockerText ?? null
            }
            {...(props.onConfirmFinishedInBrowser
              ? {
                  onConfirmFinishedInBrowser: props.onConfirmFinishedInBrowser,
                }
              : {})}
            {...(props.onFinishInBrowser
              ? { onFinishInBrowser: props.onFinishInBrowser }
              : {})}
            selectedApplyRunId={effectiveSelectedApplyRunId}
            selectedAttempt={
              showLatestAttemptDetails ? effectiveSelectedAttempt : null
            }
            selectedRecord={effectiveSelectedRecord}
          />
        )}
      </div>
    </LockedScreenLayout>
  );
}
