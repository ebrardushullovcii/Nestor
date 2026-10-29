/** Metadata only. Also run by main in a target frame; never returns field values. */
export function readPasswordForms(): { action: string; login: boolean }[] {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ).filter(
    (input) =>
      !input.disabled &&
      !input.readOnly &&
      getComputedStyle(input).visibility !== "hidden" &&
      getComputedStyle(input).opacity !== "0" &&
      input.getClientRects().length > 0,
  );
  return inputs.map((input) => {
    const form = input.form;
    const buttons = Array.from(
      (form ?? document).querySelectorAll('button, input[type="submit"]'),
    )
      .map((button) => button.textContent || button.getAttribute("value") || "")
      .join(" ");
    const registration =
      inputs.length !== 1 ||
      input.autocomplete === "new-password" ||
      /create|register|sign\s*up|reset|change\s*password|delete|remove|purchase|pay\b/i.test(
        buttons,
      );
    const headings = Array.from(
      document.querySelectorAll("h1, h2, [role=heading]"),
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
    };
  });
}
