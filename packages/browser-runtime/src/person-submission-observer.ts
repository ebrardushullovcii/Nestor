import { readApplicationSubmissionConfirmationEvidence } from "@nestor/contracts";

/** Installed in each document; observes trusted input, never sends or cancels it. */
function installPersonSubmissionObserver(
  tokens: { unbound: string | null; bound: string | null },
  receipts: typeof readApplicationSubmissionConfirmationEvidence,
): void {
  const pageWindow = window as unknown as Record<string, unknown>;
  const installation = tokens.bound
    ? "__nestorNativePersonSubmissionObserver"
    : "__nestorGuardPersonSubmissionObserver";
  if (pageWindow[installation]) return;
  pageWindow[installation] = tokens.bound ?? true;
  const deepElements = (root: ParentNode, selector: string): Element[] => {
    const elements = [...root.querySelectorAll(selector)];
    for (const host of root.querySelectorAll("*"))
      if (host.shadowRoot)
        elements.push(...deepElements(host.shadowRoot, selector));
    return elements;
  };
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  };
  const text = (root: ParentNode): string => {
    const parts: string[] = [];
    for (const node of root.childNodes) {
      if (node instanceof Text) {
        parts.push(node.textContent ?? "");
        continue;
      }
      if (
        !(node instanceof HTMLElement) ||
        ["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)
      )
        continue;
      const style = getComputedStyle(node);
      if (
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility) ||
        Number(style.opacity || "1") === 0 ||
        (style.display !== "contents" && !node.getClientRects().length)
      )
        continue;
      const block = !["inline", "inline-block", "contents"].includes(
        style.display,
      );
      if (block) parts.push("\n");
      parts.push(text(node));
      if (node.shadowRoot) parts.push(text(node.shadowRoot));
      if (block) parts.push("\n");
    }
    return parts.join(" ");
  };
  const bound = () => {
    try {
      return Boolean(
        pageWindow.__nestorNativePreparedApplication ||
        pageWindow.__nestorPreparedApplication ||
        sessionStorage.getItem("__nestorPreparedApplication"),
      );
    } catch {
      return false;
    }
  };
  const labelOf = (element: Element): string =>
    (
      element.getAttribute("aria-label") ||
      (element instanceof HTMLInputElement
        ? element.value
        : element.textContent) ||
      ""
    )
      .replace(/\s+/gu, " ")
      .trim();
  const finalLabel = (label: string) =>
    /^(?:submit(?: (?:my|the|your))?(?: (?:job )?application)?|send(?: (?:my|the|your))?(?: (?:job )?application)?|(?:complete|finish)(?: (?:my|the|your))? application|apply(?: now| for (?:this|the) (?:job|position))?)[.!\s]*$/iu.test(
      label,
    );
  const finalControl = (
    control: Element | null,
    form: HTMLFormElement | null,
  ): boolean => {
    if (!control || !finalLabel(labelOf(control))) return false;
    const root = form ?? control.closest('[role="form"]') ?? document;
    const step = document
      .querySelector('[aria-current="step"]')
      ?.textContent?.match(/\b(\d+)\s*(?:of|\/)\s*(\d+)\b/iu);
    if (step && Number(step[1]) < Number(step[2])) return false;
    const fields = deepElements(
      root,
      "input,textarea,select,[contenteditable=true]",
    );
    if (
      fields.some(
        (field) =>
          field instanceof HTMLInputElement &&
          field.type === "password" &&
          !field.disabled &&
          visible(field),
      )
    )
      return false;
    const applicationFields = fields.some((field) => {
      if (
        field instanceof HTMLInputElement &&
        ["hidden", "submit", "button", "checkbox", "radio"].includes(field.type)
      )
        return false;
      const identity = [
        field.getAttribute("name"),
        field.getAttribute("id"),
        field.getAttribute("autocomplete"),
        field.getAttribute("aria-label"),
      ].join(" ");
      return (
        (field instanceof HTMLInputElement && field.type === "file") ||
        /\b(?:name|first[_-]?name|last[_-]?name|given-name|family-name|resume|cv|cover[_-]?letter)\b/iu.test(
          identity,
        )
      );
    });
    // Entry buttons, sign-ins and ordinary intermediate forms are not sends.
    // A read-only review form can still have an explicit final application control.
    const label = labelOf(control);
    if (
      /^(?:submit|send)[.!\s]*$/iu.test(label) &&
      !/\b(?:application|resume|cv|cover letter)\b/iu.test(text(root))
    )
      return false;
    return (
      applicationFields || Boolean(form && /\bapplication\b/iu.test(label))
    );
  };
  let intent: {
    form: HTMLFormElement | null;
    control: Element | null;
    at: number;
  } | null = null;
  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || event.key !== "Enter") return;
      const input = event
        .composedPath()
        .find((target) => target instanceof HTMLInputElement);
      if (input instanceof HTMLInputElement && input.form)
        intent = { form: input.form, control: null, at: Date.now() };
    },
    true,
  );
  const observe = (event: Event) => {
    if (!event.isTrusted) return;
    const submit = event instanceof SubmitEvent ? event : null;
    const control =
      submit?.submitter ??
      event
        .composedPath()
        .find(
          (target) =>
            target instanceof Element &&
            target.matches(
              'button,input[type="submit"],input[type="button"],[role="button"]',
            ),
        );
    if (!(control instanceof Element)) return;
    if (!bound() && tokens.unbound) {
      if (
        /\b(?:submit|send[-_\s]*application|complete[-_\s]*application)\b/iu.test(
          labelOf(control),
        )
      )
        console.debug(tokens.unbound);
      return;
    }
    const form =
      submit?.target instanceof HTMLFormElement
        ? submit.target
        : control instanceof HTMLButtonElement ||
            control instanceof HTMLInputElement
          ? control.form
          : null;
    if (
      submit &&
      (!intent ||
        Date.now() - intent.at > 2_000 ||
        (intent.form !== form && intent.control !== control))
    )
      return;
    if (!finalControl(control, form)) return;
    if (!submit) intent = { form, control, at: Date.now() };
    const guard = pageWindow.__nestorPrepareOnlyMutationGuardV1 as
      | {
          finalActionAllowed?: boolean;
          sendPressedAt?: number;
          sendConfirmationBefore?: string[];
          sendOrigin?: string;
        }
      | undefined;
    const before = receipts(text(document.body ?? document)).messages;
    if (!tokens.bound) {
      if (!guard?.finalActionAllowed) return;
      guard.sendPressedAt = Date.now();
      guard.sendConfirmationBefore = before;
      guard.sendOrigin = location.origin;
    } else
      console.debug(
        tokens.bound + JSON.stringify({ confirmationBefore: before }),
      );
  };
  document.addEventListener("click", observe, true);
  document.addEventListener("submit", observe, true);
}

/** The same semantic observer for native Electron and Playwright documents. */
export function personSubmissionObserverSource(
  tokens: { unbound: string | null; bound: string | null } = {
    unbound: null,
    bound: null,
  },
): string {
  return `(${installPersonSubmissionObserver.toString()})(${JSON.stringify(tokens)},${readApplicationSubmissionConfirmationEvidence.toString()})`;
}
