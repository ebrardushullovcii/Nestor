import type { ApplicationAttestationKind } from "@nestor/contracts";
import { questionPrompt } from "./policy-executor";
import type { LLMClient } from "../agent/contracts";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";
import {
  answerSourceCatalog,
  classifyAnswerPermission,
  type ClassifiedAnswerDecision,
} from "./answer-source-catalog";
import { classifyApplicationQuestions } from "./question-classification";
import {
  checkWrittenApplicationAnswers,
  type WrittenAnswerCheck,
} from "./written-answer-grounding";

/** Re-read the question's meaning and sources at send time; old card provenance grants nothing. */
export async function checkClassifiedApplicationAnswers(input: {
  client: LLMClient;
  sources: ApplyAnswerSources;
  payDisclosed: boolean;
  approvedAttestations?: readonly ApplicationAttestationKind[];
  answers: readonly { question: string; answer: string }[];
  formContext: {
    pageText: string;
    fields: readonly { question: string; value: string }[];
  };
  signal?: AbortSignal;
  formControls?: readonly ApplyFormControl[];
}): Promise<WrittenAnswerCheck[]> {
  const controls: ApplyFormControl[] = input.answers.map((answer, index) => {
    const current = input.formControls?.filter(
      (control) => questionPrompt(control) === answer.question,
    );
    if (current?.length === 1 && current[0]) return current[0];
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
  const readings = await classifyApplicationQuestions({
    client: input.client,
    signal: input.signal,
    questions: input.answers.map((answer, index) => ({
      prompt: answer.question,
      kind: controls[index]?.kind ?? "text",
      options: controls[index]?.options ?? [],
      hint: controls[index]?.hint ?? "",
      placeholder: controls[index]?.placeholder ?? "",
    })),
    pageInstructions: input.formContext.pageText,
    sources: answerSourceCatalog(input.sources),
  });
  const decisions = input.answers.map(
    (answer, index): ClassifiedAnswerDecision => {
      const control = controls[index];
      if (!control)
        return {
          kind: "needs_you",
          reason: "The question is no longer present.",
        };
      const reading = readings.get(answer.question);
      return classifyAnswerPermission({
        control: {
          ...control,
          attestationKind: reading?.declarationKind ?? control.attestationKind,
        },
        controls,
        tags: reading?.answerTags,
        approvedAttestations: input.approvedAttestations ?? [],
        sources: input.sources,
        answer: answer.answer,
        pageInstructions: input.formContext.pageText,
      });
    },
  );
  const writing = input.answers.filter(
    (_answer, index) => decisions[index]?.kind === "writing",
  );
  const checks = writing.length
    ? await checkWrittenApplicationAnswers({ ...input, answers: writing })
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
