import {
  buildApplyFormObservation,
  questionPrompt,
} from "@nestor/browser-agent";
import type {
  RawApplyPage,
  ApplicationRow,
  CandidateAnswerKind,
} from "@nestor/contracts";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import type { ApplicationStore } from "@nestor/db/applications";
import { describeFormQuestion } from "./questions";

/** Only native-attributed field edits become saved verbatim sources, never mere page values. */
export function rememberPersonPageAnswers(input: {
  page: RawApplyPage;
  application: Pick<ApplicationRow, "id" | "attempt">;
  job: { id: number; location: string };
  memory: ApplicationStore["needsYou"];
  earlierQuestions?: readonly { id: string; prompt: string }[];
}): number {
  const { page, application, job, memory } = input;
  const observed = buildApplyFormObservation(page, new Date().toISOString());
  if (page.loading || observed.blocker?.requiresPerson) return 0;
  let count = 0;
  for (const raw of page.controls) {
    const person = raw.personAnswer;
    if (
      !person ||
      person.pageUrl !== page.url ||
      person.value !== raw.value ||
      person.checked !== raw.checked ||
      /password|one-time-code/iu.test(raw.autocomplete)
    )
      continue;
    const control = observed.controls.find(
      (control) => control.ref === (raw.ref ?? `c${raw.index}`),
    );
    if (
      !control ||
      !control.visible ||
      control.invalid ||
      control.kind === "file" ||
      control.credentialRole ||
      control.answerControlType === "multi_choice" ||
      (control.kind === "radio" && !control.checked)
    )
      continue;
    const prompt = questionPrompt(control);
    const targets = observed.controls.filter(
      (field) =>
        field.visible &&
        normalizeFormQuestionPrompt(questionPrompt(field)) ===
          normalizeFormQuestionPrompt(prompt),
    );
    if (
      new Set(targets.map((field) => field.choiceGroupKey ?? field.ref))
        .size !== 1
    )
      continue;
    const answer =
      control.kind === "checkbox"
        ? control.checked
          ? "Yes"
          : "No"
        : control.kind === "radio"
          ? control.label || control.value
          : control.selectedOptionLabel || control.value;
    if (!answer.trim()) continue;
    const question = {
      prompt,
      kind: control.questionKind,
      answerControlType: control.answerControlType,
      answerOptions: control.options,
    };
    const known = describeFormQuestion(question, job);
    const previous =
      input.earlierQuestions?.filter(
        (question) =>
          normalizeFormQuestionPrompt(question.prompt) ===
          normalizeFormQuestionPrompt(prompt),
      ) ?? [];
    if (previous.length > 1) continue;
    const kind: CandidateAnswerKind = [
      "availability",
      "notice_period",
      "salary_expectation",
      "work_authorization",
      "visa_sponsorship",
      "relocation",
      "travel",
      "self_intro",
      "career_transition",
    ].includes(control.questionKind)
      ? (control.questionKind as CandidateAnswerKind)
      : "other";
    if (
      memory.rememberPersonAnswer(
        {
          ...known,
          applicationId: application.id,
          attempt: application.attempt,
          fieldKey: previous[0]?.id ?? known.key,
          kind: "question",
          scope: {},
          prompt,
        },
        answer,
        kind,
      )
    )
      count++;
  }
  return count;
}
