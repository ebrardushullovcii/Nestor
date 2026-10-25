import type { ActionState } from "@renderer/features/job-finder/lib/job-finder-types";

const NEWS = new Set([
  "Application tracker updated.",
  "Activity resumed.",
  "Activity paused.",
]);
export function isActionNews(message: string | null): boolean {
  return message !== null && NEWS.has(message);
}

/**
 * Screens whose finished actions are reported with a toast instead of a box
 * above their list (ADR 0042, ADR 0044).
 */
const SUCCESS_TOAST_ROUTES = [
  "/job-finder/applications",
  "/job-finder/discovery",
] as const;

/**
 * A route action message becomes a toast only when it says the action
 * succeeded, belongs to one of those screens, and names no saved file (a
 * file path keeps its inline "Open folder"). A failure, a message still in
 * progress and a message without a tone stay inline.
 */
export function isActionSuccessToast(
  state: ActionState,
  ownerPath: string | null,
): boolean {
  if (state.tone !== "success" || !state.message || state.savedFilePath) {
    return false;
  }
  if (!ownerPath) return false;
  return SUCCESS_TOAST_ROUTES.some(
    (route) =>
      ownerPath === route ||
      ownerPath.startsWith(`${route}/`) ||
      ownerPath.startsWith(`${route}?`),
  );
}
