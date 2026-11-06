import type { AgentConfig } from "../types";
import { searchSelectivity } from "./job-search-prompts";
export function describeSearchGoal(config: AgentConfig): string {
  if (config.inventoryOnly)
    return `Collect vacancy cards from ${config.promptContext.siteLabel} and its observed employer/ATS handoffs. Do not judge fit, location, seniority or preferences; the following engine steps do that.`;
  const packet = config.promptContext.taskPacket;
  const searchIntent = config.promptContext.searchRequest?.intent.trim();
  return packet
    ? `Check ${config.promptContext.siteLabel} so a future search can use it well. The goal of the check: ${packet.phaseGoal}`
    : `Find ${config.retainAllFound ? "all suitable" : `up to ${config.targetJobCount}`} current job postings on ${config.promptContext.siteLabel} that fit roles ${config.searchPreferences.targetRoles.join(", ") || "not specified"} in ${config.searchPreferences.locations.join(", ") || "any location"}.${searchIntent ? ` The person asked for ${JSON.stringify(searchIntent)}.` : ""} ${
        searchSelectivity(config) !== "best_matches"
          ? "Find a broad pool of plausible jobs, including borderline possibilities."
          : "Keep only strong fits rather than filling the list."
      }`;
}
