import { clearJobDetailCache } from "./use-job-detail";
import { clearTailoredAssetDetailCache } from "./use-tailored-asset-detail";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApplicationCrmBulkStageMutationInput,
  ApplicationCrmExportInput,
  ApplicationCrmMutationInput,
  ApplicationCrmSettings,
  AppearanceTheme,
  ApplyGroupedManualAnswerInput,
  CandidateProfile,
  ClearApplicationAnswerCommandInput,
  CompanyIntelligenceMutationInput,
  DiscoveryActivityEvent,
  DiscoveryFeedbackReason,
  EditableSourceInstructionArtifact,
  JobFinderApplyConsentActionInput,
  JobFinderApplyCopilotActionInput,
  JobFinderApplyQueueActionInput,
  JobFinderApplyRunActionInput,
  JobFinderApplyQueueControlInput,
  JobFinderApproveResumesInput,
  JobFinderStartApplyQueueInput,
  JobFinderApplyRunDetailsQuery,
  JobFinderApplicationStartTarget,
  JobFinderPreparedApplicationPageInput,
  JobFinderOpenBrowserSessionInput,
  JobFinderSetResumeClaimConfirmationInput,
  JobFinderSetWorkHistoryReviewAcknowledgmentInput,
  JobFinderSettings,
  JobFinderSearchRequest,
  JobFinderAgentDiscoveryReply,
  JobFinderAgentDiscoveryResult,
  JobFinderRendererWorkspaceSnapshot,
  JobFinderWorkspaceDelta,
  JobFinderWorkspaceEntityMutation,
  JobFinderWorkspaceSyncResult,
  JobSearchPreferences,
  RapidReviewMutationInput,
  RecommendResumeStrategyInput,
  RecordOutcomeInput,
  ResolveSubmissionOutcomeInput,
  SafeguardMutationInput,
  ReviewCompanyMergeInput,
  SaveResumeStrategyInput,
  SaveCampaignRuleInput,
  SaveJobSearchCampaignInput,
  SelectResumeStrategyInput,
  SetCampaignResumeStrategyDefaultInput,
  SetCompanyPreferenceInput,
  SetJobFinderActivityControlInput,
  SetOutcomeSuggestionEnabledInput,
  WorkspaceRevision,
  ProfileCopilotContext,
  ProfileSetupReviewAction,
  ProfileSetupReviewActionOptions,
  ProfileSetupState,
  ProjectGroupedManualAnswerCommand,
  ResumeImportProgressEvent,
  ResumeApplicationMode,
  TailoringMode,
  ResumePdfExportIntent,
  ResumeTimelineRepairAction,
  ResumeDraft,
  ResumeDraftPatch,
  SaveApplicationAnswerCommandInput,
  SnoozeGroupedDecisionInput,
  SourceDebugProgressEvent,
  UpdateApplicationDefaultsInput,
  UpdateWorkspaceBehaviorInput,
  UpdateAiBehaviorInput,
  UserActionCommandInput,
} from "@nestor/contracts";
import type { JobFinderShellActions } from "../lib/job-finder-types";
import { applyJobFinderWorkspaceDelta } from "../../../pages/job-finder-workspace-delta";
import {
  isJobFinderStartupDatabaseRecoveryFact,
  type JobFinderStartupDatabaseRecoveryBlockedFact,
  type JobFinderStartupDatabaseRecoveryFact,
} from "../../../../../shared/job-finder-startup-db-recovery";

/** How long update-driven syncs rest, as a multiple of the last sync. */
const UPDATE_SYNC_REST_FACTOR = 2;
/**
 * At least this long between update-driven syncs. A search publishes several
 * updates a second and each sync costs main tens of milliseconds; more than
 * two refreshes a second shows nothing new and slows every click.
 */
const MIN_UPDATE_SYNC_REST_MS = 400;
/** A stalled sync never leaves the workspace stale for longer than this. */
const MAX_UPDATE_SYNC_REST_MS = 8_000;
const MAX_WORKSPACE_BASELINES = 4;

type JobFinderWorkspaceState =
  | { status: "loading" }
  | {
      status: "ready";
      actions: JobFinderShellActions;
      platform: "darwin" | "win32" | "linux";
      resumeImportProgress: ResumeImportProgressEvent | null;
      workspace: JobFinderRendererWorkspaceSnapshot;
    }
  | {
      status: "error";
      message: string;
      retry: () => void;
      startupDatabaseRecovery: JobFinderStartupDatabaseRecoveryBlockedFact | null;
    };

function markJobFinderTiming(markName: string, startMarkName?: string) {
  const performanceApi = globalThis.performance;
  if (!performanceApi?.mark) {
    return;
  }

  performanceApi.mark(markName);
  if (startMarkName && performanceApi.measure) {
    try {
      performanceApi.measure(markName, startMarkName, markName);
    } catch {
      // Performance diagnostics must never affect workspace loading.
    }
  }
}

type StartupDatabaseRecoveryFactRequest =
  Promise<JobFinderStartupDatabaseRecoveryFact | null>;

function requestStartupDatabaseRecoveryFact(): StartupDatabaseRecoveryFactRequest {
  try {
    const recoveryBridge = window.nestor?.jobFinder?.getStartupDatabaseRecovery;
    if (typeof recoveryBridge === "function") {
      return recoveryBridge().catch(() => null);
    }
  } catch {
    // Older preload builds without the typed bridge fall through.
  }

  return Promise.resolve(null);
}

function selectBlockedStartupDatabaseRecovery(
  recoveryFact: JobFinderStartupDatabaseRecoveryFact | null,
): JobFinderStartupDatabaseRecoveryBlockedFact | null {
  return recoveryFact !== null &&
    isJobFinderStartupDatabaseRecoveryFact(recoveryFact) &&
    recoveryFact.status === "blocked"
    ? recoveryFact
    : null;
}

/** Changes answer with a sync result; test and demo routes still send a bare snapshot. */
function isWorkspaceSyncResult(
  response: JobFinderRendererWorkspaceSnapshot | JobFinderWorkspaceSyncResult,
): response is JobFinderWorkspaceSyncResult {
  return (
    "kind" in response &&
    (response.kind === "delta" || response.kind === "snapshot")
  );
}

export function useJobFinderWorkspace(): JobFinderWorkspaceState {
  const [workspaceState, setWorkspaceState] = useState<JobFinderWorkspaceState>(
    { status: "loading" },
  );
  const [loadRequest, setLoadRequest] = useState(0);
  const performanceRunRef = useRef(0);
  const workspaceRef = useRef<JobFinderRendererWorkspaceSnapshot | null>(null);
  const workspaceRevisionRef = useRef<WorkspaceRevision>(0);
  const workspaceBaselinesRef = useRef(
    new Map<WorkspaceRevision, JobFinderRendererWorkspaceSnapshot>(),
  );
  const workspaceCommitVersionRef = useRef(0);
  const requestBackgroundSyncRef = useRef<(() => void) | null>(null);
  // Progress belongs to the import invocation that registered its callback.
  // A native file picker may settle after a route change or a renderer reload;
  // request identity keeps a late event from repainting a newer import.
  const resumeImportRequestSequenceRef = useRef(0);

  useEffect(() => {
    return () => {
      resumeImportRequestSequenceRef.current += 1;
    };
  }, []);
  // A workspace action may finish after a newer action has already committed.
  // Keep the latest invocation authoritative so a slow IPC response cannot
  // restore an older snapshot or revision.
  const workspaceRequestSequenceRef = useRef(0);

  const beginWorkspaceRequest = useCallback(() => {
    workspaceRequestSequenceRef.current += 1;
    return workspaceRequestSequenceRef.current;
  }, []);

  const isCurrentWorkspaceRequest = useCallback((sequence: number) => {
    return workspaceRequestSequenceRef.current === sequence;
  }, []);

  const assertWorkspaceHydrated = useCallback(() => {
    if (workspaceRef.current?.hydration?.phase === "bootstrap") {
      throw new Error(
        "Job Finder is still finishing its initial load. Please wait a moment and try again.",
      );
    }
  }, []);

  const commitWorkspace = useCallback(
    (
      workspace: JobFinderRendererWorkspaceSnapshot,
      revision: WorkspaceRevision = 0,
      resetBaselines = false,
    ) => {
      const baselines = workspaceBaselinesRef.current;
      if (revision === 0 || resetBaselines) {
        baselines.clear();
      }
      workspaceRevisionRef.current = revision;
      if (revision !== 0) {
        // Retain workspace references, sharing unchanged immutable rows.
        baselines.set(revision, workspace);
        while (baselines.size > MAX_WORKSPACE_BASELINES) {
          const oldestRevision = baselines.keys().next().value;
          if (oldestRevision === undefined) break;
          baselines.delete(oldestRevision);
        }
      }
      workspaceCommitVersionRef.current += 1;
      workspaceRef.current = workspace;
      // Main answers this window's next change relative to what it shows.
      // Test hosts and an older preload may not offer the notice.
      const noteRevision = window.nestor.jobFinder.noteWorkspaceRevision;
      if (typeof noteRevision === "function") noteRevision(revision);
      setWorkspaceState((currentState) =>
        currentState.status === "ready"
          ? { ...currentState, workspace }
          : currentState,
      );
    },
    [],
  );

  const applyWorkspaceDelta = useCallback((delta: JobFinderWorkspaceDelta) => {
    if (delta.currentRevision <= workspaceRevisionRef.current) {
      return { status: "stale" } as const;
    }
    const baseline = workspaceBaselinesRef.current.get(delta.baseRevision);
    if (!baseline) {
      return { status: "gap" } as const;
    }
    // A cumulative delta describes this exact baseline, not the newer UI.
    // Reconstruct from it so intermediate additions and reverted fields vanish.
    return applyJobFinderWorkspaceDelta({
      revision: delta.baseRevision,
      workspace: baseline,
      delta,
    });
  }, []);

  const recoverFullWorkspaceOnce = useCallback(
    async (sequence?: number) => {
      const requestSequence = sequence ?? beginWorkspaceRequest();
      try {
        const result = await window.nestor.jobFinder.syncWorkspace(null);
        if (result.kind === "snapshot") {
          if (!isCurrentWorkspaceRequest(requestSequence)) {
            return workspaceRef.current ?? result.snapshot;
          }

          commitWorkspace(result.snapshot, result.currentRevision, true);
          return result.snapshot;
        }
      } catch {
        // Older preload builds still use the existing full-snapshot fallback.
      }

      const workspace = await window.nestor.jobFinder.getWorkspace();
      if (!isCurrentWorkspaceRequest(requestSequence)) {
        return workspaceRef.current ?? workspace;
      }

      commitWorkspace(workspace);
      return workspace;
    },
    [beginWorkspaceRequest, commitWorkspace, isCurrentWorkspaceRequest],
  );

  // A response that loses the sequencing race against a later request must
  // still converge. The winning request may have snapshotted main-process
  // state before this response's own backend commit landed, so dropping the
  // fenced response can leave permanently stale UI. One trailing
  // authoritative fetch — dispatched only after this response settled, so
  // its snapshot observes every settled commit — restores freshness without
  // weakening the latest-request fence: nothing stale is ever committed.
  const scheduleConvergenceFetch = useCallback(() => {
    void recoverFullWorkspaceOnce().catch(() => undefined);
  }, [recoverFullWorkspaceOnce]);

  const commitWorkspaceSyncResult = useCallback(
    (
      result: JobFinderWorkspaceSyncResult,
      sequence: number,
    ): JobFinderRendererWorkspaceSnapshot | null => {
      if (!isCurrentWorkspaceRequest(sequence)) {
        return workspaceRef.current;
      }

      if (result.kind === "snapshot") {
        commitWorkspace(result.snapshot, result.currentRevision);
        return result.snapshot;
      }

      const workspace = workspaceRef.current;
      if (!workspace) {
        return null;
      }

      const applied = applyWorkspaceDelta(result.delta);
      if (applied.status === "stale") {
        return workspace;
      }
      if (applied.status !== "applied") {
        return null;
      }

      commitWorkspace(applied.workspace, applied.revision);
      return applied.workspace;
    },
    [applyWorkspaceDelta, commitWorkspace, isCurrentWorkspaceRequest],
  );

  const runWorkspaceAction = useCallback(
    async (
      action: () => Promise<
        JobFinderRendererWorkspaceSnapshot | JobFinderWorkspaceSyncResult
      >,
      options?: { allowDuringBootstrap?: boolean },
    ): Promise<JobFinderRendererWorkspaceSnapshot> => {
      if (!options?.allowDuringBootstrap) {
        assertWorkspaceHydrated();
      }
      const sequence = beginWorkspaceRequest();
      let response: JobFinderRendererWorkspaceSnapshot | JobFinderWorkspaceSyncResult;
      try {
        response = await action();
      } catch (error) {
        // Main often records the failure before it throws (a resume run that
        // failed saves a failed asset with its cause). Without a re-sync the
        // screen kept its pre-action state, "No resume yet" with "Create the
        // resume", until the window was reloaded.
        scheduleConvergenceFetch();
        throw error;
      }
      if (isWorkspaceSyncResult(response)) {
        // Same convergence contract as runWorkspaceEntityMutation: main
        // answered relative to the revision this window holds.
        if (!isCurrentWorkspaceRequest(sequence)) scheduleConvergenceFetch();
        return (
          commitWorkspaceSyncResult(response, sequence) ??
          (await recoverFullWorkspaceOnce(sequence))
        );
      }
      const workspace = response;
      if (!isCurrentWorkspaceRequest(sequence)) {
        scheduleConvergenceFetch();
        return workspaceRef.current ?? workspace;
      }

      // A bare snapshot response carries no revision, so the delta baseline
      // must be surrendered here. `0` means "this workspace corresponds to no
      // revision main knows about", which forces the next sync to ask for a
      // full snapshot and re-baseline both sides together.
      //
      // Do NOT "optimise" this into keeping the previous revision: main's
      // tracker baseline would still be the pre-mutation snapshot while the
      // committed workspace is the post-mutation one, so the next delta would
      // be computed against a state the renderer no longer holds. An entity
      // created by this mutation and removed before the next sync would then
      // survive forever in the UI, because it is absent from both the baseline
      // and the current snapshot and therefore never appears in `removedIds`.
      // The revision can only be carried forward once the mutation response
      // itself carries it (see `runWorkspaceEntityMutation`, which does exactly
      // that through the typed sync envelope).
      commitWorkspace(workspace);
      return workspace;
    },
    [
      assertWorkspaceHydrated,
      beginWorkspaceRequest,
      commitWorkspace,
      commitWorkspaceSyncResult,
      isCurrentWorkspaceRequest,
      recoverFullWorkspaceOnce,
      scheduleConvergenceFetch,
    ],
  );

  const syncWorkspace = useCallback(async () => {
    const sequence = beginWorkspaceRequest();
    const baseRevision = workspaceRevisionRef.current || null;
    let result: JobFinderWorkspaceSyncResult;
    try {
      result = await window.nestor.jobFinder.syncWorkspace(baseRevision);
    } catch {
      return recoverFullWorkspaceOnce(sequence);
    }

    return (
      commitWorkspaceSyncResult(result, sequence) ??
      (await recoverFullWorkspaceOnce(sequence))
    );
  }, [
    beginWorkspaceRequest,
    commitWorkspaceSyncResult,
    recoverFullWorkspaceOnce,
  ]);

  // Main may publish an update before the mutation that caused it returns.
  // Notification refreshes therefore use their own fence: they never advance
  // the mutation request sequence, and they commit only if no other response
  // has committed since this refresh began.
  const syncWorkspaceFromUpdate = useCallback(async () => {
    if (!workspaceRef.current) return null;
    const commitVersion = workspaceCommitVersionRef.current;
    const baseRevision = workspaceRevisionRef.current || null;

    try {
      const result = await window.nestor.jobFinder.syncWorkspace(baseRevision);
      if (workspaceCommitVersionRef.current !== commitVersion) {
        return workspaceRef.current;
      }

      if (result.kind === "snapshot") {
        commitWorkspace(result.snapshot, result.currentRevision);
        return result.snapshot;
      }

      const workspace = workspaceRef.current;
      if (workspace) {
        const applied = applyWorkspaceDelta(result.delta);
        if (applied.status === "stale") {
          return workspace;
        }
        if (applied.status === "applied") {
          commitWorkspace(applied.workspace, applied.revision);
          return applied.workspace;
        }
      }
    } catch {
      // Fall through to the legacy full-snapshot recovery below.
    }

    const workspace = await window.nestor.jobFinder.getWorkspace();
    if (workspaceCommitVersionRef.current !== commitVersion) {
      return workspaceRef.current ?? workspace;
    }
    commitWorkspace(workspace);
    return workspace;
  }, [applyWorkspaceDelta, commitWorkspace]);

  useEffect(() => {
    let disposed = false;
    let syncing = false;
    let queued = false;
    let waitTimer: number | undefined;
    let nextSyncAt = 0;
    const startSync = () => {
      syncing = true;
      const startedAt = Date.now();
      void syncWorkspaceFromUpdate().finally(() => {
        syncing = false;
        // A search sends updates several times a second, and each sync makes
        // main rebuild the whole workspace, which takes seconds once it holds
        // a few thousand jobs. Resting twice as long as the sync took keeps
        // those rebuilds to about a third of main's time at any size.
        const finishedAt = Date.now();
        nextSyncAt =
          finishedAt +
          Math.min(
            MAX_UPDATE_SYNC_REST_MS,
            Math.max(
              MIN_UPDATE_SYNC_REST_MS,
              UPDATE_SYNC_REST_FACTOR * (finishedAt - startedAt),
            ),
          );
        if (queued) {
          queued = false;
          converge();
        }
      });
    };
    const converge = () => {
      if (disposed) return;
      if (syncing || waitTimer !== undefined) {
        queued = true;
        return;
      }
      const wait = nextSyncAt - Date.now();
      if (wait <= 0) {
        startSync();
        return;
      }
      waitTimer = window.setTimeout(() => {
        waitTimer = undefined;
        if (disposed) return;
        // The sync starting now covers every update that arrived meanwhile.
        queued = false;
        startSync();
      }, wait);
    };
    requestBackgroundSyncRef.current = converge;
    const subscribe = window.nestor.jobFinder.onWorkspaceUpdate;
    // Test hosts and a renderer that survived a development preload refresh
    // can briefly expose the earlier bridge shape. The next mount subscribes;
    // this mount keeps its ordinary mutation-driven convergence.
    const unsubscribe =
      typeof subscribe === "function" ? subscribe(converge) : undefined;
    return () => {
      disposed = true;
      if (requestBackgroundSyncRef.current === converge) {
        requestBackgroundSyncRef.current = null;
      }
      if (waitTimer !== undefined) window.clearTimeout(waitTimer);
      unsubscribe?.();
    };
  }, [syncWorkspaceFromUpdate]);

  /**
   * Asks for a background refresh on the same paced path as main's update
   * notices, so progress refreshes during a search never stack on them.
   */
  const requestWorkspaceRefresh = useCallback(() => {
    requestBackgroundSyncRef.current?.();
  }, []);

  const runWorkspaceEntityMutation = useCallback(
    async (mutation: JobFinderWorkspaceEntityMutation) => {
      assertWorkspaceHydrated();
      const sequence = beginWorkspaceRequest();
      const baseRevision = workspaceRevisionRef.current || null;
      const result = await window.nestor.jobFinder.mutateWorkspaceEntities({
        baseRevision,
        mutation,
      });

      if (!isCurrentWorkspaceRequest(sequence)) {
        // Same convergence contract as runWorkspaceAction: a background sync
        // that raced this committed mutation must not leave its result
        // stranded in stale UI, and the fenced response must not be
        // committed directly ahead of the newer request.
        scheduleConvergenceFetch();
      }

      return (
        commitWorkspaceSyncResult(result, sequence) ??
        (await recoverFullWorkspaceOnce(sequence))
      );
    },
    [
      beginWorkspaceRequest,
      commitWorkspaceSyncResult,
      recoverFullWorkspaceOnce,
      assertWorkspaceHydrated,
      isCurrentWorkspaceRequest,
      scheduleConvergenceFetch,
    ],
  );

  const actions = useMemo<JobFinderShellActions>(
    () => ({
      analyzeProfileFromResume: () =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.analyzeProfileFromResume(),
        ),
      judgeUnjudgedJobs: () =>
        runWorkspaceAction(() => window.nestor.jobFinder.judgeUnjudgedJobs()),
      openBrowserSession: (input?: JobFinderOpenBrowserSessionInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.openBrowserSession(input),
        ),
      checkBrowserSession: () =>
        runWorkspaceAction(
          () => window.nestor.jobFinder.checkBrowserSession(),
          { allowDuringBootstrap: true },
        ),
      performUserAction: (command: UserActionCommandInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.performUserAction(command),
        ),
      approveApply: (input: JobFinderApplicationStartTarget) =>
        runWorkspaceAction(() => window.nestor.jobFinder.approveApply(input)),
      dismissDiscoveryJob: (
        jobId: string,
        reasons: readonly DiscoveryFeedbackReason[],
        action: "hide_job" | "hide_and_exclude_employer" = "hide_job",
        expectedNormalizedCompanyName: string | null = null,
      ) =>
        runWorkspaceEntityMutation({
          type: "dismiss_discovery_job",
          jobId,
          reasons: [...reasons],
          action,
          expectedNormalizedCompanyName,
        }),
      previewEmployerExclusion: (jobId: string) =>
        window.nestor.jobFinder.previewEmployerExclusion(jobId),
      removeEmployerExclusion: (input) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.removeEmployerExclusion(input),
        ),
      restoreDismissedDiscoveryJob: (jobId: string) =>
        runWorkspaceEntityMutation({
          type: "restore_dismissed_discovery_job",
          jobId,
        }),
      removeJobsFromReview: (jobIds: readonly string[]) =>
        runWorkspaceEntityMutation({
          type: "remove_jobs_from_review",
          jobIds: [...jobIds],
        }),
      dismissDiscoveryJobs: (
        jobIds: readonly string[],
        reasons: readonly DiscoveryFeedbackReason[],
      ) =>
        runWorkspaceEntityMutation({
          type: "dismiss_discovery_jobs",
          jobIds: [...jobIds],
          reasons: [...reasons],
        }),
      removeJobFromReview: (jobId: string) =>
        runWorkspaceEntityMutation({
          type: "remove_job_from_review",
          jobId,
        }),
      getResumeWorkspace: (jobId: string) =>
        window.nestor.jobFinder.getResumeWorkspace(jobId),
      previewResumeDraft: (draft: ResumeDraft, requestId?: string) =>
        window.nestor.jobFinder.previewResumeDraft(draft, requestId),
      saveResumeDraft: (draft: ResumeDraft, autosaveSessionId?: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveResumeDraft(draft, autosaveSessionId),
        ),
      regenerateResumeDraft: (jobId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.regenerateResumeDraft(jobId),
        ),
      regenerateResumeSection: (jobId: string, sectionId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.regenerateResumeSection(jobId, sectionId),
        ),
      restoreResumeDraftRevision: (jobId: string, revisionId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.restoreResumeDraftRevision(jobId, revisionId),
        ),
      undoResumeAssistantEdit: (jobId: string, revisionId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.undoResumeAssistantEdit(jobId, revisionId),
        ),
      exportResumePdf: async (
        jobId: string,
        intent: ResumePdfExportIntent = "download",
      ) => {
        assertWorkspaceHydrated();
        const sequence = beginWorkspaceRequest();
        const { workspace, ...outcome } =
          await window.nestor.jobFinder.exportResumePdf(jobId, intent);
        // The workspace comes as a delta from the revision this window
        // holds, like every other change's answer.
        if (!isCurrentWorkspaceRequest(sequence)) scheduleConvergenceFetch();
        const snapshot =
          commitWorkspaceSyncResult(workspace, sequence) ??
          (await recoverFullWorkspaceOnce(sequence));
        return { ...outcome, snapshot };
      },
      // Reveal is not a workspace mutation: it selects the written file in the
      // OS file manager and returns what happened, so it never refreshes.
      revealSavedFile: (path: string) =>
        window.nestor.jobFinder.revealSavedFile(path),
      approveResume: (jobId: string, exportId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.approveResume(jobId, exportId),
        ),
      clearResumeApproval: (
        jobId: string,
        restoreStatus?: "draft" | "needs_review",
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.clearResumeApproval(jobId, restoreStatus),
        ),
      setWorkHistoryReviewAcknowledgment: (
        input: JobFinderSetWorkHistoryReviewAcknowledgmentInput,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.setWorkHistoryReviewAcknowledgment(input),
        ),
      setResumeClaimConfirmation: (
        input: JobFinderSetResumeClaimConfirmationInput,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.setResumeClaimConfirmation(input),
        ),
      applyResumePatch: (
        patch: ResumeDraftPatch,
        revisionReason?: string | null,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.applyResumePatch(patch, revisionReason),
        ),
      getResumeAssistantMessages: (jobId: string) =>
        window.nestor.jobFinder.getResumeAssistantMessages(jobId),
      sendResumeAssistantMessage: (jobId: string, content: string) =>
        window.nestor.jobFinder.sendResumeAssistantMessage(jobId, content),
      resolveResumeAssistantProposal: (
        jobId: string,
        proposalId: string,
        action: "accept" | "reject",
        patchIds: readonly string[],
      ) =>
        window.nestor.jobFinder.resolveResumeAssistantProposal(
          jobId,
          proposalId,
          action,
          patchIds,
        ),
      generateResume: (jobId: string) =>
        runWorkspaceAction(() => window.nestor.jobFinder.generateResume(jobId)),
      startApplyCopilotRun: (input: JobFinderApplyCopilotActionInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.startApplyCopilotRun(input),
        ),
      startAutoApplyRun: (input: JobFinderApplicationStartTarget) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.startAutoApplyRun(input),
        ),
      startAutoApplyQueueRun: (
        jobIds: JobFinderApplyQueueActionInput["jobIds"],
        applicationAutomationMode?: JobFinderApplyQueueActionInput["applicationAutomationMode"],
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.startAutoApplyQueueRun(
            jobIds,
            applicationAutomationMode,
          ),
        ),
      startApplyQueue: (input: JobFinderStartApplyQueueInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.startApplyQueue(input),
        ),
      approveResumes: (input: JobFinderApproveResumesInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.approveResumes(input),
        ),
      controlApplyQueue: (input: JobFinderApplyQueueControlInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.controlApplyQueue(input),
        ),
      approveApplyRun: (input: JobFinderApplyRunActionInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.approveApplyRun(input),
        ),
      cancelApplyRun: (input: JobFinderApplyRunActionInput) =>
        runWorkspaceAction(() => window.nestor.jobFinder.cancelApplyRun(input)),
      resolveApplyConsentRequest: (input: JobFinderApplyConsentActionInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.resolveApplyConsentRequest(input),
        ),
      revokeApplyRunApproval: (input: JobFinderApplyRunActionInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.revokeApplyRunApproval(input),
        ),
      focusPreparedApplicationPage: (
        input: JobFinderPreparedApplicationPageInput,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.focusPreparedApplicationPage(input),
        ),
      submitPreparedApplication: (input: { jobId: string }) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.submitPreparedApplication(input),
        ),
      sendPreparedApplications: (input: { jobIds: string[] }) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.sendPreparedApplications(input),
        ),
      mutateApplicationCrm: (input: ApplicationCrmMutationInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.mutateApplicationCrm(input),
        ),
      mutateApplicationCrmBulkStage: (
        input: ApplicationCrmBulkStageMutationInput,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.mutateApplicationCrmBulkStage(input),
        ),
      runApplicationNoResponseAutomation: (settings?: ApplicationCrmSettings) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.runApplicationNoResponseAutomation(settings),
        ),
      exportApplicationCrm: (input: ApplicationCrmExportInput) =>
        window.nestor.jobFinder.exportApplicationCrm(input),
      importResume: (options?: { retryInterrupted?: boolean }) => {
        const requestSequence = ++resumeImportRequestSequenceRef.current;
        setWorkspaceState((currentState) =>
          currentState.status === "ready"
            ? { ...currentState, resumeImportProgress: null }
            : currentState,
        );
        const onImportProgress = (progress: ResumeImportProgressEvent) => {
          if (resumeImportRequestSequenceRef.current !== requestSequence) {
            return;
          }

          setWorkspaceState((currentState) =>
            currentState.status === "ready"
              ? { ...currentState, resumeImportProgress: progress }
              : currentState,
          );
        };
        const importPromise = runWorkspaceAction(() =>
          options?.retryInterrupted === true
            ? window.nestor.jobFinder.importResume(onImportProgress, {
                retryInterrupted: true,
              })
            : window.nestor.jobFinder.importResume(onImportProgress),
        );

        return importPromise.finally(() => {
          if (resumeImportRequestSequenceRef.current !== requestSequence) {
            return;
          }

          // Invalidate the callback before clearing its visible progress so a
          // late event from a closed picker cannot resurrect Guided setup's
          // busy state.
          resumeImportRequestSequenceRef.current += 1;
          setWorkspaceState((currentState) =>
            currentState.status === "ready"
              ? { ...currentState, resumeImportProgress: null }
              : currentState,
          );
        });
      },
      assessJobListing: (jobId: string) =>
        runWorkspaceEntityMutation({ type: "assess_job_listing", jobId }),
      queueJobForReview: (jobId: string) =>
        runWorkspaceEntityMutation({
          type: "queue_job_for_review",
          jobId,
        }),
      queueJobsForReview: (jobIds: readonly string[]) =>
        runWorkspaceEntityMutation({
          type: "queue_jobs_for_review",
          jobIds: [...jobIds],
        }),
      setJobResumeApplicationMode: (
        jobId: string,
        resumeApplicationMode: ResumeApplicationMode,
        resumeTailoringMode?: TailoringMode | null,
      ) =>
        runWorkspaceEntityMutation({
          type: "set_job_resume_application_mode",
          jobId,
          resumeApplicationMode,
          ...(resumeTailoringMode === undefined ? {} : { resumeTailoringMode }),
        }),
      refreshWorkspace: syncWorkspace,
      requestWorkspaceRefresh,
      resetBrowser: () =>
        runWorkspaceAction(() => window.nestor.jobFinder.resetBrowser()),
      resetWorkspace: () => {
        clearJobDetailCache();
        clearTailoredAssetDetailCache();
        return runWorkspaceAction(() =>
          window.nestor.jobFinder.resetWorkspace(),
        ).finally(() => {
          clearJobDetailCache();
          clearTailoredAssetDetailCache();
        });
      },
      runAgentDiscovery: async (
        onProgress?: (event: DiscoveryActivityEvent) => void,
        targetId?: string,
        searchRequest?: JobFinderSearchRequest,
      ) => {
        // Main answers with what changed since the revision this window
        // holds; it is committed like any other change this window asked for.
        let outcome: JobFinderAgentDiscoveryResult["outcome"] = "completed";
        const snapshot = await runWorkspaceAction(async () => {
          const reply = (await window.nestor.jobFinder.runAgentDiscovery(
            onProgress,
            targetId,
            searchRequest,
          )) as JobFinderAgentDiscoveryReply | JobFinderAgentDiscoveryResult;
          outcome = reply.outcome;
          // Test hosts and an older preload may still answer with the
          // whole workspace.
          return "sync" in reply ? reply.sync : reply.snapshot;
        });
        return { outcome, snapshot };
      },
      cancelAgentDiscovery: (input) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.cancelAgentDiscovery(input),
        ),
      runSourceDebug: (
        targetId: string,
        onProgress?: (event: SourceDebugProgressEvent) => void,
        options?: { readabilityTimeoutMs?: number },
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.runSourceDebug(targetId, onProgress, options),
        ),
      getSourceDebugRunDetails: (runId: string) =>
        window.nestor.jobFinder.getSourceDebugRunDetails(runId),
      getApplyRunDetails: (input: JobFinderApplyRunDetailsQuery) =>
        window.nestor.jobFinder.getApplyRunDetails(input),
      saveApplicationAnswer: (command: SaveApplicationAnswerCommandInput) =>
        window.nestor.jobFinder.saveApplicationAnswer(command),
      clearApplicationAnswer: (command: ClearApplicationAnswerCommandInput) =>
        window.nestor.jobFinder.clearApplicationAnswer(command),
      projectGroupedManualAnswer: (
        command: ProjectGroupedManualAnswerCommand,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.projectGroupedManualAnswer(command),
        ),
      applyGroupedManualAnswer: (input: ApplyGroupedManualAnswerInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.applyGroupedManualAnswer(input),
        ),
      snoozeGroupedDecision: (input: SnoozeGroupedDecisionInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.snoozeGroupedDecision(input),
        ),
      exportApplicationPacket: (input: JobFinderApplyRunDetailsQuery) =>
        window.nestor.jobFinder.exportApplicationPacket(input),
      resolveSubmissionOutcome: (input: ResolveSubmissionOutcomeInput) =>
        window.nestor.jobFinder.resolveSubmissionOutcome(input),
      saveSourceInstructionArtifact: (
        targetId: string,
        artifact: EditableSourceInstructionArtifact,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveSourceInstructionArtifact(
            targetId,
            artifact,
          ),
        ),
      acceptSourceInstructionDraft: (targetId: string, instructionId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.acceptSourceInstructionDraft(
            targetId,
            instructionId,
          ),
        ),
      verifySourceInstructions: (targetId: string, instructionId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.verifySourceInstructions(
            targetId,
            instructionId,
          ),
        ),
      saveProfile: (profile: CandidateProfile) =>
        runWorkspaceAction(() => window.nestor.jobFinder.saveProfile(profile)),
      saveWorkspaceInputs: (
        profile: CandidateProfile,
        searchPreferences: JobSearchPreferences,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveWorkspaceInputs(
            profile,
            searchPreferences,
          ),
        ),
      saveSearchPreferences: (searchPreferences: JobSearchPreferences) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveSearchPreferences(searchPreferences),
        ),
      saveCampaign: (campaign: SaveJobSearchCampaignInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveCampaign(campaign),
        ),
      selectCampaign: (campaignId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.selectCampaign(campaignId),
        ),
      runCampaignNow: (campaignId?: string | null) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.runCampaignNow(
            campaignId ? { campaignId } : undefined,
          ),
        ),
      markCampaignNotificationRead: (notificationId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.markCampaignNotificationRead(notificationId),
        ),
      markAllCampaignNotificationsRead: () =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.markAllCampaignNotificationsRead(),
        ),
      saveCampaignRule: (campaignId: string, rule: SaveCampaignRuleInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveCampaignRule(campaignId, rule),
        ),
      deleteCampaignRule: (campaignId: string, ruleId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.deleteCampaignRule(campaignId, ruleId),
        ),
      deleteCampaign: async (campaignId: string) => {
        const deleted =
          await window.nestor.jobFinder.deleteJobSearchCampaign(campaignId);
        // A refused or failed deletion must leave the local snapshot alone.
        // Only a confirmed delete follows the canonical sync path so the
        // removed campaign disappears immediately and the backend-selected
        // fallback active campaign becomes authoritative. The sync fences its
        // commit through the workspace request sequence, so a slow refresh
        // can never overwrite a newer snapshot.
        if (!deleted) {
          return false;
        }

        await syncWorkspace();
        return true;
      },
      toggleCampaignRule: (
        campaignId: string,
        ruleId: string,
        enabled: boolean,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.toggleCampaignRule(
            campaignId,
            ruleId,
            enabled,
          ),
        ),
      projectCampaignRuleFunnel: (campaignId: string) =>
        window.nestor.jobFinder.projectCampaignRuleFunnel(campaignId),
      setActivityControl: (input: SetJobFinderActivityControlInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.setActivityControl(input),
        ),
      mutateRapidReview: (input: RapidReviewMutationInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.mutateRapidReview(input),
        ),
      recordOutcome: (input: RecordOutcomeInput) =>
        runWorkspaceAction(() => window.nestor.jobFinder.recordOutcome(input)),
      saveResumeStrategy: (input: SaveResumeStrategyInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveResumeStrategy(input),
        ),
      disableResumeStrategy: (strategyId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.disableResumeStrategy(strategyId),
        ),
      selectResumeStrategy: (input: SelectResumeStrategyInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.selectResumeStrategy(input),
        ),
      recommendResumeStrategy: (input: RecommendResumeStrategyInput) =>
        window.nestor.jobFinder.recommendResumeStrategy(input),
      setCampaignResumeStrategyDefault: (
        input: SetCampaignResumeStrategyDefaultInput,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.setCampaignResumeStrategyDefault(input),
        ),
      refreshCompanyIntelligence: () =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.refreshCompanyIntelligence(),
        ),
      setCompanyPreference: (input: SetCompanyPreferenceInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.setCompanyPreference(input),
        ),
      reviewCompanyMerge: (input: ReviewCompanyMergeInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.reviewCompanyMerge(input),
        ),
      mutateCompanyIntelligence: (input: CompanyIntelligenceMutationInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.mutateCompanyIntelligence(input),
        ),
      setOutcomeSuggestionEnabled: (input: SetOutcomeSuggestionEnabledInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.setOutcomeSuggestionEnabled(input),
        ),
      mutateSafeguards: (input: SafeguardMutationInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.mutateSafeguards(input),
        ),
      saveSettings: (settings: JobFinderSettings) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveSettings(settings),
        ),
      updateApplicationDefaults: (input: UpdateApplicationDefaultsInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.updateApplicationDefaults(input),
        ),
      updateWorkspaceBehavior: (input: UpdateWorkspaceBehaviorInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.updateWorkspaceBehavior(input),
        ),
      updateAiBehavior: (input: UpdateAiBehaviorInput) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.updateAiBehavior(input),
        ),
      updateAppearanceTheme: (appearanceTheme: AppearanceTheme) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.updateAppearanceTheme(appearanceTheme),
        ),
      updateTrackerCrm: (applicationCrm: ApplicationCrmSettings) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.updateTrackerCrm(applicationCrm),
        ),
      saveProfileSetupState: (profileSetupState: ProfileSetupState) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.saveProfileSetupState(profileSetupState),
        ),
      applyProfileSetupReviewAction: (
        reviewItemId: string,
        action: ProfileSetupReviewAction,
        options?: ProfileSetupReviewActionOptions,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.applyProfileSetupReviewAction(
            reviewItemId,
            action,
            options,
          ),
        ),
      applyResumeTimelineRepairAction: (
        runId: string,
        proposalId: string,
        action: ResumeTimelineRepairAction,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.applyResumeTimelineRepairAction(
            runId,
            proposalId,
            action,
          ),
        ),
      sendProfileCopilotMessage: (
        content: string,
        context?: ProfileCopilotContext,
      ) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.sendProfileCopilotMessage(content, context),
        ),
      applyProfileCopilotPatchGroup: (patchGroupId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.applyProfileCopilotPatchGroup(patchGroupId),
        ),
      rejectProfileCopilotPatchGroup: (patchGroupId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.rejectProfileCopilotPatchGroup(patchGroupId),
        ),
      undoProfileRevision: (revisionId: string) =>
        runWorkspaceAction(() =>
          window.nestor.jobFinder.undoProfileRevision(revisionId),
        ),
    }),
    [
      requestWorkspaceRefresh,
      runWorkspaceAction,
      runWorkspaceEntityMutation,
      syncWorkspace,
    ],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspace() {
      const performanceRunId = ++performanceRunRef.current;
      const performancePrefix = `job-finder:workspace:${performanceRunId}`;
      markJobFinderTiming(`${performancePrefix}:bootstrap:start`);

      try {
        const [platformResponse, bootstrap] = await Promise.all([
          window.nestor.ping(),
          typeof window.nestor.jobFinder.getWorkspaceBootstrap === "function"
            ? window.nestor.jobFinder.getWorkspaceBootstrap()
            : recoverFullWorkspaceOnce(),
        ]);

        if (!cancelled) {
          // Keep the bootstrap snapshot as the authoritative visible state
          // before deferred hydration begins. The hydration failure path uses
          // this identity check to report a real failure; without recording it
          // here, that error is silently discarded because the ref is still
          // null while the shell is already showing the bootstrap.
          if (
            typeof window.nestor.jobFinder.getWorkspaceBootstrap === "function"
          ) {
            // Bootstrap is an unrevisioned snapshot, even when fully hydrated.
            commitWorkspace(bootstrap);
          } else {
            // The legacy recovery path already recorded its revisioned snapshot.
            workspaceRef.current = bootstrap;
          }
          setWorkspaceState({
            status: "ready",
            actions,
            platform: platformResponse.platform,
            resumeImportProgress: null,
            workspace: bootstrap,
          });
          markJobFinderTiming(
            `${performancePrefix}:bootstrap:ready`,
            `${performancePrefix}:bootstrap:start`,
          );
          markJobFinderTiming("job-finder:workspace:bootstrap:ready");
        }

        // Keep the shell responsive while the large collections hydrate. The
        // hydration request is fenced like every other workspace request so a
        // later user action can never be overwritten by a stale full snapshot.
        if (bootstrap.hydration?.phase === "bootstrap") {
          const hydrationSequence = beginWorkspaceRequest();
          markJobFinderTiming(`${performancePrefix}:hydration:start`);
          markJobFinderTiming("job-finder:workspace:hydration:start");

          const reportHydrationFailure = (error: unknown) => {
            // Only a shell still waiting on hydration can surface this
            // failure; once any commit moved past the bootstrap phase the
            // workspace converged and the error would be noise.
            if (
              cancelled ||
              workspaceRef.current?.hydration?.phase !== "bootstrap"
            ) {
              return;
            }

            const message =
              error instanceof Error
                ? error.message
                : "Unable to finish loading the Job Finder workspace.";
            setWorkspaceState({
              status: "error",
              message,
              retry: () => {
                setWorkspaceState({ status: "loading" });
                setLoadRequest((current) => current + 1);
              },
              startupDatabaseRecovery: null,
            });
          };

          // An allowDuringBootstrap action can win the sequence race while
          // the shell still shows the partial bootstrap snapshot. Its commit
          // cannot finish hydration, so without help bootstrap stays stranded
          // (every gated action keeps failing). Loop one authoritative fetch
          // at a time: each attempt is dispatched after the previous request
          // settled, so it observes every commit that superseded its
          // predecessor, and the loop ends as soon as the visible phase moves
          // past "bootstrap". A failing attempt surfaces the retryable error
          // instead of silently stranding.
          const resumeStrandedBootstrap = async () => {
            while (
              !cancelled &&
              workspaceRef.current?.hydration?.phase === "bootstrap"
            ) {
              try {
                await recoverFullWorkspaceOnce();
              } catch (error) {
                reportHydrationFailure(error);
                return;
              }
            }
          };

          void recoverFullWorkspaceOnce(hydrationSequence)
            .then((hydratedWorkspace) => {
              if (hydratedWorkspace?.hydration?.phase === "complete") {
                markJobFinderTiming(
                  `${performancePrefix}:hydration:complete`,
                  `${performancePrefix}:hydration:start`,
                );
                markJobFinderTiming("job-finder:workspace:hydration:complete");
              }
              void resumeStrandedBootstrap();
            })
            .catch((error) => {
              if (
                cancelled ||
                !isCurrentWorkspaceRequest(hydrationSequence) ||
                workspaceRef.current !== bootstrap
              ) {
                // This failure was superseded: an action owns the surface or
                // a newer request already replaced the bootstrap snapshot.
                // Deterministically resume hydration rather than leaving the
                // partial bootstrap visible forever.
                void resumeStrandedBootstrap();
                return;
              }

              reportHydrationFailure(error);
            });
        }
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to load the Job Finder workspace.";

        if (!cancelled) {
          // Main records the typed incident synchronously before the
          // bootstrap request rejects, so fetching here (not earlier) always
          // observes it; a malformed or unrelated fact fails closed to the
          // generic retryable error.
          const startupDatabaseRecovery = selectBlockedStartupDatabaseRecovery(
            await requestStartupDatabaseRecoveryFact(),
          );

          if (!cancelled) {
            setWorkspaceState({
              status: "error",
              message,
              retry: () => {
                setWorkspaceState({ status: "loading" });
                setLoadRequest((current) => current + 1);
              },
              startupDatabaseRecovery,
            });
          }
        }
      }
    }

    void loadWorkspace();

    return () => {
      cancelled = true;
    };
  }, [
    actions,
    beginWorkspaceRequest,
    commitWorkspace,
    isCurrentWorkspaceRequest,
    loadRequest,
    recoverFullWorkspaceOnce,
  ]);

  const capacityResetsAt =
    workspaceState.status === "ready"
      ? workspaceState.workspace.dashboard
          ?.globalDailyApplicationPreparationCapacity?.resetsAt
      : undefined;

  useEffect(() => {
    if (!capacityResetsAt) {
      return;
    }

    const resetAtMs = Date.parse(capacityResetsAt);
    if (!Number.isFinite(resetAtMs)) {
      return;
    }

    const refreshIfStale = () => {
      if (Date.now() >= resetAtMs) {
        void syncWorkspace().catch(() => undefined);
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        refreshIfStale();
      }
    };
    const timeout = window.setTimeout(
      refreshIfStale,
      Math.max(0, resetAtMs - Date.now() + 100),
    );
    window.addEventListener("focus", refreshIfStale);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("focus", refreshIfStale);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [capacityResetsAt, syncWorkspace]);

  return workspaceState;
}
