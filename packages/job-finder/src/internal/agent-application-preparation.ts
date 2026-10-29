import { browserAgentPermissionsOf } from "@nestor/contracts";
import {
  checkWrittenApplicationAnswer,
  applicationFacts,
  createApplyPageHands,
  createMoveReviewer,
  runApplyAgent,
  type ApplyAgentResult,
  type ApplyAuthority,
  type ApplyDocument,
  type LLMClient,
} from "@nestor/browser-agent";
import {
  buildPreparationResult,
  loadVerifiedResumeBytes,
  type ExecuteApplicationFlowInput,
} from "@nestor/browser-runtime";

/** The application facts, without the callback that is about to use them. */
export type ApplyPreparationInput = Omit<
  ExecuteApplicationFlowInput,
  "prepareApplicationForm"
>;
import {
  ApplicationLetterGroundingError,
  createApplicationLetterProvider,
} from "./application-letter-provider";
import {
  decideApplySubmissionHandoff,
  type ApplySubmissionHandoff,
} from "./apply-submission-handoff";
import type {
  JobFinderDocumentManager,
  RenderedLetterArtifact,
} from "./workspace-service-contracts";
import type { ApplicationLetterDependencies } from "./application-letter-provider";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  type ApplyAgentTiming,
  AiBehaviorPreferenceSchema,
  ApplicationReviewCardSchema,
  CoverLetterPreferenceSchema,
} from "@nestor/contracts";
import type {
  ApplicationAuthorityEnvelope,
  ApplyPageSession,
  ApplicationAttemptBlocker,
  ApplicationAttemptCheckpoint,
  ApplicationAttemptExternalWriteEvidence,
  ApplicationAttemptQuestion,
  ApplyExecutionModelUse,
  ApplyExecutionResult,
  ApplicationReviewCard,
  CandidateProfile,
  CandidateReusableAnswer,
  JobFinderSettings,
  JobSearchPreferences,
  SavedJob,
} from "@nestor/contracts";
/**
 * Runs one application through the agent loop and reports it the way the rest
 * of the product already expects.
 *
 * Workflow decisions live in `browser-agent` and browser mechanics live in
 * `browser-runtime`; this is the seam Job Finder owns between them. It
 * verifies the resume bytes, installs the guard that stops a prepare-only run
 * from transmitting anything, hands the agent a page, and turns what comes
 * back into the application record that gets persisted.
 */

export interface AgentApplicationPreparationInput {
  /**
   * The open application page, with its safety mechanics. Playwright's `Page`
   * never crosses this boundary: the browser layer keeps it.
   */
  session: ApplyPageSession;
  /** The runtime's live URL for this exact bound page. */
  currentUrl?: string;
  /** The saved permission this run works inside, when there is one. */
  envelope?: ApplicationAuthorityEnvelope | null;
  executionInput: ApplyPreparationInput;
  applicationRecordId?: string;
  searchPreferences?: JobSearchPreferences | undefined;
  llmClient: LLMClient;
  questionReadCacheScope?: object;
  initialQuestionContexts?: Parameters<
    typeof runApplyAgent
  >[0]["initialQuestionContexts"];
  initialPickerAttempts?: Parameters<
    typeof runApplyAgent
  >[0]["initialPickerAttempts"];
  initialUnansweredPickerQuestions?: Parameters<
    typeof runApplyAgent
  >[0]["initialUnansweredPickerQuestions"];
  startedAt: string;
  /** What the person would call this site. */
  siteLabel: string;
  /** Who the model is, for the privacy receipt: "OpenCode Go", "muse-spark-1.3". */
  providerLabel?: string | null;
  modelLabel?: string | null;
  onProgress?: Parameters<typeof runApplyAgent>[0]["onProgress"];
  readReusableAnswers?: Parameters<
    typeof runApplyAgent
  >[0]["readReusableAnswers"];
  reusableAnswers?: CandidateReusableAnswer[];
  uploadsConfirmedByPerson?: readonly string[];
  earlierAttachments?: Parameters<
    typeof runApplyAgent
  >[0]["earlierAttachments"];
  /** What an earlier run left on this form, to bring a closed page back. */
  replay?: Parameters<typeof runApplyAgent>[0]["replay"];
  /**
   * Writes and renders the letter this application sends. Omitted when the
   * caller has no way to produce one, in which case a form that asks for a
   * letter pauses for the person.
   */
  letters?: Omit<ApplicationLetterDependencies, "application" | "signal">;
  /**
   * Told what the finished form amounts to, so the run loop can hand it to the
   * submission path without re-deriving it from the persisted record.
   */
  onPrepared?: (outcome: {
    result: ApplyAgentResult;
    handoff: ApplySubmissionHandoff;
    reviewCard: ApplicationReviewCard;
  }) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

function toApplyAuthority(
  executionInput: ApplyPreparationInput,
): ApplyAuthority {
  const submitAuthorized = executionInput.submitAuthorized === true;
  const mode =
    executionInput.applyAutomationMode ??
    (executionInput.mode === "submit_when_ready" && submitAuthorized
      ? "autonomous_submit"
      : "prepare_only");
  return {
    mode,
    // Confirm-first works the form all the way to its send button but is never
    // itself allowed to press it.
    submitAuthorized: mode === "autonomous_submit" && submitAuthorized,
    // The saved permission's list plus the routine declarations the person
    // allows in Settings (ADR 0027). Without the second, every "I certify"
    // box stopped the run, because nothing in the product ever wrote the
    // first.
    preApprovedAttestationKinds: [
      ...new Set([
        ...(executionInput.preApprovedAttestationKinds ?? []),
        ...AiBehaviorPreferenceSchema.parse(
          executionInput.settings.aiBehavior ?? {},
        ).applying.preApprovedDeclarations,
      ]),
    ],
    salaryDisclosure: executionInput.salaryDisclosure ?? "pause_for_user",
    allowedOrigins: executionInput.applyAllowedOrigins ?? [],
  };
}

export function resolveApplicationDocumentMimeType(fileName: string): string {
  const extension = fileName.trim().toLowerCase().split(".").at(-1);
  switch (extension) {
    case "pdf":
      return "application/pdf";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "txt":
      return "text/plain";
    case "rtf":
      return "application/rtf";
    case "odt":
      return "application/vnd.oasis.opendocument.text";
    default:
      return "application/octet-stream";
  }
}

export function toApplyDocuments(
  executionInput: ApplyPreparationInput,
): ApplyDocument[] {
  const resume: ApplyDocument = {
    id: `document_resume_${executionInput.resumeArtifact.id}`,
    fileName: executionInput.resumeArtifact.fileName,
    mimeType: resolveApplicationDocumentMimeType(
      executionInput.resumeArtifact.fileName,
    ),
    label: "Your CV",
    kind: "resume",
    loadBytes: () => loadVerifiedResumeBytes(executionInput.resumeArtifact),
  };

  // The person's own files keep their kind. Every one of them used to arrive
  // as "other", so a cover letter added under Profile › Files was never
  // "already available" to the agent, and it wrote a fresh letter beside the
  // one the person had chosen.
  const attachments = (executionInput.applicationAttachments ?? []).map(
    (attachment): ApplyDocument => ({
      id: `document_asset_${attachment.assetId}`,
      fileName: attachment.fileName,
      mimeType: attachment.mime,
      label: attachment.prompt,
      kind:
        attachment.assetKind ??
        (attachment.questionKind === "cover_letter"
          ? "cover_letter"
          : attachment.questionKind === "resume"
            ? "resume"
            : attachment.questionKind === "portfolio"
              ? "portfolio"
              : "other"),
      loadBytes: () => attachment.loadVerifiedBytes(),
    }),
  );

  return [resume, ...attachments];
}

/**
 * The record only carries the blocker codes the product already acts on.
 * Anything a person has to handle themselves lands on manual review; the plain
 * sentence saying which one it was travels in `summary` and `detail`.
 */
const BLOCKER_CODES: Record<
  NonNullable<ApplyAgentResult["pauses"][number]["blocker"]>["code"],
  ApplicationAttemptBlocker["code"]
> = {
  site_login_required: "site_login_required",
  account_creation_required: "requires_manual_review",
  security_challenge: "requires_manual_review",
  multi_factor_required: "requires_manual_review",
  application_closed: "application_closed",
  application_page_unreachable: "application_page_unreachable",
  site_saves_as_you_go: "site_saves_as_you_go",
  browser_blocked: "browser_blocked",
};

/**
 * Every question the run handed back, in page order and without repeats.
 *
 * A pause carries all of them now; the single `question` is still read for a
 * pause built before that.
 */
function toQuestions(result: ApplyAgentResult): ApplicationAttemptQuestion[] {
  const byId = new Map<string, ApplicationAttemptQuestion>();
  for (const pause of result.pauses) {
    const questions =
      pause.questions && pause.questions.length > 0
        ? pause.questions
        : pause.question
          ? [pause.question]
          : [];
    for (const question of questions) {
      if (!byId.has(question.id)) {
        byId.set(question.id, question);
      }
    }
  }
  return [...byId.values()];
}

function toBlocker(
  result: ApplyAgentResult,
  questions: readonly ApplicationAttemptQuestion[],
): ApplicationAttemptBlocker | null {
  const blocked = result.pauses.find((pause) => pause.blocker !== null);
  if (blocked?.blocker) {
    return {
      code: BLOCKER_CODES[blocked.blocker.code],
      userActionKind:
        blocked.blocker.code === "security_challenge" &&
        blocked.blocker.requiresPerson === true
          ? "captcha"
          : null,
      // The agent's own sentence is the report the person acts on. Keep the
      // page-derived blocker detail as supporting evidence, but do not replace
      // the agent's explanation with a generic wrapper.
      summary: result.reason,
      detail: blocked.blocker.detail,
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      // The page it actually happened on, so opening it lands where the person
      // has to act rather than back on the listing. When the next action is
      // about one site — allowing it to save as you go — that site wins.
      url: blocked.blocker.host
        ? `https://${blocked.blocker.host}`
        : result.finalUrl,
    };
  }
  if (questions.length > 0) {
    return {
      code: "missing_candidate_answer",
      userActionKind: questions.every(
        (question) => question.answerControlType === "file",
      )
        ? "manual_upload"
        : null,
      summary: result.reason,
      detail: result.reason,
      questionIds: questions.map((question) => question.id),
      sourceDebugEvidenceRefIds: [],
      url: result.finalUrl,
    };
  }
  if (result.outcome === "paused") {
    return {
      code: "requires_manual_review",
      userActionKind: "other",
      summary: result.reason,
      detail: result.reason,
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      url: result.finalUrl,
    };
  }
  // A run that said it was stuck never reached the end of the form. Without a
  // blocker it read as "Ready to send" beside its own sentence saying the
  // form could not be reached; the record now says it could not apply and
  // offers another go.
  if (result.outcome === "stuck") {
    return {
      code: "requires_manual_review",
      userActionKind: null,
      summary: result.reason,
      detail: result.reason,
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      url: result.finalUrl,
    };
  }
  return null;
}

function toCheckpoints(
  result: ApplyAgentResult,
  jobId: string,
  startedAt: string,
): ApplicationAttemptCheckpoint[] {
  // Each line is stamped with the moment it was written, not with the run's
  // start: a trail where every step happened "at 19:41" is no trail.
  const lines =
    result.timeline.length > 0
      ? result.timeline
      : result.notes.map((text) => ({ at: startedAt, text }));
  return lines.slice(0, 40).map((line, index) => ({
    id: `checkpoint_${jobId}_agent_${index + 1}`,
    at: line.at,
    label: "Working through the form",
    detail: line.text,
    state: "in_progress" as const,
    visualEvidence: [],
  }));
}

/** What the run wrote on the site, for the receipt: each field, each file. */
function toExternalWrites(
  result: ApplyAgentResult,
): ApplicationAttemptExternalWriteEvidence[] {
  return [
    ...result.filled.map((entry) => ({
      category:
        entry.questionKind === "personal_info"
          ? ("profile_field" as const)
          : ("application_answer" as const),
      fieldLabel: entry.label,
      occurredAt: entry.at,
      verified: false,
    })),
    ...result.attachments.map((entry) => ({
      category: "resume_attachment" as const,
      fieldLabel: entry.controlLabel,
      occurredAt: entry.at,
      verified: false,
    })),
  ];
}

/** The model this run talked to, for the receipt. Empty only when it never did. */
function toModelUse(
  result: ApplyAgentResult,
  input: Pick<AgentApplicationPreparationInput, "providerLabel" | "modelLabel">,
  startedAt: string,
): ApplyExecutionModelUse[] {
  if (result.modelTurns === 0) {
    return [];
  }
  return [
    {
      purpose: "application_answering",
      providerLabel: input.providerLabel?.trim() || "Job Finder's assistant",
      modelLabel: input.modelLabel?.trim() || null,
      occurredAt: startedAt,
      turns: result.modelTurns,
    },
  ];
}

function nextActionFor(result: ApplyAgentResult): string {
  const blocked = result.pauses.find((pause) => pause.blocker !== null);
  if (blocked?.blocker) {
    if (blocked.blocker.code === "application_closed")
      return "Find another job";
    return blocked.blocker.nextActionLabel;
  }
  const questions = toQuestions(result);
  const files = questions.filter(
    (question) => question.answerControlType === "file",
  );
  if (files.length === questions.length && files.length > 0) {
    return files.length === 1
      ? `Add the required ${files[0]!.prompt
          .split(" — ")
          .at(-1)!
          .replace(/[\s*:]+$/u, "")
          .replace(/\s+upload$/iu, "")
          .toLowerCase()}`
      : "Add the required files";
  }
  if (files.length > 0)
    return "Add the required files and answer the remaining questions";
  if (questions.length > 0) return "Answer the form's questions and continue";
  if (result.outcome === "stuck") {
    return "Try again, or open the listing and apply on the site";
  }
  return result.outcome === "awaiting_your_review"
    ? "Review it and send it"
    : "Open the application and finish it";
}

function summaryFor(result: ApplyAgentResult): string {
  return (
    result.reason.trim() ||
    "Job Finder stopped before finishing this application."
  );
}

/**
 * Runs the apply loop and turns a thrown error into an answer.
 *
 * Anything can throw: a page read, a schema that refuses a value, a browser
 * that went away. When it does, this run still has to end as something the
 * person can see, or they are left with a record that says it is running, a
 * button that does nothing, and no way back.
 */
async function runApplyAgentSafely(
  input: AgentApplicationPreparationInput,
  config: Parameters<typeof runApplyAgent>[0],
): Promise<
  | { ok: true; result: ApplyAgentResult }
  | { ok: false; detail: string; timing?: ApplyAgentTiming }
> {
  let timing: ApplyAgentTiming | undefined;
  try {
    return {
      ok: true,
      result: await runApplyAgent(
        {
          ...config,
          onTiming: (value) => {
            timing = value;
          },
        },
        input.llmClient,
      ),
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.message.trim()
        ? error.message.trim().replace(/\.?$/u, ".")
        : "Something went wrong while it was working through the form.";
    return {
      ok: false,
      ...(timing ? { timing } : {}),
      detail: `Job Finder hit a problem on ${input.siteLabel} it could not work around. ${reason} Nothing was sent, and anything it filled in is still on the page.`,
    };
  }
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

export function resolveApplicationPreparationTarget(input: {
  executionInput: ApplyPreparationInput;
  currentUrl?: string;
}): { targetUrl: string; isContinuation: boolean } {
  const configuredUrl =
    input.executionInput.job.applicationUrl ??
    input.executionInput.job.canonicalUrl;
  const isContinuation = Boolean(input.executionInput.startingUrl?.trim());
  const permittedOrigins = new Set(
    [
      originOf(configuredUrl),
      ...(input.executionInput.applyAllowedOrigins ?? []).map(originOf),
    ].filter((origin): origin is string => origin !== null),
  );
  const currentUrl = input.currentUrl?.trim() ?? "";
  const currentOrigin = originOf(currentUrl);

  // The browser runtime owns the exact Page binding. Its live URL, observed
  // after an authorized sign-in or other setup, is newer than the persisted
  // checkpoint and listing URLs. Only trust it inside this application's
  // already-authorized origins.
  if (currentOrigin && permittedOrigins.has(currentOrigin)) {
    return { targetUrl: currentUrl, isContinuation };
  }

  const persistedStart = input.executionInput.startingUrl?.trim();
  return {
    targetUrl:
      persistedStart && originOf(persistedStart)
        ? persistedStart
        : configuredUrl,
    isContinuation,
  };
}

export async function runAgentApplicationPreparation(
  input: AgentApplicationPreparationInput,
): Promise<ApplyExecutionResult> {
  const { executionInput, startedAt } = input;
  const now = input.now ?? (() => new Date());
  const fieldSaveOrigins = [
    ...(executionInput.intermediateMutationAllowedOrigins ??
      executionInput.applyAllowedOrigins ??
      []),
  ];

  // Install the fence before any field is touched. Attachment uploads have a
  // separate file-bound grant. Non-final field saves stay on the form frame's
  // own origin; a saved envelope may narrow that permission.
  await input.session.installPrepareOnlyGuard({
    ...(executionInput.attachmentUploadsAuthorized === true
      ? { attachmentUploadsAuthorized: true }
      : {}),
    intermediateMutationsAuthorized:
      executionInput.intermediateMutationsAuthorized === true,
    allowedOrigins: fieldSaveOrigins,
  });

  const { targetUrl, isContinuation } =
    resolveApplicationPreparationTarget(input);
  const authority = toApplyAuthority(executionInput);
  const allowedOrigins = [...authority.allowedOrigins];
  const activeAuthority: ApplyAuthority = {
    ...authority,
    allowedOrigins,
  };
  let activeEnvelope = input.envelope ?? null;
  const recheckWriteAuthority = async (purpose: "answers" | "attachment") => {
    if (executionInput.recheckIntermediateMutationAuthority) {
      const page = await input.session.readPage();
      const origin = page.url ? originOf(page.url) : null;
      if (
        !origin ||
        !(await executionInput.recheckIntermediateMutationAuthority(
          origin,
          purpose,
        ))
      )
        throw new Error(
          "The application's permission to persist this value changed.",
        );
      await input.session.installPrepareOnlyGuard({
        intermediateMutationsAuthorized:
          executionInput.intermediateMutationsAuthorized === true,
        ...(executionInput.attachmentUploadsAuthorized === true
          ? { attachmentUploadsAuthorized: true }
          : {}),
        allowedOrigins: fieldSaveOrigins,
      });
    }
  };
  const hands = createApplyPageHands(input.session, now);
  const uploadFile = hands.uploadFile;
  hands.uploadFile = async (ref, file) => {
    await recheckWriteAuthority("attachment");
    return uploadFile(ref, file);
  };
  const moveReviewer = createMoveReviewer({
    browserPermissions: browserAgentPermissionsOf(executionInput.settings),
    ...(executionInput.prepareBrowserCredentials ? { prepareBrowserCredentials: executionInput.prepareBrowserCredentials } : {}),
    llmClient: input.llmClient,
    goal: isContinuation
      ? `Continue the ${executionInput.job.title} application at ${executionInput.job.company} on the currently open retained page at ${targetUrl}. Confirm that the open page is still this employer's application. Keep working on that current form; do not return to the listing or reload it. Nothing is sent.`
      : `Apply for ${executionInput.job.title} at ${executionInput.job.company} on the open page at ${targetUrl}. Confirm that the open page is this employer's application, then fill in the form; nothing is sent.`,
    homeLabel: input.siteLabel,
    homeHosts: [hostnameOf(targetUrl) ?? input.siteLabel],
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const approvedLetterText = await input.letters?.getApprovedText?.(
    executionInput.job.id,
    input.applicationRecordId,
  );
  const outcome = await runApplyAgentSafely(input, {
    hands,
    safety: {
      ...input.session,
      openIntermediateWriteWindow: async () => {
        await recheckWriteAuthority("answers");
        await input.session.openIntermediateWriteWindow();
      },
    },
    modelQuestionClassification: true,
    ...(input.questionReadCacheScope
      ? { questionReadCacheScope: input.questionReadCacheScope }
      : {}),
    ...(input.readReusableAnswers
      ? { readReusableAnswers: input.readReusableAnswers }
      : {}),
    ...(input.initialQuestionContexts
      ? { initialQuestionContexts: input.initialQuestionContexts }
      : {}),
    ...(input.initialPickerAttempts
      ? { initialPickerAttempts: input.initialPickerAttempts }
      : {}),
    ...(input.uploadsConfirmedByPerson?.length
      ? { uploadsConfirmedByPerson: input.uploadsConfirmedByPerson }
      : {}),
    ...(input.earlierAttachments?.length
      ? { earlierAttachments: input.earlierAttachments }
      : {}),
    ...(input.replay ? { replay: input.replay } : {}),
    ...(input.initialUnansweredPickerQuestions
      ? {
          initialUnansweredPickerQuestions:
            input.initialUnansweredPickerQuestions,
        }
      : {}),
    intermediateWritesAuthorized:
      executionInput.intermediateMutationsAuthorized === true,
    // Only Send for me presses the form's own buttons; Fill in for me leaves
    // them to the person even where the site saves fields as they are filled.
    pressesFormButtons: executionInput.submitAuthorized === true,
    browserPermissions: browserAgentPermissionsOf(executionInput.settings),
    ...(executionInput.readBrowserPermissions ? { readBrowserPermissions: executionInput.readBrowserPermissions } : {}),
    accountCreationAuthorized:
      browserAgentPermissionsOf(executionInput.settings).createAccounts,
    authority: activeAuthority,
    sources: {
      profile: executionInput.profile,
      ...(executionInput.listingDiscovery
        ? { listingDiscovery: executionInput.listingDiscovery }
        : {}),
      preferences: input.searchPreferences,
      resumeText: executionInput.profile.baseResume.textContent,
      posting: {
        title: executionInput.job.title,
        company: executionInput.job.company,
        location: executionInput.job.location,
        description: executionInput.job.description,
      },
      ...(approvedLetterText != null ? { approvedLetterText } : {}),
      reusableAnswers: input.reusableAnswers ?? [],
      documents: toApplyDocuments(executionInput),
    },
    application: {
      jobId: executionInput.job.id,
      applicationId: executionInput.idempotencyKey ?? executionInput.job.id,
      ...(executionInput.applicationPageBindingKey
        ? { resultId: executionInput.applicationPageBindingKey }
        : {}),
      ...(input.applicationRecordId
        ? { applicationRecordId: input.applicationRecordId }
        : {}),
      startingUrl: targetUrl,
      ...(executionInput.instructions?.length
        ? { instructions: executionInput.instructions }
        : {}),
      ...(isContinuation
        ? {
            continuation: {
              sourceUrls: [
                executionInput.startingUrl,
                executionInput.job.applicationUrl,
                executionInput.job.canonicalUrl,
              ].filter(
                (url): url is string =>
                  typeof url === "string" && url.trim().length > 0,
              ),
            },
          }
        : {}),
    },
    siteLabel: input.siteLabel,
    writing: AiBehaviorPreferenceSchema.parse(
      executionInput.settings.aiBehavior ?? {},
    ).applying,
    reviewMove: async (move) => {
      const review = await moveReviewer(move);
      if (!review.allowed) return review;
      let origin: string | null = null;
      try {
        origin = new URL(move.url).origin;
      } catch {
        origin = null;
      }
      if (
        origin &&
        !allowedOrigins.includes(origin) &&
        executionInput.authorizeReviewedApplicationOrigin
      ) {
        const widened =
          await executionInput.authorizeReviewedApplicationOrigin(origin);
        if (widened) {
          if (widened !== true) activeEnvelope = widened;
          allowedOrigins.push(origin);
          if (!fieldSaveOrigins.includes(origin)) fieldSaveOrigins.push(origin);
        }
      }
      return review;
    },
    ...(input.letters
      ? {
          letters: createApplicationLetterProvider({
            ...input.letters,
            application: {
              jobId: executionInput.job.id,
              applicationId:
                executionInput.idempotencyKey ?? executionInput.job.id,
            },
            ...(input.signal ? { signal: input.signal } : {}),
          }),
        }
      : {}),
    now,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  if (!outcome.ok) {
    // Whatever went wrong, this run ends as a recorded outcome rather than as
    // a thrown error: a run that disappears leaves the person with a button
    // that does nothing and a record that says it is still going.
    const failed = buildPreparationResult({
      executionInput,
      // A run the model or browser dropped is a failed attempt to try again,
      // not a step waiting on the person.
      state: "failed",
      summary: "Job Finder could not finish this application",
      detail: outcome.detail,
      questions: [],
      blocker: {
        code: "requires_manual_review",
        userActionKind: null,
        summary: "Job Finder could not finish this application.",
        detail: outcome.detail,
        questionIds: [],
        sourceDebugEvidenceRefIds: [],
        url: null,
      },
      checkpoints: [],
      checkpointLabel: "Stopped before the form was finished",
      checkpointDetail: outcome.detail,
      checkpointUrls: [targetUrl],
      lastUrl: null,
      now: now().toISOString(),
      nextActionLabel: "Try this application again",
    });
    return { ...failed, agentTiming: outcome.timing };
  }

  const result = outcome.result;
  // One line the developer can read beside the person's own notes. The same
  // numbers are in the run's trail; this is so a slow run can be diagnosed
  // from the console without opening the record.
  const timingNote = result.notes.find((note) =>
    note.startsWith("[apply] timing"),
  );
  if (timingNote) {
    console.info(timingNote);
  }

  if (toApplyAuthority(executionInput).mode === "autonomous_submit")
    await input.session.drainIntermediateWrites?.();
  input.onPrepared?.({
    result,
    handoff: decideApplySubmissionHandoff({
      result,
      mode: toApplyAuthority(executionInput).mode,
      envelope: activeEnvelope,
      siteLabel: input.siteLabel,
    }),
    reviewCard: buildApplyReviewCard({
      result,
      siteLabel: input.siteLabel,
      preparedAt: now().toISOString(),
      intermediateSaved:
        toApplyAuthority(executionInput).mode === "autonomous_submit" &&
        input.session.readIntermediateWriteCount() > 0,
    }),
  });

  const questions = toQuestions(result);
  const blocker = toBlocker(result, questions);
  // A form worked to the end with nothing left for the person is ready for
  // them to read over and send. Recording it as "paused" put every finished
  // application in the Waiting-on-you count beside the ones that were stuck.
  const attemptState: ApplyExecutionResult["state"] =
    questions.length > 0
      ? "paused"
      : result.outcome === "stuck" || blocker?.code === "application_closed"
        ? "failed"
        : blocker === null && questions.length === 0
          ? "ready"
          : "paused";

  const prepared = buildPreparationResult({
    executionInput,
    state: attemptState,
    summary: summaryFor(result),
    detail: result.reason,
    questions,
    blocker,
    checkpoints: toCheckpoints(result, executionInput.job.id, startedAt),
    checkpointLabel: summaryFor(result),
    checkpointDetail: result.reason,
    checkpointUrls: [targetUrl, ...(result.finalUrl ? [result.finalUrl] : [])],
    lastUrl: result.finalUrl,
    now: now().toISOString(),
    nextActionLabel: nextActionFor(result),
    externalWrites: toExternalWrites(result),
    modelUse: toModelUse(result, input, startedAt),
  });
  return {
    ...prepared,
    agentTiming: result.timing,
    questionContexts: result.questionContexts,
    pickerAttempts: result.pickerAttempts,
    ...(result.formPath?.length ? { formPath: result.formPath } : {}),
    ...(result.skipReason ? { skipReason: result.skipReason } : {}),
  };
}

/**
 * What the person would call the site this application is on.
 *
 * The name they chose for the source when they added it, when there is one;
 * otherwise the site's own address, without the "www." nobody says out loud.
 */
export function resolveApplySiteLabel(input: {
  targetLabel: string | null;
  applicationUrl: string;
}): string {
  const chosen = input.targetLabel?.trim();
  if (chosen) {
    return chosen;
  }
  try {
    return new URL(input.applicationUrl).hostname.replace(/^www\./iu, "");
  } catch {
    return "this site";
  }
}

/**
 * Adapts the product's AI client to the shape the apply loop expects.
 *
 * Returns null when this build has no model available. That is an outage, not
 * something the person can configure, and the caller says so in those words.
 */
export function toApplyLlmClient(
  aiClient: {
    getStatus?: () => { label: string; model: string | null };
    chatWithTools?: (
      messages: Parameters<LLMClient["chatWithTools"]>[0],
      tools: Parameters<LLMClient["chatWithTools"]>[1],
      options?: {
        signal?: AbortSignal;
        maxOutputTokens?: number;
        conversationKey?: string;
      },
    ) => ReturnType<LLMClient["chatWithTools"]>;
  },
  /**
   * One conversation for everything one person's applications ask the
   * model: form turns, question readings and answer checks lead with the
   * same instructions and facts, so the gateway serves that prefix from its
   * cache across a batch and across restarts.
   */
  conversationKey?: string,
): LLMClient | null {
  const chatWithTools = aiClient.chatWithTools;
  if (!chatWithTools) {
    return null;
  }
  return {
    chatWithTools: (messages, tools, options) =>
      chatWithTools(messages, tools, {
        ...(options ?? {}),
        ...(conversationKey ? { conversationKey } : {}),
      }),
  };
}

/** The conversation key for one person's applications. */
export function applyingConversationKey(profile: { id: string }): string {
  return `applying:${profile.id}`;
}

/**
 * Builds the callback the browser layer calls once it has the page open.
 *
 * When this build has no model available, the application stops with an
 * outage in plain words. It is never presented as something to set up: the
 * model is part of the product, so its absence is Job Finder's problem.
 */
export function createApplyFormPreparer(input: {
  executionInput: ApplyPreparationInput;
  applicationRecordId?: string;
  searchPreferences?: JobSearchPreferences | undefined;
  aiClient: Parameters<typeof toApplyLlmClient>[0];
  siteLabel: string;
  letters?:
    | Omit<ApplicationLetterDependencies, "application" | "signal">
    | undefined;
  envelope?: ApplicationAuthorityEnvelope | null;
  onPrepared?: AgentApplicationPreparationInput["onPrepared"];
  onProgress?: AgentApplicationPreparationInput["onProgress"];
  readReusableAnswers?: AgentApplicationPreparationInput["readReusableAnswers"];
  reusableAnswers?: CandidateReusableAnswer[];
  initialQuestionContexts?: AgentApplicationPreparationInput["initialQuestionContexts"];
  initialPickerAttempts?: AgentApplicationPreparationInput["initialPickerAttempts"];
  uploadsConfirmedByPerson?: readonly string[];
  earlierAttachments?: AgentApplicationPreparationInput["earlierAttachments"];
  replay?: AgentApplicationPreparationInput["replay"];
  initialUnansweredPickerQuestions?: AgentApplicationPreparationInput["initialUnansweredPickerQuestions"];
  now?: () => Date;
}): NonNullable<ExecuteApplicationFlowInput["prepareApplicationForm"]> {
  return async ({ session, currentUrl, startedAt, signal, onProgress }) => {
    const llmClient = toApplyLlmClient(
      input.aiClient,
      applyingConversationKey(input.executionInput.profile),
    );
    if (!llmClient) {
      const detail =
        "Job Finder could not fill this application in because its assistant is unavailable right now. Nothing was changed on the site. Try again shortly.";
      return buildPreparationResult({
        executionInput: input.executionInput,
        // The person cannot resolve a missing model. Persist this as a failed
        // attempt so recovery offers Try again without adding a Needs-you
        // blocker or pretending a form is ready.
        state: "failed",
        summary: "Job Finder could not fill this application in",
        detail,
        questions: [],
        blocker: null,
        checkpoints: [],
        checkpointLabel: "Stopped before filling anything in",
        checkpointDetail: detail,
        checkpointUrls: [],
        lastUrl: null,
        now: (input.now ?? (() => new Date()))().toISOString(),
        nextActionLabel: "Try this application again shortly",
      });
    }

    const status = input.aiClient.getStatus?.() ?? null;
    const reportProgress =
      input.onProgress || onProgress
        ? async (
            progress: Parameters<
              NonNullable<AgentApplicationPreparationInput["onProgress"]>
            >[0],
          ) => {
            await input.onProgress?.(progress);
            await onProgress?.(progress);
          }
        : undefined;
    return runAgentApplicationPreparation({
      session,
      currentUrl,
      executionInput: input.executionInput,
      ...(input.applicationRecordId
        ? { applicationRecordId: input.applicationRecordId }
        : {}),
      searchPreferences: input.searchPreferences,
      llmClient,
      questionReadCacheScope: input.aiClient,
      ...(input.reusableAnswers
        ? { reusableAnswers: input.reusableAnswers }
        : {}),
      ...(input.readReusableAnswers
        ? { readReusableAnswers: input.readReusableAnswers }
        : {}),
      ...(input.initialQuestionContexts
        ? { initialQuestionContexts: input.initialQuestionContexts }
        : {}),
      ...(input.initialPickerAttempts
        ? { initialPickerAttempts: input.initialPickerAttempts }
        : {}),
      ...(input.uploadsConfirmedByPerson?.length
        ? { uploadsConfirmedByPerson: input.uploadsConfirmedByPerson }
        : {}),
      ...(input.earlierAttachments?.length
        ? { earlierAttachments: input.earlierAttachments }
        : {}),
      ...(input.replay ? { replay: input.replay } : {}),
      ...(input.initialUnansweredPickerQuestions
        ? {
            initialUnansweredPickerQuestions:
              input.initialUnansweredPickerQuestions,
          }
        : {}),
      startedAt,
      siteLabel: input.siteLabel,
      providerLabel: status?.label ?? null,
      modelLabel: status?.model ?? null,
      ...(input.letters ? { letters: input.letters } : {}),
      ...(input.envelope ? { envelope: input.envelope } : {}),
      ...(input.onPrepared ? { onPrepared: input.onPrepared } : {}),
      ...(reportProgress ? { onProgress: reportProgress } : {}),
      ...(signal ? { signal } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  };
}

/**
 * Everything needed to write and render this application's letter.
 *
 * Returns undefined when neither is possible, which leaves a form asking for a
 * letter to the person rather than sending something that is not one.
 */
export function buildApplyLetterDependencies(input: {
  aiClient: {
    chatWithTools?: (
      messages: Parameters<LLMClient["chatWithTools"]>[0],
      tools: Parameters<LLMClient["chatWithTools"]>[1],
      options?: { signal?: AbortSignal; conversationKey?: string },
    ) => ReturnType<LLMClient["chatWithTools"]>;
  };
  documentManager: {
    getApprovedApplicationLetter?: JobFinderDocumentManager["getApprovedApplicationLetter"];
    renderLetterArtifact?: (renderInput: {
      text: string;
      job: SavedJob;
      profile: CandidateProfile;
      settings: JobFinderSettings;
      fileType: "pdf" | "docx" | "txt" | null;
    }) => Promise<RenderedLetterArtifact>;
  };
  job: SavedJob;
  profile: CandidateProfile;
  reusableAnswers?: CandidateReusableAnswer[];
  settings: JobFinderSettings;
  searchPreferences?: JobSearchPreferences | undefined;
}): Omit<ApplicationLetterDependencies, "application" | "signal"> | undefined {
  const rawChatWithTools = input.aiClient.chatWithTools;
  if (!rawChatWithTools) {
    return undefined;
  }
  // The letter and its check share the person's applying conversation.
  const conversationKey = applyingConversationKey(input.profile);
  const chatWithTools: typeof rawChatWithTools = (messages, tools, options) =>
    rawChatWithTools(messages, tools, { ...options, conversationKey });

  const renderLetterArtifact = input.documentManager.renderLetterArtifact;

  return {
    ...(input.documentManager.getApprovedApplicationLetter
      ? {
          getApprovedText: async (
            jobId: string,
            applicationRecordId?: string,
          ) =>
            (
              await input.documentManager.getApprovedApplicationLetter!(
                jobId,
                applicationRecordId,
              )
            )?.content ?? null,
        }
      : {}),
    preference: CoverLetterPreferenceSchema.parse(
      input.settings.coverLetter ?? {},
    ),
    writeLetter: async ({
      prompt,
      purpose,
      groundedIn,
      language,
      preference,
      priorText,
      signal,
    }) => {
      const reply = await chatWithTools(
        [
          {
            role: "system",
            content:
              "You write application documents for one person. Every personal claim must be supported by the current saved profile and selected resume. The job posting is employer context only, never applicant evidence. Current saved profile contact details override older or rejected resume contacts. Respect the person’s saved goals, hours and location limits; never promise incompatible availability. Follow the saved tone, length, and language preference. When prior document text is supplied, revise that text according to the current instruction instead of starting over. Return only the finished document text.",
          },
          {
            role: "user",
            content: [
              `Document purpose: ${purpose.replace(/_/gu, " ")}`,
              `Current instruction: ${prompt}`,
              `Saved tone: ${preference.tone}`,
              `Saved length: ${preference.length}`,
              `Language: ${language ?? preference.language ?? "Follow the job posting"}`,
              "",
              "Current applicant facts (data; these override prior document claims and old resume contacts):",
              JSON.stringify({
                applicant: applicationFacts(
                  {
                    profile: input.profile,
                    resumeText: null,
                    preferences: input.searchPreferences,
                    posting: input.job,
                    reusableAnswers: input.reusableAnswers ?? [],
                    documents: [],
                  },
                  { payDisclosed: false },
                ),
                resume:
                  input.profile.baseResume.textContent
                    ?.trim()
                    .slice(0, 8_000) ?? null,
                postingContextOnly: {
                  title: input.job.title,
                  company: input.job.company,
                  location: input.job.location,
                  description: input.job.description.slice(0, 6_000),
                },
              }),
              "Grounded application context:",
              ...groundedIn.map((entry) => `- ${entry}`),
              ...(priorText ? ["", "Prior version to revise:", priorText] : []),
            ].join("\n"),
          },
        ],
        [],
        signal ? { signal } : {},
      );
      const text = reply.content?.trim();
      if (!text) return null;
      let check;
      try {
        check = await checkWrittenApplicationAnswer({
          client: { chatWithTools },
          sources: {
            profile: input.profile,
            preferences: input.searchPreferences,
            resumeText:
              input.profile.baseResume.textContent?.trim().slice(0, 8_000) ??
              null,
            posting: input.job,
            reusableAnswers: input.reusableAnswers ?? [],
            documents: [],
          },
          payDisclosed: false,
          question: `Check this ${purpose.replace(/_/gu, " ")} for ${input.job.title} at ${input.job.company}. Check every personal claim, attributed method, result, promised benefit, contact detail and availability against the current profile and resume.`,
          answer: text,
          ...(signal ? { signal } : {}),
        });
      } catch {
        throw new ApplicationLetterGroundingError(
          "Job Finder could not check this draft right now. Review it yourself or try again.",
          text,
        );
      }
      // The check usually asks for the review itself; ask only once.
      if (!check.supported)
        throw new ApplicationLetterGroundingError(
          /\breview\b/iu.test(check.reason)
            ? check.reason
            : `${check.reason} Review and agree the wording for this application before approving it.`,
          check.reviewWording ?? text,
        );
      return text;
    },
    ...(renderLetterArtifact
      ? {
          renderLetter: async ({ text, fileType }) => {
            const rendered = await renderLetterArtifact({
              text,
              job: input.job,
              profile: input.profile,
              settings: input.settings,
              fileType,
            });
            if (!rendered.ok) {
              return { ok: false, reason: rendered.reason };
            }
            return {
              ok: true,
              fileName: rendered.fileName,
              mimeType: rendered.mimeType,
              // The exact bytes that were written are the bytes that go out.
              loadBytes: async () => {
                const bytes = await readFile(rendered.storagePath);
                const actual = createHash("sha256").update(bytes).digest("hex");
                if (actual !== rendered.sha256) {
                  throw new Error(
                    "The letter changed after it was written, so it was not attached.",
                  );
                }
                return new Uint8Array(bytes);
              },
            };
          },
        }
      : {}),
  };
}

/**
 * What the person sees before they press send.
 *
 * Everything here comes from the run that just happened: the answers that went
 * into the form and where each one came from, the files that were attached,
 * and the page it ended on. Nothing is inferred and nothing is hidden — a
 * review that does not show the generated answers is not a review.
 */
function reviewQuestionKey(
  fieldKey: string | undefined,
  label: string,
  siblings: readonly { fieldKey?: string | undefined; label: string }[] = [],
): string {
  if (!fieldKey) return label;
  const parts = fieldKey.split("|");
  if (parts.length < 4) return fieldKey;
  const base = `${parts[0]}|${parts[1]}|${label}`;
  if (parts[2]?.startsWith("field:"))
    return `${base}|${parts[2].split(":").at(-1)}`;
  const same = siblings.filter((entry) => {
    const peer = entry.fieldKey?.split("|");
    return (
      peer &&
      peer.length >= 4 &&
      `${peer[0]}|${peer[1]}|${entry.label}` === base
    );
  });
  const ordinal = same.findIndex((entry) => entry.fieldKey === fieldKey);
  // Equal-worded questions on one screen remain separate by their order.
  // Temporary handles never become the identity of a unique question.
  return `${base}|${same.length > 1 ? Math.max(0, ordinal) : 0}`;
}

export function buildApplyReviewCard(input: {
  result: ApplyAgentResult;
  siteLabel: string;
  preparedAt: string;
  intermediateSaved?: boolean;
}): ApplicationReviewCard {
  const filled = input.result.reviewFilled ?? input.result.filled;
  const attached = input.result.reviewAttachments ?? input.result.attachments;
  const letterEntry = filled.find(
    (entry) => entry.questionKind === "cover_letter",
  );
  const attachedLetter = attached.find((entry) => entry.reviewText)?.reviewText;
  const reviewDraft = input.result.pauses.find(
    (pause) => pause.reviewDraft,
  )?.reviewDraft;
  // The card's schema caps every string. The run's own text (a grounding
  // note that quotes a resume line, a long field label) can run past a cap,
  // and an over-long note used to make this parse throw after the form had
  // been filled in, so the run ended as "stopped safely" and nothing was
  // sent. Text is clamped to what the card can hold; the record keeps the
  // full run trail.
  const clamp = (text: string, max: number): string => {
    const trimmed = text.trim() ? text : "-";
    return trimmed.length <= max
      ? trimmed
      : `${trimmed.slice(0, max - 1).trimEnd()}…`;
  };
  const clampGrounding = (notes: readonly string[]): string[] =>
    notes
      .map((note) => note.trim())
      .filter((note) => note.length > 0)
      .slice(0, 8)
      .map((note) => clamp(note, 240));

  return ApplicationReviewCardSchema.parse({
    siteLabel: clamp(input.siteLabel, 240),
    pageUrl: input.result.finalUrl,
    ...(input.intermediateSaved ? { intermediateSaved: true } : {}),
    ...(input.result.reviewObservedFieldKeys
      ? { observedFieldKeys: input.result.reviewObservedFieldKeys }
      : {}),
    answers: [
      ...new Map(
        filled.map((entry) => [entry.fieldKey ?? entry.label, entry]),
      ).values(),
    ]
      .slice(0, 200)
      .map((entry) => ({
        ...(entry.fieldKey ? { fieldKey: entry.fieldKey } : {}),
        question: clamp(entry.label, 2_000),
        answer: clamp(entry.answer.value, 12_000),
        source: clamp(entry.answer.provenanceLabel, 240),
        sourceId: entry.answer.sourceId,
        written: entry.answer.sourceKind === "generated",
        groundedIn: clampGrounding(entry.answer.groundedIn),
      })),
    attachments: [
      ...new Map(
        attached.map((entry) => [entry.fieldKey ?? entry.controlLabel, entry]),
      ).values(),
    ]
      .slice(0, 20)
      .map((attachment) => ({
        ...(attachment.fieldKey ? { fieldKey: attachment.fieldKey } : {}),
        label: clamp(attachment.label, 240),
        fileName: clamp(attachment.fileName, 240),
        field: clamp(attachment.controlLabel, 2_000),
      })),
    letter: reviewDraft
      ? {
          text: clamp(reviewDraft.text, 12_000),
          groundedIn: clampGrounding(reviewDraft.groundedIn),
          reviewReason: clamp(reviewDraft.reason, 2_000),
        }
      : letterEntry
        ? {
            fields: [
              ...filled
                .filter((entry) => entry.questionKind === "cover_letter")
                .map((entry) => entry.label),
              ...attached
                .filter((entry) => entry.reviewText)
                .map((entry) => entry.controlLabel),
            ],
            text: clamp(letterEntry.answer.value, 12_000),
            groundedIn: clampGrounding(letterEntry.answer.groundedIn),
          }
        : attachedLetter
          ? {
              fields: attached
                .filter((entry) => entry.reviewText)
                .map((entry) => entry.controlLabel),
              text: clamp(attachedLetter.text, 12_000),
              groundedIn: clampGrounding(attachedLetter.groundedIn),
            }
          : null,
    waitingOnYou: input.result.pauses
      .map((pause) => pause.summary)
      .slice(0, 20)
      .map((summary) => clamp(summary, 2_000)),
    preparedAt: input.preparedAt,
  });
}

/** The address and recorded step identify a screen, without interpreting its label. */
function reviewStepKey(fieldKey: string | undefined): string | null {
  const parts = fieldKey?.split("|");
  return parts && parts.length >= 4 && parts[0]
    ? `${parts[0]}|${parts[1]}`
    : null;
}

/** A continuation adds to the retained form review; latest fields win. */

export function mergeApplyReviewCards(
  previous: ApplicationReviewCard | null,
  current: ApplicationReviewCard | null,
  options: { freshPreparation?: boolean } = {},
): ApplicationReviewCard | null {
  if (!current) return options.freshPreparation ? null : previous;
  if (!previous) return current;
  const answerPeers = (card: ApplicationReviewCard) =>
    card.answers.map((entry) => ({ ...entry, label: entry.question }));
  const attachmentPeers = (card: ApplicationReviewCard) =>
    card.attachments.map((entry) => ({ ...entry, label: entry.field }));
  const answerKey = (
    card: ApplicationReviewCard,
    entry: ApplicationReviewCard["answers"][number],
  ) => reviewQuestionKey(entry.fieldKey, entry.question, answerPeers(card));
  const attachmentKey = (
    card: ApplicationReviewCard,
    entry: ApplicationReviewCard["attachments"][number],
  ) => reviewQuestionKey(entry.fieldKey, entry.field, attachmentPeers(card));
  const observedPeers = (current.observedFieldKeys ?? []).map((fieldKey) => ({
    fieldKey,
    label: fieldKey.split("|").slice(3).join("|"),
  }));
  const currentSteps = new Set(
    (current.observedFieldKeys ?? []).map(reviewStepKey).filter(Boolean),
  );
  const previousKeys = [
    ...previous.answers.map((answer) => answer.fieldKey),
    ...previous.attachments.map((attachment) => attachment.fieldKey),
    ...(previous.observedFieldKeys ?? []),
  ];
  const previousSteps = [...new Set(previousKeys.map(reviewStepKey))].filter(
    (step) => step !== null,
  );
  const previousObservedSteps = new Set(
    (previous.observedFieldKeys ?? []).map(reviewStepKey),
  );
  // Older continuations stored only their last run's observations. Recover
  // their earlier screens from the retained answers when that history is partial.
  const orderedPreviousSteps = previousSteps.every((step) =>
    previousObservedSteps.has(step),
  )
    ? [...previousObservedSteps].filter((step) => step !== null)
    : previousSteps;
  const firstCurrentStep = reviewStepKey(current.observedFieldKeys?.[0]);
  const previousObservedPeers = (previous.observedFieldKeys ?? []).map(
    (fieldKey) => ({
      fieldKey,
      label: fieldKey.split("|").slice(3).join("|"),
    }),
  );
  const previousQuestionKeys = new Set([
    ...previous.answers.map((answer) => answerKey(previous, answer)),
    ...previous.attachments.map((attachment) =>
      attachmentKey(previous, attachment),
    ),
    ...previousObservedPeers.map((entry) =>
      reviewQuestionKey(entry.fieldKey, entry.label, previousObservedPeers),
    ),
  ]);
  const continuedForm =
    firstCurrentStep !== null &&
    orderedPreviousSteps.indexOf(firstCurrentStep) > 0 &&
    !orderedPreviousSteps
      .slice(0, orderedPreviousSteps.indexOf(firstCurrentStep))
      .some((step) => currentSteps.has(step)) &&
    observedPeers.some(
      (observed) =>
        reviewStepKey(observed.fieldKey) === firstCurrentStep &&
        previousQuestionKeys.has(
          reviewQuestionKey(observed.fieldKey, observed.label, observedPeers),
        ),
    );
  const retainEarlier = !options.freshPreparation || continuedForm;
  const unobservedStep = (fieldKey: string | undefined): boolean => {
    const step = reviewStepKey(fieldKey);
    return step !== null ? !currentSteps.has(step) : !options.freshPreparation;
  };
  const observedFieldKeys = new Set<string>();
  if (retainEarlier && current.observedFieldKeys) {
    // Replace each observed screen in its original position so revisiting the
    // first screen cannot make a later screen look like the form's start.
    for (const key of previous.observedFieldKeys ?? []) {
      if (unobservedStep(key)) observedFieldKeys.add(key);
      else {
        for (const currentKey of current.observedFieldKeys) {
          if (reviewStepKey(currentKey) === reviewStepKey(key))
            observedFieldKeys.add(currentKey);
        }
      }
    }
    for (const key of current.observedFieldKeys) observedFieldKeys.add(key);
  }
  const answers = current.answers.map((answer) => {
    const recorded = previous.answers.find((entry) =>
      answer.fieldKey && entry.fieldKey
        ? answerKey(current, answer) === answerKey(previous, entry)
        : answer.question === entry.question,
    );
    return answer.source === "the filled application form" &&
      recorded?.answer === answer.answer
      ? {
          ...recorded,
          ...(answer.fieldKey ? { fieldKey: answer.fieldKey } : {}),
        }
      : answer;
  });
  const earlierAnswers = (retainEarlier ? previous.answers : []).filter(
    (answer) =>
      unobservedStep(answer.fieldKey) &&
      (answer.fieldKey
        ? !current.observedFieldKeys?.some(
            (key) =>
              reviewQuestionKey(
                key,
                key.split("|").slice(3).join("|"),
                observedPeers,
              ) === answerKey(previous, answer),
          ) &&
          !answers.some(
            (entry) =>
              answerKey(current, entry) === answerKey(previous, answer),
          )
        : !answers.some((entry) => entry.question === answer.question)),
  );
  const earlierAttachments = (retainEarlier ? previous.attachments : []).filter(
    (attachment) =>
      unobservedStep(attachment.fieldKey) &&
      (attachment.fieldKey
        ? !current.observedFieldKeys?.some(
            (key) =>
              reviewQuestionKey(
                key,
                key.split("|").slice(3).join("|"),
                observedPeers,
              ) === attachmentKey(previous, attachment),
          ) &&
          !current.attachments.some(
            (entry) =>
              attachmentKey(current, entry) ===
              attachmentKey(previous, attachment),
          )
        : !current.attachments.some(
            (entry) => entry.field === attachment.field,
          )),
  );
  return ApplicationReviewCardSchema.parse({
    ...current,
    ...(previous.intermediateSaved || current.intermediateSaved
      ? { intermediateSaved: true }
      : {}),
    ...(retainEarlier && current.observedFieldKeys
      ? {
          observedFieldKeys: [...observedFieldKeys].slice(0, 500),
        }
      : {}),
    answers: [
      ...new Map(
        [...earlierAnswers, ...answers].map((answer) => [
          answerKey(
            earlierAnswers.includes(answer) ? previous : current,
            answer,
          ),
          answer,
        ]),
      ).values(),
    ].filter(
      (entry, index, all) =>
        all.findLastIndex(
          (candidate) =>
            (candidate.fieldKey === entry.fieldKey ||
              ((candidate.fieldKey?.split("|").length ?? 0) < 4 &&
                (entry.fieldKey?.split("|").length ?? 0) < 4)) &&
            candidate.question === entry.question &&
            candidate.answer === entry.answer,
        ) === index,
    ),
    attachments: [
      ...new Map(
        [...earlierAttachments, ...current.attachments].map((attachment) => [
          attachmentKey(
            earlierAttachments.includes(attachment) ? previous : current,
            attachment,
          ),
          attachment,
        ]),
      ).values(),
    ].filter(
      (entry, index, all) =>
        all.findLastIndex(
          (candidate) =>
            (candidate.fieldKey === entry.fieldKey ||
              ((candidate.fieldKey?.split("|").length ?? 0) < 4 &&
                (entry.fieldKey?.split("|").length ?? 0) < 4)) &&
            candidate.field === entry.field &&
            candidate.fileName === entry.fileName,
        ) === index,
    ),
    letter:
      current.letter ??
      (!options.freshPreparation || letterStillOnForm(previous, current)
        ? previous.letter
        : null),
  });
}

/**
 * A fresh preparation that found the earlier letter already on the form
 * (the same file in the same field, or the same text) filled nothing, so its
 * own card has no letter; the letter going out is still the earlier one.
 */
function letterStillOnForm(
  previous: ApplicationReviewCard,
  current: ApplicationReviewCard,
): boolean {
  const letter = previous.letter;
  const fields = letter?.fields ?? [];
  if (!letter || fields.length === 0) return false;
  return (
    current.attachments.some(
      (attachment) =>
        fields.includes(attachment.field) &&
        previous.attachments.some(
          (earlier) =>
            earlier.field === attachment.field &&
            earlier.fileName === attachment.fileName,
        ),
    ) ||
    current.answers.some(
      (answer) =>
        fields.includes(answer.question) &&
        answer.answer.trim() === letter.text.trim(),
    )
  );
}
