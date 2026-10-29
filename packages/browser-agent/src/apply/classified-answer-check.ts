import type { ApplicationAttestationKind } from "@nestor/contracts";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import { questionPrompt } from "./policy-executor";
import { phoneCountryPicker } from "./phone-answer";
import { fieldNamesAnotherPerson } from "./github-username";
import type { LLMClient } from "../agent/contracts";
import type {
  ApplyAgentConfig,
  ApplyAnswerSources,
  ApplyFormControl,
} from "./types";
import {
  answerSourceCatalog,
  classifyAnswerPermission,
  type ClassifiedAnswerDecision,
} from "./answer-source-catalog";
import {
  createQuestionClassifier,
  questionClassificationKey,
} from "./question-classification";
import {
  checkWrittenApplicationAnswers,
  type WrittenAnswerCheck,
} from "./written-answer-grounding";

/** Re-ground current sources at send time; old card provenance grants nothing. */
export async function checkClassifiedApplicationAnswers(input: {
  client: LLMClient;
  sources: ApplyAnswerSources;
  payDisclosed: boolean;
  application?: ApplyAgentConfig["application"];
  approvedAttestations?: readonly ApplicationAttestationKind[];
  answers: readonly { question: string; answer: string }[];
  formContext: {
    pageText: string;
    fields: readonly { question: string; value: string }[];
  };
  signal?: AbortSignal;
  formControls?: readonly ApplyFormControl[];
  /** Same AI-client scope as preparation; only identical complete readings are reused. */
  questionReadCacheScope?: object;
}): Promise<WrittenAnswerCheck[]> {
  // Earlier wizard steps can remain in the DOM while hidden. Their actual
  // controls and ancestry still bind the answer; an old card alone cannot.
  const formControls = input.formControls?.map((control) => {
    const hasVisibleTwin = input.formControls?.some(
      (other) =>
        other.visible && questionPrompt(other) === questionPrompt(control),
    );
    return !control.visible && !hasVisibleTwin
      // Wizard fieldsets are often disabled off-screen. This is a read-only
      // grounding view, not permission to write into those controls.
      ? { ...control, visible: true, disabled: false }
      : control;
  });
  const controls: ApplyFormControl[] = input.answers.map((answer, index) => {
    const asked = normalizeFormQuestionPrompt(answer.question);
    const matches = formControls?.filter((control) => {
      const prompt = normalizeFormQuestionPrompt(questionPrompt(control));
      return (
        control.visible &&
        (prompt === asked ||
          (control.groupLabel.trim().length > 0 &&
            asked.endsWith(` ${prompt}`) &&
            !fieldNamesAnotherPerson({
              ...control,
              groupLabel: answer.question,
            })))
      );
    });
    const exact = matches?.filter(
      (control) =>
        normalizeFormQuestionPrompt(questionPrompt(control)) === asked,
    );
    const current = exact?.length ? exact : matches;
    if (current?.length === 1 && current[0]) return current[0];
    const numbers = current?.filter(
      (control) => control.telInput && phoneCountryPicker(control, current),
    );
    if (numbers?.length === 1 && numbers[0]) return numbers[0];
    // A choice is asked by several fields (a Yes/No pair, radio options,
    // and sometimes a hidden box behind them): the answer is the option the
    // page shows chosen, which is what preparation checked.
    const said = answer.answer.trim().toLowerCase();
    const chosen = current?.find(
      (control) =>
        control.visible &&
        (control.kind === "radio" || control.kind === "checkbox") &&
        control.checked &&
        (control.label || control.value).trim().toLowerCase() === said,
    );
    if (chosen) return chosen;
    const parts = answer.question.split(/\s+—\s+/u);
    return {
      ref: `preflight${index}`,
      kind: "text",
      label: parts.at(-1)!,
      groupLabel: parts.slice(0, -1).join(" — "),
      placeholder: "",
      required: true,
      disabled: false,
      readOnly: false,
      visible: true,
      value: answer.answer,
      checked: false,
      options: [],
      selectedOptionLabel: "",
      invalid: false,
      validationMessage: "",
      questionKind: "other",
      answerControlType: "text",
      attestationKind: null,
      answered: true,
    };
  });
  if (!controls.length) return [];
  // Classify the same full form and native metadata as preparation. Removing
  // optional fields or required flags both changes the question's context and
  // needlessly asks the model to reinterpret an already-read literal.
  const contextControls = [...(formControls ?? [])];
  for (const control of controls)
    if (
      !contextControls.some(
        (current) => questionPrompt(current) === questionPrompt(control),
      )
    )
      contextControls.push(control);
  const catalog = answerSourceCatalog(input.sources);
  const classify = createQuestionClassifier({
    client: input.client,
    signal: input.signal,
    cacheScope: input.questionReadCacheScope,
    sources: () => catalog,
  });
  const readings = await classify(
    contextControls,
    JSON.stringify({
      instructions: input.formContext.pageText,
    }),
  );
  const decisions = input.answers.map(
    (answer, index): ClassifiedAnswerDecision => {
      const control = controls[index];
      // A fallback label parsed from an old card is not evidence that this
      // exact applicant field still exists on the live form (for example,
      // Name may now belong to a reference section).
      if (!control || (formControls && !formControls.includes(control)))
        return {
          kind: "needs_you",
          reason: "The question is no longer present.",
        };
      const reading =
        readings.get(questionClassificationKey(control, contextControls)) ??
        readings.get(answer.question);
      return classifyAnswerPermission({
        control: {
          ...control,
          attestationKind: reading?.declarationKind ?? control.attestationKind,
          questionKind: reading?.asksAboutPay
            ? "salary_expectation"
            : (reading?.eligibilityKind ?? control.questionKind),
          asksCurrentPay:
            reading?.asksCurrentPay ?? control.asksCurrentPay ?? false,
          asksHiringCountry:
            reading?.asksHiringCountry ?? control.asksHiringCountry ?? false,
        },
        controls: contextControls,
        tags: reading?.answerTags,
        approvedAttestations: input.approvedAttestations ?? [],
        sources: input.sources,
        ...(input.application ? { application: input.application } : {}),
        answer: answer.answer,
        pageInstructions: input.formContext.pageText,
      });
    },
  );
  const writing = input.answers.flatMap((answer, index) => {
    const decision = decisions[index];
    return decision?.kind === "writing" || decision?.kind === "inference"
      ? [
          {
            ...answer,
            ...(decision.evidencePolicy
              ? { evidencePolicy: decision.evidencePolicy }
              : {}),
          },
        ]
      : [];
  });
  const checks = writing.length
    ? await checkWrittenApplicationAnswers({
        ...input,
        answers: writing,
      }).catch(() =>
        writing.map(() => ({
          supported: false,
          reason: "This answer could not be checked against your sources.",
        })),
      )
    : [];
  let writtenIndex = 0;
  return decisions.map((decision) =>
    decision.kind === "literal"
      ? {
          supported: true,
          reason: "Unchanged matching saved answer or profile fact.",
        }
      : decision.kind === "needs_you"
        ? { supported: false, reason: decision.reason }
        : (checks[writtenIndex++] ?? {
            supported: false,
            reason: "The writing could not be verified.",
          }),
  );
}
