import type { ApplyFormObservation } from "./types";

/** A visible field on this step still needs an answer, or a password. */
function stepHasOpenField(page: ApplyFormObservation): boolean {
  return page.controls.some(
    (control) =>
      (control.visible || control.kind === "file") &&
      !control.disabled &&
      (control.answerUnverified ||
        control.invalid ||
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

/** Returning to correct an earlier answer must also work with open/invalid fields. */
export function localBackPreflight(page: ApplyFormObservation, ref: string) {
  const action = page.actions.find((item) => item.ref === ref);
  if (
    !page.url ||
    page.loading ||
    page.blocker?.requiresPerson ||
    !action ||
    action.kind !== "back" ||
    !action.visible ||
    action.disabled ||
    action.submitsForm !== false ||
    (page.step.index !== null && page.step.index <= 1)
  )
    return null;
  return {
    ref: action.ref,
    label: action.label,
    url: page.url,
    stepLabel: page.step.label,
    frame: action.frame ?? null,
  };
}

export function localStepWentBack(
  before: ApplyFormObservation,
  after: ApplyFormObservation,
): boolean {
  if (
    before.url !== after.url ||
    after.loading ||
    after.blocker?.requiresPerson
  )
    return false;
  if (before.step.index !== null && after.step.index !== null)
    return (
      after.step.index === before.step.index - 1 &&
      after.step.total === before.step.total &&
      before.signature !== after.signature
    );
  const section = (page: ApplyFormObservation) =>
    JSON.stringify([
      page.step.label,
      page.headings,
      page.controls
        .filter((control) => control.visible)
        .map((control) => [
          control.kind,
          control.label,
          control.groupLabel,
          control.sectionPath,
          control.options,
        ]),
    ]);
  return section(before) !== section(after);
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
 * An ordinary non-final advance may save through the site's own requests.
 * A complete progress counter is useful evidence, not a prerequisite. The
 * observed advance and request guard keep final submission separate.
 * The press runs inside the per-action intermediate-write window, so the
 * final-action deny still covers every request it makes. A last step, a
 * review screen or a page with a visible send control is never advanced here.
 */
export function numberedStepPreflight(page: ApplyFormObservation, ref: string) {
  const action = page.actions.find((item) => item.ref === ref);
  const { index, total } = page.step;
  const nativeForm =
    action?.submitsForm === true &&
    action.inForm === true &&
    action.formMethod?.toUpperCase() === "POST" &&
    action.formAction &&
    originOf(action.formAction) === originOf(page.url)
      ? { action: action.formAction, method: "POST" as const }
      : null;
  if (
    !page.url ||
    !originOf(page.url) ||
    page.loading ||
    page.blocker ||
    !action ||
    action.kind !== "advance" ||
    !action.visible ||
    action.disabled ||
    (action.submitsForm === true && !nativeForm) ||
    FINAL_WORDING.test(action.label) ||
    (index !== null &&
      total !== null &&
      (index < 1 || total <= index || total > 99)) ||
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
    ...(nativeForm ? { nativeForm } : {}),
  };
}

/** After one server-backed press: exactly the next step of the same wizard. */
export function numberedStepAdvanced(
  before: ApplyFormObservation,
  after: ApplyFormObservation,
): boolean {
  if (
    !originOf(before.url) ||
    originOf(before.url) !== originOf(after.url) ||
    after.loading ||
    after.blocker ||
    after.validationErrors.length
  )
    return false;
  if (before.step.index !== null && after.step.index !== null) {
    return (
      after.step.index === before.step.index + 1 &&
      after.step.total === before.step.total &&
      before.signature !== after.signature
    );
  }
  // URL, entered values and loading text alone do not prove a new section.
  // Observe changed section identity or new questions after the bounded press.
  const section = (page: ApplyFormObservation) =>
    JSON.stringify([
      page.step.label,
      page.headings.map((heading) => [heading.level, heading.text]),
    ]);
  const questions = (page: ApplyFormObservation) =>
    JSON.stringify(
      page.controls
        .filter((control) => control.visible)
        .map((control) => [
          control.kind,
          control.label,
          control.groupLabel,
          control.sectionPath,
          control.hint,
          control.options,
          control.frame,
        ]),
    );
  return (
    after.controls.some((control) => control.visible) &&
    (section(before) !== section(after) ||
      questions(before) !== questions(after))
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
  if (!page.url) return null;
  let where: string;
  try {
    const url = new URL(page.url);
    where = `${url.host}${url.pathname}`;
  } catch {
    return null;
  }
  const numbered = index !== null && total !== null;
  const stage = numbered
    ? `step ${index} of ${total}`
    : page.step.label?.trim()
      ? `“${page.step.label.trim().slice(0, 120)}”`
      : "this form";
  const expected = numbered
    ? `step ${index + 1} of ${total}`
    : "a new application section";
  return `Pressed “${label.trim().slice(0, 120)}” once on ${stage} at ${where}. The form did not show ${expected} afterwards, so Nestor will not press it again.`;
}

export const UNCONFIRMED_STEP_LABEL = "Step press not confirmed";
