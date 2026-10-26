import type { ApplyFormControl } from "./types";

// GitHub's own pages, not accounts: github.com/orgs/… names no person.
const RESERVED = new Set([
  "about",
  "apps",
  "collections",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "join",
  "login",
  "marketplace",
  "notifications",
  "orgs",
  "pricing",
  "pulls",
  "search",
  "settings",
  "sponsors",
  "topics",
  "trending",
]);

/**
 * The account a GitHub address belongs to. A repository address names its
 * owner first; `profileOnly` accepts only an address of the account itself,
 * for links that may point at someone else's repository.
 */
export function githubUsername(
  value: string | null | undefined,
  options: { profileOnly?: boolean } = {},
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(
      /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase()))
      return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const username = parts.at(0);
    if (
      !username ||
      (options.profileOnly && parts.length !== 1) ||
      RESERVED.has(username.toLowerCase()) ||
      !/^[a-z\d](?:[a-z\d-]{0,38})$/iu.test(username)
    )
      return null;
    return username;
  } catch {
    return null;
  }
}

const GITHUB = /\bgit\s?hub\b/iu;
const HANDLE_LABEL = /^(?:your\s+)?(?:git\s?hub\s+)?(?:user\s*name|handle)$/iu;
// Help text must ask for the handle ("Please provide your GitHub username",
// "Enter your handle", "Username only"); "Your username will be shown
// publicly" mentions one without asking for it.
const ASKS_HANDLE =
  /(?:^|[.!?;:(—–-]\s*)(?:please\s+)?(?:(?:enter|provide|type|add|share|give|include|fill\s+in|put|list)\s+(?:in\s+)?(?:your\s+|the\s+)?(?:git\s?hub\s+)?(?:user\s*name|handle)|what(?:\s+is|['’]s)\s+(?:your\s+|the\s+)?(?:git\s?hub\s+)?(?:user\s*name|handle)|(?:your\s+)?(?:git\s?hub\s+)?(?:user\s*name|handle)\s+only|just\s+(?:the|your)\s+(?:git\s?hub\s+)?(?:user\s*name|handle))\b/iu;
// In a label, "GitHub profile" asks for the address too.
const ADDRESS =
  /\b(?:url|link|address|website|https?|profile)\b|\b[a-z\d-]+\.com\b/iu;
// A complete handle-only instruction may say "username only, no URL".
// Do not remove negation from arbitrary prose: "do not submit without a URL"
// requests an address, and every other address mention still vetoes conversion.
const HANDLE_ONLY_NO_ADDRESS =
  /^(?:(?:your\s+)?(?:git\s?hub\s+)?(?:user\s*name|handle)\s*\(\s*)?(?:(?:git\s?hub\s+)?(?:user\s*name|handle)\s+only|just\s+(?:the|your)\s+(?:git\s?hub\s+)?(?:user\s*name|handle))\s*[,;:-]\s*(?:no\s+url|not\s+a\s+link|without\s+the\s+url)\s*[).!]*$/iu;

export function fieldNamesAnotherPerson(
  control: Pick<
    ApplyFormControl,
    "label" | "groupLabel" | "placeholder" | "hint"
  >,
): boolean {
  return /\b(?:references?|referees?|emergency contacts?|another person|other person|someone else|spouse|partner)\b/iu.test(
    `${control.groupLabel} ${control.label} ${control.hint ?? ""} ${control.placeholder}`,
  );
}

/**
 * Whether the field wants a GitHub handle rather than the profile address.
 * Its label, help text and placeholder instructions decide. An address
 * request anywhere vetoes conversion.
 */
export function asksGithubUsername(
  control: Pick<
    ApplyFormControl,
    "label" | "groupLabel" | "placeholder" | "hint"
  >,
): boolean {
  const clean = (text: string | undefined) => (text ?? "").trim();
  const label = clean(control.label);
  const hint = clean(control.hint);
  const placeholder = clean(control.placeholder);
  const instructions = [clean(control.groupLabel), label, hint, placeholder];
  if (fieldNamesAnotherPerson(control)) return false;
  if (![clean(control.groupLabel), label, hint].some((text) => GITHUB.test(text)))
    return false;
  if (
    instructions.some(
      (text) => ADDRESS.test(text) && !HANDLE_ONLY_NO_ADDRESS.test(text),
    )
  )
    return false;
  if (
    HANDLE_LABEL.test(clean(control.label).replace(/[\s*:?]+$/gu, "")) ||
    instructions.some((text) => ASKS_HANDLE.test(text))
  )
    return true;
  return HANDLE_LABEL.test(placeholder);
}

export function formatGithubAnswer(
  control: Pick<
    ApplyFormControl,
    "label" | "groupLabel" | "placeholder" | "hint"
  >,
  value: string,
): string {
  return asksGithubUsername(control)
    ? (githubUsername(value) ?? value.replace(/^@(?=[a-z\d-]+$)/iu, ""))
    : value;
}
