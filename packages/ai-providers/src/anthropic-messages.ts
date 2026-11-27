import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolResultBlockParam,
  BetaUsage,
  MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ModelOutputLimitError } from "@nestor/agent-runtime";
import type { ModelTurnStreamEvent } from "@nestor/agent-runtime";
import type { ModelImageInput } from "@nestor/contracts";
import { modelOutputLimit } from "./model-output-limit";
import type {
  ChatCompletionsPayload,
  CompatibleMessage,
  CompatibleTool,
  ModelReasoningEffort,
  ModelUsagePayload,
} from "./openai-compatible-transport";

/**
 * Anthropic's own Messages API, beside the OpenAI-compatible routes.
 *
 * Anthropic's OpenAI-compatible layer has no prompt caching, rejects JSON
 * mode, ignores effort and returns no thinking. This route speaks Messages
 * through the official SDK and hands the rest of the package the same
 * normalized Chat Completions payload every other route returns, so the
 * tools, facts and [AI usage] records stay the same.
 *
 * What the API requires and this file therefore does:
 * - Thinking is always on (adaptive); effort goes in `output_config`.
 * - The assistant's content blocks (thinking with its signature included)
 *   go back unchanged on later turns, carried as the message's continuation.
 * - Caching is explicit: one breakpoint closes tools + system, and on a
 *   conversation the automatic breakpoint follows its growing end.
 * - JSON with a schema uses `output_config.format`; JSON mode does not exist.
 * - A refusal is reported as such, after the server-side fallbacks the
 *   request opted into have also declined.
 */

export const ANTHROPIC_MESSAGES_BETAS = [
  // `fallbacks: "default"`: a policy decline is retried server-side on the
  // model the API routes that category to, inside the same request.
  "server-side-fallback-2026-07-01",
  // `prefix_mismatch_behavior: "drop_block"`: the agent loop sometimes folds
  // an old page view into a receipt (context-fold.ts). On accounts enforced
  // on preserved thinking that edit would turn every later request into a
  // 400; with drop_block the API drops the thinking after the edit instead.
  "thinking-binding-controls-2026-08-01",
] as const;

/**
 * Anthropic requires `max_tokens`. Send each model's published output limit
 * (https://platform.claude.com/docs/en/about-claude/models), thinking
 * included; an unlisted Claude route gets the SDK's streaming default.
 */
const MESSAGES_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  "claude-opus-5-5": 128_000,
  "claude-opus-5": 128_000,
  "claude-sonnet-5-5": 128_000,
  "claude-fable-5-2": 128_000,
  "claude-haiku-5-5": 128_000,
};
const DEFAULT_MESSAGES_MAX_TOKENS = 64_000;

/** Messages has no `none` effort; its lowest is `low`. */
function messagesEffort(
  effort: ModelReasoningEffort | undefined,
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!effort) return undefined;
  return effort === "none" ? "low" : effort;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function imageBlock(url: string): BetaImageBlockParam {
  const match = /^data:([^;,]+);base64,(.*)$/su.exec(url);
  if (match) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: match[1] as "image/png",
        data: match[2]!,
      },
    };
  }
  return { type: "image", source: { type: "url", url } };
}

function textBlocks(text: string): BetaTextBlockParam[] {
  return text.length > 0 ? [{ type: "text", text }] : [];
}

/** User or tool content: a string, or Chat Completions text/image parts. */
function userContentBlocks(
  content: unknown,
): Array<BetaTextBlockParam | BetaImageBlockParam> {
  if (typeof content === "string") return textBlocks(content);
  if (!Array.isArray(content)) return [];
  return (content as unknown[]).flatMap(
    (part): Array<BetaTextBlockParam | BetaImageBlockParam> => {
      if (typeof part === "string") return textBlocks(part);
      if (!isRecord(part)) return [];
      if (part.type === "text" && typeof part.text === "string")
        return textBlocks(part.text);
      if (
        part.type === "image_url" &&
        isRecord(part.image_url) &&
        typeof part.image_url.url === "string"
      )
        return [imageBlock(part.image_url.url)];
      return [];
    },
  );
}

function imageInputBlocks(
  images: readonly ModelImageInput[] | undefined,
): Array<BetaTextBlockParam | BetaImageBlockParam> {
  return (images ?? []).flatMap((image) => [
    ...textBlocks(image.label),
    imageBlock(image.dataUrl),
  ]);
}

function contentText(content: unknown): string {
  return userContentBlocks(content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}

function parseToolInput(argumentsText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (isRecord(parsed)) return parsed;
  } catch {
    // A tool call this route produced always carries an object.
  }
  return {};
}

/** Text and tool calls the app reads from a stored assistant turn. */
function assistantShape(message: {
  content: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
}): string {
  return JSON.stringify(message);
}

/**
 * The assistant turn as Anthropic produced it, thinking and signatures
 * included, when it still says what the app's transcript says; otherwise
 * rebuilt from the transcript (and its thinking is not replayed).
 */
function assistantContentBlocks(
  message: CompatibleMessage,
): BetaContentBlockParam[] {
  const text = contentText(message.content);
  const toolCalls = (message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: parseToolInput(call.function.arguments),
  }));
  const stored = message.anthropic_content;
  if (Array.isArray(stored) && stored.length > 0) {
    const blocks = stored.filter(isRecord);
    const storedText = blocks
      .flatMap((block) =>
        block.type === "text" && typeof block.text === "string"
          ? [block.text]
          : [],
      )
      .join("");
    const storedCalls = blocks.flatMap((block) =>
      block.type === "tool_use" &&
      typeof block.id === "string" &&
      typeof block.name === "string"
        ? [{ id: block.id, name: block.name, input: block.input }]
        : [],
    );
    if (
      assistantShape({ content: storedText, toolCalls: storedCalls }) ===
      assistantShape({ content: text, toolCalls })
    )
      return blocks as unknown as BetaContentBlockParam[];
  }
  return [
    ...textBlocks(text),
    ...toolCalls.map(
      (call): BetaContentBlockParam => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      }),
    ),
  ];
}

type BuiltMessage =
  | { role: "user" | "assistant"; content: BetaContentBlockParam[] }
  | { role: "system"; content: string };

function appendUserBlocks(
  messages: BuiltMessage[],
  blocks: BetaContentBlockParam[],
): void {
  if (blocks.length === 0) return;
  const last = messages.at(-1);
  if (last?.role === "user") last.content.push(...blocks);
  else messages.push({ role: "user", content: [...blocks] });
}

/**
 * Builds a Messages request from the app's message list. Leading system
 * messages become the top-level `system`; tool replies become `tool_result`
 * blocks in one user message, with their screenshots inside the result.
 */
export function buildMessagesRequestBody(input: {
  model: string;
  reasoningEffort?: ModelReasoningEffort | undefined;
  messages: readonly CompatibleMessage[];
  jsonSchema?: { name: string; schema: Record<string, unknown> } | undefined;
  tools?: readonly CompatibleTool[];
  parallelToolCalls?: boolean | undefined;
}): Record<string, unknown> {
  let leading = 0;
  while (input.messages[leading]?.role === "system") leading += 1;
  const system: BetaTextBlockParam[] = input.messages
    .slice(0, leading)
    .flatMap((message) => textBlocks(contentText(message.content)));
  const lastSystem = system.at(-1);
  if (lastSystem) lastSystem.cache_control = { type: "ephemeral" };

  const built: BuiltMessage[] = [];
  for (const message of input.messages.slice(leading)) {
    if (message.role === "tool") {
      const result: BetaToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "",
        content: [
          ...userContentBlocks(message.content),
          ...imageInputBlocks(message.images),
        ],
      };
      appendUserBlocks(built, [result]);
      continue;
    }
    if (message.role === "user") {
      appendUserBlocks(built, [
        ...userContentBlocks(message.content),
        ...imageInputBlocks(message.images),
      ]);
      continue;
    }
    if (message.role === "assistant") {
      const content = assistantContentBlocks(message);
      if (content.length > 0) built.push({ role: "assistant", content });
      continue;
    }
    const text = contentText(message.content);
    if (text) built.push({ role: "system", content: text });
  }
  // A mid-conversation system message must follow a user turn and be last
  // or followed by an assistant turn; elsewhere it is said in a user turn.
  const messages: BetaMessageParam[] = [];
  built.forEach((message, index) => {
    if (message.role !== "system") {
      const last = messages.at(-1);
      if (message.role === "user" && last?.role === "user")
        (last.content as BetaContentBlockParam[]).push(...message.content);
      else messages.push({ role: message.role, content: [...message.content] });
      return;
    }
    const next = built[index + 1];
    if (
      messages.at(-1)?.role === "user" &&
      (next === undefined || next.role === "assistant")
    ) {
      messages.push({
        role: "system",
        content: message.content,
      } as unknown as BetaMessageParam);
      return;
    }
    const block: BetaTextBlockParam = { type: "text", text: message.content };
    const last = messages.at(-1);
    if (last?.role === "user")
      (last.content as BetaContentBlockParam[]).push(block);
    else messages.push({ role: "user", content: [block] });
  });

  const tools = input.tools ?? [];
  const effort = messagesEffort(input.reasoningEffort);
  const continuesConversation =
    tools.length > 0 ||
    input.messages.some((message) => message.role === "assistant");
  const body: Omit<MessageCreateParamsStreaming, "stream"> = {
    model: input.model,
    max_tokens:
      MESSAGES_OUTPUT_LIMITS[input.model] ??
      modelOutputLimit(input.model) ??
      DEFAULT_MESSAGES_MAX_TOKENS,
    betas: [...ANTHROPIC_MESSAGES_BETAS],
    fallbacks: "default",
    // Summaries keep a long thought visibly alive on the stream; display
    // changes what is returned, not what is thought or billed.
    thinking: {
      type: "adaptive",
      display: "summarized",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    },
    ...(effort || input.jsonSchema
      ? {
          output_config: {
            ...(effort ? { effort } : {}),
            ...(input.jsonSchema
              ? {
                  format: {
                    type: "json_schema" as const,
                    schema: transformJSONSchema(input.jsonSchema.schema),
                  },
                }
              : {}),
          },
        }
      : {}),
    // One-shot requests end in their own unique input; a write there would
    // never be read back. A conversation's end is the next turn's prefix.
    ...(continuesConversation
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
    ...(system.length > 0 ? { system } : {}),
    messages,
    ...(tools.length > 0
      ? {
          tools: tools.map((tool) => ({
            name: tool.function.name,
            ...(tool.function.description
              ? { description: tool.function.description }
              : {}),
            input_schema: tool.function
              .parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
          })),
          ...(input.parallelToolCalls === false
            ? {
                tool_choice: {
                  type: "auto" as const,
                  disable_parallel_tool_use: true,
                },
              }
            : {}),
        }
      : {}),
  };
  return body as unknown as Record<string, unknown>;
}

export class ModelRefusalError extends Error {
  readonly category: string | null;

  constructor(category: string | null, explanation: string | null) {
    super(
      `The AI declined this request${category ? ` (${category})` : ""}${explanation ? `: ${explanation}` : "."}`,
    );
    this.name = "ModelRefusalError";
    this.category = category;
  }
}

/** Anthropic's input excludes cache reads and writes; the app's input includes both. */
export function messagesUsagePayload(
  usage: Partial<BetaUsage> | null | undefined,
): ModelUsagePayload & { cache_creation_input_tokens?: number } {
  if (!usage) return {};
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  return {
    ...(typeof usage.input_tokens === "number"
      ? { prompt_tokens: usage.input_tokens + read + write }
      : {}),
    ...(typeof usage.output_tokens === "number"
      ? { completion_tokens: usage.output_tokens }
      : {}),
    prompt_tokens_details: { cached_tokens: read },
    cache_creation_input_tokens: write,
    ...(usage.output_tokens_details
      ? {
          completion_tokens_details: {
            reasoning_tokens: usage.output_tokens_details.thinking_tokens,
          },
        }
      : {}),
  };
}

const UNPAIRED_BEFORE_FALLBACK = new Set([
  "thinking",
  "redacted_thinking",
  "tool_use",
  "server_tool_use",
]);

/**
 * Normalizes a final Messages response. After a mid-output fallback only the
 * blocks the API accepts back are kept: the declined model's thinking and
 * tool calls before the last `fallback` block are omitted, the block stays.
 */
export function normalizeMessagesResponse(
  message: BetaMessage,
): ChatCompletionsPayload {
  if (message.stop_reason === "refusal") {
    throw new ModelRefusalError(
      message.stop_details?.category ?? null,
      message.stop_details?.explanation ?? null,
    );
  }
  if (message.stop_reason === "max_tokens")
    throw new ModelOutputLimitError("max_tokens");
  if (message.stop_reason === "model_context_window_exceeded")
    throw new Error(
      "The AI service returned an incomplete response: model context window exceeded",
    );
  const boundary = message.content.findLastIndex(
    (block) => block.type === "fallback",
  );
  const replay = message.content.filter(
    (block, index) =>
      index >= boundary || !UNPAIRED_BEFORE_FALLBACK.has(block.type),
  );
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const toolCalls = message.content.flatMap((block, index) =>
    block.type === "tool_use" && index > boundary
      ? [
          {
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          },
        ]
      : [],
  );
  return {
    choices: [
      {
        message: {
          ...(text ? { content: text } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          anthropic_content: replay,
        },
        finish_reason:
          message.stop_reason === "tool_use"
            ? "tool_calls"
            : message.stop_reason === "end_turn"
              ? "stop"
              : (message.stop_reason ?? "stop"),
      },
    ],
    usage: messagesUsagePayload(message.usage),
  };
}

/** The SDK takes the API root; the app's routes name `.../v1`. */
export function messagesSdkBaseUrl(url: string): string {
  return url.replace(/\/v1\/messages\/?$/u, "").replace(/\/+$/u, "");
}

function apiKeyFromHeaders(headers: Record<string, string>): string {
  for (const [name, value] of Object.entries(headers)) {
    if (/^x-api-key$/iu.test(name)) return value;
    if (/^authorization$/iu.test(name))
      return value.replace(/^Bearer\s+/iu, "");
  }
  return "";
}

/**
 * One streamed attempt through the SDK. Retries, idle and operator
 * deadlines stay in model-request-transport, so the SDK's own retries are
 * off and its request timeout never ends a working stream first.
 */
export async function streamMessagesAttempt(input: {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  onActivity: () => void;
  progressOnly: boolean;
  emit?: ((event: ModelTurnStreamEvent) => void) | undefined;
  observeUsage: (payload: unknown) => void;
}): Promise<{ payload: ChatCompletionsPayload; message: BetaMessage }> {
  const extraHeaders = Object.fromEntries(
    Object.entries(input.headers).filter(
      ([name]) =>
        !/^(authorization|x-api-key|content-type|accept)$/iu.test(name),
    ),
  );
  const client = new Anthropic({
    apiKey: apiKeyFromHeaders(input.headers),
    baseURL: messagesSdkBaseUrl(input.url),
    fetch: input.fetchImpl,
    maxRetries: 0,
    timeout: 24 * 60 * 60 * 1000,
    defaultHeaders: extraHeaders,
  });
  const stream = client.beta.messages.stream(
    input.body as unknown as MessageCreateParamsStreaming,
    { signal: input.signal },
  );
  const observe = () => {
    const usage = stream.currentMessage?.usage;
    if (usage) input.observeUsage({ usage: messagesUsagePayload(usage) });
  };
  // Stop must end the attempt even when a body ignores fetch's abort.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      stream.abort();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const events = stream[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await Promise.race([events.next(), aborted]);
      if (next.done) break;
      const event = next.value;
      if (!input.progressOnly) input.onActivity();
      if (event.type === "message_start" || event.type === "message_delta") {
        observe();
        continue;
      }
      if (event.type === "content_block_start") {
        if (event.content_block.type === "tool_use") {
          input.onActivity();
          input.emit?.({
            type: "tool_call_started",
            index: event.index,
            name: event.content_block.name,
          });
        }
        continue;
      }
      if (event.type !== "content_block_delta") continue;
      const delta = event.delta;
      if (delta.type === "text_delta" && delta.text) {
        input.onActivity();
        input.emit?.({ type: "text_delta", text: delta.text });
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        input.onActivity();
        input.emit?.({ type: "reasoning_delta", text: delta.thinking });
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        input.onActivity();
        input.emit?.({ type: "tool_call_delta", index: event.index });
      } else if (delta.type === "signature_delta") {
        input.onActivity();
      }
    }
    const message = await Promise.race([stream.finalMessage(), aborted]);
    input.observeUsage({ usage: messagesUsagePayload(message.usage) });
    return { payload: normalizeMessagesResponse(message), message };
  } finally {
    if (onAbort) input.signal.removeEventListener("abort", onAbort);
  }
}

const STREAM_ERROR_STATUS: Readonly<Record<string, number>> = {
  overloaded_error: 529,
  api_error: 500,
  rate_limit_error: 429,
  timeout_error: 504,
};

/**
 * Reads an SDK error as the transport's own: an HTTP status (with the
 * provider's message) for status and stream errors, a network error for a
 * connection failure. Returns null for anything else.
 */
export function describeMessagesError(error: unknown):
  | {
      kind: "http";
      status: number;
      message: string;
      retryAfter: string | null;
    }
  | { kind: "network"; message: string }
  | { kind: "abort" }
  | null {
  if (error instanceof Anthropic.APIUserAbortError) return { kind: "abort" };
  if (error instanceof Anthropic.APIConnectionError)
    return { kind: "network", message: error.message };
  if (!(error instanceof Anthropic.APIError)) return null;
  const body = isRecord(error.error) ? error.error : null;
  const detail = body && isRecord(body.error) ? body.error : body;
  const type = typeof detail?.type === "string" ? detail.type : null;
  const message =
    typeof detail?.message === "string" && detail.message
      ? detail.message
      : error.message;
  const status =
    typeof error.status === "number"
      ? error.status
      : type
        ? STREAM_ERROR_STATUS[type]
        : undefined;
  if (status === undefined) return null;
  return {
    kind: "http",
    status,
    message: type ? `${type}: ${message}` : message,
    retryAfter:
      (error.headers as Headers | undefined)?.get("retry-after") ?? null,
  };
}
