import type { AiAccountNeed } from "@nestor/contracts";

const CAUSE: Record<AiAccountNeed["reason"], string> = {
  funding: "your AI account has run out of credit",
  authentication: "the AI service did not accept your API key",
  permission: "your API key has no access to the AI model",
};

const STEP: Record<AiAccountNeed["reason"], string> = {
  funding: "Top it up",
  authentication: "Fix the key",
  permission: "Give the key access",
};

/**
 * What a resume read the AI account refused tells the person. A refused
 * read looked like a resume problem ("could not be read", "the AI
 * connection failed"), while the file was fine and the step was theirs:
 * the account. The read waits on the account and runs again by itself.
 */
export function resumeReadRefusedMessage(need: AiAccountNeed): string {
  if (need.owner === "nestor")
    return "Nestor's AI service is paused, so your resume has not been read yet. It is read by itself when the service is back; what did import is saved.";
  return `Nestor's AI has not read your resume yet: ${CAUSE[need.reason]}. ${STEP[need.reason]} from Needs you, and the missing sections are read by themselves once the AI answers. What did import is saved.`;
}
