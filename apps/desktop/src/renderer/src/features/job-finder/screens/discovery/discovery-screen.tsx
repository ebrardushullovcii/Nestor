import { LIST_DETAIL_COLUMNS_CLASS } from "../../components/list-detail-columns";
import { useJobDetail } from "../../hooks/use-job-detail";
import { useDiscoveryTriage } from "./discovery-triage";
import { useStableCallback } from "../../hooks/use-stable-callback";
import { campaignPlanEditorHref } from "../../lib/job-finder-route-hrefs";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import type {
  BrowserSessionState,
  FitJudgmentProgress,
  ApplicationRecord,
  CompanyEntity,
  DiscoveryAdapterSessionState,
  DiscoveryActivityEvent,
  DiscoveryFeedbackReason,
  EmployerExclusionPreview,
  DiscoveryRunRecord,
  JobSearchCampaign,
  JobFinderSearchRequest,
  JobSearchPreferences,
  JobSearchSelectivity,
  PlanSafeguardPause,
  ReviewQueueItem,
  SourceAccessPrompt,
  JobListRow,
} from "@nestor/contracts";
import {
  resolveCampaignSourceTargetIds,
  isListableCompanyName,
} from "@nestor/contracts";
import { X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { getDiscoveryRuntimeProjection } from "./discovery-search-readiness";
import {
  createDiscoveryRunCancelledFeedback,
  createDiscoveryRunInterruptedFeedback,
  isDiscoveryFailureSuperseded,
  createDiscoveryRunSafeguardPausedFeedback,
  createDiscoveryRunStartedFeedback,
  createDiscoveryRunSucceededFeedback,
} from "./discovery-run-feedback";
import { LockedScreenLayout } from "@renderer/features/job-finder/components/locked-screen-layout";
import {
  PageHeaderStack,
  type PageStatusAction,
  type PageStatusItem,
} from "@renderer/features/job-finder/components/page-header";
import { OPEN_JOB_FINDER_BROWSER_ACTION } from "@renderer/features/job-finder/lib/job-finder-browser-handoff-copy";
import { JOB_FINDER_ROUTE_PATHS } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import { formatCountLabel } from "@renderer/features/job-finder/lib/job-finder-utils";
import {
  formatDiscoveryRunReportLabel,
  formatDiscoveryRunCountLabel,
  getDiscoveryRunReportCounts,
  getDiscoveryRunCountEvidence,
  hasDiscoveryRunReportCounts,
} from "@renderer/features/job-finder/lib/discovery-run-count-label";
import { settleJobFinderRouteHeaderScroll } from "@renderer/features/job-finder/lib/job-finder-scroll-reveal";
import { DiscoveryHistoryModal } from "./discovery-activity-panel";
import {
  isDiscoveryAlsoFoundResult,
  isDiscoveryDecidedJob,
} from "./discovery-result-groups";
import {
  DISCOVERY_SEARCH_SETUP_PANEL_ID,
  DiscoverySearchBar,
} from "./discovery-search-bar";
import { DiscoveryDetailPanel } from "./discovery-detail-panel";

import { formatDiscoveryHideReason } from "./discovery-hide-reason-options";
import { DiscoveryFiltersPanel } from "./discovery-filters-panel";
import {
  DISCOVERY_OFFLINE_CATALOG_NOTICE_ID,
  DISCOVERY_SEARCH_SETUP_BLOCKER_ID,
  DiscoveryResultsPanel,
} from "./discovery-results-panel";
import { DiscoveryRunFeedbackCallout } from "./discovery-run-feedback-callout";
import {
  getDiscoveryLatestRunNotices,
  getDiscoveryLatestRunVerdict,
  type DiscoveryRunFeedback,
} from "./discovery-run-feedback";
import { compareDiscoveryFitOrder } from "./discovery-results-sort";
import { useDiscoveryStopState } from "@renderer/features/job-finder/lib/discovery-stop-state";
import { DISCOVERY_STOP_UNACKNOWLEDGED_LABEL } from "@renderer/features/job-finder/lib/status-copy";
import { getDiscoverySearchReadiness } from "./discovery-search-readiness";
import type {
  ActionState,
  JobFinderQueuedJobOutcome,
} from "@renderer/features/job-finder/lib/job-finder-types";
import { cn } from "@renderer/lib/cn";
import { useAssistantContextSource } from "../../assistant/assistant-provider";
import { createIdentityMemo } from "../../lib/identity-memo";

export function getDiscoveryConfiguredFilters(
  searchPreferences: JobSearchPreferences,
) {
  const enabledSourceCount =
    getDiscoverySearchReadiness(searchPreferences).enabledSourceCount;
  const searchTargetCount =
    searchPreferences.targetRoles.length + searchPreferences.jobFamilies.length;

  // A remote-only search has no locations by design; reporting "0 locations"
  // beside "1 work mode" reads as a setup error instead of the intended
  // configuration.
  const isRemoteOnlySearch =
    searchPreferences.locations.length === 0 &&
    searchPreferences.workModes.length > 0 &&
    searchPreferences.workModes.every((workMode) => workMode === "remote");

  return [
    searchTargetCount > 0
      ? formatCountLabel(searchTargetCount, "search target")
      : "No search targets",
    ...(isRemoteOnlySearch
      ? ["remote only"]
      : [
          formatCountLabel(searchPreferences.locations.length, "location"),
          formatCountLabel(searchPreferences.workModes.length, "work mode"),
        ]),
    formatCountLabel(enabledSourceCount, "enabled source"),
  ];
}
export {
  DISCOVERY_CLEAR_MISMATCH_SCORE_FLOOR,
  isDiscoveryClearMismatch,
} from "./discovery-result-groups";

/**
 * Whether Find jobs opens with the weaker matches shown. It follows the rule
 * that picks a search's own mode (ADR 0025): "Cast a wide net" runs broad,
 * "Best matches only" runs precise, and the middle setting defers to the
 * plan's mode.
 */
export function resolveDiscoveryListOpensWide(
  searchSelectivity: JobSearchSelectivity | null | undefined,
  activeCampaignMode: "precision" | "scale",
): boolean {
  if (searchSelectivity === "wide_net") return true;
  if (searchSelectivity === "best_matches") return false;
  return activeCampaignMode === "scale";
}

export function getNewestRunForCampaign(
  recentRuns: readonly DiscoveryRunRecord[],
  campaignId: string | null,
): DiscoveryRunRecord | null {
  return (
    [...recentRuns]
      .filter((run) => (run.campaignId ?? null) === campaignId)
      .sort(
        (left, right) =>
          Date.parse(right.startedAt) - Date.parse(left.startedAt),
      )[0] ?? null
  );
}

const NO_REVIEW_QUEUE: readonly ReviewQueueItem[] = [];

export function getDiscoveryResultVisibility(
  jobs: readonly JobListRow[],
  selectedJob: JobListRow | null,
  showAlsoFound: boolean,
  preserveSelectedJob = false,
  stableOrderIds?: readonly string[],
): {
  alsoFoundCount: number;
  hiddenAlsoFoundCount: number;
  jobs: readonly JobListRow[];
  selectedJob: JobListRow | null;
} {
  // Weaker matches and clear mismatches are one "also found" pool. Presenting
  // them beside the leading band made the headline count describe jobs the
  // app itself had already scored well below the saved targets.
  const alsoFound = jobs.filter(isDiscoveryAlsoFoundResult);
  // A deep-linked selection keeps only that job visible even when it is in the
  // also-found pool; the rest stay hidden so the preserve path never silently
  // reveals the whole pool.
  const displayCandidates = showAlsoFound
    ? jobs
    : jobs.filter(
        (job) =>
          !isDiscoveryAlsoFoundResult(job) ||
          (preserveSelectedJob && job.id === selectedJob?.id),
      );
  // Ordering is the canonical Best-match chain (see compareDiscoveryFitOrder),
  // so the visible sequence always equals the rediscovery rank-audit sequence
  // for the same candidate set instead of depending on arrival order.
  const stableOrder = stableOrderIds
    ? new Map(stableOrderIds.map((id, index) => [id, index]))
    : null;
  const visibleJobs = displayCandidates.slice().sort((left, right) => {
    if (stableOrder) {
      const leftIndex = stableOrder.get(left.id);
      const rightIndex = stableOrder.get(right.id);
      if (leftIndex !== undefined || rightIndex !== undefined) {
        if (leftIndex === undefined) return 1;
        if (rightIndex === undefined) return -1;
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      }
    }
    return compareDiscoveryFitOrder(left, right);
  });
  const visibleSelectedJob =
    selectedJob && visibleJobs.some((job) => job.id === selectedJob.id)
      ? selectedJob
      : (visibleJobs[0] ?? null);
  const visibleJobIds = new Set(visibleJobs.map((job) => job.id));

  return {
    alsoFoundCount: alsoFound.length,
    // Truthful hidden count: also-found rows actually absent from the
    // displayed list, so a deep-linked row held visible counts as shown.
    hiddenAlsoFoundCount: alsoFound.filter((job) => !visibleJobIds.has(job.id))
      .length,
    jobs: visibleJobs,
    selectedJob: visibleSelectedJob,
  };
}

export interface StableDiscoveryRunSnapshot {
  runId: string;
  jobIds: readonly string[];
  /** Only the verdict each row shows; holding whole jobs kept a second copy. */
  assessmentsById: ReadonlyMap<string, JobListRow["matchAssessment"]>;
}

/**
 * Keeps rows in the order they were first shown during a run, appends only
 * genuinely new rows, and holds each row's verdict once it has one, so a
 * rescore after a listing read does not reshuffle the list mid-search. A row
 * still waiting for its first verdict shows it as soon as the model gives it:
 * fit is judged while the search runs (ADR 0041), and freezing the unjudged
 * state hid every one of those scores until the search ended. The terminal
 * render receives the current objects once.
 */
export function updateStableDiscoveryRunSnapshot(input: {
  current: StableDiscoveryRunSnapshot | null;
  jobs: readonly JobListRow[];
  runId: string | null;
}): {
  jobs: readonly JobListRow[];
  snapshot: StableDiscoveryRunSnapshot | null;
} {
  if (!input.runId) {
    return { jobs: input.jobs, snapshot: null };
  }

  if (input.current?.runId !== input.runId) {
    const ordered = input.jobs.slice().sort(compareDiscoveryFitOrder);
    return {
      jobs: ordered,
      snapshot: {
        runId: input.runId,
        jobIds: ordered.map((job) => job.id),
        assessmentsById: new Map(
          ordered.map((job) => [job.id, job.matchAssessment]),
        ),
      },
    };
  }

  const current = input.current;
  const appended: JobListRow[] = [];
  const firstVerdicts: JobListRow[] = [];
  for (const job of input.jobs) {
    const held = current.assessmentsById.get(job.id);
    if (!held) appended.push(job);
    else if (!held.judgment && job.matchAssessment.judgment) {
      firstVerdicts.push(job);
    }
  }
  const snapshot =
    appended.length === 0 && firstVerdicts.length === 0
      ? current
      : {
          runId: input.runId,
          jobIds:
            appended.length === 0
              ? current.jobIds
              : [...current.jobIds, ...appended.map((job) => job.id)],
          assessmentsById: new Map([
            ...current.assessmentsById,
            ...[...appended, ...firstVerdicts].map(
              (job) => [job.id, job.matchAssessment] as const,
            ),
          ]),
        };
  const currentJobsById = new Map(input.jobs.map((job) => [job.id, job]));
  return {
    jobs: snapshot.jobIds.flatMap((id) => {
      const currentJob = currentJobsById.get(id);
      const heldAssessment = snapshot.assessmentsById.get(id);
      if (!currentJob || !heldAssessment) return [];
      return heldAssessment === currentJob.matchAssessment
        ? [currentJob]
        : [{ ...currentJob, matchAssessment: heldAssessment }];
    }),
    snapshot,
  };
}

/**
 * Resolves the job the inspector should describe. The results panel reports
 * which job it actually displays on the current filtered and paginated page;
 * until the first report arrives (`displayedJobId === undefined`), the
 * pre-existing default-selection behavior applies. An explicit `null` report
 * means the visible page is empty and the inspector must clear rather than
 * keep describing a row the user cannot see.
 */
export function getDiscoveryInspectedJob(
  rankedJobs: readonly JobListRow[],
  requestedJobId: string | null,
  displayedJobId: string | null | undefined,
): JobListRow | null {
  if (displayedJobId === undefined) {
    const requested = requestedJobId
      ? rankedJobs.find((job) => job.id === requestedJobId)
      : undefined;
    return requested ?? rankedJobs[0] ?? null;
  }
  if (displayedJobId === null) {
    return null;
  }
  return rankedJobs.find((job) => job.id === displayedJobId) ?? null;
}

/**
 * The search preferences as the active plan runs them: the workspace sources,
 * switched on or off by the plan. One object per workspace preferences and
 * plan, so the source list keeps its identity between renders and visits and
 * every per-source lookup built from it is reused instead of rebuilt.
 */
const resolvePlanSearchPreferences = createIdentityMemo(
  (
    workspaceSearchPreferences: JobSearchPreferences,
    selectedCampaign: JobSearchCampaign | undefined,
  ): JobSearchPreferences => {
    if (!selectedCampaign) return workspaceSearchPreferences;
    const effectiveSourceIds = new Set(
      resolveCampaignSourceTargetIds({
        ...selectedCampaign,
        searchPreferences: {
          ...selectedCampaign.searchPreferences,
          discovery: workspaceSearchPreferences.discovery,
        },
      }),
    );
    return {
      ...workspaceSearchPreferences,
      discovery: {
        ...workspaceSearchPreferences.discovery,
        targets: workspaceSearchPreferences.discovery.targets.map(
          (target) => ({
            ...target,
            enabled: effectiveSourceIds.has(target.id),
          }),
        ),
      },
    };
  },
);

/**
 * The visible list for one collection, kept across selections and visits.
 * Selecting a row only changes which row is selected, so the list is not
 * filtered and sorted again for it; only a held deep-linked row takes part.
 */
const getMemoizedResultVisibility = createIdentityMemo(
  (
    jobs: readonly JobListRow[],
    showAlsoFound: boolean,
    preservedSelectedJob: JobListRow | null,
    stableOrderIds: readonly string[] | undefined,
  ) =>
    getDiscoveryResultVisibility(
      jobs,
      preservedSelectedJob,
      showAlsoFound,
      preservedSelectedJob !== null,
      stableOrderIds,
    ),
);

const getHiddenAlsoFoundJobs = createIdentityMemo(
  (visibleJobs: readonly JobListRow[], allJobs: readonly JobListRow[]) => {
    const visibleIds = new Set(visibleJobs.map((job) => job.id));
    return allJobs.filter((job) => !visibleIds.has(job.id));
  },
);

/**
 * The person's own Show/Hide weaker matches choice per plan and opening rule,
 * kept for this app session. Without it every visit to Find jobs reset the
 * list, so the total jumped between the strong matches and all jobs.
 */
const weakerMatchesChoices = new Map<string, boolean>();

export function DiscoveryScreen(props: {
  actionState: Pick<ActionState, "message" | "actionLink">;
  activityPaused?: boolean;
  activeRun: DiscoveryRunRecord | null;
  applicationRecords?: readonly ApplicationRecord[];
  /**
   * Shortlisted rows, so the inspector's readiness badge reads the same value
   * Shortlisted renders instead of deriving a second one from the job status.
   */
  reviewQueue?: readonly ReviewQueueItem[];
  /** Search plans the page can switch between; Search now runs the current one. */
  campaigns?: readonly JobSearchCampaign[];
  safeguardPauses?: readonly PlanSafeguardPause[];
  activeCampaignId?: string | null;
  isPlanSwitchPending?: boolean;
  onSelectCampaign?: (campaignId: string) => void;
  browserSession: BrowserSessionState;
  companies?: readonly CompanyEntity[];
  discoveryRunFeedback?: DiscoveryRunFeedback | null;
  fitJudgmentProgress?: FitJudgmentProgress | null;
  discoverySessions: readonly DiscoveryAdapterSessionState[];
  isBrowserSessionPending: boolean;
  isBrowserSessionPendingForTarget: (targetId: string) => boolean;
  isDiscoveryAllPending: boolean;
  isActivityPausePending?: boolean;
  isJobPending: (jobId: string) => boolean;
  isTargetPending: (targetId: string) => boolean;
  jobs: readonly JobListRow[];
  dismissedJobs: readonly JobListRow[];
  liveEvents: readonly DiscoveryActivityEvent[];
  onBackToRapidReview?: () => void;
  /** Cancels the active run through the same fenced request the Task Center uses. */
  onCancelDiscovery?: (runId: string) => Promise<boolean>;
  onResumeActivity?: () => void;
  onDismissJob: (
    jobId: string,
    reasons: readonly DiscoveryFeedbackReason[],
    action?: "hide_job" | "hide_and_exclude_employer",
    expectedNormalizedCompanyName?: string | null,
    options?: { quiet?: boolean },
  ) => void | Promise<void>;
  /** Takes jobs back off the shortlist (the triage pass's Undo). */
  onRemoveFromShortlist?: (
    jobIds: readonly string[],
    options?: { quiet?: boolean },
  ) => Promise<void>;
  onPreviewEmployerExclusion?: (
    jobId: string,
  ) => Promise<EmployerExclusionPreview>;
  onRemoveEmployerExclusion?: (input: {
    jobId: string;
    normalizedCompanyName: string;
  }) => void;
  onRestoreDismissedJob: (
    jobId: string,
    options?: { quiet?: boolean },
  ) => void;
  onOpenBrowserSession: () => void;
  onOpenBrowserSessionForTarget: (targetId: string) => void;
  onOpenCompany?: (companyId: string) => void;
  onOpenApplication?: (recordId: string) => void;
  /** Opens a job's original listing page in the Job Finder browser. */
  onOpenListing?: (url: string) => void;
  onAssessJobListing?: (jobId: string) => Promise<void>;
  onJudgeUnjudgedJobs?: () => Promise<void>;
  onQueueJob: (
    jobId: string,
    options?: { quiet?: boolean },
  ) => void | Promise<JobFinderQueuedJobOutcome>;
  onQueueJobs?: (
    jobIds: readonly string[],
  ) => Promise<JobFinderQueuedJobOutcome>;
  /** Hides every selected job as Not interested, in one request. */
  onDismissJobs?: (jobIds: readonly string[]) => Promise<void>;
  onRunAgentDiscovery:
    | ((searchRequest?: JobFinderSearchRequest) => void)
    | undefined;
  onRunDiscoveryForTarget?: (targetId: string) => void;
  onSelectJob: (jobId: string) => void;
  recentRuns: readonly DiscoveryRunRecord[];
  searchPreferences: JobSearchPreferences;
  /** How picky the search is, from Settings, AI behavior; shown read-only. */
  searchSelectivity?: JobSearchSelectivity | null;
  preserveSelectedJob?: boolean;
  selectedJob: JobListRow | null;
  selectedSourceTargetId?: string | null;
  sourceAccessPrompts: readonly SourceAccessPrompt[];
}) {
  const {
    actionState,
    activityPaused = false,
    activeRun,
    applicationRecords = [],
    reviewQueue = NO_REVIEW_QUEUE,
    campaigns,
    safeguardPauses = [],
    activeCampaignId = null,
    isPlanSwitchPending = false,
    onSelectCampaign,
    browserSession,
    companies,
    discoveryRunFeedback = null,
    discoverySessions,
    isActivityPausePending = false,
    isBrowserSessionPending,
    isBrowserSessionPendingForTarget,
    isDiscoveryAllPending,
    isJobPending,
    isTargetPending,
    jobs,
    dismissedJobs,
    liveEvents,
    onBackToRapidReview,
    onCancelDiscovery,
    onDismissJob,
    onRemoveFromShortlist,
    onResumeActivity,
    onPreviewEmployerExclusion,
    onRemoveEmployerExclusion,
    onRestoreDismissedJob,
    onOpenBrowserSession,
    onOpenBrowserSessionForTarget,
    onOpenCompany,
    onOpenApplication,
    onOpenListing,
    onQueueJob,
    onQueueJobs,
    onDismissJobs,
    onAssessJobListing,
    onJudgeUnjudgedJobs,
    onRunAgentDiscovery,
    onSelectJob,
    recentRuns,
    searchPreferences: workspaceSearchPreferences,
    searchSelectivity = null,
    preserveSelectedJob,
    selectedJob,
    selectedSourceTargetId,
    sourceAccessPrompts,
  } = props;
  const selectedCampaign = campaigns?.find(
    (plan) => plan.id === activeCampaignId,
  );
  const searchPreferences = resolvePlanSearchPreferences(
    workspaceSearchPreferences,
    selectedCampaign,
  );
  const activeCampaignMode =
    campaigns?.find((campaign) => campaign.id === activeCampaignId)?.mode ??
    "precision";
  const [showHistory, setShowHistory] = useState(false);
  // The list opens as wide as the search ran: "Cast a wide net" (and a scale
  // plan under the middle setting) shows the weaker matches too, the same
  // rule that picks the run's own mode. "Best matches only" always opens on
  // the strong matches.
  const opensWide = resolveDiscoveryListOpensWide(
    searchSelectivity,
    activeCampaignMode,
  );
  const weakerMatchesChoiceKey = `${activeCampaignId ?? ""}|${opensWide}`;
  const [showAlsoFound, setShowAlsoFoundState] = useState(
    () => weakerMatchesChoices.get(weakerMatchesChoiceKey) ?? opensWide,
  );
  useEffect(() => {
    setShowAlsoFoundState(
      weakerMatchesChoices.get(weakerMatchesChoiceKey) ?? opensWide,
    );
  }, [weakerMatchesChoiceKey, opensWide]);
  const setShowAlsoFound = useStableCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      setShowAlsoFoundState((current) => {
        const value = typeof next === "function" ? next(current) : next;
        weakerMatchesChoices.set(weakerMatchesChoiceKey, value);
        return value;
      });
    },
  );
  // What the results panel actually displays on its current filtered and
  // paginated page. Null state means "not reported yet"; an explicit null
  // jobId means the panel is showing no results at all.
  const [displayedSelection, setDisplayedSelection] = useState<{
    jobId: string | null;
    campaignId: string | null | undefined;
  } | null>(null);
  // Results-mode feedback for the Shortlist decision, keyed by the exact
  // clicked job. Each `onQueueJob` call resolves its own awaited outcome, so
  // overlapping shortlists resolving out of order, search completions, and
  // Hide/Restore route messages can never cross-label a row. Route action
  // statuses share one surface above both workspaces (never duplicated in
  // either), so this per-row surface neither duplicates them nor lets a
  // route-level failure adopt another row's attribution.
  const [queueOutcomesByJobId, setQueueOutcomesByJobId] = useState<
    ReadonlyMap<string, JobFinderQueuedJobOutcome>
  >(new Map());
  // Single-shot stop request for the currently running discovery run. The
  // request reuses the same fenced cancellation as the Task Center, so the
  // local flag only keeps the header control from sending duplicates until
  // the run leaves its running state.
  const [isStopSearchRequested, setIsStopSearchRequested] = useState(false);
  const handleQueueJob = useCallback(
    (jobId: string) => {
      // Request-local attribution: each click owns its own resolved outcome,
      // so overlapping shortlists, search completions, and shared route
      // messages can never cross-label another row.
      return Promise.resolve(onQueueJob(jobId))
        .then((outcome) => {
          if (!outcome) {
            return;
          }
          setQueueOutcomesByJobId((current) =>
            new Map(current).set(jobId, outcome),
          );
        })
        .catch(() => {
          setQueueOutcomesByJobId((current) =>
            new Map(current).set(jobId, {
              message: "The requested Job Finder action failed.",
              status: "failure",
            }),
          );
        });
    },
    [onQueueJob],
  );
  // Results own the page. Search setup is a disclosure opened from the search
  // bar's chips, so editing what the search looks for never costs a
  // navigation act and never hides a finished search behind a tab.
  // Results own the page from the first visit too: the goal box and Search
  // now are the whole setup a person needs; the defaults panel is one click.
  const [openSetupChipId, setOpenSetupChipId] = useState<string | null>(null);
  const isSetupOpen = openSetupChipId !== null;
  const selectedPlanRuns = useMemo(
    () =>
      activeCampaignId === null
        ? recentRuns
        : recentRuns.filter((run) => run.campaignId === activeCampaignId),
    [activeCampaignId, recentRuns],
  );
  const selectedPlanLatestRun = useMemo(
    () =>
      [...selectedPlanRuns].sort(
        (left, right) =>
          Date.parse(right.startedAt) - Date.parse(left.startedAt),
      )[0] ?? null,
    [selectedPlanRuns],
  );
  const selectedPlanSafeguardRoute =
    safeguardPauses.find((pause) => pause.campaignId === activeCampaignId)
      ?.route ?? null;
  const selectedPlanRunReportLabel = useMemo(() => {
    if (selectedPlanLatestRun?.state !== "completed") return null;
    const counts = getDiscoveryRunReportCounts(selectedPlanLatestRun);
    return hasDiscoveryRunReportCounts(counts)
      ? formatDiscoveryRunReportLabel(counts)
      : null;
  }, [selectedPlanLatestRun]);
  const selectedPlanRunFeedback = useMemo(() => {
    if (
      activeRun?.state === "running" &&
      activeRun.campaignId === activeCampaignId
    ) {
      return createDiscoveryRunStartedFeedback();
    }
    if (!selectedPlanLatestRun) return null;
    if (selectedPlanLatestRun.state === "completed") {
      if (selectedPlanSafeguardRoute) {
        return createDiscoveryRunSafeguardPausedFeedback(
          selectedPlanSafeguardRoute,
        );
      }
      return createDiscoveryRunSucceededFeedback(
        null,
        selectedPlanRunReportLabel ??
          formatDiscoveryRunCountLabel(
            getDiscoveryRunCountEvidence(selectedPlanLatestRun, null),
          ),
        getDiscoveryRunReportCounts(selectedPlanLatestRun).new,
        selectedPlanLatestRun.targetExecutions?.filter(
          (source) => source.state === "failed",
        ).length ?? 0,
      );
    }
    if (selectedPlanLatestRun.state === "cancelled") {
      return createDiscoveryRunCancelledFeedback({
        savedJobCount: selectedPlanLatestRun.summary?.validJobsFound,
      });
    }
    if (selectedPlanLatestRun.state === "failed") {
      return createDiscoveryRunInterruptedFeedback({
        detail: selectedPlanLatestRun.summary?.warnings?.at(-1) ?? null,
      });
    }
    return null;
  }, [
    activeCampaignId,
    activeRun,
    selectedPlanLatestRun,
    selectedPlanRunReportLabel,
    selectedPlanSafeguardRoute,
  ]);
  const failureSupersededByCompletedRun = isDiscoveryFailureSuperseded({
    feedback: discoveryRunFeedback,
    targetId:
      discoveryRunFeedback?.targetId ??
      searchPreferences.discovery.targets.find(
        (target) => target.label === discoveryRunFeedback?.targetLabel,
      )?.id ??
      null,
    runs:
      discoveryRunFeedback?.targetLabel || discoveryRunFeedback?.targetId
        ? recentRuns
        : selectedPlanLatestRun
          ? [selectedPlanLatestRun]
          : [],
  });
  const currentDiscoveryRunFeedback =
    discoveryRunFeedback &&
    ((discoveryRunFeedback.status === "failed" &&
      !failureSupersededByCompletedRun) ||
      selectedPlanLatestRun === null ||
      (discoveryRunFeedback.status === "started" &&
        (activeRun == null || activeRun.campaignId === activeCampaignId)))
      ? discoveryRunFeedback
      : selectedPlanRunFeedback;
  // A dismissed banner stays gone for that exact verdict; the next run, or
  // the same run changing state, brings a fresh one.
  const [dismissedFeedbackKeys, setDismissedFeedbackKeys] = useState<string[]>(
    () => {
      try {
        const stored: unknown = JSON.parse(
          window.localStorage.getItem("nestor.discovery.dismissed-feedback") ??
            "[]",
        );
        return Array.isArray(stored)
          ? stored
              .filter((key): key is string => typeof key === "string")
              .slice(-100)
          : [];
      } catch {
        return [];
      }
    },
  );
  const currentFeedbackKey = currentDiscoveryRunFeedback
    ? `${currentDiscoveryRunFeedback.status}|${currentDiscoveryRunFeedback.headline}|${activeRun?.id ?? selectedPlanLatestRun?.id ?? ""}`
    : null;
  // A finished or stopped search needs nothing from the person, so it is a
  // toast, not a banner over the results (ADR 0042). Only a change seen on
  // this visit is announced: the verdict standing when the screen opens
  // describes a search that ended before, and the results already show it.
  const { showToast } = useToast();
  const searchVisibleJobs = useRef<{
    runId: string;
    planId: string | null | undefined;
    ids: Set<string>;
  } | null>(null);
  useEffect(() => {
    if (activeRun?.state === "running") {
      if (activeRun.campaignId && activeRun.campaignId !== activeCampaignId) {
        searchVisibleJobs.current = null;
        return;
      }
      if (
        searchVisibleJobs.current?.runId !== activeRun.id ||
        searchVisibleJobs.current.planId !== activeCampaignId
      ) {
        searchVisibleJobs.current = {
          runId: activeRun.id,
          planId: activeCampaignId,
          ids: new Set(
            props.jobs
              .filter((job) => !isDiscoveryAlsoFoundResult(job))
              .map((job) => job.id),
          ),
        };
      }
      for (const job of props.jobs) {
        if (!isDiscoveryAlsoFoundResult(job))
          searchVisibleJobs.current.ids.add(job.id);
      }
      return;
    }
    const previous = searchVisibleJobs.current;
    if (!previous) return;
    searchVisibleJobs.current = null;
    if (previous.planId !== activeCampaignId) return;
    const currentById = new Map(props.jobs.map((job) => [job.id, job]));
    const left = [...previous.ids].filter((id) => !currentById.has(id)).length;
    const moved = props.jobs.filter(
      (job) => previous.ids.has(job.id) && isDiscoveryAlsoFoundResult(job),
    ).length;
    if (left > 0 || moved > 0)
      showToast({
        title: [
          left > 0
            ? `${left} ${left === 1 ? "job left" : "jobs left"} this plan after the fit check.`
            : null,
          moved > 0
            ? `${moved} ${moved === 1 ? "job moved" : "jobs moved"} to weaker matches after the fit check.`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        ...(moved > 0 && !showAlsoFound
          ? {
              action: {
                label: "Show weaker matches",
                onClick: () => setShowAlsoFound(true),
              },
            }
          : {}),
      });
  }, [activeRun, activeCampaignId, props.jobs, showAlsoFound, showToast]);
  const assessedRequest = useRef<{
    id: string;
    previous: JobListRow["matchAssessment"];
  } | null>(null);
  const assessJobWithFeedback = onAssessJobListing
    ? async (id: string) => {
        const job = props.jobs.find((job) => job.id === id);
        if (job)
          assessedRequest.current = { id, previous: job.matchAssessment };
        try {
          await onAssessJobListing(id);
        } catch (error) {
          assessedRequest.current = null;
          throw error;
        }
      }
    : undefined;
  useEffect(() => {
    const request = assessedRequest.current;
    if (!request) return;
    const job = props.jobs.find((job) => job.id === request.id);
    if (
      !job ||
      job.matchAssessment === request.previous ||
      job.matchAssessment.judgment?.judgedAt ===
        request.previous.judgment?.judgedAt
    )
      return;
    assessedRequest.current = null;
    if (!showAlsoFound && isDiscoveryAlsoFoundResult(job))
      showToast({
        title: `Assessed: ${job.matchAssessment.score}% fit, moved to weaker matches`,
        action: {
          label: "Show weaker matches",
          onClick: () => setShowAlsoFound(true),
        },
      });
  }, [props.jobs, showAlsoFound, showToast]);
  const announcedFeedbackKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (announcedFeedbackKeyRef.current === undefined) {
      announcedFeedbackKeyRef.current = currentFeedbackKey;
      return;
    }
    if (announcedFeedbackKeyRef.current === currentFeedbackKey) return;
    announcedFeedbackKeyRef.current = currentFeedbackKey;
    const toast = currentDiscoveryRunFeedback?.toast;
    if (!toast) return;
    showToast({
      id: "discovery-run",
      title: toast.title,
      ...(toast.description ? { description: toast.description } : {}),
      tone:
        currentDiscoveryRunFeedback?.status === "succeeded" &&
        !currentDiscoveryRunFeedback.partial
          ? "success"
          : "neutral",
    });
  }, [currentDiscoveryRunFeedback, currentFeedbackKey, showToast]);
  const visibleDiscoveryRunFeedback =
    currentFeedbackKey !== null &&
    dismissedFeedbackKeys.includes(currentFeedbackKey)
      ? null
      : currentDiscoveryRunFeedback;
  const [dismissedActionMessage, setDismissedActionMessage] = useState<
    string | null
  >(null);
  // A search that starts while setup is open would finish behind the setup
  // panel: the completion banner and results were invisible until the user
  // happened to close it. Starting a run closes setup.
  useEffect(() => {
    if (visibleDiscoveryRunFeedback?.status === "started") {
      setOpenSetupChipId(null);
    }
  }, [visibleDiscoveryRunFeedback?.status]);
  // The wait belongs beside the control that started it, in the same
  // vocabulary Home and Search history use for the finished run.
  const liveSearchProgressLabel = useMemo(() => {
    if (activeRun?.state !== "running") {
      return null;
    }

    const phaseProgress = (
      liveEvents.length > 0 ? liveEvents : (activeRun.activity ?? [])
    ).at(-1)?.progress;
    if (phaseProgress) {
      const phase =
        phaseProgress.phase === "reading_listings"
          ? "Reading listings"
          : "Judging fit";
      return `${phase} ${phaseProgress.completed} of ${phaseProgress.total}`;
    }
    const evidence = getDiscoveryRunCountEvidence(
      activeRun,
      liveEvents.at(-1) ?? null,
    );
    return evidence.distinctJobsRetained > 0 || evidence.duplicatesMerged > 0
      ? formatDiscoveryRunCountLabel(evidence)
      : null;
  }, [activeRun, liveEvents]);
  // Which source the search is on and how many are done. The agent's own
  // notes stay in Activity: printed here they read as internal chatter, and
  // the search bar's running clock already shows the page is not frozen.
  const liveStatusLine = useMemo(() => {
    if (activeRun?.state !== "running") return null;
    const events =
      liveEvents.length > 0 ? liveEvents : (activeRun.activity ?? []);
    const phaseProgress = events.at(-1)?.progress;
    if (phaseProgress) {
      const phase =
        phaseProgress.phase === "reading_listings"
          ? "Reading listings"
          : "Judging fit";
      return `${phase} ${phaseProgress.completed} of ${phaseProgress.total}.`;
    }
    const latest = [...events].reverse().find((event) => event.targetId);
    const target = latest?.targetId
      ? searchPreferences.discovery.targets.find(
          (entry) => entry.id === latest.targetId,
        )
      : null;
    const done = activeRun.summary?.targetsCompleted ?? 0;
    const planned = activeRun.summary?.targetsPlanned ?? 0;
    const line = [
      target && done < planned ? `Checking ${target.label}.` : null,
      planned > 0 ? `${done} of ${planned} sources done.` : null,
      `${campaigns?.find((plan) => plan.id === activeRun.campaignId)?.name ?? "Job search"} · started ${new Date(activeRun.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}${activeRun.campaignId !== activeCampaignId ? " · running in the background" : ""}.`,
    ]
      .filter(Boolean)
      .join(" ");
    return line.length > 0 ? line : null;
  }, [
    activeRun,
    liveEvents,
    searchPreferences.discovery.targets,
    campaigns,
    activeCampaignId,
  ]);
  const workspaceMode: "results" | "setup" = isSetupOpen ? "setup" : "results";
  const setWorkspaceMode = useCallback((mode: "results" | "setup") => {
    setOpenSetupChipId(mode === "setup" ? "roles" : null);
  }, []);
  // One-shot reveal: a workspace that opens empty lands on Search setup, and
  // the first arrival of saved results switches to Results exactly once so a
  // first successful search is never hidden behind the setup tab. The flag is
  // latched, so later empty→nonempty transitions stay wherever the user
  // navigated instead of yanking them back.
  const hasRevealedFirstResultsRef = useRef(jobs.length > 0);
  const firstResultRevealPendingRef = useRef(false);
  useLayoutEffect(() => {
    // Detect the first arrival in the same layout phase as settlement. A
    // passive effect can otherwise set the pending ref after this effect has
    // already run; when the user is already on Results, its no-op state update
    // would not produce another commit to settle the route header.
    if (!hasRevealedFirstResultsRef.current && jobs.length > 0) {
      hasRevealedFirstResultsRef.current = true;
      firstResultRevealPendingRef.current = true;

      if (workspaceMode === "setup") {
        setWorkspaceMode("results");
        return undefined;
      }
    }

    if (!firstResultRevealPendingRef.current || workspaceMode !== "results") {
      return undefined;
    }

    firstResultRevealPendingRef.current = false;
    const settleRouteHeader = () => {
      const headerStack = document.querySelector<HTMLElement>(
        "[data-page-header-stack]",
      );
      const scrollArea = headerStack?.closest<HTMLElement>(
        "[data-locked-screen-scroll-area]",
      );
      const topContent = headerStack?.parentElement;
      const topContentHeight = topContent?.getBoundingClientRect().height ?? 0;
      const headerHeight =
        topContentHeight || headerStack?.getBoundingClientRect().height || 0;

      if (scrollArea && headerHeight > 0) {
        settleJobFinderRouteHeaderScroll(scrollArea, headerHeight);
      }
    };

    // The first-results render changes the locked layout's top height. Run
    // once after commit and once after that geometry settles so a browser
    // reveal can never leave the route title half under the fixed shell.
    settleRouteHeader();
    if (typeof window.requestAnimationFrame !== "function") {
      return undefined;
    }
    const frame = window.requestAnimationFrame(settleRouteHeader);
    return () => window.cancelAnimationFrame(frame);
  }, [jobs.length, setWorkspaceMode, workspaceMode]);
  const stableReadStageSnapshotRef = useRef<StableDiscoveryRunSnapshot | null>(
    null,
  );
  const stableRunId = activeRun?.state === "running" ? activeRun.id : null;
  // Find jobs lists the jobs still waiting on a decision. The open job stays
  // in its place when it is decided here (a bulk shortlist that included it),
  // so the list does not jump back to its first row; it leaves once another
  // job opens. A decided job restored from an earlier visit is not held, and
  // a link to one (global search) still opens it.
  const shortlistedJobIds = useMemo(
    () => new Set(reviewQueue.map((item) => item.jobId)),
    [reviewQueue],
  );
  const selectedJobDecided =
    selectedJob !== null && isDiscoveryDecidedJob(selectedJob, shortlistedJobIds);
  const openedUndecidedJobIdRef = useRef<string | null>(null);
  if (selectedJob && !selectedJobDecided)
    openedUndecidedJobIdRef.current = selectedJob.id;
  const heldDecidedJobId =
    selectedJob &&
    selectedJobDecided &&
    (preserveSelectedJob ||
      openedUndecidedJobIdRef.current === selectedJob.id)
      ? selectedJob.id
      : null;
  const undecidedJobs = useMemo(
    () =>
      jobs.filter(
        (job) =>
          job.id === heldDecidedJobId ||
          !isDiscoveryDecidedJob(job, shortlistedJobIds),
      ),
    [heldDecidedJobId, jobs, shortlistedJobIds],
  );
  // Recomputed only when the jobs or the run change: live search events
  // re-render this screen several times a second, and a new list each time
  // made the results re-filter and re-sort every job.
  const stableReadStage = useMemo(() => {
    const next = updateStableDiscoveryRunSnapshot({
      current: stableReadStageSnapshotRef.current,
      jobs: undecidedJobs,
      runId: stableRunId,
    });
    stableReadStageSnapshotRef.current = next.snapshot;
    return next;
  }, [undecidedJobs, stableRunId]);
  const stableJobs = stableReadStage.jobs;
  const stableSelectedJob = selectedJob
    ? (stableJobs.find((job) => job.id === selectedJob.id) ?? selectedJob)
    : null;
  const listVisibility = getMemoizedResultVisibility(
    stableJobs,
    showAlsoFound,
    preserveSelectedJob ? stableSelectedJob : null,
    stableReadStage.snapshot?.jobIds,
  );
  const resultVisibility = useMemo(
    () => ({
      ...listVisibility,
      selectedJob:
        stableSelectedJob &&
        listVisibility.jobs.some((job) => job.id === stableSelectedJob.id)
          ? stableSelectedJob
          : (listVisibility.jobs[0] ?? null),
    }),
    [listVisibility, stableSelectedJob],
  );
  const hiddenAlsoFoundJobs = getHiddenAlsoFoundJobs(
    resultVisibility.jobs,
    stableJobs,
  );
  const [inAreaJobCount, pendingLocationJobCount] = useMemo(() => {
    let inArea = 0;
    let pending = 0;
    for (const job of stableJobs) {
      if (!job.matchAssessment.judgment) pending += 1;
      else if (job.matchAssessment.locationReach === "in_area") inArea += 1;
    }
    return [inArea, pending];
  }, [stableJobs]);
  const inspectedJob = getDiscoveryInspectedJob(
    resultVisibility.jobs,
    selectedJob?.id ?? null,
    displayedSelection?.campaignId === activeCampaignId
      ? displayedSelection?.jobId
      : undefined,
  );
  const inspectedDetail = useJobDetail(inspectedJob, activeCampaignId);
  // The list's own order (search, filters, sort), for moving to the next job.
  const [orderedJobIds, setOrderedJobIds] = useState<readonly string[]>([]);
  const triage = useDiscoveryTriage({
    enabled: !isSetupOpen && inspectedJob !== null,
    jobs: resultVisibility.jobs,
    orderedJobIds,
    inspectedJob,
    reviewQueue,
    campaignId: activeCampaignId,
    onSelectJob,
    onQueueJob,
    onDismissJob: (jobId) =>
      onDismissJob(jobId, [], "hide_job", null, { quiet: true }),
    onRestoreDismissedJob: (jobId) =>
      onRestoreDismissedJob(jobId, { quiet: true }),
    ...(onRemoveFromShortlist
      ? {
          onRemoveFromShortlist: (jobIds: readonly string[]) =>
            onRemoveFromShortlist(jobIds, { quiet: true }),
        }
      : {}),
  });
  // What "this job" means for the assistant (ADR 0037): the inspected row is
  // focus. The results panel publishes the list and the ticked rows.
  useAssistantContextSource("discovery-focus", () => ({
    focus: inspectedJob
      ? {
          kind: "job",
          id: inspectedJob.id,
          label: `${inspectedJob.title} at ${inspectedJob.company}`,
        }
      : null,
  }));
  // Only the inspected job's own resolved outcome is eligible for display;
  // switching rows drops every other entry so no stale outcome replays later.
  useEffect(() => {
    const inspectedJobId = inspectedJob?.id ?? null;
    setQueueOutcomesByJobId((current) => {
      if (current.size === 0) {
        return current;
      }
      const next = new Map<string, JobFinderQueuedJobOutcome>();
      for (const [jobId, outcome] of current) {
        if (jobId === inspectedJobId) {
          next.set(jobId, outcome);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [inspectedJob?.id]);
  const inspectedJobQueueFeedback = inspectedJob
    ? (queueOutcomesByJobId.get(inspectedJob.id) ?? null)
    : null;
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const requestedDetailJobRef = useRef<string | null>(null);
  const revealSelectedDetail = useCallback(() => {
    const twoPane =
      window.matchMedia?.("(min-width: 1280px)").matches ??
      window.innerWidth >= 1280;
    if (!twoPane) {
      detailPanelRef.current
        ?.querySelector<HTMLElement>("section")
        // jsdom and some embedded views have no scrollIntoView.
        ?.scrollIntoView?.({ block: "start" });
    }
  }, []);
  useLayoutEffect(() => {
    if (requestedDetailJobRef.current === inspectedJob?.id) {
      requestedDetailJobRef.current = null;
      revealSelectedDetail();
    }
  }, [inspectedJob?.id, revealSelectedDetail]);
  const hasInspectableJob = inspectedJob !== null;
  const selectedJobCompanyId =
    inspectedJob && (companies ?? []).length > 0
      ? ((companies ?? []).find(
          (company) =>
            // The cheap id check first: normalizing every company's name on
            // each render cost a shortlist or hide about 20 ms.
            company.jobIds.includes(inspectedJob.id) &&
            isListableCompanyName(company.canonicalName),
        )?.id ?? null)
      : null;
  const hiddenJobCount = resultVisibility.hiddenAlsoFoundCount;

  const showEmptyDiscoveryState = jobs.length === 0;
  // Newest-run truth for the results panel's empty states, so a failed or
  // cancelled latest attempt never renders as "no matches" or "first search".
  const latestRunVerdict = useMemo(
    () => getDiscoveryLatestRunVerdict(selectedPlanRuns),
    [selectedPlanRuns],
  );
  // Run-level warnings the newest run recorded about its own evidence (for
  // example: only listing cards were read). They are printed verbatim beside
  // the run outcome instead of being re-derived from the results on screen.
  const latestRunNotices = useMemo(
    () => getDiscoveryLatestRunNotices(selectedPlanRuns),
    [selectedPlanRuns],
  );
  const enabledTargetIds = new Set(
    searchPreferences.discovery.targets
      .filter((target) => target.enabled)
      .map((target) => target.id),
  );
  const enabledSourceAccessPrompts = sourceAccessPrompts.filter((prompt) =>
    enabledTargetIds.has(prompt.targetId),
  );
  const primarySourceAccessPrompt =
    (selectedSourceTargetId
      ? enabledSourceAccessPrompts.find(
          (prompt) => prompt.targetId === selectedSourceTargetId,
        )
      : null) ??
    enabledSourceAccessPrompts.find(
      (prompt) => prompt.state === "prompt_login_required",
    ) ??
    enabledSourceAccessPrompts[0] ??
    null;
  const runtimeProjection = getDiscoveryRuntimeProjection(browserSession);
  const searchReadiness = getDiscoverySearchReadiness(
    searchPreferences,
    browserSession,
  );
  const hasOfflineCatalogRows =
    runtimeProjection.isOffline && resultVisibility.jobs.length > 0;
  let primaryRecoveryAction: {
    label: string;
    pending: boolean;
    nextStep: string;
    onAction: () => void;
  } | null = null;
  if (
    !runtimeProjection.isOffline &&
    primarySourceAccessPrompt?.state === "prompt_login_required"
  ) {
    if (browserSession.status === "ready" && props.onRunDiscoveryForTarget) {
      primaryRecoveryAction = {
        label: `I'm signed in — retry ${primarySourceAccessPrompt.targetLabel}`,
        pending: isTargetPending(primarySourceAccessPrompt.targetId),
        nextStep:
          "Job Finder will check only this source and show the sign-in handoff again if access is still blocked.",
        onAction: () =>
          props.onRunDiscoveryForTarget?.(primarySourceAccessPrompt.targetId),
      };
    } else {
      primaryRecoveryAction = {
        label: primarySourceAccessPrompt.actionLabel,
        pending: isBrowserSessionPendingForTarget(
          primarySourceAccessPrompt.targetId,
        ),
        nextStep:
          "Job Finder will wait while you sign in, then you can confirm and retry only this source.",
        onAction: () =>
          onOpenBrowserSessionForTarget(primarySourceAccessPrompt.targetId),
      };
    }
  } else if (
    !runtimeProjection.isOffline &&
    (browserSession.status === "blocked" ||
      browserSession.status === "login_required")
  ) {
    // A browser that is merely not open never needs recovery: the search
    // opens it. Only a blocked or sign-in-pending session earns a handoff.
    primaryRecoveryAction = primarySourceAccessPrompt
      ? {
          label: primarySourceAccessPrompt.actionLabel,
          pending: isBrowserSessionPendingForTarget(
            primarySourceAccessPrompt.targetId,
          ),
          nextStep: primarySourceAccessPrompt.rerunLabel
            ? `Then ${primarySourceAccessPrompt.rerunLabel}.`
            : "Then search again.",
          onAction: () =>
            onOpenBrowserSessionForTarget(primarySourceAccessPrompt.targetId),
        }
      : {
          label:
            browserSession.status === "blocked"
              ? `${OPEN_JOB_FINDER_BROWSER_ACTION} to recover`
              : `${OPEN_JOB_FINDER_BROWSER_ACTION} to sign in`,
          pending: isBrowserSessionPending,
          nextStep: "Then search again.",
          onAction: onOpenBrowserSession,
        };
  }
  const hasEnabledSources = searchReadiness.enabledSourceCount > 0;
  const hasLocations = searchPreferences.locations.length > 0;
  // A single-source run also occupies the shared discovery pipeline; every
  // Search now control must refuse a concurrent click instead of relying on
  // the main process to reject it. Paused activity refuses for the same
  // reason: the run would be rejected, so the controls say so up front.
  const liveRunId = isDiscoveryAllPending ? liveEvents.at(-1)?.runId : null;
  // A stop request the search never answered must not hold the screen. Once
  // the release window passes the run is reported as stopped and every
  // control it was disabling — the plan dropdown included — comes back.
  const stopState = useDiscoveryStopState(activeRun);
  const isStopUnacknowledged = stopState === "unacknowledged";
  const activeRunId = isStopUnacknowledged
    ? null
    : activeRun?.state === "running"
      ? activeRun.id
      : (liveRunId ?? null);
  const isActiveRunRunning = activeRunId !== null;
  // Leaving the running state always re-arms stop for the next run, whether
  // the run completed, failed, or honoured the cancellation request.
  useEffect(() => {
    if (!isActiveRunRunning) {
      setIsStopSearchRequested(false);
    }
  }, [isActiveRunRunning]);
  const handleStopSearch = useCallback(() => {
    if (!onCancelDiscovery || !isActiveRunRunning || isStopSearchRequested) {
      return;
    }
    // Stop means stop. The confirm dialog that used to stand here cost a
    // click and, in a scripted browser, silently swallowed every stop.
    setIsStopSearchRequested(true);
    void onCancelDiscovery(activeRunId).then((accepted) => {
      if (!accepted) {
        setIsStopSearchRequested(false);
      }
    });
  }, [
    activeRunId,
    isActiveRunRunning,
    isStopSearchRequested,
    onCancelDiscovery,
  ]);
  const isAnyDiscoveryRunActive =
    !isStopUnacknowledged &&
    (activeRun?.state === "running" || isDiscoveryAllPending);
  const isSearchUnavailable = activityPaused || isAnyDiscoveryRunActive;
  const savedSourceCount = searchPreferences.discovery.targets.length;
  const searchSetupBlocker =
    showEmptyDiscoveryState && !hasEnabledSources
      ? {
          title:
            savedSourceCount > 0
              ? "Enable a source before searching"
              : "Choose at least one source before searching",
          description:
            savedSourceCount > 0
              ? "Sources are saved but none are turned on, so Search stays disabled. Enable a saved source in Profile, then search."
              : "Enable at least one source in Profile so Find jobs has somewhere to search. Your profile will guide the search even when you leave target roles blank.",
          actionLabel:
            savedSourceCount > 0 ? "Enable sources" : "Add a job source",
          actionHref: JOB_FINDER_ROUTE_PATHS.profileSources,
          nextStep: hasLocations
            ? "Then search again."
            : "Then add locations if you want tighter matches and search again.",
        }
      : null;

  // A failed search that needs a retry keeps its box (ADR 0042), in the
  // Results column in results mode because it concerns the results, and at
  // the top while the search setup is open.
  const runFeedbackCallout =
    visibleDiscoveryRunFeedback &&
    !visibleDiscoveryRunFeedback.toast &&
    visibleDiscoveryRunFeedback.status !== "started" &&
    (!isSetupOpen || visibleDiscoveryRunFeedback.status !== "succeeded") ? (
      <DiscoveryRunFeedbackCallout
        feedback={visibleDiscoveryRunFeedback}
        isRecoveryPending={isBrowserSessionPending}
        notices={latestRunNotices}
        onDismiss={() => {
          if (!currentFeedbackKey) return;
          const next = [
            ...dismissedFeedbackKeys.filter(
              (key) => key !== currentFeedbackKey,
            ),
            currentFeedbackKey,
          ].slice(-100);
          setDismissedFeedbackKeys(next);
          try {
            window.localStorage.setItem(
              "nestor.discovery.dismissed-feedback",
              JSON.stringify(next),
            );
          } catch {
            /* Dismissal still works for this visit. */
          }
        }}
        onOpenBrowserSession={onOpenBrowserSession}
        suppressBrowserRecovery={runtimeProjection.isOffline}
      />
    ) : null;

  // Page-level conditions are items on the header's status line (ADR 0044):
  // the pause, with the one Resume, and a readiness blocker with its fix.
  // The search bar's Search now names the item that disables it.
  const discoveryStatusItems: PageStatusItem[] = [];
  if (activityPaused) {
    discoveryStatusItems.push({
      id: "activity-paused",
      tone: "warning",
      text: "Paused. New searches and applications wait until you resume.",
      textId: "discovery-header-search-paused-reason",
      ...(onResumeActivity
        ? {
            action: {
              kind: "button",
              label: "Resume activity",
              onClick: onResumeActivity,
              pending: isActivityPausePending,
            },
          }
        : {}),
    });
  } else if (
    workspaceMode === "results" &&
    !searchReadiness.ready &&
    searchReadiness.reason &&
    !searchSetupBlocker &&
    !hasOfflineCatalogRows
  ) {
    // The action is derived from the exact blocker so a browser problem
    // never reads as "Enable sources" while a source is already on.
    const readinessAction: PageStatusAction | null =
      searchReadiness.blocker === "no_search_roles"
          ? {
              kind: "link",
              label: "Add target roles",
              to: JOB_FINDER_ROUTE_PATHS.profileTargetRoles,
            }
          : searchReadiness.blocker === "no_enabled_sources"
            ? {
                kind: "link",
                label: savedSourceCount > 0 ? "Enable sources" : "Add sources",
                to: JOB_FINDER_ROUTE_PATHS.profileSources,
              }
            : null;
    discoveryStatusItems.push({
      id: "search-readiness",
      tone: "warning",
      text: searchReadiness.reason,
      textId: "discovery-header-search-disabled-reason",
      ...(readinessAction ? { action: readinessAction } : {}),
    });
  }

  const filtersPanel = (
    <DiscoveryFiltersPanel
      activeRun={activeRun}
      activityPaused={activityPaused}
      browserSession={browserSession}
      discoverySessions={discoverySessions}
      isAnyDiscoveryRunActive={isAnyDiscoveryRunActive}
      isBrowserSessionPending={isBrowserSessionPending}
      isBrowserSessionPendingForTarget={isBrowserSessionPendingForTarget}
      isDiscoveryAllPending={isDiscoveryAllPending}
      isTargetPending={isTargetPending}
      planEditorHref={JOB_FINDER_ROUTE_PATHS.profileWorkModes}
      onOpenBrowserSession={onOpenBrowserSession}
      onOpenBrowserSessionForTarget={onOpenBrowserSessionForTarget}
      // The search bar above owns the single Search command, so the setup
      // panel keeps only its own secondary browser and history actions.
      onRunAgentDiscovery={undefined}
      {...(props.onRunDiscoveryForTarget
        ? { onRunDiscoveryForTarget: props.onRunDiscoveryForTarget }
        : {})}
      onViewProgress={() => setShowHistory(true)}
      searchPreferences={searchPreferences}
      searchSelectivity={searchSelectivity}
      sourceAccessPrompts={sourceAccessPrompts}
      // On the heading row: a separate "Editing what this search looks for"
      // line above the panel's own "What this search looks for" said it twice.
      headerAction={
        <Button
          onClick={() => setOpenSetupChipId(null)}
          size="sm"
          title="Results stay saved."
          type="button"
          variant="secondary"
        >
          {jobs.length > 0 ? "Back to results" : "Close search setup"}
        </Button>
      }
    />
  );

  const recoveryActionProps = primaryRecoveryAction
    ? {
        onRecoveryAction: primaryRecoveryAction.onAction,
        recoveryActionLabel: primaryRecoveryAction.label,
        recoveryActionNextStep: primaryRecoveryAction.nextStep,
        recoveryActionPending: primaryRecoveryAction.pending,
      }
    : {};

  const resultsWorkspace = (
    <div
      className={cn(
        "grid min-h-0 min-w-0 grid-cols-1 items-stretch gap-4 xl:h-full xl:min-h-0 xl:overflow-hidden",
        hasInspectableJob ? LIST_DETAIL_COLUMNS_CLASS : "xl:grid-cols-1",
      )}
      id="discovery-workspace-content"
    >
      <div className="flex min-h-0 min-w-0 flex-col gap-2">
        {runFeedbackCallout}
        <DiscoveryResultsPanel
          hiddenJobsControl={
            dismissedJobs.length > 0 ? (
              <details className="text-sm open:w-full">
                {/* Short and the size of the run line beside it, so the fit
                    actions stay on the same row at 1440 wide. */}
                <summary
                  className="cursor-pointer text-xs font-medium text-foreground-soft"
                  title="Jobs you marked Not interested"
                >
                  Hidden ({dismissedJobs.length})
                </summary>
                <p className="mt-2 text-(length:--text-small) leading-5 text-foreground-muted">
                  Hidden jobs stay on this device and do not change fit scores.
                </p>
                <ul className="mt-3 grid gap-2">
                  {dismissedJobs.map((job) => (
                    <li
                      className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-(--surface-panel-border) pt-2"
                      key={job.id}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-(length:--text-small) font-medium text-foreground">
                          {job.title}
                        </p>
                        <p className="text-(length:--text-tiny) text-foreground-muted">
                          {job.discoveryFeedback?.reasons
                            .map(formatDiscoveryHideReason)
                            .join(" · ") ?? "Hidden without saved reasons"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {job.discoveryFeedback?.employerExclusion &&
                        onRemoveEmployerExclusion ? (
                          <Button
                            disabled={isJobPending(job.id)}
                            onClick={() =>
                              onRemoveEmployerExclusion({
                                jobId: job.id,
                                normalizedCompanyName:
                                  job.discoveryFeedback!.employerExclusion!
                                    .normalizedCompanyName,
                              })
                            }
                            size="sm"
                            type="button"
                            variant="ghost"
                          >
                            Allow this employer in future searches
                          </Button>
                        ) : null}
                        <Button
                          disabled={isJobPending(job.id)}
                          onClick={() => onRestoreDismissedJob(job.id)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Show again
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null
          }
          {...(onJudgeUnjudgedJobs ? { onJudgeUnjudgedJobs } : {})}
          fitJudgmentProgress={
            props.fitJudgmentProgress?.planId === activeCampaignId
              ? props.fitJudgmentProgress
              : null
          }
          // With one plan its name says nothing; it only took toolbar room.
          planName={
            (campaigns?.length ?? 0) > 1
              ? (campaigns?.find((plan) => plan.id === activeCampaignId)
                  ?.name ?? null)
              : null
          }
          alsoFoundCount={resultVisibility.alsoFoundCount}
          areAlsoFoundShown={showAlsoFound}
          browserSession={browserSession}
          discoveryTargets={searchPreferences.discovery.targets}
          emptyClassName="min-h-80"
          // Active search plan identity: the running run's campaign, else the
          // most recent run's, else the shared default scope. Facet filters
          // persist per plan so switching plans never leaks selections.
          facetScopeId={activeCampaignId}
          hasCompletedSearch={selectedPlanLatestRun?.state === "completed"}
          isSearchInProgress={
            activeRun?.state === "running" &&
            activeRun.campaignId === activeCampaignId
          }
          liveStatusLine={liveStatusLine}
          hiddenAlsoFoundCount={hiddenJobCount}
          hiddenAlsoFoundJobs={hiddenAlsoFoundJobs}
          inAreaJobCount={inAreaJobCount}
          jobs={resultVisibility.jobs}
          latestRun={
            activeRun?.state === "running" &&
            activeRun.campaignId === activeCampaignId
              ? activeRun
              : selectedPlanLatestRun
          }
          latestRunVerdict={latestRunVerdict}
          failureCalloutShown={
            visibleDiscoveryRunFeedback?.status === "failed" &&
            visibleDiscoveryRunFeedback.recovery !== null
          }
          preferredLocations={searchPreferences.locations}
          remoteIncluded={searchPreferences.workModes.includes("remote")}
          totalLocationJobCount={stableJobs.length}
          pendingLocationJobCount={pendingLocationJobCount}
          editPlanHref={
            activeCampaignId
              ? campaignPlanEditorHref(activeCampaignId)
              : JOB_FINDER_ROUTE_PATHS.campaigns
          }
          onSearchAgain={onRunAgentDiscovery ?? null}
          {...(props.onRunDiscoveryForTarget
            ? { onRetrySource: props.onRunDiscoveryForTarget }
            : {})}
          onDisplayedSelectedJobIdChange={(jobId) =>
            setDisplayedSelection({ jobId, campaignId: activeCampaignId })
          }
          onOrderedJobIdsChange={setOrderedJobIds}
          onShowAlsoFound={() => setShowAlsoFound(true)}
          onToggleAlsoFound={() => setShowAlsoFound((current) => !current)}
          onSelectJob={(jobId) => {
            requestedDetailJobRef.current = jobId;
            onSelectJob(jobId);
            if (jobId === inspectedJob?.id) revealSelectedDetail();
          }}
          onShortlistJobs={async (jobIds) => {
            if (onQueueJobs) {
              const outcome = await onQueueJobs(jobIds);
              // A bulk success is the toast's, with its Undo all; the
              // footer keeps only a failure, so it is never said twice.
              if (outcome.status === "success") return;
              setQueueOutcomesByJobId((current) => {
                const next = new Map(current);
                for (const id of jobIds) next.set(id, outcome);
                return next;
              });
            } else {
              // Older hosts remain bounded rather than launching one full
              // workspace mutation for every visible row at the same time.
              for (const jobId of jobIds) await handleQueueJob(jobId);
            }
          }}
          {...(onDismissJobs ? { onDismissJobs } : {})}
          searchSetupBlocker={searchSetupBlocker}
          selectedJob={resultVisibility.selectedJob}
          {...recoveryActionProps}
        />
      </div>
      {hasInspectableJob ? (
        <div className="min-h-0 min-w-0" ref={detailPanelRef}>
          {inspectedDetail.job ? (
            <DiscoveryDetailPanel
              applicationRecords={applicationRecords}
              reviewQueue={reviewQueue}
              discoveryTargets={searchPreferences.discovery.targets}
              isJobPending={isJobPending}
              onDismissJob={onDismissJob}
              {...(onPreviewEmployerExclusion
                ? { onPreviewEmployerExclusion }
                : {})}
              {...(onOpenCompany ? { onOpenCompany } : {})}
              onOpenApplication={onOpenApplication ?? (() => undefined)}
              {...(onOpenListing ? { onOpenListing } : {})}
              {...(assessJobWithFeedback
                ? { onAssessJobListing: assessJobWithFeedback }
                : {})}
              onBackToResults={() => {
                const row = Array.from(
                  document.querySelectorAll<HTMLElement>(
                    "[data-collection-item-id]",
                  ),
                ).find(
                  (element) =>
                    element.dataset.collectionItemId === inspectedJob?.id,
                );
                row?.scrollIntoView?.({ block: "center" });
                (row instanceof HTMLButtonElement
                  ? row
                  : row?.querySelector<HTMLElement>("button")
                )?.focus({ preventScroll: true });
              }}
              onQueueJob={(jobId) => {
                void handleQueueJob(jobId);
              }}
              queueFeedback={inspectedJobQueueFeedback}
              selectedJob={inspectedDetail.job}
              triage={triage}
              selectedJobCompanyId={selectedJobCompanyId}
            />
          ) : (
            <section className="surface-panel-shell p-6" aria-live="polite">
              <h2>{inspectedJob?.title}</h2>
              {/* "Loading" shows only if the read takes longer than a blink. */}
              <p className={inspectedDetail.error ? undefined : "delayed-appear"}>
                {inspectedDetail.error ?? "Loading job details…"}
              </p>
              {inspectedDetail.error ? (
                <Button onClick={inspectedDetail.retry}>Retry</Button>
              ) : null}
            </section>
          )}
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <LockedScreenLayout
        contentClassName="xl:overflow-hidden"
        lockContentHeight
        topContent={
          <>
            <PageHeaderStack
              actions={
                onBackToRapidReview ? (
                  <Button
                    onClick={onBackToRapidReview}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Back to rapid review
                  </Button>
                ) : null
              }
              description="Search your job sources, then shortlist the jobs you want to apply to."
              statusItems={discoveryStatusItems}
              subnav={
                // The search settings used to be a peer tab whose whole content
                // was four read-only summary rows. They are now an interactive
                // bar: each chip opens the same editor in place, and the one
                // search command lives at its right end.
                <DiscoverySearchBar
                  {...(campaigns ? { campaigns } : {})}
                  activeCampaignId={activeCampaignId}
                  isPlanSwitchPending={isPlanSwitchPending}
                  {...(onSelectCampaign ? { onSelectCampaign } : {})}
                  browserSession={browserSession}
                  isBrowserSessionPending={isBrowserSessionPending}
                  isSearchDisabled={
                    !searchReadiness.ready ||
                    isSearchUnavailable ||
                    !onRunAgentDiscovery
                  }
                  isSearchPending={isDiscoveryAllPending}
                  isSearchRunning={isActiveRunRunning}
                  resultScope={showAlsoFound ? "wide" : "focused"}
                  hiddenResultCount={showAlsoFound ? 0 : hiddenJobCount}
                  isSetupOpen={isSetupOpen}
                  openSetupChipId={openSetupChipId}
                  isStopPending={
                    !isStopUnacknowledged &&
                    (isStopSearchRequested ||
                      (activeRun?.id === activeRunId &&
                        Boolean(activeRun.cancellationRequestedAt)))
                  }
                  stoppedNotice={
                    isStopUnacknowledged
                      ? DISCOVERY_STOP_UNACKNOWLEDGED_LABEL
                      : null
                  }
                  onOpenBrowserSession={onOpenBrowserSession}
                  onRunAgentDiscovery={onRunAgentDiscovery}
                  onToggleResultScope={() =>
                    setShowAlsoFound((current) => !current)
                  }
                  onToggleSetup={setOpenSetupChipId}
                  searchActionDescribedBy={
                    activityPaused
                      ? "discovery-header-search-paused-reason"
                      : hasOfflineCatalogRows
                        ? DISCOVERY_OFFLINE_CATALOG_NOTICE_ID
                        : searchReadiness.ready || !searchSetupBlocker
                          ? undefined
                          : DISCOVERY_SEARCH_SETUP_BLOCKER_ID
                  }
                  profileSourceEnabled={Object.fromEntries(
                    workspaceSearchPreferences.discovery.targets.map(
                      (source) => [source.id, source.enabled],
                    ),
                  )}
                  searchPreferences={searchPreferences}
                  backgroundPlanName={
                    activeRun?.state === "running" &&
                    Boolean(activeRun.campaignId) &&
                    Boolean(activeCampaignId) &&
                    activeRun.campaignId !== activeCampaignId
                      ? (campaigns?.find(
                          (plan) => plan.id === activeRun.campaignId,
                        )?.name ?? "background")
                      : null
                  }
                  searchProgressLabel={liveSearchProgressLabel}
                  searchStartedAt={activeRun?.startedAt ?? null}
                  {...(onCancelDiscovery
                    ? { onStopSearch: handleStopSearch }
                    : {})}
                />
              }
              title="Find jobs"
            />
            {/* A results banner belongs where the results are. While the
                search-setup editor is open there are no results on screen, so
                only feedback that still needs the user — a failure, a
                cancellation, a run in flight — stays visible. */}
            {/* Toast outcomes (finished, stopped) and a run in flight get no
                banner: the search bar already says "Searching" with the
                elapsed time and counts. */}
            {isSetupOpen ? runFeedbackCallout : null}
            {/* One route-owned action surface shared by Results and Search
                setup, so a failed Resume activity or any other authoritative
                refusal stays visible in every mode. It renders below the
                paused banner and run feedback so a stale message can never
                mask the pause truth or the newest run verdict. */}
            {actionState.message &&
            !visibleDiscoveryRunFeedback &&
            actionState.message !== dismissedActionMessage ? (
              <p
                aria-atomic="true"
                aria-live="polite"
                className="relative min-w-0 break-words rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel-tint) py-2 pl-3 pr-10 text-(length:--text-description) leading-5 text-foreground"
                data-testid="discovery-route-action-status"
                role="status"
              >
                {actionState.message}
                {actionState.actionLink ? (
                  <>
                    {" "}
                    <Link
                      className="font-medium text-primary underline-offset-2 hover:underline"
                      to={actionState.actionLink.route}
                    >
                      {actionState.actionLink.label}
                    </Link>
                  </>
                ) : null}
                <Button
                  aria-label="Dismiss this notice"
                  className="absolute right-1.5 top-1 h-7 w-7 rounded-full p-0 opacity-70 hover:opacity-100"
                  onClick={() => setDismissedActionMessage(actionState.message)}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <X className="size-4" />
                </Button>
              </p>
            ) : null}
          </>
        }
      >
        {isSetupOpen ? (
          <div
            className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] xl:h-full"
            id={DISCOVERY_SEARCH_SETUP_PANEL_ID}
          >
            <div className="min-h-0 min-w-0" id="discovery-workspace-content">
              {filtersPanel}
            </div>
          </div>
        ) : (
          resultsWorkspace
        )}
      </LockedScreenLayout>

      <DiscoveryHistoryModal
        activeRun={activeRun}
        isDiscoveryPending={isDiscoveryAllPending}
        isTargetPending={isTargetPending}
        liveEvents={liveEvents}
        onClose={() => setShowHistory(false)}
        {...(props.onRunDiscoveryForTarget
          ? { onRetrySource: props.onRunDiscoveryForTarget }
          : {})}
        open={showHistory}
        recentRuns={recentRuns}
        targets={searchPreferences.discovery.targets}
      />
    </>
  );
}
