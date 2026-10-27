import type {
  ApplyRawPageHands,
  RawApplyControl,
  RawApplyPage,
  RawApplyPlacement,
} from "@nestor/contracts";

import {
  inferActionKind,
  inferAttestationKind,
  inferQuestionKind,
  isControlAnswered,
  normalizeSignal,
  toAnswerControlType,
} from "./control-classification";
import { detectApplyBlocker } from "./blockers";
import { requiresOwnWords } from "./own-words";
import type {
  ApplyControlKind,
  ApplyFormAction,
  ApplyFormControl,
  ApplyFormObservation,
  ApplyLinkDestination,
  ApplyPageHands,
  ApplyPageLink,
  ApplyPlacement,
  ApplyStepPosition,
} from "./types";

/**
 * Turning a raw page read into something the loop can reason about.
 *
 * The browser layer says what is on the page. This file says what it means:
 * which control asks which question, which of them the person has to answer
 * themselves, which button sends the application, and whether the page is
 * showing something that needs a person.
 */

function toControlKind(raw: RawApplyControl): ApplyControlKind {
  const type = raw.inputType.toLowerCase();
  if (raw.tagName === "select") {
    return "select";
  }
  if (raw.tagName === "textarea" || raw.tagName === "contenteditable") {
    return "long_text";
  }
  if (raw.role === "combobox") {
    return "combobox";
  }
  if (raw.role === "checkbox" || type === "checkbox") {
    return "checkbox";
  }
  if (raw.role === "radio" || type === "radio") {
    return "radio";
  }
  if (type === "file") {
    return "file";
  }
  if (type === "date" || type === "month") {
    return "date";
  }
  if (
    type === "text" ||
    type === "email" ||
    type === "tel" ||
    type === "url" ||
    type === "number" ||
    type === "search" ||
    type === ""
  ) {
    return "text";
  }
  return "other";
}

/** Reads "Step 2 of 4" style progress out of whatever the page happens to call it. */
export function readStepPosition(
  stepLabel: string | null,
  bodyText: string,
): ApplyStepPosition {
  const label = stepLabel?.trim() || null;
  const haystack = label ?? bodyText.slice(0, 4_000);
  const numbered =
    /\b(?:step|page|section)\s+(\d{1,2})\s*(?:of|\/|from)\s*(\d{1,2})\b/iu.exec(
      haystack,
    );
  if (numbered?.[1] && numbered[2]) {
    return {
      label,
      index: Number.parseInt(numbered[1], 10),
      total: Number.parseInt(numbered[2], 10),
    };
  }
  const bare = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/u.exec(haystack);
  if (label && bare?.[1] && bare[2]) {
    return {
      label,
      index: Number.parseInt(bare[1], 10),
      total: Number.parseInt(bare[2], 10),
    };
  }
  return { label, index: null, total: null };
}

/** What a link opens, judged only by its own address. */
function readLinkDestination(resolved: URL | null): ApplyLinkDestination {
  if (!resolved) {
    return "other";
  }
  if (resolved.protocol === "mailto:") {
    return "email";
  }
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
    return "other";
  }
  return /\.(?:pdf|docx?|rtf|odt)$/iu.test(resolved.pathname)
    ? "document"
    : "page";
}

function hashSignature(parts: readonly string[]): string {
  let hash = 2166136261;
  const joined = parts.join(" ");
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function placementOf(raw: RawApplyPlacement): ApplyPlacement {
  return {
    ...(raw.section?.trim() ? { section: raw.section.trim() } : {}),
    ...(raw.inForm ? { inForm: true } : {}),
  };
}

/**
 * Toggle buttons that answer one question read as that question's choices.
 * Ashby's Yes/No is two `aria-pressed` buttons inside the question's field:
 * as buttons, Fill handed them to the person; as a radio group named after
 * the question, they go through the answer path like any other choice. The
 * control keeps the button's own handle, so pressing it is the same press.
 */
function withToggleChoices(raw: RawApplyPage): RawApplyPage {
  const groups = new Map<string, RawApplyPage["actions"]>();
  for (const action of raw.actions) {
    const question = action.section?.trim();
    if (action.pressed === undefined || !question) continue;
    groups.set(question, [...(groups.get(question) ?? []), action]);
  }
  const toggles = [...groups].filter(([, group]) => group.length >= 2);
  if (!toggles.length) return raw;
  const taken = new Set(toggles.flatMap(([, group]) => group));
  return {
    ...raw,
    actions: raw.actions.filter((action) => !taken.has(action)),
    controls: [
      ...raw.controls,
      ...toggles.flatMap(([question, group]) =>
        group.map(
          (action): RawApplyControl => ({
            ref: action.ref ?? `a${action.index}`,
            index: -1 - action.index,
            tagName: "button",
            inputType: "radio",
            role: "radio",
            id: "",
            name: `pressed:${question}`,
            scopeKey: "pressed",
            label: action.label.trim(),
            groupLabel: question,
            placeholder: "",
            autocomplete: "",
            // Only the question's own marker says so; the page has no
            // required attribute on a button.
            required: /\*\s*$/u.test(question),
            invalid: false,
            validationMessage: "",
            disabled: action.disabled,
            readOnly: false,
            visible: action.visible,
            value: action.label.trim(),
            checked: action.pressed === true,
            multiple: false,
            options: [],
            selectedOptionLabel: "",
          }),
        ),
      ),
    ],
  };
}

export function buildApplyFormObservation(
  page: RawApplyPage,
  observedAt: string,
): ApplyFormObservation {
  const raw = withToggleChoices(page);
  const controls: ApplyFormControl[] = raw.controls.map((rawControl) => {
    const kind = toControlKind(rawControl);
    const inputType = rawControl.inputType.toLowerCase();
    const credentialRole =
      inputType === "password"
        ? ("password" as const)
        : inputType === "email" ||
            /\b(?:email|e-mail|username|user name|user id)\b/iu.test(
              `${rawControl.label} ${rawControl.placeholder} ${rawControl.autocomplete}`,
            )
          ? ("identifier" as const)
          : null;
    const base: Omit<
      ApplyFormControl,
      "questionKind" | "answerControlType" | "attestationKind" | "answered"
    > = {
      ref: rawControl.ref ?? `c${rawControl.index}`,
      kind,
      ...(inputType === "month" || inputType === "date"
        ? { dateInputType: inputType }
        : {}),
      ...(inputType === "number" ||
      inputType === "date" ||
      inputType === "month"
        ? {
            inputConstraints: {
              type: inputType,
              ...(rawControl.min ? { min: rawControl.min } : {}),
              ...(rawControl.max ? { max: rawControl.max } : {}),
              ...(rawControl.step ? { step: rawControl.step } : {}),
            },
          }
        : {}),
      ...(inputType === "file" && rawControl.accept
        ? {
            acceptedTypes: rawControl.accept
              .split(",")
              .map((entry) => entry.trim().toLowerCase())
              .filter(Boolean),
          }
        : {}),
      label: rawControl.label.trim(),
      ...(rawControl.hint?.trim() ? { hint: rawControl.hint.trim() } : {}),
      groupLabel: rawControl.groupLabel.trim(),
      ...(kind === "radio" || (kind === "checkbox" && !rawControl.required)
        ? {
            choiceGroupKey: rawControl.name.trim()
              ? `${rawControl.scopeKey ?? "root"}:name:${rawControl.name.trim()}`
              : `ref:${rawControl.ref ?? `c${rawControl.index}`}`,
          }
        : {}),
      placeholder: rawControl.placeholder.trim(),
      required: rawControl.required,
      disabled: rawControl.disabled,
      readOnly: rawControl.readOnly,
      visible: rawControl.visible,
      // A task-local password can be present long enough to submit a sign-in
      // form, but it must never enter the observation/model/tool trace.
      value: credentialRole === "password" ? "" : rawControl.value,
      credentialRole,
      checked: rawControl.checked,
      options: rawControl.options,
      selectedOptionLabel: rawControl.selectedOptionLabel,
      invalid: rawControl.invalid,
      validationMessage: rawControl.validationMessage,
      ...(rawControl.upload ? { upload: rawControl.upload } : {}),
    };
    const control: ApplyFormControl = {
      ...base,
      questionKind: inferQuestionKind(base),
      answerControlType: toAnswerControlType(kind, rawControl.multiple),
      attestationKind: inferAttestationKind(base),
      answered: false,
    };
    return {
      ...control,
      answered:
        credentialRole === "password"
          ? rawControl.value.length > 0
          : isControlAnswered(control),
    };
  });

  // A radio group is one question. Once one option is selected, every option
  // in that group belongs to an answered question; `checked` still identifies
  // the chosen value. Treating each unselected option as a separate empty
  // required field makes an agent overwrite a valid Yes with No (and vice
  // versa) while trying to satisfy an impossible form state.
  for (const control of controls) {
    if (control.kind !== "radio" && control.kind !== "checkbox") continue;
    const groupKey = control.choiceGroupKey;
    if (!groupKey) continue;
    const group = controls.filter(
      (candidate) =>
        candidate.kind === control.kind &&
        candidate.choiceGroupKey === groupKey,
    );
    if (control.kind === "checkbox" && group.length < 2) continue;
    control.answered = group.some((candidate) => candidate.checked);
    // Radio choices must pass through the same saved-answer matching as a
    // select. Otherwise a saved prose answer appears usable until every
    // individual radio is refused, without a question for the person.
    if (control.kind === "checkbox") control.answerControlType = "multi_choice";
    control.options = group.map(
      (candidate) => candidate.label || candidate.value,
    );
  }

  const actions: ApplyFormAction[] = raw.actions.map((rawAction) => ({
    ref: rawAction.ref ?? `a${rawAction.index}`,
    label: rawAction.label.trim(),
    kind: inferActionKind(rawAction.label),
    visible: rawAction.visible,
    disabled: rawAction.disabled,
    ...(rawAction.formAction ? { formAction: rawAction.formAction } : {}),
    ...(rawAction.formMethod ? { formMethod: rawAction.formMethod } : {}),
    ...placementOf(rawAction),
  }));

  const links: ApplyPageLink[] = raw.links.map((rawLink) => {
    let resolved: URL | null = null;
    try {
      resolved = new URL(rawLink.href, raw.url ?? undefined);
    } catch {
      resolved = null;
    }
    return {
      ref: rawLink.ref ?? `l${rawLink.index}`,
      label: rawLink.label.trim(),
      href: resolved ? resolved.toString() : rawLink.href,
      origin:
        resolved &&
        (resolved.protocol === "https:" || resolved.protocol === "http:")
          ? resolved.origin
          : null,
      destination: readLinkDestination(resolved),
      opensNewWindow: /^_blank$/iu.test(rawLink.target.trim()),
      visible: rawLink.visible,
      topOffset: rawLink.topOffset,
    };
  });

  let origin: string | null = null;
  try {
    origin = raw.url ? new URL(raw.url).origin : null;
  } catch {
    origin = null;
  }

  return {
    observedAt,
    signature: hashSignature([
      raw.url ?? "",
      raw.stepLabel ?? "",
      ...controls.map(
        (control) =>
          `${control.ref}|${control.kind}|${normalizeSignal(control.label)}|${control.required}|${control.answered}`,
      ),
      ...actions.map(
        (action) =>
          `${action.ref}|${action.kind}|${normalizeSignal(action.label)}`,
      ),
      ...links.map((link) => `${link.ref}|${normalizeSignal(link.label)}`),
    ]),
    url: raw.url,
    origin,
    title: raw.title,
    step: readStepPosition(raw.stepLabel, raw.bodyText),
    bodyTextExcerpt: raw.bodyText.slice(0, 6_000),
    ownWordsRequired: requiresOwnWords(raw.bodyText),
    headings: raw.headings.map((heading) => ({
      level: heading.level,
      text: heading.text,
    })),
    controls,
    actions,
    links,
    clickables: raw.clickables.map((clickable) => ({
      ref: clickable.ref ?? `e${clickable.index}`,
      label: clickable.label,
      role: clickable.role,
      tagName: clickable.tagName,
      visible: clickable.visible,
      ...placementOf(clickable),
    })),
    openedTabs: raw.openedTabs.map((tab) => ({
      index: tab.index,
      url: tab.url,
      title: tab.title,
    })),
    loading: raw.loading,
    ...(raw.uploads ? { uploads: raw.uploads } : {}),
    validationErrors: raw.validationErrors,
    blocker: detectApplyBlocker({
      bodyText: raw.bodyText,
      controls,
      actions,
      links,
    }),
  };
}

/**
 * Wraps the browser layer's mechanics into the hands the loop uses.
 *
 * The only thing added here is meaning: writes pass straight through.
 */
export function createApplyPageHands(
  mechanics: ApplyRawPageHands,
  now: () => Date = () => new Date(),
): ApplyPageHands {
  const readLinkedText = mechanics.readLinkedText;
  return {
    observe: async () =>
      buildApplyFormObservation(
        await mechanics.readPage(),
        now().toISOString(),
      ),
    navigate: (url) => mechanics.navigate(url),
    clickElement: (ref) => mechanics.clickElement(ref),
    pressKey: (ref, key) => mechanics.pressKey(ref, key),
    scroll: (direction) => mechanics.scroll(direction),
    wait: (milliseconds) => mechanics.wait(milliseconds),
    goBack: () => mechanics.goBack(),
    readText: (ref) => mechanics.readText(ref),
    ...(readLinkedText ? { readLinkedText: () => readLinkedText() } : {}),
    fillText: (ref, value) => mechanics.fillText(ref, value),
    chooseOption: (ref, optionLabel) =>
      mechanics.chooseOption(ref, optionLabel),
    setToggle: (ref, checked) => mechanics.setToggle(ref, checked),
    uploadFile: (ref, file) => mechanics.uploadFile(ref, file),
    clickAction: (ref) => mechanics.clickAction(ref),
    ...(mechanics.checkAction
      ? { checkAction: (ref: string) => mechanics.checkAction!(ref) }
      : {}),
    followLink: (ref) => mechanics.followLink(ref),
    ...(mechanics.adoptOpenedTab
      ? { adoptOpenedTab: (index) => mechanics.adoptOpenedTab!(index) }
      : {}),
  };
}
