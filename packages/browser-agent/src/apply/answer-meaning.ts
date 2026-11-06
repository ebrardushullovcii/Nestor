import type { ApplyStepReceiptField } from "@nestor/contracts";
import { createHash } from "node:crypto";
import { isAnswerFromThisApplication } from "./application-facts";
import { questionPrompt } from "./question-text";
import type {
  ApplyAgentConfig,
  ApplyAnswerSources,
  ApplyFormControl,
} from "./types";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const meaningHash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

/** No DOM ref or current value: those change during a verified write. */
export function meaningTargetHash(
  control: ApplyFormControl,
  controls: readonly ApplyFormControl[] = [],
): string {
  return meaningHash({
    question: questionPrompt(control).replace(
      /\s*\(repeated question on [^)]*\)\s*$/u,
      "",
    ),
    kind: control.kind,
    answerControlType: control.answerControlType,
    options:
      control.choiceGroupKey &&
      ["radio", "checkbox"].includes(control.kind) &&
      controls.length
        ? controls
            .filter((entry) => entry.choiceGroupKey === control.choiceGroupKey)
            .map((entry) => entry.label || entry.value)
        : control.options,
    hint: control.hint ?? "",
    placeholder: control.placeholder,
    sectionPath: control.sectionPath ?? [],
    groupLabel: control.groupLabel,
    frame: control.frame ?? null,
    scopeKey: control.scopeKey ?? null,
    rowScopeKey: control.rowScopeKey ?? null,
    constraints: control.inputConstraints ?? null,
    telInput: control.telInput === true,
    urlInput: control.urlInput === true,
  });
}
export type AcceptedAnswerMeaning = NonNullable<
  ApplyStepReceiptField["acceptedMeaning"]
>;

/** The person's decision on this exact current field, before semantic reuse. */
export function currentApplicationAnswer(input: {
  control: ApplyFormControl;
  controls: readonly ApplyFormControl[];
  sources: ApplyAnswerSources;
  application?: ApplyAgentConfig["application"];
  pageUrl?: string | null | undefined;
  pageInstructions: string;
}) {
  if (!input.application || input.control.credentialRole) return null;
  const target = meaningTargetHash(input.control, input.controls);
  const groups = new Set(
    input.controls
      .filter(
        (control) =>
          control.visible &&
          !control.disabled &&
          meaningTargetHash(control, input.controls) === target,
      )
      .map((control) => control.choiceGroupKey || control.ref),
  );
  if (groups.size !== 1) return null;
  // Native identity already binds the WHOLE question, conditions and options.
  // A semantic/units matcher must not veto the person's exact current decision.
  const matches = input.sources.reusableAnswers.filter((saved) => {
    const scope = saved.applicationScope;
    const binding = scope?.currentFieldBinding;
    return (
      !saved.needsConfirmation &&
      scope &&
      binding &&
      isAnswerFromThisApplication(
        saved,
        input.application!,
        input.sources.posting.location,
      ) &&
      (!scope.applicationRecordId ||
        scope.applicationRecordId === input.application!.applicationRecordId) &&
      binding.pageUrl === input.pageUrl &&
      binding.targetHash === target &&
      binding.instructionsHash === meaningHash(input.pageInstructions)
    );
  });
  return new Set(matches.map((saved) => saved.answer.trim())).size === 1
    ? (matches[0] ?? null)
    : null;
}
