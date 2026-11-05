import { randomUUID } from "node:crypto";
import type { ApplyRawPageHands, ApplyWriteResult } from "@nestor/contracts";
import type { Locator, Page } from "playwright";
import { openPrepareOnlyProviderWriteWindow } from "./playwright-application-flow";

/** Called only after the host's exact-site saved-account autofill succeeded. */
export async function clickPreparedLoginAction(
  page: Page,
  locator: Locator,
  input: Parameters<
    NonNullable<ApplyRawPageHands["clickAuthorizedLoginAction"]>
  >[0],
  click: () => Promise<void>,
  signal?: AbortSignal,
): Promise<ApplyWriteResult> {
  let close: (() => Promise<void>) | undefined;
  let removeLoaded: (() => void) | undefined;
  const token = randomUUID();
  const url = page.url();
  const elementHandle = await locator.elementHandle();
  const owningFrame = await elementHandle?.ownerFrame();
  await elementHandle?.dispose();
  if (!owningFrame || signal?.aborted)
    return { ok: false, error: "The sign-in page is no longer available." };
  const denied = {
    ok: false as const,
    error: "The saved sign-in surface changed. Finish sign-in on the website.",
  };
  try {
    const binding = await locator.evaluate(
      (element, expected) => {
        const button = element as HTMLButtonElement;
        const form = button.form;
        const visible = (item: HTMLElement) =>
          !!item.getClientRects().length &&
          getComputedStyle(item).visibility !== "hidden";
        const label =
          element.getAttribute("aria-label") ??
          (element instanceof HTMLInputElement
            ? element.value
            : element.textContent) ??
          "";
        const stamp =
          window.top === window
            ? null
            : { origin: location.origin, pathname: location.pathname };
        if (
          !form ||
          !visible(button) ||
          button.matches(":disabled,[aria-disabled=true]") ||
          !/^(?:sign\s?in|log\s?in|login)$/iu.test(label.trim()) ||
          JSON.stringify(stamp) !== JSON.stringify(expected.frame) ||
          location.origin !== expected.origin ||
          new URL(form.action).origin !== expected.origin ||
          (button.hasAttribute("formaction") &&
            new URL(button.formAction).origin !== expected.origin)
        )
          return null;
        const passwords = [
          ...form.querySelectorAll<HTMLInputElement>('input[type="password"]'),
        ].filter(visible);
        if (
          passwords.length !== 1 ||
          !passwords[0]!.value ||
          passwords[0]!.disabled ||
          passwords[0]!.autocomplete === "new-password" ||
          form.querySelector(
            '[autocomplete="one-time-code"], [autocomplete="new-password"], input[type="file"]',
          )
        )
          return null;
        const actions = [
          ...form.querySelectorAll<HTMLElement>(
            'button,input[type="submit"],[role="button"]',
          ),
        ];
        if (
          actions.some((item) => {
            if (!visible(item)) return false;
            const text =
              item instanceof HTMLInputElement
                ? item.value
                : (item.textContent ?? "");
            // Sending wording refuses in any control. Account-creation
            // wording refuses unless the control is an explicit non-submitting
            // button: a "Create Account" alternative beside the exact Sign In
            // is navigation, not a second way to submit this form.
            return (
              /\b(?:submit|send|apply|finish|complete)\b/iu.test(text) ||
              (/\b(?:create|register|sign\s?up)\b/iu.test(text) &&
                !(item instanceof HTMLButtonElement && item.type === "button"))
            );
          })
        )
          return null;
        form.dataset.nestorScriptLogin = expected.token;
        button.dataset.nestorScriptLogin = expected.token;
        const endpoint = new URL(
          button.hasAttribute("formaction") ? button.formAction : form.action,
        );
        return { formAction: endpoint.origin + endpoint.pathname };
      },
      { frame: input.frame, origin: new URL(url).origin, token },
    );
    if (!binding || signal?.aborted) return denied;
    let documentChanged = false;
    const loaded = () => {
      documentChanged = true;
    };
    page.on("domcontentloaded", loaded);
    removeLoaded = () => page.off("domcontentloaded", loaded);
    const frameUrl = owningFrame.url();
    close = await openPrepareOnlyProviderWriteWindow(page, {
      origins: [new URL(url).origin],
      disclosableValues: input.identifier ? [input.identifier] : [],
      active: () =>
        !signal?.aborted &&
        !documentChanged &&
        !page.isClosed() &&
        page.url() === url &&
        owningFrame.url() === frameUrl,
      login: { frame: owningFrame, formAction: binding.formAction, token },
    });
    const revoke = () => {
      void close?.();
    };
    signal?.addEventListener("abort", revoke, { once: true });
    try {
      signal?.throwIfAborted();
      await click();
      // The window belongs to this press, not to the site's origin. Give its
      // bounded asynchronous handler time to answer before revoking it.
      await owningFrame
        .waitForFunction(
          () =>
            ![
              ...document.querySelectorAll<HTMLInputElement>(
                'input[type="password"]',
              ),
            ].some((item) => item.getClientRects().length),
          undefined,
          { timeout: 10_000 },
        )
        .catch(() => undefined);
      await page
        .waitForLoadState("networkidle", { timeout: 1500 })
        .catch(() => undefined);
      signal?.throwIfAborted();
      return {
        ok: true,
        observedValue:
          "Pressed the saved-account sign-in control; completion is not verified.",
      };
    } finally {
      signal?.removeEventListener("abort", revoke);
      page.off("domcontentloaded", loaded);
    }
  } catch {
    return denied;
  } finally {
    removeLoaded?.();
    await close?.();
    // The successful handler can remove its button/form. Never wait for that
    // stale ref during cleanup; remove only this press's marks in its frame.
    await owningFrame
      .evaluate((expected) => {
        for (const element of document.querySelectorAll<HTMLElement>(
          "[data-nestor-script-login]",
        ))
          if (element.dataset.nestorScriptLogin === expected)
            delete element.dataset.nestorScriptLogin;
      }, token)
      .catch(() => undefined);
  }
}
