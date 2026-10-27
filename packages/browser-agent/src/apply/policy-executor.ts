import { classifyAnswerPermission } from "./answer-source-catalog";
import { questionClassificationKey } from "./question-classification";
import {
  OPINION_ANSWER_REASON,
  requiresSavedOpinionAnswer,
} from "./answer-evidence";
import {
  asksListingDiscoveryControl,
  listingDiscoveryAnswer,
} from "./listing-discovery-answer";
import {
  nationalityQuestionIdentity,
  NATIONALITY_ANSWER_REASON,
} from "./person-nationality";
import { TEXT_RETENTION_MS, textRetentionError } from "./text-retention";
import {
  resumeFormFileNames,
  cleanFormQuestionPrompt,
  normalizeFormQuestionPrompt,
  type ApplicationAttemptQuestion,
  type ApplyPickerAttempt,
  type StoredApplyPickerAttempt,
  type ApplyWriteResult,
  type CandidateReusableAnswer,
  type SavedOptionFallback,
} from "@nestor/contracts";

import {
  savedAnswerForQuestion,
  storedFactFor,
  isAnswerFromThisApplication,
} from "./application-facts";
import { normalizeSignal } from "./control-classification";
import {
  fillPressFor,
  recordFillPress,
  type FillPressState,
} from "./fill-presses";
import { matchOption } from "./option-match";
import { savedPickerRule, strictOptionMatch } from "./option-fallback";
import { priorCompanyHistory } from "./prior-company";
import { currentTimezoneAnswer } from "./current-timezone";
import {
  hasStartDateValue,
  isStartDateControl,
  startDateAnswer,
} from "./start-date";
import { formatGithubAnswer } from "./github-username";
import { formatProfileUrlAnswer } from "./profile-url";
import type { ApplyQuestionClassification } from "./question-classification";
import {
  buildCoverLetterRequest,
  coverLetterPolicyAllows,
  coverLetterDeliveryFor,
  isCoverLetterControl,
  looksLikeUsableLetter,
  requiredLetterFileType,
} from "./cover-letter";
import { attemptKey, judgeBlockedAttempt } from "./blocked-attempts";
import { isSecurityChallengeControl } from "./blockers";
import {
  runSubmitPreflight,
  STEP_HANDOVER_QUESTION_ID,
} from "./submit-preflight";
import { isShortValueAnswer } from "./written-answer-grounding";
import {
  OWN_WORDS_REASON,
  formWritingInstructions,
  ownWordsAppliesToQuestion,
} from "./own-words";
import type {
  ApplyAgentConfig,
  ApplyAnswer,
  ApplyAttachedDocument,
  ApplyFilledControl,
  ApplyFormAction,
  ApplyFormControl,
  ApplyFormObservation,
  ApplyPause,
  ApplyProposal,
  ApplyDocument,
} from "./types";

/**
 * The safety layer between the model and the page.
 *
 * It is deliberately thin. The model decides where to go, what to press, and
 * how to get through a site; none of that is second-guessed here. What this
 * layer does is the short list of things that must not depend on a model
 * being right:
 *
 * - an answer about the person comes from the person's own facts, not from
 *   the model's memory of them
 * - a declaration the person has to make themselves is only made when they
 *   approved that exact kind in advance
 * - a write proposed against a page that has since moved on is retried
 *   against the page as it is now, rather than landing in the wrong field
 * - sending an application goes through its own preflight and authority
 * - the origin allowlist is enforced only at the irreversible send preflight;
 *   ordinary navigation is governed by the reviewed-move path below
 *
 * Everything else — cookie banners, chat widgets, redirects, listings that
 * link to a different company's site, buttons made out of divs — is the
 * model's to work out, the way a person would.
 */

export type ApplyExecutionOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "observed"; observation: ApplyFormObservation }
  /** A read the model asked for. Carries no page change. */
  | { kind: "read"; text: string; observation: ApplyFormObservation }
  | {
      kind: "filled";
      filled: ApplyFilledControl;
      observation: ApplyFormObservation;
    }
  | {
      kind: "attached";
      attachment: ApplyAttachedDocument;
      observation: ApplyFormObservation;
    }
  /** A movement on the page. Only a real page/location change is progress. */
  | {
      kind: "moved";
      note: string;
      observation: ApplyFormObservation;
      progress: boolean;
    }
  /** What the person's own facts say about one field, for the model to use. */
  | {
      kind: "suggestion";
      answer: ApplyAnswer | null;
      note: string;
      /**
       * The exact question, recorded when nothing can answer it and the form
       * requires it. The model asked; this is what it would have to hand back
       * to the person.
       */
      question: ApplicationAttemptQuestion | null;
      controlRef: string;
      observation: ApplyFormObservation;
    }
  | { kind: "paused"; pause: ApplyPause }
  /** The step did not fit the page. The loop says why and the model retries. */
  | { kind: "refused"; reason: string; observation: ApplyFormObservation }
  | {
      kind: "ready_to_send";
      finalActionRef: string;
      finalActionLabel: string;
      observation: ApplyFormObservation;
    }
  | {
      kind: "finished";
      reason: string;
      stuck: boolean;
      needsPerson: boolean;
      forPerson?: string[];
    };

export interface ApplyExecutorDeps {
  /** fill_fields verifies all provisional text writes before recording them. */
  deferTextRetention?: boolean;
  config: ApplyAgentConfig;
  now: () => Date;
  guardState: ApplyGuardState;
  /**
   * The model's reading of the page's questions (ADR 0041): whether one asks
   * about pay and which declaration one is. Absent offline, where the keyword
   * classification on the observation stands.
   */
  classifyQuestions?: (
    controls: readonly ApplyFormControl[],
    step?: string,
  ) => Promise<ReadonlyMap<string, ApplyQuestionClassification>>;
  onAnswerSource?: (source: "stored_fact" | "checked") => void;
  checkWrittenAnswer?: (
    question: string,
    answer: string,
    evidencePolicy?: "factual_summary",
  ) => Promise<{
    supported: boolean;
    reason: string;
    reviewWording?: string;
  }>;
}

export interface ApplyGuardState extends FillPressState {
  /**
   * Choices each picker question on this application refused, across runs,
   * and what its list offered then. A refused choice is never tried again.
   */
  pickerAttempts: Map<string, ApplyPickerAttempt>;
  /** Pickers whose last attempt in this run failed: not answered, whatever the box shows. */
  openPickers: Set<string>;
  /** Pickers the model asked for a refused choice again: it has no other to try. */
  repeatedPickers: Set<string>;
  acknowledged: Set<string>;
  hasWritten: boolean;
  lastFieldLabel: string | null;
  /** Plain notes about traffic that was blocked and safely ignored. */
  notes: string[];
  /** Origins the run has already told the model about, so it says it once. */
  reportedOrigins: Set<string>;
  /** How many of the site's own saves the guard blocked and tolerated. */
  blockedSaveCount: number;
  /** The most recent one, so a form that will not move on can name the site. */
  lastBlockedSave: { host: string | null; fieldLabel: string | null } | null;
  /** Origins off the listing's site that a review allowed, with the reason. */
  approvedOrigins: Map<string, string>;
  /** Where the run last was, for the reviewer's "from". */
  lastOnSiteUrl: string | null;
}

export function createApplyGuardState(
  pickerAttempts: readonly StoredApplyPickerAttempt[] = [],
): ApplyGuardState {
  return {
    pickerAttempts: new Map(
      pickerAttempts.map((attempt) => [
        attempt.question,
        { ...attempt, notOffered: attempt.notOffered ?? [] },
      ]),
    ),
    openPickers: new Set(),
    repeatedPickers: new Set(),
    acknowledged: new Set<string>(),
    hasWritten: false,
    lastFieldLabel: null,
    fieldWrites: 0,
    openedForm: false,
    rowsAdded: new Map(),
    notes: [],
    reportedOrigins: new Set<string>(),
    blockedSaveCount: 0,
    lastBlockedSave: null,
    approvedOrigins: new Map(),
    lastOnSiteUrl: null,
  };
}

/** Distinct choices a picker may refuse before Job Finder stops choosing for it. */
export const MAX_PICKER_ATTEMPTS = 2;

/** One picker question on this application, the same across reloads and reruns. */
export function pickerQuestionKey(control: ApplyFormControl): string {
  return normalizeFormQuestionPrompt(questionPrompt(control));
}

export function pickerExhausted(
  guardState: ApplyGuardState,
  control: ApplyFormControl,
): boolean {
  const key = pickerQuestionKey(control);
  return (
    guardState.repeatedPickers.has(key) ||
    (guardState.pickerAttempts.get(key)?.tried.length ?? 0) >=
      MAX_PICKER_ATTEMPTS
  );
}

/** Remembers a refused choice and what the list offered instead, when it said. */
function recordPickerFailure(
  guardState: ApplyGuardState,
  control: ApplyFormControl,
  option: string,
  offeredOptions: readonly string[] | undefined,
): void {
  const question = pickerQuestionKey(control);
  const previous = guardState.pickerAttempts.get(question);
  const tried = normalizeSignal(option);
  guardState.pickerAttempts.set(question, {
    question,
    tried: [
      ...(previous?.tried ?? []).filter((value) => value !== tried),
      tried,
    ].slice(-20),
    notOffered: [
      ...(previous?.notOffered ?? []).filter((value) => value !== tried),
      // A refusal proves absence only with the list it showed instead.
      ...(offeredOptions?.length ? [tried] : []),
    ].slice(-20),
    offeredOptions: offeredOptions?.length
      ? offeredOptions.slice(0, 500)
      : (previous?.offeredOptions ?? []),
  });
  guardState.openPickers.add(question);
}

/**
 * A picker that would not take the choice. A required one goes to the person
 * with the choices the form's own list showed; an optional one is left blank.
 */
function pickerHandover(
  deps: ApplyExecutorDeps,
  observation: ApplyFormObservation,
  control: ApplyFormControl,
  option: string,
  detail: string,
  at: string,
): ApplyExecutionOutcome {
  control.answered = false;
  const offered =
    deps.guardState.pickerAttempts.get(pickerQuestionKey(control))
      ?.offeredOptions ?? [];
  const exhausted = pickerExhausted(deps.guardState, control);
  if (!control.required)
    return {
      kind: "refused",
      reason: `"${questionPrompt(control)}" is optional and its list did not take "${option}". Leave it blank and carry on. ${detail}`,
      observation,
    };
  const reason = offered.length
    ? `The form's list does not include "${option}". Choose one of the options it offers.`
    : `The form's list did not take "${option}". Enter the answer the way the form lists it.`;
  return {
    kind: "suggestion",
    answer: null,
    controlRef: control.ref,
    observation,
    note: `${detail} ${exhausted ? "No further automatic attempts will be made on this picker; it is now with the person." : "Choose a different option only if the person saved a rule for this question; otherwise it is with the person."}`,
    question: {
      ...buildPendingQuestion({
        control,
        jobId: deps.config.application.jobId,
        detectedAt: at,
        suggestion: null,
        siblings: observation.controls,
        reason,
      }),
      answerOptions: [...offered],
    },
  };
}

function pickerRefused(
  guardState: ApplyGuardState,
  control: ApplyFormControl,
  option: string,
): boolean {
  return (
    guardState.pickerAttempts
      .get(pickerQuestionKey(control))
      ?.tried.includes(normalizeSignal(option)) ?? false
  );
}

/** One choice put to the picker; a refusal is recorded with what its list offered. */
async function choosePickerOption(
  deps: ApplyExecutorDeps,
  control: ApplyFormControl,
  option: string,
): Promise<ApplyWriteResult> {
  const write = await writeUnderGuard(deps, {
    declaredValue: option,
    write: () => deps.config.hands.chooseOption(control.ref, option),
  });
  if (write.ok) deps.guardState.openPickers.delete(pickerQuestionKey(control));
  else
    recordPickerFailure(
      deps.guardState,
      control,
      option,
      write.reason === "option_not_offered"
        ? (write.offeredOptions ?? [])
        : undefined,
    );
  return write;
}

async function pickerFilled(
  deps: ApplyExecutorDeps,
  control: ApplyFormControl,
  observation: ApplyFormObservation,
  at: string,
  answer: ApplyAnswer,
): Promise<ApplyExecutionOutcome> {
  afterWrite(deps, questionPrompt(control));
  const stop = await guardStop(deps, observation.url);
  if (stop) {
    return { kind: "paused", pause: stop };
  }
  return {
    kind: "filled",
    filled: {
      ref: control.ref,
      label: questionPrompt(control),
      questionKind: control.questionKind,
      answer,
      at,
    },
    observation: await deps.config.hands.observe(),
  };
}

/**
 * The person's ordered rule for one picker: their answer, then their fallback,
 * then skip the application. Their answer is checked like any answer to this
 * question, and the fallback goes in on that same answer. Each is matched to
 * the spelling the form's list uses; a name that only resembles one is left to
 * the person. The application is skipped only when a list that finished
 * loading said it has neither; anything less goes to the person.
 */
async function applyPickerRule(input: {
  deps: ApplyExecutorDeps;
  control: ApplyFormControl;
  observation: ApplyFormObservation;
  at: string;
  saved: CandidateReusableAnswer;
  rule: SavedOptionFallback;
}): Promise<ApplyExecutionOutcome> {
  const { deps, control, observation, at, saved, rule } = input;
  const key = pickerQuestionKey(control);
  const offered = () =>
    deps.guardState.pickerAttempts.get(key)?.offeredOptions ?? [];
  // A skip rests only on what the list said in this run: the latest list it
  // showed instead of a refused choice. Refusals remembered from an earlier
  // run only stop a retry, and send the question to the person.
  let listedNow: readonly string[] = [];
  for (const [position, wanted] of [rule.primary, rule.fallback].entries()) {
    // Each of the person's two answers is checked like any answer to this
    // question before it goes in: the fallback as their saved answer too, so
    // pay kept private or an eligibility answer still holds.
    const choice = await decideAnswer({
      deps:
        position === 0
          ? deps
          : {
              ...deps,
              config: {
                ...deps.config,
                sources: {
                  ...deps.config.sources,
                  reusableAnswers: deps.config.sources.reusableAnswers.map(
                    (answer) =>
                      answer.id === saved.id
                        ? { ...answer, answer: wanted }
                        : answer,
                  ),
                },
              },
            },
      control,
      value: wanted,
      storedFactId: `answerLibrary.${saved.id}`,
      pageText: formWritingInstructions(observation),
      controls: observation.controls,
    });
    if (choice.kind === "leave") {
      return notEntered({ deps, control, observation, at, decision: choice });
    }
    // A second pass only when the list's reply spells the choice its own way.
    for (let pass = 0; pass < 2; pass += 1) {
      // Only the picker's own reply shows what it lacks; the list read with
      // the page may stop before the plain name.
      const fromList = strictOptionMatch(offered(), wanted);
      const fromPage = strictOptionMatch(control.options, wanted);
      if (fromList.kind === "ambiguous")
        return pickerHandover(
          deps,
          observation,
          control,
          wanted,
          `The list has names close to "${wanted}" (${fromList.candidates.slice(0, 6).join(", ")}) but none that is plainly it.`,
          at,
        );
      const option =
        fromList.kind === "match"
          ? fromList.value
          : fromPage.kind === "match"
            ? fromPage.value
            : wanted;
      if (pickerRefused(deps.guardState, control, option)) break;
      const write = await choosePickerOption(deps, control, option);
      if (write.ok)
        return pickerFilled(
          deps,
          control,
          observation,
          at,
          position === 0
            ? { ...choice.answer, value: option }
            : {
                ...choice.answer,
                value: option,
                sourceKind: "answer_library",
                sourceId: `answerLibrary.${saved.id}#fallback`,
                provenanceLabel: "your saved fallback for this question",
                groundedIn: ["your saved fallback for this question"],
              },
        );
      if (write.reason !== "option_not_offered") {
        const after = await deps.config.hands.observe();
        return pickerHandover(
          deps,
          after,
          findControl(after, control.ref) ?? control,
          option,
          write.error,
          at,
        );
      }
      if (write.offeredOptions?.length) listedNow = write.offeredOptions;
    }
  }
  // Judged on the latest list the picker settled on, for both choices: a
  // choice refused earlier may be listed now.
  const absent = (wanted: string) =>
    listedNow.length > 0 &&
    strictOptionMatch(listedNow, wanted).kind === "none";
  if (absent(rule.primary) && absent(rule.fallback))
    return {
      kind: "skipped",
      reason: `The form's list has neither ${rule.primary} nor ${rule.fallback}. Your saved rule says to skip this application.`,
    };
  return pickerHandover(
    deps,
    observation,
    control,
    rule.primary,
    "The list's choices could not be confirmed, so the saved rule was not applied.",
    at,
  );
}

/**
 * A stable name for one question.
 *
 * Tied to what the question says rather than where it sits, so a form that
 * renumbers its fields does not turn a saved answer into a new question the
 * person is asked all over again. Two controls that say exactly the same
 * thing are told apart by which comes first, and only then.
 */
function questionIdFor(
  control: ApplyFormControl,
  jobId: string,
  siblings: readonly ApplyFormControl[] = [],
): string {
  const identity = (candidate: ApplyFormControl): string =>
    candidate.kind === "radio" && candidate.choiceGroupKey
      ? `radio|${candidate.choiceGroupKey}`
      : `${normalizeSignal(candidate.groupLabel)}|${normalizeSignal(candidate.label)}|${candidate.kind}`;
  const digest = (value: string): string => {
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const semanticIdentity =
    control.kind === "radio"
      ? `${control.groupLabel || "choice"} ${control.kind}`
      : `${control.groupLabel} ${control.label} ${control.kind}`;
  const slug = semanticIdentity
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 60);
  const same = siblings.filter(
    (candidate) => identity(candidate) === identity(control),
  );
  const ordinal = same.findIndex((candidate) => candidate.ref === control.ref);
  const choiceSuffix =
    (control.kind === "radio" ||
      control.answerControlType === "multi_choice") &&
    control.choiceGroupKey
      ? `_${digest(control.choiceGroupKey)}`
      : "";
  const suffix =
    (control.repeatedQuestion
      ? `_repeat_${digest(control.repeatedQuestion.step)}`
      : "") +
    (choiceSuffix || (same.length > 1 && ordinal > 0 ? `_${ordinal + 1}` : ""));
  return `question_${jobId}_${slug || "field"}${suffix}`;
}

/**
 * The question as the person reads it.
 *
 * A field whose group says the same thing as its own label reads as one
 * question, not two: "Phone — Phone" is what a saved answer then fails to
 * match on the next run.
 */
/**
 * A file field that names another file. An empty read-back is not evidence
 * either way: some sites clear the field once they hold the file.
 */
/** Native accept is a format constraint, independent of document wording. */
function acceptsDocument(
  control: ApplyFormControl,
  document: Pick<ApplyDocument, "fileName" | "mimeType">,
): boolean {
  if (!control.acceptedTypes?.length) return true;
  const name = document.fileName.toLowerCase();
  const mime = document.mimeType.toLowerCase();
  return control.acceptedTypes.some((accepted) =>
    accepted.startsWith(".")
      ? name.endsWith(accepted)
      : accepted.endsWith("/*")
        ? mime.startsWith(accepted.slice(0, -1))
        : accepted === mime,
  );
}

export function fileFieldHoldsOtherFile(
  value: string,
  fileName: string,
): boolean {
  const shown = value.split(/[\\/]/u).at(-1)?.trim() ?? "";
  return shown !== "" && !shown.includes(fileName) && !fileName.includes(shown);
}

export function questionPrompt(control: ApplyFormControl): string {
  if (control.repeatedQuestion) return control.repeatedQuestion.prompt;
  const label = control.label.trim();
  const group = control.groupLabel.trim();
  // File tasks name the input, without its fieldset legend or required marker.
  if (control.kind === "file") {
    return label.replace(/[\s*:]+$/u, "").replace(/\s+upload$/iu, "") || "file";
  }
  const normalizedLabel = normalizeSignal(label);
  const normalizedGroup = normalizeSignal(group);
  if (
    (control.kind === "radio" ||
      (control.kind === "checkbox" &&
        control.answerControlType === "multi_choice")) &&
    group.length > 0
  )
    return control.attestationKind !== null
      ? cleanFormQuestionPrompt(group) || group
      : group;
  const groupAddsSomething =
    normalizedGroup.length > 0 &&
    normalizedLabel.length > 0 &&
    !normalizedLabel.includes(normalizedGroup) &&
    !normalizedGroup.includes(normalizedLabel);
  const prompt = groupAddsSomething ? `${group} — ${label}` : label || group;
  const described =
    prompt ||
    control.placeholder.trim() ||
    "A question on the application form";
  // A declaration's section can change what "I agree" means. Keep that
  // context for both its saved answer and the model's permission check.
  return control.attestationKind !== null
    ? cleanFormQuestionPrompt(described) || described
    : described;
}

export function buildPendingQuestion(input: {
  control: ApplyFormControl;
  jobId: string;
  detectedAt: string;
  suggestion: ApplyAnswer | null;
  siblings?: readonly ApplyFormControl[];
  /** Why stored answers did not settle it, said beside the question. */
  reason?: string | null;
}): ApplicationAttemptQuestion {
  const { control, suggestion } = input;
  const note = input.reason?.trim() || null;
  const radioSiblings =
    control.kind === "radio" && control.choiceGroupKey
      ? (input.siblings ?? []).filter(
          (candidate) =>
            candidate.kind === "radio" &&
            candidate.choiceGroupKey === control.choiceGroupKey,
        )
      : [];
  const answerOptions =
    radioSiblings.length > 0
      ? radioSiblings.map((candidate) => candidate.value || candidate.label)
      : control.options;
  return {
    id: questionIdFor(control, input.jobId, input.siblings ?? []),
    prompt: questionPrompt(control),
    ...(control.repeatedQuestion ? { repeatedAtDifferentStep: true } : {}),
    kind: control.questionKind,
    answerControlType: control.answerControlType,
    ...(control.inputConstraints
      ? { inputConstraints: control.inputConstraints }
      : {}),
    isRequired: control.required,
    detectedAt: input.detectedAt,
    // A list's blank first choice is not an answer anyone could give.
    answerOptions: answerOptions.filter((option) => option.trim().length > 0),
    suggestedAnswers: suggestion
      ? [
          {
            id: `${questionIdFor(control, input.jobId, input.siblings ?? [])}_suggestion`,
            text: suggestion.value,
            sourceKind:
              suggestion.sourceKind === "answer_library"
                ? "user"
                : suggestion.sourceKind === "generated"
                  ? "prior_answer"
                  : "profile",
            sourceId: suggestion.sourceId,
            confidenceLabel: null,
            provenance: [
              {
                id: `${questionIdFor(control, input.jobId, input.siblings ?? [])}_source`,
                sourceKind:
                  suggestion.sourceKind === "answer_library"
                    ? "user"
                    : suggestion.sourceKind === "generated"
                      ? "prior_answer"
                      : "profile",
                sourceId: suggestion.sourceId,
                label: suggestion.provenanceLabel,
                snippet: null,
              },
            ],
          },
        ]
      : [],
    ...(note ? { note } : {}),
    submittedAnswer: null,
    status: "detected",
  };
}

/**
 * The control as the model classified its question: a pay question and a
 * declaration are what the model says they are, not what a keyword list
 * matched. If the model cannot be asked, the keyword classification stays,
 * so the person's pay switch and declaration approvals are never left
 * unguarded.
 */
async function withModelQuestionKinds(
  deps: ApplyExecutorDeps,
  observation: ApplyFormObservation,
  control: ApplyFormControl,
): Promise<ApplyFormControl> {
  if (!deps.classifyQuestions) {
    return { ...control, answerTags: null };
  }
  let classification: ApplyQuestionClassification | undefined;
  let payCurrency = false;
  try {
    const classifications = await deps.classifyQuestions(
      observation.controls,
      JSON.stringify({
        url: observation.url,
        step: observation.step,
        instructions: formWritingInstructions(observation),
      }),
    );
    classification =
      classifications.get(
        questionClassificationKey(control, observation.controls),
      ) ?? classifications.get(questionPrompt(control));
    payCurrency =
      /currency/iu.test(questionPrompt(control)) &&
      (control.questionKind === "salary_expectation" ||
        observation.controls.some(
          (sibling) =>
            (
              classifications.get(
                questionClassificationKey(sibling, observation.controls),
              ) ?? classifications.get(questionPrompt(sibling))
            )?.asksAboutPay === true,
        ));
  } catch {
    return { ...control, answerTags: null };
  }
  if (!classification) {
    return { ...control, answerTags: null };
  }
  return {
    ...control,
    answerTags: classification.answerTags ?? null,
    questionKind:
      classification.eligibilityKind ??
      (classification.asksAboutPay || payCurrency
        ? "salary_expectation"
        : control.questionKind === "salary_expectation"
          ? "other"
          : control.questionKind),
    attestationKind: classification.declarationKind,
    // A label's asterisk is how many forms say required; the reading knows.
    required: control.required || classification.required === true,
    requiredOnPage: control.requiredOnPage ?? control.required,
    ...(typeof classification.asksHiringCountry === "boolean"
      ? { asksHiringCountry: classification.asksHiringCountry }
      : {}),
    ...(typeof classification.asksCurrentPay === "boolean"
      ? { asksCurrentPay: classification.asksCurrentPay }
      : {}),
  };
}

const PAY_KEPT_PRIVATE_REASON =
  "Job Finder leaves pay questions to you. Answer it yourself if you want to.";

type AnswerDecision =
  | { kind: "use"; answer: ApplyAnswer }
  /**
   * Left for the person. `permission` marks their own choice to answer this
   * themselves (pay they keep private), which no model answer overrides.
   */
  | {
      kind: "leave";
      reason: string;
      suggestion: ApplyAnswer | null;
      permission: boolean;
    };

function savedSuggestion(
  control: ApplyFormControl,
  config: ApplyAgentConfig,
): ApplyAnswer | null {
  const saved = savedAnswerForQuestion(control, config.sources.reusableAnswers);
  let value = formatGithubAnswer(control, saved?.answer ?? "");
  if (saved && control.answerControlType === "multi_choice") {
    try {
      const selected: unknown = JSON.parse(saved.answer);
      if (
        Array.isArray(selected) &&
        selected.every((entry) => typeof entry === "string") &&
        selected.includes(control.label || control.value)
      ) {
        value = control.label || control.value;
      }
    } catch {
      /* Older text answers still go through the fact check. */
    }
  }
  const sourceLabel =
    saved &&
    normalizeFormQuestionPrompt(saved.question) ===
      normalizeFormQuestionPrompt(questionPrompt(control))
      ? "your answer to this question"
      : `your saved answer "${saved?.label || saved?.question}"`;
  return saved
    ? {
        value,
        kind: control.questionKind,
        sourceKind: "answer_library",
        sourceId: `answerLibrary.${saved.id}`,
        provenanceLabel: sourceLabel,
        groundedIn: [sourceLabel],
      }
    : null;
}

/**
 * A short value the fact check could not confirm (a start date worked out
 * from a notice period, a phone code from a number) is offered back to the
 * person to accept or change with one press, beside the check's reason. It
 * is not entered. Prose, eligibility, pay and declarations get no such offer.
 */
function proposedValueSuggestion(
  control: ApplyFormControl,
  value: string,
): ApplyAnswer | null {
  return control.attestationKind === null && isShortValueAnswer(control, value)
    ? {
        value: value.trim(),
        kind: control.questionKind,
        sourceKind: "generated",
        sourceId: `proposed.${control.ref}`,
        provenanceLabel: "Job Finder's proposal for you to confirm",
        groundedIn: [],
      }
    : null;
}

/**
 * Whether the model's answer about the person goes in (ADR 0041, ADR 0021).
 *
 * The model read the question and the person's facts and chose the answer.
 * The person's saved answer to this exact question, or a value that is one of
 * their stored facts word for word, goes in as that; anything else is read by
 * the fact check against their profile,
 * resume and saved answers before it is written. Pay the person keeps to
 * themselves is left for them, whatever the model proposed. Without a fact
 * check (an offline run) only stored facts go in.
 */
async function decideAnswer(input: {
  deps: ApplyExecutorDeps;
  control: ApplyFormControl;
  value: string;
  groundedIn?: readonly string[] | undefined;
  storedFactId?: string | undefined;
  pageText: string;
  controls: readonly ApplyFormControl[];
}): Promise<AnswerDecision> {
  const { deps, control } = input;
  const config = deps.config;
  // The recorded discovery source chooses the answer, not a generated guess or
  // an incompatible remembered referral. The normal permission gate still runs.
  const discovery =
    (!deps.classifyQuestions || control.answerTags?.kind === "other") &&
    asksListingDiscoveryControl(control)
      ? listingDiscoveryAnswer(control, config.sources, input.controls)
      : null;
  const priorCompany =
    control.answerTags?.kind === "other"
      ? priorCompanyHistory(control, config.sources)?.answer
      : null;
  const timezone =
    control.answerTags?.kind === "other" &&
    !savedAnswerForQuestion(
      control,
      config.sources.reusableAnswers,
      input.controls,
    )
      ? currentTimezoneAnswer(control, config.sources)?.value
      : null;
  const start = startDateAnswer(
    control,
    config.sources,
    input.controls,
    deps.now(),
  );
  const retainedDate = hasStartDateValue(control) ? control.value : null;
  const value = formatProfileUrlAnswer(
    control,
    formatGithubAnswer(
      control,
      control.kind === "radio" || control.kind === "checkbox"
        ? input.value
        : (retainedDate ??
            start?.value ??
            discovery?.value ??
            priorCompany?.value ??
            timezone ??
            input.value),
    ),
    control.answerTags?.sourceId ?? input.storedFactId,
  );
  const payDisclosed =
    config.authority.salaryDisclosure === "answer_from_profile";
  const saved = savedSuggestion(control, config);
  if (control.repeatedQuestion && !saved) {
    return {
      kind: "leave",
      reason:
        "This question appeared on another step. Answer it for this entry so Job Finder does not reuse the earlier answer.",
      suggestion: null,
      permission: true,
    };
  }
  if (deps.classifyQuestions) {
    const permission = classifyAnswerPermission({
      control,
      controls: input.controls,
      tags: control.answerTags,
      sources: config.sources,
      answer: value,
      pageInstructions: input.pageText,
      approvedAttestations: config.authority.preApprovedAttestationKinds,
      application: config.application,
      now: deps.now(),
    });
    if (permission.kind === "needs_you")
      return {
        kind: "leave",
        reason: permission.reason,
        suggestion: null,
        permission: true,
      };
    if (permission.kind === "literal") {
      if (
        control.questionKind === "salary_expectation" &&
        !payDisclosed &&
        !isAnswerFromThisApplication(
          savedAnswerForQuestion(
            control,
            config.sources.reusableAnswers,
            input.controls,
          ),
          config.application,
          config.sources.posting.location,
        ) &&
        !permission.source.id.startsWith("answerLibrary.application_")
      )
        return {
          kind: "leave",
          reason: PAY_KEPT_PRIVATE_REASON,
          suggestion: saved,
          permission: true,
        };
      deps.onAnswerSource?.("stored_fact");
      return {
        kind: "use",
        answer: {
          value,
          kind: control.questionKind,
          sourceKind:
            permission.source.purpose === "saved"
              ? "answer_library"
              : permission.source.purpose === "listing"
                ? "posting"
                : "profile",
          sourceId: permission.source.id,
          provenanceLabel:
            permission.source.purpose === "listing"
              ? "where Nestor found this listing"
              : "your matching saved answer or profile fact",
          groundedIn: [permission.source.id],
        },
      };
    }
    // Writing permission never falls through the legacy literal shortcuts.
    if (!deps.checkWrittenAnswer)
      return {
        kind: "leave",
        reason: "This writing could not be checked against your sources.",
        suggestion: null,
        permission: true,
      };
    deps.onAnswerSource?.("checked");
    const check = await (
      permission.evidencePolicy
        ? deps.checkWrittenAnswer(
            questionPrompt(control),
            value,
            permission.evidencePolicy,
          )
        : deps.checkWrittenAnswer(questionPrompt(control), value)
    ).catch(() => null);
    if (!check?.supported)
      return {
        kind: "leave",
        reason:
          check?.reason ??
          "This writing could not be checked against your sources.",
        suggestion: null,
        permission: true,
      };
    return {
      kind: "use",
      answer: {
        value,
        kind: control.questionKind,
        sourceKind: "generated",
        sourceId: `written.${control.ref}`,
        provenanceLabel: "written for this application",
        groundedIn: input.groundedIn?.length
          ? [...input.groundedIn]
          : permission.source
            ? [permission.source.id]
            : [],
      },
    };
    // Only requested writing reaches the independent claim checker below.
  }
  if (asksListingDiscoveryControl(control)) {
    const answer = listingDiscoveryAnswer(
      control,
      config.sources,
      input.controls,
    );
    if (
      answer &&
      (control.kind === "radio" || control.kind === "checkbox") &&
      normalizeSignal(answer.value) !== normalizeSignal(value)
    )
      return {
        kind: "leave",
        reason: "This option does not match the recorded listing source.",
        suggestion: null,
        permission: true,
      };
    return answer
      ? { kind: "use", answer }
      : {
          kind: "leave",
          reason:
            "The form does not offer the source where Nestor found this listing. Please choose your answer.",
          suggestion: null,
          permission: true,
        };
  }
  // The reader binds an explicit answer to this application and exact question.
  const savedRecord = savedAnswerForQuestion(
    control,
    config.sources.reusableAnswers,
  );
  if (!saved && requiresSavedOpinionAnswer(questionPrompt(control), value)) {
    return {
      kind: "leave",
      reason: OPINION_ANSWER_REASON,
      suggestion: null,
      permission: true,
    };
  }
  const nationalityQuestion = nationalityQuestionIdentity(
    questionPrompt(control),
  );
  if (
    nationalityQuestion &&
    (!saved ||
      nationalityQuestionIdentity(savedRecord?.question ?? "") !==
        nationalityQuestion)
  ) {
    return {
      kind: "leave",
      reason: NATIONALITY_ANSWER_REASON,
      suggestion: null,
      permission: true,
    };
  }
  const isApplicationAnswer =
    isAnswerFromThisApplication(
      savedRecord,
      config.application,
      config.sources.posting.location,
    ) ||
    (saved?.sourceId.startsWith("answerLibrary.application_") &&
      !savedRecord?.applicationScope);
  if (saved && isApplicationAnswer) {
    if (control.answerControlType === "multi_choice" && saved.value !== value)
      return {
        kind: "leave",
        reason: "Use only the options the person chose for this question.",
        suggestion: saved,
        permission: false,
      };
    deps.onAnswerSource?.("stored_fact");
    return { kind: "use", answer: saved };
  }
  if (control.questionKind === "salary_expectation" && !payDisclosed) {
    const savedPay = config.sources.reusableAnswers.find(
      (answer) =>
        answer.kind === "salary_expectation" && !answer.needsConfirmation,
    );
    return {
      kind: "leave",
      reason: PAY_KEPT_PRIVATE_REASON,
      suggestion:
        saved ??
        (savedPay && !control.asksCurrentPay
          ? {
              value: savedPay.answer,
              kind: "salary_expectation",
              sourceKind: "answer_library",
              sourceId: `answerLibrary.${savedPay.id}`,
              provenanceLabel: "your saved pay answer",
              groundedIn: ["your saved pay answer"],
            }
          : null),
      permission: true,
    };
  }

  const eligibilityQuestion =
    control.questionKind === "work_authorization" ||
    control.questionKind === "visa_sponsorship" ||
    control.asksHiringCountry === true;
  if (
    eligibilityQuestion &&
    saved &&
    isAnswerFromThisApplication(
      savedAnswerForQuestion(control, config.sources.reusableAnswers),
      config.application,
      config.sources.posting.location,
    ) &&
    normalizeSignal(saved.value) !== normalizeSignal(value)
  ) {
    return {
      kind: "leave",
      reason: `You answered this question ${saved.value}. Use that answer unchanged.`,
      suggestion: saved,
      permission: false,
    };
  }
  if (
    (!eligibilityQuestion ||
      isAnswerFromThisApplication(
        savedAnswerForQuestion(control, config.sources.reusableAnswers),
        config.application,
        config.sources.posting.location,
      )) &&
    saved &&
    saved.value.trim() === value.trim()
  ) {
    deps.onAnswerSource?.("stored_fact");
    return { kind: "use", answer: { ...saved, value } };
  }
  // The person's own answer to this exact question, even a bare Yes or No.
  const stored = storedFactFor({
    sources: config.sources,
    payDisclosed,
    control,
    value,
    storedFactId: input.storedFactId,
  });
  if (stored) {
    deps.onAnswerSource?.("stored_fact");
    return { kind: "use", answer: stored };
  }
  if (ownWordsAppliesToQuestion(input.pageText, questionPrompt(control))) {
    return {
      kind: "leave",
      reason: OWN_WORDS_REASON,
      suggestion: null,
      permission: true,
    };
  }
  if (!deps.checkWrittenAnswer) {
    return {
      kind: "leave",
      reason: "Job Finder could not check this answer against your facts.",
      suggestion: savedSuggestion(control, config),
      permission: false,
    };
  }
  let check;
  deps.onAnswerSource?.("checked");
  try {
    check = await deps.checkWrittenAnswer(questionPrompt(control), value);
  } catch {
    return {
      kind: "leave",
      reason:
        "Job Finder could not check this answer right now. Please review it yourself or try again.",
      suggestion: saved,
      permission: false,
    };
  }
  if (!check.supported) {
    return {
      kind: "leave",
      reason: check.reason,
      suggestion: check.reviewWording
        ? {
            value: check.reviewWording,
            kind: control.questionKind,
            sourceKind: "generated",
            sourceId: `review.${control.ref}`,
            provenanceLabel: "proposed wording for your review",
            groundedIn: [],
          }
        : (savedSuggestion(control, config) ??
          proposedValueSuggestion(control, value)),
      permission: false,
    };
  }
  if (saved && saved.value.trim() === value.trim()) {
    return { kind: "use", answer: { ...saved, value } };
  }
  return {
    kind: "use",
    answer: {
      value,
      kind: control.questionKind,
      sourceKind: "generated",
      sourceId: `written.${control.ref}`,
      provenanceLabel: "written for this application",
      groundedIn:
        input.groundedIn && input.groundedIn.length > 0
          ? [...input.groundedIn]
          : ["your profile"],
    },
  };
}

function eligibilityReviewReason(
  control: ApplyFormControl,
  config: ApplyAgentConfig,
  reason: string,
): string {
  if (
    control.questionKind !== "work_authorization" &&
    control.questionKind !== "visa_sponsorship"
  )
    return reason;
  const facts = config.sources.profile.workEligibility;
  const permits = (facts.limitedWorkPermissions ?? []).map(
    (permit) =>
      `${permit.country}: ${permit.conditions}${permit.requiresFutureSponsorship === true ? "; sponsorship needed later" : ""}`,
  );
  return `${reason} Posting location: ${config.sources.posting.location?.trim() || "not specified"}. Countries where you can work: ${facts.authorizedWorkCountries.join(", ") || "not recorded"}.${permits.length ? ` Limited permissions: ${permits.join(". ")}.` : ""} Confirm the hiring country and answer for this job's hours and dates.`;
}

function leaveUnansweredForPerson(input: {
  control: ApplyFormControl;
  observation: ApplyFormObservation;
  config: ApplyAgentConfig;
  at: string;
  reason: string;
  suggestion: ApplyAnswer | null;
}): ApplyExecutionOutcome {
  const { control, observation, config, at, suggestion } = input;
  const reason = eligibilityReviewReason(control, config, input.reason);
  return {
    kind: "suggestion",
    answer: suggestion,
    note: `"${questionPrompt(control)}" needs the person's answer. ${reason} Leave it unchanged and carry on with the rest of the form.`,
    question:
      control.required ||
      input.reason === OWN_WORDS_REASON ||
      input.reason === OPINION_ANSWER_REASON ||
      input.reason === NATIONALITY_ANSWER_REASON
        ? buildPendingQuestion({
            control,
            jobId: config.application.jobId,
            detectedAt: at,
            suggestion,
            siblings: observation.controls,
            reason,
          })
        : null,
    controlRef: control.ref,
    observation,
  };
}

/**
 * An answer the fact check did not support. The model is told why and may
 * answer again from the facts; a required question is kept for the person in
 * case no supported answer comes.
 */
function unsupportedAnswer(input: {
  control: ApplyFormControl;
  observation: ApplyFormObservation;
  config: ApplyAgentConfig;
  at: string;
  reason: string;
  suggestion: ApplyAnswer | null;
}): ApplyExecutionOutcome {
  const { control, observation, config, at } = input;
  return {
    kind: "suggestion",
    answer: null,
    note: `That answer was not entered because the person's facts do not support it: ${input.reason} Use only supported facts, or leave this field blank and continue with the other fields. ${control.required ? "The required question has been kept for the person if no supported answer is available." : "This field is optional; do not ask the person to fill it."}`,
    question: control.required
      ? buildPendingQuestion({
          control,
          jobId: config.application.jobId,
          detectedAt: at,
          suggestion: input.suggestion,
          siblings: observation.controls,
          reason: eligibilityReviewReason(control, config, input.reason),
        })
      : null,
    controlRef: control.ref,
    observation,
  };
}

/** Where an answer the model proposed was not entered. */
function notEntered(input: {
  deps: ApplyExecutorDeps;
  control: ApplyFormControl;
  observation: ApplyFormObservation;
  at: string;
  decision: Extract<AnswerDecision, { kind: "leave" }>;
}): ApplyExecutionOutcome {
  const args = {
    control: input.control,
    observation: input.observation,
    config: input.deps.config,
    at: input.at,
    reason: input.decision.reason,
    suggestion: input.decision.suggestion,
  };
  return input.decision.permission || !input.deps.checkWrittenAnswer
    ? leaveUnansweredForPerson(args)
    : unsupportedAnswer(args);
}

function bareOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function continuationSectionRoot(value: string): string | null {
  try {
    const url = new URL(value);
    const firstSegment = url.pathname.split("/").filter(Boolean)[0];
    return firstSegment ? `${url.origin}/${firstSegment}/` : `${url.origin}/`;
  } catch {
    return null;
  }
}

/**
 * A continued run may advance inside the retained wizard, but it must not
 * discard that form by returning to the exact old source page or its site
 * header. Those addresses are supplied by Job Finder from this application;
 * no ATS route names are guessed here.
 */
function refuseContinuationBacktrack(
  targetUrl: string,
  current: ApplyFormObservation,
  deps: ApplyExecutorDeps,
): string | null {
  const continuation = deps.config.application.continuation;
  if (!continuation || !current.url) return null;
  // A sign-in may land on an account page with a search or newsletter field
  // before the application is visible. It still needs to follow the known job
  // link. Protect only a page with actual application-form evidence.
  const candidateControls = current.controls.filter(
    (control) =>
      control.credentialRole !== "identifier" &&
      control.credentialRole !== "password" &&
      control.questionKind !== "other",
  );
  const hasApplicationFormEvidence =
    current.step.index !== null ||
    current.controls.some((control) => control.kind === "file") ||
    candidateControls.length >= 2 ||
    (candidateControls.length > 0 &&
      current.actions.some(
        (action) => action.kind === "advance" || action.kind === "final",
      ));
  if (!hasApplicationFormEvidence) return null;
  let target: URL;
  let here: URL;
  try {
    target = new URL(targetUrl, current.url);
    here = new URL(current.url);
  } catch {
    return null;
  }
  if (target.toString() === here.toString() || target.origin !== here.origin) {
    return null;
  }
  const oldSources = continuation.sourceUrls.flatMap((sourceUrl) => {
    try {
      return [new URL(sourceUrl).toString()];
    } catch {
      return [];
    }
  });
  const sourceSectionRoots = continuation.sourceUrls.flatMap((sourceUrl) => {
    const root = continuationSectionRoot(sourceUrl);
    return root ? [root] : [];
  });
  if (
    !oldSources.includes(target.toString()) &&
    !sourceSectionRoots.includes(target.toString())
  ) {
    return null;
  }
  return "This run is continuing the retained application form. Stay on that form instead of returning to the site home or the older job listing.";
}

/**
 * Whether the run may be on this page.
 *
 * A listing on one site whose form lives on another is the ordinary shape of
 * job applications. It is also how a run ends up on a search engine or a
 * scraper mirror, one "that is normal" at a time. So a move off the listing's
 * site is allowed only for a reason the model states, judged by a second
 * opinion against the goal; an origin allowed once stays allowed for the
 * run. Submission authority is checked separately by `runSubmitPreflight`;
 * reaching and filling an employer form does not itself send an application.
 */
async function authorizeOrigin(
  observationOrUrl: ApplyFormObservation | string,
  reason: string | null,
  deps: ApplyExecutorDeps,
): Promise<{ refuse: string | null; note: string | null }> {
  const { config } = deps;
  const origin =
    typeof observationOrUrl === "string"
      ? bareOrigin(observationOrUrl)
      : observationOrUrl.origin;
  if (!origin) {
    return { refuse: null, note: null };
  }

  const startOrigin = bareOrigin(config.application.startingUrl);
  if (!startOrigin || origin === startOrigin) {
    return { refuse: null, note: null };
  }
  if (deps.guardState.approvedOrigins.has(origin)) {
    return { refuse: null, note: null };
  }
  if (!config.reviewMove) {
    if (!deps.guardState.reportedOrigins.has(origin)) {
      deps.guardState.reportedOrigins.add(origin);
      return {
        refuse: null,
        note: `This is now ${origin}, a different site from the listing.`,
      };
    }
    return { refuse: null, note: null };
  }
  if (!reason) {
    return {
      refuse: `${origin} is a different site from the listing. To go there, say why in reason: what on the page points there and what you expect to find. A second review reads it.`,
      note: null,
    };
  }
  const url =
    typeof observationOrUrl === "string"
      ? observationOrUrl
      : (observationOrUrl.url ?? origin);
  const review = await config.reviewMove({
    url,
    reason,
    fromUrl: deps.guardState.lastOnSiteUrl,
  });
  if (!review.allowed) {
    deps.guardState.notes.push(
      `Stayed off ${origin}. Reason given: ${reason} Review: ${review.verdict}`,
    );
    return {
      refuse: `${origin} is a different site from the listing, and a review of your reason did not allow going there: ${review.verdict}`,
      note: null,
    };
  }
  deps.guardState.approvedOrigins.set(origin, reason);
  deps.guardState.notes.push(
    `Went to ${origin} because: ${reason} Allowed after review: ${review.verdict}`,
  );
  return {
    refuse: null,
    note: `This is now ${origin}, a different site from the listing. Leaving was allowed after review: ${review.verdict}`,
  };
}

/**
 * After a move that turned out to be refused: back to where the run was.
 */
async function retreat(
  deps: ApplyExecutorDeps,
  refusal: string,
): Promise<{
  kind: "refused";
  reason: string;
  observation: ApplyFormObservation;
}> {
  const back = await deps.config.hands.goBack();
  const observation = await deps.config.hands.observe();
  return {
    kind: "refused",
    reason: `${refusal}${back.ok ? " Job Finder went back." : ""}`,
    observation,
  };
}

function findControl(
  observation: ApplyFormObservation,
  ref: string,
): ApplyFormControl | null {
  return observation.controls.find((control) => control.ref === ref) ?? null;
}

/**
 * Performs one write with the prepare-only guard watching.
 *
 * The value is declared to the guard first, so it can tell a request carrying
 * the answer from one that does not. When field saves are allowed, a short
 * same-origin window is opened before the write and left to run out, so the
 * save the site sends a moment later still gets through.
 */
async function writeUnderGuard(
  deps: ApplyExecutorDeps,
  input: {
    declaredValue: string | null;
    write: () => Promise<ApplyWriteResult>;
  },
): Promise<ApplyWriteResult> {
  const safety = deps.config.safety;
  if (!safety) {
    return input.write();
  }
  if (input.declaredValue) {
    await safety.registerPreparedValue(input.declaredValue);
  }
  if (deps.config.intermediateWritesAuthorized === true) {
    // Opened before the write and left to expire on its own. Sites save a
    // field a moment after it changes, not during the write; closing the
    // window the instant the write returned blocked exactly those saves and
    // left every select on the form reverting to empty.
    await safety.openIntermediateWriteWindow().catch(() => undefined);
  }
  return input.write();
}

/** What the guard saw around one write: a reason to stop, or a tab to follow. */
interface GuardReview {
  pause: ApplyPause | null;
  /** Where a tab the page tried to open was going, when it tried. */
  openedWindowUrl: string | null;
}

/** Whether the guard stopped something worth ending the run over. */
export async function guardStop(
  deps: ApplyExecutorDeps,
  pageUrl: string | null,
): Promise<ApplyPause | null> {
  return (await reviewGuard(deps, pageUrl)).pause;
}

async function reviewGuard(
  deps: ApplyExecutorDeps,
  pageUrl: string | null,
): Promise<GuardReview> {
  const safety = deps.config.safety;
  if (!safety) {
    return { pause: null, openedWindowUrl: null };
  }
  const attempt = await safety.readBlockedAttempt();
  const judgement = judgeBlockedAttempt({
    attempt,
    acknowledged: deps.guardState.acknowledged,
    hasWritten: deps.guardState.hasWritten,
    pageUrl,
    lastFieldLabel: deps.guardState.lastFieldLabel,
  });
  if (judgement.stop) {
    return {
      pause: {
        code: "site_tried_to_send",
        summary: judgement.summary,
        question: null,
        blocker: null,
      },
      openedWindowUrl: null,
    };
  }
  let openedWindowUrl: string | null = null;
  if (attempt && judgement.tolerated) {
    deps.guardState.acknowledged.add(attemptKey(attempt));
    if (judgement.note) {
      deps.guardState.notes.push(judgement.note);
    }
    if (judgement.savesAsYouGo) {
      deps.guardState.lastBlockedSave = {
        host: judgement.savesAsYouGo.host,
        fieldLabel: deps.guardState.lastFieldLabel,
      };
      deps.guardState.blockedSaveCount += 1;
    }
    if (
      judgement.openedWindow?.url &&
      /^https?:/iu.test(judgement.openedWindow.url)
    ) {
      openedWindowUrl = judgement.openedWindow.url;
    }
  }
  return { pause: null, openedWindowUrl };
}

/**
 * The handover where Fill in for me stops pressing.
 *
 * Fill never presses the form's own buttons (Next, Continue, Save, Add):
 * any of them could send the application, and nothing tells which. So the
 * run fills what is on the page and hands the press to the person; continuing
 * afterwards picks the run up on the page they reached.
 */
export function pressOnSitePause(pressed: string, at: Date): ApplyPause {
  const summary = `Job Finder filled what it could on this page. Press ${pressed} on the site yourself, then continue and Job Finder fills the next page.`;
  // One Needs you item for this application: the person presses it on the
  // site and says so, and the run continues on the page they reached.
  const question = {
    id: STEP_HANDOVER_QUESTION_ID,
    prompt: `Press ${pressed} on the site, then continue`,
    repeatedAtDifferentStep: false,
    description: null,
    kind: "other" as const,
    answerControlType: "text" as const,
    isRequired: true,
    note: "Job Finder filled what it could on this page. In Fill in for me it never presses the form's own buttons, because one of them could send your application.",
    detectedAt: at.toISOString(),
    answerOptions: [],
    suggestedAnswers: [],
    submittedAnswer: null,
    status: "detected" as const,
  };
  return {
    code: "site_tried_to_send",
    summary,
    question,
    questions: [question],
    blocker: {
      code: "site_saves_as_you_go",
      summary,
      detail: `In Fill in for me Job Finder never presses the form's own buttons, because one of them could send your application. ${pressed} is yours to press.`,
      nextActionLabel: `Press ${pressed} on the site, then continue`,
      host: null,
    },
  };
}

/**
 * A button that submits its form but reads as neither a step (Next,
 * Continue) nor the form's send. It may send the application, and nothing
 * on the page says so for certain, so the run never presses it.
 */
export function unrecognizedSubmit(action: ApplyFormAction): boolean {
  return action.submitsForm === true && action.kind === "other";
}

/**
 * The handover for that button, in either mode: Fill in for me leaves the
 * click to the person anyway; in Send for me it is a Needs you item, and the
 * person presses it in their own window.
 */
export function formSendPause(label: string, at: Date): ApplyPause {
  const pause = pressOnSitePause(`"${label}"`, at);
  const summary = `This form's button "${label}" may send your application; press it yourself when you're ready.`;
  const question = {
    ...pause.question!,
    prompt: `Press "${label}" on the site yourself when you're ready`,
    note: summary,
  };
  return {
    ...pause,
    summary,
    question,
    questions: [question],
    blocker: pause.blocker && {
      ...pause.blocker,
      summary,
      detail: summary,
      nextActionLabel: `Press "${label}" yourself`,
    },
    formSend: true,
  };
}

/** Whether this run may press the form's own buttons (Send for me). */
export function pressesFormButtons(
  config: Pick<
    ApplyAgentConfig,
    "pressesFormButtons" | "intermediateWritesAuthorized"
  >,
): boolean {
  return (
    config.pressesFormButtons ?? config.intermediateWritesAuthorized === true
  );
}

function afterWrite(deps: ApplyExecutorDeps, label: string | null): void {
  deps.guardState.hasWritten = true;
  deps.guardState.lastFieldLabel = label;
  if (label !== null) deps.guardState.fieldWrites += 1;
}

/**
 * Runs one step.
 *
 * `seenSignature` is the page the model was looking at. A page that has moved
 * on refuses the write and hands back what is there now, so the model can try
 * again against the real page rather than the run stopping.
 */
export async function executeApplyProposal(
  proposal: ApplyProposal,
  seenSignature: string,
  deps: ApplyExecutorDeps,
): Promise<ApplyExecutionOutcome> {
  const { config } = deps;
  const at = deps.now().toISOString();

  if (proposal.tool === "finish") {
    return {
      kind: "finished",
      reason: proposal.reason,
      stuck: proposal.stuck === true,
      needsPerson: proposal.needsPerson === true,
      forPerson: proposal.forPerson ?? [],
    };
  }

  // Reads and page moves never need a fresh observation first; the hands
  // return one afterwards anyway.
  switch (proposal.tool) {
    case "observe":
      return { kind: "observed", observation: await config.hands.observe() };
    case "read_text": {
      const text = await config.hands.readText(proposal.ref);
      return { kind: "read", text, observation: await config.hands.observe() };
    }
    case "navigate": {
      const reason = proposal.reason ?? null;
      const current = await config.hands.observe();
      const continuationRefusal = refuseContinuationBacktrack(
        proposal.url,
        current,
        deps,
      );
      if (continuationRefusal) {
        return {
          kind: "refused",
          reason: continuationRefusal,
          observation: current,
        };
      }
      const before = await authorizeOrigin(proposal.url, reason, deps);
      if (before.refuse) {
        return {
          kind: "refused",
          reason: before.refuse,
          observation: await config.hands.observe(),
        };
      }
      const moved = await config.hands.navigate(proposal.url);
      const observation = await config.hands.observe();
      if (!moved.ok) {
        return { kind: "refused", reason: moved.error, observation };
      }
      const origin = await authorizeOrigin(observation, reason, deps);
      if (origin.refuse) {
        return retreat(deps, origin.refuse);
      }
      deps.guardState.lastOnSiteUrl = observation.url;
      return {
        kind: "moved",
        note: [`Opened ${moved.url}.`, before.note ?? origin.note]
          .filter(Boolean)
          .join(" "),
        observation,
        progress: true,
      };
    }
    case "follow_link": {
      const reason = proposal.reason ?? null;
      const current = await config.hands.observe();
      const link =
        current.links.find((entry) => entry.ref === proposal.ref) ?? null;
      const continuationRefusal = link
        ? refuseContinuationBacktrack(link.href, current, deps)
        : null;
      if (continuationRefusal) {
        return {
          kind: "refused",
          reason: continuationRefusal,
          observation: current,
        };
      }
      const accountCreationLink = link
        ? /^(?:create (?:an? )?account|register|sign up)(?:\b|$)/iu.test(
            link.label.trim(),
          ) ||
          /(?:^|\/)(?:signup|sign-up|register|registration)(?:\/|$)/iu.test(
            (() => {
              try {
                return new URL(link.href).pathname;
              } catch {
                return link.href;
              }
            })(),
          )
        : false;
      if (accountCreationLink && config.accountCreationAuthorized !== true) {
        return {
          kind: "refused",
          reason:
            "Creating an account has not been authorized. Use an existing sign-in path, or finish and leave account creation with the person.",
          observation: current,
        };
      }
      const before = link
        ? await authorizeOrigin(link.href, reason, deps)
        : { refuse: null, note: null };
      if (before.refuse) {
        return { kind: "refused", reason: before.refuse, observation: current };
      }
      const moved = await config.hands.followLink(proposal.ref);
      const observation = await config.hands.observe();
      if (!moved.ok) {
        return { kind: "refused", reason: moved.error, observation };
      }
      const origin = await authorizeOrigin(observation, reason, deps);
      if (origin.refuse) {
        return retreat(deps, origin.refuse);
      }
      deps.guardState.lastOnSiteUrl = observation.url;
      return {
        kind: "moved",
        note: [
          `Followed ${link?.label ? `"${link.label}"` : "the link"} to ${moved.url}.`,
          before.note ?? origin.note,
        ]
          .filter(Boolean)
          .join(" "),
        observation,
        progress: true,
      };
    }
    case "go_back": {
      const moved = await config.hands.goBack();
      const observation = await config.hands.observe();
      if (moved.ok) deps.guardState.lastOnSiteUrl = observation.url;
      return moved.ok
        ? {
            kind: "moved",
            note: `Went back to ${moved.url}.`,
            observation,
            progress: true,
          }
        : { kind: "refused", reason: moved.error, observation };
    }
    case "scroll": {
      await config.hands.scroll(proposal.direction);
      return {
        kind: "moved",
        note: `Scrolled ${proposal.direction}.`,
        observation: await config.hands.observe(),
        progress: false,
      };
    }
    case "wait": {
      await config.hands.wait(proposal.milliseconds);
      return {
        kind: "moved",
        note: `Waited ${Math.round(proposal.milliseconds)}ms.`,
        observation: await config.hands.observe(),
        progress: false,
      };
    }
    default:
      break;
  }

  const observation = await config.hands.observe();
  deps.guardState.lastOnSiteUrl = observation.url;

  // A page that moved on since the model looked is retried, not stopped: the
  // model gets what is there now and decides again.
  if (observation.signature !== seenSignature) {
    return {
      kind: "refused",
      reason:
        "The page changed since you last looked, so that step was not taken. Here is the page as it is now — decide again from this.",
      observation,
    };
  }

  // Typing into or choosing in a picker goes through the select checks
  // below; clicking it open is the one way round them.
  if (proposal.tool === "click") {
    const control = findControl(observation, proposal.ref);
    if (
      control &&
      (control.kind === "select" || control.kind === "combobox") &&
      !control.answered &&
      pickerExhausted(deps.guardState, control)
    )
      return pickerHandover(
        deps,
        observation,
        control,
        control.selectedOptionLabel || control.value || questionPrompt(control),
        "This picker refused its choices already.",
        at,
      );
  }

  // Security checks stay with the person. A continuation after the person
  // solved one used to tick the box again, which unticked their answer.
  if (
    (proposal.tool === "click" ||
      proposal.tool === "type" ||
      proposal.tool === "select" ||
      proposal.tool === "set_checkbox") &&
    (() => {
      const control = findControl(observation, proposal.ref);
      return control !== null && isSecurityChallengeControl(control);
    })()
  ) {
    return {
      kind: "refused",
      reason:
        "That control is a security check. Only the person answers it; leave it exactly as it is and carry on with the rest of the form.",
      observation,
    };
  }

  // Validate attachment selection before leaving a form step. An earlier
  // attempt may still hold a different resume on this retained page.
  if (proposal.tool === "click" || proposal.tool === "submit_application") {
    const action =
      "ref" in proposal
        ? observation.actions.find(
            (candidate) => candidate.ref === proposal.ref,
          )
        : null;
    if (
      proposal.tool !== "click" ||
      action?.kind === "advance" ||
      action?.kind === "final"
    ) {
      const resume = config.sources.documents.find(
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
          ),
      );
      if (staleUpload && resume) {
        return {
          kind: "refused",
          reason: `"${questionPrompt(staleUpload)}" still contains ${staleUpload.value.split(/[\\/]/u).at(-1)}. The selected resume is ${resume.fileName}.`,
          observation,
        };
      }
    }
  }

  switch (proposal.tool) {
    case "click": {
      const submits = observation.actions.find(
        (action) => action.ref === proposal.ref,
      );
      if (submits && unrecognizedSubmit(submits))
        return {
          kind: "paused",
          pause: formSendPause(submits.label, deps.now()),
        };
      const control = findControl(observation, proposal.ref);
      if (control?.kind === "checkbox" || control?.kind === "radio") {
        // A click changes an answer just as set_checkbox does. Keep consent
        // and grounded-answer checks on both routes to the same control.
        return executeApplyProposal(
          {
            tool: "set_checkbox",
            ref: control.ref,
            checked: control.kind === "radio" || !control.checked,
          },
          observation.signature,
          deps,
        );
      }
      // Fill in for me presses only what helps it fill (see fill-presses);
      // Next, Continue, Save and the rest are the person's.
      const fillPress = pressesFormButtons(deps.config)
        ? null
        : fillPressFor({
            config,
            observation,
            ref: proposal.ref,
            state: deps.guardState,
          });
      // "Apply now" before anything is filled opens the form; it sends nothing.
      const finalAction =
        fillPress?.kind === "open_form"
          ? undefined
          : observation.actions.find(
              (candidate) =>
                candidate.ref === proposal.ref && candidate.kind === "final",
            );
      if (finalAction) {
        const preflight = runSubmitPreflight({
          observation,
          proposedActionRef: proposal.ref,
          authority: config.authority,
        });
        if (!preflight.ok) {
          return { kind: "refused", reason: preflight.reason, observation };
        }
        // Models sometimes choose the generic click tool for the visible send
        // button. Treat that as the same intent as submit_application so the
        // irreversible action still belongs to the separately authorized
        // submission path and is never pressed from the preparation loop.
        return {
          kind: "ready_to_send",
          finalActionRef: proposal.ref,
          finalActionLabel: finalAction.label,
          observation,
        };
      }
      if (!pressesFormButtons(deps.config) && !fillPress)
        return {
          kind: "paused",
          pause: pressOnSitePause(
            describeRef(observation, proposal.ref),
            deps.now(),
          ),
        };
      const livePage = await config.hands.observe();
      const personOwnedBlocker = livePage.blocker?.requiresPerson
        ? livePage.blocker
        : null;
      if (
        personOwnedBlocker &&
        !(
          personOwnedBlocker.code === "account_creation_required" &&
          config.accountCreationAuthorized === true
        )
      ) {
        return {
          kind: "paused",
          pause: {
            code: "page_blocked",
            summary: personOwnedBlocker.summary,
            question: null,
            blocker: personOwnedBlocker,
          },
        };
      }
      // A press is never a field write: let the selected file finish
      // uploading, then shut its window so this press cannot carry it.
      await config.safety?.closeUploadWindow?.().catch(() => undefined);
      // A cookie banner is dismissed with the choice that keeps the least,
      // whichever of its buttons the model named.
      const pressRef = fillPress?.ref ?? proposal.ref;
      const write = await writeUnderGuard(deps, {
        declaredValue: null,
        write: () => config.hands.clickElement(pressRef),
      });
      if (!write.ok) {
        return { kind: "refused", reason: write.error, observation };
      }
      afterWrite(deps, null);
      if (fillPress) recordFillPress(deps.guardState, fillPress);
      const review = await reviewGuard(deps, observation.url);
      if (review.pause) {
        return { kind: "paused", pause: review.pause };
      }
      // The thing pressed wanted a new tab. A person would simply end up on
      // it; so does the run, in the one tab it works in.
      const reason = proposal.reason ?? null;
      if (review.openedWindowUrl) {
        const before = await authorizeOrigin(
          review.openedWindowUrl,
          reason,
          deps,
        );
        if (before.refuse) {
          return {
            kind: "refused",
            reason: `Pressing ${describeRef(observation, pressRef)} tried to open ${review.openedWindowUrl} in a new tab. ${before.refuse}`,
            observation: await config.hands.observe(),
          };
        }
        const followed = await config.hands.navigate(review.openedWindowUrl);
        const landed = await config.hands.observe();
        if (!followed.ok) {
          return {
            kind: "refused",
            reason: `Pressing ${describeRef(observation, pressRef)} tried to open ${review.openedWindowUrl} in a new tab, and that page would not open here: ${followed.error}`,
            observation: landed,
          };
        }
        const landedOrigin = await authorizeOrigin(landed, reason, deps);
        if (landedOrigin.refuse) {
          return retreat(deps, landedOrigin.refuse);
        }
        deps.guardState.lastOnSiteUrl = landed.url;
        return {
          kind: "moved",
          note: `Pressing ${describeRef(observation, pressRef)} opened ${followed.url} in a new tab. Job Finder works in one tab, so it opened that address here instead.${(before.note ?? landedOrigin.note) ? ` ${before.note ?? landedOrigin.note}` : ""}`,
          observation: landed,
          progress: true,
        };
      }
      const after = await config.hands.observe();
      const movedOrigin = await authorizeOrigin(after, reason, deps);
      if (movedOrigin.refuse) {
        return retreat(
          deps,
          `Pressing ${describeRef(observation, pressRef)} led to ${after.origin ?? "another site"}. ${movedOrigin.refuse}`,
        );
      }
      deps.guardState.lastOnSiteUrl = after.url;
      return {
        kind: "moved",
        note: [
          `Pressed ${describeRef(observation, pressRef)}.`,
          movedOrigin.note,
        ]
          .filter(Boolean)
          .join(" "),
        observation: after,
        progress:
          after.url !== observation.url ||
          after.signature !== observation.signature,
      };
    }

    case "type": {
      const found = findControl(observation, proposal.ref);
      if (!found) {
        return {
          kind: "refused",
          reason: `There is no ${proposal.ref} on this page.`,
          observation,
        };
      }
      const control = await withModelQuestionKinds(deps, observation, found);
      if (control.kind === "combobox" || control.kind === "select")
        return executeApplyProposal(
          {
            tool: "select",
            ref: control.ref,
            option: proposal.text,
            ...(proposal.storedFactId
              ? { storedFactId: proposal.storedFactId }
              : {}),
          },
          seenSignature,
          deps,
        );
      if (!control.visible || control.disabled || control.readOnly) {
        return {
          kind: "refused",
          reason: `"${questionPrompt(control)}" cannot be edited right now.`,
          observation,
        };
      }
      if (observation.blocker?.requiresPerson === true) {
        return {
          kind: "paused",
          pause: {
            code: "page_blocked",
            summary: observation.blocker.summary,
            question: null,
            blocker: observation.blocker,
          },
        };
      }

      // One application sends one letter. A box asking for it gets the same
      // words as a file field would, so the person never discovers they sent
      // two different letters for the same job.
      if (isCoverLetterControl(control)) {
        const policy = config.writing?.coverLetterPolicy ?? "when_required";
        if (
          !approvedApplicationLetter(config, control) &&
          !coverLetterPolicyAllows(control, policy)
        ) {
          if (policy === "never" && control.required) {
            return {
              kind: "paused",
              pause: {
                code: "document_needs_you",
                summary:
                  "This form requires a letter, but your settings say Job Finder should not write one. Add the letter yourself or change that setting, then continue.",
                question: buildPendingQuestion({
                  control,
                  jobId: config.application.jobId,
                  detectedAt: at,
                  suggestion: null,
                  reason:
                    "Your cover-letter setting is Never. Attach the required letter yourself or change that setting.",
                }),
                blocker: null,
              },
            };
          }
          return {
            kind: "refused",
            reason:
              policy === "never"
                ? "Your settings say not to write or attach letters. Leave this field blank and continue."
                : "Your settings say to write a letter only when the form requires one. This field is optional, so leave it blank and continue.",
            observation,
          };
        }
        if (!config.letters && !approvedApplicationLetter(config, control)) {
          return {
            kind: "refused",
            reason: "Job Finder has no letter for this application.",
            observation,
          };
        }
        if (
          deps.classifyQuestions &&
          !approvedApplicationLetter(config, control)
        ) {
          const permission = classifyAnswerPermission({
            control,
            controls: observation.controls,
            tags: control.answerTags,
            sources: config.sources,
            answer: "",
            pageInstructions: formWritingInstructions(observation),
          });
          if (permission.kind !== "writing")
            return notEntered({
              deps,
              control,
              observation,
              at,
              decision: {
                kind: "leave",
                reason:
                  permission.kind === "needs_you"
                    ? permission.reason
                    : "This form needs your unchanged letter.",
                suggestion: null,
                permission: true,
              },
            });
        }
        const letter = await provideApplicationLetter(deps, control);
        if (letter.kind !== "ok") {
          return letter.outcome;
        }
        const typed = await writeUnderGuard(deps, {
          declaredValue: letter.letter.text,
          write: () => config.hands.fillText(control.ref, letter.letter.text),
        });
        if (!typed.ok) {
          return { kind: "refused", reason: typed.error, observation };
        }
        let retainedPage: ApplyFormObservation | null = null;
        if (!deps.deferTextRetention) {
          await config.hands.wait(TEXT_RETENTION_MS);
          const after = await config.hands.observe();
          retainedPage = after;
          const error = textRetentionError(
            observation,
            after,
            control,
            letter.letter.text,
          );
          if (error)
            return { kind: "refused", reason: error, observation: after };
        }
        afterWrite(deps, questionPrompt(control));
        const letterStop = await guardStop(deps, observation.url);
        if (letterStop) {
          return { kind: "paused", pause: letterStop };
        }
        return {
          kind: "filled",
          filled: {
            ref: control.ref,
            label: questionPrompt(control),
            questionKind: "cover_letter",
            answer: {
              value: letter.letter.text,
              kind: "cover_letter",
              sourceKind: approvedApplicationLetter(config, control)
                ? "answer_library"
                : "generated",
              sourceId: approvedApplicationLetter(config, control)
                ? config.sources.approvedLetterText !== undefined
                  ? "approved_application_letter"
                  : `answerLibrary.${savedAnswerForQuestion(control, config.sources.reusableAnswers)?.id}`
                : "application.letter",
              provenanceLabel: approvedApplicationLetter(config, control)
                ? "your letter for this application"
                : "the letter written for this application",
              groundedIn: letter.letter.groundedIn,
            },
            at,
          },
          observation: retainedPage ?? (await config.hands.observe()),
        };
      }

      // The model read the question and the person's facts and chose what to
      // type (ADR 0041); decideAnswer keeps it to the person's own facts.
      const decision = await decideAnswer({
        controls: observation.controls,
        deps,
        control,
        pageText: formWritingInstructions(observation),
        value: proposal.text,
        groundedIn: proposal.groundedIn,
        storedFactId: proposal.storedFactId,
      });
      if (decision.kind === "leave") {
        return notEntered({ deps, control, observation, at, decision });
      }
      const answer = decision.answer;

      const write = await writeUnderGuard(deps, {
        declaredValue: answer.value,
        write: () =>
          isStartDateControl(control) &&
          !control.invalid &&
          control.value === answer.value
            ? Promise.resolve({ ok: true, observedValue: control.value })
            : config.hands.fillText(control.ref, answer.value),
      });
      if (!write.ok) {
        return { kind: "refused", reason: write.error, observation };
      }
      let retainedPage: ApplyFormObservation | null = null;
      if (!deps.deferTextRetention) {
        await config.hands.wait(TEXT_RETENTION_MS);
        const after = await config.hands.observe();
        retainedPage = after;
        const error = textRetentionError(
          observation,
          after,
          control,
          answer.value,
        );
        if (error)
          return { kind: "refused", reason: error, observation: after };
      }
      afterWrite(deps, questionPrompt(control));
      const stop = await guardStop(deps, observation.url);
      if (stop) {
        return { kind: "paused", pause: stop };
      }
      return {
        kind: "filled",
        filled: {
          ref: control.ref,
          label: questionPrompt(control),
          questionKind: control.questionKind,
          answer,
          at,
        },
        observation: retainedPage ?? (await config.hands.observe()),
      };
    }

    case "select": {
      const found = findControl(observation, proposal.ref);
      if (!found) {
        return {
          kind: "refused",
          reason: `There is no ${proposal.ref} on this page.`,
          observation,
        };
      }
      const control = await withModelQuestionKinds(deps, observation, found);
      // The person's saved rule for this exact question decides the order,
      // whatever the model proposed.
      const saved = savedPickerRule(control, questionPrompt(control), config);
      if (saved)
        return applyPickerRule({ deps, control, observation, at, ...saved });
      const choice = await decideAnswer({
        controls: observation.controls,
        deps,
        control,
        pageText: formWritingInstructions(observation),
        value: matchOption(control.options, proposal.option) ?? proposal.option,
        storedFactId: proposal.storedFactId,
      });
      if (choice.kind === "leave") {
        return notEntered({ deps, control, observation, at, decision: choice });
      }
      // The list read with the page may stop short of the form's real
      // choices, so a choice missing from it still goes to the picker.
      const option =
        matchOption(control.options, choice.answer.value) ??
        choice.answer.value;
      const key = pickerQuestionKey(control);
      if (pickerRefused(deps.guardState, control, option)) {
        deps.guardState.repeatedPickers.add(key);
        return pickerHandover(
          deps,
          observation,
          control,
          option,
          `"${option}" was already tried on this application and the form did not take it.`,
          at,
        );
      }
      // After two refused choices only the person's own answers are tried.
      if (
        pickerExhausted(deps.guardState, control) &&
        choice.answer.sourceKind === "generated"
      )
        return pickerHandover(
          deps,
          observation,
          control,
          option,
          `This picker refused ${MAX_PICKER_ATTEMPTS} choices already.`,
          at,
        );
      const write = await choosePickerOption(deps, control, option);
      if (!write.ok) {
        const after = await config.hands.observe();
        return pickerHandover(
          deps,
          after,
          findControl(after, control.ref) ?? control,
          option,
          write.error,
          at,
        );
      }
      return pickerFilled(deps, control, observation, at, {
        ...(choice.answer.sourceKind === "generated"
          ? {
              ...choice.answer,
              sourceId: `chosen.${control.ref}`,
              provenanceLabel: "chosen on the form by Job Finder",
            }
          : choice.answer),
        value: option,
      });
    }

    case "set_checkbox": {
      const found = findControl(observation, proposal.ref);
      if (!found) {
        return {
          kind: "refused",
          reason: `There is no ${proposal.ref} on this page.`,
          observation,
        };
      }
      let control = await withModelQuestionKinds(deps, observation, found);
      // A radio button is a choice like a select's option: the model's pick
      // stands when the person's facts support it (ADR 0041). A declaration
      // is settled by the person's approvals below instead.
      let radioAnswer: ApplyAnswer | null = null;
      const eligibilityAnswer =
        control.questionKind === "work_authorization" ||
        control.questionKind === "visa_sponsorship";
      const savedToggle = savedAnswerForQuestion(
        control,
        config.sources.reusableAnswers,
      );
      const ownToggle =
        savedToggle?.id.startsWith("application_") &&
        (!savedToggle.applicationScope ||
          isAnswerFromThisApplication(
            savedToggle,
            config.application,
            config.sources.posting.location,
          ));
      if (
        deps.classifyQuestions ||
        ownToggle ||
        ((control.kind === "radio" ||
          control.answerControlType === "multi_choice") &&
          proposal.checked &&
          control.attestationKind === null) ||
        (eligibilityAnswer && (control.kind === "checkbox" || proposal.checked))
      ) {
        // Eligibility is a factual answer even when worded as a declaration.
        // A box in a checkbox group is one option of the group's question,
        // so it is matched by its option, like a radio button; the person's
        // answer to that group lists the options they chose.
        const proposedOption =
          control.kind === "checkbox" &&
          control.answerControlType !== "multi_choice"
            ? proposal.checked
              ? "Yes"
              : "No"
            : control.label || control.value;
        const choice = await decideAnswer({
          controls: observation.controls,
          deps,
          control,
          pageText: formWritingInstructions(observation),
          value: proposedOption,
          storedFactId: proposal.storedFactId,
        });
        if (choice.kind === "leave") {
          return notEntered({
            deps,
            control,
            observation,
            at,
            decision: choice,
          });
        }
        radioAnswer =
          choice.answer.sourceKind === "generated"
            ? {
                ...choice.answer,
                value: proposedOption,
                sourceId: `chosen.${control.ref}`,
                provenanceLabel: "chosen on the form by Job Finder",
              }
            : choice.answer;
      }
      let checked = proposal.checked;
      if (radioAnswer?.sourceId.startsWith("answerLibrary.application_")) {
        if (control.kind === "radio") {
          const selected = observation.controls.find(
            (candidate) =>
              candidate.kind === "radio" &&
              (control.choiceGroupKey
                ? candidate.choiceGroupKey === control.choiceGroupKey
                : candidate.ref === control.ref) &&
              [candidate.value, candidate.label].some(
                (value) =>
                  normalizeSignal(value) === normalizeSignal(radioAnswer.value),
              ),
          );
          if (!selected)
            return {
              kind: "refused",
              reason:
                "The person's answer is not one of this question's choices.",
              observation,
            };
          control = selected;
          checked = true;
        } else if (control.answerControlType === "multi_choice") {
          // decideAnswer accepted only an option the person included.
          checked = true;
        } else if (control.answerControlType === "boolean") {
          const value = normalizeSignal(radioAnswer.value);
          if (value !== "yes" && value !== "no")
            return {
              kind: "refused",
              reason: "The person's answer does not match this checkbox.",
              observation,
            };
          checked = value === "yes";
        }
      }
      if (
        radioAnswer &&
        control.kind === "radio" &&
        checked &&
        ![control.label, control.value].some(
          (value) =>
            normalizeSignal(value) === normalizeSignal(radioAnswer.value),
        )
      )
        return {
          kind: "refused",
          reason: "The approved answer does not match this radio option.",
          observation,
        };
      // A declaration the person makes about themselves is theirs. This is the
      // one place the model is overruled rather than advised. It is not,
      // however, a reason to stop: the run used to end on the first such box
      // with the rest of the form untouched, and the person came back to a
      // half-filled page and a "Needs you" that never cleared. The box is left
      // for them, the model carries on, and the question is handed back with
      // the finished form ("1 question left for you", ADR 0022).
      //
      // A "Yes" the person saved for this exact question earlier counts as
      // their approval: they answered it once and asked to keep it.
      const savedDeclaration =
        control.attestationKind !== null && checked
          ? savedSuggestion(control, config)
          : null;
      const savedDeclarationSaysYes =
        savedDeclaration !== null &&
        /^(yes|true|agree|i agree|accept|checked|on|1)\b/iu.test(
          savedDeclaration.value.trim(),
        );
      const declarationApproved =
        control.attestationKind !== null &&
        config.authority.preApprovedAttestationKinds.includes(
          control.attestationKind,
        );
      if (
        control.attestationKind !== null &&
        checked &&
        !declarationApproved &&
        !savedDeclarationSaysYes
      ) {
        return {
          kind: "suggestion",
          answer: null,
          note: `"${questionPrompt(control)}" is a declaration only the person can make, and they have not approved that kind in advance. Job Finder left it unticked.${control.required ? " It will be handed to them with the finished form." : " It is optional, so no answer is needed."} Do not try to tick it again; carry on with the rest of the application, and when everything else is done call finish.`,
          question: control.required
            ? buildPendingQuestion({
                control,
                jobId: config.application.jobId,
                detectedAt: at,
                suggestion: null,
                siblings: observation.controls,
              })
            : null,
          controlRef: control.ref,
          observation,
        };
      }
      const write = await writeUnderGuard(deps, {
        declaredValue: null,
        write: () => config.hands.setToggle(control.ref, checked),
      });
      if (!write.ok) {
        return { kind: "refused", reason: write.error, observation };
      }
      afterWrite(deps, questionPrompt(control));
      const stop = await guardStop(deps, observation.url);
      if (stop) {
        return { kind: "paused", pause: stop };
      }
      const formValue =
        control.kind === "radio" && checked
          ? control.value || control.label
          : checked
            ? "Yes"
            : "No";
      return {
        kind: "filled",
        filled: {
          ref: control.ref,
          label: questionPrompt(control),
          questionKind: control.questionKind,
          // A declaration on in Settings is ticked because of that setting,
          // whatever the person saved. A saved "Yes" keeps its source but
          // records what the box shows, so the review finds it on the form.
          answer:
            savedDeclarationSaysYes && savedDeclaration && !declarationApproved
              ? { ...savedDeclaration, value: formValue }
              : (radioAnswer ?? {
                  value: formValue,
                  kind: control.questionKind,
                  sourceKind: control.attestationKind ? "profile" : "generated",
                  sourceId: control.attestationKind
                    ? `authority.attestation.${control.attestationKind}`
                    : `chosen.${control.ref}`,
                  provenanceLabel: control.attestationKind
                    ? "your Settings (on by default)"
                    : "chosen on the form by Job Finder",
                  groundedIn: [
                    control.attestationKind
                      ? "your Settings (on by default)"
                      : "the form",
                  ],
                }),
          at,
        },
        observation: await config.hands.observe(),
      };
    }

    case "upload": {
      const found = findControl(observation, proposal.ref);
      if (!found) {
        return {
          kind: "refused",
          reason: `There is no ${proposal.ref} on this page.`,
          observation,
        };
      }
      const control = await withModelQuestionKinds(deps, observation, found);
      if (isCoverLetterControl(control)) {
        const policy = config.writing?.coverLetterPolicy ?? "when_required";
        // The person's own cover letter (Profile › Files) beats a written one
        // and beats the "only when required" rule: they added the file in
        // order to send it, so an optional letter field gets it too. Only
        // "never" keeps every letter field for them.
        const approvedText = approvedApplicationLetter(config, control);
        const ownLetter = approvedText
          ? config.sources.documents.find(
              (candidate) =>
                candidate.id === proposal.documentId &&
                candidate.kind === "cover_letter" &&
                candidate.reviewText?.text === approvedText,
            )
          : policy === "never"
            ? undefined
            : config.sources.documents.find(
                (candidate) => candidate.kind === "cover_letter",
              );
        if (ownLetter) {
          const ownBytes = await ownLetter.loadBytes();
          const ownUpload = await writeUnderGuard(deps, {
            declaredValue: ownLetter.fileName,
            write: () =>
              config.hands.uploadFile(control.ref, {
                name: ownLetter.fileName,
                mimeType: ownLetter.mimeType,
                bytes: ownBytes,
              }),
          });
          if (!ownUpload.ok) {
            return { kind: "refused", reason: ownUpload.error, observation };
          }
          if (
            fileFieldHoldsOtherFile(ownUpload.observedValue, ownLetter.fileName)
          ) {
            return {
              kind: "refused",
              reason:
                "The form did not keep the selected file. Nothing was recorded as attached.",
              observation: await config.hands.observe(),
            };
          }
          afterWrite(deps, questionPrompt(control));
          const ownStop = await guardStop(deps, observation.url);
          if (ownStop) {
            return { kind: "paused", pause: ownStop };
          }
          return {
            kind: "attached",
            attachment: {
              ...(ownLetter.reviewText
                ? { reviewText: ownLetter.reviewText }
                : {}),
              documentId: ownLetter.id,
              fileName: ownLetter.fileName,
              label: ownLetter.label,
              controlLabel: questionPrompt(control),
              at,
            },
            observation: await config.hands.observe(),
          };
        }
        if (
          !approvedApplicationLetter(config, control) &&
          !coverLetterPolicyAllows(control, policy)
        ) {
          if (policy === "never" && control.required) {
            return {
              kind: "paused",
              pause: {
                code: "document_needs_you",
                summary:
                  "This form requires a letter, but your settings say Job Finder should not write one. Attach the letter yourself or change that setting, then continue.",
                question: buildPendingQuestion({
                  control,
                  jobId: config.application.jobId,
                  detectedAt: at,
                  suggestion: null,
                  reason:
                    "Your cover-letter setting is Never. Attach the required letter yourself or change that setting.",
                }),
                blocker: null,
              },
            };
          }
          return {
            kind: "refused",
            reason:
              policy === "never"
                ? "Your settings say not to write or attach letters. Leave this field blank and continue."
                : "Your settings say to write a letter only when the form requires one. This field is optional, so leave it blank and continue.",
            observation,
          };
        }
        if (!config.letters && !approvedApplicationLetter(config, control)) {
          return {
            kind: "refused",
            reason: "Job Finder has no letter for this application.",
            observation,
          };
        }
        if (
          deps.classifyQuestions &&
          !approvedApplicationLetter(config, control)
        ) {
          const permission = classifyAnswerPermission({
            control,
            controls: observation.controls,
            tags: control.answerTags,
            sources: config.sources,
            answer: "",
            pageInstructions: formWritingInstructions(observation),
          });
          if (permission.kind !== "writing")
            return notEntered({
              deps,
              control,
              observation,
              at,
              decision: {
                kind: "leave",
                reason:
                  permission.kind === "needs_you"
                    ? permission.reason
                    : "This form needs your unchanged letter.",
                suggestion: null,
                permission: true,
              },
            });
        }
        const letter = await provideApplicationLetter(deps, control);
        if (letter.kind !== "ok") {
          return letter.outcome;
        }
        if (!letter.letter.document) {
          return {
            kind: "paused",
            pause: {
              code: "document_needs_you",
              summary: `This form wants the letter as a file Job Finder cannot produce for "${questionPrompt(control)}". Attach one here and it will be used.`,
              question: buildPendingQuestion({
                control,
                jobId: config.application.jobId,
                detectedAt: at,
                suggestion: null,
              }),
              blocker: null,
            },
          };
        }
        const letterFile = letter.letter.document;
        const letterBytes = await letterFile.loadBytes();
        const letterUpload = await writeUnderGuard(deps, {
          declaredValue: letterFile.fileName,
          write: () =>
            config.hands.uploadFile(control.ref, {
              name: letterFile.fileName,
              mimeType: letterFile.mimeType,
              bytes: letterBytes,
            }),
        });
        if (!letterUpload.ok) {
          return { kind: "refused", reason: letterUpload.error, observation };
        }
        if (
          fileFieldHoldsOtherFile(
            letterUpload.observedValue,
            letterFile.fileName,
          )
        ) {
          return {
            kind: "refused",
            reason:
              "The form did not keep the selected file. Nothing was recorded as attached.",
            observation: await config.hands.observe(),
          };
        }
        afterWrite(deps, questionPrompt(control));
        const letterStop = await guardStop(deps, observation.url);
        if (letterStop) {
          return { kind: "paused", pause: letterStop };
        }
        return {
          kind: "attached",
          attachment: {
            reviewText: {
              text: letter.letter.text,
              groundedIn: letter.letter.groundedIn,
            },
            documentId: letterFile.id,
            fileName: letterFile.fileName,
            label: letterFile.label,
            controlLabel: questionPrompt(control),
            at,
          },
          observation: await config.hands.observe(),
        };
      }

      let document = config.sources.documents.find(
        (candidate) => candidate.id === proposal.documentId,
      );
      if (!document) {
        return {
          kind: "refused",
          reason: `There is no file called ${proposal.documentId}. The ones available are listed in your instructions; if the form wants something else, finish and say what it asked for.`,
          observation,
        };
      }
      if (
        (control.questionKind === "portfolio" ||
          /\b(?:portfolio|work samples?)\b/iu.test(
            `${control.groupLabel} ${control.label}`,
          )) &&
        document.kind !== "portfolio" &&
        document.kind !== "work_sample"
      ) {
        return {
          kind: "refused",
          reason:
            "A portfolio upload needs the person's portfolio or work sample. Job Finder cannot create a substitute for it.",
          observation,
        };
      }
      const fileLabel = `${control.groupLabel} ${control.label}`;
      if (
        (/\btranscripts?\b/iu.test(fileLabel) &&
          document.kind !== "transcript") ||
        (/\bcertificates?\b/iu.test(fileLabel) &&
          document.kind !== "certificate")
      ) {
        return {
          kind: "refused",
          reason:
            "This upload needs the person's matching file. Job Finder cannot create a substitute for it.",
          observation,
        };
      }
      if (!acceptsDocument(control, document)) {
        // A plain-text copy of an Original Markdown resume preserves every
        // byte. Never ask the writer to rewrite the person's resume for format.
        const textCopy = {
          ...document,
          fileName: document.fileName.replace(/\.md$/iu, ".txt"),
          mimeType: "text/plain",
        };
        if (
          document.kind === "resume" &&
          /\.md$/iu.test(document.fileName) &&
          acceptsDocument(control, textCopy)
        ) {
          document = textCopy;
        } else {
          return {
            kind: "paused",
            pause: {
              code: "document_needs_you",
              summary: `The form does not accept ${document.fileName}. Attach a supported copy (${control.acceptedTypes?.join(", ")}).`,
              question: buildPendingQuestion({
                control,
                jobId: config.application.jobId,
                detectedAt: at,
                suggestion: null,
                reason:
                  "The selected file format is not accepted by this form.",
              }),
              blocker: null,
            },
          };
        }
      }
      const bytes = await document.loadBytes();
      if (bytes.byteLength === 0) {
        return {
          kind: "refused",
          reason: `${document.label} came back empty, so nothing was attached.`,
          observation,
        };
      }
      const write = await writeUnderGuard(deps, {
        declaredValue: document.fileName,
        write: () =>
          config.hands.uploadFile(control.ref, {
            name: document.fileName,
            mimeType: document.mimeType,
            bytes,
          }),
      });
      if (!write.ok) {
        return { kind: "refused", reason: write.error, observation };
      }
      if (fileFieldHoldsOtherFile(write.observedValue, document.fileName)) {
        return {
          kind: "refused",
          reason:
            "The form did not keep the selected file. Nothing was recorded as attached.",
          observation: await config.hands.observe(),
        };
      }
      afterWrite(deps, questionPrompt(control));
      const stop = await guardStop(deps, observation.url);
      if (stop) {
        return { kind: "paused", pause: stop };
      }
      return {
        kind: "attached",
        attachment: {
          ...(document.reviewText ? { reviewText: document.reviewText } : {}),
          documentId: document.id,
          fileName: document.fileName,
          label: document.label,
          controlLabel: questionPrompt(control),
          at,
        },
        observation: await config.hands.observe(),
      };
    }

    case "submit_application": {
      const preflight = runSubmitPreflight({
        observation,
        proposedActionRef: proposal.ref,
        authority: config.authority,
      });
      if (!preflight.ok) {
        return { kind: "refused", reason: preflight.reason, observation };
      }
      const action = observation.actions.find(
        (candidate) => candidate.ref === proposal.ref,
      );
      // Nothing is pressed here. Sending an application is one irreversible
      // act that has to be recorded as it happens, so it belongs to the
      // submission path rather than to this loop.
      return {
        kind: "ready_to_send",
        finalActionRef: proposal.ref,
        finalActionLabel: action?.label ?? "Submit application",
        observation,
      };
    }

    default: {
      const exhaustive: never = proposal;
      return {
        kind: "refused",
        reason: `Unsupported step: ${JSON.stringify(exhaustive)}`,
        observation,
      };
    }
  }
}

/** Only the person's explicit decision on this application's letter bypasses writing. */
export function approvedApplicationLetter(
  config: ApplyAgentConfig,
  control: ApplyFormControl,
): string | undefined {
  if (config.sources.approvedLetterText !== undefined) {
    return config.sources.approvedLetterText;
  }
  const saved = savedAnswerForQuestion(control, config.sources.reusableAnswers);
  return saved?.id.startsWith("application_") &&
    isAnswerFromThisApplication(
      saved,
      config.application,
      config.sources.posting.location,
    )
    ? saved.answer
    : undefined;
}

type LetterOutcome =
  | {
      kind: "ok";
      letter: {
        text: string;
        document: ApplyDocument | null;
        groundedIn: string[];
      };
    }
  | { kind: "stop"; outcome: ApplyExecutionOutcome };

/**
 * Gets the one letter for this application.
 *
 * Written once and handed back unchanged after that, so a form that asks for a
 * file and a form that asks for a box never end up with two different letters.
 */
async function provideApplicationLetter(
  deps: ApplyExecutorDeps,
  control: ApplyFormControl,
): Promise<LetterOutcome> {
  const { config } = deps;
  const letters = config.letters;
  const approvedText = approvedApplicationLetter(config, control);
  const observation = await config.hands.observe();
  if (
    !approvedText &&
    ownWordsAppliesToQuestion(
      formWritingInstructions(observation),
      questionPrompt(control),
    )
  ) {
    return {
      kind: "stop",
      outcome: leaveUnansweredForPerson({
        control,
        observation,
        config,
        at: deps.now().toISOString(),
        reason: OWN_WORDS_REASON,
        suggestion: null,
      }),
    };
  }
  if (!letters && approvedText && control.kind !== "file") {
    return {
      kind: "ok",
      letter: {
        text: approvedText,
        document: null,
        groundedIn: ["your letter for this application"],
      },
    };
  }
  if (!letters) {
    return {
      kind: "stop",
      outcome: {
        kind: "refused",
        reason: "Job Finder has no letter for this application.",
        observation: await config.hands.observe(),
      },
    };
  }

  const request = applicationLetterRequest(config, control);
  const produced = await letters.provide(request);

  const pauseWith = (summary: string): LetterOutcome => ({
    kind: "stop",
    outcome: {
      kind: "paused",
      pause: {
        code: "document_needs_you",
        summary,
        ...(!produced.ok && produced.draftText
          ? {
              reviewDraft: {
                text: produced.draftText,
                reason: produced.reason,
                groundedIn: request.groundedIn,
              },
            }
          : {}),
        question: buildPendingQuestion({
          control,
          jobId: config.application.jobId,
          detectedAt: deps.now().toISOString(),
          suggestion: null,
          reason: summary,
        }),
        blocker: null,
      },
    },
  });

  if (!produced.ok) {
    return pauseWith(
      `Job Finder could not write the letter this form asks for. ${produced.reason}`,
    );
  }
  // A letter with a gap in it must never go out; the person is asked instead.
  if (!approvedText && !looksLikeUsableLetter(produced.text)) {
    return pauseWith(
      "The letter Job Finder wrote for this application did not come out usable, so nothing was attached. Write or attach one here and it will be used.",
    );
  }

  return {
    kind: "ok",
    letter: {
      text: produced.text,
      document: produced.document,
      groundedIn: approvedText
        ? ["your letter for this application"]
        : request.groundedIn,
    },
  };
}

/** The same local draft request is used while filling and at the guarded write. */
export function applicationLetterRequest(
  config: ApplyAgentConfig,
  control: ApplyFormControl,
): Parameters<NonNullable<ApplyAgentConfig["letters"]>["provide"]>[0] {
  const approvedText = approvedApplicationLetter(config, control);
  return {
    ...buildCoverLetterRequest({
      sources: config.sources,
      preference: config.letters!.preference,
    }),
    purpose: "cover_letter",
    formControl: { ref: control.ref, question: questionPrompt(control) },
    delivery: coverLetterDeliveryFor(control),
    fileType: requiredLetterFileType(control),
    ...(approvedText ? { approvedText } : {}),
  };
}

function describeRef(observation: ApplyFormObservation, ref: string): string {
  const action = observation.actions.find((entry) => entry.ref === ref);
  if (action?.label) return `"${action.label}"`;
  const link = observation.links.find((entry) => entry.ref === ref);
  if (link?.label) return `"${link.label}"`;
  const clickable = observation.clickables.find((entry) => entry.ref === ref);
  if (clickable?.label) return `"${clickable.label}"`;
  return ref;
}
