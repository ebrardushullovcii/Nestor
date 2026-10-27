import { normalizeSignal } from "./control-classification";
import { questionPrompt } from "./policy-executor";
import {
  checkFormReadiness,
  holdsAnswer,
  type UploadEvidenceOptions,
} from "./submit-preflight";
import type { ApplyFormControl, ApplyFormObservation } from "./types";

/** A submit button that only says Apply, as on a one-form role page. */
const APPLY_LABEL =
  /^apply(?: (?:for|to) (?:this|the) (?:role|job|position|opening|opportunity))?$/u;

/**
 * The send of a form whose only button says "Apply" (Askable's role form:
 * Name, Email, Phone and a consent box; its handler posts them with fetch).
 *
 * Submitting a form is not sending an application: a search filter, cookie
 * preferences or a listing's Apply that opens the employer's form submit
 * forms too. So that button is the send only when its own form is this
 * application's: it holds the person's answers (their identity fields, or
 * fields this run wrote), it has no other submit button, and with that
 * button as its send the form reads ready. Anything else stays an ordinary
 * button. Returns the observation with that one button marked final.
 */
export function withApplyFormSend(
  observation: ApplyFormObservation,
  input: {
    wrote: (control: ApplyFormControl) => boolean;
    uploads?: UploadEvidenceOptions;
  },
): ApplyFormObservation {
  if (observation.actions.some((action) => action.kind === "final"))
    return observation;
  for (const candidate of observation.actions) {
    const form = candidate.formKey;
    if (
      !form ||
      !candidate.submitsForm ||
      !candidate.visible ||
      candidate.disabled ||
      !APPLY_LABEL.test(normalizeSignal(candidate.label)) ||
      observation.actions.some(
        (other) =>
          other !== candidate && other.formKey === form && other.submitsForm,
      )
    )
      continue;
    const answers = observation.controls.filter(
      (control) =>
        control.formKey === form &&
        control.visible &&
        holdsAnswer(control) &&
        (control.questionKind === "personal_info" || input.wrote(control)),
    );
    if (!answers.length) continue;
    const promoted: ApplyFormObservation = {
      ...observation,
      actions: observation.actions.map((action) =>
        action === candidate ? { ...action, kind: "final" } : action,
      ),
    };
    if (checkFormReadiness(promoted, input.uploads).ok) return promoted;
  }
  return observation;
}

/** Whether a field was written by this run: by its question, as recorded. */
export function wroteField(
  written: ReadonlyArray<{ label: string }>,
): (control: ApplyFormControl) => boolean {
  const labels = new Set(written.map((entry) => entry.label));
  return (control) => labels.has(questionPrompt(control));
}
