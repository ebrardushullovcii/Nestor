export const modelApiModes = ["responses", "chat_completions"] as const;
export type ModelApiMode = (typeof modelApiModes)[number];

export const modelReasoningEfforts = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ModelReasoningEffort = (typeof modelReasoningEfforts)[number];

export const DEFAULT_OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
// Product routes on OpenCode Go: Muse Spark 1.3 at xhigh for every text and
// vision task, DeepSeek V4.1 Flash at high only for aggressive resume
// tailoring. Model ids are verified against /models on the gateway.
export const DEFAULT_TEXT_MODEL = "muse-spark-1.3-contributor";
export const DEFAULT_TEXT_MODEL_API_MODE: ModelApiMode = "responses";
export const DEFAULT_TEXT_MODEL_REASONING_EFFORT: ModelReasoningEffort =
  "xhigh";
export const DEFAULT_AGGRESSIVE_RESUME_MODEL = "deepseek-v4.1-flash";
export const DEFAULT_AGGRESSIVE_RESUME_MODEL_API_MODE: ModelApiMode =
  "chat_completions";
export const DEFAULT_AGGRESSIVE_RESUME_MODEL_REASONING_EFFORT: ModelReasoningEffort =
  "high";
export const DEFAULT_VISION_MODEL = "muse-spark-1.3-contributor";
export const DEFAULT_VISION_MODEL_API_MODE: ModelApiMode = "responses";
export const DEFAULT_VISION_MODEL_REASONING_EFFORT: ModelReasoningEffort =
  "xhigh";

export type CompatibleMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
  /** DeepSeek thinking-mode continuation, sent back on later tool turns. */
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
};

export type CompatibleTool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: unknown;
  };
};

export type ModelUsagePayload = {
  prompt_tokens?: number | undefined;
  completion_tokens?: number | undefined;
  prompt_tokens_details?: { cached_tokens?: number | undefined } | undefined;
  completion_tokens_details?:
    | { reasoning_tokens?: number | undefined }
    | undefined;
  /** DeepSeek reports cache hits under its own names. */
  prompt_cache_hit_tokens?: number | undefined;
};

export type ChatCompletionsPayload = {
  usage?: ModelUsagePayload;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
  error?: { message?: string };
};

export type ResponsesPayload = {
  output?: Array<{
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  output_text?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  status?: string;
  error?: { message?: string };
};

function isTextContentPart(value: unknown): value is { text: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string",
  );
}

function extractContentString(rawContent: unknown): string {
  if (typeof rawContent === "string") {
    return rawContent;
  }

  if (Array.isArray(rawContent)) {
    return rawContent
      .flatMap((entry) => {
        if (typeof entry === "string") {
          return [entry];
        }
        if (isTextContentPart(entry)) {
          return [entry.text];
        }
        return [];
      })
      .join("\n");
  }

  return "";
}

function extractJsonString(rawContent: string): string {
  const fencedMatches = [
    ...rawContent.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi),
  ]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));

  for (const candidate of fencedMatches) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Keep scanning fenced blocks until one parses as JSON.
    }
  }

  if (fencedMatches[0]) {
    return fencedMatches[0];
  }

  const firstBraceIndex = rawContent.indexOf("{");
  const firstBracketIndex = rawContent.indexOf("[");
  const startsWithArray =
    firstBracketIndex >= 0 &&
    (firstBraceIndex < 0 || firstBracketIndex < firstBraceIndex);

  if (startsWithArray) {
    const lastBracketIndex = rawContent.lastIndexOf("]");
    if (lastBracketIndex > firstBracketIndex) {
      return rawContent.slice(firstBracketIndex, lastBracketIndex + 1);
    }
  }

  const lastBraceIndex = rawContent.lastIndexOf("}");
  if (firstBraceIndex >= 0 && lastBraceIndex > firstBraceIndex) {
    return rawContent.slice(firstBraceIndex, lastBraceIndex + 1);
  }

  return rawContent.trim();
}

function normalizeResponsesPayload(
  payload: ResponsesPayload,
): ChatCompletionsPayload {
  const content =
    payload.output_text?.trim() ||
    payload.output
      ?.flatMap((item) =>
        item.type === "message"
          ? (item.content ?? []).flatMap((part) =>
              typeof part.text === "string" ? [part.text] : [],
            )
          : [],
      )
      .join("\n") ||
    undefined;
  const toolCalls = payload.output?.flatMap((item) => {
    if (
      item.type !== "function_call" ||
      typeof item.call_id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.arguments !== "string"
    ) {
      return [];
    }

    return [
      {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      },
    ];
  });

  return {
    choices: [
      {
        message: {
          ...(content ? { content } : {}),
          ...(toolCalls && toolCalls.length > 0
            ? { tool_calls: toolCalls }
            : {}),
        },
        ...(payload.status ? { finish_reason: payload.status } : {}),
      },
    ],
    ...(payload.usage
      ? {
          usage: {
            prompt_tokens: payload.usage.input_tokens,
            completion_tokens: payload.usage.output_tokens,
            prompt_tokens_details: {
              cached_tokens: payload.usage.input_tokens_details?.cached_tokens,
            },
            completion_tokens_details: {
              reasoning_tokens:
                payload.usage.output_tokens_details?.reasoning_tokens,
            },
          },
        }
      : {}),
    ...(payload.error ? { error: payload.error } : {}),
  };
}

/** Normalizes either API's JSON body into the Chat Completions shape. */
export function normalizeModelPayload(
  rawPayload: ChatCompletionsPayload | ResponsesPayload,
  apiMode: ModelApiMode,
): ChatCompletionsPayload {
  return apiMode === "responses"
    ? normalizeResponsesPayload(rawPayload as ResponsesPayload)
    : (rawPayload as ChatCompletionsPayload);
}

/** Reads the JSON object the model was asked to return from a normalized payload. */
export function extractModelJsonFromPayload(
  payload: ChatCompletionsPayload,
): unknown {
  const rawContent = extractContentString(
    payload.choices?.[0]?.message?.content,
  );
  const jsonString = extractJsonString(rawContent);

  try {
    return JSON.parse(jsonString) as unknown;
  } catch (error) {
    throw new Error(
      `Model returned invalid JSON: ${error instanceof Error ? error.message : "Unknown parse error"}`,
    );
  }
}

async function parseNormalizedPayload(
  response: Response,
  apiMode: ModelApiMode,
): Promise<ChatCompletionsPayload> {
  const rawBody = await response.text();
  let rawPayload: ChatCompletionsPayload | ResponsesPayload | null = null;

  if (rawBody.length > 0) {
    try {
      rawPayload = JSON.parse(rawBody) as
        | ChatCompletionsPayload
        | ResponsesPayload;
    } catch {
      rawPayload = null;
    }
  }

  if (!response.ok) {
    throw new Error(
      rawPayload?.error?.message ??
        `Model request failed with status ${response.status}`,
    );
  }

  if (!rawPayload) {
    throw new Error("Model returned a non-JSON response");
  }

  return normalizeModelPayload(rawPayload, apiMode);
}

export async function parseModelJsonResponse(
  response: Response,
  apiMode: ModelApiMode = "chat_completions",
): Promise<unknown> {
  const payload = await parseNormalizedPayload(response, apiMode);
  return extractModelJsonFromPayload(payload);
}

export async function parseResponsePayload(
  response: Response,
  apiMode: ModelApiMode = "chat_completions",
): Promise<ChatCompletionsPayload> {
  return parseNormalizedPayload(response, apiMode);
}

function toResponsesContent(rawContent: unknown): unknown {
  if (!Array.isArray(rawContent)) {
    return rawContent;
  }

  const content: unknown[] = [];
  for (const part of rawContent as unknown[]) {
    if (!part || typeof part !== "object") {
      continue;
    }

    if (
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      content.push({ type: "input_text", text: part.text });
      continue;
    }

    if (
      "type" in part &&
      part.type === "image_url" &&
      "image_url" in part &&
      part.image_url &&
      typeof part.image_url === "object" &&
      "url" in part.image_url &&
      typeof part.image_url.url === "string"
    ) {
      content.push({
        type: "input_image",
        image_url: part.image_url.url,
        ...("detail" in part.image_url &&
        typeof part.image_url.detail === "string"
          ? { detail: part.image_url.detail }
          : {}),
      });
    }
  }

  return content;
}

function toResponsesInput(messages: readonly CompatibleMessage[]): unknown[] {
  return messages.flatMap((message) => {
    if (message.role === "tool") {
      return message.tool_call_id
        ? [
            {
              type: "function_call_output",
              call_id: message.tool_call_id,
              output: extractContentString(message.content),
            },
          ]
        : [];
    }

    const items: unknown[] = [];
    const content = toResponsesContent(message.content);
    if (
      (typeof content === "string" && content.length > 0) ||
      (Array.isArray(content) && content.length > 0)
    ) {
      items.push({ role: message.role, content });
    }

    for (const toolCall of message.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      });
    }

    return items;
  });
}

export function buildModelRequestBody(input: {
  apiMode: ModelApiMode;
  model: string;
  reasoningEffort?: ModelReasoningEffort | undefined;
  /** Set only by callers whose model route supports sampling controls. */
  temperature?: number | undefined;
  messages: readonly CompatibleMessage[];
  jsonOutput?: boolean;
  /** Responses only; callers must verify strict schema support on the route. */
  jsonSchema?: { name: string; schema: Record<string, unknown> } | undefined;
  tools?: readonly CompatibleTool[];
  maxOutputTokens?: number | undefined;
  parallelToolCalls?: boolean | undefined;
  /**
   * Ask the Responses API for reasoning summaries. The text is ignored; the
   * summary events are what keep a streamed request visibly alive while the
   * model thinks for minutes (verified against OpenCode Go: one summary every
   * 4–15s, versus total silence without it).
   */
  reasoningSummary?: boolean | undefined;
  /** Chat Completions only: ask for a usage chunk at the end of a stream. */
  includeStreamUsage?: boolean | undefined;
}): Record<string, unknown> {
  if (input.apiMode === "chat_completions") {
    return {
      ...(input.includeStreamUsage
        ? { stream_options: { include_usage: true } }
        : {}),
      model: input.model,
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : !input.reasoningEffort
          ? { temperature: 0.2 }
          : {}),
      ...(input.reasoningEffort
        ? {
            reasoning_effort: input.reasoningEffort,
          }
        : {}),
      ...(input.jsonOutput ? { response_format: { type: "json_object" } } : {}),
      messages: input.messages,
      ...(input.tools && input.tools.length > 0
        ? {
            tools: input.tools,
            tool_choice: "auto",
            ...(input.parallelToolCalls === undefined
              ? {}
              : { parallel_tool_calls: input.parallelToolCalls }),
          }
        : {}),
      ...(typeof input.maxOutputTokens === "number"
        ? { max_tokens: input.maxOutputTokens }
        : {}),
    };
  }

  return {
    model: input.model,
    store: false,
    ...(input.temperature !== undefined
      ? { temperature: input.temperature }
      : {}),
    reasoning: {
      effort: input.reasoningEffort ?? DEFAULT_VISION_MODEL_REASONING_EFFORT,
      ...(input.reasoningSummary ? { summary: "auto" } : {}),
    },
    input: toResponsesInput(input.messages),
    ...(input.jsonSchema
      ? {
          text: {
            format: { type: "json_schema", strict: true, ...input.jsonSchema },
          },
        }
      : input.jsonOutput
        ? { text: { format: { type: "json_object" } } }
        : {}),
    ...(input.tools && input.tools.length > 0
      ? {
          tools: input.tools.map((tool) => ({
            type: "function",
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
          })),
          tool_choice: "auto",
          ...(input.parallelToolCalls === undefined
            ? {}
            : { parallel_tool_calls: input.parallelToolCalls }),
        }
      : {}),
    ...(typeof input.maxOutputTokens === "number"
      ? { max_output_tokens: input.maxOutputTokens }
      : {}),
  };
}

export function parseModelApiMode(
  value: string | undefined,
): ModelApiMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return modelApiModes.find((mode) => mode === normalized);
}

export function parseModelReasoningEffort(
  value: string | undefined,
): ModelReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase();
  return modelReasoningEfforts.find((effort) => effort === normalized);
}

/**
 * Work whose reasoning effort is chosen on its own. The resume writer keeps
 * the client's main effort; the rest run many times per search or form and
 * think less. A request without a task uses the client's agent effort.
 */
export const modelReasoningTasks = [
  "resume_writer",
  "resume_import",
  "listing_read",
  "search",
  "page_read",
  "fit_batch",
  "listing_screen",
  "claim_check",
  "apply",
] as const;
export type ModelReasoningTask = (typeof modelReasoningTasks)[number];

/**
 * Product defaults and env overrides per task. Search turns, page reads and
 * form turns are short "what next / what is on this page" decisions: low.
 * Fit batches and fact checks are verdicts that stand without a rule
 * recomputing them (ADR 0041): medium. A full listing read keeps the main
 * effort unless its own variable says otherwise. Muse resume writing uses
 * medium unless its task effort is explicitly overridden.
 */
const TASK_REASONING_EFFORT_SETTINGS: Record<
  ModelReasoningTask,
  { env: string; fallback: ModelReasoningEffort | null }
> = {
  resume_writer: {
    env: "NESTOR_AI_RESUME_WRITER_REASONING_EFFORT",
    fallback: null,
  },
  // Reading a resume into typed candidates is extraction: the document is
  // the answer, so it thinks at low effort like the other read tasks.
  resume_import: {
    env: "NESTOR_AI_RESUME_IMPORT_REASONING_EFFORT",
    fallback: "low",
  },
  listing_read: {
    env: "NESTOR_AI_LISTING_READ_REASONING_EFFORT",
    fallback: null,
  },
  search: { env: "NESTOR_AI_SEARCH_REASONING_EFFORT", fallback: "low" },
  page_read: { env: "NESTOR_AI_PAGE_READ_REASONING_EFFORT", fallback: "low" },
  fit_batch: { env: "NESTOR_AI_FIT_REASONING_EFFORT", fallback: "medium" },
  // Which job-board listings are worth keeping, from title and place only.
  listing_screen: {
    env: "NESTOR_AI_LISTING_SCREEN_REASONING_EFFORT",
    fallback: "low",
  },
  claim_check: {
    env: "NESTOR_AI_CLAIM_CHECK_REASONING_EFFORT",
    fallback: "medium",
  },
  apply: { env: "NESTOR_AI_APPLY_REASONING_EFFORT", fallback: "low" },
};

export function resolveTaskReasoningEffortsFromEnvironment(
  env: Record<string, string | undefined>,
): Partial<Record<ModelReasoningTask, ModelReasoningEffort>> {
  const efforts: Partial<Record<ModelReasoningTask, ModelReasoningEffort>> = {};
  for (const [task, setting] of Object.entries(
    TASK_REASONING_EFFORT_SETTINGS,
  ) as [
    ModelReasoningTask,
    { env: string; fallback: ModelReasoningEffort | null },
  ][]) {
    const effort =
      parseModelReasoningEffort(env[setting.env]) ?? setting.fallback;
    if (effort) efforts[task] = effort;
  }
  return efforts;
}

export function buildModelUrl(baseUrl: string, apiMode: ModelApiMode): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(
    apiMode === "responses" ? "responses" : "chat/completions",
    normalizedBaseUrl,
  ).toString();
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  return buildModelUrl(baseUrl, "chat_completions");
}

export function buildAudioTranscriptionsUrl(baseUrl: string): string {
  const normalizedBaseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL("audio/transcriptions", normalizedBaseUrl).toString();
}
