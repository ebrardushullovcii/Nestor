import type { ConversationModel } from "@nestor/agent-runtime";
import type { AssistantModelRoute } from "@nestor/ai-providers";

import { createScriptedAssistantModel } from "./scripted-model";
import type { AssistantModelHandle } from "./session-host";

/**
 * Adapts a configured route to the conversation loop. One conversation key is
 * sent on every call of a conversation, so the provider can cache its prefix
 * and attribute the work. An explicitly configured fallback route takes over
 * a call the primary route failed; private continuation stays on the route
 * that produced it.
 */
export function createAssistantModelHandle(
  route: AssistantModelRoute,
  fallback: AssistantModelRoute | null = null,
): AssistantModelHandle {
  const callRoute =
    (
      target: AssistantModelRoute,
      conversationId: string,
    ): ConversationModel["chatWithTools"] =>
    (messages, tools, options) =>
      target.client.chatWithTools(messages, tools, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.maxOutputTokens
          ? { maxOutputTokens: options.maxOutputTokens }
          : {}),
        ...(options?.onStreamEvent
          ? { onStreamEvent: options.onStreamEvent }
          : {}),
        conversationKey: `assistant:${conversationId}`,
      });
  return {
    name: route.model,
    scripted: false,
    capabilities: {
      contextWindowTokens: route.capabilities.contextWindowTokens,
      maxOutputTokens: route.capabilities.maxOutputTokens,
      images: route.capabilities.images,
    },
    createModel(conversationId) {
      const primary = callRoute(route, conversationId);
      const secondary = fallback ? callRoute(fallback, conversationId) : null;
      return {
        async chatWithTools(messages, tools, options) {
          try {
            return await primary(messages, tools, options);
          } catch (error) {
            if (!secondary || options?.signal?.aborted) throw error;
            if (error instanceof Error && error.name === "AbortError")
              throw error;
            return secondary(messages, tools, options);
          }
        },
      };
    },
    async summarize(conversationId, prompt) {
      const result = await route.client.chatWithTools(
        [
          {
            role: "system",
            content:
              "You write compact, exact JSON handoff summaries of conversations.",
          },
          { role: "user", content: prompt },
        ],
        [],
        {
          conversationKey: `assistant-summary:${conversationId}`,
          maxOutputTokens: 3_000,
        },
      );
      return result.content ?? "";
    },
  };
}

export function createScriptedAssistantModelHandle(
  options: { delayMs?: number; contextWindowTokens?: number } = {},
): AssistantModelHandle {
  return {
    name: "scripted-assistant",
    scripted: true,
    capabilities: {
      contextWindowTokens: options.contextWindowTokens ?? 64_000,
      maxOutputTokens: 4_000,
      images: false,
    },
    createModel: () =>
      createScriptedAssistantModel(
        options.delayMs !== undefined ? { delayMs: options.delayMs } : {},
      ),
    summarize: null,
  };
}
