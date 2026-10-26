import type { ApplyFormControl } from "./types";

export function githubUsername(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  try {
    const url = new URL(
      /^https?:\/\//iu.test(value) ? value : `https://${value}`,
    );
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase()))
      return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const username = parts.at(0);
    return parts.length === 1 && username && /^[a-z\d-]+$/iu.test(username)
      ? username
      : null;
  } catch {
    return null;
  }
}

export function asksGithubUsername(control: ApplyFormControl): boolean {
  const prompt = `${control.groupLabel} ${control.label}`;
  if (/\bgithub\b/iu.test(prompt) && /\b(?:user\s*name|handle)\b/iu.test(prompt))
    return true;
  const text = `${control.groupLabel} ${control.label} ${control.placeholder}`;
  return (
    /\bgithub\b/iu.test(text) &&
    /\b(?:user\s*name|handle)\b/iu.test(text) &&
    !/\b(?:url|link)\b/iu.test(text)
  );
}

export function formatGithubAnswer(
  control: ApplyFormControl,
  value: string,
): string {
  return asksGithubUsername(control)
    ? (githubUsername(value) ?? value.replace(/^@(?=[a-z\d-]+$)/iu, ""))
    : value;
}
