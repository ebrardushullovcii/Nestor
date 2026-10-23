import type {
  ApplicationAutomationMode,
  ApplicationPageState,
  DiscoveryRunRecord,
  JobFinderSearchRequest,
  JobFinderRendererWorkspaceSnapshot,
  ReviewQueueItem,
  ProfileSetupStep,
} from "@nestor/contracts";
import {
  evaluateProfileSetupReadiness,
  resolveCampaignSourceTargetIds,
  getProfileSetupReadinessBlockers,
  PREPARED_PAGE_CLOSED_SUMMARY,
} from "@nestor/contracts";
import { deriveSourceHealthSignals } from "@nestor/job-finder/source-health";
import {
  AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID,
  projectPlanSafeguardPauses,
} from "@nestor/job-finder/plan-safeguard-pauses";
import type {
  JobFinderTaskCenterItem,
  JobFinderTaskCenterModel,
} from "../../components/task-center/job-finder-task-center-model";
import {
  countApplicationRecords,
  countDiscoveryVisibleJobs,
  countDiscoveryWeakerJobs,
  countNeedsYou,
  countSafeguardBlockers,
  countShortlistedJobs,
  selectCampaignJobIds,
} from "../../lib/destination-counts";
import { listApplyRunsStoppedBySafeguard } from "../../lib/apply-run-pause-state";
import {
  getDiscoveryRunCountEvidence,
  getDiscoveryRunReportCounts,
} from "../../lib/discovery-run-count-label";
import { JOB_FINDER_ROUTE_PATHS } from "../../lib/job-finder-route-hrefs";
import { pageNeedsPreparing } from "../../hooks/use-application-page-states";
import {
  describeSourcesNeedingAttention,
  listSourcesNeedingAttention,
  SOURCES_NEEDING_ATTENTION_FILTER,
} from "../../lib/source-attention";
import { getProfileSetupReadinessBlockerLabel } from "../../components/profile/setup/profile-setup-screen-helpers";
import {
  WAITING_FOR_BROWSER_TAB_SUMMARY,
  describeNotSentResult,
  resolveApplyStatePresentation,
} from "../applications/apply-state";
import { buildApplyRunContextReader } from "../applications/applications-recovery-state";
import {
  getDiscoveryRunFailureRecovery,
  isAppSideDiscoveryFailure,
} from "../discovery/discovery-run-feedback";
import {
  APPLICATION_PREPARATION_BATCH_LIMIT,
  collectInProgressApplicationJobIds,
  collectPreparedApplicationJobIds,
  countResumeLinesToDecide,
  countTailoredDraftPreparationEligible,
  isQueueStageReady,
  isTailoredDraftPreparationEligible,
  type TailoredDraftPreparationViewState,
  needsPersonResumeReview,
} from "../review-queue/review-queue-status";
import { buildResumeWorkspaceRoute } from "../../lib/resume-workspace-route";
import {
  describeApplyQueue,
  isApplyQueueOngoing,
  listApplyQueueWaitingJobIds,
  type ApplyQueueControlAction,
  type ApplyQueueViewButton,
} from "../../lib/apply-queue-view";
import {
  formatDiscoveryRunSourceProblemSummary,
  selectNewestSettledDiscoveryRun,
  summarizeDiscoveryRunSourceProblems,
} from "./home-source-health-summary";

/**
 * Home answers three questions and nothing else: where am I, what is going on,
 * and what do I do next. This module decides the answers from the workspace;
 * the screen only renders them. Every number here comes from the same owner
 * the sidebar badges and the destination pages read, so Home can never print
 * a count another page does not recognise.
 */

export type HomeAction =
  | { kind: "navigate"; route: string }
  | { kind: "run_search"; request?: JobFinderSearchRequest }
  | { kind: "create_resumes" }
  | { kind: "resume_setup"; step: ProfileSetupStep }
  | { kind: "apply_all"; jobIds: readonly string[] }
  /** Job Finder presses Send on each filled-in form (Send for me). */
  | { kind: "send_prepared"; jobIds: readonly string[] }
  | { kind: "stop_search"; runId: string }
  | { kind: "stop_apply"; runId: string }
  | { kind: "apply_queue"; action: ApplyQueueControlAction }
  | { kind: "stop_resumes" }
  | { kind: "pause_activity" }
  | { kind: "resume_activity" };

export interface HomeButton {
  label: string;
  action: HomeAction;
}

interface HomeNextStep {
  /** Why this is the next step, as a stable id the tests can assert on. */
  id:
    | "safeguards"
    | "paused"
    | "setup"
    | "sources"
    | "needs_you"
    | "send"
    | "daily_limit"
    | "retry"
    | "check_closed"
    | "review_resumes"
    | "apply"
    | "create_resumes"
    | "wait_search"
    | "wait_resumes"
    | "wait_apply"
    | "first_search"
    | "look_through"
    | "nothing_found"
    | "search_failed"
    | "source_failed"
    | "tracker_due"
    | "caught_up";
  title: string;
  detail: string;
  /**
   * A quiet link after the detail, for the one deliberate change the detail
   * mentions. Applying names the saved mode and links straight to it, so
   * changing the mode is one press away instead of a hunt through Settings.
   */
  detailLink?: HomeButton;
  primary: HomeButton;
  secondary: readonly HomeButton[];
  /**
   * Other things worth knowing that are not the next step, as quiet lines
   * under the buttons: "4 applications have a closed form · Open
   * Applications". One line each, at most one link.
   */
  also?: readonly HomeAlsoLine[];
}

export interface HomeAlsoLine {
  id: string;
  text: string;
  link?: HomeButton;
}

interface HomeNowItem {
  id: string;
  title: string;
  detail: string;
  stop: HomeButton | null;
  open: HomeButton | null;
  /** False for work that waits (paused, or until tomorrow): no pulse. */
  active?: boolean;
}

interface HomeProblem {
  id: string;
  /** No tone is a quiet line: a fact the app cannot fix, with no dot. */
  tone: "critical" | "warning" | null;
  text: string;
  button: HomeButton | null;
  /**
   * When set, hiding the line keeps it hidden until this key changes (for
   * example a different set of failing sources), not just for the visit.
   */
  dismissKey?: string;
}

interface HomeStage {
  id: "discovery" | "review-queue" | "applications";
  label: string;
  count: number;
  /** The one-line breakdown the sidebar badge cannot carry. */
  detail: string | null;
  route: string;
}

interface JobSearchHomeModel {
  /** One sentence under the title: what is going on right now. */
  statusLine: string;
  paused: boolean;
  now: readonly HomeNowItem[];
  problems: readonly HomeProblem[];
  next: HomeNextStep;
  /** Null until the workspace has anything to stand in a pipeline. */
  stages: readonly HomeStage[] | null;
  showPlanSelector: boolean;
}

export interface BuildJobSearchHomeModelInput {
  workspace: JobFinderRendererWorkspaceSnapshot;
  tasks: JobFinderTaskCenterModel;
  tailoredDraftPreparation?:
    | TailoredDraftPreparationViewState
    | null
    | undefined;
  /** A search request is in flight but the run has not been recorded yet. */
  discoveryRunPending: boolean;
  /** Whether Home may start a search itself. */
  canRunDiscovery: boolean;
  applicationAutomationMode: ApplicationAutomationMode;
  /**
   * Whether each ready form is open, can be reopened, or has to be prepared
   * again. A form that reopens is just ready; only the rest count as closed.
   */
  applicationPageStates?: ReadonlyMap<string, ApplicationPageState>;
  now?: number;
}

const discoveryRoute = JOB_FINDER_ROUTE_PATHS.discovery;
const reviewQueueRoute = JOB_FINDER_ROUTE_PATHS.reviewQueue;
const applicationsRoute = JOB_FINDER_ROUTE_PATHS.applications;
const trackerRoute = `${JOB_FINDER_ROUTE_PATHS.applications}?view=tracker`;
const applyingSettingsRoute = `${JOB_FINDER_ROUTE_PATHS.settings}#settings-application-authority`;
const needsYouRoute = "/job-finder/actions";
const profileSetupRoute = "/job-finder/profile/setup";
const profileSourcesRoute = `${JOB_FINDER_ROUTE_PATHS.profileSources}#profile-job-sources`;
const profileSourcesNeedingAttentionRoute = `${JOB_FINDER_ROUTE_PATHS.profileSources}&show=${SOURCES_NEEDING_ATTENTION_FILTER}#profile-job-sources`;

function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

function joinParts(parts: readonly (string | null)[]): string | null {
  const kept = parts.filter((part): part is string => Boolean(part));
  return kept.length > 0 ? kept.join(" · ") : null;
}

function newestDiscoveryRun(
  workspace: JobFinderRendererWorkspaceSnapshot,
): DiscoveryRunRecord | null {
  let newest: DiscoveryRunRecord | null = null;
  for (const run of workspace.recentDiscoveryRuns ?? []) {
    if (!newest || run.startedAt > newest.startedAt) {
      newest = run;
    }
  }
  return workspace.activeDiscoveryRun ?? newest;
}

/**
 * The request that continues an interrupted search on the sources that are
 * still enabled. `undefined` means the newest search was not interrupted;
 * `null` means it was, but none of its sources is still enabled.
 */
export function buildInterruptedSearchRetryRequest(
  workspace: JobFinderRendererWorkspaceSnapshot,
): JobFinderSearchRequest | null | undefined {
  const run = newestDiscoveryRun(workspace);
  // A graceful app close cancels the live run before shutdown, so older and
  // current workspaces can represent the same interrupted search either with
  // the explicit phase or as a cancelled terminal run.
  if (run?.runPhase !== "interrupted" && run?.state !== "cancelled") {
    return undefined;
  }

  const enabledTargetIds = new Set(
    workspace.searchPreferences.discovery.targets
      .filter((target) => target.enabled)
      .map((target) => target.id),
  );
  const sourceIds = run.targetIds.filter((id) => enabledTargetIds.has(id));
  if (sourceIds.length === 0) return null;

  return {
    intent: run.searchIntent ?? "",
    ...(run.searchBreadth ? { breadth: run.searchBreadth } : {}),
    freshness: run.searchFreshness ?? "any",
    sourceIds,
  };
}

/** "10 found · 10 new", or null when the run recorded nothing. */
/**
 * The one number Home's status line needs from the last search. Its full
 * report (postings seen, duplicates merged, rejected...) belongs with the
 * search on Find jobs; on one line here it read as a wall of jargon.
 */
function formatRunCounts(run: DiscoveryRunRecord | null): string | null {
  const fresh = runNewCount(run);
  // "0 new" is not a count worth a clause; the next step says the search
  // found nothing in words.
  return fresh > 0 ? plural(fresh, "new job") : null;
}

function runNewCount(run: DiscoveryRunRecord | null): number {
  if (!run) return 0;
  const report = getDiscoveryRunReportCounts(run);
  if (report.new !== null) return report.new;
  return getDiscoveryRunCountEvidence(run, null).distinctJobsRetained;
}

function formatRelativeDay(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const elapsedMs = Math.max(0, now - then);
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${plural(days, "day")} ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(then),
  );
}

/**
 * The summary the apply service writes on an application the person stepped
 * into while it was being filled (`PERSON_TOOK_OVER_SUMMARY` in
 * `@nestor/job-finder`, which the renderer cannot import). The tab stays
 * theirs until they press Resume agent in the browser, which carries it on.
 */
export const PERSON_TOOK_OVER_APPLICATION_SUMMARY =
  "You took over this application.";

/**
 * Why the retry card is there. "Stopped before the form was finished" was
 * wrong after a restart, when the forms had been filled in and were waiting
 * for Send: closing Job Finder closes their pages, and nothing was sent.
 */
function describeRetryReason(
  retryJobIds: readonly string[],
  closedFilledFormJobIds: readonly string[],
  takenOverJobIds: readonly string[] = [],
  notStartedJobIds: readonly string[] = [],
  notSentRetryReasons: ReadonlyMap<string, string> = new Map(),
): string {
  const takenOver = retryJobIds.filter((jobId) =>
    takenOverJobIds.includes(jobId),
  ).length;
  if (takenOver > 0) {
    // The person is (or was) working in that tab. Handing it back is the
    // step that carries it on; Try again is for a tab they closed.
    const lead =
      takenOver === 1
        ? "You took over this application in the Job Finder browser. Press Resume agent there when you are done and Job Finder carries it on."
        : `You took over ${takenOver} applications in the Job Finder browser. Press Resume agent there when you are done and Job Finder carries them on.`;
    return takenOver === retryJobIds.length
      ? `${lead} If you closed the tab, try again to start from the listing.`
      : `${lead} Trying again starts the others from the listing.`;
  }
  const closed = retryJobIds.filter((jobId) =>
    closedFilledFormJobIds.includes(jobId),
  ).length;
  // A form filled in whose send failed (the site went down mid-send) was
  // finished too; "stopped before the form was finished" was wrong for it.
  const notSentReasons = retryJobIds.flatMap((jobId) =>
    closedFilledFormJobIds.includes(jobId)
      ? []
      : [notSentRetryReasons.get(jobId)].filter((reason): reason is string =>
          Boolean(reason),
        ),
  );
  const notSent = notSentReasons.length;
  if (closed === 0 && notSent === 0) {
    const notStarted = retryJobIds.filter((jobId) =>
      notStartedJobIds.includes(jobId),
    ).length;
    if (notStarted === retryJobIds.length) {
      return notStarted === 1
        ? "The batch stopped before Job Finder got to this one, so nothing was filled in or sent. Trying again starts it from the listing."
        : "The batch stopped before Job Finder got to these, so nothing was filled in or sent. Trying again starts each one from the listing.";
    }
    return "The last attempt stopped before the form was finished. A fresh attempt starts from the listing again.";
  }
  const notSentReason = (notSentReasons[0] ?? "")
    .replace(/^Not sent:\s*/u, "")
    .replace(/\.$/u, "");
  const filledIn = [
    closed === 0
      ? null
      : closed === 1
        ? "This form was filled in, but its page closed before it was sent (closing Job Finder closes it), so nothing was sent."
        : `${closed} forms were filled in, but their pages closed before they were sent (closing Job Finder closes them), so nothing was sent.`,
    notSent === 0
      ? null
      : `${notSent === 1 ? (closed === 0 ? "This form was" : "One more form was") : `${notSent} forms were`} filled in but not sent: ${notSentReason}.`,
  ]
    .filter(Boolean)
    .join(" ");
  const finished = closed + notSent;
  if (finished === retryJobIds.length) {
    return `${filledIn} Trying again fills ${finished === 1 ? "it" : "them"} in again from the listing.`;
  }
  const unfinished = retryJobIds.length - finished;
  return `${filledIn} ${unfinished === 1 ? "One other attempt" : `${unfinished} other attempts`} stopped before the form was finished. Trying again starts each one from the listing.`;
}

/** Retryable jobs the batch leaves out until their resume is approved again. */
function describeHeldForResumeReview(count: number): string | null {
  if (count === 0) return null;
  return count === 1
    ? "One other waits until you approve its changed Aggressive resume; open it in Applications."
    : `${count} others wait until you approve their changed Aggressive resumes; open them in Applications.`;
}

/**
 * The word on a press that runs applications again. In Send for me those runs
 * send, so it says Apply; "Try again" there read as harmless.
 */
function retryWord(mode: ApplicationAutomationMode): string {
  return mode === "autonomous_submit" ? "Apply again" : "Try again";
}

/** The in-place press named with its count, for use beside another card. */
function describeSecondaryPress(
  step: HomeNextStep,
  total: number,
  mode: ApplicationAutomationMode,
): string {
  const action = step.primary.action;
  if (action.kind !== "apply_all") return step.primary.label;
  const n = action.jobIds.length;
  if (step.id === "retry") {
    const again = retryWord(mode);
    return n < total
      ? `${again} for ${n} of ${total}`
      : n === 1
        ? `${again} for 1 application`
        : `${again} for all ${n}`;
  }
  return n < total
    ? `Apply to ${n} of ${total}`
    : n === 1
      ? "Apply to 1 ready job"
      : `Apply to all ${n}`;
}

function describeApplyMode(mode: ApplicationAutomationMode): string {
  switch (mode) {
    case "autonomous_submit":
      return "Job Finder fills in and sends each application, and pauses only when it needs you.";
    case "confirm_before_submit":
      return "Job Finder fills in each form, then waits for your go-ahead before sending.";
    default:
      return "Job Finder fills in each form and attaches the resume; you press Send on each one.";
  }
}

interface ApplicationCounts {
  fillingIn: number;
  /** Jobs held by the person's pause before they started. */
  paused: number;
  /** Jobs of a running batch that have not started yet. */
  waiting: number;
  /** Jobs a stopped batch never got to (retryable, counted as could not apply). */
  notStarted: number;
  readyToSend: number;
  /** The jobs whose filled-in form is waiting to be sent. */
  readyToSendJobIds: readonly string[];
  /** Why a send that was asked for did not happen, one per such job. */
  notSentReasons: readonly string[];
  applied: number;
  needsYou: number;
  couldNotApply: number;
  /** Applications the person cancelled or withdrew: not failures. */
  cancelledByPerson: number;
  withdrawnByPerson: number;
  /** The jobs Applications' own "Try again for all" would retry, same rule. */
  retryJobIds: readonly string[];
  /**
   * Filled-in forms whose page closed while they waited on the person. They
   * may have sent one themselves, so these are checked one at a time, never
   * retried together (N-033), the same rule as Applications.
   */
  pageClosedJobIds: readonly string[];
  /**
   * Retry jobs whose form was filled in but whose page closed before it was
   * sent, usually because Job Finder was closed. They are not unfinished.
   */
  closedFilledFormJobIds: readonly string[];
  /**
   * Retry jobs whose form was filled in but whose send failed, with the
   * reason ("Not sent: the site could not be reached"). Not unfinished either.
   */
  notSentRetryReasons: ReadonlyMap<string, string>;
  /** Retry jobs the person stepped into in the browser (see above). */
  takenOverJobIds: readonly string[];
  /** Retry jobs a stopped batch never got to. */
  notStartedJobIds: readonly string[];
  /**
   * Retryable jobs left out of the batch because their Aggressive resume
   * changed and must be approved again first (the start refuses them).
   */
  heldForResumeReview: number;
}

function countApplications(
  workspace: JobFinderRendererWorkspaceSnapshot,
  jobIds: ReadonlySet<string>,
  /** Jobs whose resume the person must approve first; a batch refuses them. */
  resumeReviewJobIds: ReadonlySet<string>,
  pageStates: ReadonlyMap<string, ApplicationPageState> = new Map(),
): ApplicationCounts {
  const retryJobIds: string[] = [];
  const pageClosedJobIds: string[] = [];
  const closedFilledFormJobIds: string[] = [];
  const notSentRetryReasons = new Map<string, string>();
  const takenOverJobIds: string[] = [];
  const notStartedJobIds: string[] = [];
  const readyToSendJobIds: string[] = [];
  const notSentReasons: string[] = [];
  const counts: ApplicationCounts = {
    fillingIn: 0,
    paused: 0,
    waiting: 0,
    notStarted: 0,
    readyToSend: 0,
    readyToSendJobIds,
    notSentReasons,
    applied: 0,
    needsYou: 0,
    couldNotApply: 0,
    cancelledByPerson: 0,
    withdrawnByPerson: 0,
    retryJobIds,
    pageClosedJobIds,
    closedFilledFormJobIds,
    notSentRetryReasons,
    takenOverJobIds,
    notStartedJobIds,
    heldForResumeReview: 0,
  };
  const runningJobIds = new Set(
    (workspace.applyRuns ?? [])
      .filter((run) => run.state === "running")
      .flatMap((run) => run.jobIds),
  );
  const readApplyRunContext = buildApplyRunContextReader(workspace);
  const latestResultByRecordId = new Map<
    string,
    JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
  >();
  for (const result of workspace.applyJobResults ?? []) {
    if (!result.applicationRecordId) continue;
    const previous = latestResultByRecordId.get(result.applicationRecordId);
    if (!previous || previous.updatedAt < result.updatedAt) {
      latestResultByRecordId.set(result.applicationRecordId, result);
    }
  }
  for (const record of workspace.applicationRecords ?? []) {
    if (!jobIds.has(record.jobId)) continue;
    const result = latestResultByRecordId.get(record.id);
    if (!result) {
      if (
        record.status === "submitted" ||
        record.lastAttemptState === "submitted"
      ) {
        counts.applied += 1;
      } else if (record.lastAttemptState === "in_progress") {
        counts.fillingIn += 1;
      } else if (record.lastAttemptState === "failed") {
        counts.couldNotApply += 1;
      }
      continue;
    }
    const presentation = resolveApplyStatePresentation({
      recordCrm: record.crm,
      // The same mapping `needs-you-count.ts` uses, so the tile and the badge
      // agree about which applications are waiting on the person.
      mode:
        record.automationMode === "autonomous_submit"
          ? "apply_for_me"
          : "fill_only",
      result,
      run: readApplyRunContext(result),
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
    });
    if (presentation.plannedStanding === "not_started") {
      counts.notStarted += 1;
    }
    switch (presentation.kind) {
      case "filling_in":
        if (presentation.plannedStanding === "paused") counts.paused += 1;
        else if (
          presentation.plannedStanding === "waiting_turn" ||
          presentation.plannedStanding === "waiting_tab"
        )
          counts.waiting += 1;
        else counts.fillingIn += 1;
        break;
      case "ready_to_send":
        // Its saved form can no longer be filled back in: it is a closed
        // form, not one ready to send.
        if (pageNeedsPreparing(pageStates.get(result.id))) {
          counts.couldNotApply += 1;
          if (!pageClosedJobIds.includes(record.jobId)) {
            pageClosedJobIds.push(record.jobId);
          }
          break;
        }
        counts.readyToSend += 1;
        readyToSendJobIds.push(record.jobId);
        if (describeNotSentResult(result)) notSentReasons.push(result.summary);
        break;
      case "applied":
        counts.applied += 1;
        break;
      case "needs_you":
        counts.needsYou += 1;
        break;
      case "could_not_apply":
        // The person stopped these themselves; Home never retries them.
        if (presentation.withdrawnByPerson) {
          counts.withdrawnByPerson += 1;
          break;
        }
        if (presentation.cancelledByPerson) {
          counts.cancelledByPerson += 1;
          break;
        }
        counts.couldNotApply += 1;
        if (result.blockerSummary === PREPARED_PAGE_CLOSED_SUMMARY) {
          if (!pageClosedJobIds.includes(record.jobId)) {
            pageClosedJobIds.push(record.jobId);
          }
          break;
        }
        // Every retryable job is counted; the batch limit caps the press,
        // not the number (Applications lists them all). A job whose
        // Aggressive resume is waiting for approval would make the whole
        // batch refuse, so it goes through Shortlisted's review instead.
        if (
          presentation.action === "try_again" &&
          !runningJobIds.has(record.jobId) &&
          resumeReviewJobIds.has(record.jobId)
        ) {
          counts.heldForResumeReview += 1;
        } else if (
          presentation.action === "try_again" &&
          !runningJobIds.has(record.jobId) &&
          !retryJobIds.includes(record.jobId)
        ) {
          retryJobIds.push(record.jobId);
          if (presentation.plannedStanding === "not_started") {
            notStartedJobIds.push(record.jobId);
          }
          if (result.summary === PERSON_TOOK_OVER_APPLICATION_SUMMARY) {
            takenOverJobIds.push(record.jobId);
          }
          // The one failure that means the form was finished: the prepared
          // page was gone when it was next needed (after a restart). A page
          // that closed while the form still waited on the person (a file or
          // question it stopped at) was never filled in; its review card
          // still lists what it was waiting on.
          if (
            result.state === "failed" &&
            result.blockerReason === "unexpected_navigation" &&
            (result.reviewCard?.waitingOnYou.length ?? 0) === 0
          ) {
            closedFilledFormJobIds.push(record.jobId);
          } else if (describeNotSentResult(result)) {
            notSentRetryReasons.set(record.jobId, result.summary);
          }
        }
        break;
    }
  }
  return counts;
}

interface ShortlistCounts {
  missingResumes: number;
  writing: number;
  reviewResumes: number;
  /** The jobs behind `reviewResumes`, in queue order. */
  reviewJobs: readonly {
    jobId: string;
    title: string;
    company: string;
    /** Lines waiting for a decision; 0 for an Aggressive read-through. */
    linesToDecide: number;
  }[];
  readyToApply: number;
  readyJobIds: readonly string[];
  inApplications: number;
  /** Shortlisted jobs in no bucket above (for example an out-of-date resume). */
  elsewhere: number;
}

function countShortlist(
  queue: readonly ReviewQueueItem[],
  workspace: JobFinderRendererWorkspaceSnapshot,
): ShortlistCounts {
  const prepared = collectPreparedApplicationJobIds(
    workspace.applicationRecords,
  );
  const inProgress = collectInProgressApplicationJobIds(
    workspace.applicationRecords,
  );
  const unavailable = new Set([...prepared, ...inProgress]);
  const assetsById = new Map(
    (workspace.tailoredAssets ?? []).map((asset) => [asset.id, asset]),
  );
  // Every ready job counts (Shortlisted lists them all); only the press is
  // capped at one batch.
  const readyJobIds = [
    ...new Set(
      queue
        .filter((item) => isQueueStageReady(item, unavailable))
        .map((item) => item.jobId),
    ),
  ];
  let writing = 0;
  let reviewResumes = 0;
  const reviewJobs: ShortlistCounts["reviewJobs"][number][] = [];
  let inApplications = 0;
  const seen = new Set<string>();
  for (const item of queue) {
    if (seen.has(item.jobId)) continue;
    seen.add(item.jobId);
    if (prepared.has(item.jobId) || inProgress.has(item.jobId)) {
      inApplications += 1;
      continue;
    }
    // A job that can have its resume written counts once, as needing a
    // resume, the way Shortlisted's "Needs a resume" tab counts it. A failed
    // or untailored resume also looked like one to review, so the tile said
    // "186 need a resume · 183 to review" for 200 jobs beside a tab saying
    // "To review 10".
    if (isTailoredDraftPreparationEligible(item, prepared)) continue;
    if (item.assetStatus === "generating" || item.assetStatus === "queued") {
      writing += 1;
    } else if (
      needsPersonResumeReview(
        item,
        item.resumeAssetId ? assetsById.get(item.resumeAssetId) : null,
      )
    ) {
      reviewResumes += 1;
      reviewJobs.push({
        jobId: item.jobId,
        title: item.title,
        company: item.company,
        linesToDecide: countResumeLinesToDecide(item),
      });
    }
  }
  const missingResumes = countTailoredDraftPreparationEligible(queue, prepared);
  return {
    missingResumes,
    writing,
    reviewResumes,
    reviewJobs,
    readyToApply: readyJobIds.length,
    readyJobIds,
    inApplications,
    elsewhere: Math.max(
      0,
      seen.size -
        inApplications -
        writing -
        reviewResumes -
        readyJobIds.length -
        missingResumes,
    ),
  };
}

function toHomeQueueButton(
  button: ApplyQueueViewButton | null,
): HomeButton | null {
  if (!button) return null;
  return {
    label: button.label,
    action:
      button.action === "raise_limit"
        ? { kind: "navigate", route: applyingSettingsRoute }
        : { kind: "apply_queue", action: button.action },
  };
}

/** The Apply queue, first in Happening now, with its two controls. */
function buildApplyQueueNowItem(
  queue: JobFinderRendererWorkspaceSnapshot["applyQueue"],
  dailyLimit: number | null,
): HomeNowItem | null {
  const view = describeApplyQueue(queue, { dailyLimit });
  if (!view) return null;
  return {
    id: "apply-queue",
    title: view.title,
    detail: view.detail,
    active: view.active,
    open: toHomeQueueButton(view.primary),
    stop: toHomeQueueButton(view.secondary),
  };
}

function buildNowItem(
  item: JobFinderTaskCenterItem,
  showPausedApply: boolean,
): HomeNowItem | null {
  if (
    item.status !== "active" &&
    item.status !== "stopping" &&
    !(showPausedApply && item.kind === "apply" && item.status === "paused")
  )
    return null;
  const stopping = item.status === "stopping";
  switch (item.kind) {
    case "discovery":
      return {
        id: item.id,
        title: `Searching ${item.sourceLabel}`,
        detail: joinParts([item.stageLabel, item.countLabel]) ?? "",
        stop:
          item.canCancel && !stopping
            ? {
                label: "Stop",
                action: { kind: "stop_search", runId: item.id },
              }
            : null,
        open: {
          label: "Open Find jobs",
          action: { kind: "navigate", route: discoveryRoute },
        },
      };
    case "tailored_drafts":
      return {
        id: item.id,
        title: item.canCancel ? "Writing resumes" : "Stopping resumes",
        detail:
          joinParts([
            item.countLabel,
            item.canCancel
              ? "up to two at once"
              : "finishing the ones already started",
          ]) ?? "",
        stop: item.canCancel
          ? {
              label: "Stop new resumes",
              action: { kind: "stop_resumes" },
            }
          : null,
        open: {
          label: "Open Shortlisted",
          action: { kind: "navigate", route: reviewQueueRoute },
        },
      };
    case "apply": {
      const waitingForTab =
        item.status !== "paused" &&
        item.stageLabel === WAITING_FOR_BROWSER_TAB_SUMMARY;
      return {
        id: item.id,
        title: waitingForTab
          ? `Waiting to apply: ${item.sourceLabel}`
          : `${item.status === "paused" ? "Paused before" : "Applying:"} ${item.sourceLabel}`,
        detail: waitingForTab
          ? "Browser tab limit reached. Close finished tabs in the Job Finder browser; prepared, unsent forms stay open."
          : item.stageLabel,
        stop: item.canCancel
          ? { label: "Stop", action: { kind: "stop_apply", runId: item.id } }
          : null,
        open: {
          label: "Open Applications",
          action: { kind: "navigate", route: applicationsRoute },
        },
      };
    }
    case "resume_import":
      return {
        id: item.id,
        title: "Reading your resume",
        detail: item.stageLabel,
        stop: null,
        open: {
          label: "Open Profile",
          action: { kind: "navigate", route: JOB_FINDER_ROUTE_PATHS.profile },
        },
      };
    case "source_check":
      return {
        id: item.id,
        title: `Checking ${item.sourceLabel}`,
        detail: item.stageLabel,
        stop: null,
        open: {
          label: "Open job sources",
          action: { kind: "navigate", route: profileSourcesRoute },
        },
      };
    default:
      return null;
  }
}

export function buildJobSearchHomeModel(
  input: BuildJobSearchHomeModelInput,
): JobSearchHomeModel {
  const { workspace, tasks } = input;
  const now = input.now ?? Date.now();
  const trackerDue = (() => {
    let overdue = 0;
    let firstDue: { recordId: string; title: string; at: number } | null = null;
    let interviewsSoon = 0;
    const soon = now + 2 * 86_400_000;
    for (const record of input.workspace.applicationRecords) {
      if (record.crm?.archivedAt) continue;
      for (const reminder of record.crm?.reminders ?? []) {
        const due = Date.parse(reminder.dueAt);
        if (
          reminder.status === "pending" &&
          Number.isFinite(due) &&
          due <= now
        ) {
          overdue += 1;
          if (!firstDue || due < firstDue.at) {
            firstDue = {
              recordId: record.id,
              title: `${reminder.title} · ${record.title} at ${record.company}`,
              at: due,
            };
          }
        }
      }
      for (const interview of record.crm?.interviews ?? []) {
        const starts = Date.parse(interview.startsAt);
        if (
          interview.status === "scheduled" &&
          Number.isFinite(starts) &&
          starts >= now &&
          starts <= soon
        )
          interviewsSoon += 1;
      }
    }
    return { overdue, interviewsSoon, firstDue };
  })();
  const jobIds = selectCampaignJobIds(workspace);
  const queue = (workspace.reviewQueue ?? []).filter((item) =>
    jobIds.has(item.jobId),
  );

  const setupStatus = workspace.profileSetupState?.status ?? "not_started";
  const hasSearchHistory =
    (workspace.recentDiscoveryRuns?.length ?? 0) > 0 ||
    Boolean(workspace.activeDiscoveryRun);
  const setupIncomplete = setupStatus !== "completed" && !hasSearchHistory;
  const setupFresh = setupStatus === "not_started";
  const firstSetupBlocker = workspace.profile
    ? getProfileSetupReadinessBlockers(
        evaluateProfileSetupReadiness(
          workspace.profile,
          workspace.searchPreferences,
        ),
      )[0]
    : undefined;
  const setupStep = firstSetupBlocker
    ? firstSetupBlocker.step
    : (workspace.profileSetupState?.currentStep ?? "import");
  const setupStepLabel =
    {
      import: "your resume",
      essentials: "your basics",
      background: "your work history",
      targeting: "your job targets",
      extras: "the optional extras",
      narrative: "the optional extras",
      answers: "the optional extras",
      ready_check: "your job targets",
    }[setupStep] ?? "where you left off";

  const selectedPlan = workspace.campaigns.find(
    (plan) => plan.id === workspace.activeCampaignId,
  );
  const targets =
    selectedPlan?.searchPreferences?.discovery.targets ??
    workspace.searchPreferences.discovery.targets;
  const selectedSourceIds = selectedPlan?.searchPreferences
    ? new Set(resolveCampaignSourceTargetIds(selectedPlan))
    : null;
  const enabledTargets = targets.filter((target) =>
    selectedSourceIds ? selectedSourceIds.has(target.id) : target.enabled,
  );
  const savedSourceCount = targets.length;
  const enabledSourceCount = enabledTargets.length;
  // The same sources, signals and words as the Job sources filter "Needs
  // attention": the library that screen lists, judged with the search
  // history. Home counted six "not working" while that filter showed 687.
  const sourcesNeedingAttention = listSourcesNeedingAttention(
    workspace.searchPreferences.discovery.targets,
    deriveSourceHealthSignals({
      activeRun: workspace.activeDiscoveryRun,
      recentRuns: workspace.recentDiscoveryRuns,
      sourceAccessPrompts: workspace.sourceAccessPrompts,
    }),
  );

  const newestRun = newestDiscoveryRun(workspace);
  // Every source of the newest search failed for the same reason the app
  // owns (its AI was unavailable): that is an outage to say once, not a
  // source to fix.
  const newestRunFailedWarnings = (newestRun?.targetExecutions ?? [])
    .filter((execution) => execution.state === "failed")
    .map((execution) => execution.warning ?? "");
  const newestRunFailedForTheApp =
    newestRunFailedWarnings.length > 0 &&
    newestRunFailedWarnings.every(isAppSideDiscoveryFailure);
  const hasDiscoveryNow = tasks.items.some(
    (item) =>
      item.kind === "discovery" &&
      (item.status === "active" || item.status === "stopping"),
  );
  const queueNow = buildApplyQueueNowItem(
    workspace.applyQueue,
    workspace.dashboard?.globalDailyApplicationPreparationCapacity?.limit ??
      null,
  );
  const nowItems = [
    ...(queueNow ? [queueNow] : []),
    ...tasks.items
      .map((item) =>
        buildNowItem(
          item,
          workspace.activityControl.paused &&
            workspace.activityControl.pauseBehavior === "finish_current",
        ),
      )
      .filter((item): item is HomeNowItem => item !== null),
  ];
  const searchRunning = hasDiscoveryNow || input.discoveryRunPending;
  const resumesWriting = tasks.items.some(
    (item) => item.kind === "tailored_drafts" && item.status === "active",
  );
  const applyRunning =
    isApplyQueueOngoing(workspace.applyQueue) ||
    tasks.items.some(
      (item) =>
        item.kind === "apply" &&
        (item.status === "active" || item.status === "stopping"),
    );

  if (input.discoveryRunPending && !hasDiscoveryNow) {
    nowItems.unshift({
      id: "discovery-pending",
      title: "Starting the search",
      detail: "Opening your job sources.",
      stop: null,
      open: {
        label: "Open Find jobs",
        action: { kind: "navigate", route: discoveryRoute },
      },
    });
  }

  const visibleJobs = countDiscoveryVisibleJobs(workspace, jobIds);
  const hiddenWeaker = countDiscoveryWeakerJobs(workspace, jobIds);
  const shortlisted = countShortlistedJobs(workspace, jobIds);
  const shortlist = countShortlist(queue, workspace);
  const resumeBatch =
    input.tailoredDraftPreparation?.status === "running"
      ? input.tailoredDraftPreparation
      : null;
  const resumeBatchJobIds = new Set(
    resumeBatch && !workspace.intelligence.resumeBatchCheckpoint?.done
      ? workspace.intelligence.resumeBatchCheckpoint?.jobIds
      : [],
  );
  const untouchedResumes =
    resumeBatchJobIds.size > 0
      ? countTailoredDraftPreparationEligible(
          queue.filter((item) => !resumeBatchJobIds.has(item.jobId)),
          collectPreparedApplicationJobIds(workspace.applicationRecords),
        )
      : shortlist.missingResumes;
  const activeResumes = resumeBatch
    ? Math.max(
        0,
        resumeBatch.attemptedCount -
          resumeBatch.completedCount -
          resumeBatch.failedCount,
      )
    : shortlist.writing;
  const queuedResumes =
    resumeBatch && !resumeBatch.stopRequested
      ? Math.max(0, resumeBatch.totalCount - resumeBatch.attemptedCount)
      : 0;
  const applicationCount = countApplicationRecords(workspace, jobIds);
  const applications = countApplications(
    workspace,
    jobIds,
    new Set(
      queue
        .filter((item) =>
          needsPersonResumeReview(
            item,
            (workspace.tailoredAssets ?? []).find(
              (asset) => asset.id === item.resumeAssetId,
            ) ?? null,
          ),
        )
        .map((item) => item.jobId),
    ),
    input.applicationPageStates,
  );
  const dailyPreparationRemaining = Math.max(
    0,
    workspace.dashboard?.globalDailyApplicationPreparationCapacity?.remaining ??
      Number.POSITIVE_INFINITY,
  );
  // One press queues every job: the Apply queue keeps to ten at a time and
  // to the daily limit by itself (ADR 0058).
  const pressLimit = Number.POSITIVE_INFINITY;
  const queuedJobIds = new Set(
    listApplyQueueWaitingJobIds(workspace.applyQueue),
  );
  // A job its batch never reached goes first when a press covers only some:
  // it has no failed attempt behind it, and it was the one left stranded.
  const retryJobIdsWithinDailyLimit = [
    ...applications.retryJobIds.filter((jobId) =>
      applications.notStartedJobIds.includes(jobId),
    ),
    ...applications.retryJobIds.filter(
      (jobId) => !applications.notStartedJobIds.includes(jobId),
    ),
  ]
    .filter((jobId) => !queuedJobIds.has(jobId))
    .slice(0, pressLimit);
  const readyJobIdsWithinDailyLimit = shortlist.readyJobIds
    .filter((jobId) => !queuedJobIds.has(jobId))
    .slice(0, pressLimit);
  /** Why a press covers fewer jobs than are waiting, or null when it covers all. */
  const describePartialPress = (
    n: number,
    total: number,
    stay: "Applications" | "Shortlisted",
  ): string | null => {
    if (n >= total) return null;
    const others = total - n;
    return dailyPreparationRemaining <
      Math.min(total, APPLICATION_PREPARATION_BATCH_LIMIT)
      ? `Today's limit allows ${plural(n, "application")} now. The others stay in ${stay} for later.`
      : `Job Finder works through ${APPLICATION_PREPARATION_BATCH_LIMIT} at a time. The other ${others} ${others === 1 ? "stays" : "stay"} in ${stay} for the next press.`;
  };
  const needsYouCount = countNeedsYou(workspace);
  const safeguardPauses = projectPlanSafeguardPauses(
    workspace.intelligence?.safeguards,
    workspace.campaigns,
  );
  // The same population the sidebar's Safeguards badge counts: a prepared
  // batch waiting for its sample review, a company cap, a conflict. A sample
  // review gates further application preparation, not read-only discovery.
  const safeguardBlockerCount = countSafeguardBlockers(workspace);
  // A batch a safety limit stopped is a safeguard only until its remaining
  // jobs start again. With no limit left to settle, "Open Safeguards" only
  // sent the person on to Applications' "Prepare remaining jobs"; Home offers
  // that retry itself.
  const onlyStoppedBatchesHeld =
    safeguardBlockerCount > 0 &&
    listApplyRunsStoppedBySafeguard(workspace).length === safeguardBlockerCount;

  const runCounts = formatRunCounts(newestRun);
  const runFinished = newestRun?.state === "completed";
  const runFailed =
    newestRun !== null &&
    (newestRun.state === "failed" ||
      newestRun.state === "cancelled" ||
      newestRun.runPhase === "interrupted");
  const lastSearchAt = newestRun?.completedAt ?? newestRun?.startedAt ?? null;
  const retryRequest = buildInterruptedSearchRetryRequest(workspace);
  const searchAgain: HomeButton = input.canRunDiscovery
    ? retryRequest === null
      ? {
          label: "Choose sources",
          action: { kind: "navigate", route: discoveryRoute },
        }
      : {
          label: "Search again",
          action: retryRequest
            ? { kind: "run_search", request: retryRequest }
            : { kind: "run_search" },
        }
    : {
        label: "Open Find jobs",
        action: { kind: "navigate", route: discoveryRoute },
      };

  // Problems: things that are wrong, each with the one place to fix it.
  const problems: HomeProblem[] = [];
  if (
    !setupIncomplete &&
    sourcesNeedingAttention.length > 0 &&
    !newestRunFailedForTheApp
  ) {
    // Searches carry on with the other sources and the app cannot fix a
    // site, so this is a quiet line the person can hide for good (ADR 0051,
    // issue #50), not a red alarm listing every name. The button opens Job
    // sources on the filter with the same name and the same count.
    problems.push({
      id: "failing-sources",
      tone: null,
      text: describeSourcesNeedingAttention(sourcesNeedingAttention.length),
      button: {
        label: "Open job sources",
        action: {
          kind: "navigate",
          route: profileSourcesNeedingAttentionRoute,
        },
      },
      // Hidden for good once dismissed (ADR 0051). Keyed by the set of
      // sources it came back every time one more of ~900 sources failed, so
      // a person with many sources never got rid of it. Job sources keeps
      // the Needs attention filter for anyone who goes looking.
      dismissKey: "dismissed",
    });
  } else if (!setupIncomplete && !searchRunning && !newestRunFailedForTheApp) {
    const newestSettledRun = selectNewestSettledDiscoveryRun(
      workspace.recentDiscoveryRuns ?? [],
    );
    // Only sources still turned on: a problem with a source the person has
    // since removed or turned off has nothing left to fix.
    const settledRun =
      newestSettledRun && newestSettledRun.summary
        ? {
            ...newestSettledRun,
            summary: {
              ...newestSettledRun.summary,
              sourceHealth: (
                newestSettledRun.summary.sourceHealth ?? []
              ).filter((entry) =>
                enabledTargets.some((target) => target.id === entry.targetId),
              ),
            },
          }
        : newestSettledRun;
    // A stop the person pressed is not a source problem, and the status line
    // already says the search stopped early; a line with "Open job sources"
    // for it pointed at nothing to fix.
    const onlyStoppedByPerson =
      (summarizeDiscoveryRunSourceProblems(settledRun)?.total ?? 0) === 0;
    const summary = onlyStoppedByPerson
      ? null
      : formatDiscoveryRunSourceProblemSummary(settledRun);
    if (summary) {
      // The app retries these sources on the next search by itself; the
      // line is a quiet note that can be hidden for good, like the one
      // above, not a warning to act on.
      problems.push({
        id: "source-problems",
        tone: null,
        text: summary,
        button: {
          label: "Open job sources",
          action: { kind: "navigate", route: profileSourcesRoute },
        },
        dismissKey: "dismissed",
      });
    }
  }

  // The next step, in priority order: blocked things first, then whatever is
  // closest to a sent application, then finding more.
  let next: HomeNextStep;
  // The saved mode is used by every Apply until the person deliberately
  // changes it; this is the one press that gets them to that choice.
  const changeApplyModeLink: HomeButton = {
    label: "Change how it applies",
    action: { kind: "navigate", route: applyingSettingsRoute },
  };
  const dailyLimitNext: HomeNextStep = {
    id: "daily_limit",
    title: "Today's preparation limit is reached",
    detail:
      "Application preparation can continue after the daily limit resets, or you can change the limit in Applying settings.",
    primary: {
      label: "Open Applying settings",
      action: { kind: "navigate", route: applyingSettingsRoute },
    },
    secondary: [searchAgain],
  };
  const firstPause = safeguardPauses[0];

  // The in-place steps, built once so a blocker card above them can still
  // offer the next one as a second button. "Send 1 application" used to hide
  // "Try again for all 2" and "Apply to all 3" until that one form was sent.
  const retryNext: HomeNextStep | null =
    applications.retryJobIds.length > 0 && !applyRunning
      ? (() => {
          const n = retryJobIdsWithinDailyLimit.length;
          const total = applications.retryJobIds.length;
          if (n === 0) return dailyLimitNext;
          const partial = describePartialPress(n, total, "Applications");
          return {
            id: "retry",
            title: `${retryWord(input.applicationAutomationMode)} for ${n < total ? `${n} of ${total} applications` : plural(n, "application")}`,
            detail: [
              partial ??
                describeRetryReason(
                  retryJobIdsWithinDailyLimit,
                  applications.closedFilledFormJobIds,
                  applications.takenOverJobIds,
                  applications.notStartedJobIds,
                  applications.notSentRetryReasons,
                ),
              describeHeldForResumeReview(applications.heldForResumeReview),
              describeApplyMode(input.applicationAutomationMode),
            ]
              .filter(Boolean)
              .join(" "),
            detailLink: changeApplyModeLink,
            primary: {
              label:
                n === 1
                  ? retryWord(input.applicationAutomationMode)
                  : n < total
                    ? `${retryWord(input.applicationAutomationMode)} for ${n}`
                    : `${retryWord(input.applicationAutomationMode)} for all ${n}`,
              action: {
                kind: "apply_all",
                jobIds: retryJobIdsWithinDailyLimit,
              },
            },
            secondary: [
              {
                label: "Open Applications",
                action: { kind: "navigate", route: applicationsRoute },
              },
            ],
          };
        })()
      : null;
  const applyNext: HomeNextStep | null =
    shortlist.readyToApply > 0 && !applyRunning
      ? (() => {
          const n = readyJobIdsWithinDailyLimit.length;
          const total = shortlist.readyToApply;
          if (n === 0) return dailyLimitNext;
          const partial = describePartialPress(n, total, "Shortlisted");
          return {
            id: "apply",
            title: `Apply to ${n < total ? `${n} of ${total} ready jobs` : plural(n, "ready job")}`,
            detail: partial
              ? `${partial} ${describeApplyMode(input.applicationAutomationMode)}`
              : describeApplyMode(input.applicationAutomationMode),
            detailLink: changeApplyModeLink,
            primary: {
              label:
                n === 1
                  ? "Apply now"
                  : n < total
                    ? `Apply to ${n}`
                    : `Apply to all ${n}`,
              action: {
                kind: "apply_all",
                jobIds: readyJobIdsWithinDailyLimit,
              },
            },
            secondary: [
              {
                label: "Open Shortlisted",
                action: { kind: "navigate", route: reviewQueueRoute },
              },
            ],
          };
        })()
      : null;
  const createNext: HomeNextStep | null =
    shortlist.missingResumes > 0 && !resumesWriting
      ? {
          id: "create_resumes",
          title: `Create ${plural(shortlist.missingResumes, "resume")}`,
          detail:
            "Written two at a time while you wait. To change a job's resume level first, open Shortlisted.",
          primary: {
            label:
              shortlist.missingResumes === 1
                ? "Create the missing resume"
                : `Create ${shortlist.missingResumes} resumes`,
            action: { kind: "create_resumes" },
          },
          secondary: [
            {
              label: "Open Shortlisted",
              action: { kind: "navigate", route: reviewQueueRoute },
            },
          ],
        }
      : null;
  // While a batch of resumes is being written, applying waits for it (one
  // press for all instead of one now and another later).
  // Send for me covers forms filled in before the person chose it: the agent
  // presses Send on each kept page, one press for all of them. It is also the
  // in-place second button on a card that leads (a Needs-you step), so the
  // ready forms do not wait for that step to be cleared first.
  const sendNext: HomeNextStep | null =
    input.applicationAutomationMode === "autonomous_submit" &&
    applications.readyToSendJobIds.length > 0
      ? (() => {
          const n = applications.readyToSend;
          const notSent = applications.notSentReasons;
          return {
            id: "send",
            title: `Send ${plural(n, "application")}`,
            detail:
              notSent.length > 0
                ? `${notSent.length === 1 ? "1 was" : `${notSent.length} were`} not sent: ${notSent[0]!.replace(/^Not sent:\s*/u, "")}. ${n === 1 ? "Send it" : `Send all ${n}`} tries again.`
                : n === 1
                  ? "The form is filled in and you chose Send for me, so Job Finder presses Send on it."
                  : "The forms are filled in and you chose Send for me, so Job Finder presses Send on each one.",
            primary: {
              label: n === 1 ? "Send it" : `Send all ${n}`,
              action: {
                kind: "send_prepared",
                jobIds: applications.readyToSendJobIds,
              },
            },
            secondary: [
              {
                label: "Open Applications",
                action: { kind: "navigate", route: applicationsRoute },
              },
            ],
          } satisfies HomeNextStep;
        })()
      : null;
  const nextInPlaceStep = [
    sendNext,
    retryNext,
    resumesWriting ? null : applyNext,
    createNext,
  ].find((candidate) => candidate !== null && candidate.id !== "daily_limit");
  // As a second button on another card the title is not there to say how
  // many, so the label carries the count ("Try again" alone beside "Send 5
  // applications" did not say it meant 1 of the 3 that failed).
  // When today's limit is what holds the next press back, say so beside the
  // blocker instead of leaving those jobs waiting without a word.
  const nextInPlaceAction: HomeButton | undefined = nextInPlaceStep
    ? {
        ...nextInPlaceStep.primary,
        label: describeSecondaryPress(
          nextInPlaceStep,
          nextInPlaceStep.id === "retry"
            ? applications.retryJobIds.length
            : shortlist.readyToApply,
          input.applicationAutomationMode,
        ),
      }
    : retryNext?.id === "daily_limit" || applyNext?.id === "daily_limit"
      ? {
          label: "Change today's limit",
          action: { kind: "navigate", route: applyingSettingsRoute },
        }
      : undefined;

  // Why the newest search failed, when every source it tried failed for a
  // reason searching again cannot fix (an address that leads to a missing
  // page, a plan with no sites). "Run it again" was wrong there.
  const failedSourceFix = (() => {
    if (newestRun?.state !== "failed") return null;
    const failed = (newestRun.targetExecutions ?? []).filter(
      (execution) => execution.state === "failed",
    );
    if (
      failed.length === 0 ||
      failed.length !== (newestRun.targetExecutions ?? []).length
    ) {
      return null;
    }
    const recoveries = failed.map((execution) =>
      getDiscoveryRunFailureRecovery(execution.warning ?? ""),
    );
    if (!recoveries.every((recovery) => recovery.kind === "source_setup")) {
      return null;
    }
    // Once the person removed or turned off the broken source, there is
    // nothing left to fix; searching again is the next step, not a card
    // with no search on it.
    const stillOn = failed.filter((execution) =>
      enabledTargets.some((target) => target.id === execution.targetId),
    );
    if (stillOn.length === 0) return null;
    const labels = stillOn
      .map(
        (execution) =>
          targets.find((target) => target.id === execution.targetId)?.label,
      )
      .filter((label): label is string => Boolean(label));
    const recovery = recoveries[0];
    return recovery ? { recovery, labels } : null;
  })();

  const unresolvedRequests = (workspace.userActionRequests ?? []).filter(
    (request) =>
      !["resolved", "skipped", "cancelled", "expired", "superseded"].includes(
        request.state,
      ),
  );
  const sourceSignIns = unresolvedRequests.filter(
    (request) => request.scope?.type === "discovery_source",
  ).length;

  const stoppedEarly =
    newestRun?.runPhase === "interrupted" || newestRun?.state === "cancelled";

  if (workspace.activityControl.paused) {
    next = {
      id: "paused",
      title: "Work is paused",
      detail:
        needsYouCount > 0
          ? `Resume to continue or start work. ${needsYouCount === 1 ? "1 thing needs" : `${needsYouCount} things need`} you meanwhile.`
          : "Resume to continue or start work.",
      primary: { label: "Resume", action: { kind: "resume_activity" } },
      // The pause holds new work, not the person's answers.
      secondary:
        needsYouCount > 0
          ? [
              {
                label: "Open Needs you",
                action: { kind: "navigate", route: needsYouRoute },
              },
            ]
          : [],
    };
  } else if (firstPause) {
    next = {
      id: "safeguards",
      title: firstPause.id.startsWith(
        `${AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID}:`,
      )
        ? "A safeguard paused application work"
        : "A safeguard paused your search plan",
      detail: firstPause.explanation,
      primary: {
        label: "Open Safeguards",
        action: { kind: "navigate", route: firstPause.route },
      },
      secondary: [],
    };
  } else if (
    onlyStoppedBatchesHeld &&
    retryNext?.id === "retry" &&
    needsYouCount === 0
  ) {
    next = {
      ...retryNext,
      detail: retryNext.detail.startsWith("The batch stopped before")
        ? retryNext.detail.replace(
            "The batch stopped before",
            "A safety limit stopped the batch before",
          )
        : `A safety limit stopped your last batch. ${retryNext.detail}`,
      secondary: [
        ...retryNext.secondary,
        {
          label: "Open Safeguards",
          action: { kind: "navigate", route: "/job-finder/safeguards" },
        },
      ],
    };
  } else if (safeguardBlockerCount > 0) {
    next = {
      id: "safeguards",
      title:
        safeguardBlockerCount === 1
          ? "A safeguard is waiting on you"
          : `${safeguardBlockerCount} safeguards are waiting on you`,
      detail:
        "Job Finder held some application work back until you decide. Safeguards says why and what carries it on; searches carry on meanwhile.",
      primary: {
        label: "Open Safeguards",
        action: { kind: "navigate", route: "/job-finder/safeguards" },
      },
      // The stopped batch's remaining jobs stay one press away.
      secondary:
        onlyStoppedBatchesHeld && retryNext?.id === "retry"
          ? [retryNext.primary]
          : [],
    };
  } else if (setupIncomplete) {
    next = setupFresh
      ? {
          id: "setup",
          title: "Set up your profile",
          detail:
            "Import your resume and tell Job Finder what you're looking for. Takes about five minutes.",
          primary: {
            label: "Start setup",
            action: { kind: "navigate", route: profileSetupRoute },
          },
          secondary: [],
        }
      : {
          id: "setup",
          title: "Finish setting up",
          detail: firstSetupBlocker
            ? `${getProfileSetupReadinessBlockerLabel(firstSetupBlocker.id)} in ${setupStepLabel}.`
            : `Pick up at ${setupStepLabel} to finish setup.`,
          primary: {
            label: "Continue setup",
            action: { kind: "resume_setup", step: setupStep },
          },
          secondary: [],
        };
  } else if (needsYouCount > 0) {
    const others = needsYouCount - sourceSignIns;
    next = {
      id: "needs_you",
      title:
        needsYouCount === 1
          ? "1 thing needs you"
          : `${needsYouCount} things need you`,
      // The count holds source sign-ins too; "An application is waiting"
      // was wrong when the only item was a job site asking to sign in.
      detail:
        others <= 0
          ? `${sourceSignIns === 1 ? "A job source wants" : `${sourceSignIns} job sources want`} you to sign in before Job Finder can search ${sourceSignIns === 1 ? "it" : "them"}. Sign in once in the Job Finder browser; the search carries on by itself.`
          : sourceSignIns > 0
            ? "An application is waiting on an answer or a step only you can take, and a job source wants you to sign in. Open Needs you to keep them moving."
            : "An application is waiting on an answer or a step only you can take. Open it to keep that application moving.",
      primary: {
        label: "Open Needs you",
        action: { kind: "navigate", route: needsYouRoute },
      },
      // The rest of the pipeline does not wait on this one item.
      secondary: nextInPlaceAction ? [nextInPlaceAction] : [],
    };
  } else if (trackerDue.firstDue) {
    next = {
      id: "tracker_due",
      title: trackerDue.firstDue.title,
      detail: `${plural(trackerDue.overdue, "follow-up is due", "follow-ups are due")}. You can follow up while other work runs.`,
      primary: {
        label: "Open application",
        action: {
          kind: "navigate",
          route: `${trackerRoute}&applicationRecordId=${encodeURIComponent(trackerDue.firstDue.recordId)}`,
        },
      },
      secondary: [],
    };
  } else if (enabledSourceCount === 0) {
    next =
      savedSourceCount > 0
        ? {
            id: "sources",
            title: "Turn on a job source",
            detail:
              "Your sources are saved but none is turned on, so a search has nowhere to look.",
            primary: {
              label: "Open job sources",
              action: { kind: "navigate", route: profileSourcesRoute },
            },
            secondary: [],
          }
        : {
            id: "sources",
            title: "Add a job source",
            detail:
              "Paste a job board or careers page you already browse. Job Finder searches only the sites you add.",
            primary: {
              label: "Open job sources",
              action: { kind: "navigate", route: profileSourcesRoute },
            },
            secondary: [],
          };
  } else if (applications.readyToSend > 0) {
    const n = applications.readyToSend;
    next = sendNext
      ? {
          ...sendNext,
          // Jobs that could not be finished stay one press away beside it.
          secondary: [
            ...(retryNext && retryNext.id === "retry"
              ? [
                  {
                    ...retryNext.primary,
                    label: describeSecondaryPress(
                      retryNext,
                      applications.retryJobIds.length,
                      input.applicationAutomationMode,
                    ),
                  },
                ]
              : []),
            ...sendNext.secondary,
          ],
        }
      : {
          id: "send",
          title: `Send ${plural(n, "application")}`,
          detail:
            input.applicationAutomationMode === "confirm_before_submit"
              ? "The forms are filled in. Look each one over and give the go-ahead."
              : "The forms are filled in and the resume is attached. Press Send on each one in the browser.",
          primary: {
            label: "Open Applications",
            action: { kind: "navigate", route: applicationsRoute },
          },
          secondary: nextInPlaceAction ? [nextInPlaceAction] : [],
        };
  } else if (shortlist.reviewResumes > 0) {
    // Reading the resumes is what lets the person apply, so with resumes
    // waiting it is the next step; a failed batch to retry and forms that
    // closed are one press or one quiet line beside it. "Check 4 applications
    // whose form closed" used to lead while 196 resumes waited.
    const n = shortlist.reviewResumes;
    const only = n === 1 ? shortlist.reviewJobs[0] : undefined;
    const first = shortlist.reviewJobs[0];
    const withLines = shortlist.reviewJobs.filter(
      (job) => job.linesToDecide > 0,
    );
    const why =
      withLines.length === 0
        ? only
          ? "Aggressive resumes stretch toward the posting, so each one is read and approved before it is used."
          : "Aggressive resumes stretch toward the posting, so each one is read and approved before it is used. Approve one and the next opens."
        : only
          ? `${only.linesToDecide === 1 ? "A line" : `${only.linesToDecide} lines`} in the resume for ${only.title} at ${only.company} ${only.linesToDecide === 1 ? "is" : "are"} waiting for your decision. Keep or change ${only.linesToDecide === 1 ? "it" : "each one"}, and the job can be applied to.`
          : withLines.length === n
            ? "Some resumes have lines waiting for your decision. Keep or change each one, and those jobs can be applied to."
            : "Some resumes have lines waiting for your decision, and Aggressive resumes stretch toward the posting. Approve one and the next opens.";
    // The ready jobs do not wait on this review; say which ones do.
    const pressCount =
      applyNext?.primary.action.kind === "apply_all"
        ? applyNext.primary.action.jobIds.length
        : 0;
    const heldBack =
      applyNext?.id === "apply" && shortlist.readyToApply > 0
        ? only
          ? ` "${describeSecondaryPress(applyNext, shortlist.readyToApply, input.applicationAutomationMode)}" starts ${pressCount < shortlist.readyToApply ? `${pressCount} of the ${shortlist.readyToApply} ready jobs` : pressCount === 1 ? "the ready one" : "the others"}; ${only.title} waits for this.${pressCount < shortlist.readyToApply ? ` ${describePartialPress(pressCount, shortlist.readyToApply, "Shortlisted") ?? ""}`.trimEnd() : ""}`
          : ` The ready jobs can start now; these ${n} wait for their review.`
        : "";
    const closedCount = applyRunning ? 0 : applications.pageClosedJobIds.length;
    next = {
      id: "review_resumes",
      title: only ? "Review the resume" : `Review ${plural(n, "resume")}`,
      detail: `${why}${heldBack}`,
      // Lands on the first resume waiting, in the studio's review pass.
      primary: only
        ? {
            label: "Review the resume",
            action: {
              kind: "navigate",
              route: buildResumeWorkspaceRoute(only.jobId),
            },
          }
        : first
          ? {
              label: "Start reviewing",
              action: {
                kind: "navigate",
                route: buildResumeWorkspaceRoute(first.jobId),
              },
            }
          : {
              label: "Open Shortlisted",
              action: { kind: "navigate", route: reviewQueueRoute },
            },
      // Work that does not wait on this review keeps moving in one press
      // here: failed applications to retry, missing resumes to write, and
      // ready jobs to apply to. (Search again is added below, as for every
      // step of the loop.)
      secondary: [
        ...(retryNext && retryNext.id === "retry"
          ? [
              {
                ...retryNext.primary,
                label: describeSecondaryPress(
                  retryNext,
                  applications.retryJobIds.length,
                  input.applicationAutomationMode,
                ),
              },
            ]
          : []),
        ...(createNext ? [createNext.primary] : []),
        ...(applyNext && applyNext.id === "apply" && !resumesWriting
          ? [
              {
                ...applyNext.primary,
                label: describeSecondaryPress(
                  applyNext,
                  shortlist.readyToApply,
                  input.applicationAutomationMode,
                ),
              },
            ]
          : []),
      ],
      also:
        closedCount > 0
          ? [
              {
                id: "check_closed",
                text:
                  closedCount === 1
                    ? `1 application's form closed before it was sent: check it, then mark it Applied or ${input.applicationAutomationMode === "autonomous_submit" ? "apply again" : "prepare it again"}.`
                    : `${closedCount} applications' forms closed before they were sent: check them, then mark each Applied or ${input.applicationAutomationMode === "autonomous_submit" ? "apply again" : "prepare it again"}.`,
                link: {
                  label: "Open Applications",
                  action: { kind: "navigate", route: applicationsRoute },
                },
              },
            ]
          : [],
    };
  } else if (retryNext) {
    next = retryNext;
  } else if (applications.pageClosedJobIds.length > 0 && !applyRunning) {
    // A filled-in form whose page closed may have been sent by the person
    // before it closed; only they know. Trying them all again could send one
    // twice (N-033), so each is checked in Applications.
    const n = applications.pageClosedJobIds.length;
    next = {
      id: "check_closed",
      // "Form closed" is what the rows and the detail badge say.
      title: `Check ${plural(n, "application")} whose form closed`,
      detail:
        n === 1
          ? `Job Finder filled this one in, but its form closed before Job Finder saw it sent. If you sent it yourself, set its tracker stage to Applied. If not, choose ${input.applicationAutomationMode === "autonomous_submit" ? "Apply again" : "Prepare again"} on it in Applications.`
          : `Job Finder filled these in, but their forms closed before Job Finder saw them sent. If you sent any yourself, set its tracker stage to Applied. Choose ${input.applicationAutomationMode === "autonomous_submit" ? "Apply again" : "Prepare again"} on the others in Applications.`,
      primary: {
        label: "Open Applications",
        action: { kind: "navigate", route: applicationsRoute },
      },
      secondary: [searchAgain],
    };
  } else if (applications.heldForResumeReview > 0 && !applyRunning) {
    // Trying these again would be refused until the changed Aggressive
    // resume is read and approved; say that instead of offering the press.
    const n = applications.heldForResumeReview;
    next = {
      id: "review_resumes",
      title: `Approve ${plural(n, "changed resume")}`,
      detail:
        n === 1
          ? "An application could not be finished and its Aggressive resume has changed since. Read and approve it, then try again from Applications."
          : `${n} applications could not be finished and their Aggressive resumes have changed since. Read and approve each one, then try again from Applications.`,
      primary: {
        label: "Open Applications",
        action: { kind: "navigate", route: applicationsRoute },
      },
      secondary: [],
    };
  } else if (
    applyNext &&
    applyNext.id === "apply" &&
    createNext &&
    shortlist.missingResumes > shortlist.readyToApply
  ) {
    // Most shortlisted jobs still need a resume: writing them is the next
    // step, and applying to the few ready ones stays one press beside it.
    // Leading with "Apply to 1 ready job" and no Create cost two presses
    // through Shortlisted.
    next = {
      ...createNext,
      secondary: [
        {
          ...applyNext.primary,
          label: describeSecondaryPress(
            applyNext,
            shortlist.readyToApply,
            input.applicationAutomationMode,
          ),
        },
        ...createNext.secondary,
      ],
    };
  } else if (applyNext && !(resumesWriting && applyNext.id === "apply")) {
    // While the batch of resumes is still being written, waiting for it and
    // applying to all at once is one press; "Apply to 1 ready job" mid-batch
    // invited a partial press and a second one later. Jobs still waiting for
    // a resume get Create in place beside Apply.
    next =
      createNext && applyNext.id === "apply"
        ? {
            ...applyNext,
            secondary: [createNext.primary, ...applyNext.secondary],
          }
        : applyNext;
  } else if (createNext) {
    next = createNext;
  } else if (applyRunning) {
    next = {
      id: "wait_apply",
      title: "Nothing needed from you right now",
      detail:
        "Job Finder is working through your applications. It will show up here if one needs you.",
      primary: {
        label: "Open Applications",
        action: { kind: "navigate", route: applicationsRoute },
      },
      secondary: [],
    };
  } else if (resumesWriting) {
    next = {
      id: "wait_resumes",
      title: "Nothing needed from you right now",
      detail:
        applyNext?.id === "apply"
          ? `The resumes are being written; ${shortlist.readyToApply} ${shortlist.readyToApply === 1 ? "is" : "are"} ready so far. Apply to all of them once the rest are done, or start the ready ones now.`
          : "The resumes are being written. Apply is the next step once they are ready.",
      primary: {
        label: "Open Shortlisted",
        action: { kind: "navigate", route: reviewQueueRoute },
      },
      secondary:
        applyNext?.id === "apply" &&
        applyNext.primary.action.kind === "apply_all"
          ? [
              {
                label:
                  applyNext.primary.action.jobIds.length === 1
                    ? "Apply to the ready one now"
                    : `Apply to the ${applyNext.primary.action.jobIds.length} ready now`,
                action: applyNext.primary.action,
              },
            ]
          : [],
    };
  } else if (searchRunning) {
    next = {
      id: "wait_search",
      title: "Nothing needed from you right now",
      detail:
        "Results land in Find jobs as each source finishes. You can start shortlisting while it runs.",
      primary: {
        label: "Open Find jobs",
        action: { kind: "navigate", route: discoveryRoute },
      },
      secondary: [],
    };
  } else if (!hasSearchHistory) {
    next = {
      id: "first_search",
      title: "Run your first search",
      detail: `Job Finder searches ${plural(enabledSourceCount, "source")} with your profile and lists what it finds in Find jobs.`,
      primary: input.canRunDiscovery
        ? { label: "Search now", action: { kind: "run_search" } }
        : {
            label: "Open Find jobs",
            action: { kind: "navigate", route: discoveryRoute },
          },
      secondary: [],
    };
  } else if (failedSourceFix) {
    const { recovery, labels } = failedSourceFix;
    next = {
      id: "source_failed",
      title:
        labels.length > 1
          ? `Fix ${labels.length} job sources`
          : "Fix a job source",
      detail: `${recovery.headline}${labels.length > 0 ? ` (${labels.join(", ")})` : ""} ${recovery.nextStep}`,
      primary: {
        label: "Open job sources",
        action: { kind: "navigate", route: profileSourcesRoute },
      },
      secondary: [],
    };
  } else if (
    runFailed &&
    !(stoppedEarly && visibleJobs > 0 && shortlisted === 0)
  ) {
    next = {
      id: "search_failed",
      title: stoppedEarly
        ? "Your last search stopped early"
        : "Your last search failed",
      detail:
        retryRequest === null
          ? "The sources it used are no longer enabled. Choose which sources to search."
          : newestRunFailedForTheApp
            ? (() => {
                const recovery = getDiscoveryRunFailureRecovery(
                  newestRunFailedWarnings[0] ?? "",
                );
                return `${recovery.headline} ${recovery.nextStep}`;
              })()
            : "Run it again to pick up the openings it missed.",
      primary: searchAgain,
      secondary: [],
    };
  } else if (runFinished && visibleJobs === 0 && runNewCount(newestRun) === 0) {
    next = {
      id: "nothing_found",
      title: "Your search found nothing new",
      detail:
        "Try again later, add another job source, or widen the roles and places in your profile.",
      primary: searchAgain,
      secondary: [
        {
          label: "Open job sources",
          action: { kind: "navigate", route: profileSourcesRoute },
        },
      ],
    };
  } else if (visibleJobs > 0 && shortlisted === 0) {
    next = {
      id: "look_through",
      title: `Look through ${plural(visibleJobs, "job")}`,
      detail: stoppedEarly
        ? "You stopped the search; the jobs it found so far are in Find jobs. Shortlist the ones you want to apply to."
        : "Shortlist the ones you want to apply to. Job Finder writes a resume for each and applies.",
      primary: {
        label: "Open Find jobs",
        action: { kind: "navigate", route: discoveryRoute },
      },
      secondary: [searchAgain],
    };
  } else if (visibleJobs === 0 && hiddenWeaker > 0 && shortlisted === 0) {
    // Everything the search kept scored below your targets. "Nothing is
    // waiting on you" beside a tile saying "N weaker matches hidden" was
    // wrong: they are there to look at.
    next = {
      id: "look_through",
      title: `Look through ${plural(hiddenWeaker, "weaker match", "weaker matches")}`,
      detail:
        "The last search found no strong matches. The weaker ones are behind Show weaker matches in Find jobs; shortlist any worth applying to, or widen the roles and places in your profile.",
      primary: {
        label: "Open Find jobs",
        action: { kind: "navigate", route: discoveryRoute },
      },
      secondary: [searchAgain],
    };
  } else if (shortlist.elsewhere > 0) {
    // Shortlisted jobs in no other bucket: an out-of-date resume, one that
    // could not be written. "All caught up" was not true for them.
    const n = shortlist.elsewhere;
    next = {
      id: "review_resumes",
      title: `Check ${plural(n, "shortlisted job")}`,
      detail:
        n === 1
          ? "Its resume is out of date or could not be written. Open Shortlisted to write it again or pick another level."
          : "Their resumes are out of date or could not be written. Open Shortlisted to write them again or pick another level.",
      primary: {
        label: "Open Shortlisted",
        action: { kind: "navigate", route: reviewQueueRoute },
      },
      // Search again is added below, as for every review step.
      secondary: [],
    };
  } else if (trackerDue.overdue > 0 || trackerDue.interviewsSoon > 0) {
    // A follow-up past its date or an interview in the next two days is
    // waiting on the person even when no application work is: "All caught
    // up" beside an overdue reminder was not true.
    const parts = [
      trackerDue.overdue > 0
        ? plural(
            trackerDue.overdue,
            "follow-up is overdue",
            "follow-ups are overdue",
          )
        : null,
      trackerDue.interviewsSoon > 0
        ? `${plural(trackerDue.interviewsSoon, "interview")} in the next two days`
        : null,
    ].filter((part): part is string => part !== null);
    next = {
      id: "tracker_due",
      title: parts.join(" · ").replace(/^./u, (first) => first.toUpperCase()),
      detail:
        "Your tracker has dates coming due. Open it to see them, mark reminders done, or move them.",
      primary: {
        label: "Open the tracker",
        action: { kind: "navigate", route: trackerRoute },
      },
      secondary: [searchAgain],
    };
  } else {
    next = {
      id: "caught_up",
      title: "All caught up",
      detail:
        shortlisted > 0
          ? "Every shortlisted job is in Applications. Search again for new openings, or shortlist more from Find jobs."
          : "Nothing is waiting on you. Search again for new openings.",
      primary: searchAgain,
      secondary: [
        {
          label: `Open Find jobs`,
          action: { kind: "navigate", route: discoveryRoute },
        },
      ],
    };
  }

  // The card already names the broken source and the one place to fix it;
  // a problem line saying the same thing again is noise.
  const shownProblems =
    // With no source turned on, the last search's source problems are about
    // sources that are off; the card asks for a source instead.
    next.id === "source_failed" || next.id === "sources"
      ? problems.filter(
          (problem) =>
            problem.id !== "source-problems" &&
            problem.id !== "failing-sources",
        )
      : problems;

  // Searching again is always one press for a returning person (the search
  // loop is the product), so every step that is not itself a search, a wait,
  // or a blocker carries it as a quiet second button.
  if (
    hasSearchHistory &&
    !searchRunning &&
    ["send", "retry", "review_resumes", "apply", "create_resumes"].includes(
      next.id,
    )
  ) {
    next = { ...next, secondary: [...next.secondary, searchAgain] };
  }

  // What is going on, in one sentence.
  if (trackerDue.firstDue && next.id !== "tracker_due") {
    next = {
      ...next,
      detail: `${next.detail} Follow-up due: ${trackerDue.firstDue.title}.`,
      secondary: [
        ...next.secondary,
        {
          label: "Open due follow-up",
          action: {
            kind: "navigate",
            route: `${trackerRoute}&applicationRecordId=${encodeURIComponent(trackerDue.firstDue.recordId)}`,
          },
        },
      ],
    };
  }
  const paused = workspace.activityControl.paused;
  let statusLine: string;
  if (paused) {
    statusLine =
      "Paused. New searches and applications will not start until you resume.";
  } else if (nowItems.length === 1 && nowItems[0]) {
    statusLine = `${nowItems[0].title} · ${nowItems[0].detail}`.replace(
      /\.?$/,
      ".",
    );
  } else if (nowItems.length > 1) {
    // "Nothing needs you yet" stood beside a card saying "2 things need you".
    statusLine = `${nowItems.length} things are running. ${
      needsYouCount === 0
        ? "Nothing needs you yet."
        : needsYouCount === 1
          ? "1 thing needs you."
          : `${needsYouCount} things need you.`
    }`;
  } else if (setupIncomplete) {
    statusLine = setupFresh
      ? "Nothing here yet. Set up your profile to start."
      : "Setup is not finished yet.";
  } else if (enabledSourceCount === 0) {
    statusLine =
      savedSourceCount > 0
        ? "No job source is turned on, so nothing can be searched."
        : "No job source added yet, so nothing can be searched.";
  } else if (!hasSearchHistory) {
    statusLine = `Ready to search ${plural(enabledSourceCount, "source")}. Nothing has been searched yet.`;
  } else if (newestRun && lastSearchAt) {
    const when = formatRelativeDay(lastSearchAt, now);
    const verb = runFailed
      ? newestRun.runPhase === "interrupted" || newestRun.state === "cancelled"
        ? "stopped early"
        : "failed"
      : "finished";
    // A one-source pass (the source searched again after a sign-in, or
    // "search this source") counts only that source; say which, so its
    // numbers are not read as the whole search.
    const singleSourceLabel =
      newestRun.scope === "single_target" && enabledSourceCount > 1
        ? (targets.find((target) => target.id === newestRun.targetIds[0])
            ?.label ?? null)
        : null;
    statusLine = singleSourceLabel
      ? `Last search of ${singleSourceLabel} ${verb} ${when}${runCounts ? ` · ${runCounts}` : ""}.`
      : `Last search ${verb} ${when}${runCounts ? ` · ${runCounts}` : ""}.`;
  } else {
    statusLine = "Nothing is running.";
  }

  const stages: HomeStage[] | null =
    hasSearchHistory ||
    visibleJobs > 0 ||
    shortlisted > 0 ||
    applicationCount > 0
      ? [
          {
            id: "discovery",
            label: "Find jobs",
            count: visibleJobs,
            // The Find jobs header's own words: the weaker ones may be
            // shown or hidden there, so the tile does not say which.
            detail: hiddenWeaker > 0 ? `+ ${hiddenWeaker} weaker` : null,
            route: discoveryRoute,
          },
          {
            id: "review-queue",
            label: "Shortlisted",
            count: shortlisted,
            detail: joinParts([
              untouchedResumes > 0 ? `${untouchedResumes} need a resume` : null,
              queuedResumes > 0 ? `${queuedResumes} queued` : null,
              activeResumes > 0 ? `${activeResumes} being written` : null,
              shortlist.reviewResumes > 0
                ? `${shortlist.reviewResumes} to review`
                : null,
              shortlist.readyToApply > 0
                ? `${shortlist.readyToApply} ready to apply`
                : null,
              shortlist.elsewhere > 0
                ? `${shortlist.elsewhere} to check`
                : null,
              shortlist.inApplications > 0
                ? `${shortlist.inApplications} in Applications`
                : null,
            ]),
            route: reviewQueueRoute,
          },
          {
            id: "applications",
            label: "Applications",
            count: applicationCount,
            detail: joinParts([
              applications.fillingIn > 0
                ? `${applications.fillingIn} filling in`
                : null,
              applications.waiting > 0
                ? `${applications.waiting} waiting`
                : null,
              applications.paused > 0 ? `${applications.paused} paused` : null,
              applications.readyToSend > 0
                ? `${applications.readyToSend} ready to send`
                : null,
              applications.needsYou > 0
                ? `${applications.needsYou} need you`
                : null,
              applications.applied > 0
                ? `${applications.applied} applied`
                : null,
              applications.pageClosedJobIds.length > 0
                ? `${plural(applications.pageClosedJobIds.length, "form")} closed`
                : null,
              applications.couldNotApply -
                applications.notStarted -
                applications.pageClosedJobIds.length >
              0
                ? `${applications.couldNotApply - applications.notStarted - applications.pageClosedJobIds.length} could not apply`
                : null,
              applications.notStarted > 0
                ? `${applications.notStarted} not started`
                : null,
              applications.cancelledByPerson > 0
                ? `${applications.cancelledByPerson} cancelled`
                : null,
              applications.withdrawnByPerson > 0
                ? `${applications.withdrawnByPerson} withdrawn`
                : null,
              // Tracker dates stay counted here when another next step wins
              // the card above (N-013).
              trackerDue.overdue > 0
                ? plural(
                    trackerDue.overdue,
                    "follow-up overdue",
                    "follow-ups overdue",
                  )
                : null,
              trackerDue.interviewsSoon > 0
                ? `${plural(trackerDue.interviewsSoon, "interview")} soon`
                : null,
            ]),
            route: applicationsRoute,
          },
        ]
      : null;

  return {
    statusLine,
    paused,
    now: nowItems,
    problems: shownProblems,
    next,
    stages,
    showPlanSelector: !setupIncomplete && workspace.campaigns.length > 1,
  };
}
