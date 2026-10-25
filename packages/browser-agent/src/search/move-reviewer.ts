import { parseToolArguments } from "@nestor/agent-runtime";

import type { LLMClient } from "../agent/contracts";
import type { AgentConfig } from "../types";

/** The search or source-check goal, for the reviewer. */
export function describeSearchGoal(config: AgentConfig): string {
  const packet = config.promptContext.taskPacket;
  const searchIntent = config.promptContext.searchRequest?.intent.trim();
  return packet
    ? `Check ${config.promptContext.siteLabel} so a future search can use it well. The goal of the check: ${packet.phaseGoal}`
    : `Find ${config.retainAllFound ? "all suitable" : `up to ${config.targetJobCount}`} current job postings on ${config.promptContext.siteLabel} that fit roles ${config.searchPreferences.targetRoles.join(", ") || "not specified"} in ${config.searchPreferences.locations.join(", ") || "any location"}.${searchIntent ? ` The person asked for ${JSON.stringify(searchIntent)}.` : ""} ${
        config.promptContext.searchMode === "scale"
          ? "Find a broad pool of plausible jobs, including borderline possibilities."
          : "Keep only strong fits rather than filling the list."
      }`;
}

/**
 * The second opinion on leaving the site.
 *
 * A search run belongs to one site, but the way to a posting is often on
 * another: a board that links to the employer's page, a careers hub that
 * hands off to an applicant-tracking system. The agent may go, but only for
 * a reason it states, and only when a separate judgement finds that reason
 * fits the goal. The judge sees the goal, where the run is, where it wants
 * to go, and the reason; it answers once, with a verdict the agent reads.
 */

export interface MoveReview {
  allowed: boolean;
  verdict: string;
}

const DECIDE_TOOL = {
  type: "function" as const,
  function: {
    name: "decide",
    description: "Your decision about this move.",
    parameters: {
      type: "object" as const,
      properties: {
        allowed: { type: "boolean" },
        verdict: {
          type: "string",
          description:
            "One or two plain sentences the agent will read: why this is or is not a reasonable move for the goal.",
        },
      },
      required: ["allowed", "verdict"],
    },
  },
};

export function createMoveReviewer(input: {
  llmClient: LLMClient;
  /** What the run is for, in one or two sentences. */
  goal: string;
  /** The site the run lives on, in the person's words. */
  homeLabel: string;
  /** Hostnames that count as home. */
  homeHosts: readonly string[];
  signal?: AbortSignal;
}): (move: {
  url: string;
  reason: string;
  fromUrl: string | null;
}) => Promise<MoveReview> {
  const { goal } = input;

  return async (move) => {
    const messages = [
      {
        role: "system" as const,
        content: [
          "You review one proposed move by an agent working in a person's browser. The agent wants to leave the site the run is on. Decide whether that is a reasonable thing to do for the goal, judging only the reason it gave and the addresses involved.",
          "",
          "Allow a move when the reason is specific and the destination plausibly serves the goal: a posting's own page on the employer's site, an applicant-tracking system the listing hands off to, a careers hub the site points at, the employer's application form. Refuse when the reason is vague, when the destination has nothing to do with the goal (a search engine, a scraper or mirror of listings, a social network, an unrelated site), or when the reason describes signing in, creating an account, or getting around a check; those stay with the person whatever the reason.",
          "",
          "Answer with the decide tool only.",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: [
          `Goal: ${goal}`,
          `Home site: ${input.homeLabel} (${input.homeHosts.join(", ")})`,
          `The run is on: ${move.fromUrl ?? "unknown"}`,
          `It wants to go to: ${move.url}`,
          `Its reason: ${move.reason}`,
        ].join("\n"),
      },
    ];
    let response: Awaited<ReturnType<LLMClient["chatWithTools"]>>;
    try {
      response = await input.llmClient.chatWithTools(
        messages,
        [DECIDE_TOOL],
        input.signal ? { signal: input.signal } : {},
      );
    } catch (error) {
      if (
        (error instanceof DOMException && error.name === "AbortError") ||
        input.signal?.aborted
      ) {
        throw error;
      }
      return {
        allowed: false,
        verdict:
          "The review could not be made right now; stay on the site for this step and try again later if it still matters.",
      };
    }
    const call = (response.toolCalls ?? []).find(
      (entry) => entry.function.name === "decide",
    );
    if (!call) {
      return {
        allowed: false,
        verdict:
          "The review gave no decision, so the move stays refused for now.",
      };
    }
    const args = parseToolArguments(call.function.arguments);
    const verdict =
      typeof args.verdict === "string" && args.verdict.trim()
        ? args.verdict.trim()
        : args.allowed === true
          ? "The reason fits the goal."
          : "The reason does not fit the goal.";
    return { allowed: args.allowed === true, verdict };
  };
}
