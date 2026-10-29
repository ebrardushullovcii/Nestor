import type { ApplyFormObservation } from "./apply/types";

const GOOGLE_BUTTON =
  /^(?:(?:continue|sign\s?in|log\s?in|sign\s?up|register)\s+(?:with|using)\s+)?google(?:\s+account)?$/iu;
const ACCOUNT_EMAIL = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;

export function isGoogleAccountPage(
  page: Pick<ApplyFormObservation, "url">,
): boolean {
  if (!/accounts\.google\.com/iu.test(page.url ?? "")) return false;
  try {
    return new URL(page.url ?? "").hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

/** Google is a provider opt-in, including when its button registers a site account. */
export function googleSignInInteraction(
  page: ApplyFormObservation,
  ref: string | undefined,
): "googleSignIn" | "google_handoff" | null {
  const items = [...page.actions, ...page.links, ...page.clickables].filter(
    (item) => item.visible && !("disabled" in item && item.disabled),
  );
  const item = items.find((entry) => entry.ref === ref);
  if (!isGoogleAccountPage(page))
    return item && GOOGLE_BUTTON.test(item.label.trim())
      ? "googleSignIn"
      : null;
  if (new URL(page.url!).origin !== "https://accounts.google.com")
    return "google_handoff";

  // Only an unambiguous, already signed-in account can be selected. Google
  // credentials, account creation and OAuth permission/consent pages stay human.
  const choosing = page.headings.some((heading) =>
    /\bchoose an? account\b/iu.test(heading.text),
  );
  const accounts = new Map(
    items
      .filter((entry) => ACCOUNT_EMAIL.test(entry.label))
      .map((entry) => [entry.ref, entry]),
  );
  return choosing && accounts.size === 1 && item && accounts.has(item.ref)
    ? "googleSignIn"
    : "google_handoff";
}

export function hasGoogleSignInAction(page: ApplyFormObservation): boolean {
  return [...page.actions, ...page.links, ...page.clickables].some(
    (item) =>
      item.visible &&
      googleSignInInteraction(page, item.ref) === "googleSignIn",
  );
}
