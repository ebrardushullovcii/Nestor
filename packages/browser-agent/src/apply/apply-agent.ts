import { traceOurs, traceEvent, runTraceEnabled } from "@nestor/core/run-trace";
import {
  parseToolArguments,
  runAgentLoop,
  type AgentLoopFinish,
  type AgentLoopModel,
  type AgentLoopResult,
  type AgentLoopTool,
  type AgentLoopToolOutcome,
} from "@nestor/agent-runtime";
import {
  describeBrowserError,
  intendedAccountEmail,
  resumeFormFileNames,
  type ApplicationAttemptQuestion,
  type ApplyFormPathStep,
} from "@nestor/contracts";
import { createHash } from "node:crypto";
import { meaningHash, meaningTargetHash } from "./answer-meaning";
import { answerSourceCatalog } from "./answer-source-catalog";
import { createApplyProgressGuard } from "./apply-progress";
import { createApplyTiming } from "./apply-timing";
import { manualEntryPressFor } from "./fill-presses";
import {
  localStepAdvanced,
  numberedStepAdvanced,
  UNCONFIRMED_STEP_LABEL,
} from "./local-step-preflight";
import { createApplyModelActivity } from "./model-activity";
import { questionLabel } from "./question-text";
import {
  createStepReceiptTracker,
  observedControlValue,
} from "./step-receipts";
import { TEXT_RETENTION_MS, textRetentionError } from "./text-retention";

import {
  formQuestionText,
  normalizeFormQuestionPrompt,
  preserveTechnologyTokens,
} from "@nestor/contracts";
import { withReasoningTask, type LLMClient } from "../agent/contracts";
import {
  browserInteractionKind,
  currentBrowserPermissions,
  googleIdentityContext,
  signInEntryActions,
  withBrowserPermissions,
} from "../browser-permission-policy";
import {
  googleSignInInteraction,
  isGoogleAccountPage,
} from "../google-sign-in";
import { createPageTools } from "../page-tools";
import { answerProposals } from "./answer-proposals";
import {
  applicationFacts,
  relevantSavedAnswers,
  savedAnswerForQuestion,
  serializeApplicationData,
} from "./application-facts";
import {
  applyStepShape,
  createApplySystemPrompt,
  createApplyUserPrompt,
  describeObservation,
  describeObservationUpdate,
} from "./apply-prompts";
import {
  FILL_FIELDS_TOOL_DEFINITION,
  getApplyToolDefinitions,
  parseApplyProposal,
  parseFillFields,
} from "./apply-tools";
import {
  isSecurityChallengeControl,
  reportedSecurityChallenge,
} from "./blockers";
import { isControlAnswered, normalizeSignal } from "./control-classification";
import {
  buildCoverLetterRequest,
  coverLetterPolicyAllows,
  isCoverLetterControl,
} from "./cover-letter";
import { fillMayOpen } from "./fill-presses";
import {
  nextPathStep,
  planReplay,
  replayedAnswer,
  replayStillCurrent,
  replayValueFitsControl,
  reviewFieldKey,
  screenKey,
  type ReplayWrite,
} from "./form-replay";
import { applicationModelFactsMessage } from "./model-facts";
import { savedPickerRule } from "./option-fallback";
import { formWritingInstructions, questionReadContext } from "./own-words";
import { compactApplyPageHistory } from "./page-history";
import {
  NATIONALITY_ANSWER_REASON,
  nationalityQuestionIdentity,
} from "./person-nationality";
import {
  applicationLetterRequest,
  approvedApplicationLetter,
  createApplyGuardState,
  executeApplyProposal,
  fileFieldHoldsOtherFile,
  fillStepPress,
  formSendPause,
  guardStop,
  buildPendingQuestion as makePendingQuestion,
  pickerQuestionKey,
  pressesFormButtons,
  pressOnSitePause,
  questionPrompt,
  unrecognizedSubmit,
  type ApplyExecutionOutcome,
} from "./policy-executor";
import {
  applicationQuestionClassificationContext,
  asksPayCurrency,
  createQuestionClassifier,
  modelQuestionKind,
  questionClassificationKey,
  QuestionReadUnavailableError,
} from "./question-classification";
import { createQuestionOccurrences } from "./question-occurrences";
import {
  checkFormReadiness,
  fileUploadProblems,
  hasRemainingApplicationStep,
  holdsAnswer,
  retainedForFormSubmission,
  runSubmitPreflight,
  STEP_HANDOVER_QUESTION_ID,
  unresolvedRequiredControls,
  UPLOAD_REPAIR_QUESTION_ID,
  type FileUploadProblem,
} from "./submit-preflight";
import type {
  ApplyAgentConfig,
  ApplyAgentResult,
  ApplyAttachedDocument,
  ApplyBlocker,
  ApplyDocument,
  ApplyFilledControl,
  ApplyFormControl,
  ApplyFormObservation,
  ApplyPause,
  ApplyProposal,
} from "./types";

/** Bind before the fresh finish read can change the page's control refs. */
function nativeFinishQuestion(
  item: string,
  observation: ApplyFormObservation | null,
  posting: ApplyAgentConfig["sources"]["posting"],
): string | string[] {
  const controls = (observation?.controls ?? []).filter(
    (control) => control.visible && !control.disabled,
  );
  // The tool parser groups overflow items with semicolons; preserve every
  // field's identity there too, rather than making an extra free-text task.
  const refs = item.split(";").map((ref) => ref.trim());
  const referenced = refs.map((ref) =>
    controls.find((control) => control.ref === ref),
  );
  if (referenced.some((control) => control !== undefined))
    return refs.map((ref, index) => {
      const control = referenced[index];
      return control ? questionPrompt(control) : ref;
    });

  // Compatibility with older finish messages that explicitly ask what value
  // to enter in a named field. Do not use a shared keyword as question identity.
  const request = item.match(
    /^(?:what|which)\s+(.+?)\s+(?:should|can|do)\s+(?:i|we)\s+(?:enter|put|provide|select|choose|use)\s+(?:in|into|for)\s+(?:(?:the|your|required|optional)\s+)*(.+?)\s+field(.*)$/iu,
  );
  const [, requested, label, suffix] = request ?? [];
  if (!requested || !label || suffix === undefined) return item;
  const words = (value: string) =>
    normalizeFormQuestionPrompt(preserveTechnologyTokens(value));
  const target = words(label);
  if (
    !target ||
    !` ${words(requested)} `.includes(` ${target} `) ||
    ![
      "",
      ...["your", "the"].flatMap((owner) => [
        `for ${owner} ${posting.title} application`,
        ...["to", "at", "with"].map(
          (preposition) =>
            `for ${owner} ${posting.title} application ${preposition} ${posting.company}`,
        ),
      ]),
    ].some((context) => words(context) === words(suffix))
  )
    return item;
  const named = controls.filter((control) => words(control.label) === target);
  const [field] = named;
  return named.length === 1 && field && words(questionPrompt(field)) === target
    ? questionPrompt(field)
    : item;
}

const DEFAULT_MAX_STEPS = Number.POSITIVE_INFINITY;
function matchesFinishQuestion(
  prompt: string,
  isBoolean: boolean,
  item: string,
) {
  const words = (text: string) =>
    normalizeFormQuestionPrompt(preserveTechnologyTokens(text));
  return (
    words(prompt) === words(item) ||
    words(prompt) === words(formQuestionText(item, isBoolean))
  );
}
function offersYesNo(options: readonly string[]) {
  return (
    options.length === 2 &&
    options.some((option) => normalizeFormQuestionPrompt(option) === "yes") &&
    options.some((option) => normalizeFormQuestionPrompt(option) === "no")
  );
}
// Work that keeps changing the form has no total turn or wall-time budget.
const DEFAULT_NO_PROGRESS_STEP_LIMIT = 120;
// Writing and then checking a high-effort letter can exceed a page tool's 90s.

/** What a partial classifier outage still allows: reads and field writes. */
const PARTIAL_OUTAGE_TOOLS = new Set([
  "observe",
  "read_text",
  "scroll",
  "wait",
  "fill_fields",
  "type",
  "select",
  "set_checkbox",
  "upload",
]);

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
  const activity: ApplyAgentResult["timeline"] = (config.earlierActivity ?? [])
    .filter((checkpoint) =>
      [
        "Google account selected",
        "Google sign-in confirmed",
        UNCONFIRMED_STEP_LABEL,
      ].includes(checkpoint.label),
    )
    .map((checkpoint) => ({
      at: checkpoint.at,
      text: checkpoint.detail,
      label: checkpoint.label,
    }));
  const confirmationText = (account: string) =>
    `Pressed Google’s sign-in confirmation for ${account}. Sign-in completion has not been verified.`;
  const confirmations = new Set(
    activity
      .filter((entry) => entry.label === "Google sign-in confirmed")
      .map((entry) => entry.text),
  );
  const selections = new Set(activity.map((entry) => entry.text));
  const selectionText = (account: string) =>
    `Selected Google account ${account}. Sign-in completion has not been verified.`;
  config = {
    ...config,
    readIntendedAccountEmail:
      config.readIntendedAccountEmail ??
      (() => intendedAccountEmail(config.sources.profile)),
  };
  try {
    return await runMeasuredApplyAgent(
      {
        ...config,
        hands: timing.hands(
          withBrowserPermissions(config.hands, {
            ...config,
            googleSignInAlreadyConfirmed: (account) =>
              confirmations.has(confirmationText(account)),
            onGoogleSignInConfirmed: async (account) => {
              const text = confirmationText(account);
              if (confirmations.has(text)) return;
              confirmations.add(text);
              activity.push({
                at: (config.now ?? (() => new Date()))().toISOString(),
                label: "Google sign-in confirmed",
                text,
              });
              await config.onGoogleSignInConfirmed?.(account);
            },
            googleAccountAlreadySelected: (account) =>
              selections.has(selectionText(account)),
            onGoogleAccountSelected: async (account) => {
              const text = selectionText(account);
              if (selections.has(text)) return;
              selections.add(text);
              activity.push({
                at: (config.now ?? (() => new Date()))().toISOString(),
                label: "Google account selected",
                text,
              });
              await config.onGoogleAccountSelected?.(account);
            },
          }),
        ),
      },
      // Name this application model task.
      timing.model(withReasoningTask(llmClient, "apply")),
      timing,
      activity,
    );
  } finally {
    config.onTiming?.(timing.snapshot());
  }
}

async function runMeasuredApplyAgent(
  input: ApplyAgentConfig,
  llmClient: LLMClient,
  timingRecord: ReturnType<typeof createApplyTiming>,
  activity: ApplyAgentResult["timeline"],
): Promise<ApplyAgentResult> {
  const routeClient = llmClient;
  llmClient = {
    chatWithTools: (messages, tools, options) =>
      routeClient.chatWithTools(messages, tools, {
        ...options,
        ...(input.modelMaxOutputTokens
          ? { maxOutputTokens: input.modelMaxOutputTokens }
          : {}),
      }),
  };
  const modelActivity = createApplyModelActivity(llmClient);
  llmClient = modelActivity.client;
  const runAbort = new AbortController();
  const runSignal = input.signal
    ? AbortSignal.any([input.signal, runAbort.signal])
    : runAbort.signal;
  const config: ApplyAgentConfig = {
    ...input,
    signal: runSignal,
  };
  const now = config.now ?? (() => new Date());
  const filled: ApplyFilledControl[] = [];
  // Only executor-approved writes, bound to this page/step and field. Page
  // autofill and arbitrary observed values are not checked answer receipts.
  const checkedFieldValues = new Map<string, string>();
  const attachments: ApplyAttachedDocument[] = [];
  const observedAnswers = new Map<string, ApplyFilledControl>();
  const observedAttachments = new Map<string, ApplyAttachedDocument>();
  const pauses: ApplyPause[] = [];
  /** The moves between screens, carried on from the run this one restores. */
  const formPath: ApplyFormPathStep[] = [...(config.replay?.path ?? [])];
  /**
   * A form button Fill in for me left for the person. It is handed over when
   * the run finishes, after everything else it could fill is filled, rather
   * than the moment the model reached for it.
   */
  let deferredPress: ApplyPause | null = null;
  const deferPress = (pause: ApplyPause): string => {
    deferredPress = pause;
    note(`Left ${pause.question?.prompt ?? "a form button"} for the end.`);
    return `${pause.blocker?.detail ?? pause.summary} Job Finder hands it to the person when everything else is filled: fill every other field on this page you can answer, then finish.`;
  };
  /**
   * Reaching for a form button again means the page is done: the run ends
   * with it, the person's questions first (their answers belong on this
   * page, so the press waits for the next run).
   */
  const handOverPress = async (
    pause: ApplyPause,
  ): Promise<AgentLoopToolOutcome> => {
    if (uploadTries.size) syncObservation(await pageTools.observe());
    if (
      exhaustedUploads.size ||
      [...uploadLedger].some(
        ([key, entry]) =>
          uploadTries.has(key) &&
          ["rejected", "unconfirmed"].includes(entry.state),
      )
    ) {
      // A failed upload's Attach/Home button is not a candidate question.
      // Use normal finishing so genuine required gaps are still collected.
      needsPersonFinishPending = false;
      forPerson = [];
      return outcomeToLoop({
        kind: "finished",
        reason: [...exhaustedUploads.values()].join(" "),
        stuck: true,
        needsPerson: false,
      });
    }
    const handover = collectedQuestionsPause() ?? pause;
    pauses.push(handover);
    note(handover.summary);
    return { kind: "stop", reason: handover.summary, data: handover };
  };
  // Letter fields whose drafted letter waits for the person's review.
  const lettersAwaitingReview = new Set<string>();
  const notes: string[] = [];
  const timeline = activity;
  const reviewObservedFieldKeys = new Set<string>();
  const pendingQuestions = new Map<string, ApplicationAttemptQuestion>();
  const setPendingQuestion = pendingQuestions.set.bind(pendingQuestions);
  if (runTraceEnabled())
    pendingQuestions.set = (key, question) => {
      traceOurs(
        "packages/browser-agent/src/apply/apply-agent.ts:pendingQuestions.set",
        "asked_person",
        JSON.stringify(question),
      );
      return setPendingQuestion(key, question);
    };
  const attemptedWrites = new Set<string>();
  const attemptedManualEntries = new Set<string>();
  const attemptedSignInEntries = new Set<string>();
  const suggestedAccessRoutes = new Set<string>();
  let attemptedGoogleSignIn = false;
  const recordAccessAttempt = async (
    observation: ApplyFormObservation,
    ref: string,
  ) => {
    if (
      browserInteractionKind(
        observation,
        ref,
        await googleIdentityContext(config, config.hands),
      ) === "googleSignIn"
    )
      attemptedGoogleSignIn = true;
    const action = signInEntryActions(observation).find(
      (entry) => entry.ref === ref,
    );
    if (action)
      attemptedSignInEntries.add(
        `${observation.url}|${action.label.toLowerCase()}`,
      );
  };
  const heldAnswerKeys = new Set<string>();

  // A run that stops for the person (a check only they can pass) is first
  // asked once to fill the fields it already knows, so the person is left
  // only the part the agent could not do.
  const guardState = createApplyGuardState(config.initialPickerAttempts);
  // A step press an earlier run could not confirm is never pressed again.
  for (const entry of activity)
    if (entry.label === UNCONFIRMED_STEP_LABEL)
      guardState.uncertainAdvances.set(entry.text, entry.at);
  // This attempt's send evidence (council D1): never write or replay authority.
  const stepReceipts = createStepReceiptTracker(
    config.application.resultId ?? config.application.applicationId,
  );
  const earlierUncertain = new Set(guardState.uncertainAdvances.keys());
  // Pickers an earlier run left unanswered: a search the site restored into
  // the box is not a choice, until this run chooses one.
  const unconfirmedPickers = new Map(
    (config.initialUnansweredPickerQuestions ?? []).map((question) => [
      normalizeFormQuestionPrompt(question.prompt),
      question.options,
    ]),
  );
  const questionOccurrences = createQuestionOccurrences(
    config.initialQuestionContexts,
  );
  const pageHands = config.hands;
  config.hands = {
    ...pageHands,
    fillText: (ref, value) => {
      recordWriteAttempt(ref);
      return pageHands.fillText(ref, value);
    },
    chooseOption: (ref, value) => {
      recordWriteAttempt(ref);
      return pageHands.chooseOption(ref, value);
    },
    setToggle: (ref, checked) => {
      recordWriteAttempt(ref);
      return pageHands.setToggle(ref, checked);
    },
    observe: async () => {
      const observation = await pageHands.observe();
      questionOccurrences.observe(observation);
      // A search left in a picker whose choice failed is not an answer. A
      // value the run never typed there is: the person picked it on the
      // page, or the site restored their pick.
      for (const control of observation.controls) {
        const key = pickerQuestionKey(control);
        const shown = normalizeSignal(
          control.selectedOptionLabel || control.value,
        );
        const previousOptions =
          control.kind === "combobox" &&
          (!shown ||
            (guardState.pickerAttempts.get(key)?.tried.includes(shown) ?? true))
            ? unconfirmedPickers.get(key)
            : undefined;
        if (
          ((control.kind === "combobox" || control.kind === "select") &&
            guardState.openPickers.has(key)) ||
          previousOptions
        )
          control.answered = false;
        if (previousOptions && !control.options.length)
          control.options = [...previousOptions];
        // Remote menus disappear when their search is cleared. Keep the
        // rows the picker returned available to the next model turn and to
        // the person's question if no supported equivalent can be chosen.
        if (guardState.openPickers.has(key) && !control.options.length)
          control.options = [
            ...(guardState.pickerAttempts.get(key)?.offeredOptions ?? []),
          ];
      }
      stepReceipts.observe(observation);
      return observation;
    },
  };
  const recordWriteAttempt = (ref: string) => {
    const control = pageTools.state.observation?.controls.find(
      (entry) => entry.ref === ref,
    );
    // Recorded before the write runs: a write the site refuses still counts.
    stepReceipts.wrote(pageTools.state.observation ?? null, ref);
    if (control)
      attemptedWrites.add(normalizeFormQuestionPrompt(questionPrompt(control)));
  };
  const classifyQuestions = config.modelQuestionClassification
    ? createQuestionClassifier({
        client: llmClient,
        signal: config.signal,
        cacheScope: config.questionReadCacheScope,
        readContext: async () =>
          applicationQuestionClassificationContext({
            sources: runConfig.sources,
            application: {
              ...runConfig.application,
              startingUrl:
                pageTools.state.observation?.url ??
                runConfig.application.startingUrl,
            },
            payDisclosed:
              runConfig.authority.salaryDisclosure === "answer_from_profile",
            approvedAttestations:
              runConfig.authority.preApprovedAttestationKinds,
            browserPermissions: await currentBrowserPermissions(config),
          }),
        sources: () =>
          answerSourceCatalog({
            ...runConfig.sources,
            reusableAnswers: relevantSavedAnswers(
              runConfig.sources.reusableAnswers,
              pageTools.state.observation?.controls.map(questionPrompt),
            ),
          }),
      })
    : undefined;
  const documentCatalog: ApplyDocument[] = [...config.sources.documents];
  const letterRequests = new Map<
    string,
    ReturnType<NonNullable<ApplyAgentConfig["letters"]>["provide"]>
  >();
  const runConfig: ApplyAgentConfig = {
    ...config,
    sources: {
      ...config.sources,
      taskInstructions:
        config.application.instructions ?? config.sources.taskInstructions,
      documents: documentCatalog,
      reusableAnswers: config.sources.reusableAnswers.filter((answer) => {
        const scope = answer.applicationScope;
        return (
          !scope ||
          (!scope.applicationRecordId && !scope.resultId) ||
          (scope.applicationRecordId &&
            scope.applicationRecordId ===
              config.application.applicationRecordId) ||
          (scope.resultId && scope.resultId === config.application.resultId)
        );
      }),
    },
    ...(config.letters
      ? {
          letters: {
            ...config.letters,
            provide: async (request) => {
              const key = JSON.stringify(request);
              let pending = letterRequests.get(key);
              if (!pending) {
                pending = config.letters!.provide({
                  ...request,
                  signal: runSignal,
                });
                letterRequests.set(key, pending);
                // A draft may still be running when a page changes or Stop lands.
                void pending.catch(() => undefined);
              }
              const result = await pending;

              return result;
            },
          },
        }
      : {}),
  };
  let readyToSend: ApplyAgentResult["readyToSend"] = null;
  let skipReason: string | null = null;
  const payDisclosed =
    config.authority.salaryDisclosure === "answer_from_profile";
  const resumeText =
    (
      config.sources.resumeText ?? config.sources.profile.baseResume.textContent
    )?.trim() || null;
  const initialReusableAnswers = JSON.stringify(
    runConfig.sources.reusableAnswers,
  );
  let currentReusableAnswers = initialReusableAnswers;
  const refreshReusableAnswers = async () => {
    if (!config.readReusableAnswers) return;
    const shared = await config.readReusableAnswers(
      (pageTools.state.observation?.controls ?? [])
        .filter((control) => control.visible && !control.credentialRole)
        .map((control) => ({
          prompt: questionPrompt(control),
          kind: control.questionKind,
          ...(control.repeatedQuestion
            ? { repeatedAtDifferentStep: true }
            : {}),
          answerControlType: control.answerControlType,
          answerOptions: control.options,
          ...(control.inputConstraints
            ? { inputConstraints: control.inputConstraints }
            : {}),
        })),
    );
    const local = runConfig.sources.reusableAnswers.filter((answer) =>
      answer.id.startsWith("application_"),
    );
    const sharedIds = new Set(shared.map((answer) => answer.id));
    const answers = [
      ...local.filter((answer) => !sharedIds.has(answer.id)),
      ...shared,
    ];
    const next = JSON.stringify(answers);
    if (next !== currentReusableAnswers) {
      unsupportedExistingAnswers.clear();
      // Only a changed answer for this question releases its earlier refusal.
      for (const [key, pending] of pendingQuestions) {
        const controls = pageTools.state.observation?.controls ?? [];
        const control = controls.find(
          (entry) => questionPrompt(entry) === pending.prompt,
        );
        if (!control) continue;
        const previous = savedAnswerForQuestion(
          control,
          runConfig.sources.reusableAnswers,
          controls,
        );
        const updated = savedAnswerForQuestion(control, answers, controls);
        if (updated && updated.answer !== previous?.answer) {
          pendingQuestions.delete(key);
          heldAnswerKeys.delete(key);
        }
      }
      runConfig.sources.reusableAnswers = answers;
      currentReusableAnswers = next;
    }
  };

  let advanceFinishNudged = false;
  let staleResumeNudged = false;
  let optionalLetterNudged = false;
  let forPersonNudged = false;
  // A genuine person-owned task stays pending. A finish naming only checked
  // current answers can clear its stale flag after the ordinary page checks.
  let needsPersonFinishPending = false;
  let finishHasOnlyCheckedFields = false;
  // What the model's last finish named for the person, apart from its reason.
  let forPerson: string[] = [];

  const buildPendingQuestion = (
    input: Parameters<typeof makePendingQuestion>[0],
  ) => {
    const page = pageTools.state.observation;
    const controls = input.siblings ?? page?.controls ?? [input.control];
    const readings = page
      ? classifyQuestions?.settled(controls, questionReadContext(page))
      : undefined;
    const reading = readings?.get(
      questionClassificationKey(input.control, controls),
    );
    const control = reading
      ? {
          ...input.control,
          questionKind: modelQuestionKind(
            input.control,
            reading,
            asksPayCurrency(input.control, controls, readings),
          ),
          asksCurrentPay:
            reading.asksCurrentPay ?? input.control.asksCurrentPay ?? false,
        }
      : input.control;
    const pendingInput = {
      ...input,
      control,
      ...(page ? { observation: page } : {}),
    };
    return makePendingQuestion(pendingInput);
  };
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
  const currentFieldAnswer = (control: ApplyFormControl): string =>
    control.kind === "radio"
      ? control.label || control.value
      : control.kind === "checkbox"
        ? control.answerControlType === "multi_choice"
          ? control.label || control.value
          : control.checked
            ? "Yes"
            : "No"
        : control.selectedOptionLabel || control.value;
  const checkedFieldKey = (
    observation: ApplyFormObservation,
    control: ApplyFormControl,
  ): string =>
    JSON.stringify([
      reviewFieldKey(observation, control),
      questionClassificationKey(control, observation.controls),
      control.answerControlType === "multi_choice"
        ? control.label || control.value
        : null,
    ]);
  const hasCheckedFieldAnswer = (
    control: ApplyFormControl,
    observation: ApplyFormObservation,
  ): boolean => {
    if (
      !holdsAnswer(control) ||
      control.invalid ||
      control.kind === "file" ||
      control.credentialRole === "password"
    )
      return false;
    const value = currentFieldAnswer(control);
    if (
      !value.trim() ||
      checkedFieldValues.get(checkedFieldKey(observation, control))?.trim() !==
        value.trim()
    )
      return false;
    return true;
  };
  // Every file this run has seen held in a field, across the form's steps.
  // A refusal on step one stays a refusal when the run reaches the last step:
  // readiness reads only the current page, so this is what keeps it.
  const uploadWaitMs = config.uploadWaitMs ?? 60_000;
  const confirmedFields = new Set(config.uploadsConfirmedByPerson ?? []);
  const uploadOptions = {
    confirmedByPerson: (control: ApplyFormObservation["controls"][number]) =>
      confirmedFields.has(questionPrompt(control)),
  };
  const uploadLedger = new Map<
    string,
    {
      label: string;
      control: ApplyFormObservation["controls"][number];
      fieldKey: string;
      fileName: string;
      documentId: string | undefined;
      state: FileUploadProblem["state"] | "accepted";
      since: number;
    }
  >();
  const stableUploadKeys = new Map<string, string>();
  const uploadReviewFields = new Map<string, Set<string>>();
  const forgetObservedUpload = (key: string): void => {
    for (const fieldKey of uploadReviewFields.get(key) ?? [])
      observedAttachments.delete(fieldKey);
    observedAttachments.delete(key);
  };
  const uploadFieldKey = (
    control: ApplyFormControl,
    page: ApplyFormObservation,
  ): string => {
    const label = questionPrompt(control);
    const ordinal = page.controls
      .filter((entry) => questionPrompt(entry) === label)
      .indexOf(control);
    const url = page.url?.split(/[?#]/u)[0] ?? "";
    const key = `${url}|field:file:${ordinal}|${label}`;
    if (!control.fileControlKey) return key;
    const nativeOrdinal = page.controls
      .filter(
        (entry) =>
          entry.kind === "file" &&
          entry.fileControlKey === control.fileControlKey,
      )
      .indexOf(control);
    const identity = `${url}|${control.fileControlKey}|${nativeOrdinal}`;
    const stable = stableUploadKeys.get(identity);
    if (stable) return stable;
    stableUploadKeys.set(identity, key);
    return key;
  };
  const selectedFiles = new Map<
    string,
    { documentId: string; fileName: string }
  >();
  const nativeSavedFiles = new Map<string, ApplyAttachedDocument>();
  for (const earlier of [
    ...(runConfig.earlierAttachments ?? []),
    ...(runConfig.replay?.attachments ?? []),
  ]) {
    if (!earlier.savedSha256 || !earlier.fieldKey) continue;
    const document = documentCatalog.find(
      (entry) => entry.fileName === earlier.fileName,
    );
    if (!document) continue;
    const bytes = await document.loadBytes().catch(() => null);
    if (!bytes) continue;
    if (
      createHash("sha256").update(bytes).digest("hex") !== earlier.savedSha256
    )
      continue;
    nativeSavedFiles.set(earlier.fieldKey, {
      fieldKey: earlier.fieldKey,
      documentId: document.id,
      fileName: earlier.fileName,
      label: earlier.label,
      controlLabel: earlier.field,
      savedSha256: earlier.savedSha256,
      at: now().toISOString(),
    });
  }
  const uploadDiagnostics = new Map<string, string>();
  const recordUpload = (
    fieldKey: string,
    control: ApplyFormObservation["controls"][number],
    page: ApplyFormObservation,
    observed: FileUploadProblem["state"] | "accepted",
  ): void => {
    const earlier = uploadLedger.get(fieldKey);
    const label = questionPrompt(control);
    const at = now().getTime();
    const fileName =
      control.upload?.fileName ||
      (control.answered ? control.value.split(/[\\/]/u).at(-1) : "") ||
      earlier?.fileName ||
      selectedFiles.get(fieldKey)?.fileName ||
      "";
    if (!control.answered && !earlier && !fileName && observed === "accepted")
      return;
    let state = observed;
    if (observed === "unconfirmed" && selectedFiles.has(fieldKey))
      state = "uploading";
    let rule =
      fileUploadProblems(page, uploadOptions).find(
        (problem) => problem.control.ref === control.ref,
      )?.rule ?? "never confirmed";
    if (
      !control.answered &&
      observed === "accepted" &&
      control.upload?.network !== "accepted"
    ) {
      const shown =
        fileName &&
        `${control.upload?.described ?? ""}\n${control.upload?.nearby ?? ""}`
          .toLowerCase()
          .includes(fileName.toLowerCase());
      if (!shown) {
        state = "uploading";
        rule = "file gone from the field; waiting for confirmation";
      }
    }
    const since =
      earlier &&
      earlier.fileName === fileName &&
      (earlier.state === state ||
        (state === "uploading" && earlier.state === "unconfirmed"))
        ? earlier.since
        : at;
    if (
      state === "uploading" &&
      (at - since >= uploadWaitMs || earlier?.state === "unconfirmed")
    ) {
      state = "unconfirmed";
      rule = rule.startsWith("file gone")
        ? "file gone from the field; never confirmed"
        : "never confirmed";
    }
    uploadLedger.set(fieldKey, {
      label,
      control,
      fieldKey: reviewFieldKey(page, control),
      fileName,
      documentId:
        selectedFiles.get(fieldKey)?.documentId ?? earlier?.documentId,
      state,
      since,
    });
    if (state === "accepted") exhaustedUploads.delete(fieldKey);
    if (state !== "rejected" && state !== "unconfirmed") return;
    const requests =
      control.upload?.requests
        ?.map(
          (request) =>
            `${request.status === null ? "no HTTP response" : `HTTP ${request.status}`} from ${request.endpoint}${request.blocked ? " (held back by Nestor)" : ""}${request.guardRefusal ? ` [${request.guardRefusal}]` : ""}`,
        )
        .join("; ") || "no upload request observed";
    const diagnostic = `Upload for "${label}" ${state === "rejected" ? "failed" : "was not confirmed"}. Rule: ${rule}. Validation: ${control.validationMessage || "none"}. Beside the field: ${[control.upload?.described, control.upload?.nearby].filter(Boolean).join("; ") || "no text"}. Request: ${requests}.`;
    if (uploadDiagnostics.get(fieldKey) !== diagnostic) {
      uploadDiagnostics.set(fieldKey, diagnostic);
      note(diagnostic);
    }
  };
  // Every visible security check on the page is ticked or answered.
  const securityChallengeSolved = (
    observation: ApplyFormObservation,
  ): boolean => {
    const challenges = observation.controls.filter(
      (control) => control.visible && isSecurityChallengeControl(control),
    );
    return (
      challenges.length > 0 &&
      challenges.every(
        (control) =>
          control.checked ||
          (control.answered && control.value.trim().length > 0),
      )
    );
  };
  // Two possible network sends, but distinct local gestures that make no
  // request do not consume the network retry. Unknown traffic counts as a send.
  const MAX_UPLOAD_TRIES = 2;
  const uploadTries = new Map<string, number>();
  const attachmentMethods = ["input", "chooser", "drop"] as const;
  const uploadMethods = new Map<
    string,
    Set<(typeof attachmentMethods)[number]>
  >();
  const uploadCanRetry = (key: string) =>
    (uploadTries.get(key) ?? 0) < MAX_UPLOAD_TRIES &&
    attachmentMethods.some((method) => !uploadMethods.get(key)?.has(method));
  const exhaustedUploads = new Map<string, string>();
  const uploadsStillUploading = () =>
    [...uploadLedger.values()].some((entry) => entry.state === "uploading");
  const exhaustedUploadReason = (
    key: string,
    label: string,
    detail?: string,
  ) => {
    const file =
      uploadLedger.get(key)?.fileName ||
      selectedFiles.get(key)?.fileName ||
      "the selected file";
    const recovery =
      (uploadTries.get(key) ?? 0) >= MAX_UPLOAD_TRIES
        ? "after one recovery pass"
        : "because a recovery could not safely reach the attachment field";
    return `Nestor could not attach ${file} to "${label}" ${recovery}. ${uploadDiagnostics.get(key) ?? detail ?? "The site did not confirm the file."} Your recorded answers are kept.`;
  };

  // A chosen file the site refused is already the person's one upload item.
  const repairsUpload = (control: ApplyFormObservation["controls"][number]) => {
    const page = pageTools.state.observation;
    return (
      control.kind === "file" &&
      ((page && exhaustedUploads.has(uploadFieldKey(control, page))) ||
        (pendingQuestions.has(UPLOAD_REPAIR_QUESTION_ID) &&
          [...uploadLedger.values()].some(
            (entry) =>
              entry.state !== "accepted" &&
              entry.label === questionPrompt(control),
          )))
    );
  };

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

  const pageViews = new Set<string>();
  const describePage = (observation: ApplyFormObservation): string => {
    const text = describeObservation(observation);
    pageViews.add(text);
    return text;
  };
  const startOrigin = originOf(config.application.startingUrl);
  const pageTools = createPageTools(config.hands, {
    describe: describePage,
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

  const unsupportedExistingAnswers = new Map<string, string>();
  const existingAnswerKey = (
    page: ApplyFormObservation,
    control: ApplyFormControl,
  ) =>
    JSON.stringify([
      reviewFieldKey(page, control),
      observedControlValue(control, page.controls),
    ]);
  const syncObservation = (next: ApplyFormObservation): void => {
    for (const control of next.controls) {
      if (unsupportedExistingAnswers.has(existingAnswerKey(next, control)))
        control.answerUnverified = true;
      else delete control.answerUnverified;
    }
    questionOccurrences.observe(next);
    pageTools.state.observation = next;
    const uploadProblems = fileUploadProblems(next, uploadOptions);
    const unsettledUploads = new Set(
      uploadProblems.map((problem) => problem.control.ref),
    );
    // Classify the page's questions now, while the model reads the page, so
    // the first answer does not wait for it. Writes await the same result.
    // Refresh shared answers before prefetching; otherwise each newly reached
    // step first reads stale evidence and must classify it again a turn later.
    void refreshReusableAnswers()
      .then(() => {
        if (pageTools.state.observation !== next) return;
        return classifyQuestions?.(next.controls, questionReadContext(next));
      })
      .catch(() => undefined);
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
        (holdsAnswer(current) && !current.invalid)
      )
        pendingQuestions.delete(key);
    }
    readyToSend = null;
    const fileFieldsSeen = new Set<string>();
    for (const control of next.controls) {
      if (control.disabled || (!control.visible && control.kind !== "file"))
        continue;
      if (control.kind === "file")
        for (const [key, saved] of nativeSavedFiles)
          if (saved.controlLabel === questionPrompt(control))
            nativeSavedFiles.delete(key);
      const label = questionPrompt(control);
      const nationality = ["work_authorization", "visa_sponsorship"].includes(
        control.questionKind,
      )
        ? null
        : nationalityQuestionIdentity(label);
      const nationalitySaved = nationality
        ? savedAnswerForQuestion(control, runConfig.sources.reusableAnswers)
        : null;
      if (
        nationality &&
        (!nationalitySaved ||
          nationalityQuestionIdentity(nationalitySaved.question) !==
            nationality)
      ) {
        control.answered = false;
        if (control.value.trim())
          pendingQuestions.set(
            pendingQuestionKey(control),
            buildPendingQuestion({
              control,
              jobId: runConfig.application.jobId,
              detectedAt: next.observedAt,
              siblings: next.controls,
              suggestion: null,
              reason: NATIONALITY_ANSWER_REASON,
            }),
          );
      }
      const matchingQuestions = next.controls.filter(
        (entry) => questionPrompt(entry) === label,
      );
      const questionOrdinal = matchingQuestions.indexOf(control);
      const questionKey =
        control.choiceGroupKey && !control.choiceGroupKey.startsWith("ref:")
          ? control.choiceGroupKey
          : `field:${control.kind}:${questionOrdinal}`;
      const fieldKey = `${screenKey(next)}|${questionKey}|${label}`.slice(
        0,
        2_000,
      );
      reviewObservedFieldKeys.add(fieldKey);
      if (control.kind === "file") {
        // Without the step label: a field that stays in the page while later
        // steps show is the same field on every step.
        const ledgerKey = uploadFieldKey(control, next);
        const reviewFields =
          uploadReviewFields.get(ledgerKey) ?? new Set<string>();
        reviewFields.add(fieldKey);
        uploadReviewFields.set(ledgerKey, reviewFields);
        fileFieldsSeen.add(ledgerKey);
        recordUpload(
          ledgerKey,
          control,
          next,
          uploadProblems.find((problem) => problem.control.ref === control.ref)
            ?.state ?? "accepted",
        );
        // Some widgets (Greenhouse) empty the input once they have the file;
        // the storage's receipt for it still makes it attached.
        const uploadAccepted = holdsAnswer(control);
        if (
          (control.answered || uploadAccepted) &&
          !unsettledUploads.has(control.ref)
        ) {
          const shownName = control.answered
            ? (control.value.split(/[\\/]/u).at(-1) ?? control.value)
            : null;
          const recorded = [...attachments]
            .reverse()
            .find(
              (entry) =>
                entry.controlLabel === label &&
                (shownName === null || entry.fileName === shownName),
            );
          const fileName =
            shownName ??
            recorded?.fileName ??
            control.upload?.fileName ??
            control.upload?.selectedFileName ??
            "";
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
          forgetObservedUpload(ledgerKey);
        }
      } else if (
        control.answered &&
        ((control.kind !== "radio" && control.kind !== "checkbox") ||
          control.checked) &&
        !isSecurityChallengeControl(control)
      ) {
        const value = observedControlValue(control, next.controls);
        if (value.trim()) {
          // A multi-select is written one box at a time. Its group answer
          // keeps the source those writes shared, so a replay can tell
          // whether that source still holds (review P1); a mix of sources
          // stays observed and is checked against the current saved answer.
          const memberSources =
            control.answerControlType === "multi_choice"
              ? next.controls
                  .filter(
                    (candidate) =>
                      candidate.choiceGroupKey === control.choiceGroupKey &&
                      candidate.checked,
                  )
                  .map(
                    (member) =>
                      [...filled]
                        .reverse()
                        .find((entry) => entry.ref === member.ref)?.answer,
                  )
              : [];
          const [firstSource] = memberSources;
          const skillIds = memberSources.map((answer) => {
            const id = answer?.sourceId;
            return id && /^profile\.skills\.\d+$/u.test(id) ? id : null;
          });
          const groupSource =
            firstSource && skillIds.every(Boolean)
              ? {
                  ...firstSource,
                  sourceId: "profile.skills",
                  groundedIn: skillIds.filter(
                    (id): id is string => id !== null,
                  ),
                }
              : firstSource &&
                  memberSources.every(
                    (answer) =>
                      answer?.sourceId === firstSource.sourceId &&
                      !answer.sourceId?.startsWith("observed."),
                  )
                ? firstSource
                : null;
          const recorded = groupSource
            ? {
                ref: control.ref,
                label,
                questionKind: control.questionKind,
                answer: { ...groupSource, value },
                at: next.observedAt,
              }
            : [...filled]
                .reverse()
                .find(
                  (entry) =>
                    entry.label === label && entry.answer.value === value,
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
      if (holdsAnswer(control) && !control.invalid)
        pendingQuestions.delete(pendingQuestionKey(control));
    }
    // A server-backed wizard may replace earlier controls with a structured
    // review. Keep those current values as observations, never as new facts.
    const catalog = answerSourceCatalog(runConfig.sources);
    for (const [index, row] of (next.summaryRows ?? []).entries()) {
      const label = row.label.trim(),
        value = row.value.trim();
      if (
        !label ||
        !value ||
        [...observedAttachments.values()].some((a) => a.fileName === value)
      )
        continue;
      const same = (question: string) =>
        normalizeSignal(question) === normalizeSignal(label);
      // questionPrompt adds section context to a control's own label. A
      // summary commonly shows that label alone. Only suppress its extra
      // display row here; source checks still use the whole question.
      const represented = (question: string) =>
        same(question) ||
        normalizeSignal(question.split(" — ").at(-1) ?? question) ===
          normalizeSignal(label);
      if (
        [...observedAnswers.values()].some(
          (a) => represented(a.label) && a.answer.value.trim() === value,
        )
      )
        continue;
      const prior = runConfig.replay?.answers.find(
        (a) => same(a.question) && a.answer.trim() === value,
      );
      if (
        !prior &&
        !catalog.some(
          (source) =>
            source.purpose !== "authority" && source.value.trim() === value,
        )
      )
        continue;
      const fieldKey = `${screenKey(next)}|summary:${index}|${label}`.slice(
        0,
        2_000,
      );
      observedAnswers.set(fieldKey, {
        fieldKey,
        ref: `summary:${index}`,
        label,
        questionKind: "other",
        at: next.observedAt,
        answer: {
          value,
          kind: "other",
          sourceKind: "profile",
          sourceId: `observed.summary_${index}`,
          provenanceLabel: "the site's current review",
          groundedIn: [],
        },
      });
      reviewObservedFieldKeys.add(fieldKey);
    }
    // Some widgets replace the file field with the file's name once the
    // upload lands (Greenhouse). The field is gone; the server's word on that
    // same file, which the page still reports, settles it.
    for (const [key, entry] of uploadLedger) {
      if (fileFieldsSeen.has(key) || !entry.fileName) continue;
      const word = next.uploads?.find(
        (upload) =>
          upload.fileName.toLowerCase() === entry.fileName.toLowerCase(),
      )?.network;
      if (!word) {
        // An error page can replace a deferred selection after it first
        // appeared attached. It cannot keep an unverified receipt.
        const field = next.controls.find(
          (control) =>
            control.kind === "file" && uploadFieldKey(control, next) === key,
        );
        const errorPage =
          !next.controls.some(
            (control) => control.visible && !control.disabled,
          ) &&
          (next.validationErrors.length > 0 ||
            /\b(?:unknown error|an error (?:has )?occurred|something went wrong|temporarily unavailable|error submitting|submission failed|upload failed)\b/iu.test(
              next.bodyTextExcerpt,
            ));
        if (
          uploadTries.has(key) &&
          ["accepted", "uploading"].includes(entry.state) &&
          errorPage &&
          !nativeSavedFiles.has(key) &&
          !field?.answered &&
          !next.bodyTextExcerpt
            .toLowerCase()
            .includes(entry.fileName.toLowerCase())
        ) {
          uploadLedger.set(key, {
            ...entry,
            state: "unconfirmed",
            since: now().getTime(),
          });
          forgetObservedUpload(key);
          uploadDiagnostics.set(
            key,
            `The selected file ${entry.fileName} no longer appears on the page, and the site has not confirmed it.`,
          );
        }
        continue;
      }
      // A wizard keeps an earlier step's field in the page, disabled and
      // hidden. When that input still holds the exact file inside a POST
      // multipart form, the form's submission sends it: an untied word from
      // a later step's autosave does not unattach it.
      const field = next.controls.find(
        (control) =>
          control.kind === "file" && uploadFieldKey(control, next) === key,
      );
      const state =
        word !== "rejected" &&
        nativeSavedFiles.get(key)?.fileName === entry.fileName
          ? "accepted"
          : word === "pending"
            ? "uploading"
            : word === "unconfirmed" &&
                field &&
                field.upload?.fileName?.toLowerCase() ===
                  entry.fileName.toLowerCase() &&
                retainedForFormSubmission(field)
              ? "accepted"
              : word;
      const nativeSaved = nativeSavedFiles.get(key);
      if (word === "rejected") {
        nativeSavedFiles.delete(key);
        if (nativeSaved?.fieldKey)
          observedAttachments.delete(nativeSaved.fieldKey);
      }
      if (state !== entry.state)
        uploadLedger.set(key, { ...entry, state, since: now().getTime() });
      if (state === "accepted") exhaustedUploads.delete(key);
      if (state !== "accepted") {
        forgetObservedUpload(key);
        observedAttachments.delete(entry.fieldKey);
        uploadDiagnostics.set(
          key,
          word === "rejected"
            ? `The site rejected ${entry.fileName} after its attachment field left the page.`
            : `The site has not confirmed ${entry.fileName} in the form that was submitted.`,
        );
        continue;
      }
      const recorded = [...attachments]
        .reverse()
        .find(
          (attached) =>
            attached.controlLabel === entry.label &&
            attached.fileName === entry.fileName,
        );
      const observedKey = nativeSaved?.fieldKey ?? entry.fieldKey;
      observedAttachments.set(observedKey, {
        ...(recorded ?? {
          documentId: `observed.${entry.label}`,
          fileName: entry.fileName,
          label: entry.label,
          controlLabel: entry.label,
          at: next.observedAt,
        }),
        fieldKey: observedKey,
        ...(nativeSavedFiles.get(key)?.savedSha256
          ? { savedSha256: nativeSavedFiles.get(key)!.savedSha256 }
          : {}),
      });
    }
    for (const [key, saved] of nativeSavedFiles) {
      if (
        !key.startsWith(`${next.url?.split(/[?#]/u)[0] ?? ""}|`) ||
        next.controls.some(
          (field) =>
            field.kind === "file" &&
            questionPrompt(field) === saved.controlLabel,
        )
      )
        continue;
      if (
        next.uploads?.some(
          (upload) =>
            upload.fileName === saved.fileName && upload.network === "rejected",
        )
      ) {
        nativeSavedFiles.delete(key);
        observedAttachments.delete(saved.fieldKey ?? key);
        continue;
      }
      observedAttachments.set(saved.fieldKey ?? key, saved);
    }
    // A continue keeps the page an earlier attempt attached a file on. Where
    // the widget replaced that field with the file's name, this run never
    // sees the field; the storage's word on that same file settles it.
    for (const earlier of runConfig.earlierAttachments ?? []) {
      const key = earlier.fieldKey ?? `earlier|${earlier.field}`;
      if (
        observedAttachments.has(key) ||
        next.controls.some(
          (control) =>
            control.kind === "file" &&
            questionPrompt(control) === earlier.field,
        ) ||
        next.uploads?.find(
          (upload) =>
            upload.fileName.toLowerCase() === earlier.fileName.toLowerCase(),
        )?.network !== "accepted"
      )
        continue;
      observedAttachments.set(key, {
        documentId: `observed.${earlier.label}`,
        fileName: earlier.fileName,
        label: earlier.label,
        controlLabel: earlier.field,
        at: next.observedAt,
        fieldKey: key,
      });
    }
    // However many files the site refused, on this step or an earlier one,
    // the person gets one item for this application. It goes only once each
    // of those files is seen accepted.
    const repairs = [...uploadLedger.entries()]
      .filter(
        ([key, entry]) =>
          !uploadTries.has(key) &&
          (entry.state === "rejected" || entry.state === "unconfirmed"),
      )
      .map(([, entry]) => entry);
    const [firstRepair] = repairs;
    if (firstRepair) {
      const selectedDocument =
        documentCatalog.find(
          (document) => document.id === firstRepair.documentId,
        ) ??
        documentCatalog.find(
          (document) => document.fileName === firstRepair.fileName,
        );
      const labels = [...new Set(repairs.map((entry) => entry.label))];
      const failed = repairs.some((entry) => entry.state === "rejected");
      pendingQuestions.set(UPLOAD_REPAIR_QUESTION_ID, {
        ...buildPendingQuestion({
          control: firstRepair.control,
          jobId: config.application.jobId,
          detectedAt: now().toISOString(),
          suggestion: null,
          askReason: {
            kind: "page_refused",
            check: "upload_acceptance",
            ...(selectedDocument
              ? {
                  selectedDocument: {
                    kind: selectedDocument.kind,
                    label: selectedDocument.label.slice(0, 300),
                    fileName: selectedDocument.fileName.slice(0, 255),
                  },
                }
              : {}),
            detail:
              repairs
                .map(
                  (entry) =>
                    [...uploadDiagnostics.entries()].find(
                      ([key]) => uploadLedger.get(key) === entry,
                    )?.[1],
                )
                .filter(Boolean)
                .join("\n")
                .slice(0, 4_000) ||
              "The site has not confirmed the selected file in this field.",
          },
        }),
        id: UPLOAD_REPAIR_QUESTION_ID,
        prompt: `${labels.join(", ")} — ${failed ? "upload failed" : "upload not confirmed"}`,
        note: [
          failed
            ? "The site did not accept this upload; your other answers are kept."
            : "The site has not shown this file as attached; your other answers are kept.",
          ...repairs
            .map(
              (entry) =>
                [...uploadDiagnostics.entries()].find(
                  ([key]) => uploadLedger.get(key) === entry,
                )?.[1],
            )
            .filter(Boolean),
        ].join("\n"),
      });
    } else pendingQuestions.delete(UPLOAD_REPAIR_QUESTION_ID);
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
    pageViews.add(text);
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
      case "skipped":
        skipReason = outcome.reason;
        return {
          kind: "finish",
          finish: {
            reason: outcome.reason,
            stuck: false,
            needsPerson: false,
            data: {},
          },
        };
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
      case "filled": {
        const control = outcome.observation.controls.find(
          (control) => control.ref === outcome.filled.ref,
        );
        if (control) {
          checkedFieldValues.set(
            checkedFieldKey(outcome.observation, control),
            outcome.filled.answer.value,
          );
          heldAnswerKeys.delete(pendingQuestionKey(control));
        }
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
          `Answered "${outcome.filled.label}" (${outcome.filled.answer.provenanceLabel}).`,
        );
        return {
          kind: "ok",
          progress: true,
          content: withPage
            ? `Filled in "${outcome.filled.label}". The form now looks like this:\n\n${describePage(outcome.observation)}`
            : `Filled in "${outcome.filled.label}".`,
        };
      }
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
            ? `Attached ${outcome.attachment.label}. The form now looks like this:\n\n${describePage(outcome.observation)}`
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
            ? `${outcome.note}\n\nThe page now:\n\n${describePage(outcome.observation)}`
            : outcome.note,
        };
      case "suggestion": {
        syncObservation(outcome.observation);
        const control = outcome.observation.controls.find(
          (candidate) => candidate.ref === outcome.controlRef,
        );
        if (outcome.question) {
          pendingQuestions.set(
            control ? pendingQuestionKey(control) : outcome.controlRef,
            control && outcome.observation.url
              ? {
                  ...outcome.question,
                  currentFieldBinding: {
                    pageUrl: outcome.observation.url,
                    targetHash: meaningTargetHash(
                      control,
                      outcome.observation.controls,
                    ),
                    instructionsHash: meaningHash(
                      formWritingInstructions(outcome.observation),
                    ),
                  },
                }
              : outcome.question,
          );
          if (
            control &&
            !guardState.openPickers.has(pickerQuestionKey(control))
          )
            heldAnswerKeys.add(pendingQuestionKey(control));
        }
        return {
          kind: "ok",
          stopBatch: !(
            control && heldAnswerKeys.has(pendingQuestionKey(control))
          ),
          content: outcome.note,
        };
      }
      case "refused":
        syncObservation(outcome.observation);
        return {
          kind: "ok",
          status: "refused",
          stopBatch: !outcome.fieldRef,
          content: withPage
            ? `${outcome.reason}\n\nThe page now:\n\n${describePage(outcome.observation)}`
            : outcome.reason,
        };
      case "paused":
        // A step press Nestor already made once is not deferred and retried.
        if (outcome.pause.unconfirmedStep) return handOverPress(outcome.pause);
        // Fill in for me: a form button waits until the rest is filled.
        if (
          outcome.pause.question?.id === STEP_HANDOVER_QUESTION_ID &&
          (!pressesFormButtons(runConfig) || outcome.pause.formSend === true)
        )
          return deferredPress
            ? handOverPress(outcome.pause)
            : {
                kind: "ok",
                status: "refused",
                stopBatch: false,
                content: deferPress(outcome.pause),
              };
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
        syncObservation(outcome.observation);
        note("The form is complete and ready to send.");
        // Nothing is left for the model to decide: the checks its finish
        // would run happen now, and a form that passes them ends the run
        // here instead of after another model turn.
        return outcomeToLoop({
          kind: "finished",
          reason: "The form is complete and ready to send.",
          stuck: false,
          needsPerson: false,
        });
      case "finished": {
        let finishNeedsPerson = outcome.needsPerson;
        if (finishNeedsPerson) needsPersonFinishPending = true;
        forPerson = (outcome.forPerson ?? []).flatMap((item) =>
          nativeFinishQuestion(
            item,
            pageTools.state.observation,
            config.sources.posting,
          ),
        );
        // A write receipt is not proof that a controlled field retained its
        // value. Re-read the live form before accepting the model's finish.
        let observation = await pageTools.observe();
        const reportedChallenge = !securityChallengeSolved(observation)
          ? [outcome.reason, ...forPerson]
              .map(reportedSecurityChallenge)
              .find((blocker) => blocker !== null)
          : null;
        if (!observation.blocker && reportedChallenge)
          observation = { ...observation, blocker: reportedChallenge };
        const permissions = await currentBrowserPermissions(config);
        const identityContext = await googleIdentityContext(
          config,
          config.hands,
        );
        // A password screen can hide provider choices behind a separate Sign In.
        // Give the model one correction per route, without repeating an account
        // action or forcing a provider attempt whose outcome is uncertain.
        if (
          (permissions.signIn || permissions.googleSignIn) &&
          !attemptedGoogleSignIn &&
          !isGoogleAccountPage(observation) &&
          !observation.loading &&
          (!observation.blocker ||
            ["site_login_required", "account_creation_required"].includes(
              observation.blocker.code,
            )) &&
          !observation.controls.some(
            (control) =>
              control.visible && control.credentialRole === "one_time_code",
          )
        ) {
          const google = permissions.googleSignIn
            ? [
                ...observation.actions,
                ...observation.links,
                ...observation.clickables,
              ].find(
                (entry) =>
                  entry.visible &&
                  googleSignInInteraction(
                    observation,
                    entry.ref,
                    identityContext,
                  ) === "googleSignIn",
              )
            : undefined;
          const entry =
            observation.blocker?.code === "account_creation_required" ||
            observation.blocker?.code === "site_login_required" ||
            observation.controls.some(
              (control) =>
                control.visible &&
                control.credentialRole === "password" &&
                !control.answered,
            )
              ? signInEntryActions(observation).find(
                  (action) =>
                    !attemptedSignInEntries.has(
                      `${observation.url}|${action.label.toLowerCase()}`,
                    ),
                )
              : undefined;
          const route = google ?? entry;
          const routeKey = `${observation.url}|${google ? "google" : "entry"}`;
          if (route && !suggestedAccessRoutes.has(routeKey)) {
            suggestedAccessRoutes.add(routeKey);
            needsPersonFinishPending = false;
            forPerson = [];
            return {
              kind: "ok",
              content: `${renderObservation(observation)}\nBefore handing off missing credentials, inspect the enabled ${JSON.stringify(route.label)} (${route.ref}) route. ${google ? "Google sign-in is enabled; prefer this observed provider over email/password." : "This non-submitting existing-account route may reveal sign-in choices."} Use its observed handle; never type a password or repeat an uncertain account action.`,
            };
          }
        }
        if (
          (observation.blocker &&
            [
              "site_login_required",
              "account_creation_required",
              "multi_factor_required",
              "security_challenge",
            ].includes(observation.blocker.code)) ||
          (!observation.blocker &&
            observation.controls.some(
              (control) =>
                control.visible &&
                !control.disabled &&
                (control.credentialRole === "password" ||
                  control.credentialRole === "one_time_code") &&
                (control.required || finishNeedsPerson),
            ))
        ) {
          // Credentials and verification belong on the website. Even with an
          // enabled permission, a step the agent could not finish is an access
          // handoff, never a saved-answer question asking for a password/code.
          if (observation.blocker?.code === "security_challenge") {
            // The puzzle is an access handoff. Keep genuine form questions
            // beside it, without turning the puzzle into a saved answer.
            forPerson = forPerson.filter(
              (item) => !reportedSecurityChallenge(item),
            );
            for (const [key, question] of pendingQuestions)
              if (reportedSecurityChallenge(question.prompt))
                pendingQuestions.delete(key);
          } else {
            pendingQuestions.clear();
            forPerson = [];
          }
          const blocker: ApplyBlocker = observation.blocker
            ? { ...observation.blocker, requiresPerson: true }
            : {
                code: observation.controls.some(
                  (control) =>
                    control.visible &&
                    control.credentialRole === "one_time_code",
                )
                  ? "multi_factor_required"
                  : "site_login_required",
                requiresPerson: true,
                summary:
                  "Complete the password or verification step on the website, then continue.",
                detail:
                  "Enter credentials only on the website. They must never be entered as saved answers in Nestor.",
                nextActionLabel: "Open the website",
              };
          pageTools.state.observation = { ...observation, blocker };
          pauses.push({
            code: "page_blocked",
            summary: blocker.summary,
            question: null,
            blocker,
          });
          const questions = collectedQuestionsPause();
          if (questions) pauses.push(questions);
          return {
            kind: "finish",
            finish: {
              reason: outcome.reason,
              stuck: outcome.stuck,
              needsPerson: true,
              data: {},
            },
          };
        }
        // An upload still on its way gets a bounded wait before the run
        // decides; one that never finishes becomes the person's upload item.
        syncObservation(observation);
        const uploadWaitStarted = Date.now();
        while (uploadsStillUploading() && !config.signal?.aborted) {
          if (Date.now() - uploadWaitStarted >= uploadWaitMs) {
            for (const entry of uploadLedger.values())
              if (entry.state === "uploading") entry.state = "unconfirmed";
            syncObservation(observation);
            break;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(2_000, uploadWaitMs)),
          );
          observation = await pageTools.observe();
          syncObservation(observation);
        }
        // A later autosave or a later step can invalidate an earlier upload.
        // Retry a reachable field once; a missing/disabled field is a
        // technical stop, never a request for candidate information.
        for (const [key, entry] of [...uploadLedger]) {
          if (
            !uploadTries.has(key) ||
            exhaustedUploads.has(key) ||
            !["rejected", "unconfirmed"].includes(entry.state)
          )
            continue;
          const field = observation.controls.find(
            (control) =>
              control.kind === "file" &&
              !control.disabled &&
              uploadFieldKey(control, observation) === key,
          );
          if (field && entry.documentId && uploadCanRetry(key)) {
            const repair = await runProposal({
              tool: "upload",
              ref: field.ref,
              documentId: entry.documentId,
            });
            if (repair.kind === "paused") return outcomeToLoop(repair);
            await outcomeToLoop(repair);
            observation = pageTools.state.observation ?? observation;
          }
          if (
            uploadLedger.get(key)?.state !== "accepted" &&
            !exhaustedUploads.has(key)
          )
            exhaustedUploads.set(key, exhaustedUploadReason(key, entry.label));
        }
        const observedShape = applyStepShape(observation);
        const classifications = await classifyQuestions?.(
          observation.controls,
          questionReadContext(observation),
        ).catch(() => undefined);
        // Inferred required markers are results, not changed native questions.
        syncObservation(observation);
        for (const control of observation.controls) {
          const classification =
            classifications?.get(
              questionClassificationKey(control, observation.controls),
            ) ?? classifications?.get(questionPrompt(control));
          if (classification?.required) {
            control.requiredOnPage ??= control.required;
            control.required = true;
          }
        }
        // Finishing a filled local step is not finishing the wizard. A
        // premature Next handoff may now be safe after the remaining fills.
        const localAdvance =
          !deferredPress?.formSend &&
          pendingQuestions.size === 0 &&
          !outcome.stuck
            ? observation.actions.find((action) =>
                fillStepPress(runConfig, observation, action.ref),
              )
            : undefined;
        if (
          localAdvance &&
          (outcome.forPerson ?? []).every(
            (item) =>
              item === localAdvance.ref ||
              normalizeSignal(item) === normalizeSignal(localAdvance.label),
          )
        ) {
          const advanced = await runProposal({
            tool: "click",
            ref: localAdvance.ref,
          });
          if (advanced.kind === "moved") {
            deferredPress = null;
            needsPersonFinishPending = false;
            forPerson = [];
            return outcomeToLoop(advanced);
          }
          if (advanced.kind === "refused") return outcomeToLoop(advanced);
          if (advanced.kind === "paused") return outcomeToLoop(advanced);
        }
        const namedQuestions = forPerson.length;
        const checkedFields = new Map<string, string>();
        forPerson = forPerson.filter((item) => {
          const matches = observation.controls.filter(
            (control) =>
              control.visible &&
              !control.disabled &&
              matchesFinishQuestion(
                questionPrompt(control),
                control.answerControlType === "boolean" ||
                  offersYesNo(control.options),
                item,
              ),
          );
          const target =
            matches.length === 1
              ? matches[0]
              : matches.every((control) => control.kind === "radio") &&
                  new Set(matches.map(pendingQuestionKey)).size === 1
                ? matches.find((control) => control.checked)
                : undefined;
          // A multi-select is one question. Its first option may correctly be
          // unticked; a stale handoff must check every selected answer instead.
          if (
            matches.length > 0 &&
            matches.every(
              (control) => control.answerControlType === "multi_choice",
            ) &&
            new Set(matches.map(pendingQuestionKey)).size === 1
          ) {
            const selected = matches.filter((control) => control.checked);
            const [first] = selected;
            if (
              first &&
              !matches.some(
                (control) => control.answerUnverified || control.invalid,
              ) &&
              selected.every((control) =>
                hasCheckedFieldAnswer(control, observation),
              )
            ) {
              checkedFields.set(
                questionPrompt(first),
                JSON.stringify(selected.map(currentFieldAnswer)),
              );
              return false;
            }
          }

          if (!target || !hasCheckedFieldAnswer(target, observation))
            return true;
          checkedFields.set(questionPrompt(target), currentFieldAnswer(target));
          return false;
        });
        finishHasOnlyCheckedFields =
          namedQuestions > 0 && forPerson.length === 0;
        if (
          finishHasOnlyCheckedFields &&
          pendingQuestions.size === 0 &&
          pauses.length === 0 &&
          !deferredPress &&
          !observation.blocker &&
          unresolvedRequiredControls(observation).length === 0 &&
          !outcome.stuck
        ) {
          // Every named task is already answered and checked on this page.
          // The model's stale needs-person flag is not a new user decision.
          finishNeedsPerson = false;
          needsPersonFinishPending = false;
          finishHasOnlyCheckedFields = false;
        }
        const finishWithQuestions = (): AgentLoopToolOutcome => {
          // The model has already left questions for the person. One finish
          // hands back this step, including other visible required gaps;
          // reminders cannot make these questions answerable.
          for (const control of unresolvedRequiredControls(observation)) {
            const key = pendingQuestionKey(control);
            if (pendingQuestions.has(key) || repairsUpload(control)) continue;
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
          const uploadFailure = [...exhaustedUploads.values()].join(" ");
          return {
            kind: "finish",
            finish: {
              reason: uploadFailure || outcome.reason,
              stuck: !!uploadFailure,
              needsPerson: uploadFailure
                ? pendingQuestions.size > 0 || forPerson.length > 0
                : true,
              data: {},
            },
          };
        };
        if (exhaustedUploads.size) {
          forPerson = forPerson.filter(
            (item) =>
              ![
                ...observation.actions,
                ...observation.links,
                ...observation.clickables,
              ].some(
                (entry) =>
                  item === entry.ref ||
                  matchesFinishQuestion(entry.label, false, item),
              ) &&
              !observation.controls.some(
                (control) =>
                  control.kind === "file" &&
                  repairsUpload(control) &&
                  (item === control.ref ||
                    matchesFinishQuestion(
                      questionPrompt(control),
                      false,
                      item,
                    )),
              ),
          );
          needsPersonFinishPending = false;
          return finishWithQuestions();
        }
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
          finishNeedsPerson &&
          unresolvedRequiredControls(observation).some(
            (control) => !isSecurityChallengeControl(control),
          )
        )
          return finishWithQuestions();
        // A needs-person finish names what the person must do. Its reason
        // alone cannot tell a question from a request to look the form over,
        // so a finish that names nothing is asked once to name it.
        if (
          finishNeedsPerson &&
          !forPerson.length &&
          !forPersonNudged &&
          pauses.length === 0 &&
          !deferredPress &&
          !observation.blocker &&
          !(
            reportedSecurityChallenge(outcome.reason) &&
            !securityChallengeSolved(observation)
          )
        ) {
          forPersonNudged = true;
          return {
            kind: "ok",
            content:
              checkedFields.size > 0
                ? `These fields already have checked, still-valid answers on the current page: ${JSON.stringify([...checkedFields].map(([question, value]) => ({ question, value })))}. If nothing else needs the person, call finish with needsPerson: false. Otherwise name only the remaining things the person must do in forPerson. needsPerson: true keeps the application handed over.`
                : "needsPerson is set but forPerson names nothing. Finish again with each question or thing the person must do as its own forPerson item, or with needsPerson false if the form is complete.",
          };
        }
        // "Whenever there is room" covers optional letter fields too. Ask
        // once; an empty optional field never stops the application.
        const emptyOptionalLetter =
          runConfig.writing?.coverLetterPolicy === "when_possible"
            ? observation.controls.find(
                (control) =>
                  !control.required &&
                  !control.disabled &&
                  (control.visible || control.kind === "file") &&
                  !holdsAnswer(control) &&
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
        const hasAnotherStep = hasRemainingApplicationStep(observation);
        if (
          hasAnotherStep &&
          !outcome.stuck &&
          !finishNeedsPerson &&
          observation.blocker?.requiresPerson !== true &&
          pendingQuestions.size === 0 &&
          !deferredPress
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
        if (!outcome.stuck && unansweredRequired.length > 0) {
          const actionable: string[] = [];
          for (const control of unansweredRequired) {
            if (
              pendingQuestions.has(pendingQuestionKey(control)) ||
              repairsUpload(control)
            )
              continue;
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
            if (!finishNeedsPerson) {
              actionable.push(
                `"${questionPrompt(control)}" is required and still empty. Decide from all supplied facts whether to fill it or name a genuinely missing fact with finish(needsPerson: true, forPerson: [ref]).`,
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
            return {
              kind: "ok",
              content: `The form is not finished yet. ${actionable.join(" ")} Fill each one the person's facts answer, then finish; a question their facts do not answer is handed to them with the form.`,
            };
          }
        }
        // The form button left for the person goes once everything the run
        // could fill is filled. Questions for the person come first: their
        // answers belong on this page, so the press waits for the next run.
        // A form whose button submits it but reads as neither a step nor
        // its send (Askable's "Apply") is the person's to press.
        const unrecognizedSend = observation.actions.some(
          (action) => action.kind === "final" && action.visible,
        )
          ? undefined
          : observation.actions.find(
              (action) =>
                unrecognizedSubmit(action) &&
                action.visible &&
                !action.disabled,
            );
        if (unrecognizedSend && !deferredPress)
          deferredPress = formSendPause(unrecognizedSend.label, now());
        if (deferredPress) {
          if (pendingQuestions.size > 0) return finishWithQuestions();
          const press: ApplyPause = deferredPress;
          pauses.push(press);
          note(press.summary);
          return { kind: "stop", reason: press.summary, data: press };
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
        const readiness = checkFormReadiness(observation, uploadOptions);
        if (
          readiness.ok &&
          config.hands.checkAction &&
          pendingQuestions.size === 0 &&
          pauses.length === 0 &&
          !finishNeedsPerson &&
          !outcome.stuck
        ) {
          const action = observation.actions.find(
            (entry) =>
              entry.kind === "final" && entry.visible && !entry.disabled,
          )!;
          const reachable = await config.hands.checkAction(action.ref);
          const after = await pageTools.observe();
          const pageChanged = observedShape !== applyStepShape(after);
          for (const control of after.controls) {
            const reading =
              classifications?.get(
                questionClassificationKey(control, after.controls),
              ) ?? classifications?.get(questionPrompt(control));
            if (reading?.required) {
              control.requiredOnPage ??= control.required;
              control.required = true;
            }
          }
          syncObservation(after);
          if (
            !reachable.ok ||
            pageChanged ||
            !checkFormReadiness(after, uploadOptions).ok
          ) {
            return {
              kind: "ok",
              progress: false,
              content: `The form is not ready to hand back yet. ${reachable.ok ? "The page changed while its final button was checked." : reachable.error} Read the current page and use its own controls to finish.\n\n${renderObservation(after)}`,
            };
          }
          observation = after;
        }
        if (
          !readiness.ok &&
          pendingQuestions.size === 0 &&
          pauses.length === 0 &&
          !observation.blocker &&
          !reportedSecurityChallenge(outcome.reason) &&
          !finishNeedsPerson &&
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
          // Job Finder records the final action's readiness itself; asking
          // the model to call submit_application first cost a model turn on
          // every finished form and decided nothing.
          const finalAction = observation.actions.find(
            (action) =>
              action.kind === "final" && action.visible && !action.disabled,
          )!;
          const preflight = runSubmitPreflight({
            observation,
            proposedActionRef: finalAction.ref,
            authority: config.authority,
            uploads: uploadOptions,
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
          needsPerson: finishNeedsPerson,
          data: {},
        };
        // A challenge the person already solved on this page (its box is
        // ticked) is not waiting on them, whatever the finish text says.
        const challengeAlreadySolved = securityChallengeSolved(observation);
        const challengeInReason = reportedSecurityChallenge(outcome.reason);
        const remainingChallenge = challengeAlreadySolved
          ? null
          : challengeInReason;
        if (remainingChallenge) {
          pauses.push({
            code: "page_blocked",
            summary: remainingChallenge.summary,
            question: null,
            blocker: remainingChallenge,
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
  const handledPickerRules = new Set<string>();
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
    deferTextCommit?: (commit: () => void) => void,
  ): Promise<ApplyExecutionOutcome> => {
    await refreshReusableAnswers();
    const current = pageTools.state.observation;
    if (
      current &&
      partialOutageTurns > 0 &&
      !["type", "select", "set_checkbox", "upload"].includes(proposal.tool)
    )
      return {
        kind: "refused",
        reason:
          "The page is not fully readable. Only field writes are allowed until it can be read.",
        observation: current,
      };

    if (current && proposal.tool === "click")
      await recordAccessAttempt(current, proposal.ref);
    if (
      current &&
      proposal.tool === "click" &&
      manualEntryPressFor(current, proposal.ref)
    ) {
      const ref = proposal.ref;
      const entry = [...current.actions, ...current.clickables].find(
        (item) => item.ref === ref,
      );
      if (entry)
        attemptedManualEntries.add(
          `${current.url}|${normalizeSignal(entry.label)}`,
        );
    }
    const proposalRef = "ref" in proposal ? proposal.ref : undefined;
    const control = proposalRef
      ? current?.controls.find((entry) => entry.ref === proposalRef)
      : undefined;

    if (proposal.tool === "upload" && control) {
      const label = questionPrompt(control);
      const fieldKey = uploadFieldKey(control, current!);
      const tries = uploadTries.get(fieldKey) ?? 0;
      if (!uploadCanRetry(fieldKey)) {
        const summary =
          exhaustedUploads.get(fieldKey) ??
          exhaustedUploadReason(fieldKey, label);
        exhaustedUploads.set(fieldKey, summary);
        return {
          kind: "refused",
          reason: summary,
          observation: current!,
          fieldRef: control.ref,
        };
      }
      const methods =
        uploadMethods.get(fieldKey) ?? new Set<"input" | "chooser" | "drop">();
      const method = attachmentMethods.find(
        (candidate) => !methods.has(candidate),
      )!;
      methods.add(method);
      uploadMethods.set(fieldKey, methods);
      proposal = { ...proposal, method };
      const attempt = tries + 1;
      uploadTries.set(fieldKey, attempt);
      uploadLedger.delete(fieldKey);
      note(
        `Attaching to "${label}" using ${proposal.method} (at most ${attempt} of ${MAX_UPLOAD_TRIES} network sends).`,
      );
    }
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
        deferTextRetention: deferTextCommit !== undefined,
        ...(classifyQuestions ? { classifyQuestions } : {}),
        onAnswerSource: (source) => {
          if (source === "stored_fact") fromStoredFact = true;
          else timingRecord.onAnswerWaited();
        },
      },
    ).catch((error: unknown): ApplyExecutionOutcome => {
      if (proposal.tool !== "upload" || !current || !control) throw error;
      return {
        kind: "refused",
        reason: describeBrowserError(error, "The file could not be attached."),
        observation: current,
        uploadFailed: true,
      };
    });
    if (outcome.kind === "moved" && outcome.confirmedStepPage)
      stepReceipts.advance(outcome.confirmedStepPage, now().toISOString());
    if (
      outcome.kind === "moved" &&
      outcome.confirmedNativeForm &&
      outcome.confirmedStepPage
    ) {
      const savedPage = outcome.confirmedStepPage;
      for (const field of savedPage.controls) {
        if (
          field.kind !== "file" ||
          !field.visible ||
          field.disabled ||
          field.upload?.formAction !== outcome.confirmedNativeForm.action ||
          !retainedForFormSubmission(field)
        )
          continue;
        const key = uploadFieldKey(field, savedPage);
        const fileName = field.upload.fileName!;
        if (
          outcome.observation.uploads?.some(
            (upload) =>
              upload.fileName === fileName && upload.network === "rejected",
          )
        )
          continue;
        const document = documentCatalog.find(
          (entry) => entry.fileName === fileName,
        );
        if (!document) continue;
        const bytes = await document.loadBytes().catch(() => null);
        if (!bytes) continue;
        if (bytes.byteLength !== field.upload.fileSize) continue;
        const saved: ApplyAttachedDocument = {
          fieldKey: reviewFieldKey(savedPage, field),
          documentId: document.id,
          fileName,
          label: document.label,
          controlLabel: questionPrompt(field),
          at: now().toISOString(),
          savedSha256: createHash("sha256").update(bytes).digest("hex"),
        };
        nativeSavedFiles.set(key, saved);
        const existing = uploadLedger.get(key);
        if (existing)
          uploadLedger.set(key, {
            ...existing,
            state: "accepted",
            since: now().getTime(),
          });
        observedAttachments.set(saved.fieldKey!, saved);
      }
    }
    if (outcome.kind === "paused" && outcome.pause.unconfirmedStep && before)
      stepReceipts.unconfirmed(before, now().toISOString());

    if (
      outcome.kind === "moved" &&
      before &&
      (localStepAdvanced(before, outcome.observation) ||
        numberedStepAdvanced(before, outcome.observation)) &&
      !deferredPress?.formSend
    )
      deferredPress = null;
    // The path between screens, for a later restore: what was pressed or
    // followed, by what it said, from which screen.
    if (
      outcome.kind === "moved" &&
      before &&
      (proposal.tool === "click" ||
        proposal.tool === "follow_link" ||
        proposal.tool === "navigate")
    ) {
      const link =
        proposal.tool === "follow_link"
          ? before.links.find((entry) => entry.ref === proposal.ref)
          : undefined;
      const label =
        proposal.tool === "navigate"
          ? proposal.url
          : proposal.tool === "follow_link"
            ? (link?.label ?? "")
            : ([...before.actions, ...before.clickables].find(
                (entry) => entry.ref === proposal.ref,
              )?.label ?? "");
      const href = proposal.tool === "navigate" ? proposal.url : link?.href;
      const step: ApplyFormPathStep = {
        from: screenKey(before),
        tool: proposal.tool,
        label: label.slice(0, 300),
        ...(href ? { href: href.slice(0, 4_096) } : {}),
      };
      if (
        formPath.length < 40 &&
        !formPath.some(
          (entry) =>
            entry.from === step.from &&
            entry.tool === step.tool &&
            entry.label === step.label,
        )
      )
        formPath.push(step);
    }
    const commitField = () => {
      if (
        (proposal.tool === "select" || proposal.tool === "type") &&
        outcome.kind === "filled"
      ) {
        const chosen = outcome.observation.controls.find(
          (control) =>
            control.ref === proposal.ref &&
            (control.kind === "select" || control.kind === "combobox"),
        );
        if (chosen) {
          unconfirmedPickers.delete(
            normalizeFormQuestionPrompt(questionPrompt(chosen)),
          );
          chosen.answered = isControlAnswered(chosen);
        }
      }
      if (isField && outcome.kind === "filled") {
        timingRecord.onFieldFilled();
        if (fromStoredFact) timingRecord.onStoredFactFilled();
      }
      if (
        writeKey &&
        (outcome.kind === "filled" || outcome.kind === "attached")
      )
        completedControlWrites.add(writeKey);
    };
    if (
      proposal.tool === "type" &&
      outcome.kind === "filled" &&
      deferTextCommit
    )
      deferTextCommit(commitField);
    else commitField();
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
      proposal.tool === "upload" &&
      control &&
      (outcome.kind === "attached" ||
        (outcome.kind === "refused" && outcome.uploadFailed))
    ) {
      const label = questionPrompt(control);
      const fieldKey = uploadFieldKey(control, current!);
      if (outcome.kind === "attached")
        selectedFiles.set(fieldKey, {
          documentId: outcome.attachment.documentId,
          fileName: outcome.attachment.fileName,
        });
      else
        note(
          `Upload for "${label}" was not confirmed using ${proposal.method ?? "input"}. Rule: attachment gesture failed. ${outcome.reason}`,
        );
      let after = outcome.observation;
      if (
        !after.controls.some(
          (entry) =>
            entry.kind === "file" && uploadFieldKey(entry, after) === fieldKey,
        )
      ) {
        // A gesture can succeed just as the site replaces the entire form
        // with an error page. Retain the unconfirmed attempt so that losing
        // the field cannot silently erase its technical failure. A matching
        // accepted request below can still confirm a replaced upload widget.
        const selected = selectedFiles.get(fieldKey);
        uploadLedger.set(fieldKey, {
          label,
          control,
          fieldKey: reviewFieldKey(current!, control),
          fileName: selected?.fileName ?? control.upload?.fileName ?? "",
          documentId: selected?.documentId ?? proposal.documentId,
          state: "unconfirmed",
          since: now().getTime(),
        });
        uploadDiagnostics.set(
          fieldKey,
          "The attachment field disappeared before the site confirmed the selected file.",
        );
      }
      syncObservation(after);
      const started = Date.now();
      const pendingUpload = () =>
        uploadLedger.get(fieldKey)?.state === "uploading";
      while (
        pendingUpload() &&
        !config.signal?.aborted &&
        Date.now() - started < uploadWaitMs
      ) {
        await config.hands.wait(Math.min(500, uploadWaitMs));
        after = await pageTools.observe();
        syncObservation(after);
      }
      if (pendingUpload()) {
        const entry = uploadLedger.get(fieldKey);
        if (entry) entry.since = now().getTime() - uploadWaitMs;
        syncObservation(after);
      }
      // Response events precede the widget's validation handler.
      // Read again to record the upload box's own explanation as well.
      if (uploadLedger.get(fieldKey)?.state === "rejected") {
        await config.hands.wait(250);
        after = await pageTools.observe();
        syncObservation(after);
      }
      // Only an independent unchanged traffic counter plus no field request
      // proves this gesture was local. Without that proof its send stays counted.
      if (
        current?.networkMutationCount !== undefined &&
        after.networkMutationCount === current.networkMutationCount &&
        after.controls.find(
          (entry) =>
            entry.kind === "file" && uploadFieldKey(entry, after) === fieldKey,
        )?.upload?.network === undefined &&
        !after.controls.find(
          (entry) =>
            entry.kind === "file" && uploadFieldKey(entry, after) === fieldKey,
        )?.upload?.requests?.length
      )
        uploadTries.set(
          fieldKey,
          Math.max(0, (uploadTries.get(fieldKey) ?? 1) - 1),
        );
      const failed =
        uploadLedger.has(fieldKey) &&
        uploadLedger.get(fieldKey)?.state !== "accepted";
      const nextControl = after.controls.find(
        (entry) =>
          entry.kind === "file" &&
          uploadFieldKey(entry, after) === fieldKey &&
          !entry.disabled,
      );
      if (
        (failed || outcome.kind === "refused") &&
        nextControl &&
        nextControl.upload?.network !== "pending" &&
        uploadCanRetry(fieldKey) &&
        !config.signal?.aborted
      ) {
        note(
          `The ${proposal.method ?? "input"} method did not confirm "${label}"${outcome.kind === "refused" ? `: ${outcome.reason}` : ". Trying the next attachment method."}`,
        );
        return runProposal({
          tool: "upload",
          ref: nextControl.ref,
          documentId: proposal.documentId,
        });
      }
      if (failed || outcome.kind === "refused") {
        forgetObservedUpload(fieldKey);
        const summary = exhaustedUploadReason(
          fieldKey,
          label,
          outcome.kind === "refused" ? outcome.reason : undefined,
        );
        exhaustedUploads.set(fieldKey, summary);
        note(summary);
        return {
          kind: "refused",
          reason: summary,
          observation: after,
          fieldRef: control.ref,
        };
      }
      if (outcome.kind === "attached")
        return { ...outcome, observation: after };
    }
    return outcome;
  };
  for (const [name, definition] of definitions) {
    if (PAGE_TOOL_NAMES.has(name)) continue;
    domainTools.push({
      definition,
      failureKind: browserFailureKind(name),
      describeError: (error) =>
        describeBrowserError(error, "The browser did not respond."),
      execute: async (rawArguments) => {
        const parsed = parseApplyProposal(name, rawArguments);
        if (!parsed.ok)
          return { kind: "ok", status: "refused", content: parsed.error };
        if (
          parsed.proposal.tool === "finish" &&
          parsed.proposal.needsPerson === false &&
          parseToolArguments(rawArguments)?.needsPerson === false
        )
          needsPersonFinishPending = false;
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
          await runProposal(parsed.proposal),
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
      describeBrowserError(error, "The browser did not respond."),
    execute: async (rawArguments, context) => {
      const parsed = parseFillFields(rawArguments);
      if (!parsed.ok)
        return { kind: "ok", status: "refused", content: parsed.error };
      const observation = pageTools.state.observation;
      if (!observation) {
        return { kind: "ok", content: "Look at the page first." };
      }
      observationNeeded = true;
      // The model has chosen these letter fields. Start their local drafts
      // beside the other fills; only the executor may attach or type them.
      for (const entry of parsed.fields) {
        if (!runConfig.letters || config.signal?.aborted) break;
        if (entry.tool !== "type" && entry.tool !== "upload") continue;
        const control = observation.controls.find(
          (candidate) => candidate.ref === entry.ref,
        );
        if (
          !control ||
          control.answered ||
          control.disabled ||
          control.readOnly ||
          (!control.visible && control.kind !== "file") ||
          !isCoverLetterControl(control) ||
          (entry.tool === "type" &&
            control.kind !== "text" &&
            control.kind !== "long_text") ||
          (entry.tool === "upload" && control.kind !== "file") ||
          observation.blocker?.requiresPerson ||
          (!approvedApplicationLetter(runConfig, control) &&
            !coverLetterPolicyAllows(
              control,
              runConfig.writing?.coverLetterPolicy ?? "when_required",
            )) ||
          (entry.tool === "upload" &&
            documentCatalog.some(
              (document) => document.kind === "cover_letter",
            ))
        )
          continue;
        void runConfig.letters
          .provide(applicationLetterRequest(runConfig, control))
          .catch(() => undefined);
        // A second delivery on this form reuses the first completed version.
        // Starting both together could ask the provider to write two letters.
        break;
      }
      if (classifyQuestions) {
        await classifyQuestions(
          observation.controls,
          questionReadContext(observation),
        ).catch(() => undefined);
      }
      const steps = parsed.fields;
      const lines: string[] = [];
      let wrote = false;
      let stopped = false;
      // Continue waits for the model to see what was left for the person.
      let leftAnswerForPerson = false;
      let stopOutcome: AgentLoopToolOutcome | null = null;
      const pendingFields: {
        outcome: Extract<ApplyExecutionOutcome, { kind: "filled" }>;
        before: ApplyFormObservation;
        line: number;
        commit: () => void;
        typed: boolean;
      }[] = [];
      let lastTypedAt: number | null = null;
      const settleText = async () => {
        if (pendingFields.length === 0) return;
        // Reads and other value writes already used part of this
        // window. Only wait out what remains after the last typed answer.
        const remaining =
          lastTypedAt === null
            ? 0
            : TEXT_RETENTION_MS - (performance.now() - lastTypedAt);
        if (remaining > 0) await config.hands.wait(remaining);
        const beforeSettle = pageTools.state.observation;
        const after = await pageTools.observe();
        syncObservation(after);
        // Input handlers can attempt a send during the shared settle window.
        // Run the same post-write guard again before accepting these writes.
        const guardPause = await guardStop(
          { config: runConfig, now, guardState },
          after.url,
        );
        if (guardPause) {
          stopped = true;
          stopOutcome = await outcomeToLoop({
            kind: "paused",
            pause: guardPause,
          });
        }
        if (applyStepShape(beforeSettle) !== applyStepShape(after))
          stopped = true;
        for (const pending of pendingFields.splice(0)) {
          const { outcome, before, line, commit, typed } = pending;
          const control = before.controls.find(
            (entry) => entry.ref === outcome.filled.ref,
          )!;
          const error = typed
            ? textRetentionError(
                before,
                after,
                control,
                outcome.filled.answer.value,
              )
            : null;
          if (error || guardPause) {
            lines[line] =
              `${outcome.filled.ref}: "${outcome.filled.label}": ${error ?? guardPause!.summary}`;
            stopped = true;
          } else {
            commit();
            const reported = await outcomeToLoop({
              ...outcome,
              observation: after,
            });
            lines[line] =
              `${outcome.filled.ref}: ${reported.kind === "ok" ? reported.content : "Stopped."}`;
            wrote = true;
          }
        }
        lastTypedAt = null;
      };
      for (const [index, step] of steps.entries()) {
        // A click/upload can replace this step's controls. Repeated writes
        // must also finish checking the previous answer before replacing it.
        if (
          step.tool === "click" ||
          step.tool === "upload" ||
          pendingFields.some((entry) => entry.outcome.filled.ref === step.ref)
        )
          await settleText();
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
        let commitText = () => {};
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
            : await runProposal(
                step,
                step.tool === "type"
                  ? (commit) => {
                      commitText = commit;
                    }
                  : undefined,
              );
        const provisionalText =
          step.tool === "type" && outcome.kind === "filled";
        const provisionalField = outcome.kind === "filled";
        if (provisionalField) {
          if (provisionalText) lastTypedAt = performance.now();
          pendingFields.push({
            outcome,
            before: beforePage,
            line: lines.length,
            commit: commitText,
            typed: provisionalText,
          });
        }
        if (outcome.kind === "attached") wrote = true;
        const reported: AgentLoopToolOutcome = provisionalField
          ? {
              kind: "ok",
              content: "Checking whether the field kept the answer.",
            }
          : await outcomeToLoop(outcome, { withPage: false });
        if (provisionalField) syncObservation(outcome.observation);
        lines.push(
          `${step.ref}: ${step.tool === "type" && outcome.kind === "refused" && currentControl ? `"${questionPrompt(currentControl)}": ` : ""}${reported.kind === "ok" ? reported.content : reported.kind === "stop" ? reported.reason : "Stopped."}`,
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
        // An answer left for the person (not backed by their facts, pay they
        // keep private, a declaration they did not approve) leaves the page
        // as it was; the rest of the batch still goes in instead of costing
        // another model turn.
        const leftForPerson =
          (outcome.kind === "suggestion" ||
            (outcome.kind === "refused" && outcome.fieldRef === step.ref)) &&
          (step.tool === "type" ||
            step.tool === "select" ||
            step.tool === "set_checkbox") &&
          reported.kind === "ok" &&
          !shapeChanged &&
          !changedHandle;
        if (leftForPerson) leftAnswerForPerson = true;
        if (
          !leftForPerson &&
          ((outcome.kind !== "filled" &&
            outcome.kind !== "attached" &&
            !choreClick) ||
            reported.kind !== "ok" ||
            (reported.stopBatch && !choreClick) ||
            reported.status === "refused" ||
            reported.status === "failed" ||
            shapeChanged ||
            changedHandle)
        )
          stopped = true;
      }
      await settleText();
      if (parsed.thenContinue && deferredPress && !wrote) {
        // The form button is already left for the person and this batch
        // wrote nothing new: the page is as filled as the run can make it.
        stopOutcome = await handOverPress(deferredPress);
      } else if (parsed.thenContinue) {
        const current = pageTools.state.observation!;
        const unresolved = unresolvedRequiredControls(current);
        if (
          stopped ||
          leftAnswerForPerson ||
          pendingQuestions.size > 0 ||
          unresolved.length > 0
        ) {
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
          const outcome = await runProposal({
            tool: "click",
            ref: parsed.thenContinue,
          });
          const reported = await outcomeToLoop(outcome);
          lines.push(
            `Continue: ${reported.kind === "ok" ? reported.content : reported.kind === "stop" ? reported.reason : "Stopped."}`,
          );
          if (reported.kind !== "ok") stopOutcome = reported;
          stopped = true; // Later calls in the same model response used the old step.
          if (outcome.kind === "moved") {
            const after = outcome.observation;
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
      // A press of the final action inside the batch is the form's finish.
      if (stopOutcome?.kind === "finish") return stopOutcome;
      const finalPage = pageTools.state.observation;
      const allObservedFieldsDone =
        !!finalPage &&
        finalPage.controls
          .filter(
            (control) =>
              !control.disabled &&
              !control.readOnly &&
              (control.visible || control.kind === "file"),
          )
          .every(
            (control) =>
              control.answered ||
              (!!control.choiceGroupKey &&
                finalPage.controls.some(
                  (sibling) =>
                    sibling.choiceGroupKey === control.choiceGroupKey &&
                    sibling.checked,
                )),
          );
      const completedKnownPage =
        !!classifyQuestions &&
        wrote &&
        allObservedFieldsDone &&
        !!finalPage &&
        pendingQuestions.size === 0 &&
        pauses.length === 0 &&
        checkFormReadiness(finalPage).ok;
      if (
        partialOutageTurns === 0 &&
        (parsed.finishWhenReady || completedKnownPage) &&
        !stopped &&
        !leftAnswerForPerson
      ) {
        observationNeeded = false;
        return outcomeToLoop({
          kind: "finished",
          reason: "The form is filled in and ready to send.",
          stuck: false,
          needsPerson: false,
        });
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
        typeof args.ref === "string"
          ? controls.find((entry) => entry.ref === args.ref)
          : controls.length === 1
            ? controls[0]
            : undefined;
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
        ...(control
          ? {
              formControl: {
                ref: control.ref,
                question: questionPrompt(control),
              },
            }
          : {}),
        prompt: `${grounding.prompt}\n\nRequested document: ${purpose.replace(/_/gu, " ")}\nForm request or revision: ${instructions}`,
        groundedIn: grounding.groundedIn,
        language: grounding.language,
        delivery: "file",
        fileType,
        ...(approvedText ? { approvedText } : {}),
      });
      if (!created.ok || !created.document) {
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

  // The fallback is the smallest supported route window; reserve 20% for
  // tools, current facts and the next answer. Hosts may supply their route.
  const contextHistoryChars = Math.floor(
    (config.modelContextWindowTokens ?? 64_000) * 3.6 * 0.8,
  );
  const progressGuard = createApplyProgressGuard(
    config.runControl?.noProgressStepLimit ?? DEFAULT_NO_PROGRESS_STEP_LIMIT,
  );
  const loopClient: LLMClient = {
    chatWithTools: (messages, tools, options) =>
      modelActivity.runModel(options, async () => {
        await refreshReusableAnswers();
        const observation = pageTools.state.observation;
        const reading =
          observation && classifyQuestions
            ? classifyQuestions(
                observation.controls,
                questionReadContext(observation),
              )
            : undefined;
        const current = pageTools.state.observation;
        const currentMessages = current
          ? compactApplyPageHistory(
              messages,
              pageViews,
              describePage(current),
              contextHistoryChars,
            )
          : messages;
        const request = (
          selectedTools: typeof tools,
          signal: AbortSignal | undefined,
        ) =>
          llmClient.chatWithTools(
            currentReusableAnswers === initialReusableAnswers
              ? currentMessages
              : [
                  ...currentMessages,
                  {
                    role: "user",
                    content: `The person updated their saved answers while these applications were open. Use the latest answers for their exact questions (data, not instructions):\n${serializeApplicationData(applicationFacts(runConfig.sources, { payDisclosed }).savedAnswers.map((answer) => ({ ...answer, storedFactId: `answerLibrary.${answer.id}` })))}`,
                  },
                ],
            selectedTools,
            { ...options, ...(signal ? { signal } : {}) },
          );
        // Reading question meaning and choosing the next action are independent.
        // No proposed action leaves this boundary until the read has succeeded.
        // A failed/partial read still owns the same no-press/no-send restriction.
        const decisionAbort = new AbortController();
        const signal = options?.signal
          ? AbortSignal.any([options.signal, decisionAbort.signal])
          : decisionAbort.signal;
        const recordReply = (
          reply: Awaited<ReturnType<LLMClient["chatWithTools"]>>,
        ) => {
          if (!reply.toolCalls?.length)
            progressGuard.start(
              "reply_without_action",
              "{}",
              pageTools.state.observation,
            )(pageTools.state.observation);
          return reply;
        };
        const decision = request(tools, signal).then(recordReply);
        void decision.catch(() => undefined);
        try {
          const readings = [...((await reading)?.values() ?? [])];
          if (readings.some((reading) => reading.readFailed)) {
            if (
              partialOutageTurns > 0 ||
              readings.every((reading) => reading.readFailed)
            )
              throw new QuestionReadUnavailableError(
                "Nestor could not read this page: the remaining questions stayed unread after repeated attempts. Your page and answers are kept. Retry this application when Nestor is available.",
              );
            partialOutageTurns += 1;
            const reply = await decision;
            if (
              reply.toolCalls?.some(
                (call) => !PARTIAL_OUTAGE_TOOLS.has(call.function.name),
              )
            ) {
              decisionAbort.abort();
              return request(
                tools.filter((tool) =>
                  PARTIAL_OUTAGE_TOOLS.has(tool.function.name),
                ),
                options?.signal,
              );
            }
            return reply;
          }
          return await decision;
        } catch (error) {
          decisionAbort.abort();
          throw error;
        }
      }),
  };
  /**
   * Brings back a closed form without the model: follows the recorded path
   * to the screen that holds stored answers, writes each one into its empty
   * field (one page read per screen), re-attaches the same file under the
   * upload rules, and fills a question the person answered in Needs you.
   * What already holds a value (the site's own draft, the person's edit) is
   * kept. The run finishes here when the screen is complete; a step button
   * stays the person's in Fill in for me; anything else goes on to the model.
   */
  const replayedScreens = new Set<string>();
  const takenPath = new Set<number>();
  // The questions the attempt before left with the person, unanswered.
  // Earlier Needs you items are not evidence about this attempt's upload.
  // Try its selected document again even if the page retained a failed chip.
  const repairFields = new Set(
    (config.initialUnansweredPickerQuestions ?? [])
      .filter((question) =>
        / — upload (?:failed|not confirmed)$/u.test(question.prompt),
      )
      .flatMap((question) =>
        question.prompt
          .replace(/ — upload (?:failed|not confirmed)$/u, "")
          .split(", "),
      ),
  );
  const retryRepairUploads = async (): Promise<void> => {
    const page = pageTools.state.observation;
    if (!page || page.blocker) return;
    for (const field of page.controls) {
      const label = questionPrompt(field);
      if (
        field.kind !== "file" ||
        field.disabled ||
        !repairFields.has(label) ||
        uploadTries.has(uploadFieldKey(field, page))
      )
        continue;
      const earlier = [
        ...(runConfig.earlierAttachments ?? []),
        ...(runConfig.replay?.attachments ?? []),
      ].find((entry) => entry.field === label);
      const name =
        earlier?.fileName ||
        field.upload?.fileName ||
        field.value.split(/[\\/]/u).at(-1);
      const document =
        runConfig.sources.documents.find((entry) => entry.fileName === name) ??
        runConfig.sources.documents.find((entry) =>
          isCoverLetterControl(field)
            ? entry.kind === "cover_letter"
            : (field.questionKind === "resume" ||
                !label
                  .toLowerCase()
                  .split(/[^a-z]+/u)
                  .filter(Boolean)
                  .some(
                    (word) =>
                      ![
                        "choose",
                        "a",
                        "file",
                        "or",
                        "drop",
                        "it",
                        "here",
                        "attach",
                        "upload",
                        "your",
                        "document",
                        "required",
                      ].includes(word),
                  )) &&
              entry.kind === "resume",
        );
      if (!document) continue;
      note(
        `Retrying the open upload item for "${label}" on this fresh attempt.`,
      );
      await outcomeToLoop(
        await runProposal({
          tool: "upload",
          ref: field.ref,
          documentId: document.id,
        }),
        { withPage: false },
      );
    }
  };
  const restoreFromReplay = async (): Promise<AgentLoopFinish | null> => {
    const replay = runConfig.replay;
    if (!replay) return null;
    await refreshReusableAnswers();
    const toFinish = (
      reported: AgentLoopToolOutcome,
    ): AgentLoopFinish | null =>
      reported.kind === "finish"
        ? reported.finish
        : reported.kind === "stop"
          ? {
              reason: reported.reason,
              needsPerson: true,
              stuck: false,
              data: {},
            }
          : null;
    const safety = runConfig.safety;
    const writeOne = async (write: ReplayWrite): Promise<boolean> => {
      if (write.kind !== "toggle")
        await safety?.registerPreparedValue(write.value);
      if (runConfig.intermediateWritesAuthorized === true)
        await safety?.openIntermediateWriteWindow().catch(() => undefined);
      const result =
        write.kind === "text"
          ? await runConfig.hands.fillText(write.control.ref, write.value)
          : write.kind === "choose"
            ? await runConfig.hands.chooseOption(write.control.ref, write.value)
            : await runConfig.hands.setToggle(write.control.ref, write.checked);
      return result.ok;
    };
    for (let hop = 0; hop <= replay.path.length; hop += 1) {
      await retryRepairUploads();
      const page = pageTools.state.observation;
      if (!page || page.blocker) return null;
      const screen = screenKey(page);
      if (replayedScreens.has(screen)) break;
      // This screen's saved answers, so a changed one is seen before replay.
      if (hop > 0) await refreshReusableAnswers();
      const plan = planReplay(
        page,
        replay,
        replayStillCurrent({
          controls: page.controls,
          sources: runConfig.sources,
          approvedAttestations: config.authority.preApprovedAttestationKinds,
        }),
      );
      const files = replay.attachments.flatMap((attachment) => {
        const control = page.controls.find(
          (entry) =>
            entry.kind === "file" &&
            !entry.disabled &&
            (!holdsAnswer(entry) ||
              fileUploadProblems(page, uploadOptions).some(
                (problem) => problem.control.ref === entry.ref,
              )) &&
            (attachment.fieldKey
              ? attachment.fieldKey === reviewFieldKey(page, entry)
              : questionPrompt(entry) === attachment.field),
        );
        const document = runConfig.sources.documents.find(
          (entry) => entry.fileName === attachment.fileName,
        );
        return control && document ? [{ control, document }] : [];
      });
      // A question the person answered in Needs you since: their words.
      const savedGroups = new Set<string>();
      const saved = page.controls.flatMap((control) => {
        const group = pendingQuestionKey(control);
        if (
          !control.visible ||
          control.disabled ||
          control.readOnly ||
          savedGroups.has(group) ||
          control.kind === "file" ||
          control.credentialRole ||
          holdsAnswer(control) ||
          plan.writes.some((entry) => entry.write.control === control)
        )
          return [];
        const answer = savedAnswerForQuestion(
          control,
          runConfig.sources.reusableAnswers,
          page.controls,
        );
        savedGroups.add(group);
        return answer?.id.startsWith("application_") &&
          replayValueFitsControl(control, answer.answer)
          ? [{ control, answer }]
          : [];
      });
      if (
        !plan.writes.length &&
        !plan.kept &&
        !plan.withdrawn.length &&
        !files.length &&
        !saved.length
      ) {
        // Nothing of this screen is stored: take the recorded way on.
        const next = nextPathStep(page, replay, takenPath);
        if (!next) break;
        takenPath.add(next.index);
        const proposal: ApplyProposal | null =
          next.step.tool === "navigate"
            ? { tool: "navigate", url: next.step.href ?? next.step.label }
            : next.ref
              ? { tool: next.step.tool, ref: next.ref }
              : null;
        if (!proposal) break;
        const finish = toFinish(
          await outcomeToLoop(await runProposal(proposal), {
            withPage: false,
          }),
        );
        if (finish) return finish;
        continue;
      }
      replayedScreens.add(screen);
      // Files first: each upload reads the page it changed, and the plain
      // writes after it share one read at the end.
      for (const { control, document } of files) {
        const finish = toFinish(
          await outcomeToLoop(
            await runProposal({
              tool: "upload",
              ref: control.ref,
              documentId: document.id,
            }),
            { withPage: false },
          ),
        );
        if (finish) return finish;
      }
      let restoredCount = 0;
      const failedWrites: ReplayWrite[] = [];
      for (const { write, answer } of plan.writes) {
        if (!(await writeOne(write))) {
          failedWrites.push(write);
          continue;
        }
        // Unchecking a stale member restores nothing by itself; the
        // member that holds the answer records it.
        if (write.kind === "toggle" && !write.checked) continue;
        restoredCount += 1;
        filled.push({
          fieldKey: reviewFieldKey(page, write.control),
          ref: write.control.ref,
          label: questionPrompt(write.control),
          questionKind: write.control.questionKind,
          answer: replayedAnswer(answer, write.control),
          at: now().toISOString(),
        });
      }
      for (const { control, answer } of saved) {
        for (const proposal of answerProposals(
          control,
          answer.answer,
          page.controls,
          `answerLibrary.${answer.id}`,
        )) {
          const outcome = await runProposal(proposal);
          const finish = toFinish(
            await outcomeToLoop(outcome, { withPage: false }),
          );
          if (finish) return finish;
          if (outcome.kind === "filled") restoredCount += 1;
        }
      }
      const after = await pageTools.observe();
      syncObservation(after);
      note(
        `Brought back ${restoredCount} answer${restoredCount === 1 ? "" : "s"} on this screen without the model${plan.kept ? `; ${plan.kept} were already there` : ""}${plan.missing.length ? `; ${plan.missing.length} no longer match a field` : ""}.`,
      );
      // A choice is restored only when the page now shows exactly the planned
      // state: every box ticked or unticked as planned, the planned option
      // chosen. A refused write or a page that changed it back leaves the
      // form with the person instead of letting it pass as Ready (review P2).
      const unrestored = plan.writes.flatMap(({ write }) => {
        const now = after.controls.find(
          (control) => control.ref === write.control.ref,
        );
        const held =
          !!now &&
          !failedWrites.includes(write) &&
          (write.kind === "toggle"
            ? now.checked === write.checked
            : write.kind === "choose"
              ? [now.selectedOptionLabel, now.value].some(
                  (shown) =>
                    shown.trim().toLowerCase() ===
                    write.value.trim().toLowerCase(),
                )
              : true);
        return held ? [] : [questionPrompt(write.control)];
      });
      for (const group of plan.groups) {
        const actual = after.controls.filter(
          (control) =>
            (control.kind === "checkbox" || control.kind === "radio") &&
            (group.key
              ? control.choiceGroupKey === group.key
              : group.members.some((member) => member.ref === control.ref)),
        );
        if (
          actual.length !== group.members.length ||
          group.members.some(
            (member) =>
              actual.find((control) => control.ref === member.ref)?.checked !==
              member.checked,
          )
        )
          unrestored.push(group.label);
      }
      if (unrestored.length) {
        const labels = [...new Set(unrestored)];
        for (const control of after.controls)
          if (labels.includes(questionPrompt(control)))
            observedAnswers.delete(reviewFieldKey(after, control));
        const reason = `Nestor could not put back ${labels.map((label) => `"${label}"`).join(", ")} exactly as answered; the form shows something else there. The form is left for you to check, and nothing was sent.`;
        note(reason);
        const kept = new Set(
          plan.writes
            .filter(({ write }) =>
              labels.includes(questionPrompt(write.control)),
            )
            .map(({ write }) => write.control.ref),
        );
        for (let index = filled.length - 1; index >= 0; index -= 1) {
          const entry = filled[index];
          if (entry && (kept.has(entry.ref) || labels.includes(entry.label)))
            filled.splice(index, 1);
        }
        return { reason, needsPerson: true, stuck: false, data: {} };
      }
      const stopped = await guardStop(
        { config: runConfig, now, guardState },
        after.url,
      );
      if (stopped) {
        pauses.push(stopped);
        return {
          reason: stopped.summary,
          needsPerson: true,
          stuck: false,
          data: {},
        };
      }
      const next = nextPathStep(after, replay, takenPath);
      if (next && checkFormReadiness(after, uploadOptions).ok) {
        const proposal: ApplyProposal | null =
          next.step.tool === "navigate"
            ? { tool: "navigate", url: next.step.href ?? next.step.label }
            : next.ref
              ? { tool: next.step.tool, ref: next.ref }
              : null;
        if (proposal) {
          takenPath.add(next.index);
          const finish = toFinish(
            await outcomeToLoop(await runProposal(proposal), {
              withPage: false,
            }),
          );
          if (finish) return finish;
          continue;
        }
      }
      break;
    }
    const current = pageTools.state.observation;
    if (!current || current.blocker) return null;
    await classifyQuestions?.(
      current.controls,
      questionReadContext(current),
    ).catch(() => undefined);
    const open = unresolvedRequiredControls(current);

    // An earlier Needs you verdict is history, not an answer veto. Let the
    // model reconsider every unresolved question against the current facts.
    if (open.length) return null;
    // The screen is complete. A next step stays the person's in Fill in for
    // me: its button is handed over the way the run hands it over.
    const advance = current.actions.find(
      (action) =>
        action.kind === "advance" && action.visible && !action.disabled,
    );
    if (advance && !pressesFormButtons(runConfig) && !deferredPress) {
      const finish = toFinish(
        await outcomeToLoop(
          await runProposal({ tool: "click", ref: advance.ref }),
          { withPage: false },
        ),
      );
      if (finish) return finish;
    }
    // With the step handed over the screen is done; otherwise it must read
    // as ready.
    if (!deferredPress && !checkFormReadiness(current, uploadOptions).ok)
      return null;
    return toFinish(
      await outcomeToLoop({
        kind: "finished",
        reason: "The form is back as it was left.",
        stuck: false,
        needsPerson: false,
      }),
    );
  };
  let technicalFailure: ApplyAgentResult["technicalFailure"];
  let partialOutageTurns = 0;
  let groundingFailureReason: string | null = null;
  const loop = await runAgentLoop({
    // What stays the same for every application this person makes leads:
    // the instructions, then their facts. The job, its resume and its page
    // come after, so a batch of applications shares one cached prefix.
    messages: [
      { role: "system", content: createApplySystemPrompt(runConfig) },
      {
        role: "user",
        content: applicationModelFactsMessage(runConfig.sources, payDisclosed),
      },
      { role: "user", content: createApplyUserPrompt(runConfig) },
      {
        role: "user",
        content: `${resumeText ? `The resume going out with this application:\n${resumeText}\n\n` : ""}${openingMessage}`,
      },
    ],
    model: loopClient as unknown as AgentLoopModel,
    tools: [
      ...pageTools.tools
        .filter((tool) => PAGE_TOOL_NAMES.has(tool.definition.function.name))
        .map<AgentLoopTool>((tool) => ({
          ...tool,
          execute: async (rawArguments, context) => {
            // Fill opens ordinary application entry links as well as this
            // application's known pages; later ambiguous navigation is held.
            const name = tool.definition.function.name;
            if (name === "read_text") {
              const args = parseToolArguments(rawArguments);
              if (typeof args.ref === "string") {
                const fresh = await config.hands.observe();
                syncObservation(fresh);
                const control = fresh.controls.find(
                  (control) => control.ref === args.ref && control.visible,
                );
                if (control && control.options.length > 12)
                  return {
                    kind: "ok",
                    content: JSON.stringify({
                      ref: control.ref,
                      question: questionPrompt(control),
                      choices: control.options,
                      total: control.options.length,
                    }),
                  };
              }
            }
            if (
              (name === "follow_link" || name === "navigate") &&
              !pressesFormButtons(config)
            ) {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(rawArguments || "{}") as Record<
                  string,
                  unknown
                >;
              } catch {
                args = {};
              }
              const seen = pageTools.state.observation;
              const link =
                name === "follow_link"
                  ? seen?.links.find((entry) => entry.ref === args.ref)
                  : seen?.links.find((entry) => entry.href === args.url);
              const href =
                name === "navigate"
                  ? typeof args.url === "string"
                    ? args.url
                    : ""
                  : (link?.href ?? "");
              const accessKind =
                seen && name === "follow_link" && typeof args.ref === "string"
                  ? browserInteractionKind(
                      seen,
                      args.ref,
                      await googleIdentityContext(config, config.hands),
                    )
                  : null;
              const browserPermissions =
                await currentBrowserPermissions(config);
              const enabledAccessLink =
                (accessKind === "signIn" ||
                  accessKind === "createAccounts" ||
                  accessKind === "googleSignIn") &&
                browserPermissions[accessKind];
              if (
                !enabledAccessLink &&
                !fillMayOpen(
                  config,
                  seen?.url ?? null,
                  href,
                  seen ? { observation: seen, state: guardState } : undefined,
                )
              ) {
                const pause = pressOnSitePause(
                  link?.label && !/^https?:/iu.test(link.label.trim())
                    ? `"${link.label}"`
                    : "the link to the next page",
                  now(),
                );
                if (deferredPress) return handOverPress(pause);
                return { kind: "ok", content: deferPress(pause) };
              }
            }
            if (name === "follow_link" || name === "navigate") {
              try {
                const args = JSON.parse(rawArguments) as Record<
                  string,
                  unknown
                >;
                const seen = pageTools.state.observation;
                const ref =
                  name === "follow_link"
                    ? args.ref
                    : seen?.links.find((link) => link.href === args.url)?.ref;
                if (seen && typeof ref === "string")
                  await recordAccessAttempt(seen, ref);
              } catch {
                // The page tool reports malformed arguments without an action.
              }
            }
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
    ].map<AgentLoopTool>((tool) => ({
      ...tool,
      execute: (arguments_, context) => {
        if (
          partialOutageTurns > 0 &&
          !PARTIAL_OUTAGE_TOOLS.has(tool.definition.function.name)
        )
          return Promise.resolve({
            kind: "ok",
            status: "refused",
            content:
              "The page is not fully readable. Only reads and field writes are allowed.",
          });
        const record = progressGuard.start(
          tool.definition.function.name,
          arguments_,
          pageTools.state.observation,
        );
        return modelActivity
          .run(context, () => tool.execute(arguments_, context))
          .then((outcome) => {
            const changed = record(pageTools.state.observation);
            return outcome.kind === "ok"
              ? { ...outcome, progress: changed }
              : outcome;
          });
      },
    })),
    subjectLabel: config.siteLabel,
    ceilings: {
      maxSteps: config.runControl?.maxSteps ?? DEFAULT_MAX_STEPS,

      noProgressStepLimit:
        config.runControl?.noProgressStepLimit ?? Number.POSITIVE_INFINITY,
    },
    describeStall: () =>
      pageTools.state.observation
        ? `The page is ${pageTools.state.observation.url ?? "open"}.`
        : null,
    parallelToolCalls: true,
    // The host supplies the complete current page on every model call.
    staleToolResultChars: null,
    compactionMaxChars: contextHistoryChars,
    onToolTiming: timingRecord.onToolTiming,
    // Once every remaining field is held for the person, another model turn
    // cannot fill anything. This includes answer refusals, not just pickers.
    beforeModelTurn: async () => {
      if (progressGuard.stuck) {
        const record = progressGuard.start(
          "observe",
          "{}",
          pageTools.state.observation,
        );
        const latest = await pageTools.observe();
        record(latest);
        syncObservation(latest);
      }
      if (progressGuard.stuck)
        return {
          reason:
            "The same action was repeated on the same page and nothing new happened. Your form is kept.",
          needsPerson: false,
          stuck: true,
          data: {},
        };
      if (technicalFailure)
        return {
          reason:
            groundingFailureReason ??
            "Nestor could not finish checking this application.",
          needsPerson: false,
          stuck: true,
          data: {},
        };
      await refreshReusableAnswers();
      // A form brought back from what an earlier run left: no model call
      // for a screen that matches it.
      await retryRepairUploads();
      const restored = await restoreFromReplay();
      if (restored) return restored;
      let current = pageTools.state.observation;
      if (current?.blocker?.code === "browser_blocked")
        return {
          reason: current.blocker.summary,
          needsPerson: true,
          stuck: false,
          data: {},
        };
      if (current?.blocker) return null;
      // Empty optional wizard screens need no answer or model decision.
      // Re-observe each local advance through the ordinary executor fence.
      while (
        current &&
        pendingQuestions.size === 0 &&
        !deferredPress?.formSend &&
        current.controls.every(
          (control) => !control.visible || control.disabled || control.readOnly,
        )
      ) {
        const emptyStep = current;
        const advance = emptyStep.actions.find((action) =>
          fillStepPress(runConfig, emptyStep, action.ref),
        );
        if (!advance) break;
        const outcome = await runProposal({ tool: "click", ref: advance.ref });
        const reported = await outcomeToLoop(outcome, { withPage: false });
        if (reported.kind === "finish") return reported.finish;
        if (reported.kind === "stop")
          return {
            reason: reported.reason,
            needsPerson: true,
            stuck: false,
            data: {},
          };
        if (outcome.kind !== "moved") break;
        current = pageTools.state.observation;
        // The empty screen may have exposed a recorded, answered screen.
        // Restore it before the model can make a new choice for that field.
        const restoredAfterAdvance = await restoreFromReplay();
        if (restoredAfterAdvance) return restoredAfterAdvance;
        current = pageTools.state.observation;
      }
      // A saved picker rule is applied as soon as its question is on the
      // page; the picker itself says whether the choices are there.
      for (const control of current?.controls ?? []) {
        const key = pickerQuestionKey(control);
        if (
          handledPickerRules.has(key) ||
          !savedPickerRule(control, questionPrompt(control), runConfig)
        )
          continue;
        handledPickerRules.add(key);
        const outcome = await runProposal({
          tool: "select",
          ref: control.ref,
          option: "",
        });
        const reported = await outcomeToLoop(outcome, { withPage: false });
        if (reported.kind === "finish") return reported.finish;
        if (reported.kind === "stop")
          return {
            reason: reported.reason,
            needsPerson: true,
            stuck: false,
            data: {},
          };
      }
      return null;
    },
    afterToolBatch: async () => {
      if (!observationNeeded) return null;
      observationNeeded = false;
      const after = await pageTools.observe();
      syncObservation(after);
      return `The page after your batch:\n\n${renderObservation(after)}`;
    },
    // The model often reports in words that it is done instead of calling
    // finish, and the provider cannot be told to always call a tool. When
    // this step has questions left for the person, or the form has been
    // filled and is ready, those words go through the same finish checks as
    // the finish tool; otherwise the loop reminds the model to use a tool.
    onReplyWithoutTool: async (content) => {
      const current = pageTools.state.observation;
      const done =
        pendingQuestions.size > 0 ||
        (current !== null &&
          filled.length + attachments.length > 0 &&
          checkFormReadiness(current, uploadOptions).ok);
      return done
        ? outcomeToLoop({
            kind: "finished",
            reason: content.trim().slice(0, 2_000),
            stuck: false,
            needsPerson: pendingQuestions.size > 0,
          })
        : null;
    },
    onHistoryCompacted: () => {
      modelObservation = null;
      const current = pageTools.state.observation;
      return current
        ? `Current page in full after earlier history was shortened:\n\n${renderObservation(current)}`
        : null;
    },
    ...(config.onProgress
      ? {
          onStep: (
            info: Parameters<NonNullable<typeof config.onProgress>>[0],
          ) => {
            // The form's own step marker, so the person sees how far along
            // a long form is. No field names or values.
            const step = pageTools.state.observation?.step;
            return config.onProgress!({
              ...info,
              note:
                step?.index && step.total && step.total > 1
                  ? `form step ${step.index} of ${step.total}: ${info.note}`
                  : info.note,
            });
          },
        }
      : {}),
    ...(config.signal ? { signal: config.signal } : {}),
    now,
  })
    .catch((error: unknown): AgentLoopResult => {
      if (!(error instanceof QuestionReadUnavailableError)) throw error;

      technicalFailure = {
        code: "question_classification_unavailable",
        retryable: true,
        pageDisposition: "retain",
      };
      note(error.message);
      return {
        ending: "stopped",
        reason: error.message,
        finish: null,
        stop: { reason: error.message },
        steps: 0,
        progressSteps: 0,
        turnNotes: [],
        messages: [],
        timing: { totalMs: 0, modelMs: 0, toolMs: 0, modelTurns: 0 },
      };
    })
    .finally(async () => {
      // Stop aborts the provider through the run's signal; cleanup still drains
      // the local drafts if a page change left their writes unattempted.
      runAbort.abort();
      await Promise.allSettled(letterRequests.values());
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
  /**
   * What a needs-person finish leaves for the person, beside whatever the
   * page already left: every item it named (one whose whole text is a
   * field's question hands over that field), all of them, nothing dropped.
   * A finish that names nothing hands over the page's blocker, else the
   * required questions its reason names, else what it quotes, else the
   * reason itself.
   */
  const finishItemIds = new Set<string>();
  const addFinishItems = (said: string, items: string[]): void => {
    const page = pageTools.state.observation;
    const words = (text: string) =>
      normalizeFormQuestionPrompt(preserveTechnologyTokens(text));
    const controls = page?.controls ?? [];
    const open = controls.filter(
      (control) =>
        control.visible &&
        !control.disabled &&
        !holdsAnswer(control) &&
        !(
          control.choiceGroupKey &&
          controls.some(
            (sibling) =>
              sibling.choiceGroupKey === control.choiceGroupKey &&
              sibling.checked,
          )
        ),
    );
    const askOnPage = (control: (typeof controls)[number]) => {
      const key = pendingQuestionKey(control);
      const question =
        pendingQuestions.get(key) ??
        buildPendingQuestion({
          control,
          jobId: config.application.jobId,
          detectedAt: now().toISOString(),
          suggestion: null,
          siblings: controls,
        });
      pendingQuestions.set(key, question);
      finishItemIds.add(question.id);
    };
    const askText = (prompt: string) => {
      const id = `named_${createHash("sha256").update(prompt).digest("hex").slice(0, 24)}`;
      finishItemIds.add(id);
      pendingQuestions.set(`named:${prompt}`, {
        id,
        prompt,
        repeatedAtDifferentStep: false,
        kind: "other",
        answerControlType: "text",
        isRequired: true,
        detectedAt: now().toISOString(),
        answerOptions: [],
        suggestedAnswers: [],
        submittedAnswer: null,
        status: "detected",
      });
    };
    // Questions already held by a pause or the deferred press count too.
    const heldQuestions = [
      ...pauses.flatMap(
        (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
      ),
      ...(deferredPress?.question ? [deferredPress.question] : []),
    ];
    const handover = heldQuestions.find(
      (question) => question.id === STEP_HANDOVER_QUESTION_ID,
    );
    const advances = (page?.actions ?? []).filter(
      (action) =>
        action.kind === "advance" && action.visible && !action.disabled,
    );
    const escape = (text: string) =>
      text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    // Council D5: only the one press instruction for the step already handed
    // over maps onto it. Anything more, or any open field, is still asked.
    const restatesHandover = (item: string): boolean => {
      const labels = new Set(advances.map((action) => words(action.label)));
      if (!handover || item.includes("?") || labels.size !== 1) return false;
      const parenthetical = /\s*\(([^()]*)\)\s*[.!]?\s*$/u.exec(item);
      const body = parenthetical ? item.slice(0, parenthetical.index) : item;
      const clauses = body
        .split(/[.!;]+|\b(?:then|also|after that)\b/iu)
        .map((clause) => clause.trim())
        .filter((clause) => /[\p{L}\p{N}]/u.test(clause));
      const [only] = clauses;
      if (clauses.length !== 1 || only === undefined) return false;
      const clause = words(only.replace(/["“”'‘’]/gu, ""));
      const named = [
        ...new Set(
          advances
            .map((action) => words(action.label))
            .filter(
              (label) =>
                !!label &&
                new RegExp(
                  `\\b(?:press|click|tap)\\s+(?:on\\s+)?(?:the\\s+)?${escape(label)}\\b`,
                  "u",
                ).test(clause),
            ),
        ),
      ];
      const [label] = named;
      if (
        named.length !== 1 ||
        label === undefined ||
        !words(handover.prompt).includes(label)
      )
        return false;
      const said = words(item);
      return !open.some((control) => {
        const prompt = words(questionPrompt(control));
        return prompt.length > 2 && said.includes(prompt);
      });
    };
    for (const item of items) {
      if (handover && restatesHandover(item)) {
        finishItemIds.add(handover.id);
        continue;
      }
      // Restating an already-open question does not create another task or
      // replace its options, explanation or draft. Extra clauses stay separate.
      const existing = [...pendingQuestions.values(), ...heldQuestions].filter(
        (question) =>
          matchesFinishQuestion(
            question.prompt,
            question.answerControlType === "boolean" ||
              offersYesNo(question.answerOptions),
            item,
          ),
      );
      if (existing.length) {
        existing.forEach((question) => finishItemIds.add(question.id));
        continue;
      }
      let field = controls.filter(
        (control) =>
          control.visible &&
          !control.disabled &&
          matchesFinishQuestion(
            questionPrompt(control),
            control.answerControlType === "boolean" ||
              offersYesNo(control.options),
            item,
          ),
      );
      if (!field.length) {
        const labelled = controls.filter(
          (control) =>
            control.visible &&
            !control.disabled &&
            matchesFinishQuestion(
              questionLabel(control),
              control.answerControlType === "boolean" ||
                offersYesNo(control.options),
              item,
            ),
        );
        if (
          new Set(
            labelled.map((control) => control.choiceGroupKey || control.ref),
          ).size === 1
        )
          field = labelled;
      }
      if (field.length) field.forEach(askOnPage);
      else askText(item);
    }
    if (items.length) return;
    if (page?.blocker) {
      // One the person owns is handed over below, as on any run.
      if (page.blocker.requiresPerson) return;
      pauses.push({
        code: "page_blocked",
        summary: said,
        question: null,
        blocker: page.blocker,
      });
      return;
    }
    // A pause or the page's own questions already say what is waiting.
    if (pauses.length > 0 || pendingQuestions.size > 0) return;
    const required = open.filter((control) => {
      const prompt = words(questionPrompt(control));
      return (
        control.required && prompt.length > 3 && words(said).includes(prompt)
      );
    });
    required.forEach(askOnPage);
    if (required.length) return;
    // Nothing on the page matches: hand over what the reason quotes (an
    // apostrophe is not a quote), else the reason itself.
    const quoted = [...said.matchAll(/["‘“]([^"’”]{6,200})["’”]/gu)].map(
      (match) => String(match[1]).trim(),
    );
    for (const prompt of quoted.length ? quoted : [said.trim()])
      askText(prompt);
  };
  // A finish that says needsPerson always ends paused, never ready to send:
  // what it names joins whatever the page left, in the same handover.
  // Council D6: a run that met a partial classifier outage filled only what
  // it could read (and exact identity), then ends as a retained technical
  // failure, however the loop itself ended.
  if (!technicalFailure && !skipReason && partialOutageTurns > 0) {
    technicalFailure = {
      code: "question_classification_unavailable",
      retryable: true,
      pageDisposition: "retain",
    };
    groundingFailureReason =
      "Nestor could not read this page: the remaining questions stayed unread after repeated attempts. Your page and answers are kept. Retry this application when Nestor is available.";
    note(groundingFailureReason);
  }

  const finishNeedsPerson =
    !skipReason &&
    (needsPersonFinishPending || loop.finish?.needsPerson === true);
  const finishReason =
    needsPersonFinishPending && loop.finish?.needsPerson !== true
      ? "Job Finder still needs you to review this application before it can finish."
      : (loop.finish?.reason ?? loop.reason);
  if (finishNeedsPerson && (!technicalFailure || forPerson.length > 0))
    addFinishItems(
      finishHasOnlyCheckedFields
        ? "Review this application before sending."
        : finishReason,
      forPerson,
    );
  const pending = collectedQuestionsPause();
  const personOwnedBlocker =
    pageTools.state.observation?.blocker?.requiresPerson === true
      ? pageTools.state.observation.blocker
      : null;
  let outcome: ApplyAgentResult["outcome"];
  let reason: string;
  if (skipReason) {
    outcome = "paused";
    reason = skipReason;
    readyToSend = null;
  } else if (exhaustedUploads.size > 0 && !pending && pauses.length === 0) {
    outcome = "stuck";
    reason = [...exhaustedUploads.values()].join(" ");
  } else if (
    technicalFailure &&
    pendingQuestions.size === 0 &&
    pauses.length === 0
  ) {
    outcome = "stuck";
    reason = groundingFailureReason ?? loop.reason;
  } else if (pauses.length > 0) {
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
    reason = [pending.summary, ...exhaustedUploads.values()].join(" ");
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
  if (finishNeedsPerson) {
    // Every item it named reaches the person, whichever pause came first.
    const handed = new Set(
      pauses.flatMap((pause) =>
        (pause.questions ?? (pause.question ? [pause.question] : [])).map(
          (question) => question.id,
        ),
      ),
    );
    const missing = [...pendingQuestions.values()].filter(
      (question) => finishItemIds.has(question.id) && !handed.has(question.id),
    );
    const [first] = missing;
    if (first)
      pauses.push({
        code: "question_needs_you",
        summary: finishReason,
        question: first,
        questions: missing,
        blocker: null,
      });
    if (outcome !== "paused" && outcome !== "stuck") {
      outcome = "paused";
      reason = pauses[0]?.summary ?? finishReason;
    }
  }
  // Nothing waiting on the person, or a run that could not finish, is never
  // ready to send.
  if (outcome === "paused" || outcome === "stuck") readyToSend = null;
  traceEvent("apply_outcome", { outcome, pauses, notes });

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
  for (const pause of pauses) {
    for (const question of [
      ...(pause.questions ?? []),
      ...(pause.question ? [pause.question] : []),
    ]) {
      if (attemptedWrites.has(normalizeFormQuestionPrompt(question.prompt))) {
        question.askReason = {
          kind: "page_refused",
          check: "answer_retention",
          detail: (
            question.note ||
            "A write was attempted, but this page still reports the question as unanswered or invalid."
          ).slice(0, 4000),
        };
      }
    }
  }
  // A press this attempt could not confirm means no earlier step binds at Send.
  if (
    [...guardState.uncertainAdvances.keys()].some(
      (key) => !earlierUncertain.has(key),
    ) &&
    pageTools.state.observation
  )
    stepReceipts.unconfirmed(pageTools.state.observation, now().toISOString());
  // Each unconfirmed step press becomes a receipt a continued run reads.
  for (const [text, at] of guardState.uncertainAdvances)
    if (
      !timeline.some(
        (entry) =>
          entry.label === UNCONFIRMED_STEP_LABEL && entry.text === text,
      )
    )
      timeline.push({ at, label: UNCONFIRMED_STEP_LABEL, text });
  return {
    outcome,
    ...(technicalFailure ? { technicalFailure } : {}),
    ...(skipReason ? { skipReason } : {}),
    reason: skipReason ?? reason,
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
    questionContexts: questionOccurrences.snapshot(),
    pickerAttempts: [...guardState.pickerAttempts.values()].map((attempt) => ({
      ...attempt,
      tried: attempt.tried.slice(-20),
      notOffered: attempt.notOffered.slice(-20),
    })),
    formPath,
    stepReceipts: stepReceipts.finish(
      pageTools.state.observation ?? null,
      now().toISOString(),
    ),
  };
}
