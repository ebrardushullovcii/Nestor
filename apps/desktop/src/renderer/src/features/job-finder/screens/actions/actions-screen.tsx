import { useQuestionAnswerDrafts } from "./use-question-answer-drafts";
import { PlanSafeguardPauseCards } from "../../components/plan-safeguard-pause-cards";
import {
  CONFIRM_STEP_DONE_ACTION,
  JOB_FINDER_BROWSER_NAME,
  OPEN_JOB_FINDER_BROWSER_ACTION,
} from "../../lib/job-finder-browser-handoff-copy";
import type {
  ApplicationAttemptQuestion,
  ApplyRunDetails,
  JobFinderApplyRunDetailsQuery,
  ApplyGroupedManualAnswerInput,
  CandidateProfile,
  PlanSafeguardPause,
  GroupedManualAnswerDecision,
  JobFinderRendererWorkspaceSnapshot,
  ProjectGroupedManualAnswerCommand,
  SnoozeGroupedDecisionInput,
  UserActionCommandInput,
  UserActionRequest,
} from "@nestor/contracts";
import { ArrowUpRight, Ban, BellOff, Check, ExternalLink } from "lucide-react";

import { Badge } from "@renderer/components/ui/badge";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Textarea } from "@renderer/components/ui/textarea";
import {
  BoundedCollectionPagination,
  useBoundedCollection,
} from "./bounded-collection";
import { formatDateOnly } from "../../lib/job-finder-utils";
import { stripScrapedGlyphs } from "../../lib/scraped-glyphs";
import {
  splitBlockedAttemptNote,
  TECHNICAL_DETAILS_LABEL,
} from "../../lib/describe-failure";
import { buildJobFinderContextRoute } from "../../lib/job-finder-context-navigation";
import { buildResumeWorkspaceRoute } from "../../lib/resume-workspace-route";
import { listApplicationsAwaitingUser } from "../../lib/needs-you-count";
import {
  APPLICATION_FILE_CONTINUES_NOTE,
  APPLICATION_SIGN_IN_CONTINUES_NOTE,
  OPEN_PROFILE_FILES_ACTION,
  applicationSignInContinuesOnItsOwn,
} from "../../lib/application-sign-in-handoff";
import {
  inferFileKindForQuestion,
  profileFilesHref,
} from "../../lib/job-finder-route-hrefs";
import {
  getApplicationNextStepLabel,
  listPendingApplicationQuestions,
} from "../applications/applications-status";
import { formatQuestionPrompt } from "../applications/applications-recovery-state";
import { describeFailure } from "../../lib/describe-failure";
import {
  CollectionNoMatches,
  CollectionSearchToolbar,
  matchesCollectionSearch,
} from "../../components/collection-search-toolbar";
import { PageHeaderStack } from "../../components/page-header";
import { usePersistedCollectionView } from "../../hooks/use-persisted-collection-view";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

const terminalStates = new Set<UserActionRequest["state"]>([
  "resolved",
  "skipped",
  "cancelled",
  "expired",
  "superseded",
]);

type DiscoveryJob = JobFinderRendererWorkspaceSnapshot["discoveryJobs"][number];

export function getUserActionContextRoute(
  request: Pick<UserActionRequest, "scope">,
  applicationRecords?: readonly JobFinderRendererWorkspaceSnapshot["applicationRecords"][number][],
): string {
  if (request.scope.type === "discovery_source") {
    return buildJobFinderContextRoute("/job-finder/discovery", {
      targetId: request.scope.targetId,
    });
  }

  const applicationScope = request.scope;
  if (applicationScope.applicationRecordId) {
    return buildJobFinderContextRoute("/job-finder/applications", {
      applicationRecordId: applicationScope.applicationRecordId,
      jobId: applicationScope.jobId,
    });
  }

  const matchingRecords = (applicationRecords ?? []).filter(
    (record) => record.jobId === applicationScope.jobId,
  );
  const applicationRecordId =
    matchingRecords.length === 1 ? (matchingRecords[0]?.id ?? null) : null;

  return buildJobFinderContextRoute(
    "/job-finder/applications",
    applicationRecordId
      ? { applicationRecordId, jobId: applicationScope.jobId }
      : { jobId: applicationScope.jobId },
  );
}

/**
 * One name for the window and one name for the confirm, on every browser
 * step. "Open sign-up" / "Account is ready" / "Open MFA" / "MFA is complete"
 * were nine names for two actions.
 */
export const userActionKindPresentations: Record<
  UserActionRequest["kind"],
  { label: string; openLabel: string; doneLabel: string; guidance: string }
> = {
  login: {
    label: "Sign in",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: `Complete sign-in in ${JOB_FINDER_BROWSER_NAME}.`,
  },
  signup: {
    label: "Sign up",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: `Create the account yourself in ${JOB_FINDER_BROWSER_NAME}.`,
  },
  mfa: {
    label: "MFA",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: `Complete the security-code challenge in ${JOB_FINDER_BROWSER_NAME}.`,
  },
  email_verification: {
    label: "Email verification",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: "Use the verification link or code yourself.",
  },
  captcha: {
    label: "CAPTCHA",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: "Complete the human-verification challenge yourself.",
  },
  existing_account_choice: {
    label: "Account choice",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: "Choose the appropriate account path yourself.",
  },
  manual_answer: {
    label: "Manual answer",
    openLabel: "Open question",
    doneLabel: "Answer is complete",
    guidance: `Review and answer the question in ${JOB_FINDER_BROWSER_NAME}.`,
  },
  legal_consent: {
    label: "Legal consent",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: "Read and decide the legal consent yourself.",
  },
  external_redirect: {
    label: "External redirect",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: "Review the external destination before continuing.",
  },
  manual_upload: {
    label: "Manual upload",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: `Attach the requested file yourself in ${JOB_FINDER_BROWSER_NAME}.`,
  },
  other: {
    label: "Other",
    openLabel: OPEN_JOB_FINDER_BROWSER_ACTION,
    doneLabel: CONFIRM_STEP_DONE_ACTION,
    guidance: "Do this step yourself in the browser.",
  },
};

export function listUnresolvedUserActions(
  requests: readonly UserActionRequest[],
): readonly UserActionRequest[] {
  return requests.filter((request) => !terminalStates.has(request.state));
}

/**
 * Indexes the discovery jobs by id once per snapshot so scope lookups stay
 * one-pass instead of scanning the job array for every action card.
 */
export function buildJobIndexById(
  jobs: readonly DiscoveryJob[],
): Map<string, DiscoveryJob> {
  return new Map(jobs.map((job) => [job.id, job]));
}

/**
 * A whole instruction that only restates the safety boundary — the runtime
 * writes one per request ("…and stops before final submission").
 */
const SAFETY_ONLY_INSTRUCTION =
  /^(?:after (?:access verification|confirmation)|job finder)\b[^.]*\b(?:stops? before final submission|never (?:receives|handles|stores))/i;

/**
 * A trailing safety clause appended to an otherwise actionable step, e.g.
 * "Complete sign-in in the Job Finder browser. Job Finder never receives or
 * stores your credentials."
 */
const TRAILING_SAFETY_CLAUSE =
  /(?:\s|^)(?:job finder (?:never|cannot)[^.]*\.|do not enter (?:credentials|passwords)[^.]*\.)\s*$/i;

/**
 * The card already ends with one safety sentence and the page header owns the
 * credentials boundary, so the numbered steps stay purely about what the user
 * does: open the page, finish the step, come back and confirm.
 */
export function toActionableInstructions(
  instructions: readonly string[],
): readonly string[] {
  return (
    instructions
      // A site's own decoration travels into these lines through the labels they
      // quote; a colour pin in the middle of a step is noise, not an instruction.
      .map((instruction) => stripScrapedGlyphs(instruction).trim())
      .filter(
        (instruction) =>
          instruction.length > 0 && !SAFETY_ONLY_INSTRUCTION.test(instruction),
      )
      .map((instruction) =>
        instruction.replace(TRAILING_SAFETY_CLAUSE, "").trim(),
      )
      .filter((instruction) => instruction.length > 0)
  );
}

/** Below this many open actions the list is scannable without a search field. */
const ACTION_SEARCH_MIN_ITEMS = 5;

const SECRET_CREDENTIAL_QUESTION =
  /\b(?:password|passcode|one[- ]time (?:password|code)|verification code|security code|otp)\b/i;

export function createCommand(
  request: UserActionRequest,
  action: "open_page" | "confirm_done" | "skip" | "cancel",
): UserActionCommandInput {
  const base = {
    requestId: request.id,
    commandId: `user_action_${action}_${globalThis.crypto.randomUUID()}`,
    expectedRevision: request.revision,
    credentialsPolicy: "browser_only" as const,
    submitAuthorized: false as const,
    accountCreationAuthorized: false as const,
  };

  return action === "skip" || action === "cancel"
    ? { ...base, action, reason: null }
    : { ...base, action };
}

function TaskLocalCredentialsForm(props: {
  isPending: boolean;
  onCommand: (command: UserActionCommandInput) => void | Promise<void>;
  request: UserActionRequest;
}) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const canSubmit = identifier.trim().length > 0 && password.length > 0;

  return (
    <details className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) p-3">
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        Use credentials for this task
      </summary>
      <p className="mt-3 text-xs leading-5 text-foreground-soft">
        These are used once on this exact sign-in page. Job Finder does not save
        them to your profile, answers, or application history.
      </p>
      <form
        className="mt-3 grid max-w-md gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          const command: UserActionCommandInput = {
            action: "submit_task_local_credentials",
            requestId: props.request.id,
            commandId: `user_action_task_local_credentials_${globalThis.crypto.randomUUID()}`,
            expectedRevision: props.request.revision,
            identifier: identifier.trim(),
            password,
            taskLocalUseAuthorized: true,
            credentialsPolicy: "browser_only",
            submitAuthorized: false,
            accountCreationAuthorized: false,
          };
          setPassword("");
          void props.onCommand(command);
        }}
      >
        <label className="grid gap-1 text-sm text-foreground">
          Account email or username
          <Input
            autoComplete="off"
            disabled={props.isPending}
            onChange={(event) => setIdentifier(event.target.value)}
            value={identifier}
          />
        </label>
        <label className="grid gap-1 text-sm text-foreground">
          Password
          <Input
            autoComplete="off"
            disabled={props.isPending}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </label>
        <Button
          disabled={!canSubmit}
          pending={props.isPending}
          size="compact"
          type="submit"
          variant="secondary"
        >
          Sign in once and continue
        </Button>
      </form>
    </details>
  );
}

/** A check still running after this long says why it may be waiting. */
const CHECK_SLOW_MINUTES = 3;
/** After this long a check is treated as lost and offers a fresh start. */
const CHECK_STALLED_MINUTES = 12;

/** Whole minutes since `since`, re-read every half minute; null when unset. */
function siteHostOf(job: {
  applicationUrl?: string | null;
  canonicalUrl: string;
}): string | null {
  try {
    return new URL(job.applicationUrl ?? job.canonicalUrl).hostname;
  } catch {
    return null;
  }
}

/** True when another job on this job's site is being filled in right now. */
export function isSameSiteApplicationActive(
  job: { id: string; applicationUrl?: string | null; canonicalUrl: string },
  applyJobResults: readonly { jobId: string; state: string }[],
  jobsById: ReadonlyMap<
    string,
    { id: string; applicationUrl?: string | null; canonicalUrl: string }
  >,
): boolean {
  const host = siteHostOf(job);
  if (!host) return false;
  return applyJobResults.some((result) => {
    if (result.jobId === job.id) return false;
    if (!["filling", "question_capture", "submitting"].includes(result.state))
      return false;
    const other = jobsById.get(result.jobId);
    return other ? siteHostOf(other) === host : false;
  });
}

export function useMinutesSince(since: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [since]);
  if (!since) return null;
  const started = Date.parse(since);
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.floor((now - started) / 60_000));
}

function ActionCard(props: {
  isGroupedProjectPending: (groupKey: string) => boolean;
  isPending: boolean;
  jobLabel: string | null;
  jobLocation?: string | undefined;
  /**
   * Returning a promise lets the question step wait for the bridge call and
   * say so when it is refused, instead of a click that records nothing.
   */
  onCommand: (command: UserActionCommandInput) => void | Promise<void>;
  onOpenScope: () => void;
  /** Opens Profile > Files, where a file question is answered. */
  onOpenFiles?: () => void;
  onProjectGroupedManualAnswer: (
    command: ProjectGroupedManualAnswerCommand,
  ) => void;
  profile: CandidateProfile | null;
  questions: readonly ApplicationAttemptQuestion[];
  answerDraft?: QuestionAnswerDraft;
  onAnswerDraftChange?: (draft: QuestionAnswerDraft) => void | Promise<void>;
  request: UserActionRequest;
  /**
   * Closes a check that never finished and prepares the application again,
   * in one press. Absent where the application cannot be started from here.
   */
  onStartOver?: (cancel: UserActionCommandInput) => void | Promise<void>;
  /**
   * Another application on the same site is being filled in right now. A
   * checked step waits for it (one application per site at a time).
   */
  sameSiteApplicationActive?: boolean;
}) {
  const { isPending, jobLabel, onCommand, onOpenScope, questions, request } =
    props;
  const isVerifying = request.state === "verifying";
  const checkingMinutes = useMinutesSince(
    isVerifying ? request.updatedAt : null,
  );
  const waitsForSameSite =
    request.scope.type === "application" &&
    Boolean(props.sameSiteApplicationActive) &&
    checkingMinutes !== null &&
    checkingMinutes >= 1;
  const checkingStalled =
    request.scope.type === "application" &&
    checkingMinutes !== null &&
    checkingMinutes >= CHECK_STALLED_MINUTES;
  const checkingWaits =
    !checkingStalled &&
    checkingMinutes !== null &&
    checkingMinutes >= CHECK_SLOW_MINUTES;
  // Older runs could misclassify a password input as an ordinary application
  // question. Never render a reusable-answer editor for that persisted data.
  // It stays a browser handoff so the person can open, check, or cancel it.
  const isLegacyCredentialQuestion =
    request.kind === "manual_answer" &&
    questions.some((question) =>
      SECRET_CREDENTIAL_QUESTION.test(question.prompt.trim()),
    );
  // One shape for the whole card: a question step is a question and an answer
  // box, not a browser hand-off with an answer editor bolted underneath it.
  const answerQuestions = questions.filter(
    (question) => question.answerControlType !== "file",
  );
  const isQuestionStep =
    request.kind === "manual_answer" &&
    answerQuestions.length > 0 &&
    !isLegacyCredentialQuestion;
  // A sign-in, account, or security-check step is a sentence and two buttons.
  // It used to stack five paraphrases of "do it in the browser and come back"
  // plus a retry-mechanics note the person cannot act on.
  const isBlockerStep =
    request.kind === "login" ||
    request.kind === "signup" ||
    request.kind === "mfa" ||
    request.kind === "captcha" ||
    request.kind === "email_verification" ||
    request.kind === "existing_account_choice" ||
    isLegacyCredentialQuestion;
  const stepHostLabel = (() => {
    const raw = request.actionUrl ?? request.displayOrigin;
    if (!raw) {
      return null;
    }
    try {
      return new URL(raw).hostname.replace(/^www\./i, "");
    } catch {
      return raw.split(/[/?#]/)[0] || null;
    }
  })();
  const attemptsExhausted = request.attemptCount >= request.maxAttempts;
  const continuesAfterSignIn = applicationSignInContinuesOnItsOwn(request);
  // A file question is answered in Profile > Files: adding or restoring a
  // fitting file there carries the application on by itself.
  const waitsForFile =
    (request.kind === "manual_upload" || request.kind === "manual_answer") &&
    request.scope.type === "application" &&
    Boolean(props.onOpenFiles) &&
    questions.some(
      (question) =>
        question.answerControlType === "file" && question.kind !== "resume",
    );
  const presentation = userActionKindPresentations[request.kind];
  const actionPresentation = isLegacyCredentialQuestion
    ? userActionKindPresentations.login
    : presentation;
  const displayedTitle = isLegacyCredentialQuestion
    ? "Sign in to continue"
    : stripScrapedGlyphs(request.title);
  const scopeLabel =
    request.scope.type === "application" ? "application" : "job source";
  const missingBrowserLinkDescriptionId = `${request.id}-missing-browser-link`;
  const cancelConsequenceId = `${request.id}-cancel-consequence`;
  const actionableInstructions = toActionableInstructions(request.instructions);
  // The runtime records what the page tried to do when it was blocked. It is
  // kept, because it tells an engineer what happened — but it is a request
  // log, so it sits behind a disclosure instead of inside the step a person
  // is being asked to carry out.
  const instructionParts = actionableInstructions.map((instruction) =>
    splitBlockedAttemptNote(instruction),
  );
  const instructionTechnicalDetails = instructionParts
    .map((part) => part.technicalDetails)
    .filter((detail): detail is string => Boolean(detail));
  const summaryParts = splitBlockedAttemptNote(request.summary);
  // The same recorded line often repeats across summary and steps; it is one
  // fact, so it is listed once.
  const technicalDetails = [
    ...new Set([
      ...(summaryParts.technicalDetails ? [summaryParts.technicalDetails] : []),
      ...instructionTechnicalDetails,
    ]),
  ];

  return (
    <article className="grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Everything in a queue called "Needs you" is required, so a
                REQUIRED chip on every card carried no information. Only the
                exception — a step you may skip — is worth a chip. */}
            {request.requirement === "required" ? null : (
              <Badge variant="section">Optional</Badge>
            )}
            {/* "Other" names nothing; the request summary already says what
            the step is, so only classified kinds earn a category badge. */}
            {request.kind === "other" || isLegacyCredentialQuestion ? null : (
              <Badge variant="status">{presentation.label}</Badge>
            )}
            {/* Everything on Needs you is awaiting the user, so that state
                is the page, not a chip. Only a step in another state (being
                verified after you confirmed it) says so. */}
            {request.state === "awaiting_user" ? null : (
              <Badge variant="outline">
                {request.state === "verifying"
                  ? request.kind === "manual_answer"
                    ? `${props.sameSiteApplicationActive ? "Waiting its turn" : "Inserting your answer"} (${checkingMinutes === 0 ? "under a minute" : `${checkingMinutes ?? 0} min`})`
                    : "Checking"
                  : request.state.replaceAll("_", " ")}
              </Badge>
            )}
          </div>
          <h3 className="font-semibold text-(--text-headline)">
            {displayedTitle}
          </h3>
          {/* A question step's summary was four sentences restating the
              heading, the question, and "do it in the browser and come back"
              — none of which is true any more now that the answer box is
              right here. */}
          <p className="max-w-3xl text-sm leading-6 text-foreground-soft">
            {isQuestionStep
              ? // A question that came back with a reason (for example the
                // saved work countries do not settle the job's region) says
                // what Job Finder did find under the question; the heading
                // must not claim the profile has nothing.
                questions.some((question) => Boolean(question.note))
                ? "Your saved details do not settle this. The note under the question says why."
                : "Nothing in your profile, resume, or saved answers covers this."
              : isLegacyCredentialQuestion
                ? "This older step cannot collect a password. Open the exact job page to sign in there, or cancel it and try the application again."
                : isVerifying
                  ? // Being checked (or answered from a saved answer): saying
                    // "do it in the browser, then come back and confirm" here
                    // told the person to do what Job Finder was doing.
                    waitsForSameSite && !checkingStalled
                    ? "Waiting for the other application on this site to finish. It carries on by itself after that; nothing is needed from you."
                    : checkingStalled
                      ? `This check has not finished after ${checkingMinutes} minutes, so Job Finder has probably lost track of it. Nothing was sent. Prepare it again to start this application afresh with your answers.`
                      : checkingWaits
                        ? request.scope.type === "application"
                          ? `Still checking after ${checkingMinutes} minutes. Another application on the same site is probably ahead of it; it carries on by itself when that one finishes.`
                          : `Still checking after ${checkingMinutes} minutes. Another search is still running; this source is searched as soon as it ends.`
                        : "Job Finder is checking this step and carries on by itself once it is done. Nothing is needed from you unless it asks again."
                  : stripScrapedGlyphs(summaryParts.message)}
          </p>
        </div>
        <Button
          onClick={onOpenScope}
          size="compact"
          type="button"
          variant="ghost"
        >
          View {request.scope.type === "application" ? "application" : "source"}
          <ArrowUpRight aria-hidden="true" />
        </Button>
      </div>

      {jobLabel ? (
        <p className="text-sm font-medium text-foreground">{jobLabel}</p>
      ) : null}
      {/* The verification origin is deliberately path-stripped, so showing
          it alone told the user only "wellfound.com". The exact page the
          action opens is the useful fact; the bare origin is the fallback. */}
      {/* The host, not a 900-character OAuth URL. The full link is what the
          button opens; printing it here was a wall of query string. */}
      {stepHostLabel ? (
        <p className="text-xs text-muted-foreground">On: {stepHostLabel}</p>
      ) : null}
      {/* While Job Finder is checking the step, the person's instructions
          ("confirm completion ...") contradict "Nothing is needed from you". */}
      {instructionParts.length > 0 &&
      !isQuestionStep &&
      !isBlockerStep &&
      !isVerifying ? (
        <ol className="grid list-decimal gap-1 pl-5 text-sm leading-6 text-foreground-soft">
          {instructionParts.map((part) => (
            <li key={part.message}>{part.message}</li>
          ))}
        </ol>
      ) : null}
      {technicalDetails.length > 0 && !isBlockerStep ? (
        <details className="min-w-0">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {TECHNICAL_DETAILS_LABEL}
          </summary>
          <ul
            className="mt-1 grid gap-1 break-all text-xs leading-5 text-muted-foreground"
            role="list"
          >
            {technicalDetails.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {questions
        .filter((question) => question.answerControlType === "file")
        .map((question) => (
          <p
            className="text-sm leading-6 text-foreground-soft"
            key={question.id}
          >
            Add the required{" "}
            {formatQuestionPrompt(question.prompt).toLowerCase()}.
            {question.note ? ` ${question.note}` : ""}
          </p>
        ))}
      {isQuestionStep && isVerifying ? (
        <p
          aria-live="polite"
          className="text-(length:--text-small) leading-6 text-foreground-soft"
          data-testid="needs-you-answered-status"
          role="status"
        >
          Answered. Job Finder is putting your answers in and carrying on; this
          step closes on its own when the form moves forward.
        </p>
      ) : null}
      {isQuestionStep ? (
        <div hidden={isVerifying}>
          <QuestionAnswerForm
            {...(props.answerDraft ? { draft: props.answerDraft } : {})}
            {...(props.onAnswerDraftChange
              ? { onDraftChange: props.onAnswerDraftChange }
              : {})}
            isPending={isPending || isVerifying}
            onAnswer={async (answers, saveForFuture, hiringCountry) => {
              // Every answer in one command, each tied to its question, so one
              // revision moves the step on and no answer is lost between calls.
              const first = answers[0];
              if (!first) return;
              await onCommand({
                ...createCommand(request, "confirm_done"),
                action: "submit_manual_answer",
                answer: first.answer,
                // Always tied to its question: an application keeps earlier
                // questions on record, so a bare answer can be ambiguous.
                answers: answers.map((entry) => ({ ...entry })),
                saveForFuture,
                ...(hiringCountry ? { hiringCountry } : {}),
              });
            }}
            jobLocation={props.jobLocation}
            questions={answerQuestions}
            requestId={request.id}
          />
        </div>
      ) : null}
      {request.kind === "login" &&
      request.scope.type === "application" &&
      request.scope.resultId &&
      !isVerifying ? (
        <TaskLocalCredentialsForm
          isPending={isPending}
          onCommand={onCommand}
          request={request}
        />
      ) : null}
      {/* The boxed treatment framed the boundary as fine print and repeated
          the steps above it inside a grey rectangle. The per-kind sentence
          and the one no-submit sentence stay; the box does not. */}
      {continuesAfterSignIn ? (
        <p
          className="text-xs leading-5 text-muted-foreground"
          data-testid="needs-you-sign-in-continues-note"
        >
          {APPLICATION_SIGN_IN_CONTINUES_NOTE}
        </p>
      ) : isQuestionStep ||
        isBlockerStep ||
        isVerifying ? null : waitsForFile ? ( // answer the question in the browser" contradicted the line above. // A step being checked needs nothing from the person; "Review and
        // Requests written before the file hand-off carried this sentence
        // still get it once; newer ones already say it above.
        request.summary.includes("Profile › Files") ? null : (
          <p
            className="text-xs leading-5 text-muted-foreground"
            data-testid="needs-you-file-continues-note"
          >
            {APPLICATION_FILE_CONTINUES_NOTE}
          </p>
        )
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          {presentation.guidance} Confirming here cannot create an account or
          submit an application.
        </p>
      )}

      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={`Actions for ${displayedTitle}`}
      >
        {checkingStalled && props.onStartOver ? (
          <Button
            data-testid="needs-you-start-over"
            onClick={() => {
              void props.onStartOver?.(createCommand(request, "cancel"));
            }}
            pending={isPending}
            size="compact"
            type="button"
          >
            Prepare it again
          </Button>
        ) : null}
        {waitsForFile && props.onOpenFiles ? (
          <Button
            data-testid="needs-you-open-files"
            onClick={props.onOpenFiles}
            size="compact"
            type="button"
          >
            <ArrowUpRight aria-hidden="true" /> {OPEN_PROFILE_FILES_ACTION}
          </Button>
        ) : null}
        {isQuestionStep ? null : request.actionUrl ? (
          <Button
            onClick={() => {
              void onCommand(createCommand(request, "open_page"));
            }}
            pending={isPending}
            size="compact"
            type="button"
          >
            <ExternalLink aria-hidden="true" /> {actionPresentation.openLabel}
          </Button>
        ) : (
          <Button
            aria-describedby={missingBrowserLinkDescriptionId}
            onClick={onOpenScope}
            size="compact"
            type="button"
            variant="secondary"
          >
            <ArrowUpRight aria-hidden="true" /> Review {scopeLabel}
          </Button>
        )}
        {/* A sign-in on a kept application page is watched: the run goes
            on by itself once the wall is gone, so no check press. */}
        {!isQuestionStep && !continuesAfterSignIn ? (
          <Button
            disabled={isVerifying || attemptsExhausted}
            onClick={() => {
              void onCommand(createCommand(request, "confirm_done"));
            }}
            pending={isPending}
            size="compact"
            type="button"
            variant="secondary"
          >
            <Check aria-hidden="true" />
            {isVerifying
              ? "Verifying"
              : attemptsExhausted
                ? "Attempts exhausted"
                : actionPresentation.doneLabel}
          </Button>
        ) : null}
        {/* "Skip" and "Cancel" were peers with no stated difference and the
            same outcome: both close the request without doing the step. One
            dismissal, named for what it does. */}
        {/* The label said nothing about the consequence, so cancelling read
            as "put this aside" rather than "this application stops here". */}
        <Button
          aria-describedby={cancelConsequenceId}
          onClick={() => {
            void onCommand(createCommand(request, "cancel"));
          }}
          pending={isPending}
          size="compact"
          type="button"
          variant="ghost"
        >
          <Ban aria-hidden="true" />
          {isQuestionStep ? "Skip this job" : "Cancel this step"}
        </Button>
      </div>
      <p
        className="text-xs leading-5 text-muted-foreground"
        id={cancelConsequenceId}
      >
        Cancelling closes this step without doing it. Job Finder stops working
        on it and nothing is sent; you can still finish it yourself on the job
        site.
      </p>

      {!request.actionUrl ? (
        <p
          className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-xs leading-5 text-foreground-soft"
          id={missingBrowserLinkDescriptionId}
          role="status"
        >
          The saved browser link is unavailable. Review the {scopeLabel} to
          restart or recover this step; if the correct browser page is already
          open, finish there and then use the confirmation action above.
        </p>
      ) : null}

      {isPending ? (
        <p className="text-xs leading-5 text-muted-foreground" role="status">
          {`Working in ${JOB_FINDER_BROWSER_NAME}. This step is time-limited and the controls will re-enable automatically.`}
        </p>
      ) : null}

      {attemptsExhausted ? (
        <p className="text-xs leading-5 text-muted-foreground" role="status">
          Job Finder checked {request.maxAttempts} times and still saw the same
          page. Finish the step in {JOB_FINDER_BROWSER_NAME}, then open the
          application and choose Run preparation again, or cancel this step to
          stop working on this job.
        </p>
      ) : null}
    </article>
  );
}

const snoozeDayMs = 86_400_000;

/**
 * Builds the typed approval payload that covers exactly the persisted decision
 * lineage ids/revisions plus the persisted answer. No client-side fan-out is
 * ever constructed here: the service applies the full lineage atomically.
 */
export function buildGroupedApplyInput(
  decision: GroupedManualAnswerDecision,
): ApplyGroupedManualAnswerInput {
  return {
    decisionId: decision.id,
    requestIds: decision.lineage.map((entry) => entry.requestId),
    expectedRequestRevisions: Object.fromEntries(
      decision.lineage.map((entry) => [
        entry.requestId,
        entry.expectedRequestRevision,
      ]),
    ),
    answer: decision.answer,
  };
}

function buildGroupedSnoozeInput(
  decision: GroupedManualAnswerDecision,
  days: number,
): SnoozeGroupedDecisionInput {
  return {
    decisionId: decision.id,
    expectedRevision: decision.expectedRevision,
    until: new Date(Date.now() + days * snoozeDayMs).toISOString(),
    reason: null,
  };
}

function GroupedDecisionCard(props: {
  compact?: boolean;
  decision: GroupedManualAnswerDecision;
  isApplyPending: boolean;
  isSnoozePending: boolean;
  jobsById: ReadonlyMap<string, DiscoveryJob>;
  onApply: (input: ApplyGroupedManualAnswerInput) => void;
  onSnooze: (input: SnoozeGroupedDecisionInput) => void;
}) {
  const { compact = false, decision, jobsById } = props;
  const hasConflict = decision.conflict.status === "detected";
  const uniqueJobCount = new Set(decision.lineage.map((entry) => entry.jobId))
    .size;
  const jobLabel = (jobId: string) => {
    const job = jobsById.get(jobId);
    return job
      ? `${job.title} at ${job.company}`
      : `Application for job ${jobId}`;
  };
  const jobNoun = uniqueJobCount === 1 ? "job" : "jobs";
  const lineagePage = useBoundedCollection(decision.lineage, decision.id);
  const [showLineage, setShowLineage] = useState(false);
  const lineageIsLarge = decision.lineage.length > lineagePage.pageSize;

  return (
    <article
      aria-label={`Reusable answer ${decision.id}`}
      className="grid gap-4 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="status">Manual answer</Badge>
            <Badge variant="outline">Pending reuse</Badge>
            {hasConflict ? (
              <Badge variant="outline">Conflict detected</Badge>
            ) : null}
          </div>
          <h3 className="font-semibold text-(--text-headline)">
            {compact
              ? `Snoozed reusable answer for ${uniqueJobCount} ${jobNoun}`
              : `Reuse one answer across ${uniqueJobCount} ${jobNoun}`}
          </h3>
        </div>
      </div>

      <div className="rounded-md border border-border/70 bg-background/45 p-4">
        <p className="text-xs text-muted-foreground">Reusable answer</p>
        <p className="mt-1 min-w-0 wrap-anywhere whitespace-pre-wrap text-sm leading-6 text-foreground">
          {decision.answer.value}
        </p>
      </div>

      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">Scope</dt>
          <dd className="font-medium text-foreground">
            {decision.lineage.length} pending application question
            {decision.lineage.length === 1 ? "" : "s"} across {uniqueJobCount}{" "}
            {jobNoun}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="font-medium text-foreground">
            {formatDateOnly(decision.createdAt)}
          </dd>
        </div>
      </dl>

      {lineageIsLarge ? (
        <Button
          aria-expanded={showLineage}
          onClick={() => setShowLineage((shown) => !shown)}
          size="compact"
          type="button"
          variant="ghost"
        >
          {showLineage ? "Hide" : "Show"} application questions (
          {decision.lineage.length})
        </Button>
      ) : null}
      {!lineageIsLarge || showLineage ? (
        <>
          <ul
            aria-label="Application questions"
            className="grid gap-1 text-sm leading-6 text-foreground-soft"
          >
            {lineagePage.items.map((entry) => (
              <li
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0"
                key={entry.requestId}
              >
                <span className="font-medium text-foreground">
                  {jobLabel(entry.jobId)}
                </span>
                <span className="text-xs text-muted-foreground">
                  request {entry.requestId} · revision{" "}
                  {entry.expectedRequestRevision}
                </span>
              </li>
            ))}
          </ul>
          <BoundedCollectionPagination
            {...lineagePage}
            itemLabel={`application questions for ${decision.id}`}
          />
        </>
      ) : null}

      {hasConflict ? (
        <p
          className="rounded-md border border-(--warning-border) bg-(--warning-surface) px-3 py-2 text-xs leading-5 text-foreground-soft"
          role="status"
        >
          {decision.conflict.summary ??
            "A conflicting saved answer was detected for this question."}{" "}
          Approval stays disabled until the conflict is resolved. Resolve it in
          Profile, then return here to approve reuse.
        </p>
      ) : null}

      {!compact ? (
        <p className="rounded-md border border-border/60 bg-background/35 px-3 py-2 text-xs leading-5 text-muted-foreground">
          Approving fills only these pending application questions with the
          exact answer above. Job Finder cannot create an account or submit an
          application. Review and submit on the employer site yourself.
        </p>
      ) : null}

      <div
        aria-label={`Actions for reusable answer ${decision.id}`}
        className="flex flex-wrap gap-2"
        role="group"
      >
        <Button
          disabled={hasConflict}
          onClick={() => props.onApply(buildGroupedApplyInput(decision))}
          pending={props.isApplyPending}
          size="compact"
          type="button"
        >
          <Check aria-hidden="true" /> Approve &amp; reuse for {uniqueJobCount}{" "}
          {jobNoun}
        </Button>
        {!compact ? (
          <>
            <Button
              onClick={() =>
                props.onSnooze(buildGroupedSnoozeInput(decision, 1))
              }
              pending={props.isSnoozePending}
              size="compact"
              type="button"
              variant="secondary"
            >
              Snooze 1 day
            </Button>
            <Button
              onClick={() =>
                props.onSnooze(buildGroupedSnoozeInput(decision, 3))
              }
              pending={props.isSnoozePending}
              size="compact"
              type="button"
              variant="secondary"
            >
              Snooze 3 days
            </Button>
            <Button
              onClick={() =>
                props.onSnooze(buildGroupedSnoozeInput(decision, 7))
              }
              pending={props.isSnoozePending}
              size="compact"
              type="button"
              variant="secondary"
            >
              Snooze 7 days
            </Button>
          </>
        ) : null}
      </div>

      {decision.snooze ? (
        <p
          className="flex items-center gap-2 text-xs leading-5 text-muted-foreground"
          role="status"
        >
          <BellOff aria-hidden="true" className="size-3.5 shrink-0" />
          Snoozed until {formatDateOnly(decision.snooze.until)}
          {decision.snooze.reason ? ` · ${decision.snooze.reason}` : ""}.
        </p>
      ) : null}
    </article>
  );
}

/**
 * An application paused on a site step with no live browser-step request
 * behind it. It sits in the same Applications group as the live steps: the
 * distinction between the two is how the runtime recorded the pause, not
 * anything the person can act on differently.
 */
function AwaitingApplicationCard(props: {
  onNavigate: (path: string) => void;
  record: JobFinderRendererWorkspaceSnapshot["applicationRecords"][number];
}) {
  const { record } = props;
  const opensResumeStudio = getApplicationNextStepLabel(record)
    .toLowerCase()
    .includes("resume studio");
  return (
    <article className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) p-5">
      <div className="grid gap-1">
        <h3 className="font-semibold text-(--text-headline)">
          {stripScrapedGlyphs(record.title)}
        </h3>
        <p className="text-sm text-foreground-soft">
          {stripScrapedGlyphs(record.company)}
        </p>
        <p className="text-sm leading-6 text-foreground-soft">
          {stripScrapedGlyphs(getApplicationNextStepLabel(record))}
        </p>
      </div>
      <div>
        <Button
          onClick={() =>
            props.onNavigate(
              opensResumeStudio
                ? buildResumeWorkspaceRoute(record.jobId)
                : buildJobFinderContextRoute("/job-finder/applications", {
                    applicationRecordId: record.id,
                    jobId: record.jobId,
                    targetId: null,
                  }),
            )
          }
          size="compact"
          type="button"
          variant="secondary"
        >
          <ArrowUpRight aria-hidden="true" />{" "}
          {opensResumeStudio ? "Open resume" : "Open this application"}
        </Button>
      </div>
    </article>
  );
}

export function ActionsScreen(props: {
  safeguardPauses?: readonly PlanSafeguardPause[];
  applicationAttempts?: JobFinderRendererWorkspaceSnapshot["applicationAttempts"];
  applicationRecords?: JobFinderRendererWorkspaceSnapshot["applicationRecords"];
  applyJobResults?: JobFinderRendererWorkspaceSnapshot["applyJobResults"];
  discoveryJobs: JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
  groupedDecisions?: readonly GroupedManualAnswerDecision[];
  isGroupedApplyPending?: (decisionId: string) => boolean;
  isGroupedProjectPending?: (groupKey: string) => boolean;
  isGroupedSnoozePending?: (decisionId: string) => boolean;
  isPending: (requestId: string) => boolean;
  onApplyGroupedManualAnswer?: (input: ApplyGroupedManualAnswerInput) => void;
  /**
   * Returning a promise lets the question step wait for the bridge call and
   * say so when it is refused, instead of a click that records nothing.
   */
  onCommand: (command: UserActionCommandInput) => void | Promise<void>;
  onNavigate: (path: string) => void;
  onGetApplyRunDetails?: (
    query: JobFinderApplyRunDetailsQuery,
  ) => Promise<ApplyRunDetails>;
  onProjectGroupedManualAnswer?: (
    command: ProjectGroupedManualAnswerCommand,
  ) => void;
  onSnoozeGroupedDecision?: (input: SnoozeGroupedDecisionInput) => void;
  /** See ActionCard's onStartOver: cancel the lost check, prepare again. */
  onStartOver?: (
    request: UserActionRequest,
    cancel: UserActionCommandInput,
  ) => void | Promise<void>;
  profile?: CandidateProfile;
  requests: readonly UserActionRequest[];
  selectedRequestId?: string | null;
  selectedDecisionId?: string | null;
  selectedApplicationRecordId?: string | null;
}) {
  const { answerDrafts, restoredApplications, updateAnswerDraft } =
    useQuestionAnswerDrafts(props);
  const groupedDecisions = props.groupedDecisions ?? [];
  const pendingDecisions = groupedDecisions.filter(
    (decision) => decision.approval === "pending",
  );
  // Ordinary member cards stay hidden only while a persisted pending grouped
  // decision represents them, so the same question is never surfaced twice.
  const representedRequestIds = new Set(
    pendingDecisions.flatMap((decision) =>
      decision.lineage.map((entry) => entry.requestId),
    ),
  );
  const unresolved = listUnresolvedUserActions(props.requests).filter(
    (request) => !representedRequestIds.has(request.id),
  );
  // An application the Applications screen badges "Needs you" with no live
  // browser-step request behind it used to be invisible here, so this page
  // said "Nothing needs you right now" about work the other screen was
  // flagging. Both read the one selector.
  const applicationsAwaitingUser = useMemo(
    () =>
      listApplicationsAwaitingUser({
        applicationRecords: props.applicationRecords ?? [],
        applyJobResults: props.applyJobResults ?? [],
        requests: props.requests,
      }),
    [props.applicationRecords, props.applyJobResults, props.requests],
  );
  const view = usePersistedCollectionView("needs-you", "comfortable");
  const selectionKey =
    props.selectedRequestId ||
    props.selectedApplicationRecordId ||
    props.selectedDecisionId
      ? `${props.selectedRequestId ?? ""}:${props.selectedApplicationRecordId ?? ""}:${props.selectedDecisionId ?? ""}`
      : null;
  const lastSelection = useRef<string | null>(null);
  useEffect(() => {
    if (selectionKey && lastSelection.current !== selectionKey) {
      view.setQuery("");
    }
    lastSelection.current = selectionKey;
  }, [selectionKey, view.setQuery]);
  const deferredQuery = useDeferredValue(view.query);
  const jobsById = useMemo(
    () => buildJobIndexById(props.discoveryJobs),
    [props.discoveryJobs],
  );
  const visibleDecisions = pendingDecisions.filter(
    (decision) =>
      !deferredQuery.trim() ||
      matchesCollectionSearch(deferredQuery, [
        "manual answer",
        "reusable answer",
        decision.snooze ? "snoozed" : null,
        decision.id,
        decision.answer.value,
        ...decision.lineage.flatMap((entry) => {
          const job = jobsById.get(entry.jobId);
          return [
            entry.requestId,
            entry.applicationRecordId,
            entry.jobId,
            job?.title,
            job?.company,
          ];
        }),
      ]),
  );
  const activeDecisions = visibleDecisions.filter(
    (decision) => decision.snooze === null,
  );
  const snoozedDecisions = visibleDecisions.filter(
    (decision) => decision.snooze !== null,
  );
  const activePage = useBoundedCollection(
    activeDecisions,
    deferredQuery,
    activeDecisions.findIndex(
      (decision) => decision.id === props.selectedDecisionId,
    ),
    props.selectedDecisionId,
  );
  const snoozedPage = useBoundedCollection(
    snoozedDecisions,
    deferredQuery,
    snoozedDecisions.findIndex(
      (decision) => decision.id === props.selectedDecisionId,
    ),
    props.selectedDecisionId,
  );
  const visibleRequests = useMemo(
    () =>
      unresolved.filter((request) => {
        const applicationScope =
          request.scope.type === "application" ? request.scope : null;
        const job = applicationScope
          ? (jobsById.get(applicationScope.jobId) ?? null)
          : null;
        return matchesCollectionSearch(deferredQuery, [
          request.title,
          request.id,
          userActionKindPresentations[request.kind].label,
          request.scope.type,
          job?.title,
          job?.company,
          ...request.instructions,
        ]);
      }),
    [deferredQuery, jobsById, unresolved],
  );
  const visibleAwaitingRecords = useMemo(
    () =>
      applicationsAwaitingUser.filter((record) =>
        matchesCollectionSearch(deferredQuery, [
          record.title,
          record.id,
          record.company,
          "application",
          getApplicationNextStepLabel(record),
        ]),
      ),
    [applicationsAwaitingUser, deferredQuery],
  );
  const applicationItems = [
    ...visibleAwaitingRecords.map((record) => ({
      type: "record" as const,
      record,
    })),
    ...visibleRequests
      .filter((request) => request.scope.type === "application")
      .map((request) => ({ type: "request" as const, request })),
  ];
  const applicationPage = useBoundedCollection(
    applicationItems,
    deferredQuery,
    applicationItems.findIndex((item) =>
      item.type === "record"
        ? item.record.id === props.selectedApplicationRecordId
        : item.request.id === props.selectedRequestId,
    ),
    props.selectedRequestId ?? props.selectedApplicationRecordId,
  );
  const sourceRequests = visibleRequests.filter(
    (request) => request.scope.type === "discovery_source",
  );
  const sourcePage = useBoundedCollection(
    sourceRequests,
    deferredQuery,
    sourceRequests.findIndex(
      (request) => request.id === props.selectedRequestId,
    ),
    props.selectedRequestId,
  );
  const groups = [
    {
      id: "application" as const,
      title: "Applications",
      totalCount: applicationItems.length,
      page: applicationPage,
    },
    {
      id: "discovery_source" as const,
      title: "Job sources",
      totalCount: sourceRequests.length,
      page: sourcePage,
    },
  ];

  const hasPendingDecisionCards = pendingDecisions.length > 0;
  const totalCount =
    unresolved.length +
    applicationsAwaitingUser.length +
    pendingDecisions.length;
  const visibleCount =
    visibleRequests.length +
    visibleAwaitingRecords.length +
    visibleDecisions.length;

  return (
    <section className="grid gap-5 pb-8">
      <PageHeaderStack
        // Each card already carries the exact no-submit boundary for the
        // action it offers; the page header owns the credential boundary
        // only, so the promise is stated once per card instead of three
        // times on the same screen.
        description="Steps only you can do. Passwords and security codes stay with you."
        title="Needs you"
      />

      {/* A search field plus a "1 result" counter above a single card is
          dead chrome in the first viewport. Search appears once the list is
          long enough to need it, or while a query is already narrowing it. */}
      {totalCount >= ACTION_SEARCH_MIN_ITEMS || view.query.length > 0 ? (
        <CollectionSearchToolbar
          label="Find an action"
          onQueryChange={view.setQuery}
          placeholder="Search jobs, companies, sources, or action type"
          placement="page"
          query={view.query}
          totalCount={totalCount}
          visibleCount={visibleCount}
        />
      ) : null}

      <PlanSafeguardPauseCards
        pauses={props.safeguardPauses ?? []}
        onNavigate={props.onNavigate}
      />
      {activeDecisions.length > 0 ? (
        <section
          aria-labelledby="reusable-answers-heading"
          className="grid gap-3"
        >
          <div className="flex items-center gap-2">
            <h2
              className="font-semibold text-(--text-headline)"
              id="reusable-answers-heading"
            >
              Reusable answers
            </h2>
            <Badge variant="section">{activeDecisions.length}</Badge>
          </div>
          <div className="grid gap-3">
            {activePage.items.map((decision) => (
              <GroupedDecisionCard
                decision={decision}
                isApplyPending={
                  props.isGroupedApplyPending?.(decision.id) ?? false
                }
                isSnoozePending={
                  props.isGroupedSnoozePending?.(decision.id) ?? false
                }
                jobsById={jobsById}
                key={decision.id}
                onApply={(input) => props.onApplyGroupedManualAnswer?.(input)}
                onSnooze={(input) => props.onSnoozeGroupedDecision?.(input)}
              />
            ))}
          </div>
          <BoundedCollectionPagination
            {...activePage}
            itemLabel="reusable answers"
          />
        </section>
      ) : null}

      {snoozedDecisions.length > 0 ? (
        <section aria-labelledby="snoozed-heading" className="grid gap-3">
          <div className="flex items-center gap-2">
            <h2
              className="font-semibold text-(--text-headline)"
              id="snoozed-heading"
            >
              Snoozed
            </h2>
            <Badge variant="section">{snoozedDecisions.length}</Badge>
          </div>
          <div className="grid gap-3">
            {snoozedPage.items.map((decision) => (
              <GroupedDecisionCard
                compact
                decision={decision}
                isApplyPending={
                  props.isGroupedApplyPending?.(decision.id) ?? false
                }
                isSnoozePending={
                  props.isGroupedSnoozePending?.(decision.id) ?? false
                }
                jobsById={jobsById}
                key={decision.id}
                onApply={(input) => props.onApplyGroupedManualAnswer?.(input)}
                onSnooze={(input) => props.onSnoozeGroupedDecision?.(input)}
              />
            ))}
          </div>
          <BoundedCollectionPagination
            {...snoozedPage}
            itemLabel="snoozed reusable answers"
          />
        </section>
      ) : null}

      {unresolved.length === 0 &&
      !hasPendingDecisionCards &&
      applicationsAwaitingUser.length === 0 &&
      !props.safeguardPauses?.length ? (
        <div className="grid gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) p-5">
          <div className="grid gap-2" role="status">
            <h2 className="font-semibold text-(--text-headline)">
              Nothing needs you right now
            </h2>
            <p className="text-sm text-foreground-soft">
              Blocked sources and applications will appear here when a
              browser-only step needs your attention.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => props.onNavigate("/job-finder/discovery")}
              size="compact"
              type="button"
            >
              <ArrowUpRight aria-hidden="true" /> Find jobs
            </Button>
          </div>
        </div>
      ) : totalCount > 0 && visibleCount === 0 ? (
        <CollectionNoMatches
          noun="actions"
          onClear={() => view.setQuery("")}
          query={view.query}
        />
      ) : (
        <>
          {groups.map((group) => {
            const totalCount = group.totalCount;
            if (totalCount === 0) {
              return null;
            }
            const pageRequests =
              group.id === "application"
                ? applicationPage.items.flatMap((item) =>
                    item.type === "request" ? [item.request] : [],
                  )
                : sourcePage.items;
            const pageRecords =
              group.id === "application"
                ? applicationPage.items.flatMap((item) =>
                    item.type === "record" ? [item.record] : [],
                  )
                : [];
            const shownCount = pageRequests.length + pageRecords.length;
            return (
              <section
                className="grid gap-3"
                key={group.id}
                aria-labelledby={`action-group-${group.id}`}
              >
                <div className="flex items-center gap-2">
                  <h2
                    className="font-semibold text-(--text-headline)"
                    id={`action-group-${group.id}`}
                  >
                    {group.title}
                  </h2>
                  {/* Canonical count across every matching action, independent
                  of the mounted page window. */}
                  <Badge variant="section">{totalCount}</Badge>
                </div>
                {shownCount === 0 ? (
                  <p className="text-sm leading-6 text-foreground-soft">
                    All {totalCount} on another page.
                  </p>
                ) : (
                  <>
                    {shownCount < totalCount ? (
                      <p className="text-sm leading-6 text-foreground-soft">
                        Showing {shownCount} of {totalCount} on this page.
                      </p>
                    ) : null}
                    <div className="grid gap-3">
                      {pageRecords.map((record) => (
                        <AwaitingApplicationCard
                          key={record.id}
                          onNavigate={props.onNavigate}
                          record={record}
                        />
                      ))}
                      {pageRequests.map((request) => {
                        const applicationScope =
                          request.scope.type === "application"
                            ? request.scope
                            : null;
                        const job = applicationScope
                          ? (jobsById.get(applicationScope.jobId) ?? null)
                          : null;
                        // One selector, shared with Applications, so the
                        // two screens can never disagree about how many
                        // questions are pending for this application.
                        const questions = applicationScope
                          ? listPendingApplicationQuestions({
                              applicationAttempts:
                                props.applicationAttempts ?? [],
                              applicationRecordId:
                                applicationScope.applicationRecordId,
                              jobId: applicationScope.jobId,
                            })
                          : [];
                        const draftKey = request.id;
                        const answerDraft = answerDrafts.current.get(draftKey);
                        return (
                          <ActionCard
                            isGroupedProjectPending={
                              props.isGroupedProjectPending ?? (() => false)
                            }
                            isPending={props.isPending(request.id)}
                            {...(answerDraft ? { answerDraft } : {})}
                            onAnswerDraftChange={(draft) => {
                              return updateAnswerDraft(request, draft);
                            }}
                            jobLocation={job?.location}
                            jobLabel={
                              job ? `${job.title} at ${job.company}` : null
                            }
                            key={`${draftKey}-${request.kind}-${restoredApplications.has(draftKey) ? "restored" : "current"}`}
                            onCommand={props.onCommand}
                            {...(props.onStartOver
                              ? {
                                  onStartOver: (
                                    cancel: UserActionCommandInput,
                                  ) => props.onStartOver?.(request, cancel),
                                }
                              : {})}
                            onProjectGroupedManualAnswer={
                              props.onProjectGroupedManualAnswer ??
                              (() => undefined)
                            }
                            profile={props.profile ?? null}
                            questions={questions}
                            onOpenScope={() =>
                              props.onNavigate(
                                getUserActionContextRoute(
                                  request,
                                  props.applicationRecords,
                                ),
                              )
                            }
                            sameSiteApplicationActive={
                              job
                                ? isSameSiteApplicationActive(
                                    job,
                                    props.applyJobResults ?? [],
                                    jobsById,
                                  )
                                : false
                            }
                            onOpenFiles={() =>
                              // Every kind the form asks for; Files starts on
                              // the first one the person has no file of yet.
                              props.onNavigate(
                                profileFilesHref(
                                  questions
                                    .filter(
                                      (question) =>
                                        question.answerControlType === "file" &&
                                        question.kind !== "resume",
                                    )
                                    .map(inferFileKindForQuestion),
                                ),
                              )
                            }
                            request={request}
                          />
                        );
                      })}
                    </div>
                  </>
                )}
                <BoundedCollectionPagination
                  {...group.page}
                  itemLabel={
                    group.id === "application"
                      ? "application actions"
                      : "job source actions"
                  }
                />
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}

/**
 * Every question the form still needs, and one way to answer them.
 *
 * This replaced an "ANSWER MEMORY" panel with four competing buttons ("Use
 * once", "Save for future & use", "Reuse for matching applications", "Reset
 * draft"), a no-reusable-match report and a paragraph about when the service
 * groups drafts — none of which was even in the accessibility tree. One
 * labelled control per question, one checkbox, one button, and the same
 * bridge call the old "Use once" made, which already records the answer and
 * runs the retry that fills it in.
 */
export type QuestionAnswerDraft = {
  answers: Record<string, string | string[]>;
  saveForFuture: boolean;
  hiringCountry?: string | undefined;
};

export function QuestionAnswerForm(props: {
  jobLocation?: string | undefined;
  draft?: QuestionAnswerDraft;
  onDraftChange?: (draft: QuestionAnswerDraft) => void | Promise<void>;
  isPending: boolean;
  onAnswer: (
    answers: readonly { questionId: string; answer: string }[],
    saveForFuture: boolean,
    hiringCountry?: string,
  ) => void | Promise<void>;
  questions: readonly ApplicationAttemptQuestion[];
  requestId: string;
}) {
  const { isPending, onAnswer, questions, requestId } = props;
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(
    () => props.draft?.answers ?? {},
  );
  const [saveForFuture, setSaveForFuture] = useState(
    () =>
      props.draft?.saveForFuture ??
      !questions.some((question) =>
        /neither.*(?:country|region)|ambiguous|does not (?:identify|name).*country/iu.test(
          question.note ?? "",
        ),
      ),
  );
  const needsCountry = questions.some(
    (question) =>
      question.kind === "work_authorization" ||
      question.kind === "visa_sponsorship",
  );
  const [hiringCountry, setHiringCountry] = useState(
    props.draft?.hiringCountry ?? "",
  );
  const { onDraftChange } = props;
  const lastDraft = useRef(
    JSON.stringify({
      answers,
      saveForFuture,
      ...(needsCountry ? { hiringCountry } : {}),
    }),
  );
  const incomingDraft = JSON.stringify(props.draft);
  const skipDraftSave = useRef(false);
  useEffect(() => {
    if (!props.draft) return;
    setAnswers(props.draft.answers);
    setSaveForFuture(props.draft.saveForFuture);
    setHiringCountry(props.draft.hiringCountry ?? "");
    lastDraft.current = JSON.stringify({
      answers: props.draft.answers,
      saveForFuture: props.draft.saveForFuture,
      ...(needsCountry
        ? { hiringCountry: props.draft.hiringCountry ?? "" }
        : {}),
    });
    skipDraftSave.current = true;
    // Only a changed saved value refreshes the form.
  }, [incomingDraft]);
  useEffect(() => {
    if (skipDraftSave.current) {
      skipDraftSave.current = false;
      return;
    }
    const draft = {
      answers,
      saveForFuture,
      ...(needsCountry ? { hiringCountry } : {}),
    };
    const serialized = JSON.stringify(draft);
    if (serialized === lastDraft.current) return;
    lastDraft.current = serialized;
    void Promise.resolve(onDraftChange?.(draft)).catch(() => {
      setFailure(
        "Your unfinished answer could not be saved. Keep this form open and try again.",
      );
    });
  }, [answers, saveForFuture, hiringCountry, needsCountry, onDraftChange]);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const saveId = `${requestId}-save-answer`;
  const draftKeyFor = (question: ApplicationAttemptQuestion) =>
    questions.filter((entry) => entry.prompt === question.prompt).length > 1
      ? question.id
      : question.prompt;
  const readAnswer = (questionId: string) => {
    const question = questions.find((entry) => entry.id === questionId);
    const value = question
      ? (answers[draftKeyFor(question)] ?? question.submittedAnswer ?? "")
      : "";
    return Array.isArray(value)
      ? value.length
        ? JSON.stringify(value)
        : ""
      : value;
  };
  const missingRequired =
    (needsCountry && !hiringCountry.trim()) ||
    questions.some(
      (question) =>
        question.isRequired !== false && !readAnswer(question.id).trim(),
    );
  const isSingle = questions.length === 1;

  return (
    <form
      className="grid min-w-0 gap-4"
      data-testid="needs-you-question-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          missingRequired ||
          isPending ||
          working ||
          !event.currentTarget.reportValidity()
        ) {
          return;
        }
        setFailure(null);
        setWorking(true);
        void Promise.resolve(
          onAnswer(
            // An optional question the person left blank is left blank on the
            // form too; there is nothing to record for it.
            questions
              .map((question) => ({
                questionId: question.id,
                answer: readAnswer(question.id).trim(),
              }))
              .filter((entry) => entry.answer.length > 0),
            saveForFuture,
            ...(needsCountry ? ([hiringCountry.trim()] as const) : []),
          ),
        ).then(
          () => {
            setWorking(false);
          },
          (error: unknown) => {
            // The typed answers stay exactly where they are; a refused save
            // that silently recorded nothing is the whole defect here.
            setWorking(false);
            setFailure(
              describeFailure(error, {
                action: "save that answer",
                unknownSentence:
                  "Job Finder could not save that answer; try again.",
              }).sentence,
            );
          },
        );
      }}
    >
      {needsCountry ? (
        <div className="grid gap-2">
          <p className="text-(length:--text-small) text-foreground-soft">
            Application location: {props.jobLocation?.trim() || "not specified"}
            . Answer for the country that would hire you. Saved answers are used
            again only for jobs in the same country and permit conditions.
          </p>
          <label
            className="grid gap-1 text-sm"
            htmlFor={`${requestId}-hiring-country`}
          >
            Which country would hire you for this job?
            <Input
              id={`${requestId}-hiring-country`}
              value={hiringCountry}
              maxLength={120}
              required
              onChange={(event) => setHiringCountry(event.target.value)}
            />
          </label>
          <p className="text-xs text-foreground-soft">
            Confirm with the employer if it is unclear. Your answers below are
            your decision for that country, the job's hours and dates.
          </p>
        </div>
      ) : null}
      {questions.map((question) => {
        const answerId = `${requestId}-answer-${question.id}`;
        const label = formatQuestionPrompt(question.prompt);
        const description = question.description?.trim();
        // The site's own words about this field, when it has any. A
        // description that is the label again, or the "nothing on file
        // answers this" sentence already printed once at the top, is not one.
        const showDescription =
          description &&
          description.toLowerCase() !== label.toLowerCase() &&
          !/nothing in your profile, resume, or saved answers/i.test(
            description,
          );
        const options = question.answerOptions ?? [];

        return (
          <div className="grid min-w-0 gap-1.5" key={question.id}>
            {question.answerControlType === "multi_choice" ? null : (
              <label
                className="text-sm font-medium leading-6 text-foreground"
                data-testid="needs-you-question-text"
                htmlFor={answerId}
              >
                {/* Only the ones the site actually marks required hold the
                  button back, so the ones it does not are said to be
                  optional rather than looking like a missed step. */}
                {question.isRequired === false ? `${label} (optional)` : label}
              </label>
            )}
            {showDescription ? (
              <p className="text-(length:--text-small) leading-5 text-foreground-soft">
                {stripScrapedGlyphs(description)}
              </p>
            ) : null}
            {question.note ? (
              <p
                className="text-(length:--text-small) leading-5 text-(--warning-text)"
                data-testid="needs-you-question-note"
              >
                {question.note}
              </p>
            ) : null}
            {(question.suggestedAnswers ?? [])
              .filter(
                (suggestion) =>
                  suggestion.sourceKind === "prior_answer" &&
                  suggestion.sourceId?.startsWith("review."),
              )
              .map((suggestion) => (
                <div key={suggestion.id} className="grid gap-2">
                  <p className="text-sm">
                    Suggested wording — review it before continuing:
                  </p>
                  <p className="whitespace-pre-wrap text-sm">
                    {suggestion.text}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setAnswers((current) => ({
                        ...current,
                        [draftKeyFor(question)]: suggestion.text,
                      }))
                    }
                  >
                    Use this wording
                  </Button>
                </div>
              ))}
            {question.answerControlType === "multi_choice" &&
            options.length > 0 ? (
              <fieldset className="grid gap-2">
                <legend
                  className="mb-1.5 text-sm font-medium leading-6 text-foreground"
                  data-testid="needs-you-question-text"
                >
                  {question.isRequired === false
                    ? `${label} (optional)`
                    : label}
                </legend>
                {options.map((option) => {
                  const stored = answers[draftKeyFor(question)];
                  const selected = Array.isArray(stored) ? stored : [];

                  return (
                    <label
                      key={option}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="size-4 shrink-0 accent-(--primary)"
                        checked={selected.includes(option)}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            [draftKeyFor(question)]: event.target.checked
                              ? [...selected, option]
                              : selected.filter((value) => value !== option),
                          }))
                        }
                      />
                      {option}
                    </label>
                  );
                })}
              </fieldset>
            ) : options.length > 0 ? (
              <select
                className="h-10 min-w-0 rounded-(--radius-small) border border-(--control-border) bg-background px-3 text-sm text-foreground"
                id={answerId}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [draftKeyFor(question)]: event.target.value,
                  }))
                }
                value={readAnswer(question.id)}
              >
                <option value="">Choose an answer</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : question.answerControlType === "boolean" ? (
              // A box on the form (a consent or declaration) is a box here
              // too, not a text field asking the person to type "Yes".
              <label className="flex items-start gap-2 text-sm leading-6 text-foreground">
                <input
                  checked={readAnswer(question.id) === "Yes"}
                  className="mt-1 size-4 shrink-0 accent-(--primary)"
                  data-testid="needs-you-question-checkbox"
                  id={answerId}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [draftKeyFor(question)]: event.target.checked
                        ? "Yes"
                        : "",
                    }))
                  }
                  type="checkbox"
                />
                Tick this box on the form
              </label>
            ) : question.inputConstraints ||
              question.answerControlType === "date" ? (
              <div className="grid gap-1">
                <input
                  className="h-10 w-full max-w-xs rounded-(--radius-small) border border-(--control-border) bg-background px-3 text-sm"
                  id={answerId}
                  type={question.inputConstraints?.type ?? "date"}
                  min={question.inputConstraints?.min}
                  max={question.inputConstraints?.max}
                  step={question.inputConstraints?.step}
                  required={question.isRequired !== false}
                  value={readAnswer(question.id)}
                  onChange={(event) =>
                    setAnswers((current) => ({
                      ...current,
                      [draftKeyFor(question)]: event.target.value,
                    }))
                  }
                />
                {question.inputConstraints?.type === "month" ? (
                  <p className="text-xs text-muted-foreground">
                    Choose the month and year.
                  </p>
                ) : null}
              </div>
            ) : (
              <Textarea
                id={answerId}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [draftKeyFor(question)]: event.target.value,
                  }))
                }
                rows={3}
                value={readAnswer(question.id)}
              />
            )}
          </div>
        );
      })}
      <label className="flex items-start gap-2 text-(length:--text-small) leading-6 text-foreground-soft">
        <input
          checked={saveForFuture}
          className="mt-1 size-4 shrink-0 accent-(--primary)"
          id={saveId}
          onChange={(event) => setSaveForFuture(event.target.checked)}
          type="checkbox"
        />
        {isSingle
          ? "Save this answer for next time"
          : "Save these answers for next time"}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={missingRequired || isPending || working}
          pending={working}
          size="compact"
          type="submit"
        >
          Answer and continue
        </Button>
        {working ? (
          <p
            aria-live="polite"
            className="text-(length:--text-small) leading-6 text-foreground-soft"
            role="status"
          >
            Job Finder is filling it in…
          </p>
        ) : null}
      </div>
      {failure ? (
        <p
          className="text-(length:--text-small) leading-6 text-(--warning-text)"
          data-testid="needs-you-answer-failure"
          role="alert"
        >
          {failure}
        </p>
      ) : null}
    </form>
  );
}
