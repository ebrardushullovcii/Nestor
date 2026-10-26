import { jobSiteTarget } from "@nestor/contracts";
import type {
  BrowserSessionRuntime,
  OpenBrowserSessionOptions,
} from "@nestor/browser-runtime";
import type {
  ApplyJobResult,
  JobFinderDiscoveryState,
  JobFinderWorkspaceSnapshot,
  JobSearchPreferences,
  JobSource,
  SavedJob,
  SetJobFinderActivityControlInput,
  SourceDebugRunRecord,
} from "@nestor/contracts";
import {
  JobFinderActivityControlSchema,
  jobSourceValues,
  SavedJobSchema,
  SetJobFinderActivityControlInputSchema,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { isDeepStrictEqual } from "node:util";
import {
  localDateKey,
} from "./internal/application-preparation-capacity";
import { toDiscoverySessionState } from "./internal/discovery-state";
import { createListingActivityIdentityIndex } from "./internal/listing-activity-identity-index";
import { clearResumeBatchLiveness } from "./internal/resume-batch-checkpoint";
import {
  buildStaleResumeDraft,
  hasResumeAffectingJobChange,
} from "./internal/resume-workspace-staleness";
import { createWorkspaceApplicationMethods } from "./internal/workspace-application-methods";
import { createWorkspaceAssistantEditMethods } from "./internal/workspace-assistant-edit-methods";
import {
  extractJobsFromPageText,
  saveJobsFromPage,
} from "./internal/workspace-assistant-page-jobs";
import { addJobFromBrowserPage } from "./internal/workspace-browser-job";
import { SOURCE_DEBUG_RECENT_HISTORY_LIMIT } from "./internal/workspace-defaults";
import {
  getPreferredSessionAdapter,
} from "./internal/workspace-helpers";
import type {
  ApplicationPreparationCapacityToken,
  WorkspaceServiceContext,
} from "./internal/workspace-service-context";
import type {
  CreateJobFinderWorkspaceServiceOptions,
  JobFinderWorkspaceResetOptions,
  JobFinderWorkspaceService,
} from "./internal/workspace-service-contracts";
import { mergeSessionStates } from "./internal/workspace-service-helpers";
import { createWorkspaceSnapshotProfileMethods } from "./internal/workspace-snapshot-profile-methods";
import { createWorkspaceSourceDebugMethods } from "./internal/workspace-source-debug-methods";
import { persistDiscoveryLoginUserAction } from "./internal/workspace-source-user-action";
import {
  createWorkspaceUserActionMethods,
} from "./internal/workspace-user-action-methods";

const applicationPageOwningStates = new Set<ApplyJobResult["state"]>([
  "question_capture",
  "filling",
  "awaiting_review",
  "submitting",
  "blocked",
]);

/**
 * Automatic workflow cleanup must not destroy a different application that is
 * still waiting in its exact prepared tab. The person's explicit browser Close
 * action and workspace shutdown bypass this guard and keep their normal
 * semantics.
 */
export async function hasLiveUnresolvedApplicationPage(input: {
  browserRuntime: BrowserSessionRuntime;
  repository: WorkspaceServiceContext["repository"];
  source: JobSource;
}): Promise<boolean> {
  if (!input.browserRuntime.hasApplicationPageBinding) return false;

  try {
    const [results, requests] = await Promise.all([
      input.repository.listApplyJobResults(),
      input.repository.listUserActionRequests({ scopeType: "application" }),
    ]);
    const bindingKeys = new Set(
      results
        .filter(
          (result) =>
            applicationPageOwningStates.has(result.state) ||
            result.privacyReceipt?.submissionOutcome?.outcome ===
              "outcome_uncertain",
        )
        .map((result) => result.id),
    );
    for (const request of requests) {
      if (
        request.scope.type === "application" &&
        !["resolved", "skipped", "cancelled", "expired", "superseded"].includes(
          request.state,
        ) &&
        request.scope.resultId
      ) {
        bindingKeys.add(request.scope.resultId);
      }
    }

    for (const bindingKey of bindingKeys) {
      if (
        await input.browserRuntime.hasApplicationPageBinding(
          input.source,
          bindingKey,
        )
      ) {
        return true;
      }
    }
    return false;
  } catch {
    // If ownership cannot be read safely, preserve pages. A later snapshot can
    // reconcile stale bindings; cleanup cannot recreate a destroyed form.
    return true;
  }
}

export {
  DEFAULT_DISCOVERY_HISTORY_LIMIT,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TARGET_ROLES,
  DEFAULT_ROLE,
  DEFAULT_TARGET_JOB_COUNT,
  PROFILE_PLACEHOLDER_HEADLINE,
  PROFILE_PLACEHOLDER_LOCATION,
  SOURCE_DEBUG_APP_SCHEMA_VERSION,
  SOURCE_DEBUG_PHASES,
  SOURCE_DEBUG_PROMPT_PROFILE_VERSION,
  SOURCE_DEBUG_RECENT_HISTORY_LIMIT,
  SOURCE_DEBUG_TOOLSET_VERSION,
} from "./internal/workspace-defaults";

export type {
  CandidateAssetResolver,
  CreateJobFinderWorkspaceServiceOptions,
  JobFinderDocumentManager,
  JobFinderWorkspaceResetOptions,
  JobFinderWorkspaceService,
  RenderedResumeArtifact,
  ResolvedApplicationCandidateAsset,
  ResumeResearchAdapter,
  ResumeResearchAdapterInput,
} from "./internal/workspace-service-contracts";

export type {
  ResumeRenderDocument,
  ResumeRenderSection,
  ResumeRenderSectionEntry,
} from "./internal/resume-workspace-structure";

export { MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN } from "./internal/application-preparation-capacity";

type PreparationCapacityState = {
  tokens: Set<ApplicationPreparationCapacityToken>;
  transitionTail: Promise<void>;
};

const preparationCapacityStates = new WeakMap<
  object,
  PreparationCapacityState
>();

function getPreparationCapacityState(
  repository: object,
): PreparationCapacityState {
  const existing = preparationCapacityStates.get(repository);
  if (existing) return existing;

  const created = {
    tokens: new Set<ApplicationPreparationCapacityToken>(),
    transitionTail: Promise.resolve(),
  };
  preparationCapacityStates.set(repository, created);
  return created;
}

async function withPreparationCapacityTransition<T>(
  repository: object,
  operation: (state: PreparationCapacityState) => T | Promise<T>,
): Promise<T> {
  const state = getPreparationCapacityState(repository);
  const previous = state.transitionTail;
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  state.transitionTail = previous.catch(() => undefined).then(() => current);

  await previous.catch(() => undefined);
  try {
    return await operation(state);
  } finally {
    releaseCurrent();
  }
}

/** How long a workspace read waits for verifying steps to be picked up. */
const SNAPSHOT_RECOVERY_WAIT_MS = 1_500;

export function createJobFinderWorkspaceService(
  options: CreateJobFinderWorkspaceServiceOptions,
): JobFinderWorkspaceService {
  const {
    backgroundWorkReady,
    aiClient,
    visionProvider,
    browserRuntime,
    candidateAssetResolver,
    documentManager,
    resumeDraftProcessor,
    exportFileVerifier,
    repository,
    researchAdapter,
    fetchListingHtml,
    onActivityControlChanged,
    onResumeEvidenceFinished,
    onShortlistResumeChanged,
    onListingAssessmentFinished,
    onSavedJobsRescored,
    onExplicitUserStart,
    hasRunJobSearch,
  } = options;
  const activeSourceDebugExecutionIdRef = { current: null as string | null };
  const activeSourceDebugAbortControllerRef = {
    current: null as AbortController | null,
  };
  const activeSourceDebugPromiseRef = {
    current: null as Promise<unknown> | null,
  };
  const activeApplyRunAbortControllers = new Map<string, AbortController>();
  const activeApplyRunPromises = new Map<string, Promise<void>>();
  const applyRunTransitionTails = new Map<string, Promise<void>>();
  let applicationCrmTransitionTail: Promise<void> = Promise.resolve();
  let intelligenceTransitionTail: Promise<void> = Promise.resolve();
  let campaignTransitionTail: Promise<void> = Promise.resolve();
  const activeResumeVisionRunIds = new Set<string>();
  const activeResumeEvidenceRunIds = new Set<string>();
  const shutdownPromiseRef = {
    current: null as Promise<void> | null,
  };
  const activeWorkspaceOperations = new Map<string, number>();
  let workspaceResetInProgress = false;

  const WORKSPACE_RESET_IN_PROGRESS_MESSAGE =
    "Job Finder workspace reset is already in progress. Wait for it to finish before starting another operation.";

  function invalidateListingReads(): void {
    clearResumeBatchLiveness(context.repository);
    if (context.listingAssessmentGenerationRef)
      context.listingAssessmentGenerationRef.current += 1;
    context.listingAssessmentJobIds?.clear();
    context.listingAssessmentAbortControllerRef?.current.abort();
    if (context.listingAssessmentAbortControllerRef)
      context.listingAssessmentAbortControllerRef.current =
        new AbortController();
  }

  function activeWorkspaceOperationLabels(): string[] {
    const labels = new Set(activeWorkspaceOperations.keys());

    if (
      activeSourceDebugAbortControllerRef.current ||
      activeSourceDebugPromiseRef.current
    ) {
      labels.add("source debug");
    }
    if (
      activeApplyRunAbortControllers.size > 0 ||
      activeApplyRunPromises.size > 0
    ) {
      labels.add("application preparation");
    }
    if (
      activeResumeVisionRunIds.size > 0 ||
      activeResumeEvidenceRunIds.size > 0
    ) {
      labels.add("resume analysis");
    }

    return [...labels];
  }

  function trackWorkspaceOperation<T>(
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (workspaceResetInProgress) {
      return Promise.reject(new Error(WORKSPACE_RESET_IN_PROGRESS_MESSAGE));
    }
    if (shutdownPromiseRef.current) {
      return Promise.reject(
        new Error("Job Finder is closing. This operation was not started."),
      );
    }

    activeWorkspaceOperations.set(
      label,
      (activeWorkspaceOperations.get(label) ?? 0) + 1,
    );

    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      const count = activeWorkspaceOperations.get(label) ?? 0;
      if (count <= 1) {
        activeWorkspaceOperations.delete(label);
      } else {
        activeWorkspaceOperations.set(label, count - 1);
      }
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    return result.finally(() => {
      const count = activeWorkspaceOperations.get(label) ?? 0;
      if (count <= 1) {
        activeWorkspaceOperations.delete(label);
      } else {
        activeWorkspaceOperations.set(label, count - 1);
      }
    });
  }

  async function resetWorkspace(
    seed: Parameters<JobFinderWorkspaceService["resetWorkspace"]>[0],
    options?: JobFinderWorkspaceResetOptions,
  ): Promise<JobFinderWorkspaceSnapshot> {
    if (workspaceResetInProgress) {
      throw new Error(WORKSPACE_RESET_IN_PROGRESS_MESSAGE);
    }

    const activeLabels = activeWorkspaceOperationLabels();
    if (activeLabels.length > 0) {
      throw new Error(
        `Job Finder workspace reset is unavailable while ${activeLabels.join(", ")} ${activeLabels.length === 1 ? "is" : "are"} still running. Wait for the operation${activeLabels.length === 1 ? "" : "s"} to finish or cancel it, then try reset again. No workspace data was removed.`,
      );
    }

    workspaceResetInProgress = true;
    invalidateListingReads();
    try {
      // Finish queued document cleanup before Reset moves the managed folder.
      await documentManager.pruneGeneratedResumeFiles?.();
      await options?.beforeStateReset?.();
      return await snapshotProfileMethods.resetWorkspace(seed);
    } finally {
      workspaceResetInProgress = false;
    }
  }

  const context: WorkspaceServiceContext = {
    ...(options.jobSites ? { jobSites: options.jobSites } : {}),
    ...(backgroundWorkReady ? { backgroundWorkReady } : {}),
    ...(resumeDraftProcessor ? { resumeDraftProcessor } : {}),
    aiClient,
    ...(visionProvider ? { visionProvider } : {}),
    browserRuntime,
    ...(candidateAssetResolver ? { candidateAssetResolver } : {}),
    documentManager,
    ...(exportFileVerifier ? { exportFileVerifier } : {}),
    repository,
    ...(options.readSavedAnswers
      ? { readSavedAnswers: options.readSavedAnswers }
      : {}),
    listingAssessmentJobIds: new Set<string>(),
    listingActivityIdentityIndex: createListingActivityIdentityIndex(),
    listingAssessmentGenerationRef: { current: 0 },
    listingAssessmentAbortControllerRef: { current: new AbortController() },
    isWorkspaceClosing: () =>
      workspaceResetInProgress || shutdownPromiseRef.current !== null,
    ...(onListingAssessmentFinished ? { onListingAssessmentFinished } : {}),
    ...(onSavedJobsRescored ? { onSavedJobsRescored } : {}),
    ...(hasRunJobSearch ? { hasRunJobSearch } : {}),
    activeSourceDebugExecutionIdRef,
    activeSourceDebugAbortControllerRef,
    activeSourceDebugPromiseRef,
    activeApplyRunAbortControllers,
    activeApplyRunPromises,
    applyRunTransitionTails,
    markApplicationPreparationStarted,
    withApplicationCrmTransition<T>(operation: () => Promise<T>): Promise<T> {
      const result = applicationCrmTransitionTail.then(operation, operation);
      applicationCrmTransitionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    withIntelligenceTransition<T>(operation: () => Promise<T>): Promise<T> {
      const result = intelligenceTransitionTail.then(operation, operation);
      intelligenceTransitionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    withCampaignTransition<T>(operation: () => Promise<T>): Promise<T> {
      const result = campaignTransitionTail.then(operation, operation);
      campaignTransitionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    activeResumeVisionRunIds,
    activeResumeEvidenceRunIds,
    ...(onResumeEvidenceFinished ? { onResumeEvidenceFinished } : {}),
    ...(onShortlistResumeChanged ? { onShortlistResumeChanged } : {}),
    getWorkspaceSnapshot: () =>
      Promise.reject(new Error("Workspace snapshot method not initialized.")),
    readWorkspaceSnapshot: () =>
      Promise.reject(new Error("Workspace snapshot reader not initialized.")),
    getActiveCampaignId: async () =>
      (await repository.getCampaignState())?.activeCampaignId ?? null,
    runSourceDebugWorkflow: () =>
      Promise.reject(new Error("Source debug workflow not initialized.")),
    persistDiscoveryState: (updater) =>
      repository.commitDiscoveryStateUpdate(updater),
    async refreshDiscoverySessions(
      searchPreferences: JobSearchPreferences,
      knownSessions?: JobFinderDiscoveryState["sessions"],
    ): Promise<JobFinderDiscoveryState["sessions"]> {
      // Every source reads through the same generic adapter (see
      // resolveAdapterKind), so only whether any source is on matters.
      // Normalizing all 900 sources of a large workspace to learn that took
      // about 4 ms of every workspace read.
      const adapterKinds: JobSource[] =
        searchPreferences.discovery.targets.some((target) => target.enabled)
          ? [getPreferredSessionAdapter(searchPreferences)]
          : [];
      if (adapterKinds.length === 0) {
        return [];
      }

      const observedSessions: JobFinderDiscoveryState["sessions"] = [];
      for (const adapterKind of adapterKinds) {
        try {
          observedSessions.push(
            toDiscoverySessionState(
              await browserRuntime.getSessionState(adapterKind),
            ),
          );
        } catch {
          // Keep persisted state when runtime refresh fails.
        }
      }

      if (observedSessions.length === 0) {
        if (knownSessions) return knownSessions;
        const unchanged = await repository.getDiscoveryState();
        return unchanged.sessions;
      }

      // Every workspace refresh lands here. Rewriting the whole discovery
      // state when the browser reports what is already stored made each
      // refresh during a search write megabytes for nothing.
      if (
        knownSessions &&
        isDeepStrictEqual(
          observedSessions.reduce(
            (sessions, observation) =>
              mergeSessionStates(sessions, observation),
            knownSessions,
          ),
          knownSessions,
        )
      ) {
        return knownSessions;
      }

      const merge = (current: JobFinderDiscoveryState["sessions"]) =>
        observedSessions.reduce(
          (sessions, observation) => mergeSessionStates(sessions, observation),
          current,
        );
      if (repository.commitDiscoverySessions) {
        return repository.commitDiscoverySessions(merge);
      }
      const next = await context.persistDiscoveryState((current) => ({
        ...current,
        sessions: merge(current.sessions),
      }));
      return next.sessions;
    },
    saveJobSiteMetadata(targetId, updater) {
      return Promise.resolve().then(() => {
        const site = options.jobSites?.get(Number(targetId));
        if (!site || !options.jobSites)
          throw new Error(`Unknown job site '${targetId}'.`);
        const next = updater(jobSiteTarget(site));
        const saved = options.jobSites.record(site.id, {
          instructionStatus: next.instructionStatus,
          validatedInstructionId: next.validatedInstructionId,
          draftInstructionId: next.draftInstructionId,
          lastDebugRunId: next.lastDebugRunId,
          lastVerifiedAt: next.lastVerifiedAt,
          staleReason: next.staleReason,
        });
        return jobSiteTarget(saved!);
      });
    },
    async persistSourceDebugRun(run: SourceDebugRunRecord): Promise<void> {
      await repository.upsertSourceDebugRun(run);
      await context.persistDiscoveryState((current) => ({
        ...current,
        activeSourceDebugRun:
          run.state === "running" || run.state === "paused_manual"
            ? run
            : current.activeSourceDebugRun?.id === run.id
              ? null
              : current.activeSourceDebugRun,
        recentSourceDebugRuns: [
          run,
          ...current.recentSourceDebugRuns.filter(
            (entry) => entry.id !== run.id,
          ),
        ].slice(0, SOURCE_DEBUG_RECENT_HISTORY_LIMIT),
      }));
      await persistDiscoveryLoginUserAction({ repository, run });
    },
    async persistBrowserSessionState(
      session: Awaited<ReturnType<BrowserSessionRuntime["openSession"]>>,
    ): Promise<void> {
      await context.persistDiscoveryState((current) => ({
        ...current,
        sessions: mergeSessionStates(
          current.sessions,
          toDiscoverySessionState(session),
        ),
      }));
    },
    async staleApprovedResumeDrafts(
      staleReason: string,
      jobIds?: readonly string[],
      profileInputs?: Parameters<
        NonNullable<JobFinderRepository["staleResumeDrafts"]>
      >[0]["profileInputs"],
    ): Promise<void> {
      // The cached display rows, when the repository keeps them: every
      // draft holds whole resumes, and parsing them all again made each
      // profile save half a second slower. Each write below is a new value.
      const display = await repository.readDisplayCollections?.();
      const [drafts, tailoredAssets, applicationRecords] = await Promise.all([
        display?.resumeDrafts ?? repository.listResumeDrafts(),
        display?.tailoredAssets ?? repository.listTailoredAssets(),
        display?.applicationRecords ?? repository.listApplicationRecords(),
      ]);

      const targetJobIds = jobIds ? new Set(jobIds) : null;

      const submittedJobIds = new Set(
        applicationRecords
          .filter((record) => record.status === "submitted")
          .map((record) => record.jobId),
      );
      const toStale: {
        draft: (typeof drafts)[number];
        existingAsset: (typeof tailoredAssets)[number] | null;
      }[] = [];
      for (const draft of drafts) {
        if (submittedJobIds.has(draft.jobId)) continue;

        if (targetJobIds && !targetJobIds.has(draft.jobId)) {
          continue;
        }

        const existingAsset =
          tailoredAssets.find((asset) => asset.jobId === draft.jobId) ?? null;
        // Already stale for this reason, with nothing approved and no file
        // kept: staling it again would only rewrite it with a new time.
        if (
          draft.status === "stale" &&
          draft.staleReason === staleReason &&
          draft.approvedAt === null &&
          draft.approvedExportId === null &&
          (existingAsset === null || existingAsset.storagePath === null)
        ) {
          continue;
        }
        toStale.push({ draft, existingAsset });
      }
      if (toStale.length === 0 && !profileInputs) return;
      // Only the approval fields change, so a repository that can mark them
      // in place does so in one transaction. Reading, validating and writing
      // each whole draft again held a profile save for about 1.5 s.
      if (repository.staleResumeDrafts) {
        await repository.staleResumeDrafts({
          draftIds: toStale.map(({ draft }) => draft.id),
          staleReason,
          updatedAt: new Date().toISOString(),
          ...(profileInputs ? { profileInputs } : {}),
        });
        return;
      }
      for (const { draft, existingAsset } of toStale) {
        const staleDraft = buildStaleResumeDraft(draft, staleReason);

        await repository.clearResumeApproval({
          draft: staleDraft,
          staleReason,
          tailoredAsset: existingAsset
            ? {
                ...existingAsset,
                storagePath: null,
                updatedAt: staleDraft.updatedAt,
              }
            : null,
        });
      }
      if (profileInputs) {
        if (profileInputs.searchPreferences)
          await repository.saveProfileAndSearchPreferences(
            profileInputs.profile,
            profileInputs.searchPreferences,
          );
        else await repository.saveProfile(profileInputs.profile);
      }
    },
    async openRunBrowserSession(
      source: JobSource,
      options?: OpenBrowserSessionOptions,
    ): Promise<void> {
      const session = await browserRuntime.openSession(source, options);
      await context.persistBrowserSessionState(session);
    },
    async closeRunBrowserSession(source: JobSource): Promise<void> {
      if (
        await hasLiveUnresolvedApplicationPage({
          browserRuntime,
          repository,
          source,
        })
      ) {
        return;
      }
      const session = await browserRuntime.closeSession(source);
      await context.persistBrowserSessionState(session);
    },
    async closeParkedBrowserTab(source, tab): Promise<void> {
      await browserRuntime.closeParkedTab?.(source, tab);
    },
    async resumeActivityForExplicitStart(): Promise<void> {
      await requireActivityEnabled();
    },
    hasActiveBrowserWorkflow: () =>
      activeSourceDebugAbortControllerRef.current !== null ||
      activeSourceDebugPromiseRef.current !== null ||
      activeApplyRunAbortControllers.size > 0 ||
      activeApplyRunPromises.size > 0,
    async updateJob(
      jobId: string,
      updater: (job: SavedJob) => SavedJob,
    ): Promise<void> {
      let found = false;

      await repository.commitSavedJobDelta({
        updateJobIds: [jobId],
        update: (job) => {
          if (job.id !== jobId) {
            return job;
          }

          found = true;
          const updatedJob = SavedJobSchema.parse(updater(job));
          if (updatedJob.id !== jobId) {
            throw new Error("Saved job updates must preserve the job id.");
          }
          return updatedJob;
        },
        clearResumeApproval: {
          jobId,
          staleReason:
            "Saved job details changed after approval and the resume needs a fresh review.",
          shouldClear: (previousJob, nextJob) =>
            hasResumeAffectingJobChange(previousJob, nextJob),
        },
      });

      if (!found) {
        throw new Error(`Unknown Job Finder job '${jobId}'.`);
      }
    },
    ...(researchAdapter ? { researchAdapter } : {}),
    ...(fetchListingHtml ? { fetchListingHtml } : {}),
  };

  const { discoveryRecoveryReady, ...snapshotProfileMethods } =
    createWorkspaceSnapshotProfileMethods(context);
  const assistantEditMethods = createWorkspaceAssistantEditMethods({
    ctx: context,
    applyAssistantProfilePatchGroup:
      snapshotProfileMethods.applyAssistantProfilePatchGroup,
    commitResumeApplicationMode: async (resumeApplicationMode) => {
      await snapshotProfileMethods.updateApplicationDefaults({
        resumeApplicationMode,
      });
    },
    saveSettings: (settings) => snapshotProfileMethods.saveSettings(settings),
  });
  const applicationMethods = createWorkspaceApplicationMethods(context);
  const userActionMethods = createWorkspaceUserActionMethods(context);
  let userActionRecoveryPromise: Promise<void> | null = null;

  async function resumeVerifyingUserActions(): Promise<void> {
    if (!userActionRecoveryPromise) {
      userActionRecoveryPromise =
        userActionMethods.resumeVerifyingUserActions();
    }
    const recovery = userActionRecoveryPromise;

    try {
      await recovery;
    } finally {
      if (userActionRecoveryPromise === recovery) {
        userActionRecoveryPromise = null;
      }
    }
  }


  async function readDisplayProjection() {
    return (
      (await snapshotProfileMethods.getWorkspaceProjection?.()) ??
      snapshotProfileMethods.getWorkspaceSnapshot()
    );
  }

  async function getWorkspaceSnapshot(borrowValidatedJobs = false) {
    await waitForUserActionRecovery();
    return borrowValidatedJobs
      ? readDisplayProjection()
      : snapshotProfileMethods.getWorkspaceSnapshot();
  }

  async function waitForUserActionRecovery() {
    // Recovery starts or joins the continuation of every verifying step, and
    // a continuation drives the browser for minutes. Quick verifications
    // still land in this snapshot; a long continuation carries on in the
    // background instead of holding every read (the app showed "Loading your
    // workspace" for as long as the agent worked).
    const alreadyRecovering = userActionRecoveryPromise !== null;
    const recovery = workspaceResetInProgress
      ? Promise.resolve()
      : resumeVerifyingUserActions();
    recovery.catch((error: unknown) => {
      console.error(
        "[user-actions] recovery of a verifying step failed",
        error,
      );
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (!alreadyRecovering)
      await Promise.race([
        recovery,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, SNAPSHOT_RECOVERY_WAIT_MS);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  async function getWorkspaceBootstrap() {
    return snapshotProfileMethods.getWorkspaceBootstrap();
  }

  async function getWorkspaceHomeSnapshot() {
    await waitForUserActionRecovery();
    return (await snapshotProfileMethods.getWorkspaceHomeSnapshot?.()) ?? null;
  }

  // Mutation results are display reads. Canonical snapshots stay available
  // through the public reader and readWorkspaceSnapshot; they retain checkpoints.
  context.getWorkspaceSnapshot = () => getWorkspaceSnapshot(true);
  context.readWorkspaceSnapshot = () =>
    snapshotProfileMethods.getWorkspaceSnapshot();
  context.readWorkspaceProjection = readDisplayProjection;

  const sourceDebugMethods = createWorkspaceSourceDebugMethods(context);
  context.runSourceDebugWorkflow = sourceDebugMethods.runSourceDebugWorkflow;
  /**
   * Explicit user actions (Search now, Check source, Prepare, opening the
   * browser) resume paused background work instead of failing. The pause is
   * raised when the person takes the browser over or presses Pause; their next
   * deliberate click is the clearest signal they are ready to continue, and
   * "press Resume on Home first" was a dead end in the Profile footer.
   * Scheduled runs never come through here; they keep obeying the pause.
   */
  async function requireActivityEnabled(): Promise<void> {
    if ((await repository.getActivityControl()).paused) {
      await commitActivityControl({ paused: false });
    }
    await onExplicitUserStart?.();
  }







  async function markApplicationPreparationStarted(
    input: { resultId: string; runId: string; jobId: string },
    token?: ApplicationPreparationCapacityToken,
  ): Promise<ApplyJobResult> {
    return withPreparationCapacityTransition(repository, async () => {
      const current = (
        await repository.listApplyJobResults({
          runId: input.runId,
          jobId: input.jobId,
        })
      ).find((result) => result.id === input.resultId);
      if (!current) {
        throw new Error(`Unknown apply result '${input.resultId}'.`);
      }
      if (current.applicationPreparationStartedAt) {
        return current;
      }

      const now = new Date();
      const startedAt = now.toISOString();
      const startedLocalDate = localDateKey(now);
      if (token) {
        if (token.remainingJobs <= 0) {
          throw new Error(
            "Application preparation capacity token is exhausted.",
          );
        }
        token.remainingJobs -= 1;
      }
      const marked = await repository.markApplicationPreparationStarted({
        ...input,
        startedAt,
        startedLocalDate,
      });
      return marked.result;
    });
  }



  async function commitActivityControl(
    rawInput: SetJobFinderActivityControlInput,
  ) {
    const input = SetJobFinderActivityControlInputSchema.parse(rawInput);
    const previousControl = await repository.getActivityControl();
    const now = new Date().toISOString();
    const control = JobFinderActivityControlSchema.parse({
      paused: input.paused,
      pausedAt: input.paused ? now : null,
      reason: input.paused ? (input.reason ?? null) : null,
      ...(input.paused && input.pauseBehavior
        ? { pauseBehavior: input.pauseBehavior }
        : {}),
    });
    await repository.saveActivityControl(control);
    await onActivityControlChanged?.(control);
    // Browser takeover and Pause stop a running source check at once.
    if (input.paused && input.pauseBehavior !== "finish_current") {
      activeSourceDebugAbortControllerRef.current?.abort();
      await Promise.allSettled(
        [activeSourceDebugPromiseRef.current].filter(
          (value): value is Promise<unknown> => value != null,
        ),
      );
    } else if (previousControl.paused) {
      // Startup may have checked verifying actions while the workspace was
      // paused and cached that completed no-op recovery promise. An explicit
      // Resume is a new recovery boundary: clear the cached startup pass so
      // the snapshot below immediately processes the already-persisted
      // verifying actions instead of waiting for another app restart.
      userActionRecoveryPromise = null;
    }
  }
  async function setActivityControl(
    rawInput: SetJobFinderActivityControlInput,
  ) {
    await commitActivityControl(rawInput);
    return getWorkspaceSnapshot();
  }

  function describeShutdownFailure(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }

  async function shutdown(): Promise<void> {
    if (shutdownPromiseRef.current) {
      return shutdownPromiseRef.current;
    }

    shutdownPromiseRef.current = (async () => {
      invalidateListingReads();
      activeSourceDebugAbortControllerRef.current?.abort();
      await Promise.allSettled(
        [activeSourceDebugPromiseRef.current].filter(
          (value): value is Promise<unknown> => value != null,
        ),
      );

      const shutdownResults = await Promise.allSettled([
        ...(resumeDraftProcessor ? [resumeDraftProcessor.close()] : []),
        // Session kinds come from the runtime contract. Reading discovery
        // history just to close its sessions copies a large workspace at quit.
        ...jobSourceValues.map((source) => browserRuntime.closeSession(source)),
        repository.close(),
      ]);
      const rejectedResults = shutdownResults.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (rejectedResults.length > 0) {
        console.warn(
          "[JobFinderWorkspace] Shutdown completed with failures",
          rejectedResults.map((result) =>
            describeShutdownFailure(result.reason),
          ),
        );
      }
    })();

    return shutdownPromiseRef.current;
  }

  return {
    shutdown,
    ...snapshotProfileMethods,
    saveProfile: (profile) =>
      trackWorkspaceOperation("profile save", () =>
        snapshotProfileMethods.saveProfile(profile),
      ),
    saveProfileAndSearchPreferences: (profile, preferences) =>
      trackWorkspaceOperation("profile save", () =>
        snapshotProfileMethods.saveProfileAndSearchPreferences(
          profile,
          preferences,
        ),
      ),
    resetWorkspace,
    runResumeImport: (input) =>
      trackWorkspaceOperation("resume import", () =>
        snapshotProfileMethods.runResumeImport(input),
      ),
    analyzeProfileFromResume: () =>
      trackWorkspaceOperation("resume analysis", () =>
        snapshotProfileMethods.analyzeProfileFromResume(),
      ),
    sendProfileCopilotMessage: (content, context) =>
      trackWorkspaceOperation("profile proposal", () =>
        snapshotProfileMethods.sendProfileCopilotMessage(content, context),
      ),
    proposeProfileCopilotChange: (content, context) =>
      trackWorkspaceOperation("profile proposal", () =>
        snapshotProfileMethods.proposeProfileCopilotChange(content, context),
      ),
    applyProfileCopilotPatchGroup: (patchGroupId) =>
      trackWorkspaceOperation("profile proposal", () =>
        snapshotProfileMethods.applyProfileCopilotPatchGroup(patchGroupId),
      ),
    rejectProfileCopilotPatchGroup: (patchGroupId) =>
      trackWorkspaceOperation("profile proposal", () =>
        snapshotProfileMethods.rejectProfileCopilotPatchGroup(patchGroupId),
      ),
    undoProfileRevision: (revisionId) =>
      trackWorkspaceOperation("profile proposal", () =>
        snapshotProfileMethods.undoProfileRevision(revisionId),
      ),
    openBrowserSession: async (input) => {
      await requireActivityEnabled();
      return snapshotProfileMethods.openBrowserSession(input);
    },
    setActivityControl,
    getWorkspaceSnapshot: () =>
      workspaceResetInProgress
        ? getWorkspaceSnapshot()
        : trackWorkspaceOperation("workspace read", () =>
            getWorkspaceSnapshot(),
          ),
    getWorkspaceProjection: () =>
      workspaceResetInProgress
        ? getWorkspaceSnapshot(true)
        : trackWorkspaceOperation("workspace projection", () =>
            getWorkspaceSnapshot(true),
          ),
    getWorkspaceBootstrap,
    getWorkspaceHomeSnapshot,
    ...sourceDebugMethods,
    runSourceDebug: (targetId, signal, onProgress) =>
      trackWorkspaceOperation("source debug", async () => {
        await requireActivityEnabled();
        await discoveryRecoveryReady;
        return sourceDebugMethods.runSourceDebug(targetId, signal, onProgress);
      }),
    verifySourceInstructions: (targetId, instructionId, signal, onProgress) =>
      trackWorkspaceOperation("source debug", async () => {
        await requireActivityEnabled();
        return sourceDebugMethods.verifySourceInstructions(
          targetId,
          instructionId,
          signal,
          onProgress,
        );
      }),
    performUserAction: (command) =>
      trackWorkspaceOperation("application user action", () =>
        userActionMethods.performUserAction(command),
      ),
    ...applicationMethods,
    queueJobForReview: (jobId) =>
      trackWorkspaceOperation("shortlisting jobs", () =>
        applicationMethods.queueJobForReview(jobId),
      ),
    queueJobsForReview: (jobIds) =>
      trackWorkspaceOperation("shortlisting jobs", () =>
        applicationMethods.queueJobsForReview!(jobIds),
      ),
    applyAssistantProfileOperations: (request) =>
      trackWorkspaceOperation("profile proposal", () =>
        assistantEditMethods.applyAssistantProfileOperations(request),
      ),
    undoAssistantProfileChange: (request) =>
      trackWorkspaceOperation("profile proposal", () =>
        assistantEditMethods.undoAssistantProfileChange(request),
      ),
    undoAssistantSettingsChange:
      assistantEditMethods.undoAssistantSettingsChange,
    undoAssistantResumeChange: assistantEditMethods.undoAssistantResumeChange,
    addJobFromBrowserPage: (input) =>
      trackWorkspaceOperation("discovery", () =>
        addJobFromBrowserPage(context, input),
      ),
    extractJobsFromPageText: (input) => extractJobsFromPageText(context, input),
    saveJobsFromPage: (input) =>
      trackWorkspaceOperation("discovery", () =>
        saveJobsFromPage(context, input),
      ),
  };
}
