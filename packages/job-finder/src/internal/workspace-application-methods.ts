import {
  createAdaptiveConcurrencyLimiter,
  createConcurrencyLimiter,
} from "@nestor/core";
import {
  RESUME_AI_CONCURRENCY,
  RESUME_LOCAL_CONCURRENCY,
  RESUME_PIPELINE_CAPACITY,
  type ResumeBatchGenerationResult,
  type ResumeBatchGenerationProgress,
  type ResumeBatchProviderBlock,
} from "@nestor/contracts";
import { refreshApprovedApplicationLetter } from "./approved-application-letter";
import type {
  DiscoveryFeedbackBatchOutcome,
  DiscoveryFeedbackBatchResult,
  JobFinderDiscoveryState,
  JobFinderDismissDiscoveryJobInput,
} from "@nestor/contracts";
import { normalizeCompanyName } from "@nestor/contracts";
import type { DiscoveryFeedbackBatchOptions } from "./workspace-service-contracts";
import {
  mergeResumeBatchCheckpoints,
  markResumeBatchRunning,
  withResumeBatchLiveness,
} from "./resume-batch-checkpoint";
import { checkSameCompanySends } from "./same-company-sends";
import { searchPreferencesForCampaignRun } from "./campaign-dashboard";
import { withPlanAssessment } from "./plan-assessment";
import {
  getAiProviderAccessFailure,
  isAiProviderRateLimited,
  completeTailoredResumeDraft,
} from "@nestor/ai-providers";
import {
  applyResumeLanguage,
  collectResumeLanguageFields,
  writeResumeLanguage,
} from "./resume-workspace-language";
import { mergeApplicationAnswersIntoExecutionProfile } from "./workspace-application-answer-execution";
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
  createMonotonicTimestamp,
  preserveWorkHistoryReviewGuidance,
} from "./resume-draft-commit-support";
import {
  applicationSiteKey,
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
  notSentAttempt,
  recordPreparedApplicationNotSent,
  sendPreparedApplicationIfAllowed,
} from "./apply-submission-run-step";
import {
  APPLICATION_SKIPPED_BY_PERSON_LABEL,
  ApplyJobResultSchema,
  ApplyRecoveryContextSchema,
  ApplyRunSchema,
  ApplySubmitApprovalSchema,
  ApplicationConsentRequestSchema,
  ApplicationAttemptConsentDecisionSchema,
  ApplicationAttemptQuestionSchema,
  ApplicationAttemptSchema,
  ApplicationArtifactRefSchema,
  ApplicationQuestionRecordSchema,
  ApplicationRecordSchema,
  ApplicationReplayCheckpointSchema,
  ApplicationResumeArtifactSchema,
  JobFinderInterviewFollowUpInputSchema,
  JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema,
  JobFinderSetResumeClaimConfirmationInputSchema,
  isResumeClaimAssessmentApprovable,
  isBlockingResumeClaimAssessment,
  isCurrentResumeClaimVerifier,
  resumeClaimOwnershipStatement,
  buildResumeIssueApprovalContentHash,
  matchResumeIssueApproval,
  ResumeIssueApprovalSchema,
  type ResumeIssueApproval,
  ResumeAssistantMessageSchema,
  type ResumeProposalApprovalBlocker,
  ResumeClaimConfirmationSchema,
  ResumeValidationResultSchema,
  WorkHistoryReviewAcknowledgmentSchema,
  isResumeTemplateApplyEligible,
  isResumeTemplateApprovalEligible,
  isBlockingResumeValidationIssue,
  isResumeSkillClaimAssessment,
  type ResumeDraft,
  ResumeDraftPatchSchema,
  ResumeDraftSchema,
  SavedJobSchema,
  type SavedJob,
  TailoredAssetSchema,
  type ApplyExecutionResult,
  type BrowserVisualEvidenceSummary,
  type CandidateProfile,
  type JobSource,
  type ResumeTemplateDefinition,
  type TailoredAsset,
  type UserActionRequest,
  type JobFinderWorkspaceSnapshot,
  type JobFinderActivityControl,
  type ResumeClaimConfirmation,
  type WorkHistoryReviewAcknowledgment,
} from "@nestor/contracts";
import { isSafelyParkedApplyQueue } from "./workspace-apply-run-recovery";
import { sanitizeTailoredAssetFailureMessage } from "./tailored-asset-failure";
import { projectDiscoveryJobViews } from "./listing-activity";
import { selectApplicationSighting } from "./listing-sightings";
import { isApprovedTailoredResumeReadyForApply } from "./matching-review-queue";
import {
  buildApplyCopilotArtifacts,
  buildSingleJobAutoApplyArtifacts,
  buildMissingResumeCopilotArtifacts,
  mapExecutionResultToApplyBlockerReason,
  mapExecutionResultToApplyJobState,
  mapExecutionResultToApplyRunState,
  reconcileApplyRunAfterConfirmedSubmission,
  summarizeApplyJobResultStates,
} from "./workspace-apply-run-support";
import { markSavedJobStatusInLedger } from "./workspace-discovery-ledger";
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
  nextAssetVersion,
  nextJobStatusFromAttempt,
  resolveActiveSourceInstructionArtifact,
  toApplicationEvents,
  wasResumeDraftApproved,
} from "./workspace-helpers";
import { createUniqueId, normalizeText, uniqueStrings } from "./shared";
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
  describeUnstartedBatchReason,
  isInterruptedApplyJobState,
  selectReusableBatchApproval,
} from "./workspace-apply-run-recovery";
import {
  applyPatchToResumeDraft,
  buildAssistantReplyMessage,
  buildResumeDraftFromTailoredDraft,
  buildResumeDraftContentHash,
  buildResumeCoverageComparison,
  buildResumeDraftStateHash,
  buildResumeDraftRevision,
  buildResumeExportArtifact,
  buildResumeRenderDocument,
  buildTailoredResumeTextFromResumeDraft,
  buildTailoredAssetBridge,
  buildWorkHistoryReviewSuggestions,
  collectResearchContext,
  collectResumeWorkspaceEvidence,
  buildResumeProposalReplyContent,
  isWorkHistoryOmissionReviewSuggestion,
  hasBlockingResumeClaimAssessment,
  matchWorkHistoryReviewAcknowledgment,
  resolveResumeTemplateLabel,
  resolveTailoredAssetLabel,
  sanitizeResumeDraft,
  validateResumeDraft,
} from "./resume-workspace-helpers";
import { evaluateCheckedResumeProposalGrounding } from "./resume-claim-checks";
import {
  buildResumeWorkspace,
  buildWorkHistoryReviewSuggestionsFromValidation,
  ensureResumeDraft,
  fetchAndPersistResearch,
  previewResumeDraft,
  renderDraftToPdf,
  resolveEffectiveResumeTailoringStrengthForJob,
  sanitizeAndCheckResumeDraft,
  assertResumeProfileRevisionCurrent,
  buildOriginalResumeAssistantReply,
} from "./workspace-application-resume-support";
import {
  buildDraftWithoutAssistantEdit,
  findDraftAfterRevision,
} from "./resume-assistant-edit-undo";
import {
  buildResumeGenerationStrategyPolicy,
  buildResumeStrategyContext,
  resolveCampaignDefaultResumeStrategyId,
} from "./resume-strategy-application";
import { createApplicationUserActionResumer } from "./workspace-application-user-action-resumption";
import {
  buildRecentResumeAssistantConversation,
  checkResumeAssistantProposal,
  findResumeAssistantPatchesDroppedOnSave,
  listResumeLinesToConfirm,
} from "./resume-assistant-conversation";
import {
  PERSON_TOOK_OVER_SUMMARY,
  handApplicationPageToPersonForAccessStep,
  persistApplicationUserAction,
  retireCancelledApplicationUserActions,
  terminalizeApplicationAfterPreparedPageLost,
} from "./workspace-application-user-action";
import { persistAutomaticApplicationSafeguards } from "./automatic-safeguards";
import { reconcileStaleMissingResumeBlockers } from "./workspace-application-blocker-sync";
import { resolvePrepareOnlyIntermediateMutationAuthority } from "./prepare-only-intermediate-mutation-authority";
import {
  appendExactEmployerExclusion,
  removeExactEmployerExclusion,
  resolveEmployerExclusionPreview,
} from "./employer-exclusion";
import {
  resolveApplicationRecordForJob,
  withApplicationRecordTransition,
} from "./application-crm";
import type {
  ApplicationAutomationMode,
  ApplicationReviewCard,
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
} from "./listing-detail-enrichment";
import { jobNeedsFitJudgment } from "./fit-judgment";
import { createMatchAssessmentSession } from "./match-assessment-session";
import { withSavedJobSearchBehavior } from "./job-search-behavior";
import { enrichSearchPreferencesFromProfile } from "./workspace-helpers";
import { createMatchAssessment, createMatchAssessmentAsync } from "./matching";

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

/**
 * Builds the durable failed tailored asset recorded when resume generation,
 * rendering, or persistence throws. It keeps the existing asset identity and
 * version so a later successful retry advances them with the same semantics
 * as before, and it never invents artifact content that was not produced.
 */
function buildFailedTailoredAsset(input: {
  jobId: string;
  existingAsset: TailoredAsset | null;
  error: unknown;
}): TailoredAsset {
  const failedAt = new Date().toISOString();
  return TailoredAssetSchema.parse({
    id: input.existingAsset?.id ?? `resume_${input.jobId}`,
    jobId: input.jobId,
    kind: "resume",
    status: "failed",
    // A document nothing could be tailored for keeps the person's own name for
    // it. Naming a failed retry "Tailored Resume" contradicted the very panel
    // that had just explained why no tailoring happened.
    label: resolveTailoredAssetLabel({
      existingLabel: input.existingAsset?.label ?? null,
      generationMethod:
        input.existingAsset?.generationMethod ?? "deterministic",
      generationReason: input.existingAsset?.generationReason ?? null,
    }),
    version: input.existingAsset?.version ?? "v1",
    templateName: input.existingAsset?.templateName ?? "Chronology Classic",
    compatibilityScore: input.existingAsset?.compatibilityScore ?? null,
    progressPercent: input.existingAsset?.progressPercent ?? null,
    updatedAt: failedAt,
    storagePath: input.existingAsset?.storagePath ?? null,
    contentText: input.existingAsset?.contentText ?? null,
    previewSections: input.existingAsset?.previewSections ?? [],
    generationMethod: input.existingAsset?.generationMethod ?? "deterministic",
    notes: input.existingAsset?.notes ?? [],
    failureMessage: sanitizeTailoredAssetFailureMessage(input.error),
    failedAt,
  });
}

function getApplyResultSortTime(input: {
  completedAt: string | null;
  updatedAt: string;
  startedAt: string;
}): number {
  return Date.parse(input.completedAt ?? input.updatedAt ?? input.startedAt);
}

class FeedbackMutationStoppedError extends Error {
  constructor() {
    super("The workspace changed or closed, or the assistant stopped.");
  }
}
class FeedbackMutationHeldError extends Error {}

type WorkspaceApplicationMethods = Omit<
  Pick<
    JobFinderWorkspaceService,
    | "assessJobListing"
    | "queueJobForReview"
    | "queueJobsForReview"
    | "setJobResumeApplicationMode"
    | "saveResumeBatchCheckpoint"
    | "removeJobFromReview"
    | "removeJobsFromReview"
    | "dismissDiscoveryJob"
    | "dismissDiscoveryJobs"
    | "excludeEmployerDiscoveryJobs"
    | "previewEmployerExclusion"
    | "removeEmployerExclusion"
    | "restoreDismissedDiscoveryJob"
    | "restoreDismissedDiscoveryJobs"
    | "generateResume"
    | "generateResumeForBatch"
    | "getResumeWorkspace"
    | "previewResumeDraft"
    | "saveResumeDraft"
    | "restoreResumeDraftRevision"
    | "undoResumeAssistantEdit"
    | "regenerateResumeDraft"
    | "regenerateResumeSection"
    | "exportResumePdf"
    | "approveResume"
    | "clearResumeApproval"
    | "applyResumePatch"
    | "setWorkHistoryReviewAcknowledgment"
    | "setResumeClaimConfirmation"
    | "getResumeAssistantMessages"
    | "getResumeAssistantHistory"
    | "sendResumeAssistantMessage"
    | "resolveResumeAssistantProposal"
    | "startApplyCopilotRun"
    | "startAutoApplyRun"
    | "startAutoApplyQueueRun"
    | "approveApplyRun"
    | "cancelApplyRun"
    | "resolveApplyConsentRequest"
    | "revokeApplyRunApproval"
    | "approveApply"
    | "focusPreparedApplicationPage"
    | "inspectPreparedApplicationPage"
    | "submitPreparedApplication"
    | "refreshApprovedApplicationLetter"
    | "recordLiveAssistantApplicationAction"
  >,
  | "startApplyCopilotRun"
  | "approveApplyRun"
  | "resolveApplyConsentRequest"
  | "approveApply"
  | "startAutoApplyQueueRun"
> & {
  /**
   * The batch start needs the caller's capacity reservation the same way
   * `approveApplyRun` does. Without it every job the batch begins is charged
   * against the reservation the batch itself already made, so the daily
   * safeguard refuses partway through and the batch stalls with no
   * explanation.
   */
  startAutoApplyQueueRun(
    jobIds: readonly string[],
    capacityToken?: ApplicationPreparationCapacityToken,
    applicationAutomationMode?: ApplicationAutomationMode,
  ): Promise<
    Awaited<ReturnType<JobFinderWorkspaceService["startAutoApplyQueueRun"]>>
  >;
  startApplyCopilotRun(
    jobId: string,
    options?: { visualCheckpointsEnabled?: boolean },
    applicationRecordId?: string | null,
    capacityToken?: ApplicationPreparationCapacityToken,
  ): Promise<
    Awaited<ReturnType<JobFinderWorkspaceService["startApplyCopilotRun"]>>
  >;
  approveApplyRun(
    runId: string,
    capacityToken?: ApplicationPreparationCapacityToken,
  ): Promise<Awaited<ReturnType<JobFinderWorkspaceService["approveApplyRun"]>>>;
  resumeParkedApplyRuns(
    control: JobFinderActivityControl,
    onFinished?: () => void,
  ): Promise<void>;
  resolveApplyConsentRequest(
    requestId: string,
    action: "approve" | "decline",
    capacityToken?: ApplicationPreparationCapacityToken,
  ): Promise<
    Awaited<ReturnType<JobFinderWorkspaceService["resolveApplyConsentRequest"]>>
  >;
  approveApply(
    jobId: string,
    applicationRecordId?: string | null,
    capacityToken?: ApplicationPreparationCapacityToken,
  ): Promise<Awaited<ReturnType<JobFinderWorkspaceService["approveApply"]>>>;
  resumeApplicationUserAction(
    request: UserActionRequest,
    taskLocalCredentials?: TaskLocalApplicationCredentials,
  ): Promise<void>;
};

async function getLatestResumeRevisionId(
  ctx: WorkspaceServiceContext,
  draftId: string,
): Promise<string | null> {
  return (
    (await ctx.repository.listResumeDraftRevisions(draftId))[0]?.id ?? null
  );
}

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

/** Recording a finished preparation, tolerant of answers saved meanwhile. */
async function assertPreparationProfileCurrent(
  ctx: WorkspaceServiceContext,
  prerequisites: { profile: CandidateProfile; profileRevision: number },
): Promise<void> {
  const current = await ctx.repository.getProfileWithRevision();
  if (
    current.revision !== prerequisites.profileRevision &&
    onlySavedAnswersWereAdded(prerequisites.profile, current.profile)
  ) {
    return;
  }
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
    const [
      discovery,
      settings,
      preferences,
      selectedSaved,
      intelligence,
      assets,
      attempts,
    ] = await Promise.all([
      ctx.repository.readDiscoveryDisplayProjection(),
      ctx.repository.getSettings(),
      ctx.repository.getSearchPreferences(),
      ctx.repository.listSavedJobsByIds(ids),
      ctx.repository.getIntelligenceState(),
      ctx.repository.listTailoredAssets(),
      ctx.repository.listApplicationAttempts(),
    ]);
    const selectedPending = discovery.pendingDiscoveryJobs.filter((job) =>
      requested.has(job.id),
    );
    const selected = new Map(
      [...selectedSaved, ...selectedPending].map((job) => [job.id, job]),
    );
    for (const id of ids)
      if (!selected.has(id))
        throw new Error(`Unable to shortlist unknown job '${id}'.`);
    // Resolving inactive aliases needs the complete identity inventory; the common
    // active-listing path reads only the rows this shortlist actually changes.
    const activityJobs = discovery.discoveryLedger.some(
      (entry) => entry.latestStatus === "inactive" && entry.inactiveAt !== null,
    )
      ? [
          ...(await ctx.repository.readSavedJobsProjection()),
          ...selectedPending,
        ]
      : [...selected.values()];
    const views = projectDiscoveryJobViews({
      jobs: activityJobs,
      discoveryLedger: discovery.discoveryLedger,
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
      ...(selectedPending.length > 0
        ? {
            upsertsFromBorrowedDiscovery: (current) =>
              current.pendingDiscoveryJobs
                .filter((job) => requested.has(job.id))
                .map((job) => SavedJobSchema.parse(shortlist(job))),
          }
        : {}),
      updateJobIds: ids,
      update: (job) => shortlist(job),
      ...(selectedPending.length > 0
        ? {
            updateDiscoveryState: (current: JobFinderDiscoveryState) => ({
              ...current,
              pendingDiscoveryJobs: current.pendingDiscoveryJobs.filter(
                (job) => !requested.has(job.id),
              ),
            }),
          }
        : {}),
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
      const savedJobs = await ctx.repository.listSavedJobsByIds([jobId]);
      const job =
        savedJobs[0] ??
        (await ctx.repository.getDiscoveryState()).pendingDiscoveryJobs.find(
          (entry) => entry.id === jobId,
        );
      if (!job) {
        if (options.throwOnFailure) {
          throw new Error(
            "This job is not in the saved or pending list. Use Assess next 1 listing in Find jobs to assess the search results.",
          );
        }
        return;
      }
      if (!listingReadCurrent(generation)) return;
      const isPending = savedJobs.length === 0;
      const alreadyRead =
        job.detailQuality === "detail_enriched" &&
        job.listingDetailFetch?.outcome === "enriched";
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
        !jobNeedsFitJudgment(job, session.contextFingerprint) &&
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
        );
        const matchAssessment = session.remember(job, assessed);
        if (!listingReadCurrent(generation)) return;
        await ctx.repository.commitSavedJobDelta({
          updateJobIds: [jobId],
          update: (current) =>
            current.id === jobId && current.description === job.description
              ? withPlanAssessment(current, assessmentPlanId, matchAssessment)
              : current,
          ...(isPending
            ? {
                updateDiscoveryState: (current: JobFinderDiscoveryState) => ({
                  ...current,
                  pendingDiscoveryJobs: current.pendingDiscoveryJobs.map(
                    (entry) =>
                      entry.id === jobId &&
                      entry.description === job.description
                        ? withPlanAssessment(
                            entry,
                            assessmentPlanId,
                            matchAssessment,
                          )
                        : entry,
                  ),
                }),
              }
            : {}),
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
        ...(isPending
          ? {
              updateDiscoveryState: (current: JobFinderDiscoveryState) => ({
                ...current,
                pendingDiscoveryJobs:
                  current.pendingDiscoveryJobs.map(applyRead),
              }),
            }
          : {}),
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
      // the read, the writer pauses the batch rather than writing without it.
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

  async function requireApplicationSafeguardClearance(
    jobIds: readonly string[],
    savedJobs?: readonly ReturnType<typeof SavedJobSchema.parse>[],
  ): Promise<void> {
    if (!ctx.requireApplicationSafeguardClearance) {
      throw new Error("Application safeguard gate not initialized.");
    }
    await ctx.requireApplicationSafeguardClearance(jobIds, savedJobs);
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

  function claimDirectApplyExecution(
    jobId: string,
    applicationRecordId: string,
  ): DirectApplyExecutionClaim {
    if (activeDirectApplyClaims.has(applicationRecordId)) {
      throw new Error(
        "This application is already being prepared. Wait for it to finish before starting it again.",
      );
    }

    const claim = {
      jobId,
      applicationRecordId,
      runId: createUniqueId("apply_run"),
      resultId: createUniqueId("apply_result"),
      controller: new AbortController(),
    } satisfies DirectApplyExecutionClaim;
    activeDirectApplyClaims.set(applicationRecordId, claim);
    ctx.activeApplyRunAbortControllers.set(claim.runId, claim.controller);
    return claim;
  }

  function releaseDirectApplyExecution(claim: DirectApplyExecutionClaim): void {
    if (activeDirectApplyClaims.get(claim.applicationRecordId) === claim) {
      activeDirectApplyClaims.delete(claim.applicationRecordId);
    }
    if (
      ctx.activeApplyRunAbortControllers.get(claim.runId) === claim.controller
    ) {
      ctx.activeApplyRunAbortControllers.delete(claim.runId);
    }
    ctx.activeApplyRunPromises.delete(claim.runId);
  }

  async function requireApplyActivityEnabled(): Promise<void> {
    // Preparing an application is an explicit click; it resumes paused
    // background work rather than failing with "press Resume on Home first".
    await ctx.resumeActivityForExplicitStart();
  }

  async function assertDirectApplyExecutionCanContinue(
    claim: DirectApplyExecutionClaim,
  ): Promise<void> {
    if (claim.controller.signal.aborted) {
      throw new DOMException(
        "Application preparation was aborted.",
        "AbortError",
      );
    }
    await requireApplyActivityEnabled();
    if (claim.controller.signal.aborted) {
      throw new DOMException(
        "Application preparation was aborted.",
        "AbortError",
      );
    }
  }

  async function assertNoOtherRunningApplyForJob(
    claim: DirectApplyExecutionClaim,
  ): Promise<void> {
    const [runs, results] = await Promise.all([
      ctx.repository.listApplyRuns(),
      ctx.repository.listApplyJobResults({ jobId: claim.jobId }),
    ]);
    const runningRun = runs.find((run) => {
      if (
        run.id === claim.runId ||
        run.state !== "running" ||
        !run.jobIds.includes(claim.jobId)
      ) {
        return false;
      }
      const runResults = results.filter((result) => result.runId === run.id);
      return (
        runResults.length === 0 ||
        runResults.some(
          (result) =>
            ["planned", "question_capture", "filling", "submitting"].includes(
              result.state,
            ) &&
            (result.applicationRecordId === null ||
              result.applicationRecordId === claim.applicationRecordId),
        )
      );
    });
    if (!runningRun) {
      return;
    }

    // A run is only really going while this process is still working on it.
    // One that was left marked running — the app closed, or the last attempt
    // died without recording anything — is finished here and now, so pressing
    // Prepare again starts rather than being refused by a ghost.
    // Only a copilot run is judged this way: it is the one this process drives
    // itself, so a missing promise really does mean nothing is working on it.
    // A queued or staged run is driven elsewhere and is left alone.
    if (
      runningRun.mode === "copilot" &&
      !ctx.activeApplyRunPromises.has(runningRun.id)
    ) {
      await markStaleApplyRunFailed(runningRun);
      return;
    }

    throw new Error(
      "This application is already being prepared. Wait for it to finish before starting it again.",
    );
  }

  /**
   * Closes a run nothing is working on any more.
   *
   * It says what is true — the attempt ended without finishing — rather than
   * leaving a record that claims to be running forever and a button that
   * refuses every press after it.
   */
  async function markStaleApplyRunFailed(
    run: ReturnType<typeof ApplyRunSchema.parse>,
  ): Promise<void> {
    const completedAt = new Date().toISOString();
    const detail =
      "The earlier attempt ended without recording a result, so Job Finder closed it. Nothing was sent. You can start this application again.";
    await ctx.repository.upsertApplyRun(
      ApplyRunSchema.parse({
        ...run,
        state: "failed",
        updatedAt: completedAt,
        completedAt,
        summary: "Apply copilot preparation did not finish.",
        detail,
        pendingJobs: 0,
        failedJobs: Math.max(1, run.failedJobs),
      }),
    );
    const staleResults = (
      await ctx.repository.listApplyJobResults({ runId: run.id })
    ).filter(
      (result) =>
        !["submitted", "skipped", "blocked", "failed", "cancelled"].includes(
          result.state,
        ),
    );
    await Promise.all(
      staleResults.map((result) =>
        ctx.repository.upsertApplyJobResult(
          ApplyJobResultSchema.parse({
            ...result,
            state: "failed",
            updatedAt: completedAt,
            completedAt,
            summary: "Application preparation did not finish.",
            detail,
          }),
        ),
      ),
    );
  }

  async function persistDirectApplyRunStart(input: {
    claim: DirectApplyExecutionClaim;
    job: ReturnType<typeof SavedJobSchema.parse>;
    campaignId: string | null;
    startedAt: string;
  }): Promise<void> {
    const run = ApplyRunSchema.parse({
      id: input.claim.runId,
      campaignId: input.campaignId,
      mode: "copilot",
      state: "running",
      jobIds: [input.job.id],
      currentJobId: input.job.id,
      submitApprovalId: null,
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
      completedAt: null,
      summary: "Job Finder is filling in this application.",
      detail:
        "You can pause or close the app while this runs. Whether it sends the application is the mode you chose in Settings.",
      totalJobs: 1,
      pendingJobs: 1,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    });
    const result = ApplyJobResultSchema.parse({
      id: input.claim.resultId,
      runId: input.claim.runId,
      jobId: input.job.id,
      applicationRecordId: input.claim.applicationRecordId,
      queuePosition: 0,
      state: "planned",
      summary: "Apply copilot preparation is starting.",
      detail:
        "The browser application flow has not reached a review checkpoint yet.",
      startedAt: input.startedAt,
      updatedAt: input.startedAt,
      completedAt: null,
      applicationPreparationStartedAt: null,
      applicationPreparationStartedLocalDate: null,
      blockerReason: null,
      blockerSummary: null,
      pendingConsentRequestCount: 0,
      artifactCount: 0,
      latestCheckpointId: null,
    });
    await Promise.all([
      ctx.repository.upsertApplyRun(run),
      ctx.repository.upsertApplyJobResult(result),
    ]);
  }

  async function markDirectApplyRunFailed(
    claim: DirectApplyExecutionClaim,
    error: unknown,
  ): Promise<void> {
    if (claim.controller.signal.aborted) {
      // Pause and shutdown own the cancellation transition. Their callers
      // either cancel this durable run or recover it as failed after waiting.
      return;
    }
    // Activity pause owns the cancellation transition. A direct flow can
    // observe the persisted pause between its final guard and this failure
    // handler, before the pause caller reaches the controller abort loop.
    const activityControl = await ctx.repository.getActivityControl();
    if (
      activityControl.paused &&
      activityControl.pauseBehavior !== "finish_current"
    ) {
      return;
    }
    const latestRun = (await ctx.repository.listApplyRuns()).find(
      (run) => run.id === claim.runId,
    );
    if (!latestRun || latestRun.state !== "running") {
      return;
    }
    const completedAt = new Date().toISOString();
    const detail =
      error instanceof Error
        ? error.message
        : "The direct application preparation flow failed before review.";
    const handedToPerson = isBrowserHandedToPersonError(error);
    const failedRun = ApplyRunSchema.parse({
      ...latestRun,
      state: "failed",
      updatedAt: completedAt,
      completedAt,
      summary: handedToPerson
        ? "Stopped because you took over the browser."
        : "Apply copilot preparation failed.",
      detail: `${detail} No final submit action was taken; the run can be restarted after the failure is reviewed.`,
      pendingJobs: 0,
      failedJobs: Math.max(1, latestRun.failedJobs),
    });
    const latestResult = (await ctx.repository.listApplyJobResults()).find(
      (result) => result.id === claim.resultId,
    );
    const failedResult =
      latestResult &&
      !["submitted", "skipped", "blocked", "failed", "cancelled"].includes(
        latestResult.state,
      )
        ? ApplyJobResultSchema.parse({
            ...latestResult,
            state: "failed",
            updatedAt: completedAt,
            completedAt,
            summary: handedToPerson
              ? PERSON_TOOK_OVER_SUMMARY
              : "Application preparation failed.",
            detail: `${detail} No final submit action was taken.`,
          })
        : null;

    await Promise.all([
      ctx.repository.upsertApplyRun(failedRun),
      ...(failedResult
        ? [ctx.repository.upsertApplyJobResult(failedResult)]
        : []),
    ]);
  }

  /**
   * The last word on a run that ended badly.
   *
   * Used only when the ordinary failure path could not write its own record:
   * whatever else is wrong, the run must not be left claiming to be running.
   */
  async function forceApplyRunFailed(
    claim: DirectApplyExecutionClaim,
  ): Promise<void> {
    const latestRun = (await ctx.repository.listApplyRuns()).find(
      (run) => run.id === claim.runId,
    );
    if (!latestRun || latestRun.state !== "running") {
      return;
    }
    const completedAt = new Date().toISOString();
    await ctx.repository.upsertApplyRun(
      ApplyRunSchema.parse({
        ...latestRun,
        state: "failed",
        updatedAt: completedAt,
        completedAt,
        summary: "Apply copilot preparation failed.",
        detail:
          "Job Finder stopped working on this application and could not say why. Nothing was sent. You can start it again.",
        pendingJobs: 0,
        failedJobs: Math.max(1, latestRun.failedJobs),
      }),
    );
  }

  function trackDirectApplyExecution<T>(
    claim: DirectApplyExecutionClaim,
    operation: () => Promise<T>,
  ): Promise<T> {
    const operationPromise = operation()
      .catch(async (error: unknown) => {
        // Whatever this was, it is written down before anything else happens.
        // A failure nobody can see is how a run ends up marked running for
        // ever with a button that refuses every press after it.
        console.error(
          "[apply]",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        try {
          await markDirectApplyRunFailed(claim, error);
        } catch (markError) {
          console.error(
            "[apply] could not record the failure",
            markError instanceof Error
              ? (markError.stack ?? markError.message)
              : markError,
          );
          await forceApplyRunFailed(claim).catch(() => undefined);
        }
        throw error;
      })
      .finally(async () => {
        try {
          await releaseFinishedApplicationPages({ ...ctx, runId: claim.runId });
        } finally {
          releaseDirectApplyExecution(claim);
        }
      });
    ctx.activeApplyRunPromises.set(
      claim.runId,
      operationPromise.then(
        () => undefined,
        () => undefined,
      ),
    );
    return operationPromise;
  }

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

  function createApplyAbortedError(): Error {
    return new DOMException(
      "The apply run was cancelled before its results were saved.",
      "AbortError",
    );
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

  async function assertDirectApplyTerminalTransitionIsOpen(
    claim: DirectApplyExecutionClaim,
  ): Promise<void> {
    const latestRun = (await ctx.repository.listApplyRuns()).find(
      (entry) => entry.id === claim.runId,
    );
    const activityControl = await ctx.repository.getActivityControl();
    if (
      claim.controller.signal.aborted ||
      (activityControl.paused &&
        activityControl.pauseBehavior !== "finish_current") ||
      latestRun?.state !== "running"
    ) {
      throw createApplyAbortedError();
    }
  }

  const resumeDraftTransitionTails = new Map<string, Promise<void>>();
  const inFlightResumeGenerations = new Map<
    string,
    Promise<JobFinderWorkspaceSnapshot>
  >();

  const resumeAdmission = createConcurrencyLimiter(RESUME_PIPELINE_CAPACITY);
  // Writers back off together when the AI service keeps refusing for load,
  // instead of every queued resume running into the same limit and failing.
  const resumeWriters = createAdaptiveConcurrencyLimiter({
    max: RESUME_AI_CONCURRENCY,
    min: 2,
  });
  const resumeProcessors = createConcurrencyLimiter(RESUME_LOCAL_CONCURRENCY);
  const resumeCheckpointEpochs = new Map<string, number>();
  const inFlightResumeCores = new Map<
    string,
    Promise<ResumeBatchGenerationResult>
  >();
  type GenerationOptions = {
    language?: string | null;
    shouldStop?: () => boolean;
    onStage?: (stage: ResumeBatchGenerationProgress["stage"]) => void;
    onProviderBlocked?: (block: ResumeBatchProviderBlock) => void;
  };

  function reportResumeStage(
    options: GenerationOptions | undefined,
    stage: ResumeBatchGenerationProgress["stage"],
  ): void {
    try {
      options?.onStage?.(stage);
    } catch {
      /* A disconnected observer cannot cancel durable work. */
    }
  }

  function startResumeGeneration(
    jobId: string,
    options?: GenerationOptions,
    regenerate = false,
  ): Promise<ResumeBatchGenerationResult> {
    const existing = inFlightResumeCores.get(jobId);
    if (existing) return existing;
    let lastStage: ResumeBatchGenerationProgress["stage"] | undefined;
    const observedOptions: GenerationOptions = {
      ...options,
      onStage: (stage) => {
        if (lastStage === stage) return;
        lastStage = stage;
        options?.onStage?.(stage);
      },
    };
    reportResumeStage(observedOptions, "queued");
    const generation = listingGeneration();
    const run = resumeAdmission
      .run(() =>
        withResumeDraftTransition(
          jobId,
          async (): Promise<ResumeBatchGenerationResult> => {
            if (options?.shouldStop?.() || !listingReadCurrent(generation))
              return { jobId, outcome: "not_started" };
            if (regenerate) {
              const draft = await ctx.repository.getResumeDraftByJobId(jobId);
              if (draft && hasLockedResumeContent(draft))
                throw new Error(
                  "Unlock pinned resume sections or bullets before regenerating the full draft.",
                );
            }
            return runGenerateResume(jobId, observedOptions);
          },
        ),
      )
      .finally(() => {
        if (inFlightResumeCores.get(jobId) === run)
          inFlightResumeCores.delete(jobId);
        reportResumeStage(observedOptions, "finished");
      });
    inFlightResumeCores.set(jobId, run);
    return run;
  }

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

  async function assertResumeDraftCurrent(draft: ResumeDraft): Promise<void> {
    const currentDraft = await ctx.repository.getResumeDraftByJobId(
      draft.jobId,
    );
    if (
      !currentDraft ||
      currentDraft.updatedAt !== draft.updatedAt ||
      buildResumeDraftStateHash(currentDraft) !==
        buildResumeDraftStateHash(draft)
    ) {
      throw new Error(
        "Resume draft changed before this operation could be saved. Reload the workspace and try again.",
      );
    }
  }

  const consentResolutionTails = new Map<string, Promise<void>>();

  async function withConsentResolution<T>(
    requestId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = consentResolutionTails.get(requestId) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    consentResolutionTails.set(requestId, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseCurrent();
      if (consentResolutionTails.get(requestId) === tail) {
        consentResolutionTails.delete(requestId);
      }
    }
  }

  function hasLockedResumeContent(draft: ResumeDraft): boolean {
    return draft.sections.some(
      (section) =>
        section.locked ||
        section.bullets.some((bullet) => bullet.locked) ||
        section.entries.some(
          (entry) =>
            entry.locked || entry.bullets.some((bullet) => bullet.locked),
        ),
    );
  }

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

  /**
   * Commits a work-history review acknowledgment/removal as a real draft
   * mutation: approval and export binding are cleared, the tailored asset
   * loses its storage path, and validation plus a revision are persisted
   * atomically under the same optimistic concurrency contract as every other
   * draft mutation.
   */
  async function persistWorkHistoryReviewAcknowledgmentMutation(input: {
    jobId: string;
    currentDraft: ResumeDraft;
    mutatedAt: string;
    reason: string;
    nextAcknowledgments: readonly WorkHistoryReviewAcknowledgment[];
  }): Promise<JobFinderWorkspaceSnapshot> {
    const state = await ensureResumeDraft(ctx, input.jobId);
    const hadApprovedExport = wasResumeDraftApproved(input.currentDraft);
    const nextDraft = ResumeDraftSchema.parse({
      ...input.currentDraft,
      workHistoryReviewAcknowledgments: input.nextAcknowledgments,
      status: hadApprovedExport ? "stale" : "needs_review",
      approvedAt: null,
      approvedExportId: null,
      staleReason: hadApprovedExport
        ? "Work-history review decisions changed after approval and need a fresh review."
        : null,
      updatedAt: input.mutatedAt,
    });
    const revision = buildResumeDraftRevision({
      draft: input.currentDraft,
      resultingDraft: nextDraft,
      createdAt: input.mutatedAt,
      parentRevisionId: await getLatestResumeRevisionId(
        ctx,
        input.currentDraft.id,
      ),
      actor: "user",
      mutationKind: "manual_save",
      reason: input.reason,
    });
    const validation = validateResumeDraft({
      draft: nextDraft,
      job: state.job,
      profile: state.profile,
      validatedAt: input.mutatedAt,
    });
    const previousValidation =
      (await ctx.repository.listResumeValidationResults(nextDraft.id))[0] ??
      null;
    const validationWithReviewGuidance = preserveWorkHistoryReviewGuidance({
      validation,
      previousValidation,
      draft: nextDraft,
    });
    const nextAsset = buildTailoredAssetBridge({
      draft: nextDraft,
      job: state.job,
      profile: state.profile,
      existingAsset: state.tailoredAsset,
      clearStoragePath: true,
      templates: state.templates,
    });

    await ctx.repository.applyResumePatchWithRevision({
      expectedDraftUpdatedAt: input.currentDraft.updatedAt,
      draft: nextDraft,
      revision,
      validation: validationWithReviewGuidance,
      tailoredAsset: nextAsset,
    });

    return ctx.getWorkspaceSnapshot();
  }

  /**
   * Commits a resume claim confirmation/removal as a real draft mutation.
   * Confirmation truth participates in export eligibility, so any change
   * invalidates the approval and export binding exactly like every other
   * claim-affecting draft mutation, and the monotonic revision records the
   * decision even though claim text itself is unchanged.
   */
  async function persistResumeClaimConfirmationMutation(input: {
    jobId: string;
    currentDraft: ResumeDraft;
    mutatedAt: string;
    reason: string;
    nextConfirmations: readonly ResumeClaimConfirmation[];
    nextIssueApprovals?: readonly ResumeIssueApproval[];
  }): Promise<JobFinderWorkspaceSnapshot> {
    const state = await ensureResumeDraft(ctx, input.jobId);
    const hadApprovedExport = wasResumeDraftApproved(input.currentDraft);
    const nextDraft = ResumeDraftSchema.parse({
      ...input.currentDraft,
      claimConfirmations: input.nextConfirmations,
      issueApprovals:
        input.nextIssueApprovals ?? input.currentDraft.issueApprovals,
      status: hadApprovedExport ? "stale" : "needs_review",
      approvedAt: null,
      approvedExportId: null,
      staleReason: hadApprovedExport
        ? "Claim confirmations changed after approval and need a fresh review."
        : null,
      updatedAt: input.mutatedAt,
    });
    const revision = buildResumeDraftRevision({
      draft: input.currentDraft,
      resultingDraft: nextDraft,
      createdAt: input.mutatedAt,
      parentRevisionId: await getLatestResumeRevisionId(
        ctx,
        input.currentDraft.id,
      ),
      actor: "user",
      mutationKind: "manual_save",
      reason: input.reason,
    });
    const validation = validateResumeDraft({
      draft: nextDraft,
      job: state.job,
      profile: state.profile,
      validatedAt: input.mutatedAt,
    });
    const previousValidation =
      (await ctx.repository.listResumeValidationResults(nextDraft.id))[0] ??
      null;
    const validationWithReviewGuidance = preserveWorkHistoryReviewGuidance({
      validation,
      previousValidation,
      draft: nextDraft,
    });
    const nextAsset = buildTailoredAssetBridge({
      draft: nextDraft,
      job: state.job,
      profile: state.profile,
      existingAsset: state.tailoredAsset,
      clearStoragePath: true,
      templates: state.templates,
    });

    await ctx.repository.applyResumePatchWithRevision({
      expectedDraftUpdatedAt: input.currentDraft.updatedAt,
      draft: nextDraft,
      revision,
      validation: validationWithReviewGuidance,
      tailoredAsset: nextAsset,
    });

    return ctx.getWorkspaceSnapshot();
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
        : ctx.repository.listSavedJobs(),
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
    const draftFilePath = asset?.storagePath?.trim() || null;
    const canUseReviewedDraft =
      (settings.applicationAutomationMode ?? "prepare_only") ===
        "prepare_only" &&
      draft !== null &&
      (draft.status === "draft" || draft.status === "needs_review") &&
      asset?.status === "ready" &&
      draftFilePath !== null;

    if (!draft) {
      throw new Error(
        `A tailored resume draft is required before preparing the application for '${job.title}'.`,
      );
    }
    if (!approvedExport && !canUseReviewedDraft) {
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

    const selectedFilePath = approvedExport?.filePath ?? draftFilePath;
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

    const verifiedSha256 = approvedExport
      ? await verifyResumeFileIntegrity({
          expectedSha256: approvedExport.sha256,
          filePath: selectedFilePath,
          label: "The approved tailored CV",
        })
      : ((await ctx.exportFileVerifier?.sha256?.(selectedFilePath)) ?? null);
    const verifiedApprovedExportPath =
      await resolveVerifiedResumeFilePath(selectedFilePath);

    return {
      job,
      profile,
      profileState,
      profileRevision: profileState.revision,
      resumeApplicationMode,
      resumeArtifact: ApplicationResumeArtifactSchema.parse({
        id: `application_resume_${job.id}_${approvedExport?.id ?? draft.id}`,
        jobId: job.id,
        source: "tailored_export",
        sourceDocumentId: approvedExport ? null : draft.id,
        exportArtifactId: approvedExport?.id ?? null,
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
    const savedJobs = await ctx.repository.listSavedJobs();
    const job = savedJobs.find((entry) => entry.id === input.jobId) ?? null;

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

  function mergeMissingResumeApplicationRecord(input: {
    applicationRecord: ReturnType<typeof ApplicationRecordSchema.parse>;
    existingRecord: ReturnType<typeof ApplicationRecordSchema.parse> | null;
  }) {
    if (!input.existingRecord) {
      return input.applicationRecord;
    }

    return ApplicationRecordSchema.parse({
      ...input.existingRecord,
      ...input.applicationRecord,
      id: input.existingRecord.id,
      status: input.existingRecord.status,
      lastAttemptState:
        input.applicationRecord.latestBlocker?.code === "missing_resume"
          ? input.existingRecord.lastAttemptState
          : input.applicationRecord.lastAttemptState,
      questionSummary: input.applicationRecord.questionSummary,
      latestBlocker: input.applicationRecord.latestBlocker,
      consentSummary: input.applicationRecord.consentSummary,
      replaySummary: input.applicationRecord.replaySummary,
      crm: input.existingRecord.crm,
      events: mergeEvents(
        input.existingRecord.events,
        input.applicationRecord.events,
      ),
    });
  }

  async function clearStaleMissingResumeBlockerForJob(
    jobId: string,
  ): Promise<void> {
    const [
      applicationRecords,
      resumeDrafts,
      resumeExportArtifacts,
      tailoredAssets,
    ] = await Promise.all([
      ctx.repository.listApplicationRecords(),
      ctx.repository.listResumeDrafts(),
      ctx.repository.listResumeExportArtifacts({ jobId }),
      ctx.repository.listTailoredAssets(),
    ]);
    const now = new Date().toISOString();

    await reconcileStaleMissingResumeBlockers(ctx.repository, {
      applicationRecords: applicationRecords.filter(
        (record) => record.jobId === jobId,
      ),
      resumeDrafts,
      resumeExportArtifacts,
      tailoredAssets,
      detectedAt: now,
    });
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
      savedJobs,
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
      ctx.repository.listSavedJobs(),
    ]);
    const run = runs.find((entry) => entry.id === input.runId) ?? null;
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
    let admissionStopDetail: string | null = null;
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

        try {
          const queuedJob = savedJobsById.get(jobId);
          await requireApplicationSafeguardClearance(
            [jobId],
            queuedJob ? [queuedJob] : [],
          );
        } catch (error) {
          if (await stopIfRunWasCancelled(true)) {
            return;
          }
          admissionStopped = true;
          admissionStopDetail =
            error instanceof Error
              ? error.message
              : "Application safeguards could not be verified before the next queued job.";
          await withApplyRunTransition(run.id, async () => {
            if (await stopIfRunWasCancelled()) return;
            const progress = await readQueueProgress();
            currentRunState = ApplyRunSchema.parse({
              ...currentRunState,
              ...progress,
              state: "paused_for_user_review",
              currentJobId: jobId,
              updatedAt: new Date().toISOString(),
              completedAt: null,
              summary: "Automatic apply paused before the next queued job.",
              detail: admissionStopDetail,
            });
            await ctx.repository.upsertApplyRun(currentRunState);
          });
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
          const provenanceTarget = provenanceTargetId
            ? (searchPreferences.discovery.targets.find(
                (target) => target.id === provenanceTargetId,
              ) ?? null)
            : null;
          const activeInstruction = provenanceTarget
            ? resolveActiveSourceInstructionArtifact(
                provenanceTarget,
                sourceInstructionArtifacts,
              )
            : null;
          const applyInstructions = uniqueStrings([
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
            profile: mergeApplicationAnswersIntoExecutionProfile({
              profile: browserProfile.profile,
              questionRecords:
                await ctx.repository.listApplicationQuestionRecords({
                  applicationRecordId: exactApplicationRecordId,
                }),
              answerRecords: await ctx.repository.listApplicationAnswerRecords({
                applicationRecordId: exactApplicationRecordId,
              }),
              idPrefix: `application_${exactApplicationRecordId}`,
              applicationRecordId: exactApplicationRecordId,
              jobLocation: job.location,
            }),
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
      const requestedConcurrency = Number(
        process.env.NESTOR_APPLICATION_PREPARATION_CONCURRENCY ?? 2,
      );
      const concurrency =
        input.mode === "single_job_auto"
          ? 1
          : Number.isInteger(requestedConcurrency)
            ? Math.max(1, Math.min(5, requestedConcurrency))
            : 2;
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
   * A new attempt for a job replaces an older one-job run that was only
   * waiting on the person for that job: its hand-off is superseded, so left
   * paused it read as a safety pause that could never carry on.
   */
  async function closeReplacedSingleJobRuns(
    jobId: string,
    newRunId: string,
  ): Promise<void> {
    const replaced = (await ctx.repository.listApplyRuns()).filter(
      (run) =>
        run.id !== newRunId &&
        run.mode !== "queue_auto" &&
        run.jobIds.length === 1 &&
        run.jobIds[0] === jobId &&
        (run.state === "paused_for_user_review" ||
          run.state === "paused_for_consent"),
    );
    const at = new Date().toISOString();
    for (const run of replaced) {
      await ctx.repository.upsertApplyRun(
        ApplyRunSchema.parse({
          ...run,
          state: "cancelled",
          updatedAt: at,
          completedAt: at,
          summary: "Replaced by a newer attempt for this job.",
          detail:
            "A later attempt for this application took over; nothing more happens on this one.",
        }),
      );
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

  /**
   * Closes a staged batch that never began. The run row is written before
   * execution starts, so a refusal in between would otherwise leave a paused
   * run nobody owns; the paused card would keep offering the same button and
   * every press would leave another one behind. The run and its untouched
   * planned rows end with one plain sentence saying why nothing was opened.
   */
  async function closeUnstartedBatchRun(
    runId: string,
    error: unknown,
  ): Promise<void> {
    const reason = describeUnstartedBatchReason(
      error instanceof Error ? error.message : null,
    );
    const now = new Date().toISOString();
    const [runs, results] = await Promise.all([
      ctx.repository.listApplyRuns({ id: runId }),
      ctx.repository.listApplyJobResults({ runId }),
    ]);
    const run = runs[0] ?? null;
    if (!run || run.state !== "paused_for_user_review") {
      return;
    }
    const untouched = results.filter(
      (result) =>
        result.state === "planned" && !result.applicationPreparationStartedAt,
    );
    await Promise.all(
      untouched.map((result) =>
        ctx.repository.upsertApplyJobResult(
          ApplyJobResultSchema.parse({
            ...result,
            state: "skipped",
            updatedAt: now,
            completedAt: now,
            summary: "Not started.",
            detail: reason,
          }),
        ),
      ),
    );
    const nextResults = results.map((result) =>
      untouched.some((candidate) => candidate.id === result.id)
        ? { ...result, state: "skipped" as const }
        : result,
    );
    await ctx.repository.upsertApplyRun(
      ApplyRunSchema.parse({
        ...run,
        state: "failed",
        updatedAt: now,
        completedAt: now,
        summary: reason,
        detail:
          "Nothing was opened, filled or submitted for these jobs. Your approval for this batch is still on record, so you can try again without approving again.",
        ...deriveRecoveredApplyRunCounters(nextResults, now),
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

  /**
   * Generation core shared by `generateResume` and `regenerateResumeDraft`.
   * It snapshots workspace state up front and only persists after the long
   * AI/render pipeline, so every caller must hold this job's resume-draft
   * transition across the whole call; otherwise an interleaved save could win
   * the optimistic-concurrency check between the snapshot and the durable
   * write. Because callers serialize, the equal-content persistence branch is
   * also safe: no newer validation or asset state can exist while the tail is
   * held.
   */
  async function runGenerateResume(
    jobId: string,
    options?: GenerationOptions,
  ): Promise<ResumeBatchGenerationResult> {
    const generation = listingGeneration();
    const signal = ctx.listingAssessmentAbortControllerRef?.current.signal;
    const current = () => listingReadCurrent(generation);
    let releaseWriter: (() => void) | undefined;
    let releaseProcessor: (() => void) | undefined;
    let providerBlockReported = false;
    let providerBlockError: Error | undefined;
    const reportProviderBlock = (error: unknown) => {
      const block = getAiProviderAccessFailure(error);
      if (!block || providerBlockReported || !current()) return;
      providerBlockReported = true;
      providerBlockError = new Error(block.message, { cause: error });
      try {
        options?.onProviderBlocked?.(block);
      } catch {
        /* Observers cannot replace the provider error. */
      }
    };
    const intelligence = withResumeBatchLiveness(
      ctx.repository,
      await (ctx.repository.readIntelligenceProjection?.() ??
        ctx.repository.getIntelligenceState()),
    );
    const continuedBatch = intelligence.resumeBatchCheckpoint?.running
      ? intelligence.resumeBatchCheckpoints?.findLast(
          (batch) =>
            batch.running &&
            !batch.done &&
            !!batch.resumedBatchIds?.length &&
            batch.jobIds.includes(jobId) &&
            !batch.completedJobIds.includes(jobId),
        )
      : undefined;
    const request = continuedBatch?.requests?.findLast(
      (entry) => entry.jobId === jobId,
    );
    if (options?.language === undefined && request?.language !== undefined)
      options = { ...options, language: request.language };

    if (request?.level) {
      await ctx.updateJob(jobId, (job) =>
        SavedJobSchema.parse({
          ...job,
          resumeApplicationMode: "tailored_per_job",
          resumeTailoringMode:
            request.level === "light"
              ? "conservative"
              : request.level === "tailored"
                ? "balanced"
                : "aggressive",
        }),
      );
    }
    const requestedJob = (
      await ctx.repository.listSavedJobsByIds([jobId])
    ).find((entry) => entry.id === jobId);
    if (
      options?.shouldStop &&
      requestedJob?.resumeApplicationMode === "original_resume"
    )
      return { jobId, outcome: "original" };
    if (requestedJob?.status !== "shortlisted")
      removedResumeJobIds.delete(jobId);
    if (removedResumeJobIds.has(jobId)) return { jobId, outcome: "cancelled" };
    // A resume is written toward the listing, so read the listing first when
    // the search only kept the card (or an earlier read failed).
    releaseWriter = await resumeWriters.acquire();
    if (options?.shouldStop?.() || !current()) {
      releaseWriter();
      return { jobId, outcome: "not_started" };
    }
    try {
      reportResumeStage(options, "writing");
      await readListingDetailForShortlistedJob(jobId, {
        force: true,
        resumeWriterOwnsSlot: true,
      });
      if (!current()) return { jobId, outcome: "cancelled" };
      const [
        profileState,
        searchPreferences,
        settings,
        savedJobs,
        existingAsset,
        intelligenceState,
        campaignState,
      ] = await Promise.all([
        ctx.repository.getProfileWithRevision(),
        ctx.repository.getSearchPreferences(),
        ctx.repository.getSettings(),
        ctx.repository.listSavedJobsByIds([jobId]),
        ctx.repository.getTailoredAssetByJobId(jobId),
        ctx.repository.readIntelligenceProjection?.() ??
          ctx.repository.getIntelligenceState(),
        ctx.repository.getCampaignState(),
      ]);
      const { revision: profileRevision } = profileState;
      const profile = {
        ...profileState.profile,
        experiences: profileState.profile.experiences.filter(
          (record) => !record.isDraft,
        ),
        education: profileState.profile.education.filter(
          (record) => !record.isDraft,
        ),
        certifications: profileState.profile.certifications.filter(
          (record) => !record.isDraft,
        ),
        links: profileState.profile.links.filter((record) => !record.isDraft),
      };
      const job = savedJobs.find((entry) => entry.id === jobId);

      if (!job) {
        throw new Error(
          `Unable to generate a resume for unknown job '${jobId}'.`,
        );
      }

      if (
        options?.shouldStop &&
        job.resumeApplicationMode === "original_resume"
      )
        return { jobId, outcome: "original" };
      if (removedResumeJobIds.has(jobId) || !current())
        return { jobId, outcome: "cancelled" };
      reportResumeStage(options, "writing");
      if (existingAsset?.failureMessage || existingAsset?.failedAt) {
        await ctx.repository.upsertTailoredAsset({
          ...existingAsset,
          failureMessage: null,
          failedAt: null,
        });
      }

      const existingDraft = await ctx.repository.getResumeDraftByJobId(jobId);
      const templates = ctx.documentManager.listResumeTemplates();
      const strategyContext = buildResumeStrategyContext({
        state: intelligenceState,
        job,
        campaignDefaultResumeStrategyId: resolveCampaignDefaultResumeStrategyId(
          campaignState,
          jobId,
        ),
      });
      const strategyPolicy = buildResumeGenerationStrategyPolicy({
        state: intelligenceState,
        job,
        campaignDefaultResumeStrategyId: resolveCampaignDefaultResumeStrategyId(
          campaignState,
          jobId,
        ),
      });
      const effectiveTailoringMode =
        job.resumeTailoringMode ??
        strategyPolicy?.tailoringStrength ??
        searchPreferences.tailoringMode;
      const generationSearchPreferences = {
        ...searchPreferences,
        tailoringMode: effectiveTailoringMode,
      };
      const generationStrategyPolicy =
        strategyPolicy && job.resumeTailoringMode
          ? {
              ...strategyPolicy,
              tailoringStrength: job.resumeTailoringMode,
            }
          : strategyPolicy;
      const selectedBaseResumeDocumentId =
        strategyPolicy?.baseResumeDocumentId ?? profile.baseResume.id;
      const resumeImportBundles = strategyPolicy
        ? await ctx.repository.listResumeImportDocumentBundles()
        : [];
      const selectedBaseResume =
        resumeImportBundles.find(
          (bundle) =>
            bundle.id === selectedBaseResumeDocumentId ||
            bundle.sourceResumeId === selectedBaseResumeDocumentId,
        ) ?? null;
      const resumeText =
        selectedBaseResume?.fullText ?? profile.baseResume.textContent;
      const baseResumeFallbackNote =
        strategyPolicy &&
        selectedBaseResumeDocumentId !== profile.baseResume.id &&
        !selectedBaseResume?.fullText
          ? `Strategy base resume document "${selectedBaseResumeDocumentId}" was unavailable, so the current profile resume was used as the grounded source.`
          : null;
      const existingDraftRevisions = existingDraft
        ? await ctx.repository.listResumeDraftRevisions(existingDraft.id)
        : [];
      const hasExplicitDraftTemplate = existingDraftRevisions.some(
        (revision) =>
          (revision.actor === "user" || revision.actor === "restore") &&
          revision.diff?.templateChanged === true,
      );
      const hasExplicitStrategyTemplate =
        strategyPolicy?.effectiveSource === "selection";
      const lockedTemplateId = hasExplicitDraftTemplate
        ? (existingDraft?.templateId ?? null)
        : hasExplicitStrategyTemplate
          ? (strategyContext.templateId ?? null)
          : null;
      // Generation, rendering, and persistence failures must leave durable
      // queue truth behind: record the failed tailored asset before
      // propagating the original error to callers.
      try {
        const research = await fetchAndPersistResearch(
          ctx,
          job,
          profileRevision,
          profile,
        );
        const evidence = collectResumeWorkspaceEvidence({
          profile,
          job,
          research,
        });
        const researchContext = collectResearchContext(research);
        const targetLanguage =
          options?.language !== undefined
            ? options.language
            : (existingDraft?.language ?? null);
        const baseDraft = buildResumeDraftFromTailoredDraft({
          job,
          profile,
          research,
          templateId: settings.resumeTemplateId,
          draft: completeTailoredResumeDraft(
            {},
            {
              profile,
              job,
              settings,
              searchPreferences: generationSearchPreferences,
              resumeText,
              strategy: generationStrategyPolicy,
            },
          ),
          createdAt: new Date().toISOString(),
          generationMethod: "ai",
        });
        let excludedQueueWaitMs = 0;
        // Verdicts belong to this writer even if other jobs displace them from
        // the bounded session cache. The checker still compares the complete
        // evidence/context key and each line's hash before reusing them.
        let previewClaimChecks: NonNullable<ResumeDraft["claimChecks"]> = [];
        const draft = await ctx.aiClient.createResumeDraft({
          getExcludedElapsedMs: () => excludedQueueWaitMs,
          ...(signal ? { signal } : {}),
          profile,
          searchPreferences: generationSearchPreferences,
          settings,
          job,
          resumeText,
          strategy: generationStrategyPolicy,
          evidence,
          researchContext,
          availableTemplates: templates,
          selectedTemplateId:
            lockedTemplateId ??
            existingDraft?.templateId ??
            strategyContext.templateId ??
            settings.resumeTemplateId,
          templateSelectionLocked: lockedTemplateId !== null,
          language: targetLanguage,
          languageFields: collectResumeLanguageFields(baseDraft),
          targetPageCount: baseDraft.targetPageCount,
          renderPreview: async ({
            draft: previewDraft,
            templateId,
            signal: previewSignal,
            getRemainingBudgetMs,
          }) => {
            const checkSignal =
              previewSignal && signal
                ? AbortSignal.any([previewSignal, signal])
                : (previewSignal ?? signal);
            if (!current())
              throw new Error(
                "Resume generation stopped because the workspace changed.",
              );
            const template =
              templates.find((candidate) => candidate.id === templateId) ??
              null;
            if (!template || !isResumeTemplateApplyEligible(template)) {
              throw new Error(
                `Resume template '${templateId}' is unavailable or not apply-safe.`,
              );
            }
            const previewAt = new Date().toISOString();
            const assembledPreviewDraft = buildResumeDraftFromTailoredDraft({
              job,
              templateId: template.id,
              draft: previewDraft,
              createdAt: previewAt,
              updatedAt: previewAt,
              existingDraftId: existingDraft?.id ?? null,
              previousWorkHistoryReviewAcknowledgments:
                existingDraft?.workHistoryReviewAcknowledgments ?? [],
              generationMethod: "ai",
              profile,
              research,
            });
            assembledPreviewDraft.claimChecks = previewClaimChecks;
            const previewResumeDraft = await sanitizeAndCheckResumeDraft(
              ctx,
              {
                draft: previewDraft.languagePresentation
                  ? applyResumeLanguage(
                      assembledPreviewDraft,
                      previewDraft.languagePresentation,
                    )
                  : assembledPreviewDraft,
                job,
                profile,
                ...(generationStrategyPolicy
                  ? { sourceSkills: previewDraft.coreSkills }
                  : {}),
              },
              {
                ...(checkSignal ? { signal: checkSignal } : {}),
                ...(getRemainingBudgetMs ? { getRemainingBudgetMs } : {}),
              },
            ).catch((error: unknown) => {
              reportProviderBlock(error);
              throw error;
            });
            const rendered = await ctx.documentManager.renderResumeArtifact({
              ...(checkSignal ? { signal: checkSignal } : {}),
              onQueueWait: (milliseconds) => {
                excludedQueueWaitMs += milliseconds;
              },
              job,
              profile,
              renderDocument: buildResumeRenderDocument(
                profile,
                previewResumeDraft,
              ),
              templateId: template.id,
              settings,
            });
            const previewValidation = validateResumeDraft({
              draft: previewResumeDraft,
              job,
              profile,
              strategy: generationStrategyPolicy,
              pageCount: rendered.pageCount ?? null,
              validatedAt: previewAt,
            });
            previewClaimChecks = previewResumeDraft.claimChecks ?? [];
            // A stretch is the person's call only in aggressive tailoring
            // (ADR 0018); in the other modes the writer grounds it or drops it.
            const stretchesAreThePersons =
              effectiveTailoringMode === "aggressive";
            const personConfirmationAssessmentIds = new Set(
              stretchesAreThePersons
                ? previewValidation.claimAssessments
                    .filter(
                      (assessment) => assessment.status === "confirm_needed",
                    )
                    .map((assessment) => assessment.id)
                : [],
            );
            return {
              templateId: template.id,
              pageCount: rendered.pageCount ?? null,
              targetPageCount: previewResumeDraft.targetPageCount,
              warnings: rendered.warnings ?? [],
              fileName: rendered.fileName,
              // The writer repairs unbacked lines and lines outside the
              // strategy's evidence limits. Length is handled by the writer
              // itself from the page count above.
              requiredModelRepairs: previewValidation.issues.filter(
                (issue) =>
                  (issue.severity === "error" ||
                    issue.id.startsWith("issue_strategy_evidence_boundary_")) &&
                  !(
                    issue.id.startsWith("issue_claim_grounding_") &&
                    personConfirmationAssessmentIds.has(
                      issue.id.slice("issue_claim_grounding_".length),
                    )
                  ),
              ),
              personConfirmationCount: personConfirmationAssessmentIds.size,
              languageFields: collectResumeLanguageFields(previewResumeDraft),
            };
          },
        });
        // Prefer the structured provenance recorded by the AI boundary; the
        // note-prose inference stays only for legacy clients that omit it.
        releaseWriter();
        releaseWriter = undefined;
        reportResumeStage(options, "queued");
        if (!current()) return { jobId, outcome: "cancelled" };
        const provenance = draft.generationProvenance ?? null;
        const generationMethod = provenance
          ? provenance.method === "ai"
            ? "ai_assisted"
            : "deterministic"
          : draft.notes.some((note: string) =>
                normalizeText(note).includes("deterministic"),
              )
            ? "deterministic"
            : ctx.aiClient.getStatus().kind === "openai_compatible"
              ? "ai_assisted"
              : "deterministic";
        const generationReason =
          generationMethod === "deterministic"
            ? (provenance?.reason ??
              (ctx.aiClient.getStatus().kind === "openai_compatible"
                ? "provider_failed"
                : "no_provider_configured"))
            : null;
        const generationDetail = provenance?.detail?.trim() || null;
        const now = createMonotonicTimestamp(existingDraft?.updatedAt ?? null);
        // A strategy may supply the template default for a fresh draft, but it
        // never approves or readies the artifact: the generated draft stays
        // unapproved and the per-job approval/staleness checks stay
        // authoritative.
        const strategyTemplateId =
          lockedTemplateId ??
          draft.recommendedTemplateId ??
          existingDraft?.templateId ??
          strategyContext.templateId ??
          null;
        const strategyDisplayName =
          strategyContext.selectedStrategyName ??
          strategyContext.recommendedStrategyName ??
          null;
        const sourceDraft = buildResumeDraftFromTailoredDraft({
          job,
          templateId: strategyTemplateId ?? settings.resumeTemplateId,
          draft,
          createdAt: existingDraft?.createdAt ?? now,
          updatedAt: now,
          existingDraftId: existingDraft?.id ?? null,
          previousWorkHistoryReviewAcknowledgments:
            existingDraft?.workHistoryReviewAcknowledgments ?? [],
          generationMethod:
            generationMethod === "ai_assisted" ? "ai" : "deterministic",
          profile,
          research,
          headline:
            strategyPolicy?.headlinePolicy === "fixed"
              ? profile.headline
              : strategyPolicy?.headlinePolicy === "role_family_template"
                ? strategyPolicy.roleFamily
                : strategyPolicy?.headlinePolicy === "per_job_tailored"
                  ? job.title
                  : undefined,
        });
        const languageDraft = {
          ...sourceDraft,
          claimChecks: previewClaimChecks,
          language: targetLanguage,
        };
        const resumeDraft = draft.languagePresentation
          ? applyResumeLanguage(languageDraft, draft.languagePresentation)
          : languageDraft;
        releaseProcessor = await resumeProcessors.acquire();
        if (!current()) return { jobId, outcome: "cancelled" };
        reportResumeStage(options, "processing");
        const sanitizedResumeDraft = await sanitizeAndCheckResumeDraft(
          ctx,
          {
            draft: resumeDraft,
            job,
            profile,
            ...(strategyPolicy ? { sourceSkills: draft.coreSkills } : {}),
          },
          { fixGeneratedLines: true },
        );
        const previewSections = buildTailoredAssetBridge({
          draft: sanitizedResumeDraft,
          job,
          profile,
        }).previewSections;
        const contentText = buildTailoredResumeTextFromResumeDraft(
          profile,
          job,
          sanitizedResumeDraft,
        );
        await assertCurrentResumeProfile(
          ctx,
          profileRevision,
          "rendering this generated resume",
          profile,
        );
        const renderedArtifact = await ctx.documentManager.renderResumeArtifact(
          {
            job,
            profile,
            renderDocument: buildResumeRenderDocument(
              profile,
              sanitizedResumeDraft,
            ),
            templateId: sanitizedResumeDraft.templateId,
            settings,
          },
        );

        await assertCurrentResumeProfile(
          ctx,
          profileRevision,
          "completing this generated resume",
          profile,
        );

        if (!renderedArtifact.storagePath) {
          throw new Error(
            `Resume export failed for '${job.title}' at '${job.company}'.`,
          );
        }

        const validation = validateResumeDraft({
          draft: sanitizedResumeDraft,
          job,
          profile,
          strategy: generationStrategyPolicy,
          pageCount: renderedArtifact.pageCount ?? null,
          validatedAt: now,
        });
        const workHistoryReviewSuggestions = buildWorkHistoryReviewSuggestions({
          draft: sanitizedResumeDraft,
          tailoredDraft: draft,
        });
        const validationWithReviewGuidance = ResumeValidationResultSchema.parse(
          {
            ...validation,
            coverageComparison: buildResumeCoverageComparison({
              profile,
              draft: sanitizedResumeDraft,
              pageCount: renderedArtifact.pageCount ?? null,
              validationIssues: validation.issues,
              coverageMetadata: draft.coverageMetadata,
            }),
            issues: [
              ...validation.issues,
              ...workHistoryReviewSuggestions.map((suggestion) => ({
                id: `issue_${suggestion.id}`,
                severity: suggestion.severity,
                category:
                  suggestion.kind === "date_quality"
                    ? ("date_quality" as const)
                    : ("work_history_review" as const),
                sectionId: suggestion.sectionId,
                entryId: suggestion.entryId,
                bulletId: null,
                message: suggestion.message,
              })),
            ],
          },
        );
        const nextAsset = TailoredAssetSchema.parse({
          id: existingAsset?.id ?? `resume_${jobId}`,
          jobId,
          kind: "resume",
          status: "ready",
          label: resolveTailoredAssetLabel({
            existingLabel: draft.label ?? existingAsset?.label ?? null,
            generationMethod,
            generationReason,
          }),
          version: nextAssetVersion(existingAsset ?? undefined),
          templateName: resolveResumeTemplateLabel({
            templateId: sanitizedResumeDraft.templateId,
            templates,
            fallbackLabel: existingAsset?.templateName ?? "Chronology Classic",
          }),
          compatibilityScore:
            draft.compatibilityScore ??
            Math.min(100, job.matchAssessment.score + 3),
          progressPercent: 100,
          updatedAt: now,
          storagePath: renderedArtifact.storagePath,
          contentText,
          previewSections,
          generationMethod,
          generationReason,
          generationDetail,
          notes: uniqueStrings([
            ...draft.notes,
            ...(strategyTemplateId && !existingDraft
              ? [
                  `Used resume strategy${strategyDisplayName ? ` "${strategyDisplayName}"` : ""} as the template default. The strategy does not approve or ready this artifact; it still needs your review and explicit approval.`,
                ]
              : []),
            ...(strategyPolicy
              ? [
                  `Applied resume strategy "${strategyPolicy.strategyName}" (${strategyPolicy.effectiveSource}: ${strategyPolicy.effectiveReason}); policies ${strategyPolicy.headlinePolicy} headline, ${strategyPolicy.skillsPolicy} skills, ${strategyPolicy.coveragePolicy} coverage, ${strategyPolicy.tailoringStrength} tailoring.`,
                ]
              : []),
            ...(baseResumeFallbackNote ? [baseResumeFallbackNote] : []),
            ...(renderedArtifact.fileName
              ? [
                  `Generated ${renderedArtifact.format.toUpperCase()} resume artifact ${renderedArtifact.fileName}.`,
                ]
              : []),
            ...(renderedArtifact.intermediateFileName
              ? [
                  `Saved HTML debug render ${renderedArtifact.intermediateFileName}.`,
                ]
              : []),
            ...(renderedArtifact.pageCount !== null &&
            renderedArtifact.pageCount !== undefined
              ? [`Generated PDF page count: ${renderedArtifact.pageCount}.`]
              : []),
            ...(renderedArtifact.warnings ?? []),
            ...(renderedArtifact.pageCount !== null &&
            renderedArtifact.pageCount !== undefined &&
            renderedArtifact.pageCount > sanitizedResumeDraft.targetPageCount
              ? [
                  `The resume runs to ${renderedArtifact.pageCount} pages; the target is ${sanitizedResumeDraft.targetPageCount}.`,
                ]
              : []),
          ]),
          // A successful generation is authoritative: clear any failure detail
          // left by an earlier failed attempt so retry truth stays accurate.
          failureMessage: null,
          failedAt: null,
        });

        if (!current()) return { jobId, outcome: "cancelled" };
        await assertCurrentResumeProfile(
          ctx,
          profileRevision,
          "saving this generated resume",
          profile,
        );

        const latestJob = (
          await ctx.repository.listSavedJobsByIds([jobId])
        ).find((entry) => entry.id === jobId);
        if (!latestJob || removedResumeJobIds.has(jobId))
          return { jobId, outcome: "cancelled" };

        if (
          existingDraft &&
          buildResumeDraftStateHash(existingDraft) !==
            buildResumeDraftStateHash(sanitizedResumeDraft)
        ) {
          const revision = buildResumeDraftRevision({
            draft: existingDraft,
            resultingDraft: sanitizedResumeDraft,
            createdAt: now,
            parentRevisionId: await getLatestResumeRevisionId(
              ctx,
              existingDraft.id,
            ),
            actor: "assistant",
            mutationKind: "regenerate_draft",
            reason: "Regenerated full resume draft",
          });
          await assertCurrentResumeProfile(
            ctx,
            profileRevision,
            "committing this generated resume",
            profile,
          );
          await ctx.repository.applyResumePatchWithRevision({
            expectedDraftUpdatedAt: existingDraft.updatedAt,
            draft: sanitizedResumeDraft,
            revision,
            validation: validationWithReviewGuidance,
            tailoredAsset: nextAsset,
          });
        } else {
          await ctx.repository.saveResumeDraftWithValidation({
            draft: sanitizedResumeDraft,
            validation: validationWithReviewGuidance,
            tailoredAsset: nextAsset,
          });
        }
        await ctx.updateJob(jobId, (currentJob) => ({
          ...currentJob,
          status: removedResumeJobIds.has(jobId)
            ? currentJob.status
            : "ready_for_review",
        }));

        if (generationMethod !== "deterministic") resumeWriters.recordSuccess();
        return {
          jobId,
          outcome:
            generationMethod === "deterministic" ? "fallback" : "written",
        };
      } catch (error) {
        if (isAiProviderRateLimited(error)) resumeWriters.recordOverload();
        if (!current()) return { jobId, outcome: "cancelled" };
        // Stop waiting writers before any asynchronous failure persistence.
        reportProviderBlock(error);
        const generationError = providerBlockError ?? error;
        // A failed run changes nothing (ADR 0041): a job that already had a
        // resume keeps it as it was, ready or approved, and the error tells the
        // person. The failure notice is saved beside the retained file, or on a
        // failed asset when no draft exists. A newer edit keeps its own state.
        try {
          const latestDraft = await ctx.repository.getResumeDraftByJobId(jobId);
          if (
            existingAsset &&
            existingDraft &&
            latestDraft?.updatedAt === existingDraft.updatedAt
          ) {
            await ctx.repository.upsertTailoredAsset({
              ...existingAsset,
              failureMessage: `${sanitizeTailoredAssetFailureMessage(generationError)} Your previous resume was kept.`,
              failedAt: new Date().toISOString(),
            });
          } else if (existingDraft === null && latestDraft === null) {
            await ctx.repository.upsertTailoredAsset(
              buildFailedTailoredAsset({
                jobId,
                existingAsset: existingAsset ?? null,
                error: generationError,
              }),
            );
          }
        } catch {
          // Failure persistence must never mask the original generation
          // error: the caller still sees why generation failed.
        }
        throw generationError;
      }
    } catch (error) {
      // Includes listing/preflight failures outside the asset-writing scope.
      reportProviderBlock(error);
      throw providerBlockError ?? error;
    } finally {
      // Publish completion before transferring a permit to the next job.
      // Otherwise progress can transiently count three processors despite a two-slot gate.
      reportResumeStage(options, "finished");
      releaseWriter?.();
      releaseProcessor?.();
    }
  }

  /**
   * Section-regeneration core for `regenerateResumeSection`. It binds the
   * produced proposal to the draft version it read, so its caller must hold
   * the job's resume-draft transition and keep a save from changing that
   * version between this snapshot and the proposal message write.
   */
  async function runRegenerateResumeSection(
    jobId: string,
    sectionId: string,
  ): Promise<JobFinderWorkspaceSnapshot> {
    const state = await ensureResumeDraft(ctx, jobId);
    const { draft } = state;
    const targetSection = draft.sections.find(
      (section) => section.id === sectionId,
    );

    if (!targetSection) {
      throw new Error(
        `Unable to regenerate unknown resume section '${sectionId}'.`,
      );
    }

    if (
      targetSection.locked ||
      targetSection.bullets.some((bullet) => bullet.locked)
    ) {
      throw new Error(
        `Unlock the '${targetSection.label}' section before regenerating it.`,
      );
    }

    if (
      targetSection.entries.some(
        (entry) =>
          entry.locked || entry.bullets.some((bullet) => bullet.locked),
      )
    ) {
      throw new Error(
        `Unlock the '${targetSection.label}' section before regenerating it.`,
      );
    }

    const research = await fetchAndPersistResearch(
      ctx,
      state.job,
      state.profileRevision,
    );
    const tailoringStrength =
      await resolveEffectiveResumeTailoringStrengthForJob(ctx, jobId);
    const assistantReply = await ctx.aiClient.reviseResumeDraft({
      draft,
      job: state.job,
      request: `Regenerate the ${targetSection.label} section for stronger alignment with ${state.job.title} at ${state.job.company}.`,
      validationIssues:
        (
          await ctx.repository.listResumeValidationResults(draft.id)
        )[0]?.issues.map((issue) => issue.message) ?? [],
      tailoringStrength,
      researchContext: collectResearchContext(research),
      checkProposal: (patches) =>
        checkResumeAssistantProposal({
          aiClient: ctx.aiClient,
          baselineDraft: draft,
          patches,
          job: state.job,
          profile: state.profile,
        }),
    });
    // Section regeneration is review-first like Guided Edits: normalized
    // model output for the requested section is stored as a pending
    // assistant proposal bound to the current draft version, and the draft
    // stays untouched until the user explicitly accepts it. When the model
    // returns no usable patch for this section, an explicit no-change
    // message is stored instead of fabricating a same-content patch.
    const proposedAt = createMonotonicTimestamp(draft.updatedAt);
    const normalizedSectionPatches = assistantReply.patches
      .filter((patch) => patch.targetSectionId === sectionId)
      .map((patch) =>
        ResumeDraftPatchSchema.parse({
          ...patch,
          draftId: draft.id,
          targetEntryId: patch.targetEntryId ?? null,
          // Same canonical-origin rule as Guided Edits: model output never
          // self-identifies as user-authored.
          origin: "assistant",
        }),
      );
    const unusableReplacementPatch = normalizedSectionPatches.find(
      (patch) =>
        [
          "replace_section_text",
          "replace_entry_summary",
          "update_bullet",
        ].includes(patch.operation) && !patch.newText?.trim(),
    );
    const reviewablePatches = unusableReplacementPatch
      ? []
      : normalizedSectionPatches;

    await assertResumeProfileRevisionCurrent(
      ctx,
      state.profileRevision,
      "saving this generated resume proposal",
    );

    if (reviewablePatches.length === 0) {
      await ctx.repository.upsertResumeAssistantMessage(
        buildAssistantReplyMessage({
          jobId,
          content: `I reviewed the '${targetSection.label}' section but did not produce a usable rewrite for it, so no change was proposed. The section is unchanged; try again or edit it manually.`,
          patches: [],
          executionAttribution: assistantReply.executionReceipt,
          createdAt: proposedAt,
        }),
      );

      return ctx.getWorkspaceSnapshot();
    }

    // One rule with export: a rewrite may only be called grounded when the
    // same classifier that gates export accepts the resulting text.
    let sectionProposalGate: {
      accepted: boolean;
      approvalBlockers: ResumeProposalApprovalBlocker[];
    };
    try {
      sectionProposalGate = await evaluateCheckedResumeProposalGrounding(
        { aiClient: ctx.aiClient, tailoringStrength },
        {
          baselineDraft: draft,
          patches: reviewablePatches,
          job: state.job,
          profile: state.profile,
          evaluatedAt: proposedAt,
        },
      );
    } catch {
      // An unappliable patch is never presented as a reviewable proposal.
      await ctx.repository.upsertResumeAssistantMessage(
        buildAssistantReplyMessage({
          jobId,
          content: `I reviewed the '${targetSection.label}' section but the rewrite could not be applied to the current draft, so no change was proposed.`,
          patches: [],
          executionAttribution: assistantReply.executionReceipt,
          createdAt: proposedAt,
        }),
      );

      return ctx.getWorkspaceSnapshot();
    }

    await ctx.repository.upsertResumeAssistantMessage(
      buildAssistantReplyMessage({
        jobId,
        content: buildResumeProposalReplyContent({
          approvalBlockers: sectionProposalGate.approvalBlockers,
          changeCount: reviewablePatches.length,
          scopeLabel: targetSection.label,
        }),
        approvalBlockers: sectionProposalGate.approvalBlockers,
        patches: reviewablePatches,
        baseDraftUpdatedAt: draft.updatedAt,
        executionAttribution: assistantReply.executionReceipt,
        createdAt: proposedAt,
      }),
    );

    return ctx.getWorkspaceSnapshot();
  }

  function feedbackFence(options?: DiscoveryFeedbackBatchOptions): () => void {
    const generation = listingGeneration();
    return () => {
      if (!listingReadCurrent(generation) || options?.signal?.aborted) {
        throw new FeedbackMutationStoppedError();
      }
      try {
        options?.assertCurrent?.();
      } catch {
        throw new FeedbackMutationStoppedError();
      }
    };
  }

  async function runFeedbackBatch(
    jobIds: readonly string[],
    success: "hidden" | "restored",
    options: DiscoveryFeedbackBatchOptions | undefined,
    mutate: (jobId: string, fence: () => void) => Promise<void>,
  ): Promise<DiscoveryFeedbackBatchResult> {
    const generation = listingGeneration();
    const fence = feedbackFence(options);
    const outcomes: DiscoveryFeedbackBatchOutcome[] = [];
    let stopped = false;
    for (const jobId of jobIds) {
      if (stopped) {
        outcomes.push({ jobId, status: "stopped" });
        continue;
      }
      try {
        fence();
        await mutate(jobId, fence);
        outcomes.push({ jobId, status: success });
      } catch (error) {
        if (error instanceof FeedbackMutationStoppedError) {
          stopped = true;
          outcomes.push({ jobId, status: "stopped" });
        } else {
          outcomes.push({
            jobId,
            status:
              error instanceof FeedbackMutationHeldError ? "held" : "failed",
            message:
              error instanceof Error ? error.message.slice(0, 200) : "error",
          });
        }
      }
    }
    let workspace = listingReadCurrent(generation)
      ? await ctx.getWorkspaceSnapshot()
      : null;
    if (!listingReadCurrent(generation)) workspace = null;
    return { outcomes, workspace };
  }

  async function dismissDiscoveryJobWithoutSnapshot(
    input: JobFinderDismissDiscoveryJobInput,
    assertCurrent: () => void,
    discoveredEmployer?: string,
  ): Promise<void> {
    assertCurrent();
    const occurredAt = new Date().toISOString();
    const reasons = [...new Set(input.reasons)];
    await ctx.repository.commitDiscoveryFeedbackUpdate(
      input.jobId,
      (current) => {
        assertCurrent();
        const targetJob = current.job;
        if (!targetJob) {
          throw new Error("Unable to hide unknown job '" + input.jobId + "'.");
        }

        if (discoveredEmployer !== undefined) {
          if (targetJob.status !== "discovered") {
            throw new FeedbackMutationHeldError(
              "The job is no longer in the found list.",
            );
          }
          if (normalizeCompanyName(targetJob.company) !== discoveredEmployer) {
            throw new FeedbackMutationHeldError(
              "The employer identity changed after preview.",
            );
          }
        }
        let nextSearchPreferences = current.searchPreferences;
        let nextCampaignState = current.campaignState;
        let employerExclusion =
          targetJob.discoveryFeedback?.employerExclusion ?? null;
        if (input.action === "hide_and_exclude_employer") {
          const activeCampaign = current.campaignState?.campaigns.find(
            (campaign) =>
              campaign.id === current.campaignState?.activeCampaignId,
          );
          const activePreferences =
            activeCampaign?.searchPreferences ?? current.searchPreferences;
          const preview = resolveEmployerExclusionPreview({
            job: targetJob,
            searchPreferences: {
              ...activePreferences,
              companyWhitelist: uniqueStrings([
                ...current.searchPreferences.companyWhitelist,
                ...activePreferences.companyWhitelist,
              ]),
            },
            companies: current.intelligenceState.companies,
          });
          if (preview.status !== "available") {
            throw new Error(
              `Employer exclusion is unavailable: ${preview.reason}.`,
            );
          }
          if (
            preview.normalizedCompanyName !==
            input.expectedNormalizedCompanyName
          ) {
            throw new Error(
              "The employer identity changed after preview. Review it again before excluding this employer.",
            );
          }
          const appended = appendExactEmployerExclusion(
            activePreferences.companyBlacklist,
            preview.displayCompanyName,
            preview.normalizedCompanyName,
          );
          nextSearchPreferences = {
            ...current.searchPreferences,
            companyBlacklist: appended.values,
          };
          employerExclusion = {
            normalizedCompanyName: preview.normalizedCompanyName,
            displayCompanyName: preview.displayCompanyName,
            addedByThisFeedback: appended.added,
            campaignId: activeCampaign?.id ?? null,
          };
          if (nextCampaignState !== null) {
            nextCampaignState = {
              ...nextCampaignState,
              campaigns: nextCampaignState.campaigns.map((campaign) =>
                campaign.id === nextCampaignState!.activeCampaignId
                  ? {
                      ...campaign,
                      searchPreferences: {
                        ...campaign.searchPreferences,
                        companyBlacklist: appended.values,
                      },
                    }
                  : campaign,
              ),
            };
          }
        }

        const priorStatus =
          targetJob.status === "archived"
            ? (targetJob.discoveryFeedback?.priorStatus ?? null)
            : current.jobIsPending
              ? null
              : targetJob.status;
        const nextJob = SavedJobSchema.parse({
          ...targetJob,
          status: "archived",
          discoveryFeedback: {
            version: 1,
            revision: (targetJob.discoveryFeedback?.revision ?? 0) + 1,
            reasons,
            recordedAt: occurredAt,
            priorStatus,
            employerExclusion,
          },
        });
        return {
          result: null,
          savedJob: nextJob,
          searchPreferences: nextSearchPreferences,
          campaignState: nextCampaignState,
          discoveryState: {
            ...current.discoveryState,
            discoveryLedger: markSavedJobStatusInLedger({
              ledger: current.discoveryState.discoveryLedger,
              job: nextJob,
              status: "skipped",
              occurredAt,
              skipReason: "Not interested: " + reasons.join(", ") + ".",
            }),
            pendingDiscoveryJobs:
              current.discoveryState.pendingDiscoveryJobs.filter(
                (job) => job.id !== input.jobId,
              ),
          },
        };
      },
    );
    await releaseFinishedApplicationPages({
      ...ctx,
      jobId: input.jobId,
      removed: true,
    });
  }

  async function restoreDismissedDiscoveryJobWithoutSnapshot(
    jobId: string,
    assertCurrent: () => void,
  ): Promise<void> {
    assertCurrent();
    const requestedAt = new Date().toISOString();
    await ctx.repository.commitDiscoveryFeedbackUpdate(jobId, (current) => {
      assertCurrent();
      const targetJob = current.job;
      if (
        !targetJob ||
        current.jobIsPending ||
        targetJob.status !== "archived"
      ) {
        throw new Error(
          "Unable to restore unknown hidden job '" + jobId + "'.",
        );
      }
      const recordedAt = targetJob.discoveryFeedback?.recordedAt ?? null;
      if (recordedAt && Date.parse(recordedAt) > Date.parse(requestedAt)) {
        throw new Error(
          "The hidden-job decision changed while it was being restored.",
        );
      }
      const feedbackPriorStatus =
        targetJob.discoveryFeedback?.priorStatus ?? null;
      const restoredJob = SavedJobSchema.parse({
        ...targetJob,
        status:
          feedbackPriorStatus && feedbackPriorStatus !== "archived"
            ? feedbackPriorStatus
            : "discovered",
        discoveryFeedback: null,
      });
      return {
        result: null,
        savedJob: restoredJob,
        searchPreferences: current.searchPreferences,
        campaignState: current.campaignState,
        discoveryState: {
          ...current.discoveryState,
          discoveryLedger: markSavedJobStatusInLedger({
            ledger: current.discoveryState.discoveryLedger,
            job: restoredJob,
            status: "seen",
            occurredAt: requestedAt,
            skipReason: null,
          }),
        },
      };
    });
  }

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
    async recordLiveAssistantApplicationAction(rawInput) {
      const input = JobFinderInterviewFollowUpInputSchema.parse(rawInput);
      const locatedRecords = await ctx.repository.listApplicationRecords();
      const locatedRecord = locatedRecords.find(
        (record) => record.id === input.applicationRecordId,
      );

      if (!locatedRecord) {
        throw new Error(
          `Unknown Job Finder application record '${input.applicationRecordId}'.`,
        );
      }

      await withExactApplicationRecordTransition(
        locatedRecord.id,
        locatedRecord.jobId,
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

          const now = new Date().toISOString();
          const note = input.note?.trim();
          const terminalStatuses = new Set([
            "offer",
            "rejected",
            "withdrawn",
            "archived",
          ]);
          const shouldMarkInterview =
            input.action === "mark_interviewed" &&
            !terminalStatuses.has(existingRecord.status);
          const nextStatus = shouldMarkInterview
            ? "interview"
            : existingRecord.status;
          const lastActionLabel =
            input.action === "mark_interviewed"
              ? "Interview completed"
              : "Interview follow-up note added";
          const eventTitle =
            input.action === "mark_interviewed"
              ? "Interview marked complete"
              : "Interview follow-up note added";
          const eventDetail =
            note && note.length > 0
              ? `Live Assistant session ${input.sessionId}: ${note}`
              : `Live Assistant session ${input.sessionId} was reviewed and linked to this application record.`;

          if (shouldMarkInterview) {
            const savedJobs = await ctx.repository.listSavedJobs();
            if (savedJobs.some((job) => job.id === existingRecord.jobId)) {
              await ctx.updateJob(existingRecord.jobId, (job) =>
                SavedJobSchema.parse({
                  ...job,
                  status: "interview",
                }),
              );
            }
          }

          const nextRecord = ApplicationRecordSchema.parse({
            ...existingRecord,
            status: nextStatus,
            lastActionLabel,
            nextActionLabel:
              input.action === "mark_interviewed"
                ? "Add a follow-up note or track the interview outcome."
                : existingRecord.nextActionLabel,
            lastUpdatedAt: now,
            events: mergeEvents(existingRecord.events, [
              {
                id: createUniqueId("event"),
                at: now,
                title: eventTitle,
                detail: eventDetail,
                emphasis:
                  input.action === "mark_interviewed" ? "positive" : "neutral",
              },
            ]),
          });

          await ctx.repository.upsertApplicationRecord(nextRecord);
        },
      );
      return ctx.getWorkspaceSnapshot();
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
    async setJobResumeApplicationMode(
      jobId,
      resumeApplicationMode,
      resumeTailoringMode,
    ) {
      await ctx.updateJob(jobId, (job) =>
        SavedJobSchema.parse({
          ...job,
          resumeApplicationMode,
          ...(resumeTailoringMode === undefined ? {} : { resumeTailoringMode }),
        }),
      );

      return ctx.getWorkspaceSnapshot();
    },
    async saveResumeBatchCheckpoint(checkpoint) {
      const generation = listingGeneration();
      const priorGeneration = resumeCheckpointEpochs.get(checkpoint.id);
      if (
        !listingReadCurrent(generation) ||
        (priorGeneration !== undefined && priorGeneration !== generation)
      )
        return;
      resumeCheckpointEpochs.set(checkpoint.id, generation);
      await ctx.withIntelligenceTransition(async () => {
        if (!listingReadCurrent(generation)) return;
        const current = await ctx.repository.getIntelligenceState();
        if (!listingReadCurrent(generation)) return;
        const merged = mergeResumeBatchCheckpoints(
          current.resumeBatchCheckpoints ??
            (current.resumeBatchCheckpoint
              ? [current.resumeBatchCheckpoint]
              : []),
          checkpoint,
        );
        await ctx.repository.saveIntelligenceState({
          ...current,
          resumeBatchCheckpoint: merged.checkpoint,
          resumeBatchCheckpoints: merged.checkpoints,
        });
      });
      if (listingReadCurrent(generation))
        markResumeBatchRunning(ctx.repository, checkpoint);
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
    async dismissDiscoveryJob(input) {
      await dismissDiscoveryJobWithoutSnapshot(input, feedbackFence());
      return ctx.getWorkspaceSnapshot();
    },
    async dismissDiscoveryJobs(inputs, options) {
      const byId = new Map(inputs.map((input) => [input.jobId, input]));
      return runFeedbackBatch(
        [...byId.keys()],
        "hidden",
        options,
        (jobId, fence) =>
          dismissDiscoveryJobWithoutSnapshot(byId.get(jobId)!, fence),
      );
    },
    async excludeEmployerDiscoveryJobs(input, options) {
      let excluded = false;
      const jobIds = [...new Set([input.jobId, ...input.jobIds])];
      return runFeedbackBatch(
        jobIds,
        "hidden",
        options,
        async (jobId, fence) => {
          if (jobId !== input.jobId && !excluded) {
            throw new FeedbackMutationHeldError(
              "The employer exclusion was not applied.",
            );
          }
          await dismissDiscoveryJobWithoutSnapshot(
            {
              jobId,
              reasons: ["company"],
              action:
                jobId === input.jobId
                  ? "hide_and_exclude_employer"
                  : "hide_job",
              expectedNormalizedCompanyName:
                input.expectedNormalizedCompanyName,
            },
            fence,
            input.expectedNormalizedCompanyName,
          );
          if (jobId === input.jobId) excluded = true;
        },
      );
    },
    async previewEmployerExclusion(jobId) {
      const [savedJobs, discoveryState, searchPreferences, intelligenceState] =
        await Promise.all([
          ctx.repository.listSavedJobsByIds([jobId]),
          ctx.repository.readDiscoveryDisplayProjection(),
          ctx.repository.getSearchPreferences(),
          ctx.repository.getIntelligenceState(),
        ]);
      const job =
        discoveryState.pendingDiscoveryJobs.find(
          (entry) => entry.id === jobId,
        ) ??
        savedJobs.find((entry) => entry.id === jobId) ??
        null;
      if (!job) {
        throw new Error(`Unable to preview an unknown job '${jobId}'.`);
      }
      return resolveEmployerExclusionPreview({
        job,
        searchPreferences,
        companies: intelligenceState.companies,
      });
    },
    async removeEmployerExclusion(input) {
      await ctx.repository.commitDiscoveryFeedbackUpdate(
        input.jobId,
        (current) => {
          if (!current.job || current.job.status !== "archived") {
            throw new Error(
              `Unable to change employer exclusion for unknown hidden job '${input.jobId}'.`,
            );
          }
          const reference = current.job.discoveryFeedback?.employerExclusion;
          if (
            !reference ||
            reference.normalizedCompanyName !== input.normalizedCompanyName
          ) {
            throw new Error("The saved employer exclusion reference is stale.");
          }
          const matchingCampaignIds =
            current.campaignState?.campaigns
              .filter((campaign) =>
                campaign.searchPreferences.companyBlacklist.some(
                  (value) =>
                    normalizeText(value.trim()) === input.normalizedCompanyName,
                ),
              )
              .map((campaign) => campaign.id) ?? [];
          const campaignId =
            reference.campaignId ??
            (matchingCampaignIds.length === 1 ? matchingCampaignIds[0]! : null);
          if (current.campaignState !== null && campaignId === null) {
            throw new Error(
              "The legacy employer exclusion cannot be tied to one campaign.",
            );
          }
          if (
            campaignId !== null &&
            !current.campaignState?.campaigns.some(
              (campaign) => campaign.id === campaignId,
            )
          ) {
            throw new Error("The saved employer exclusion campaign is stale.");
          }
          const updatesGlobalPreferences =
            current.campaignState === null ||
            current.campaignState.activeCampaignId === campaignId;
          const nextJob = SavedJobSchema.parse({
            ...current.job,
            discoveryFeedback: {
              ...current.job.discoveryFeedback,
              employerExclusion: null,
            },
          });
          return {
            result: null,
            savedJob: nextJob,
            searchPreferences: updatesGlobalPreferences
              ? {
                  ...current.searchPreferences,
                  companyBlacklist: removeExactEmployerExclusion(
                    current.searchPreferences.companyBlacklist,
                    input.normalizedCompanyName,
                  ),
                }
              : current.searchPreferences,
            campaignState:
              current.campaignState === null
                ? null
                : {
                    ...current.campaignState,
                    campaigns: current.campaignState.campaigns.map(
                      (campaign) =>
                        campaign.id === campaignId
                          ? {
                              ...campaign,
                              searchPreferences: {
                                ...campaign.searchPreferences,
                                companyBlacklist: removeExactEmployerExclusion(
                                  campaign.searchPreferences.companyBlacklist,
                                  input.normalizedCompanyName,
                                ),
                              },
                            }
                          : campaign,
                    ),
                  },
            discoveryState: current.discoveryState,
          };
        },
      );
      return ctx.getWorkspaceSnapshot();
    },
    async restoreDismissedDiscoveryJob(jobId) {
      await restoreDismissedDiscoveryJobWithoutSnapshot(jobId, feedbackFence());
      return ctx.getWorkspaceSnapshot();
    },
    async restoreDismissedDiscoveryJobs(jobIds, options) {
      return runFeedbackBatch(
        [...new Set(jobIds)],
        "restored",
        options,
        restoreDismissedDiscoveryJobWithoutSnapshot,
      );
    },
    async generateResume(jobId, options) {
      // A second "Create the resume" / "Try again" press while this job's
      // resume is still being written joins that run instead of queueing a
      // second full AI generation behind it.
      const inFlight = inFlightResumeGenerations.get(jobId);
      if (inFlight) {
        return inFlight;
      }
      // Full regeneration snapshots state up front and persists only after
      // the long AI/render pipeline; holding this job's transition tail
      // serializes those writes against saves, exports, approvals, and other
      // generation runs so neither side can race or clobber the other.
      const run = startResumeGeneration(jobId, options)
        .then(() => ctx.getWorkspaceSnapshot())
        .finally(() => {
          if (inFlightResumeGenerations.get(jobId) === run) {
            inFlightResumeGenerations.delete(jobId);
          }
        });
      inFlightResumeGenerations.set(jobId, run);
      return run;
    },
    async generateResumeForBatch(jobId, options) {
      try {
        return await startResumeGeneration(jobId, options, options.regenerate);
      } catch (error) {
        const providerBlock = getAiProviderAccessFailure(error);
        if (!providerBlock) throw error;
        return { jobId, outcome: "blocked", providerBlock };
      }
    },
    async getResumeWorkspace(jobId) {
      return buildResumeWorkspace(ctx, jobId);
    },
    async previewResumeDraft(draft, signal) {
      return previewResumeDraft(ctx, ResumeDraftSchema.parse(draft), signal);
    },
    async saveResumeDraft(draft) {
      const parsedDraft = ResumeDraftSchema.parse(draft);
      return withResumeDraftTransition(parsedDraft.jobId, async () => {
        const { job, profile, tailoredAsset, templates } =
          await ensureResumeDraft(ctx, parsedDraft.jobId);
        const currentDraft = await ctx.repository.getResumeDraftByJobId(
          parsedDraft.jobId,
        );
        if (!currentDraft) {
          throw new Error(`Unable to find resume draft '${parsedDraft.id}'.`);
        }
        const parsedStateHash = buildResumeDraftStateHash(parsedDraft);
        const currentStateHash = buildResumeDraftStateHash(currentDraft);
        if (
          parsedDraft.updatedAt !== currentDraft.updatedAt &&
          parsedStateHash !== currentStateHash
        ) {
          throw new Error(
            "Resume draft changed before this edit could be saved. Reload the workspace and try again.",
          );
        }
        const now = createMonotonicTimestamp(currentDraft.updatedAt);
        const hadApprovedExport = wasResumeDraftApproved(currentDraft);
        // Acknowledgments are server-owned: the dedicated work-history review
        // command is the only writer, so an ordinary save can never inject,
        // drop, or rewrite them to bypass the review gates.
        const nextDraft = ResumeDraftSchema.parse({
          ...parsedDraft,
          workHistoryReviewAcknowledgments:
            currentDraft.workHistoryReviewAcknowledgments,
          // Same for claim confirmations and issue approvals: the editor's copy
          // of the draft can predate an approval made moments earlier, and a
          // save that wrote the stale lists back silently revived blockers the
          // person had already cleared.
          claimConfirmations: currentDraft.claimConfirmations,
          issueApprovals: currentDraft.issueApprovals,
          status: hadApprovedExport ? "stale" : "needs_review",
          approvedAt: null,
          approvedExportId: null,
          staleReason: hadApprovedExport
            ? "Draft changed after approval and needs a fresh review."
            : null,
          updatedAt: now,
        });
        const languageChanged =
          (parsedDraft.language ?? null) !== (currentDraft.language ?? null);
        const editedDraft = languageChanged
          ? await writeResumeLanguage({
              aiClient: ctx.aiClient,
              draft: nextDraft,
              job,
            })
          : nextDraft;
        const sanitizedDraft = await sanitizeAndCheckResumeDraft(ctx, {
          draft: editedDraft,
          job,
          profile,
        });
        const validation = validateResumeDraft({
          draft: sanitizedDraft,
          job,
          profile,
          validatedAt: now,
        });
        const previousValidation =
          (
            await ctx.repository.listResumeValidationResults(sanitizedDraft.id)
          )[0] ?? null;
        const validationWithReviewGuidance = preserveWorkHistoryReviewGuidance({
          validation,
          previousValidation,
          draft: sanitizedDraft,
        });
        const nextAsset = buildTailoredAssetBridge({
          draft: sanitizedDraft,
          job,
          profile,
          existingAsset: tailoredAsset,
          storagePath: tailoredAsset?.storagePath ?? null,
          templates,
        });

        if (currentStateHash !== buildResumeDraftStateHash(sanitizedDraft)) {
          const revision = buildResumeDraftRevision({
            draft: currentDraft,
            resultingDraft: sanitizedDraft,
            createdAt: now,
            parentRevisionId: await getLatestResumeRevisionId(
              ctx,
              currentDraft.id,
            ),
            actor: "user",
            mutationKind: "manual_save",
            reason:
              currentDraft.templateId !== sanitizedDraft.templateId
                ? "Changed resume template"
                : "Saved resume draft edits",
          });
          await ctx.repository.applyResumePatchWithRevision({
            expectedDraftUpdatedAt: currentDraft.updatedAt,
            draft: sanitizedDraft,
            revision,
            validation: validationWithReviewGuidance,
            tailoredAsset: nextAsset,
          });
        } else {
          await ctx.repository.saveResumeDraftWithValidation({
            draft: sanitizedDraft,
            validation: validationWithReviewGuidance,
            tailoredAsset: nextAsset,
          });
        }

        return ctx.getWorkspaceSnapshot();
      });
    },
    async restoreResumeDraftRevision(jobId, revisionId) {
      const state = await ensureResumeDraft(ctx, jobId);
      const revisions = await ctx.repository.listResumeDraftRevisions(
        state.draft.id,
      );
      const targetRevision = revisions.find(
        (revision) => revision.id === revisionId,
      );
      if (!targetRevision) {
        throw new Error(`Unknown resume revision '${revisionId}'.`);
      }
      if (!targetRevision.snapshotDraft) {
        throw new Error(
          "This legacy resume revision cannot be restored because it does not contain a complete draft snapshot.",
        );
      }
      if (
        targetRevision.draftId !== state.draft.id ||
        targetRevision.snapshotDraft.id !== state.draft.id ||
        targetRevision.snapshotDraft.jobId !== jobId
      ) {
        throw new Error("Resume revision does not belong to this job draft.");
      }

      const restoredAt = createMonotonicTimestamp(state.draft.updatedAt);
      // The persisted draft is always the exact sanitized result of the target
      // snapshot re-grounded against current profile evidence, never the raw
      // pre-sanitize target snapshot bytes: sanitization here is what keeps the
      // restored current draft, its validation, and the revision afterHash
      // describing identical content.
      const restoredDraft = await sanitizeAndCheckResumeDraft(ctx, {
        draft: ResumeDraftSchema.parse({
          ...targetRevision.snapshotDraft,
          id: state.draft.id,
          jobId,
          status: "needs_review",
          approvedAt: null,
          approvedExportId: null,
          staleReason: "Restored from resume history and needs a fresh review.",
          createdAt: state.draft.createdAt,
          updatedAt: restoredAt,
        }),
        job: state.job,
        profile: state.profile,
      });
      if (
        buildResumeDraftStateHash(restoredDraft) ===
        buildResumeDraftStateHash(state.draft)
      ) {
        return ctx.getWorkspaceSnapshot();
      }

      const validation = validateResumeDraft({
        draft: restoredDraft,
        job: state.job,
        profile: state.profile,
        validatedAt: restoredAt,
      });
      const previousValidation =
        (await ctx.repository.listResumeValidationResults(state.draft.id))[0] ??
        null;
      const validationWithReviewGuidance = preserveWorkHistoryReviewGuidance({
        validation,
        previousValidation,
        draft: restoredDraft,
      });
      const nextAsset = buildTailoredAssetBridge({
        draft: restoredDraft,
        job: state.job,
        profile: state.profile,
        existingAsset: state.tailoredAsset,
        clearStoragePath: true,
        templates: state.templates,
      });
      const restoreRevision = buildResumeDraftRevision({
        // Versioning convention: the revision snapshots the exact pre-restore
        // persisted draft so undo history stays complete, while afterHash and
        // the persisted draft both describe the same sanitized restoredDraft.
        draft: state.draft,
        resultingDraft: restoredDraft,
        createdAt: restoredAt,
        parentRevisionId: revisions[0]?.id ?? null,
        actor: "restore",
        mutationKind: "restore",
        restoredFromRevisionId: targetRevision.id,
        reason: `Restored resume revision from ${targetRevision.createdAt}`,
      });

      await ctx.repository.applyResumePatchWithRevision({
        expectedDraftUpdatedAt: state.draft.updatedAt,
        draft: restoredDraft,
        revision: restoreRevision,
        validation: validationWithReviewGuidance,
        tailoredAsset: nextAsset,
      });

      return ctx.getWorkspaceSnapshot();
    },
    async undoResumeAssistantEdit(jobId, revisionId) {
      const state = await ensureResumeDraft(ctx, jobId);
      const revisions = await ctx.repository.listResumeDraftRevisions(
        state.draft.id,
      );
      const targetRevision = revisions.find(
        (revision) => revision.id === revisionId,
      );
      if (
        !targetRevision ||
        targetRevision.mutationKind !== "assistant_patch"
      ) {
        throw new Error("That AI edit is no longer in this resume's history.");
      }
      if (
        targetRevision.draftId !== state.draft.id ||
        !targetRevision.snapshotDraft ||
        targetRevision.snapshotDraft.id !== state.draft.id ||
        targetRevision.snapshotDraft.jobId !== jobId
      ) {
        throw new Error("That AI edit does not belong to this resume.");
      }
      const draftAfterEdit = findDraftAfterRevision({
        revision: targetRevision,
        revisions,
        currentDraft: state.draft,
      });
      if (!draftAfterEdit) {
        throw new Error(
          "This AI edit cannot be undone on its own because a later history entry is incomplete. Use Version history to restore an earlier draft.",
        );
      }

      const undoneAt = createMonotonicTimestamp(state.draft.updatedAt);
      const undoneDraft = await sanitizeAndCheckResumeDraft(ctx, {
        draft: ResumeDraftSchema.parse({
          ...buildDraftWithoutAssistantEdit({
            before: targetRevision.snapshotDraft,
            after: draftAfterEdit,
            current: state.draft,
          }),
          status: "needs_review",
          approvedAt: null,
          approvedExportId: null,
          staleReason:
            "An AI edit was undone and the resume needs a fresh review.",
          updatedAt: undoneAt,
        }),
        job: state.job,
        profile: state.profile,
      });
      if (
        buildResumeDraftStateHash(undoneDraft) ===
        buildResumeDraftStateHash(state.draft)
      ) {
        return ctx.getWorkspaceSnapshot();
      }

      const validation = validateResumeDraft({
        draft: undoneDraft,
        job: state.job,
        profile: state.profile,
        validatedAt: undoneAt,
      });
      const previousValidation =
        (await ctx.repository.listResumeValidationResults(state.draft.id))[0] ??
        null;
      const validationWithReviewGuidance = preserveWorkHistoryReviewGuidance({
        validation,
        previousValidation,
        draft: undoneDraft,
      });
      const nextAsset = buildTailoredAssetBridge({
        draft: undoneDraft,
        job: state.job,
        profile: state.profile,
        existingAsset: state.tailoredAsset,
        clearStoragePath: true,
        templates: state.templates,
      });
      const undoRevision = buildResumeDraftRevision({
        draft: state.draft,
        resultingDraft: undoneDraft,
        createdAt: undoneAt,
        parentRevisionId: revisions[0]?.id ?? null,
        actor: "restore",
        mutationKind: "restore",
        restoredFromRevisionId: targetRevision.id,
        reason: "Undid AI edit; later edits kept",
      });

      await ctx.repository.applyResumePatchWithRevision({
        expectedDraftUpdatedAt: state.draft.updatedAt,
        draft: undoneDraft,
        revision: undoRevision,
        validation: validationWithReviewGuidance,
        tailoredAsset: nextAsset,
      });

      return ctx.getWorkspaceSnapshot();
    },
    async regenerateResumeDraft(jobId, options) {
      await startResumeGeneration(jobId, options, true);
      return ctx.getWorkspaceSnapshot();
    },
    async regenerateResumeSection(jobId, sectionId) {
      // Section proposals bind baseDraftUpdatedAt to the draft version they
      // were generated from; joining the same per-job transition tail keeps a
      // concurrent save from changing that version mid-regeneration.
      return withResumeDraftTransition(jobId, async () =>
        runRegenerateResumeSection(jobId, sectionId),
      );
    },
    async exportResumePdf(jobId, outputPath) {
      return withResumeDraftTransition(jobId, async () => {
        const {
          draft,
          job,
          profile,
          profileRevision,
          settings,
          tailoredAsset,
          templates,
        } = await ensureResumeDraft(ctx, jobId);
        // The persisted draft is the single render input: validation, content
        // hash binding, PDF rendering, and approval all describe this exact
        // draft. Persisted drafts are saved sanitized, so sanitization must be
        // content-neutral here; otherwise grounding drifted after the last
        // save and exporting would bind claims the PDF does not contain.
        const exportDraft = await sanitizeAndCheckResumeDraft(ctx, {
          draft,
          job,
          profile,
        });
        if (
          buildResumeDraftContentHash(exportDraft) !==
          buildResumeDraftContentHash(draft)
        ) {
          throw new Error(
            "This saved resume draft no longer matches its grounded, sanitized content because candidate evidence changed after the last save. Review and save the draft before exporting.",
          );
        }
        const preExportValidation = validateResumeDraft({
          draft: exportDraft,
          job,
          profile,
        });
        if (
          hasBlockingResumeClaimAssessment({
            validation: preExportValidation,
            draft: exportDraft,
          })
        ) {
          const previousValidation =
            (await ctx.repository.listResumeValidationResults(draft.id))[0] ??
            null;
          const visibleValidation = preserveWorkHistoryReviewGuidance({
            validation: preExportValidation,
            previousValidation,
            draft: exportDraft,
          });
          await assertResumeDraftCurrent(draft);
          await assertCurrentResumeProfile(
            ctx,
            profileRevision,
            "saving export validation",
          );
          await ctx.repository.saveResumeDraftWithValidation({
            draft: exportDraft,
            validation: visibleValidation,
            tailoredAsset,
          });
          throw new Error(
            "Some lines in this resume still need your decision before it can be exported. Open the resume: they are listed under Lines to confirm.",
          );
        }
        await assertCurrentResumeProfile(
          ctx,
          profileRevision,
          "rendering this resume export",
        );
        const renderedArtifact = await renderDraftToPdf(ctx, {
          job,
          profile,
          settings,
          draft: exportDraft,
          outputPath: outputPath ?? null,
        });

        await assertCurrentResumeProfile(
          ctx,
          profileRevision,
          "completing this resume export",
        );

        if (!renderedArtifact.storagePath) {
          throw new Error(
            `Resume export failed for '${job.title}' at '${job.company}'.`,
          );
        }

        const exportedAt = new Date().toISOString();
        const exportArtifact = buildResumeExportArtifact({
          draft: exportDraft,
          job,
          filePath: renderedArtifact.storagePath,
          format: renderedArtifact.format,
          sha256: renderedArtifact.sha256 ?? null,
          pageCount: renderedArtifact.pageCount ?? null,
          exportedAt,
        });
        const validation = validateResumeDraft({
          draft: exportDraft,
          job,
          profile,
          pageCount: renderedArtifact.pageCount ?? null,
          validatedAt: exportedAt,
        });
        const previousValidation =
          (await ctx.repository.listResumeValidationResults(draft.id))[0] ??
          null;
        const validationWithReviewGuidance = preserveWorkHistoryReviewGuidance({
          validation,
          previousValidation,
          draft: exportDraft,
        });
        // Any export of an approved draft (Download PDF) is the same content
        // in another file. The job's resume stays the approved file;
        // re-pointing it at the new export made Shortlisted say the approved
        // resume no longer matched and ask for a review of an unchanged resume.
        const keepsApprovedFile = Boolean(
          exportDraft.approvedExportId && tailoredAsset?.storagePath,
        );
        const nextAsset = buildTailoredAssetBridge({
          draft: exportDraft,
          job,
          profile,
          existingAsset: tailoredAsset,
          storagePath: keepsApprovedFile
            ? (tailoredAsset?.storagePath ?? null)
            : renderedArtifact.storagePath,
          pageCount: renderedArtifact.pageCount ?? null,
          templates,
          notes: uniqueStrings([
            ...(renderedArtifact.fileName
              ? [`Generated PDF resume artifact ${renderedArtifact.fileName}.`]
              : []),
            ...(renderedArtifact.intermediateFileName
              ? [
                  `Saved HTML debug render ${renderedArtifact.intermediateFileName}.`,
                ]
              : []),
            ...(renderedArtifact.warnings ?? []),
          ]),
        });

        await assertResumeDraftCurrent(draft);
        await assertCurrentResumeProfile(
          ctx,
          profileRevision,
          "saving this resume export",
        );
        await ctx.repository.upsertResumeExportArtifact(exportArtifact);
        await assertResumeDraftCurrent(draft);
        await assertCurrentResumeProfile(
          ctx,
          profileRevision,
          "saving this exported resume draft",
        );
        await ctx.repository.saveResumeDraftWithValidation({
          draft: exportDraft,
          validation: validationWithReviewGuidance,
          tailoredAsset: nextAsset,
        });

        return ctx.getWorkspaceSnapshot();
      });
    },
    async approveResume(jobId, exportId) {
      return withResumeDraftTransition(jobId, async () => {
        const {
          draft,
          job,
          profile,
          profileRevision,
          tailoredAsset,
          templates,
        } = await ensureResumeDraft(ctx, jobId);
        const [exports, validations] = await Promise.all([
          ctx.repository.listResumeExportArtifacts({ jobId }),
          ctx.repository.listResumeValidationResults(draft.id),
        ]);
        const targetExport = exports.find(
          (artifact) => artifact.id === exportId,
        );
        const latestValidation = validations[0] ?? null;

        if (!targetExport) {
          throw new Error(
            `Unable to approve unknown resume export '${exportId}'.`,
          );
        }

        if (targetExport.draftId !== draft.id) {
          throw new Error(
            `Resume export '${exportId}' does not belong to the current draft and cannot be approved.`,
          );
        }

        if (
          new Date(targetExport.exportedAt).getTime() <
          new Date(draft.updatedAt).getTime()
        ) {
          throw new Error(
            `Resume export '${exportId}' is older than the current draft and cannot be approved. Export a fresh PDF first.`,
          );
        }

        if (
          !latestValidation ||
          latestValidation.draftContentHash !==
            buildResumeDraftContentHash(draft)
        ) {
          throw new Error(
            `Resume export '${exportId}' does not have a current claim-grounding assessment. Export a fresh PDF before approval.`,
          );
        }

        if (
          hasBlockingResumeClaimAssessment({
            validation: latestValidation,
            draft,
          })
        ) {
          throw new Error(
            "Some lines in this resume still need your decision before it can be approved. They are listed under Lines to confirm.",
          );
        }

        if (latestValidation.issues.some(isBlockingResumeValidationIssue)) {
          throw new Error(
            `Resume export '${exportId}' still has blocking validation errors and cannot be approved yet.`,
          );
        }

        // Hidden roles are the person's choice, not a blocker: a role left
        // hidden is simply off this resume. The studio still lists them so
        // any can be added back.

        const template =
          templates.find((entry) => entry.id === draft.templateId) ?? null;

        if (!template || !isResumeTemplateApprovalEligible(template)) {
          throw new Error(
            `Resume export '${exportId}' uses a share-ready template and cannot be approved for apply-safe flows. Choose an apply-safe template and export a fresh PDF instead.`,
          );
        }

        if (
          ctx.exportFileVerifier &&
          !(await ctx.exportFileVerifier.exists(targetExport.filePath))
        ) {
          throw new Error(
            `Resume export '${exportId}' is missing on disk and cannot be approved. Export a fresh file first.`,
          );
        }
        const verifiedSha256 = await verifyResumeFileIntegrity({
          expectedSha256: targetExport.sha256,
          filePath: targetExport.filePath,
          label: "The resume export",
        });

        const approvedAt = new Date().toISOString();
        const approvedDraft = ResumeDraftSchema.parse({
          ...draft,
          status: "approved",
          approvedAt,
          approvedExportId: targetExport.id,
          staleReason: null,
          updatedAt: approvedAt,
        });
        const nextAsset = buildTailoredAssetBridge({
          draft: approvedDraft,
          job,
          profile,
          existingAsset: tailoredAsset,
          storagePath: targetExport.filePath,
          pageCount: targetExport.pageCount,
          templates,
        });

        await assertResumeDraftCurrent(draft);
        await assertCurrentResumeProfile(
          ctx,
          profileRevision,
          "approving this resume export",
        );
        await ctx.repository.approveResumeExport({
          draft: approvedDraft,
          exportArtifact: {
            ...targetExport,
            sha256: verifiedSha256,
            isApproved: true,
          },
          validation: latestValidation,
          tailoredAsset: nextAsset,
        });

        await clearStaleMissingResumeBlockerForJob(jobId);

        return ctx.getWorkspaceSnapshot();
      });
    },
    async clearResumeApproval(jobId) {
      return withResumeDraftTransition(jobId, async () => {
        const { draft, job, profile, tailoredAsset, templates } =
          await ensureResumeDraft(ctx, jobId);
        const nextDraft = ResumeDraftSchema.parse({
          ...draft,
          status: "stale",
          approvedAt: null,
          approvedExportId: null,
          staleReason: "Resume approval was cleared and needs a fresh review.",
          updatedAt: new Date().toISOString(),
        });
        const nextAsset = buildTailoredAssetBridge({
          draft: nextDraft,
          job,
          profile,
          existingAsset: tailoredAsset,
          clearStoragePath: true,
          templates,
        });

        await assertResumeDraftCurrent(draft);
        await ctx.repository.clearResumeApproval({
          draft: nextDraft,
          staleReason: nextDraft.staleReason ?? "Resume approval cleared.",
          tailoredAsset: nextAsset,
        });

        return ctx.getWorkspaceSnapshot();
      });
    },
    async setWorkHistoryReviewAcknowledgment(input) {
      const parsedInput =
        JobFinderSetWorkHistoryReviewAcknowledgmentInputSchema.parse(input);
      return withResumeDraftTransition(parsedInput.jobId, async () => {
        const currentDraft = await ctx.repository.getResumeDraftByJobId(
          parsedInput.jobId,
        );

        if (!currentDraft || currentDraft.id !== parsedInput.draftId) {
          throw new Error(
            `Unable to find resume draft '${parsedInput.draftId}' for job '${parsedInput.jobId}'.`,
          );
        }
        if (currentDraft.updatedAt !== parsedInput.expectedDraftUpdatedAt) {
          throw new Error(
            "Resume draft changed before this work-history decision could be saved. Reload the workspace and try again.",
          );
        }

        if (parsedInput.intent === "remove") {
          const existing = currentDraft.workHistoryReviewAcknowledgments.find(
            (acknowledgment) =>
              acknowledgment.id === parsedInput.acknowledgmentId,
          );
          if (!existing || existing.draftId !== currentDraft.id) {
            throw new Error(
              `Unable to find work-history review acknowledgment '${parsedInput.acknowledgmentId}' on draft '${currentDraft.id}'.`,
            );
          }

          return persistWorkHistoryReviewAcknowledgmentMutation({
            jobId: parsedInput.jobId,
            currentDraft,
            mutatedAt: createMonotonicTimestamp(currentDraft.updatedAt),
            reason: `Removed work-history review acknowledgment for '${existing.profileRecordId}'.`,
            nextAcknowledgments:
              currentDraft.workHistoryReviewAcknowledgments.filter(
                (acknowledgment) =>
                  acknowledgment.id !== parsedInput.acknowledgmentId,
              ),
          });
        }

        const state = await ensureResumeDraft(ctx, parsedInput.jobId);
        const previousValidation =
          (
            await ctx.repository.listResumeValidationResults(currentDraft.id)
          )[0] ?? null;
        const projectedSuggestions =
          buildWorkHistoryReviewSuggestionsFromValidation({
            draft: currentDraft,
            validation: preserveWorkHistoryReviewGuidance({
              validation: validateResumeDraft({
                draft: currentDraft,
                job: state.job,
                profile: state.profile,
              }),
              previousValidation,
              draft: currentDraft,
            }),
          });
        const suggestion =
          projectedSuggestions.find(
            (candidate) => candidate.id === parsedInput.suggestionId,
          ) ?? null;

        if (!suggestion) {
          throw new Error(
            `Work-history review suggestion '${parsedInput.suggestionId}' is no longer projected for this draft. Reload the workspace and try again.`,
          );
        }
        if (!isWorkHistoryOmissionReviewSuggestion(suggestion)) {
          throw new Error(
            "Only hidden-role weak_fit or gap_coverage suggestions can be acknowledged as intentional omissions.",
          );
        }
        if (suggestion.profileRecordId !== parsedInput.profileRecordId) {
          throw new Error(
            `Work-history review suggestion '${parsedInput.suggestionId}' no longer matches profile record '${parsedInput.profileRecordId}'. Reload the workspace and try again.`,
          );
        }
        if (
          suggestion.kind !== parsedInput.kind ||
          suggestion.action !== parsedInput.action
        ) {
          throw new Error(
            `Work-history review suggestion '${parsedInput.suggestionId}' changed kind or action since it was reviewed. Reload the workspace and try again.`,
          );
        }
        if (suggestion.messageContentHash !== parsedInput.messageContentHash) {
          throw new Error(
            "The work-history guidance text changed since it was reviewed. Reload the workspace and acknowledge the current wording.",
          );
        }

        const identicalAcknowledgment = matchWorkHistoryReviewAcknowledgment({
          draftId: currentDraft.id,
          suggestion,
          acknowledgments: currentDraft.workHistoryReviewAcknowledgments,
        });
        if (identicalAcknowledgment) {
          // Deterministic dedupe: the same suggestion identity is already
          // acknowledged, so this command is a no-op instead of a second record.
          return ctx.getWorkspaceSnapshot();
        }

        const mutatedAt = createMonotonicTimestamp(currentDraft.updatedAt);

        return persistWorkHistoryReviewAcknowledgmentMutation({
          jobId: parsedInput.jobId,
          currentDraft,
          mutatedAt,
          reason: `Acknowledged intentional omission of '${suggestion.profileRecordId}'.`,
          nextAcknowledgments: [
            ...currentDraft.workHistoryReviewAcknowledgments,
            WorkHistoryReviewAcknowledgmentSchema.parse({
              id: createUniqueId(
                `work_history_ack_${suggestion.profileRecordId}`,
              ),
              draftId: currentDraft.id,
              profileRecordId: suggestion.profileRecordId,
              kind: suggestion.kind,
              action: suggestion.action,
              messageContentHash: suggestion.messageContentHash,
              reason: "intentional_omission",
              acknowledgedAt: mutatedAt,
            }),
          ],
        });
      });
    },
    async setResumeClaimConfirmation(rawInput) {
      const parsedInput =
        JobFinderSetResumeClaimConfirmationInputSchema.parse(rawInput);
      return withResumeDraftTransition(parsedInput.jobId, async () => {
        // Draft identity and revision must match the caller's projection, the
        // same optimistic-concurrency contract as every other draft command.
        const currentDraft = await ctx.repository.getResumeDraftByJobId(
          parsedInput.jobId,
        );

        if (!currentDraft || currentDraft.id !== parsedInput.draftId) {
          throw new Error(
            `Unable to find resume draft '${parsedInput.draftId}' for job '${parsedInput.jobId}'.`,
          );
        }
        if (currentDraft.updatedAt !== parsedInput.expectedDraftUpdatedAt) {
          throw new Error(
            "Resume draft changed before this claim confirmation could be saved. Reload the workspace and try again.",
          );
        }

        if (parsedInput.intent === "remove") {
          const existing = currentDraft.claimConfirmations.find(
            (confirmation) => confirmation.id === parsedInput.confirmationId,
          );
          if (!existing || existing.draftId !== currentDraft.id) {
            throw new Error(
              `Unable to find resume claim confirmation '${parsedInput.confirmationId}' on draft '${currentDraft.id}'.`,
            );
          }

          return persistResumeClaimConfirmationMutation({
            jobId: parsedInput.jobId,
            currentDraft,
            mutatedAt: createMonotonicTimestamp(currentDraft.updatedAt),
            reason: `Removed claim confirmation for '${existing.sectionId}'.`,
            nextConfirmations: currentDraft.claimConfirmations.filter(
              (confirmation) => confirmation.id !== parsedInput.confirmationId,
            ),
          });
        }

        // Re-run current v2 validation instead of trusting a stored result:
        // only an exact confirm_needed assessment of the current draft can be
        // confirmed, so stale projections, hard unsupported claims, and rows
        // that need no confirmation all fail closed here.
        const state = await ensureResumeDraft(ctx, parsedInput.jobId);
        const previousValidation =
          (
            await ctx.repository.listResumeValidationResults(currentDraft.id)
          )[0] ?? null;
        if (parsedInput.intent === "approve_issue") {
          const latestValidation =
            (
              await ctx.repository.listResumeValidationResults(currentDraft.id)
            )[0] ?? null;
          const issue =
            latestValidation?.issues.find(
              (candidate) => candidate.id === parsedInput.issueId,
            ) ?? null;
          if (
            !issue ||
            buildResumeIssueApprovalContentHash(issue) !==
              parsedInput.approvedContentHash
          ) {
            throw new Error(
              "This note no longer matches the saved draft. Reload the workspace and try again.",
            );
          }
          // The same line can carry a note (a number the evidence does not
          // show) and a claim check. One "Approve as accurate" settles both:
          // approving only the note left "Review 1 line" with no control.
          const sameLineClaims = (
            latestValidation?.claimAssessments ?? []
          ).filter(
            (assessment) =>
              issue.sectionId !== null &&
              assessment.sectionId === issue.sectionId &&
              (assessment.entryId ?? null) === (issue.entryId ?? null) &&
              (assessment.bulletId ?? null) === (issue.bulletId ?? null) &&
              isCurrentResumeClaimVerifier(assessment.verifier) &&
              isResumeClaimAssessmentApprovable(assessment) &&
              isBlockingResumeClaimAssessment({
                assessment,
                draft: currentDraft,
              }),
          );
          if (
            matchResumeIssueApproval({ issue, draft: currentDraft }) &&
            sameLineClaims.length === 0
          ) {
            return ctx.getWorkspaceSnapshot();
          }
          const mutatedAt = createMonotonicTimestamp(currentDraft.updatedAt);
          return persistResumeClaimConfirmationMutation({
            jobId: parsedInput.jobId,
            currentDraft,
            mutatedAt,
            reason: "Approved a flagged line as accurate.",
            nextConfirmations: [
              ...currentDraft.claimConfirmations,
              ...sameLineClaims.map((assessment) =>
                ResumeClaimConfirmationSchema.parse({
                  id: createUniqueId(
                    `claim_confirmation_${assessment.sectionId}`,
                  ),
                  draftId: currentDraft.id,
                  field: assessment.field,
                  sectionId: assessment.sectionId,
                  entryId: assessment.entryId,
                  bulletId: assessment.bulletId,
                  confirmedClaimContentHash: assessment.contentHash,
                  ownershipStatement: resumeClaimOwnershipStatement,
                  confirmedAt: mutatedAt,
                }),
              ),
            ],
            nextIssueApprovals: matchResumeIssueApproval({
              issue,
              draft: currentDraft,
            })
              ? currentDraft.issueApprovals
              : [
                  ...currentDraft.issueApprovals,
                  ResumeIssueApprovalSchema.parse({
                    id: createUniqueId("issue_approval"),
                    draftId: currentDraft.id,
                    issueId: issue.id,
                    approvedContentHash: parsedInput.approvedContentHash,
                    approvedAt: mutatedAt,
                  }),
                ],
          });
        }
        if (parsedInput.intent === "remove_issue_approval") {
          const existing = currentDraft.issueApprovals.find(
            (approval) => approval.id === parsedInput.approvalId,
          );
          if (!existing) {
            return ctx.getWorkspaceSnapshot();
          }
          const mutatedAt = createMonotonicTimestamp(currentDraft.updatedAt);
          return persistResumeClaimConfirmationMutation({
            jobId: parsedInput.jobId,
            currentDraft,
            mutatedAt,
            reason: "Withdrew an approval of a flagged line.",
            nextConfirmations: currentDraft.claimConfirmations,
            nextIssueApprovals: currentDraft.issueApprovals.filter(
              (approval) => approval.id !== existing.id,
            ),
          });
        }
        const freshValidation = preserveWorkHistoryReviewGuidance({
          validation: validateResumeDraft({
            draft: currentDraft,
            job: state.job,
            profile: state.profile,
          }),
          previousValidation,
          draft: currentDraft,
        });
        const resolveConfirmNeededAssessment = (target: {
          field: (typeof currentDraft.claimConfirmations)[number]["field"];
          sectionId: string;
          entryId: string | null;
          bulletId: string | null;
          confirmedClaimContentHash: string;
        }) => {
          const assessment =
            freshValidation.claimAssessments.find(
              (candidate) =>
                candidate.field === target.field &&
                candidate.sectionId === target.sectionId &&
                candidate.entryId === target.entryId &&
                candidate.bulletId === target.bulletId &&
                candidate.contentHash === target.confirmedClaimContentHash,
            ) ?? null;

          if (!assessment) {
            throw new Error(
              "This claim is no longer projected for the current draft or its wording changed since it was reviewed. Reload the workspace and confirm the current claim text.",
            );
          }
          if (!isCurrentResumeClaimVerifier(assessment.verifier)) {
            throw new Error(
              "This claim assessment predates the current verifier and must be revalidated before it can be confirmed.",
            );
          }
          if (!isResumeClaimAssessmentApprovable(assessment)) {
            throw new Error(
              "This claim does not currently need explicit confirmation.",
            );
          }
          return assessment;
        };
        const findIdenticalConfirmation = (
          assessment: ReturnType<typeof resolveConfirmNeededAssessment>,
        ) =>
          currentDraft.claimConfirmations.find(
            (confirmation) =>
              confirmation.draftId === currentDraft.id &&
              confirmation.field === assessment.field &&
              confirmation.sectionId === assessment.sectionId &&
              confirmation.entryId === assessment.entryId &&
              confirmation.bulletId === assessment.bulletId &&
              confirmation.confirmedClaimContentHash === assessment.contentHash,
          ) ?? null;

        if (parsedInput.intent === "add_many") {
          const assessments = parsedInput.targets.map((target) =>
            resolveConfirmNeededAssessment(target),
          );
          const unsupportedBulkTarget = assessments.find(
            (assessment) =>
              !isResumeSkillClaimAssessment(currentDraft, assessment),
          );
          if (unsupportedBulkTarget) {
            throw new Error(
              "Bulk confirmation is only for skills the job asked for. Confirm wording stretches one at a time.",
            );
          }

          const newAssessments = assessments.filter(
            (assessment) => findIdenticalConfirmation(assessment) === null,
          );
          if (newAssessments.length === 0) {
            return ctx.getWorkspaceSnapshot();
          }

          const mutatedAt = createMonotonicTimestamp(currentDraft.updatedAt);
          return persistResumeClaimConfirmationMutation({
            jobId: parsedInput.jobId,
            currentDraft,
            mutatedAt,
            reason: `Confirmed ${newAssessments.length} job-asked ${newAssessments.length === 1 ? "skill" : "skills"}.`,
            nextConfirmations: [
              ...currentDraft.claimConfirmations,
              ...newAssessments.map((assessment) =>
                ResumeClaimConfirmationSchema.parse({
                  id: createUniqueId(
                    `claim_confirmation_${assessment.sectionId}`,
                  ),
                  draftId: currentDraft.id,
                  field: assessment.field,
                  sectionId: assessment.sectionId,
                  entryId: assessment.entryId,
                  bulletId: assessment.bulletId,
                  confirmedClaimContentHash: assessment.contentHash,
                  ownershipStatement: parsedInput.ownershipStatement,
                  confirmedAt: mutatedAt,
                }),
              ),
            ],
          });
        }

        const assessment = resolveConfirmNeededAssessment({
          field: parsedInput.field,
          sectionId: parsedInput.sectionId,
          entryId: parsedInput.entryId,
          bulletId: parsedInput.bulletId,
          confirmedClaimContentHash: parsedInput.confirmedClaimContentHash,
        });
        const identicalConfirmation = findIdenticalConfirmation(assessment);
        if (identicalConfirmation) {
          // Deterministic dedupe: the exact locator and normalized content
          // hash are already confirmed, so this command is a no-op instead of
          // a second record.
          return ctx.getWorkspaceSnapshot();
        }

        const mutatedAt = createMonotonicTimestamp(currentDraft.updatedAt);

        return persistResumeClaimConfirmationMutation({
          jobId: parsedInput.jobId,
          currentDraft,
          mutatedAt,
          reason: `Confirmed ${assessment.field} ownership for section '${assessment.sectionId}'.`,
          nextConfirmations: [
            ...currentDraft.claimConfirmations,
            ResumeClaimConfirmationSchema.parse({
              id: createUniqueId(`claim_confirmation_${assessment.sectionId}`),
              draftId: currentDraft.id,
              field: assessment.field,
              sectionId: assessment.sectionId,
              entryId: assessment.entryId,
              bulletId: assessment.bulletId,
              confirmedClaimContentHash: parsedInput.confirmedClaimContentHash,
              ownershipStatement: parsedInput.ownershipStatement,
              confirmedAt: mutatedAt,
            }),
          ],
        });
      });
    },
    async applyResumePatch(patch, revisionReason) {
      const parsedPatch = ResumeDraftPatchSchema.parse(patch);
      // Patches mutate the job's single draft, so they must queue on the same
      // per-job transition tail as saves and generation; keying by draft id
      // would create a second, uncoordinated lock for the same job and let a
      // patch race an in-flight generation's stale snapshot.
      const targetJobId =
        (await ctx.repository.listResumeDrafts()).find(
          (entry) => entry.id === parsedPatch.draftId,
        )?.jobId ?? null;

      if (!targetJobId) {
        throw new Error(
          `Unable to find resume draft '${parsedPatch.draftId}'.`,
        );
      }

      return withResumeDraftTransition(targetJobId, async () => {
        const currentDraft =
          (await ctx.repository.listResumeDrafts()).find(
            (entry) => entry.id === parsedPatch.draftId,
          ) ?? null;

        if (!currentDraft) {
          throw new Error(
            `Unable to find resume draft '${parsedPatch.draftId}'.`,
          );
        }

        const state = await ensureResumeDraft(ctx, currentDraft.jobId);

        const updatedAt = createMonotonicTimestamp(currentDraft.updatedAt);
        const nextDraft = applyPatchToResumeDraft({
          draft: currentDraft,
          patch: parsedPatch,
          updatedAt,
        });
        const sanitizedDraft = await sanitizeAndCheckResumeDraft(ctx, {
          draft: nextDraft,
          job: state.job,
          profile: state.profile,
        });
        if (
          buildResumeDraftStateHash(currentDraft) ===
          buildResumeDraftStateHash(sanitizedDraft)
        ) {
          return ctx.getWorkspaceSnapshot();
        }
        const revision = buildResumeDraftRevision({
          draft: currentDraft,
          resultingDraft: sanitizedDraft,
          createdAt: updatedAt,
          parentRevisionId: await getLatestResumeRevisionId(
            ctx,
            currentDraft.id,
          ),
          actor: parsedPatch.origin === "assistant" ? "assistant" : "user",
          mutationKind:
            revisionReason?.startsWith("Regenerated section") === true
              ? "regenerate_section"
              : "manual_patch",
          reason: revisionReason ?? null,
        });
        const validation = validateResumeDraft({
          draft: sanitizedDraft,
          job: state.job,
          profile: state.profile,
          validatedAt: updatedAt,
        });
        const previousValidation =
          (
            await ctx.repository.listResumeValidationResults(currentDraft.id)
          )[0] ?? null;
        const validationWithReviewGuidance = preserveWorkHistoryReviewGuidance({
          validation,
          previousValidation,
          draft: sanitizedDraft,
        });
        const nextAsset = buildTailoredAssetBridge({
          draft: sanitizedDraft,
          job: state.job,
          profile: state.profile,
          existingAsset: state.tailoredAsset,
          clearStoragePath: true,
          templates: state.templates,
        });

        await ctx.repository.applyResumePatchWithRevision({
          expectedDraftUpdatedAt: currentDraft.updatedAt,
          draft: sanitizedDraft,
          revision,
          validation: validationWithReviewGuidance,
          tailoredAsset: nextAsset,
        });

        return ctx.getWorkspaceSnapshot();
      });
    },
    async getResumeAssistantMessages(jobId) {
      await ensureResumeDraft(ctx, jobId);
      return ctx.repository.listResumeAssistantMessages(jobId);
    },
    getResumeAssistantHistory() {
      return ctx.repository.listResumeAssistantMessages();
    },
    async sendResumeAssistantMessage(jobId, content) {
      const workspaceState = await ensureResumeDraft(ctx, jobId);
      const messageTimestamp = createMonotonicTimestamp(
        workspaceState.draft.updatedAt,
      );
      const assistantMessageTimestamp =
        createMonotonicTimestamp(messageTimestamp);
      const userMessage = ResumeAssistantMessageSchema.parse({
        id: createUniqueId(`resume_message_user_${jobId}`),
        jobId,
        role: "user",
        content,
        patches: [],
        createdAt: messageTimestamp,
      });
      // An Original job sends the imported file, so an edit to this draft
      // would never reach the employer. Say so instead of proposing an edit
      // the job cannot use; the studio offers the one-press switch to an
      // editable draft at the saved level and sends this request again.
      if (
        resolveJobResumeApplicationMode(
          workspaceState.job,
          workspaceState.settings,
        ) === "original_resume"
      ) {
        const savedLevel = (await ctx.repository.getSearchPreferences())
          .tailoringMode;
        await ctx.repository.upsertResumeAssistantMessage(userMessage);
        await ctx.repository.upsertResumeAssistantMessage(
          buildAssistantReplyMessage({
            jobId,
            content: buildOriginalResumeAssistantReply(savedLevel),
            patches: [],
            createdAt: assistantMessageTimestamp,
          }),
        );
        return ctx.repository.listResumeAssistantMessages(jobId);
      }
      const validations = await ctx.repository.listResumeValidationResults(
        workspaceState.draft.id,
      );
      const research = await fetchAndPersistResearch(ctx, workspaceState.job);
      const tailoringStrength =
        await resolveEffectiveResumeTailoringStrengthForJob(ctx, jobId);
      const previousMessages =
        await ctx.repository.listResumeAssistantMessages(jobId);
      const assistantReply = await ctx.aiClient.reviseResumeDraft({
        draft: workspaceState.draft,
        job: workspaceState.job,
        request: content,
        validationIssues:
          validations[0]?.issues.map((issue) => issue.message) ?? [],
        tailoringStrength,
        researchContext: collectResearchContext(research),
        recentConversation:
          buildRecentResumeAssistantConversation(previousMessages),
        linesToConfirm: listResumeLinesToConfirm({
          draft: workspaceState.draft,
          claimAssessments: validations[0]?.claimAssessments ?? [],
        }),
        // The same gate the reply below is judged by, run inside the agent so
        // it repairs a flagged change before it finishes instead of handing
        // the person a proposal that blocks approval.
        checkProposal: (patches) =>
          checkResumeAssistantProposal({
            aiClient: ctx.aiClient,
            baselineDraft: workspaceState.draft,
            patches,
            job: workspaceState.job,
            profile: workspaceState.profile,
          }),
        currentPageCount:
          validations[0]?.pageCount ??
          validations[0]?.coverageComparison?.pageCount ??
          null,
        measurePages: async (patches) => {
          let candidateDraft = workspaceState.draft;
          for (const patch of patches) {
            candidateDraft = applyPatchToResumeDraft({
              draft: candidateDraft,
              patch: {
                ...patch,
                draftId: workspaceState.draft.id,
                origin: "assistant",
              },
              updatedAt: createMonotonicTimestamp(candidateDraft.updatedAt),
            });
          }
          const measuredDraft = sanitizeResumeDraft({
            draft: candidateDraft,
            job: workspaceState.job,
            profile: workspaceState.profile,
          });
          const rendered = await ctx.documentManager.renderResumeArtifact({
            job: workspaceState.job,
            profile: workspaceState.profile,
            renderDocument: buildResumeRenderDocument(
              workspaceState.profile,
              measuredDraft,
            ),
            templateId: measuredDraft.templateId,
            settings: workspaceState.settings,
          });
          return {
            pageCount: rendered.pageCount ?? null,
            targetPageCount: measuredDraft.targetPageCount,
          };
        },
        availableTemplates: workspaceState.templates
          .filter(isResumeTemplateApplyEligible)
          .map((template) => ({
            id: template.id,
            label: template.label,
            density: template.density,
          })),
      });
      const normalizedPatches = assistantReply.patches.map((patch) =>
        ResumeDraftPatchSchema.parse({
          ...patch,
          draftId: workspaceState.draft.id,
          targetEntryId: patch.targetEntryId ?? null,
          // Model output never self-identifies its origin: assistant proposals
          // always carry the canonical assistant origin so assistant-only
          // lock and reorder restrictions apply at acceptance time.
          origin: "assistant",
        }),
      );
      // A patch the model left incomplete (no replacement text, or a bullet
      // change with no bullet named) cannot be applied. It is reported as an
      // unusable proposal in plain words, never as the apply error it would
      // raise later.
      const invalidReplacementPatch = normalizedPatches.find(
        (patch) =>
          ([
            "replace_section_text",
            "replace_entry_summary",
            "update_bullet",
          ].includes(patch.operation) &&
            !patch.newText?.trim()) ||
          (patch.operation === "update_bullet" && !patch.targetBulletId) ||
          (patch.operation === "replace_entry_summary" && !patch.targetEntryId),
      );
      const droppedOnSave = invalidReplacementPatch
        ? []
        : findResumeAssistantPatchesDroppedOnSave({
            baselineDraft: workspaceState.draft,
            patches: normalizedPatches,
            job: workspaceState.job,
            profile: workspaceState.profile,
          });
      // A change the save cleanup would remove is not offered: accepting it
      // reported "Applied" while the preview stayed the same.
      const reviewablePatches = invalidReplacementPatch
        ? []
        : normalizedPatches.filter(
            (patch) => !droppedOnSave.some((drop) => drop.patchId === patch.id),
          );
      const droppedNote =
        droppedOnSave.length > 0
          ? ` I left out ${droppedOnSave.length === 1 ? "1 change" : `${droppedOnSave.length} changes`} that would not survive saving: ${droppedOnSave[0]!.message}`
          : "";
      // The proposal is only described as grounded when the exact classifier
      // that gates export and approval accepts the draft that accepting it
      // would produce. Applying the patches also proves they are appliable, so
      // one evaluation replaces the previous apply-only dry run.
      let proposalGate: {
        accepted: boolean;
        approvalBlockers: ResumeProposalApprovalBlocker[];
      };
      try {
        proposalGate = await evaluateCheckedResumeProposalGrounding(
          { aiClient: ctx.aiClient },
          {
            baselineDraft: workspaceState.draft,
            patches: reviewablePatches,
            job: workspaceState.job,
            profile: workspaceState.profile,
            evaluatedAt: assistantMessageTimestamp,
          },
        );
      } catch (error) {
        const failureDetail =
          error instanceof Error
            ? error.message
            : "A resume patch could not be applied.";
        const failureMessage = buildAssistantReplyMessage({
          jobId,
          content: `No assistant changes were applied. ${failureDetail}`,
          patches: [],
          proposalError: failureDetail,
          executionAttribution: assistantReply.executionReceipt,
          createdAt: assistantMessageTimestamp,
        });

        await ctx.repository.upsertResumeAssistantMessage(userMessage);
        await ctx.repository.upsertResumeAssistantMessage(failureMessage);
        return ctx.repository.listResumeAssistantMessages(jobId);
      }

      const assistantContent =
        reviewablePatches.length > 0
          ? buildResumeProposalReplyContent({
              approvalBlockers: proposalGate.approvalBlockers,
              changeCount: reviewablePatches.length,
              assistantNote: `${assistantReply.content}${droppedNote}`,
            })
          : invalidReplacementPatch
            ? invalidReplacementPatch.operation === "update_bullet"
              ? "I could not tell which bullet to change, so no resume change was proposed. Name the bullet by its first few words and the role it belongs to."
              : "I could not produce a usable replacement for that request, so no resume change was proposed. Try asking for the exact section and outcome you want."
            : droppedOnSave.length > 0
              ? `No resume change was proposed. ${droppedOnSave[0]!.message} ${assistantReply.content}`
              : assistantReply.content;
      const assistantMessage = buildAssistantReplyMessage({
        jobId,
        content: assistantContent,
        approvalBlockers: proposalGate.approvalBlockers,
        patches: reviewablePatches,
        baseDraftUpdatedAt: workspaceState.draft.updatedAt,
        executionAttribution: assistantReply.executionReceipt,
        createdAt: assistantMessageTimestamp,
      });

      await ctx.repository.upsertResumeAssistantMessage(userMessage);
      await ctx.repository.upsertResumeAssistantMessage(assistantMessage);

      return ctx.repository.listResumeAssistantMessages(jobId);
    },
    async resolveResumeAssistantProposal(jobId, proposalId, action, patchIds) {
      return withResumeDraftTransition(jobId, async () => {
        const proposal = (
          await ctx.repository.listResumeAssistantMessages(jobId)
        ).find((message) => message.id === proposalId);
        if (!proposal || proposal.role !== "assistant") {
          throw new Error(`Unable to find resume proposal '${proposalId}'.`);
        }
        if (proposal.proposalStatus !== "pending") {
          throw new Error("This resume proposal has already been resolved.");
        }

        const resolvedAt = createMonotonicTimestamp(proposal.createdAt);
        if (action === "reject") {
          await ctx.repository.upsertResumeAssistantMessage(
            ResumeAssistantMessageSchema.parse({
              ...proposal,
              proposalStatus: "rejected",
              resolvedPatchIds: [],
              resolvedAt,
              proposalError: null,
            }),
          );
          return ctx.repository.listResumeAssistantMessages(jobId);
        }

        const uniquePatchIds = [...new Set(patchIds)];
        const proposalPatchIds = new Set(
          proposal.patches.map((patch) => patch.id),
        );
        if (
          uniquePatchIds.length === 0 ||
          uniquePatchIds.some((patchId) => !proposalPatchIds.has(patchId))
        ) {
          throw new Error(
            "Select at least one change from this exact proposal.",
          );
        }

        const workspaceState = await ensureResumeDraft(ctx, jobId);
        if (
          !proposal.baseDraftUpdatedAt ||
          workspaceState.draft.updatedAt !== proposal.baseDraftUpdatedAt
        ) {
          const message =
            "The resume changed after this proposal was created. Review the current draft and request fresh edits.";
          await ctx.repository.upsertResumeAssistantMessage(
            ResumeAssistantMessageSchema.parse({
              ...proposal,
              proposalError: message,
            }),
          );
          throw new Error(message);
        }

        try {
          let candidateDraft = workspaceState.draft;
          for (const patch of proposal.patches) {
            if (!uniquePatchIds.includes(patch.id)) {
              continue;
            }
            candidateDraft = applyPatchToResumeDraft({
              draft: candidateDraft,
              patch,
              updatedAt: createMonotonicTimestamp(candidateDraft.updatedAt),
            });
          }

          const finalUpdatedAt = createMonotonicTimestamp(
            candidateDraft.updatedAt,
          );
          const sanitizedDraft = await sanitizeAndCheckResumeDraft(ctx, {
            draft: candidateDraft,
            job: workspaceState.job,
            profile: workspaceState.profile,
          });
          if (
            buildResumeDraftStateHash(workspaceState.draft) ===
            buildResumeDraftStateHash(sanitizedDraft)
          ) {
            throw new Error(
              "The selected proposal does not change the current resume.",
            );
          }

          const revision = buildResumeDraftRevision({
            draft: workspaceState.draft,
            resultingDraft: sanitizedDraft,
            createdAt: finalUpdatedAt,
            parentRevisionId: await getLatestResumeRevisionId(
              ctx,
              workspaceState.draft.id,
            ),
            actor: "assistant",
            mutationKind: "assistant_patch",
            reason: `Approved guided edits proposal: ${proposal.content}`,
          });
          const validations = await ctx.repository.listResumeValidationResults(
            workspaceState.draft.id,
          );
          const validation = validateResumeDraft({
            draft: sanitizedDraft,
            job: workspaceState.job,
            profile: workspaceState.profile,
            validatedAt: finalUpdatedAt,
          });
          const validationWithReviewGuidance =
            preserveWorkHistoryReviewGuidance({
              validation,
              previousValidation: validations[0] ?? null,
              draft: sanitizedDraft,
            });
          const nextAsset = buildTailoredAssetBridge({
            draft: sanitizedDraft,
            job: workspaceState.job,
            profile: workspaceState.profile,
            existingAsset: workspaceState.tailoredAsset,
            clearStoragePath: true,
            templates: workspaceState.templates,
          });

          await ctx.repository.applyResumePatchWithRevision({
            expectedDraftUpdatedAt: workspaceState.draft.updatedAt,
            draft: sanitizedDraft,
            revision,
            validation: validationWithReviewGuidance,
            tailoredAsset: nextAsset,
          });
          await ctx.repository.upsertResumeAssistantMessage(
            ResumeAssistantMessageSchema.parse({
              ...proposal,
              proposalStatus: "accepted",
              resolvedPatchIds: uniquePatchIds,
              resolvedAt,
              proposalError: null,
            }),
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "The selected resume changes could not be applied.";
          await ctx.repository.upsertResumeAssistantMessage(
            ResumeAssistantMessageSchema.parse({
              ...proposal,
              proposalError: message,
            }),
          );
          throw error;
        }

        return ctx.repository.listResumeAssistantMessages(jobId);
      });
    },
    async approveApply(
      jobId,
      applicationRecordId?: string | null,
      capacityToken?: ApplicationPreparationCapacityToken,
    ) {
      const preflightJob = (await ctx.repository.listSavedJobs()).find(
        (entry) => entry.id === jobId,
      );
      if (!preflightJob) {
        throw new Error(
          `Unable to approve apply flow for unknown job '${jobId}'.`,
        );
      }
      const selectedApplicationRecord = await resolveApplicationRecordForJob({
        repository: ctx.repository,
        job: preflightJob,
        ...(applicationRecordId !== undefined ? { applicationRecordId } : {}),
      });
      const claim = claimDirectApplyExecution(
        jobId,
        selectedApplicationRecord.id,
      );
      return trackDirectApplyExecution(claim, async () => {
        await requireApplyActivityEnabled();
        const [
          searchPreferences,
          settings,
          savedJobs,
          sourceInstructionArtifacts,
          sourceDebugAttempts,
        ] = await Promise.all([
          ctx.repository.getSearchPreferences(),
          ctx.repository.getSettings(),
          ctx.repository.listSavedJobs(),
          ctx.repository.listSourceInstructionArtifacts(),
          ctx.repository.listSourceDebugAttempts(),
        ]);
        const job = savedJobs.find((entry) => entry.id === jobId);

        if (!job) {
          throw new Error(
            `Unable to approve apply flow for unknown job '${jobId}'.`,
          );
        }

        const prerequisites = await resolveJobApplyPrerequisites(jobId);
        const { resumeApplicationMode, resumeArtifact } = prerequisites;
        const capturedCampaignId = await ctx.getActiveCampaignId();
        await assertNoOtherRunningApplyForJob(claim);
        await assertDirectApplyExecutionCanContinue(claim);
        await assertCurrentResumeProfile(
          ctx,
          prerequisites.profileRevision,
          "staging this approved application preparation",
        );
        await persistDirectApplyRunStart({
          claim,
          job,
          campaignId: capturedCampaignId,
          startedAt: new Date().toISOString(),
        });
        await assertDirectApplyExecutionCanContinue(claim);
        const provenanceTargetId =
          selectApplicationSighting(job)?.targetId ??
          job.provenance[job.provenance.length - 1]?.targetId ??
          job.provenance[0]?.targetId ??
          null;
        const provenanceTarget = provenanceTargetId
          ? (searchPreferences.discovery.targets.find(
              (target) => target.id === provenanceTargetId,
            ) ?? null)
          : null;
        const activeLedgerTargetId =
          provenanceTarget?.id ??
          (searchPreferences.discovery.targets.length === 1
            ? (searchPreferences.discovery.targets[0]?.id ?? null)
            : null);
        const activeInstruction = provenanceTarget
          ? resolveActiveSourceInstructionArtifact(
              provenanceTarget,
              sourceInstructionArtifacts,
            )
          : null;
        const applyInstructions = uniqueStrings([
          ...buildInstructionGuidance(activeInstruction),
        ]);
        const intermediateMutationAuthority =
          await buildIntermediateMutationExecutionOptions({
            job,
            resumeArtifact,
          });
        await assertDirectApplyExecutionCanContinue(claim);
        await assertCurrentResumeProfile(
          ctx,
          prerequisites.profileRevision,
          "opening this approved application preparation",
        );
        const markedResult = await ctx.markApplicationPreparationStarted(
          {
            resultId: claim.resultId,
            runId: claim.runId,
            jobId,
          },
          capacityToken,
        );
        await reuseApplicationPage({
          ...ctx,
          source: job.source,
          applicationRecordId: selectedApplicationRecord.id,
          resultId: markedResult.id,
        });
        const browserProfile = await assertCurrentResumeProfile(
          ctx,
          prerequisites.profileRevision,
          "executing this approved application preparation",
        );

        // What the person's saved permission allows for this exact
        // application. Anything it does not cover fills the form in and stops.
        const applyAuthorityApproved = await resolveApplyAuthorityForJob({
          repository: ctx.repository,
          job: job,
          resumeSha256: resumeArtifact.sha256,
          applicationUrl: job.applicationUrl ?? job.canonicalUrl,
          now: new Date().toISOString(),
        });
        let activeEnvelopeApproved = applyAuthorityApproved.envelope;
        const applicationAttachmentsApproved =
          await resolveApplicationAttachmentsForExecution({
            jobId: job.id,
            resolver: ctx.candidateAssetResolver,
            questionRecords: [],
            answerRecords: [],
          });
        // The browser layer opens the page; Job Finder decides what goes in
        // the form and whether anything may be sent.
        const applyFlowFactsApproved = {
          applicationPageBindingKey: markedResult.id,
          job,
          resumeArtifact,
          profile: mergeApplicationAnswersIntoExecutionProfile({
            profile: browserProfile.profile,
            questionRecords:
              await ctx.repository.listApplicationQuestionRecords({
                applicationRecordId: selectedApplicationRecord.id,
              }),
            answerRecords: await ctx.repository.listApplicationAnswerRecords({
              applicationRecordId: selectedApplicationRecord.id,
            }),
            idPrefix: `application_${selectedApplicationRecord.id}`,
            applicationRecordId: selectedApplicationRecord.id,
            jobLocation: job.location,
          }),
          ...(applicationAttachmentsApproved.length > 0
            ? { applicationAttachments: applicationAttachmentsApproved }
            : {}),
          settings: { ...settings, resumeApplicationMode },
          mode:
            applyAuthorityApproved.authority.mode === "autonomous_submit"
              ? ("submit_when_ready" as const)
              : ("prepare_only" as const),
          ...intermediateMutationAuthority,
          accountCreationAuthorized: false as const,
          applyAutomationMode: applyAuthorityApproved.authority.mode,
          submitAuthorized: applyAuthorityApproved.authority.submitAuthorized,
          preApprovedAttestationKinds:
            applyAuthorityApproved.authority.preApprovedAttestationKinds,
          salaryDisclosure: applyAuthorityApproved.authority.salaryDisclosure,
          applyAllowedOrigins: [
            ...applyAuthorityApproved.authority.allowedOrigins,
          ],
          authorizeReviewedApplicationOrigin: async (origin: string) => {
            if (!activeEnvelopeApproved) return null;
            activeEnvelopeApproved = await authorizeReviewedApplicationOrigin({
              repository: ctx.repository,
              envelope: activeEnvelopeApproved,
              jobId: job.id,
              origin,
              now: new Date().toISOString(),
            });
            return activeEnvelopeApproved;
          },
          ...(applyInstructions.length > 0
            ? { instructions: applyInstructions }
            : {}),
        };
        let preparedReviewCardApproved: ApplicationReviewCard | null = null;
        const applyFlowInputApproved = {
          ...applyFlowFactsApproved,
          onWaitingForBrowserTab: () =>
            persistApplicationWaitingForBrowserTab({
              repository: ctx.repository,
              resultId: markedResult.id,
              runId: claim.runId,
              jobId: jobId,
            }),
          prepareApplicationForm: createApplyFormPreparer({
            executionInput: applyFlowFactsApproved,
            onPrepared: ({ reviewCard }) => {
              preparedReviewCardApproved = reviewCard;
            },
            applicationRecordId: selectedApplicationRecord.id,
            searchPreferences,
            aiClient: ctx.aiClient,
            onProgress: (progress) =>
              persistApplicationPreparationProgress({
                repository: ctx.repository,
                resultId: markedResult.id,
                runId: claim.runId,
                jobId,
                progress,
              }),
            ...(activeEnvelopeApproved
              ? { envelope: activeEnvelopeApproved }
              : {}),
            letters: buildApplyLetterDependencies({
              aiClient: ctx.aiClient,
              documentManager: ctx.documentManager,
              job: applyFlowFactsApproved.job,
              profile: applyFlowFactsApproved.profile,
              settings: applyFlowFactsApproved.settings,
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
            applyAuthorityApproved.authority,
            await ctx.browserRuntime.executeApplicationFlow(
              job.source,
              applyFlowInputApproved,
              { signal: claim.controller.signal },
            ),
          ),
        );
        await assertPreparationProfileCurrent(ctx, prerequisites);
        await assertDirectApplyExecutionCanContinue(claim);
        const now = new Date().toISOString();
        const sourceDebugEvidenceRefIds = buildEvidenceRefIdsFromInstruction({
          activeInstruction,
          sourceDebugAttempts,
        });
        const questions = executionResult.questions.map((question) =>
          ApplicationAttemptQuestionSchema.parse(question),
        );
        const consentDecisions = executionResult.consentDecisions.map(
          (decision) => ApplicationAttemptConsentDecisionSchema.parse(decision),
        );
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
        const runArtifacts = buildApplyCopilotArtifacts({
          reviewCard: await reviewCardForFreshPreparation(
            selectedApplicationRecord.id,
            preparedReviewCardApproved,
          ),
          existingAnswerRecords:
            await ctx.repository.listApplicationAnswerRecords({
              applicationRecordId: selectedApplicationRecord.id,
            }),
          applicationRecordId: selectedApplicationRecord.id,
          job,
          resumeArtifact,
          executionResult: {
            ...executionResult,
            blocker,
            replay,
          },
          detectedAt: now,
          runId: claim.runId,
          resultId: claim.resultId,
        });
        const persistedRun = ApplyRunSchema.parse({
          ...runArtifacts.run,
          campaignId: capturedCampaignId,
        });
        const attempt = ApplicationAttemptSchema.parse({
          id: `attempt_${jobId}_${Date.now()}`,
          jobId,
          applicationRecordId: selectedApplicationRecord.id,
          state: executionResult.state,
          summary: executionResult.summary,
          detail: executionResult.detail,
          startedAt: executionResult.checkpoints[0]?.at ?? now,
          updatedAt: executionResult.submittedAt ?? now,
          completedAt:
            executionResult.state === "in_progress"
              ? null
              : (executionResult.submittedAt ?? now),
          outcome: executionResult.outcome,
          checkpoints: executionResult.checkpoints,
          questions,
          blocker,
          consentDecisions,
          replay,
          visualEvidence: executionResult.visualEvidence,
          visualObservationSets: executionResult.visualObservationSets,
          visualCheckpoints: executionResult.visualCheckpoints,
          nextActionLabel: executionResult.nextActionLabel,
          executionTimings: executionResult.executionTimings,
          agentTiming: executionResult.agentTiming,
        });

        await withApplyRunTransition(claim.runId, async () => {
          await assertDirectApplyTerminalTransitionIsOpen(claim);
          await ctx.repository.upsertApplicationAttempt(attempt);
          await Promise.all([
            ctx.repository.upsertApplyRun(persistedRun),
            ctx.repository.upsertApplyJobResult({
              ...runArtifacts.result,
              applicationPreparationStartedAt:
                markedResult.applicationPreparationStartedAt,
              applicationPreparationStartedLocalDate:
                markedResult.applicationPreparationStartedLocalDate,
            }),
            ...runArtifacts.questionRecords.map((record) =>
              ctx.repository.upsertApplicationQuestionRecord(record),
            ),
            ...runArtifacts.answerRecords.map((record) =>
              ctx.repository.upsertApplicationAnswerRecord(record),
            ),
            ...runArtifacts.artifactRefs.map((ref) =>
              ctx.repository.upsertApplicationArtifactRef(ref),
            ),
            ...runArtifacts.checkpoints.map((checkpoint) =>
              ctx.repository.upsertApplicationReplayCheckpoint(checkpoint),
            ),
            ...runArtifacts.consentRequests.map((request) =>
              ctx.repository.upsertApplicationConsentRequest(request),
            ),
          ]);

          await withExactApplicationRecordTransition(
            selectedApplicationRecord.id,
            jobId,
            async () => {
              const applicationRecords =
                await ctx.repository.listApplicationRecords();
              const existingRecord = applicationRecords.find(
                (record) => record.id === selectedApplicationRecord.id,
              );
              if (!existingRecord) {
                throw new Error(
                  `Unknown Job Finder application record '${selectedApplicationRecord.id}'.`,
                );
              }
              const nextRecord = ApplicationRecordSchema.parse({
                ...existingRecord,
                id: existingRecord.id,
                jobId,
                title: job.title,
                company: job.company,
                status: nextJobStatusFromAttempt(job, executionResult.state),
                lastActionLabel: executionResult.summary,
                nextActionLabel: executionResult.nextActionLabel,
                lastUpdatedAt: executionResult.submittedAt ?? now,
                lastAttemptState: executionResult.state,
                questionSummary: buildQuestionSummary(attempt.questions),
                latestBlocker: buildLatestBlockerSummary(attempt.blocker),
                consentSummary: buildConsentSummary(attempt.consentDecisions),
                replaySummary: buildReplaySummary(
                  attempt.replay,
                  attempt.visualEvidence,
                ),
                automationMode: applyAuthorityApproved.authority.mode,
                crm: existingRecord.crm,
                events: mergeEvents(
                  existingRecord.events,
                  toApplicationEvents(job, executionResult.checkpoints),
                ),
              });

              await ctx.repository.upsertApplicationRecord(nextRecord);
            },
          );
          if (executionResult.state === "submitted") {
            // The applied ledger entry derives from the transaction-current
            // discovery state inside the same commit as the saved-job status,
            // so a discovery run finishing during the browser flow cannot be
            // reverted by a stale pre-flow snapshot.
            await ctx.repository.commitSavedJobDelta({
              updateJobIds: [jobId],
              update: (savedJob) =>
                savedJob.id === jobId
                  ? SavedJobSchema.parse({
                      ...savedJob,
                      status: nextJobStatusFromAttempt(
                        savedJob,
                        executionResult.state,
                      ),
                    })
                  : savedJob,
              updateDiscoveryState: (current) => ({
                ...current,
                discoveryLedger: markSavedJobStatusInLedger({
                  ledger: current.discoveryLedger,
                  job,
                  ...(activeLedgerTargetId
                    ? { activeTargetId: activeLedgerTargetId }
                    : {}),
                  status: "applied",
                  occurredAt: executionResult.submittedAt ?? now,
                  skipReason: null,
                }),
              }),
            });
          } else {
            await ctx.repository.commitSavedJobDelta({
              updateJobIds: [jobId],
              update: (savedJob) =>
                savedJob.id === jobId
                  ? SavedJobSchema.parse({
                      ...savedJob,
                      status: nextJobStatusFromAttempt(
                        savedJob,
                        executionResult.state,
                      ),
                    })
                  : savedJob,
            });
          }
        });

        return ctx.getWorkspaceSnapshot();
      });
    },
    async startApplyCopilotRun(
      jobId,
      options,
      applicationRecordId?: string | null,
      capacityToken?: ApplicationPreparationCapacityToken,
    ) {
      const preflightJob = (await ctx.repository.listSavedJobs()).find(
        (entry) => entry.id === jobId,
      );
      if (!preflightJob) {
        throw new Error(
          `Unable to start apply copilot for unknown job '${jobId}'.`,
        );
      }
      const selectedApplicationRecord = await resolveApplicationRecordForJob({
        repository: ctx.repository,
        job: preflightJob,
        ...(applicationRecordId !== undefined ? { applicationRecordId } : {}),
      });
      const claim = claimDirectApplyExecution(
        jobId,
        selectedApplicationRecord.id,
      );
      return trackDirectApplyExecution(claim, async () => {
        await requireApplyActivityEnabled();
        const [
          profileState,
          searchPreferences,
          settings,
          savedJobs,
          tailoredAssets,
          sourceInstructionArtifacts,
          sourceDebugAttempts,
          draft,
          approvedExports,
          recoverySeed,
        ] = await Promise.all([
          ctx.repository.getProfileWithRevision(),
          ctx.repository.getSearchPreferences(),
          ctx.repository.getSettings(),
          ctx.repository.listSavedJobs(),
          ctx.repository.listTailoredAssets(),
          ctx.repository.listSourceInstructionArtifacts(),
          ctx.repository.listSourceDebugAttempts(),
          ctx.repository.getResumeDraftByJobId(jobId),
          ctx.repository.listResumeExportArtifacts({ jobId }),
          buildApplyRecoveryContext(jobId, selectedApplicationRecord.id),
        ]);
        const profile = profileState.profile;
        const capturedCampaignId = await ctx.getActiveCampaignId();
        const job = savedJobs.find((entry) => entry.id === jobId) ?? null;

        if (!job) {
          throw new Error(
            `Unable to start apply copilot for unknown job '${jobId}'.`,
          );
        }

        // Hoisted above the missing-resume branch so a copilot start can never
        // record blocked artifacts for a job that another apply run is already
        // actively preparing.
        await assertNoOtherRunningApplyForJob(claim);
        await closeReplacedSingleJobRuns(jobId, claim.runId);

        const asset =
          tailoredAssets.find((entry) => entry.jobId === jobId) ?? null;
        const approvedExportResolution = isApprovedTailoredResumeReadyForApply({
          draft,
          exports: approvedExports,
          asset,
        });
        const approvedExport = approvedExportResolution.approvedExport;
        const reviewedDraftPath = asset?.storagePath?.trim() ?? "";
        const canUseReviewedDraft =
          !approvedExport &&
          asset?.status === "ready" &&
          (draft?.status === "draft" || draft?.status === "needs_review") &&
          reviewedDraftPath.length > 0;
        const originalResumePath = profile.baseResume.storagePath?.trim() ?? "";
        const usesOriginalResume =
          resolveJobResumeApplicationMode(job, settings) === "original_resume";

        const shouldBlockForMissingResume = usesOriginalResume
          ? !originalResumePath
          : !approvedExportResolution.ready && !canUseReviewedDraft;

        // The missing-resume handoff must never orphan terminal artifacts on a
        // run nobody can cancel: register a durable cancellable running row
        // first, then commit the blocked artifacts inside the run transition so
        // a winning cancel writes nothing after cancellation.
        async function persistResumePrerequisiteCopilotOutcome(prerequisite?: {
          kind: "work_history_review";
          summary: string;
          detail: string;
          nextActionLabel: string;
        }): Promise<void> {
          if (!job) {
            throw new Error(
              `Unable to start apply copilot for unknown job '${jobId}'.`,
            );
          }
          const detectedAt = new Date().toISOString();
          const artifacts = buildMissingResumeCopilotArtifacts({
            applicationRecord: selectedApplicationRecord,
            job,
            detectedAt,
            ...(prerequisite ? { prerequisite } : {}),
          });
          await assertDirectApplyExecutionCanContinue(claim);
          await assertCurrentResumeProfile(
            ctx,
            profileState.revision,
            "staging this missing-resume application preparation",
          );
          await persistDirectApplyRunStart({
            claim,
            job,
            campaignId: capturedCampaignId,
            startedAt: detectedAt,
          });
          const persistedRun = ApplyRunSchema.parse({
            ...artifacts.run,
            id: claim.runId,
            campaignId: capturedCampaignId,
            visualCheckpointsEnabled:
              options?.visualCheckpointsEnabled === true,
          });
          const persistedResult = ApplyJobResultSchema.parse({
            ...artifacts.result,
            id: claim.resultId,
            runId: claim.runId,
          });

          await withApplyRunTransition(claim.runId, async () => {
            await assertDirectApplyTerminalTransitionIsOpen(claim);
            await Promise.all([
              ctx.repository.upsertApplyRun(persistedRun),
              ctx.repository.upsertApplyJobResult(persistedResult),
              ctx.repository.upsertApplicationQuestionRecord(
                ApplicationQuestionRecordSchema.parse({
                  ...artifacts.questionRecord,
                  runId: claim.runId,
                  resultId: claim.resultId,
                }),
              ),
              ctx.repository.upsertApplicationArtifactRef(
                ApplicationArtifactRefSchema.parse({
                  ...artifacts.artifactRef,
                  runId: claim.runId,
                  resultId: claim.resultId,
                }),
              ),
              ctx.repository.upsertApplicationReplayCheckpoint(
                ApplicationReplayCheckpointSchema.parse({
                  ...artifacts.checkpoint,
                  runId: claim.runId,
                  resultId: claim.resultId,
                }),
              ),
              ctx.repository.upsertApplicationConsentRequest(
                ApplicationConsentRequestSchema.parse({
                  ...artifacts.consentRequest,
                  runId: claim.runId,
                  resultId: claim.resultId,
                }),
              ),
            ]);

            await withExactApplicationRecordTransition(
              selectedApplicationRecord.id,
              jobId,
              async () => {
                const applicationRecords =
                  await ctx.repository.listApplicationRecords();
                const existingRecord =
                  applicationRecords.find(
                    (record) => record.id === selectedApplicationRecord.id,
                  ) ?? null;
                await ctx.repository.upsertApplicationRecord(
                  mergeMissingResumeApplicationRecord({
                    applicationRecord: artifacts.applicationRecord,
                    existingRecord,
                  }),
                );
              },
            );
          });

          await persistAutomaticApplicationSafeguards({
            ctx,
            run: persistedRun,
            result: persistedResult,
            job,
            now: detectedAt,
          }).catch((safeguardError: unknown) => {
            console.error(
              "Failed to persist automatic application safeguards.",
              safeguardError,
            );
          });
        }

        if (!shouldBlockForMissingResume && ctx.exportFileVerifier) {
          const approvedFileExists = await ctx.exportFileVerifier.exists(
            usesOriginalResume
              ? originalResumePath
              : (approvedExport?.filePath ?? reviewedDraftPath),
          );

          if (!approvedFileExists) {
            await persistResumePrerequisiteCopilotOutcome();
            return ctx.getWorkspaceSnapshot();
          }
        }

        if (shouldBlockForMissingResume) {
          await persistResumePrerequisiteCopilotOutcome();
          return ctx.getWorkspaceSnapshot();
        }

        const prerequisites = await resolveJobApplyPrerequisites(jobId);
        const {
          job: currentJob,
          resumeApplicationMode,
          resumeArtifact,
        } = prerequisites;
        await assertCurrentResumeProfile(
          ctx,
          prerequisites.profileRevision,
          "staging this application preparation",
        );
        if (!ctx.browserRuntime.executeApplicationFlow) {
          throw new Error(
            "The current browser runtime does not support non-submitting apply copilot execution yet.",
          );
        }
        await assertDirectApplyExecutionCanContinue(claim);
        await assertCurrentResumeProfile(
          ctx,
          prerequisites.profileRevision,
          "starting this application preparation",
        );
        const directRunStartedAt = new Date().toISOString();
        await persistDirectApplyRunStart({
          claim,
          job: currentJob,
          campaignId: capturedCampaignId,
          startedAt: directRunStartedAt,
        });
        await assertDirectApplyExecutionCanContinue(claim);
        const provenanceTargetId =
          selectApplicationSighting(job)?.targetId ??
          job.provenance[job.provenance.length - 1]?.targetId ??
          job.provenance[0]?.targetId ??
          null;
        const provenanceTarget = provenanceTargetId
          ? (searchPreferences.discovery.targets.find(
              (target) => target.id === provenanceTargetId,
            ) ?? null)
          : null;
        const activeInstruction = provenanceTarget
          ? resolveActiveSourceInstructionArtifact(
              provenanceTarget,
              sourceInstructionArtifacts,
            )
          : null;
        const applyInstructions = uniqueStrings([
          ...buildInstructionGuidance(activeInstruction),
          ...recoverySeed.recoveryInstructions,
        ]);
        const intermediateMutationAuthority =
          await buildIntermediateMutationExecutionOptions({
            job: currentJob,
            resumeArtifact,
          });
        await assertDirectApplyExecutionCanContinue(claim);
        await assertCurrentResumeProfile(
          ctx,
          prerequisites.profileRevision,
          "opening this application preparation",
        );
        const markedResult = await ctx.markApplicationPreparationStarted(
          {
            resultId: claim.resultId,
            runId: claim.runId,
            jobId,
          },
          capacityToken,
        );
        await reuseApplicationPage({
          ...ctx,
          source: job.source,
          applicationRecordId: selectedApplicationRecord.id,
          resultId: markedResult.id,
        });
        const browserProfile = await assertCurrentResumeProfile(
          ctx,
          prerequisites.profileRevision,
          "executing this application preparation",
        );
        // What the person's saved permission allows for this exact
        // application. Anything it does not cover fills the form in and stops.
        const applyAuthorityDirect = await resolveApplyAuthorityForJob({
          repository: ctx.repository,
          job: currentJob,
          resumeSha256: resumeArtifact.sha256,
          applicationUrl: currentJob.applicationUrl ?? currentJob.canonicalUrl,
          now: new Date().toISOString(),
        });
        let activeEnvelopeDirect = applyAuthorityDirect.envelope;
        const applicationAttachmentsDirect =
          await resolveApplicationAttachmentsForExecution({
            jobId: currentJob.id,
            resolver: ctx.candidateAssetResolver,
            questionRecords: [],
            answerRecords: [],
          });
        // The browser layer opens the page; Job Finder decides what goes in
        // the form and whether anything may be sent.
        const applyFlowFactsDirect = {
          applicationPageBindingKey: markedResult.id,
          job: currentJob,
          resumeArtifact,
          profile: mergeApplicationAnswersIntoExecutionProfile({
            profile: browserProfile.profile,
            questionRecords:
              await ctx.repository.listApplicationQuestionRecords({
                applicationRecordId: selectedApplicationRecord.id,
              }),
            answerRecords: await ctx.repository.listApplicationAnswerRecords({
              applicationRecordId: selectedApplicationRecord.id,
            }),
            idPrefix: `application_${selectedApplicationRecord.id}`,
            applicationRecordId: selectedApplicationRecord.id,
            jobLocation: job.location,
          }),
          ...(applicationAttachmentsDirect.length > 0
            ? { applicationAttachments: applicationAttachmentsDirect }
            : {}),
          settings: { ...settings, resumeApplicationMode },
          mode:
            applyAuthorityDirect.authority.mode === "autonomous_submit"
              ? ("submit_when_ready" as const)
              : ("prepare_only" as const),
          ...intermediateMutationAuthority,
          accountCreationAuthorized: false as const,
          applyAutomationMode: applyAuthorityDirect.authority.mode,
          submitAuthorized: applyAuthorityDirect.authority.submitAuthorized,
          preApprovedAttestationKinds:
            applyAuthorityDirect.authority.preApprovedAttestationKinds,
          salaryDisclosure: applyAuthorityDirect.authority.salaryDisclosure,
          applyAllowedOrigins: [
            ...applyAuthorityDirect.authority.allowedOrigins,
          ],
          authorizeReviewedApplicationOrigin: async (origin: string) => {
            if (!activeEnvelopeDirect) return null;
            activeEnvelopeDirect = await authorizeReviewedApplicationOrigin({
              repository: ctx.repository,
              envelope: activeEnvelopeDirect,
              jobId: currentJob.id,
              origin,
              now: new Date().toISOString(),
            });
            return activeEnvelopeDirect;
          },
          ...(recoverySeed.recoveryContext
            ? { recoveryContext: recoverySeed.recoveryContext }
            : {}),
          ...(applyInstructions.length > 0
            ? { instructions: applyInstructions }
            : {}),
          ...buildApplyVisualExecutionOptions({
            enabled: options?.visualCheckpointsEnabled === true,
            source: currentJob.source,
          }),
        };
        // Set while the form is being filled in, so the finished application
        // can be handed to the submission path. The one-press Apply used to
        // drop this, so "Send for me" filled the form and never sent it;
        // only a batch did.
        let preparedHandoffDirect: ApplySubmissionHandoff | null = null;
        let preparedReviewCardDirect: ApplicationReviewCard | null = null;
        const applyFlowInputDirect = {
          ...applyFlowFactsDirect,
          onWaitingForBrowserTab: () =>
            persistApplicationWaitingForBrowserTab({
              repository: ctx.repository,
              resultId: markedResult.id,
              runId: claim.runId,
              jobId: jobId,
            }),
          prepareApplicationForm: createApplyFormPreparer({
            executionInput: applyFlowFactsDirect,
            applicationRecordId: selectedApplicationRecord.id,
            searchPreferences,
            aiClient: ctx.aiClient,
            onProgress: (progress) =>
              persistApplicationPreparationProgress({
                repository: ctx.repository,
                resultId: markedResult.id,
                runId: claim.runId,
                jobId,
                progress,
              }),
            ...(activeEnvelopeDirect ? { envelope: activeEnvelopeDirect } : {}),
            onPrepared: ({ handoff, reviewCard }) => {
              preparedHandoffDirect = handoff;
              preparedReviewCardDirect = reviewCard;
            },
            letters: buildApplyLetterDependencies({
              aiClient: ctx.aiClient,
              documentManager: ctx.documentManager,
              job: applyFlowFactsDirect.job,
              profile: applyFlowFactsDirect.profile,
              settings: applyFlowFactsDirect.settings,
              searchPreferences,
            }),
            siteLabel: resolveApplySiteLabel({
              targetLabel: provenanceTarget?.label ?? null,
              applicationUrl:
                currentJob.applicationUrl ?? currentJob.canonicalUrl,
            }),
          }),
        };
        const executionResult = describeApplicationPreparation(
          enforceResolvedApplyAuthorityResult(
            applyAuthorityDirect.authority,
            await ctx.browserRuntime.executeApplicationFlow(
              currentJob.source,
              applyFlowInputDirect,
              { signal: claim.controller.signal },
            ),
          ),
        );
        await assertPreparationProfileCurrent(ctx, prerequisites);
        await assertDirectApplyExecutionCanContinue(claim);
        const detectedAt = new Date().toISOString();
        const sourceDebugEvidenceRefIds = buildEvidenceRefIdsFromInstruction({
          activeInstruction,
          sourceDebugAttempts,
        });
        const questions = executionResult.questions.map((question) =>
          ApplicationAttemptQuestionSchema.parse(question),
        );
        const consentDecisions = executionResult.consentDecisions.map(
          (decision) => ApplicationAttemptConsentDecisionSchema.parse(decision),
        );
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
        const attempt = ApplicationAttemptSchema.parse({
          id: `attempt_${jobId}_${Date.now()}`,
          jobId,
          applicationRecordId: selectedApplicationRecord.id,
          state: executionResult.state,
          summary: executionResult.summary,
          detail: executionResult.detail,
          startedAt: executionResult.checkpoints[0]?.at ?? detectedAt,
          updatedAt: detectedAt,
          completedAt:
            executionResult.state === "in_progress" ? null : detectedAt,
          outcome: executionResult.outcome,
          checkpoints: executionResult.checkpoints,
          questions,
          blocker,
          consentDecisions,
          replay,
          visualEvidence: executionResult.visualEvidence,
          visualObservationSets: executionResult.visualObservationSets,
          visualCheckpoints: executionResult.visualCheckpoints,
          nextActionLabel: executionResult.nextActionLabel,
          executionTimings: executionResult.executionTimings,
          agentTiming: executionResult.agentTiming,
        });
        const runArtifacts = buildApplyCopilotArtifacts({
          existingAnswerRecords:
            await ctx.repository.listApplicationAnswerRecords({
              applicationRecordId: selectedApplicationRecord.id,
            }),
          applicationRecordId: selectedApplicationRecord.id,
          job,
          resumeArtifact,
          executionResult: {
            ...executionResult,
            blocker,
            replay,
          },
          detectedAt,
          runId: claim.runId,
          resultId: claim.resultId,
          reviewCard: await reviewCardForFreshPreparation(
            selectedApplicationRecord.id,
            preparedReviewCardDirect,
          ),
          visualCheckpointsEnabled: options?.visualCheckpointsEnabled === true,
        });
        const persistedRun = ApplyRunSchema.parse({
          ...runArtifacts.run,
          campaignId: capturedCampaignId,
          // The terminal artifacts are built after the browser finishes. Keep
          // the durable start timestamp written before the browser opened.
          createdAt: directRunStartedAt,
        });
        const persistedResult = ApplyJobResultSchema.parse({
          ...runArtifacts.result,
          // Progress and duration are anchored to the durable result that was
          // staged before preparation, not the first model checkpoint.
          startedAt: markedResult.startedAt,
          applicationPreparationStartedAt:
            markedResult.applicationPreparationStartedAt,
          applicationPreparationStartedLocalDate:
            markedResult.applicationPreparationStartedLocalDate,
        });

        await withApplyRunTransition(claim.runId, async () => {
          await assertDirectApplyTerminalTransitionIsOpen(claim);
          await ctx.repository.upsertApplicationAttempt(attempt);
          await Promise.all([
            ctx.repository.upsertApplyRun(persistedRun),
            ctx.repository.upsertApplyJobResult(persistedResult),
            ...runArtifacts.questionRecords.map((record) =>
              ctx.repository.upsertApplicationQuestionRecord(record),
            ),
            ...runArtifacts.answerRecords.map((record) =>
              ctx.repository.upsertApplicationAnswerRecord(record),
            ),
            ...runArtifacts.artifactRefs.map((ref) =>
              ctx.repository.upsertApplicationArtifactRef(ref),
            ),
            ...runArtifacts.checkpoints.map((checkpoint) =>
              ctx.repository.upsertApplicationReplayCheckpoint(checkpoint),
            ),
            ...runArtifacts.consentRequests.map((request) =>
              ctx.repository.upsertApplicationConsentRequest(request),
            ),
          ]);

          await withExactApplicationRecordTransition(
            selectedApplicationRecord.id,
            jobId,
            async () => {
              const applicationRecords =
                await ctx.repository.listApplicationRecords();
              const existingRecord = applicationRecords.find(
                (record) => record.id === selectedApplicationRecord.id,
              );
              if (!existingRecord) {
                throw new Error(
                  `Unknown Job Finder application record '${selectedApplicationRecord.id}'.`,
                );
              }
              const nextRecord = ApplicationRecordSchema.parse({
                id: existingRecord.id,
                jobId,
                title: job.title,
                company: job.company,
                status: nextJobStatusFromAttempt(job, executionResult.state),
                lastActionLabel: executionResult.summary,
                nextActionLabel: executionResult.nextActionLabel,
                lastUpdatedAt: detectedAt,
                lastAttemptState: executionResult.state,
                questionSummary: buildQuestionSummary(attempt.questions),
                latestBlocker: buildLatestBlockerSummary(attempt.blocker),
                consentSummary: buildConsentSummary(attempt.consentDecisions),
                replaySummary: buildReplaySummary(
                  attempt.replay,
                  attempt.visualEvidence,
                ),
                // The mode this run actually worked under, so "Ask before
                // sending" offers its Send control (the batch loop already
                // recorded this; the one-press path left the default).
                automationMode: applyAuthorityDirect.authority.mode,
                crm: existingRecord.crm,
                events: mergeEvents(
                  existingRecord.events,
                  toApplicationEvents(job, executionResult.checkpoints),
                ),
              });

              await ctx.repository.upsertApplicationRecord(nextRecord);
            },
          );
          await ctx.repository.commitSavedJobDelta({
            updateJobIds: [jobId],
            update: (savedJob) =>
              savedJob.id === jobId
                ? SavedJobSchema.parse({
                    ...savedJob,
                    status: nextJobStatusFromAttempt(
                      savedJob,
                      executionResult.state,
                    ),
                  })
                : savedJob,
          });
          await persistApplicationUserAction({
            repository: ctx.repository,
            applicationRecordId: selectedApplicationRecord.id,
            job,
            runId: persistedRun.id,
            resultId: runArtifacts.result.id,
            resultState: runArtifacts.result.state,
            resultStartedAt: runArtifacts.result.startedAt,
            replayCheckpointId: runArtifacts.checkpoints.at(-1)?.id ?? null,
            blocker,
            questions: runArtifacts.questionRecords,
            occurredAt: detectedAt,
          });
        });
        await handApplicationPageToPersonForAccessStep({
          browserRuntime: ctx.browserRuntime,
          source: job.source,
          resultId: runArtifacts.result.id,
          blocker,
        });

        await persistAutomaticApplicationSafeguards({
          ctx,
          run: persistedRun,
          result: runArtifacts.result,
          job,
          now: detectedAt,
        }).catch((safeguardError: unknown) => {
          console.error(
            "Failed to persist automatic application safeguards.",
            safeguardError,
          );
        });

        // Sending happens after the preparation is on record, the same way a
        // batch does it; only a permission that covers this exact application
        // ever reaches the send.
        const sent = await sendPreparedApplicationIfAllowed({
          ctx,
          handoff: preparedHandoffDirect,
          envelope: activeEnvelopeDirect,
          source: currentJob.source,
          lineage: {
            runId: persistedRun.id,
            jobId,
            resultId: runArtifacts.result.id,
            applicationRecordId: selectedApplicationRecord.id,
            campaignId: persistedRun.campaignId ?? null,
          },
          resumeArtifact,
          siteLabel: resolveApplySiteLabel({
            targetLabel: provenanceTarget?.label ?? null,
            applicationUrl:
              currentJob.applicationUrl ?? currentJob.canonicalUrl,
          }),
          signal: claim.controller.signal,
        }).catch((sendError: unknown) => {
          console.error("Failed to send the prepared application.", sendError);
          return notSentAfterError(sendError);
        });
        await recordPreparedApplicationNotSent({
          repository: ctx.repository,
          lineage: {
            runId: persistedRun.id,
            jobId,
            resultId: runArtifacts.result.id,
            applicationRecordId: selectedApplicationRecord.id,
            campaignId: persistedRun.campaignId ?? null,
          },
          attempt: sent,
        }).catch(() => undefined);
        if (sent) {
          const sentAt = new Date().toISOString();
          if (sent.confirmedSubmitted) {
            await ctx.repository.upsertApplyRun(
              ApplyRunSchema.parse({
                ...persistedRun,
                state: "completed",
                currentJobId: null,
                updatedAt: sentAt,
                completedAt: sentAt,
                summary: sent.summary,
                detail: sent.detail,
                pendingJobs: 0,
                submittedJobs: 1,
                blockedJobs: 0,
                failedJobs: 0,
              }),
            );
          }
          const currentRecord = (
            await ctx.repository.listApplicationRecords()
          ).find((record) => record.id === selectedApplicationRecord.id);
          if (currentRecord) {
            await syncRunApplicationRecord({
              applicationRecordId: currentRecord.id,
              consentSummary: currentRecord.consentSummary,
              eventDetail: sent.detail,
              eventEmphasis: sent.confirmedSubmitted ? "positive" : "warning",
              eventId: `event_${persistedRun.id}_${jobId}_sent_${Date.now()}`,
              eventTitle: sent.summary,
              jobId,
              lastActionLabel: sent.summary,
              lastAttemptState: sent.confirmedSubmitted
                ? "submitted"
                : currentRecord.lastAttemptState,
              latestBlocker: currentRecord.latestBlocker,
              nextActionLabel: sent.nextActionLabel,
              questionSummary: currentRecord.questionSummary,
              replaySummary: currentRecord.replaySummary,
              updatedAt: sentAt,
            });
          }
        }

        return ctx.getWorkspaceSnapshot();
      });
    },
    async startAutoApplyRun(jobId, applicationRecordId?: string | null) {
      const prerequisites = await resolveJobApplyPrerequisites(jobId);
      const { job } = prerequisites;
      const selectedApplicationRecord = await resolveApplicationRecordForJob({
        repository: ctx.repository,
        job,
        ...(applicationRecordId !== undefined ? { applicationRecordId } : {}),
      });
      const capturedCampaignId = await ctx.getActiveCampaignId();

      const createdAt = new Date().toISOString();
      const runArtifacts = buildSingleJobAutoApplyArtifacts({
        applicationRecordId: selectedApplicationRecord.id,
        createdAt,
        job,
      });
      const persistedRun = ApplyRunSchema.parse({
        ...runArtifacts.run,
        campaignId: capturedCampaignId,
      });

      await assertCurrentResumeProfile(
        ctx,
        prerequisites.profileRevision,
        "staging this automatic application run",
      );
      await Promise.all([
        ctx.repository.upsertApplyRun(persistedRun),
        ctx.repository.upsertApplyJobResult(runArtifacts.result),
        ctx.repository.upsertApplySubmitApproval(runArtifacts.approval),
      ]);

      await withExactApplicationRecordTransition(
        selectedApplicationRecord.id,
        jobId,
        async () => {
          const applicationRecords =
            await ctx.repository.listApplicationRecords();
          const existingRecord = applicationRecords.find(
            (record) => record.id === selectedApplicationRecord.id,
          );
          if (!existingRecord) {
            throw new Error(
              `Unknown Job Finder application record '${selectedApplicationRecord.id}'.`,
            );
          }
          const nextRecord = ApplicationRecordSchema.parse({
            ...existingRecord,
            id: existingRecord.id,
            jobId,
            title: job.title,
            company: job.company,
            status: job.status,
            lastActionLabel: persistedRun.summary,
            nextActionLabel: "Watch it in Applications.",
            lastUpdatedAt: createdAt,
            lastAttemptState: existingRecord.lastAttemptState,
            questionSummary: existingRecord.questionSummary,
            latestBlocker: existingRecord.latestBlocker,
            consentSummary: existingRecord.consentSummary,
            replaySummary: existingRecord.replaySummary,
            crm: existingRecord.crm,
            events: mergeEvents(existingRecord.events, [
              {
                id: `event_${persistedRun.id}_awaiting_submit_approval`,
                at: createdAt,
                title: "Application preparation approval requested",
                detail:
                  "Your review permits opening and filling this application only. It never permits submission.",
                emphasis: "warning",
              },
            ]),
          });

          await ctx.repository.upsertApplicationRecord(nextRecord);
        },
      );

      return ctx.getWorkspaceSnapshot();
    },
    async startAutoApplyQueueRun(
      jobIds,
      capacityToken,
      applicationAutomationMode,
    ) {
      const verifiedJobIds = new Set(
        (await ctx.repository.listApplyJobResults())
          .filter(hasVerifiedApplicationSubmission)
          .map((result) => result.jobId),
      );
      const uniqueJobIds = uniqueStrings(jobIds).filter(
        (id) => !verifiedJobIds.has(id),
      );
      if (jobIds.length > 0 && uniqueJobIds.length === 0)
        return ctx.getWorkspaceSnapshot();

      if (uniqueJobIds.length === 0) {
        throw new Error(
          "At least one job is required before starting an automatic apply queue.",
        );
      }

      // Shared staging inputs are read once for the whole batch; each job
      // still gets its own draft/export lookup, omission-review decision,
      // template validation, and artifact hash verification.
      const [
        scopedSavedJobs,
        scopedTailoredAssets,
        scopedProfileState,
        scopedSettings,
      ] = await Promise.all([
        ctx.repository.listSavedJobs(),
        ctx.repository.listTailoredAssets(),
        ctx.repository.getProfileWithRevision(),
        ctx.repository.getSettings(),
      ]);
      const jobs = await Promise.all(
        uniqueJobIds.map(
          async (jobId) =>
            (
              await resolveJobApplyPrerequisites(jobId, scopedSavedJobs, {
                tailoredAssets: scopedTailoredAssets,
                profile: scopedProfileState.profile,
                profileRevision: scopedProfileState.revision,
                settings: scopedSettings,
              })
            ).job,
        ),
      );
      const selectedApplicationRecords = await Promise.all(
        jobs.map((job) =>
          resolveApplicationRecordForJob({ repository: ctx.repository, job }),
        ),
      );
      const applicationRecordIdByJobId = new Map(
        selectedApplicationRecords.map((record) => [record.jobId, record.id]),
      );
      const getApplicationRecordId = (jobId: string): string => {
        const id = applicationRecordIdByJobId.get(jobId);
        if (!id) {
          throw new Error(
            `Missing resolved application record for job '${jobId}'.`,
          );
        }
        return id;
      };
      const createdAt = new Date().toISOString();
      const effectiveApplicationAutomationMode =
        applicationAutomationMode ??
        scopedSettings.applicationAutomationMode ??
        "prepare_only";
      if (effectiveApplicationAutomationMode === "autonomous_submit") {
        const overlap = await checkSameCompanySends({
          repository: ctx.repository,
          jobIds: uniqueJobIds,
          transition: ctx.withIntelligenceTransition.bind(ctx),
        });
        if (overlap) throw new Error(overlap);
      }
      const capturedCampaignId = await ctx.getActiveCampaignId();
      const runId = createUniqueId("apply_run");
      const approvalId = createUniqueId("apply_submit_approval");
      // Approval is per batch of named jobs (ADR 0012). Retrying the jobs
      // that failed out of a batch the person already approved is the same
      // decision, not a new one; asking again for each recovery is what made
      // a twelve-job batch demand twelve more approvals. Reuse can never
      // widen scope: every job here was named in the original approval, the
      // plan is unchanged, and nothing is submitted either way.
      const [existingApprovals, existingApplyRuns] = await Promise.all([
        ctx.repository.listApplySubmitApprovals(),
        ctx.repository.listApplyRuns(),
      ]);
      const reuse = selectReusableBatchApproval({
        approvals: existingApprovals,
        jobIds: uniqueJobIds,
        campaignId: capturedCampaignId,
        unfinishedApprovalRunIds: new Set(
          existingApplyRuns
            .filter((candidate) => candidate.state !== "completed")
            .map((candidate) => candidate.id),
        ),
        now: createdAt,
      });
      const inheritedApproval = reuse.approval;
      const authorityApproval = reuse.authorityApproval;
      const run = ApplyRunSchema.parse({
        id: runId,
        campaignId: capturedCampaignId,
        mode: "queue_auto",
        state: inheritedApproval
          ? "paused_for_user_review"
          : "awaiting_submit_approval",
        jobIds: uniqueJobIds,
        currentJobId: uniqueJobIds[0] ?? null,
        submitApprovalId: approvalId,
        createdAt,
        updatedAt: createdAt,
        completedAt: null,
        summary: inheritedApproval
          ? `${uniqueJobIds.length} ${uniqueJobIds.length === 1 ? "job was" : "jobs were"} queued for another attempt.`
          : `Working through ${uniqueJobIds.length} ${uniqueJobIds.length === 1 ? "application" : "applications"}.`,
        detail:
          effectiveApplicationAutomationMode === "autonomous_submit"
            ? "Job Finder fills each one in and sends it when the employer's form is complete, inside the limits you set."
            : effectiveApplicationAutomationMode === "confirm_before_submit"
              ? "Job Finder fills each one in and stops at the send button so you can read it over and send it."
              : "Job Finder fills each one in and leaves it open for you to send.",
        totalJobs: uniqueJobIds.length,
        pendingJobs: uniqueJobIds.length,
        submittedJobs: 0,
        skippedJobs: 0,
        blockedJobs: 0,
        failedJobs: 0,
      });
      const approval = ApplySubmitApprovalSchema.parse({
        id: approvalId,
        runId,
        mode: "queue_auto",
        jobIds: uniqueJobIds,
        status: inheritedApproval ? "approved" : "pending",
        createdAt,
        approvedAt: authorityApproval?.approvedAt ?? null,
        revokedAt: null,
        expiresAt: authorityApproval?.expiresAt ?? null,
        batchId: inheritedApproval?.batchId ?? createUniqueId("apply_batch"),
        batchCampaignId: capturedCampaignId,
        reusedFromApprovalId: inheritedApproval?.id ?? null,
        detail: inheritedApproval
          ? "These jobs are part of a batch you already started, so Job Finder is not asking again. Whether it sends each application is the mode you chose in Settings."
          : "This covers only the jobs in this batch. Whether Job Finder sends each application is the mode you chose in Settings.",
      });
      const results = jobs.map((job, index) =>
        ApplyJobResultSchema.parse({
          id: createUniqueId("apply_result"),
          runId,
          jobId: job.id,
          applicationRecordId: getApplicationRecordId(job.id),
          queuePosition: index,
          state: "planned",
          summary: inheritedApproval
            ? "Waiting its turn in the batch you approved."
            : "Waiting for you to approve this batch.",
          detail: inheritedApproval
            ? "This job was named in the batch you already approved, so Job Finder works on it without asking again. Whether it sends the application follows the mode you chose in Settings."
            : "Job Finder prepares nothing for this job until you approve this batch.",
          startedAt: createdAt,
          updatedAt: createdAt,
          completedAt: null,
          applicationPreparationStartedAt: null,
          applicationPreparationStartedLocalDate: null,
          blockerReason: null,
          blockerSummary: null,
          latestQuestionCount: 0,
          latestAnswerCount: 0,
          pendingConsentRequestCount: 0,
          artifactCount: 0,
          latestCheckpointId: null,
        }),
      );

      await assertCurrentResumeProfile(
        ctx,
        scopedProfileState.revision,
        "staging this automatic application queue",
      );
      if (inheritedApproval) {
        // The same clearance the explicit approval path performs. Reuse skips
        // the second question, never the safety checks.
        await requireApplicationSafeguardClearance(uniqueJobIds);
      }
      await Promise.all([
        ctx.repository.upsertApplyRun(run),
        ctx.repository.upsertApplySubmitApproval(approval),
        ...results.map((result) => ctx.repository.upsertApplyJobResult(result)),
        ...jobs.map((job) =>
          syncRunApplicationRecord({
            applicationRecordId: getApplicationRecordId(job.id),
            eventDetail: inheritedApproval
              ? `This job is covered by the batch approval you already gave (${approval.batchId ?? "this batch"}). Job Finder follows the application mode chosen in Settings.`
              : "A batch of applications was staged for this job. Job Finder follows the application mode chosen in Settings.",
            eventEmphasis: "warning",
            eventId: `event_${runId}_${job.id}_queue_staged`,
            eventTitle: inheritedApproval
              ? "Covered by your batch approval"
              : "Automatic apply preparation staged",
            jobId: job.id,
            lastActionLabel: run.summary,
            nextActionLabel: inheritedApproval
              ? "Job Finder is preparing this job now."
              : "Review the prepared run approval in Applications.",
            updatedAt: createdAt,
          }),
        ),
      ]);

      if (inheritedApproval) {
        // The reused-approval batch is persisted in a paused state before it
        // starts. If anything refuses it after that point the run must not be
        // left parked there: the Tasks card would go on offering "Prepare
        // remaining jobs", every further click would park another paused run,
        // and nothing on screen would ever say why nothing moved. Close the
        // run with the plain reason instead, and hand the same sentence back.
        try {
          await requireApplyActivityEnabled();
          await executeSafeApplyRun(
            { mode: "queue_auto", runId },
            capacityToken,
          );
        } catch (error) {
          await closeUnstartedBatchRun(runId, error);
          throw error;
        }
      }

      return ctx.getWorkspaceSnapshot();
    },
    async approveApplyRun(
      runId,
      capacityToken?: ApplicationPreparationCapacityToken,
    ) {
      const mode = await withApplyRunTransition(runId, async () => {
        await requireApplyActivityEnabled();
        const [runs, approvals, results] = await Promise.all([
          ctx.repository.listApplyRuns(),
          ctx.repository.listApplySubmitApprovals(),
          ctx.repository.listApplyJobResults({ runId }),
        ]);
        const run = runs.find((entry) => entry.id === runId) ?? null;

        if (!run) {
          throw new Error(`Unknown apply run '${runId}'.`);
        }

        if (run.mode !== "single_job_auto" && run.mode !== "queue_auto") {
          throw new Error(
            `Apply run '${runId}' is not waiting on submit approval.`,
          );
        }

        // Cancellation owns the terminal state when it wins the transition
        // race. Approval becomes a no-op and must never relaunch browser work.
        if (run.state === "cancelled") {
          return null;
        }

        if (run.state !== "awaiting_submit_approval") {
          throw new Error(
            `Apply run '${runId}' is not currently awaiting submit approval.`,
          );
        }

        if (!run.submitApprovalId) {
          throw new Error(
            `Apply run '${runId}' does not have a submit approval record.`,
          );
        }

        const approval =
          approvals.find((entry) => entry.id === run.submitApprovalId) ?? null;

        if (!approval) {
          throw new Error(
            `Missing submit approval '${run.submitApprovalId}' for run '${runId}'.`,
          );
        }

        if (approval.status !== "pending") {
          throw new Error(
            `Submit approval for run '${runId}' is already ${approval.status}.`,
          );
        }

        await requireApplicationSafeguardClearance(run.jobIds);

        const now = new Date().toISOString();
        const updatedApproval = ApplySubmitApprovalSchema.parse({
          ...approval,
          status: "approved",
          approvedAt: now,
          revokedAt: null,
          detail:
            "This batch is on. Whether Job Finder sends each application is the mode you chose in Settings.",
        });
        const updatedRun = ApplyRunSchema.parse({
          ...run,
          state: "paused_for_user_review",
          updatedAt: now,
          summary: "Your approval is recorded for this batch.",
          detail:
            "Job Finder is working through the jobs in this batch. Whether it sends each application is the mode you chose in Settings.",
        });
        const updatedResults = results.map((result) =>
          result.state === "planned"
            ? ApplyJobResultSchema.parse({
                ...result,
                updatedAt: now,
                summary: "Waiting its turn in this run.",
                detail:
                  "This job is in the approved batch. Job Finder follows the application mode chosen in Settings when its turn starts.",
              })
            : result,
        );

        await Promise.all([
          ctx.repository.upsertApplySubmitApproval(updatedApproval),
          ctx.repository.upsertApplyRun(updatedRun),
          ...updatedResults.map((result) =>
            ctx.repository.upsertApplyJobResult(result),
          ),
        ]);
        return run.mode;
      });

      if (mode === null) {
        return ctx.getWorkspaceSnapshot();
      }

      await requireApplyActivityEnabled();
      await executeSafeApplyRun(
        {
          mode,
          runId,
        },
        capacityToken,
      );

      return ctx.getWorkspaceSnapshot();
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
      const jobs = await ctx.repository.listSavedJobs();
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
    async resolveApplyConsentRequest(
      requestId,
      action,
      capacityToken?: ApplicationPreparationCapacityToken,
    ) {
      return withConsentResolution(requestId, async () => {
        await requireApplyActivityEnabled();
        const [requests, runs, results] = await Promise.all([
          ctx.repository.listApplicationConsentRequests(),
          ctx.repository.listApplyRuns(),
          ctx.repository.listApplyJobResults(),
        ]);
        const request =
          requests.find((entry) => entry.id === requestId) ?? null;

        if (!request) {
          throw new Error(`Unknown consent request '${requestId}'.`);
        }

        if (request.status !== "pending") {
          throw new Error(
            `Consent request '${requestId}' is already ${request.status}.`,
          );
        }
        if (!request.applicationRecordId) {
          throw new Error(
            `Consent request '${requestId}' has legacy application lineage and is non-actionable.`,
          );
        }
        const requestResults = results.filter(
          (result) =>
            result.runId === request.runId &&
            result.jobId === request.jobId &&
            result.applicationRecordId === request.applicationRecordId,
        );
        if (
          requestResults.length !== 1 ||
          request.resultId !== requestResults[0]?.id
        ) {
          throw new Error(
            `Consent request '${requestId}' no longer matches its exact apply result.`,
          );
        }

        const run = runs.find((entry) => entry.id === request.runId) ?? null;

        if (!run) {
          throw new Error(
            `Unknown apply run '${request.runId}' for consent request '${requestId}'.`,
          );
        }

        if (
          run.state !== "paused_for_consent" &&
          run.state !== "paused_for_user_review" &&
          run.state !== "running"
        ) {
          throw new Error(
            `Consent request '${requestId}' cannot be resolved because run '${run.id}' is ${run.state}.`,
          );
        }

        const pendingJobs = run.jobIds.filter((jobId) => {
          if (jobId === request.jobId) return false;
          const result = results.find(
            (entry) => entry.runId === run.id && entry.jobId === jobId,
          );
          return !result || result.state === "planned";
        });
        const jobsThatWillContinue =
          action === "approve" ? [request.jobId, ...pendingJobs] : pendingJobs;
        if (jobsThatWillContinue.length > 0) {
          await requireApplicationSafeguardClearance(jobsThatWillContinue);
        }

        type ConsentResolutionOutcome = {
          relaunchMode: "single_job_auto" | "queue_auto" | null;
          safeguards: {
            run: ReturnType<typeof ApplyRunSchema.parse>;
            result: ReturnType<typeof ApplyJobResultSchema.parse>;
          } | null;
        };

        // The final run/result/request writes are serialized under the run
        // transition and every input is re-read inside it, so a cancel that
        // won the race keeps its terminal state and a committing worker's
        // counters are never clobbered by stale snapshots. The browser
        // relaunch stays outside the transition.
        const outcome = await withApplyRunTransition(
          run.id,
          async (): Promise<ConsentResolutionOutcome> => {
            const [latestRequests, latestRuns, latestResults, latestApprovals] =
              await Promise.all([
                ctx.repository.listApplicationConsentRequests(),
                ctx.repository.listApplyRuns(),
                ctx.repository.listApplyJobResults(),
                ctx.repository.listApplySubmitApprovals(),
              ]);
            const latestRequest =
              latestRequests.find((entry) => entry.id === requestId) ?? null;

            if (!latestRequest || latestRequest.status !== "pending") {
              throw new Error(
                `Consent request '${requestId}' is already ${
                  latestRequest?.status ?? "resolved"
                }.`,
              );
            }
            if (!latestRequest.applicationRecordId) {
              throw new Error(
                `Consent request '${requestId}' has legacy application lineage and is non-actionable.`,
              );
            }
            const latestApplicationRecordId = latestRequest.applicationRecordId;

            const latestRun =
              latestRuns.find((entry) => entry.id === run.id) ?? null;

            if (!latestRun) {
              throw new Error(
                `Unknown apply run '${run.id}' for consent request '${requestId}'.`,
              );
            }

            if (
              latestRun.state !== "paused_for_consent" &&
              latestRun.state !== "paused_for_user_review" &&
              latestRun.state !== "running"
            ) {
              // Cancellation owns the terminal state when it wins the
              // transition race; this resolution must not resurrect the run.
              throw new Error(
                `Consent request '${requestId}' cannot be resolved because run '${latestRun.id}' is ${latestRun.state}.`,
              );
            }

            const now = new Date().toISOString();
            const decidedRequest = ApplicationConsentRequestSchema.parse({
              ...latestRequest,
              status: action === "approve" ? "approved" : "declined",
              decidedAt: now,
            });
            await ctx.repository.upsertApplicationConsentRequest(
              decidedRequest,
            );
            const otherPendingConsentCount = latestRequests.filter(
              (candidate) =>
                candidate.runId === latestRun.id &&
                candidate.id !== latestRequest.id &&
                candidate.status === "pending",
            ).length;
            const remainingJobs = latestRun.jobIds.filter((jobId) => {
              if (jobId === latestRequest.jobId) return false;
              const result = latestResults.find(
                (entry) =>
                  entry.runId === latestRun.id && entry.jobId === jobId,
              );
              return !result || result.state === "planned";
            });

            if (action === "decline") {
              const relatedResult = latestResults.find(
                (entry) =>
                  entry.runId === latestRequest.runId &&
                  entry.jobId === latestRequest.jobId &&
                  entry.applicationRecordId === latestApplicationRecordId,
              );

              if (relatedResult) {
                await ctx.repository.upsertApplyJobResult(
                  ApplyJobResultSchema.parse({
                    ...relatedResult,
                    state: "skipped",
                    summary: "Job skipped after consent was declined.",
                    detail:
                      "The queued run skipped this job because the required consent step was declined.",
                    updatedAt: now,
                    completedAt: now,
                    blockerReason: "signup_consent_required",
                    blockerSummary: "Consent was declined for this job.",
                    pendingConsentRequestCount: 0,
                  }),
                );
              }

              await releaseFinishedApplicationPages({
                ...ctx,
                jobId: latestRequest.jobId,
                runId: latestRun.id,
              });
              const awaitingReviewJobs = latestRun.jobIds.filter((jobId) => {
                if (jobId === latestRequest.jobId) return false;
                return latestResults.some(
                  (result) =>
                    result.runId === latestRun.id &&
                    result.jobId === jobId &&
                    result.state === "awaiting_review",
                );
              }).length;
              const blockedJobs = Math.max(0, latestRun.blockedJobs - 1);
              const nextState =
                remainingJobs.length > 0
                  ? "running"
                  : otherPendingConsentCount > 0
                    ? "paused_for_consent"
                    : awaitingReviewJobs > 0 || blockedJobs > 0
                      ? "paused_for_user_review"
                      : "completed";
              const updatedRun = ApplyRunSchema.parse({
                ...latestRun,
                state: nextState,
                updatedAt: now,
                completedAt: nextState === "completed" ? now : null,
                currentJobId: remainingJobs[0] ?? latestRequest.jobId,
                pendingJobs: remainingJobs.length + awaitingReviewJobs,
                skippedJobs: latestRun.skippedJobs + 1,
                blockedJobs,
                summary:
                  remainingJobs.length > 0
                    ? "Consent declined. The queue skipped this job and continued."
                    : otherPendingConsentCount > 0
                      ? `Consent declined for this job. ${otherPendingConsentCount} other consent ${otherPendingConsentCount === 1 ? "decision still needs" : "decisions still need"} you.`
                      : awaitingReviewJobs > 0 || blockedJobs > 0
                        ? "Consent declined for this job. Other prepared or blocked jobs remain available for review."
                        : "Consent declined. The queue finished after skipping the blocked job.",
                detail:
                  "The consent-gated job was skipped because consent was declined. The queue remains safe and non-submitting.",
              });
              await ctx.repository.upsertApplyRun(updatedRun);

              await withExactApplicationRecordTransition(
                latestApplicationRecordId,
                latestRequest.jobId,
                async () => {
                  const applicationRecords =
                    await ctx.repository.listApplicationRecords();
                  const existingRecord = applicationRecords.find(
                    (record) => record.id === latestRequest.applicationRecordId,
                  );

                  if (!existingRecord) {
                    return;
                  }

                  await ctx.repository.upsertApplicationRecord(
                    ApplicationRecordSchema.parse({
                      ...existingRecord,
                      status: existingRecord.status,
                      lastAttemptState: "paused",
                      latestBlocker: {
                        code: "missing_consent",
                        summary: "Consent was declined for this job.",
                      },
                      consentSummary: {
                        status: "declined",
                        pendingCount: 0,
                      },
                      lastActionLabel: updatedRun.summary,
                      nextActionLabel:
                        remainingJobs.length > 0
                          ? "The queue skipped this job after the declined consent."
                          : "Press Try again to have another go later.",
                      lastUpdatedAt: now,
                      events: mergeEvents(existingRecord.events, [
                        {
                          id: `event_${latestRun.id}_${latestRequest.jobId}_consent_declined`,
                          at: now,
                          title: "Consent declined",
                          detail:
                            "The consent-gated branch was declined, so this job was skipped without any final submit action.",
                          emphasis: "warning",
                        },
                      ]),
                    }),
                  );
                },
              );

              const approval =
                latestApprovals.find(
                  (entry) => entry.id === latestRun.submitApprovalId,
                ) ?? null;
              return {
                relaunchMode:
                  latestRun.mode === "queue_auto" &&
                  remainingJobs.length > 0 &&
                  approval?.status === "approved"
                    ? "queue_auto"
                    : null,
                safeguards: null,
              };
            }

            const relatedResult = latestResults.find(
              (entry) =>
                entry.runId === latestRequest.runId &&
                entry.jobId === latestRequest.jobId &&
                entry.applicationRecordId === latestApplicationRecordId,
            );
            const resumeUseContinues = latestRequest.kind === "resume_use";
            const resumeUseQueueContinues =
              resumeUseContinues && latestRun.mode !== "copilot";
            const resumeUseDirectRestart =
              resumeUseContinues && latestRun.mode === "copilot";
            const approvedResult = relatedResult
              ? ApplyJobResultSchema.parse({
                  ...relatedResult,
                  state: resumeUseQueueContinues
                    ? "planned"
                    : resumeUseDirectRestart
                      ? "failed"
                      : "awaiting_review",
                  summary: resumeUseContinues
                    ? "Resume approval recorded. Retrying application preparation."
                    : "Consent approved and the job stayed prepared for review.",
                  detail: resumeUseContinues
                    ? "The approved resume prerequisite is being checked again before Job Finder opens the live application form."
                    : "The consent-gated branch was approved. This safe build keeps the job in a review-ready state and still stops before final submit.",
                  updatedAt: now,
                  completedAt: resumeUseQueueContinues ? null : now,
                  blockerReason: null,
                  blockerSummary: null,
                  pendingConsentRequestCount: 0,
                })
              : null;
            if (approvedResult) {
              await ctx.repository.upsertApplyJobResult(approvedResult);
            }

            const awaitingReviewJobs = latestRun.jobIds.filter((jobId) => {
              if (jobId === latestRequest.jobId) return !resumeUseContinues;
              return latestResults.some(
                (result) =>
                  result.runId === latestRun.id &&
                  result.jobId === jobId &&
                  result.state === "awaiting_review",
              );
            }).length;
            const blockedJobs = Math.max(0, latestRun.blockedJobs - 1);
            const directRestartCounters =
              resumeUseDirectRestart && approvedResult
                ? deriveRecoveredApplyRunCounters(
                    latestResults.map((result) =>
                      result.id === approvedResult.id ? approvedResult : result,
                    ),
                    now,
                  )
                : null;
            const nextState = resumeUseQueueContinues
              ? "running"
              : resumeUseDirectRestart
                ? "completed"
                : remainingJobs.length > 0
                  ? "running"
                  : otherPendingConsentCount > 0
                    ? "paused_for_consent"
                    : "paused_for_user_review";

            const updatedRun = ApplyRunSchema.parse({
              ...latestRun,
              state: nextState,
              updatedAt: now,
              completedAt: resumeUseDirectRestart ? now : latestRun.completedAt,
              currentJobId: remainingJobs[0] ?? latestRequest.jobId,
              pendingJobs:
                remainingJobs.length +
                awaitingReviewJobs +
                (resumeUseQueueContinues ? 1 : 0),
              blockedJobs,
              ...(directRestartCounters ?? {}),
              summary: resumeUseContinues
                ? "Resume approval recorded. Retrying application preparation."
                : remainingJobs.length > 0
                  ? "Consent approved. The queue resumed in safe review mode."
                  : otherPendingConsentCount > 0
                    ? `Consent approved for this job. ${otherPendingConsentCount} other consent ${otherPendingConsentCount === 1 ? "decision still needs" : "decisions still need"} you.`
                    : "Consent approved. The job stayed prepared for review.",
              detail: resumeUseContinues
                ? "Job Finder is rechecking the approved resume and continuing the exact application run."
                : "The consent-gated job can continue in safe review mode, still without any final submit action.",
            });
            await ctx.repository.upsertApplyRun(updatedRun);

            // A consent decision can be the final transition that leaves an
            // automatic queue with only review-ready work. Persist the same
            // terminal safeguards here as the normal execution path does;
            // otherwise the prepared-batch sample is skipped when no remaining
            // job restarts the queue.
            const safeguards =
              approvedResult &&
              !resumeUseContinues &&
              updatedRun.state !== "running"
                ? { run: updatedRun, result: approvedResult }
                : null;

            await withExactApplicationRecordTransition(
              latestApplicationRecordId,
              latestRequest.jobId,
              async () => {
                const applicationRecords =
                  await ctx.repository.listApplicationRecords();
                const existingRecord = applicationRecords.find(
                  (record) => record.id === latestRequest.applicationRecordId,
                );

                if (!existingRecord) {
                  return;
                }

                await ctx.repository.upsertApplicationRecord(
                  ApplicationRecordSchema.parse({
                    ...existingRecord,
                    status: resumeUseContinues
                      ? existingRecord.status
                      : "ready_for_review",
                    lastAttemptState: resumeUseQueueContinues
                      ? "in_progress"
                      : resumeUseDirectRestart
                        ? "failed"
                        : "paused",
                    latestBlocker: null,
                    consentSummary: {
                      status: "approved",
                      pendingCount: 0,
                    },
                    lastActionLabel: resumeUseContinues
                      ? "Resume approval recorded. Retrying application preparation."
                      : latestRun.mode === "queue_auto" &&
                          remainingJobs.length > 0
                        ? "Consent approved. The queue resumed in safe review mode."
                        : "Consent approved. The job stayed prepared for review.",
                    nextActionLabel: resumeUseContinues
                      ? "Job Finder is reopening the live application form."
                      : latestRun.mode === "queue_auto" &&
                          remainingJobs.length > 0
                        ? "The queue continued with the remaining jobs."
                        : "Review the prepared application before any later execution step.",
                    lastUpdatedAt: now,
                    events: mergeEvents(existingRecord.events, [
                      {
                        id: `event_${latestRun.id}_${latestRequest.jobId}_consent_approved`,
                        at: now,
                        title: "Consent approved",
                        detail: resumeUseContinues
                          ? "The resume prerequisite was approved, so Job Finder continued the exact application run."
                          : "The consent-gated branch was approved. The current safe build still stops before final submit.",
                        emphasis: "positive",
                      },
                    ]),
                  }),
                );
              },
            );

            return {
              relaunchMode: resumeUseQueueContinues
                ? latestRun.mode === "queue_auto"
                  ? "queue_auto"
                  : "single_job_auto"
                : latestRun.mode === "queue_auto" && remainingJobs.length > 0
                  ? "queue_auto"
                  : null,
              safeguards,
            };
          },
        );

        if (outcome.safeguards) {
          await persistAutomaticApplicationSafeguards({
            ctx,
            run: outcome.safeguards.run,
            result: outcome.safeguards.result,
            job: null,
            now: new Date().toISOString(),
          }).catch((safeguardError: unknown) => {
            console.error(
              "Failed to persist automatic application safeguards.",
              safeguardError,
            );
          });
        }

        if (outcome.relaunchMode) {
          try {
            await requireApplyActivityEnabled();
            await executeSafeApplyRun(
              {
                mode: outcome.relaunchMode,
                runId: run.id,
              },
              capacityToken,
            );
          } catch (relaunchError) {
            // The transition already persisted `running`, but when the
            // relaunch fails before a worker takes over, nothing owns that
            // state and startup recovery would later misreport the ghost as
            // an app-closed run. A live execution for this run (a concurrent
            // resolution racing an active queue) owns the truthful running
            // state itself, so only an unowned run is parked.
            const ownedByLiveExecution =
              ctx.activeApplyRunAbortControllers.has(run.id) ||
              ctx.activeApplyRunPromises.has(run.id);
            if (!ownedByLiveExecution) {
              await withApplyRunTransition(run.id, async () => {
                const latestRuns = await ctx.repository.listApplyRuns();
                const latestRun =
                  latestRuns.find((entry) => entry.id === run.id) ?? null;
                // Cancellation or failure owns the terminal state when it
                // won the race; never resurrect or overwrite it.
                if (!latestRun || latestRun.state !== "running") {
                  return;
                }
                const pausedAt = new Date().toISOString();
                await ctx.repository.upsertApplyRun(
                  ApplyRunSchema.parse({
                    ...latestRun,
                    state: "paused_for_user_review",
                    updatedAt: pausedAt,
                    summary:
                      "Consent resolved, but the queue paused before continuing.",
                    detail:
                      relaunchError instanceof Error
                        ? relaunchError.message
                        : "The queue could not continue after this consent decision.",
                  }),
                );
              });
            }
            throw relaunchError;
          }
        }

        return ctx.getWorkspaceSnapshot();
      });
    },
    async inspectPreparedApplicationPage(input) {
      const [jobs, runs, results, records] = await Promise.all([
        ctx.repository.listSavedJobs(),
        ctx.repository.listApplyRuns(),
        ctx.repository.listApplyJobResults({ runId: input.runId }),
        ctx.repository.listApplicationRecords(),
      ]);
      const job = jobs.find((entry) => entry.id === input.jobId) ?? null;
      const run = runs.find((entry) => entry.id === input.runId) ?? null;
      const result =
        results.find(
          (entry) =>
            entry.id === input.resultId &&
            entry.jobId === input.jobId &&
            entry.applicationRecordId === input.applicationRecordId,
        ) ?? null;
      const record =
        records.find(
          (entry) =>
            entry.id === input.applicationRecordId &&
            entry.jobId === input.jobId,
        ) ?? null;
      if (!job || !run || !result || !record) {
        throw new Error(
          "This prepared application no longer matches the saved run. Try preparing it again.",
        );
      }
      if (
        result.state === "submitted" ||
        result.privacyReceipt?.submissionOutcome?.outcome ===
          "outcome_uncertain"
      ) {
        throw new Error(
          "This application already has a terminal submission outcome and cannot be reopened as a prepared form.",
        );
      }

      if (!["awaiting_review", "blocked"].includes(result.state)) {
        throw new Error(
          "This application is not waiting for inspection. Wait for its preparation to finish.",
        );
      }
      if (
        !ctx.browserRuntime.closeApplicationFormAction ||
        !ctx.browserRuntime.readApplicationPageBinding
      ) {
        throw new Error(
          "Guarded inspection of the retained application is unavailable.",
        );
      }
      await ctx.browserRuntime.closeApplicationFormAction(
        job.source,
        result.id,
      );
      return ctx.browserRuntime.readApplicationPageBinding(
        job.source,
        result.id,
      );
    },
    async focusPreparedApplicationPage(input) {
      const [jobs, runs, results, records] = await Promise.all([
        ctx.repository.listSavedJobs(),
        ctx.repository.listApplyRuns(),
        ctx.repository.listApplyJobResults({ runId: input.runId }),
        ctx.repository.listApplicationRecords(),
      ]);
      const job = jobs.find((entry) => entry.id === input.jobId) ?? null;
      const run = runs.find((entry) => entry.id === input.runId) ?? null;
      const result =
        results.find(
          (entry) =>
            entry.id === input.resultId &&
            entry.jobId === input.jobId &&
            entry.applicationRecordId === input.applicationRecordId,
        ) ?? null;
      const record =
        records.find(
          (entry) =>
            entry.id === input.applicationRecordId &&
            entry.jobId === input.jobId,
        ) ?? null;
      if (!job || !run || !result || !record) {
        throw new Error(
          "This prepared application no longer matches the saved run. Try preparing it again.",
        );
      }
      if (
        result.state === "submitted" ||
        result.privacyReceipt?.submissionOutcome?.outcome ===
          "outcome_uncertain"
      ) {
        throw new Error(
          "This application already has a terminal submission outcome and cannot be reopened as a prepared form.",
        );
      }

      const focused =
        (await ctx.browserRuntime.focusApplicationPageBinding?.(
          job.source,
          result.id,
        )) === true;
      if (focused && result.state === "awaiting_review") {
        // The person opened a filled-in form to read it over and send it
        // themselves; the prepare-only guard must not cancel their own press.
        await ctx.browserRuntime
          .handApplicationPageToPerson?.(job.source, result.id)
          .catch(() => undefined);
      }
      if (!focused) {
        const occurredAt = new Date().toISOString();
        await terminalizeApplicationAfterPreparedPageLost({
          repository: ctx.repository,
          runId: run.id,
          jobId: job.id,
          applicationRecordId: record.id,
          resultId: result.id,
          occurredAt,
          eventId: `event_missing_prepared_page_${result.id}`,
        });
      }
      return ctx.getWorkspaceSnapshot();
    },
    async refreshApprovedApplicationLetter(document) {
      await refreshApprovedApplicationLetter(ctx, document, async () => {
        const facts = await resolveJobApplyPrerequisites(document.job.jobId);
        const settings = await ctx.repository.getSettings();
        const intermediate = await buildIntermediateMutationExecutionOptions({
          job: facts.job,
          resumeArtifact: facts.resumeArtifact,
        });
        return {
          job: facts.job,
          profile: facts.profile,
          resumeArtifact: facts.resumeArtifact,
          settings,
          mode: "prepare_only",
          ...intermediate,
        };
      });
    },
    /**
     * Sends one application the person already looked over.
     *
     * The confirm-first half of sending. Everything that makes a submission
     * safe is the same as an automatic one — the saved permission is reread,
     * the preflight is written before anything happens, and one key allows one
     * attempt — so pressing this twice, or pressing it after the run already
     * sent it, cannot send a second application.
     */
    async submitPreparedApplication(jobId) {
      await requireApplyActivityEnabled();
      const prerequisites = await resolveJobApplyPrerequisites(jobId);
      const { job, resumeArtifact } = prerequisites;
      const [runs, results, records] = await Promise.all([
        ctx.repository.listApplyRuns(),
        ctx.repository.listApplyJobResults({ jobId }),
        ctx.repository.listApplicationRecords(),
      ]);

      const result = [...results]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .at(0);
      const run = result
        ? (runs.find((entry) => entry.id === result.runId) ?? null)
        : null;
      const applicationRecordId = result?.applicationRecordId ?? null;
      if (!result || !run || !applicationRecordId) {
        throw new Error(
          "This application has not been prepared yet, so there is nothing to send.",
        );
      }

      const applicationRecord =
        records.find((entry) => entry.id === applicationRecordId) ?? null;
      const authority = await resolveApplyAuthorityForJob({
        repository: ctx.repository,
        job: { id: job.id, campaignId: run.campaignId ?? null },
        resumeSha256: resumeArtifact.sha256,
        applicationUrl: job.applicationUrl ?? job.canonicalUrl,
        now: new Date().toISOString(),
      });
      const notSentLineage = {
        runId: run.id,
        jobId: job.id,
        resultId: result.id,
        applicationRecordId,
        campaignId: run.campaignId ?? null,
      };
      if (!authority.envelope) {
        const message =
          "You have not allowed Job Finder to send this application. Open it and send it yourself.";
        await recordPreparedApplicationNotSent({
          repository: ctx.repository,
          lineage: notSentLineage,
          attempt: notSentAttempt("no permission to send it", message),
        }).catch(() => undefined);
        throw new Error(message);
      }

      const siteLabel = resolveApplySiteLabel({
        targetLabel: null,
        applicationUrl: job.applicationUrl ?? job.canonicalUrl,
      });
      const sent = await sendPreparedApplicationIfAllowed({
        ctx,
        // The person pressing the button is the confirmation, so this is the
        // same handoff an automatic run produces.
        handoff: {
          status: "send_now",
          finalAction: { actionRef: "", actionLabel: "Submit application" },
          envelope: authority.envelope,
          confirmedByPerson: true,
        },
        envelope: authority.envelope,
        source: job.source,
        lineage: {
          runId: run.id,
          jobId: job.id,
          resultId: result.id,
          applicationRecordId,
          campaignId: run.campaignId ?? null,
        },
        resumeArtifact,
        siteLabel,
      }).catch(async (sendError: unknown) => {
        await recordPreparedApplicationNotSent({
          repository: ctx.repository,
          lineage: notSentLineage,
          attempt: notSentAfterError(sendError),
        }).catch(() => undefined);
        throw sendError;
      });

      await recordPreparedApplicationNotSent({
        repository: ctx.repository,
        lineage: notSentLineage,
        attempt: sent,
      });

      // A page the browser let go of is recorded as such, so the review can
      // say so and offer to prepare it again.
      if (sent?.pageClosed && applicationRecord) {
        await syncRunApplicationRecord({
          applicationRecordId,
          consentSummary: applicationRecord.consentSummary,
          eventDetail: sent.detail,
          eventEmphasis: "warning",
          eventId: `event_${run.id}_${job.id}_page_closed_${Date.now()}`,
          eventTitle: sent.summary,
          jobId: job.id,
          lastActionLabel: sent.summary,
          lastAttemptState: sent.sent
            ? "submitted"
            : applicationRecord.lastAttemptState,
          latestBlocker: applicationRecord.latestBlocker,
          nextActionLabel: sent.nextActionLabel,
          questionSummary: applicationRecord.questionSummary,
          replaySummary: applicationRecord.replaySummary,
          updatedAt: new Date().toISOString(),
        });
        return ctx.getWorkspaceSnapshot();
      }

      if (sent && applicationRecord) {
        const submittedAt = new Date().toISOString();
        if (sent.confirmedSubmitted) {
          const [currentRuns, currentResults] = await Promise.all([
            ctx.repository.listApplyRuns(),
            ctx.repository.listApplyJobResults({ runId: run.id }),
          ]);
          const currentRun =
            currentRuns.find((candidate) => candidate.id === run.id) ?? run;
          await ctx.repository.upsertApplyRun(
            reconcileApplyRunAfterConfirmedSubmission({
              run: currentRun,
              results: currentResults,
              submittedAt,
              submittedSummary: sent.summary,
              submittedDetail: sent.detail,
            }),
          );
        }
        const currentApplicationRecord = (
          await ctx.repository.listApplicationRecords()
        ).find((record) => record.id === applicationRecordId);
        if (!currentApplicationRecord) {
          return ctx.getWorkspaceSnapshot();
        }
        await syncRunApplicationRecord({
          applicationRecordId,
          consentSummary: currentApplicationRecord.consentSummary,
          eventDetail: sent.detail,
          eventEmphasis: sent.confirmedSubmitted ? "positive" : "warning",
          eventId: `event_${run.id}_${job.id}_submitted_${Date.now()}`,
          eventTitle: sent.summary,
          jobId: job.id,
          lastActionLabel: sent.summary,
          lastAttemptState: sent.formGone
            ? "failed"
            : currentApplicationRecord.lastAttemptState,
          latestBlocker: currentApplicationRecord.latestBlocker,
          nextActionLabel: sent.nextActionLabel,
          questionSummary: currentApplicationRecord.questionSummary,
          replaySummary: currentApplicationRecord.replaySummary,
          updatedAt: submittedAt,
        });
      }

      return ctx.getWorkspaceSnapshot();
    },

    async revokeApplyRunApproval(runId) {
      await withApplyRunTransition(runId, async () => {
        const [runs, approvals, results] = await Promise.all([
          ctx.repository.listApplyRuns(),
          ctx.repository.listApplySubmitApprovals(),
          ctx.repository.listApplyJobResults({ runId }),
        ]);
        const run = runs.find((entry) => entry.id === runId) ?? null;

        if (!run) {
          throw new Error(`Unknown apply run '${runId}'.`);
        }

        if (run.mode !== "single_job_auto" && run.mode !== "queue_auto") {
          throw new Error(
            `Apply run '${runId}' is not waiting on submit approval.`,
          );
        }

        if (
          run.state === "completed" ||
          run.state === "cancelled" ||
          run.state === "failed" ||
          run.state === "running" ||
          run.state === "paused_for_consent"
        ) {
          throw new Error(
            `Cannot revoke approval for run '${runId}' in state '${run.state}'.`,
          );
        }

        if (!run.submitApprovalId) {
          throw new Error(
            `Apply run '${runId}' does not have a submit approval record.`,
          );
        }

        const approval =
          approvals.find((entry) => entry.id === run.submitApprovalId) ?? null;

        if (!approval) {
          throw new Error(
            `Missing submit approval '${run.submitApprovalId}' for run '${runId}'.`,
          );
        }

        if (approval.status !== "approved") {
          throw new Error(
            `Submit approval for run '${runId}' can only be revoked after approval.`,
          );
        }

        const now = new Date().toISOString();
        const revokedApproval = ApplySubmitApprovalSchema.parse({
          ...approval,
          status: "revoked",
          revokedAt: now,
          detail:
            "Submit approval was revoked before any submit-enabled execution started.",
        });
        const replacementApproval = ApplySubmitApprovalSchema.parse({
          id: createUniqueId("apply_submit_approval"),
          runId: run.id,
          mode: run.mode,
          jobIds: approval.jobIds,
          status: "pending",
          createdAt: now,
          approvedAt: null,
          revokedAt: null,
          expiresAt: null,
          detail:
            "Submit approval must be re-granted before any later submit-enabled execution can continue.",
        });
        const updatedRun = ApplyRunSchema.parse({
          ...run,
          state: "awaiting_submit_approval",
          submitApprovalId: replacementApproval.id,
          updatedAt: now,
          summary: "Submit approval revoked for this automatic apply run.",
          detail:
            "This batch is waiting for you to start it again. Whether Job Finder sends each application is the mode you chose in Settings.",
        });

        await Promise.all([
          ctx.repository.upsertApplySubmitApproval(revokedApproval),
          ctx.repository.upsertApplySubmitApproval(replacementApproval),
          ctx.repository.upsertApplyRun(updatedRun),
        ]);

        const revocationJobId = run.currentJobId;

        if (revocationJobId) {
          const matchingResults = results.filter(
            (result) => result.jobId === revocationJobId,
          );
          const applicationRecordId = matchingResults[0]?.applicationRecordId;
          if (matchingResults.length !== 1 || !applicationRecordId) {
            throw new Error(
              `Apply run '${runId}' has legacy or ambiguous application lineage for job '${revocationJobId}'.`,
            );
          }
          await withExactApplicationRecordTransition(
            applicationRecordId,
            revocationJobId,
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
                  lastActionLabel: updatedRun.summary,
                  nextActionLabel:
                    "Re-approve this run before any later submit-enabled execution.",
                  lastUpdatedAt: now,
                  events: mergeEvents(existingRecord.events, [
                    {
                      id: `event_${run.id}_approval_revoked`,
                      at: now,
                      title: "Submit approval revoked",
                      detail:
                        "The run no longer has submit approval and must be re-approved before any later execution step.",
                      emphasis: "warning",
                    },
                  ]),
                }),
              );
            },
          );
        }
      });

      return ctx.getWorkspaceSnapshot();
    },
  };
}
