import { asksGithubUsername } from "./github-username";
import type { ApplyFormControl } from "./types";

export function isProfileUrlSource(id: string | null | undefined): boolean {
  return !!id && /^profile\.(?:[a-zA-Z]+Url|links\.[^.]+)$/u.test(id);
}

export function wantsProfileUrl(control: ApplyFormControl): boolean {
  return (
    (control.kind === "text" || control.kind === "long_text") &&
    !asksGithubUsername(control) &&
    (control.urlInput === true ||
      /\b(?:url|website|portfolio|git\s?hub|linked\s?in|profile\s+link)\b/iu.test(
        `${control.label} ${control.hint ?? ""} ${control.placeholder}`,
      ))
  );
}

/** Add only the scheme. Never guess a host, account, path or missing username. */
export function fullProfileUrl(value: string): string | null {
  const address = value
    .trim()
    .replace(/^https?:\/\//iu, "")
    .replace(/^\/\//u, "");
  if (!address || /[\s\\]/u.test(address)) return null;
  const full = `https://${address}`;
  try {
    const url = new URL(full);
    if (!url.hostname.includes(".") || url.username || url.password)
      return null;
    return full;
  } catch {
    return null;
  }
}

export function formatProfileUrlAnswer(
  control: ApplyFormControl,
  value: string,
  sourceId: string | null | undefined,
): string {
  return isProfileUrlSource(sourceId) && wantsProfileUrl(control)
    ? (fullProfileUrl(value) ?? value)
    : value;
}
