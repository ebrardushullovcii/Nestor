/** Native interaction facts, serialized into the element's own document. */
export function readPressability(element: Element): {
  disabled: boolean;
  inert: boolean;
} {
  let disabled = false,
    inert = false;
  for (
    let node: Element | null = element;
    node;
    node = node.parentElement ?? (node.getRootNode() as ShadowRoot).host ?? null
  ) {
    disabled ||= node.matches(":disabled,[aria-disabled='true']");
    inert ||= node.hasAttribute("inert");
  }
  return { disabled, inert };
}

/** Read the form's own validity and linked error text; never validate an answer ourselves. */
export function readFieldValidation(
  element: Element,
  readText: (root: Node) => string,
): { invalid: boolean; validationMessage: string } {
  const field = element as
    | HTMLInputElement
    | HTMLTextAreaElement
    | HTMLSelectElement;
  const ariaInvalid = element.getAttribute("aria-invalid");
  const invalid =
    (ariaInvalid !== null && ariaInvalid !== "false") ||
    field.validity?.valid === false ||
    element.matches(":invalid");
  const messages: string[] = [];
  if (field.validationMessage) messages.push(field.validationMessage);
  if (ariaInvalid !== null && ariaInvalid !== "false")
    messages.push(`aria-invalid=${ariaInvalid}`);
  if (field.validity?.valid === false) {
    const flags = (
      [
        "valueMissing",
        "typeMismatch",
        "patternMismatch",
        "tooLong",
        "tooShort",
        "rangeUnderflow",
        "rangeOverflow",
        "stepMismatch",
        "badInput",
        "customError",
      ] as const
    ).filter((key) => field.validity[key]);
    if (flags.length) messages.push(`Validity: ${flags.join(", ")}`);
  }
  if (invalid) {
    const root = element.getRootNode() as Document | ShadowRoot;
    for (const attribute of ["aria-errormessage", "aria-describedby"]) {
      for (const id of (element.getAttribute(attribute) ?? "")
        .split(/\s+/u)
        .filter(Boolean)) {
        const error = root.querySelector(`#${CSS.escape(id)}`);
        const text = error ? readText(error).trim() : "";
        if (text) messages.push(text);
      }
    }
  }
  return { invalid, validationMessage: [...new Set(messages)].join(" ") };
}
