import { createHash } from "node:crypto";
import type {
  ApplicationAttestationKind,
  ApplyStepReceiptField,
} from "@nestor/contracts";
import {
  applicationFacts,
  plainAnswerCheckFacts,
  serializeApplicationData,
} from "./application-facts";
import { questionPrompt } from "./question-text";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

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

/** Current applicant facts, conditions, task instructions and disclosure/consent authority. */
export function meaningSourcesHash(
  sources: ApplyAnswerSources,
  payDisclosed: boolean,
  approvedAttestations: readonly ApplicationAttestationKind[] = [],
): string {
  return meaningHash({
    applicant: JSON.parse(
      serializeApplicationData(
        plainAnswerCheckFacts(applicationFacts(sources, { payDisclosed })),
      ),
    ) as unknown,
    resume: sources.resumeText ?? sources.profile.baseResume.textContent,
    posting: sources.posting,
    approvedAttestations,
    payDisclosed,
  });
}

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
    constraints: control.inputConstraints ?? null,
    telInput: control.telInput === true,
    urlInput: control.urlInput === true,
  });
}
export type AcceptedAnswerMeaning = NonNullable<
  ApplyStepReceiptField["acceptedMeaning"]
>;
