/** Metadata only. Also run by main in a target frame; never returns field values. */
export function readPasswordForms(): {
  action: string;
  login: boolean;
  passwordIndex: number;
}[] {
  const visible = (element: Element) =>
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    getComputedStyle(element).visibility !== "hidden" &&
    getComputedStyle(element).opacity !== "0" &&
    element.getClientRects().length > 0;
  const allInputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  );
  const visibleInputs = allInputs.filter(
    (input) => !input.disabled && !input.readOnly && visible(input),
  );
  // A sign-in dialog can sit over a still-rendered registration form. Only
  // the dialog is interactive; background passwords and headings are not its
  // account-creation intent. Multiple dialogs remain ambiguous.
  const dialogs = Array.from(
    document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
    ),
  ).filter(
    (dialog) =>
      visible(dialog) && visibleInputs.some((input) => dialog.contains(input)),
  );
  const dialog = dialogs.length === 1 ? dialogs[0] : undefined;
  const inputs = dialog
    ? visibleInputs.filter((input) => dialog.contains(input))
    : visibleInputs;
  return inputs.map((input) => {
    const form = input.form;
    const controls =
      dialog && (!form || !dialog.contains(form))
        ? dialog
        : (form ?? dialog ?? document);
    const buttons = Array.from(
      controls.querySelectorAll('button, input[type="submit"]'),
    )
      .map((button) => button.textContent || button.getAttribute("value") || "")
      .join(" ");
    const registration =
      dialogs.length > 1 ||
      inputs.length !== 1 ||
      input.autocomplete === "new-password" ||
      /create|register|sign\s*up|reset|change\s*password|delete|remove|purchase|pay\b/i.test(
        buttons,
      );
    const headings = Array.from(
      (dialog ?? document).querySelectorAll("h1, h2, [role=heading]"),
    )
      .map((heading) => heading.textContent ?? "")
      .join(" ");
    const action = form?.action || location.href;
    const loginIntent =
      /sign\s*in|log\s*in/i.test(`${buttons} ${headings}`) ||
      /\/(?:login|signin|sign-in)(?:[/.?]|$)/i.test(action);
    const registrationIntent =
      /create\s*(?:an?\s*)?account|register|sign\s*up|reset\s*password|change\s*password/i.test(
        headings,
      ) ||
      /\/(?:register|signup|sign-up|create-account|reset-password)(?:[/.?]|$)/i.test(
        action,
      );
    const unsafeSubmitter = Array.from(form?.elements ?? []).find((element) => {
      const override = element.getAttribute("formaction");
      return (
        override !== null &&
        new URL(override, document.baseURI).origin !== location.origin
      );
    });
    return {
      action: unsafeSubmitter
        ? new URL(unsafeSubmitter.getAttribute("formaction")!, document.baseURI)
            .href
        : action,
      login: !registration && !registrationIntent && loginIntent,
      passwordIndex: allInputs.indexOf(input),
    };
  });
}
