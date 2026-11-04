import type {
  ApplicationAttestationKind,
  ApplyStepReceipt,
  ApplyStepReceiptField,
  BrowserAgentPermissions,
  RawApplySummaryRow,
} from "@nestor/contracts";
import { normalizeFormQuestionPrompt } from "@nestor/contracts";
import { questionPrompt } from "./policy-executor";
import { questionLabel } from "./question-text";
import { phoneCountryPicker } from "./phone-answer";
import { fieldNamesAnotherPerson } from "./github-username";
import { choiceAnswerValues } from "./option-match";
import { matchApplicationAnswer } from "./answer-match";
import type { LLMClient } from "../agent/contracts";
import type {
  ApplyAgentConfig,
  ApplyAnswerSources,
  ApplyFormControl,
} from "./types";
import {
  answerSourceCatalog,
  classifyAnswerPermission,
  type ClassifiedAnswerDecision,
} from "./answer-source-catalog";
import {
  asksPayCurrency,
  createQuestionClassifier,
  applicationQuestionClassificationContext,
  modelQuestionKind,
  questionClassificationKey,
} from "./question-classification";
import {
  checkWrittenApplicationAnswers,
  type WrittenAnswerCheck,
} from "./written-answer-grounding";

const REPEATED_NOTE = /\s*\(repeated question on [^)]*\)\s*$/u;
const collapse = (text: string) => text.replace(/\s+/gu, " ").trim();
const sameFrame = (
  a: { origin: string; pathname: string } | null | undefined,
  b: { origin: string; pathname: string } | null | undefined,
) => (!a || !b ? !a && !b : a.origin === b.origin && a.pathname === b.pathname);
/** A multi-select answer is an exact set; any other answer is trimmed text. */
function sameAnswer(field: ApplyStepReceiptField, answer: string): boolean {
  if (field.answerControlType === "multi_choice") {
    try {
      const a = JSON.parse(field.value) as unknown;
      const b = JSON.parse(answer) as unknown;
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      const left = new Set(a.map(String));
      const right = new Set(b.map(String));
      return left.size === right.size && [...left].every((v) => right.has(v));
    } catch {
      return false;
    }
  }
  return field.value.trim() === answer.trim();
}
/** The receipt's own snapshot of the field, for a read-only grounding view. */
function receiptControl(
  field: ApplyStepReceiptField,
  index: number,
): ApplyFormControl {
  const label = field.label.replace(REPEATED_NOTE, "");
  return {
    ref: `receipt${index}`,
    kind: field.kind,
    label,
    ...(field.hint ? { hint: field.hint } : {}),
    groupLabel: field.groupLabel,
    ...(field.sectionPath.length ? { sectionPath: field.sectionPath } : {}),
    ...(field.repeatedQuestion
      ? { repeatedQuestion: field.repeatedQuestion }
      : {}),
    ...(field.choiceGroupKey ? { choiceGroupKey: field.choiceGroupKey } : {}),
    ...(field.telInput ? { telInput: true } : {}),
    ...(field.urlInput ? { urlInput: true } : {}),
    placeholder: field.placeholder,
    required: field.required,
    disabled: false,
    readOnly: field.readOnly,
    visible: true,
    value: field.value,
    checked: field.kind === "radio" || field.kind === "checkbox",
    options: [...field.options],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: field.questionKind,
    answerControlType: field.answerControlType,
    attestationKind: field.attestationKind,
    answered: true,
  };
}

/** Why an earlier-step answer could not be bound on a numbered final page. */
export type PriorStepBindingFailure = "no_receipt" | "unverified";

/**
 * Re-ground current sources at send time; old card provenance grants nothing.
 *
 * An answer whose control is no longer on the page (an earlier wizard step)
 * binds only through this attempt's own confirmed-step receipt with the same
 * card `fieldKey`, on the numbered final page of the same wizard, with the
 * receipt, the card and one visible review row showing the same value
 * (council D1). Its truth is then checked against current sources as usual.
 */
export async function checkClassifiedApplicationAnswers(input: {
  client: LLMClient;
  sources: ApplyAnswerSources;
  payDisclosed: boolean;
  browserPermissions?: BrowserAgentPermissions;
  application?: ApplyAgentConfig["application"];
  approvedAttestations?: readonly ApplicationAttestationKind[];
  answers: readonly {
    question: string;
    answer: string;
    fieldKey?: string | undefined;
  }[];
  formContext: {
    pageText: string;
    fields: readonly { question: string; value: string }[];
  };
  signal?: AbortSignal;
  formControls?: readonly ApplyFormControl[];
  /** Same AI-client scope as preparation; only identical complete readings are reused. */
  questionReadCacheScope?: object;
  /** This attempt's step receipts (execution record). */
  stepReceipts?: readonly ApplyStepReceipt[];
  /** Visible review rows on the page being sent. */
  summaryRows?: readonly RawApplySummaryRow[];
  /** Where the page being sent is: its origin and numbered step. */
  sendPage?: {
    origin: string | null;
    stepIndex: number | null;
    stepTotal: number | null;
  };
}): Promise<(WrittenAnswerCheck & { priorStep?: PriorStepBindingFailure })[]> {
  input = {
    ...input,
    sources: {
      ...input.sources,
      taskInstructions:
        input.application?.instructions ?? input.sources.taskInstructions,
    },
  };
  // Earlier wizard steps can remain in the DOM while hidden. Their actual
  // controls and ancestry still bind the answer; an old card alone cannot.
  const formControls = input.formControls?.map((control) => {
    const hasVisibleTwin = input.formControls?.some(
      (other) =>
        other.visible && questionPrompt(other) === questionPrompt(control),
    );
    return !control.visible && !hasVisibleTwin
      ? // Wizard fieldsets are often disabled off-screen. This is a read-only
        // grounding view, not permission to write into those controls.
        { ...control, visible: true, disabled: false }
      : control;
  });
  const controls: ApplyFormControl[] = input.answers.map((answer, index) => {
    // A run's note that a question repeated across steps describes that run,
    // not the page: Send reads the page afresh and binds the question itself.
    const question = answer.question.replace(
      /\s*\(repeated question on [^)]*\)\s*$/u,
      "",
    );
    const asked = normalizeFormQuestionPrompt(question);
    const matches = formControls?.filter((control) => {
      const prompt = normalizeFormQuestionPrompt(questionPrompt(control));
      return (
        control.visible &&
        (prompt === asked ||
          normalizeFormQuestionPrompt(questionLabel(control)) === asked ||
          (control.groupLabel.trim().length > 0 &&
            asked.endsWith(` ${prompt}`) &&
            !fieldNamesAnotherPerson({
              ...control,
              groupLabel: answer.question,
            })))
      );
    });
    const exact = matches?.filter(
      (control) =>
        normalizeFormQuestionPrompt(questionPrompt(control)) === asked,
    );
    const current = exact?.length ? exact : matches;
    if (current?.length === 1 && current[0]) return current[0];
    // A multi-select is asked by every box in its group: bind the group.
    const [head] = current ?? [];
    const group = head?.choiceGroupKey;
    if (
      head?.answerControlType === "multi_choice" &&
      group &&
      current?.every((control) => control.choiceGroupKey === group)
    )
      return head;
    const numbers = current?.filter(
      (control) => control.telInput && phoneCountryPicker(control, current),
    );
    if (numbers?.length === 1 && numbers[0]) return numbers[0];
    // A choice is asked by several fields (a Yes/No pair, radio options,
    // and sometimes a hidden box behind them): the answer is the option the
    // page shows chosen, which is what preparation checked.
    const said = answer.answer.trim().toLowerCase();
    const chosen = current?.find(
      (control) =>
        control.visible &&
        (control.kind === "radio" || control.kind === "checkbox") &&
        control.checked &&
        (control.label || control.value).trim().toLowerCase() === said,
    );
    if (chosen) return chosen;
    const parts = question.split(/\s+—\s+/u);
    return {
      ref: `preflight${index}`,
      kind: "text",
      label: parts.at(-1)!,
      groupLabel: parts.slice(0, -1).join(" — "),
      placeholder: "",
      required: true,
      disabled: false,
      readOnly: false,
      visible: true,
      value: answer.answer,
      checked: false,
      options: [],
      selectedOptionLabel: "",
      invalid: false,
      validationMessage: "",
      questionKind: "other",
      answerControlType: "text",
      attestationKind: null,
      answered: true,
    };
  });
  if (!controls.length) return [];
  const liveBound = controls.map(
    (control) => !formControls || formControls.includes(control),
  );
  const resultId =
    input.application?.resultId ?? input.application?.applicationId ?? null;
  const attemptReceipts = (input.stepReceipts ?? []).filter(
    (receipt) => resultId !== null && receipt.resultId === resultId,
  );
  const page = input.sendPage;
  const numberedFinal =
    !!page?.origin &&
    page.stepIndex !== null &&
    page.stepTotal !== null &&
    page.stepTotal > 1 &&
    page.stepIndex === page.stepTotal;
  const unconfirmed = attemptReceipts.some(
    (receipt) => receipt.kind === "unconfirmed",
  );
  const rows = input.summaryRows ?? [];
  type PriorBinding = {
    field: ApplyStepReceiptField;
    receipt: ApplyStepReceipt;
    row: number;
    echo: boolean;
  };
  const prior: (PriorBinding | PriorStepBindingFailure | null)[] =
    input.answers.map((answer, index) => {
      if (liveBound[index] || !numberedFinal) return null;
      if (!answer.fieldKey) return "no_receipt";
      const matches = attemptReceipts
        .filter((receipt) => receipt.kind === "advance")
        .flatMap((receipt) =>
          receipt.fields
            .filter((field) => field.fieldKey === answer.fieldKey)
            .map((field) => ({ receipt, field })),
        );
      if (!matches.length) return "no_receipt";
      const [match] = matches;
      if (matches.length !== 1 || !match || unconfirmed) return "unverified";
      const { receipt, field } = match;
      // A choice group's snapshot lacks its live members: it stays with the
      // person rather than being checked from a reconstruction.
      if (
        field.kind === "radio" ||
        field.kind === "checkbox" ||
        field.answerControlType === "multi_choice"
      )
        return "unverified";
      if (
        receipt.origin !== page.origin ||
        receipt.stepTotal !== page.stepTotal ||
        receipt.stepIndex === null ||
        receipt.stepIndex >= page.stepIndex! ||
        !sameAnswer(field, answer.answer)
      )
        return "unverified";
      const base = normalizeFormQuestionPrompt(
        field.label.replace(REPEATED_NOTE, ""),
      );
      const shortBase = base.replace(/^describe your\s+/u, "");
      const labelled = rows
        .map((row, rowIndex) => ({ row, rowIndex }))
        .filter(
          ({ row }) =>
            sameFrame(row.frame, receipt.frame) &&
            [base, shortBase].includes(normalizeFormQuestionPrompt(row.label)),
        );
      const [only] = labelled;
      if (
        labelled.length !== 1 ||
        !only ||
        collapse(only.row.value) !== collapse(field.value)
      )
        return "unverified";
      return { field, receipt, row: only.rowIndex, echo: false };
    });
  // One row confirms two fields only as a read-only echo: the same base
  // question, value, group and section, the later field read-only.
  const byRow = new Map<number, number[]>();
  prior.forEach((binding, index) => {
    if (binding && typeof binding === "object")
      byRow.set(binding.row, [...(byRow.get(binding.row) ?? []), index]);
  });
  for (const indexes of byRow.values()) {
    if (indexes.length === 1) continue;
    const bound = indexes.map((index) => prior[index] as PriorBinding);
    const [first, second] = [...bound].sort(
      (a, b) => (a.receipt.stepIndex ?? 0) - (b.receipt.stepIndex ?? 0),
    );
    const echo =
      indexes.length === 2 &&
      !!first &&
      !!second &&
      (first.receipt.stepIndex ?? 0) < (second.receipt.stepIndex ?? 0) &&
      second.field.readOnly &&
      normalizeFormQuestionPrompt(
        first.field.label.replace(REPEATED_NOTE, ""),
      ) ===
        normalizeFormQuestionPrompt(
          second.field.label.replace(REPEATED_NOTE, ""),
        ) &&
      first.field.value === second.field.value &&
      first.field.groupLabel === second.field.groupLabel &&
      JSON.stringify(first.field.sectionPath) ===
        JSON.stringify(second.field.sectionPath);
    if (echo) second.echo = true;
    else for (const index of indexes) prior[index] = "unverified";
  }
  const receiptRefs = new Set<string>();
  prior.forEach((binding, index) => {
    if (!binding || typeof binding !== "object") return;
    controls[index] = receiptControl(binding.field, index);
    receiptRefs.add(controls[index].ref);
  });
  // A live field on the final page is site-unchanged only by this attempt's
  // final receipt, with the same value on the receipt, the card and the page.
  const finalReceipt = attemptReceipts.find(
    (receipt) => receipt.kind === "final",
  );
  const siteUnchanged = input.answers.map(
    (answer, index): { echo: boolean } | undefined => {
      const binding = prior[index];
      if (binding && typeof binding === "object")
        return binding.field.provenance === "site_unchanged"
          ? { echo: binding.echo }
          : undefined;
      if (!liveBound[index] || !answer.fieldKey || !finalReceipt)
        return undefined;
      const field = finalReceipt.fields.filter(
        (entry) => entry.fieldKey === answer.fieldKey,
      );
      const control = controls[index];
      const [only] = field;
      return field.length === 1 &&
        only !== undefined &&
        only.provenance === "site_unchanged" &&
        sameAnswer(only, answer.answer) &&
        !!control &&
        (control.selectedOptionLabel || control.value).trim() ===
          answer.answer.trim()
        ? { echo: false }
        : undefined;
    },
  );
  // Classify the same full form and native metadata as preparation. Removing
  // optional fields or required flags both changes the question's context and
  // needlessly asks the model to reinterpret an already-read literal.
  const contextControls = [...(formControls ?? [])];
  for (const control of controls)
    if (
      !contextControls.some(
        (current) => questionPrompt(current) === questionPrompt(control),
      )
    )
      contextControls.push(control);
  const catalog = answerSourceCatalog(input.sources);
  const classify = createQuestionClassifier({
    client: input.client,
    signal: input.signal,
    cacheScope: input.questionReadCacheScope,
    readContext: () => applicationQuestionClassificationContext(input),
    sources: () => catalog,
  });
  const readings = await classify(
    contextControls,
    JSON.stringify({
      instructions: input.formContext.pageText,
    }),
  );
  const decisions = await Promise.all(
    input.answers.map(
      async (answer, index): Promise<ClassifiedAnswerDecision> => {
        const control = controls[index];
        const binding = prior[index];
        if (binding === "no_receipt" || binding === "unverified")
          return {
            kind: "needs_you",
            reason:
              binding === "no_receipt"
                ? "An earlier step was continued without Nestor's own confirmed press."
                : "This earlier-step answer could not be checked against the review page.",
          };
        // A fallback label parsed from an old card is not evidence that this
        // exact applicant field still exists on the live form (for example,
        // Name may now belong to a reference section).
        if (
          !control ||
          (formControls && !formControls.includes(control) && !binding)
        )
          return {
            kind: "needs_you",
            reason: "The question is no longer present.",
          };
        const reading =
          readings.get(questionClassificationKey(control, contextControls)) ??
          readings.get(answer.question);
        // Each step is checked in its own context: an earlier step's answer
        // against every field of that step's receipt, a live field against the
        // live page. Two same-named fields within one step still conflict.
        const stepControls =
          binding && typeof binding === "object"
            ? binding.receipt.fields.map((field, position) =>
                field === binding.field
                  ? control
                  : { ...receiptControl(field, index), ref: `step${position}` },
              )
            : contextControls.filter(
                (entry) => !receiptRefs.has(entry.ref) || entry === control,
              );
        const decide = (
          control: ApplyFormControl,
          value: string,
          matchedSourceId?: string,
        ) =>
          classifyAnswerPermission({
            control: {
              ...control,
              attestationKind:
                reading?.declarationKind ?? control.attestationKind,
              questionKind: modelQuestionKind(
                control,
                reading,
                asksPayCurrency(control, contextControls, readings),
              ),
              asksCurrentPay:
                reading?.asksCurrentPay ?? control.asksCurrentPay ?? false,
              asksHiringCountry:
                reading?.asksHiringCountry ??
                control.asksHiringCountry ??
                false,
            },
            controls: stepControls,
            tags: reading?.answerTags,
            ...(matchedSourceId ? { matchedSourceId } : {}),
            approvedAttestations: input.approvedAttestations ?? [],
            sources: input.sources,
            payDisclosed: input.payDisclosed,
            ...(input.application ? { application: input.application } : {}),
            answer: value,
            // An earlier step is read with that step's own instructions.
            pageInstructions:
              binding && typeof binding === "object"
                ? binding.receipt.instructions
                : input.formContext.pageText,
            siteUnchanged: siteUnchanged[index],
          });
        if (control.answerControlType === "multi_choice") {
          const group = contextControls.filter(
            (member) =>
              member.kind === "checkbox" &&
              member.choiceGroupKey === control.choiceGroupKey,
          );
          const expected = choiceAnswerValues(
            answer.answer,
            group.map((member) => member.label || member.value),
          );
          const selected = group.filter((member) => member.checked);
          if (
            !expected ||
            selected.length !== expected.length ||
            selected.some(
              (member) => !expected.includes(member.label || member.value),
            )
          )
            return {
              kind: "needs_you",
              reason:
                "The selected options no longer match the prepared answer.",
            };
          const decisions = selected.map((member) =>
            decide(member, member.label || member.value),
          );
          return (
            decisions.find((decision) => decision.kind !== "literal") ??
            decisions[0] ?? {
              kind: "needs_you",
              reason: "There is no selected answer to verify.",
            }
          );
        }
        const decision = decide(control, answer.answer);
        if (
          decision.kind !== "needs_you" ||
          control.credentialRole ||
          !["source_lookup", "declaration_permission"].includes(
            decision.check ?? "",
          ) ||
          !catalog.some(
            (source) =>
              source.purpose === "saved" &&
              source.value.trim() === answer.answer.trim(),
          )
        )
          return decision;
        // Preparation's matcher is not carried as authority. Re-read a saved
        // answer's meaning here when the current question reader misses it;
        // the independent answer checker below still verifies the whole match.
        const candidate = await matchApplicationAnswer({
          client: input.client,
          question: questionPrompt(control),
          sources: catalog,
          rejection: decision.reason,
          ...(input.signal ? { signal: input.signal } : {}),
        }).catch(() => null);
        if (
          !candidate ||
          candidate.value.trim() !== answer.answer.trim() ||
          !catalog.some(
            (source) =>
              source.id === candidate.sourceId && source.purpose === "saved",
          )
        )
          return decision;
        return decide(control, answer.answer, candidate.sourceId);
      },
    ),
  );
  const writing = input.answers.flatMap((answer, index) => {
    const decision = decisions[index];
    return decision?.kind === "writing" || decision?.kind === "inference"
      ? [
          {
            ...answer,
            ...(decision.evidencePolicy
              ? { evidencePolicy: decision.evidencePolicy }
              : {}),
          },
        ]
      : [];
  });
  const checks = writing.length
    ? await checkWrittenApplicationAnswers({
        ...input,
        answers: writing,
      }).catch(() =>
        writing.map(() => ({
          supported: false,
          reason: "This answer could not be checked against your sources.",
        })),
      )
    : [];
  let writtenIndex = 0;
  const results = decisions.map(
    (
      decision,
      index,
    ): WrittenAnswerCheck & { priorStep?: PriorStepBindingFailure } => {
      const binding = prior[index];
      const failure =
        binding === "no_receipt" || binding === "unverified"
          ? binding
          : undefined;
      if (decision.kind === "literal")
        return {
          supported: true,
          reason: "Unchanged matching saved answer or profile fact.",
        };
      if (decision.kind === "site_unchanged")
        return {
          supported: true,
          reason: "The site filled this and Nestor left it unchanged.",
        };
      if (decision.kind === "needs_you")
        return {
          supported: false,
          reason: decision.reason,
          ...(failure ? { priorStep: failure } : {}),
        };
      return (
        checks[writtenIndex++] ?? {
          supported: false,
          reason: "The writing could not be verified.",
        }
      );
    },
  );
  // A read-only echo stands only with its qualifying original.
  for (const indexes of byRow.values()) {
    if (indexes.length !== 2) continue;
    if (!indexes.every((index) => results[index]?.supported))
      for (const index of indexes)
        if (results[index]?.supported)
          results[index] = {
            supported: false,
            reason:
              "Its repeated original on an earlier step could not be checked.",
          };
  }
  return results;
}
