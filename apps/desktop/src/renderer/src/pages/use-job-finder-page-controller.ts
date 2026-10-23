import { takePrefetchedResumeWorkspace } from "@renderer/features/job-finder/lib/resume-workspace-prefetch";
import { useToast } from "@renderer/components/ui/toast";
import { isActionNews, isActionSuccessToast } from "./action-news-toast";
import { stopAssistantUiResumeBatch } from "./use-job-finder-page-controller-actions";
import { useResumeOperationStarts } from "./use-resume-operation-starts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  DiscoveryActivityEvent,
  JobFinderResumeWorkspace,
  JobFinderRendererWorkspaceSnapshot,
  ProfileCopilotMessage,
  ResumeAssistantMessage,
  ResumeDraft,
  ResumeImportProgressEvent,
} from "@nestor/contracts";
import { useJobFinderWorkspace } from "@renderer/features/job-finder/hooks/use-job-finder-workspace";
import { resolveResumeWorkspaceRouteState } from "@renderer/features/job-finder/lib/resume-workspace-route-state";
import { JOB_FINDER_ROUTE_PATHS } from "@renderer/features/job-finder/lib/job-finder-route-hrefs";
import { getDefaultProfileRoute } from "@renderer/features/job-finder/lib/job-finder-utils";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import type { DiscoveryRunFeedback } from "@renderer/features/job-finder/screens/discovery/discovery-run-feedback";
import type { TailoredDraftPreparationViewState } from "@renderer/features/job-finder/screens/review-queue/review-queue-status";
import { useBlocker, useLocation, useNavigate } from "react-router-dom";
import {
  clearPendingActionScopes,
  hasAnyPendingAction,
  hasPendingAction,
  invalidatePendingActionScope,
  jobFinderPendingActions,
  type PendingActionScope,
  type PendingActionState,
} from "./job-finder-pending-actions";
import type { JobFinderPageContext } from "./job-finder-page-context";
import type {
  JobFinderSaveState,
  JobFinderSaveSurface,
} from "./job-finder-save-state";
import {
  createJobFinderSaveCoordinator,
  getJobFinderSaveStateFromReceipt,
  initialJobFinderSaveState,
  loadJobFinderSaveReceipt,
  persistJobFinderSaveReceipt,
} from "./job-finder-save-state";
import { buildJobFinderPageContext } from "./use-job-finder-page-controller-context";
import {
  clearJobFinderNavigationHint,
  noteJobFinderNavigation,
  setJobFinderStatusRoute,
  stripActionStateOwner,
  type ActionStateStatusWrite,
} from "./use-job-finder-page-controller-actions";
import {
  getActiveResumeWorkspaceJobId,
  getJobFinderWorkspaceSelection,
  getLatestApplicationAttempt,
  useApplicationSelection,
  useRetainedSelection,
} from "./use-job-finder-page-controller-helpers";
import { applyJobFinderWindowCloseGuard } from "./job-finder-window-close-guard";
import {
  getDiscoverySelectionIndex,
  getReviewSelectionIndex,
  getTailoredAssetIndex,
} from "./job-finder-page-selection";

const EMPTY_RESUME_ASSISTANT_MESSAGES: readonly ResumeAssistantMessage[] = [];
const EMPTY_REVIEW_QUEUE: Readonly<JobFinderRendererWorkspaceSnapshot["reviewQueue"]> =
  [];

export type ApplyCopilotVisualCheckpointRequest = {
  jobId: string;
  /**
   * Identity of the exact application being prepared. The round-eight review
   * (F03, P0) found the prepare dialog titled only "Use visual checkpoints?"
   * with nothing on screen naming the job or the employer, so there was no
   * way to tell what was being agreed to. `subject` is the rendered
   * "<title> at <employer>" line and `description` is the honest statement of
   * what will happen, including the prepare-only boundary.
   */
  subject: string | null;
  description: string;
  onResolve: (
    visualCheckpointsEnabled: boolean,
  ) => string | null | void | Promise<string | null | void>;
  onCancel?: () => void;
};

function createIdleTailoredDraftPreparationState(): TailoredDraftPreparationViewState {
  return {
    attemptedCount: 0,
    completedCount: 0,
    currentIndex: null,
    eligibleRemainingCount: 0,
    failedCount: 0,
    status: "idle",
    totalCount: 0,
  };
}

export type JobFinderNavigationGuardInput = {
  profileSurfaceDirty: boolean;
  searchPlanSurfaceDirty?: boolean;
  resumeWorkspaceDirty: boolean;
  saveState: JobFinderSaveState;
};

export type JobFinderLeaveConfirmation = {
  title: string;
  description: string;
  reasons: string[];
};

/**
 * One parked decision for leaving dirty Resume Studio work through an
 * action (workspace reset, campaign switch, apply start, profile open, ...).
 * `resolve` settles the awaiting action exactly once: `false` stays and keeps
 * every draft, `true` discards the named edits and lets the action proceed.
 */
export type JobFinderResumeWorkspaceLeaveRequest = {
  confirmation: JobFinderLeaveConfirmation;
  resolve: (leaveWithoutSaving: boolean) => void;
};

// One composed confirmation for every reason a route change could lose work:
// dirty resume edits, dirty profile or setup drafts, and saves that are still
// running or failed. Returns null when nothing needs protecting so callers can
// skip confirming entirely. The reasons name the exact unsaved scope so the
// in-app dialog (never a native browser prompt) can present them.
export function composeLeaveConfirmation(
  input: JobFinderNavigationGuardInput,
): JobFinderLeaveConfirmation | null {
  const reasons: string[] = [];

  if (input.resumeWorkspaceDirty) {
    reasons.push("Unsaved resume edits");
  }

  if (input.profileSurfaceDirty) {
    reasons.push("Unsaved profile or setup changes");
  }

  if (input.searchPlanSurfaceDirty) {
    reasons.push("Unsaved search-plan changes");
  }

  if (input.saveState.state === "saving") {
    reasons.push(`${input.saveState.label} is still saving`);
  }

  if (input.saveState.state === "failed") {
    reasons.push(`The last save failed: ${input.saveState.message}`);
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    title: "Leave this page?",
    description: "Your unsaved changes will be lost.",
    reasons,
  };
}

/**
 * Identity of one failed-save toast, so acknowledging that exact failure can
 * never silently swallow a later one. `markSurfaceRevised` re-emits the same
 * failure with retry guidance attached, which keeps version/attempt/message
 * identical and therefore stays acknowledged; a retry, a different surface or
 * a fresh failure produces a different key and speaks up again.
 */
export function getJobFinderFailedSaveKey(
  state: JobFinderSaveState,
): string | null {
  return state.state === "failed"
    ? `${state.version}:${state.attempt}:${state.surface}:${state.message}`
    : null;
}

/**
 * Save surfaces whose unsaved work keeps its own reason in
 * `composeLeaveConfirmation` after a save fails: `profileSurfaceDirty` covers
 * the profile family (profile screen and setup answers) and
 * `resumeWorkspaceDirty` covers Resume Studio. Acknowledging one of those
 * failures only drops the failure reason; a form that still holds edits keeps
 * asking on its own.
 *
 * `settings` is deliberately absent. Settings sections stage their drafts
 * locally with no global dirty flag (see `noteSettingsDraftEdited`), so the
 * failed state is the only thing standing between those staged drafts and a
 * navigation that discards them.
 */
const ACKNOWLEDGEABLE_FAILED_SAVE_SURFACES: readonly JobFinderSaveSurface[] = [
  "answers",
  "profile",
  "resume",
];

/**
 * Whether a failed save may be dropped from the leave guards by dismissing its
 * toast. A settings failure may not: it is released only by the explicit
 * "Leave without saving" decision (see `resolveUnsavedChangesLeave`), which is
 * the user answering that exact question, so the failure still never traps the
 * session.
 */
export function canAcknowledgeFailedSave(state: JobFinderSaveState): boolean {
  return (
    state.state === "failed" &&
    ACKNOWLEDGEABLE_FAILED_SAVE_SURFACES.includes(state.surface)
  );
}

/**
 * Mirror the composed guard confirmation to the app-owned window-close
 * handshake. Called at every mutation point of `navigationGuardRef` so main
 * always caches whether a native close needs the branded dialog first.
 */
function syncJobFinderWindowCloseGuard(
  input: JobFinderNavigationGuardInput,
): void {
  applyJobFinderWindowCloseGuard(composeLeaveConfirmation(input));
}

// Same branded question as the router blocker, but for actions that leave the
// dirty Resume Studio surface as a side effect. It names the exact unsaved
// scope and the pending action so the shared in-app dialog (never a native
// browser prompt) can present both.
export function composeResumeWorkspaceLeaveConfirmation(
  pendingAction: string,
): JobFinderLeaveConfirmation {
  return {
    title: "Discard unsaved resume edits?",
    description: `Resume Studio has unsaved edits for this job. Leaving now discards them so you can ${pendingAction}.`,
    reasons: ["Unsaved edits in Resume Studio"],
  };
}

/** Quiet time after the last autosave before the open resume reloads. */
const RESUME_AUTOSAVE_REFRESH_DELAY_MS = 8000;

export function useJobFinderPageController() {
  const location = useLocation();
  const routerNavigate = useNavigate();
  // Publishes the rendered route so every action status write can be owned by
  // the route that triggered it (see `use-job-finder-page-controller-actions`).
  setJobFinderStatusRoute(location.pathname);
  // In-app navigations are routed through this wrapper so a status written by
  // an action that navigates as part of its own completion can stay visible on
  // the destination route.
  const navigate = useCallback(
    (path: string, options?: { replace?: boolean; state?: unknown }) => {
      noteJobFinderNavigation(path);
      void routerNavigate(path, options);
    },
    [routerNavigate],
  );
  const workspaceState = useJobFinderWorkspace();
  const { showToast } = useToast();
  const [actionState, setActionState] = useState<ActionState>({
    message: null,
  });
  // Route ownership for the page-level action status. Every write through the
  // scoped setter below stamps the message with the route that owns it; the
  // context receives a derivation that hides messages owned by any other
  // route, so a success/error/status produced by one route can never leak
  // onto a sibling route.
  const actionStateRef = useRef<ActionState>({ message: null });
  const actionMessageOwnerPathRef = useRef<string | null>(null);
  const latestLocationPathnameRef = useRef<string>(location.pathname);
  latestLocationPathnameRef.current = location.pathname;
  const applyScopedActionState = useCallback(
    (next: SetStateAction<ActionState>, ownerPathOverride?: string | null) => {
      const resolved =
        typeof next === "function" ? next(actionStateRef.current) : next;
      if (isActionNews(resolved.message)) {
        showToast({ title: resolved.message! });
        actionStateRef.current = { message: null };
        actionMessageOwnerPathRef.current = null;
        setActionState({ message: null });
        return;
      }
      const carried = resolved as ActionStateStatusWrite;
      const ownerPath =
        carried.ownerPath ??
        ownerPathOverride ??
        latestLocationPathnameRef.current;
      // A finished action on a screen that reports outcomes as toasts. Only a
      // success qualifies; failures stay inline next to what they concern.
      if (isActionSuccessToast(resolved, ownerPath)) {
        const link = resolved.actionLink ?? null;
        showToast({
          title: resolved.message!,
          tone: resolved.toastTone ?? "success",
          ...(link
            ? {
                action: {
                  label: link.label,
                  onClick: () => navigate(link.route),
                },
              }
            : {}),
        });
        actionStateRef.current = { message: null };
        actionMessageOwnerPathRef.current = null;
        setActionState({ message: null });
        return;
      }
      actionStateRef.current = resolved;

      if (resolved.message === null) {
        actionMessageOwnerPathRef.current = null;
        setActionState({ message: null });
        return;
      }

      actionMessageOwnerPathRef.current = ownerPath;
      const cleanState = stripActionStateOwner(carried);
      setActionState(cleanState);
    },
    [navigate, setActionState, showToast],
  );
  const [initialSaveReceipt] = useState(() =>
    loadJobFinderSaveReceipt(window.localStorage),
  );
  const [saveState, setSaveState] = useState(() =>
    getJobFinderSaveStateFromReceipt(initialSaveReceipt),
  );
  // Mirrors every value the route-change blocker reads. Writes go through
  // dedicated setters so a confirm-then-navigate sequence in the same tick
  // still sees the fresh flags instead of a stale render's values.
  const navigationGuardRef = useRef<JobFinderNavigationGuardInput>({
    profileSurfaceDirty: false,
    searchPlanSurfaceDirty: false,
    resumeWorkspaceDirty: false,
    saveState: getJobFinderSaveStateFromReceipt(initialSaveReceipt),
  });
  // The window-close mirror lives exactly as long as this controller: a
  // restored failed-save receipt can block closes before any editor mounts,
  // and leaving the Job Finder surface (for example to Live Assistant,
  // which is only reachable once the route blocker cleared dirty state) must
  // release native close protection again.
  useEffect(() => {
    syncJobFinderWindowCloseGuard(navigationGuardRef.current);
    return () => applyJobFinderWindowCloseGuard(null);
  }, []);
  // The exact failed toast the user acknowledged. A failed save holds no
  // in-flight work, so once it is acknowledged it must stop blocking every
  // route change and every window close for the rest of the session. What
  // still protects the work depends on the surface: for the profile family
  // and Resume Studio the dirty-draft flags keep asking (which is why their
  // toast carries a dismiss control), while a settings failure is only
  // acknowledged by the explicit "Leave without saving" decision — see
  // `canAcknowledgeFailedSave`.
  const acknowledgedFailedSaveKeyRef = useRef<string | null>(null);
  // One derivation for every consumer of the save status: an acknowledged
  // failure is presented as idle, so the toast, the route blocker and the
  // window-close mirror can never disagree about whether it is still live.
  const publishSaveState = useCallback((state: JobFinderSaveState) => {
    if (state.state !== "failed") {
      acknowledgedFailedSaveKeyRef.current = null;
    }

    const presented =
      getJobFinderFailedSaveKey(state) !== null &&
      getJobFinderFailedSaveKey(state) === acknowledgedFailedSaveKeyRef.current
        ? initialJobFinderSaveState
        : state;
    navigationGuardRef.current.saveState = presented;
    syncJobFinderWindowCloseGuard(navigationGuardRef.current);
    setSaveState(presented);
  }, []);
  const saveCoordinatorRef = useRef<ReturnType<
    typeof createJobFinderSaveCoordinator
  > | null>(null);
  if (!saveCoordinatorRef.current) {
    saveCoordinatorRef.current = createJobFinderSaveCoordinator({
      initialReceipt: initialSaveReceipt,
      onReceiptChange: (receipt) =>
        persistJobFinderSaveReceipt(window.localStorage, receipt),
      onStateChange: publishSaveState,
    });
  }
  const saveCoordinator = saveCoordinatorRef.current;
  /**
   * Records the currently presented failure as acknowledged, so it stops being
   * a leave reason. No-op when nothing failed.
   */
  const acknowledgeCurrentFailedSave = useCallback(() => {
    const current = navigationGuardRef.current.saveState;
    const failedKey = getJobFinderFailedSaveKey(current);

    if (failedKey === null) {
      return;
    }

    acknowledgedFailedSaveKeyRef.current = failedKey;
    publishSaveState(current);
  }, [publishSaveState]);
  /**
   * Dismisses whichever status is on screen. A succeeded save clears its
   * receipt through the coordinator as before; a failed save is acknowledged
   * here instead, because the coordinator keeps `failed` until a later save of
   * that exact surface succeeds and there was otherwise no way out of the
   * navigation and window-close guards short of wiping the workspace.
   *
   * A settings failure is the exception and is left blocking: its staged
   * drafts have no dirty flag of their own, so dropping the failure here would
   * silently remove their only protection. Its toast therefore offers no
   * dismiss control, and the failure is released by "Leave without saving"
   * instead.
   */
  const dismissSaveStatus = useCallback(() => {
    const current = navigationGuardRef.current.saveState;

    if (current.state === "failed") {
      if (canAcknowledgeFailedSave(current)) {
        acknowledgeCurrentFailedSave();
      }
      return;
    }

    saveCoordinator.dismissSaved();
  }, [acknowledgeCurrentFailedSave, saveCoordinator]);
  const [pendingActionState, setPendingActionState] =
    useState<PendingActionState>({});
  const clearResumeLifecyclePending = useCallback(
    (scopes: readonly PendingActionScope[]) => {
      for (const scope of scopes) {
        invalidatePendingActionScope(scope);
      }
      setPendingActionState((current) =>
        clearPendingActionScopes(current, scopes),
      );
    },
    [],
  );
  const pendingActionStateRef = useRef(pendingActionState);
  pendingActionStateRef.current = pendingActionState;
  const resumeImportProgressRef = useRef<ResumeImportProgressEvent | null>(
    null,
  );
  resumeImportProgressRef.current =
    workspaceState.status === "ready"
      ? workspaceState.resumeImportProgress
      : null;
  const cancelImportResumeIfWaiting = useCallback(
    (includeProcessing = false) => {
      const scope = jobFinderPendingActions.profileImport();
      if (
        !hasPendingAction(pendingActionStateRef.current, scope) ||
        (!includeProcessing && resumeImportProgressRef.current !== null)
      ) {
        return;
      }

      window.nestor.jobFinder.cancelImportResume(includeProcessing);
      clearResumeLifecyclePending([scope]);
    },
    [clearResumeLifecyclePending],
  );
  const [liveDiscoveryEvents, setLiveDiscoveryEvents] = useState<
    DiscoveryActivityEvent[]
  >([]);
  const [discoveryRunFeedback, setDiscoveryRunFeedback] =
    useState<DiscoveryRunFeedback | null>(null);
  const [resumeWorkspace, setResumeWorkspace] =
    useState<JobFinderResumeWorkspace | null>(null);
  const [resumeAssistantMessages, setResumeAssistantMessages] = useState<
    readonly ResumeAssistantMessage[]
  >([]);
  const [resumeAssistantPending, setResumeAssistantPending] = useState(false);
  const [
    optimisticProfileCopilotMessages,
    setOptimisticProfileCopilotMessages,
  ] = useState<readonly ProfileCopilotMessage[]>([]);
  const [profileCopilotPendingContextKey, setProfileCopilotPendingContextKey] =
    useState<string | null>(null);
  const [profileCopilotBusy, setProfileCopilotBusy] = useState(false);
  const [
    applyCopilotVisualCheckpointRequest,
    setApplyCopilotVisualCheckpointRequest,
  ] = useState<ApplyCopilotVisualCheckpointRequest | null>(null);
  const profileCopilotRequestTokenRef = useRef(0);
  const [resumeWorkspaceDirty, setResumeWorkspaceDirty] = useState(false);
  const [tailoredDraftPreparation, setTailoredDraftPreparation] =
    useState<TailoredDraftPreparationViewState>(
      createIdleTailoredDraftPreparationState,
    );
  useEffect(
    () =>
      window.nestor.assistant?.onResumeBatchStop?.((batchId) => {
        if (!stopAssistantUiResumeBatch(batchId)) return;
        setTailoredDraftPreparation((current) =>
          current.status === "running"
            ? { ...current, stopRequested: true }
            : current,
        );
      }),
    [],
  );
  const tailoredDraftPreparationRunRef = useRef(false);
  const tailoredDraftPreparationStopRequestedRef = useRef(false);
  const tailoredDraftPreparationDisposedRef = useRef(false);
  const sourceDebugRunIdRef = useRef(0);
  const latestWorkspaceRef = useRef<JobFinderRendererWorkspaceSnapshot | null>(null);
  const activeResumeWorkspaceJobId = getActiveResumeWorkspaceJobId(
    location.pathname,
  );
  const previousResumeWorkspaceJobIdRef = useRef<string | null>(
    activeResumeWorkspaceJobId,
  );

  // Native file dialogs and renderer reloads can outlive the route that
  // launched them. Retire only the local pending presentation on navigation;
  // the main-process operation remains owned by its existing IPC promise and
  // may still finish and persist its real result. Generation fencing prevents
  // a late finally from touching a newer request in the same scope.
  useEffect(() => {
    const previousJobId = previousResumeWorkspaceJobIdRef.current;
    const scopes: PendingActionScope[] = [
      jobFinderPendingActions.profileImport(),
    ];

    if (previousJobId && previousJobId !== activeResumeWorkspaceJobId) {
      scopes.push(
        jobFinderPendingActions.resumeJob(previousJobId),
        jobFinderPendingActions.resumeExport(previousJobId),
      );
    }

    cancelImportResumeIfWaiting();
    clearResumeLifecyclePending(scopes);
    previousResumeWorkspaceJobIdRef.current = activeResumeWorkspaceJobId;
  }, [
    activeResumeWorkspaceJobId,
    cancelImportResumeIfWaiting,
    clearResumeLifecyclePending,
    location.pathname,
  ]);

  // The controller is replaced on a full renderer reload. Invalidate the
  // previous generation so a parked IPC finally cannot decrement state in a
  // newly mounted controller that happens to reuse the same job scope.
  useEffect(() => {
    return () => {
      cancelImportResumeIfWaiting();
      const scopes: PendingActionScope[] = [
        jobFinderPendingActions.profileImport(),
      ];
      const currentJobId = activeResumeWorkspaceJobIdRef.current;
      if (currentJobId) {
        scopes.push(
          jobFinderPendingActions.resumeJob(currentJobId),
          jobFinderPendingActions.resumeExport(currentJobId),
        );
      }
      for (const scope of scopes) {
        invalidatePendingActionScope(scope);
      }
    };
  }, [cancelImportResumeIfWaiting]);

  // Discovery and review selections retain the locally inspected job across
  // background refreshes: snapshots only carry first-row defaults, so a
  // reorder must not steal the selection while the job still exists. Both
  // selections also persist per active campaign in bounded versioned local
  // preferences and are restored on (re)hydration when the persisted job is
  // still in its scoped collection; stale entries self-heal. The
  // application-record pointer stays snapshot-driven (see hook doc for the
  // retention rules).
  const readyWorkspaceSnapshot =
    workspaceState.status === "ready" ? workspaceState.workspace : null;
  const selectionsCollectionReady =
    readyWorkspaceSnapshot?.hydration?.phase === "complete";
  const [selectedDiscoveryJobId, setSelectedDiscoveryJobId] =
    useRetainedSelection({
      snapshotValue: readyWorkspaceSnapshot?.selectedDiscoveryJobId ?? null,
      validIds: readyWorkspaceSnapshot
        ? getDiscoverySelectionIndex(readyWorkspaceSnapshot.discoveryJobs)
            .validIds
        : undefined,
      activeCampaignId: readyWorkspaceSnapshot?.activeCampaignId ?? null,
      persistedSelection: {
        storage: window.localStorage,
        surface: "discovery",
        collectionReady: selectionsCollectionReady,
      },
    });
  const [selectedReviewJobId, setSelectedReviewJobId] = useRetainedSelection({
    snapshotValue: readyWorkspaceSnapshot?.selectedReviewJobId ?? null,
    validIds: readyWorkspaceSnapshot
      ? getReviewSelectionIndex(readyWorkspaceSnapshot.reviewQueue).validIds
      : undefined,
    activeCampaignId: readyWorkspaceSnapshot?.activeCampaignId ?? null,
    persistedSelection: {
      storage: window.localStorage,
      surface: "review",
      collectionReady: selectionsCollectionReady,
    },
  });
  const [selectedApplicationRecordId, setSelectedApplicationRecordId] =
    useApplicationSelection(
      workspaceState.status === "ready"
        ? workspaceState.workspace.selectedApplicationRecordId
        : null,
    );

  const activeRouteResumeWorkspace =
    activeResumeWorkspaceJobId &&
    resumeWorkspace?.job.id === activeResumeWorkspaceJobId
      ? resumeWorkspace
      : null;
  const activeRouteResumeAssistantMessages = activeRouteResumeWorkspace
    ? resumeAssistantMessages
    : EMPTY_RESUME_ASSISTANT_MESSAGES;
  const activeRouteResumeAssistantPending = activeRouteResumeWorkspace
    ? resumeAssistantPending
    : false;
  const activeRouteResumeWorkspaceDirty = activeRouteResumeWorkspace
    ? resumeWorkspaceDirty
    : false;
  const [profileSurfaceDirty, setProfileSurfaceDirty] = useState(false);
  const applyProfileSurfaceDirty = useCallback<
    Dispatch<SetStateAction<boolean>>
  >(
    (value) => {
      const next =
        typeof value === "function"
          ? value(navigationGuardRef.current.profileSurfaceDirty)
          : value;
      navigationGuardRef.current.profileSurfaceDirty = next;
      syncJobFinderWindowCloseGuard(navigationGuardRef.current);
      if (next) {
        // The profile family (profile screen and setup answers) started
        // holding unsaved edits. Any exact-request retry captured for these
        // surfaces before this point would resubmit the pre-edit payload,
        // so retire it and let the surface Save action submit current values.
        saveCoordinator.markSurfaceRevised("profile");
        saveCoordinator.markSurfaceRevised("answers");
      }
      setProfileSurfaceDirty(next);
    },
    [saveCoordinator],
  );
  const applySearchPlanSurfaceDirty = useCallback((dirty: boolean) => {
    navigationGuardRef.current.searchPlanSurfaceDirty = dirty;
    syncJobFinderWindowCloseGuard(navigationGuardRef.current);
  }, []);
  const applyResumeWorkspaceDirty = useCallback<
    Dispatch<SetStateAction<boolean>>
  >(
    (value) => {
      const next =
        typeof value === "function"
          ? value(navigationGuardRef.current.resumeWorkspaceDirty)
          : value;
      navigationGuardRef.current.resumeWorkspaceDirty = next;
      syncJobFinderWindowCloseGuard(navigationGuardRef.current);
      if (next) {
        // Resume Studio started holding unsaved edits; see the profile-surface
        // note above for why a stale exact-request retry must be retired.
        saveCoordinator.markSurfaceRevised("resume");
      }
      setResumeWorkspaceDirty(next);
    },
    [saveCoordinator],
  );
  // Per-edit counterparts to the dirty-transition guards above: a surface
  // that is already dirty keeps taking edits without another boolean
  // transition, so each user-authored draft edit reports here to retire any
  // exact-request retry captured before the edit. The profile family owns
  // both save surfaces behind its single dirty flag, matching the pair in
  // `applyProfileSurfaceDirty`.
  const noteProfileSurfaceDraftEdited = useCallback(() => {
    saveCoordinator.markSurfaceRevised("profile");
    saveCoordinator.markSurfaceRevised("answers");
  }, [saveCoordinator]);
  const noteResumeWorkspaceDraftEdited = useCallback(() => {
    saveCoordinator.markSurfaceRevised("resume");
  }, [saveCoordinator]);
  // Settings sections stage drafts locally with no global dirty flag, so each
  // staged edit reports here to keep the shell's exact-request retry honest
  // for the settings surface.
  const noteSettingsDraftEdited = useCallback(() => {
    saveCoordinator.markSurfaceRevised("settings");
  }, [saveCoordinator]);
  const isPendingAction = useCallback(
    (scope: PendingActionScope) => hasPendingAction(pendingActionState, scope),
    [pendingActionState],
  );
  const isAnyPendingAction = useCallback(
    (scopes: readonly PendingActionScope[]) =>
      hasAnyPendingAction(pendingActionState, scopes),
    [pendingActionState],
  );

  const isResumeJobPending = useCallback(
    (jobId: string) =>
      isPendingAction(jobFinderPendingActions.resumeJob(jobId)),
    [isPendingAction],
  );
  const resumeOperationStarts = useResumeOperationStarts(
    readyWorkspaceSnapshot?.reviewQueue ?? EMPTY_REVIEW_QUEUE,
    isResumeJobPending,
  );

  // Action-level counterpart to the router blocker below: an action that
  // leaves dirty Resume Studio work asks the same branded question through a
  // controller-owned request instead of `window.confirm`. The promise resolves
  // exactly once — Stay (`false`: take no action, keep every draft) or Leave
  // without saving (`true`: discard only the named draft state, then let the
  // awaiting action proceed). Escape, backdrop, and focus restore are owned by
  // the shared dialog's focus trap and always resolve to staying.
  const [resumeWorkspaceLeaveRequest, setResumeWorkspaceLeaveRequest] =
    useState<JobFinderResumeWorkspaceLeaveRequest | null>(null);
  // Mirrors the parked request synchronously so a resolver click and a second
  // arriving action agree even inside one tick, before React commits state.
  const settleResumeWorkspaceLeaveRequestRef = useRef<
    ((leaveWithoutSaving: boolean) => void) | null
  >(null);

  const confirmLeaveDirtyResumeWorkspace = useCallback(
    (pendingAction: string): Promise<boolean> => {
      if (!activeResumeWorkspaceJobId || !activeRouteResumeWorkspaceDirty) {
        return Promise.resolve(true);
      }

      // One decision at a time: while a prompt is pending a further action
      // stays unresolved and aborts instead of stacking a second dialog.
      if (settleResumeWorkspaceLeaveRequestRef.current) {
        return Promise.resolve(false);
      }

      return new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (leaveWithoutSaving: boolean) => {
          if (settled) {
            // Escape after Leave, or a double click on either button, must
            // not resolve twice or run the action twice.
            return;
          }

          settled = true;
          settleResumeWorkspaceLeaveRequestRef.current = null;
          setResumeWorkspaceLeaveRequest(null);

          if (leaveWithoutSaving) {
            // Discard exactly the protection this prompt named, before the
            // awaiting action runs, so any navigation it performs sees fresh
            // guard flags (same contract as the blocker dialog's leave).
            applyResumeWorkspaceDirty(false);
          }

          resolve(leaveWithoutSaving);
        };

        settleResumeWorkspaceLeaveRequestRef.current = settle;
        setResumeWorkspaceLeaveRequest({
          confirmation: composeResumeWorkspaceLeaveConfirmation(pendingAction),
          resolve: settle,
        });
      });
    },
    [
      activeResumeWorkspaceJobId,
      activeRouteResumeWorkspaceDirty,
      applyResumeWorkspaceDirty,
    ],
  );

  const resolveResumeWorkspaceLeaveRequest = useCallback(
    (leaveWithoutSaving: boolean) => {
      settleResumeWorkspaceLeaveRequestRef.current?.(leaveWithoutSaving);
    },
    [],
  );

  // One React Router blocker guards every in-app route change (push, link
  // click, and back/forward) with the single composed confirmation above.
  // Instead of a native browser confirm, a protected navigation is parked in
  // the blocker's `blocked` state and the branded dialog below resolves it.
  // Hash-only changes and Profile tab/focus changes keep the same form
  // mounted, so they do not discard its draft.
  const routeChangeBlocker = useBlocker(({ currentLocation, nextLocation }) => {
    const keepsMountedSurface =
      currentLocation.pathname === nextLocation.pathname &&
      (currentLocation.pathname !== JOB_FINDER_ROUTE_PATHS.profile ||
        (workspaceState.status === "ready" &&
          getDefaultProfileRoute(workspaceState.workspace.profileSetupState, {
            forceFullProfile: Boolean(
              (nextLocation.state as { forceFullProfile?: boolean } | null)
                ?.forceFullProfile,
            ),
          }) === JOB_FINDER_ROUTE_PATHS.profile));
    if (keepsMountedSurface && currentLocation.search === nextLocation.search) {
      return false;
    }

    if (
      keepsMountedSurface &&
      currentLocation.pathname === JOB_FINDER_ROUTE_PATHS.profile
    ) {
      const currentParams = new URLSearchParams(currentLocation.search);
      const nextParams = new URLSearchParams(nextLocation.search);
      for (const params of [currentParams, nextParams]) {
        params.delete("section");
        params.delete("focus");
        params.sort();
      }
      if (currentParams.toString() === nextParams.toString()) return false;
    }

    return composeLeaveConfirmation(navigationGuardRef.current) !== null;
  });
  const [unsavedChangesConfirmation, setUnsavedChangesConfirmation] =
    useState<JobFinderLeaveConfirmation | null>(null);

  useEffect(() => {
    if (routeChangeBlocker.state !== "blocked") {
      setUnsavedChangesConfirmation(null);
      return;
    }

    // Protection can lapse between blocking and rendering because a racing
    // save may have completed; continue instead of asking a pointless
    // question about work that no longer exists.
    const confirmation = composeLeaveConfirmation(navigationGuardRef.current);

    if (!confirmation) {
      // Let the parked navigation through: `reset()` would silently cancel
      // it, which dropped hand-offs issued right as a save settled.
      routeChangeBlocker.proceed();
      return;
    }

    setUnsavedChangesConfirmation(confirmation);
  }, [routeChangeBlocker]);

  const resolveUnsavedChangesStay = useCallback(() => {
    if (routeChangeBlocker.state !== "blocked") {
      return;
    }

    // The navigation never commits, so the pending route hint must not be
    // applied by the next status write.
    clearJobFinderNavigationHint();
    routeChangeBlocker.reset();
  }, [routeChangeBlocker]);

  const resolveUnsavedChangesLeave = useCallback(() => {
    if (routeChangeBlocker.state !== "blocked") {
      return;
    }

    // Leaving is an explicit discard: drop draft protection before committing
    // so the destination — and every later back/forward move — reflects
    // reality instead of re-prompting for drafts that no longer exist. The
    // appliers update the guard ref synchronously, so `proceed` commits with
    // fresh flags.
    applyProfileSurfaceDirty(false);
    applySearchPlanSurfaceDirty(false);
    applyResumeWorkspaceDirty(false);
    // The dialog just named the failed save as one of its reasons and the user
    // answered it, so that failure is discarded with the rest. This is the
    // only release for a settings failure, whose staged drafts are unmounted
    // by this very navigation; without it the failure would keep blocking
    // every later route change and window close with nothing left to protect.
    acknowledgeCurrentFailedSave();
    routeChangeBlocker.proceed();
  }, [
    acknowledgeCurrentFailedSave,
    applyProfileSurfaceDirty,
    applySearchPlanSurfaceDirty,
    applyResumeWorkspaceDirty,
    routeChangeBlocker,
  ]);

  // Once a navigation commits, its route hint has either been consumed by the
  // action's own status write or belongs to no write at all; drop it so a
  // late write can claim the route where its action actually started.
  useEffect(() => {
    clearJobFinderNavigationHint();
  }, [location.pathname]);

  const readyWorkspaceState =
    workspaceState.status === "ready" ? workspaceState : null;
  const actions = readyWorkspaceState?.actions ?? null;
  const lastKnownPlatformRef = useRef<"darwin" | "win32" | "linux" | undefined>(
    workspaceState.status === "ready" ? workspaceState.platform : undefined,
  );
  if (readyWorkspaceState?.platform) {
    lastKnownPlatformRef.current = readyWorkspaceState.platform;
  }
  const platform =
    readyWorkspaceState?.platform ??
    lastKnownPlatformRef.current ??
    (workspaceState.status === "ready" ? workspaceState.platform : undefined);
  const workspace = readyWorkspaceState?.workspace ?? null;
  const workspaceWithOptimisticProfileCopilot =
    useMemo<JobFinderRendererWorkspaceSnapshot | null>(() => {
      if (!workspace) {
        return null;
      }

      if (optimisticProfileCopilotMessages.length === 0) {
        return workspace;
      }

      // The question is saved before the Assistant answers (so closing the
      // app mid-answer keeps it). Once the saved copy arrives, it replaces
      // the optimistic one instead of showing the question twice.
      const pendingOptimisticMessages = optimisticProfileCopilotMessages.filter(
        (optimistic) =>
          !workspace.profileCopilotMessages.some(
            (saved) =>
              saved.role === "user" &&
              saved.content === optimistic.content &&
              JSON.stringify(saved.context) ===
                JSON.stringify(optimistic.context) &&
              Date.parse(saved.createdAt) >=
                Date.parse(optimistic.createdAt) - 10_000,
          ),
      );
      if (pendingOptimisticMessages.length === 0) {
        return workspace;
      }

      return {
        ...workspace,
        profileCopilotMessages: [
          ...workspace.profileCopilotMessages,
          ...pendingOptimisticMessages,
        ],
      };
    }, [optimisticProfileCopilotMessages, workspace]);
  const profileSetupState = workspace?.profileSetupState ?? null;
  const canImportResume = !profileSurfaceDirty;
  const importResumeGuardMessage = profileSurfaceDirty
    ? "Save this step before importing or refreshing from a resume."
    : null;
  const activeResumeWorkspaceJobIdRef = useRef<string | null>(
    activeResumeWorkspaceJobId,
  );
  const getResumeWorkspaceRef = useRef<
    JobFinderShellActions["getResumeWorkspace"] | null
  >(actions?.getResumeWorkspace ?? null);
  const resumeAssistantRequestTokenRef = useRef(0);
  // Monotonic token shared by every resume-workspace fetch path (mount load
  // and refresh). A response may only commit while its token is still the
  // newest, so a slow older fetch — for example a parked mount response that
  // settles after a save-driven refresh — can never overwrite newer state.
  const resumeWorkspaceRequestTokenRef = useRef(0);
  // Single choke point for authoritative resume-workspace writes: claiming a
  // fresh token here invalidates every still-in-flight older fetch before
  // the newer state lands, regardless of which flow owns the write.
  const applyResumeWorkspaceSnapshot = useCallback(
    (next: SetStateAction<JobFinderResumeWorkspace | null>) => {
      resumeWorkspaceRequestTokenRef.current += 1;
      setResumeWorkspace(next);
    },
    [],
  );
  activeResumeWorkspaceJobIdRef.current = activeResumeWorkspaceJobId;
  getResumeWorkspaceRef.current = actions?.getResumeWorkspace ?? null;
  latestWorkspaceRef.current =
    workspaceWithOptimisticProfileCopilot ?? workspace;

  const clearResumeWorkspaceState = useCallback(() => {
    resumeAssistantRequestTokenRef.current += 1;
    applyResumeWorkspaceSnapshot(null);
    setResumeAssistantMessages([]);
    setResumeAssistantPending(false);
    applyResumeWorkspaceDirty(false);
  }, [applyResumeWorkspaceDirty]);

  const isCurrentResumeWorkspaceJob = useCallback(
    (jobId: string) => activeResumeWorkspaceJobIdRef.current === jobId,
    [],
  );

  const isCurrentResumeAssistantRequest = useCallback(
    (jobId: string, requestToken: number) =>
      activeResumeWorkspaceJobIdRef.current === jobId &&
      resumeAssistantRequestTokenRef.current === requestToken,
    [],
  );

  const refreshResumeWorkspace = useCallback(
    async (
      jobId: string,
      options?: {
        updateAssistantMessages?: boolean;
      },
    ) => {
      // Claiming a fresh token invalidates any in-flight older fetch (for
      // example a still-pending mount load) before this refresh resolves.
      const requestToken = resumeWorkspaceRequestTokenRef.current + 1;
      resumeWorkspaceRequestTokenRef.current = requestToken;
      const nextWorkspace = await actions?.getResumeWorkspace(jobId);

      if (
        !nextWorkspace ||
        !isCurrentResumeWorkspaceJob(nextWorkspace.job.id) ||
        resumeWorkspaceRequestTokenRef.current !== requestToken
      ) {
        return false;
      }

      applyResumeWorkspaceSnapshot(nextWorkspace);

      if (options?.updateAssistantMessages) {
        setResumeAssistantMessages(nextWorkspace.assistantMessages);
        setResumeAssistantPending(false);
      }

      return true;
    },
    [actions, isCurrentResumeWorkspaceJob, applyResumeWorkspaceSnapshot],
  );

  // After an autosave the studio already holds the saved text; the full
  // reload waits until no save has come for a few seconds.
  const autosaveRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const adoptAutosavedResumeDraft = useCallback(
    (draft: ResumeDraft) => {
      applyResumeWorkspaceSnapshot((current) =>
        current && current.draft.id === draft.id
          ? { ...current, draft }
          : current,
      );
      if (autosaveRefreshTimerRef.current)
        clearTimeout(autosaveRefreshTimerRef.current);
      autosaveRefreshTimerRef.current = setTimeout(() => {
        autosaveRefreshTimerRef.current = null;
        if (!isCurrentResumeWorkspaceJob(draft.jobId)) return;
        void refreshResumeWorkspace(draft.jobId).catch(() => undefined);
      }, RESUME_AUTOSAVE_REFRESH_DELAY_MS);
    },
    [
      applyResumeWorkspaceSnapshot,
      isCurrentResumeWorkspaceJob,
      refreshResumeWorkspace,
    ],
  );
  useEffect(
    () => () => {
      if (autosaveRefreshTimerRef.current)
        clearTimeout(autosaveRefreshTimerRef.current);
    },
    [],
  );

  // The assistant (or any background work) can change the open resume.
  // Follow workspace updates so the studio shows the saved draft instead of a
  // stale copy that a later Save would be refused for (ADR 0037).
  const refreshResumeWorkspaceRef = useRef(refreshResumeWorkspace);
  refreshResumeWorkspaceRef.current = refreshResumeWorkspace;
  useEffect(() => {
    const subscribe = window.nestor?.jobFinder?.onWorkspaceUpdate;
    if (typeof subscribe !== "function") return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const jobId = activeResumeWorkspaceJobIdRef.current;
        if (!jobId) return;
        void refreshResumeWorkspaceRef.current(jobId).catch(() => undefined);
      }, 300);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (
      resumeWorkspace?.job.id &&
      resumeWorkspace.job.id !== activeResumeWorkspaceJobId
    ) {
      clearResumeWorkspaceState();
    }

    if (!activeResumeWorkspaceJobId) {
      clearResumeWorkspaceState();
    }
  }, [
    activeResumeWorkspaceJobId,
    clearResumeWorkspaceState,
    resumeWorkspace?.job.id,
  ]);

  useEffect(() => {
    if (!activeResumeWorkspaceJobId || !workspace) {
      return;
    }

    const routeState = resolveResumeWorkspaceRouteState({
      hydration: workspace.hydration,
      jobId: activeResumeWorkspaceJobId,
      reviewQueue: workspace.reviewQueue,
    });

    // Bootstrap snapshots intentionally defer the review queue. While the
    // workspace is still hydrating, the missing item is not evidence that the
    // job left the shortlist, so the route must stay put (the route's own
    // hydration gate takes over). A hydrated snapshot that truly no longer
    // contains the job clears local workspace state and lets the route's
    // explicit "no longer available" screen show the reason; the operator
    // leaves only through its action, never through a silent bounce.
    if (routeState.kind === "hydrating" || routeState.kind === "available") {
      return;
    }

    clearResumeWorkspaceState();
  }, [
    activeResumeWorkspaceJobId,
    clearResumeWorkspaceState,
    workspace?.hydration,
    workspace?.reviewQueue,
  ]);

  // One authoritative resume-workspace fetch per navigation. The previously
  // separate guarded refresh effect duplicated this load on every mount, so
  // it was removed: a single fetch keeps one IPC call per route entry, and
  // the request token fences this response against newer save/action
  // refreshes so an older mount response can never overwrite them.
  useEffect(() => {
    let cancelled = false;

    const getResumeWorkspace = getResumeWorkspaceRef.current;

    if (!activeResumeWorkspaceJobId || !actions || !getResumeWorkspace) {
      return () => {
        cancelled = true;
      };
    }

    // The review pass reads the next resume ahead; showing it at once keeps
    // "Approve and next" from flashing a loading card. The read below still
    // runs and replaces it.
    const prefetched = takePrefetchedResumeWorkspace(activeResumeWorkspaceJobId);
    if (prefetched) {
      applyResumeWorkspaceSnapshot(prefetched);
      setResumeAssistantMessages(prefetched.assistantMessages);
      setResumeAssistantPending(false);
    }
    const requestToken = resumeWorkspaceRequestTokenRef.current + 1;
    resumeWorkspaceRequestTokenRef.current = requestToken;
    void getResumeWorkspace(activeResumeWorkspaceJobId)
      .then((nextWorkspace) => {
        if (
          !cancelled &&
          resumeWorkspaceRequestTokenRef.current === requestToken &&
          nextWorkspace.job.id === activeResumeWorkspaceJobIdRef.current
        ) {
          applyScopedActionState((current) =>
            current.message === null ? current : { ...current, message: null },
          );
          applyResumeWorkspaceSnapshot(nextWorkspace);
          setResumeAssistantMessages(nextWorkspace.assistantMessages);
          setResumeAssistantPending(false);
          setSelectedReviewJobId(nextWorkspace.job.id);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          // Electron wraps the main-process failure as "Error invoking
          // remote method '…': Error: Unknown Job Finder job '…'", so an
          // anchored match never fired and the raw IPC string reached the
          // screen instead of the owned "Resume no longer available" state.
          const isUnknownJob =
            error instanceof Error &&
            /Unknown Job Finder job /.test(error.message);
          if (isUnknownJob) {
            // The job no longer exists in the workspace. The route owns the
            // visible "Resume no longer available" state, so a silent bounce
            // would hide the reason; keep the URL and let the route explain.
            return;
          }

          // The technical failure belongs in the log, never on the screen:
          // an IPC channel name and an internal job id are not something a
          // user can act on.
          console.error("Resume workspace could not be loaded.", error);
          // The error is written as part of the replace navigation itself, so
          // it is owned by the review-queue destination it lands on.
          applyScopedActionState(
            {
              message:
                "We couldn’t open the resume editor for this job. Shortlisted is shown instead — open the job again to retry.",
            },
            "/job-finder/review-queue",
          );
          void navigate("/job-finder/review-queue", { replace: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeResumeWorkspaceJobId,
    actions,
    applyResumeWorkspaceSnapshot,
    applyScopedActionState,
    navigate,
    setSelectedReviewJobId,
  ]);

  // One unmount-only lifecycle effect owns the tailored-draft disposal
  // signal. Sibling route changes keep this controller mounted above the
  // outlet, so only true teardown may ask a parked sequential batch to stop
  // after its current item. Resetting on mount keeps React StrictMode's
  // simulated unmount/remount from permanently poisoning a live controller.
  useEffect(() => {
    tailoredDraftPreparationDisposedRef.current = false;

    return () => {
      tailoredDraftPreparationDisposedRef.current = true;
    };
  }, []);

  // Route-change protection is owned by the useBlocker guard above, so shell
  // navigation only needs to navigate; the blocker asks the single composed
  // question whenever unsaved work is actually at risk.
  const navigateFromShell = useCallback(
    (path: string) => {
      void navigate(path);
    },
    [navigate],
  );
  const retryLastSave = useCallback(() => {
    void saveCoordinator.retry();
  }, [saveCoordinator]);
  const cancelApplyCopilotVisualCheckpointRequest = useCallback(() => {
    const currentRequest = applyCopilotVisualCheckpointRequest;
    setApplyCopilotVisualCheckpointRequest(null);
    currentRequest?.onCancel?.();
  }, [applyCopilotVisualCheckpointRequest]);
  const resolveApplyCopilotVisualCheckpointRequest = useCallback(
    async (visualCheckpointsEnabled: boolean) => {
      const currentRequest = applyCopilotVisualCheckpointRequest;
      if (!currentRequest) {
        return null;
      }

      // The request is cleared only once the start has actually begun. A
      // refused start keeps the dialog on screen with the reason in it rather
      // than closing and leaving the page exactly as it was.
      const refusal = await currentRequest.onResolve(visualCheckpointsEnabled);
      const sentence = typeof refusal === "string" ? refusal.trim() : "";
      if (sentence) {
        return sentence;
      }

      setApplyCopilotVisualCheckpointRequest(null);
      return null;
    },
    [applyCopilotVisualCheckpointRequest],
  );

  const { selectedDiscoveryJob, selectedReviewItem, selectedReviewJob } =
    useMemo(
      () =>
        workspace
          ? getJobFinderWorkspaceSelection(
              workspace,
              selectedDiscoveryJobId,
              selectedReviewJobId,
            )
          : {
              selectedDiscoveryJob: null,
              selectedReviewItem: null,
              selectedReviewJob: null,
            },
      [
        selectedDiscoveryJobId,
        selectedReviewJobId,
        workspace?.discoveryJobs,
        workspace?.reviewQueue,
      ],
    );

  const selectedTailoredAsset = useMemo(
    () =>
      workspace && selectedReviewItem?.resumeAssetId
        ? (getTailoredAssetIndex(workspace.tailoredAssets).get(
            selectedReviewItem.resumeAssetId,
          ) ?? null)
        : null,
    [selectedReviewItem?.resumeAssetId, workspace?.tailoredAssets],
  );

  const { selectedApplicationAttempt, selectedApplicationRecord } = useMemo(
    () =>
      workspace
        ? getLatestApplicationAttempt(workspace, selectedApplicationRecordId)
        : { selectedApplicationAttempt: null, selectedApplicationRecord: null },
    [
      selectedApplicationRecordId,
      workspace?.applicationRecords,
      workspace?.applicationAttempts,
    ],
  );

  // Route-scoped view of the page action status: a message is visible only on
  // the route that owns it. The raw state is kept intact so in-flight actions
  // can complete without racing a disposal; the ownership ref is stamped by
  // every write through `applyScopedActionState`.
  const scopedActionState = useMemo<ActionState>(() => {
    const ownerPath = actionMessageOwnerPathRef.current;
    if (ownerPath !== null && ownerPath !== location.pathname) {
      return { message: null };
    }
    return actionState;
  }, [actionState, location.pathname]);

  const context = useMemo<JobFinderPageContext | null>(() => {
    if (!readyWorkspaceState || !workspace || !actions) {
      return null;
    }

    return buildJobFinderPageContext({
      actionState: scopedActionState,
      actions,
      activeRouteResumeAssistantMessages,
      activeRouteResumeAssistantPending,
      activeRouteResumeWorkspace,
      canImportResume,
      confirmLeaveDirtyResumeWorkspace,
      importResumeGuardMessage,
      resumeOperationStarts,
      isAnyPendingAction,
      isPendingAction,
      isCurrentResumeAssistantRequest,
      isCurrentResumeWorkspaceJob,
      discoveryRunFeedback,
      liveDiscoveryEvents,
      latestWorkspaceRef,
      locationPathname: location.pathname,
      navigate: (path, options) => {
        void navigate(path, options);
      },
      navigateSafely: navigateFromShell,
      profileCopilotBusy,
      resumeImportProgress: readyWorkspaceState.resumeImportProgress,
      profileCopilotPendingContextKey,
      profileCopilotRequestTokenRef,
      profileSetupState,
      saveCoordinator,
      saveState,
      requestApplyCopilotVisualCheckpoints: (request) => {
        setApplyCopilotVisualCheckpointRequest(request);
      },
      refreshResumeWorkspace,
      adoptAutosavedResumeDraft,
      resumeAssistantRequestTokenRef,
      selectedApplicationAttempt,
      selectedApplicationRecord,
      selectedDiscoveryJob,
      selectedReviewItem,
      selectedReviewJob,
      selectedTailoredAsset,
      setActionState: applyScopedActionState,
      setDiscoveryRunFeedback,
      setLiveDiscoveryEvents,
      setOptimisticProfileCopilotMessages,
      setPendingActionState,
      setProfileCopilotBusy,
      setProfileCopilotPendingContextKey,
      setProfileSurfaceDirty: applyProfileSurfaceDirty,
      setSearchPlanSurfaceDirty: applySearchPlanSurfaceDirty,
      setResumeAssistantMessages,
      setResumeAssistantPending,
      setResumeWorkspace: applyResumeWorkspaceSnapshot,
      clearResumeWorkspaceState,
      setResumeWorkspaceDirty: applyResumeWorkspaceDirty,
      onProfileSurfaceDraftEdited: noteProfileSurfaceDraftEdited,
      onCancelImportResume: () => cancelImportResumeIfWaiting(true),
      onResumeWorkspaceDraftEdited: noteResumeWorkspaceDraftEdited,
      onSettingsDraftEdited: noteSettingsDraftEdited,
      setSelectedApplicationRecordId,
      setSelectedDiscoveryJobId,
      setSelectedReviewJobId,
      setTailoredDraftPreparation,
      sourceDebugRunIdRef,
      tailoredDraftPreparation,
      tailoredDraftPreparationRunRef,
      tailoredDraftPreparationStopRequestedRef,
      tailoredDraftPreparationDisposedRef,
      workspace: workspaceWithOptimisticProfileCopilot ?? workspace,
    });
  }, [
    applySearchPlanSurfaceDirty,
    scopedActionState,
    actionState,
    actions,
    activeRouteResumeAssistantMessages,
    activeRouteResumeAssistantPending,
    activeRouteResumeWorkspace,
    applyResumeWorkspaceSnapshot,
    clearResumeWorkspaceState,
    confirmLeaveDirtyResumeWorkspace,
    discoveryRunFeedback,
    resumeOperationStarts,
    isAnyPendingAction,
    isPendingAction,
    isCurrentResumeAssistantRequest,
    isCurrentResumeWorkspaceJob,
    liveDiscoveryEvents,
    location.pathname,
    navigate,
    navigateFromShell,
    canImportResume,
    cancelImportResumeIfWaiting,
    profileCopilotBusy,
    readyWorkspaceState,
    profileSetupState,
    profileCopilotPendingContextKey,
    saveCoordinator,
    saveState,
    importResumeGuardMessage,
    refreshResumeWorkspace,
    adoptAutosavedResumeDraft,
    selectedApplicationAttempt,
    selectedApplicationRecord,
    selectedDiscoveryJob,
    selectedReviewItem,
    selectedReviewJob,
    selectedTailoredAsset,
    tailoredDraftPreparation,
    noteProfileSurfaceDraftEdited,
    noteResumeWorkspaceDraftEdited,
    noteSettingsDraftEdited,
    workspace,
    workspaceWithOptimisticProfileCopilot,
  ]);

  if (!readyWorkspaceState || !workspace || !actions) {
    return {
      appearanceTheme: null,
      applyCopilotVisualCheckpointRequest: null,
      cancelApplyCopilotVisualCheckpointRequest,
      context: null,
      dismissSavedStatus: dismissSaveStatus,
      navigateFromShell,
      platform,
      resolveResumeWorkspaceLeaveRequest,
      resolveUnsavedChangesLeave,
      resolveUnsavedChangesStay,
      retryLastSave,
      resumeWorkspaceLeaveConfirmation:
        resumeWorkspaceLeaveRequest?.confirmation ?? null,
      saveState,
      resolveApplyCopilotVisualCheckpointRequest,
      unsavedChangesConfirmation,
      workspace,
      workspaceState,
    };
  }

  return {
    appearanceTheme: workspace.settings.appearanceTheme,
    applyCopilotVisualCheckpointRequest,
    cancelApplyCopilotVisualCheckpointRequest,
    context: context!,
    dismissSavedStatus: dismissSaveStatus,
    navigateFromShell,
    platform,
    resolveResumeWorkspaceLeaveRequest,
    resolveUnsavedChangesLeave,
    resolveUnsavedChangesStay,
    retryLastSave,
    resumeWorkspaceLeaveConfirmation:
      resumeWorkspaceLeaveRequest?.confirmation ?? null,
    saveState,
    resolveApplyCopilotVisualCheckpointRequest,
    unsavedChangesConfirmation,
    workspace,
    workspaceState,
  };
}
