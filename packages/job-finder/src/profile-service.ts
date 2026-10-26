import {
  AiBehaviorPreferenceSchema,
  AppearanceThemeSchema,
  CandidateProfileSchema,
  CoverLetterPreferenceSchema,
  JobFinderActivityControlSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ProfileSetupStateSchema,
  ResumeDocumentBundleSchema,
  ResumeSourceDocumentSchema,
  SetJobFinderActivityControlInputSchema,
  UpdateAiBehaviorInputSchema,
  UpdateApplicationDefaultsInputSchema,
  UpdateWorkspaceBehaviorInputSchema,
  jobSiteTarget,
  type AppearanceTheme,
  type CandidateProfile,
  type CandidateReusableAnswer,
  type JobFinderActivityControl,
  type JobFinderSettings,
  type JobPosting,
  type JobSearchPreferences,
  type ProfileSetupReviewAction,
  type ProfileSetupReviewActionOptions,
  type ProfileSetupState,
  type ResumeDocumentBundle,
  type ResumeImportVisionArtifact,
  type ResumeSourceDocument,
  type ResumeTimelineRepairAction,
  type SetJobFinderActivityControlInput,
  type SourceDebugProgressEvent,
  type SourceDebugRunRecord,
  type UpdateAiBehaviorInput,
  type UpdateApplicationDefaultsInput,
  type UpdateWorkspaceBehaviorInput,
} from "@nestor/contracts";
import type {
  JobFinderAiClient,
  ResumeVisionProvider,
} from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type { JobFinderRepository } from "@nestor/db";
import type { JobSitesStore } from "@nestor/db/job-store";

import type { ProfileContext } from "./internal/profile-context";
import { normalizeProfileBeforeSave } from "./internal/profile-merge";
import { resolvePendingReviewItemsAfterExplicitSave } from "./internal/profile-setup-review-items";
import {
  deriveAndPersistProfileSetupState,
  landProfileSetupAfterImport,
} from "./internal/profile-workspace-state";
import {
  isResumeImportActiveInProcess,
  runResumeImportWorkflow,
} from "./internal/resume-import-workflow";
import { persistResumeTimelineRepairAction } from "./internal/resume-timeline-repair";
import { createWorkspaceAssistantEditMethods } from "./internal/workspace-assistant-edit-methods";
import {
  normalizeJobFinderSettings,
  normalizeSearchPreferences,
} from "./internal/workspace-helpers";
import { createWorkspaceProfileCopilotMethods } from "./internal/workspace-profile-copilot-methods";
import { createWorkspaceProfileSetupContextHelpers } from "./internal/workspace-profile-setup-context";
import { createWorkspaceProfileSetupReviewMethods } from "./internal/workspace-profile-setup-review-methods";
import { createWorkspaceSourceDebugStoreMethods } from "./internal/workspace-source-debug-store-methods";
import { runSourceDebugWorkflow } from "./internal/workspace-source-debug-workflow";
import type { JobFinderDocumentManager } from "./internal/workspace-service-contracts";
import { uniqueStrings } from "./internal/shared";

export interface ProfileServiceOptions {
  repository: JobFinderRepository;
  aiClient: JobFinderAiClient;
  visionProvider?: ResumeVisionProvider;
  browserRuntime: BrowserSessionRuntime;
  documentManager: JobFinderDocumentManager;
  jobSites?: JobSitesStore;
  readSavedAnswers?: () => readonly CandidateReusableAnswer[];
  hasRunJobSearch?: () => boolean;
  /** Jobs whose resume is approved, to tell which ones an edit sent back. */
  approvedResumeJobIds?: () => string[];
  onResumeEvidenceFinished?: () => void;
  /** Called after the pause changes, so the host's browser and Apply follow it. */
  onActivityControlChanged?: (control: JobFinderActivityControl) => void;
  /**
   * A person starting browser work by hand, such as Check site: the host
   * lets its browser open again after the person closed it.
   */
  onExplicitUserStart?: () => void | Promise<void>;
  /**
   * Site sign-ins the person owes: a site check that stops at a sign-in page
   * asks for one in Needs you, and a check that gets through settles it.
   */
  sourceAccess?: {
    request(sourceId: number, prompt: string): unknown;
    complete(sourceId: number): unknown;
  };
}

/**
 * Profile work: resume import, guided setup, profile and settings saves, the
 * assistant's profile edits and site checks. Each writes the job store and
 * answers with what it did, never a whole-workspace view.
 */
export function createProfileService(options: ProfileServiceOptions) {
  const { repository, jobSites, browserRuntime } = options;
  const activeSourceDebugAbortControllerRef = {
    current: null as AbortController | null,
  };
  const activeSourceDebugPromiseRef = {
    current: null as Promise<unknown> | null,
  };
  const ctx: ProfileContext = {
    ...(jobSites ? { jobSites } : {}),
    aiClient: options.aiClient,
    ...(options.visionProvider
      ? { visionProvider: options.visionProvider }
      : {}),
    browserRuntime,
    documentManager: options.documentManager,
    repository,
    ...(options.readSavedAnswers
      ? { readSavedAnswers: options.readSavedAnswers }
      : {}),
    ...(options.hasRunJobSearch
      ? { hasRunJobSearch: options.hasRunJobSearch }
      : {}),
    ...(options.approvedResumeJobIds
      ? { approvedResumeJobIds: options.approvedResumeJobIds }
      : {}),
    ...(options.onResumeEvidenceFinished
      ? { onResumeEvidenceFinished: options.onResumeEvidenceFinished }
      : {}),
    activeSourceDebugExecutionIdRef: { current: null },
    activeSourceDebugAbortControllerRef,
    activeSourceDebugPromiseRef,
    activeResumeVisionRunIds: new Set(),
    activeResumeEvidenceRunIds: new Set(),
    backgroundWork: new Set(),
    saveJobSiteMetadata(targetId, updater) {
      return Promise.resolve().then(() => {
        const site = jobSites?.get(Number(targetId));
        if (!site || !jobSites)
          throw new Error(`Unknown job site '${targetId}'.`);
        const next = updater(jobSiteTarget(site));
        const saved = jobSites.record(site.id, {
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
    persistSourceDebugRun: (run) => repository.upsertSourceDebugRun(run),
    async openRunBrowserSession(source, sessionOptions) {
      await browserRuntime.openSession(source, sessionOptions);
    },
    async closeRunBrowserSession(source) {
      await browserRuntime.closeSession(source);
    },
  };

  const { buildBundleFromStoredResume, getCurrentSetupStateContext } =
    createWorkspaceProfileSetupContextHelpers(ctx);
  const setupReview = createWorkspaceProfileSetupReviewMethods({
    ctx,
    getCurrentSetupStateContext,
  });

  async function commitApplicationDefaultFields(
    fields: Partial<JobFinderSettings>,
  ): Promise<void> {
    const templates = ctx.documentManager.listResumeTemplates();
    await repository.commitSettingsUpdate((current) =>
      normalizeJobFinderSettings({ ...current, ...fields }, templates),
    );
  }

  const copilot = createWorkspaceProfileCopilotMethods({
    ctx,
    getCurrentSetupStateContext,
    commitResumeApplicationMode: (resumeApplicationMode) =>
      commitApplicationDefaultFields({ resumeApplicationMode }),
  });

  async function saveSettings(settings: JobFinderSettings): Promise<void> {
    const templates = ctx.documentManager.listResumeTemplates();
    const next = normalizeJobFinderSettings(settings, templates);
    await repository.commitSettingsUpdate((latest) => ({
      ...next,
      applicationAutomationMode:
        settings.applicationAutomationMode ??
        latest.applicationAutomationMode ??
        "confirm_before_submit",
      salaryDisclosure:
        settings.salaryDisclosure ??
        latest.salaryDisclosure ??
        "pause_for_user",
    }));
  }

  const assistantEdits = createWorkspaceAssistantEditMethods({
    ctx,
    applyAssistantProfilePatchGroup: copilot.applyAssistantProfilePatchGroup,
    commitResumeApplicationMode: (resumeApplicationMode) =>
      commitApplicationDefaultFields({ resumeApplicationMode }),
    saveSettings,
  });

  async function landSetupState(
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
    persistedState: ProfileSetupState,
  ) {
    await deriveAndPersistProfileSetupState(ctx, {
      persistedState,
      profile,
      searchPreferences,
      latestResumeImportRunId:
        (await repository.getLatestResumeImportRun())?.id ?? null,
    });
  }

  async function persistSearchPreferences(
    searchPreferences: JobSearchPreferences,
    ownsAiBehaviorFields: boolean,
  ): Promise<void> {
    const [profile, setupState, current] = await Promise.all([
      repository.getProfile(),
      repository.getProfileSetupState(),
      repository.getSearchPreferences().then(normalizeSearchPreferences),
    ]);
    const parsed = normalizeSearchPreferences(
      JobSearchPreferencesSchema.parse(searchPreferences),
    );
    // The resume approach and how picky a search is belong to Settings; an
    // older Profile draft never writes its copies over a newer Settings save.
    const next = ownsAiBehaviorFields
      ? parsed
      : {
          ...parsed,
          tailoringMode: current.tailoringMode,
          searchSelectivity: current.searchSelectivity,
        };
    await repository.saveSearchPreferences(next);
    await landSetupState(profile, next, setupState);
  }

  async function saveProfileAndPreferences(
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences | null,
  ): Promise<void> {
    const [currentProfile, currentPreferences, setupState] = await Promise.all([
      repository.getProfile(),
      repository.getSearchPreferences().then(normalizeSearchPreferences),
      repository.getProfileSetupState(),
    ]);
    const nextProfile = normalizeProfileBeforeSave(
      currentProfile,
      CandidateProfileSchema.parse(profile),
    );
    const nextPreferences = searchPreferences
      ? {
          ...normalizeSearchPreferences(
            JobSearchPreferencesSchema.parse(searchPreferences),
          ),
          tailoringMode: currentPreferences.tailoringMode,
          searchSelectivity: currentPreferences.searchSelectivity,
        }
      : currentPreferences;
    const nextSetupState = resolvePendingReviewItemsAfterExplicitSave({
      currentProfile,
      currentSearchPreferences: currentPreferences,
      nextProfile,
      nextSearchPreferences: nextPreferences,
      profileSetupState: setupState,
      now: new Date().toISOString(),
    });
    if (searchPreferences)
      await repository.saveProfileAndSearchPreferences(
        nextProfile,
        nextPreferences,
      );
    else await repository.saveProfile(nextProfile);
    await landSetupState(nextProfile, nextPreferences, nextSetupState);
  }

  function trackSourceCheck<T>(promise: Promise<T>): Promise<T> {
    activeSourceDebugPromiseRef.current = promise;
    void promise
      .finally(() => {
        if (activeSourceDebugPromiseRef.current === promise)
          activeSourceDebugPromiseRef.current = null;
      })
      .catch(() => undefined);
    return promise;
  }

  /**
   * A person starting browser work. It refuses while work is paused: only an
   * explicit Resume, or the last step of a finished reset, lowers a pause.
   */
  async function requireActivityEnabled(): Promise<void> {
    if ((await repository.getActivityControl()).paused)
      throw new Error("Background work is paused. Resume it, then try again.");
    await options.onExplicitUserStart?.();
  }

  // Stopping (app quit, Reset everything) cancels every import and waits for
  // it, so nothing an import was still reading lands in a cleared store.
  const importStop = new AbortController();
  const importsInFlight = new Set<Promise<unknown>>();
  function trackImport<T>(
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (importStop.signal.aborted)
      return Promise.reject(new Error("Job Finder is closing."));
    const promise = work(
      signal ? AbortSignal.any([signal, importStop.signal]) : importStop.signal,
    );
    importsInFlight.add(promise);
    void promise
      .finally(() => importsInFlight.delete(promise))
      .catch(() => undefined);
    return promise;
  }

  const sourceDebugStore = createWorkspaceSourceDebugStoreMethods(ctx);

  function runSourceCheck(
    targetId: string,
    signal: AbortSignal | undefined,
    checkOptions: {
      clearExistingInstructions: boolean;
      reviewInstructionId?: string | null;
    },
    onProgress?: (event: SourceDebugProgressEvent) => void,
  ): Promise<SourceDebugRunRecord> {
    return trackSourceCheck(
      requireActivityEnabled()
        .then(() =>
          runSourceDebugWorkflow(
            ctx,
            targetId,
            signal,
            checkOptions,
            onProgress,
          ),
        )
        .then((run) => {
          if (run.state === "paused_manual")
            options.sourceAccess?.request(
              Number(targetId),
              run.manualPrerequisiteSummary ??
                "Sign in to this site in the browser, then check it again.",
            );
          else if (run.state === "completed")
            options.sourceAccess?.complete(Number(targetId));
          return run;
        }),
    );
  }

  return {
    async runResumeImport(input: {
      baseResume: ResumeSourceDocument;
      documentBundle: ResumeDocumentBundle;
      importWarnings?: readonly string[];
      visionArtifact?: ResumeImportVisionArtifact;
      signal?: AbortSignal;
    }): Promise<void> {
      return trackImport(input.signal, async (signal) => {
        const baseResume = ResumeSourceDocumentSchema.parse(input.baseResume);
        const documentBundle = ResumeDocumentBundleSchema.parse(
          input.documentBundle,
        );
        const searchPreferences = await repository.getSearchPreferences();
        const atStart = await repository.getProfileWithRevision();
        if (!baseResume.textContent && !input.visionArtifact?.pages.length) {
          const warnings = uniqueStrings([
            ...baseResume.analysisWarnings,
            ...documentBundle.warnings,
            ...(input.importWarnings ?? []),
            "Paste plain-text resume content below if you want the agent to extract profile details from this file.",
          ]);
          await repository.commitProfileUpdate(
            (current) => {
              const normalized = normalizeProfileBeforeSave(current, {
                ...current,
                baseResume,
              });
              return CandidateProfileSchema.parse({
                ...normalized,
                baseResume: {
                  ...normalized.baseResume,
                  analysisWarnings: warnings,
                },
              });
            },
            { expectedRevision: atStart.revision },
          );
          return;
        }
        const importStartedAt = new Date().toISOString();
        await runResumeImportWorkflow(ctx, {
          profile: normalizeProfileBeforeSave(atStart.profile, {
            ...atStart.profile,
            baseResume,
          }),
          signal,
          searchPreferences,
          documentBundle,
          trigger: "import",
          expectedProfileRevision: atStart.revision,
          ...(input.importWarnings
            ? { importWarnings: input.importWarnings }
            : {}),
          ...(input.visionArtifact
            ? { visionArtifact: input.visionArtifact }
            : {}),
        });
        await landProfileSetupAfterImport(ctx, { importStartedAt });
      });
    },

    async analyzeProfileFromResume(): Promise<void> {
      return trackImport(undefined, async (signal) => {
        const [atStart, searchPreferences] = await Promise.all([
          repository.getProfileWithRevision(),
          repository.getSearchPreferences(),
        ]);
        const { profile } = atStart;
        if (!profile.baseResume.textContent) {
          await repository.commitProfileUpdate(
            (current) =>
              CandidateProfileSchema.parse({
                ...current,
                baseResume: {
                  ...current.baseResume,
                  extractionStatus: "needs_text",
                  lastAnalyzedAt: null,
                  analysisWarnings: [
                    "Paste plain-text resume content to let the agent extract candidate details.",
                  ],
                },
              }),
            { expectedRevision: atStart.revision },
          );
          throw new Error(
            "Resume text is required before the profile agent can extract candidate details.",
          );
        }
        const latestBundle =
          (
            await repository.listResumeImportDocumentBundles({
              sourceResumeId: profile.baseResume.id,
            })
          )[0] ?? buildBundleFromStoredResume(profile);
        await runResumeImportWorkflow(ctx, {
          profile,
          searchPreferences,
          documentBundle: latestBundle,
          trigger: "refresh",
          expectedProfileRevision: atStart.revision,
          signal,
        });
      });
    },

    async getResumeImportState() {
      const [
        resumeImportRuns,
        resumeImportDocumentBundles,
        resumeImportFieldCandidates,
      ] = await Promise.all([
        repository.listResumeImportRuns(),
        repository.listResumeImportDocumentBundles(),
        repository.listResumeImportFieldCandidates(),
      ]);
      return {
        activeVisionRunIds: [...ctx.activeResumeVisionRunIds],
        resumeImportRuns,
        resumeImportDocumentBundles,
        resumeImportFieldCandidates,
      };
    },

    isResumeImportActive: () =>
      isResumeImportActiveInProcess(ctx) ||
      ctx.activeResumeVisionRunIds.size > 0,

    /**
     * Brings guided setup up to date with the latest import: settles an
     * import the app closed during, and lists what still needs review.
     */
    async refreshProfileSetup(): Promise<void> {
      await getCurrentSetupStateContext();
    },

    async saveProfileSetupState(state: ProfileSetupState): Promise<void> {
      const [profile, searchPreferences] = await Promise.all([
        repository.getProfile(),
        repository.getSearchPreferences(),
      ]);
      await landSetupState(
        profile,
        normalizeSearchPreferences(searchPreferences),
        ProfileSetupStateSchema.parse(state),
      );
    },

    applyProfileSetupReviewAction: (
      reviewItemId: string,
      action: ProfileSetupReviewAction,
      actionOptions?: ProfileSetupReviewActionOptions,
    ): Promise<void> =>
      setupReview.applyProfileSetupReviewAction(
        reviewItemId,
        action,
        actionOptions,
      ),

    async applyResumeTimelineRepairAction(
      runId: string,
      proposalId: string,
      action: ResumeTimelineRepairAction,
    ): Promise<void> {
      await persistResumeTimelineRepairAction({
        repository,
        runId,
        proposalId,
        action,
        occurredAt: new Date().toISOString(),
      });
    },

    saveProfile: (profile: CandidateProfile) =>
      saveProfileAndPreferences(profile, null),
    saveProfileAndSearchPreferences: (
      profile: CandidateProfile,
      searchPreferences: JobSearchPreferences,
    ) => saveProfileAndPreferences(profile, searchPreferences),
    saveSearchPreferences: (searchPreferences: JobSearchPreferences) =>
      persistSearchPreferences(searchPreferences, false),

    saveSettings,
    async updateApplicationDefaults(
      input: UpdateApplicationDefaultsInput,
    ): Promise<void> {
      const parsed = UpdateApplicationDefaultsInputSchema.parse(input);
      await commitApplicationDefaultFields(
        Object.fromEntries(
          Object.entries({
            resumeApplicationMode: parsed.resumeApplicationMode,
            resumeTemplateId: parsed.resumeTemplateId,
            fontPreset: parsed.fontPreset,
            coverLetter: parsed.coverLetter,
            applicationAutomationMode: parsed.applicationAutomationMode,
            salaryDisclosure: parsed.salaryDisclosure,
          }).filter(([, value]) => value !== undefined),
        ),
      );
    },
    async updateAiBehavior(input: UpdateAiBehaviorInput): Promise<void> {
      const patch = UpdateAiBehaviorInputSchema.parse(input);
      const saved = await repository.getSettings();
      const current = AiBehaviorPreferenceSchema.parse(saved.aiBehavior ?? {});
      // Explicit fields merge over the saved ones: an omitted declaration
      // list is never permission to restore approvals the person withdrew.
      const aiBehavior =
        patch.aiBehavior === undefined
          ? undefined
          : AiBehaviorPreferenceSchema.parse({
              profileAssistant: {
                ...current.profileAssistant,
                ...patch.aiBehavior.profileAssistant,
              },
              jobSearch: {
                ...current.jobSearch,
                ...patch.aiBehavior.jobSearch,
              },
              applying: { ...current.applying, ...patch.aiBehavior.applying },
            });
      const coverLetter =
        patch.coverLetter === undefined
          ? undefined
          : CoverLetterPreferenceSchema.parse({
              ...saved.coverLetter,
              ...patch.coverLetter,
            });
      const approach = patch.resumeApproach;
      await commitApplicationDefaultFields({
        ...(aiBehavior ? { aiBehavior } : {}),
        ...(coverLetter ? { coverLetter } : {}),
        ...(approach === undefined
          ? {}
          : {
              resumeApplicationMode:
                approach === "original_resume"
                  ? ("original_resume" as const)
                  : ("tailored_per_job" as const),
            }),
      });
      const tailoringMode =
        approach !== undefined && approach !== "original_resume"
          ? approach
          : undefined;
      const searchSelectivity = aiBehavior?.jobSearch.selectivity;
      if (tailoringMode === undefined && searchSelectivity === undefined)
        return;
      const preferences = normalizeSearchPreferences(
        await repository.getSearchPreferences(),
      );
      if (
        (tailoringMode ?? preferences.tailoringMode) ===
          preferences.tailoringMode &&
        (searchSelectivity ?? preferences.searchSelectivity) ===
          preferences.searchSelectivity
      )
        return;
      await persistSearchPreferences(
        {
          ...preferences,
          ...(tailoringMode !== undefined ? { tailoringMode } : {}),
          ...(searchSelectivity !== undefined ? { searchSelectivity } : {}),
        },
        true,
      );
    },
    async updateWorkspaceBehavior(
      input: UpdateWorkspaceBehaviorInput,
    ): Promise<void> {
      const parsed = UpdateWorkspaceBehaviorInputSchema.parse(input);
      const fields = Object.fromEntries(
        Object.entries({
          keepSessionAlive: parsed.keepSessionAlive,
          discoveryOnly: parsed.discoveryOnly,
          collapseSideMenuWithAssistant: parsed.collapseSideMenuWithAssistant,
          writeResumesOnShortlist: parsed.writeResumesOnShortlist,
        }).filter(([, value]) => value !== undefined),
      );
      await repository.commitSettingsUpdate((current) =>
        JobFinderSettingsSchema.parse({ ...current, ...fields }),
      );
    },
    async updateAppearanceTheme(theme: AppearanceTheme): Promise<void> {
      const parsed = AppearanceThemeSchema.parse(theme);
      await repository.commitSettingsUpdate((current) => ({
        ...current,
        appearanceTheme: parsed,
      }));
    },

    /**
     * Pauses or resumes background work. Pausing (unless it lets the current
     * job finish) stops a running site check at once.
     */
    async setActivityControl(
      input: SetJobFinderActivityControlInput,
    ): Promise<JobFinderActivityControl> {
      const parsed = SetJobFinderActivityControlInputSchema.parse(input);
      const control = JobFinderActivityControlSchema.parse({
        paused: parsed.paused,
        pausedAt: parsed.paused ? new Date().toISOString() : null,
        reason: parsed.paused ? (parsed.reason ?? null) : null,
        ...(parsed.paused && parsed.pauseBehavior
          ? { pauseBehavior: parsed.pauseBehavior }
          : {}),
      });
      await repository.saveActivityControl(control);
      options.onActivityControlChanged?.(control);
      if (parsed.paused && parsed.pauseBehavior !== "finish_current") {
        activeSourceDebugAbortControllerRef.current?.abort();
        await Promise.allSettled([activeSourceDebugPromiseRef.current]);
      }
      return control;
    },

    applyProfileCopilotPatchGroup: copilot.applyProfileCopilotPatchGroup,
    rejectProfileCopilotPatchGroup: copilot.rejectProfileCopilotPatchGroup,
    undoProfileRevision: copilot.undoProfileRevision,
    applyAssistantProfileOperations:
      assistantEdits.applyAssistantProfileOperations,
    undoAssistantProfileChange: assistantEdits.undoAssistantProfileChange,
    undoAssistantSettingsChange: assistantEdits.undoAssistantSettingsChange,

    /** Checks how to read one job site and saves what it learned. */
    runSourceDebug: (
      targetId: string,
      signal?: AbortSignal,
      onProgress?: (event: SourceDebugProgressEvent) => void,
    ) =>
      runSourceCheck(
        targetId,
        signal,
        { clearExistingInstructions: true },
        onProgress,
      ),
    async verifySourceInstructions(
      targetId: string,
      instructionId: string,
      signal?: AbortSignal,
      onProgress?: (event: SourceDebugProgressEvent) => void,
    ): Promise<SourceDebugRunRecord> {
      const artifact = (await repository.listSourceInstructionArtifacts()).find(
        (entry) => entry.id === instructionId && entry.targetId === targetId,
      );
      if (!artifact)
        throw new Error(`Unknown source instruction '${instructionId}'.`);
      return runSourceCheck(
        targetId,
        signal,
        { clearExistingInstructions: false, reviewInstructionId: artifact.id },
        onProgress,
      );
    },
    /**
     * Stops a running site check and every resume import, late branches
     * included, and waits until none of them can write again. For app
     * shutdown and Reset everything; the service takes no imports after.
     */
    async stop(): Promise<void> {
      activeSourceDebugAbortControllerRef.current?.abort();
      importStop.abort();
      await Promise.allSettled([
        activeSourceDebugPromiseRef.current,
        ...importsInFlight,
        ...ctx.backgroundWork,
      ]);
    },
    async cancelSourceDebug(runId: string): Promise<void> {
      if (
        ctx.activeSourceDebugExecutionIdRef.current !== runId ||
        !activeSourceDebugAbortControllerRef.current
      )
        return;
      activeSourceDebugAbortControllerRef.current.abort();
      await Promise.allSettled([activeSourceDebugPromiseRef.current]);
    },
    // Site check runs and the guidance they saved.
    ...sourceDebugStore,

    /** Reads job postings off a page's text; saves nothing. */
    extractJobsFromPageText(input: {
      pageText: string;
      pageUrl: string;
      pageType: "search_results" | "job_detail";
      maxJobs: number;
      signal?: AbortSignal;
    }): Promise<JobPosting[]> {
      return options.aiClient.extractJobsFromPage({
        pageText: input.pageText,
        pageUrl: input.pageUrl,
        pageType: input.pageType,
        maxJobs: input.maxJobs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
  };
}

export type ProfileService = ReturnType<typeof createProfileService>;
