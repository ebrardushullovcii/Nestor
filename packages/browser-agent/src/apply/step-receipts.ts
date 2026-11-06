import type {
  ApplyStepReceipt,
  ApplyStepReceiptField,
} from "@nestor/contracts";
import { reviewFieldKey } from "./form-replay";
import { questionPrompt } from "./policy-executor";
import type { ApplyFormControl, ApplyFormObservation } from "./types";

/**
 * The value a control shows, derived exactly as the review card derives it: a
 * multi-select as the JSON list of its checked labels, a single checkbox as
 * Yes, a radio by its label, anything else by its shown option or text.
 */
export function observedControlValue(
  control: ApplyFormControl,
  controls: readonly ApplyFormControl[],
): string {
  return control.kind === "checkbox"
    ? control.answerControlType === "multi_choice"
      ? // The exact options, as JSON: a label may contain a comma.
        JSON.stringify(
          controls
            .filter(
              (candidate) =>
                candidate.choiceGroupKey === control.choiceGroupKey &&
                candidate.checked,
            )
            .map((candidate) => candidate.label || candidate.value),
        )
      : "Yes"
    : control.kind === "radio"
      ? control.label || control.value
      : control.selectedOptionLabel || control.value;
}

/** Fields a receipt may hold: visible, enabled, answered, never a secret or a file. */
function receiptControls(observation: ApplyFormObservation) {
  const seen = new Set<string>();
  const out: { control: ApplyFormControl; fieldKey: string; value: string }[] =
    [];
  for (const control of observation.controls) {
    if (
      !control.visible ||
      control.disabled ||
      control.credentialRole ||
      control.kind === "file" ||
      !control.answered ||
      ((control.kind === "radio" || control.kind === "checkbox") &&
        !control.checked)
    )
      continue;
    const fieldKey = reviewFieldKey(observation, control);
    if (seen.has(fieldKey)) continue;
    const value = observedControlValue(control, observation.controls);
    if (!value.trim()) continue;
    seen.add(fieldKey);
    out.push({ control, fieldKey, value });
  }
  return out;
}

const fullText = (value: string | undefined) => value ?? "";

/**
 * Send evidence for one attempt: which fields Nestor wrote, the value each
 * field had the first time Nestor saw it, and a receipt for every step it
 * confirmed it advanced. Nothing here authorizes a write, a replay, a reclaim
 * or a continuation; a new attempt starts with an empty tracker.
 */
export function createStepReceiptTracker(
  resultId: string,
  acceptedMeaning?: (
    control: ApplyFormControl,
    value: string,
    observation: ApplyFormObservation,
  ) => ApplyStepReceiptField["acceptedMeaning"],
) {
  const firstSeen = new Map<string, string>();
  const written = new Set<string>();
  const receipts: ApplyStepReceipt[] = [];
  const provenance = (
    fieldKey: string,
    value: string,
  ): ApplyStepReceiptField["provenance"] =>
    written.has(fieldKey)
      ? "executor_write"
      : firstSeen.get(fieldKey) === value
        ? "site_unchanged"
        : "observed_unverified";
  const receipt = (
    kind: ApplyStepReceipt["kind"],
    observation: ApplyFormObservation,
    at: string,
  ): ApplyStepReceipt => {
    let url = "";
    let origin = "";
    try {
      const parsed = new URL(observation.url ?? "");
      url = `${parsed.origin}${parsed.pathname}`;
      origin = parsed.origin;
    } catch {
      /* A page without an address binds nothing. */
    }
    const fields =
      kind === "unconfirmed"
        ? []
        : receiptControls(observation).map(
            ({ control, fieldKey, value }): ApplyStepReceiptField => ({
              ...(acceptedMeaning?.(control, value, observation)
                ? {
                    acceptedMeaning: acceptedMeaning(
                      control,
                      value,
                      observation,
                    ),
                  }
                : {}),
              fieldKey,
              ...(control.frame ? { frame: control.frame } : {}),
              ...(control.inputConstraints
                ? { inputConstraints: control.inputConstraints }
                : {}),
              label: fullText(questionPrompt(control)),
              groupLabel: fullText(control.groupLabel),
              sectionPath: (control.sectionPath ?? []).map((part) =>
                fullText(part),
              ),
              hint: fullText(control.hint),
              placeholder: fullText(control.placeholder),
              kind: control.kind === "file" ? "other" : control.kind,
              answerControlType: control.answerControlType,
              choiceGroupKey: control.choiceGroupKey
                ? fullText(control.choiceGroupKey)
                : null,
              options: (control.choiceGroupKey &&
              ["radio", "checkbox"].includes(control.kind)
                ? observation.controls
                    .filter(
                      (entry) =>
                        entry.choiceGroupKey === control.choiceGroupKey,
                    )
                    .map((entry) => entry.label || entry.value)
                : control.options
              ).map((o) => fullText(o)),
              required: control.required,
              readOnly: control.readOnly,
              questionKind: control.questionKind,
              attestationKind: control.attestationKind,
              repeatedQuestion: control.repeatedQuestion
                ? {
                    prompt: fullText(control.repeatedQuestion.prompt),
                    step: fullText(control.repeatedQuestion.step),
                  }
                : null,
              telInput: control.telInput === true,
              urlInput: control.urlInput === true,
              nativeValue: fullText(control.value),
              value: fullText(value),
              provenance: provenance(fieldKey, value),
            }),
          );
    const frames = new Set(
      observation.controls
        .filter((control) => control.visible && control.frame)
        .map((control) => JSON.stringify(control.frame)),
    );
    const [frame] = frames;
    return {
      kind,
      resultId,
      url,
      origin,
      stepIndex: observation.step.index,
      stepTotal: observation.step.total,
      stepLabel: observation.step.label
        ? fullText(observation.step.label)
        : null,
      frame:
        frames.size === 1 && frame
          ? (JSON.parse(frame) as { origin: string; pathname: string })
          : null,
      instructions: fullText(observation.bodyTextExcerpt),
      fields,
      at,
    };
  };
  return {
    /** Every observation Nestor reads: the first value of each field counts. */
    observe(observation: ApplyFormObservation): void {
      for (const { fieldKey, value } of receiptControls(observation))
        if (!firstSeen.has(fieldKey)) firstSeen.set(fieldKey, value);
      // A field first seen empty starts as empty: a later site fill is not unchanged.
      for (const control of observation.controls) {
        if (!control.visible || control.disabled || control.kind === "file")
          continue;
        const fieldKey = reviewFieldKey(observation, control);
        if (!firstSeen.has(fieldKey)) firstSeen.set(fieldKey, "");
      }
    },
    /** Every write call, before it runs, including one the site then refuses. */
    wrote(observation: ApplyFormObservation | null, ref: string): void {
      const control = observation?.controls.find((entry) => entry.ref === ref);
      if (observation && control)
        written.add(reviewFieldKey(observation, control));
    },
    /** A step Nestor confirmed it advanced, from the exact pre-press page. */
    advance(prePress: ApplyFormObservation, at: string): void {
      receipts.push(receipt("advance", prePress, at));
    },
    /** A press whose result the page did not confirm: no earlier step binds. */
    unconfirmed(page: ApplyFormObservation, at: string): void {
      if (!receipts.some((entry) => entry.kind === "unconfirmed"))
        receipts.push(receipt("unconfirmed", page, at));
    },
    /** The run's last observation, for live final-step and single-page fields. */
    finish(page: ApplyFormObservation | null, at: string): ApplyStepReceipt[] {
      return page ? [...receipts, receipt("final", page, at)] : [...receipts];
    },
  };
}
export type StepReceiptTracker = ReturnType<typeof createStepReceiptTracker>;
