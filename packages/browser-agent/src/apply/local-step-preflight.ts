import type { ApplyFormObservation } from "./types";

/** Page evidence, not a Next label, establishes an unfinished local wizard. */
export function localStepPreflight(page: ApplyFormObservation, ref: string) {
  const action = page.actions.find((item) => item.ref === ref);
  const { index, total } = page.step;
  if (
    !page.url ||
    page.loading ||
    page.blocker?.requiresPerson ||
    !action ||
    action.kind !== "advance" ||
    !action.visible ||
    action.disabled ||
    action.inForm !== true ||
    action.submitsForm !== false ||
    index === null ||
    total === null ||
    index < 1 ||
    total <= index ||
    total > 99 ||
    page.validationErrors.length ||
    page.controls.some(
      (control) =>
        (control.visible || control.kind === "file") &&
        !control.disabled &&
        (control.invalid ||
          (control.required && !control.answered) ||
          control.credentialRole === "password" ||
          (control.credentialRole === "identifier" &&
            !(control.questionKind === "personal_info" && /e-?mail/iu.test(control.label)))),
    )
  )
    return null;
  return {
    ref: action.ref,
    label: action.label,
    url: page.url,
    stepLabel: page.step.label,
  };
}

export function localStepAdvanced(
  before: ApplyFormObservation,
  after: ApplyFormObservation,
): boolean {
  return (
    before.url === after.url &&
    before.step.index !== null &&
    after.step.index === before.step.index + 1 &&
    after.step.total === before.step.total &&
    !after.loading &&
    !after.blocker?.requiresPerson &&
    before.signature !== after.signature
  );
}
