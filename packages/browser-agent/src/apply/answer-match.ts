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
  options?: readonly string[];
  sources: readonly ClassifiedAnswerSource[];
  rejection: string | null;
  signal?: AbortSignal;
}): Promise<{ sourceId: string; value: string } | null> {
  const sources = input.sources.filter(
    (source) => source.purpose !== "context",
  );
  const response = await input.client.chatWithTools(
    [
      {
        role: "system",
        content:
          "Find an existing answer to the whole application question. Select one supplied source only. Map its meaning to the actual target options, even when labels or control types differ. Return actual option labels, or a JSON array string for a complete multiple selection. Preserve its meaning, country, conditions and negations. For free text keep the person's words unchanged. A wording rejection is a candidate to reconsider, never permission to invent facts. Approved declaration authority permits only its named consent or acknowledgement, never a new personal fact. Unknown age, relocation, preferences, credentials and personal facts stay unknown. Report null when no source answers the whole question. Your proposal still goes through grounding, permission and page verification.",
      },
      {
        role: "user",
        content: JSON.stringify({
          question: input.question,
          options: input.options ?? [],
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
