import {
  cleanFormQuestionPrompt,
  normalizeFormQuestionPrompt,
} from "@nestor/contracts";
import { normalizeSignal } from "./control-classification";
import type { ApplyFormControl } from "./types";

/** The field's own label, for binding a short review card to a live control.
 * Permission and saved-answer checks must use questionPrompt's full context. */
export function questionLabel(control: ApplyFormControl): string {
  if (control.repeatedQuestion) return control.repeatedQuestion.prompt;
  const label = control.label.trim();
  const group =
    control.attestationKind === null &&
    (control.kind === "radio" || control.answerControlType === "multi_choice")
      ? (
          control.sectionPath?.at(-1) ??
          control.groupLabel.split(" — ").at(-1) ??
          ""
        ).trim()
      : control.groupLabel.trim();
  // File tasks name the input, without its fieldset legend or required marker.
  if (control.kind === "file") {
    return label.replace(/[\s*:]+$/u, "").replace(/\s+upload$/iu, "") || "file";
  }
  const normalizedLabel = normalizeSignal(label);
  const normalizedGroup = normalizeSignal(group);
  if (
    (control.kind === "radio" ||
      (control.kind === "checkbox" &&
        control.answerControlType === "multi_choice")) &&
    group.length > 0
  )
    return control.attestationKind !== null
      ? cleanFormQuestionPrompt(group) || group
      : group;
  const groupAddsSomething =
    normalizedGroup.length > 0 &&
    normalizedLabel.length > 0 &&
    !normalizedLabel.includes(normalizedGroup) &&
    !normalizedGroup.includes(normalizedLabel);
  const prompt = groupAddsSomething ? `${group} — ${label}` : label || group;
  const described =
    prompt ||
    control.placeholder.trim() ||
    "A question on the application form";
  // A declaration's section can change what "I agree" means. Keep that
  // context for both its saved answer and the model's permission check.
  return control.attestationKind !== null
    ? cleanFormQuestionPrompt(described) || described
    : described;
}

/** One whole question for asking, remembering, matching and checking. A hint
 * or outer section can change its conditions even when its label is unchanged. */
export function questionPrompt(control: ApplyFormControl): string {
  const base = questionLabel(control);
  if (control.kind === "file" || control.repeatedQuestion) return base;
  const normalize = normalizeFormQuestionPrompt;
  const context = (control.sectionPath ?? []).filter(
    (part) => part.trim() && !normalize(base).includes(normalize(part)),
  );
  const parts = [...context, base];
  const hint = control.hint?.trim();
  if (hint && !normalize(parts.join(" ")).includes(normalize(hint)))
    parts.push(hint);
  return parts.join(" — ");
}
