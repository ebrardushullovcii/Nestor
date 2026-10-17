import {
  BrowserSourceAccessProbeInputSchema,
  BrowserSourceAccessProbeResultSchema,
  type BrowserSourceAccessProbeInput,
  type BrowserSourceAccessProbeResult,
  type BrowserSourceAccessProbeSignal,
} from "@nestor/contracts";
import type { Page } from "playwright";

export type VisibleAccessSignals = {
  passwordControl: boolean;
  loginControl: boolean;
  captchaChallenge: boolean;
  mfaChallenge: boolean;
  signOutControl: boolean;
  accountMenuControl: boolean;
  profileControl: boolean;
};

function normalizeOrigin(value: string): string | null {
  try {
    return `${new URL(value).origin}/`;
  } catch {
    return null;
  }
}

/** A source access check must never borrow another open tab's account marker. */
export function selectUniqueSourceAccessPage<
  TPage extends Pick<Page, "url" | "isClosed">,
>(pages: readonly TPage[], expectedOrigin: string): TPage | null {
  const normalizedExpectedOrigin = normalizeOrigin(expectedOrigin);
  if (!normalizedExpectedOrigin) return null;
  const matches = pages.filter(
    (page) =>
      !page.isClosed() &&
      normalizeOrigin(page.url()) === normalizedExpectedOrigin,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function isAuthRoute(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:^|\/)(?:login|log-in|signin|sign-in|authenticate|authentication|session)(?:\/|$)/iu.test(
      url.pathname,
    );
  } catch {
    return false;
  }
}

function createResult(input: {
  state: BrowserSourceAccessProbeResult["state"];
  currentOrigin: string | null;
  signals: readonly BrowserSourceAccessProbeSignal[];
}): BrowserSourceAccessProbeResult {
  return BrowserSourceAccessProbeResultSchema.parse({
    state: input.state,
    checkedAt: new Date().toISOString(),
    currentOrigin: input.currentOrigin,
    signals: [...new Set(input.signals)],
  });
}

export function createInconclusiveSourceAccessProbeResult(
  input: BrowserSourceAccessProbeInput,
): BrowserSourceAccessProbeResult {
  BrowserSourceAccessProbeInputSchema.parse(input);
  return createResult({
    state: "inconclusive",
    currentOrigin: null,
    signals: [],
  });
}

/**
 * Reads what the page shows about signing in. Runs inside the page and is
 * self-contained, so a host that reads a tab without Playwright (the desktop
 * app's embedded browser) can run the same function in that exact tab.
 */
export function collectVisibleAccessSignals(): VisibleAccessSignals {
  const isVisible = (element: Element): boolean => {
    if (!(element instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity || "1") > 0 &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const labelFor = (element: Element): string =>
    [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("name"),
      element.getAttribute("placeholder"),
      element.getAttribute("alt"),
      element.textContent,
    ]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase();
  const controls = Array.from(
    document.querySelectorAll(
      'input, button, a, [role="button"], [role="link"], [role="menuitem"], iframe, [data-sitekey]',
    ),
  )
    .filter(isVisible)
    .slice(0, 1_000);
  const labels = controls.map((element) => ({
    element,
    label: labelFor(element),
  }));
  const hasLabel = (pattern: RegExp): boolean =>
    labels.some(({ label }) => pattern.test(label));
  const hasMenuLabel = (pattern: RegExp): boolean =>
    labels.some(
      ({ element, label }) =>
        pattern.test(label) &&
        (element.getAttribute("aria-haspopup") === "menu" ||
          element.getAttribute("role") === "menuitem" ||
          element.tagName === "BUTTON"),
    );

  return {
    passwordControl: controls.some(
      (element) =>
        element instanceof HTMLInputElement &&
        element.type.toLowerCase() === "password",
    ),
    loginControl: hasLabel(/\b(?:log[ -]?in|sign[ -]?in)\b/iu),
    captchaChallenge:
      controls.some((element) => {
        const source = element.getAttribute("src") ?? "";
        return /captcha|recaptcha|hcaptcha|turnstile/iu.test(source);
      }) ||
      hasLabel(/\b(?:captcha|verify you are human|human verification)\b/iu),
    mfaChallenge:
      controls.some(
        (element) =>
          element instanceof HTMLInputElement &&
          element.autocomplete === "one-time-code",
      ) ||
      hasLabel(
        /\b(?:verification code|security code|two-factor|2fa|one-time code)\b/iu,
      ),
    signOutControl: hasLabel(/\b(?:log[ -]?out|sign[ -]?out)\b/iu),
    accountMenuControl: hasMenuLabel(
      /\b(?:account menu|user menu|profile menu|my account)\b/iu,
    ),
    profileControl:
      hasLabel(/\b(?:my profile|view profile)\b/iu) ||
      hasMenuLabel(/\b(?:profile|user avatar|account avatar)\b/iu),
  };
}

async function inspectVisibleAccessSignals(
  page: Page,
): Promise<VisibleAccessSignals> {
  return page.evaluate(collectVisibleAccessSignals);
}

export async function inspectSourceAccessPage(
  page: Page,
  inputValue: BrowserSourceAccessProbeInput,
): Promise<BrowserSourceAccessProbeResult> {
  return classifySourceAccess({
    currentUrl: page.url(),
    input: inputValue,
    readSignals: () => inspectVisibleAccessSignals(page),
  });
}

/**
 * Classifies one page's access state from its address and what it shows.
 * `readSignals` is only called when the page is on the expected origin.
 */
export async function classifySourceAccess(options: {
  currentUrl: string;
  input: BrowserSourceAccessProbeInput;
  readSignals: () => Promise<VisibleAccessSignals>;
}): Promise<BrowserSourceAccessProbeResult> {
  const input = BrowserSourceAccessProbeInputSchema.parse(options.input);
  const expectedOrigin = normalizeOrigin(input.expectedOrigin);
  const currentUrl = options.currentUrl;
  const currentOrigin = normalizeOrigin(currentUrl);

  if (expectedOrigin === null || currentOrigin !== expectedOrigin) {
    return createResult({
      state: "blocked",
      currentOrigin,
      signals: ["origin_mismatch"],
    });
  }

  let visibleSignals: VisibleAccessSignals;
  try {
    visibleSignals = await options.readSignals();
  } catch {
    return createResult({
      state: "inconclusive",
      currentOrigin,
      signals: [],
    });
  }

  const signals: BrowserSourceAccessProbeSignal[] = [];
  if (isAuthRoute(currentUrl)) signals.push("auth_route");
  if (visibleSignals.passwordControl) signals.push("password_control");
  if (visibleSignals.loginControl) signals.push("login_control");
  if (visibleSignals.captchaChallenge) signals.push("captcha_challenge");
  if (visibleSignals.mfaChallenge) signals.push("mfa_challenge");
  if (visibleSignals.signOutControl) signals.push("sign_out_control");
  if (visibleSignals.accountMenuControl) signals.push("account_menu_control");
  if (visibleSignals.profileControl) signals.push("profile_control");

  const hasBlockingSignal = signals.some((signal) =>
    [
      "auth_route",
      "password_control",
      "captcha_challenge",
      "mfa_challenge",
    ].includes(signal),
  );
  const hasAuthenticatedSignal = signals.some((signal) =>
    ["sign_out_control", "account_menu_control", "profile_control"].includes(
      signal,
    ),
  );

  return createResult({
    state: hasBlockingSignal
      ? "blocked"
      : hasAuthenticatedSignal
        ? "authenticated"
        : "inconclusive",
    currentOrigin,
    signals,
  });
}
