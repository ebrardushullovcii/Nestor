import { resumeFormFileNames } from "@nestor/contracts";
import { inferQuestionKind } from "@nestor/browser-agent";
import {
  ApplicationAnswerRecordSchema,
  type ApplicationAnswerRecord,
  compareApplicationAnswerRecency,
  ApplicationRecordSchema,
  ApplyExecutionResultSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplySubmitApprovalSchema,
  ApplicationArtifactRefSchema,
  ApplicationConsentRequestSchema,
  ApplicationPrivacyReceiptSchema,
  ApplicationQuestionRecordSchema,
  ApplicationReplayCheckpointSchema,
  type ApplyExecutionResult,
  type ApplyJobResult,
  type ApplyRun,
  type ApplicationPrivacyReceipt,
  type ApplicationReviewCard,
  type ApplicationResumeArtifact,
  type BrowserVisualEvidenceSummary,
  type JobFinderWorkspaceSnapshot,
  type SavedJob,
} from "@nestor/contracts";

import { createUniqueId } from "./shared";

const PENDING_APPLY_JOB_STATES = new Set<ApplyJobResult["state"]>([
  "planned",
  "question_capture",
  "filling",
  "awaiting_review",
  "submitting",
]);

export function summarizeApplyJobResultStates(
  results: readonly ApplyJobResult[],
): {
  submittedJobs: number;
  awaitingReviewJobs: number;
  blockedJobs: number;
  failedJobs: number;
  skippedJobs: number;
} {
  const latestByJob = new Map<string, ApplyJobResult>();
  for (const result of results) {
    const current = latestByJob.get(result.jobId);
    if (
      !current ||
      hasVerifiedApplicationSubmission(result) ||
      (!hasVerifiedApplicationSubmission(current) &&
        result.updatedAt.localeCompare(current.updatedAt) > 0)
    ) {
      latestByJob.set(result.jobId, result);
    }
  }
  const latestResults = [...latestByJob.values()];
  return {
    submittedJobs: latestResults.filter(
      (result) =>
        result.state === "submitted" &&
        (result.privacyReceipt === null ||
          hasVerifiedApplicationSubmission(result)),
    ).length,
    awaitingReviewJobs: latestResults.filter(
      (result) => result.state === "awaiting_review",
    ).length,
    blockedJobs: latestResults.filter((result) => result.state === "blocked")
      .length,
    failedJobs: latestResults.filter((result) => result.state === "failed")
      .length,
    skippedJobs: latestResults.filter((result) => result.state === "skipped")
      .length,
  };
}

export function reconcileApplyRunAfterConfirmedSubmission(input: {
  run: ApplyRun;
  results: readonly ApplyJobResult[];
  submittedAt: string;
  submittedSummary: string;
  submittedDetail: string;
}): ApplyRun {
  const latestByJob = new Map<string, ApplyJobResult>();
  for (const result of input.results) {
    const current = latestByJob.get(result.jobId);
    if (
      !current ||
      hasVerifiedApplicationSubmission(result) ||
      (!hasVerifiedApplicationSubmission(current) &&
        result.updatedAt.localeCompare(current.updatedAt) > 0)
    ) {
      latestByJob.set(result.jobId, result);
    }
  }
  const orderedResults = input.run.jobIds.map(
    (jobId) => latestByJob.get(jobId) ?? null,
  );
  const pendingResults = orderedResults.filter(
    (result) => result === null || PENDING_APPLY_JOB_STATES.has(result.state),
  );
  const blockedResults = orderedResults.filter(
    (result) => result?.state === "blocked",
  );
  const pendingJobs = pendingResults.length;
  const submittedJobs = orderedResults.filter(
    (result) =>
      result?.state === "submitted" &&
      (result.privacyReceipt === null ||
        hasVerifiedApplicationSubmission(result)),
  ).length;
  const skippedJobs = orderedResults.filter(
    (result) => result?.state === "skipped",
  ).length;
  const blockedJobs = blockedResults.length;
  const failedJobs = orderedResults.filter(
    (result) => result?.state === "failed",
  ).length;
  const remainsRunning =
    input.run.state === "running" &&
    pendingResults.some((result) => result?.state !== "awaiting_review");
  const safetyPaused =
    input.run.state === "paused_for_user_review" &&
    pendingResults.some(
      (result) =>
        result?.state === "planned" && !result.applicationPreparationStartedAt,
    );
  const completed = pendingJobs === 0 && blockedJobs === 0;
  const state = completed
    ? "completed"
    : remainsRunning
      ? "running"
      : "paused_for_user_review";
  const currentJobId = completed
    ? null
    : input.run.currentJobId !== null &&
        (pendingResults.some(
          (result) => result?.jobId === input.run.currentJobId,
        ) ||
          blockedResults.some(
            (result) => result?.jobId === input.run.currentJobId,
          ))
      ? input.run.currentJobId
      : (pendingResults.find((result) => result !== null)?.jobId ??
        blockedResults[0]?.jobId ??
        null);

  return ApplyRunSchema.parse({
    ...input.run,
    state,
    currentJobId,
    updatedAt: input.submittedAt,
    completedAt: completed ? input.submittedAt : null,
    summary: safetyPaused
      ? input.run.summary
      : completed
        ? input.submittedSummary
        : `${input.submittedSummary}; ${pendingJobs + blockedJobs} ${pendingJobs + blockedJobs === 1 ? "application is" : "applications are"} still waiting for review.`,
    detail: safetyPaused
      ? input.run.detail
      : completed
        ? input.submittedDetail
        : submittedJobs > 0
          ? "The confirmed application is recorded. The remaining applications keep their own review state."
          : "Nothing was confirmed sent. The remaining applications keep their own review state.",
    pendingJobs,
    submittedJobs,
    skippedJobs,
    blockedJobs,
    failedJobs,
  });
}

/** Preparation prose cannot establish a send; only the submission receipt can. */
export function describeApplicationPreparation(
  result: ApplyExecutionResult,
): ApplyExecutionResult {
  if (result.state === "submitted" || result.state === "in_progress")
    return result;
  const waiting = result.questions.some(
    (question) =>
      question.status !== "answered" && question.status !== "submitted",
  );
  return {
    ...result,
    summary:
      result.state === "failed" || result.state === "unsupported"
        ? "Application preparation did not finish."
        : waiting
          ? "Needs your answers."
          : result.state === "ready"
            ? "Ready to send."
            : "Preparation paused.",
    detail:
      result.blocker?.detail ??
      result.blocker?.summary ??
      (result.state === "failed" || result.state === "unsupported"
        ? result.detail
        : waiting
          ? "Answer the remaining questions to continue this application."
          : result.state === "ready"
            ? "The form is filled in. Review it and send when you are ready."
            : "Preparation paused before a send was confirmed."),
  };
}

export function hasVerifiedApplicationSubmission(
  result: ApplyJobResult,
): boolean {
  return (
    result.privacyReceipt?.finalSubmitOccurred === true &&
    (result.privacyReceipt.submissionOutcome === null ||
      result.privacyReceipt.submissionOutcome.outcome === "submitted")
  );
}

export function enforcePrepareOnlyExecutionResult(
  input: ApplyExecutionResult,
): ApplyExecutionResult {
  const result = ApplyExecutionResultSchema.parse(input);

  if (
    result.state === "submitted" ||
    result.submittedAt !== null ||
    result.outcome === "submitted"
  ) {
    throw new Error(
      "A prepare-only application flow reported a submitted outcome without final-submit authorization.",
    );
  }

  return result;
}

export function buildMissingResumeCopilotArtifacts(input: {
  applicationRecord: ReturnType<typeof ApplicationRecordSchema.parse>;
  job: SavedJob;
  detectedAt: string;
  prerequisite?: {
    kind: "work_history_review";
    summary: string;
    detail: string;
    nextActionLabel: string;
  };
}): {
  run: ApplyRun;
  result: ApplyJobResult;
  applicationRecord: ReturnType<typeof ApplicationRecordSchema.parse>;
  questionRecord: ReturnType<typeof ApplicationQuestionRecordSchema.parse>;
  artifactRef: ReturnType<typeof ApplicationArtifactRefSchema.parse>;
  checkpoint: ReturnType<typeof ApplicationReplayCheckpointSchema.parse>;
  consentRequest: ReturnType<typeof ApplicationConsentRequestSchema.parse>;
} {
  const runId = createUniqueId("apply_run");
  const resultId = createUniqueId("apply_result");
  const questionId = createUniqueId("apply_question");
  const artifactId = createUniqueId("apply_artifact");
  const checkpointId = createUniqueId("apply_checkpoint");
  const consentRequestId = createUniqueId("apply_consent_request");
  const canonicalApplyUrl = input.job.applicationUrl ?? input.job.canonicalUrl;
  const needsWorkHistoryReview =
    input.prerequisite?.kind === "work_history_review";
  const blockerSummary =
    input.prerequisite?.summary ??
    "An approved tailored resume is required before apply copilot can start.";
  const blockerDetail =
    input.prerequisite?.detail ??
    "This job does not currently have an approved, non-stale tailored resume export on disk, so the run stopped before any live application action.";
  const nextActionLabel =
    input.prerequisite?.nextActionLabel ??
    "Export and approve a tailored resume before retrying apply copilot.";

  const run = ApplyRunSchema.parse({
    id: runId,
    mode: "copilot",
    state: needsWorkHistoryReview
      ? "paused_for_user_review"
      : "paused_for_consent",
    jobIds: [input.job.id],
    currentJobId: input.job.id,
    submitApprovalId: null,
    createdAt: input.detectedAt,
    updatedAt: input.detectedAt,
    completedAt: null,
    summary: `Apply copilot paused for '${input.job.title}' before any live application execution.`,
    detail: needsWorkHistoryReview
      ? "The tailored resume needs one decision from you, so the copilot recorded that step instead of opening the job site."
      : "The approved tailored resume is missing or stale, so the copilot run recorded a review-ready blocker instead of starting any live application flow.",
    totalJobs: 1,
    pendingJobs: 0,
    submittedJobs: 0,
    skippedJobs: 0,
    blockedJobs: 1,
    failedJobs: 0,
  });

  const result = ApplyJobResultSchema.parse({
    id: resultId,
    runId,
    jobId: input.job.id,
    applicationRecordId: input.applicationRecord.id,
    queuePosition: 0,
    state: "blocked",
    summary: "Apply copilot blocked before launch.",
    detail: blockerDetail,
    startedAt: input.detectedAt,
    updatedAt: input.detectedAt,
    completedAt: input.detectedAt,
    applicationPreparationStartedAt: null,
    applicationPreparationStartedLocalDate: null,
    blockerReason: needsWorkHistoryReview
      ? "required_human_input"
      : "resume_missing",
    blockerSummary,
    latestQuestionCount: 1,
    latestAnswerCount: 0,
    pendingConsentRequestCount: 1,
    artifactCount: 1,
    latestCheckpointId: checkpointId,
  });

  const questionRecord = ApplicationQuestionRecordSchema.parse({
    id: questionId,
    runId,
    jobId: input.job.id,
    applicationRecordId: input.applicationRecord.id,
    resultId,
    prompt: needsWorkHistoryReview
      ? "Confirm the work history intentionally left out of this tailored resume"
      : "Approved tailored resume available for this job",
    kind: needsWorkHistoryReview ? "experience" : "resume",
    isRequired: true,
    detectedAt: input.detectedAt,
    answerOptions: [],
    suggestedAnswers: [],
    selectedAnswerId: null,
    submittedAnswer: null,
    status: "skipped",
    pageUrl: canonicalApplyUrl,
  });

  const applicationRecord = ApplicationRecordSchema.parse({
    ...input.applicationRecord,
    id: input.applicationRecord.id,
    jobId: input.job.id,
    title: input.job.title,
    company: input.job.company,
    status: input.job.status,
    lastActionLabel: needsWorkHistoryReview
      ? "Application preparation is waiting for your resume review."
      : result.summary,
    nextActionLabel,
    lastUpdatedAt: input.detectedAt,
    lastAttemptState: needsWorkHistoryReview ? "paused" : null,
    questionSummary: {
      total: 1,
      required: 1,
      answered: 0,
      unansweredRequired: 1,
    },
    latestBlocker: {
      code: needsWorkHistoryReview
        ? "requires_manual_review"
        : "missing_resume",
      summary: result.blockerSummary,
    },
    consentSummary: {
      status: "none",
      pendingCount: 0,
    },
    replaySummary: {
      lastUrl: canonicalApplyUrl,
      checkpointCount: 1,
      evidenceCount: 1,
      sourceInstructionArtifactId: null,
    },
    events: [
      {
        id: `event_${runId}_${needsWorkHistoryReview ? "work_history_review" : "missing_resume"}_blocker`,
        at: input.detectedAt,
        title: needsWorkHistoryReview
          ? "Resume review needed before preparation"
          : "Apply copilot blocked before launch",
        detail: result.detail,
        emphasis: "critical",
      },
    ],
  });

  const artifactRef = ApplicationArtifactRefSchema.parse({
    id: artifactId,
    runId,
    jobId: input.job.id,
    applicationRecordId: input.applicationRecord.id,
    resultId,
    questionId,
    kind: "field_snapshot",
    label: needsWorkHistoryReview
      ? "Work history review needed"
      : "Missing approved tailored resume blocker",
    createdAt: input.detectedAt,
    storagePath: null,
    url: canonicalApplyUrl,
    textSnippet: needsWorkHistoryReview
      ? "Apply copilot stayed local and non-submitting while the tailored resume waits for work history confirmation."
      : "Apply copilot stayed local and non-submitting because no approved tailored resume export was available.",
  });

  const checkpoint = ApplicationReplayCheckpointSchema.parse({
    id: checkpointId,
    runId,
    jobId: input.job.id,
    applicationRecordId: input.applicationRecord.id,
    resultId,
    createdAt: input.detectedAt,
    label: "Blocked before live apply launch",
    detail: needsWorkHistoryReview
      ? "The run recorded the resume review step and stayed in local non-submitting copilot mode."
      : "The run recorded the missing-resume blocker and stayed in local non-submitting copilot mode.",
    url: canonicalApplyUrl,
    jobState: "blocked",
    artifactRefIds: [artifactId],
  });

  const consentRequest = ApplicationConsentRequestSchema.parse({
    id: consentRequestId,
    runId,
    jobId: input.job.id,
    applicationRecordId: input.applicationRecord.id,
    resultId,
    kind: "resume_use",
    linkedConsentKind: "resume_use",
    label: needsWorkHistoryReview
      ? "Confirm the tailored resume's hidden work history"
      : "Approve and export a tailored resume before starting apply copilot",
    detail: needsWorkHistoryReview
      ? "Open this job in Resume Studio, confirm that the omitted role or roles are intentionally hidden, then try application preparation again."
      : "This non-submitting Milestone 1 run only records the prerequisite blocker. Export and approve a fresh tailored PDF before later apply-copilot slices can continue.",
    status: "pending",
    requestedAt: input.detectedAt,
    decidedAt: null,
    expiresAt: null,
  });

  return {
    run,
    result,
    applicationRecord,
    questionRecord,
    artifactRef,
    checkpoint,
    consentRequest,
  };
}

export function createEmptyApplyVisualState() {
  return {
    visualObservationSets: [],
    visualCheckpoints: [],
  };
}

export function selectLatestApplyRunId(
  applyRuns: readonly JobFinderWorkspaceSnapshot["applyRuns"][number][],
) {
  return (
    applyRuns.reduce<JobFinderWorkspaceSnapshot["applyRuns"][number] | null>(
      (latest, run) => {
        if (!latest) {
          return run;
        }

        const latestTimestamp = Date.parse(latest.updatedAt);
        const nextTimestamp = Date.parse(run.updatedAt);

        if (
          Number.isFinite(nextTimestamp) &&
          !Number.isFinite(latestTimestamp)
        ) {
          return run;
        }

        if (!Number.isFinite(nextTimestamp)) {
          return latest;
        }

        if (nextTimestamp > latestTimestamp) {
          return run;
        }

        if (
          nextTimestamp === latestTimestamp &&
          run.id.localeCompare(latest.id) > 0
        ) {
          return run;
        }

        return latest;
      },
      null,
    )?.id ?? null
  );
}

export function buildSingleJobAutoApplyArtifacts(input: {
  applicationRecordId: string;
  approvalId?: string | null;
  createdAt: string;
  detail?: string | null;
  job: SavedJob;
  mode?: "single_job_auto";
}): {
  approval: ReturnType<typeof ApplySubmitApprovalSchema.parse>;
  result: ApplyJobResult;
  run: ApplyRun;
} {
  const runId = createUniqueId("apply_run");
  const resultId = createUniqueId("apply_result");
  const approvalId =
    input.approvalId ?? createUniqueId("apply_submit_approval");

  const run = ApplyRunSchema.parse({
    id: runId,
    mode: input.mode ?? "single_job_auto",
    state: "awaiting_submit_approval",
    jobIds: [input.job.id],
    currentJobId: input.job.id,
    submitApprovalId: approvalId,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: null,
    summary: `Automatic submit run is staged for '${input.job.title}'.`,
    detail:
      input.detail ??
      "This batch records your approval before Job Finder prepares anything. Job Finder never presses the final submit button on a job site — you do that yourself.",
    totalJobs: 1,
    pendingJobs: 1,
    submittedJobs: 0,
    skippedJobs: 0,
    blockedJobs: 0,
    failedJobs: 0,
  });

  const result = ApplyJobResultSchema.parse({
    id: resultId,
    runId,
    jobId: input.job.id,
    applicationRecordId: input.applicationRecordId,
    queuePosition: 0,
    state: "planned",
    summary: "Waiting for explicit submit approval.",
    detail:
      "This job is waiting for you to approve the batch it belongs to. Job Finder never presses the final submit button on a job site — you finish the application yourself.",
    startedAt: input.createdAt,
    updatedAt: input.createdAt,
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
  });

  const approval = ApplySubmitApprovalSchema.parse({
    id: approvalId,
    runId,
    mode: input.mode ?? "single_job_auto",
    jobIds: [input.job.id],
    status: "pending",
    createdAt: input.createdAt,
    approvedAt: null,
    revokedAt: null,
    expiresAt: null,
    detail:
      "Approve this batch before Job Finder prepares it. Job Finder never presses the final submit button on a job site; you finish each application yourself.",
  });

  return {
    approval,
    result,
    run,
  };
}

export function mapExecutionResultToApplyBlockerReason(
  blocker: ApplyExecutionResult["blocker"],
): ApplyJobResult["blockerReason"] {
  if (!blocker) {
    return null;
  }
  if (blocker.userActionKind === "captcha") {
    return "site_protection";
  }

  switch (blocker.code) {
    case "application_closed":
      return "application_closed";
    case "missing_resume":
      return "resume_missing";
    case "requires_manual_review":
    case "missing_candidate_answer":
    case "unknown":
      return "required_human_input";
    case "site_login_required":
      return "auth_required";
    case "site_saves_as_you_go":
      // Only the person can allow this site to save as they type.
      return "required_human_input";
    case "missing_consent":
      return "signup_consent_required";
    case "external_redirect":
    case "unsupported_apply_path":
      return "unexpected_navigation";
    case "application_page_unreachable":
      return "application_page_unreachable";
    default:
      console.warn(
        `[job-finder] Unhandled apply blocker code '${String(blocker.code)}' while mapping apply blocker reason.`,
      );
      return null;
  }
}

export function mapExecutionResultToApplyJobState(input: {
  consentRequests: readonly ReturnType<
    typeof ApplicationConsentRequestSchema.parse
  >[];
  executionResult: ApplyExecutionResult;
}): ApplyJobResult["state"] {
  if (input.executionResult.state === "submitted") {
    return "submitted";
  }

  if (input.executionResult.state === "failed") {
    return "failed";
  }

  if (input.executionResult.state === "unsupported") {
    return "blocked";
  }

  if (input.consentRequests.length > 0) {
    return "blocked";
  }

  return "awaiting_review";
}

export function mapExecutionResultToApplyRunState(input: {
  consentRequests: readonly ReturnType<
    typeof ApplicationConsentRequestSchema.parse
  >[];
  executionResult: ApplyExecutionResult;
}): ApplyRun["state"] {
  if (input.executionResult.state === "submitted") {
    return "completed";
  }

  if (input.executionResult.state === "failed") {
    return "failed";
  }

  if (input.executionResult.state === "unsupported") {
    return "completed";
  }

  if (input.consentRequests.length > 0) {
    return "paused_for_consent";
  }

  return "paused_for_user_review";
}

export function buildApplicationPrivacyReceipt(input: {
  applicationRecordId: string;
  job: SavedJob;
  resumeArtifact: ApplicationResumeArtifact;
  executionResult: ApplyExecutionResult;
  generatedAt: string;
  runId: string;
  resultId: string;
  reviewCard?: ApplicationReviewCard | null;
}): ApplicationPrivacyReceipt {
  const executionResult = enforcePrepareOnlyExecutionResult(
    input.executionResult,
  );
  const destinationUrl = new URL(
    input.job.applicationUrl ?? input.job.canonicalUrl,
  );
  const externalWrites = (executionResult.externalWrites ?? []).map(
    (entry) => ({ ...entry, artifactRefId: null }),
  );

  const attachedResume = input.reviewCard?.attachments.find(
    (attachment) =>
      inferQuestionKind({
        kind: "file",
        label: attachment.field,
        groupLabel: "",
        placeholder: "",
      }) === "resume",
  );
  const matchesSelectedResume =
    !attachedResume ||
    resumeFormFileNames(input.resumeArtifact.fileName).includes(
      attachedResume.fileName,
    );
  return ApplicationPrivacyReceiptSchema.parse({
    generatedAt: input.generatedAt,
    lineage: {
      runId: input.runId,
      jobId: input.job.id,
      resultId: input.resultId,
      applicationRecordId: input.applicationRecordId,
    },
    destination: {
      origin: destinationUrl.origin,
      safePath: destinationUrl.pathname || "/",
    },
    resume: {
      source: input.resumeArtifact.source,
      sourceDocumentId: matchesSelectedResume
        ? input.resumeArtifact.sourceDocumentId
        : null,
      exportArtifactId: matchesSelectedResume
        ? input.resumeArtifact.exportArtifactId
        : null,
      fileName: attachedResume?.fileName ?? input.resumeArtifact.fileName,
      sha256: matchesSelectedResume ? input.resumeArtifact.sha256 : null,
    },
    stayedLocal: [
      "profile_data",
      "resume_content",
      "application_answers",
      "job_listing_data",
      "browser_evidence",
      ...(input.resumeArtifact.source === "tailored_export"
        ? (["generated_documents"] as const)
        : []),
    ],
    modelUse: (executionResult.modelUse ?? []).map((entry) => ({
      purpose: entry.purpose,
      transport: "external_model" as const,
      providerLabel: entry.providerLabel,
      modelLabel: entry.modelLabel,
      dataCategories: [
        "profile_data",
        "resume_content",
        "job_listing_data",
        "application_answers",
      ] as const,
      occurredAt: entry.occurredAt,
    })),
    externalWrites,
    accountCreationAuthorized: false,
    finalSubmitAuthorized: false,
    finalSubmitOccurred: false,
  });
}
export function buildApplyCopilotArtifacts(input: {
  existingAnswerRecords?: readonly ApplicationAnswerRecord[];
  applicationRecordId: string;
  job: SavedJob;
  executionResult: ApplyExecutionResult;
  resumeArtifact: ApplicationResumeArtifact;
  detectedAt: string;
  runId?: string;
  resultId?: string;
  reviewCard?: ApplicationReviewCard | null;
  visualCheckpointsEnabled?: boolean;
}): {
  run: ApplyRun;
  result: ApplyJobResult;
  questionRecords: ReturnType<typeof ApplicationQuestionRecordSchema.parse>[];
  answerRecords: ReturnType<typeof ApplicationAnswerRecordSchema.parse>[];
  artifactRefs: ReturnType<typeof ApplicationArtifactRefSchema.parse>[];
  checkpoints: ReturnType<typeof ApplicationReplayCheckpointSchema.parse>[];
  consentRequests: ReturnType<typeof ApplicationConsentRequestSchema.parse>[];
} {
  input = {
    ...input,
    executionResult: describeApplicationPreparation(input.executionResult),
  };
  const runId = input.runId ?? createUniqueId("apply_run");
  const resultId = input.resultId ?? createUniqueId("apply_result");
  const canonicalApplyUrl = input.job.applicationUrl ?? input.job.canonicalUrl;
  const replayableExecutionCheckpoints =
    input.executionResult.checkpoints.length > 0
      ? input.executionResult.checkpoints
      : input.executionResult.blocker
        ? [
            {
              id: `blocked_${createUniqueId("apply_checkpoint_source")}`,
              at: input.detectedAt,
              label: "Browser action required",
              detail: `Job Finder stopped safely before final submit: ${input.executionResult.blocker.summary}`,
              state: input.executionResult.state,
              visualEvidence: input.executionResult.visualEvidence,
            },
          ]
        : [];
  const persistedQuestionIdByExecutionId = new Map<string, string>();
  const persistedAnswerIdByExecutionId = new Map<string, string>();
  const checkpointArtifactIdsByExecutionId = new Map<string, string[]>();
  const executionQuestionIdByPersistedId = new Map<string, string>();
  const lastCheckpointIndex = replayableExecutionCheckpoints.length - 1;
  input.executionResult.questions.forEach((question) => {
    // The same question on the same application keeps the same record, run
    // after run. Minting a new id each time is what made the pending list
    // double on every retry and left the answers filed against a question the
    // retry no longer recognised.
    const persistedQuestionId = `apply_question_${input.applicationRecordId}_${question.id}`;
    persistedQuestionIdByExecutionId.set(question.id, persistedQuestionId);
    executionQuestionIdByPersistedId.set(persistedQuestionId, question.id);
  });

  for (const question of input.executionResult.questions) {
    for (const answer of question.suggestedAnswers) {
      persistedAnswerIdByExecutionId.set(
        answer.id,
        createUniqueId("apply_answer"),
      );
    }
  }

  function mapCheckpointStateToJobState(
    checkpoint: ApplyExecutionResult["checkpoints"][number],
  ): ReturnType<typeof ApplicationReplayCheckpointSchema.parse>["jobState"] {
    switch (checkpoint.state) {
      case "submitted":
        return "submitted";
      case "failed":
        return "failed";
      case "paused":
        return "awaiting_review";
      case "unsupported":
        return "blocked";
      default:
        return checkpoint.label.toLowerCase().includes("question")
          ? "question_capture"
          : "filling";
    }
  }

  function visualEvidenceForCheckpoint(
    checkpoint: ApplyExecutionResult["checkpoints"][number],
    checkpointIndex: number,
  ): BrowserVisualEvidenceSummary[] {
    if (checkpoint.visualEvidence.length > 0) {
      return checkpoint.visualEvidence;
    }

    return checkpointIndex === lastCheckpointIndex
      ? input.executionResult.visualEvidence
      : [];
  }

  const latestAnswerByQuestion = new Map<string, ApplicationAnswerRecord>();
  for (const answer of [...(input.existingAnswerRecords ?? [])].sort(
    compareApplicationAnswerRecency,
  )) {
    if (!latestAnswerByQuestion.has(answer.questionId))
      latestAnswerByQuestion.set(answer.questionId, answer);
  }
  const answerRecords = input.executionResult.questions.flatMap((question) =>
    question.suggestedAnswers.map((answer) => {
      const questionId =
        persistedQuestionIdByExecutionId.get(question.id) ?? question.id;
      const previous = latestAnswerByQuestion.get(questionId);
      const record = ApplicationAnswerRecordSchema.parse({
        revision: (previous?.revision ?? 0) + 1,
        supersedesAnswerId: previous?.id ?? null,
        id:
          persistedAnswerIdByExecutionId.get(answer.id) ??
          createUniqueId("apply_answer"),
        runId,
        jobId: input.job.id,
        applicationRecordId: input.applicationRecordId,
        resultId,
        questionId:
          persistedQuestionIdByExecutionId.get(question.id) ?? question.id,
        status:
          question.submittedAnswer && question.submittedAnswer === answer.text
            ? "filled"
            : "suggested",
        text: answer.text,
        sourceKind: answer.sourceKind,
        sourceId: answer.sourceId,
        confidenceLabel: answer.confidenceLabel,
        provenance: answer.provenance,
        createdAt: input.detectedAt,
        submittedAt:
          question.submittedAnswer && question.submittedAnswer === answer.text
            ? input.detectedAt
            : null,
      });
      latestAnswerByQuestion.set(questionId, record);
      return record;
    }),
  );
  const questionRecords = input.executionResult.questions.map((question) => {
    const persistedQuestionId =
      persistedQuestionIdByExecutionId.get(question.id) ?? question.id;
    const matchingSuggestedAnswer = question.submittedAnswer
      ? (question.suggestedAnswers.find(
          (suggestedAnswer) =>
            suggestedAnswer.text === question.submittedAnswer,
        ) ?? null)
      : null;
    const selectedAnswerId = matchingSuggestedAnswer?.id
      ? (persistedAnswerIdByExecutionId.get(matchingSuggestedAnswer.id) ?? null)
      : null;

    return ApplicationQuestionRecordSchema.parse({
      id: persistedQuestionId,
      runId,
      jobId: input.job.id,
      applicationRecordId: input.applicationRecordId,
      resultId,
      prompt: question.prompt,
      ...(question.description ? { description: question.description } : {}),
      ...(question.note ? { note: question.note } : {}),
      ...(question.inputConstraints
        ? { inputConstraints: question.inputConstraints }
        : {}),
      kind: question.kind,
      answerControlType:
        question.answerControlType ??
        (question.answerOptions.length > 0 ? "single_choice" : "text"),
      isRequired: question.isRequired,
      detectedAt: question.detectedAt,
      answerOptions: question.answerOptions,
      suggestedAnswers: question.suggestedAnswers,
      selectedAnswerId,
      submittedAnswer: question.submittedAnswer,
      status: question.status,
      pageUrl: canonicalApplyUrl,
      visualContext: input.executionResult.visualEvidence[0] ?? null,
    });
  });
  const blockerQuestionIds = input.executionResult.blocker?.questionIds ?? [];
  const artifactRefs = [
    ...questionRecords
      .filter((record) => {
        const executionQuestionId = executionQuestionIdByPersistedId.get(
          record.id,
        );
        return executionQuestionId
          ? blockerQuestionIds.includes(executionQuestionId)
          : false;
      })
      .map((record) =>
        ApplicationArtifactRefSchema.parse({
          id: createUniqueId("apply_artifact"),
          runId,
          jobId: input.job.id,
          applicationRecordId: input.applicationRecordId,
          resultId,
          questionId: record.id,
          kind: "field_snapshot",
          label: `Captured prompt: ${record.prompt}`,
          createdAt: input.detectedAt,
          storagePath: null,
          url: record.pageUrl,
          textSnippet: record.prompt,
          visualEvidence: input.executionResult.visualEvidence[0] ?? null,
        }),
      ),
    ...replayableExecutionCheckpoints.map((checkpoint, checkpointIndex) => {
      const artifactId = createUniqueId("apply_artifact");
      const existingArtifactIds =
        checkpointArtifactIdsByExecutionId.get(checkpoint.id) ?? [];
      checkpointArtifactIdsByExecutionId.set(checkpoint.id, [
        ...existingArtifactIds,
        artifactId,
      ]);
      const checkpointVisualEvidence = visualEvidenceForCheckpoint(
        checkpoint,
        checkpointIndex,
      );

      return ApplicationArtifactRefSchema.parse({
        id: artifactId,
        runId,
        jobId: input.job.id,
        applicationRecordId: input.applicationRecordId,
        resultId,
        questionId: null,
        kind: "checkpoint",
        label: checkpoint.label,
        createdAt: checkpoint.at,
        storagePath: null,
        url: canonicalApplyUrl,
        textSnippet: checkpoint.detail,
        visualEvidence: checkpointVisualEvidence[0] ?? null,
      });
    }),
  ];
  const visualReconciliations = input.executionResult.visualCheckpoints.flatMap(
    (checkpoint) => checkpoint.reconciliations,
  );
  const checkpoints = replayableExecutionCheckpoints.map(
    (checkpoint, checkpointIndex) => {
      const persistedCheckpointId = createUniqueId("apply_checkpoint");
      const checkpointVisualEvidence = visualEvidenceForCheckpoint(
        checkpoint,
        checkpointIndex,
      );

      return ApplicationReplayCheckpointSchema.parse({
        id: persistedCheckpointId,
        runId,
        jobId: input.job.id,
        applicationRecordId: input.applicationRecordId,
        resultId,
        createdAt: checkpoint.at,
        label: checkpoint.label,
        detail: checkpoint.detail,
        url: canonicalApplyUrl,
        jobState: mapCheckpointStateToJobState(checkpoint),
        artifactRefIds:
          checkpointArtifactIdsByExecutionId.get(checkpoint.id) ?? [],
        visualEvidence: checkpointVisualEvidence,
        visualReconciliations:
          checkpointIndex === lastCheckpointIndex ? visualReconciliations : [],
      });
    },
  );
  const consentRequests = input.executionResult.consentDecisions
    .filter((decision) => decision.status === "requested")
    .map((decision) =>
      ApplicationConsentRequestSchema.parse({
        id: createUniqueId("apply_consent_request"),
        runId,
        jobId: input.job.id,
        applicationRecordId: input.applicationRecordId,
        resultId,
        kind:
          decision.kind === "resume_use"
            ? "resume_use"
            : decision.kind === "autofill_profile"
              ? "profile_autofill"
              : "manual_verification",
        linkedConsentKind: decision.kind,
        label: decision.label,
        detail: decision.detail,
        status: "pending",
        requestedAt: input.detectedAt,
        decidedAt: null,
        expiresAt: null,
      }),
    );

  const resultState = mapExecutionResultToApplyJobState({
    consentRequests,
    executionResult: input.executionResult,
  });
  const runState = mapExecutionResultToApplyRunState({
    consentRequests,
    executionResult: input.executionResult,
  });

  const privacyReceipt = buildApplicationPrivacyReceipt({
    applicationRecordId: input.applicationRecordId,
    job: input.job,
    resumeArtifact: input.resumeArtifact,
    executionResult: input.executionResult,
    generatedAt: input.detectedAt,
    runId,
    resultId,
    reviewCard: input.reviewCard ?? null,
  });
  const result = ApplyJobResultSchema.parse({
    id: resultId,
    runId,
    jobId: input.job.id,
    applicationRecordId: input.applicationRecordId,
    queuePosition: 0,
    state: resultState,
    summary: input.executionResult.summary,
    agentTiming: input.executionResult.agentTiming,
    detail: input.executionResult.detail,
    startedAt: replayableExecutionCheckpoints[0]?.at ?? input.detectedAt,
    updatedAt: input.detectedAt,
    completedAt:
      input.executionResult.state === "submitted" ||
      input.executionResult.state === "failed" ||
      input.executionResult.state === "unsupported"
        ? input.detectedAt
        : null,
    applicationPreparationStartedAt: null,
    applicationPreparationStartedLocalDate: null,
    blockerReason: mapExecutionResultToApplyBlockerReason(
      input.executionResult.blocker,
    ),
    blockerSummary: input.executionResult.blocker?.summary ?? null,
    listingSignalEvidence: input.executionResult.listingSignalEvidence,
    visualObservationSets: input.executionResult.visualObservationSets,
    visualCheckpoints: input.executionResult.visualCheckpoints,
    latestQuestionCount: Math.max(
      questionRecords.length,
      input.reviewCard?.answers.length ?? 0,
    ),
    latestAnswerCount: Math.max(
      answerRecords.filter((answer) => answer.status === "filled").length,
      input.reviewCard?.answers.filter((answer) => answer.answer.trim())
        .length ?? 0,
    ),
    pendingConsentRequestCount: consentRequests.length,
    artifactCount: artifactRefs.length,
    latestCheckpointId: checkpoints.at(-1)?.id ?? null,
    privacyReceipt,
    reviewCard: input.reviewCard ?? null,
  });

  const run = ApplyRunSchema.parse({
    id: runId,
    mode: "copilot",
    state: runState,
    jobIds: [input.job.id],
    currentJobId: input.job.id,
    submitApprovalId: null,
    visualCheckpointsEnabled: input.visualCheckpointsEnabled === true,
    createdAt: input.detectedAt,
    updatedAt: input.detectedAt,
    completedAt:
      input.executionResult.state === "submitted" ||
      input.executionResult.state === "failed" ||
      input.executionResult.state === "unsupported"
        ? input.detectedAt
        : null,
    summary: input.executionResult.summary,
    detail: input.executionResult.detail,
    totalJobs: 1,
    pendingJobs: result.state === "awaiting_review" ? 1 : 0,
    submittedJobs: result.state === "submitted" ? 1 : 0,
    skippedJobs: 0,
    blockedJobs: result.state === "blocked" ? 1 : 0,
    failedJobs: result.state === "failed" ? 1 : 0,
  });

  return {
    run,
    result,
    questionRecords,
    answerRecords,
    artifactRefs,
    checkpoints,
    consentRequests,
  };
}
