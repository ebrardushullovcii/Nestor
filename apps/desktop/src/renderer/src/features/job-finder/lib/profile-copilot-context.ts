import type { ProfileCopilotContext } from "@nestor/contracts";

export function getProfileCopilotContextKey(
  context: ProfileCopilotContext,
): string {
  if (context.surface === "setup") {
    return `setup:${context.step}`;
  }

  if (context.surface === "profile") {
    return `profile:${context.section}`;
  }

  return "general";
}
