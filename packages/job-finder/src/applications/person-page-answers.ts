import {
  buildApplyFormObservation,
  questionPrompt,
} from "@nestor/browser-agent";
import type { RawApplyPage, ApplicationRow } from "@nestor/contracts";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import type { ApplicationStore } from "@nestor/db/applications";
import { describeFormQuestion } from "./questions";

/** Native-attributed edits are local to this application, never reusable answers. */
export function rememberPersonPageAnswers(input: {
  page: RawApplyPage;
  application: Pick<ApplicationRow, "id" | "attempt">;
  job: { id: number; location: string };
  memory: ApplicationStore["needsYou"];
  earlierQuestions?: readonly { id: string; prompt: string }[];
}): number {
  const { page, application, job, memory } = input;
  if (!page.controls?.length) return 0;
  const observed = buildApplyFormObservation(page, new Date().toISOString());
  if (
    page.loading ||
    page.personAnswersBlocked ||
    observed.blocker?.requiresPerson ||
    page.controls.some(
      (control) =>
        control.inputType === "password" ||
        /\b(?:current-password|new-password|one-time-code|username)\b/iu.test(
          control.autocomplete,
        ) ||
        /^(?:password|confirm password|new password|current password|verification code|one.time code|otp)$/iu.test(
          control.label.trim(),
        ),
    )
  )
    return 0;
  let count = 0;
  for (const raw of page.controls) {
    const person = raw.personAnswer;
    if (
      !person ||
      person.pageUrl !== page.url ||
      person.value !== raw.value ||
      person.checked !== raw.checked ||
      person.shownValue !== (raw.selectedOptionLabel || raw.value) ||
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
      control.credentialRole === "password" ||
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
    if (
      memory.recordPersonAnswer(
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
      )
    )
      count++;
  }
  return count;
}
