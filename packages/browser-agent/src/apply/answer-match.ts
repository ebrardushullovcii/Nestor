import { parseToolArguments } from "@nestor/agent-runtime";
import type { LLMClient } from "../agent/contracts";
import type { ClassifiedAnswerSource } from "./answer-source-catalog";
import type { ApplyFormControl } from "./types";

export const semanticAnswerKey = (
  control: ApplyFormControl,
  value: string,
): string =>
  JSON.stringify([
    control.ref,
    control.scopeKey,
    control.rowScopeKey,
    control.groupLabel,
    control.label,
    control.repeatedQuestion,
    value,
  ]);

/** One bounded proposal, followed by the ordinary policy and write verification. */
export async function matchApplicationAnswer(input: {
  client: LLMClient;
  question: string;
  sources: readonly ClassifiedAnswerSource[];
  rejection: string | null;
  signal?: AbortSignal;
}): Promise<{ sourceId: string; value: string } | null> {
  const sources = input.sources.filter(
    (source) => source.purpose !== "context" && source.value.length <= 4000,
  );
  const response = await input.client.chatWithTools(
    [
      {
        role: "system",
        content:
          "Find an existing answer to the whole application question. Select one supplied source only. Preserve its meaning, country, conditions and negations. A layout/wording rejection is a candidate to reconsider, never permission to invent facts. Unknown age, relocation, preferences, credentials and personal declarations stay unknown. Report null when no source answers the whole question. Your proposal still goes through grounding, permission and page verification.",
      },
      {
        role: "user",
        content: JSON.stringify({
          question: input.question,
          priorRejection: input.rejection,
          sources,
        }),
      },
    ],
    [
      {
        type: "function",
        function: {
          name: "match_application_answer",
          description: "Propose an existing source for this question, or null.",
          parameters: {
            type: "object",
            properties: {
              sourceId: { type: ["string", "null"] },
              answer: { type: ["string", "null"] },
            },
            required: ["sourceId", "answer"],
          },
        },
      },
    ],
    {
      reasoningTask: "apply",
      maxOutputTokens: 800,
      signal: input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    },
  );
  const call = response.toolCalls?.find(
    (entry) => entry.function.name === "match_application_answer",
  );
  const args = call ? parseToolArguments(call.function.arguments) : null;
  return typeof args?.sourceId === "string" &&
    typeof args.answer === "string" &&
    sources.some((source) => source.id === args.sourceId) &&
    args.answer.trim() &&
    args.answer.length <= 8000
    ? { sourceId: args.sourceId, value: args.answer }
    : null;
}
