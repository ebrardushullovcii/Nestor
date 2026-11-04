import type { ApplyFormObservation } from "./types";

/** A visible field on this step still needs an answer, or a password. */
function stepHasOpenField(page: ApplyFormObservation): boolean {
  return page.controls.some(
    (control) =>
      (control.visible || control.kind === "file") &&
      !control.disabled &&
      (control.invalid ||
        (control.required && !control.answered) ||
        control.credentialRole === "password"),
  );
}

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
    stepHasOpenField(page)
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

/** Wording a non-final step control never carries, whatever its kind says. */
const FINAL_WORDING = /\b(?:submit|send|finish|complete|apply)\b/iu;
/** A review or summary screen is the last one before the send. */
const REVIEW_SCREEN = /\b(?:review|summary)\b/iu;

function originOf(url: string | null): string | null {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
}

/**
 * A numbered, non-final step whose advance may save the step through the
 * site's own requests (Workday-style Save and Continue). The page's own
 * counter is the evidence that more steps remain; the label proves nothing.
 * The press runs inside the per-action intermediate-write window, so the
 * final-action deny still covers every request it makes. A last step, a
 * review screen or a page with a visible send control is never advanced here.
 */
export function numberedStepPreflight(page: ApplyFormObservation, ref: string) {
  const action = page.actions.find((item) => item.ref === ref);
  const { index, total } = page.step;
  if (
    !page.url ||
    !originOf(page.url) ||
    page.loading ||
    page.blocker ||
    !action ||
    action.kind !== "advance" ||
    !action.visible ||
    action.disabled ||
    // A native submit is refused by the guard; it cannot save this step.
    action.submitsForm === true ||
    FINAL_WORDING.test(action.label) ||
    index === null ||
    total === null ||
    index < 1 ||
    total <= index ||
    total > 99 ||
    REVIEW_SCREEN.test(page.step.label ?? "") ||
    page.headings.some(
      (heading) => heading.level <= 2 && REVIEW_SCREEN.test(heading.text),
    ) ||
    page.actions.some((item) => item.kind === "final" && item.visible) ||
    page.validationErrors.length ||
    stepHasOpenField(page)
  )
    return null;
  return {
    ref: action.ref,
    label: action.label,
    url: page.url,
    stepLabel: page.step.label,
    frame: action.frame ?? null,
    index,
    total,
  };
}

/** After one server-backed press: exactly the next step of the same wizard. */
export function numberedStepAdvanced(
  before: ApplyFormObservation,
  after: ApplyFormObservation,
): boolean {
  return (
    !!originOf(before.url) &&
    originOf(before.url) === originOf(after.url) &&
    before.step.index !== null &&
    before.step.total !== null &&
    after.step.index === before.step.index + 1 &&
    after.step.total === before.step.total &&
    !after.loading &&
    !after.blocker?.requiresPerson &&
    before.signature !== after.signature
  );
}

/**
 * The receipt of one step press whose result the page did not confirm. It is
 * also the key that stops any later press of that same step, in this run or a
 * continued one: host and path only, never a query.
 */
export function unconfirmedStepText(
  page: ApplyFormObservation,
  label: string,
): string | null {
  const { index, total } = page.step;
  if (index === null || total === null || !page.url) return null;
  let where: string;
  try {
    const url = new URL(page.url);
    where = `${url.host}${url.pathname}`;
  } catch {
    return null;
  }
  return `Pressed “${label.trim().slice(0, 120)}” once on step ${index} of ${total} at ${where}. The form did not show step ${index + 1} of ${total} afterwards, so Nestor will not press it again.`;
}

export const UNCONFIRMED_STEP_LABEL = "Step press not confirmed";
