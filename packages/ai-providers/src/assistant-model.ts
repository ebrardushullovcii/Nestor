import { createOpenAiCompatibleJobFinderAiClient } from "./openai-compatible";
import {
  DEFAULT_OPENCODE_GO_BASE_URL,
  parseModelApiMode,
  parseModelReasoningEffort,
  type ModelApiMode,
  type ModelReasoningEffort,
} from "./openai-compatible-transport";
import {
  parseConfiguredBoolean,
  parseConfiguredPositiveInteger,
} from "./model-request-transport";
import type { AgentCapableJobFinderAiClient, StringMap } from "./shared";

/**
 * The assistant sidebar's model route (ADR 0037).
 *
 * The sidebar talks a lot and decides quickly, so it gets its own route with
 * low reasoning effort by default. Everything that shapes a request comes
 * from this table; prompts, tools and the UI never depend on a wire format.
 */

export const DEFAULT_ASSISTANT_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_ASSISTANT_API_MODE: ModelApiMode = "chat_completions";
export const DEFAULT_ASSISTANT_REASONING_EFFORT: ModelReasoningEffort = "low";
export const ALTERNATIVE_ASSISTANT_MODEL = "muse-spark-1.3-contributor";

export interface AssistantModelCapabilities {
  model: string;
  apiMode: ModelApiMode;
  tools: boolean;
  streaming: boolean;
  /** Tokens the route accepts, prompt and output together. */
  contextWindowTokens: number;
  /** Output reserved for one answer when budgeting the prompt. */
  maxOutputTokens: number;
  images: boolean;
  /** Private state that must return to the route on later tool turns. */
  continuation: "reasoning_content" | "none";
  /** True when the table knew the model; unknown models get the conservative row. */
  known: boolean;
}

const CAPABILITY_TABLE: Record<
  string,
  Omit<AssistantModelCapabilities, "model" | "known">
> = {
  "deepseek-v4.1-flash": {
    apiMode: "chat_completions",
    tools: true,
    streaming: true,
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_000,
    images: false,
    continuation: "reasoning_content",
  },
  "muse-spark-1.3-contributor": {
    apiMode: "responses",
    tools: true,
    streaming: true,
    contextWindowTokens: 196_000,
    maxOutputTokens: 12_000,
    images: true,
    continuation: "none",
  },
};

const CONSERVATIVE_ROW: Omit<AssistantModelCapabilities, "model" | "known"> = {
  apiMode: "chat_completions",
  tools: true,
  streaming: true,
  contextWindowTokens: 64_000,
  maxOutputTokens: 6_000,
  images: false,
  continuation: "none",
};

export function resolveAssistantModelCapabilities(input: {
  model: string;
  apiMode?: ModelApiMode | undefined;
  contextWindowTokens?: number | undefined;
  images?: boolean | undefined;
}): AssistantModelCapabilities {
  const row = CAPABILITY_TABLE[input.model];
  const base = row ?? CONSERVATIVE_ROW;
  return {
    ...base,
    model: input.model,
    apiMode: input.apiMode ?? base.apiMode,
    contextWindowTokens: input.contextWindowTokens ?? base.contextWindowTokens,
    images: input.images ?? base.images,
    known: row !== undefined,
  };
}

export interface AssistantModelRoute {
  model: string;
  apiMode: ModelApiMode;
  reasoningEffort: ModelReasoningEffort;
  capabilities: AssistantModelCapabilities;
  client: AgentCapableJobFinderAiClient;
}

export type AssistantModelRouteResolution =
  | {
      available: true;
      route: AssistantModelRoute;
      fallback: AssistantModelRoute | null;
    }
  | { available: false; detail: string };

/** The outage sentence: the model ships with the product, so this is never a setup task. */
export const ASSISTANT_MODEL_OUTAGE_DETAIL =
  "The assistant's AI service is not reachable right now. Your messages are kept; try again in a moment.";

function buildRoute(input: {
  env: StringMap;
  apiKey: string;
  model: string;
  apiMode: ModelApiMode;
  reasoningEffort: ModelReasoningEffort;
  contextWindowTokens: number | undefined;
}): AssistantModelRoute {
  const capabilities = resolveAssistantModelCapabilities({
    model: input.model,
    apiMode: input.apiMode,
    contextWindowTokens: input.contextWindowTokens,
  });
  const client = createOpenAiCompatibleJobFinderAiClient({
    apiKey: input.apiKey,
    baseUrl:
      input.env.NESTOR_AI_ASSISTANT_BASE_URL?.trim() ||
      input.env.NESTOR_AI_BASE_URL ||
      DEFAULT_OPENCODE_GO_BASE_URL,
    model: input.model,
    apiMode: input.apiMode,
    reasoningEffort: input.reasoningEffort,
    agentReasoningEffort: input.reasoningEffort,
    label: "Job Finder assistant",
    contextWindowTokens: capabilities.contextWindowTokens,
    requestTimeoutMs: parseConfiguredPositiveInteger(
      input.env.NESTOR_AI_ASSISTANT_TIMEOUT_MS,
      1_000,
    ),
    idleTimeoutMs: parseConfiguredPositiveInteger(
      input.env.NESTOR_AI_IDLE_TIMEOUT_MS,
      1_000,
    ),
    maxAttempts: parseConfiguredPositiveInteger(
      input.env.NESTOR_AI_MAX_ATTEMPTS,
    ),
    streaming: parseConfiguredBoolean(input.env.NESTOR_AI_STREAMING),
  });
  return {
    model: input.model,
    apiMode: input.apiMode,
    reasoningEffort: input.reasoningEffort,
    capabilities,
    client,
  };
}

/**
 * Reads `NESTOR_AI_ASSISTANT_MODEL`, `..._API_MODE`,
 * `..._REASONING_EFFORT` and `..._CONTEXT_WINDOW_TOKENS`, falling back to the
 * shared key and base URL. The default route is DeepSeek V4.1 Flash on Chat
 * Completions; Muse Spark Contributor on Responses is the alternative. A
 * fallback route is used only when `NESTOR_AI_ASSISTANT_FALLBACK_MODEL`
 * names one.
 */
export function resolveAssistantModelRouteFromEnvironment(
  env: StringMap = process.env,
): AssistantModelRouteResolution {
  const apiKey =
    env.NESTOR_AI_ASSISTANT_API_KEY?.trim() || env.NESTOR_AI_API_KEY?.trim();
  if (!apiKey) {
    return { available: false, detail: ASSISTANT_MODEL_OUTAGE_DETAIL };
  }
  const model =
    env.NESTOR_AI_ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
  const known = resolveAssistantModelCapabilities({ model });
  const apiMode =
    parseModelApiMode(env.NESTOR_AI_ASSISTANT_API_MODE) ??
    (model === DEFAULT_ASSISTANT_MODEL
      ? DEFAULT_ASSISTANT_API_MODE
      : known.apiMode);
  const reasoningEffort =
    parseModelReasoningEffort(env.NESTOR_AI_ASSISTANT_REASONING_EFFORT) ??
    DEFAULT_ASSISTANT_REASONING_EFFORT;
  const contextWindowTokens = parseConfiguredPositiveInteger(
    env.NESTOR_AI_ASSISTANT_CONTEXT_WINDOW_TOKENS,
    1_000,
  );
  const route = buildRoute({
    env,
    apiKey,
    model,
    apiMode,
    reasoningEffort,
    contextWindowTokens,
  });
  const fallbackModel = env.NESTOR_AI_ASSISTANT_FALLBACK_MODEL?.trim();
  const fallback =
    fallbackModel && fallbackModel !== model
      ? buildRoute({
          env,
          apiKey,
          model: fallbackModel,
          apiMode:
            parseModelApiMode(env.NESTOR_AI_ASSISTANT_FALLBACK_API_MODE) ??
            resolveAssistantModelCapabilities({ model: fallbackModel }).apiMode,
          reasoningEffort,
          contextWindowTokens: undefined,
        })
      : null;
  return { available: true, route, fallback };
}
