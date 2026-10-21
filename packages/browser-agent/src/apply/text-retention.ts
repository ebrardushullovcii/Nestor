import type { ApplyFormControl, ApplyFormObservation } from "./types";

export const TEXT_RETENTION_MS = 300;
export const CLEARED_TEXT_ERROR =
  "The field cleared the answer instead of keeping it. Leave it for the person or try a different control once.";

/** Refs alone are not identities: a rerender can assign one to another field. */
export function textRetentionError(
  before: ApplyFormObservation,
  after: ApplyFormObservation,
  control: ApplyFormControl,
  value: string,
): string | null {
  const current = after.controls.find((entry) => entry.ref === control.ref);
  if (
    before.url !== after.url ||
    JSON.stringify(before.step) !== JSON.stringify(after.step) ||
    !current ||
    current.kind !== control.kind ||
    current.label !== control.label ||
    current.groupLabel !== control.groupLabel
  ) {
    return "The field changed before its answer could be checked. Read the current page before trying again.";
  }
  return value.trim().length > 0 && current.value.trim().length === 0
    ? CLEARED_TEXT_ERROR
    : null;
}
