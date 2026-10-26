import { searchPreferencesForCampaignRun } from "./campaign-dashboard";
import { withPlanAssessment } from "./plan-assessment";
import {
  getAiProviderAccessFailure,
  isAiServiceBusy,
} from "@nestor/ai-providers";
import {
  SavedJobSchema,
  type SavedJob,
  type CandidateProfile,
} from "@nestor/contracts";
import { projectDiscoveryJobViews } from "./listing-activity";
import {
  DEFAULT_RESUME_APPLICATION_MODE,
} from "./job-resume-application-mode";
import type {
  WorkspaceServiceContext,
} from "./workspace-service-context";
import type { JobFinderWorkspaceService } from "./workspace-service-contracts";
import {
  createModelListingPageReader,
  enrichSavedJobListingDetails,
  jobNeedsListingDetail,
  hasCompleteListingDetail,
} from "./listing-detail-enrichment";
import { jobNeedsFitJudgment } from "./fit-judgment";
import { createMatchAssessmentSession } from "./match-assessment-session";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import { createMatchAssessment, createMatchAssessmentAsync } from "./matching";



type WorkspaceApplicationMethods = Pick<
  JobFinderWorkspaceService,
  | "assessJobListing"
  | "queueJobForReview"
  | "queueJobsForReview"
  | "removeJobFromReview"
  | "removeJobsFromReview"
>;

/**
 * True when the only change between two profiles is answers the person saved
 * for next time. Saving an answer while a batch runs (the default now) must
 * not fail the application being filled in meanwhile: the resume it attached
 * does not read the saved answers.
 */
export function onlySavedAnswersWereAdded(
  before: CandidateProfile,
  after: CandidateProfile,
): boolean {
  const beforeAnswers = before.answerBank.customAnswers;
  const afterAnswers = after.answerBank.customAnswers;
  const kept = new Set(beforeAnswers.map((answer) => JSON.stringify(answer)));
  if (
    afterAnswers.length < beforeAnswers.length ||
    afterAnswers.filter((answer) => kept.has(JSON.stringify(answer))).length !==
      beforeAnswers.length
  ) {
    return false;
  }
  const withoutCustomAnswers = (profile: CandidateProfile) =>
    JSON.stringify({
      ...profile,
      answerBank: { ...profile.answerBank, customAnswers: [] },
    });
  return withoutCustomAnswers(before) === withoutCustomAnswers(after);
}



export function createWorkspaceApplicationMethods(
  ctx: WorkspaceServiceContext,
): WorkspaceApplicationMethods {
  const removedResumeJobIds = new Set<string>();

  const pendingListingReads = new Map<string, number>();
  const listingReadGenerations = new Map<string, number>();
  let activeListingReads = 0;
  const listingGeneration = () =>
    ctx.listingAssessmentGenerationRef?.current ?? 0;
  const listingReadCurrent = (generation: number) =>
    generation === listingGeneration() && !ctx.isWorkspaceClosing?.();

  type ListingReadOptions = {
    force?: boolean;
    throwOnFailure?: boolean;
    resumeWriterOwnsSlot?: boolean;
  };
  const listingReads = new Map<
    string,
    {
      generation: number;
      options: ListingReadOptions;
      promise: Promise<void>;
    }
  >();
  const listingSlotWaiters: Array<() => void> = [];
  let occupiedListingSlots = 0;

  /** An abort as an Error, whatever the signal was aborted with. */
  function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }

  function acquireListingSlot(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = listingSlotWaiters.indexOf(start);
        if (index >= 0) listingSlotWaiters.splice(index, 1);
        reject(abortReason(signal));
      };
      const start = () => {
        signal.removeEventListener("abort", cancel);
        if (signal.aborted) {
          reject(abortReason(signal));
          return;
        }
        occupiedListingSlots += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          occupiedListingSlots -= 1;
          listingSlotWaiters.shift()?.();
        });
      };
      if (signal.aborted) {
        reject(abortReason(signal));
        return;
      }
      if (occupiedListingSlots < 2) start();
      else {
        listingSlotWaiters.push(start);
        signal.addEventListener("abort", cancel, { once: true });
      }
    });
  }

  async function withListingAssessmentSlot<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const signal =
      ctx.listingAssessmentAbortControllerRef?.current.signal ??
      new AbortController().signal;
    if (ctx.isWorkspaceClosing?.())
      throw new Error(
        "Job Finder changed or closed before this assessment could start.",
      );
    let release: (() => void) | undefined;
    let cancel: (() => void) | undefined;
    try {
      release = await acquireListingSlot(signal);
      const stopped = new Promise<never>((_resolve, reject) => {
        cancel = () => reject(abortReason(signal));
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
      signal.throwIfAborted();
      return await Promise.race([operation(signal), stopped]);
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
      release?.();
    }
  }
  ctx.withListingAssessmentSlot = withListingAssessmentSlot;

  async function readListingDetailForShortlistedJob(
    jobId: string,
    options: ListingReadOptions = {},
  ): Promise<void> {
    const generation = listingGeneration();
    if (!listingReadCurrent(generation)) {
      if (options.throwOnFailure)
        throw new Error(
          "Job Finder changed or closed before this listing could be read.",
        );
      return;
    }
    const existing = listingReads.get(jobId);
    if (existing?.generation === generation) {
      const needsFreshRead =
        (options.force && !existing.options.force) ||
        (options.throwOnFailure && !existing.options.throwOnFailure);
      if (!needsFreshRead) return existing.promise;
      await existing.promise;
      return readListingDetailForShortlistedJob(jobId, options);
    }
    const signal =
      ctx.listingAssessmentAbortControllerRef?.current.signal ??
      new AbortController().signal;
    const promise = (async () => {
      try {
        // Explicit resume jobs already hold a writer permit. Their model
        // listing check uses that capacity; background checks retain two slots.
        if (options.resumeWriterOwnsSlot)
          await performListingDetailRead(jobId, options);
        else
          await withListingAssessmentSlot(() =>
            performListingDetailRead(jobId, options),
          );
      } catch (error) {
        if (options.throwOnFailure || !signal.aborted) throw error;
      }
    })();
    const request = { generation, options, promise };
    listingReads.set(jobId, request);
    try {
      await promise;
    } finally {
      if (listingReads.get(jobId) === request) listingReads.delete(jobId);
    }
  }

  function drainListingReads(): void {
    while (activeListingReads < 2 && pendingListingReads.size > 0) {
      const [jobId, generation] = pendingListingReads.entries().next().value!;
      pendingListingReads.delete(jobId);
      if (!listingReadCurrent(generation)) {
        if (listingReadGenerations.get(jobId) === generation) {
          listingReadGenerations.delete(jobId);
          ctx.listingAssessmentJobIds?.delete(jobId);
        }
        continue;
      }
      activeListingReads += 1;
      void readListingDetailForShortlistedJob(jobId)
        .catch((error: unknown) => {
          if (listingReadCurrent(generation))
            console.warn("[shortlist] Listing assessment failed", error);
        })
        .finally(() => {
          activeListingReads -= 1;
          if (listingReadGenerations.get(jobId) === generation) {
            listingReadGenerations.delete(jobId);
            ctx.listingAssessmentJobIds?.delete(jobId);
          }
          if (listingReadCurrent(generation))
            ctx.onListingAssessmentFinished?.();
          drainListingReads();
        });
    }
  }

  async function queueJobsForReview(jobIds: readonly string[]): Promise<void> {
    const generation = listingGeneration();
    const assertCurrent = () => {
      if (!listingReadCurrent(generation))
        throw new Error(
          "Job Finder changed or closed before these jobs could be shortlisted. No jobs were added.",
        );
    };
    assertCurrent();
    const ids = [...new Set(jobIds)];
    if (ids.length === 0) return;
    const requested = new Set(ids);
    const display = await ctx.repository.readDisplayCollections?.();
    const [settings, preferences, selectedSaved, intelligence, assets, attempts] =
      await Promise.all([
      ctx.repository.getSettings(),
      ctx.repository.readSearchPreferencesProjection?.() ??
        ctx.repository.getSearchPreferences(),
      ctx.repository.listSavedJobsByIds(ids),
      ctx.repository.readIntelligenceProjection?.() ??
        ctx.repository.getIntelligenceState(),
      display?.tailoredAssets ?? ctx.repository.listTailoredAssets(),
      display?.applicationAttempts ?? ctx.repository.listApplicationAttempts(),
    ]);
    const selected = new Map(selectedSaved.map((job) => [job.id, job]));
    for (const id of ids)
      if (!selected.has(id))
        throw new Error(`Unable to shortlist unknown job '${id}'.`);
    const views = projectDiscoveryJobViews({
      jobs: [...selected.values()],
      listingSignals: intelligence.safeguards.listingSignals,
      applicationAttempts: attempts,
    });
    for (const view of views)
      if (requested.has(view.id) && view.listingActivity.status === "closed")
        throw new Error(
          `Unable to shortlist closed job '${view.id}'. The listing has explicit closed evidence.`,
        );
    const assetByJob = new Map(assets.map((asset) => [asset.jobId, asset]));
    const shortlist = (job: SavedJob): SavedJob => {
      assertCurrent();
      if (
        job.status === "archived" &&
        selected.get(job.id)?.status !== "archived"
      )
        throw new Error(
          `Unable to shortlist '${job.title}': it was removed while this selection was being saved.`,
        );
      if (job.matchAssessment.judgment?.listingClosed)
        throw new Error(
          `Unable to shortlist '${job.title}': the listing says it is closed.`,
        );
      if (
        ["drafting", "ready_for_review", "approved", "submitted"].includes(
          job.status,
        )
      )
        return job;
      return {
        ...job,
        shortlistedAt: new Date().toISOString(),
        status:
          assetByJob.get(job.id)?.status === "ready"
            ? "ready_for_review"
            : "drafting",
        resumeApplicationMode:
          job.resumeApplicationMode ??
          settings.resumeApplicationMode ??
          DEFAULT_RESUME_APPLICATION_MODE,
        resumeTailoringMode:
          job.resumeTailoringMode ?? preferences.tailoringMode,
      };
    };
    assertCurrent();
    await ctx.repository.commitSavedJobDelta({
      updateJobIds: ids,
      update: (job) => shortlist(job),
    });
    for (const id of ids) {
      if (listingReadGenerations.get(id) === generation) continue;
      listingReadGenerations.set(id, generation);
      ctx.listingAssessmentJobIds?.add(id);
      pendingListingReads.set(id, generation);
    }
    drainListingReads();
  }

  /**
   * Shortlisting is the moment the job's body starts to matter: the tailored
   * resume is written toward it and the fit score gates "Prepare". If the
   * search left this job as a card, read its page now, once, and re-score.
   * Never fatal: a page that will not read leaves the shortlist unchanged.
   */
  async function performListingDetailRead(
    jobId: string,
    options: {
      /**
       * Read again even inside the retry back-off. Creating a resume is the
       * moment the listing text matters most; a fetch that failed during a
       * network blip must not leave the job untailorable for hours.
       */
      force?: boolean;
      throwOnFailure?: boolean;
      resumeWriterOwnsSlot?: boolean;
    } = {},
  ): Promise<void> {
    const fetchListingHtml = ctx.fetchListingHtml;
    if (!fetchListingHtml) {
      return;
    }
    try {
      const generation = listingGeneration();
      const signal = ctx.listingAssessmentAbortControllerRef?.current.signal;
      if (!listingReadCurrent(generation)) return;
      const [job] = await ctx.repository.listSavedJobsByIds([jobId]);
      if (!job) {
        if (options.throwOnFailure) {
          throw new Error("This job is not in the saved list.");
        }
        return;
      }
      if (!listingReadCurrent(generation)) return;
      const alreadyRead = hasCompleteListingDetail(job);
      // Resume writing needs the captured posting body, not another fit
      // verdict. Explicit assessment controls still request a fresh judgment.
      if (options.resumeWriterOwnsSlot && alreadyRead) return;
      if (!options.force && !alreadyRead && !jobNeedsListingDetail(job)) {
        return;
      }
      const [profile, profilePreferences, settings, campaignState] =
        await Promise.all([
          ctx.repository.getProfile(),
          ctx.repository.getSearchPreferences(),
          ctx.repository.getSettings(),
          ctx.repository.getCampaignState(),
        ]);
      const assessmentPlanId = campaignState?.activeCampaignId ?? null;
      const activePlan = campaignState?.campaigns.find(
        (plan) => plan.id === assessmentPlanId,
      );
      const searchPreferences = activePlan
        ? searchPreferencesForCampaignRun(activePlan)
        : profilePreferences;
      const session = createMatchAssessmentSession({
        profile,
        // Scored with the same remote setting a search uses, so reading the
        // listing on shortlist does not flip the job's location verdict.
        searchPreferences: withSavedJobSearchBehavior(
          enrichSearchPreferencesFromProfile(searchPreferences, profile),
          settings,
        ),
        calculate: createMatchAssessment,
      });
      if (
        alreadyRead &&
        !options.throwOnFailure &&
        !jobNeedsFitJudgment(
          job,
          session.verdictFingerprint,
          session.contextFingerprint,
        ) &&
        session.assessPersisted(job, job.matchAssessment).requirementsSource ===
          "model"
      )
        return;
      if (alreadyRead && !options.throwOnFailure) {
        const assessed = await createMatchAssessmentAsync(
          ctx.aiClient,
          profile,
          withSavedJobSearchBehavior(
            enrichSearchPreferencesFromProfile(searchPreferences, profile),
            settings,
          ),
          job,
          signal,
          // Shortlisting asked for the job, not for this read.
          { background: true },
        );
        const matchAssessment = session.remember(job, assessed);
        if (!listingReadCurrent(generation)) return;
        await ctx.repository.commitSavedJobDelta({
          updateJobIds: [jobId],
          update: (current) =>
            current.id === jobId && current.description === job.description
              ? withPlanAssessment(current, assessmentPlanId, matchAssessment)
              : current,
        });
        return;
      }
      const enrichment = await enrichSavedJobListingDetails({
        jobs: [job],
        ...(signal ? { signal } : {}),
        fetchHtml: fetchListingHtml,
        readPage: createModelListingPageReader(ctx.aiClient),
        ...(ctx.browserRuntime.readRenderedPage
          ? {
              readRenderedPage: ctx.browserRuntime.readRenderedPage.bind(
                ctx.browserRuntime,
              ),
            }
          : {}),
        assess: async (posting) => {
          // The writer needs the listing's text, not a fresh verdict: the
          // job keeps its verdict and the next judging pass refreshes it.
          // Asking here added a minute and 9K tokens to every such resume.
          if (options.resumeWriterOwnsSlot) return session.assess(posting);
          try {
            const assessed = await createMatchAssessmentAsync(
              ctx.aiClient,
              profile,
              withSavedJobSearchBehavior(
                enrichSearchPreferencesFromProfile(searchPreferences, profile),
                settings,
              ),
              posting,
              signal,
              // Only "Judge fit" waits on this read.
              { background: !options.throwOnFailure },
            );
            return session.remember(posting, assessed);
          } catch (error) {
            if (options.throwOnFailure) throw error;
            return session.assess(posting);
          }
        },
        timeBudgetMs: 9_000,
        ...(options.force ? { ignoreRetryBackoff: true } : {}),
        ...(options.throwOnFailure ? { rereadComplete: true } : {}),
      });
      const next = enrichment.jobs[0];
      if (!next || enrichment.changedJobIds.length === 0) {
        return;
      }
      const applyRead = (current: SavedJob): SavedJob =>
        current.id === jobId &&
        current.description === job.description &&
        current.canonicalUrl === job.canonicalUrl
          ? {
              ...current,
              company: next.company,
              location: next.location,
              description: next.description,
              summary: next.summary,
              salaryText: next.salaryText,
              postedAt: next.postedAt,
              employmentType: next.employmentType,
              workMode: next.workMode,
              keySkills: next.keySkills,
              keywordSignals: next.keywordSignals,
              responsibilities: next.responsibilities,
              minimumQualifications: next.minimumQualifications,
              preferredQualifications: next.preferredQualifications,
              seniority: next.seniority,
              benefits: next.benefits,
              applicationUrl: next.applicationUrl,
              provenance: next.provenance,
              normalizedCompensation: next.normalizedCompensation,
              screeningHints: next.screeningHints,
              detailQuality: next.detailQuality,
              listingDetailFetch: next.listingDetailFetch,
              listingDetailCapture: next.listingDetailCapture,
              planAssessments: withPlanAssessment(
                current,
                assessmentPlanId,
                next.matchAssessment,
              ).planAssessments,
              matchAssessment: assessmentPlanId
                ? current.matchAssessment
                : next.matchAssessment,
            }
          : current;
      if (!listingReadCurrent(generation)) return;
      await ctx.repository.commitSavedJobDelta({
        updateJobIds: [jobId],
        update: applyRead,
      });
      if (enrichment.providerAccessError instanceof Error)
        throw enrichment.providerAccessError;
      if (
        options.throwOnFailure &&
        next.listingDetailFetch?.outcome !== "enriched" &&
        next.listingDetailFetch?.outcome !== "partial"
      ) {
        throw new Error(
          next.listingDetailFetch?.detail ??
            "The listing could not be assessed. Your previous assessment was kept.",
        );
      }
    } catch (error) {
      // A resume is written toward the listing: when the AI service refused
      // the read or was too busy for it, the writer stops rather than saving
      // the person's original wording as if the listing had no text.
      if (
        options.resumeWriterOwnsSlot &&
        !getAiProviderAccessFailure(error) &&
        isAiServiceBusy(error)
      )
        throw new Error(
          "The AI service is busy right now, so this resume was not written. Nothing was changed. Try again in a few minutes.",
          { cause: error },
        );
      if (
        options.throwOnFailure ||
        (options.resumeWriterOwnsSlot && getAiProviderAccessFailure(error))
      )
        throw error;
      if (
        ctx.listingAssessmentAbortControllerRef?.current.signal.aborted ||
        ctx.isWorkspaceClosing?.()
      )
        return;
      // The shortlist itself succeeded; the body stays unread for now and the
      // job records nothing, so the next look can try again.
      console.warn("[shortlist] Listing assessment failed", error);
    }
  }

  type DirectApplyExecutionClaim = {
    jobId: string;
    applicationRecordId: string;
    runId: string;
    resultId: string;
    controller: AbortController;
  };

















  const resumeDraftTransitionTails = new Map<string, Promise<void>>();

  async function withResumeDraftTransition<T>(
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = resumeDraftTransitionTails.get(jobId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    resumeDraftTransitionTails.set(jobId, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (resumeDraftTransitionTails.get(jobId) === tail) {
        resumeDraftTransitionTails.delete(jobId);
      }
    }
  }
  // Assistant edits queue on the same per-job transition tail.
  ctx.withResumeDraftTransition = withResumeDraftTransition;






















  return {
    async assessJobListing(jobId) {
      if (!ctx.fetchListingHtml)
        throw new Error("The listing reader is unavailable.");
      await readListingDetailForShortlistedJob(jobId, {
        force: true,
        throwOnFailure: true,
      });
      return ctx.getWorkspaceSnapshot();
    },
    queueJobsForReview,
    async queueJobForReview(jobId) {
      await queueJobsForReview([jobId]);
      return ctx.getWorkspaceSnapshot();
    },
    async removeJobFromReview(jobId) {
      removedResumeJobIds.add(jobId);
      await ctx.updateJob(jobId, (job) =>
        SavedJobSchema.parse({
          ...job,
          status: "shortlisted",
        }),
      );

      return ctx.getWorkspaceSnapshot();
    },
    async removeJobsFromReview(jobIds) {
      for (const jobId of new Set(jobIds)) {
        removedResumeJobIds.add(jobId);
        await ctx.updateJob(jobId, (job) =>
          SavedJobSchema.parse({
            ...job,
            status: "shortlisted",
          }),
        );
      }
    },

  };
}
