import { resolveApplyAuthorityForJob } from "./apply-authority-resolution";
import { releaseFinishedApplicationPages } from "./application-page-lifecycle";
import {
  ApplicationAnswerRecordSchema,
  compareApplicationAnswerRecency,
  type ApplicationAnswerRecord,
  type SubmitUserActionManualAnswerCommand,
  UserActionCommandSchema,
  type UserActionCommand,
  type UserActionRequest,
  JobFinderActivityControlSchema,
  type ApplicationQuestionRecord,
  type ApplyJobResult,
} from "@nestor/contracts";
import {
  buildApplyFormObservation,
  inferAttestationKind,
  inferQuestionKind,
  selectObservedSignInAction,
} from "@nestor/browser-agent";

import {
  isUserActionTerminal,
  reduceUserActionCommand,
} from "../user-action-domain";
import {
  rememberWorkspaceAnswer,
  normalizeAnswerQuestion,
} from "./workspace-answer-memory";
import {
  isApplicationAuthenticationUserActionKind,
  isApplicationPrepareOnlyUserAction,
  releaseApplicationRecordAfterDismissedUserAction,
  retireCancelledApplicationUserActions,
} from "./workspace-application-user-action";
import type { JobFinderRepository } from "@nestor/db";

import type {
  WorkspaceServiceContext,
} from "./workspace-service-context";
import type { JobFinderWorkspaceService } from "./workspace-service-contracts";
import { readSavedJob } from "./read-saved-job";
import {
  getUserActionVerificationFlightKey,
  isSourceAccessUserAction,
  verifySourceAccessUserAction,
} from "./workspace-user-action-verification";

type WorkspaceUserActionMethods = Pick<
  JobFinderWorkspaceService,
  "performUserAction"
> & {
  resumeVerifyingUserActions(): Promise<void>;
};

/**
 * Fixed upper bound for concurrently running user-action resumption flights
 * (source-access probes and prepare-only application retries). A small bound
 * keeps snapshot-triggered fan-out deterministic and consistent with the
 * prepare-only safety model instead of launching every resolved action at
 * once.
 */
export const USER_ACTION_RESUMPTION_CONCURRENCY = 2;

/**
 * Fail-closed activity gate: while global activity is paused, or when the
 * activity control cannot be read, no browser or application work may be
 * launched. Callers must skip the work and leave the affected user actions in
 * their current state so they stay resumable after activity resumes.
 */
/**
 * The opposite gate for explicit user actions: a deliberate click (Search
 * now, Run now, Check source, Prepare, opening the browser) clears a pause
 * instead of failing on it. Automated work must never call this; it keeps
 * using {@link isWorkspaceActivityPaused}.
 */
export async function resumePausedActivityForUserAction(
  repository: Pick<
    JobFinderRepository,
    "getActivityControl" | "saveActivityControl"
  >,
): Promise<void> {
  const control = await repository.getActivityControl();
  if (!control.paused) {
    return;
  }
  await repository.saveActivityControl(
    JobFinderActivityControlSchema.parse({
      paused: false,
      pausedAt: null,
      reason: null,
    }),
  );
}

export async function isWorkspaceActivityPaused(
  repository: Pick<JobFinderRepository, "getActivityControl">,
): Promise<boolean> {
  try {
    return (await repository.getActivityControl()).paused;
  } catch {
    // An unreadable control surface must never open the gate.
    return true;
  }
}

/**
 * Deterministic bounded-concurrency runner: items are processed in list order
 * by at most `concurrency` workers. The first task error stops scheduling new
 * tasks; in-flight tasks drain before the error is rethrown so no rejection is
 * dropped and unstarted items simply stay resumable.
 */
async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let firstError: unknown = null;
  const worker = async (): Promise<void> => {
    while (cursor < items.length && firstError === null) {
      const item = items[cursor];
      cursor += 1;
      if (item === undefined) continue;
      try {
        await task(item);
      } catch (error) {
        firstError ??= error;
        return;
      }
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError instanceof Error) throw firstError;
  if (firstError !== null && firstError !== undefined) {
    throw new Error("User-action resumption failed with an unknown error.");
  }
}

/** Latest persisted answer record for a question, with a deterministic tie-break. */
function latestAnswerForQuestion(
  records: readonly ApplicationAnswerRecord[],
  questionId: string,
): ApplicationAnswerRecord | null {
  let latest: ApplicationAnswerRecord | null = null;
  for (const record of records) {
    if (record.questionId !== questionId) continue;
    if (
      latest === null ||
      compareApplicationAnswerRecency(record, latest) < 0
    ) {
      latest = record;
    }
  }
  return latest;
}

/**
 * Proves the caller's exact `submit_manual_answer` command event is already
 * persisted. The event id is the caller's commandId, so a grouped apply event
 * (which uses its own deterministic id) can never be mistaken for the caller's
 * command; the previous/resulting revisions pin the exact transition.
 */
async function hasPersistedExactSubmitManualAnswerEvent(input: {
  ctx: WorkspaceServiceContext;
  command: SubmitUserActionManualAnswerCommand;
  request: UserActionRequest;
}): Promise<boolean> {
  const events = await input.ctx.repository.listUserActionEvents({
    requestId: input.request.id,
    operation: "submit_manual_answer",
  });
  return events.some(
    (event) =>
      event.id === input.command.commandId &&
      event.requestId === input.request.id &&
      event.operation === "submit_manual_answer" &&
      event.previousRevision === input.command.expectedRevision &&
      event.resultingRevision === input.command.expectedRevision + 1 &&
      event.resultingState === "verifying",
  );
}

async function persistManualAnswer(input: {
  command: SubmitUserActionManualAnswerCommand;
  ctx: WorkspaceServiceContext;
  request: UserActionRequest;
  resultingRevision: number;
}): Promise<{ prompt: string; answer: string }[]> {
  if (input.request.scope.type !== "application") {
    throw new Error("Manual answers require an application action.");
  }

  const scope = input.request.scope;
  if (!scope.applicationRecordId) {
    throw new Error(
      "This manual answer is missing its exact application record scope.",
    );
  }
  if (!scope.resultId) {
    throw new Error(
      "This manual answer is missing its exact application result scope.",
    );
  }
  const allQuestions =
    await input.ctx.repository.listApplicationQuestionRecords({
      runId: scope.runId,
      jobId: scope.jobId,
      resultId: scope.resultId,
      applicationRecordId: scope.applicationRecordId,
    });
  const records = await input.ctx.repository.listApplicationAnswerRecords({
    runId: scope.runId,
    jobId: scope.jobId,
    resultId: scope.resultId,
    applicationRecordId: scope.applicationRecordId,
  });
  const recordPrefix = `manual_answer_${input.request.id}_${input.resultingRevision}`;
  const retryQuestionIds = new Set(
    records
      .filter(
        (record) =>
          record.id === recordPrefix ||
          (record.id.startsWith(`${recordPrefix}_`) &&
            /^\d+$/u.test(record.id.slice(recordPrefix.length + 1))),
      )
      .map((record) => record.questionId),
  );
  // A partially saved command can be retried after earlier questions already
  // became answered. The current form can also detect an unanswered field
  // whose persisted record was marked answered by an earlier failed check.
  const attempts = await input.ctx.repository.listApplicationAttempts({
    applicationRecordId: scope.applicationRecordId,
  });
  const latestAttempt = [...attempts].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0];
  const activeQuestionIds = latestAttempt
    ? new Set(
        latestAttempt.questions
          .filter((question) => question.status === "detected")
          .map((question) => question.id),
      )
    : null;
  const questions = allQuestions.filter(
    (question) =>
      retryQuestionIds.has(question.id) ||
      ((question.status === "detected" ||
        activeQuestionIds?.has(question.id) ||
        activeQuestionIds?.has(
          question.id.replace(
            `apply_question_${scope.applicationRecordId}_`,
            "",
          ),
        )) &&
        (!activeQuestionIds ||
          activeQuestionIds.has(question.id) ||
          activeQuestionIds.has(
            question.id.replace(
              `apply_question_${scope.applicationRecordId}_`,
              "",
            ),
          ))),
  );

  // A multi-question step arrives as one command with every answer tied to
  // its question; a single-question step still arrives as one bare answer.
  const pairs: { question: (typeof questions)[number]; answer: string }[] = [];
  if (input.command.answers && input.command.answers.length > 0) {
    for (const entry of input.command.answers) {
      const question = questions.find(
        (candidate) =>
          candidate.id === entry.questionId ||
          candidate.id ===
            `apply_question_${scope.applicationRecordId}_${entry.questionId}`,
      );
      if (!question) {
        throw new Error(
          "One of these answers does not match a question Job Finder is waiting on. Reload Needs you and try again.",
        );
      }
      pairs.push({ question, answer: entry.answer.trim() });
    }
  } else {
    // Include the exact saved question on a retry. Legacy detected questions
    // with a user answer do not make a new bare answer ambiguous.
    const answeredQuestionIds = new Set(
      (questions.length === 1
        ? []
        : await input.ctx.repository.listApplicationAnswerRecords({
            runId: scope.runId,
            jobId: scope.jobId,
            resultId: scope.resultId,
            applicationRecordId: scope.applicationRecordId,
          })
      )
        .filter((record) => record.sourceKind === "user")
        .map((record) => record.questionId),
    );
    const waiting =
      questions.length === 1
        ? questions
        : questions.filter(
            (question) =>
              retryQuestionIds.has(question.id) ||
              !answeredQuestionIds.has(question.id),
          );
    if (waiting.length !== 1) {
      throw new Error(
        "This step has several questions; answer them together from Needs you.",
      );
    }
    const question = waiting[0];
    if (!question) return [];
    pairs.push({ question, answer: input.command.answer.trim() });
  }

  let pairIndex = 0;
  for (const pair of pairs) {
    pairIndex += 1;
    await persistOneManualAnswer({
      ...input,
      question: pair.question,
      answer: pair.answer,
      // Several answers in one command each need their own record id.
      recordSuffix: pairs.length === 1 ? "" : `_${pairIndex}`,
    });
  }
  await input.ctx.repository.saveUserActionAnswerDraft({
    requestId: input.request.id,
    expectedRevision: input.resultingRevision,
    draft: null,
  });
  return pairs.map((pair) => ({
    prompt: pair.question.prompt,
    answer: pair.answer,
  }));
}

const SAME_ANSWER_COMMAND_PREFIX = "same_answer_";

const OPEN_MANUAL_ANSWER_STATES = [
  "pending",
  "page_opened",
  "awaiting_user",
  "still_blocked",
] as const;

/**
 * Other open question steps a just-given answer covers completely: every
 * question they still wait on (every required one at least) is the same
 * question, by its normalized wording. Factual answers can cover the batch;
 * declarations and context-dependent answers need deliberate saving to be
 * reused on another application.
 */
export async function findManualAnswerStepsCoveredBy(input: {
  ctx: Pick<WorkspaceServiceContext, "repository">;
  answered: readonly { prompt: string; answer: string }[];
  /** The step just answered; null when reading answers already saved. */
  request: UserActionRequest | null;
  savedForFuture: boolean;
  states?: readonly (typeof OPEN_MANUAL_ANSWER_STATES)[number][];
}): Promise<
  {
    request: UserActionRequest;
    answers: { questionId: string; answer: string }[];
  }[]
> {
  const { ctx, request } = input;
  if (
    (request && request.scope.type !== "application") ||
    input.answered.length === 0
  ) {
    return [];
  }
  const runId =
    request?.scope.type === "application" ? request.scope.runId : null;
  const answerByPrompt = new Map(
    input.answered.map((entry) => [
      normalizeAnswerQuestion(entry.prompt),
      entry.answer,
    ]),
  );
  const candidates = (
    await ctx.repository.listUserActionRequests({
      scopeType: "application",
      states: [...(input.states ?? OPEN_MANUAL_ANSWER_STATES)],
    })
  ).filter(
    (candidate) =>
      candidate.id !== request?.id &&
      candidate.kind === "manual_answer" &&
      candidate.scope.type === "application" &&
      Boolean(candidate.scope.resultId) &&
      Boolean(candidate.scope.applicationRecordId) &&
      (input.savedForFuture || candidate.scope.runId === runId),
  );
  const matchingSteps: {
    request: UserActionRequest;
    scope: {
      runId: string;
      jobId: string;
      resultId: string;
      applicationRecordId: string;
    };
    answers: { questionId: string; answer: string }[];
    salaryQuestions: ApplicationQuestionRecord[];
  }[] = [];
  const isPayQuestion = (question: ApplicationQuestionRecord) =>
    question.kind === "salary_expectation" ||
    inferQuestionKind({
      label: question.prompt,
      groupLabel: question.description ?? "",
      placeholder: "",
      kind: "other",
    }) === "salary_expectation";
  for (const candidate of candidates) {
    if (candidate.scope.type !== "application") continue;
    const scope = {
      runId: candidate.scope.runId,
      jobId: candidate.scope.jobId,
      resultId: candidate.scope.resultId ?? "",
      applicationRecordId: candidate.scope.applicationRecordId ?? "",
    };
    const [questions, answerRecords] = await Promise.all([
      ctx.repository.listApplicationQuestionRecords(scope),
      ctx.repository.listApplicationAnswerRecords(scope),
    ]);
    const answeredIds = new Set(
      answerRecords
        .filter((record) => record.sourceKind === "user")
        .map((record) => record.questionId),
    );
    const waiting = questions.filter(
      (question) =>
        question.status === "detected" && !answeredIds.has(question.id),
    );
    const answers = waiting.flatMap((question) => {
      const answer = answerByPrompt.get(
        normalizeAnswerQuestion(question.prompt),
      );
      if (!answer) return [];
      if (
        question.kind === "work_authorization" ||
        question.kind === "visa_sponsorship"
      )
        return [];
      if (
        !input.savedForFuture &&
        /neither.*(?:country|region)|ambiguous|does not (?:identify|name).*country/iu.test(
          question.note ?? "",
        )
      )
        return [];
      if (
        !input.savedForFuture &&
        inferAttestationKind({
          label: question.prompt,
          groupLabel: question.description ?? "",
          placeholder: "",
          kind: "other",
        }) !== null
      )
        return [];
      return [{ questionId: question.id, answer }];
    });
    const everyRequiredCovered = waiting.every(
      (question) =>
        question.isRequired === false ||
        answers.some((entry) => entry.questionId === question.id),
    );
    if (answers.length > 0 && everyRequiredCovered) {
      matchingSteps.push({
        request: candidate,
        scope,
        answers,
        salaryQuestions: waiting.filter(
          (question) =>
            answers.some((entry) => entry.questionId === question.id) &&
            isPayQuestion(question),
        ),
      });
    }
  }

  // Snapshot recovery checks every pending step. Read salary facts only for
  // prompts that can actually be answered, and never copy the full job store.
  const salaryJobIds = [
    ...new Set(
      matchingSteps
        .filter((step) => step.salaryQuestions.length > 0)
        .map((step) => step.scope.jobId),
    ),
  ];
  const salaryJobs = new Map(
    (salaryJobIds.length > 0
      ? await ctx.repository.listSavedJobsByIds(salaryJobIds)
      : []
    ).map((job) => [job.id, job]),
  );
  const resultsByApplication = new Map<string, readonly ApplyJobResult[]>();
  const covered: {
    request: UserActionRequest;
    answers: { questionId: string; answer: string }[];
  }[] = [];
  for (const step of matchingSteps) {
    let answers = step.answers;
    if (step.salaryQuestions.length > 0) {
      const { scope } = step;
      const job = salaryJobs.get(scope.jobId);
      let payDisclosed = false;
      if (job) {
        const resultKey = JSON.stringify([
          scope.runId,
          scope.jobId,
          scope.applicationRecordId,
        ]);
        let results = resultsByApplication.get(resultKey);
        if (!results) {
          results = await ctx.repository.listApplyJobResults({
            runId: scope.runId,
            jobId: scope.jobId,
            applicationRecordId: scope.applicationRecordId,
          });
          resultsByApplication.set(resultKey, results);
        }
        const result = results.find(
          (entry) =>
            entry.id === scope.resultId &&
            entry.runId === scope.runId &&
            entry.jobId === scope.jobId &&
            entry.applicationRecordId === scope.applicationRecordId,
        );
        // Cache facts for this lookup only. Permission is checked separately
        // for every step, so a changed pay choice takes effect immediately.
        const { authority } = await resolveApplyAuthorityForJob({
          repository: ctx.repository,
          job,
          resumeSha256: result?.privacyReceipt?.resume.sha256,
          applicationUrl: job.applicationUrl ?? job.canonicalUrl,
          now: new Date().toISOString(),
        });
        payDisclosed = authority.salaryDisclosure === "answer_from_profile";
      }
      if (!payDisclosed) {
        if (
          step.salaryQuestions.some((question) => question.isRequired !== false)
        )
          continue;
        const salaryQuestionIds = new Set(
          step.salaryQuestions.map((question) => question.id),
        );
        answers = answers.filter(
          (answer) => !salaryQuestionIds.has(answer.questionId),
        );
      }
    }
    if (answers.length > 0) covered.push({ request: step.request, answers });
  }
  return covered;
}

async function persistOneManualAnswer(input: {
  command: SubmitUserActionManualAnswerCommand;
  ctx: WorkspaceServiceContext;
  request: UserActionRequest;
  resultingRevision: number;
  question: ApplicationQuestionRecord;
  answer: string;
  recordSuffix: string;
}): Promise<void> {
  if (input.request.scope.type !== "application") {
    throw new Error("Manual answers require an application action.");
  }
  const scope = input.request.scope;
  if (!scope.applicationRecordId || !scope.resultId) {
    throw new Error("This manual answer is missing its application scope.");
  }
  const { question, answer } = input;
  const now = new Date().toISOString();

  if (input.command.saveForFuture) {
    rememberWorkspaceAnswer(input.ctx, {
      prompt: question.prompt,
      answer,
      kind: question.kind,
      ...(input.command.hiringCountry
        ? { hiringCountry: input.command.hiringCountry }
        : {}),
    });
  }

  // A letter the person wrote or accepted here is the letter this
  // application uses: preparation attaches it word for word and never
  // drafts or asks about another one.
  async function keepLetterApproved(): Promise<void> {
    if (
      question.kind !== "cover_letter" ||
      !input.ctx.documentManager.saveApprovedApplicationLetter
    )
      return;
    const [profile, job, applicationRecords] = await Promise.all([
      input.ctx.repository.getProfile(),
      readSavedJob(input.ctx.repository, question.jobId),
      input.ctx.repository.listApplicationRecords(),
    ]);
    const applicationRecord = applicationRecords.find(
      (entry) => entry.id === scope.applicationRecordId,
    );
    if (job && applicationRecord) {
      await input.ctx.documentManager.saveApprovedApplicationLetter({
        profile,
        job,
        applicationRecord,
        question,
        text: answer,
      });
    }
  }

  const recordId = `manual_answer_${input.request.id}_${input.resultingRevision}${input.recordSuffix}`;
  const records = await input.ctx.repository.listApplicationAnswerRecords({
    questionId: question.id,
  });
  const existingById = records.find((record) => record.id === recordId) ?? null;
  // The exact retry reuses the already-persisted record as the basis of the
  // revision chain, so the deterministic id stays idempotent: the retry never
  // creates another revision and never rewrites createdAt.
  const latest = latestAnswerForQuestion(records, question.id);

  const record = ApplicationAnswerRecordSchema.parse({
    id: recordId,
    ...(input.command.hiringCountry
      ? { hiringCountry: input.command.hiringCountry }
      : {}),
    runId: scope.runId,
    jobId: scope.jobId,
    applicationRecordId: scope.applicationRecordId,
    resultId: scope.resultId,
    questionId: question.id,
    status: "suggested",
    text: answer,
    value: { type: "text", value: answer },
    saveScope: input.command.saveForFuture
      ? "reusable_profile"
      : "application_once",
    sourceKind: "user",
    sourceId: input.request.id,
    confidenceLabel: "User-provided for this exact question",
    provenance: [
      {
        id: `manual_answer_provenance_${input.request.id}_${input.resultingRevision}${input.recordSuffix}`,
        sourceKind: "user",
        sourceId: input.request.id,
        label: input.command.saveForFuture
          ? "Entered in Action inbox and saved to Profile"
          : "Entered in Action inbox for this application only",
        snippet: question.prompt,
      },
    ],
    // Monotonically increasing revision based on the actual latest persisted
    // record for the question, never a fixed revision-1 write that could
    // clobber a newer answer (for example one created by a grouped apply).
    revision: existingById?.revision ?? (latest?.revision ?? 0) + 1,
    supersedesAnswerId: existingById
      ? existingById.supersedesAnswerId
      : (latest?.id ?? null),
    createdAt: existingById?.createdAt ?? now,
    submittedAt: null,
  });

  if (existingById) {
    if (JSON.stringify(existingById) === JSON.stringify(record)) {
      // Exact idempotent retry of the deterministic record id.
      await keepLetterApproved();
      return;
    }
    throw new Error(
      `Answer record '${recordId}' already exists with different data.`,
    );
  }

  const committed = await input.ctx.repository.commitApplicationAnswerMutation({
    expectedAnswer: latest,
    expectedQuestion: question,
    answer: record,
    question: {
      ...question,
      selectedAnswerId: record.id,
      submittedAnswer: record.text,
      status: "answered",
    },
  });
  if (committed === "stale") {
    throw new Error(
      "This answer changed in another view. Reload Needs you and try again.",
    );
  }
  if (committed === "duplicate") {
    const stored = (
      await input.ctx.repository.listApplicationAnswerRecords({
        questionId: question.id,
      })
    ).find((answer) => answer.id === record.id);
    if (
      !stored ||
      JSON.stringify(stored) !==
        JSON.stringify({ ...record, createdAt: stored.createdAt })
    ) {
      throw new Error(
        `Answer record '${recordId}' already exists with different data.`,
      );
    }
  }
  await keepLetterApproved();
}
/**
 * A hand-off made when the browser refused a new tab. Before that error was
 * mapped to a plain failure, it became a "complete the browser step" card
 * showing the raw protocol text, although no page had opened and there was
 * nothing for the person to do.
 */
const TAB_LIMIT_HANDOFF_PATTERN =
  /Protocol error \(Target\.createTarget\)|Close a browser tab before opening another/i;

export function isStaleTabLimitHandoff(request: UserActionRequest): boolean {
  return (
    request.scope.type === "application" &&
    !isUserActionTerminal(request.state) &&
    request.state !== "verifying" &&
    TAB_LIMIT_HANDOFF_PATTERN.test(request.summary)
  );
}

const TAB_LIMIT_CLOSURE = {
  lastActionLabel:
    "The application never opened: the Job Finder browser had too many tabs open.",
  eventTitle: "Application never opened",
  eventDetail:
    "The Job Finder browser had as many tabs as it allows, so this application never opened and nothing was sent. Try again to prepare it.",
  resultSummary: "The Job Finder browser had too many tabs open",
  resultDetail:
    "Job Finder could not open this application because its browser already had as many tabs as it allows. Nothing was sent. Choose Try again to prepare it.",
};

/**
 * Closes the tab-limit hand-offs older builds left in Needs you and marks
 * their applications as not applied, so they show a Try again instead of a
 * step the person cannot do. Runs once per app session.
 */
async function retireStaleTabLimitHandoffs(
  repository: JobFinderRepository,
): Promise<void> {
  const requests = await repository.listUserActionRequests({
    scopeType: "application",
  });
  for (const request of requests.filter(isStaleTabLimitHandoff)) {
    const occurredAt = new Date().toISOString();
    const cancelled = reduceUserActionCommand(
      request,
      {
        requestId: request.id,
        commandId: `${request.id}_tab_limit_retired`,
        expectedRevision: request.revision,
        action: "cancel",
        reason:
          "The application never opened because the browser had too many tabs; this was not a step for the person.",
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      },
      occurredAt,
    );
    if (cancelled.status !== "applied") continue;
    const commit = await repository.commitUserActionTransition({
      request: cancelled.request,
      event: cancelled.event,
    });
    if (commit.status === "stale") continue;
    await releaseApplicationRecordAfterDismissedUserAction({
      repository,
      request: commit.request,
      occurredAt,
      eventId: `event_tab_limit_retired_${request.id}`,
      dismissal: "cancelled",
      closedBecause: TAB_LIMIT_CLOSURE,
    });
  }
}

export function createWorkspaceUserActionMethods(
  ctx: WorkspaceServiceContext,
): WorkspaceUserActionMethods {
  const commandFlights = new Map<
    string,
    Promise<Awaited<ReturnType<JobFinderWorkspaceService["performUserAction"]>>>
  >();
  const requestTransitionTails = new Map<string, Promise<void>>();
  const manualAnswersBeingStored = new Set<string>();
  const verificationFlights = new Map<string, Promise<void>>();

  async function closeTerminalParkedDiscoverySession(
    request: UserActionRequest,
  ): Promise<void> {
    if (
      request.scope.type !== "discovery_source" ||
      !request.scope.parkedTab ||
      !isUserActionTerminal(request.state)
    ) {
      return;
    }

    await ctx
      .closeParkedBrowserTab(request.scope.source, request.scope.parkedTab)
      .catch(() => {});

    const discoveryHandoffs = await ctx.repository
      .listUserActionRequests({
        scopeType: "discovery_source",
      })
      .catch(() => null);
    // Failure to prove that no other handoff owns the shared host fails safe:
    // the exact tab close above is still isolated, while the host stays alive.
    if (!discoveryHandoffs) return;
    const pendingParkedHandoffs = discoveryHandoffs.some(
      (candidate) =>
        candidate.scope.type === "discovery_source" &&
        candidate.scope.parkedTab !== null &&
        candidate.scope.parkedTab !== undefined &&
        !isUserActionTerminal(candidate.state),
    );
    if (pendingParkedHandoffs || ctx.hasActiveBrowserWorkflow()) return;

    await ctx.closeRunBrowserSession(request.scope.source).catch(() => {});
  }

  function verifySingleFlight(request: UserActionRequest): Promise<void> {
    const key = getUserActionVerificationFlightKey(request);
    const existing = verificationFlights.get(key);
    if (existing) return existing;

    const flight = (async () => {
      if (request.scope.type === "application" && request.scope.resultId) {
        await ctx.browserRuntime.closeApplicationFormAction?.(
          request.scope.source,
          request.scope.resultId,
        );
      }
      // Same fail-closed gate as application resumption: source-access
      // verification drives the browser, so it must not start while global
      // activity is paused or unreadable.
      if (await isWorkspaceActivityPaused(ctx.repository)) return;
      await verifySourceAccessUserAction({
        browserRuntime: ctx.browserRuntime,
        repository: ctx.repository,
        request,
      });
    })().finally(() => {
      if (verificationFlights.get(key) === flight) {
        verificationFlights.delete(key);
      }
    });
    verificationFlights.set(key, flight);
    return flight;
  }

  let tabLimitHandoffsRetired = false;

  /**
   * A question step that a saved answer now covers completely goes on by
   * itself: an application that was already filling in when the person saved
   * the answer asked it a moment later all the same.
   */
  async function answerStepsFromSavedAnswers(): Promise<void> {
    const answered = (ctx.readSavedAnswers?.() ?? []).flatMap((saved) => {
      const answer = saved.answer.trim();
      return answer
        ? [saved.question, saved.label]
            .filter((prompt): prompt is string => Boolean(prompt?.trim()))
            .map((prompt) => ({ prompt, answer }))
        : [];
    });
    const covered = await findManualAnswerStepsCoveredBy({
      ctx,
      answered,
      request: null,
      savedForFuture: true,
      states: ["pending"],
    });
    for (const step of covered) {
      dispatchSameAnswer(step);
    }
  }

  function dispatchSameAnswer(step: {
    request: UserActionRequest;
    answers: { questionId: string; answer: string }[];
  }): void {
    const first = step.answers[0];
    if (!first) return;
    void performUserAction({
      action: "submit_manual_answer",
      requestId: step.request.id,
      expectedRevision: step.request.revision,
      commandId: `${SAME_ANSWER_COMMAND_PREFIX}${step.request.id}_r${step.request.revision}`,
      answer: first.answer,
      answers: step.answers,
      saveForFuture: false,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    }).catch((error: unknown) => {
      console.error(
        "Job Finder could not reuse an answer on another application.",
        error,
      );
    });
  }

  async function resumeVerifyingUserActions(): Promise<void> {
    // Fail closed before listing or launching anything: while global activity
    // is paused (or unreadable) no verification probe or application flow may
    // start, and every action below simply stays resumable.
    if (await isWorkspaceActivityPaused(ctx.repository)) return;

    if (!tabLimitHandoffsRetired) {
      tabLimitHandoffsRetired = true;
      // Housekeeping only: a failure here must never block the snapshot or
      // the resumptions below.
      await retireStaleTabLimitHandoffs(ctx.repository).catch(() => {});
    }

    // Also repairs older records and a hand-off committed just after cancellation.
    await retireCancelledApplicationUserActions(ctx.repository);

    const verifyingRequests = (
      await ctx.repository.listUserActionRequests({
        states: ["verifying"],
      })
    ).filter((request) => !manualAnswersBeingStored.has(request.id));
    // After the list above: a step answered here resumes through its own
    // command, once its answer is stored. Listed as verifying before the
    // answer landed, it was handed back as still blocked.
    await answerStepsFromSavedAnswers().catch((error: unknown) => {
      console.error(
        "Job Finder could not answer a step from your saved answers.",
        error,
      );
    });

    await runBounded(
      verifyingRequests,
      USER_ACTION_RESUMPTION_CONCURRENCY,
      // Sign-in confirmations, including ones deferred by Pause or a
      // restart, are probed again. Nothing resumes an old application run:
      // applications run on the job store.
      (request) =>
        isSourceAccessUserAction(request)
          ? verifySingleFlight(request)
          : Promise.resolve(),
    );
  }

  async function performUserActionOnce(command: UserActionCommand) {
    const request = await ctx.repository.getUserActionRequest(
      command.requestId,
    );

    if (!request) {
      throw new Error("This action is no longer available.");
    }

    const reduction = reduceUserActionCommand(
      request,
      command,
      new Date().toISOString(),
    );

    if (reduction.status === "stale") {
      if (
        command.action === "submit_task_local_credentials" &&
        request.state === "verifying" &&
        request.revision === command.expectedRevision + 1
      ) {
        const events = await ctx.repository.listUserActionEvents({
          requestId: request.id,
        });
        if (
          events.some(
            (event) =>
              event.id === command.commandId &&
              event.operation === "submit_task_local_credentials" &&
              event.resultingRevision === request.revision,
          )
        ) {
          // The old engine took sign-in credentials here to continue its
          // run; with no run to continue, the credentials are dropped.
          command.identifier = "";
          command.password = "";
        }
      }
      if (
        command.action === "submit_manual_answer" &&
        request.state === "verifying" &&
        request.revision === command.expectedRevision + 1
      ) {
        // A verifying request at the expected resulting revision is not by
        // itself proof the caller's command applied: a grouped apply or any
        // other writer moves manual-answer requests to verifying too. Persist
        // only when listUserActionEvents proves the exact commandId event
        // exists with operation submit_manual_answer and the expected and
        // resulting revisions; a grouped event id is never the caller's id.
        if (
          await hasPersistedExactSubmitManualAnswerEvent({
            ctx,
            command,
            request,
          })
        ) {
          await persistManualAnswer({
            command,
            ctx,
            request,
            resultingRevision: request.revision,
          });
        }
      }
      if (
        command.action === "confirm_done" ||
        command.action === "submit_manual_answer"
      ) {
        if (
          request.state === "verifying" &&
          isSourceAccessUserAction(request)
        ) {
          await verifySingleFlight(request);
        }
      }
      return ctx.getWorkspaceSnapshot();
    }

    if (command.action === "open_page") {
      if (!request.actionUrl) {
        throw new Error(
          "This action does not have a safe browser page to open.",
        );
      }

      if (request.scope.type === "application") {
        const requiresFreshManualPage =
          isApplicationPrepareOnlyUserAction(request) &&
          /blocked a background page request/i.test(request.summary);
        if (requiresFreshManualPage) {
          await ctx.openRunBrowserSession(request.scope.source, {
            targetUrl: request.actionUrl,
            reuseExistingPage: false,
          });
        } else {
          const focused = request.scope.resultId
            ? await ctx.browserRuntime.focusApplicationPageBinding?.(
                request.scope.source,
                request.scope.resultId,
              )
            : false;
          if (!focused) {
            const occurredAt = new Date().toISOString();
            const cancelled = reduceUserActionCommand(
              request,
              {
                requestId: request.id,
                commandId: `${command.commandId}_missing_prepared_page`,
                expectedRevision: request.revision,
                action: "cancel",
                reason:
                  "The exact prepared application page is no longer open.",
                credentialsPolicy: "browser_only",
                submitAuthorized: false,
                accountCreationAuthorized: false,
              },
              occurredAt,
            );
            if (cancelled.status === "applied") {
              const cancellationCommit =
                await ctx.repository.commitUserActionTransition({
                  request: cancelled.request,
                  event: cancelled.event,
                });
              if (cancellationCommit.status !== "stale") {
                await releaseApplicationRecordAfterDismissedUserAction({
                  repository: ctx.repository,
                  request: cancellationCommit.request,
                  occurredAt,
                  eventId: `event_missing_prepared_page_${request.id}`,
                  dismissal: "cancelled",
                  unavailablePreparedPage: true,
                });
              }
            }
            return ctx.getWorkspaceSnapshot();
          }
          if (request.scope.resultId) {
            await ctx.browserRuntime.closeApplicationFormAction?.(
              request.scope.source,
              request.scope.resultId,
            );
            // A sign-in or account step is the person's: the kept page takes
            // their own posts (creating the account, signing in) until the
            // next continuation locks it again.
            if (isApplicationAuthenticationUserActionKind(request.kind)) {
              await ctx.browserRuntime
                .handApplicationPageToPerson?.(
                  request.scope.source,
                  request.scope.resultId,
                )
                .catch(() => {});
            }
          }
          if (
            request.kind === "login" &&
            request.scope.resultId &&
            ctx.browserRuntime.readApplicationPageBinding &&
            ctx.browserRuntime.armApplicationFormAction
          ) {
            const raw = await ctx.browserRuntime.readApplicationPageBinding(
              request.scope.source,
              request.scope.resultId,
            );
            const observation = buildApplyFormObservation(
              raw,
              new Date().toISOString(),
            );
            const signIn = selectObservedSignInAction(observation);
            if (signIn && observation.url) {
              // Observation may await a page read while a newer result
              // supersedes this request. Never arm from that stale read.
              const current = await ctx.repository.getUserActionRequest(
                request.id,
              );
              if (
                current?.revision === request.revision &&
                current.state === request.state
              ) {
                await ctx.browserRuntime.armApplicationFormAction(
                  request.scope.source,
                  {
                    pageBindingKey: request.scope.resultId,
                    pageUrl: observation.url,
                    ...signIn,
                  },
                );
                const afterArm = await ctx.repository.getUserActionRequest(
                  request.id,
                );
                if (
                  afterArm?.revision !== request.revision ||
                  afterArm.state !== request.state
                ) {
                  await ctx.browserRuntime.closeApplicationFormAction?.(
                    request.scope.source,
                    request.scope.resultId,
                  );
                }
              }
            }
          }
        }
      } else {
        await ctx.openRunBrowserSession(request.scope.source, {
          targetUrl: request.actionUrl,
          // The parked tab itself, when the browser still has it: its
          // address may have moved on since it was parked.
          ...(request.scope.type === "discovery_source" &&
          request.scope.parkedTab?.tabId
            ? { tabId: request.scope.parkedTab.tabId }
            : {}),
          // When that tab is gone, the host opens the address again as the
          // parked tab for this request instead of failing.
          ...(request.scope.type === "discovery_source" &&
          request.scope.parkedTab
            ? {
                parkedFor:
                  request.kind === "login"
                    ? ("sign_in" as const)
                    : ("challenge" as const),
              }
            : {}),
        });
      }
    }

    const commandCommit = await ctx.repository.commitUserActionTransition({
      request: reduction.request,
      event: reduction.event,
    });

    if (commandCommit.status === "stale") {
      if (
        command.action === "open_page" &&
        request.scope.type === "application" &&
        request.scope.resultId
      ) {
        await ctx.browserRuntime.closeApplicationFormAction?.(
          request.scope.source,
          request.scope.resultId,
        );
      }
      // The reducer saw the current revision but a concurrent writer advanced
      // the request before this commit, so the caller's transition did not
      // apply and the answer must not be persisted. Only "applied" and
      // "duplicate" prove the exact command event is persisted. The current
      // verifying request still resumes so a lost response to an earlier
      // successful commit of the same command recovers through the
      // single-flight resumer.
      if (
        command.action === "confirm_done" ||
        command.action === "submit_manual_answer"
      ) {
        const current = commandCommit.request;
        if (
          current.state === "verifying" &&
          isSourceAccessUserAction(current)
        ) {
          await verifySingleFlight(current);
        }
      }
      return ctx.getWorkspaceSnapshot();
    }

    // Between the step moving to verifying and its answer being stored, no
    // other path may resume it: the missing answer read as a failed write
    // and the question went back to the person.
    if (command.action === "submit_manual_answer") {
      manualAnswersBeingStored.add(command.requestId);
    }

    if (
      command.action !== "open_page" &&
      commandCommit.request.scope.type === "application" &&
      commandCommit.request.scope.resultId
    ) {
      await ctx.browserRuntime
        .closeApplicationFormAction?.(
          commandCommit.request.scope.source,
          commandCommit.request.scope.resultId,
        )
        .catch((error: unknown) => {
          manualAnswersBeingStored.delete(command.requestId);
          throw error;
        });
    }

    if (command.action === "submit_manual_answer") {
      let answered: Awaited<ReturnType<typeof persistManualAnswer>>;
      try {
        answered = await persistManualAnswer({
          command,
          ctx,
          request: commandCommit.request,
          resultingRevision: commandCommit.request.revision,
        });
      } finally {
        manualAnswersBeingStored.delete(command.requestId);
      }
      // One answer covers the same question on the other applications of the
      // batch (and, once saved for next time, on any application waiting on
      // it), so a batch never asks the person the same thing three times.
      // Each one continues exactly as if the person had answered it there.
      // Only the person's own answer fans out; a reused one never does, so
      // no step is answered twice.
      const covered = command.commandId.startsWith(SAME_ANSWER_COMMAND_PREFIX)
        ? []
        : await findManualAnswerStepsCoveredBy({
            ctx,
            answered,
            request: commandCommit.request,
            savedForFuture: command.saveForFuture,
          }).catch(() => []);
      for (const sibling of covered) {
        dispatchSameAnswer(sibling);
      }
    }

    if (
      command.action === "confirm_done" ||
      command.action === "submit_manual_answer"
    ) {
      if (
        commandCommit.request.state === "verifying" &&
        isSourceAccessUserAction(commandCommit.request)
      ) {
        await verifySingleFlight(commandCommit.request);
      }
    }

    if (command.action === "submit_task_local_credentials") {
      // No old application run takes these any more; keep no copy.
      command.identifier = "";
      command.password = "";
    }

    // R4: cancelling a step said it was closed while the application it
    // belonged to kept its paused attempt state, so the header badge stayed on
    // "Needs you: 2 unresolved" and the row stayed NEEDS YOU. Closing the step
    // closes the application waiting on it.
    if (command.action === "cancel" || command.action === "skip") {
      await releaseApplicationRecordAfterDismissedUserAction({
        repository: ctx.repository,
        request: commandCommit.request,
        occurredAt:
          commandCommit.request.resolvedAt ?? new Date().toISOString(),
        eventId: `event_user_action_${command.action}_${command.requestId}`,
        dismissal: command.action === "skip" ? "skipped" : "cancelled",
      });
    }

    if (
      (command.action === "cancel" || command.action === "skip") &&
      commandCommit.request.scope.type === "application"
    ) {
      await releaseFinishedApplicationPages({
        ...ctx,
        ...(commandCommit.request.scope.applicationRecordId
          ? {
              applicationRecordId:
                commandCommit.request.scope.applicationRecordId,
            }
          : {}),
        jobId: commandCommit.request.scope.jobId,
      });
    }

    const latestRequest =
      (await ctx.repository.getUserActionRequest(command.requestId)) ??
      commandCommit.request;
    await closeTerminalParkedDiscoverySession(latestRequest);

    return ctx.getWorkspaceSnapshot();
  }

  function performUserAction(
    commandInput: Parameters<
      WorkspaceUserActionMethods["performUserAction"]
    >[0],
  ): ReturnType<WorkspaceUserActionMethods["performUserAction"]> {
    const command = UserActionCommandSchema.parse(commandInput);
    const existing = commandFlights.get(command.commandId);
    if (existing) return existing;

    // Different commands for the same card must not overlap. In particular,
    // a renderer timeout may re-enable a button while the first browser
    // hand-off is still settling. Queue the retry so it re-reads the latest
    // revision before any external browser work and becomes a safe stale
    // no-op instead of opening the same page twice.
    const previous = requestTransitionTails.get(command.requestId);
    const flight = (
      previous
        ? previous
            .catch(() => undefined)
            .then(() => performUserActionOnce(command))
        : performUserActionOnce(command)
    ).finally(() => {
      if (commandFlights.get(command.commandId) === flight) {
        commandFlights.delete(command.commandId);
      }
    });
    const tail = flight.then(
      () => undefined,
      () => undefined,
    );
    requestTransitionTails.set(command.requestId, tail);
    void tail.finally(() => {
      if (requestTransitionTails.get(command.requestId) === tail) {
        requestTransitionTails.delete(command.requestId);
      }
    });
    commandFlights.set(command.commandId, flight);
    return flight;
  }

  return {
    resumeVerifyingUserActions,
    performUserAction,
  };
}
