import { readPasswordForms } from "../main/services/browser/password-form";
import type {
  BrowserPasswordCapture,
  BrowserPasswordFill,
} from "@nestor/contracts";
/** Runs only in the sandboxed preload's isolated world. No bridge is exposed to websites. */
export function installPasswordPage(port: {
  capture(value: BrowserPasswordCapture): void;
  onFill(listener: (value: BrowserPasswordFill) => void): void;
  filled(requestId: string, ok: boolean): void;
}): void {
  const safeForm = (password: HTMLInputElement) => {
    if (
      password.disabled ||
      password.readOnly ||
      getComputedStyle(password).visibility === "hidden" ||
      getComputedStyle(password).opacity === "0" ||
      password.getClientRects().length === 0
    )
      return false;
    try {
      return (
        new URL(password.form?.action || location.href, location.href)
          .origin === location.origin &&
        Array.from(password.form?.elements ?? []).every((element) => {
          const override = element.getAttribute("formaction");
          return (
            override === null ||
            new URL(override, document.baseURI).origin === location.origin
          );
        })
      );
    } catch {
      return false;
    }
  };
  const passwords = () => {
    const inputs = document.querySelectorAll<HTMLInputElement>(
      'input[type="password"]',
    );
    return readPasswordForms()
      .map((form) => inputs[form.passwordIndex])
      .filter((input): input is HTMLInputElement => !!input && safeForm(input));
  };
  const usernameFor = (password: HTMLInputElement) => {
    const dialog = password.closest(
      'dialog, [role="dialog"], [aria-modal="true"]',
    );
    const root =
      dialog && (!password.form || !dialog.contains(password.form))
        ? dialog
        : (password.form ?? dialog ?? document);
    const inputs = Array.from(
      root.querySelectorAll<HTMLInputElement>("input"),
    ).filter(
      (input) =>
        !input.disabled &&
        !input.readOnly &&
        !input.closest('[hidden], [inert], [aria-hidden="true"]') &&
        getComputedStyle(input).visibility !== "hidden" &&
        input.getClientRects().length > 0,
    );
    const autocompleteIs = (input: HTMLInputElement, token: string) =>
      input.autocomplete.split(/\s+/u).includes(token);
    return (
      inputs.find((input) => autocompleteIs(input, "username")) ??
      inputs.find((input) => autocompleteIs(input, "email")) ??
      inputs.find((input) => input.type === "email") ??
      inputs.find(
        (input) =>
          input.type === "text" &&
          /user|email|login/i.test(`${input.name} ${input.id}`),
      )
    );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let touched: HTMLInputElement | null = null;
  const capture = () => {
    const candidates = passwords().filter(
      (input) => !touched || input.form === touched.form,
    );
    const password =
      candidates.find(
        (input) => input.autocomplete === "new-password" && input.value,
      ) ??
      (touched && candidates.includes(touched) ? touched : null) ??
      candidates.find((input) => input.value);
    if (!password?.value || password.value.length > 10000) return;
    const username = usernameFor(password)?.value ?? "";
    if (username.length > 1000) return;
    port.capture({
      origin: location.origin,
      action: password.form?.action || location.href,
      username,
      password: password.value,
    });
  };
  document.addEventListener(
    "input",
    (event) => {
      if (!event.isTrusted || !(event.target instanceof HTMLInputElement))
        return;
      if (event.target.type === "password") touched = event.target;
      if (!touched) return;
      clearTimeout(timer);
      timer = setTimeout(capture, 1200);
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      if (
        !event.isTrusted ||
        !(event.target instanceof HTMLInputElement) ||
        event.target.type !== "password"
      )
        return;
      touched = event.target;
      capture();
    },
    true,
  );
  document.addEventListener(
    "submit",
    () => {
      if (touched) capture();
    },
    true,
  );
  port.onFill((value) => {
    let ok = false;
    try {
      if (location.origin !== value.origin) return;
      const candidates = passwords();
      const password =
        candidates.find((input) => input.autocomplete === "current-password") ??
        candidates[0];
      if (
        !password ||
        (value.agent &&
          (candidates.length !== 1 || !readPasswordForms()[0]?.login))
      )
        return;
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      if (!descriptor?.set) return;
      const username = usernameFor(password);
      const usernameText = value.username.trim()
        ? value.username
        : value.fallbackUsername;
      // A password-only import does not identify a different account already
      // entered on the site. Leave that conflict for the person.
      if (
        value.agent &&
        username &&
        !value.username.trim() &&
        (!usernameText ||
          (username.value.trim() &&
            username.value.trim().toLowerCase() !==
              usernameText.trim().toLowerCase()))
      )
        return;
      // All binding checks run before either value is written.
      if (!safeForm(password)) return;
      const fill = (input: HTMLInputElement, text: string) => {
        descriptor.set!.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (username && usernameText) fill(username, usernameText);
      // A username listener may navigate or replace/change the form action.
      if (
        !password.isConnected ||
        location.origin !== value.origin ||
        !safeForm(password)
      )
        return;
      if (value.agent) {
        const forms = readPasswordForms();
        if (
          forms.length !== 1 ||
          !forms[0]?.login ||
          document.querySelectorAll('input[type="password"]')[
            forms[0].passwordIndex
          ] !== password
        )
          return;
      }
      fill(password, value.password);
      ok = true;
    } catch {
      /* Never surface secret-bearing DOM errors to console/CDP. */
    } finally {
      port.filled(value.requestId, ok);
    }
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    touched = null;
  });
}
