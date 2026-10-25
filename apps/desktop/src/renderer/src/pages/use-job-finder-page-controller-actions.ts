import { APPLICATION_WORK_PAUSED_REASON } from "@renderer/features/job-finder/lib/application-work-paused";
import {
  JOB_FINDER_BROWSER_NAME,
  JOB_FINDER_BROWSER_NAME_SENTENCE_START,
} from "@renderer/features/job-finder/lib/job-finder-browser-handoff-copy";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { JobFinderActionFailureReporting } from "./job-finder-page-context";
import {
  appendDiscoveryLiveActivityEvent,
  evaluateProfileSetupReadiness,
  getProfileSetupReadinessBlockers,
  isRunnableJobDiscoveryTarget,
} from "@nestor/contracts";
import type {
  AppearanceTheme,
  ApplicationCrmSettings,
  CandidateProfile,
  DiscoveryActivityEvent,
  DiscoveryFeedbackReason,
  JobFinderAgentDiscoveryResult,
  JobFinderSearchRequest,
  JobFinderApplyConsentActionInput,
  JobFinderApplyQueueActionInput,
  JobFinderApplyRunActionInput,
  JobFinderResumeWorkspace,
  JobFinderApplicationStartTarget,
  JobFinderOpenBrowserSessionInput,
  JobFinderPreparedApplicationPageInput,
  JobFinderRendererWorkspaceSnapshot,
  ProfileCopilotMessage,
  JobSearchPreferences,
  ProfileCopilotContext,
  ProfileSetupReviewActionOptions,
  ProfileSetupState,
  ProfileSetupStep,
  RemoveEmployerExclusionInput,
  ResumeAssistantMessage,
  ResumeApplicationMode,
  ResumeDraft,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
  UpdateAiBehaviorInput,
} from "@nestor/contracts";
import { collectPreparedApplicationJobIds } from "@renderer/features/job-finder/lib/review-queue-status";
import { isFinishBlockingReviewItem } from "@renderer/features/job-finder/components/profile/setup/profile-setup-screen-helpers";
import type {
  ActionState,
  JobFinderAutoApplyQueueStartOutcome,
  JobFinderQueuedJobOutcome,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import {
  formatDiscoveryRunReportLabel,
  getDiscoveryRunReportCounts,
  hasDiscoveryRunReportCounts,
} from "@renderer/features/job-finder/lib/discovery-run-count-label";
import {
  createDiscoveryRunAlreadyRunningFeedback,
  createDiscoveryRunCancelledFeedback,
  createDiscoveryRunFailedFeedback,
  createDiscoveryRunInterruptedFeedback,
  createDiscoveryRunRefreshIncompleteFeedback,
  createDiscoveryRunRepeatedFeedback,
  createDiscoveryRunStartedFeedback,
  createDiscoveryRunSucceededFeedback,
  getDiscoveryCancelledSavedJobCount,
  isDiscoveryAlreadyRunningDetail,
  shouldPresentRepeatedDiscoveryFeedback,
  type DiscoveryRunFeedback,
} from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import {
  getPendingActionGeneration,
  type PendingActionScope,
  type PendingActionState,
  jobFinderPendingActions,
} from "./job-finder-pending-actions";
import { getProfileCopilotContextKey } from "@renderer/features/job-finder/lib/profile-copilot-context";
import {
  getJobFinderErrorDetail,
  getJobFinderErrorMessage,
} from "@renderer/features/job-finder/lib/job-finder-error-message";
import { buildJobFinderContextRoute } from "../features/job-finder/lib/job-finder-context-navigation";
import {
  listApplyQueueWaitingJobIds,
  type ApplyQueueControlAction,
} from "../features/job-finder/lib/apply-queue-view";
import {
  getRecentChangeUndo,
  listRecentChanges,
  markRecentChangeUndone,
  recordRecentChange,
  type RecentChange,
  type RecentChangeInput,
} from "@renderer/features/job-finder/lib/recent-changes";
import { buildSourceDebugOutcomeMessage } from "./job-finder-page-route-utils";
import {
  createSaveDedupeKey,
  type JobFinderSaveCoordinator,
  type JobFinderSaveSurface,
} from "./job-finder-save-state";

import { COMMAND_PENDING_RELEASE_MS } from "@renderer/features/job-finder/lib/discovery-stop-state";
import { describeFailure } from "@renderer/features/job-finder/lib/describe-failure";
import { describeApplicationDefaultsSave } from "@renderer/features/job-finder/screens/settings/settings-application-defaults-save-copy";

/**
 * How long a browser-backed command may keep its controls disabled. Defined
 * beside the stop-state helper that bounds a Stop request with the same
 * window, and re-exported here for the call sites that already import it.
 */
export { COMMAND_PENDING_RELEASE_MS };

type ActionOptions = {
  toastTone?: () => "success" | "warning";
  /** Offered as Undo on the success toast. */
  undo?: () => void;
  /** "Undo all" for a move of many jobs. */
  undoLabel?: string;
  clearMessageOnStart?: boolean;
  /** A flow that navigates immediately keeps later failures on its destination. */
  statusOwnerPath?: string;
  /**
   * Release the pending scope after this long even if the call has not
   * settled. Application preparation runs inside one IPC call that can take
   * many minutes or hang; while it did, every Prepare control in the app
   * stayed disabled, including after the run had been cancelled. The run's
   * own state is shown by the Applications screen and the Tasks panel.
   */
  releasePendingAfterMs?: number;
  pendingTimeoutMessage?: string;
  rethrowError?: boolean;
  scope?: PendingActionScope;
  startMessage?: string;
};

type BaseActionArgs = {
  actions: JobFinderShellActions;
  activeRouteResumeWorkspace: JobFinderResumeWorkspace | null;
  canImportResume: boolean;
  confirmLeaveDirtyResumeWorkspace: (pendingAction: string) => Promise<boolean>;
  importResumeGuardMessage: string | null;
  isCurrentResumeAssistantRequest: (
    jobId: string,
    requestToken: number,
  ) => boolean;
  isCurrentResumeWorkspaceJob: (jobId: string) => boolean;
  /** The current route, read when an action runs rather than per render. */
  getLocationPathname: () => string;
  navigate: (
    path: string,
    options?: { replace?: boolean; state?: unknown },
  ) => void;
  profileSetupState: ProfileSetupState | null;
  profileCopilotRequestTokenRef: MutableRefObject<number>;
  requestApplyCopilotVisualCheckpoints: (request: {
    jobId: string;
    subject: string | null;
    description: string;
    /**
     * Returns a refusal sentence when the start could not begin, so the dialog
     * can stay open and say why instead of closing silently.
     */
    onResolve: (
      visualCheckpointsEnabled: boolean,
    ) => string | null | void | Promise<string | null | void>;
    onCancel?: () => void;
  }) => void;
  refreshResumeWorkspace: (
    jobId: string,
    options?: {
      updateAssistantMessages?: boolean;
    },
  ) => Promise<boolean>;
  /**
   * Puts an autosaved draft into the open resume at once and reloads the rest
   * (checks, history) only once the edits settle.
   */
  adoptAutosavedResumeDraft: (draft: ResumeDraft) => void;
  resumeAssistantRequestTokenRef: MutableRefObject<number>;
  setActionState: Dispatch<SetStateAction<ActionState>>;
  setLiveDiscoveryEvents: Dispatch<SetStateAction<DiscoveryActivityEvent[]>>;
  setOptimisticProfileCopilotMessages: Dispatch<
    SetStateAction<readonly ProfileCopilotMessage[]>
  >;
  setPendingActionState: Dispatch<SetStateAction<PendingActionState>>;
  setProfileCopilotBusy: Dispatch<SetStateAction<boolean>>;
  setProfileCopilotPendingContextKey: Dispatch<SetStateAction<string | null>>;
  setResumeAssistantMessages: Dispatch<
    SetStateAction<readonly ResumeAssistantMessage[]>
  >;
  setResumeAssistantPending: Dispatch<SetStateAction<boolean>>;
  setResumeWorkspace: Dispatch<SetStateAction<JobFinderResumeWorkspace | null>>;
  clearResumeWorkspaceState: () => void;
  setResumeWorkspaceDirty: Dispatch<SetStateAction<boolean>>;
  setSelectedReviewJobId: (jobId: string) => void;
  setDiscoveryRunFeedback: Dispatch<
    SetStateAction<DiscoveryRunFeedback | null>
  >;
  sourceDebugRunIdRef: MutableRefObject<number>;
  latestWorkspaceRef: MutableRefObject<JobFinderRendererWorkspaceSnapshot | null>;
  workspace: JobFinderRendererWorkspaceSnapshot;
  saveCoordinator: JobFinderSaveCoordinator;
};

const handledRefreshErrorTag = Symbol("handledRefreshError");

export const DISCOVERY_PROGRESS_REFRESH_INTERVAL_MS = 250;

/**
 * Single-flight guard for discovery runs. This lives at module scope on
 * purpose: `createPrimaryPageActions` re-runs on every
 * `buildJobFinderPageContext` rebuild (live events, workspace, action state),
 * so a closure-local flag would reset and let a second rapid call launch a
 * duplicate run. The synchronous check-and-set below is atomic because the
 * renderer is single-threaded, and the flag survives every rebuild.
 */
let isDiscoveryRunActive = false;

// Context rebuilds must not turn one pending bulk click into several IPC writes.
let isBulkShortlistActive = false;

/**
 * Route ownership for the single page-level action status (`ActionState`).
 * The page controller publishes the currently rendered route here on every
 * render and records each in-app navigation target; every status write
 * resolves its owning route from `resolveStatusOwner`. The controller then
 * derives the visible message so a status produced by one route's operation
 * can never display on an unrelated sibling route, while an action that
 * navigates as part of its own completion keeps its message on the
 * destination. Module scope is required for the same reason as the
 * single-flight guards above: `createActionRunners` and
 * `createPrimaryPageActions` re-run on every context rebuild.
 */
let jobFinderStatusRoute: string | null = null;
let jobFinderNavigationHint: string | null = null;

export function setJobFinderStatusRoute(pathname: string | null): void {
  jobFinderStatusRoute = pathname;
}

/**
 * Records a navigation the controller is about to perform. The hint is
 * resolved by the next status write so an action that navigates during its
 * own completion carries its status to the destination route. The controller
 * clears the hint once the navigation commits or is blocked, so a stale hint
 * can never outlive its own route change.
 */
export function noteJobFinderNavigation(pathname: string): void {
  jobFinderNavigationHint = pathname;
}

/**
 * Set while a just-finished guided setup is handing the user off to Find
 * jobs. The setup route consults it so its completed-state redirect targets
 * Find jobs instead of Profile for that one transition.
 */
let profileSetupJustFinished = false;

export function markProfileSetupJustFinished(): void {
  profileSetupJustFinished = true;
}

export function clearProfileSetupJustFinished(): void {
  profileSetupJustFinished = false;
}

export function isProfileSetupJustFinished(): boolean {
  return profileSetupJustFinished;
}

let firstSearchRequestedForPlan: string | null = null;

/** Asks Find jobs to start the first search when it next mounts. */
export function requestFirstSearchOnFindJobs(campaignId: string): void {
  firstSearchRequestedForPlan = campaignId;
}

/** True once per request; Find jobs calls it on mount. */
export function consumeFirstSearchRequest(campaignId?: string | null): boolean {
  const requested = firstSearchRequestedForPlan;
  firstSearchRequestedForPlan = null;
  return requested !== null && requested === campaignId;
}

/**
 * Finishing guided setup starts the first search itself, but only when no
 * search has ever run and at least one source can be searched.
 */
export function shouldStartFirstSearchAfterSetup(
  workspace: Pick<
    JobFinderRendererWorkspaceSnapshot,
    "activeDiscoveryRun" | "recentDiscoveryRuns" | "searchPreferences"
  >,
): boolean {
  // Read defensively: a partial snapshot must never stop the hand-off.
  return (
    !workspace.activeDiscoveryRun &&
    (workspace.recentDiscoveryRuns?.length ?? 0) === 0 &&
    (workspace.searchPreferences?.discovery?.targets ?? []).some(
      isRunnableJobDiscoveryTarget,
    )
  );
}

export function clearJobFinderNavigationHint(): void {
  jobFinderNavigationHint = null;
}

/**
 * A status write that carries its owning route. The controller's scoped
 * setter strips this property before storing the visible `ActionState`, so
 * screens never observe it.
 */
export type ActionStateStatusWrite = ActionState & { ownerPath?: string };

export function stripActionStateOwner(
  carried: ActionStateStatusWrite,
): ActionState {
  const actionState = { ...carried };
  delete actionState.ownerPath;
  return actionState;
}

/**
 * The route that owns a status written right now: an explicit destination
 * wins, then a navigation performed in this same action turn, then the route
 * where the action started (captured by the caller). The start route keeps
 * late completions from landing on an unrelated route the user navigated to
 * while the action was still running.
 */
function resolveStatusOwner(
  explicitOwnerPath: string | null,
  startRoute: string | null,
): string | null {
  return explicitOwnerPath ?? jobFinderNavigationHint ?? startRoute;
}

function writeActionStateWithOwner(
  setActionState: Dispatch<SetStateAction<ActionState>>,
  next: ActionState,
  ownerPath: string | null,
): void {
  if (ownerPath !== null && next.message !== null) {
    const carried: ActionStateStatusWrite = {
      ...next,
      ownerPath,
    };
    setActionState(carried);
    return;
  }
  setActionState(next);
}

export type DiscoveryWorkspaceRefreshCoordinator = {
  notifySourceCompleted: () => void;
  notifyJobsPersisted: () => void;
  /** First progress of a run: one bounded refresh so the run, the browser chip and Search history appear while it works. */
  notifyRunStarted: () => void;
  flushFinal: () => Promise<unknown>;
  dispose: () => void;
};

/**
 * Coalesces source-completion refreshes while keeping at most one snapshot
 * request in flight. The final flush always performs a fresh authoritative
 * read after any progressive request settles, so a slow earlier snapshot
 * cannot overwrite the completed run.
 */
export function createDiscoveryWorkspaceRefreshCoordinator(
  refreshWorkspace: () => Promise<unknown>,
  options: {
    intervalMs?: number;
    /**
     * Progress refreshes go here when given: the workspace's paced
     * background refresh, which also answers main's update notices, so the
     * two never rebuild the workspace at the same time. The final flush
     * still reads it directly.
     */
    requestProgressiveRefresh?: () => void;
  } = {},
): DiscoveryWorkspaceRefreshCoordinator {
  const intervalMs =
    options.intervalMs ?? DISCOVERY_PROGRESS_REFRESH_INTERVAL_MS;
  let disposed = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  const schedule = () => {
    if (disposed || !pending || timer !== null || inFlight !== null) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      if (disposed || !pending) {
        return;
      }

      pending = false;
      const requestProgressiveRefresh = options.requestProgressiveRefresh;
      inFlight = Promise.resolve()
        .then(() =>
          requestProgressiveRefresh
            ? requestProgressiveRefresh()
            : refreshWorkspace(),
        )
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, intervalMs);
  };

  return {
    notifySourceCompleted: () => {
      pending = true;
      schedule();
    },
    notifyJobsPersisted: () => {
      pending = true;
      schedule();
    },
    notifyRunStarted: () => {
      pending = true;
      schedule();
    },
    flushFinal: async () => {
      pending = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      if (inFlight !== null) {
        await inFlight;
      }

      if (!disposed) {
        return refreshWorkspace();
      }

      return undefined;
    },
    dispose: () => {
      disposed = true;
      pending = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

type HandledRefreshError = Error & {
  [handledRefreshErrorTag]: true;
};

function resolvePendingScope(
  options: ActionOptions | undefined,
): PendingActionScope | null {
  return options?.scope ?? null;
}

function isHandledRefreshError(error: unknown): error is HandledRefreshError {
  return Boolean(
    error &&
    typeof error === "object" &&
    handledRefreshErrorTag in (error as Record<PropertyKey, unknown>),
  );
}

function incrementPendingScope(
  current: PendingActionState,
  scope: PendingActionScope,
): PendingActionState {
  return {
    ...current,
    [scope]: (current[scope] ?? 0) + 1,
  };
}

function decrementPendingScope(
  current: PendingActionState,
  scope: PendingActionScope,
): PendingActionState {
  const nextCount = (current[scope] ?? 0) - 1;

  if (nextCount > 0) {
    return {
      ...current,
      [scope]: nextCount,
    };
  }

  if (!(scope in current)) {
    return current;
  }

  const nextState = { ...current };
  delete nextState[scope];
  return nextState;
}

/**
 * What an Apply press queued. Up to ten start at once; a longer choice goes
 * on in runs of ten, and a day's limit waits for tomorrow (ADR 0058).
 */
export function describeApplyQueueStart(
  snapshot:
    | Pick<JobFinderRendererWorkspaceSnapshot, "applyQueue" | "reviewQueue">
    | null
    | undefined,
  jobIds: readonly string[],
  options?: { onlyWhenHeldBack?: boolean },
): string | null {
  const queue = snapshot?.applyQueue ?? null;
  if (!queue) return null;
  const chosen = new Set(jobIds);
  const heldBack = queue.skipped.filter((entry) => chosen.has(entry.jobId));
  const heldBackSentence =
    heldBack.length === 0
      ? ""
      : heldBack.length === 1
        ? ` ${snapshot?.reviewQueue.find((item) => item.jobId === heldBack[0]!.jobId)?.title ?? "One job"} waits: ${heldBack[0]!.reason}`
        : ` ${heldBack.length} wait for you first: ${heldBack[0]!.reason}`;
  if (queue.state === "paused" && queue.pausedReason) {
    return `Nothing new started. ${queue.pausedReason}`;
  }
  if (options?.onlyWhenHeldBack) return heldBackSentence.trim() || null;
  const going = jobIds.length - heldBack.length;
  const started =
    going <= 10
      ? going === 1
        ? "Application started. Watch it in Applications."
        : `${going} applications started. Watch them in Applications.`
      : `${going} applications queued: ten at a time, with no more presses. Progress is on Home and Applications.`;
  return `${started}${heldBackSentence}`;
}

export function describePreparedApplicationSubmitResult(
  snapshot: JobFinderRendererWorkspaceSnapshot,
  jobId: string,
): string {
  const result = [...snapshot.applyJobResults]
    .filter((entry) => entry.jobId === jobId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  const outcome = result?.privacyReceipt?.submissionOutcome?.outcome ?? null;

  if (result?.state === "submitted" && outcome === "submitted") {
    return "Application sent.";
  }
  if (outcome === "outcome_uncertain") {
    return "The employer site did not confirm whether this was sent. Check the application before trying again.";
  }
  return result?.summary ?? "Application status updated.";
}

/** One line for a Send-all press: how many went out, and what did not. */
export function describePreparedApplicationsSendResult(
  snapshot: JobFinderRendererWorkspaceSnapshot,
  jobIds: readonly string[],
): string {
  if (jobIds.length === 1) {
    return describePreparedApplicationSubmitResult(snapshot, jobIds[0]!);
  }
  const sent = jobIds.filter((jobId) => {
    const result = [...snapshot.applyJobResults]
      .filter((entry) => entry.jobId === jobId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return result?.state === "submitted";
  }).length;
  const notSent = jobIds.length - sent;
  return notSent === 0
    ? `Sent all ${sent} applications.`
    : `Sent ${sent} of ${jobIds.length} applications. The others are in Applications with what stopped them.`;
}

export function preparedApplicationsToastTone(
  snapshot: JobFinderRendererWorkspaceSnapshot,
  jobIds: readonly string[],
): "success" | "warning" {
  return jobIds.every((jobId) => {
    const result = [...snapshot.applyJobResults]
      .filter((entry) => entry.jobId === jobId)
      .sort(
        (left, right) =>
          Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      )[0];
    return (
      result?.state === "submitted" &&
      result.privacyReceipt?.submissionOutcome?.outcome === "submitted"
    );
  })
    ? "success"
    : "warning";
}

export function createActionRunners(args: {
  saveCoordinator?: JobFinderSaveCoordinator;
  setActionState: Dispatch<SetStateAction<ActionState>>;
  setPendingActionState: Dispatch<SetStateAction<PendingActionState>>;
}) {
  const { saveCoordinator, setActionState, setPendingActionState } = args;

  const withPendingScope = async <TResult>(
    scope: PendingActionScope | null,
    action: () => Promise<TResult>,
    releasePendingAfterMs?: number,
    onPendingTimeout?: () => void,
  ) => {
    if (!scope) {
      return action();
    }

    setPendingActionState((current) => incrementPendingScope(current, scope));
    const pendingGeneration = getPendingActionGeneration(scope);
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      // A route/reload may retire a native-dialog operation before its IPC
      // promise settles. Do not let that stale finally decrement a newer
      // operation that reused this scope.
      if (getPendingActionGeneration(scope) === pendingGeneration) {
        setPendingActionState((current) =>
          decrementPendingScope(current, scope),
        );
      }
    };
    const releaseTimer =
      releasePendingAfterMs !== undefined
        ? setTimeout(() => {
            release();
            onPendingTimeout?.();
          }, releasePendingAfterMs)
        : null;

    try {
      return await action();
    } finally {
      if (releaseTimer !== null) {
        clearTimeout(releaseTimer);
      }
      release();
    }
  };

  const runAction = async <TResult>(
    action: () => Promise<TResult>,
    onSuccess: (result: TResult) => void | Promise<void>,
    successMessage: string | null | ((result: TResult) => string | null),
    options?: ActionOptions,
  ) => {
    const pendingScope = resolvePendingScope(options);
    const ownerStartRoute = jobFinderStatusRoute;
    const applyStatusMessage = (next: ActionState) =>
      writeActionStateWithOwner(
        setActionState,
        next,
        resolveStatusOwner(options?.statusOwnerPath ?? null, ownerStartRoute),
      );

    try {
      if (options?.clearMessageOnStart !== false) {
        applyStatusMessage({
          message: options?.startMessage ?? null,
          tone: options?.startMessage ? "progress" : null,
        });
      }

      await withPendingScope(
        pendingScope,
        async () => {
          const result = await action();
          const resolvedSuccessMessage =
            typeof successMessage === "function"
              ? successMessage(result)
              : successMessage;

          try {
            await onSuccess(result);
          } catch (error) {
            if (isHandledRefreshError(error)) {
              throw error;
            }

            const detail =
              error instanceof Error
                ? error.message
                : "The workspace view could not refresh automatically.";
            applyStatusMessage({
              message: `Action completed, but the current view could not refresh automatically. ${detail}`,
              tone: "failure",
            });
            return;
          }

          applyStatusMessage({
            message: resolvedSuccessMessage,
            tone: resolvedSuccessMessage ? "success" : null,
            ...(options?.toastTone ? { toastTone: options.toastTone() } : {}),
            ...(options?.undo && resolvedSuccessMessage
              ? {
                  undo: options.undo,
                  ...(options.undoLabel
                    ? { undoLabel: options.undoLabel }
                    : {}),
                }
              : {}),
          });
        },
        options?.releasePendingAfterMs,
        options?.pendingTimeoutMessage
          ? () =>
              applyStatusMessage({
                message: options.pendingTimeoutMessage ?? null,
                tone: "progress",
              })
          : undefined,
      );
      return true;
    } catch (error) {
      if (isHandledRefreshError(error)) {
        return false;
      }

      const message = getJobFinderErrorMessage(
        error,
        "The requested Job Finder action failed.",
      );
      applyStatusMessage({ message, tone: "failure" });
      if (options?.rethrowError) {
        throw error instanceof Error ? error : new Error(message);
      }
      return false;
    }
  };

  const runSaveAction = async <TResult>(input: {
    action: () => Promise<TResult>;
    dedupeKey: string;
    failedFallback: string;
    label: string;
    onSuccess: (result: TResult) => void | Promise<void>;
    savedMessage: string;
    scope: PendingActionScope;
    surface: JobFinderSaveSurface;
    /**
     * When true, a successful save reports only through the shared save
     * toast: the route-level action message is cleared instead of receiving
     * a second, never-dismissing copy of the same confirmation. Failures
     * still land in the route message.
     */
    routeSuccessMessage?: "toast_only";
    /** Offered as Undo on the saved confirmation. */
    undo?: () => void;
  }) => {
    const suppressRouteSuccess = input.routeSuccessMessage === "toast_only";
    const ownerStartRoute = jobFinderStatusRoute;
    // Saves resolve their owner per write: a save that navigates as part of
    // its own completion (setup finish, profile handoff) carries its status to
    // the destination instead of pinning it to the route where it started.
    const applyStatusMessage = (next: ActionState) =>
      writeActionStateWithOwner(
        setActionState,
        next,
        resolveStatusOwner(null, ownerStartRoute),
      );

    if (!saveCoordinator) {
      // Without a coordinator there is no deduped save state, but the caller
      // still needs the real outcome so a resolved false stays a failure and
      // a committed save is not reported as failed.
      return runAction(input.action, input.onSuccess, input.savedMessage, {
        scope: input.scope,
        startMessage: `Saving ${input.label.toLowerCase()}…`,
        ...(input.undo ? { undo: input.undo } : {}),
      });
    }

    applyStatusMessage({ message: `Saving ${input.label.toLowerCase()}…` });
    const result = await saveCoordinator.run({
      dedupeKey: input.dedupeKey,
      execute: (fence) =>
        withPendingScope(input.scope, async () => {
          applyStatusMessage({
            message: `Saving ${input.label.toLowerCase()}…`,
          });
          const value = await input.action();
          await input.onSuccess(value);
          // Route success text is fenced by the save operation token: an
          // older save settling late must never overwrite the status a
          // newer operation already owns.
          if (!fence || fence.isCurrent()) {
            applyStatusMessage({
              message: suppressRouteSuccess ? null : input.savedMessage,
            });
          }
          return value;
        }),
      failedMessage: (error) => {
        const message = getJobFinderErrorMessage(error, input.failedFallback);
        applyStatusMessage({ message });
        return message;
      },
      label: input.label,
      savedMessage: input.savedMessage,
      surface: input.surface,
      ...(input.undo ? { undo: input.undo } : {}),
    });

    // The coordinator marks a settled operation `superseded` when a newer
    // save operation started before it finished. Such a completion — success
    // or failure — must stay silent here so it cannot clobber the newer
    // operation's route status.
    if (!result.superseded) {
      applyStatusMessage({
        message:
          result.status === "saved"
            ? suppressRouteSuccess
              ? null
              : input.savedMessage
            : getJobFinderErrorMessage(result.error, input.failedFallback),
      });
    }
    return result.status === "saved";
  };

  return {
    runAction,
    runSaveAction,
    withPendingScope,
  };
}

export function createPrimaryPageActions(
  args: BaseActionArgs & {
    runAction: <TResult>(
      action: () => Promise<TResult>,
      onSuccess: (result: TResult) => void | Promise<void>,
      successMessage: string | null | ((result: TResult) => string | null),
      options?: ActionOptions,
    ) => Promise<boolean>;
    runSaveAction: <TResult>(input: {
      action: () => Promise<TResult>;
      dedupeKey: string;
      failedFallback: string;
      label: string;
      onSuccess: (result: TResult) => void | Promise<void>;
      routeSuccessMessage?: "toast_only";
      savedMessage: string;
      scope: PendingActionScope;
      surface: JobFinderSaveSurface;
      undo?: () => void;
    }) => Promise<boolean>;
    withPendingScope: <TResult>(
      scope: PendingActionScope | null,
      action: () => Promise<TResult>,
    ) => Promise<TResult>;
  },
) {
  const {
    actions,
    canImportResume,
    confirmLeaveDirtyResumeWorkspace,
    importResumeGuardMessage,
    getLocationPathname,
    navigate,
    profileSetupState,
    profileCopilotRequestTokenRef,
    runAction,
    runSaveAction,
    withPendingScope,
    setActionState,
    setLiveDiscoveryEvents,
    setOptimisticProfileCopilotMessages,
    setProfileCopilotBusy,
    setProfileCopilotPendingContextKey,
    setResumeWorkspaceDirty,
    setSelectedReviewJobId,
    setDiscoveryRunFeedback,
    sourceDebugRunIdRef,
    latestWorkspaceRef,
    workspace,
  } = args;

  function getConfiguredSourceTarget(targetId: string) {
    return (
      workspace.searchPreferences.discovery.targets.find(
        (target) => target.id === targetId,
      ) ?? null
    );
  }

  // Route-scopes every status write that is not already owned by an action
  // runner: the write belongs to the route where its handler started, so a
  // completion that lands after an unrelated sibling-route change stays hidden
  // on its owning route instead of leaking onto the new one.
  // The newest PDF built from the job's saved draft, approved. The export
  // just ran, so its artifact is the one to freeze.
  const approveLatestResumeExport = async (jobId: string) => {
    const workspace = await actions.getResumeWorkspace(jobId);
    const exportToApprove = workspace.exports
      .filter(
        (artifact) =>
          artifact.jobId === jobId && artifact.draftId === workspace.draft.id,
      )
      .sort(
        (left, right) =>
          new Date(right.exportedAt).getTime() -
          new Date(left.exportedAt).getTime(),
      )[0];
    if (!exportToApprove) {
      throw new Error(
        "Job Finder could not create the application PDF for this resume.",
      );
    }
    return actions.approveResume(jobId, exportToApprove.id);
  };
  const applyRouteScopedMessage = (
    next: ActionState,
    ownerStartRoute: string | null = jobFinderStatusRoute,
  ) =>
    writeActionStateWithOwner(
      setActionState,
      next,
      resolveStatusOwner(null, ownerStartRoute),
    );

  // Pre-action backstop for the fixed local-day preparation safeguard. The
  // start surfaces disable their own controls when nothing remains, but any
  // caller that still reaches a start handler must see the refusal as a
  // visible actionable status instead of a dialog flowing into a no-op.
  // Every application start asks this first. The pause is the person's
  // brake (the service refuses the same starts), then the spent day.
  const getApplicationStartRefusalMessage = (): string | null => {
    if (workspace?.activityControl?.paused) {
      return APPLICATION_WORK_PAUSED_REASON;
    }
    return null;
  };

  const jobsAre = (count: number) =>
    count === 1 ? "1 job is" : `${count} jobs are`;
  const describeJobForChange = (jobId: string): string => {
    const current = latestWorkspaceRef.current ?? workspace;
    const job =
      current.reviewQueue.find((item) => item.jobId === jobId) ??
      current.discoveryJobs.find((entry) => entry.id === jobId) ??
      current.dismissedDiscoveryJobs.find((entry) => entry.id === jobId) ??
      current.applicationRecords.find((record) => record.jobId === jobId);
    return job ? `${job.title} at ${job.company}` : "a job";
  };
  /**
   * Records a move for Recent changes; the label names its first job. The
   * move itself already happened, so a record that cannot be written only
   * costs its Undo and never turns the move into a failure.
   */
  const recordMove = (
    input: Omit<RecentChangeInput, "label">,
  ): RecentChange | null => {
    let label = "a job";
    try {
      label = describeJobForChange(input.jobIds[0] ?? "");
    } catch {
      // A workspace still loading names no job; the move keeps its Undo.
    }
    try {
      return recordRecentChange({ ...input, label });
    } catch {
      return null;
    }
  };
  const undoToastFor = (change: RecentChange | null) =>
    change ? () => void undoRecentChange(change) : null;
  // One way back for every move, shared by each toast's Undo and Activity's
  // Recent changes. A job that moved on since keeps its newer state; the
  // reason says where it went instead.
  const undoRecentChange = (change: RecentChange): Promise<boolean> => {
    const current = latestWorkspaceRef.current ?? workspace;
    const undo = getRecentChangeUndo(
      change,
      {
        discoveryJobs: current.discoveryJobs,
        dismissedDiscoveryJobs: current.dismissedDiscoveryJobs,
        reviewQueue: current.reviewQueue,
        applicationJobIds: collectPreparedApplicationJobIds(
          current.applicationRecords,
        ),
      },
      listRecentChanges(),
    );
    if (!undo.possible) {
      applyRouteScopedMessage({ message: undo.reason, tone: "failure" });
      return Promise.resolve(false);
    }
    const ids = undo.jobIds;
    const settle = (
      action: () => Promise<unknown>,
      message: string,
      scope: PendingActionScope,
    ) =>
      runAction(action, () => markRecentChangeUndone(change), message, {
        scope,
      });
    switch (change.kind) {
      case "shortlisted":
        return settle(
          async () => {
            if (actions.removeJobsFromReview)
              return actions.removeJobsFromReview(ids);
            for (const id of ids) await actions.removeJobFromReview(id);
          },
          `${jobsAre(ids.length)} back in Find jobs.`,
          jobFinderPendingActions.resumeJob("bulk-remove"),
        );
      case "hidden":
        return settle(
          async () => {
            for (const id of ids)
              await actions.restoreDismissedDiscoveryJob(id);
          },
          `${jobsAre(ids.length)} back in Find jobs.`,
          jobFinderPendingActions.discoveryJob("bulk-dismiss"),
        );
      case "shown_again":
        return settle(
          async () => {
            if (actions.dismissDiscoveryJobs)
              return actions.dismissDiscoveryJobs(ids, []);
            for (const id of ids)
              await actions.dismissDiscoveryJob(id, [], "hide_job", null);
          },
          `${ids.length === 1 ? "1 job" : `${ids.length} jobs`} hidden again.`,
          jobFinderPendingActions.discoveryJob("bulk-dismiss"),
        );
      case "moved_to_find_jobs":
        return settle(
          async () => {
            if (actions.queueJobsForReview)
              return actions.queueJobsForReview(ids);
            for (const id of ids) await actions.queueJobForReview(id);
          },
          `${jobsAre(ids.length)} back in Shortlisted.`,
          jobFinderPendingActions.resumeJob("bulk-remove"),
        );
      case "approved":
        return settle(
          async () => {
            for (const id of ids)
              await actions.clearResumeApproval(
                id,
                change.restoreStatus?.[id] ?? "needs_review",
              );
          },
          ids.length === 1
            ? "The resume is back under To review."
            : `${ids.length} resumes are back under To review.`,
          jobFinderPendingActions.apply(),
        );
      case "moved_to_review":
        return settle(
          async () => {
            // Clearing the approval touched the draft, so the old PDF
            // reads as out of date; a fresh one is built and approved, as
            // the studio's Approve does.
            for (const id of ids) {
              await actions.exportResumePdf(id, "approval");
              await approveLatestResumeExport(id);
            }
          },
          ids.length === 1
            ? "Resume approved again."
            : `${ids.length} resumes approved again.`,
          jobFinderPendingActions.apply(),
        );
      case "moved_to_shortlisted":
        return settle(
          async () => {
            for (const id of ids)
              await actions.undoReturnApplicationToShortlist(id);
          },
          ids.length === 1
            ? "Back in Applications. Its form was closed; Apply again fills it in."
            : `${ids.length} applications are back in Applications.`,
          jobFinderPendingActions.apply(),
        );
      case "taken_out_of_queue":
        return Promise.resolve(false);
    }
  };

  const runDiscoveryAction = (
    targetId?: string,
    searchRequest?: JobFinderSearchRequest,
  ) => {
    if (isDiscoveryRunActive) {
      return;
    }

    const target = targetId ? getConfiguredSourceTarget(targetId) : null;
    const targetLabel = target?.label ?? null;
    const campaignIdForRun = workspace.activeCampaignId;
    const hasRunnableSource = targetId
      ? target !== null && isRunnableJobDiscoveryTarget(target)
      : workspace.searchPreferences.discovery.targets.some(
          isRunnableJobDiscoveryTarget,
        );

    if (!hasRunnableSource) {
      const feedback = createDiscoveryRunFailedFeedback({
        detail: targetId
          ? "This job source is missing, disabled, or does not have a valid public URL."
          : "Add or enable at least one valid public job-source URL before searching.",
        targetLabel,
        targetId: targetId ?? null,
      });
      setDiscoveryRunFeedback(feedback);
      return;
    }

    isDiscoveryRunActive = true;
    setLiveDiscoveryEvents([]);
    setDiscoveryRunFeedback(createDiscoveryRunStartedFeedback(targetLabel));

    let sawDiscoveryProgress = false;
    // Typed terminal outcome from the discovery IPC return. Main classifies
    // it authoritatively (service terminal state or an escaped AbortError),
    // so a user-cancelled run can never fall through to success feedback.
    let agentDiscoveryResult: JobFinderAgentDiscoveryResult | null = null;
    // `runAction` only returns a boolean success flag, so keep the final
    // refreshed workspace here for truthful zero-new / duplicate feedback.
    let refreshedDiscoverySnapshot: JobFinderRendererWorkspaceSnapshot | null =
      null;

    void runAction(
      async () => {
        const refreshCoordinator = createDiscoveryWorkspaceRefreshCoordinator(
          actions.refreshWorkspace,
          actions.requestWorkspaceRefresh
            ? { requestProgressiveRefresh: actions.requestWorkspaceRefresh }
            : {},
        );

        try {
          agentDiscoveryResult = await actions.runAgentDiscovery(
            (event) => {
              if (!sawDiscoveryProgress) {
                refreshCoordinator.notifyRunStarted();
              }
              sawDiscoveryProgress = true;
              setLiveDiscoveryEvents((current) =>
                appendDiscoveryLiveActivityEvent(current, event),
              );

              if (event.terminalState === "completed" && event.targetId) {
                refreshCoordinator.notifySourceCompleted();
              } else if (
                !event.terminalState &&
                event.stage === "persistence" &&
                (event.jobsPersisted ?? 0) + (event.jobsStaged ?? 0) > 0
              ) {
                // Mid-run checkpoint persistence committed usable jobs; refresh
                // so Results can show them while the source keeps searching.
                refreshCoordinator.notifyJobsPersisted();
              }
            },
            targetId,
            searchRequest,
          );

          // Finish with one authoritative workspace read after any bounded
          // progressive refresh has settled. A slower snapshot requested for
          // an earlier source cannot win a race against the completed run.
          const finalSnapshot = await refreshCoordinator.flushFinal();
          refreshedDiscoverySnapshot =
            finalSnapshot &&
            typeof finalSnapshot === "object" &&
            finalSnapshot !== null &&
            "recentDiscoveryRuns" in finalSnapshot
              ? (finalSnapshot as JobFinderRendererWorkspaceSnapshot)
              : null;
          return refreshedDiscoverySnapshot;
        } finally {
          refreshCoordinator.dispose();
          setLiveDiscoveryEvents([]);
        }
      },
      () => undefined,
      // Discovery terminal copy lives in discoveryRunFeedback only; never
      // mirror it on the shared route action surface.
      () => null,
      {
        rethrowError: true,
        scope: targetId
          ? jobFinderPendingActions.discoveryTarget(targetId)
          : jobFinderPendingActions.discoveryAll(),
      },
    )
      .then((completed) => {
        if (agentDiscoveryResult?.outcome === "cancelled") {
          // The run was stopped deliberately; incrementally committed jobs
          // stay visible through the final refresh above, and the feedback
          // must say stopped — never success, never failure.
          const feedback = createDiscoveryRunCancelledFeedback({
            savedJobCount: getDiscoveryCancelledSavedJobCount(
              agentDiscoveryResult.snapshot.recentDiscoveryRuns,
            ),
            targetLabel,
          });
          setDiscoveryRunFeedback(feedback);
          return;
        }

        if (!completed) {
          // Terminal path for a handled refresh error after the search
          // itself finished: never leave the started feedback in place.
          const feedback =
            createDiscoveryRunRefreshIncompleteFeedback(targetLabel);
          setDiscoveryRunFeedback(feedback);
          return;
        }

        const discoveryRuns =
          refreshedDiscoverySnapshot?.recentDiscoveryRuns ??
          agentDiscoveryResult?.snapshot.recentDiscoveryRuns ??
          [];
        const newestRun = discoveryRuns
          .filter((run) => run.campaignId === campaignIdForRun)
          .sort(
            (left, right) =>
              Date.parse(right.startedAt) - Date.parse(left.startedAt),
          )[0];
        const validJobsFound = newestRun?.summary.validJobsFound ?? 0;
        const duplicatesMerged = newestRun?.summary.duplicatesMerged ?? 0;
        const reportCounts = getDiscoveryRunReportCounts(newestRun);
        const hasReport = hasDiscoveryRunReportCounts(reportCounts);
        setDiscoveryRunFeedback(
          !hasReport &&
            shouldPresentRepeatedDiscoveryFeedback({
              duplicatesMerged,
              validJobsFound,
            })
            ? createDiscoveryRunRepeatedFeedback({
                duplicatesMerged,
                reviewedListingCount:
                  newestRun?.summary.changeDigest?.known ?? null,
                targetLabel,
              })
            : createDiscoveryRunSucceededFeedback(
                targetLabel,
                hasReport ? formatDiscoveryRunReportLabel(reportCounts) : null,
                hasReport ? reportCounts.new : null,
              ),
        );
      })
      .catch((error: unknown) => {
        // The detail channel, not user copy: `createDiscoveryRun*Feedback`
        // runs its own classifier over this string to choose the specific
        // recovery action. Passing it the copy classifier's output would
        // replace a browser/source/connection cause with a generic sentence,
        // and the callout would silently fall back to "try again".
        const detail =
          getJobFinderErrorDetail(error) ?? "The search failed on this device.";
        // The service refused a second search because the first one is still
        // live — a Stop that has not finished yet lands here. That is not a
        // failure: the run the person already has is still going.
        if (isDiscoveryAlreadyRunningDetail(detail)) {
          setDiscoveryRunFeedback(
            createDiscoveryRunAlreadyRunningFeedback(targetLabel),
          );
          void actions.refreshWorkspace().catch(() => undefined);
          return;
        }
        // Progress events prove the run started; only a rejection with no
        // observed progress may claim the search could not start.
        const feedback = sawDiscoveryProgress
          ? createDiscoveryRunInterruptedFeedback({
              detail,
              targetLabel,
              targetId: targetId ?? null,
            })
          : createDiscoveryRunFailedFeedback({
              detail,
              targetLabel,
              targetId: targetId ?? null,
            });
        setDiscoveryRunFeedback(feedback);
        // The success path ends with an authoritative refresh; a failed run
        // is recorded too (Search history, Home, source health) and must not
        // leave those screens claiming no search ever ran.
        if (sawDiscoveryProgress) {
          void actions.refreshWorkspace().catch(() => undefined);
        }
      })
      .finally(() => {
        isDiscoveryRunActive = false;
      });
  };

  const startAutoFlow = (
    runner: () => Promise<unknown>,
    successMessage: string,
    scope: PendingActionScope,
    /**
     * The job the run is for. When present the person is taken to that
     * job's application on Applications as soon as the run starts, so they
     * watch it fill in instead of waiting on Shortlisted for minutes with a
     * button that says "Filling in the form…" and nothing else moving.
     */
    destination?: { jobId: string },
  ) => {
    // Stay resolves false: take no action and keep every draft. Leave
    // resolves true after the controller discarded only the named draft
    // state, so the flow starts exactly once.
    void confirmLeaveDirtyResumeWorkspace("start this application flow").then(
      (mayLeave) => {
        if (!mayLeave) {
          return;
        }

        const action = runAction(
          runner,
          () => {
            if (destination) {
              return;
            }
            setResumeWorkspaceDirty(false);
            if (jobFinderStatusRoute !== "/job-finder/applications") {
              navigate("/job-finder/applications");
            }
          },
          successMessage,
          // Preparation can run for minutes and can hang on a job site; the
          // Applications screen and the Tasks panel show its real state, so
          // the buttons must not stay disabled for the whole call.
          {
            scope,
            releasePendingAfterMs: COMMAND_PENDING_RELEASE_MS,
            ...(destination
              ? { statusOwnerPath: "/job-finder/applications" }
              : {}),
          },
        );
        if (destination) {
          setResumeWorkspaceDirty(false);
          navigate(
            buildJobFinderContextRoute("/job-finder/applications", {
              jobId: destination.jobId,
            }),
          );
        }
        void action;
      },
    );
  };

  return {
    onAnalyzeProfileFromResume: () => {
      if (!canImportResume) {
        applyRouteScopedMessage({ message: importResumeGuardMessage });
        return;
      }

      void runAction(actions.analyzeProfileFromResume, () => undefined, null, {
        scope: jobFinderPendingActions.profileAnalyze(),
      });
    },
    onApplyProfileCopilotPatchGroup: (patchGroupId: string) =>
      void runSaveAction({
        action: () => actions.applyProfileCopilotPatchGroup(patchGroupId),
        dedupeKey: createSaveDedupeKey("profile", { patchGroupId }),
        failedFallback:
          "The assistant profile change was not saved. Retry before leaving this page.",
        label: "Profile assistant change",
        onSuccess: () => undefined,
        savedMessage: "Profile change applied.",
        scope: jobFinderPendingActions.profileMutation(),
        surface: "profile",
      }),
    onApplyProfileSetupReviewAction: (
      reviewItemId: string,
      action: "confirm" | "dismiss" | "clear_value",
      options?: ProfileSetupReviewActionOptions,
    ) =>
      void runAction(
        () =>
          actions.applyProfileSetupReviewAction(reviewItemId, action, options),
        () => undefined,
        action === "confirm"
          ? options?.selectedConflictChoiceId
            ? "Imported comparison choice confirmed."
            : "Imported suggestion confirmed."
          : action === "dismiss"
            ? "Review item dismissed for now."
            : "Current value cleared and the review item was resolved.",
        { scope: jobFinderPendingActions.profileReviewItem(reviewItemId) },
      ),
    onApproveApplyRun: (input: JobFinderApplyRunActionInput) =>
      void runAction(
        () => actions.approveApplyRun(input),
        () => undefined,
        "Application run approved. It follows the apply mode chosen for this run.",
        {
          scope: jobFinderPendingActions.applyRun(input.runId),
          releasePendingAfterMs: COMMAND_PENDING_RELEASE_MS,
          pendingTimeoutMessage:
            "This took too long to confirm. Check its status before trying again.",
        },
      ),
    onCancelApplyRun: (input: JobFinderApplyRunActionInput) =>
      runAction(
        () => actions.cancelApplyRun(input),
        () => undefined,
        "Application preparation run cancelled.",
        {
          scope: jobFinderPendingActions.applyRun(input.runId),
          releasePendingAfterMs: COMMAND_PENDING_RELEASE_MS,
          pendingTimeoutMessage:
            "This took too long to confirm. Check its status before trying again.",
        },
      ),
    onApproveApply: (jobId: string) => {
      const startRefusal = getApplicationStartRefusalMessage();
      if (startRefusal) {
        applyRouteScopedMessage({ message: startRefusal, tone: "failure" });
        return;
      }
      void confirmLeaveDirtyResumeWorkspace("approve this application").then(
        (mayLeave) => {
          if (!mayLeave) {
            return;
          }

          void runAction(
            () =>
              actions.startApplyCopilotRun({
                jobId,
                visualCheckpointsEnabled: false,
              }),
            () => {
              setResumeWorkspaceDirty(false);
              if (jobFinderStatusRoute !== "/job-finder/applications") {
                navigate("/job-finder/applications");
              }
            },
            "Applications updated. Check the latest attempt and next step there.",
            {
              scope: jobFinderPendingActions.apply(),
              startMessage: `Filling in the application in ${JOB_FINDER_BROWSER_NAME}. It follows the apply mode chosen for this run.`,
            },
          );
        },
      );
    },
    onRevokeApplyRunApproval: (input: JobFinderApplyRunActionInput) =>
      void runAction(
        () => actions.revokeApplyRunApproval(input),
        () => undefined,
        "Application run approval revoked.",
        { scope: jobFinderPendingActions.applyRun(input.runId) },
      ),
    onResolveApplyConsentRequest: (input: JobFinderApplyConsentActionInput) =>
      void runAction(
        () => actions.resolveApplyConsentRequest(input),
        () => undefined,
        input.action === "approve"
          ? "Consent approved. Check the application's latest state as the run continues."
          : "Consent declined. The run skips that job.",
        { scope: jobFinderPendingActions.applyRequest(input.requestId) },
      ),
    onStartAutoApplyQueue: async (
      jobIds: string[],
      applicationAutomationMode?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
      options?: { stayOnCurrentPage?: boolean },
    ): Promise<JobFinderAutoApplyQueueStartOutcome> => {
      // The Apply queue runs ten at a time and reports on Home and
      // Applications (ADR 0058).
      if (jobIds.length === 0) {
        const message = "No jobs selected for auto-apply queue.";
        applyRouteScopedMessage({ message });
        return { status: "refused", reason: "empty_selection", message };
      }
      if (workspace?.activityControl?.paused) {
        const message = APPLICATION_WORK_PAUSED_REASON;
        applyRouteScopedMessage({ message, tone: "failure" });
        return { status: "refused", reason: "work_paused", message };
      }

      // Stay resolves false: take no action and keep every draft. Leave
      // resolves true after the controller discarded only the named draft
      // state, so the flow starts exactly once.
      const mayLeave = await confirmLeaveDirtyResumeWorkspace(
        "start this application flow",
      );
      if (!mayLeave) {
        return {
          status: "refused",
          reason: "cancelled_stayed_in_workspace",
          message: null,
        };
      }

      // Tag backend rejections separately from every other non-confirmed
      // ending: a rejected runner means no run was created (handled failure
      // with visible feedback), while any other false from runAction is an
      // ambiguous outcome where a run may exist, so staged curation stays.
      let backendRejected = false;
      const confirmed = await runAction(
        () =>
          actions
            .startApplyQueue({
              jobIds: [...jobIds],
              ...(applicationAutomationMode
                ? { applicationAutomationMode }
                : {}),
            })
            .catch((error: unknown) => {
              backendRejected = true;
              throw error;
            }),
        () => {
          setResumeWorkspaceDirty(false);
          if (!options?.stayOnCurrentPage) {
            if (jobFinderStatusRoute !== "/job-finder/applications") {
              navigate("/job-finder/applications");
            }
          }
        },
        (snapshot) =>
          describeApplyQueueStart(snapshot, jobIds, {
            // Home shows the queue itself; a "started" line there outlived
            // it. It keeps only what needs the person.
            onlyWhenHeldBack: options?.stayOnCurrentPage === true,
          }),
        { scope: jobFinderPendingActions.apply() },
      );

      if (confirmed) {
        return { status: "confirmed" };
      }
      return backendRejected
        ? { status: "failed", message: null }
        : { status: "unknown" };
    },
    onReturnApplicationToShortlist: (record: { id: string; jobId: string }) => {
      let change: RecentChange | null = null;
      return runAction(
        () =>
          actions.returnApplicationToShortlist({
            applicationRecordId: record.id,
          }),
        () => {
          change = recordMove({
            kind: "moved_to_shortlisted",
            jobIds: [record.jobId],
          });
        },
        "Moved back to Shortlisted. Nothing was sent.",
        {
          scope: jobFinderPendingActions.apply(),
          undo: () => {
            if (change) void undoRecentChange(change);
          },
        },
      );
    },
    onTakeOutOfApplyQueue: (jobIds: readonly string[]) => {
      const ids = [...new Set(jobIds)];
      return runAction(
        () => actions.removeFromApplyQueue({ jobIds: ids }),
        (snapshot) => {
          const waiting = new Set(
            listApplyQueueWaitingJobIds(snapshot.applyQueue),
          );
          const taken = ids.filter((id) => !waiting.has(id));
          if (taken.length > 0)
            recordMove({ kind: "taken_out_of_queue", jobIds: taken });
        },
        (snapshot) => {
          const waiting = new Set(
            listApplyQueueWaitingJobIds(snapshot.applyQueue),
          );
          const left = ids.filter((id) => waiting.has(id)).length;
          const taken = ids.length - left;
          if (taken === 0)
            return "It had already started, so it stays in the run.";
          return `${taken === 1 ? "1 job" : `${taken} jobs`} taken out of the apply queue. Nothing was started for ${taken === 1 ? "it" : "them"}.`;
        },
        { scope: jobFinderPendingActions.apply() },
      );
    },
    onControlApplyQueue: (action: ApplyQueueControlAction) =>
      void runAction(
        () => actions.controlApplyQueue({ action }),
        () => undefined,
        null,
        { scope: jobFinderPendingActions.apply() },
      ),
    onStartAutoApply: (input: JobFinderApplicationStartTarget) => {
      const capacityRefusal = getApplicationStartRefusalMessage();
      if (capacityRefusal) {
        applyRouteScopedMessage({ message: capacityRefusal, tone: "failure" });
        return;
      }

      startAutoFlow(
        () => actions.startAutoApplyRun(input),
        "Application staged. Press Apply now in Applications to start it.",
        jobFinderPendingActions.apply(),
      );
    },
    onStartApplyCopilot: (input: JobFinderApplicationStartTarget) => {
      const capacityRefusal = getApplicationStartRefusalMessage();
      if (capacityRefusal) {
        applyRouteScopedMessage({ message: capacityRefusal, tone: "failure" });
        return;
      }

      // One press starts it. The mode (fill in, ask before sending, send for
      // me) is a setting the person already chose; a second dialog naming
      // the same job was one more click on every application. Screenshots
      // stay off unless Settings turns them on.
      startAutoFlow(
        () =>
          actions.startApplyCopilotRun({
            ...input,
            visualCheckpointsEnabled: false,
          }),
        "Application run finished.",
        jobFinderPendingActions.apply(),
        { jobId: input.jobId },
      );
    },
    onSubmitPreparedApplication: async (jobId: string): Promise<void> => {
      let toastTone: "success" | "warning" = "warning";
      await runAction(
        () => actions.submitPreparedApplication({ jobId }),
        () => undefined,
        (snapshot) => {
          toastTone = preparedApplicationsToastTone(snapshot, [jobId]);
          return describePreparedApplicationSubmitResult(snapshot, jobId);
        },
        {
          scope: jobFinderPendingActions.apply(),
          toastTone: () => toastTone,
          releasePendingAfterMs: COMMAND_PENDING_RELEASE_MS,
          pendingTimeoutMessage:
            "This took too long to confirm. Check its status before trying again.",
        },
      );
    },
    onSendPreparedApplications: async (
      jobIds: readonly string[],
    ): Promise<void> => {
      let toastTone: "success" | "warning" = "warning";
      await runAction(
        // One permission covers the whole press; main then sends each kept
        // page in turn. A page that is gone is recorded on that job alone
        // and the rest still go out.
        () => actions.sendPreparedApplications({ jobIds: [...jobIds] }),
        () => undefined,
        (snapshot) => {
          toastTone = preparedApplicationsToastTone(snapshot, jobIds);
          return describePreparedApplicationsSendResult(snapshot, jobIds);
        },
        {
          scope: jobFinderPendingActions.apply(),
          toastTone: () => toastTone,
        },
      );
    },
    onCheckBrowserSession: () =>
      void runAction(
        actions.checkBrowserSession,
        () => undefined,
        "Browser status refreshed.",
        { scope: jobFinderPendingActions.browserSession() },
      ),
    onDismissJob: async (
      jobId: string,
      reasons: readonly DiscoveryFeedbackReason[],
      action: "hide_job" | "hide_and_exclude_employer" = "hide_job",
      expectedNormalizedCompanyName: string | null = null,
      options?: { quiet?: boolean },
    ) => {
      // Undo shows the job again; excluding the employer is undone where it
      // was made, so that one keeps its own message.
      let change: RecentChange | null = null;
      await runAction(
        () =>
          actions.dismissDiscoveryJob(
            jobId,
            reasons,
            action,
            expectedNormalizedCompanyName,
          ),
        () => {
          if (action === "hide_job")
            change = recordMove({ kind: "hidden", jobIds: [jobId] });
        },
        options?.quiet
          ? null
          : action === "hide_and_exclude_employer"
            ? "Job hidden and the exact employer name excluded from future searches. Fit scoring is unchanged."
            : "Job hidden.",
        {
          rethrowError: true,
          scope: jobFinderPendingActions.discoveryJob(jobId),
          ...(action === "hide_job"
            ? {
                undo: () => {
                  if (change) void undoRecentChange(change);
                },
              }
            : {}),
        },
      );
    },
    onPreviewEmployerExclusion: (jobId: string) =>
      actions.previewEmployerExclusion(jobId),
    onRemoveEmployerExclusion: (input: RemoveEmployerExclusionInput) =>
      void runAction(
        () => actions.removeEmployerExclusion(input),
        () => undefined,
        "Employer allowed in future searches. The hidden job was not restored.",
        { scope: jobFinderPendingActions.discoveryJob(input.jobId) },
      ),
    onRestoreDismissedJob: (jobId: string, options?: { quiet?: boolean }) => {
      let change: RecentChange | null = null;
      void runAction(
        () => actions.restoreDismissedDiscoveryJob(jobId),
        () => {
          change = recordMove({ kind: "shown_again", jobIds: [jobId] });
        },
        options?.quiet ? null : "Job is back in Find jobs.",
        {
          scope: jobFinderPendingActions.discoveryJob(jobId),
          undo: () => {
            if (change) void undoRecentChange(change);
          },
        },
      );
    },
    onUndoRecentChange: undoRecentChange,
    onImportResume: (options?: { retryInterrupted?: boolean }) => {
      if (!canImportResume) {
        applyRouteScopedMessage({ message: importResumeGuardMessage });
        return;
      }

      void runAction(
        () =>
          options?.retryInterrupted === true
            ? actions.importResume({ retryInterrupted: true })
            : actions.importResume(),
        () => undefined,
        // Main persists a non-ready import as a normal resolution (the file
        // is saved even when text extraction or analysis did not finish), so
        // the newest resume's typed extraction status decides the copy and
        // only `ready` may claim extracted details.
        (result) => {
          if (
            result.profile.baseResume.id === workspace.profile.baseResume.id
          ) {
            return "No resume selected. Your profile was not changed.";
          }

          const fileName = result.profile.baseResume.fileName;
          switch (result.profile.baseResume.extractionStatus) {
            case "ready":
              return `${fileName} was imported. Review the extracted details before approving them.`;
            case "needs_text":
              return `${fileName} was saved, but no text could be read from it, so no details were extracted. Try another file, or add your details manually in Profile.`;
            case "failed":
              return (
                result.latestResumeImportRun?.errorMessage ??
                `${fileName} was saved, but extracting its details failed. Try importing it again, or add your details manually in Profile.`
              );
            case "not_started":
              return `${fileName} was saved, but its details have not been extracted yet. Open Profile and refresh from the saved resume.`;
          }
        },
        {
          scope: jobFinderPendingActions.profileImport(),
        },
      );
    },
    // Returns the run's settled outcome for the same reason as
    // `onPerformUserAction`: a caller that reports the hand-off result in place
    // needs the real answer, not a promise that was thrown away.
    onOpenBrowserSession: (
      input?: JobFinderOpenBrowserSessionInput,
      options?: JobFinderActionFailureReporting,
    ) =>
      runAction(
        () => actions.openBrowserSession(input),
        () => undefined,
        (result) => {
          if (input?.targetId) {
            const target = getConfiguredSourceTarget(input.targetId);
            if (result.browserSession.driver === "catalog_seed") {
              return target
                ? `Targeted sign-in for ${target.label} is unavailable because the browser agent runtime is disabled.`
                : "Targeted sign-in is unavailable because the browser agent runtime is disabled.";
            }

            return target
              ? `Opened ${JOB_FINDER_BROWSER_NAME} for ${target.label}. Sign in there, then return to continue.`
              : `${JOB_FINDER_BROWSER_NAME_SENTENCE_START} is open.`;
          }

          // The Search setup chip already reports Ready/Not open; the toast
          // only confirms the action instead of restating the status.
          return workspace.browserSession.status === "ready"
            ? `${JOB_FINDER_BROWSER_NAME_SENTENCE_START} was refreshed.`
            : `${JOB_FINDER_BROWSER_NAME_SENTENCE_START} is open.`;
        },
        {
          scope: input?.targetId
            ? jobFinderPendingActions.browserSessionTarget(input.targetId)
            : jobFinderPendingActions.browserSession(),
          // Only a caller that asked for it; see
          // `JobFinderActionFailureReporting`.
          ...(options?.rethrowError ? { rethrowError: true } : {}),
        },
      ),
    onFocusPreparedApplicationPage: (
      input: JobFinderPreparedApplicationPageInput,
      options?: JobFinderActionFailureReporting,
    ) => {
      let focused = false;
      return runAction(
        () => actions.focusPreparedApplicationPage(input),
        (snapshot) => {
          focused = snapshot.applyJobResults.some(
            (result) =>
              result.id === input.resultId &&
              result.runId === input.runId &&
              result.jobId === input.jobId &&
              result.applicationRecordId === input.applicationRecordId &&
              result.state === "awaiting_review",
          );
        },
        null,
        {
          scope: jobFinderPendingActions.apply(),
          ...(options?.rethrowError ? { rethrowError: true } : {}),
        },
      ).then((completed) => completed && focused);
    },
    onOpenProfile: () => {
      void confirmLeaveDirtyResumeWorkspace("open your profile").then(
        (mayLeave) => {
          if (!mayLeave) {
            return;
          }

          navigate("/job-finder/profile", {
            state: { forceFullProfile: true },
          });
        },
      );
    },
    ...(actions.judgeUnjudgedJobs
      ? {
          onJudgeUnjudgedJobs: async () => {
            await actions.judgeUnjudgedJobs?.();
          },
        }
      : {}),
    onAssessJobListing: async (jobId: string) => {
      await withPendingScope(jobFinderPendingActions.discoveryJob(jobId), () =>
        actions.assessJobListing(jobId),
      );
    },
    ...(actions.dismissDiscoveryJobs
      ? {
          onDismissJobs: async (jobIds: readonly string[]) => {
            const ids = [...new Set(jobIds)];
            if (ids.length === 0) return;
            let change: RecentChange | null = null;
            await runAction(
              () => actions.dismissDiscoveryJobs!(ids, []),
              () => {
                change = recordMove({ kind: "hidden", jobIds: ids });
              },
              `${ids.length} ${ids.length === 1 ? "job" : "jobs"} hidden.`,
              {
                rethrowError: true,
                scope: jobFinderPendingActions.discoveryJob("bulk-dismiss"),
                undo: () => {
                  if (change) void undoRecentChange(change);
                },
                ...(ids.length > 1 ? { undoLabel: "Undo all" } : {}),
              },
            );
          },
        }
      : {}),
    ...(actions.queueJobsForReview
      ? {
          onQueueJobs: async (
            jobIds: readonly string[],
          ): Promise<JobFinderQueuedJobOutcome> => {
            if (isBulkShortlistActive)
              return {
                status: "failure",
                message: "Shortlisting is already in progress.",
              };
            const ids = [...new Set(jobIds)];
            if (ids.length === 0)
              return {
                status: "failure",
                message: "Select a job to shortlist.",
              };
            isBulkShortlistActive = true;
            const ownerRoute = jobFinderStatusRoute;
            applyRouteScopedMessage({ message: null }, ownerRoute);
            try {
              await withPendingScope(
                jobFinderPendingActions.discoveryJob("bulk-shortlist"),
                () => actions.queueJobsForReview!(ids),
              );
              // Shortlisted keeps its own selection: the new jobs join the end
              // of the list, so selecting one there opened Shortlisted on its
              // last page the next time the person went to it. The toast
              // offers Undo instead.
              const message = `Shortlisted ${ids.length === 1 ? "1 job" : `${ids.length} jobs`}.`;
              const change = recordMove({ kind: "shortlisted", jobIds: ids });
              applyRouteScopedMessage(
                {
                  message,
                  tone: "success",
                  undo: undoToastFor(change),
                  undoLabel: ids.length > 1 ? "Undo all" : null,
                },
                ownerRoute,
              );
              return { status: "success", message };
            } catch (error) {
              const message = getJobFinderErrorMessage(
                error,
                "The requested Job Finder action failed.",
              );
              if (!isHandledRefreshError(error))
                applyRouteScopedMessage(
                  { message, tone: "failure" },
                  ownerRoute,
                );
              return { status: "failure", message };
            } finally {
              isBulkShortlistActive = false;
            }
          },
        }
      : {}),
    onQueueJob: async (
      jobId: string,
      options?: { quiet?: boolean },
    ): Promise<JobFinderQueuedJobOutcome> => {
      // Request-local shortlist outcome: the awaited result belongs to this
      // exact click, so overlapping shortlists resolving out of order can
      // never label another row and shared route messages cannot steal
      // attribution. The route-scoped write is preserved for other surfaces.
      const ownerStartRoute = jobFinderStatusRoute;
      const successMessage = "Job added to Shortlisted.";
      try {
        applyRouteScopedMessage({ message: null }, ownerStartRoute);
        await withPendingScope(
          jobFinderPendingActions.discoveryJob(jobId),
          () => actions.queueJobForReview(jobId),
        );
        // The workspace mutation may reorder or replace the discovery and
        // review collections. Retain the exact clicked id so the refreshed
        // Shortlisted surface cannot silently fall back to another row.
        setSelectedReviewJobId(jobId);
        const change = recordMove({ kind: "shortlisted", jobIds: [jobId] });
        // A triage pass says each decision on its own bar with Undo; a
        // toast for every one of a hundred shortlists would only stack up.
        if (!options?.quiet)
          applyRouteScopedMessage(
            {
              message: successMessage,
              tone: "success",
              undo: undoToastFor(change),
            },
            ownerStartRoute,
          );
        return { status: "success", message: successMessage };
      } catch (error) {
        if (isHandledRefreshError(error)) {
          // Same silent contract as runAction for handled refresh prompts:
          // their own UI reports them, so only the local outcome resolves.
          return {
            status: "failure",
            message: "The requested Job Finder action failed.",
          };
        }
        const failureMessage = getJobFinderErrorMessage(
          error,
          "The requested Job Finder action failed.",
        );
        applyRouteScopedMessage(
          { message: failureMessage, tone: "failure" },
          ownerStartRoute,
        );
        return { status: "failure", message: failureMessage };
      }
    },
    onRejectProfileCopilotPatchGroup: (patchGroupId: string) =>
      void runAction(
        () => actions.rejectProfileCopilotPatchGroup(patchGroupId),
        () => undefined,
        "Profile change proposal dismissed.",
        { scope: jobFinderPendingActions.profileMutation() },
      ),
    onRunAgentDiscovery: (searchRequest?: JobFinderSearchRequest) =>
      runDiscoveryAction(undefined, searchRequest),
    onRunDiscoveryForTarget: (targetId: string) => runDiscoveryAction(targetId),
    onCancelDiscovery: async (runId: string) => {
      try {
        const nextWorkspace = await actions.cancelAgentDiscovery({ runId });
        const currentRun = nextWorkspace.activeDiscoveryRun;
        return (
          (currentRun?.id === runId &&
            Boolean(currentRun.cancellationRequestedAt)) ||
          nextWorkspace.recentDiscoveryRuns.some(
            (run) => run.id === runId && run.state === "cancelled",
          )
        );
      } catch (error) {
        applyRouteScopedMessage({
          message: getJobFinderErrorMessage(
            error,
            "The search could not be stopped. Check its status, then try again.",
          ),
        });
        return false;
      }
    },
    onRunSourceDebug: (
      targetId: string,
      options?: { readabilityTimeoutMs?: number },
    ) => {
      const ownerStartRoute = jobFinderStatusRoute;
      sourceDebugRunIdRef.current += 1;
      const runId = sourceDebugRunIdRef.current;
      const scope = jobFinderPendingActions.sourceDebug(targetId);
      void withPendingScope(scope, async () => {
        applyRouteScopedMessage(
          {
            message:
              "Starting source debug and attaching the browser profile...",
          },
          ownerStartRoute,
        );

        try {
          const nextWorkspace = await actions.runSourceDebug(
            targetId,
            (progressEvent) => {
              if (sourceDebugRunIdRef.current !== runId) {
                return;
              }

              applyRouteScopedMessage(
                { message: progressEvent.message },
                ownerStartRoute,
              );
            },
            options,
          );

          if (sourceDebugRunIdRef.current !== runId) {
            return;
          }

          applyRouteScopedMessage(
            {
              message: buildSourceDebugOutcomeMessage(nextWorkspace, targetId),
            },
            ownerStartRoute,
          );
        } catch (error) {
          if (sourceDebugRunIdRef.current !== runId) {
            return;
          }

          // A plain sentence from the closed set; the raw "Error invoking
          // remote method" text was shown verbatim in the Profile footer.
          const message = describeFailure(error, {
            action: "check this source",
          }).userMessage;
          applyRouteScopedMessage({ message }, ownerStartRoute);
        }
      });
    },
    onResumeProfileSetup: (step?: ProfileSetupStep) =>
      void runAction(
        () =>
          actions.saveProfileSetupState({
            ...(profileSetupState ?? {
              status: "not_started",
              currentStep: "import",
              completedAt: null,
              reviewItems: [],
              lastResumedAt: null,
            }),
            status:
              profileSetupState?.status === "completed"
                ? "completed"
                : "in_progress",
            currentStep: step ?? profileSetupState?.currentStep ?? "import",
            lastResumedAt: new Date().toISOString(),
          }),
        () => {
          // The workspace update changes the mounted setup step. Navigating
          // to the same URL can remount the editor and discard fields that the
          // shared forms intentionally retain between steps.
          if (getLocationPathname() !== "/job-finder/profile/setup") {
            navigate("/job-finder/profile/setup");
          }
        },
        null,
        { scope: jobFinderPendingActions.profileSetup() },
      ),
    onSaveSetupStep: (
      profile: CandidateProfile,
      searchPreferences: JobSearchPreferences,
      nextStep: ProfileSetupStep,
      options?: {
        finishSetup?: boolean;
        message?: string;
        openProfile?: boolean;
        /**
         * Pending review items the saved draft already edited or confirmed
         * (derived by the setup screen's draft-aware queue). They are
         * persisted as resolved together with the step so an edited field
         * never keeps its own suggestion pending.
         */
        resolvedReviewItems?: readonly {
          id: string;
          status: "confirmed" | "edited";
        }[];
        resumeApplicationMode?: ResumeApplicationMode;
        stayOnCurrentStep?: boolean;
      },
    ) => {
      // Where the save started; it decides the hand-off once it settles.
      const startPathname = getLocationPathname();
      // A "Next: <step>" confirmation is stale the moment the next step
      // renders — the toast then described where the user already was. The
      // save says what it did and nothing more.
      const savedMessage =
        options?.message ??
        (options?.finishSetup
          ? "Setup finished. Next: find jobs."
          : options?.openProfile
            ? "Saved. Opening the full Profile editor."
            : "Saved.");
      let handOffToFindJobs = false;
      let startFirstSearch = false;
      let firstSearchCampaignId: string | null = null;

      return void runSaveAction({
        action: async () => {
          const snapshot = await actions.saveWorkspaceInputs(
            profile,
            searchPreferences,
          );

          // Guided setup owns the user's default resume choice as well as
          // profile/search fields. Persist the exact existing application-mode
          // value so "Use original resume unchanged" never degrades to the
          // least-invasive tailoring strength or grants any submit authority.
          return options?.resumeApplicationMode
            ? actions.updateApplicationDefaults({
                resumeApplicationMode: options.resumeApplicationMode,
              })
            : snapshot;
        },
        dedupeKey: createSaveDedupeKey(
          nextStep === "extras" ? "answers" : "profile",
          {
            profile,
            searchPreferences,
            nextStep,
            options,
          },
        ),
        failedFallback:
          "This setup step was not saved. Retry before leaving setup.",
        label: nextStep === "extras" ? "Saved answers" : "Profile setup",
        onSuccess: (snapshot) => {
          const readiness = evaluateProfileSetupReadiness(
            snapshot.profile,
            snapshot.searchPreferences,
          );
          const resolvedAt = new Date().toISOString();
          const resolvedById = new Map(
            (options?.resolvedReviewItems ?? []).map((entry) => [
              entry.id,
              entry.status,
            ]),
          );
          const reviewItems = snapshot.profileSetupState.reviewItems.map(
            (item) => {
              const resolvedStatus = resolvedById.get(item.id);
              return item.status === "pending" && resolvedStatus
                ? { ...item, status: resolvedStatus, resolvedAt }
                : item;
            },
          );
          // Only required setup items and critical items gate completion;
          // recommended imported suggestions stay optional to review.
          // The same blocker list the footer reads, so Finish is never
          // offered and then refused: it now includes the two work-eligibility
          // answers application forms ask for.
          const nextStatus =
            options?.finishSetup === true &&
            readiness.materiallyComplete &&
            getProfileSetupReadinessBlockers(readiness).length === 0 &&
            !reviewItems.some(isFinishBlockingReviewItem)
              ? "completed"
              : "in_progress";

          // The route blocker parks (and later drops) any navigation issued
          // while this save is still in flight, so the hand-off to Find jobs
          // happens once the whole save action has settled (below).
          handOffToFindJobs = nextStatus === "completed";
          if (handOffToFindJobs) {
            markProfileSetupJustFinished();
            // Read from the snapshot this save returned: the source added on
            // this same step is not in the workspace the handler closed over,
            // so the first search was never requested.
            startFirstSearch = shouldStartFirstSearchAfterSetup(snapshot);
            firstSearchCampaignId = snapshot.activeCampaignId;
          }

          return actions
            .saveProfileSetupState({
              ...snapshot.profileSetupState,
              reviewItems,
              reviewedSteps: [
                ...new Set([
                  ...(snapshot.profileSetupState.reviewedSteps ?? []),
                  snapshot.profileSetupState.currentStep,
                ]),
              ],
              status: nextStatus,
              currentStep:
                nextStatus === "completed"
                  ? "targeting"
                  : options?.stayOnCurrentStep
                    ? snapshot.profileSetupState.currentStep
                    : nextStep,
              completedAt:
                nextStatus === "completed"
                  ? (snapshot.profileSetupState.completedAt ??
                    new Date().toISOString())
                  : null,
              lastResumedAt: new Date().toISOString(),
            })
            .then((updatedSnapshot) => {
              if (updatedSnapshot.profileSetupState.status === "completed") {
                // Handed off to Find jobs once the save settles (see below).
                return;
              }

              if (options?.openProfile && options.finishSetup !== true) {
                navigate("/job-finder/profile");
                return;
              }

              if (startPathname !== "/job-finder/profile/setup") {
                navigate("/job-finder/profile/setup");
              }
            });
        },
        routeSuccessMessage: "toast_only",
        savedMessage,
        scope: jobFinderPendingActions.profileSetup(),
        surface: nextStep === "extras" ? "answers" : "profile",
      }).then((saved) => {
        // The setup route replaces itself with Profile the moment it renders
        // a completed state. Navigating after the save has fully settled
        // (nothing in flight for the route blocker to park) lets Find jobs
        // win over that redirect.
        if (saved && handOffToFindJobs) {
          // "Finish setup and find jobs" means exactly that: Find jobs starts
          // the first search itself instead of waiting for a second press of
          // Search now. Only before any search has run. Find jobs starts it
          // once it has mounted, so the hand-off navigation is never raced.
          if (startFirstSearch && firstSearchCampaignId) {
            requestFirstSearchOnFindJobs(firstSearchCampaignId);
          }
          navigate("/job-finder/discovery", { replace: true });
        }
        if (handOffToFindJobs) {
          // The completed render has already chosen its redirect target.
          setTimeout(clearProfileSetupJustFinished, 0);
        }
      });
    },
    onSaveAll: (
      profile: CandidateProfile,
      searchPreferences: JobSearchPreferences,
      savedSection?: "sources",
    ) =>
      void runSaveAction({
        action: () => actions.saveWorkspaceInputs(profile, searchPreferences),
        dedupeKey: createSaveDedupeKey("answers", {
          profile,
          searchPreferences,
        }),
        failedFallback:
          savedSection === "sources"
            ? "Job sources were not saved. Retry before leaving this page."
            : "Profile and saved answers were not saved. Retry before leaving this page.",
        label:
          savedSection === "sources"
            ? "Job sources"
            : "Profile and saved answers",
        onSuccess: () => undefined,
        savedMessage:
          savedSection === "sources"
            ? "Job sources saved."
            : "Profile and saved answers saved.",
        scope: jobFinderPendingActions.profileMutation(),
        surface: "answers",
      }),
    onSaveProfile: (profile: CandidateProfile) =>
      void runSaveAction({
        action: () => actions.saveProfile(profile),
        dedupeKey: createSaveDedupeKey("profile", profile),
        failedFallback:
          "Profile was not saved. Retry before leaving this page.",
        label: "Profile",
        onSuccess: () => undefined,
        savedMessage: "Profile saved.",
        scope: jobFinderPendingActions.profileMutation(),
        surface: "profile",
      }),
    onRevealSavedFile: (path: string) => {
      const ownerStartRoute = jobFinderStatusRoute;
      void (async () => {
        try {
          const result = await actions.revealSavedFile(path);
          if (result.outcome === "revealed") {
            return;
          }

          applyRouteScopedMessage(
            {
              message:
                result.outcome === "not_found"
                  ? `That file is no longer at ${path}. Export it again to save a new copy.`
                  : "This device cannot open a folder from Job Finder. The path above is where the file was saved.",
              savedFilePath: null,
            },
            ownerStartRoute,
          );
        } catch (error) {
          applyRouteScopedMessage(
            {
              message: getJobFinderErrorMessage(
                error,
                "The folder could not be opened. The path above is where the file was saved.",
              ),
              savedFilePath: null,
            },
            ownerStartRoute,
          );
        }
      })();
    },
    onSaveSearchPreferences: (searchPreferences: JobSearchPreferences) => {
      // Search settings belong to the current plan, and a saved change is
      // only felt on the next search, so the confirmation says both.
      const activePlanName =
        workspace.campaigns?.find(
          (campaign) => campaign.id === workspace.activeCampaignId,
        )?.name ?? null;
      void runSaveAction({
        action: () => actions.saveSearchPreferences(searchPreferences),
        dedupeKey: createSaveDedupeKey("profile", searchPreferences),
        failedFallback:
          "Job-search preferences were not saved. Retry before leaving this page.",
        label: "Job-search preferences",
        onSuccess: () => undefined,
        savedMessage: activePlanName
          ? `Search settings saved to "${activePlanName}". Your next search uses them.`
          : "Search settings saved. Your next search uses them.",
        scope: jobFinderPendingActions.profileMutation(),
        surface: "profile",
      });
    },
    onUpdateApplicationDefaults: (input: UpdateApplicationDefaultsInput) =>
      runSaveAction({
        action: () => actions.updateApplicationDefaults(input),
        dedupeKey: createSaveDedupeKey("settings", input),
        // Named after what was saved: the apply mode, the resume look, or
        // the resume level all share this save.
        ...describeApplicationDefaultsSave(input),
        onSuccess: () => undefined,
        scope: jobFinderPendingActions.settingsSave(),
        surface: "settings",
      }),
    onUpdateWorkspaceBehavior: (input: UpdateWorkspaceBehaviorInput) =>
      runSaveAction({
        action: () => actions.updateWorkspaceBehavior(input),
        dedupeKey: createSaveDedupeKey("settings", input),
        failedFallback:
          "Workspace behavior was not saved. Retry before leaving this page.",
        label: "Workspace behavior",
        onSuccess: () => undefined,
        savedMessage: "Browser & saved jobs saved.",
        scope: jobFinderPendingActions.settingsSave(),
        surface: "settings",
      }),
    onUpdateAiBehavior: (
      input: UpdateAiBehaviorInput,
      options?: { undo?: () => void },
    ) =>
      runSaveAction({
        action: () => actions.updateAiBehavior(input),
        dedupeKey: createSaveDedupeKey("settings", input),
        failedFallback:
          "AI behavior was not saved. Retry before leaving this page.",
        label: "AI behavior",
        onSuccess: () => undefined,
        savedMessage:
          "AI behavior saved. Your next search, resume, chat, and application use it.",
        scope: jobFinderPendingActions.settingsSave(),
        surface: "settings",
        ...(options?.undo ? { undo: options.undo } : {}),
      }),
    onUpdateAppearanceTheme: (appearanceTheme: AppearanceTheme) =>
      runSaveAction({
        action: () => actions.updateAppearanceTheme(appearanceTheme),
        dedupeKey: createSaveDedupeKey("settings", appearanceTheme),
        failedFallback:
          "Appearance was not saved. Retry before leaving this page.",
        label: "Appearance",
        onSuccess: () => undefined,
        savedMessage: "Appearance saved.",
        scope: jobFinderPendingActions.settingsSave(),
        surface: "settings",
      }),
    onUpdateTrackerCrm: (applicationCrm: ApplicationCrmSettings) =>
      runSaveAction({
        action: () => actions.updateTrackerCrm(applicationCrm),
        dedupeKey: createSaveDedupeKey("settings", applicationCrm),
        failedFallback: "The application tracker settings could not be saved.",
        label: "Tracker settings",
        onSuccess: () => undefined,
        savedMessage: "Tracker settings saved.",
        scope: jobFinderPendingActions.settingsSave(),
        surface: "settings",
      }),
    onSendProfileCopilotMessage: (
      content: string,
      context?: ProfileCopilotContext,
    ) =>
      (async () => {
        const ownerStartRoute = jobFinderStatusRoute;
        const requestToken = ++profileCopilotRequestTokenRef.current;
        const effectiveContext = context ?? { surface: "general" as const };
        const contextKey = getProfileCopilotContextKey(effectiveContext);
        const lastSavedMessage = [
          ...(latestWorkspaceRef.current ?? workspace).profileCopilotMessages,
        ]
          .reverse()
          .find(
            (message) =>
              getProfileCopilotContextKey(message.context) === contextKey,
          );
        const retryingSavedQuestion =
          lastSavedMessage?.role === "user" &&
          lastSavedMessage.content.trim() === content.trim();
        const createdAt = new Date().toISOString();
        const optimisticUserMessage: ProfileCopilotMessage = {
          id: `profile_copilot_user_optimistic_${contextKey}_${Date.now()}`,
          role: "user",
          content,
          context: effectiveContext,
          patchGroups: [],
          createdAt,
        };

        // Ask again answers the existing saved question. Keep its id and
        // timestamp instead of briefly appending a second optimistic copy.
        if (!retryingSavedQuestion) {
          setOptimisticProfileCopilotMessages((current) => [
            ...current,
            optimisticUserMessage,
          ]);
        }
        setProfileCopilotBusy(true);
        setProfileCopilotPendingContextKey(contextKey);
        setActionState((current) =>
          current.message === null ? current : { ...current, message: null },
        );

        try {
          await actions.sendProfileCopilotMessage(content, effectiveContext);

          if (requestToken !== profileCopilotRequestTokenRef.current) {
            return false;
          }

          setOptimisticProfileCopilotMessages([]);
          setProfileCopilotBusy(false);
          setProfileCopilotPendingContextKey(null);
          applyRouteScopedMessage(
            { message: "The Assistant replied." },
            ownerStartRoute,
          );
          return true;
        } catch (error) {
          if (requestToken !== profileCopilotRequestTokenRef.current) {
            return false;
          }

          // The question is kept (the service saved it before asking the
          // model), and the Assistant shows this sentence under it with Ask
          // again. Rejecting with it, rather than returning false, is what
          // lets the chat say why instead of a generic "could not complete".
          const message = describeFailure(error, {
            action: "get an answer from the Assistant",
          }).userMessage;
          setOptimisticProfileCopilotMessages([]);
          setProfileCopilotBusy(false);
          setProfileCopilotPendingContextKey(null);
          applyRouteScopedMessage({ message }, ownerStartRoute);
          // Picks up the saved question so it stays on screen after this
          // rail closes; the chat then offers Ask again under it.
          void actions.refreshWorkspace().catch(() => undefined);
          throw new Error(message);
        }
      })(),
    onUndoProfileRevision: (revisionId: string) =>
      void runAction(
        () => actions.undoProfileRevision(revisionId),
        () => undefined,
        "Last assistant change was undone.",
        { scope: jobFinderPendingActions.profileMutation() },
      ),
  };
}
