import { readWorkspaceApplicationAnswers } from "./workspace-application-answer-execution";
import { withSettingsFitBehavior } from "./fit-search-behavior";
import { jobSiteTarget } from "@nestor/contracts";
import {
  getAiProviderAccessFailure,
  isAiServiceBusy,
} from "@nestor/ai-providers";
import {
  describeApplicationPreparation,
  hasVerifiedApplicationSubmission,
} from "./workspace-apply-run-support";
import {
  releaseFinishedApplicationPages,
  reuseApplicationPage,
} from "./application-page-lifecycle";
import { savedResumeDigestMatches } from "./resume-file-integrity";
import {
  applicationSiteKey,
  applicationPreparationConcurrency,
  type ExecuteApplicationFlowInput,
} from "@nestor/browser-runtime";
import { creditOwnApplicationAnswers } from "./review-card-own-answers";
import {
  buildApplyLetterDependencies,
  mergeApplyReviewCards,
  createApplyFormPreparer,
  resolveApplySiteLabel,
} from "./agent-application-preparation";
import {
  persistApplicationPreparationProgress,
  persistApplicationWaitingForBrowserTab,
} from "./application-preparation-progress";
import { resolveApplicationAttachmentsForExecution } from "./workspace-application-attachments";
import {
  authorizeReviewedApplicationOrigin,
  resolveApplyAuthorityForJob,
} from "./apply-authority-resolution";
import {
  enforceResolvedApplyAuthorityResult,
  type ApplySubmissionHandoff,
} from "./apply-submission-handoff";
import {
  notSentAfterError,
  recordPreparedApplicationNotSent,
  sendPreparedApplicationIfAllowed,
} from "./apply-submission-run-step";
import {
  APPLICATION_SKIPPED_BY_PERSON_LABEL,
  ApplyJobResultSchema,
  ApplyRecoveryContextSchema,
  ApplyRunSchema,
  ApplicationAttemptConsentDecisionSchema,
  ApplicationAttemptQuestionSchema,
  ApplicationAttemptSchema,
  ApplicationRecordSchema,
  ApplicationResumeArtifactSchema,
  isResumeTemplateApplyEligible,
  SavedJobSchema,
  type SavedJob,
  type ApplyExecutionResult,
  type BrowserVisualEvidenceSummary,
  type CandidateProfile,
  type JobSource,
  type ResumeTemplateDefinition,
  type TailoredAsset,
  type UserActionRequest,
  type JobFinderActivityControl,
} from "@nestor/contracts";
import { isSafelyParkedApplyQueue } from "./workspace-apply-run-recovery";
import { projectDiscoveryJobViews } from "./listing-activity";
import { selectApplicationSighting } from "./listing-sightings";
import { isApprovedTailoredResumeReadyForApply } from "./matching-review-queue";
import {
  buildApplyCopilotArtifacts,
  mapExecutionResultToApplyBlockerReason,
  mapExecutionResultToApplyJobState,
  mapExecutionResultToApplyRunState,
  summarizeApplyJobResultStates,
} from "./workspace-apply-run-support";
import {
  buildConsentSummary,
  buildEvidenceRefIdsFromInstruction,
  buildLatestBlockerSummary,
  buildQuestionSummary,
  buildReplaySummary,
  mergeAttemptBlocker,
  mergeAttemptReplay,
} from "./workspace-application-attempt-support";
import {
  buildInstructionGuidance,
  mergeEvents,
  resolveActiveSourceInstructionArtifact,
} from "./workspace-helpers";
import { uniqueStrings } from "./shared";
import {
  DEFAULT_RESUME_APPLICATION_MODE,
  resolveJobResumeApplicationMode,
} from "./job-resume-application-mode";
import {
  evaluateCampaignApplyStopRules,
  isQuestionHandoffPauseReason,
} from "./campaign-apply-stop-rules";
import {
  deriveRecoveredApplyRunCounters,
  isInterruptedApplyJobState,
} from "./workspace-apply-run-recovery";
import { assertResumeProfileRevisionCurrent } from "./workspace-application-resume-support";
import { createApplicationUserActionResumer } from "./workspace-application-user-action-resumption";
import {
  PERSON_TOOK_OVER_SUMMARY,
  handApplicationPageToPersonForAccessStep,
  persistApplicationUserAction,
  retireCancelledApplicationUserActions,
} from "./workspace-application-user-action";
import { persistAutomaticApplicationSafeguards } from "./automatic-safeguards";
import { resolvePrepareOnlyIntermediateMutationAuthority } from "./prepare-only-intermediate-mutation-authority";
import { withApplicationRecordTransition } from "./application-crm";
import type {
  ApplicationAutomationMode,
  ApplicationReviewCard,
  JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import type {
  ApplicationPreparationCapacityToken,
  TaskLocalApplicationCredentials,
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
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import { createMatchAssessment, createMatchAssessmentAsync } from "./matching";
import { readSavedJob } from "./read-saved-job";

function buildRecoveryInstructions(input: {
  blockerSummary: string | null;
  latestCheckpointDetail: string | null;
  latestCheckpointLabel: string | null;
  latestCheckpointUrl: string | null;
}) {
  return uniqueStrings(
    [
      input.latestCheckpointLabel
        ? `Recovery checkpoint: ${input.latestCheckpointLabel}.`
        : null,
      input.latestCheckpointDetail
        ? `Recovery detail: ${input.latestCheckpointDetail}`
        : null,
      input.latestCheckpointUrl
        ? `Continue on the currently open retained application page for this checkpoint (${input.latestCheckpointUrl}). Do not navigate to or reload that URL; the open page holds the person's completed fields.`
        : null,
      input.blockerSummary
        ? `Recovery goal: avoid the previously retained blocker if the current page still presents the same branch. ${input.blockerSummary}`
        : null,
    ].filter((value): value is string =>
      Boolean(value && value.trim().length > 0),
    ),
  );
}

function getApplyResultSortTime(input: {
  completedAt: string | null;
  updatedAt: string;
  startedAt: string;
}): number {
  return Date.parse(input.completedAt ?? input.updatedAt ?? input.startedAt);
}

type WorkspaceApplicationMethods = Pick<
  JobFinderWorkspaceService,
  | "assessJobListing"
  | "queueJobForReview"
  | "queueJobsForReview"
  | "removeJobFromReview"
  | "removeJobsFromReview"
> & {
  /** Stops an old apply run that is still running from saved state. */
  cancelApplyRun(
    runId: string,
    options?: { skippedByPerson?: readonly string[] },
  ): Promise<JobFinderWorkspaceSnapshot>;
  resumeParkedApplyRuns(
    control: JobFinderActivityControl,
    onFinished?: () => void,
  ): Promise<void>;
  resumeApplicationUserAction(
    request: UserActionRequest,
    taskLocalCredentials?: TaskLocalApplicationCredentials,
  ): Promise<void>;
};

async function assertPreparationProfileCurrent(
  ctx: WorkspaceServiceContext,
  prerequisites: { profile: CandidateProfile; profileRevision: number },
): Promise<void> {
  await assertCurrentResumeProfile(
    ctx,
    prerequisites.profileRevision,
    "recording this application preparation",
  );
}

async function assertCurrentResumeProfile(
  ctx: WorkspaceServiceContext,
  expectedRevision: number,
  operation: string,
  snapshotProfile?: CandidateProfile,
): Promise<
  Awaited<
    ReturnType<WorkspaceServiceContext["repository"]["getProfileWithRevision"]>
  >
> {
  return assertResumeProfileRevisionCurrent(
    ctx,
    expectedRevision,
    operation,
    snapshotProfile,
  );
}

export function createWorkspaceApplicationMethods(
  ctx: WorkspaceServiceContext,
): WorkspaceApplicationMethods {
  const removedResumeJobIds = new Set<string>();
  async function reviewCardForFreshPreparation(
    applicationRecordId: string,
    current: ApplicationReviewCard | null,
  ): Promise<ApplicationReviewCard | null> {
    if (!current) return null;
    const results = await ctx.repository.listApplyJobResults({
      applicationRecordId,
    });
    const previousResult = [...results]
      .filter((result) => result.reviewCard !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    let previous = previousResult?.reviewCard ?? null;
    // The earlier screen can credit a form value from its answer records.
    // Carry that verified evidence too; the new run has different records.
    const needsRecord = (answer: ApplicationReviewCard["answers"][number]) =>
      (answer.source === "your answer to this question" ||
        answer.source === "the filled application form") &&
      (!answer.sourceId ||
        answer.sourceId.startsWith("observed.") ||
        answer.sourceId.startsWith("answerLibrary.application_"));
    if (previousResult && previous?.answers.some(needsRecord)) {
      const [questions, answers] = await Promise.all([
        ctx.repository.listApplicationQuestionRecords({
          applicationRecordId,
          runId: previousResult.runId,
        }),
        ctx.repository.listApplicationAnswerRecords({
          applicationRecordId,
          runId: previousResult.runId,
        }),
      ]);
      const selectedValues = (value: string): string[] => {
        try {
          const parsed: unknown = JSON.parse(value);
          if (
            Array.isArray(parsed) &&
            parsed.every((entry) => typeof entry === "string")
          )
            return [...parsed].sort();
        } catch {
          /* Older answers used separators. */
        }
        return value
          .split(/[\n,;]+/u)
          .map((part) => part.trim())
          .filter(Boolean)
          .sort();
      };
      previous = {
        ...previous,
        answers: previous.answers.map((answer) => {
          if (!needsRecord(answer)) return answer;
          const question = questions.find(
            (entry) => entry.prompt === answer.question,
          );
          const recorded = answers.find(
            (entry) =>
              entry.questionId === question?.id &&
              entry.sourceKind === "user" &&
              (entry.text === answer.answer ||
                (question?.answerControlType === "multi_choice" &&
                  JSON.stringify(selectedValues(entry.text)) ===
                    JSON.stringify(selectedValues(answer.answer)))) &&
              (entry.status === "filled" ||
                (entry.id === question?.selectedAnswerId &&
                  entry.status !== "rejected" &&
                  entry.status !== "skipped")),
          );
          return recorded
            ? {
                ...answer,
                source: "your answer to this question",
                sourceId: `applicationAnswer.${recorded.id}`,
              }
            : answer;
        }),
      };
    }
    const [ownQuestions, ownAnswers] = await Promise.all([
      ctx.repository.listApplicationQuestionRecords({ applicationRecordId }),
      ctx.repository.listApplicationAnswerRecords({ applicationRecordId }),
    ]);
    return creditOwnApplicationAnswers(
      mergeApplyReviewCards(previous, current, { freshPreparation: true }),
      ownQuestions,
      ownAnswers,
    );
  }

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
    const [
      settings,
      preferences,
      selectedSaved,
      intelligence,
      assets,
      attempts,
    ] = await Promise.all([
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
      const [profile, profilePreferences, settings] = await Promise.all([
        ctx.repository.getProfile(),
        ctx.repository.getSearchPreferences(),
        ctx.repository.getSettings(),
      ]);
      const searchPreferences = enrichSearchPreferencesFromProfile(
        withSettingsFitBehavior(profilePreferences, settings),
        profile,
      );
      const session = createMatchAssessmentSession({
        profile,
        // Scored with the same remote setting a search uses, so reading the
        // listing on shortlist does not flip the job's location verdict.
        searchPreferences,
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
          searchPreferences,
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
              ? { ...current, matchAssessment }
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
              searchPreferences,
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
              matchAssessment: next.matchAssessment,
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

  // Copilot and the legacy approveApply entry point both execute a browser
  // flow directly instead of going through executeSafeApplyRun(). Keep one
  // in-memory claim per job so repeated renderer requests cannot open two
  // application pages, while the shared context maps let pause/shutdown abort
  // and await the same work.
  const activeDirectApplyClaims = new Map<string, DirectApplyExecutionClaim>();

  // Staged auto runs claim their job ids here for the whole execution so a
  // second approval of an overlapping run is rejected before any browser
  // session opens. The scan-and-set in executeSafeApplyRun must stay free of
  // awaits to keep the check atomic against concurrent approvals.
  const activeStagedApplyJobClaims = new Map<string, string>();

  async function withApplyRunTransition<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      ctx.applyRunTransitionTails.get(runId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    ctx.applyRunTransitionTails.set(runId, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (ctx.applyRunTransitionTails.get(runId) === tail) {
        ctx.applyRunTransitionTails.delete(runId);
      }
    }
  }

  // Lock ordering: run, CRM, consent, and request transitions are acquired
  // first; this per-job application-record tail is only ever acquired inside
  // one of them.
  function withExactApplicationRecordTransition<T>(
    applicationRecordId: string,
    jobId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withApplicationRecordTransition(
      ctx.repository,
      applicationRecordId,
      async () => {
        const record = (await ctx.repository.listApplicationRecords()).find(
          (entry) => entry.id === applicationRecordId,
        );
        if (!record || record.jobId !== jobId) {
          throw new Error(
            `Application record '${applicationRecordId}' does not belong to job '${jobId}'.`,
          );
        }
        return operation();
      },
    );
  }

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

  function validateApplyTemplate(input: {
    templateId: string;
    templates: readonly ResumeTemplateDefinition[];
    jobTitle: string;
  }) {
    const template = input.templates.find(
      (entry) => entry.id === input.templateId,
    );

    if (!template || !isResumeTemplateApplyEligible(template)) {
      throw new Error(
        `The selected resume template for '${input.jobTitle}' is not eligible for automatic apply. Choose an apply-safe template, export a fresh PDF, and approve it again.`,
      );
    }
  }

  async function verifyResumeFileIntegrity(input: {
    expectedSha256: string | null | undefined;
    filePath: string;
    label: string;
  }): Promise<string | null> {
    if (!ctx.exportFileVerifier?.sha256) {
      return input.expectedSha256 ?? null;
    }

    if (!input.expectedSha256) {
      throw new Error(
        `${input.label} has no saved SHA-256 integrity record. Re-import or re-export it before starting Apply Copilot.`,
      );
    }

    const actualSha256 = await ctx.exportFileVerifier.sha256(input.filePath);
    if (!savedResumeDigestMatches(input.expectedSha256, actualSha256)) {
      throw new Error(
        `${input.label} changed after it was saved. Re-import or re-export it before starting Apply Copilot.`,
      );
    }

    return actualSha256.toLowerCase();
  }

  /**
   * The application resume artifact must carry the path the verifier actually
   * read, not the recorded one. A workspace whose absolute export path was
   * recorded under an earlier user-data directory still passes the readiness
   * gate here — the verifier recovers the file — but the browser runtime
   * re-checks the artifact path with its own `access()` and fails the run with
   * `missing_resume`, which the stale-blocker sync then clears into another
   * identical "Retry preparation" attempt. Verifiers that cannot resolve keep
   * the recorded path exactly as before.
   */
  async function resolveVerifiedResumeFilePath(
    recordedFilePath: string,
  ): Promise<string> {
    const resolvedFilePath =
      await ctx.exportFileVerifier?.resolvePath?.(recordedFilePath);
    return resolvedFilePath ?? recordedFilePath;
  }

  async function buildIntermediateMutationExecutionOptions(input: {
    job: ReturnType<typeof SavedJobSchema.parse>;
    resumeArtifact: ExecuteApplicationFlowInput["resumeArtifact"];
  }): Promise<
    Pick<
      ExecuteApplicationFlowInput,
      | "intermediateMutationsAuthorized"
      | "intermediateMutationAllowedOrigins"
      | "recheckIntermediateMutationAuthority"
    >
  > {
    const initial = await resolvePrepareOnlyIntermediateMutationAuthority({
      job: input.job,
      now: new Date().toISOString(),
      repository: ctx.repository,
      ...(ctx.readSavedAnswers
        ? { readSavedAnswers: ctx.readSavedAnswers }
        : {}),
      resumeSha256: input.resumeArtifact.sha256,
    });
    if (!initial.authorized) {
      // No saved permission narrows this run, so the run may let the site
      // save answers as they are typed on whichever origin it is filling
      // in. Nothing is sent: the submit guard is separate from this. Owner
      // decision (ADR 0024): a form that will not carry on until it has
      // saved is friction, not a risk worth stopping the run over.
      return {
        intermediateMutationsAuthorized: true,
        intermediateMutationAllowedOrigins: [],
        recheckIntermediateMutationAuthority: () => Promise.resolve(true),
      };
    }

    return {
      intermediateMutationsAuthorized: true,
      intermediateMutationAllowedOrigins: initial.allowedOrigins,
      recheckIntermediateMutationAuthority: async (observedOrigin) => {
        const current = await resolvePrepareOnlyIntermediateMutationAuthority({
          job: input.job,
          now: new Date().toISOString(),
          observedOrigin,
          repository: ctx.repository,
          ...(ctx.readSavedAnswers
            ? { readSavedAnswers: ctx.readSavedAnswers }
            : {}),
          resumeSha256: input.resumeArtifact.sha256,
        });
        return (
          current.authorized &&
          current.authorityEnvelopeId === initial.authorityEnvelopeId &&
          current.authorityRevision === initial.authorityRevision
        );
      },
    };
  }

  async function resolveJobApplyPrerequisites(
    jobId: string,
    scopedSavedJobs?: readonly ReturnType<typeof SavedJobSchema.parse>[],
    scope?: {
      tailoredAssets?: readonly TailoredAsset[];
      profile?: Awaited<
        ReturnType<WorkspaceServiceContext["repository"]["getProfile"]>
      >;
      profileRevision?: number;
      settings?: Awaited<
        ReturnType<WorkspaceServiceContext["repository"]["getSettings"]>
      >;
    },
  ) {
    if (
      (await ctx.repository.listApplyJobResults({ jobId })).some(
        hasVerifiedApplicationSubmission,
      )
    ) {
      throw new Error(
        "The employer already confirmed this application. It will not be prepared or sent again.",
      );
    }
    const profileStatePromise =
      scope?.profile && scope.profileRevision !== undefined
        ? Promise.resolve({
            profile: scope.profile,
            revision: scope.profileRevision,
          })
        : ctx.repository.getProfileWithRevision();
    const [
      savedJobs,
      tailoredAssets,
      draft,
      approvedExports,
      profileState,
      settings,
    ] = await Promise.all([
      scopedSavedJobs
        ? Promise.resolve(scopedSavedJobs)
        : ctx.repository.listSavedJobsByIds([jobId]),
      scope?.tailoredAssets
        ? Promise.resolve(scope.tailoredAssets)
        : ctx.repository.listTailoredAssets(),
      ctx.repository.getResumeDraftByJobId(jobId),
      ctx.repository.listResumeExportArtifacts({ jobId }),
      profileStatePromise,
      scope?.settings
        ? Promise.resolve(scope.settings)
        : ctx.repository.getSettings(),
    ]);
    const job = savedJobs.find((entry) => entry.id === jobId) ?? null;

    if (!job) {
      throw new Error(
        `Unable to start automatic apply for unknown job '${jobId}'.`,
      );
    }
    const resumeApplicationMode = resolveJobResumeApplicationMode(
      job,
      settings,
    );
    const profile = profileState.profile;

    if (resumeApplicationMode === "original_resume") {
      const originalResumePath = profile.baseResume.storagePath?.trim() ?? "";
      if (!originalResumePath) {
        throw new Error(
          `The original CV is unavailable for '${job.title}'. Import or re-import it in Profile before starting Apply Copilot.`,
        );
      }

      if (
        ctx.exportFileVerifier &&
        !(await ctx.exportFileVerifier.exists(originalResumePath))
      ) {
        throw new Error(
          `The original CV file is missing on disk for '${job.title}'. Re-import it in Profile before starting Apply Copilot.`,
        );
      }

      const verifiedSha256 = await verifyResumeFileIntegrity({
        expectedSha256: profile.baseResume.sha256,
        filePath: originalResumePath,
        label: "The original CV",
      });
      const verifiedOriginalResumePath =
        await resolveVerifiedResumeFilePath(originalResumePath);

      return {
        job,
        profile,
        profileRevision: profileState.revision,
        resumeApplicationMode,
        resumeArtifact: ApplicationResumeArtifactSchema.parse({
          id: `application_resume_${job.id}_${profile.baseResume.id}`,
          jobId: job.id,
          source: "original_upload",
          sourceDocumentId: profile.baseResume.id,
          exportArtifactId: null,
          fileName: profile.baseResume.fileName,
          filePath: verifiedOriginalResumePath,
          sha256: verifiedSha256,
          approvedAt: new Date().toISOString(),
        }),
      };
    }

    const asset = tailoredAssets.find((entry) => entry.jobId === jobId) ?? null;
    const approvedExportResolution = isApprovedTailoredResumeReadyForApply({
      draft,
      exports: approvedExports,
      asset,
    });
    const approvedExport = approvedExportResolution.approvedExport;

    if (!draft) {
      throw new Error(
        `A tailored resume draft is required before preparing the application for '${job.title}'.`,
      );
    }
    if (!approvedExport) {
      throw new Error(
        `Approve the tailored resume for '${job.title}' before starting this application mode.`,
      );
    }

    // Which roles a resume shows is the writer's choice for the job; a hidden
    // role is simply off this resume and never holds an application back.

    validateApplyTemplate({
      templateId: draft.templateId,
      templates: ctx.documentManager.listResumeTemplates(),
      jobTitle: job.title,
    });

    const selectedFilePath = approvedExport.filePath;
    if (!selectedFilePath) {
      throw new Error(
        `The tailored resume file is unavailable for '${job.title}'. Create the draft again before preparing this application.`,
      );
    }

    if (ctx.exportFileVerifier) {
      const approvedFileExists =
        await ctx.exportFileVerifier.exists(selectedFilePath);

      if (!approvedFileExists) {
        throw new Error(
          `The tailored resume file is missing on disk for '${job.title}'. Create or export it again before preparing this application.`,
        );
      }
    }

    if (approvedExport && !approvedExportResolution.ready) {
      throw new Error(
        `A ready approved tailored resume is required before staging automatic apply for '${job.title}'.`,
      );
    }

    const verifiedSha256 = await verifyResumeFileIntegrity({
      expectedSha256: approvedExport.sha256,
      filePath: selectedFilePath,
      label: "The approved tailored CV",
    });
    const verifiedApprovedExportPath =
      await resolveVerifiedResumeFilePath(selectedFilePath);

    return {
      job,
      profile,
      profileState,
      profileRevision: profileState.revision,
      resumeApplicationMode,
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: `application_resume_${job.id}_${approvedExport.id}`,
        jobId: job.id,
        source: "tailored_export",
        sourceDocumentId: null,
        exportArtifactId: approvedExport.id,
        fileName:
          selectedFilePath.split(/[\\/]/).at(-1) ?? `${job.title}-resume.pdf`,
        filePath: verifiedApprovedExportPath,
        sha256: verifiedSha256,
        approvedAt: new Date().toISOString(),
      }),
    };
  }

  async function syncRunApplicationRecord(input: {
    applicationRecordId: string;
    consentSummary?: ReturnType<
      typeof ApplicationRecordSchema.shape.consentSummary.parse
    >;
    eventDetail: string;
    eventEmphasis: "neutral" | "positive" | "warning" | "critical";
    eventId: string;
    eventTitle: string;
    jobId: string;
    lastActionLabel: string;
    lastAttemptState?: ReturnType<
      typeof ApplicationRecordSchema.shape.lastAttemptState.parse
    >;
    latestBlocker?: ReturnType<
      typeof ApplicationRecordSchema.shape.latestBlocker.parse
    >;
    nextActionLabel: string | null;
    questionSummary?: ReturnType<
      typeof ApplicationRecordSchema.shape.questionSummary.parse
    >;
    replaySummary?: ReturnType<
      typeof ApplicationRecordSchema.shape.replaySummary.parse
    >;
    /** What the person allowed for this application when it was prepared. */
    automationMode?: ApplicationAutomationMode;
    updatedAt: string;
  }) {
    const job = await readSavedJob(ctx.repository, input.jobId);

    if (!job) {
      return;
    }

    await withExactApplicationRecordTransition(
      input.applicationRecordId,
      input.jobId,
      async () => {
        const applicationRecords =
          await ctx.repository.listApplicationRecords();
        const existingRecord = applicationRecords.find(
          (record) => record.id === input.applicationRecordId,
        );
        if (!existingRecord) {
          throw new Error(
            `Unknown Job Finder application record '${input.applicationRecordId}'.`,
          );
        }
        const nextRecord = ApplicationRecordSchema.parse({
          id: existingRecord.id,
          jobId: input.jobId,
          title: job.title,
          company: job.company,
          status: existingRecord.status,
          lastActionLabel: input.lastActionLabel,
          nextActionLabel: input.nextActionLabel,
          lastUpdatedAt: input.updatedAt,
          lastAttemptState:
            input.lastAttemptState !== undefined
              ? input.lastAttemptState
              : existingRecord.lastAttemptState,
          questionSummary:
            input.questionSummary !== undefined
              ? input.questionSummary
              : existingRecord.questionSummary,
          automationMode: input.automationMode ?? existingRecord.automationMode,
          latestBlocker:
            input.latestBlocker !== undefined
              ? input.latestBlocker
              : existingRecord.latestBlocker,
          consentSummary:
            input.consentSummary !== undefined
              ? input.consentSummary
              : existingRecord.consentSummary,
          replaySummary:
            input.replaySummary !== undefined
              ? input.replaySummary
              : existingRecord.replaySummary,
          crm: existingRecord.crm,
          events: mergeEvents(existingRecord.events, [
            {
              id: input.eventId,
              at: input.updatedAt,
              title: input.eventTitle,
              detail: input.eventDetail,
              emphasis: input.eventEmphasis,
            },
          ]),
        });

        await ctx.repository.upsertApplicationRecord(nextRecord);
      },
    );
  }

  function buildApplyVisualExecutionOptions(input: {
    enabled: boolean;
    source: JobSource;
  }):
    | Pick<
        ExecuteApplicationFlowInput,
        "captureVisualSnapshot" | "analyzeVisualSnapshot"
      >
    | Record<string, never> {
    if (
      !input.enabled ||
      !ctx.browserRuntime.captureVisualSnapshot ||
      !ctx.aiClient.analyzeBrowserVisualSnapshot
    ) {
      return {};
    }

    const captureVisualSnapshot = ctx.browserRuntime.captureVisualSnapshot.bind(
      ctx.browserRuntime,
    );
    const analyzeVisualSnapshot =
      ctx.aiClient.analyzeBrowserVisualSnapshot.bind(ctx.aiClient);

    return {
      captureVisualSnapshot: (request) =>
        captureVisualSnapshot(input.source, request),
      analyzeVisualSnapshot,
    };
  }

  async function buildApplyRecoveryContext(
    jobId: string,
    applicationRecordId: string,
  ) {
    const [runs, results, checkpoints] = await Promise.all([
      ctx.repository.listApplyRuns(),
      ctx.repository.listApplyJobResults({ jobId, applicationRecordId }),
      ctx.repository.listApplicationReplayCheckpoints({
        jobId,
        applicationRecordId,
      }),
    ]);
    const latestResult =
      results
        .filter(
          (entry) =>
            entry.jobId === jobId &&
            entry.applicationRecordId === applicationRecordId &&
            (entry.state !== "planned" ||
              (entry.applicationPreparationStartedAt !== null &&
                entry.applicationPreparationStartedAt !== undefined)),
        )
        .sort((left, right) => {
          const rightTime = getApplyResultSortTime(right);
          const leftTime = getApplyResultSortTime(left);
          return rightTime - leftTime;
        })[0] ?? null;

    if (!latestResult) {
      return {
        recoveryContext: null,
        recoveryInstructions: [] as string[],
      };
    }

    const previousRun =
      runs.find((entry) => entry.id === latestResult.runId) ?? null;
    if (!previousRun) {
      return {
        recoveryContext: null,
        recoveryInstructions: [] as string[],
      };
    }

    const latestRunCheckpoints = checkpoints.filter(
      (checkpoint) =>
        checkpoint.runId === latestResult.runId &&
        checkpoint.resultId === latestResult.id &&
        checkpoint.applicationRecordId === applicationRecordId,
    );
    const latestCheckpoint = latestRunCheckpoints[0] ?? null;
    const retainedVisualEvidence = (() => {
      const seenEvidence = new Set<string>();
      const candidates: BrowserVisualEvidenceSummary[] = [
        ...latestRunCheckpoints.flatMap(
          (checkpoint) => checkpoint.visualEvidence,
        ),
        ...latestResult.visualCheckpoints.flatMap((checkpoint) =>
          checkpoint.retained
            ? [
                {
                  snapshotId: checkpoint.snapshotId,
                  observationSetId: checkpoint.observationSetId,
                  summary: checkpoint.summary,
                  capturedAt: checkpoint.capturedAt,
                  storagePath: checkpoint.storagePath,
                  retention: "retained" as const,
                  redactionLevel: "sensitive" as const,
                  confidence: 0.5,
                  reconciliationStatus:
                    checkpoint.reconciliations[0]?.status ??
                    ("not_compared" as const),
                },
              ]
            : [],
        ),
      ];

      return candidates
        .filter((entry) => entry.retention !== "temporary")
        .flatMap((entry) => {
          const key = `${entry.snapshotId}:${entry.observationSetId}`;
          if (seenEvidence.has(key)) {
            return [];
          }

          seenEvidence.add(key);
          return [entry];
        });
    })();
    const checkpointUrls = uniqueStrings(
      latestRunCheckpoints
        .map((checkpoint) => checkpoint.url)
        .filter(
          (url): url is string =>
            typeof url === "string" && url.trim().length > 0,
        ),
    );

    return {
      recoveryContext: ApplyRecoveryContextSchema.parse({
        previousRunId: previousRun.id,
        previousResultId: latestResult.id,
        previousRunMode: previousRun.mode,
        previousRunState: previousRun.state,
        latestCheckpoint: latestCheckpoint
          ? {
              label: latestCheckpoint.label,
              detail: latestCheckpoint.detail,
              url: latestCheckpoint.url,
              jobState: latestCheckpoint.jobState,
              createdAt: latestCheckpoint.createdAt,
            }
          : null,
        checkpointUrls,
        blockerSummary: latestResult.blockerSummary,
        retainedVisualEvidence,
      }),
      recoveryInstructions: buildRecoveryInstructions({
        blockerSummary: latestResult.blockerSummary,
        latestCheckpointDetail: latestCheckpoint?.detail ?? null,
        latestCheckpointLabel: latestCheckpoint?.label ?? null,
        latestCheckpointUrl: latestCheckpoint?.url ?? null,
      }),
    };
  }

  async function executeSafeApplyRunOwned(
    input: {
      mode: "single_job_auto" | "queue_auto";
      runId: string;
    },
    executionController: AbortController,
    capacityToken?: ApplicationPreparationCapacityToken,
  ): Promise<void> {
    const [
      searchPreferences,
      settings,
      sourceInstructionArtifacts,
      sourceDebugAttempts,
      runs,
      results,
      approvals,
      questionRecords,
      answerRecords,
      artifactRefs,
      checkpoints,
      consentRequests,
      campaignState,
    ] = await Promise.all([
      ctx.repository.getSearchPreferences(),
      ctx.repository.getSettings(),
      ctx.repository.listSourceInstructionArtifacts(),
      ctx.repository.listSourceDebugAttempts(),
      ctx.repository.listApplyRuns(),
      ctx.repository.listApplyJobResults(),
      ctx.repository.listApplySubmitApprovals(),
      ctx.repository.listApplicationQuestionRecords(),
      ctx.repository.listApplicationAnswerRecords(),
      ctx.repository.listApplicationArtifactRefs(),
      ctx.repository.listApplicationReplayCheckpoints(),
      ctx.repository.listApplicationConsentRequests(),
      ctx.repository.getCampaignState(),
    ]);
    const run = runs.find((entry) => entry.id === input.runId) ?? null;
    const savedJobs = run
      ? await ctx.repository.listSavedJobsByIds(run.jobIds)
      : [];
    const savedJobsById = new Map(savedJobs.map((job) => [job.id, job]));

    if (!run) {
      throw new Error(`Unknown apply run '${input.runId}'.`);
    }

    if (run.mode !== input.mode) {
      throw new Error(`Apply run '${input.runId}' is not a ${input.mode} run.`);
    }

    if (!run.submitApprovalId) {
      throw new Error(
        `Apply run '${input.runId}' does not have a submit approval record.`,
      );
    }

    const approval =
      approvals.find((entry) => entry.id === run.submitApprovalId) ?? null;

    if (!approval || approval.status !== "approved") {
      throw new Error(
        `Apply run '${input.runId}' must be approved before it can execute.`,
      );
    }

    if (!ctx.browserRuntime.executeApplicationFlow) {
      throw new Error(
        "The current browser runtime does not support staged apply execution.",
      );
    }

    let currentRunState: ReturnType<typeof ApplyRunSchema.parse> =
      ApplyRunSchema.parse({
        ...run,
        state: "running",
        updatedAt: new Date().toISOString(),
        summary:
          input.mode === "queue_auto"
            ? "Working through these applications."
            : "Applying to this job.",
        detail:
          "Job Finder fills in each application. Whether it sends it is the mode you chose in Settings.",
      });
    const executionSignal = executionController.signal;
    const campaignStopRules = run.campaignId
      ? campaignState?.campaigns.find(
          (campaign) => campaign.id === run.campaignId,
        )?.stopRules
      : undefined;
    const stopIfRunWasCancelled = async (
      waitForResume = false,
    ): Promise<boolean> => {
      if (executionSignal.aborted) {
        return true;
      }
      let activityControl = await ctx.repository.getActivityControl();
      while (
        waitForResume &&
        activityControl.paused &&
        activityControl.pauseBehavior === "finish_current" &&
        !executionSignal.aborted
      ) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        activityControl = await ctx.repository.getActivityControl();
      }
      if (
        (activityControl.paused &&
          activityControl.pauseBehavior !== "finish_current") ||
        executionSignal.aborted
      ) {
        executionController.abort();
        return true;
      }
      const latestRun = (await ctx.repository.listApplyRuns()).find(
        (entry) => entry.id === run.id,
      );
      if (latestRun?.state !== "cancelled") {
        return false;
      }
      executionController.abort();
      return true;
    };

    const persistRunUnlessCancelled = async (
      nextRun: ReturnType<typeof ApplyRunSchema.parse>,
    ): Promise<boolean> =>
      withApplyRunTransition(run.id, async () => {
        const latestRun = (await ctx.repository.listApplyRuns()).find(
          (entry) => entry.id === run.id,
        );
        const activityControl = await ctx.repository.getActivityControl();
        if (
          executionSignal.aborted ||
          (activityControl.paused &&
            activityControl.pauseBehavior !== "finish_current") ||
          latestRun?.state === "cancelled"
        ) {
          executionController.abort();
          return false;
        }
        await ctx.repository.upsertApplyRun(nextRun);
        return true;
      });

    if (!(await persistRunUnlessCancelled(currentRunState))) {
      return;
    }

    let submittedJobs = 0;
    let blockedJobs = 0;
    let failedJobs = 0;
    let skippedJobs = 0;
    let awaitingReviewJobs = 0;
    let pendingConsentRequests = consentRequests.filter(
      (request) => request.runId === run.id && request.status === "pending",
    ).length;
    const openedSources = new Map<JobSource, Promise<void>>();
    let shouldCloseActiveSessionOnExit = false;
    let queuedCampaignPauseReason: string | null = null;
    let admissionStopped = false;
    const admissionStopDetail: string | null = null;
    const readQueueProgress = async () => {
      const committedResults = await ctx.repository.listApplyJobResults({
        runId: run.id,
      });
      const byJob = new Map(
        committedResults.map((result) => [result.jobId, result]),
      );
      const pendingJobs = run.jobIds.filter((jobId) => {
        const result = byJob.get(jobId);
        return (
          !result ||
          ["planned", "question_capture", "filling", "submitting"].includes(
            result.state,
          )
        );
      }).length;
      return {
        ...summarizeApplyJobResultStates(committedResults),
        pendingJobs,
        pendingConsentRequests: (
          await ctx.repository.listApplicationConsentRequests()
        ).filter(
          (request) => request.runId === run.id && request.status === "pending",
        ).length,
      };
    };
    const deferredQueueSafeguards: Array<{
      result: ReturnType<typeof ApplyJobResultSchema.parse>;
      job: ReturnType<typeof SavedJobSchema.parse>;
      now: string;
    }> = [];
    const keepSessionAlive = settings.keepSessionAlive;
    try {
      const processJob = async (index: number): Promise<void> => {
        if (await stopIfRunWasCancelled(true)) {
          return;
        }
        const jobId = run.jobIds[index]!;
        let jobResult = results.find(
          (entry) => entry.runId === run.id && entry.jobId === jobId,
        );

        if (!jobResult?.applicationRecordId) {
          throw new Error(
            `Apply run '${run.id}' has legacy or missing application lineage for job '${jobId}'.`,
          );
        }
        const exactApplicationRecordId = jobResult.applicationRecordId;

        if (jobResult?.state && jobResult.state !== "planned") {
          return;
        }

        const queuedResultId = jobResult.id;
        try {
          const prerequisites = await resolveJobApplyPrerequisites(
            jobId,
            savedJobsById.get(jobId) ? [savedJobsById.get(jobId)!] : [],
          );
          // A prerequisite read is not an active browser preparation yet.
          // Finish current must also hold jobs admitted just before Pause.
          if (await stopIfRunWasCancelled(true)) {
            return;
          }
          // The prerequisite read verifies the selected export/file, but it is
          // not itself a lock. Recheck the shared profile epoch immediately
          // before marking preparation started or opening the browser so an
          // intervening profile edit cannot execute stale identity input.
          await assertCurrentResumeProfile(
            ctx,
            prerequisites.profileRevision,
            "starting automatic application preparation",
          );
          const { job, resumeApplicationMode, resumeArtifact } = prerequisites;
          const recoverySeed = await buildApplyRecoveryContext(
            jobId,
            exactApplicationRecordId,
          );
          await assertCurrentResumeProfile(
            ctx,
            prerequisites.profileRevision,
            "marking this application preparation started",
          );
          const mayStart = await withApplyRunTransition(run.id, async () => {
            if (admissionStopped || (await stopIfRunWasCancelled()))
              return false;
            currentRunState = ApplyRunSchema.parse({
              ...currentRunState,
              currentJobId: jobId,
              updatedAt: new Date().toISOString(),
            });
            await ctx.repository.upsertApplyRun(currentRunState);
            return true;
          });
          if (!mayStart) return;
          jobResult = await ctx.markApplicationPreparationStarted(
            {
              resultId: jobResult.id,
              runId: run.id,
              jobId,
            },
            capacityToken,
          );
          const activeResultIdRun = jobResult.id;
          await reuseApplicationPage({
            ...ctx,
            source: job.source,
            applicationRecordId: exactApplicationRecordId,
            resultId: activeResultIdRun,
          });
          let opening = openedSources.get(job.source);
          if (!opening) {
            opening = ctx.openRunBrowserSession(job.source, {
              purpose: "automation",
            });
            openedSources.set(job.source, opening);
          }
          await opening;
          if (await stopIfRunWasCancelled()) return;
          const provenanceTargetId =
            selectApplicationSighting(job)?.targetId ??
            job.provenance[job.provenance.length - 1]?.targetId ??
            job.provenance[0]?.targetId ??
            null;
          const provenanceSite = provenanceTargetId
            ? ctx.jobSites?.get(Number(provenanceTargetId))
            : null;
          const provenanceTarget = provenanceSite
            ? jobSiteTarget(provenanceSite)
            : null;
          const activeInstruction = provenanceTarget
            ? resolveActiveSourceInstructionArtifact(
                provenanceTarget,
                sourceInstructionArtifacts,
              )
            : null;
          const applyInstructions = uniqueStrings([
            provenanceSite?.customInstructions ?? "",
            ...buildInstructionGuidance(activeInstruction),
            ...recoverySeed.recoveryInstructions,
          ]);
          const intermediateMutationAuthority =
            await buildIntermediateMutationExecutionOptions({
              job,
              resumeArtifact,
            });
          const browserProfile = await assertCurrentResumeProfile(
            ctx,
            prerequisites.profileRevision,
            "executing this application preparation",
          );

          // What the person's saved permission allows for this exact
          // application. Anything it does not cover fills the form in and stops.
          const applyAuthorityRun = await resolveApplyAuthorityForJob({
            repository: ctx.repository,
            job: job,
            resumeSha256: resumeArtifact.sha256,
            applicationUrl: job.applicationUrl ?? job.canonicalUrl,
            now: new Date().toISOString(),
          });
          let activeEnvelopeRun = applyAuthorityRun.envelope;
          // Set while the form is being filled in, so the loop can hand a
          // finished application to the submission path without re-deriving it.
          let preparedHandoffRun: ApplySubmissionHandoff | null = null;
          let preparedReviewCardRun: ApplicationReviewCard | null = null;
          const applicationAttachmentsRun =
            await resolveApplicationAttachmentsForExecution({
              jobId: job.id,
              resolver: ctx.candidateAssetResolver,
              questionRecords: [],
              answerRecords: [],
            });
          // The browser layer opens the page; Job Finder decides what goes in
          // the form and whether anything may be sent.
          const applyFlowFactsRun = {
            applicationPageBindingKey: activeResultIdRun,
            job,
            resumeArtifact,
            profile: browserProfile.profile,
            ...(applicationAttachmentsRun.length > 0
              ? { applicationAttachments: applicationAttachmentsRun }
              : {}),
            settings: { ...settings, resumeApplicationMode },
            mode:
              applyAuthorityRun.authority.mode === "autonomous_submit"
                ? ("submit_when_ready" as const)
                : ("prepare_only" as const),
            ...intermediateMutationAuthority,
            accountCreationAuthorized: false as const,
            applyAutomationMode: applyAuthorityRun.authority.mode,
            submitAuthorized: applyAuthorityRun.authority.submitAuthorized,
            preApprovedAttestationKinds:
              applyAuthorityRun.authority.preApprovedAttestationKinds,
            salaryDisclosure: applyAuthorityRun.authority.salaryDisclosure,
            applyAllowedOrigins: [
              ...applyAuthorityRun.authority.allowedOrigins,
            ],
            authorizeReviewedApplicationOrigin: async (origin: string) => {
              if (!activeEnvelopeRun) return null;
              activeEnvelopeRun = await authorizeReviewedApplicationOrigin({
                repository: ctx.repository,
                envelope: activeEnvelopeRun,
                jobId: job.id,
                origin,
                now: new Date().toISOString(),
              });
              return activeEnvelopeRun;
            },
            ...(recoverySeed.recoveryContext
              ? { recoveryContext: recoverySeed.recoveryContext }
              : {}),
            ...(applyInstructions.length > 0
              ? { instructions: applyInstructions }
              : {}),
            ...buildApplyVisualExecutionOptions({
              enabled: currentRunState.visualCheckpointsEnabled,
              source: job.source,
            }),
          };
          const applyFlowInputRun = {
            ...applyFlowFactsRun,
            onWaitingForBrowserTab: () =>
              persistApplicationWaitingForBrowserTab({
                repository: ctx.repository,
                resultId: activeResultIdRun,
                runId: run.id,
                jobId: jobId,
              }),
            prepareApplicationForm: createApplyFormPreparer({
              readReusableAnswers: () =>
                readWorkspaceApplicationAnswers(
                  ctx,
                  exactApplicationRecordId,
                  job.location,
                ),
              executionInput: applyFlowFactsRun,
              applicationRecordId: exactApplicationRecordId,
              searchPreferences,
              aiClient: ctx.aiClient,
              onProgress: (progress) =>
                persistApplicationPreparationProgress({
                  repository: ctx.repository,
                  resultId: activeResultIdRun,
                  runId: run.id,
                  jobId,
                  progress,
                }),
              ...(applyAuthorityRun.envelope
                ? { envelope: applyAuthorityRun.envelope }
                : {}),
              onPrepared: ({ handoff, reviewCard }) => {
                preparedHandoffRun = handoff;
                // Kept with the attempt so the review shows what this run wrote,
                // not a later reconstruction of it.
                preparedReviewCardRun = reviewCard;
              },
              letters: buildApplyLetterDependencies({
                aiClient: ctx.aiClient,
                documentManager: ctx.documentManager,
                job: applyFlowFactsRun.job,
                profile: applyFlowFactsRun.profile,
                settings: applyFlowFactsRun.settings,
                searchPreferences,
              }),
              siteLabel: resolveApplySiteLabel({
                targetLabel: provenanceTarget?.label ?? null,
                applicationUrl: job.applicationUrl ?? job.canonicalUrl,
              }),
            }),
          };
          const executionResult = describeApplicationPreparation(
            enforceResolvedApplyAuthorityResult(
              applyAuthorityRun.authority,
              await ctx.browserRuntime.executeApplicationFlow(
                job.source,
                applyFlowInputRun,
                { signal: executionSignal },
              ),
            ),
          );
          await assertPreparationProfileCurrent(ctx, prerequisites);
          if (await stopIfRunWasCancelled()) {
            return;
          }
          const detectedAt = new Date().toISOString();
          const sourceDebugEvidenceRefIds = buildEvidenceRefIdsFromInstruction({
            activeInstruction,
            sourceDebugAttempts,
          });
          const blocker = mergeAttemptBlocker({
            blocker: executionResult.blocker,
            sourceDebugEvidenceRefIds,
            defaultUrl: job.applicationUrl ?? job.canonicalUrl,
          });
          const replay = mergeAttemptReplay({
            replay: executionResult.replay,
            activeInstruction,
            sourceDebugEvidenceRefIds,
            fallbackUrl: job.applicationUrl ?? job.canonicalUrl,
          });
          const normalizedExecutionResult: ApplyExecutionResult = {
            ...executionResult,
            blocker,
            replay,
          };
          const runArtifacts = buildApplyCopilotArtifacts({
            existingAnswerRecords:
              await ctx.repository.listApplicationAnswerRecords({
                applicationRecordId: exactApplicationRecordId,
              }),
            applicationRecordId: exactApplicationRecordId,
            job,
            resumeArtifact,
            executionResult: normalizedExecutionResult,
            runId: run.id,
            ...(jobResult ? { resultId: jobResult.id } : {}),
            detectedAt,
            visualCheckpointsEnabled: currentRunState.visualCheckpointsEnabled,
          });
          const existingQuestionIds = new Set(
            questionRecords
              .filter(
                (entry) => entry.runId === run.id && entry.jobId === jobId,
              )
              .filter(
                (entry) =>
                  entry.applicationRecordId === exactApplicationRecordId,
              )
              .map((entry) => entry.id),
          );
          const existingAnswerIds = new Set(
            answerRecords
              .filter(
                (entry) => entry.runId === run.id && entry.jobId === jobId,
              )
              .filter(
                (entry) =>
                  entry.applicationRecordId === exactApplicationRecordId,
              )
              .map((entry) => entry.id),
          );
          const existingArtifactIds = new Set(
            artifactRefs
              .filter(
                (entry) => entry.runId === run.id && entry.jobId === jobId,
              )
              .filter(
                (entry) =>
                  entry.applicationRecordId === exactApplicationRecordId,
              )
              .map((entry) => entry.id),
          );
          const existingCheckpointIds = new Set(
            checkpoints
              .filter(
                (entry) => entry.runId === run.id && entry.jobId === jobId,
              )
              .filter(
                (entry) =>
                  entry.applicationRecordId === exactApplicationRecordId,
              )
              .map((entry) => entry.id),
          );
          const existingConsentIds = new Set(
            consentRequests
              .filter(
                (entry) => entry.runId === run.id && entry.jobId === jobId,
              )
              .filter(
                (entry) =>
                  entry.applicationRecordId === exactApplicationRecordId,
              )
              .map((entry) => entry.id),
          );
          const updatedResult = ApplyJobResultSchema.parse({
            ...(jobResult ?? runArtifacts.result),
            id: jobResult?.id ?? runArtifacts.result.id,
            runId: run.id,
            jobId,
            reviewCard: await reviewCardForFreshPreparation(
              exactApplicationRecordId,
              preparedReviewCardRun,
            ),
            agentTiming: normalizedExecutionResult.agentTiming,
            queuePosition: index,
            state: mapExecutionResultToApplyJobState({
              consentRequests: runArtifacts.consentRequests,
              executionResult: normalizedExecutionResult,
            }),
            automaticSendPending:
              preparedHandoffRun !== null &&
              applyAuthorityRun.authority.mode === "autonomous_submit" &&
              normalizedExecutionResult.state === "ready",
            summary:
              preparedHandoffRun &&
              applyAuthorityRun.authority.mode === "autonomous_submit" &&
              normalizedExecutionResult.state === "ready"
                ? "Automatic send queued."
                : normalizedExecutionResult.summary,
            detail:
              preparedHandoffRun &&
              applyAuthorityRun.authority.mode === "autonomous_submit" &&
              normalizedExecutionResult.state === "ready"
                ? "Job Finder will send this application next and check the employer's confirmation."
                : normalizedExecutionResult.detail,
            startedAt: jobResult?.startedAt ?? detectedAt,
            updatedAt: detectedAt,
            completedAt:
              normalizedExecutionResult.state === "submitted"
                ? detectedAt
                : runArtifacts.consentRequests.length > 0 ||
                    normalizedExecutionResult.state === "paused"
                  ? null
                  : normalizedExecutionResult.state === "failed" ||
                      normalizedExecutionResult.state === "unsupported"
                    ? detectedAt
                    : null,
            blockerReason: mapExecutionResultToApplyBlockerReason(
              normalizedExecutionResult.blocker,
            ),
            blockerSummary: normalizedExecutionResult.blocker?.summary ?? null,
            listingSignalEvidence:
              normalizedExecutionResult.listingSignalEvidence,
            visualObservationSets:
              normalizedExecutionResult.visualObservationSets,
            visualCheckpoints: normalizedExecutionResult.visualCheckpoints,
            latestQuestionCount: runArtifacts.result.latestQuestionCount,
            latestAnswerCount: runArtifacts.result.latestAnswerCount,
            pendingConsentRequestCount: runArtifacts.consentRequests.length,
            artifactCount: runArtifacts.artifactRefs.length,
            latestCheckpointId: runArtifacts.checkpoints.at(-1)?.id ?? null,
            privacyReceipt: runArtifacts.result.privacyReceipt,
          });
          let committedJobResult = updatedResult;

          let campaignPauseReason: string | null = null;
          const committedJobCompletion = await withApplyRunTransition(
            run.id,
            async () => {
              const latestRun = (await ctx.repository.listApplyRuns()).find(
                (entry) => entry.id === run.id,
              );
              const activityControl = await ctx.repository.getActivityControl();
              if (
                executionSignal.aborted ||
                (activityControl.paused &&
                  activityControl.pauseBehavior !== "finish_current") ||
                (latestRun?.state !== "running" &&
                  !(
                    admissionStopDetail &&
                    latestRun?.state === "paused_for_user_review"
                  ))
              ) {
                executionController.abort();
                return false;
              }

              await Promise.all([
                ctx.repository.upsertApplyJobResult(updatedResult),
                ...runArtifacts.questionRecords
                  .filter((record) => !existingQuestionIds.has(record.id))
                  .map((record) =>
                    ctx.repository.upsertApplicationQuestionRecord({
                      ...record,
                      runId: run.id,
                      resultId: updatedResult.id,
                    }),
                  ),
                ...runArtifacts.answerRecords
                  .filter((record) => !existingAnswerIds.has(record.id))
                  .map((record) =>
                    ctx.repository.upsertApplicationAnswerRecord({
                      ...record,
                      runId: run.id,
                      resultId: updatedResult.id,
                    }),
                  ),
                ...runArtifacts.artifactRefs
                  .filter((record) => !existingArtifactIds.has(record.id))
                  .map((record) =>
                    ctx.repository.upsertApplicationArtifactRef({
                      ...record,
                      runId: run.id,
                      resultId: updatedResult.id,
                    }),
                  ),
                ...runArtifacts.checkpoints
                  .filter((record) => !existingCheckpointIds.has(record.id))
                  .map((record) =>
                    ctx.repository.upsertApplicationReplayCheckpoint({
                      ...record,
                      runId: run.id,
                      resultId: updatedResult.id,
                    }),
                  ),
                ...runArtifacts.consentRequests
                  .filter((record) => !existingConsentIds.has(record.id))
                  .map((record) =>
                    ctx.repository.upsertApplicationConsentRequest({
                      ...record,
                      runId: run.id,
                      resultId: updatedResult.id,
                    }),
                  ),
              ]);

              await persistApplicationUserAction({
                repository: ctx.repository,
                applicationRecordId: exactApplicationRecordId,
                job,
                runId: run.id,
                resultId: updatedResult.id,
                resultState: updatedResult.state,
                resultStartedAt: updatedResult.startedAt,
                replayCheckpointId: runArtifacts.checkpoints.at(-1)?.id ?? null,
                blocker,
                questions: runArtifacts.questionRecords,
                occurredAt: detectedAt,
              });
              await handApplicationPageToPersonForAccessStep({
                browserRuntime: ctx.browserRuntime,
                source: job.source,
                resultId: updatedResult.id,
                blocker,
              });

              const attempt = ApplicationAttemptSchema.parse({
                id: `attempt_${jobId}_${Date.now()}`,
                jobId,
                applicationRecordId: exactApplicationRecordId,
                state: normalizedExecutionResult.state,
                summary: normalizedExecutionResult.summary,
                detail: normalizedExecutionResult.detail,
                startedAt:
                  normalizedExecutionResult.checkpoints[0]?.at ?? detectedAt,
                updatedAt: detectedAt,
                completedAt:
                  normalizedExecutionResult.state === "in_progress"
                    ? null
                    : detectedAt,
                outcome: normalizedExecutionResult.outcome,
                checkpoints: normalizedExecutionResult.checkpoints,
                questions: normalizedExecutionResult.questions.map((question) =>
                  ApplicationAttemptQuestionSchema.parse(question),
                ),
                blocker,
                consentDecisions:
                  normalizedExecutionResult.consentDecisions.map((decision) =>
                    ApplicationAttemptConsentDecisionSchema.parse(decision),
                  ),
                replay,
                visualEvidence: normalizedExecutionResult.visualEvidence,
                visualObservationSets:
                  normalizedExecutionResult.visualObservationSets,
                visualCheckpoints: normalizedExecutionResult.visualCheckpoints,
                nextActionLabel: normalizedExecutionResult.nextActionLabel,
                executionTimings: normalizedExecutionResult.executionTimings,
                agentTiming: normalizedExecutionResult.agentTiming,
              });
              await ctx.repository.upsertApplicationAttempt(attempt);

              const jobState = updatedResult.state;
              await syncRunApplicationRecord({
                applicationRecordId: exactApplicationRecordId,
                consentSummary: buildConsentSummary(attempt.consentDecisions),
                eventDetail:
                  jobState === "blocked" &&
                  runArtifacts.consentRequests.length > 0
                    ? input.mode === "queue_auto"
                      ? "This job needs an explicit consent decision. The queue continued preparing unrelated jobs safely."
                      : "This run paused on a consent-gated step for this job. Resolve or decline the consent request to continue."
                    : normalizedExecutionResult.detail,
                eventEmphasis:
                  jobState === "submitted"
                    ? "positive"
                    : jobState === "failed"
                      ? "critical"
                      : jobState === "blocked"
                        ? "warning"
                        : "neutral",
                eventId: `event_${run.id}_${jobId}_${Date.now()}`,
                eventTitle:
                  jobState === "blocked" &&
                  runArtifacts.consentRequests.length > 0
                    ? "Consent needed"
                    : normalizedExecutionResult.summary,
                jobId,
                lastActionLabel: normalizedExecutionResult.summary,
                lastAttemptState: normalizedExecutionResult.state,
                latestBlocker: buildLatestBlockerSummary(attempt.blocker),
                nextActionLabel:
                  jobState === "blocked" &&
                  runArtifacts.consentRequests.length > 0
                    ? input.mode === "queue_auto"
                      ? "Resolve this job's consent request; other queued jobs continue independently."
                      : "Resolve the consent request in Applications to continue."
                    : normalizedExecutionResult.nextActionLabel,
                questionSummary: buildQuestionSummary(attempt.questions),
                replaySummary: buildReplaySummary(
                  attempt.replay,
                  attempt.visualEvidence,
                ),
                automationMode: applyAuthorityRun.authority.mode,
                updatedAt: detectedAt,
              });

              // Sending happens after the preparation is on record, so the
              // submission's own projection is the last word on this attempt.
              const sendLineage = {
                runId: run.id,
                jobId,
                resultId: updatedResult.id,
                applicationRecordId: exactApplicationRecordId,
                campaignId: run.campaignId ?? null,
              };
              const sendAttempt = await sendPreparedApplicationIfAllowed({
                ctx,
                handoff: preparedHandoffRun,
                envelope: activeEnvelopeRun,
                source: job.source,
                lineage: sendLineage,
                resumeArtifact,
                siteLabel: resolveApplySiteLabel({
                  targetLabel: provenanceTarget?.label ?? null,
                  applicationUrl: job.applicationUrl ?? job.canonicalUrl,
                }),
                signal: executionSignal,
              }).catch((sendError: unknown) => {
                // The prepared application is on record; a send that threw
                // leaves it for the person instead of ending the whole batch.
                console.error(
                  "Failed to send the prepared application.",
                  sendError,
                );
                return notSentAfterError(sendError);
              });
              // A send that did not happen says why on its row and on Home;
              // it used to leave the job on "ready to send" without a word.
              if (sendAttempt && !sendAttempt.sent && !sendAttempt.pageClosed) {
                console.warn(
                  `[apply] ${job.company}: ${sendAttempt.summary}. ${sendAttempt.detail}`,
                );
                await recordPreparedApplicationNotSent({
                  repository: ctx.repository,
                  lineage: sendLineage,
                  attempt: sendAttempt,
                }).catch(() => undefined);
                await syncRunApplicationRecord({
                  applicationRecordId: exactApplicationRecordId,
                  consentSummary: buildConsentSummary(attempt.consentDecisions),
                  eventDetail: sendAttempt.detail,
                  eventEmphasis: "warning",
                  eventId: `event_${run.id}_${jobId}_not_sent_${Date.now()}`,
                  eventTitle: sendAttempt.summary,
                  jobId,
                  lastActionLabel: sendAttempt.summary,
                  lastAttemptState: sendAttempt.formGone
                    ? "failed"
                    : normalizedExecutionResult.state,
                  latestBlocker: buildLatestBlockerSummary(attempt.blocker),
                  nextActionLabel: sendAttempt.nextActionLabel,
                  questionSummary: buildQuestionSummary(attempt.questions),
                  replaySummary: buildReplaySummary(
                    attempt.replay,
                    attempt.visualEvidence,
                  ),
                  automationMode: applyAuthorityRun.authority.mode,
                  updatedAt: new Date().toISOString(),
                }).catch(() => undefined);
              }

              // Sending may replace the prepared result with a submitted or
              // uncertain result. Re-read the durable rows before projecting
              // counters, stop rules, and safeguards; the prepared snapshot is
              // stale as soon as the final action finishes.
              const committedRunResults =
                await ctx.repository.listApplyJobResults({ runId: run.id });
              committedJobResult =
                committedRunResults.find(
                  (candidate) => candidate.id === updatedResult.id,
                ) ?? updatedResult;
              const progress = await readQueueProgress();
              ({
                submittedJobs,
                awaitingReviewJobs,
                blockedJobs,
                failedJobs,
                skippedJobs,
                pendingConsentRequests,
              } = progress);
              // Review and Needs you are finished preparation attempts. Count
              // only work still planned or active, regardless of finish order.
              const pendingJobs = progress.pendingJobs;
              const remainingJobs = pendingJobs;
              const processedJobs = run.jobIds.length - pendingJobs;
              const nextRunState =
                committedJobResult.state === "submitted"
                  ? "completed"
                  : mapExecutionResultToApplyRunState({
                      consentRequests: runArtifacts.consentRequests,
                      executionResult: normalizedExecutionResult,
                    });
              const currentCampaignPauseReason = campaignStopRules
                ? evaluateCampaignApplyStopRules({
                    blockerReason: committedJobResult.blockerReason,
                    blockedCount: blockedJobs,
                    failedCount: failedJobs,
                    processedCount:
                      submittedJobs +
                      awaitingReviewJobs +
                      blockedJobs +
                      failedJobs +
                      skippedJobs,
                    stopRules: campaignStopRules,
                  })
                : null;
              queuedCampaignPauseReason ??= currentCampaignPauseReason;
              campaignPauseReason =
                input.mode === "queue_auto"
                  ? remainingJobs === 0
                    ? queuedCampaignPauseReason
                    : null
                  : currentCampaignPauseReason;
              currentRunState = ApplyRunSchema.parse({
                ...currentRunState,
                currentJobId: jobId,
                updatedAt: new Date().toISOString(),
                state:
                  admissionStopDetail || campaignPauseReason
                    ? "paused_for_user_review"
                    : input.mode === "queue_auto"
                      ? remainingJobs > 0
                        ? "running"
                        : pendingConsentRequests > 0
                          ? "paused_for_consent"
                          : pendingJobs > 0 || blockedJobs > 0
                            ? "paused_for_user_review"
                            : "completed"
                      : nextRunState,
                summary: admissionStopDetail
                  ? "Automatic apply paused before the next queued job."
                  : campaignPauseReason
                    ? isQuestionHandoffPauseReason(campaignPauseReason)
                      ? `Automatic apply did what it could; ${blockedJobs <= 1 ? "1 application waits" : `${blockedJobs} applications wait`} on your answers in Needs you.`
                      : "Automatic apply paused by this search plan's safety rules."
                    : input.mode === "queue_auto"
                      ? remainingJobs === 0 && pendingConsentRequests > 0
                        ? `Automatic apply prepared every unblocked job; ${pendingConsentRequests} consent ${pendingConsentRequests === 1 ? "decision needs" : "decisions need"} you.`
                        : `Automatic apply queue processed ${processedJobs} of ${run.jobIds.length} jobs using the chosen application mode.`
                      : runArtifacts.consentRequests.length > 0
                        ? `Automatic apply paused for consent on '${job.title}'.`
                        : `Automatic apply run processed '${job.title}' using the chosen application mode.`,
                detail:
                  admissionStopDetail ??
                  campaignPauseReason ??
                  (input.mode === "queue_auto" && pendingConsentRequests > 0
                    ? "Consent-blocked jobs remain explicit user actions, while every unrelated ready job was allowed to reach its safe review checkpoint."
                    : runArtifacts.consentRequests.length > 0
                      ? "The run stopped because a consent-gated step needs an explicit user decision."
                      : "Job Finder finished working through the application."),
                completedAt:
                  admissionStopDetail || campaignPauseReason
                    ? null
                    : input.mode === "queue_auto"
                      ? pendingConsentRequests > 0 ||
                        pendingJobs > 0 ||
                        blockedJobs > 0
                        ? null
                        : committedJobResult.updatedAt
                      : nextRunState === "completed" ||
                          nextRunState === "failed"
                        ? committedJobResult.updatedAt
                        : null,
                pendingJobs,
                submittedJobs,
                skippedJobs,
                blockedJobs,
                failedJobs,
              });
              await ctx.repository.upsertApplyRun(currentRunState);
              return true;
            },
          );
          if (!committedJobCompletion) {
            return;
          }

          if (
            committedJobResult.completedAt !== null ||
            committedJobResult.state === "awaiting_review"
          ) {
            if (input.mode === "queue_auto") {
              // Safeguards produced by this approved batch must describe its
              // waiting jobs, not prevent later named jobs in the same batch
              // from being prepared. External/job-specific safeguards are still
              // rechecked before every browser launch above.
              deferredQueueSafeguards.push({
                result: committedJobResult,
                job,
                now: detectedAt,
              });
            } else {
              await persistAutomaticApplicationSafeguards({
                ctx,
                run: currentRunState,
                result: committedJobResult,
                job,
                now: detectedAt,
              }).catch((safeguardError: unknown) => {
                console.error(
                  "Failed to persist automatic application safeguards.",
                  safeguardError,
                );
              });
            }
          }
        } catch (jobError) {
          // One job's error must not end the batch. A cancelled or paused
          // run, a single-job run, and a browser the person took over still
          // end here as before; anything else is written down on that job and
          // the batch goes on to the next one.
          if (
            input.mode !== "queue_auto" ||
            executionSignal.aborted ||
            (isBrowserHandedToPersonError(jobError) &&
              !isOneTabTakeoverError(jobError)) ||
            (await stopIfRunWasCancelled())
          ) {
            throw jobError;
          }
          console.error(
            "[apply] one queued application failed; the batch continues",
            jobError instanceof Error
              ? (jobError.stack ?? jobError.message)
              : jobError,
          );
          await withApplyRunTransition(run.id, async () => {
            if (await stopIfRunWasCancelled()) return;
            await markQueuedJobFailed({
              runId: run.id,
              resultId: queuedResultId,
              error: jobError,
            });
            const progress = await readQueueProgress();
            ({
              submittedJobs,
              awaitingReviewJobs,
              blockedJobs,
              failedJobs,
              skippedJobs,
              pendingConsentRequests,
            } = progress);
            const remainingJobs = progress.pendingJobs;
            currentRunState = ApplyRunSchema.parse({
              ...currentRunState,
              ...progress,
              currentJobId: jobId,
              updatedAt: new Date().toISOString(),
              state: admissionStopDetail
                ? "paused_for_user_review"
                : remainingJobs > 0
                  ? "running"
                  : pendingConsentRequests > 0
                    ? "paused_for_consent"
                    : blockedJobs > 0 || awaitingReviewJobs > 0
                      ? "paused_for_user_review"
                      : "completed",
              completedAt:
                admissionStopDetail ||
                remainingJobs > 0 ||
                pendingConsentRequests > 0 ||
                blockedJobs > 0 ||
                awaitingReviewJobs > 0
                  ? null
                  : new Date().toISOString(),
              summary: admissionStopDetail
                ? "Automatic apply paused before the next queued job."
                : `Automatic apply queue processed ${run.jobIds.length - remainingJobs} of ${run.jobIds.length} jobs using the chosen application mode.`,
              detail:
                admissionStopDetail ??
                "Job Finder finished working through the application.",
            });
            await ctx.repository.upsertApplyRun(currentRunState);
          });
        }
      };

      // Preparation can overlap; every result/run transition above is still
      // committed in order. Drain active workers before cleanup or failure.
      const concurrency =
        input.mode === "single_job_auto"
          ? 1
          : applicationPreparationConcurrency(
              process.env.NESTOR_APPLICATION_PREPARATION_CONCURRENCY,
            );
      // The browser runs one form per site at a time. A worker that took the
      // next job in list order could sit waiting on a busy site while a job
      // on another site was free, so each worker takes the first job whose
      // site no other worker holds, and list order only when none is free.
      const unclaimedIndexes = run.jobIds.map((_, index) => index);
      const busySites = new Map<string, number>();
      const siteOfIndex = (index: number): string => {
        const job = savedJobsById.get(run.jobIds[index]!);
        return (
          applicationSiteKey(job?.applicationUrl ?? job?.canonicalUrl ?? "") ??
          `unknown:${index}`
        );
      };
      const claimNextIndex = (): number | null => {
        if (unclaimedIndexes.length === 0) return null;
        const free = unclaimedIndexes.findIndex(
          (index) => !busySites.has(siteOfIndex(index)),
        );
        return unclaimedIndexes.splice(free >= 0 ? free : 0, 1)[0] ?? null;
      };
      const workers = Array.from(
        { length: Math.min(concurrency, run.jobIds.length) },
        async () => {
          while (!admissionStopped && unclaimedIndexes.length > 0) {
            if (await stopIfRunWasCancelled(true)) return;
            if (admissionStopped) return;
            const index = claimNextIndex();
            if (index === null) return;
            const site = siteOfIndex(index);
            busySites.set(site, (busySites.get(site) ?? 0) + 1);
            try {
              await processJob(index);
            } catch (error) {
              admissionStopped = true;
              throw error;
            } finally {
              const remaining = (busySites.get(site) ?? 1) - 1;
              if (remaining > 0) busySites.set(site, remaining);
              else busySites.delete(site);
            }
          }
        },
      );
      const settled = await Promise.allSettled(workers);
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      if (await stopIfRunWasCancelled()) return;

      for (const deferred of deferredQueueSafeguards) {
        await persistAutomaticApplicationSafeguards({
          ctx,
          run: currentRunState,
          ...deferred,
        }).catch((safeguardError: unknown) => {
          console.error(
            "Failed to persist automatic application safeguards.",
            safeguardError,
          );
        });
      }
    } catch (error) {
      if (await stopIfRunWasCancelled()) {
        return;
      }
      shouldCloseActiveSessionOnExit = openedSources.size > 0;
      const failedAt = new Date().toISOString();
      const handedToPerson = isBrowserHandedToPersonError(error);
      if (input.mode === "queue_auto") {
        // The job that was open when the batch stopped, and every job it had
        // not reached, end with a sentence and a Try again instead of reading
        // "Filling in" under a run that is over.
        await closeUnfinishedQueuedJobs({
          runId: run.id,
          at: failedAt,
          reason: handedToPerson
            ? "You closed or paused the browser, so Job Finder stopped this batch here. Nothing more was sent. Try again when you are ready."
            : `The batch stopped before this job: ${error instanceof Error ? error.message : "an unknown error"}. Nothing was sent for it.`,
        }).catch((closeError: unknown) => {
          console.error("[apply] could not close unfinished jobs", closeError);
        });
      }
      // The failed run is terminal, so its queue counters are recomputed
      // from the exact committed result states with the canonical recovery
      // semantics instead of retaining stale running-time pending work.
      const committedFailureResults = await ctx.repository.listApplyJobResults({
        runId: run.id,
      });
      currentRunState = ApplyRunSchema.parse({
        ...currentRunState,
        state: "failed",
        updatedAt: failedAt,
        completedAt: failedAt,
        ...deriveRecoveredApplyRunCounters(committedFailureResults, failedAt),
        summary: handedToPerson
          ? "Stopped because you took over the browser."
          : "Automatic apply run failed before safe review completed.",
        detail: handedToPerson
          ? "Jobs this batch had not finished can be tried again once the browser is resumed."
          : error instanceof Error
            ? error.message
            : "Unknown automatic apply failure.",
      });
      const persistedFailureRun =
        await persistRunUnlessCancelled(currentRunState);
      if (persistedFailureRun) {
        await persistAutomaticApplicationSafeguards({
          ctx,
          run: currentRunState,
          now: failedAt,
        }).catch((safeguardError: unknown) => {
          console.error(
            "Failed to persist automatic application safeguards.",
            safeguardError,
          );
        });
      }
      throw error;
    } finally {
      await releaseFinishedApplicationPages({ ...ctx, runId: run.id });
      if (
        !keepSessionAlive ||
        shouldCloseActiveSessionOnExit ||
        executionSignal.aborted
      ) {
        for (const source of openedSources.keys()) {
          try {
            await ctx.closeRunBrowserSession(source);
          } catch (cleanupError) {
            console.error(
              "Failed to close apply browser session.",
              cleanupError,
            );
          }
        }
      }
    }
  }

  /**
   * The person stepped into or paused the browser. Every later job would
   * meet the same paused browser, so the batch stops instead of writing a
   * failure on each remaining job.
   */
  function isBrowserHandedToPersonError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : "";
    return /stepped into the browser|Browser activity is paused|Browser activity was stopped|You closed the Job Finder browser/i.test(
      message,
    );
  }

  /**
   * The person stepped into the one tab this job was using (ADR 0024). Only
   * this job stopped: the rest of a batch carries on in other tabs, and this
   * job carries on when the person hands the tab back.
   */
  function isOneTabTakeoverError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : "";
    return /hand it back with Resume agent/i.test(message);
  }

  const UNFINISHED_QUEUED_RESULT_STATES = new Set([
    "planned",
    "filling",
    "question_capture",
    "submitting",
  ]);

  /** One queued job's own failure, written on that job only. */
  async function markQueuedJobFailed(input: {
    runId: string;
    resultId: string;
    error: unknown;
  }): Promise<void> {
    const latest = (
      await ctx.repository.listApplyJobResults({ runId: input.runId })
    ).find((result) => result.id === input.resultId);
    if (!latest || !UNFINISHED_QUEUED_RESULT_STATES.has(latest.state)) {
      return;
    }
    const failedAt = new Date().toISOString();
    const message =
      input.error instanceof Error && input.error.message.trim()
        ? input.error.message.trim()
        : "Job Finder stopped working on this application.";
    await ctx.repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        ...latest,
        state: "failed",
        updatedAt: failedAt,
        completedAt: failedAt,
        summary: isOneTabTakeoverError(input.error)
          ? PERSON_TOOK_OVER_SUMMARY
          : "Could not apply.",
        detail: `${message} Nothing was sent for this job; the rest of the batch carried on.`,
      }),
    );
    if (latest.applicationRecordId) {
      await syncRunApplicationRecord({
        applicationRecordId: latest.applicationRecordId,
        jobId: latest.jobId,
        lastAttemptState: "failed",
        lastActionLabel: "Could not apply.",
        nextActionLabel: "Try again",
        eventId: `event_${latest.id}_failed`,
        eventTitle: "Could not apply.",
        eventDetail: message,
        eventEmphasis: "critical",
        updatedAt: failedAt,
      });
    }
  }

  /**
   * Ends every job a stopped batch left unfinished: the one it was working
   * on and the ones it had not reached.
   */
  async function closeUnfinishedQueuedJobs(input: {
    runId: string;
    at: string;
    reason: string;
  }): Promise<void> {
    const results = await ctx.repository.listApplyJobResults({
      runId: input.runId,
    });
    await Promise.all(
      results
        .filter((result) => UNFINISHED_QUEUED_RESULT_STATES.has(result.state))
        .map(async (result) => {
          await ctx.repository.upsertApplyJobResult(
            // Skipped, not failed: the batch stopped around these jobs, so
            // they must not count toward a failure-streak safeguard that
            // would then refuse the Try again.
            ApplyJobResultSchema.parse({
              ...result,
              state: "skipped",
              updatedAt: input.at,
              completedAt: input.at,
              summary: result.applicationPreparationStartedAt
                ? "Could not apply."
                : "Not started.",
              detail: input.reason,
            }),
          );
          if (result.applicationRecordId) {
            await syncRunApplicationRecord({
              applicationRecordId: result.applicationRecordId,
              jobId: result.jobId,
              lastAttemptState: "failed",
              lastActionLabel: result.applicationPreparationStartedAt
                ? "Could not apply."
                : "Not started.",
              nextActionLabel: "Try again",
              eventId: `event_${result.id}_stopped`,
              eventTitle: "Application preparation stopped",
              eventDetail: input.reason,
              eventEmphasis: "neutral",
              updatedAt: input.at,
            });
          }
        }),
    );
  }

  async function executeSafeApplyRun(
    input: {
      mode: "single_job_auto" | "queue_auto";
      runId: string;
    },
    capacityToken?: ApplicationPreparationCapacityToken,
    onStarted?: (claimed: boolean) => void,
  ): Promise<void> {
    if (ctx.activeApplyRunAbortControllers.has(input.runId)) {
      if (onStarted) {
        onStarted(false);
        return;
      }
      throw new Error(`Apply run '${input.runId}' is already executing.`);
    }

    const stagedRun =
      (await ctx.repository.listApplyRuns({ id: input.runId }))[0] ?? null;
    if (!stagedRun) {
      throw new Error(`Unknown apply run '${input.runId}'.`);
    }
    const stagedResults = await ctx.repository.listApplyJobResults({
      runId: input.runId,
    });
    const stagedLineage = stagedRun.jobIds.map((jobId) => {
      const matches = stagedResults.filter((result) => result.jobId === jobId);
      const applicationRecordId = matches[0]?.applicationRecordId;
      if (matches.length !== 1 || !applicationRecordId) {
        throw new Error(
          `Apply run '${input.runId}' has legacy or ambiguous application lineage for job '${jobId}'.`,
        );
      }
      return { jobId, applicationRecordId };
    });

    // Synchronous scan-and-set: no await may sit between this conflict check
    // and the claim writes, or two concurrent approvals could both pass.
    const conflictingLineage = stagedLineage.filter((lineage) => {
      const owningRunId = activeStagedApplyJobClaims.get(
        lineage.applicationRecordId,
      );
      return (
        (owningRunId !== undefined && owningRunId !== input.runId) ||
        activeDirectApplyClaims.has(lineage.applicationRecordId)
      );
    });
    if (conflictingLineage.length > 0) {
      throw new Error(
        "This application is already being prepared. Wait for it to finish before starting it again.",
      );
    }
    if (ctx.activeApplyRunAbortControllers.has(input.runId)) {
      if (onStarted) {
        onStarted(false);
        return;
      }
      throw new Error(`Apply run '${input.runId}' is already executing.`);
    }
    for (const { applicationRecordId } of stagedLineage) {
      activeStagedApplyJobClaims.set(applicationRecordId, input.runId);
    }

    const executionController = new AbortController();
    ctx.activeApplyRunAbortControllers.set(input.runId, executionController);
    const executionPromise = executeSafeApplyRunOwned(
      input,
      executionController,
      capacityToken,
    ).finally(() => {
      for (const { applicationRecordId } of stagedLineage) {
        if (
          activeStagedApplyJobClaims.get(applicationRecordId) === input.runId
        ) {
          activeStagedApplyJobClaims.delete(applicationRecordId);
        }
      }
      if (
        ctx.activeApplyRunAbortControllers.get(input.runId) ===
        executionController
      ) {
        ctx.activeApplyRunAbortControllers.delete(input.runId);
      }
      if (ctx.activeApplyRunPromises.get(input.runId) === executionPromise) {
        ctx.activeApplyRunPromises.delete(input.runId);
      }
    });
    ctx.activeApplyRunPromises.set(input.runId, executionPromise);
    onStarted?.(true);
    return executionPromise;
  }

  const resumeApplicationUserAction = createApplicationUserActionResumer(ctx, {
    resolveJobApplyPrerequisites,
  });

  return {
    resumeApplicationUserAction,
    async resumeParkedApplyRuns(control, onFinished) {
      const [runs, results] = await Promise.all([
        ctx.repository.listApplyRuns(),
        ctx.repository.listApplyJobResults(),
      ]);
      for (const run of runs) {
        if (
          ctx.activeApplyRunAbortControllers.has(run.id) ||
          !isSafelyParkedApplyQueue({
            run,
            results: results.filter((result) => result.runId === run.id),
            control,
          })
        )
          continue;

        // Resume is a user action, but the button must return when the old
        // executor has claimed the run, not after the whole batch finishes.
        await new Promise<void>((resolve, reject) => {
          let started = false;
          let claimed = false;
          void executeSafeApplyRun(
            { mode: "queue_auto", runId: run.id },
            undefined,
            (didClaim) => {
              started = true;
              claimed = didClaim;
              resolve();
            },
          )
            .catch((error: unknown) => {
              if (!started)
                reject(
                  error instanceof Error ? error : new Error(String(error)),
                );
              else
                console.error("The resumed application queue stopped.", error);
            })
            .finally(() => {
              if (claimed) onFinished?.();
            });
        });
      }
    },
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
    async cancelApplyRun(runId, options) {
      const skippedByPerson = new Set(options?.skippedByPerson ?? []);
      ctx.activeApplyRunAbortControllers.get(runId)?.abort();
      const { run, updatedRun, now, applicationRecordIdByJobId, results } =
        await withApplyRunTransition(runId, async () => {
          const [runs, results] = await Promise.all([
            ctx.repository.listApplyRuns(),
            ctx.repository.listApplyJobResults({ runId }),
          ]);
          const run = runs.find((entry) => entry.id === runId) ?? null;

          if (!run) {
            throw new Error(`Unknown apply run '${runId}'.`);
          }

          if (
            run.state === "completed" ||
            run.state === "cancelled" ||
            run.state === "failed"
          ) {
            throw new Error(`Apply run '${runId}' can no longer be cancelled.`);
          }

          const applicationRecordIdByJobId = new Map<string, string>();
          for (const jobId of run.jobIds) {
            const matchingResults = results.filter(
              (result) => result.jobId === jobId,
            );
            const applicationRecordId = matchingResults[0]?.applicationRecordId;
            if (
              matchingResults.length !== 1 ||
              !applicationRecordId ||
              matchingResults.some(
                (result) => result.applicationRecordId !== applicationRecordId,
              )
            ) {
              throw new Error(
                `Apply run '${runId}' has legacy or ambiguous application lineage for job '${jobId}'.`,
              );
            }
            applicationRecordIdByJobId.set(jobId, applicationRecordId);
          }

          const now = new Date().toISOString();
          // A cancelled run is terminal, so its queue counters are recomputed
          // from the exact committed result states with the same canonical
          // recovery semantics an interrupted run receives: preserved
          // awaiting_review checkpoints stay the only outstanding user-owned
          // work, and abandoned queued/in-flight rows stop inflating derived
          // queue sizes forever.
          const updatedRun = ApplyRunSchema.parse({
            ...run,
            state: "cancelled",
            updatedAt: now,
            completedAt: now,
            summary: "Automatic apply run cancelled.",
            detail:
              "The queued run was cancelled before final submit. Any completed preparation artifacts remain available for review.",
            ...deriveRecoveredApplyRunCounters(results, now),
          });
          await ctx.repository.upsertApplyRun(updatedRun);
          return {
            run,
            updatedRun,
            now,
            applicationRecordIdByJobId,
            results,
          };
        });

      // Cancel writes each job record sequentially under the per-job record
      // transition so a concurrent worker sync can never interleave a lost
      // update, and committed attempt/checkpoint history is always retained.
      for (const jobId of run.jobIds) {
        const applicationRecordId = applicationRecordIdByJobId.get(jobId);
        if (!applicationRecordId) continue;
        // Only outcomes the run still owns (queued or interrupted mid-flow)
        // receive cancellation copy. Finished records keep the labels their
        // own outcome wrote: submitted and awaiting_review checkpoints,
        // declined skips, blockers, and failures all stay truthful after
        // cancellation. The cancellation audit event is appended either way.
        const jobResult = results.find((result) => result.jobId === jobId);
        const runOwnsJobOutcome =
          !jobResult || isInterruptedApplyJobState(jobResult.state);
        await withExactApplicationRecordTransition(
          applicationRecordId,
          jobId,
          async () => {
            const applicationRecords =
              await ctx.repository.listApplicationRecords();
            const existingRecord = applicationRecords.find(
              (record) => record.id === applicationRecordId,
            );

            if (!existingRecord) {
              return;
            }

            await ctx.repository.upsertApplicationRecord(
              ApplicationRecordSchema.parse({
                ...existingRecord,
                ...(runOwnsJobOutcome && skippedByPerson.has(jobId)
                  ? {
                      lastActionLabel: APPLICATION_SKIPPED_BY_PERSON_LABEL,
                      nextActionLabel:
                        "Nothing was sent. Apply again if you change your mind.",
                    }
                  : runOwnsJobOutcome
                    ? {
                        lastActionLabel: updatedRun.summary,
                        // A record with an earlier attempt must not keep
                        // showing that attempt's state (Tracker read a
                        // stopped retry as Ready for approval). A job the
                        // stop reached first has no attempt to describe.
                        ...(existingRecord.lastAttemptState
                          ? { lastAttemptState: "cancelled" as const }
                          : {}),
                        nextActionLabel:
                          "Press Try again to pick this up later.",
                      }
                    : {}),
                lastUpdatedAt: now,
                events: mergeEvents(existingRecord.events, [
                  {
                    id: `event_${run.id}_${jobId}_cancelled`,
                    at: now,
                    title: "Automatic apply run cancelled",
                    detail:
                      "The queued run was cancelled before any final submit action. Retained review data remains available.",
                    emphasis: "warning",
                  },
                ]),
              }),
            );
          },
        );
      }

      await retireCancelledApplicationUserActions(ctx.repository, runId);
      const jobs = await ctx.repository.listSavedJobsByIds(
        results.map((result) => result.jobId),
      );
      for (const result of results) {
        if (result.state === "awaiting_review" || result.state === "submitted")
          continue;
        const job = jobs.find((entry) => entry.id === result.jobId);
        await ctx.browserRuntime
          .releaseApplicationPageBinding?.(
            job?.source ?? "target_site",
            result.id,
          )
          .catch(() => undefined);
      }
      return ctx.getWorkspaceSnapshot();
    },
  };
}
