import { releaseFinishedApplicationPages } from "./application-page-lifecycle";
import { mergeApplyReviewCards } from "./agent-application-preparation";
import { creditOwnApplicationAnswers } from "./review-card-own-answers";
import type { ExecuteApplicationFlowInput } from "@nestor/browser-runtime";
import {
  completeTaskLocalSignIn,
  createApplyPageHands,
} from "@nestor/browser-agent";
import type { ApplyPageSession } from "@nestor/contracts";
import {
  buildApplyLetterDependencies,
  createApplyFormPreparer,
  resolveApplySiteLabel,
} from "./agent-application-preparation";
import {
  persistApplicationPreparationProgress,
  persistApplicationWaitingForBrowserTab,
} from "./application-preparation-progress";
import {
  ApplyExecutionResultSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  ApplyRecoveryContextSchema,
  ApplicationAttemptConsentDecisionSchema,
  ApplicationAttemptQuestionSchema,
  ApplicationAttemptSchema,
  UserActionVerificationResultSchema,
  ApplicationRecordSchema,
  type ApplicationAttempt,
  type ApplicationReviewCard,
  type ApplicationResumeArtifact,
  type ApplyExecutionResult,
  type ApplyJobResult,
  type ApplyRun,
  type JobSource,
  type SavedJob,
  type UserActionRequest,
} from "@nestor/contracts";
import {
  isUserActionTerminal,
  reduceUserActionCommand,
  reduceUserActionVerification,
} from "../user-action-domain";

import {
  buildApplicationBlockerFingerprint,
  isApplicationAuthenticationUserActionKind,
  isApplicationPrepareOnlyUserAction,
  handApplicationPageToPersonForAccessStep,
  persistApplicationUserAction,
  releaseApplicationRecordAfterDismissedUserAction,
} from "./workspace-application-user-action";
import {
  buildApplyCopilotArtifacts,
  mapExecutionResultToApplyBlockerReason,
  mapExecutionResultToApplyJobState,
  reconcileApplyRunAfterConfirmedSubmission,
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
import { selectApplicationSighting } from "./listing-sightings";
import { withApplicationRecordTransition } from "./application-crm";
import { applicationAnswersForExecution } from "./workspace-application-answer-execution";
import { resolveApplicationAttachmentsForExecution } from "./workspace-application-attachments";
import { persistAutomaticApplicationSafeguards } from "./automatic-safeguards";
import { resolveApplyAuthorityForJob } from "./apply-authority-resolution";
import {
  enforceResolvedApplyAuthorityResult,
  type ApplySubmissionHandoff,
} from "./apply-submission-handoff";
import {
  notSentAfterError,
  recordPreparedApplicationNotSent,
  sendPreparedApplicationIfAllowed,
} from "./apply-submission-run-step";
import type {
  TaskLocalApplicationCredentials,
  WorkspaceServiceContext,
} from "./workspace-service-context";
import { readSavedJob } from "./read-saved-job";

type ExactApplicationScope = {
  runId: string;
  jobId: string;
  applicationRecordId: string;
  resultId: string;
  replayCheckpointId: string;
  source: JobSource;
};

type ApplicationPrerequisites = {
  job: SavedJob;
  resumeArtifact: ApplicationResumeArtifact;
};

type ApplicationResumptionDependencies = {
  resolveJobApplyPrerequisites(
    jobId: string,
  ): Promise<ApplicationPrerequisites>;
};

type ApplicationResumptionLineage = {
  run: ApplyRun;
  result: ApplyJobResult;
  checkpoint: Awaited<
    ReturnType<
      WorkspaceServiceContext["repository"]["listApplicationReplayCheckpoints"]
    >
  >[number];
  job: SavedJob;
};

async function isActivityPaused(
  ctx: Pick<WorkspaceServiceContext, "repository">,
): Promise<boolean> {
  try {
    return (await ctx.repository.getActivityControl()).paused;
  } catch {
    return true;
  }
}

function getExactApplicationScope(
  request: UserActionRequest,
): ExactApplicationScope | null {
  const isApplicationSourceAccess =
    (request.state === "verifying" || request.state === "resolved") &&
    request.verification.type === "source_access" &&
    isApplicationAuthenticationUserActionKind(request.kind);
  const isPrepareOnlyVerification =
    isApplicationPrepareOnlyUserAction(request) &&
    (request.state === "verifying" || request.state === "resolved");

  if (
    request.scope.type !== "application" ||
    !request.scope.applicationRecordId ||
    !request.scope.resultId ||
    !request.scope.replayCheckpointId ||
    (!isApplicationSourceAccess && !isPrepareOnlyVerification)
  ) {
    return null;
  }

  return {
    runId: request.scope.runId,
    jobId: request.scope.jobId,
    applicationRecordId: request.scope.applicationRecordId,
    resultId: request.scope.resultId,
    replayCheckpointId: request.scope.replayCheckpointId,
    source: request.scope.source,
  };
}

function getResumptionRequestRevision(request: UserActionRequest): number {
  return request.state === "verifying"
    ? request.revision + 1
    : request.revision;
}

function getResumptionAttemptId(request: UserActionRequest): string {
  return `application_user_action_resume_${request.id}_r${getResumptionRequestRevision(request)}`;
}

function getVerificationEventId(request: UserActionRequest): string {
  const verificationRevision =
    request.state === "verifying" ? request.revision : request.revision - 1;
  return `verification:${request.id}:r${verificationRevision}`;
}

function hasMatchingResumptionLineage(input: {
  attempt: ApplicationAttempt;
  request: UserActionRequest;
  scope: ExactApplicationScope;
}): boolean {
  const resumption = input.attempt.userActionResumption;
  return Boolean(
    resumption &&
    resumption.requestId === input.request.id &&
    resumption.requestRevision ===
      getResumptionRequestRevision(input.request) &&
    resumption.verificationEventId === getVerificationEventId(input.request) &&
    resumption.runId === input.scope.runId &&
    resumption.jobId === input.scope.jobId &&
    resumption.resultId === input.scope.resultId &&
    resumption.replayCheckpointId === input.scope.replayCheckpointId &&
    input.attempt.jobId === input.scope.jobId &&
    input.attempt.applicationRecordId === input.scope.applicationRecordId,
  );
}

function createResumptionAttempt(input: {
  request: UserActionRequest;
  scope: ExactApplicationScope;
  existingAttempt: ApplicationAttempt | null;
  now: string;
  state: ApplicationAttempt["state"];
  summary: string;
  detail: string;
  completed: boolean;
  executionResult?: ApplyExecutionResult;
}): ApplicationAttempt {
  const executionResult = input.executionResult;
  const completedState =
    executionResult?.state === "not_started" ||
    executionResult?.state === "in_progress"
      ? "paused"
      : (executionResult?.state ?? input.state);

  return ApplicationAttemptSchema.parse({
    id: getResumptionAttemptId(input.request),
    jobId: input.scope.jobId,
    applicationRecordId: input.scope.applicationRecordId,
    state: input.completed ? completedState : input.state,
    summary: input.summary,
    detail: input.detail,
    startedAt: input.existingAttempt?.startedAt ?? input.now,
    updatedAt: input.now,
    completedAt: input.completed ? input.now : null,
    outcome: executionResult?.outcome ?? input.existingAttempt?.outcome ?? null,
    checkpoints:
      executionResult?.checkpoints ?? input.existingAttempt?.checkpoints ?? [],
    questions: (
      executionResult?.questions ??
      input.existingAttempt?.questions ??
      []
    ).map((question) => ApplicationAttemptQuestionSchema.parse(question)),
    blocker: executionResult?.blocker ?? input.existingAttempt?.blocker ?? null,
    consentDecisions: (
      executionResult?.consentDecisions ??
      input.existingAttempt?.consentDecisions ??
      []
    ).map((decision) =>
      ApplicationAttemptConsentDecisionSchema.parse(decision),
    ),
    replay: executionResult?.replay ?? input.existingAttempt?.replay ?? {},
    visualEvidence:
      executionResult?.visualEvidence ??
      input.existingAttempt?.visualEvidence ??
      [],
    visualObservationSets:
      executionResult?.visualObservationSets ??
      input.existingAttempt?.visualObservationSets ??
      [],
    visualCheckpoints:
      executionResult?.visualCheckpoints ??
      input.existingAttempt?.visualCheckpoints ??
      [],
    nextActionLabel:
      executionResult?.nextActionLabel ??
      input.existingAttempt?.nextActionLabel ??
      null,
    executionTimings:
      executionResult?.executionTimings ??
      input.existingAttempt?.executionTimings ??
      [],
    agentTiming: executionResult
      ? executionResult.agentTiming
      : input.existingAttempt?.agentTiming,
    userActionResumption: {
      requestId: input.request.id,
      requestRevision: getResumptionRequestRevision(input.request),
      verificationEventId: getVerificationEventId(input.request),
      runId: input.scope.runId,
      jobId: input.scope.jobId,
      resultId: input.scope.resultId,
      replayCheckpointId: input.scope.replayCheckpointId,
    },
  });
}

function buildRecoveryInstructions(input: {
  checkpointLabel: string;
  checkpointDetail: string | null;
  checkpointUrl: string | null;
  blockerSummary: string | null;
}): string[] {
  return uniqueStrings(
    [
      `Resume only the verified application checkpoint: ${input.checkpointLabel}.`,
      input.checkpointDetail
        ? `Recovery detail: ${input.checkpointDetail}`
        : null,
      input.checkpointUrl
        ? `Return to this exact retained apply URL when it still matches the current flow: ${input.checkpointUrl}`
        : null,
      input.blockerSummary
        ? `The prior browser-owned blocker was: ${input.blockerSummary}`
        : null,
    ].filter((value): value is string => Boolean(value)),
  );
}

function buildVisualExecutionOptions(input: {
  ctx: WorkspaceServiceContext;
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
    !input.ctx.browserRuntime.captureVisualSnapshot ||
    !input.ctx.aiClient.analyzeBrowserVisualSnapshot
  ) {
    return {};
  }

  const captureVisualSnapshot =
    input.ctx.browserRuntime.captureVisualSnapshot.bind(
      input.ctx.browserRuntime,
    );
  const analyzeVisualSnapshot =
    input.ctx.aiClient.analyzeBrowserVisualSnapshot.bind(input.ctx.aiClient);

  return {
    captureVisualSnapshot: (request) =>
      captureVisualSnapshot(input.source, request),
    analyzeVisualSnapshot,
  };
}

function getPersistedResultAttemptState(
  result: ApplyJobResult,
): ApplicationAttempt["state"] {
  switch (result.state) {
    case "submitted":
      return "failed";
    case "failed":
      return "failed";
    case "blocked":
      return "unsupported";
    default:
      return "paused";
  }
}

function getResultCompletedAt(input: {
  executionResult: ApplyExecutionResult;
  now: string;
}): string | null {
  return input.executionResult.state === "failed" ||
    input.executionResult.state === "unsupported"
    ? input.now
    : null;
}

function createFailedExecutionResult(error: unknown): ApplyExecutionResult {
  return ApplyExecutionResultSchema.parse({
    state: "failed",
    summary: "Application retry stopped safely",
    detail:
      error instanceof Error
        ? error.message
        : "The scoped application retry failed for an unknown reason.",
    submittedAt: null,
    outcome: null,
    checkpoints: [],
    questions: [],
    blocker: null,
    consentDecisions: [],
    replay: {},
    visualEvidence: [],
    visualObservationSets: [],
    visualCheckpoints: [],
    nextActionLabel: "Try again when you are ready.",
    executionTimings: [],
  });
}

function getPrepareOnlyVerificationOutcome(
  request: UserActionRequest,
  executionResult: ApplyExecutionResult,
): "verified" | "still_blocked" | null {
  if (
    request.state !== "verifying" ||
    !isApplicationPrepareOnlyUserAction(request)
  ) {
    return null;
  }

  if (executionResult.state === "unsupported") return "still_blocked";
  if (executionResult.state === "failed") {
    // A technical failure cannot verify the old browser question. Persist the
    // failed attempt below so its exact handoff is retired and retry is offered.
    return null;
  }
  // A continued run that the person's permission let send is the clearest
  // proof the step they finished is behind them.
  if (
    executionResult.state === "submitted" ||
    executionResult.submittedAt !== null
  ) {
    return "verified";
  }

  const expectedFingerprint =
    request.verification.type === "page_blocker_absent"
      ? request.verification.blockerFingerprint
      : null;
  if (expectedFingerprint === null) return null;

  return executionResult.blocker === null ||
    buildApplicationBlockerFingerprint(executionResult.blocker) !==
      expectedFingerprint
    ? "verified"
    : "still_blocked";
}

function getTaskLocalCredentialVerificationOutcome(
  request: UserActionRequest,
  executionResult: ApplyExecutionResult,
  credentialStepCompleted: boolean,
): "verified" | "still_blocked" | null {
  if (
    request.state !== "verifying" ||
    request.kind !== "login" ||
    request.scope.type !== "application" ||
    request.verification.type !== "source_access"
  ) {
    return null;
  }
  if (!credentialStepCompleted) {
    return "still_blocked";
  }
  const nextUserActionKind = executionResult.blocker?.userActionKind ?? null;
  return executionResult.blocker?.code === "site_login_required" ||
    nextUserActionKind === "login" ||
    nextUserActionKind === "signup" ||
    nextUserActionKind === "mfa" ||
    nextUserActionKind === "captcha" ||
    nextUserActionKind === "email_verification" ||
    nextUserActionKind === "existing_account_choice"
    ? "still_blocked"
    : "verified";
}

async function settlePrepareOnlyVerification(input: {
  ctx: WorkspaceServiceContext;
  outcome: "verified" | "still_blocked";
  request: UserActionRequest;
}): Promise<UserActionRequest | null> {
  if (
    input.request.state !== "verifying" ||
    !isApplicationPrepareOnlyUserAction(input.request)
  ) {
    return null;
  }

  const currentRequest = await input.ctx.repository.getUserActionRequest(
    input.request.id,
  );
  if (
    !currentRequest ||
    currentRequest.state !== "verifying" ||
    currentRequest.revision !== input.request.revision
  ) {
    return null;
  }

  const checkedAt = new Date().toISOString();
  const reduction = reduceUserActionVerification(
    currentRequest,
    UserActionVerificationResultSchema.parse({
      requestId: currentRequest.id,
      verificationId: getVerificationEventId(currentRequest),
      expectedRevision: currentRequest.revision,
      outcome: input.outcome,
      checkedAt,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    }),
  );

  if (reduction.status === "stale" || !reduction.event) {
    return null;
  }

  if (
    input.outcome === "verified" &&
    currentRequest.kind === "manual_answer" &&
    currentRequest.scope.type === "application" &&
    currentRequest.scope.applicationRecordId !== null &&
    currentRequest.scope.resultId !== null
  ) {
    const scope = currentRequest.scope;
    const questions = await input.ctx.repository.listApplicationQuestionRecords(
      {
        applicationRecordId: scope.applicationRecordId!,
        resultId: scope.resultId!,
      },
    );
    const answers = await input.ctx.repository.listApplicationAnswerRecords({
      applicationRecordId: scope.applicationRecordId!,
      resultId: scope.resultId!,
    });
    // Only this request's answers: an earlier pause in the same preparation
    // has its own summary.
    const answered = questions.filter((question) =>
      answers.some(
        (answer) =>
          answer.questionId === question.id &&
          answer.sourceKind === "user" &&
          answer.sourceId === currentRequest.id &&
          answer.status !== "rejected",
      ),
    );
    if (answered.length)
      reduction.request.summary =
        answered.length === 1
          ? `You answered “${answered[0]!.prompt}” in the app.`
          : `You answered ${answered.length} application questions in the app.`;
  }
  const commit = await input.ctx.repository.commitUserActionTransition({
    request: reduction.request,
    event: reduction.event,
  });
  return commit.request;
}

/**
 * Closes a step whose run already ended and puts its application at Could
 * not apply with Try again. After a restart the prepared page is gone, so the
 * application is prepared again from the start; the person's answers are
 * already saved and are reused.
 */
async function closeStepOfEndedRun(input: {
  ctx: WorkspaceServiceContext;
  request: UserActionRequest;
  scope: ExactApplicationScope;
}): Promise<void> {
  const current = await input.ctx.repository.getUserActionRequest(
    input.request.id,
  );
  if (!current || isUserActionTerminal(current.state)) return;
  const occurredAt = new Date().toISOString();
  const transition = reduceUserActionCommand(
    current,
    {
      requestId: current.id,
      commandId: `${current.id}_run_ended_r${current.revision}`,
      expectedRevision: current.revision,
      action: "cancel",
      reason:
        "This application's run ended before the step could be checked. Nothing was sent; choose Try again to prepare it again.",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    },
    occurredAt,
  );
  if (transition.status !== "applied") return;
  const commit = await input.ctx.repository.commitUserActionTransition({
    request: transition.request,
    event: transition.event,
  });
  if (commit.status === "stale") return;
  await withApplicationRecordTransition(
    input.ctx.repository,
    input.scope.applicationRecordId,
    () =>
      releaseApplicationRecordAfterDismissedUserAction({
        repository: input.ctx.repository,
        request: commit.request,
        occurredAt,
        eventId: `event_${current.id}_run_ended`,
        dismissal: "cancelled",
        unavailablePreparedPage: true,
      }),
  );
}

async function settleTaskLocalCredentialVerification(input: {
  ctx: WorkspaceServiceContext;
  outcome: "verified" | "still_blocked";
  request: UserActionRequest;
}): Promise<UserActionRequest | null> {
  if (
    input.request.state !== "verifying" ||
    input.request.kind !== "login" ||
    input.request.scope.type !== "application" ||
    input.request.verification.type !== "source_access"
  ) {
    return null;
  }

  const currentRequest = await input.ctx.repository.getUserActionRequest(
    input.request.id,
  );
  if (
    !currentRequest ||
    currentRequest.state !== "verifying" ||
    currentRequest.revision !== input.request.revision
  ) {
    return null;
  }

  const checkedAt = new Date().toISOString();
  const reduction = reduceUserActionVerification(
    currentRequest,
    UserActionVerificationResultSchema.parse({
      requestId: currentRequest.id,
      verificationId: getVerificationEventId(currentRequest),
      expectedRevision: currentRequest.revision,
      outcome: input.outcome,
      checkedAt,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    }),
  );
  if (reduction.status === "stale" || !reduction.event) return null;
  const commit = await input.ctx.repository.commitUserActionTransition({
    request: reduction.request,
    event: reduction.event,
  });
  return commit.request;
}

async function readExactLineage(input: {
  ctx: WorkspaceServiceContext;
  scope: ExactApplicationScope;
}): Promise<
  | { status: "current"; lineage: ApplicationResumptionLineage }
  | { status: "stale"; detail: string; runEnded?: boolean }
> {
  const [runs, results, checkpoints, job, applicationRecords] =
    await Promise.all([
      input.ctx.repository.listApplyRuns({ id: input.scope.runId }),
      input.ctx.repository.listApplyJobResults({
        runId: input.scope.runId,
        jobId: input.scope.jobId,
        applicationRecordId: input.scope.applicationRecordId,
      }),
      input.ctx.repository.listApplicationReplayCheckpoints({
        runId: input.scope.runId,
        jobId: input.scope.jobId,
        resultId: input.scope.resultId,
        applicationRecordId: input.scope.applicationRecordId,
      }),
      readSavedJob(input.ctx.repository, input.scope.jobId),
      input.ctx.repository.listApplicationRecords(),
    ]);
  const run = runs.find((entry) => entry.id === input.scope.runId) ?? null;
  const result =
    results.find((entry) => entry.id === input.scope.resultId) ?? null;
  const checkpoint =
    checkpoints.find((entry) => entry.id === input.scope.replayCheckpointId) ??
    null;
  const applicationRecord =
    applicationRecords.find(
      (entry) => entry.id === input.scope.applicationRecordId,
    ) ?? null;

  if (!applicationRecord || applicationRecord.jobId !== input.scope.jobId) {
    return {
      status: "stale",
      detail: "The exact application record no longer owns this job.",
    };
  }

  if (!run || !run.jobIds.includes(input.scope.jobId)) {
    return {
      status: "stale",
      detail: "The exact apply run no longer owns this job.",
    };
  }
  if (run.state === "cancelled" || run.state === "failed") {
    return {
      status: "stale",
      detail: `The exact apply run is already ${run.state}.`,
      runEnded: true,
    };
  }
  if (!result || results.length !== 1) {
    return {
      status: "stale",
      detail:
        "The exact apply result is no longer current for this run and job.",
    };
  }
  if (result.applicationRecordId !== input.scope.applicationRecordId) {
    return {
      status: "stale",
      detail:
        "The exact apply result no longer belongs to this application record.",
    };
  }
  if (result.latestCheckpointId !== input.scope.replayCheckpointId) {
    return {
      status: "stale",
      detail:
        "A newer or different application checkpoint replaced the verified checkpoint.",
    };
  }
  if (
    !checkpoint ||
    checkpoint.runId !== input.scope.runId ||
    checkpoint.jobId !== input.scope.jobId ||
    checkpoint.resultId !== input.scope.resultId ||
    checkpoint.applicationRecordId !== input.scope.applicationRecordId
  ) {
    return {
      status: "stale",
      detail:
        "The verified replay checkpoint no longer matches the exact application lineage.",
    };
  }
  if (!job || job.source !== input.scope.source) {
    return {
      status: "stale",
      detail:
        "The saved job or its source changed after the user-action request was created.",
    };
  }

  return {
    status: "current",
    lineage: { run, result, checkpoint, job },
  };
}

async function persistApplicationRecord(input: {
  ctx: WorkspaceServiceContext;
  job: SavedJob;
  applicationRecordId: string;
  attempt: ApplicationAttempt;
  eventId: string;
  now: string;
}): Promise<void> {
  await withApplicationRecordTransition(
    input.ctx.repository,
    input.applicationRecordId,
    async () => {
      const records = await input.ctx.repository.listApplicationRecords();
      const existing =
        records.find((record) => record.id === input.applicationRecordId) ??
        null;
      if (!existing || existing.jobId !== input.job.id) {
        throw new Error(
          `Application record '${input.applicationRecordId}' does not belong to job '${input.job.id}'.`,
        );
      }
      const emphasis =
        input.attempt.state === "failed"
          ? "critical"
          : input.attempt.state === "paused" ||
              input.attempt.state === "unsupported"
            ? "warning"
            : "neutral";

      await input.ctx.repository.upsertApplicationRecord(
        ApplicationRecordSchema.parse({
          // Continuation updates the attempt projection, not the person's
          // application policy. Keep the mode and every other durable field
          // from the exact record instead of letting schema defaults silently
          // turn Ask before sending back into Fill in only.
          ...existing,
          id: existing.id,
          jobId: input.job.id,
          title: input.job.title,
          company: input.job.company,
          status: existing.status,
          lastActionLabel: input.attempt.summary,
          nextActionLabel: input.attempt.nextActionLabel,
          lastUpdatedAt: input.now,
          lastAttemptState: input.attempt.state,
          questionSummary: buildQuestionSummary(input.attempt.questions),
          latestBlocker: buildLatestBlockerSummary(input.attempt.blocker),
          consentSummary: buildConsentSummary(input.attempt.consentDecisions),
          replaySummary: buildReplaySummary(
            input.attempt.replay,
            input.attempt.visualEvidence,
          ),
          crm: existing.crm,
          events: mergeEvents(existing.events, [
            {
              id: input.eventId,
              at: input.now,
              title: input.attempt.summary,
              detail: input.attempt.detail,
              emphasis,
            },
          ]),
        }),
      );
    },
  );
}

export function reconcileReadyRunAfterApplicationResumption(input: {
  run: ApplyRun;
  results: readonly ApplyJobResult[];
  resumedRun: ApplyRun;
  resumedJobId: string;
  completedAt: string;
  summary: string;
  detail: string;
}): ApplyRun {
  const reconciled = reconcileApplyRunAfterConfirmedSubmission({
    run: input.run,
    results: input.results,
    submittedAt: input.completedAt,
    submittedSummary: input.summary,
    submittedDetail: input.detail,
  });
  const singleCopilot =
    input.run.mode === "copilot" &&
    input.run.jobIds.length === 1 &&
    input.run.jobIds[0] === input.resumedJobId;
  const remaining = reconciled.pendingJobs + reconciled.blockedJobs;
  return ApplyRunSchema.parse({
    ...reconciled,
    ...(singleCopilot
      ? {
          state: input.resumedRun.state,
          currentJobId: input.resumedRun.currentJobId,
          completedAt: input.resumedRun.completedAt,
          pendingJobs: input.resumedRun.pendingJobs,
          submittedJobs: input.resumedRun.submittedJobs,
          skippedJobs: input.resumedRun.skippedJobs,
          blockedJobs: input.resumedRun.blockedJobs,
          failedJobs: input.resumedRun.failedJobs,
        }
      : {}),
    summary:
      singleCopilot || reconciled.state === "completed"
        ? input.summary
        : reconciled.state === "running"
          ? input.run.summary
          : `${input.summary} ${remaining} ${remaining === 1 ? "application still needs" : "applications still need"} review.`,
    detail:
      singleCopilot || reconciled.state === "completed"
        ? input.detail
        : reconciled.state === "running"
          ? input.run.detail
          : "The other applications keep their own pending steps and review state.",
  });
}

/**
 * Resumption attempts this process is running, per workspace store. A claimed
 * attempt that is not in here was left by an earlier run of the app (a
 * restart mid-way) or by a flight that ended without settling it; nothing
 * will ever finish it, so it is taken over instead of leaving its step on
 * "Checking" for ever. Shared across service instances on one store, so a
 * second instance still joins the first one's live attempt.
 */
const liveResumptionAttemptIds = new WeakMap<object, Set<string>>();

function getLiveResumptionAttemptIds(repository: object): Set<string> {
  let ids = liveResumptionAttemptIds.get(repository);
  if (!ids) {
    ids = new Set<string>();
    liveResumptionAttemptIds.set(repository, ids);
  }
  return ids;
}

export function createApplicationUserActionResumer(
  ctx: WorkspaceServiceContext,
  dependencies: ApplicationResumptionDependencies,
): (
  request: UserActionRequest,
  taskLocalCredentials?: TaskLocalApplicationCredentials,
) => Promise<void> {
  const liveAttemptIds = getLiveResumptionAttemptIds(ctx.repository);
  const resume = async (
    request: UserActionRequest,
    scope: ExactApplicationScope,
    attemptId: string,
    taskLocalCredentials?: TaskLocalApplicationCredentials,
  ): Promise<void> => {
    const isPrepareOnlyVerification =
      request.state === "verifying" &&
      isApplicationPrepareOnlyUserAction(request);

    const verificationEventId = getVerificationEventId(request);
    const requestEvents = await ctx.repository.listUserActionEvents({
      requestId: request.id,
    });
    const hasTransitionEvidence =
      request.state === "verifying"
        ? requestEvents.some(
            (event) =>
              (event.operation === "confirm_done" ||
                event.operation === "submit_task_local_credentials" ||
                event.operation === "submit_manual_answer" ||
                event.operation === "record_legal_decision") &&
              event.resultingRevision === request.revision,
          )
        : requestEvents.some(
            (event) =>
              event.operation === "verification_succeeded" &&
              event.id === verificationEventId &&
              event.resultingRevision === request.revision,
          );
    if (!hasTransitionEvidence) return;

    // A typed answer is committed in two writes: the request moves to
    // verifying, then the answer is stored. If the second write failed, the
    // application must not carry on without it (the agent would write its
    // own answer instead). Hand the question back so the person can answer
    // again. A grouped answer is stored in the same write as its transition.
    if (request.state === "verifying") {
      const answerEvent = requestEvents.find(
        (event) =>
          event.operation === "submit_manual_answer" &&
          event.resultingRevision === request.revision &&
          !event.id.endsWith(":grouped_manual_answer"),
      );
      if (answerEvent && scope.resultId) {
        const recordPrefix = `manual_answer_${request.id}_${request.revision}`;
        const storedAnswers = await ctx.repository.listApplicationAnswerRecords(
          {
            runId: scope.runId,
            jobId: scope.jobId,
            resultId: scope.resultId,
            applicationRecordId: scope.applicationRecordId,
          },
        );
        const answerStored = storedAnswers.some(
          (record) =>
            record.id === recordPrefix ||
            record.id.startsWith(`${recordPrefix}_`),
        );
        if (!answerStored) {
          await settlePrepareOnlyVerification({
            ctx,
            outcome: "still_blocked",
            request,
          });
          return;
        }
      }
    }

    const attempts = await ctx.repository.listApplicationAttempts();
    const existingAttempt =
      attempts.find((attempt) => attempt.id === attemptId) ?? null;

    if (
      existingAttempt &&
      !hasMatchingResumptionLineage({
        attempt: existingAttempt,
        request,
        scope,
      })
    ) {
      throw new Error(
        `Application resumption attempt '${attemptId}' has conflicting lineage.`,
      );
    }
    if (existingAttempt?.completedAt) return;

    // This continuation works on the kept page: take back anything the
    // person was allowed to press there (their sign-in, their own send)
    // before Job Finder touches it.
    await ctx.browserRuntime.closeApplicationFormAction?.(
      scope.source,
      scope.resultId,
    );

    const scheduledAt = new Date().toISOString();
    const scheduledAttempt = createResumptionAttempt({
      request,
      scope,
      existingAttempt,
      now: scheduledAt,
      state: "in_progress",
      summary: isPrepareOnlyVerification
        ? "Checking the completed browser step once"
        : "Verified sign-in; retrying this application once",
      detail:
        "Job Finder scheduled one prepare-only retry for the exact application checkpoint. Final submission and account creation remain disabled.",
      completed: false,
    });

    const lineageResult = await readExactLineage({ ctx, scope });
    if (lineageResult.status === "stale" && lineageResult.runEnded) {
      // The run ended under this check (the app closed mid-check, or the
      // person stopped the batch). The step cannot carry on, so it must not
      // stay in Needs you asking for something already done: close it and
      // leave the application as Could not apply with Try again.
      await closeStepOfEndedRun({ ctx, request, scope });
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: existingAttempt ?? scheduledAttempt,
          now: new Date().toISOString(),
          state: "unsupported",
          summary: "Application check stopped because its run ended",
          detail: lineageResult.detail,
          completed: true,
        }),
      );
      return;
    }
    if (lineageResult.status === "stale") {
      const staleAt = new Date().toISOString();
      await settlePrepareOnlyVerification({
        ctx,
        outcome: "still_blocked",
        request,
      });
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: existingAttempt ?? scheduledAttempt,
          now: staleAt,
          state: "unsupported",
          summary: "Application retry skipped because its checkpoint changed",
          detail: lineageResult.detail,
          completed: true,
        }),
      );
      return;
    }

    const { run, result, checkpoint, job } = lineageResult.lineage;
    if (
      !isPrepareOnlyVerification &&
      result.blockerReason !== "auth_required"
    ) {
      const completedAt = new Date().toISOString();
      if (result.lastUserActionResumptionId !== attemptId) {
        await ctx.repository.upsertApplicationAttempt(
          createResumptionAttempt({
            request,
            scope,
            existingAttempt: existingAttempt ?? scheduledAttempt,
            now: completedAt,
            state: "unsupported",
            summary: "Application retry skipped because its result changed",
            detail:
              "The exact result changed without this resumption receipt, so Job Finder did not attribute or repeat another application flow.",
            completed: true,
          }),
        );
        return;
      }
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: existingAttempt ?? scheduledAttempt,
          now: completedAt,
          state: getPersistedResultAttemptState(result),
          summary: result.summary,
          detail: result.detail,
          completed: true,
        }),
      );
      return;
    }

    // Still unfinished here means orphaned (see liveAttemptIds): carry it on.
    const orphanedAttempt = existingAttempt;
    if (orphanedAttempt) {
      console.warn(
        `[apply] taking over application step '${request.id}': its earlier check never finished (started ${orphanedAttempt.startedAt}).`,
      );
    }

    let prerequisites: ApplicationPrerequisites;
    try {
      prerequisites = await dependencies.resolveJobApplyPrerequisites(
        scope.jobId,
      );
    } catch (error) {
      const staleAt = new Date().toISOString();
      await settlePrepareOnlyVerification({
        ctx,
        outcome: "still_blocked",
        request,
      });
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: existingAttempt ?? scheduledAttempt,
          now: staleAt,
          state: "unsupported",
          summary: "Application retry could not reuse its approved resume",
          detail:
            error instanceof Error
              ? error.message
              : "The approved resume prerequisite changed before retry.",
          completed: true,
        }),
      );
      return;
    }

    if (
      prerequisites.job.id !== scope.jobId ||
      prerequisites.job.source !== scope.source
    ) {
      const staleAt = new Date().toISOString();
      await settlePrepareOnlyVerification({
        ctx,
        outcome: "still_blocked",
        request,
      });
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: existingAttempt ?? scheduledAttempt,
          now: staleAt,
          state: "unsupported",
          summary: "Application retry skipped because its saved job changed",
          detail:
            "The resolved resume prerequisites no longer match the exact job and source from the verified user-action request.",
          completed: true,
        }),
      );
      return;
    }

    const [
      profile,
      settings,
      searchPreferences,
      instructionArtifacts,
      debugAttempts,
    ] = await Promise.all([
      ctx.repository.getProfile(),
      ctx.repository.getSettings(),
      ctx.repository.getSearchPreferences(),
      ctx.repository.listSourceInstructionArtifacts(),
      ctx.repository.listSourceDebugAttempts(),
    ]);
    const [answerRecords, questionRecords] = await Promise.all([
      ctx.repository.listApplicationAnswerRecords({
        jobId: scope.jobId,
        applicationRecordId: scope.applicationRecordId,
      }),
      ctx.repository.listApplicationQuestionRecords({
        jobId: scope.jobId,
        applicationRecordId: scope.applicationRecordId,
      }),
    ]);
    const applicationAnswers = applicationAnswersForExecution({
      answerRecords,
      questionRecords,
      idPrefix: `application_${request.id}`,
      ...(scope.applicationRecordId
        ? { applicationRecordId: scope.applicationRecordId }
        : {}),
      jobLocation: job.location,
    });
    const provenanceTargetId =
      selectApplicationSighting(job)?.targetId ??
      job.provenance.at(-1)?.targetId ??
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
          instructionArtifacts,
        )
      : null;
    const recoveryContext = ApplyRecoveryContextSchema.parse({
      previousRunId: run.id,
      previousResultId: result.id,
      previousRunMode: run.mode,
      previousRunState: run.state,
      latestCheckpoint: {
        label: checkpoint.label,
        detail: checkpoint.detail,
        url: checkpoint.url,
        jobState: checkpoint.jobState,
        createdAt: checkpoint.createdAt,
      },
      checkpointUrls: checkpoint.url ? [checkpoint.url] : [],
      blockerSummary: result.blockerSummary,
      retainedVisualEvidence: checkpoint.visualEvidence.filter(
        (evidence) => evidence.retention !== "temporary",
      ),
    });
    // Keep the person's selected answers beside their questions so resumption
    // can fill those fields and continue without repeating the whole form.
    const answeredQuestionLines = applicationAnswers
      .filter((answer) => answer.id.startsWith(`application_${request.id}_`))
      .map(
        (answer) =>
          `Answer to "${answer.question.trim()}": ${answer.answer.trim()}`,
      );
    const instructions = uniqueStrings([
      ...buildInstructionGuidance(activeInstruction),
      ...buildRecoveryInstructions({
        checkpointLabel: checkpoint.label,
        checkpointDetail: checkpoint.detail,
        checkpointUrl: checkpoint.url,
        blockerSummary: result.blockerSummary,
      }),
      ...(answeredQuestionLines.length > 0
        ? [
            "The form was already filled in before it stopped for these questions. Do not retype fields that already hold the right value; answer only the questions below, then carry on to the review step.",
            ...answeredQuestionLines,
          ]
        : []),
    ]);

    let applicationAttachments: Awaited<
      ReturnType<typeof resolveApplicationAttachmentsForExecution>
    > = [];
    let preparationError: Error | null = null;
    try {
      applicationAttachments = await resolveApplicationAttachmentsForExecution({
        jobId: scope.jobId,
        resolver: ctx.candidateAssetResolver,
        answerRecords,
        questionRecords,
      });
    } catch (error) {
      preparationError =
        error instanceof Error
          ? error
          : new Error("Application attachment preparation failed.");
    }

    // Keep the insert-once claim adjacent to browser launch. If activity was
    // paused during any prerequisite read, the action remains unclaimed and
    // resumable instead of leaving an in-progress receipt that later runs
    // cannot safely adopt.
    if (await isActivityPaused(ctx)) return;
    let ownsClaim = true;
    if (orphanedAttempt) {
      await ctx.repository.upsertApplicationAttempt(scheduledAttempt);
    } else {
      ownsClaim =
        await ctx.repository.claimApplicationAttempt(scheduledAttempt);
    }
    if (!ownsClaim) {
      const claimedAttempt = (
        await ctx.repository.listApplicationAttempts()
      ).find((attempt) => attempt.id === attemptId);
      if (
        claimedAttempt &&
        !hasMatchingResumptionLineage({
          attempt: claimedAttempt,
          request,
          scope,
        })
      ) {
        throw new Error(
          `Application resumption attempt '${attemptId}' has conflicting lineage.`,
        );
      }
      return;
    }

    // The continued run works inside the same permission the first run
    // did. It used to be pinned to fill-in-only, so a person who had chosen
    // "Send for me" answered the one question, watched the form fill in
    // again, and still had to send it themselves.
    const applyAuthority = await resolveApplyAuthorityForJob({
      repository: ctx.repository,
      job: { id: job.id, campaignId: run.campaignId ?? null },
      resumeSha256: prerequisites.resumeArtifact.sha256,
      applicationUrl: job.applicationUrl ?? job.canonicalUrl,
      now: new Date().toISOString(),
    });
    const siteLabel = resolveApplySiteLabel({
      targetLabel: provenanceTarget?.label ?? null,
      applicationUrl:
        prerequisites.job.applicationUrl ?? prerequisites.job.canonicalUrl,
    });
    let preparedHandoff: ApplySubmissionHandoff | null = null;
    let preparedReviewCard: ApplicationReviewCard | null = null;
    let taskLocalCredentialStepCompleted = false;
    // Start on the page the run stopped on, in the tab that is already open
    // there, so whatever the person did on it is still done.
    const continueFromUrl = checkpoint.url ?? null;

    let executionResult: ApplyExecutionResult;
    try {
      if (preparationError) {
        throw preparationError;
      }
      await ctx.markApplicationPreparationStarted({
        resultId: result.id,
        runId: run.id,
        jobId: job.id,
      });
      // The browser layer opens the page; Job Finder decides what goes in the
      // form and whether anything may be sent.
      const applyFlowFacts = {
        applicationPageBindingKey: result.id,
        job: prerequisites.job,
        resumeArtifact: prerequisites.resumeArtifact,
        profile,
        ...(applicationAttachments.length > 0
          ? { applicationAttachments }
          : {}),
        settings,
        mode:
          applyAuthority.authority.mode === "autonomous_submit"
            ? ("submit_when_ready" as const)
            : ("prepare_only" as const),
        idempotencyKey: attemptId,
        accountCreationAuthorized: false as const,
        // Field saves are allowed by default (ADR 0024).
        intermediateMutationsAuthorized: true as const,
        intermediateMutationAllowedOrigins: [],
        applyAutomationMode: applyAuthority.authority.mode,
        submitAuthorized: applyAuthority.authority.submitAuthorized,
        preApprovedAttestationKinds:
          applyAuthority.authority.preApprovedAttestationKinds,
        salaryDisclosure: applyAuthority.authority.salaryDisclosure,
        applyAllowedOrigins: [...applyAuthority.authority.allowedOrigins],
        ...(continueFromUrl ? { startingUrl: continueFromUrl } : {}),
        ...(taskLocalCredentials
          ? {
              prepareTaskLocalCredentials: async (input: {
                session: ApplyPageSession;
              }) => {
                try {
                  await completeTaskLocalSignIn({
                    hands: createApplyPageHands(input.session),
                    clickAuthorizedFormAction: (ref) =>
                      input.session.clickAuthorizedFormAction(ref),
                    credential: {
                      reference: taskLocalCredentials.reference,
                      load: () => ({
                        identifier: taskLocalCredentials.identifier,
                        password: taskLocalCredentials.password,
                      }),
                    },
                  });
                  taskLocalCredentialStepCompleted = true;
                } finally {
                  taskLocalCredentials.identifier = "";
                  taskLocalCredentials.password = "";
                }
              },
            }
          : {}),
        recoveryContext,
        ...(instructions.length > 0 ? { instructions } : {}),
        ...buildVisualExecutionOptions({
          ctx,
          enabled: run.visualCheckpointsEnabled,
          source: scope.source,
        }),
      };
      const rawResult = enforceResolvedApplyAuthorityResult(
        applyAuthority.authority,
        await ctx.browserRuntime.executeApplicationFlow(scope.source, {
          ...applyFlowFacts,
          onWaitingForBrowserTab: () =>
            persistApplicationWaitingForBrowserTab({
              repository: ctx.repository,
              resultId: result.id,
              runId: run.id,
              jobId: job.id,
            }),
          prepareApplicationForm: createApplyFormPreparer({
            readReusableAnswers: async () => [
              ...applicationAnswers,
              ...(ctx.readSavedAnswers?.() ?? []),
            ],
            executionInput: applyFlowFacts,
            applicationRecordId: scope.applicationRecordId,
            aiClient: ctx.aiClient,
            onProgress: (progress) =>
              persistApplicationPreparationProgress({
                repository: ctx.repository,
                resultId: result.id,
                runId: run.id,
                jobId: job.id,
                progress,
              }),
            ...(applyAuthority.envelope
              ? { envelope: applyAuthority.envelope }
              : {}),
            onPrepared: ({ handoff, reviewCard }) => {
              preparedHandoff = handoff;
              preparedReviewCard = reviewCard;
            },
            letters: buildApplyLetterDependencies({
              aiClient: ctx.aiClient,
              documentManager: ctx.documentManager,
              job: applyFlowFacts.job,
              profile: applyFlowFacts.profile,
              settings: applyFlowFacts.settings,
            }),
            siteLabel,
          }),
        }),
      );

      const sourceDebugEvidenceRefIds = buildEvidenceRefIdsFromInstruction({
        activeInstruction,
        sourceDebugAttempts: debugAttempts,
      });
      executionResult = ApplyExecutionResultSchema.parse({
        ...rawResult,
        blocker: mergeAttemptBlocker({
          blocker: rawResult.blocker,
          sourceDebugEvidenceRefIds,
          defaultUrl: job.applicationUrl ?? job.canonicalUrl,
        }),
        replay: mergeAttemptReplay({
          replay: rawResult.replay,
          activeInstruction,
          sourceDebugEvidenceRefIds,
          fallbackUrl: job.applicationUrl ?? job.canonicalUrl,
        }),
        submittedAt: null,
      });
    } catch (error) {
      executionResult = createFailedExecutionResult(error);
    }

    const refreshedLineage = await readExactLineage({ ctx, scope });
    if (refreshedLineage.status === "stale") {
      const staleAt = new Date().toISOString();
      await settlePrepareOnlyVerification({
        ctx,
        outcome: "still_blocked",
        request,
      });
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: existingAttempt ?? scheduledAttempt,
          now: staleAt,
          state: "unsupported",
          summary:
            "Application retry result was not saved because its checkpoint changed",
          detail: refreshedLineage.detail,
          completed: true,
        }),
      );
      return;
    }

    const currentResult = refreshedLineage.lineage.result;
    if (JSON.stringify(currentResult) !== JSON.stringify(result)) {
      const staleAt = new Date().toISOString();
      await settlePrepareOnlyVerification({
        ctx,
        outcome: "still_blocked",
        request,
      });
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: existingAttempt ?? scheduledAttempt,
          now: staleAt,
          state: "unsupported",
          summary:
            "Application retry result was not saved because the result changed",
          detail:
            "Another flow changed the exact result while this retry was running, so Job Finder did not overwrite it.",
          completed: true,
        }),
      );
      return;
    }
    if (
      !isPrepareOnlyVerification &&
      currentResult.blockerReason !== "auth_required"
    ) {
      const completedAt = new Date().toISOString();
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: existingAttempt ?? scheduledAttempt,
          now: completedAt,
          state:
            currentResult.lastUserActionResumptionId === attemptId
              ? getPersistedResultAttemptState(currentResult)
              : "unsupported",
          summary:
            currentResult.lastUserActionResumptionId === attemptId
              ? currentResult.summary
              : "Application retry result was not saved because the result changed",
          detail:
            currentResult.lastUserActionResumptionId === attemptId
              ? currentResult.detail
              : "Another flow changed the exact result while this retry was running, so Job Finder did not overwrite it.",
          completed: true,
        }),
      );
      return;
    }

    const prepareOnlyVerificationOutcome = getPrepareOnlyVerificationOutcome(
      request,
      executionResult,
    );
    const taskLocalCredentialVerificationOutcome = taskLocalCredentials
      ? getTaskLocalCredentialVerificationOutcome(
          request,
          executionResult,
          taskLocalCredentialStepCompleted,
        )
      : null;
    const verificationOutcome =
      prepareOnlyVerificationOutcome ?? taskLocalCredentialVerificationOutcome;
    if (verificationOutcome) {
      const settledRequest = prepareOnlyVerificationOutcome
        ? await settlePrepareOnlyVerification({
            ctx,
            outcome: verificationOutcome,
            request,
          })
        : await settleTaskLocalCredentialVerification({
            ctx,
            outcome: verificationOutcome,
            request,
          });
      if (!settledRequest) {
        const staleAt = new Date().toISOString();
        await ctx.repository.upsertApplicationAttempt(
          createResumptionAttempt({
            request,
            scope,
            existingAttempt: existingAttempt ?? scheduledAttempt,
            now: staleAt,
            state: "unsupported",
            summary: "Application retry stopped because the action changed",
            detail:
              "The user-action request changed while its prepare-only verification was running, so Job Finder did not claim completion.",
            completed: true,
          }),
        );
        return;
      }
      if (verificationOutcome === "still_blocked") {
        const blockedAt = new Date().toISOString();
        await ctx.repository.upsertApplicationAttempt(
          createResumptionAttempt({
            request,
            scope,
            existingAttempt: existingAttempt ?? scheduledAttempt,
            now: blockedAt,
            state: executionResult.state,
            summary: "Browser step is still blocking this application",
            detail:
              "The exact prepare-only retry found the same persisted blocker, so Job Finder kept the action open and did not claim completion.",
            completed: true,
            executionResult,
          }),
        );
        return;
      }
    }

    const finalExecutionResult =
      verificationOutcome === "verified" &&
      executionResult.blocker === null &&
      executionResult.state === "ready"
        ? ApplyExecutionResultSchema.parse({
            ...executionResult,
            summary:
              "The browser step is complete and this application is ready for you.",
            detail:
              "Job Finder verified the exact step on the retained application page and continued the form without sending it.",
          })
        : executionResult;
    const completedAt = new Date().toISOString();
    const finalAttempt = createResumptionAttempt({
      request,
      scope,
      existingAttempt: existingAttempt ?? scheduledAttempt,
      now: completedAt,
      state: finalExecutionResult.state,
      summary: finalExecutionResult.summary,
      detail: finalExecutionResult.detail,
      completed: true,
      executionResult: finalExecutionResult,
    });
    const resumedArtifacts = buildApplyCopilotArtifacts({
      existingAnswerRecords: await ctx.repository.listApplicationAnswerRecords({
        applicationRecordId: scope.applicationRecordId,
      }),
      applicationRecordId: scope.applicationRecordId,
      job,
      executionResult: finalExecutionResult,
      resumeArtifact: prerequisites.resumeArtifact,
      detectedAt: completedAt,
      runId: run.id,
      resultId: result.id,
      visualCheckpointsEnabled: run.visualCheckpointsEnabled,
      reviewCard: creditOwnApplicationAnswers(
        mergeApplyReviewCards(result.reviewCard, preparedReviewCard),
        await ctx.repository.listApplicationQuestionRecords({
          applicationRecordId: scope.applicationRecordId,
        }),
        await ctx.repository.listApplicationAnswerRecords({
          applicationRecordId: scope.applicationRecordId,
        }),
      ),
    });
    const existingQuestionIds = new Set(
      questionRecords.map((record) => record.id),
    );
    const blockedQuestionIds = new Set(
      (finalExecutionResult.blocker?.questionIds ?? []).map(
        (questionId) =>
          `apply_question_${scope.applicationRecordId}_${questionId}`,
      ),
    );
    const newQuestionRecords = resumedArtifacts.questionRecords.filter(
      (record) =>
        blockedQuestionIds.has(record.id) &&
        !existingQuestionIds.has(record.id),
    );
    const newQuestionIds = new Set(
      newQuestionRecords.map((record) => record.id),
    );
    const newAnswerRecords = resumedArtifacts.answerRecords.filter((record) =>
      newQuestionIds.has(record.questionId),
    );
    const isConsentBlocked =
      finalExecutionResult.blocker?.code === "missing_consent";
    const nextResultState = isConsentBlocked
      ? "blocked"
      : mapExecutionResultToApplyJobState({
          consentRequests: [],
          executionResult: finalExecutionResult,
        });
    const nextResult = ApplyJobResultSchema.parse({
      ...result,
      state: nextResultState,
      summary: finalExecutionResult.summary,
      detail: finalExecutionResult.detail,
      agentTiming: finalExecutionResult.agentTiming,
      updatedAt: completedAt,
      completedAt: getResultCompletedAt({ executionResult, now: completedAt }),
      blockerReason: mapExecutionResultToApplyBlockerReason(
        finalExecutionResult.blocker,
      ),
      blockerSummary: finalExecutionResult.blocker?.summary ?? null,
      visualObservationSets: finalExecutionResult.visualObservationSets,
      visualCheckpoints: finalExecutionResult.visualCheckpoints,
      latestQuestionCount: resumedArtifacts.result.latestQuestionCount,
      latestAnswerCount: resumedArtifacts.result.latestAnswerCount,
      pendingConsentRequestCount: isConsentBlocked ? 1 : 0,
      latestCheckpointId: checkpoint.id,
      lastUserActionResumptionId: attemptId,
      reviewCard: resumedArtifacts.result.reviewCard,
      privacyReceipt: resumedArtifacts.result.privacyReceipt,
    });

    await ctx.repository.upsertApplicationAttempt({
      ...finalAttempt,
      completedAt: null,
    });
    const resultClaimed = await ctx.repository.compareAndSwapApplyJobResult({
      expected: result,
      result: nextResult,
    });
    if (!resultClaimed) {
      const staleAt = new Date().toISOString();
      await ctx.repository.upsertApplicationAttempt(
        createResumptionAttempt({
          request,
          scope,
          existingAttempt: finalAttempt,
          now: staleAt,
          state: "unsupported",
          summary:
            "Application retry result was not saved because the result changed",
          detail:
            "Another flow changed the exact result while this retry was running, so Job Finder did not overwrite it.",
          completed: true,
        }),
      );
      return;
    }
    await Promise.all([
      ctx.repository.upsertApplicationAttempt(finalAttempt),
      ...newQuestionRecords.map((record) =>
        ctx.repository.upsertApplicationQuestionRecord(record),
      ),
      ...newAnswerRecords.map((record) =>
        ctx.repository.upsertApplicationAnswerRecord(record),
      ),
    ]);
    await persistApplicationRecord({
      ctx,
      job,
      applicationRecordId: scope.applicationRecordId,
      attempt: finalAttempt,
      eventId: `event_${attemptId}`,
      now: completedAt,
    });
    await persistApplicationUserAction({
      repository: ctx.repository,
      applicationRecordId: scope.applicationRecordId,
      job,
      runId: run.id,
      resultId: nextResult.id,
      resultState: nextResult.state,
      resultStartedAt: nextResult.startedAt,
      replayCheckpointId: checkpoint.id,
      blocker: finalExecutionResult.blocker,
      questions: resumedArtifacts.questionRecords,
      occurredAt: completedAt,
    });
    await handApplicationPageToPersonForAccessStep({
      browserRuntime: ctx.browserRuntime,
      source: job.source,
      resultId: nextResult.id,
      blocker: finalExecutionResult.blocker,
    });
    if (
      nextResult.state === "awaiting_review" &&
      nextResult.blockerReason === null
    ) {
      const [currentRuns, currentResults] = await Promise.all([
        ctx.repository.listApplyRuns({ id: run.id }),
        ctx.repository.listApplyJobResults({ runId: run.id }),
      ]);
      const currentRun = currentRuns[0];
      if (
        currentRun &&
        !["cancelled", "failed", "completed"].includes(currentRun.state) &&
        currentResults.some(
          (candidate) =>
            candidate.id === nextResult.id &&
            candidate.lastUserActionResumptionId === attemptId &&
            candidate.state === "awaiting_review" &&
            candidate.blockerReason === null,
        )
      ) {
        await ctx.repository.upsertApplyRun(
          reconcileReadyRunAfterApplicationResumption({
            run: currentRun,
            results: currentResults,
            resumedRun: resumedArtifacts.run,
            resumedJobId: job.id,
            completedAt,
            summary: finalExecutionResult.summary,
            detail: finalExecutionResult.detail,
          }),
        );
      }
    }
    if (nextResult.state === "failed") {
      const [currentRuns, currentResults] = await Promise.all([
        ctx.repository.listApplyRuns({ id: run.id }),
        ctx.repository.listApplyJobResults({ runId: run.id }),
      ]);
      const currentRun = currentRuns[0];
      if (currentRun && currentRun.state !== "cancelled") {
        await ctx.repository.upsertApplyRun(
          reconcileApplyRunAfterConfirmedSubmission({
            run: currentRun,
            results: currentResults,
            submittedAt: completedAt,
            submittedSummary: finalExecutionResult.summary,
            submittedDetail: finalExecutionResult.detail,
          }),
        );
      }
    }
    // Sending happens after the preparation is on record, the same way an
    // ordinary run does it; only a permission that covers this exact
    // application ever reaches the send.
    const sent = await sendPreparedApplicationIfAllowed({
      ctx,
      handoff: preparedHandoff,
      envelope: applyAuthority.envelope,
      source: scope.source,
      lineage: {
        runId: run.id,
        jobId: job.id,
        resultId: nextResult.id,
        applicationRecordId: scope.applicationRecordId,
        campaignId: run.campaignId ?? null,
      },
      resumeArtifact: prerequisites.resumeArtifact,
      siteLabel,
    }).catch((sendError: unknown) => {
      console.error("Failed to send the continued application.", sendError);
      return notSentAfterError(sendError);
    });
    await recordPreparedApplicationNotSent({
      repository: ctx.repository,
      lineage: {
        runId: run.id,
        jobId: job.id,
        resultId: nextResult.id,
        applicationRecordId: scope.applicationRecordId,
        campaignId: run.campaignId ?? null,
      },
      attempt: sent,
    }).catch(() => undefined);
    if (sent) {
      if (sent.confirmedSubmitted) {
        const [currentRuns, currentResults] = await Promise.all([
          ctx.repository.listApplyRuns({ id: run.id }),
          ctx.repository.listApplyJobResults({ runId: run.id }),
        ]);
        const currentRun = currentRuns[0];
        if (currentRun && currentRun.state !== "cancelled") {
          await ctx.repository.upsertApplyRun(
            reconcileApplyRunAfterConfirmedSubmission({
              run: currentRun,
              results: currentResults,
              submittedAt: new Date().toISOString(),
              submittedSummary: sent.summary,
              submittedDetail: sent.detail,
            }),
          );
        }
      }
      const currentRecord = (
        await ctx.repository.listApplicationRecords()
      ).find((record) => record.id === scope.applicationRecordId);
      await persistApplicationRecord({
        ctx,
        job,
        applicationRecordId: scope.applicationRecordId,
        attempt: {
          ...finalAttempt,
          // The submission runtime has already written the durable outcome.
          // Do not overwrite that authoritative submitted/uncertain state
          // with the preparation attempt's earlier "ready" state.
          state: sent.confirmedSubmitted
            ? "submitted"
            : sent.pageClosed || sent.formGone
              ? "failed"
              : (currentRecord?.lastAttemptState ?? finalAttempt.state),
          summary: sent.summary,
          detail: sent.detail,
          nextActionLabel: sent.nextActionLabel,
        },
        eventId: `event_${attemptId}_sent`,
        now: new Date().toISOString(),
      });
    }
    await persistAutomaticApplicationSafeguards({
      ctx,
      run,
      result: nextResult,
      job,
      now: completedAt,
    }).catch((safeguardError: unknown) => {
      console.error(
        "Failed to persist automatic application safeguards.",
        safeguardError,
      );
    });
  };

  return async (request, taskLocalCredentials) => {
    const scope = getExactApplicationScope(request);
    if (!scope) return;
    const attemptId = getResumptionAttemptId(request);
    if (liveAttemptIds.has(attemptId)) return;
    liveAttemptIds.add(attemptId);
    try {
      await resume(request, scope, attemptId, taskLocalCredentials);
    } finally {
      liveAttemptIds.delete(attemptId);
      await releaseFinishedApplicationPages({
        ...ctx,
        runId: scope.runId,
        applicationRecordId: scope.applicationRecordId,
      });
    }
  };
}
