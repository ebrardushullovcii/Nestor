import {
  PREPARED_PAGE_CLOSED_SUMMARY,
  WITHDRAWAL_UNDONE_SUMMARY,
  WITHDRAWN_BY_PERSON_SUMMARY,
  isApplicationTrackedAsSentByPerson,
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  ApplyRunSchema,
  JOB_FINDER_BROWSER_LABEL,
  UserActionRequestSchema,
  type ApplicationAttemptBlocker,
  type ApplyJobState,
  type SavedJob,
  type UserActionRequest,
  type UserActionRequestKind,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";

import {
  isUserActionTerminal,
  reduceUserActionSuperseded,
  reduceUserActionCommand,
} from "../user-action-domain";
import { withApplicationRecordTransition } from "./application-crm";
import { reconcileApplyRunAfterConfirmedSubmission } from "./workspace-apply-run-support";

const applicationAuthenticationKinds = new Set<UserActionRequestKind>([
  "login",
  "signup",
  "email_verification",
  "mfa",
]);

const applicationKindCopy: Record<
  UserActionRequestKind,
  { titleVerb: string; summaryStep: string; instruction: string }
> = {
  login: {
    titleVerb: "Sign in",
    summaryStep: "sign-in",
    instruction: `Complete sign-in in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder never receives or stores your credentials.`,
  },
  signup: {
    titleVerb: "Create your account",
    summaryStep: "account creation",
    instruction: `Create the account yourself in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder never creates accounts or receives your credentials.`,
  },
  email_verification: {
    titleVerb: "Verify your email",
    summaryStep: "email-verification",
    instruction:
      "Complete email verification yourself. Job Finder never reads or stores verification links or security codes.",
  },
  mfa: {
    titleVerb: "Complete MFA",
    summaryStep: "multi-factor authentication",
    instruction: `Complete MFA yourself in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder never reads or stores security codes.`,
  },
  captcha: {
    titleVerb: "Complete the CAPTCHA",
    summaryStep: "human-verification",
    instruction: `Complete the CAPTCHA yourself in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder never solves or bypasses human-verification challenges.`,
  },
  existing_account_choice: {
    titleVerb: "Choose the account path",
    summaryStep: "account-choice",
    instruction: `Choose the appropriate account path yourself in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder never creates an account or chooses an identity for you.`,
  },
  manual_answer: {
    titleVerb: "Answer the required question",
    summaryStep: "manual-answer",
    instruction:
      "Review the question, then choose a one-use answer or explicitly save it for future reuse. Job Finder never silently promotes a one-use answer into Profile.",
  },
  legal_consent: {
    titleVerb: "Review the required consent",
    summaryStep: "legal-consent",
    instruction: `Read and decide the consent yourself in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder never accepts legal terms on your behalf.`,
  },
  external_redirect: {
    titleVerb: "Review the external destination",
    summaryStep: "external-redirect",
    instruction: `Review and continue to the external destination yourself in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder keeps final submission disabled.`,
  },
  manual_upload: {
    titleVerb: "Attach the required file",
    summaryStep: "manual-upload",
    instruction: `Attach the requested file yourself in the ${JOB_FINDER_BROWSER_LABEL}. Job Finder does not infer that an upload succeeded from this button.`,
  },
  other: {
    titleVerb: "Complete the browser step",
    summaryStep: "manual",
    instruction: `Finish this step yourself in the ${JOB_FINDER_BROWSER_LABEL}.`,
  },
};

/**
 * The concrete reason the application paused, in the user's words: the
 * classified blocker's own summary plus its detail when that adds anything.
 * This keeps the Needs-you card specific ("the site tried to save a field
 * automatically") instead of a generic "complete the described step".
 */
/**
 * Runtime details name the interrupted field, but fall back to the literal
 * placeholder "application field" when none was captured. Quoting that
 * placeholder to the user reads as a real field name they can go and find.
 */
const PLACEHOLDER_FIELD_QUOTE = /['"‘’“”]application field['"‘’“”]/gi;

/**
 * The no-submit boundary is owned once by the Needs-you page header, so the
 * per-card reason does not restate it.
 */
const TRAILING_NO_SUBMIT_CLAUSE =
  /,?\s*instead of risking a final (?:application )?submission\b\.?/i;

/**
 * Words that carry no meaning for the redundancy comparison below, so
 * "The application page could not safely save a prepared field" is compared
 * on `application/page/safely/save/prepared/field`.
 */
const REASON_STOP_WORDS = new Set([
  "and",
  "any",
  "are",
  "but",
  "can",
  "could",
  "did",
  "for",
  "had",
  "has",
  "have",
  "into",
  "its",
  "not",
  "may",
  "might",
  "must",
  "own",
  "should",
  "still",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "this",
  "those",
  "was",
  "were",
  "when",
  "while",
  "with",
  "would",
  "your",
]);

function readReasonContentWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !REASON_STOP_WORDS.has(word)),
  );
}

/**
 * True when the detail already says what the summary says. A blocker summary
 * is a short label and its detail is the same event told at length, so
 * printing both produced cards that opened with two near-identical sentences
 * ("... could not safely save a prepared field. The application site tried to
 * save a field while it was being prepared."). When the detail's first
 * sentence already carries most of the summary's meaning, the detail — which
 * is strictly more specific — is the only sentence worth showing.
 */
const REASON_RESTATEMENT_OVERLAP = 0.6;

function detailRestatesSummary(summary: string, detail: string): boolean {
  const summaryWords = readReasonContentWords(summary);
  if (summaryWords.size === 0) {
    return true;
  }

  const detailOpening = detail.split(/(?<=[.!?])\s+/)[0] ?? detail;
  const detailWords = readReasonContentWords(detailOpening);
  const shared = [...summaryWords].filter((word) =>
    detailWords.has(word),
  ).length;

  return shared / summaryWords.size >= REASON_RESTATEMENT_OVERLAP;
}

/** The labels of the file fields a blocked form still needs, in form order. */
async function listNeededApplicationFiles(input: {
  repository: JobFinderRepository;
  applicationRecordId: string;
  resultId: string;
  questionIds: readonly string[];
}): Promise<string[]> {
  if (input.questionIds.length === 0) return [];
  const records = await input.repository
    .listApplicationQuestionRecords({ resultId: input.resultId })
    .catch(() => []);
  return input.questionIds.flatMap((questionId) => {
    const record = records.find(
      (entry) =>
        entry.id ===
          `apply_question_${input.applicationRecordId}_${questionId}` &&
        entry.answerControlType === "file",
    );
    const label =
      record?.prompt
        .split(" — ")
        .at(-1)
        ?.trim()
        .replace(/[\s*:]+$/u, "")
        .replace(/\s+upload$/iu, "") ?? "";
    if (!label) return [];
    // "Academic transcript" reads "your academic transcript"; "CV" stays.
    return [
      /^[A-Z][a-z]/u.test(label)
        ? label.charAt(0).toLowerCase() + label.slice(1)
        : label,
    ];
  });
}

function joinWithAnd(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

export function describeApplicationBlockerReason(
  blocker: Pick<ApplicationAttemptBlocker, "summary" | "detail">,
): string {
  const summary = blocker.summary.trim();
  const summarySentence = /[.!?]$/.test(summary) ? summary : `${summary}.`;
  const detail = (blocker.detail?.trim() ?? "")
    .replace(PLACEHOLDER_FIELD_QUOTE, "a field")
    .replace(TRAILING_NO_SUBMIT_CLAUSE, "")
    .trim();
  const normalizedDetail =
    detail.length > 0 && !/[.!?]$/.test(detail) ? `${detail}.` : detail;
  if (normalizedDetail.length === 0 || normalizedDetail === summarySentence) {
    return summarySentence;
  }
  if (detailRestatesSummary(summarySentence, normalizedDetail)) {
    return normalizedDetail;
  }
  return `${summarySentence} ${normalizedDetail}`;
}

function stableFingerprint(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeBlockerPageIdentity(value: string | null): string {
  if (!value) return "";

  try {
    const url = new URL(value);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin.toLowerCase()}${pathname}`;
  } catch {
    return "";
  }
}

export function buildApplicationBlockerFingerprint(
  blocker: ApplicationAttemptBlocker,
): string {
  const kind = mapApplicationBlockerToUserActionKind(blocker);
  return `application_blocker:${stableFingerprint(
    [
      kind,
      blocker.code,
      [...blocker.questionIds].sort().join(","),
      normalizeBlockerPageIdentity(blocker.url),
    ].join("|"),
  )}`;
}

function getSafeBrowserTarget(
  blocker: ApplicationAttemptBlocker,
  job: SavedJob,
): { actionUrl: string; expectedOrigin: string } | null {
  const candidateUrl =
    blocker.url?.trim() ||
    job.applicationUrl?.trim() ||
    job.canonicalUrl.trim();

  try {
    const parsed = new URL(candidateUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return {
      actionUrl: parsed.toString(),
      expectedOrigin: `${parsed.origin}/`,
    };
  } catch {
    return null;
  }
}

export function mapApplicationBlockerToUserActionKind(
  blocker: ApplicationAttemptBlocker,
): UserActionRequestKind {
  if (blocker.userActionKind) return blocker.userActionKind;

  switch (blocker.code) {
    case "site_login_required":
      return "login";
    case "missing_candidate_answer":
      return "manual_answer";
    case "missing_resume":
      return "manual_upload";
    case "missing_consent":
      return "legal_consent";
    case "external_redirect":
    case "unsupported_apply_path":
      return "external_redirect";
    case "application_closed":
    case "application_page_unreachable":
      // Technical failure: never surfaced as a user-owned browser step.
      return "other";
    case "site_saves_as_you_go":
      // Letting a site save as you type is the person's decision about that
      // site, made in the app rather than in the browser (ADR 0012).
      return "other";
    case "requires_manual_review":
    case "unknown":
      return "other";
  }
}

/**
 * Unreachable or closed pages have no browser step the person can resolve.
 * These blockers must never create a Needs-you user-action request.
 */
export function isApplicationTechnicalFailureBlocker(
  blocker: ApplicationAttemptBlocker,
): boolean {
  return (
    blocker.code === "application_page_unreachable" ||
    blocker.code === "application_closed"
  );
}

export function isApplicationAuthenticationUserActionKind(
  kind: UserActionRequestKind,
): kind is "login" | "signup" | "email_verification" | "mfa" {
  return applicationAuthenticationKinds.has(kind);
}

export function isApplicationPrepareOnlyUserAction(
  request: UserActionRequest,
): boolean {
  return (
    request.scope.type === "application" &&
    request.verification.type === "page_blocker_absent"
  );
}

function compareApplicationActionRecency(
  left: UserActionRequest,
  right: UserActionRequest,
): number {
  const createdAtComparison = right.createdAt.localeCompare(left.createdAt);
  return createdAtComparison !== 0
    ? createdAtComparison
    : right.id.localeCompare(left.id);
}

async function commitApplicationActionSuperseded(input: {
  repository: JobFinderRepository;
  request: UserActionRequest;
  supersedingReferenceId: string;
  occurredAt: string;
}): Promise<void> {
  let current = input.request;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isUserActionTerminal(current.state)) return;
    const supersededAt =
      current.updatedAt > input.occurredAt
        ? current.updatedAt
        : input.occurredAt;
    const transition = reduceUserActionSuperseded(
      current,
      input.supersedingReferenceId,
      supersededAt,
    );
    if (transition.status !== "applied") return;

    const commit = await input.repository.commitUserActionTransition({
      request: transition.request,
      event: transition.event,
    });
    if (commit.status !== "stale") return;
    current = commit.request;
  }
}

/**
 * Written on a prepared application whose page closed (usually because Job
 * Finder was restarted). The form had been filled; nothing went wrong on the
 * site, so it is not a failed attempt for the failure-rate safeguard.
 */
export { PREPARED_PAGE_CLOSED_SUMMARY };

/**
 * Written on a result whose site refused the send: nothing went out and
 * nothing failed on the site, so the failure-rate safeguard does not count it.
 */
export const SITE_UNREACHABLE_SUMMARY =
  "The site could not be reached when the application was sent.";

/**
 * Written on an application the person stepped into while it was being
 * filled. Nothing went wrong on the site; it carries on when they hand the
 * browser back, and it is not a failed attempt for the failure-rate
 * safeguard.
 */
export const PERSON_TOOK_OVER_SUMMARY = "You took over this application.";

async function keepOnlyLatestApplicationActionable(input: {
  repository: JobFinderRepository;
  applicationRecordId: string;
  occurredAt: string;
}): Promise<void> {
  const sameRecordRequests = (await input.repository.listUserActionRequests())
    .filter(
      (request) =>
        request.scope.type === "application" &&
        request.scope.applicationRecordId === input.applicationRecordId,
    )
    .sort(compareApplicationActionRecency);
  const latest = sameRecordRequests[0];
  if (!latest) return;

  for (const candidate of sameRecordRequests.slice(1)) {
    await commitApplicationActionSuperseded({
      repository: input.repository,
      request: candidate,
      supersedingReferenceId: latest.id,
      occurredAt: input.occurredAt,
    });
  }
}

async function supersedeActionsClearedByNewerResult(input: {
  repository: JobFinderRepository;
  applicationRecordId: string;
  resultId: string;
  resultStartedAt: string;
  occurredAt: string;
}): Promise<void> {
  const olderActionableRequests = (
    await input.repository.listUserActionRequests()
  ).filter(
    (request) =>
      request.scope.type === "application" &&
      request.scope.applicationRecordId === input.applicationRecordId &&
      (request.scope.resultId === input.resultId ||
        request.createdAt <= input.resultStartedAt) &&
      !isUserActionTerminal(request.state),
  );

  for (const request of olderActionableRequests) {
    await commitApplicationActionSuperseded({
      repository: input.repository,
      request,
      supersedingReferenceId: input.resultId,
      occurredAt: input.occurredAt,
    });
  }
}

export async function persistApplicationUserAction(input: {
  repository: JobFinderRepository;
  applicationRecordId: string;
  job: SavedJob;
  runId: string;
  resultId: string | null;
  resultState?: ApplyJobState;
  resultStartedAt?: string;
  replayCheckpointId: string | null;
  blocker: ApplicationAttemptBlocker | null;
  occurredAt: string;
  questions?: readonly { id: string; prompt: string }[];
}): Promise<void> {
  if (!input.resultId || !input.replayCheckpointId) return;
  if (input.resultState === "failed") {
    if (input.resultStartedAt) {
      await supersedeActionsClearedByNewerResult({
        repository: input.repository,
        applicationRecordId: input.applicationRecordId,
        resultId: input.resultId,
        resultStartedAt: input.resultStartedAt,
        occurredAt: input.occurredAt,
      });
    }
    return;
  }
  if (!input.blocker) {
    if (input.resultState === "awaiting_review" && input.resultStartedAt) {
      await supersedeActionsClearedByNewerResult({
        repository: input.repository,
        applicationRecordId: input.applicationRecordId,
        resultId: input.resultId,
        resultStartedAt: input.resultStartedAt,
        occurredAt: input.occurredAt,
      });
    }
    return;
  }
  // Technical failures own no browser step. The employer page never opened,
  // so there is nothing for the user to do and no request is created.
  if (isApplicationTechnicalFailureBlocker(input.blocker)) {
    return;
  }

  const kind = mapApplicationBlockerToUserActionKind(input.blocker);
  const browserTarget = getSafeBrowserTarget(input.blocker, input.job);
  const copy = applicationKindCopy[kind];
  const blockerFingerprint = buildApplicationBlockerFingerprint(input.blocker);
  const targetId =
    input.job.provenance.at(-1)?.targetId ??
    input.job.provenance[0]?.targetId ??
    null;
  const occurrenceFingerprint = stableFingerprint(
    [
      input.runId,
      input.job.id,
      input.applicationRecordId,
      input.resultId,
      input.replayCheckpointId,
      kind,
      blockerFingerprint,
      browserTarget?.expectedOrigin ?? "no_safe_browser_origin",
    ].join("|"),
  );
  const dedupeKey = `application_${kind}:${occurrenceFingerprint}`;
  const allRequests = await input.repository.listUserActionRequests();
  const existingRequest = allRequests.find(
    (request) => request.dedupeKey === dedupeKey,
  );
  if (existingRequest) {
    if (
      existingRequest.kind !== kind ||
      existingRequest.scope.type !== "application" ||
      existingRequest.scope.runId !== input.runId ||
      existingRequest.scope.jobId !== input.job.id ||
      existingRequest.scope.applicationRecordId !== input.applicationRecordId ||
      existingRequest.scope.resultId !== input.resultId ||
      existingRequest.scope.replayCheckpointId !== input.replayCheckpointId ||
      existingRequest.scope.source !== input.job.source ||
      !("blockerFingerprint" in existingRequest.verification) ||
      existingRequest.verification.blockerFingerprint !== blockerFingerprint
    ) {
      throw new Error(
        `Application ${kind} action dedupe collision for '${dedupeKey}'.`,
      );
    }
    await keepOnlyLatestApplicationActionable({
      repository: input.repository,
      applicationRecordId: input.applicationRecordId,
      occurredAt: input.occurredAt,
    });
    return;
  }

  // An upload step names the files the form asks for, so the person knows
  // what to add in Profile › Files without opening the page.
  const neededFiles =
    kind === "manual_upload"
      ? await listNeededApplicationFiles({
          repository: input.repository,
          applicationRecordId: input.applicationRecordId,
          resultId: input.resultId,
          questionIds: input.blocker.questionIds ?? [],
        })
      : [];
  const neededFileLabel = joinWithAnd(neededFiles);
  const questionPrompts =
    kind === "manual_answer"
      ? (
          input.questions ??
          (await input.repository.listApplicationQuestionRecords({
            applicationRecordId: input.applicationRecordId,
            resultId: input.resultId,
          }))
        )
          .filter((question) =>
            (input.blocker?.questionIds ?? []).some(
              (id) =>
                question.id === id ||
                question.id ===
                  `apply_question_${input.applicationRecordId}_${id}`,
            ),
          )
          .map((question) => question.prompt)
      : [];
  const answerPrompt =
    questionPrompts.length === 1
      ? `Answer “${questionPrompts[0]}” in the app.`
      : "Answer the application questions in the app.";
  const request = UserActionRequestSchema.parse({
    id: `application_${kind}_${occurrenceFingerprint}`,
    dedupeKey,
    revision: 1,
    kind,
    state: "pending",
    requirement: "required",
    scope: {
      type: "application",
      runId: input.runId,
      jobId: input.job.id,
      applicationRecordId: input.applicationRecordId,
      resultId: input.resultId,
      replayCheckpointId: input.replayCheckpointId,
      source: input.job.source,
    },
    verification: isApplicationAuthenticationUserActionKind(kind)
      ? {
          type: "source_access",
          targetId,
          blockerFingerprint,
          expectedOrigin: browserTarget?.expectedOrigin ?? null,
        }
      : {
          type: "page_blocker_absent",
          blockerFingerprint,
          expectedPageFingerprint: null,
        },
    title: neededFileLabel
      ? `Add your ${neededFileLabel} to continue the ${input.job.company} application`
      : `${kind === "manual_answer" && (input.blocker?.questionIds.length ?? 0) > 1 ? "Answer the required questions" : copy.titleVerb} to continue the ${input.job.company} application`,
    // A sign-in on the kept application page is watched and carries on by
    // itself (ADR 0027); every other step still ends with the person's
    // confirmation.
    summary:
      kind === "manual_answer"
        ? `${answerPrompt} Job Finder continues after you save your answer.`
        : isApplicationAuthenticationUserActionKind(kind)
          ? `${describeApplicationBlockerReason(input.blocker)} Complete this ${copy.summaryStep} step in the ${JOB_FINDER_BROWSER_LABEL}; Job Finder carries on with this application by itself once you're in.`
          : kind === "manual_upload"
            ? neededFileLabel
              ? `${describeApplicationBlockerReason(input.blocker)} The ${input.job.company} form asks for your ${neededFileLabel}. Add or restore ${neededFiles.length === 1 ? "it" : "them"} in Profile › Files and Job Finder attaches ${neededFiles.length === 1 ? "it" : "them"} and carries on by itself.`
              : `${describeApplicationBlockerReason(input.blocker)} Add or restore the file in Profile › Files and Job Finder attaches it and carries on by itself.`
            : `${describeApplicationBlockerReason(input.blocker)} Complete this ${copy.summaryStep} step in the ${JOB_FINDER_BROWSER_LABEL}, then come back here and confirm so Job Finder can check the page again.`,
    instructions:
      kind === "manual_answer"
        ? ["Answer the questions here, then save your answers to continue."]
        : isApplicationAuthenticationUserActionKind(kind)
          ? [
              copy.instruction,
              "Job Finder watches this page and carries on with this exact application once the sign-in is done.",
            ]
          : kind === "manual_upload"
            ? [
                "Add or restore the file in Profile › Files; Job Finder attaches it and carries on by itself.",
                `Or attach it yourself in the ${JOB_FINDER_BROWSER_LABEL}, then choose Check whether this step is done.`,
              ]
            : [
                copy.instruction,
                "Return to Needs you and confirm completion only after the browser step is complete.",
                "After confirmation, Job Finder checks the page again and carries on in your saved apply mode.",
              ],
    actionUrl: browserTarget?.actionUrl ?? null,
    displayOrigin: browserTarget?.expectedOrigin ?? null,
    credentialsPolicy: "browser_only",
    submitAuthorized: false,
    accountCreationAuthorized: false,
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: input.occurredAt,
    updatedAt: input.occurredAt,
    openedAt: null,
    resolvedAt: null,
    expiresAt: null,
  });
  if (kind === "manual_answer") {
    const cancelled = allRequests
      .filter(
        (previous) =>
          previous.kind === "manual_answer" &&
          previous.state === "cancelled" &&
          previous.answerDraft &&
          previous.scope.type === "application" &&
          previous.scope.applicationRecordId === input.applicationRecordId &&
          "blockerFingerprint" in previous.verification &&
          previous.verification.blockerFingerprint === blockerFingerprint,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (cancelled) {
      request.answerDraft = cancelled.answerDraft;
      request.answerDraftFieldUpdatedAt = cancelled.answerDraftFieldUpdatedAt;
    }
  }
  await input.repository.createUserActionRequest(request);
  await keepOnlyLatestApplicationActionable({
    repository: input.repository,
    applicationRecordId: input.applicationRecordId,
    occurredAt: input.occurredAt,
  });
}
export const persistApplicationLoginUserAction = persistApplicationUserAction;

/**
 * A sign-in, account, or verification step is the person's to do on the kept
 * application page (ADR 0012, 0027). The page's prepare-only guard blocks
 * every form post, which also blocked the person's own "Create account" or
 * "Sign in" press there unless one exact sign-in button had been armed. While
 * such a step waits on the person, the page is theirs: posts they make go
 * through. The next continuation locks it again
 * (`closeApplicationFormAction`) before Job Finder touches it.
 */
export async function handApplicationPageToPersonForAccessStep(input: {
  browserRuntime: {
    handApplicationPageToPerson?: (
      source: SavedJob["source"],
      pageBindingKey: string,
    ) => Promise<void>;
  };
  source: SavedJob["source"];
  resultId: string | null;
  blocker: ApplicationAttemptBlocker | null;
}): Promise<void> {
  if (!input.resultId || !input.blocker) return;
  if (isApplicationTechnicalFailureBlocker(input.blocker)) return;
  const kind = mapApplicationBlockerToUserActionKind(input.blocker);
  if (!isApplicationAuthenticationUserActionKind(kind)) return;
  // No kept page (for example after a restart) means nothing to hand over;
  // the step then opens a fresh page as before.
  await input.browserRuntime
    .handApplicationPageToPerson?.(input.source, input.resultId)
    .catch(() => {});
}

/**
 * Marks one exact prepared application as retryable when its in-memory page
 * binding is gone. Both a pending browser hand-off and a ready-for-review
 * browser hand-off use this path, so neither can fall back to an arbitrary
 * tab after restart or after another application opens.
 */
export async function terminalizeApplicationAfterPreparedPageLost(input: {
  repository: JobFinderRepository;
  runId: string;
  jobId: string;
  applicationRecordId: string;
  resultId: string;
  occurredAt: string;
  eventId: string;
  preserveRunningRun?: boolean;
}): Promise<void> {
  const [records, runResults, jobResults, runs] = await Promise.all([
    input.repository.listApplicationRecords(),
    input.repository.listApplyJobResults({ runId: input.runId }),
    input.repository.listApplyJobResults({ jobId: input.jobId }),
    input.repository.listApplyRuns(),
  ]);
  const result = runResults.find(
    (entry) =>
      entry.id === input.resultId &&
      entry.jobId === input.jobId &&
      entry.applicationRecordId === input.applicationRecordId,
  );
  if (
    !result ||
    result.state === "submitting" ||
    result.state === "submitted" ||
    result.privacyReceipt?.submissionOutcome?.outcome === "outcome_uncertain"
  ) {
    return;
  }

  // A result-bound button may still be on screen while a newer attempt for
  // the same record starts. Losing the older page must not overwrite that
  // newer attempt's record or run state.
  const hasNewerResult = jobResults.some(
    (entry) =>
      entry.applicationRecordId === input.applicationRecordId &&
      entry.id !== result.id &&
      (entry.updatedAt.localeCompare(result.updatedAt) > 0 ||
        (entry.updatedAt === result.updatedAt && entry.id > result.id)),
  );
  if (hasNewerResult) return;

  const record = records.find(
    (entry) =>
      entry.id === input.applicationRecordId && entry.jobId === input.jobId,
  );
  const run = runs.find((entry) => entry.id === input.runId);
  if (
    !record ||
    (record.lastAttemptState !== "paused" &&
      record.lastAttemptState !== "ready") ||
    !run
  ) {
    return;
  }

  // A form that was filled in and waiting on the person may have been sent by
  // them before the page went away. Job Finder did not send it, but it can no
  // longer see whether they did, so it never says "nothing was sent" here.
  const mayHaveBeenSentByPerson =
    record.lastAttemptState === "ready" ||
    (result.state === "awaiting_review" && result.blockerReason === null);
  const pageClosedDetail = mayHaveBeenSentByPerson
    ? "Job Finder did not send this application and can no longer see the page. If you sent it yourself, set its stage to Applied; Try again would fill the form in again."
    : "The exact prepared page could not be reopened. Nothing was sent, and you can choose Try again to prepare this application again.";
  await input.repository.upsertApplicationRecord(
    ApplicationRecordSchema.parse({
      ...record,
      lastAttemptState: "failed",
      lastActionLabel: "The prepared application page is no longer open.",
      nextActionLabel: mayHaveBeenSentByPerson
        ? "If you sent it, set its stage to Applied. If not, Try again."
        : "Try again, or finish it yourself on the job site.",
      lastUpdatedAt: input.occurredAt,
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      events: [
        ...record.events,
        {
          id: input.eventId,
          at: input.occurredAt,
          title: "Prepared page closed",
          detail: pageClosedDetail,
          emphasis: "warning",
        },
      ],
    }),
  );

  const terminalResult = ApplyJobResultSchema.parse({
    ...result,
    state: "failed",
    summary: PREPARED_PAGE_CLOSED_SUMMARY,
    detail: pageClosedDetail,
    updatedAt: input.occurredAt,
    completedAt: input.occurredAt,
    blockerReason: "unexpected_navigation",
    blockerSummary: PREPARED_PAGE_CLOSED_SUMMARY,
    latestQuestionCount: 0,
  });
  await input.repository.upsertApplyJobResult(terminalResult);

  // A Home pause can park an approved queue between jobs. The prior prepared
  // page is gone after restart, but its failed result must not terminate the
  // untouched jobs that Resume will execute under the same approved run.
  if (input.preserveRunningRun && run.state === "running") return;

  const nextResults = runResults.map((entry) =>
    entry.id === terminalResult.id ? terminalResult : entry,
  );
  const reconciledRun = reconcileApplyRunAfterConfirmedSubmission({
    run,
    results: nextResults,
    submittedAt: input.occurredAt,
    submittedSummary: "A prepared application page was no longer open",
    submittedDetail: mayHaveBeenSentByPerson
      ? "Job Finder did not send it. If you sent it yourself, set its stage to Applied."
      : "Nothing was sent. The affected application can be prepared again.",
  });
  await input.repository.upsertApplyRun(
    ApplyRunSchema.parse({
      ...reconciledRun,
      summary: "A prepared application page was no longer open.",
      detail: mayHaveBeenSentByPerson
        ? "Job Finder did not send it. If you sent it yourself, set its stage to Applied; other work keeps its own state."
        : "Nothing was sent. The affected application can be prepared again while any other work keeps its own state.",
    }),
  );
}

/**
 * Closing a browser step must also close the application waiting on it.
 *
 * Cancelling or skipping a step said "the step was closed" and stopped there:
 * the request went to cancelled, but the application record kept the paused
 * attempt state that every "waiting on you" reading is derived from. The
 * header badge therefore stayed on "Needs you: 2 unresolved" and the row
 * stayed NEEDS YOU after both steps were cancelled. The record moves to the
 * state the cancel copy promises — Job Finder stops working on it and the
 * person can still finish it themselves — and the count follows.
 */
export async function releaseApplicationRecordAfterDismissedUserAction(input: {
  repository: JobFinderRepository;
  request: UserActionRequest;
  occurredAt: string;
  eventId: string;
  dismissal: "cancelled" | "skipped";
  unavailablePreparedPage?: boolean;
  preserveCompletedPreparation?: boolean;
  /**
   * Said instead of "you cancelled the step" when Job Finder closed a step
   * that was never the person's to do.
   */
  closedBecause?: {
    lastActionLabel: string;
    eventTitle: string;
    eventDetail: string;
    resultSummary: string;
    resultDetail: string;
    /** Null when nothing is left for the person to do here. */
    nextActionLabel?: string | null;
  };
}): Promise<void> {
  const { request } = input;
  if (request.scope.type !== "application") return;
  const applicationScope = request.scope;
  const applicationRecordId = applicationScope.applicationRecordId;
  if (!applicationRecordId) return;

  const record = (await input.repository.listApplicationRecords()).find(
    (entry) => entry.id === applicationRecordId,
  );
  if (!record || record.lastAttemptState !== "paused") return;

  // Another open step on the same application still needs the person, so the
  // record keeps waiting until the last one is closed.
  const stillOpen = (
    await input.repository.listUserActionRequests({ scopeType: "application" })
  ).some(
    (entry) =>
      entry.id !== request.id &&
      entry.scope.type === "application" &&
      entry.scope.applicationRecordId === applicationRecordId &&
      !isUserActionTerminal(entry.state),
  );
  if (stillOpen) return;

  const unavailablePreparedPage = input.unavailablePreparedPage === true;
  if (unavailablePreparedPage && applicationScope.resultId) {
    await terminalizeApplicationAfterPreparedPageLost({
      repository: input.repository,
      runId: applicationScope.runId,
      jobId: applicationScope.jobId,
      applicationRecordId,
      resultId: applicationScope.resultId,
      occurredAt: input.occurredAt,
      eventId: input.eventId,
    });
    return;
  }

  const cancelledByPerson =
    input.dismissal === "cancelled" && !input.closedBecause;
  const closedWord = input.dismissal === "skipped" ? "skipped" : "cancelled";
  await input.repository.upsertApplicationRecord(
    ApplicationRecordSchema.parse({
      ...record,
      // Closing the step is not the end of the application: the person can
      // press Try again later, or finish it on the site themselves.
      lastAttemptState: cancelledByPerson ? "cancelled" : "failed",
      lastActionLabel:
        input.closedBecause?.lastActionLabel ??
        (cancelledByPerson
          ? "Cancelled by you"
          : `You ${closedWord} the step Job Finder was waiting on.`),
      nextActionLabel:
        input.closedBecause?.nextActionLabel !== undefined
          ? input.closedBecause.nextActionLabel
          : "Try again, or finish it yourself on the job site.",
      lastUpdatedAt: input.occurredAt,
      latestBlocker: cancelledByPerson ? null : record.latestBlocker,
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      events: [
        ...record.events,
        {
          id: input.eventId,
          at: input.occurredAt,
          title: input.closedBecause?.eventTitle ?? `Step ${closedWord}`,
          detail:
            input.closedBecause?.eventDetail ??
            "Job Finder stopped working on this application. Nothing was sent, and you can still finish it yourself on the job site.",
          emphasis: "warning",
        },
      ],
    }),
  );

  if (!applicationScope.resultId) return;
  const runResults = await input.repository.listApplyJobResults({
    runId: applicationScope.runId,
  });
  const result = runResults.find(
    (entry) => entry.id === applicationScope.resultId,
  );
  if (
    !result ||
    result.state === "submitted" ||
    (input.preserveCompletedPreparation &&
      result.state === "awaiting_review" &&
      result.completedAt !== null) ||
    result.privacyReceipt?.submissionOutcome?.outcome === "outcome_uncertain"
  ) {
    return;
  }

  const terminalResult = ApplyJobResultSchema.parse({
    ...result,
    state:
      input.dismissal === "skipped"
        ? "skipped"
        : cancelledByPerson
          ? "cancelled"
          : "failed",
    summary:
      input.closedBecause?.resultSummary ??
      (cancelledByPerson
        ? "Cancelled by you"
        : `The person ${closedWord} the step Job Finder was waiting on.`),
    detail:
      input.closedBecause?.resultDetail ??
      "Job Finder stopped working on this application. Nothing was sent; choose Try again to prepare it again.",
    updatedAt: input.occurredAt,
    completedAt: input.occurredAt,
    blockerReason: cancelledByPerson ? null : result.blockerReason,
    blockerSummary: cancelledByPerson ? null : result.blockerSummary,
    pendingConsentRequestCount: cancelledByPerson
      ? 0
      : result.pendingConsentRequestCount,
    latestQuestionCount: 0,
  });
  await input.repository.upsertApplyJobResult(terminalResult);

  const run = (await input.repository.listApplyRuns()).find(
    (entry) => entry.id === applicationScope.runId,
  );
  if (!run) return;
  const nextResults = runResults.map((entry) =>
    entry.id === terminalResult.id ? terminalResult : entry,
  );
  const pendingResults = nextResults.filter((entry) =>
    [
      "planned",
      "question_capture",
      "filling",
      "submitting",
      "awaiting_review",
    ].includes(entry.state),
  );
  const workingResults = pendingResults.filter(
    (entry) => entry.state !== "awaiting_review",
  );
  const blockedResults = nextResults.filter(
    (entry) => entry.state === "blocked",
  );
  const hasWaitingWork = pendingResults.length > 0 || blockedResults.length > 0;
  await input.repository.upsertApplyRun(
    ApplyRunSchema.parse({
      ...run,
      state:
        run.state === "cancelled" || run.state === "failed"
          ? run.state
          : workingResults.length > 0
            ? "running"
            : hasWaitingWork
              ? "paused_for_user_review"
              : "completed",
      currentJobId:
        run.state === "cancelled" || run.state === "failed"
          ? null
          : (workingResults[0]?.jobId ??
            pendingResults[0]?.jobId ??
            blockedResults[0]?.jobId ??
            null),
      updatedAt: input.occurredAt,
      completedAt:
        run.state === "cancelled" || run.state === "failed"
          ? run.completedAt
          : hasWaitingWork
            ? null
            : input.occurredAt,
      // Every outcome in the batch is counted, so one cancel does not hide
      // the applications that went out or failed.
      ...(cancelledByPerson
        ? {
            summary: (
              [
                ["submitted", "applied"],
                ["cancelled", "cancelled"],
                ["failed", "failed"],
                ["blocked", "blocked"],
                ["skipped", "skipped"],
                ["awaiting_review", "waiting on you"],
              ] as const
            )
              .map(([state, label]) => {
                const count = nextResults.filter(
                  (entry) => entry.state === state,
                ).length;
                return count > 0 ? `${count} ${label}` : null;
              })
              .filter(Boolean)
              .join(" · "),
          }
        : {}),
      pendingJobs: pendingResults.length,
      submittedJobs: nextResults.filter((entry) => entry.state === "submitted")
        .length,
      skippedJobs: nextResults.filter((entry) => entry.state === "skipped")
        .length,
      blockedJobs: nextResults.filter((entry) => entry.state === "blocked")
        .length,
      failedJobs: nextResults.filter((entry) => entry.state === "failed")
        .length,
    }),
  );
}

/** Close steps that can no longer resume because their exact run was cancelled. */
export async function retireCancelledApplicationUserActions(
  repository: JobFinderRepository,
  runId?: string,
): Promise<void> {
  const display = await repository.readDisplayCollections?.();
  const [runs, requests, results] = await Promise.all([
    display?.applyRuns ?? repository.listApplyRuns(),
    display?.userActionRequests.filter(
      (request) => request.scope.type === "application",
    ) ?? repository.listUserActionRequests({ scopeType: "application" }),
    display?.applyJobResults ?? repository.listApplyJobResults(),
  ]);
  const cancelledRunIds = new Set(
    runs
      .filter(
        (run) => run.state === "cancelled" && (!runId || run.id === runId),
      )
      .map((run) => run.id),
  );
  for (const request of requests) {
    const scope = request.scope;
    if (
      scope.type !== "application" ||
      !cancelledRunIds.has(scope.runId) ||
      !scope.applicationRecordId ||
      !scope.resultId ||
      isUserActionTerminal(request.state)
    )
      continue;
    const result = results.find(
      (entry) =>
        entry.id === scope.resultId &&
        entry.runId === scope.runId &&
        entry.jobId === scope.jobId &&
        entry.applicationRecordId === scope.applicationRecordId,
    );
    if (
      !result ||
      result.state === "submitted" ||
      result.privacyReceipt?.submissionOutcome?.outcome === "outcome_uncertain"
    )
      continue;
    const now = new Date().toISOString();
    const transition = reduceUserActionCommand(
      request,
      {
        requestId: request.id,
        commandId: `${request.id}_run_cancelled_r${request.revision}`,
        expectedRevision: request.revision,
        action: "cancel",
        reason:
          "The application run was cancelled. Choose Try again to prepare it again.",
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      },
      now,
    );
    if (transition.status !== "applied") continue;
    const commit = await repository.commitUserActionTransition({
      request: transition.request,
      event: transition.event,
    });
    if (commit.status === "stale") continue;
    await withApplicationRecordTransition(
      repository,
      scope.applicationRecordId,
      async () => {
        // Re-read under the record transition: a new attempt may have committed
        // while this request was being closed. Ambiguous equal times stay intact.
        const currentResults = await repository.listApplyJobResults();
        const currentResult = currentResults.find(
          (entry) => entry.id === result.id,
        );
        if (
          !currentResult ||
          currentResult.state === "submitted" ||
          currentResult.privacyReceipt?.submissionOutcome?.outcome ===
            "outcome_uncertain"
        )
          return;
        if (
          currentResults.some(
            (entry) =>
              entry.applicationRecordId === scope.applicationRecordId &&
              entry.id !== result.id &&
              entry.startedAt >= result.startedAt,
          )
        )
          return;
        await releaseApplicationRecordAfterDismissedUserAction({
          repository,
          request: commit.request,
          occurredAt: now,
          eventId: `event_${request.id}_run_cancelled`,
          dismissal: "cancelled",
          closedBecause: {
            lastActionLabel: "You cancelled this application run.",
            eventTitle: "Application step closed after cancellation",
            eventDetail:
              "The application run was cancelled. Its prepared evidence remains available; choose Try again to prepare it again.",
            resultSummary: "You cancelled this application run.",
            resultDetail:
              "Nothing was sent. Choose Try again to prepare this application again.",
          },
        });
      },
    );
  }
}

/**
 * The person recorded in their tracker that an application was sent (Applied
 * or a later stage), or that they withdrew it. Its open steps (a question,
 * "finish it on the site") are no longer theirs to do, so they are closed
 * instead of staying in Needs you and inviting a second submission (N-033).
 * Nothing is marked as a verified send: the result keeps its own state, and
 * the tracker carries their word.
 */
export async function closeApplicationStepsTrackedByPerson(
  repository: JobFinderRepository,
  applicationRecordIds: readonly string[],
  reason: "sent" | "withdrawn",
): Promise<void> {
  const recordIds = new Set(applicationRecordIds);
  if (recordIds.size === 0) return;
  const wording =
    reason === "sent"
      ? {
          commandReason:
            "You recorded this application as sent in your tracker.",
          lastActionLabel: "You recorded this application as sent.",
          eventTitle: "Application step closed: you sent it",
          eventDetail:
            "You set its tracker stage to one that comes after sending, so Job Finder closed the step it was waiting on. Nothing was sent by Job Finder.",
          resultDetail:
            "Your tracker says this application was sent. Job Finder did not see the site's confirmation and will not fill it in again.",
        }
      : {
          commandReason: WITHDRAWN_BY_PERSON_SUMMARY,
          lastActionLabel: "You marked this application withdrawn.",
          eventTitle: "Application step closed: you withdrew it",
          eventDetail:
            "You marked it withdrawn in your tracker, so Job Finder closed the step it was waiting on. Nothing was sent by Job Finder.",
          resultDetail:
            "You marked this application withdrawn. Job Finder will not work on it again unless you choose Try again.",
        };
  const requests = await repository.listUserActionRequests({
    scopeType: "application",
  });
  for (const request of requests) {
    const scope = request.scope;
    if (
      scope.type !== "application" ||
      !scope.applicationRecordId ||
      !recordIds.has(scope.applicationRecordId) ||
      isUserActionTerminal(request.state)
    )
      continue;
    const now = new Date().toISOString();
    const transition = reduceUserActionCommand(
      request,
      {
        requestId: request.id,
        commandId: `${request.id}_tracked_${reason}_r${request.revision}`,
        expectedRevision: request.revision,
        action: "skip",
        reason: wording.commandReason,
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      },
      now,
    );
    if (transition.status !== "applied") continue;
    const commit = await repository.commitUserActionTransition({
      request: transition.request,
      event: transition.event,
    });
    if (commit.status === "stale") continue;
    await withApplicationRecordTransition(
      repository,
      scope.applicationRecordId,
      () =>
        releaseApplicationRecordAfterDismissedUserAction({
          repository,
          request: commit.request,
          occurredAt: now,
          eventId: `event_${request.id}_tracked_${reason}`,
          dismissal: "skipped",
          preserveCompletedPreparation: true,
          closedBecause: {
            lastActionLabel: wording.lastActionLabel,
            eventTitle: wording.eventTitle,
            eventDetail: wording.eventDetail,
            resultSummary: wording.lastActionLabel,
            resultDetail: wording.resultDetail,
            nextActionLabel: null,
          },
        }),
    );
  }
}

/** Undo restores the tracker, but cannot reopen a task already closed. */
export async function restoreWithdrawnApplicationPreparation(
  repository: JobFinderRepository,
  applicationRecordIds: readonly string[],
): Promise<void> {
  for (const recordId of applicationRecordIds) {
    await withApplicationRecordTransition(repository, recordId, async () => {
      const record = (await repository.listApplicationRecords()).find(
        (entry) => entry.id === recordId,
      );
      if (!record || record.crm?.stage === "withdrawn") return;
      const latest = (await repository.listApplyJobResults())
        .filter((entry) => entry.applicationRecordId === recordId)
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
        )[0];
      if (
        !latest ||
        latest.state !== "skipped" ||
        latest.summary !== WITHDRAWN_BY_PERSON_SUMMARY
      )
        return;
      const now = new Date().toISOString();
      const trackedAsSent = isApplicationTrackedAsSentByPerson(record.crm);
      await repository.upsertApplyJobResult(
        ApplyJobResultSchema.parse({
          ...latest,
          summary: trackedAsSent
            ? "Withdrawal undone. Tracked as sent."
            : WITHDRAWAL_UNDONE_SUMMARY,
          detail: trackedAsSent
            ? "Your previous tracker stage is restored. You marked this application as sent."
            : "Your previous tracker stage is restored. Prepare this application again using your saved answers and files.",
          updatedAt: now,
        }),
      );
      await repository.upsertApplicationRecord(
        ApplicationRecordSchema.parse({
          ...record,
          lastActionLabel: "Withdrawal undone.",
          nextActionLabel: trackedAsSent ? null : "Prepare again",
          lastUpdatedAt: now,
        }),
      );
    });
  }
}
