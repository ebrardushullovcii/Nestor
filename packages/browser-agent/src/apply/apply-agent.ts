import { createApplyTiming } from "./apply-timing";
import { resumeFormFileNames } from "@nestor/contracts";
import {
  parseToolArguments,
  runAgentLoop,
  type AgentLoopFinish,
  type AgentLoopModel,
  type AgentLoopTool,
  type AgentLoopToolOutcome,
} from "@nestor/agent-runtime";
import {
  describeBrowserError,
  type ApplicationAttemptQuestion,
} from "@nestor/contracts";

import { withReasoningTask, type LLMClient } from "../agent/contracts";
import { createPageTools } from "../page-tools";
import {
  createApplySystemPrompt,
  createApplyUserPrompt,
  describeObservation,
  describeObservationUpdate,
  applyStepShape,
} from "./apply-prompts";
import {
  FILL_FIELDS_TOOL_DEFINITION,
  getApplyToolDefinitions,
  parseApplyProposal,
  parseFillFields,
  type FillFieldsEntry,
} from "./apply-tools";
import {
  buildPendingQuestion,
  approvedApplicationLetter,
  createApplyGuardState,
  executeApplyProposal,
  fileFieldHoldsOtherFile,
  questionPrompt,
  type ApplyExecutionOutcome,
} from "./policy-executor";
import {
  buildCoverLetterRequest,
  coverLetterPolicyAllows,
  isCoverLetterControl,
} from "./cover-letter";
import {
  createQuestionClassifier,
  questionClassificationKey,
} from "./question-classification";
import {
  applicationFacts,
  savedAnswerForQuestion,
  storedFactFor,
  storedFacts,
} from "./application-facts";
import {
  checkFormReadiness,
  runSubmitPreflight,
  unresolvedRequiredControls,
} from "./submit-preflight";
import { matchOption } from "./option-match";
import {
  checkWrittenApplicationAnswer,
  checkWrittenApplicationAnswers,
  WrittenAnswerCheckUnavailableError,
  type WrittenAnswerCheck,
} from "./written-answer-grounding";
import {
  isSecurityChallengeControl,
  reportedSecurityChallenge,
} from "./blockers";
import type {
  ApplyAgentConfig,
  ApplyAgentResult,
  ApplyAttachedDocument,
  ApplyFilledControl,
  ApplyFormObservation,
  ApplyDocument,
  ApplyPause,
  ApplyProposal,
} from "./types";

const DEFAULT_MAX_STEPS = 200;
// Long forms on a slow model took 16 minutes to reach the review step;
// 15 minutes cut them off just before it.
const DEFAULT_TIME_BUDGET_MS = 30 * 60_000;
const DEFAULT_NO_PROGRESS_STEP_LIMIT = 12;

const PAGE_TOOL_NAMES = new Set([
  "observe",
  "read_text",
  "navigate",
  "follow_link",
  "scroll",
  "wait",
  "go_back",
]);

function formStepIdentity(observation: ApplyFormObservation): string {
  return JSON.stringify({
    url: observation.url,
    step: observation.step,
    // Prefer the site's step marker; errors can reveal extra fields on the same step.
    controls:
      observation.step.label !== null || observation.step.index !== null
        ? undefined
        : observation.controls.map(
            ({ ref, kind, label, groupLabel, visible }) => ({
              ref,
              kind,
              label,
              groupLabel,
              visible,
            }),
          ),
  });
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function defaultOutcomeFor(
  config: ApplyAgentConfig,
): "prepared" | "awaiting_your_review" {
  return config.authority.mode === "confirm_before_submit"
    ? "awaiting_your_review"
    : "prepared";
}

function describePrepared(
  config: ApplyAgentConfig,
  filledCount: number,
  attachmentCount: number,
): string {
  const filledPart =
    filledCount === 1
      ? "filled in 1 answer"
      : `filled in ${filledCount} answers`;
  const attachmentPart =
    attachmentCount === 0
      ? ""
      : attachmentCount === 1
        ? " and attached 1 file"
        : ` and attached ${attachmentCount} files`;
  const ending =
    config.authority.mode === "confirm_before_submit"
      ? "It is ready for you to look over and send."
      : "It is filled in and waiting; nothing was sent.";
  return `Job Finder ${filledPart}${attachmentPart} on ${config.siteLabel}. ${ending}`;
}

function browserFailureKind(toolName: string): "browser" | "tool" {
  return [
    "click",
    "type",
    "select",
    "set_checkbox",
    "submit_application",
  ].includes(toolName)
    ? "browser"
    : "tool";
}

const GENERIC_FILE_WORDS = new Set([
  "a",
  "an",
  "application",
  "attach",
  "attachment",
  "document",
  "file",
  "required",
  "the",
  "upload",
]);

function hasMatchingApplicationDocument(
  control: ApplyFormObservation["controls"][number],
  documents: readonly ApplyDocument[],
): boolean {
  const prompt = questionPrompt(control).toLowerCase();
  if (
    control.questionKind === "resume" &&
    /(?:\bresume\b|curriculum vitae|\bcv\b)/u.test(prompt)
  ) {
    return documents.some((document) => document.kind === "resume");
  }
  if (
    control.questionKind === "cover_letter" &&
    /(?:cover|motivation)[ -]?letter/u.test(prompt)
  ) {
    return documents.some((document) => document.kind === "cover_letter");
  }
  const promptWords = prompt
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 2 && !GENERIC_FILE_WORDS.has(word));
  if (promptWords.length === 0) return false;
  return documents.some((document) => {
    if (document.kind === "resume" || document.kind === "cover_letter") {
      return false;
    }
    const description = `${document.label} ${document.fileName}`.toLowerCase();
    return promptWords.some((word) => description.includes(word));
  });
}

function stuckReasonMentionsRequiredFile(
  reason: string,
  control: ApplyFormObservation["controls"][number],
): boolean {
  const normalizedReason = reason.toLowerCase();
  if (/\b(?:attach|document|file|upload)\b/u.test(normalizedReason)) {
    return true;
  }
  const promptWords = questionPrompt(control)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 3 && !GENERIC_FILE_WORDS.has(word));
  return promptWords.some((word) => normalizedReason.includes(word));
}

function isApplicationLetterOrStatement(
  control: ApplyFormObservation["controls"][number],
): boolean {
  const prompt = questionPrompt(control).toLowerCase();
  return (
    isCoverLetterControl(control) ||
    /\b(?:supporting|personal) statement\b/u.test(prompt)
  );
}

function canGenerateRequiredApplicationDocument(
  control: ApplyFormObservation["controls"][number],
  config: ApplyAgentConfig,
): boolean {
  if (!config.letters || !isApplicationLetterOrStatement(control)) {
    return false;
  }
  const policy = config.writing?.coverLetterPolicy ?? "when_required";
  return coverLetterPolicyAllows(control, policy);
}

export async function runApplyAgent(
  config: ApplyAgentConfig,
  llmClient: LLMClient,
): Promise<ApplyAgentResult> {
  const timing = createApplyTiming(config.now ?? (() => new Date()));
  try {
    return await runMeasuredApplyAgent(
      { ...config, hands: timing.hands(config.hands) },
      // Form turns are short; answer checks name their own task.
      timing.model(withReasoningTask(llmClient, "apply")),
      timing,
    );
  } finally {
    config.onTiming?.(timing.snapshot());
  }
}

async function runMeasuredApplyAgent(
  config: ApplyAgentConfig,
  llmClient: LLMClient,
  timingRecord: ReturnType<typeof createApplyTiming>,
): Promise<ApplyAgentResult> {
  const now = config.now ?? (() => new Date());
  const filled: ApplyFilledControl[] = [];
  const attachments: ApplyAttachedDocument[] = [];
  const observedAnswers = new Map<string, ApplyFilledControl>();
  const observedAttachments = new Map<string, ApplyAttachedDocument>();
  const pauses: ApplyPause[] = [];
  // Letter fields whose drafted letter waits for the person's review.
  const lettersAwaitingReview = new Set<string>();
  const notes: string[] = [];
  const timeline: { at: string; text: string }[] = [];
  const reviewObservedFieldKeys = new Set<string>();
  const pendingQuestions = new Map<string, ApplicationAttemptQuestion>();
  // A run that stops for the person (a check only they can pass) is first
  // asked once to fill the fields it already knows, so the person is left
  // only the part the agent could not do.
  let stuckFinishNudged = false;
  const guardState = createApplyGuardState();
  const classifyQuestions = config.modelQuestionClassification
    ? createQuestionClassifier({ client: llmClient, signal: config.signal })
    : undefined;
  const documentCatalog: ApplyDocument[] = [...config.sources.documents];
  const runConfig: ApplyAgentConfig = {
    ...config,
    sources: { ...config.sources, documents: documentCatalog },
  };
  let readyToSend: ApplyAgentResult["readyToSend"] = null;
  const payDisclosed =
    config.authority.salaryDisclosure === "answer_from_profile";
  const resumeText =
    (config.sources.resumeText ?? config.sources.profile.baseResume.textContent)
      ?.trim()
      .slice(0, 8_000) || null;
  const currentFormContext = () => {
    const observation = pageTools.state.observation;
    return observation
      ? {
          pageText: observation.bodyTextExcerpt,
          fields: observation.controls
            .filter(
              (control) =>
                control.visible &&
                !control.credentialRole &&
                control.kind !== "file" &&
                control.answered,
            )
            .map((control) => ({
              question: questionPrompt(control),
              value: control.selectedOptionLabel || control.value,
            })),
        }
      : undefined;
  };
  const answerChecks = new Map<string, Promise<WrittenAnswerCheck>>();
  const answerCheckKey = (question: string, answer: string) =>
    JSON.stringify([
      pageTools.state.observation?.url,
      pageTools.state.observation?.step,
      question,
      answer,
    ]);
  const checkOne = (
    question: string,
    answer: string,
  ): Promise<WrittenAnswerCheck> => {
    const key = answerCheckKey(question, answer);
    const cached = answerChecks.get(key);
    if (cached) return cached;
    const result = checkWrittenApplicationAnswer({
      client: llmClient,
      sources: runConfig.sources,
      payDisclosed,
      formContext: currentFormContext(),
      question,
      answer,
      signal: config.signal,
    });
    answerChecks.set(key, result);
    return result;
  };
  // Precheck exactly the answer the executor will ask about. The executor
  // still decides whether that answer and the person's permissions allow a write.
  const fillFieldCheck = (
    proposal: FillFieldsEntry,
    observation: ApplyFormObservation,
  ): { question: string; answer: string } | null => {
    const control = observation.controls.find(
      (candidate) => candidate.ref === proposal.ref,
    );
    if (!control) return null;
    let answer: string | null;
    switch (proposal.tool) {
      case "type":
        answer = proposal.text;
        break;
      case "select":
        answer =
          control.options.length > 0
            ? matchOption(control.options, proposal.option)
            : proposal.option;
        break;
      case "set_checkbox":
        // Ordinary single boxes are settled by the executor's declaration
        // checks, not by a written-answer check.
        if (
          control.kind === "checkbox" &&
          control.answerControlType !== "multi_choice" &&
          control.questionKind !== "work_authorization" &&
          control.questionKind !== "visa_sponsorship"
        )
          return null;
        answer =
          control.kind === "checkbox" &&
          control.answerControlType !== "multi_choice"
            ? proposal.checked
              ? "Yes"
              : "No"
            : proposal.checked
              ? control.label || control.value
              : null;
        break;
      case "upload":
      case "click":
        return null; // The executor checks files and click-derived answers itself.
    }
    return answer !== null &&
      control.attestationKind === null &&
      !isCoverLetterControl(control) &&
      (savedAnswerForQuestion(
        control,
        runConfig.sources.reusableAnswers,
      )?.answer.trim() ?? "") !== answer.trim() &&
      !storedFactFor({
        sources: runConfig.sources,
        payDisclosed,
        control,
        value: answer,
        storedFactId:
          "storedFactId" in proposal ? proposal.storedFactId : undefined,
      })
      ? { question: questionPrompt(control), answer }
      : null;
  };
  let requiredEmptyNudged = false;
  let advanceFinishNudged = false;
  let finalActionNudged = false;
  let staleResumeNudged = false;
  let optionalLetterNudged = false;

  const pendingQuestionKey = (
    control: Pick<
      ApplyFormObservation["controls"][number],
      "ref" | "kind" | "choiceGroupKey"
    >,
  ): string =>
    (control.kind === "radio" || control.kind === "checkbox") &&
    control.choiceGroupKey
      ? `${control.kind}:${control.choiceGroupKey}`
      : control.ref;

  await config.onProgress?.({
    step: 0,
    note: "reading the application form",
    progressSteps: 0,
    elapsedMs: 0,
  });

  const note = (text: string): void => {
    notes.push(text);
    timeline.push({ at: now().toISOString(), text });
  };
  const collectedQuestionsPause = (): ApplyPause | null => {
    const questions = [...pendingQuestions.values()];
    const first = questions[0];
    if (!first) return null;
    return {
      code: questions.every((question) => question.answerControlType === "file")
        ? "document_needs_you"
        : "question_needs_you",
      summary: questions.every(
        (question) => question.answerControlType === "file",
      )
        ? `Add the required ${questions.map((question) => question.prompt).join(" and ")} to continue.`
        : questions.length === 1
          ? `Job Finder filled in what it could on ${config.siteLabel} and needs your answer to one question.`
          : `Job Finder filled in what it could on ${config.siteLabel} and needs your answers to ${questions.length} questions.`,
      question: first,
      questions,
      blocker: null,
    };
  };

  const startOrigin = originOf(config.application.startingUrl);
  const pageTools = createPageTools(config.hands, {
    allowUrl: (url) => {
      const origin = originOf(url);
      if (!origin) return null;
      if (config.reviewMove && startOrigin && origin !== startOrigin) {
        return `${origin} is a different site from the listing.`;
      }
      return null;
    },
    ...(config.reviewMove
      ? {
          reviewMove: async (move: {
            url: string;
            reason: string;
            fromUrl: string | null;
          }) => {
            return config.reviewMove!(move);
          },
        }
      : {}),
  });

  const syncObservation = (next: ApplyFormObservation): void => {
    pageTools.state.observation = next;
    // Classify the page's questions now, while the model reads the page, so
    // the first answer does not wait for it. Writes await the same result.
    void classifyQuestions?.(
      next.controls,
      JSON.stringify({ url: next.url, step: next.step }),
    ).catch(() => undefined);
    // A person or a later page write may have answered a previously pending
    // question. Keep the live controls authoritative when continuing.
    // Refs are page-local. Retain only questions that still describe an
    // unresolved control on this step, rather than a field from an older page.
    for (const [key, pending] of pendingQuestions) {
      const current = next.controls.find(
        (control) =>
          pendingQuestionKey(control) === key &&
          questionPrompt(control) === pending.prompt,
      );
      if (
        !current ||
        current.disabled ||
        (!current.visible && current.kind !== "file") ||
        current.answered
      )
        pendingQuestions.delete(key);
    }
    readyToSend = null;
    for (const control of next.controls) {
      if (control.disabled || (!control.visible && control.kind !== "file"))
        continue;
      const label = questionPrompt(control);
      const matchingQuestions = next.controls.filter(
        (entry) => questionPrompt(entry) === label,
      );
      const questionOrdinal = matchingQuestions.indexOf(control);
      const questionKey =
        control.choiceGroupKey && !control.choiceGroupKey.startsWith("ref:")
          ? control.choiceGroupKey
          : `field:${control.kind}:${questionOrdinal}`;
      const fieldKey =
        `${next.url?.split(/[?#]/u)[0] ?? ""}|${next.step.label ?? ""}|${questionKey}|${label}`.slice(
          0,
          2_000,
        );
      reviewObservedFieldKeys.add(fieldKey);
      if (control.kind === "file") {
        if (control.answered) {
          const fileName =
            control.value.split(/[\\/]/u).at(-1) ?? control.value;
          const recorded = [...attachments]
            .reverse()
            .find(
              (entry) =>
                entry.controlLabel === label && entry.fileName === fileName,
            );
          observedAttachments.set(fieldKey, {
            ...(recorded ?? {
              documentId: `observed.${control.ref}`,
              fileName,
              label,
              controlLabel: label,
              at: next.observedAt,
            }),
            fieldKey,
          });
        } else {
          observedAttachments.delete(fieldKey);
        }
      } else if (
        control.answered &&
        ((control.kind !== "radio" && control.kind !== "checkbox") ||
          control.checked) &&
        !isSecurityChallengeControl(control)
      ) {
        const value =
          control.kind === "checkbox"
            ? control.answerControlType === "multi_choice"
              ? next.controls
                  .filter(
                    (candidate) =>
                      candidate.choiceGroupKey === control.choiceGroupKey &&
                      candidate.checked,
                  )
                  .map((candidate) => candidate.label || candidate.value)
                  .join(", ")
              : "Yes"
            : control.kind === "radio"
              ? control.label || control.value
              : control.selectedOptionLabel || control.value;
        if (value.trim()) {
          const recorded = [...filled]
            .reverse()
            .find(
              (entry) => entry.label === label && entry.answer.value === value,
            );
          observedAnswers.set(fieldKey, {
            ...(recorded ?? {
              ref: control.ref,
              label,
              questionKind: control.questionKind,
              answer: {
                value,
                kind: control.questionKind,
                sourceKind: "profile",
                sourceId: `observed.${control.ref}`,
                provenanceLabel: "the filled application form",
                groundedIn: [],
              },
              at: next.observedAt,
            }),
            fieldKey,
          });
        }
      } else if (
        (control.kind !== "radio" && control.kind !== "checkbox") ||
        !control.answered
      ) {
        observedAnswers.delete(fieldKey);
      }
      if (control.answered)
        pendingQuestions.delete(pendingQuestionKey(control));
    }
    if (next.url && !pageTools.state.visitedUrls.includes(next.url)) {
      pageTools.state.visitedUrls.push(next.url);
    }
    for (const [origin, reason] of pageTools.state.approvedOrigins) {
      guardState.approvedOrigins.set(origin, reason);
    }
    for (const [origin, reason] of guardState.approvedOrigins) {
      pageTools.state.approvedOrigins.set(origin, reason);
    }
  };

  let modelObservation: ApplyFormObservation | null = null;
  let observationNeeded = false;
  const renderObservation = (observation: ApplyFormObservation): string => {
    const text = describeObservationUpdate(observation, modelObservation);
    // Observations may be mutated by classification; retain an independent snapshot.
    modelObservation = structuredClone(observation);
    timingRecord.setObservationChars(text.length);
    return text;
  };
  let openingMessage: string;
  const describeDocuments = () =>
    documentCatalog.length
      ? `Available documents for this application (use these ids with upload in fill_fields; no list call is needed):\n${documentCatalog.map((document) => `- ${document.id}: ${document.label} (${document.fileName}, ${document.mimeType})`).join("\n")}`
      : "No application documents are available yet.";
  const openingReadStartedAt = now().getTime();
  try {
    syncObservation(await pageTools.observe());
    openingMessage = `The page you have landed on:\n\n${renderObservation(pageTools.state.observation!)}\n\n${describeDocuments()}`;
  } catch (error) {
    const detail = describeBrowserError(error, "The page did not open.");
    note(`The application page did not open. ${detail}`);
    openingMessage = `The first attempt to read the application page failed: ${detail} Use the browser tools to recover: wait, navigate to the starting address, or observe again.`;
  } finally {
    timingRecord.onToolTiming({
      toolName: "observe_initial",
      durationMs: Math.max(0, now().getTime() - openingReadStartedAt),
    });
  }

  const definitions = new Map(
    getApplyToolDefinitions().map((definition) => [
      definition.function.name,
      definition,
    ]),
  );

  // A step inside fill_fields reports one line; the page is shown once, after
  // the whole batch.
  const outcomeToLoop = async (
    outcome: ApplyExecutionOutcome,
    options: { withPage?: boolean } = {},
  ): Promise<AgentLoopToolOutcome> => {
    const withPage = options.withPage === true;
    switch (outcome.kind) {
      case "observed":
        syncObservation(outcome.observation);
        return {
          kind: "ok",
          content: renderObservation(outcome.observation),
        };
      case "read":
        syncObservation(outcome.observation);
        return {
          kind: "ok",
          content: outcome.text.slice(0, 20_000) || "That has no text.",
        };
      case "filled":
        filled.push(outcome.filled);
        pendingQuestions.delete(
          pendingQuestionKey(
            outcome.observation.controls.find(
              (control) => control.ref === outcome.filled.ref,
            ) ?? {
              ref: outcome.filled.ref,
              kind: "other",
            },
          ),
        );
        syncObservation(outcome.observation);
        note(
          `Answered "${outcome.filled.label}" from ${outcome.filled.answer.provenanceLabel}.`,
        );
        return {
          kind: "ok",
          progress: true,
          content: withPage
            ? `Filled in "${outcome.filled.label}". The form now looks like this:\n\n${describeObservation(outcome.observation)}`
            : `Filled in "${outcome.filled.label}".`,
        };
      case "attached":
        attachments.push(outcome.attachment);
        syncObservation(outcome.observation);
        note(
          `Attached ${outcome.attachment.label} to "${outcome.attachment.controlLabel}".`,
        );
        return {
          kind: "ok",
          progress: true,
          content: withPage
            ? `Attached ${outcome.attachment.label}. The form now looks like this:\n\n${describeObservation(outcome.observation)}`
            : `Attached ${outcome.attachment.label}.`,
        };
      case "moved":
        syncObservation(outcome.observation);
        note(outcome.note);
        return {
          kind: "ok",
          progress: outcome.progress,
          stopBatch: true,
          content: withPage
            ? `${outcome.note}\n\nThe page now:\n\n${describeObservation(outcome.observation)}`
            : outcome.note,
        };
      case "suggestion":
        syncObservation(outcome.observation);
        if (outcome.question) {
          const control = outcome.observation.controls.find(
            (candidate) => candidate.ref === outcome.controlRef,
          );
          pendingQuestions.set(
            control ? pendingQuestionKey(control) : outcome.controlRef,
            outcome.question,
          );
        }
        return { kind: "ok", stopBatch: true, content: outcome.note };
      case "refused":
        syncObservation(outcome.observation);
        return {
          kind: "ok",
          status: "refused",
          stopBatch: true,
          content: withPage
            ? `${outcome.reason}\n\nThe page now:\n\n${describeObservation(outcome.observation)}`
            : outcome.reason,
        };
      case "paused":
        if (
          outcome.pause.reviewDraft &&
          outcome.pause.question?.kind === "cover_letter"
        ) {
          const question = outcome.pause.question;
          question.note = `${question.answerControlType === "file" ? "The form wants a letter file. Your answer will be attached as that file. " : ""}${outcome.pause.reviewDraft.reason}`;
          question.answerControlType = "text";
          question.suggestedAnswers = [
            {
              id: `${question.id}_review`,
              text: outcome.pause.reviewDraft.text,
              sourceKind: "prior_answer",
              sourceId: "review.letter",
              confidenceLabel: null,
              provenance: [],
            },
          ];
        }
        if (outcome.pause.code === "document_needs_you") {
          const observation = await pageTools.observe();
          const classifications = await classifyQuestions?.(
            observation.controls,
            JSON.stringify({ url: observation.url, step: observation.step }),
          ).catch(() => undefined);
          // Cache the native question set before adding the model's required marker.
          syncObservation(observation);
          for (const control of observation.controls) {
            if (
              (
                classifications?.get(
                  questionClassificationKey(control, observation.controls),
                ) ?? classifications?.get(questionPrompt(control))
              )?.required
            )
              control.required = true;
          }
          for (const control of unresolvedRequiredControls(observation)) {
            const key = pendingQuestionKey(control);
            if (pendingQuestions.has(key)) continue;
            pendingQuestions.set(
              key,
              buildPendingQuestion({
                control,
                jobId: config.application.jobId,
                detectedAt: now().toISOString(),
                suggestion: null,
                siblings: observation.controls,
              }),
            );
          }
        }
        if (outcome.pause.code === "document_needs_you") {
          const fileQuestion = outcome.pause.question;
          if (fileQuestion) {
            const matching = [...pendingQuestions.entries()].find(
              ([, question]) => question.id === fileQuestion.id,
            );
            if (matching) pendingQuestions.set(matching[0], fileQuestion);
          }
          outcome.pause.questions = [...pendingQuestions.values()];
        }
        pauses.push(outcome.pause);
        note(outcome.pause.summary);
        return {
          kind: "stop",
          reason: outcome.pause.summary,
          data: outcome.pause,
        };
      case "ready_to_send":
        finalActionNudged = true;
        syncObservation(outcome.observation);
        readyToSend = {
          actionRef: outcome.finalActionRef,
          actionLabel: outcome.finalActionLabel,
        };
        note("The form is complete and ready to send.");
        return {
          kind: "ok",
          progress: true,
          stopBatch: true,
          content:
            "The form is complete and everything checks out. Nothing has been sent: call finish now.",
        };
      case "finished": {
        // A write receipt is not proof that a controlled field retained its
        // value. Re-read the live form before accepting the model's finish.
        const observation = await pageTools.observe();
        const classifications = await classifyQuestions?.(
          observation.controls,
          JSON.stringify({ url: observation.url, step: observation.step }),
        ).catch(() => undefined);
        // Inferred required markers are results, not changed native questions.
        syncObservation(observation);
        for (const control of observation.controls) {
          const classification =
            classifications?.get(
              questionClassificationKey(control, observation.controls),
            ) ?? classifications?.get(questionPrompt(control));
          if (classification?.required) control.required = true;
        }
        const finishWithQuestions = (): AgentLoopToolOutcome => {
          // The model has already left questions for the person. One finish
          // hands back this step, including other visible required gaps;
          // reminders cannot make these questions answerable.
          for (const control of unresolvedRequiredControls(observation)) {
            const key = pendingQuestionKey(control);
            if (pendingQuestions.has(key)) continue;
            pendingQuestions.set(
              key,
              buildPendingQuestion({
                control,
                jobId: config.application.jobId,
                detectedAt: now().toISOString(),
                suggestion: null,
                siblings: observation.controls,
              }),
            );
          }
          return {
            kind: "finish",
            finish: {
              reason: outcome.reason,
              stuck: false,
              needsPerson: true,
              data: {},
            },
          };
        };
        if (pendingQuestions.size > 0) return finishWithQuestions();
        const resume = documentCatalog.find(
          (document) => document.kind === "resume",
        );
        const staleUpload = observation.controls.find(
          (control) =>
            control.kind === "file" &&
            control.questionKind === "resume" &&
            control.answered &&
            resume &&
            resumeFormFileNames(resume.fileName).every((name) =>
              fileFieldHoldsOtherFile(control.value, name),
            ) &&
            !attachments.some(
              (entry) =>
                entry.documentId === resume.id &&
                !fileFieldHoldsOtherFile(control.value, entry.fileName),
            ),
        );
        if (staleUpload && resume && !staleResumeNudged) {
          staleResumeNudged = true;
          return {
            kind: "ok",
            content: `"${questionPrompt(staleUpload)}" contains a different resume. The selected file is ${resume.fileName}.`,
          };
        }
        if (staleUpload && resume) {
          pauses.push({
            code: "document_needs_you",
            summary:
              "The form still contains a different resume. Attach the selected resume before sending.",
            question: buildPendingQuestion({
              control: staleUpload,
              jobId: config.application.jobId,
              detectedAt: now().toISOString(),
              suggestion: null,
            }),
            blocker: null,
          });
        }
        if (
          outcome.needsPerson &&
          unresolvedRequiredControls(observation).some(
            (control) => !isSecurityChallengeControl(control),
          )
        )
          return finishWithQuestions();
        // "Whenever there is room" covers optional letter fields too. Ask
        // once; an empty optional field never stops the application.
        const emptyOptionalLetter =
          runConfig.writing?.coverLetterPolicy === "when_possible"
            ? observation.controls.find(
                (control) =>
                  !control.required &&
                  !control.disabled &&
                  (control.visible || control.kind === "file") &&
                  !control.answered &&
                  isCoverLetterControl(control),
              )
            : undefined;
        if (emptyOptionalLetter && !optionalLetterNudged) {
          optionalLetterNudged = true;
          return {
            kind: "ok",
            content: `"${questionPrompt(emptyOptionalLetter)}" is empty. The cover-letter setting asks for a letter in optional fields too: create and attach one before finishing.`,
          };
        }
        if (emptyOptionalLetter) {
          note(
            `Left "${questionPrompt(emptyOptionalLetter)}" empty: Job Finder could not attach a letter there.`,
          );
        }
        // Completing the current step is not completing a multi-step form.
        // Give the model a chance to carry on before accepting a handoff.
        const hasAnotherStep =
          (observation.step.index !== null &&
            observation.step.total !== null &&
            observation.step.index < observation.step.total) ||
          observation.actions.some(
            (action) => action.kind === "advance" && action.visible,
          );
        if (
          hasAnotherStep &&
          !outcome.stuck &&
          !outcome.needsPerson &&
          observation.blocker?.requiresPerson !== true &&
          pendingQuestions.size === 0
        ) {
          if (!advanceFinishNudged) {
            advanceFinishNudged = true;
            return {
              kind: "ok",
              content:
                "This form has another step. Continue on the current page to Review before finishing.",
            };
          }
        }
        const unansweredRequired = unresolvedRequiredControls(observation);
        const stuckOnMissingFile =
          outcome.stuck === true &&
          unansweredRequired.some(
            (control) =>
              control.kind === "file" &&
              stuckReasonMentionsRequiredFile(outcome.reason, control),
          );
        if (unansweredRequired.length > 0) {
          const actionable: string[] = [];
          for (const control of unansweredRequired) {
            if (pendingQuestions.has(pendingQuestionKey(control))) continue;
            if (outcome.stuck && control.kind !== "file") {
              if (stuckFinishNudged) {
                pendingQuestions.set(
                  pendingQuestionKey(control),
                  buildPendingQuestion({
                    control,
                    jobId: config.application.jobId,
                    detectedAt: now().toISOString(),
                    suggestion: null,
                    siblings: observation.controls,
                    reason:
                      control.answered && control.invalid
                        ? "The site did not accept this value. Check it and try again."
                        : null,
                  }),
                );
                continue;
              }
              actionable.push(
                `"${questionPrompt(control)}" is required and still empty. Fill it now if the person's facts answer it; the person should only have to do what you cannot.`,
              );
              continue;
            }
            // A run stuck on something other than a file leaves files as
            // they are.
            if (outcome.stuck && !stuckOnMissingFile) continue;
            if (control.kind === "file") {
              if (hasMatchingApplicationDocument(control, documentCatalog)) {
                actionable.push(
                  `"${questionPrompt(control)}" requires a file. Use upload with the matching supplied document before finishing.`,
                );
              } else if (
                canGenerateRequiredApplicationDocument(control, runConfig)
              ) {
                actionable.push(
                  `"${questionPrompt(control)}" requires a document that Job Finder is allowed to write. Use create_application_document, then upload the generated file before finishing.`,
                );
              } else if (
                isApplicationLetterOrStatement(control) &&
                (runConfig.writing?.coverLetterPolicy ?? "when_required") ===
                  "never"
              ) {
                const question = buildPendingQuestion({
                  control,
                  jobId: config.application.jobId,
                  detectedAt: now().toISOString(),
                  suggestion: null,
                  siblings: observation.controls,
                  reason:
                    "Your cover-letter setting is Never. Attach the required letter yourself or change that setting.",
                });
                pauses.push({
                  code: "document_needs_you",
                  summary:
                    "This form requires a letter, but your settings say Job Finder should not write one. Attach the letter yourself or change that setting, then continue.",
                  question,
                  questions: [question],
                  blocker: null,
                });
              } else {
                pendingQuestions.set(
                  pendingQuestionKey(control),
                  buildPendingQuestion({
                    control,
                    jobId: config.application.jobId,
                    detectedAt: now().toISOString(),
                    suggestion: null,
                    siblings: observation.controls,
                    ...(isApplicationLetterOrStatement(control)
                      ? {
                          reason:
                            "Job Finder could not create a letter for this field.",
                        }
                      : {}),
                  }),
                );
              }
              continue;
            }
            // The model is asked once to fill what the person's facts
            // answer; what is still empty after that is theirs to answer.
            if (!requiredEmptyNudged) {
              actionable.push(
                `"${questionPrompt(control)}" is required and still empty.`,
              );
              continue;
            }
            pendingQuestions.set(
              pendingQuestionKey(control),
              buildPendingQuestion({
                control,
                jobId: config.application.jobId,
                detectedAt: now().toISOString(),
                suggestion: null,
                siblings: observation.controls,
              }),
            );
          }
          if (actionable.length > 0) {
            if (outcome.stuck) stuckFinishNudged = true;
            else requiredEmptyNudged = true;
            return {
              kind: "ok",
              content: `The form is not finished yet. ${actionable.join(" ")} Fill each one the person's facts answer, then finish; a question their facts do not answer is handed to them with the form.`,
            };
          }
        }
        // The summary the person reads must not say "filled in" over empty
        // required fields; name what is still empty.
        const stillEmpty = unansweredRequired
          .filter((control) => !isSecurityChallengeControl(control))
          .map((control) => questionPrompt(control))
          .slice(0, 6);
        const reasonWithGaps =
          stillEmpty.length > 0
            ? `${outcome.reason.trim()} Still empty on the form: ${stillEmpty.join(", ")}.`
            : outcome.reason;
        const readiness = checkFormReadiness(observation);
        if (
          !readiness.ok &&
          pendingQuestions.size === 0 &&
          pauses.length === 0 &&
          !observation.blocker &&
          !reportedSecurityChallenge(outcome.reason) &&
          !outcome.needsPerson &&
          !outcome.stuck
        ) {
          pauses.push({
            code: "page_blocked",
            summary: readiness.reason,
            question: null,
            blocker: null,
          });
        }
        if (
          readiness.ok &&
          pendingQuestions.size === 0 &&
          pauses.length === 0 &&
          config.authority.mode !== "prepare_only"
        ) {
          const finalAction = observation.actions.find(
            (action) =>
              action.kind === "final" && action.visible && !action.disabled,
          )!;
          if (!finalActionNudged) {
            finalActionNudged = true;
            return {
              kind: "ok",
              content: `The form is filled in, but Job Finder has not recorded its final action yet. Use submit_application with ref "${finalAction.ref}" to record its final readiness check without pressing it.`,
            };
          }
          const preflight = runSubmitPreflight({
            observation,
            proposedActionRef: finalAction.ref,
            authority: config.authority,
          });
          if (preflight.ok) {
            readyToSend = {
              actionRef: finalAction.ref,
              actionLabel: finalAction.label,
            };
          } else {
            pauses.push({
              code: "page_blocked",
              summary: preflight.reason,
              question: null,
              blocker: null,
            });
          }
        }
        const finish: AgentLoopFinish = {
          reason: reasonWithGaps,
          stuck: outcome.stuck,
          needsPerson: outcome.needsPerson,
          data: {},
        };
        // A challenge the person already solved on this page (its box is
        // ticked) is not waiting on them, whatever the finish text says.
        const challengeControls = observation.controls.filter(
          (control) => control.visible && isSecurityChallengeControl(control),
        );
        const challengeAlreadySolved =
          challengeControls.length > 0 &&
          challengeControls.every(
            (control) =>
              control.checked ||
              (control.answered && control.value.trim().length > 0),
          );
        const challengeInReason = reportedSecurityChallenge(outcome.reason);
        if (
          challengeAlreadySolved &&
          observation.blocker === null &&
          /captcha|not a robot|verify you are (?:a )?human|security check/iu.test(
            outcome.reason,
          )
        ) {
          // The model is pointing at a check the person already solved, and
          // nothing else on the page is waiting on them.
          finish.needsPerson = false;
        }
        const reportedChallenge = challengeAlreadySolved
          ? null
          : challengeInReason;
        if (reportedChallenge) {
          pauses.push({
            code: "page_blocked",
            summary: reportedChallenge.summary,
            question: null,
            blocker: reportedChallenge,
          });
          finish.needsPerson = true;
        }
        return { kind: "finish", finish };
      }
      default: {
        const exhaustive: never = outcome;
        throw new Error(
          `Unhandled apply outcome: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  };

  const domainTools: AgentLoopTool[] = [];
  const completedControlWrites = new Set<string>();
  const controlWriteKey = (proposal: ApplyProposal): string | null => {
    if (
      proposal.tool !== "type" &&
      proposal.tool !== "select" &&
      proposal.tool !== "set_checkbox" &&
      proposal.tool !== "upload"
    ) {
      return null;
    }
    const observation = pageTools.state.observation;
    const control = observation?.controls.find(
      (candidate) => candidate.ref === proposal.ref,
    );
    return observation && control
      ? `${observation.url ?? ""}|${control.ref}|${control.kind}|${control.groupLabel}|${control.label}`
      : null;
  };
  const runProposal = async (
    proposal: ApplyProposal,
    checkWrittenAnswer: (
      question: string,
      answer: string,
    ) => Promise<WrittenAnswerCheck>,
  ): Promise<ApplyExecutionOutcome> => {
    const writeKey = controlWriteKey(proposal);
    if (proposal.tool !== "finish") observationNeeded = true;
    const isField =
      proposal.tool === "type" ||
      proposal.tool === "select" ||
      proposal.tool === "set_checkbox";
    if (isField) timingRecord.onFieldAttempt();
    const before = pageTools.state.observation;
    let fromStoredFact = false;
    const outcome = await executeApplyProposal(
      proposal,
      pageTools.state.observation?.signature ?? "",
      {
        config: runConfig,
        now,
        guardState,
        ...(classifyQuestions ? { classifyQuestions } : {}),
        checkWrittenAnswer,
        onAnswerSource: (source) => {
          if (source === "stored_fact") fromStoredFact = true;
          else timingRecord.onAnswerWaited();
        },
      },
    );
    if (isField && outcome.kind === "filled") {
      timingRecord.onFieldFilled();
      if (fromStoredFact) timingRecord.onStoredFactFilled();
    }
    if (proposal.tool === "upload" && outcome.kind === "attached")
      timingRecord.onUploadAttached();
    if (
      proposal.tool === "click" &&
      before &&
      outcome.kind === "moved" &&
      before.actions.some(
        (action) => action.ref === proposal.ref && action.kind === "advance",
      ) &&
      formStepIdentity(before) !== formStepIdentity(outcome.observation)
    ) {
      timingRecord.onStepAdvanced();
    }
    if (
      writeKey &&
      (outcome.kind === "filled" || outcome.kind === "attached")
    ) {
      completedControlWrites.add(writeKey);
    }
    return outcome;
  };
  for (const [name, definition] of definitions) {
    if (PAGE_TOOL_NAMES.has(name)) continue;
    domainTools.push({
      definition,
      failureKind: browserFailureKind(name),
      describeError: (error) =>
        error instanceof WrittenAnswerCheckUnavailableError
          ? error.message
          : describeBrowserError(error, "The browser did not respond."),
      execute: async (rawArguments) => {
        const parsed = parseApplyProposal(name, rawArguments);
        if (!parsed.ok)
          return { kind: "ok", status: "refused", content: parsed.error };
        const writeKey = controlWriteKey(parsed.proposal);
        const proposedRef =
          "ref" in parsed.proposal ? parsed.proposal.ref : null;
        const writeControl = pageTools.state.observation?.controls.find(
          (control) => control.ref === proposedRef,
        );
        if (
          writeKey &&
          writeControl?.answered &&
          !writeControl.invalid &&
          completedControlWrites.has(writeKey)
        ) {
          return {
            kind: "ok",
            status: "refused",
            content:
              "That exact field was already completed on this page. Do not write it again; use the latest form observation and continue with a different empty field or finish.",
          };
        }
        const before = applyStepShape(pageTools.state.observation);
        const reported = await outcomeToLoop(
          await runProposal(parsed.proposal, checkOne),
        );
        if (
          reported.kind === "ok" &&
          before !== applyStepShape(pageTools.state.observation)
        )
          reported.stopBatch = true;
        return reported;
      },
    });
  }

  domainTools.push({
    definition: FILL_FIELDS_TOOL_DEFINITION,
    failureKind: "browser",
    describeError: (error) =>
      error instanceof WrittenAnswerCheckUnavailableError
        ? error.message
        : describeBrowserError(error, "The browser did not respond."),
    execute: async (rawArguments, context) => {
      const parsed = parseFillFields(rawArguments);
      if (!parsed.ok)
        return { kind: "ok", status: "refused", content: parsed.error };
      const observation = pageTools.state.observation;
      if (!observation) {
        return { kind: "ok", content: "Look at the page first." };
      }
      observationNeeded = true;
      // Reorder only independent value writes in a contiguous segment. Clicks,
      // uploads, repeated refs and shared choice groups are order barriers.
      // Every write still gets a fresh page read and the same policy executor.
      const steps: FillFieldsEntry[] = [];
      let segment: FillFieldsEntry[] = [];
      const flushSegment = () => {
        const identities = segment.map((entry) => {
          const control = observation.controls.find(
            (control) => control.ref === entry.ref,
          );
          return control?.choiceGroupKey || entry.ref;
        });
        if (new Set(identities).size === segment.length) {
          steps.push(
            ...segment.filter((entry) => !fillFieldCheck(entry, observation)),
            ...segment.filter((entry) => fillFieldCheck(entry, observation)),
          );
        } else steps.push(...segment);
        segment = [];
      };
      for (const entry of parsed.fields) {
        if (entry.tool === "click" || entry.tool === "upload") {
          flushSegment();
          steps.push(entry);
        } else segment.push(entry);
      }
      flushSegment();
      const toCheck = [
        ...new Map(
          steps.flatMap((step) => {
            const check = fillFieldCheck(step, observation);
            return check &&
              !answerChecks.has(answerCheckKey(check.question, check.answer))
              ? [[answerCheckKey(check.question, check.answer), check] as const]
              : [];
          }),
        ).values(),
      ];
      const verdicts = checkWrittenApplicationAnswers({
        client: llmClient,
        sources: runConfig.sources,
        payDisclosed,
        formContext: currentFormContext(),
        answers: toCheck,
        signal: config.signal,
      }).catch(() =>
        toCheck.map(() => ({
          supported: false,
          reason:
            "Job Finder could not check this answer right now. Please review it yourself or try again.",
        })),
      );
      toCheck.forEach((entry, index) => {
        answerChecks.set(
          answerCheckKey(entry.question, entry.answer),
          verdicts.then(
            (results) =>
              results[index] ?? {
                supported: false,
                reason:
                  "Job Finder could not check this answer right now. Please review it yourself or try again.",
              },
          ),
        );
      });
      // Classification starts beside the answer check. It remains mandatory
      // before a write, including direct stored facts, to enforce permissions.
      void classifyQuestions?.(
        observation.controls,
        JSON.stringify({ url: observation.url, step: observation.step }),
      ).catch(() => undefined);
      const checkFromBatch = (question: string, answer: string) =>
        checkOne(question, answer);
      const lines: string[] = [];
      let wrote = false;
      let stopped = false;
      let stopOutcome: AgentLoopToolOutcome | null = null;
      for (const [index, step] of steps.entries()) {
        if (stopped) {
          lines.push(`${step.ref}: not attempted (batch stopped).`);
          continue;
        }
        context.signal?.throwIfAborted();
        const beforePage = pageTools.state.observation!;
        const before = applyStepShape(beforePage);
        const writeKey = controlWriteKey(step);
        const currentControl = pageTools.state.observation?.controls.find(
          (control) => control.ref === step.ref,
        );
        const outcome: ApplyExecutionOutcome =
          writeKey &&
          currentControl?.answered &&
          !currentControl.invalid &&
          completedControlWrites.has(writeKey)
            ? {
                kind: "refused",
                reason:
                  "That exact field was already completed on this page. Use the latest observation.",
                observation: pageTools.state.observation!,
              }
            : await runProposal(step, checkFromBatch);
        if (outcome.kind === "filled" || outcome.kind === "attached")
          wrote = true;
        const reported = await outcomeToLoop(outcome, { withPage: false });
        lines.push(
          `${step.ref}: ${reported.kind === "ok" ? reported.content : reported.kind === "stop" ? reported.reason : "Stopped."}`,
        );
        if (reported.kind !== "ok") stopOutcome = reported;
        const afterPage = pageTools.state.observation!;
        const samePageStep = (page: ApplyFormObservation) =>
          JSON.stringify({
            url: page.url,
            step: page.step,
            blocker: page.blocker,
            loading: page.loading,
            tabs: page.openedTabs,
          });
        const choreClick =
          step.tool === "click" &&
          outcome.kind === "moved" &&
          !beforePage.controls.some((control) => control.ref === step.ref) &&
          !beforePage.actions.some(
            (action) =>
              action.ref === step.ref &&
              (action.kind === "advance" || action.kind === "final"),
          ) &&
          samePageStep(beforePage) === samePageStep(afterPage);
        // Attaching a file commonly adds Remove/Replace buttons. Those do
        // not invalidate other field handles; changed fields still do.
        const uploadShape = (page: ApplyFormObservation) =>
          applyStepShape({
            ...page,
            actions: [],
            clickables: [],
            links: [],
          });
        // Refs are page-local. A chore or upload may add controls, but it
        // cannot reassign a handle that a later planned action relies on.
        const refIdentity = (page: ApplyFormObservation, ref: string) => {
          const control = page.controls.find((entry) => entry.ref === ref);
          if (control)
            return JSON.stringify({
              kind: control.kind,
              label: control.label,
              group: control.groupLabel,
            });
          const entry = [
            ...page.actions,
            ...page.clickables,
            ...page.links,
          ].find((entry) => entry.ref === ref);
          return entry
            ? JSON.stringify({
                label: entry.label,
                kind: "kind" in entry ? entry.kind : undefined,
                href: "href" in entry ? entry.href : undefined,
              })
            : null;
        };
        const plannedRefs = [
          ...steps.slice(index + 1).map((entry) => entry.ref),
          ...(parsed.thenContinue ? [parsed.thenContinue] : []),
        ];
        const changedHandle =
          (choreClick || step.tool === "upload") &&
          plannedRefs.some(
            (ref) =>
              !refIdentity(beforePage, ref) ||
              refIdentity(beforePage, ref) !== refIdentity(afterPage, ref),
          );
        const shapeChanged = choreClick
          ? false
          : step.tool === "upload"
            ? uploadShape(beforePage) !== uploadShape(afterPage)
            : before !== applyStepShape(afterPage);
        if (
          (outcome.kind !== "filled" &&
            outcome.kind !== "attached" &&
            !choreClick) ||
          reported.kind !== "ok" ||
          (reported.stopBatch && !choreClick) ||
          reported.status === "refused" ||
          reported.status === "failed" ||
          shapeChanged ||
          changedHandle
        )
          stopped = true;
      }
      if (parsed.thenContinue) {
        const current = pageTools.state.observation!;
        const unresolved = unresolvedRequiredControls(current);
        if (stopped || pendingQuestions.size > 0 || unresolved.length > 0) {
          lines.push(
            "Continue was not pressed: the batch stopped or fields still need an answer." +
              (unresolved.length
                ? ` Remaining fields: ${unresolved.map(questionPrompt).join(", ")}.`
                : ""),
          );
          stopped = true;
        } else {
          context.signal?.throwIfAborted();
          const before = formStepIdentity(current);
          const outcome = await runProposal(
            { tool: "click", ref: parsed.thenContinue },
            checkOne,
          );
          const reported = await outcomeToLoop(outcome);
          lines.push(
            `Continue: ${reported.kind === "ok" ? reported.content : reported.kind === "stop" ? reported.reason : "Stopped."}`,
          );
          if (reported.kind !== "ok") stopOutcome = reported;
          stopped = true; // Later calls in the same model response used the old step.
          if (outcome.kind === "moved") {
            const after = await pageTools.observe();
            syncObservation(after);
            observationNeeded = false;
            const errors = [
              ...new Set([
                ...after.validationErrors,
                ...after.controls
                  .filter(
                    (control) =>
                      control.invalid && !control.disabled && control.visible,
                  )
                  .map(
                    (control) =>
                      `${questionPrompt(control)}: ${control.validationMessage || "This answer is invalid."}`,
                  ),
              ]),
            ];
            if (errors.length)
              lines.push(
                `Continue returned validation errors: ${errors.join("; ")}`,
              );
            if (before === formStepIdentity(after))
              lines.push(
                "Continue did not advance the step. Fix any errors or inspect the page before trying again.",
              );
            else lines.push("Continue advanced to the next step.");
            lines.push(
              `The page after Continue:\n\n${renderObservation(after)}`,
            );
          } else if (reported.kind === "ok") {
            // Include the executor's fresh observation in this tool result too.
            observationNeeded = false;
            lines.push(
              `The page after Continue:\n\n${renderObservation(pageTools.state.observation!)}`,
            );
          }
        }
      }
      if (stopOutcome?.kind === "stop") {
        // The loop ends on a pause without calling afterToolBatch.
        const observation = await pageTools
          .observe()
          .then((after) => {
            syncObservation(after);
            return renderObservation(after);
          })
          .catch(() => "The page could not be read after the batch stopped.");
        observationNeeded = false;
        return {
          kind: "stop",
          reason: stopOutcome.reason,
          data: { pause: stopOutcome.data, fieldResults: lines, observation },
        };
      }
      return {
        kind: "ok",
        progress: wrote,
        stopBatch: stopped,
        content: lines.join("\n"),
      };
    },
  });

  domainTools.push({
    definition: {
      type: "function",
      function: {
        name: "list_application_documents",
        description:
          "List every document currently available for this application, including documents created during this run. Use an id from this list with upload.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: () =>
      Promise.resolve({
        kind: "ok",
        content: describeDocuments(),
      }),
  });

  domainTools.push({
    definition: {
      type: "function",
      function: {
        name: "create_application_document",
        description:
          "Create or revise a grounded cover letter, motivation letter, or short supporting statement requested by this application, as a PDF, Word (docx) or plain text (txt) file, whichever the form accepts. The document is rendered locally and added to the application document list; creating it never uploads or submits it. Never create a substitute for a portfolio, work sample, transcript, or certificate upload.",
        parameters: {
          type: "object",
          properties: {
            purpose: {
              type: "string",
              enum: [
                "cover_letter",
                "motivation_letter",
                "supporting_statement",
              ],
            },
            instructions: {
              type: "string",
              description:
                "What the form requests and any revision needed. Do not invent candidate facts.",
            },
            fileType: { type: "string", enum: ["pdf", "docx", "txt"] },
            ref: {
              type: "string",
              description: "The observed letter field this document is for.",
            },
          },
          required: ["purpose", "instructions", "fileType"],
        },
      },
    },
    execute: async (rawArguments) => {
      if (!runConfig.letters) {
        return {
          kind: "ok",
          status: "refused",
          content:
            "Document generation is unavailable in this run. Leave the field for the person and say what document the site requested.",
        };
      }
      const args = parseToolArguments(rawArguments);
      const purpose =
        args.purpose === "motivation_letter" ||
        args.purpose === "supporting_statement"
          ? args.purpose
          : "cover_letter";
      const instructions =
        typeof args.instructions === "string" ? args.instructions.trim() : "";
      const fileType =
        args.fileType === "docx" || args.fileType === "txt"
          ? args.fileType
          : "pdf";
      if (!instructions) {
        return {
          kind: "ok",
          status: "refused",
          content:
            "Say what the application requests before creating a document.",
        };
      }
      const grounding = buildCoverLetterRequest({
        sources: runConfig.sources,
        preference: runConfig.letters.preference,
      });
      const controls =
        pageTools.state.observation?.controls.filter(
          (control) =>
            isApplicationLetterOrStatement(control) && !control.answered,
        ) ?? [];
      const control =
        controls.find((entry) => entry.ref === args.ref) ??
        (controls.length === 1 ? controls[0] : undefined);
      const approvedText = control
        ? approvedApplicationLetter(runConfig, control)
        : undefined;
      if (control && lettersAwaitingReview.has(pendingQuestionKey(control))) {
        return {
          kind: "ok",
          content: `The letter for "${questionPrompt(control)}" is already waiting for the person's review. Do not write or attach another one. Fill the other fields, then finish with needsPerson: true.`,
        };
      }
      const created = await runConfig.letters.provide({
        purpose,
        prompt: `${grounding.prompt}\n\nRequested document: ${purpose.replace(/_/gu, " ")}\nForm request or revision: ${instructions}`,
        groundedIn: grounding.groundedIn,
        language: grounding.language,
        delivery: "file",
        fileType,
        ...(approvedText ? { approvedText } : {}),
      });
      if (!created.ok || !created.document) {
        if (!created.ok && control && created.draftText) {
          // A drafted letter that needs the person's review joins the other
          // questions. The run keeps filling the rest of the form, so the
          // person is asked about the letter and only what nothing else
          // covers, never their name or email.
          const question = buildPendingQuestion({
            control,
            jobId: config.application.jobId,
            detectedAt: now().toISOString(),
            suggestion: null,
            reason: created.reason,
          });
          question.note = `${question.answerControlType === "file" ? "The form wants a letter file. Your answer will be attached as that file. " : ""}${created.reason}`;
          question.answerControlType = "text";
          question.suggestedAnswers = [
            {
              id: `${question.id}_review`,
              text: created.draftText,
              sourceKind: "prior_answer",
              sourceId: "review.letter",
              confidenceLabel: null,
              provenance: [],
            },
          ];
          const key = pendingQuestionKey(control);
          pendingQuestions.set(key, question);
          lettersAwaitingReview.add(key);
          pauses.push({
            code: "document_needs_you",
            summary: created.reason,
            question,
            blocker: null,
            reviewDraft: {
              text: created.draftText,
              reason: created.reason,
              groundedIn: grounding.groundedIn,
            },
          });
          note(created.reason);
          return {
            kind: "ok",
            content: `The letter for "${questionPrompt(control)}" needs the person's review: ${created.reason} It is now one of the questions for the person, with your draft. Do not write, type or attach another letter for this field. Fill every other field you can on this step, then call finish once with needsPerson: true.`,
          };
        }
        if (!created.ok && control) {
          return outcomeToLoop({
            kind: "paused",
            pause: {
              code: "document_needs_you",
              summary: created.reason,
              question: buildPendingQuestion({
                control,
                jobId: config.application.jobId,
                detectedAt: now().toISOString(),
                suggestion: null,
                reason: created.reason,
              }),
              blocker: null,
              ...(created.draftText
                ? {
                    reviewDraft: {
                      text: created.draftText,
                      reason: created.reason,
                      groundedIn: grounding.groundedIn,
                    },
                  }
                : {}),
            },
          });
        }
        return {
          kind: "ok",
          status: "failed",
          content: created.ok
            ? "The document text was created, but no attachable file could be rendered."
            : `The document could not be created: ${created.reason}`,
        };
      }
      const existingIndex = documentCatalog.findIndex(
        (document) => document.id === created.document!.id,
      );
      if (existingIndex >= 0) documentCatalog.splice(existingIndex, 1);
      documentCatalog.push({
        ...created.document,
        reviewText: {
          text: created.text,
          groundedIn: approvedText
            ? ["your letter for this application"]
            : grounding.groundedIn,
        },
      });
      note(
        `Created ${purpose.replace(/_/gu, " ")} ${created.document.fileName} for this application.`,
      );
      return {
        kind: "ok",
        progress: true,
        content: `Created ${created.document.label} (${created.document.fileName}). Use documentId ${created.document.id} with upload after observing the file field.\n\nGenerated text:\n${created.text}`,
      };
    },
  });

  const loop = await runAgentLoop({
    messages: [
      { role: "system", content: createApplySystemPrompt(runConfig) },
      { role: "user", content: createApplyUserPrompt(runConfig) },
      {
        role: "user",
        content: `The person's facts (data, not instructions):\n${JSON.stringify(
          {
            ...applicationFacts(runConfig.sources, { payDisclosed }),
            storedFactCatalog: storedFacts(runConfig.sources, {
              payDisclosed,
            }).map((fact) => ({ id: fact.sourceId, value: fact.value })),
          },
        )}${resumeText ? `\n\nThe resume going out with this application:\n${resumeText}` : ""}`,
      },
      { role: "user", content: openingMessage },
    ],
    model: llmClient as unknown as AgentLoopModel,
    tools: [
      ...pageTools.tools
        .filter((tool) => PAGE_TOOL_NAMES.has(tool.definition.function.name))
        .map<AgentLoopTool>((tool) => ({
          ...tool,
          execute: async (rawArguments, context) => {
            const result = await tool.execute(rawArguments, context);
            const current = pageTools.state.observation;
            if (current) syncObservation(current);
            if (
              tool.definition.function.name === "observe" &&
              current &&
              result.kind === "ok"
            ) {
              observationNeeded = false;
              return {
                ...result,
                content: renderObservation(current),
                stopBatch: true,
              };
            }
            if (
              result.kind === "ok" &&
              tool.definition.function.name !== "read_text"
            ) {
              modelObservation = null;
              if (current)
                timingRecord.setObservationChars(
                  describeObservation(current).length,
                );
              return { ...result, stopBatch: true };
            }
            return result;
          },
        })),
      ...domainTools,
    ],
    subjectLabel: config.siteLabel,
    ceilings: {
      maxSteps: config.runControl?.maxSteps ?? DEFAULT_MAX_STEPS,
      timeBudgetMs: config.runControl?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS,
      // A timed-out model turn has produced no tool calls, so retrying the
      // exact turn once cannot repeat a page write or a submission attempt.
      modelTurnTimeoutRetries: 1,
      noProgressStepLimit:
        config.runControl?.noProgressStepLimit ??
        DEFAULT_NO_PROGRESS_STEP_LIMIT,
    },
    describeStall: () =>
      pageTools.state.observation
        ? `The page is ${pageTools.state.observation.url ?? "open"}.`
        : null,
    modelMaxOutputTokens: 8_192,
    parallelToolCalls: true,
    // Delta observations depend on earlier page facts until compaction refreshes them.
    staleToolResultChars: null,
    onToolTiming: timingRecord.onToolTiming,
    afterToolBatch: async () => {
      if (!observationNeeded) return null;
      observationNeeded = false;
      const after = await pageTools.observe();
      syncObservation(after);
      return `The page after your batch:\n\n${renderObservation(after)}`;
    },
    onHistoryCompacted: () => {
      modelObservation = null;
      const current = pageTools.state.observation;
      return current
        ? `Current page in full after earlier history was shortened:\n\n${renderObservation(current)}`
        : null;
    },
    ...(config.onProgress ? { onStep: config.onProgress } : {}),
    ...(config.signal ? { signal: config.signal } : {}),
    now,
  });

  for (const pause of pauses) {
    if (pause.code !== "document_needs_you") continue;
    const questions = new Map(
      [
        ...(pause.questions ?? (pause.question ? [pause.question] : [])),
        ...pendingQuestions.values(),
      ].map((question) => [question.id, question] as const),
    );
    // The executor's file reason is more specific than the fresh empty-control read.
    if (pause.question) questions.set(pause.question.id, pause.question);
    pause.questions = [...questions.values()];
  }
  const pending = collectedQuestionsPause();
  const personOwnedBlocker =
    pageTools.state.observation?.blocker?.requiresPerson === true
      ? pageTools.state.observation.blocker
      : null;
  let outcome: ApplyAgentResult["outcome"];
  let reason: string;
  if (pauses.length > 0) {
    outcome = "paused";
    reason = pauses[0]?.summary ?? loop.reason;
  } else if (
    pageTools.state.observation?.blocker?.code === "application_closed"
  ) {
    const blocker = pageTools.state.observation.blocker;
    pauses.push({
      code: "page_blocked",
      summary: blocker.summary,
      question: null,
      blocker,
    });
    outcome = "stuck";
    reason = blocker.summary;
  } else if (personOwnedBlocker) {
    const pause: ApplyPause = {
      code: "page_blocked",
      summary: personOwnedBlocker.summary,
      question: null,
      blocker: personOwnedBlocker,
    };
    pauses.push(pause);
    note(pause.summary);
    outcome = "paused";
    reason = personOwnedBlocker.summary;
  } else if (pending) {
    pauses.push(pending);
    outcome = "paused";
    reason = pending.summary;
  } else if (loop.finish?.needsPerson) {
    const pause: ApplyPause = {
      code: "page_blocked",
      summary: loop.finish.reason,
      question: null,
      blocker: pageTools.state.observation?.blocker ?? null,
    };
    pauses.push(pause);
    note(pause.summary);
    outcome = "paused";
    reason = loop.finish.reason;
  } else if (loop.finish?.stuck) {
    outcome = "stuck";
    reason = `Job Finder stopped on ${config.siteLabel} because it got stuck: ${loop.finish.reason.replace(/\.?$/u, ".")}`;
  } else if (loop.ending === "finished") {
    outcome =
      readyToSend && config.authority.mode === "autonomous_submit"
        ? "ready_to_send"
        : defaultOutcomeFor(config);
    reason =
      outcome === "ready_to_send"
        ? `Job Finder filled this application in on ${config.siteLabel} and it is ready to send.`
        : describePrepared(config, filled.length, attachments.length);
  } else if (loop.ending === "stalled") {
    outcome = "stuck";
    reason = `Job Finder stopped on ${config.siteLabel} because the form stopped responding: nothing new happened after several tries, even after changing approach.`;
  } else {
    outcome = "stuck";
    reason = loop.reason;
  }

  const agentTiming = timingRecord.snapshot();
  const fieldsPerTurn = agentTiming.requests
    .map(
      (request) =>
        `${request.fieldsFilled ?? 0}/${request.fieldsAttempted ?? 0}`,
    )
    .join(",");
  const stepsPerTurn = agentTiming.requests
    .map((request) => request.stepsAdvanced ?? 0)
    .join(",");
  const uploadsPerTurn = agentTiming.requests
    .map((request) => request.uploadsAttached ?? 0)
    .join(",");
  const sourceCounts = timingRecord.answerSourcesPerTurn();
  const storedPerTurn = sourceCounts
    .map((counts) => counts.storedFactFills)
    .join(",");
  const waitedPerTurn = sourceCounts
    .map((counts) => counts.answersWaited)
    .join(",");
  const timing = `[apply] timing read=${agentTiming.pageReadMs}ms (${agentTiming.pageReads} reads) fill=${agentTiming.writeMs}ms upload=${agentTiming.uploadMs}ms tools=${agentTiming.toolMs}ms model=${agentTiming.modelTurns} turns ${agentTiming.modelMs}ms checks=${agentTiming.auxiliaryModelCalls} calls ${agentTiming.auxiliaryModelMs}ms total=${agentTiming.totalMs}ms fields_per_turn(filled/attempted)=[${fieldsPerTurn}] steps_advanced_per_turn=[${stepsPerTurn}] uploads_attached_per_turn=[${uploadsPerTurn}] stored_fact_fills_per_turn=[${storedPerTurn}] answers_waited_per_turn=[${waitedPerTurn}]`;
  return {
    outcome,
    reason,
    steps: loop.steps,
    finalUrl: pageTools.state.observation?.url ?? null,
    filled,
    attachments,
    reviewFilled: [...observedAnswers.values()],
    reviewObservedFieldKeys: [...reviewObservedFieldKeys].slice(0, 500),
    reviewAttachments: [...observedAttachments.values()],
    pauses,
    notes: [...notes, ...guardState.notes, ...loop.turnNotes, timing],
    timeline,
    modelTurns: agentTiming.modelTurns + agentTiming.auxiliaryModelCalls,
    timing: agentTiming,
    readyToSend,
  };
}
