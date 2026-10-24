import { clearResumeBatchLiveness } from "./internal/resume-batch-checkpoint";
import { createListingActivityIdentityIndex } from "./internal/listing-activity-identity-index";
import type {
  BrowserSessionRuntime,
  OpenBrowserSessionOptions,
} from "@nestor/browser-runtime";
import { addJobFromBrowserPage } from "./internal/workspace-browser-job";
import { writeApplicationDocumentText } from "./internal/application-document-writer";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { recordApplicationsSentByPerson } from "./internal/application-sent-by-person";
import { judgeUnjudgedPlanJobs } from "./internal/backlog-fit-judgment";
import { refreshAutomaticApplicationFailurePauses } from "./internal/automatic-safeguards";
import type { JobFinderRepository } from "@nestor/db";
import type {
  JobFinderDiscoveryCommandReply,
  JobFinderDiscoveryCancellationReply,
} from "@nestor/contracts";
import {
  ACTIVITY_PAUSED_MESSAGE,
  ApplicationRecordSchema,
  JobFinderDiscoveryCancellationInputSchema,
  JobFinderActivityControlSchema,
  JobSearchCampaignCollectionSchema,
  SetJobFinderActivityControlInputSchema,
  jobSourceValues,
  SavedJobSchema,
  type ApplyJobResult,
  type ApplyRun,
  type ApplicationAutomationMode,
  type JobFinderDiscoveryState,
  type JobFinderWorkspaceSnapshot,
  type FitJudgmentProgress,
  type JobDiscoveryTarget,
  type JobSearchCampaign,
  type JobSearchPreferences,
  type JobSource,
  type SavedJob,
  type SetJobFinderActivityControlInput,
  type SourceDebugRunRecord,
} from "@nestor/contracts";
import { mergeSessionStates } from "./internal/workspace-service-helpers";
import {
  getPreferredSessionAdapter,
  updateDiscoveryTarget,
} from "./internal/workspace-helpers";
import { SOURCE_DEBUG_RECENT_HISTORY_LIMIT } from "./internal/workspace-defaults";
import type {
  ApplicationPreparationCapacityToken,
  WorkspaceServiceContext,
} from "./internal/workspace-service-context";
import {
  buildStaleResumeDraft,
  hasResumeAffectingJobChange,
} from "./internal/resume-workspace-staleness";
import {
  type CampaignRunContext,
  type CreateJobFinderWorkspaceServiceOptions,
  type JobFinderWorkspaceService,
  type JobFinderWorkspaceResetOptions,
} from "./internal/workspace-service-contracts";
import { createWorkspaceSnapshotProfileMethods } from "./internal/workspace-snapshot-profile-methods";
import { createWorkspaceAssistantEditMethods } from "./internal/workspace-assistant-edit-methods";
import { runResumeRevisionSpecialist } from "./internal/workspace-assistant-resume-specialist";
import {
  extractJobsFromPageText,
  saveJobsFromPage,
} from "./internal/workspace-assistant-page-jobs";
import { createWorkspaceDiscoveryMethods } from "./internal/workspace-discovery-methods";
import { createWorkspaceSourceDebugMethods } from "./internal/workspace-source-debug-methods";
import { createWorkspaceApplicationMethods } from "./internal/workspace-application-methods";
import { createWorkspaceApplyRunStoreMethods } from "./internal/workspace-apply-run-store-methods";
import {
  recoverInterruptedApplyJobResult,
  recoverInterruptedApplyRun,
  recoverInterruptedExactLineageProjections,
  isSafelyParkedApplyQueue,
} from "./internal/workspace-apply-run-recovery";
import { createWorkspaceApplicationAnswerMethods } from "./internal/workspace-application-answer-methods";
import { createWorkspaceGroupedAnswerMethods } from "./internal/workspace-grouped-answer-methods";
import { createWorkspaceCrmMethods } from "./internal/workspace-crm-methods";
import { createWorkspaceIntelligenceMethods } from "./internal/workspace-intelligence-methods";
import { createWorkspaceSafeguardMethods } from "./internal/workspace-safeguard-methods";
import {
  createWorkspaceUserActionMethods,
  isWorkspaceActivityPaused,
} from "./internal/workspace-user-action-methods";
import { toDiscoverySessionState } from "./internal/discovery-state";
import { uniqueStrings } from "./internal/shared";
import { buildDiscoveryJobs } from "./internal/matching-review-queue";
import { persistDiscoveryLoginUserAction } from "./internal/workspace-source-user-action";
import {
  createWorkspaceCampaignMethods,
  recordCampaignDiscoveryResult,
} from "./internal/workspace-campaign-methods";
import {
  assertCampaignCanRun,
  searchPreferencesForCampaignRun,
} from "./internal/campaign-dashboard";
import { ensureCampaignState } from "./internal/campaign-dashboard";
import {
  deriveGlobalDailyApplicationPreparationCapacity,
  localDateKey,
  MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY,
  MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN,
} from "./internal/application-preparation-capacity";

const applicationPageOwningStates = new Set<ApplyJobResult["state"]>([
  "question_capture",
  "filling",
  "awaiting_review",
  "submitting",
  "blocked",
]);

/** One turn of the event loop, so pending window messages are served. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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
  CreateJobFinderWorkspaceServiceOptions,
  CandidateAssetResolver,
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
import { readSavedJob } from "./internal/read-saved-job";

export {
  MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY,
  MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN,
  deriveGlobalDailyApplicationPreparationCapacity,
} from "./internal/application-preparation-capacity";

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
    onDetachedApplyRunFinished,
    onResumeEvidenceFinished,
    onShortlistResumeChanged,
    onListingAssessmentFinished,
    onSavedJobsRescored,
    onExplicitUserStart,
  } = options;
  const activeDiscoveryAbortControllerRef = {
    current: null as AbortController | null,
  };
  const activeDiscoveryRunIdRef = { current: null as string | null };
  const fitJudgmentProgressRef = {
    current: null as FitJudgmentProgress | null,
  };
  let fitJudgmentAbortController: AbortController | null = null;
  const activeDiscoveryPromiseRef = {
    current: null as Promise<unknown> | null,
  };
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
      activeDiscoveryAbortControllerRef.current ||
      activeDiscoveryPromiseRef.current
    ) {
      labels.add("discovery");
    }
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
    ...(backgroundWorkReady ? { backgroundWorkReady } : {}),
    ...(resumeDraftProcessor ? { resumeDraftProcessor } : {}),
    aiClient,
    ...(visionProvider ? { visionProvider } : {}),
    browserRuntime,
    ...(candidateAssetResolver ? { candidateAssetResolver } : {}),
    documentManager,
    ...(exportFileVerifier ? { exportFileVerifier } : {}),
    repository,
    listingAssessmentJobIds: new Set<string>(),
    listingActivityIdentityIndex: createListingActivityIdentityIndex(),
    listingAssessmentGenerationRef: { current: 0 },
    listingAssessmentAbortControllerRef: { current: new AbortController() },
    isWorkspaceClosing: () =>
      workspaceResetInProgress || shutdownPromiseRef.current !== null,
    fitJudgmentProgressRef,
    ...(onListingAssessmentFinished ? { onListingAssessmentFinished } : {}),
    ...(onSavedJobsRescored ? { onSavedJobsRescored } : {}),
    activeDiscoveryAbortControllerRef,
    activeDiscoveryRunIdRef,
    activeDiscoveryPromiseRef,
    activeSourceDebugExecutionIdRef,
    activeSourceDebugAbortControllerRef,
    activeSourceDebugPromiseRef,
    activeApplyRunAbortControllers,
    activeApplyRunPromises,
    applyRunTransitionTails,
    markApplicationPreparationStarted,
    requireApplicationSafeguardClearance: () =>
      Promise.reject(new Error("Application safeguard gate not initialized.")),
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
    resumeApplicationUserAction: () =>
      Promise.reject(
        new Error("Application user action resumer not initialized."),
      ),
    continueDiscoveryForSource: () =>
      Promise.reject(
        new Error("Discovery source continuation not initialized."),
      ),
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
    async saveDiscoveryTargetUpdate(
      targetId: string,
      updater: (target: JobDiscoveryTarget) => JobDiscoveryTarget,
    ): Promise<JobSearchPreferences> {
      // Source-debug target metadata (validated-guidance pointers and run/verify
      // stamps) must stay visible to the active campaign's runs and survive
      // plan switches, so the update is applied inside one serialized atomic
      // commit that mirrors the changed target into both the global search
      // preferences and the active campaign's stored preferences. Plan
      // selects/saves serialize on the same campaign transition, so neither
      // side can clobber the other or leave the active pointer paired with
      // preferences that miss this update.
      return context.withCampaignTransition(async () => {
        const campaignState = await repository.getCampaignState();
        if (!campaignState) {
          // No collection exists yet, so there is nothing to mirror; every
          // collection creator holds this same transition and therefore none
          // can appear between this read and the write below.
          const searchPreferences = await repository.getSearchPreferences();
          const nextSearchPreferences = updateDiscoveryTarget(
            searchPreferences,
            targetId,
            updater,
          );
          await repository.saveSearchPreferences(nextSearchPreferences);
          return nextSearchPreferences;
        }
        return repository.commitCampaignPreferencesUpdate((current) => {
          const state = current.campaignState;
          if (!state) {
            throw new Error("Campaign state is unavailable.");
          }
          const nextSearchPreferences = updateDiscoveryTarget(
            current.searchPreferences,
            targetId,
            updater,
          );
          const now = new Date().toISOString();
          const nextState = JobSearchCampaignCollectionSchema.parse({
            ...state,
            campaigns: state.campaigns.map((campaign) =>
              campaign.id === state.activeCampaignId &&
              campaign.searchPreferences.discovery.targets.some(
                (candidate) => candidate.id === targetId,
              )
                ? {
                    ...campaign,
                    searchPreferences: nextSearchPreferences,
                    sourceTargetIds: nextSearchPreferences.discovery.targets
                      .filter((target) => target.enabled)
                      .map((target) => target.id),
                    updatedAt: now,
                  }
                : campaign,
            ),
          });
          return {
            result: nextSearchPreferences,
            campaignState: nextState,
            searchPreferences: nextSearchPreferences,
          };
        });
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
      activeDiscoveryAbortControllerRef.current !== null ||
      activeDiscoveryPromiseRef.current !== null ||
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

  const snapshotProfileMethods = createWorkspaceSnapshotProfileMethods(context);
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
  context.resumeApplicationUserAction = (request, taskLocalCredentials) =>
    applicationMethods.resumeApplicationUserAction(
      request,
      taskLocalCredentials,
    );
  const userActionMethods = createWorkspaceUserActionMethods(context);
  let userActionRecoveryPromise: Promise<void> | null = null;
  let unjudgedJobsJudging: Promise<JobFinderWorkspaceSnapshot> | null = null;

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

  async function resumeVerifyingUserActionsAfterCommit(): Promise<void> {
    // A grouped apply commits verifying request transitions after an earlier
    // snapshot may already have completed a recovery run, so the cached
    // recovery promise must not suppress this fresh resume. Concurrent
    // callers share this single in-flight recovery run, and a crash between
    // the grouped commit and this resume still recovers on the next restart
    // because the recovery promise is only ever held in memory.
    const recovery = userActionMethods.resumeVerifyingUserActions();
    userActionRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (userActionRecoveryPromise === recovery) {
        userActionRecoveryPromise = null;
      }
    }
  }

  async function cancelDiscoveryRunCommand(
    runId: string,
  ): Promise<JobFinderDiscoveryCancellationReply> {
    const input = JobFinderDiscoveryCancellationInputSchema.parse({ runId });
    const requestedAt = new Date().toISOString();
    let accepted = false;
    await context.persistDiscoveryState((current) => {
      if (
        current.activeRun?.id !== input.runId ||
        current.activeRun.state !== "running"
      )
        return current;
      accepted = true;
      return {
        ...current,
        activeRun: {
          ...current.activeRun,
          cancellationRequestedAt:
            current.activeRun.cancellationRequestedAt ?? requestedAt,
        },
      };
    });
    // The live identity reaches the window before the first durable run row.
    if (activeDiscoveryRunIdRef.current === input.runId) accepted = true;
    if (accepted) activeDiscoveryAbortControllerRef.current?.abort();
    return { runId: input.runId, accepted };
  }

  let lastDisplayProjection: JobFinderWorkspaceSnapshot | undefined;
  let runningDiscoveryCommands = 0;
  async function readDisplayProjection() {
    // Query screens follow committed rows. Legacy readers can retain their
    // last complete view while search writes, rather than rebuilding it per beat.
    if (
      lastDisplayProjection &&
      (runningDiscoveryCommands > 0 ||
        activeDiscoveryAbortControllerRef.current)
    )
      return lastDisplayProjection;
    lastDisplayProjection =
      await (snapshotProfileMethods.getWorkspaceProjection?.() ??
        snapshotProfileMethods.getWorkspaceSnapshot());
    return lastDisplayProjection;
  }

  async function getWorkspaceSnapshot(borrowValidatedJobs = false) {
    if (
      borrowValidatedJobs &&
      lastDisplayProjection &&
      (runningDiscoveryCommands > 0 ||
        activeDiscoveryAbortControllerRef.current)
    )
      return lastDisplayProjection;
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
  const crmMethods = createWorkspaceCrmMethods({
    ctx: context,
    getWorkspaceSnapshot: () => getWorkspaceSnapshot(true),
  });
  const intelligenceMethods = createWorkspaceIntelligenceMethods({
    ctx: context,
    getWorkspaceSnapshot: () => getWorkspaceSnapshot(true),
    callbacks: {
      shortlist: applicationMethods.queueJobForReview,
      reject: (jobId) =>
        applicationMethods.dismissDiscoveryJob({
          jobId,
          reasons: ["other"],
          action: "hide_job",
        }),
      restore: async (jobId) => {
        const job = await readSavedJob(repository, jobId);
        if (job?.status === "archived") {
          await applicationMethods.restoreDismissedDiscoveryJob(jobId);
        } else if (job && job.status !== "discovered") {
          await applicationMethods.removeJobFromReview(jobId);
        }
      },
    },
  });
  const safeguardMethods = createWorkspaceSafeguardMethods({
    ctx: context,
    getWorkspaceSnapshot: () => getWorkspaceSnapshot(true),
  });
  context.requireApplicationSafeguardClearance = async (jobIds, savedJobs) => {
    await refreshAutomaticApplicationFailurePauses({
      ctx: context,
      now: new Date().toISOString(),
    });
    const blockers =
      await safeguardMethods.evaluateApplicationPreparationBlockers(
        jobIds,
        savedJobs,
      );
    // The failure-rate pause asks the person to look at the failed attempts
    // and retry them. Their Try again for exactly those jobs is that retry,
    // so the pause must not refuse it (it pointed back at Applications in a
    // loop); new jobs still wait until the pause lifts or is dismissed.
    const retriesFailedJobsOnly = await startRetriesOnlyFailedJobs(jobIds);
    safeguardMethods.requireNoBlockers(
      retriesFailedJobsOnly
        ? blockers.filter(
            (blocker) => blocker.kind !== "abnormal_failure_pause",
          )
        : blockers,
    );
  };
  async function startRetriesOnlyFailedJobs(
    jobIds: readonly string[],
  ): Promise<boolean> {
    if (jobIds.length === 0) return false;
    const results = await context.repository.listApplyJobResults();
    // The retry's own queued placeholder is not an attempt yet; read the
    // last attempt that actually ran.
    return jobIds.every((jobId) => {
      const latest = results
        .filter(
          (result) => result.jobId === jobId && result.state !== "planned",
        )
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .at(0);
      return latest?.state === "failed";
    });
  }

  const sourceDebugMethods = createWorkspaceSourceDebugMethods(context);
  context.runSourceDebugWorkflow = sourceDebugMethods.runSourceDebugWorkflow;
  const discoveryMethods = createWorkspaceDiscoveryMethods(context);
  const campaignMethods = createWorkspaceCampaignMethods({
    ctx: context,
    getWorkspaceSnapshot: () => getWorkspaceSnapshot(true),
    runCampaignDiscovery: async (campaignContext, onActivity) => {
      await requireDiscoverySafeguardClearance();
      return discoveryMethods.runCampaignDiscovery(campaignContext, onActivity);
    },
    afterCampaignRun: () => intelligenceMethods.refreshCompanyIntelligence(),
  });

  function runCampaignScopedDiscovery(
    executor: (
      campaign: CampaignRunContext,
    ) => Promise<JobFinderDiscoveryCommandReply>,
    requestedCampaignId: string | undefined,
    options: { commandOnly: true },
  ): Promise<JobFinderDiscoveryCommandReply>;
  function runCampaignScopedDiscovery(
    executor: (
      campaign: CampaignRunContext,
    ) => Promise<JobFinderWorkspaceSnapshot>,
    requestedCampaignId?: string,
    options?: { nestedUserActionRecovery?: boolean },
  ): Promise<JobFinderWorkspaceSnapshot>;
  async function runCampaignScopedDiscovery(
    executor: (
      campaign: CampaignRunContext,
    ) => Promise<JobFinderWorkspaceSnapshot | JobFinderDiscoveryCommandReply>,
    requestedCampaignId?: string,
    options: { nestedUserActionRecovery?: boolean; commandOnly?: boolean } = {},
  ) {
    await requireDiscoverySafeguardClearance();
    let campaignState = await repository.getCampaignState();
    if (!campaignState && requestedCampaignId) {
      throw new Error("This search plan was removed; run the plan again");
    }
    if (!campaignState) {
      // The stale missing-read only nominates this path: state is re-read
      // inside one campaign transition and the default is created only if it
      // is still absent, so a concurrently created or mutated collection can
      // never be overwritten by an unlocked bootstrap.
      campaignState = await context.withCampaignTransition(async () => {
        const latestState = await repository.getCampaignState();
        if (latestState) return latestState;
        return ensureCampaignState({
          repository,
          searchPreferences: await repository.getSearchPreferences(),
        });
      });
    }
    const campaignId = requestedCampaignId ?? campaignState.activeCampaignId;
    const campaign = campaignState.campaigns.find(
      (candidate) => candidate.id === campaignId,
    );
    if (!campaign) {
      throw new Error(
        requestedCampaignId
          ? "This search plan was removed; run the plan again"
          : "The active job search campaign is unavailable.",
      );
    }
    assertCampaignCanRun(campaign);
    const result = await executor({
      campaignId: campaign.id,
      mode: campaign.mode,
      searchPreferences: searchPreferencesForCampaignRun(campaign),
      runJobBudget: campaign.limits.discoveryRunJobBudget ?? null,
    });
    // The steps that close a search each take a while on a large workspace
    // and none of them waits on anything outside main, so together they held
    // main (and every window) for seconds at once. A turn of the event loop
    // between them lets the window's messages through.
    await yieldToEventLoop();
    await recordCampaignDiscoveryResult({
      ctx: context,
      campaignId,
      beforeCampaignJobIds: campaign.jobIds,
    });
    await yieldToEventLoop();
    if (options.commandOnly) {
      await intelligenceMethods.refreshCompanyIntelligenceState();
      return result;
    }
    if (options.nestedUserActionRecovery) {
      await intelligenceMethods.refreshCompanyIntelligenceState();
      return context.readWorkspaceSnapshot();
    }
    return intelligenceMethods.refreshCompanyIntelligence();
  }

  context.continueDiscoveryForSource = async (targetId, discoveryRunId) => {
    const discoveryState = await repository.getDiscoveryState();
    const originatingRun = [
      discoveryState.activeRun,
      ...discoveryState.recentRuns,
    ].find((candidate) => candidate?.id === discoveryRunId);
    if (!originatingRun?.campaignId) {
      return {
        status: "origin_removed",
        message: "This search plan was removed; run the plan again",
      };
    }

    const campaignState = await repository.getCampaignState();
    if (
      !campaignState?.campaigns.some(
        (campaign) => campaign.id === originatingRun.campaignId,
      )
    ) {
      return {
        status: "origin_removed",
        message: "This search plan was removed; run the plan again",
      };
    }

    try {
      await runCampaignScopedDiscovery(
        (campaign) =>
          discoveryMethods.runCampaignDiscoveryForTarget(campaign, targetId),
        originatingRun.campaignId,
        { nestedUserActionRecovery: true },
      );
      return { status: "continued" };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "This search plan was removed; run the plan again"
      ) {
        return { status: "origin_removed", message: error.message };
      }
      throw error;
    }
  };

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

  /**
   * Application work is the exception: the global pause is the person's brake
   * on anything that fills in or sends a form, so a row's Try again or an
   * Apply press refuses instead of quietly lifting it. Continue on Home (or in
   * the header) is the one way back.
   */
  async function requireApplicationActivityNotPaused(): Promise<void> {
    if (await isWorkspaceActivityPaused(repository)) {
      throw new Error(ACTIVITY_PAUSED_MESSAGE);
    }
    await onExplicitUserStart?.();
  }

  async function resolvePreparationCampaign(
    run: ApplyRun | null,
  ): Promise<JobSearchCampaign | null> {
    let state = await repository.getCampaignState();
    if (!state) {
      // Same serialized missing-state bootstrap as scoped discovery: re-read
      // under one campaign transition and create only if still absent.
      state = await context.withCampaignTransition(async () => {
        const latestState = await repository.getCampaignState();
        if (latestState) return latestState;
        return ensureCampaignState({
          repository,
          searchPreferences: await repository.getSearchPreferences(),
        });
      });
    }
    if (run?.campaignId) {
      const capturedCampaign = state.campaigns.find(
        (candidate) => candidate.id === run.campaignId,
      );
      if (!capturedCampaign) {
        throw new Error(
          "The campaign captured by this apply run is no longer available. Restage the run from a current campaign before continuing.",
        );
      }
      return capturedCampaign;
    }
    return (
      state.campaigns.find(
        (candidate) => candidate.id === state.activeCampaignId,
      ) ?? null
    );
  }

  function assertCampaignPreparationScope(
    campaign: JobSearchCampaign,
    jobIds: readonly string[],
  ): void {
    const uniqueJobIds = uniqueStrings(jobIds);
    const unscopedJobId = uniqueJobIds.find(
      (jobId) => !campaign.jobIds.includes(jobId),
    );
    if (unscopedJobId) {
      throw new Error(
        "That job is not retained in the active campaign. Select its campaign before preparing an application.",
      );
    }
  }

  /**
   * Global daily preparation capacity counts every campaign-attributed and
   * legacy run, but only jobs that left `planned`. Each exact run/job lineage
   * is counted once. Run creation is the durable timestamp shared by current
   * and legacy lineages, and its local calendar day defines the safety window.
   */
  async function requireGlobalDailyPreparationCapacity(
    prospectiveJobIds: readonly string[],
    reservedJobs: number,
    reservedJobIds: readonly string[] = [],
  ): Promise<void> {
    const uniqueProspectiveJobIds = uniqueStrings(prospectiveJobIds);
    if (uniqueProspectiveJobIds.length === 0) {
      return;
    }
    const [applyRuns, applyJobResults, applicationRecords, settings] =
      await Promise.all([
        repository.listApplyRuns(),
        repository.listApplyJobResults(),
        repository.listApplicationRecords(),
        repository.getSettings(),
      ]);
    const dailyLimit =
      settings.maxApplicationsPerLocalDay ??
      MAX_BEGUN_EMPLOYER_APPLICATIONS_PER_LOCAL_DAY;
    const capacity = deriveGlobalDailyApplicationPreparationCapacity({
      applyRuns,
      applyJobResults,
      applicationRecords,
      limit: dailyLimit,
      // Reserved jobs are already charged through `reservedJobs` below.
      reservedJobIds: [...reservedJobIds, ...uniqueProspectiveJobIds],
    });
    if (
      capacity.used +
        capacity.legacyUncertain +
        reservedJobs +
        uniqueProspectiveJobIds.length >
      dailyLimit
    ) {
      throw new Error(
        `You can start up to ${dailyLimit} ${dailyLimit === 1 ? "preparation" : "preparations"} per day. Today: ${capacity.used} started${capacity.legacyUncertain ? `, ${capacity.legacyUncertain} older attempts also count` : ""}${reservedJobs ? `, ${reservedJobs} reserved` : ""}. Retries and failed attempts count; continuing an open form does not. Change the limit in Settings → Applying.`,
      );
    }
  }

  async function requireEmployerApplicationCapacity(
    jobIds: readonly string[],
    run: ApplyRun | null = null,
    reservedJobs = 0,
    reservedJobIds: readonly string[] = [],
  ): Promise<void> {
    const scopedJobIds = run?.jobIds ?? jobIds;
    if (
      uniqueStrings(scopedJobIds).length > MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN
    ) {
      throw new Error(
        `Employer-application runs are limited to ${MAX_EMPLOYER_APPLICATION_JOBS_PER_RUN} unique jobs.`,
      );
    }
    const campaign = await resolvePreparationCampaign(run);
    if (campaign) {
      assertCampaignPreparationScope(campaign, scopedJobIds);
    }
    await requireGlobalDailyPreparationCapacity(
      jobIds,
      reservedJobs,
      reservedJobIds,
    );
  }

  async function requireApplicationSafeguardClearance(
    jobIds: readonly string[],
  ): Promise<void> {
    if (!context.requireApplicationSafeguardClearance) {
      throw new Error("Application safeguard gate not initialized.");
    }
    await context.requireApplicationSafeguardClearance(jobIds);
  }

  /**
   * The one gate sequence every application preparation entry point shares:
   * global activity, campaign lineage scope, fixed global capacity, and
   * safeguard blockers. Entry points must delegate here instead of assembling
   * their own subset so no route can skip a gate the others enforce.
   */
  async function requireApplicationPreparationGuards(
    jobIds: readonly string[],
    run: ApplyRun | null = null,
    reservedJobs = 0,
    reservedJobIds: readonly string[] = [],
  ): Promise<void> {
    await requireApplicationActivityNotPaused();
    await requireEmployerApplicationCapacity(
      jobIds,
      run,
      reservedJobs,
      reservedJobIds,
    );
    await requireApplicationSafeguardClearance(jobIds);
  }

  async function withApplicationPreparationReservation<T>(
    resolveScope: () =>
      | {
          jobIds: readonly string[];
          run: ApplyRun | null;
        }
      | Promise<{
          jobIds: readonly string[];
          run: ApplyRun | null;
        }>,
    operation: (token: ApplicationPreparationCapacityToken) => Promise<T>,
  ): Promise<T> {
    const token = await withPreparationCapacityTransition(
      repository,
      async (capacityState) => {
        const scope = await resolveScope();
        const localDate = localDateKey(new Date());
        const todaysTokens = [...capacityState.tokens].filter(
          (candidate) => candidate.localDate === localDate,
        );
        const reservedJobs = todaysTokens.reduce(
          (total, candidate) => total + candidate.remainingJobs,
          0,
        );
        const reservedJobIds = todaysTokens.flatMap((candidate) => [
          ...candidate.jobIds,
        ]);
        await requireApplicationPreparationGuards(
          scope.jobIds,
          scope.run,
          reservedJobs,
          reservedJobIds,
        );
        const created = {
          localDate,
          remainingJobs: uniqueStrings(scope.jobIds).length,
          jobIds: uniqueStrings(scope.jobIds),
        } satisfies ApplicationPreparationCapacityToken;
        capacityState.tokens.add(created);
        return created;
      },
    );

    try {
      return await operation(token);
    } finally {
      await withPreparationCapacityTransition(repository, (state) => {
        state.tokens.delete(token);
      });
    }
  }

  async function markApplicationPreparationStarted(
    input: { resultId: string; runId: string; jobId: string },
    token?: ApplicationPreparationCapacityToken,
  ): Promise<ApplyJobResult> {
    return withPreparationCapacityTransition(repository, async (state) => {
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
      const tokensToday = [...state.tokens].filter(
        (candidate) => candidate.localDate === startedLocalDate,
      );
      const reservedToday = tokensToday.reduce(
        (total, candidate) => total + candidate.remainingJobs,
        0,
      );
      if (!token || token.localDate !== startedLocalDate) {
        await requireGlobalDailyPreparationCapacity(
          [input.jobId],
          reservedToday,
          tokensToday.flatMap((candidate) => [...candidate.jobIds]),
        );
      }
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

  async function resolveApplicationStartRecordId(
    jobId: string,
    applicationRecordId?: string | null,
  ): Promise<string | undefined> {
    if (applicationRecordId !== null) {
      return applicationRecordId;
    }

    const job = (await repository.listSavedJobs()).find(
      (entry) => entry.id === jobId,
    );
    if (!job) {
      throw new Error(
        `Unable to create an application record for unknown job '${jobId}'.`,
      );
    }

    const now = new Date().toISOString();
    const record = ApplicationRecordSchema.parse({
      id: `application_${randomUUID()}`,
      jobId,
      title: job.title,
      company: job.company,
      status: job.status,
      lastActionLabel: "New application record created for safe preparation.",
      nextActionLabel: "Prepare the application when you are ready.",
      lastUpdatedAt: now,
    });
    await repository.upsertApplicationRecord(record);
    return record.id;
  }

  /**
   * Guards approving (and therefore executing) an existing staged or paused
   * run with exactly the gates a fresh preparation start faces. Only jobs
   * that have not begun yet count as new consumption; jobs already prepared
   * inside this run lineage are already reflected in today's quota through
   * their result rows.
   */
  async function listPendingApplyRunJobIds(run: ApplyRun): Promise<string[]> {
    const results = await repository.listApplyJobResults({ runId: run.id });
    return uniqueStrings(run.jobIds).filter((jobId) => {
      const result = results.find((candidate) => candidate.jobId === jobId);
      return (
        result?.state === "planned" && !result.applicationPreparationStartedAt
      );
    });
  }

  async function requireDiscoverySafeguardClearance(): Promise<void> {
    const blockers = await safeguardMethods.evaluateGlobalDiscoveryBlockers();
    safeguardMethods.requireNoBlockers(blockers);
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
    applicationMethods.resumeOnShortlistPauseChanged(control.paused);
    // Home's Pause new work lets the current application reach a safe
    // boundary. The queue waits between jobs and Resume continues that same
    // run. Browser takeover and shutdown still abort immediately.
    if (input.paused && input.pauseBehavior !== "finish_current") {
      const activeRunIds = [...activeApplyRunAbortControllers.keys()];
      activeDiscoveryAbortControllerRef.current?.abort();
      activeSourceDebugAbortControllerRef.current?.abort();
      for (const controller of activeApplyRunAbortControllers.values()) {
        controller.abort();
      }
      await Promise.allSettled(
        [
          activeDiscoveryPromiseRef.current,
          activeSourceDebugPromiseRef.current,
          ...activeApplyRunPromises.values(),
        ].filter((value): value is Promise<unknown> => value != null),
      );
      await Promise.allSettled(
        activeRunIds.map((runId) => applicationMethods.cancelApplyRun(runId)),
      );
    } else if (previousControl.paused) {
      // Startup may have checked verifying actions while the workspace was
      // paused and cached that completed no-op recovery promise. An explicit
      // Resume is a new recovery boundary: clear the cached startup pass so
      // the snapshot below immediately processes the already-persisted
      // verifying actions instead of waiting for another app restart.
      userActionRecoveryPromise = null;
      if (previousControl.pauseBehavior === "finish_current") {
        await applicationMethods.resumeParkedApplyRuns(
          previousControl,
          onDetachedApplyRunFinished,
        );
      }
    }
  }
  async function setActivityControl(
    rawInput: SetJobFinderActivityControlInput,
  ) {
    await commitActivityControl(rawInput);
    return getWorkspaceSnapshot();
  }
  const applyRunStoreMethods = createWorkspaceApplyRunStoreMethods(context);
  const applicationAnswerMethods = createWorkspaceApplicationAnswerMethods(
    context,
    applyRunStoreMethods.getApplyRunDetails,
    (command) =>
      trackWorkspaceOperation("application answer continuation", () =>
        userActionMethods.performUserAction(command),
      ),
  );
  const groupedAnswerMethods = createWorkspaceGroupedAnswerMethods({
    ctx: context,
    getWorkspaceSnapshot: () => getWorkspaceSnapshot(true),
    resumeVerifyingUserActions: resumeVerifyingUserActionsAfterCommit,
  });

  function describeShutdownFailure(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }

  async function shutdown(): Promise<void> {
    if (shutdownPromiseRef.current) {
      return shutdownPromiseRef.current;
    }

    shutdownPromiseRef.current = (async () => {
      invalidateListingReads();
      const activeApplyRunIds = [...activeApplyRunAbortControllers.keys()];
      fitJudgmentAbortController?.abort();
      activeDiscoveryAbortControllerRef.current?.abort();
      activeSourceDebugAbortControllerRef.current?.abort();
      for (const controller of activeApplyRunAbortControllers.values()) {
        controller.abort();
      }

      await Promise.allSettled(
        [
          activeDiscoveryPromiseRef.current,
          activeSourceDebugPromiseRef.current,
          ...activeApplyRunPromises.values(),
        ].filter((value): value is Promise<unknown> => value != null),
      );

      if (activeApplyRunIds.length > 0) {
        const activeApplyRunIdSet = new Set(activeApplyRunIds);
        const [applyRuns, applyResults, activityControl] = await Promise.all([
          repository.listApplyRuns().catch(() => []),
          repository.listApplyJobResults().catch(() => []),
          repository.getActivityControl(),
        ]);
        const completedAt = new Date().toISOString();
        const parkedRunIds = new Set(
          applyRuns
            .filter(
              (run) =>
                activeApplyRunIdSet.has(run.id) &&
                isSafelyParkedApplyQueue({
                  run,
                  results: applyResults.filter(
                    (result) => result.runId === run.id,
                  ),
                  control: activityControl,
                }),
            )
            .map((run) => run.id),
        );
        const activeRunningRuns = applyRuns.filter(
          (run) =>
            activeApplyRunIdSet.has(run.id) &&
            run.state === "running" &&
            !parkedRunIds.has(run.id),
        );
        const activeResults = applyResults.filter(
          (result) =>
            activeApplyRunIdSet.has(result.runId) &&
            !parkedRunIds.has(result.runId),
        );
        const recoveredRuns = activeRunningRuns.map((run) =>
          recoverInterruptedApplyRun(
            run,
            completedAt,
            activeResults.filter((result) => result.runId === run.id),
          ),
        );
        const recoveredResults: ApplyJobResult[] = [];
        const terminalizedRecordIds = new Set<string>();
        for (const result of activeResults) {
          const recoveredResult = recoverInterruptedApplyJobResult(
            result,
            completedAt,
          );
          if (!recoveredResult) {
            continue;
          }
          // Exact applicationRecordId lineage only: legacy null-lineage
          // rows are terminalized without being attributed to a record.
          if (result.applicationRecordId) {
            terminalizedRecordIds.add(result.applicationRecordId);
          }
          recoveredResults.push(recoveredResult);
        }
        // Crash-resumable persist order: exact-lineage projections land
        // before the run/result commits, so a crash mid-shutdown leaves the
        // parent runs durably non-terminal and the next startup replay
        // finishes the job idempotently instead of stranding in-progress
        // attempt/record rows under already-terminal runs.
        await Promise.allSettled([
          recoverInterruptedExactLineageProjections({
            repository,
            interruptedRecordIds: terminalizedRecordIds,
            completedAt,
            eventIdFor: (recordId) =>
              `event_shutdown_app_closed_recovery_${recordId}`,
          }),
        ]);
        await Promise.allSettled([
          ...recoveredRuns.map((run) => repository.upsertApplyRun(run)),
          ...recoveredResults.map((result) =>
            repository.upsertApplyJobResult(result),
          ),
        ]);
      }

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
    writeApplicationDocumentText: (input) =>
      writeApplicationDocumentText(context, input),
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
    async withWorkspaceRestore(operation) {
      if (
        workspaceResetInProgress ||
        activeWorkspaceOperationLabels().length > 0
      )
        throw new Error(
          "Wait for Job Finder's current work to finish or stop it before restoring. Your workspace was kept.",
        );
      workspaceResetInProgress = true;
      invalidateListingReads();
      try {
        await operation();
      } finally {
        workspaceResetInProgress = false;
      }
    },
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
    ...campaignMethods,
    runCampaignNow: (input, onActivity) =>
      trackWorkspaceOperation("discovery", () =>
        campaignMethods.runCampaignNow(input, onActivity),
      ),
    runDueScheduledCampaigns: (now, onActivity) =>
      trackWorkspaceOperation("discovery", () =>
        campaignMethods.runDueScheduledCampaigns(now, onActivity),
      ),
    processDueScheduledCampaigns: (now, onActivity) =>
      trackWorkspaceOperation("scheduled discovery", () =>
        campaignMethods.processDueScheduledCampaigns(now, onActivity),
      ),
    ...intelligenceMethods,
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
    getApplicationDocumentContext: async (jobId, applicationRecordId) => {
      const [profile, jobs, records, results] = await Promise.all([
        repository.getProfile(),
        repository.listSavedJobsByIds([jobId]),
        repository.listApplicationRecords(),
        repository.listApplyJobResults({ jobId, applicationRecordId }),
      ]);
      return {
        profile,
        job: buildDiscoveryJobs(jobs)[0] ?? null,
        applicationRecord:
          records.find(
            (entry) =>
              entry.id === applicationRecordId && entry.jobId === jobId,
          ) ?? null,
        latestResult:
          [...results].sort(
            (left, right) =>
              Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
          )[0] ?? null,
      };
    },
    getWorkspaceBootstrap,
    getWorkspaceHomeSnapshot,
    mutateSafeguards: safeguardMethods.mutateSafeguards,
    getSafeguardsOverview: safeguardMethods.getSafeguardsOverview,
    evaluateApplicationSafeguardBlockers:
      safeguardMethods.evaluateApplicationPreparationBlockers,
    evaluateDiscoverySafeguardBlockers:
      safeguardMethods.evaluateGlobalDiscoveryBlockers,
    ...discoveryMethods,
    runDiscovery: (targetId) =>
      trackWorkspaceOperation("discovery", async () => {
        await requireActivityEnabled();
        return runCampaignScopedDiscovery(() =>
          discoveryMethods.runDiscovery(targetId),
        );
      }),
    runAgentDiscovery: (onActivity, signal, targetId, searchRequest) =>
      trackWorkspaceOperation("discovery", async () => {
        await requireActivityEnabled();
        return runCampaignScopedDiscovery(() =>
          discoveryMethods.runAgentDiscovery(
            onActivity,
            signal,
            targetId,
            searchRequest,
          ),
        );
      }),
    runDiscoveryForTarget: (targetId, onActivity, signal) =>
      trackWorkspaceOperation("discovery", async () => {
        await requireActivityEnabled();
        return runCampaignScopedDiscovery(() =>
          discoveryMethods.runDiscoveryForTarget(targetId, onActivity, signal),
        );
      }),
    runAgentDiscoveryCommand: (onActivity, targetId, searchRequest) =>
      trackWorkspaceOperation("discovery", async () => {
        runningDiscoveryCommands += 1;
        try {
          await requireActivityEnabled();
          return await runCampaignScopedDiscovery(
            () =>
              discoveryMethods.runAgentDiscoveryCommand(
                onActivity,
                targetId,
                searchRequest,
              ),
            undefined,
            { commandOnly: true },
          );
        } finally {
          runningDiscoveryCommands -= 1;
        }
      }),
    cancelDiscoveryRunCommand: (runId) =>
      trackWorkspaceOperation("discovery cancellation", () =>
        cancelDiscoveryRunCommand(runId),
      ),
    cancelDiscoveryRun: (runId) =>
      trackWorkspaceOperation("discovery cancellation", async () => {
        await cancelDiscoveryRunCommand(runId);
        return getWorkspaceSnapshot();
      }),
    ...sourceDebugMethods,
    runSourceDebug: (targetId, signal, onProgress) =>
      trackWorkspaceOperation("source debug", async () => {
        await requireActivityEnabled();
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
    ...applyRunStoreMethods,
    ...applicationAnswerMethods,
    ...groupedAnswerMethods,
    saveUserActionAnswerDraft: (input) =>
      trackWorkspaceOperation("answer draft", () =>
        repository.saveUserActionAnswerDraft(input),
      ),
    performUserAction: (command) =>
      trackWorkspaceOperation("application user action", () =>
        userActionMethods.performUserAction(command),
      ),
    ...applicationMethods,
    dismissDiscoveryJob: (input) =>
      trackWorkspaceOperation("hiding jobs", () =>
        applicationMethods.dismissDiscoveryJob(input),
      ),
    dismissDiscoveryJobs: (inputs, options) =>
      trackWorkspaceOperation("hiding jobs", () =>
        applicationMethods.dismissDiscoveryJobs!(inputs, options),
      ),
    excludeEmployerDiscoveryJobs: (input, options) =>
      trackWorkspaceOperation("excluding an employer", () =>
        applicationMethods.excludeEmployerDiscoveryJobs!(input, options),
      ),
    restoreDismissedDiscoveryJob: (jobId) =>
      trackWorkspaceOperation("restoring hidden jobs", () =>
        applicationMethods.restoreDismissedDiscoveryJob(jobId),
      ),
    restoreDismissedDiscoveryJobs: (jobIds, options) =>
      trackWorkspaceOperation("restoring hidden jobs", () =>
        applicationMethods.restoreDismissedDiscoveryJobs!(jobIds, options),
      ),
    getResumeWorkspace: (jobId) =>
      trackWorkspaceOperation("resume workspace", () =>
        applicationMethods.getResumeWorkspace(jobId),
      ),
    queueJobForReview: (jobId) =>
      trackWorkspaceOperation("shortlisting jobs", () =>
        applicationMethods.queueJobForReview(jobId),
      ),
    queueJobsForReview: (jobIds) =>
      trackWorkspaceOperation("shortlisting jobs", () =>
        applicationMethods.queueJobsForReview!(jobIds),
      ),
    continueResumesOnShortlist: () =>
      applicationMethods.continueResumesOnShortlist(),
    recordApplicationsSentByPerson: () =>
      recordApplicationsSentByPerson(context),
    judgeUnjudgedJobs: () => {
      // One pass at a time; a second press joins the one already running.
      unjudgedJobsJudging ??= trackWorkspaceOperation(
        "fit judging",
        async () => {
          fitJudgmentProgressRef.current = null;
          options.onFitJudgmentProgress?.();
          const controller = new AbortController();
          fitJudgmentAbortController = controller;
          const startedAt = new Date().toISOString();
          try {
            await judgeUnjudgedPlanJobs({
              ctx: context,
              signal: controller.signal,
              onProgress: (progress) => {
                fitJudgmentProgressRef.current = {
                  ...progress,
                  startedAt,
                  updatedAt: new Date().toISOString(),
                };
                options.onFitJudgmentProgress?.();
              },
            });
            return getWorkspaceSnapshot();
          } catch (error) {
            const currentProgress = context.fitJudgmentProgressRef?.current;
            controller.abort();
            if (currentProgress) {
              fitJudgmentProgressRef.current = {
                ...currentProgress,
                phase: "failed",
                updatedAt: new Date().toISOString(),
              };
              options.onFitJudgmentProgress?.();
            }
            throw error;
          } finally {
            fitJudgmentAbortController = null;
          }
        },
      ).finally(() => {
        unjudgedJobsJudging = null;
      });
      return unjudgedJobsJudging;
    },
    generateResume: (jobId, options) =>
      trackWorkspaceOperation("resume generation", () =>
        applicationMethods.generateResume(jobId, options),
      ),
    regenerateResumeDraft: (jobId, options) =>
      trackWorkspaceOperation("resume generation", () =>
        applicationMethods.regenerateResumeDraft(jobId, options),
      ),
    regenerateResumeSection: (jobId, sectionId) =>
      trackWorkspaceOperation("resume generation", () =>
        applicationMethods.regenerateResumeSection(jobId, sectionId),
      ),
    sendResumeAssistantMessage: (jobId, content) =>
      trackWorkspaceOperation("resume proposal", () =>
        applicationMethods.sendResumeAssistantMessage(jobId, content),
      ),
    resolveResumeAssistantProposal: (jobId, proposalId, action, patchIds) =>
      trackWorkspaceOperation("resume proposal", () =>
        applicationMethods.resolveResumeAssistantProposal(
          jobId,
          proposalId,
          action,
          patchIds,
        ),
      ),
    startApplyCopilotRun: (jobId, options, applicationRecordId) =>
      trackWorkspaceOperation("application preparation", async () => {
        return withApplicationPreparationReservation(
          () => ({ jobIds: [jobId], run: null }),
          async (token) => {
            const exactApplicationRecordId =
              await resolveApplicationStartRecordId(jobId, applicationRecordId);
            return applicationMethods.startApplyCopilotRun(
              jobId,
              options,
              exactApplicationRecordId,
              token,
            );
          },
        );
      }),
    startAutoApplyRun: (jobId, applicationRecordId) =>
      trackWorkspaceOperation("application preparation", async () => {
        return withApplicationPreparationReservation(
          () => ({ jobIds: [jobId], run: null }),
          async () => {
            const exactApplicationRecordId =
              await resolveApplicationStartRecordId(jobId, applicationRecordId);
            return applicationMethods.startAutoApplyRun(
              jobId,
              exactApplicationRecordId,
            );
          },
        );
      }),
    startAutoApplyQueueRun: (
      jobIds,
      applicationAutomationMode?: ApplicationAutomationMode,
    ) =>
      trackWorkspaceOperation("application preparation", async () => {
        return withApplicationPreparationReservation(
          () => ({ jobIds, run: null }),
          // The batch's own reservation already charges today's quota for
          // every job in it. Without the token each job the batch begins is
          // charged a second time, so the daily safeguard refuses partway
          // through and the batch stalls with nothing on screen.
          (token) =>
            applicationMethods.startAutoApplyQueueRun(
              jobIds,
              token,
              applicationAutomationMode,
            ),
        );
      }),
    approveApplyRun: (runId) =>
      trackWorkspaceOperation("application preparation", async () => {
        return withApplicationPreparationReservation(
          async () => {
            const run =
              (await repository.listApplyRuns()).find(
                (entry) => entry.id === runId,
              ) ?? null;
            if (!run) {
              throw new Error(`Unknown apply run '${runId}'.`);
            }
            return {
              jobIds: await listPendingApplyRunJobIds(run),
              run,
            };
          },
          (token) => applicationMethods.approveApplyRun(runId, token),
        );
      }),
    cancelApplyRun: (runId, options) =>
      trackWorkspaceOperation("application preparation", () =>
        applicationMethods.cancelApplyRun(runId, options),
      ),
    resolveApplyConsentRequest: (requestId, action) =>
      trackWorkspaceOperation("application preparation", async () => {
        return withApplicationPreparationReservation(
          async () => {
            const [requests, runs, results] = await Promise.all([
              repository.listApplicationConsentRequests(),
              repository.listApplyRuns(),
              repository.listApplyJobResults(),
            ]);
            const request = requests.find((entry) => entry.id === requestId);
            if (!request)
              throw new Error(`Unknown consent request '${requestId}'.`);
            const run = runs.find((entry) => entry.id === request.runId);
            if (!run) throw new Error(`Unknown apply run '${request.runId}'.`);
            const jobIds = uniqueStrings(run.jobIds).filter((jobId) => {
              const result = results.find(
                (entry) => entry.runId === run.id && entry.jobId === jobId,
              );
              return (
                result?.state === "planned" &&
                !result.applicationPreparationStartedAt
              );
            });
            return { jobIds, run };
          },
          (token) =>
            applicationMethods.resolveApplyConsentRequest(
              requestId,
              action,
              token,
            ),
        );
      }),
    revokeApplyRunApproval: (runId) =>
      trackWorkspaceOperation("application preparation", () =>
        applicationMethods.revokeApplyRunApproval(runId),
      ),
    approveApply: (jobId) =>
      trackWorkspaceOperation("application preparation", async () => {
        // Legacy direct-apply entry point. It delegates to the same guarded
        // path as every other preparation start so it cannot bypass campaign
        // scope, capacity, or safeguards; the submit authority of the wrapped
        // method itself (prepare-only, no final submit) is unchanged.
        return withApplicationPreparationReservation(
          () => ({ jobIds: [jobId], run: null }),
          (token) => applicationMethods.approveApply(jobId, undefined, token),
        );
      }),
    ...crmMethods,
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
    applyAssistantResumePatches:
      assistantEditMethods.applyAssistantResumePatches,
    applyAssistantResumeRevision:
      assistantEditMethods.applyAssistantResumeRevision,
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
    runResumeRevisionSpecialist: (input) =>
      trackWorkspaceOperation("resume edit", () =>
        runResumeRevisionSpecialist(context, input),
      ),
  };
}
