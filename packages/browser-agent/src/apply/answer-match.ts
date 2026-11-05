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

export class AnswerMatchUnavailableError extends Error {
  constructor(readonly category: "output_limit" | "invalid_response") {
    super(`Nestor could not match this answer (${category}).`);
    this.name = "AnswerMatchUnavailableError";
  }
}

/** One proposal, with one larger retry for a truncated reasoning turn. */
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
  for (const maxOutputTokens of [4_000, 8_000]) {
    const response = await input.client.chatWithTools(
      [
        {
          role: "system",
          content:
            "Find an existing answer to the whole application question. Select one supplied source only. Map its meaning to the actual target options, even when labels or control types differ. Return actual option labels, or a JSON array string for a complete multiple selection. Preserve its meaning, country, conditions and negations. Preserve the person's words for personal narratives, opinions and explicit own-words requests. A supplied preference, factual declaration or numeric target may be expressed as a typed sentence or number with exactly the same meaning and units. A wording rejection is a candidate to reconsider, never permission to invent facts. Approved declaration authority permits only its named consent or acknowledgement, never a new personal fact. Unknown age, relocation, preferences, credentials and personal facts stay unknown. A short saved answer such as Yes, exactly this schedule confirms only the conditions actually stated in its saved question and answer. Never fill a gap in the source from the later target question, posting or legal work capacity. For example, confirmed weekly hours and dates do not confirm newly added weekdays, daily times or timezone. Reuse identical conditions; ask only for the added personal conditions. An explicit source exclusion can answer a more specific negative, such as no nights answering a proposed night shift. Report null when no source answers the whole question. Your proposal still goes through grounding, permission and page verification.",
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
            description:
              "Propose an existing source for this question, or null.",
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
        maxOutputTokens,
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      },
    );
    if (
      response.finishReason === "length" ||
      response.finishReason === "max_output_tokens"
    ) {
      if (maxOutputTokens === 4_000) continue;
      throw new AnswerMatchUnavailableError("output_limit");
    }
    const call = response.toolCalls?.find(
      (entry) => entry.function.name === "match_application_answer",
    );
    const args = call ? parseToolArguments(call.function.arguments) : null;
    if (args?.sourceId === null && args.answer === null) return null;
    if (
      !(
        typeof args?.sourceId === "string" &&
        typeof args.answer === "string" &&
        sources.some((source) => source.id === args.sourceId) &&
        args.answer.trim() &&
        args.answer.length <= 8000
      )
    )
      throw new AnswerMatchUnavailableError("invalid_response");
    return { sourceId: args.sourceId, value: args.answer };
  }
  throw new AnswerMatchUnavailableError("output_limit");
}
