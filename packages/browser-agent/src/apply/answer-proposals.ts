import { matchOption } from "./option-match";
import type { ApplyFormControl, ApplyProposal } from "./types";

/** Bind an answer to the actual option handles; never type into a choice group. */
export function answerProposals(
  control: ApplyFormControl,
  value: string,
  controls: readonly ApplyFormControl[],
  storedFactId: string,
): ApplyProposal[] {
  if (
    control.credentialRole ||
    control.kind === "file" ||
    control.kind === "other"
  )
    return [];
  if (
    control.kind === "radio" ||
    control.answerControlType === "multi_choice"
  ) {
    let values = [value];
    if (control.answerControlType === "multi_choice") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (
          !Array.isArray(parsed) ||
          !parsed.every((entry) => typeof entry === "string")
        )
          return [];
        values = parsed;
      } catch {
        return [];
      }
    }
    const group = controls.filter(
      (entry) =>
        entry.kind === control.kind &&
        entry.choiceGroupKey === control.choiceGroupKey,
    );
    const options = group.map((entry) => entry.label || entry.value);
    const selected = values.map((entry) => matchOption(options, entry));
    if (selected.some((entry) => entry === null)) return [];
    return group
      .filter((entry) => selected.includes(entry.label || entry.value))
      .map((entry) => ({
        tool: "set_checkbox",
        ref: entry.ref,
        checked: true,
        storedFactId,
      }));
  }
  if (control.kind === "checkbox") {
    if (!/^(?:yes|no|true|false)$/iu.test(value.trim())) return [];
    return [
      {
        tool: "set_checkbox",
        ref: control.ref,
        checked: /^(?:yes|true)$/iu.test(value.trim()),
        storedFactId,
      },
    ];
  }
  if (control.kind === "select" || control.kind === "combobox")
    return [{ tool: "select", ref: control.ref, option: value, storedFactId }];
  return [{ tool: "type", ref: control.ref, text: value, storedFactId }];
}
