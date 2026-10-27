/**
 * Resilient model request transport shared by every OpenAI-compatible call
 * Job Finder makes (text, tools, vision).
 *
 * The problem it solves: a generation can legitimately take minutes on a
 * reasoning model, while a dropped Wi-Fi link or a stalled gateway looks the
 * same to a plain `fetch` with one fixed deadline. Both used to end the same
 * way: "timed out", no retry, deterministic fallback.
 *
 * The approach:
 *
 * - Requests are streamed (`stream: true`). Bytes arriving prove the service
 *   is alive, so liveness is measured as *silence*, not total elapsed time.
 * - Two clocks per request: an idle clock (no bytes for `idleTimeoutMs` means
 *   the connection is presumed dead and the attempt is retried) and a total
 *   clock (`totalTimeoutMs`, the most the caller is willing to wait across
 *   all attempts).
 * - Retries with capped exponential backoff and `Retry-After` support for
 *   the failures that are worth retrying: network errors, idle timeouts,
 *   incomplete streams, 408/409/425/429 and 5xx. Never for 4xx validation
 *   errors, never after a caller abort, never past the total budget.
 * - The result is the same normalized Chat Completions payload the rest of
 *   the package already reads, so callers do not care whether the bytes came
 *   as one JSON body or as server-sent events. A gateway that ignores
 *   `stream: true` and answers with JSON still works.
 */

import {
  type ChatCompletionsPayload,
  type ModelApiMode,
  type ModelUsagePayload,
  type ResponsesPayload,
  normalizeModelPayload,
} from "./openai-compatible-transport";
import type { ModelRequestUsage } from "@nestor/contracts";
import { createModelRequestUsage } from "./model-request-usage";
import {
  recordModelRequestAttempt,
  recordModelRequestUsage,
} from "./model-usage-scope";

export const DEFAULT_MODEL_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_MODEL_MAX_ATTEMPTS = 5;
export const DEFAULT_MODEL_RETRY_BASE_DELAY_MS = 1_000;
export const DEFAULT_MODEL_RETRY_MAX_DELAY_MS = 20_000;

const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 425, 429, 500, 502, 503, 504,
]);

const TRANSIENT_MESSAGE_PATTERN =
  /rate.?limit|overload|temporar|too many requests|try again|econnreset|econnrefused|etimedout|enotfound|eai_again|epipe|socket hang up|network|fetch failed|terminated|premature|502|503|504/i;

export type ModelRequestRetryReason =
  | "network"
  | "idle_timeout"
  | "incomplete_stream"
  | "http_status"
  | "transient_message";

export type ModelRequestEvent =
  | { type: "attempt_started"; attempt: number; maxAttempts: number }
  | {
      type: "retry_scheduled";
      attempt: number;
      delayMs: number;
      reason: ModelRequestRetryReason;
      detail: string;
    };

/**
 * What a streamed answer looks like while it arrives, normalized across
 * Chat Completions and Responses. Text deltas belong to one attempt: a
 * retried attempt starts with `attempt_started` and its text replaces the
 * earlier partial text rather than extending it.
 */
export type ModelStreamEvent =
  | { type: "attempt_started"; attempt: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_started"; index: number; name: string };

export interface ModelRequestResilienceOptions {
  /** Longest silence tolerated before an attempt is presumed dead. */
  idleTimeoutMs?: number | undefined;
  /** Attempts across the whole request, including the first. */
  maxAttempts?: number | undefined;
  /** Send `stream: true` and read server-sent events. Default true. */
  streaming?: boolean | undefined;
  retryBaseDelayMs?: number | undefined;
  retryMaxDelayMs?: number | undefined;
}

export interface PerformModelRequestInput extends ModelRequestResilienceOptions {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  apiMode: ModelApiMode;
  purpose?: string | undefined;
  onUsage?: ((usage: ModelRequestUsage) => void) | undefined;
  /** Most the caller waits across every attempt. */
  totalTimeoutMs: number;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
  onEvent?: ((event: ModelRequestEvent) => void) | undefined;
  /** Normalized deltas as a streamed answer arrives (see ModelStreamEvent). */
  onStreamEvent?: ((event: ModelStreamEvent) => void) | undefined;
}

export class ModelRequestHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.name = "ModelRequestHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class ModelRequestTimeoutError extends Error {
  readonly kind: "idle" | "total";

  constructor(kind: "idle" | "total", waitedMs: number) {
    // The "timed out after Ns" shape is what provenance and studio copy key
    // on to say "the AI took too long" instead of "the AI failed".
    super(
      kind === "idle"
        ? `Model request timed out after ${Math.floor(waitedMs / 1000)}s of silence from the AI service`
        : `Model request timed out after ${Math.floor(waitedMs / 1000)}s`,
    );
    this.name = "AbortError";
    this.kind = kind;
  }
}

class ModelStreamIncompleteError extends Error {
  constructor(detail: string) {
    super(`The AI service closed the stream before finishing: ${detail}`);
    this.name = "ModelStreamIncompleteError";
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const error = payload.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return null;
}

function rejectIncompleteOutput(payload: unknown, apiMode: ModelApiMode): void {
  if (!isRecord(payload)) return;
  if (apiMode === "responses" && payload.status === "incomplete") {
    const details = isRecord(payload.incomplete_details)
      ? payload.incomplete_details
      : null;
    const reason =
      typeof details?.reason === "string"
        ? details.reason
        : "unspecified reason";
    throw new Error(
      `The AI service returned an incomplete response: ${reason}`,
    );
  }
  const choice: unknown = Array.isArray(payload.choices)
    ? payload.choices[0]
    : null;
  if (
    apiMode === "chat_completions" &&
    isRecord(choice) &&
    (choice.finish_reason === "length" ||
      choice.finish_reason === "content_filter")
  ) {
    throw new Error(
      `The AI service returned an incomplete response: ${choice.finish_reason}`,
    );
  }
}

export function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number.parseFloat(trimmed) * 1000));
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, at - Date.now());
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "TypeError" || error.name === "FetchError") {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (isRecord(cause) && typeof cause.code === "string") {
    return /^E[A-Z]+$/.test(cause.code) || cause.code === "UND_ERR_SOCKET";
  }
  return false;
}

export function computeRetryDelayMs(input: {
  attempt: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMs?: number | null | undefined;
  random?: () => number;
}): number {
  const random = input.random ?? Math.random;
  const exponential = Math.min(
    input.maxDelayMs,
    input.baseDelayMs * 2 ** input.attempt,
  );
  const jitter = Math.floor(random() * Math.min(250, input.baseDelayMs));
  const suggested = input.retryAfterMs ?? 0;
  return Math.max(exponential + jitter, Math.min(suggested, input.maxDelayMs));
}

async function sleepWithAbort(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type ToolCallAccumulator = { id: string; name: string; arguments: string };

/**
 * Folds one Chat Completions stream chunk into the running message. Tool
 * calls stream as fragments keyed by `index`; arguments arrive in pieces.
 */
interface ChatStreamState {
  content: string;
  reasoningContent: string;
  toolCalls: Map<number, ToolCallAccumulator>;
  finished: boolean;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
}

function foldChatCompletionsChunk(
  chunk: unknown,
  state: ChatStreamState,
  emit?: (event: ModelStreamEvent) => void,
): void {
  if (!isRecord(chunk)) {
    return;
  }
  rejectIncompleteOutput(chunk, "chat_completions");
  // With `stream_options.include_usage` the usage arrives on a final chunk
  // whose choices are empty.
  if (isRecord(chunk.usage)) {
    state.usage = chunk.usage;
  }
  const choices: unknown[] = Array.isArray(chunk.choices)
    ? (chunk.choices as unknown[])
    : [];
  const choice = choices[0];
  if (!isRecord(choice)) {
    return;
  }
  const delta = isRecord(choice.delta) ? choice.delta : null;
  if (delta) {
    if (typeof delta.content === "string") {
      state.content += delta.content;
      if (delta.content) emit?.({ type: "text_delta", text: delta.content });
    }
    // DeepSeek thinking mode streams its reasoning separately. It is private
    // continuation for later tool turns, never shown to the person.
    if (typeof delta.reasoning_content === "string") {
      state.reasoningContent += delta.reasoning_content;
      if (delta.reasoning_content) {
        emit?.({ type: "reasoning_delta", text: delta.reasoning_content });
      }
    }
    const toolCalls: unknown[] = Array.isArray(delta.tool_calls)
      ? (delta.tool_calls as unknown[])
      : [];
    toolCalls.forEach((fragment, position) => {
      if (!isRecord(fragment)) {
        return;
      }
      const index =
        typeof fragment.index === "number" ? fragment.index : position;
      const entry = state.toolCalls.get(index) ?? {
        id: "",
        name: "",
        arguments: "",
      };
      if (typeof fragment.id === "string" && fragment.id) {
        entry.id = fragment.id;
      }
      const fn = isRecord(fragment.function) ? fragment.function : null;
      if (fn) {
        if (typeof fn.name === "string" && fn.name) {
          if (!entry.name) {
            emit?.({ type: "tool_call_started", index, name: fn.name });
          }
          entry.name = fn.name;
        }
        if (typeof fn.arguments === "string") {
          entry.arguments += fn.arguments;
        }
      }
      state.toolCalls.set(index, entry);
    });
  }
  // Some gateways send the whole message on the final chunk instead of deltas.
  const message = isRecord(choice.message) ? choice.message : null;
  if (message && !delta) {
    if (typeof message.content === "string") {
      state.content += message.content;
    }
    if (typeof message.reasoning_content === "string") {
      state.reasoningContent += message.reasoning_content;
    }
    const toolCalls: unknown[] = Array.isArray(message.tool_calls)
      ? (message.tool_calls as unknown[])
      : [];
    toolCalls.forEach((call, position) => {
      if (!isRecord(call)) {
        return;
      }
      const fn = isRecord(call.function) ? call.function : null;
      state.toolCalls.set(position, {
        id: typeof call.id === "string" ? call.id : "",
        name: fn && typeof fn.name === "string" ? fn.name : "",
        arguments: fn && typeof fn.arguments === "string" ? fn.arguments : "",
      });
    });
  }
  if (typeof choice.finish_reason === "string" && choice.finish_reason) {
    state.finished = true;
    state.finishReason = choice.finish_reason;
  }
}

function buildChatPayloadFromStream(
  state: ChatStreamState,
): ChatCompletionsPayload {
  const toolCalls = [...state.toolCalls.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, call]) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }))
    .filter((call) => call.id && call.function.name);
  return {
    choices: [
      {
        message: {
          ...(state.content ? { content: state.content } : {}),
          ...(state.reasoningContent
            ? { reasoning_content: state.reasoningContent }
            : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        ...(state.finishReason ? { finish_reason: state.finishReason } : {}),
      },
    ],
    ...(state.usage ? { usage: state.usage as ModelUsagePayload } : {}),
  };
}

/**
 * Reads a server-sent-event body to completion and returns the normalized
 * payload. `onActivity` is called for every chunk so the idle clock resets.
 */
async function readStreamedPayload(
  response: Response,
  apiMode: ModelApiMode,
  onActivity: () => void,
  signal: AbortSignal,
  emit?: (event: ModelStreamEvent) => void,
  observeUsage?: (payload: unknown) => void,
): Promise<ChatCompletionsPayload> {
  const body = response.body;
  if (!body) {
    throw new ModelStreamIncompleteError("empty body");
  }
  const reader = body.getReader();
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const decoder = new TextDecoder();
  let buffered = "";
  let dataLines: string[] = [];
  let sawDone = false;
  let reachedEof = false;
  const chat: ChatStreamState = {
    content: "",
    reasoningContent: "",
    toolCalls: new Map<number, ToolCallAccumulator>(),
    finished: false,
    finishReason: null,
    usage: null,
  };
  const responses: {
    completed: ResponsesPayload | null;
    text: string;
    toolCalls: Array<{ call_id: string; name: string; arguments: string }>;
  } = { completed: null, text: "", toolCalls: [] };

  const handleEvent = (data: string) => {
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    observeUsage?.(parsed);
    const errorMessage = readErrorMessage(parsed);
    if (errorMessage && isRecord(parsed) && parsed.type !== "response.failed") {
      throw new Error(errorMessage);
    }
    if (apiMode === "chat_completions") {
      foldChatCompletionsChunk(parsed, chat, emit);
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (type === "error") {
      throw new Error(
        (typeof parsed.message === "string" && parsed.message) ||
          "The AI service reported an error while streaming.",
      );
    }
    if (type === "response.failed") {
      const failure = isRecord(parsed.response) ? parsed.response : null;
      throw new Error(
        (failure && readErrorMessage(failure)) ??
          "The AI service reported a failed response.",
      );
    }
    if (
      type === "response.completed" ||
      type === "response.done" ||
      type === "response.incomplete"
    ) {
      if (type === "response.incomplete") {
        rejectIncompleteOutput(
          {
            ...(isRecord(parsed.response) ? parsed.response : {}),
            status: "incomplete",
          },
          "responses",
        );
      }
      if (parsed.response !== undefined && !isRecord(parsed.response)) {
        throw new ModelStreamIncompleteError("malformed completed response");
      }
      rejectIncompleteOutput(parsed.response, "responses");
      if (isRecord(parsed.response)) {
        responses.completed = parsed.response as ResponsesPayload;
      }
      sawDone = true;
      return;
    }
    if (
      type === "response.output_text.delta" &&
      typeof parsed.delta === "string"
    ) {
      responses.text += parsed.delta;
      if (parsed.delta) emit?.({ type: "text_delta", text: parsed.delta });
      return;
    }
    if (
      type === "response.output_item.added" &&
      isRecord(parsed.item) &&
      parsed.item.type === "function_call" &&
      typeof parsed.item.name === "string"
    ) {
      emit?.({
        type: "tool_call_started",
        index:
          typeof parsed.output_index === "number" ? parsed.output_index : 0,
        name: parsed.item.name,
      });
      return;
    }
    if (type === "response.output_item.done" && isRecord(parsed.item)) {
      const item = parsed.item;
      if (
        item.type === "function_call" &&
        typeof item.call_id === "string" &&
        typeof item.name === "string" &&
        typeof item.arguments === "string"
      ) {
        responses.toolCalls.push({
          call_id: item.call_id,
          name: item.name,
          arguments: item.arguments,
        });
      }
    }
  };

  const flushEvent = () => {
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (data) {
      handleEvent(data);
    }
  };

  const consumeLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flushEvent();
      return;
    }
    if (line.startsWith(":")) {
      return; // keepalive comment
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // `event:` and `id:` lines carry nothing the parsers above need.
  };

  try {
    while (!sawDone) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      onActivity();
      buffered += decoder.decode(value, { stream: true });
      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex >= 0 && !sawDone) {
        consumeLine(buffered.slice(0, newlineIndex));
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }
    }
    if (!sawDone) {
      buffered += decoder.decode();
      if (buffered) {
        consumeLine(buffered);
      }
      flushEvent();
    }
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    // A protocol completion marker ends the response, even when a gateway
    // keeps the connection open. Cancel that body (and bodies rejected by
    // the parser) without waiting for network EOF or cancellation to settle.
    if (!reachedEof) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (signal.aborted) {
    // A cancelled reader ends with `done`; never hand back a truncated
    // message as if it were the model's answer.
    throw createAbortError();
  }

  if (apiMode === "chat_completions") {
    if (!sawDone && !chat.finished) {
      // Partial text can be valid JSON too. Require completion before
      // releasing either text or tool calls (ADR 0020).
      throw new ModelStreamIncompleteError("no completion marker arrived");
    }
    return buildChatPayloadFromStream(chat);
  }

  if (responses.completed) {
    return normalizeModelPayload(responses.completed, "responses");
  }
  if (sawDone && (responses.text || responses.toolCalls.length > 0)) {
    return normalizeModelPayload(
      {
        output_text: responses.text,
        output: responses.toolCalls.map((call) => ({
          type: "function_call",
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments,
        })),
      },
      "responses",
    );
  }
  throw new ModelStreamIncompleteError("no completed response arrived");
}

async function readTextWithActivity(
  response: Response,
  onActivity: () => void,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelOnAbort, { once: true });
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      onActivity();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
  if (signal.aborted) {
    throw createAbortError();
  }
  return text;
}

function classifyRetry(
  error: unknown,
): { reason: ModelRequestRetryReason; retryAfterMs: number | null } | null {
  if (error instanceof ModelRequestTimeoutError) {
    return error.kind === "idle"
      ? { reason: "idle_timeout", retryAfterMs: null }
      : null;
  }
  if (error instanceof ModelRequestHttpError) {
    return RETRYABLE_HTTP_STATUSES.has(error.status)
      ? { reason: "http_status", retryAfterMs: error.retryAfterMs }
      : null;
  }
  if (error instanceof ModelStreamIncompleteError) {
    return { reason: "incomplete_stream", retryAfterMs: null };
  }
  if (isNetworkError(error)) {
    return { reason: "network", retryAfterMs: null };
  }
  if (
    error instanceof Error &&
    error.name !== "AbortError" &&
    TRANSIENT_MESSAGE_PATTERN.test(error.message)
  ) {
    return { reason: "transient_message", retryAfterMs: null };
  }
  return null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A rejected key, or an account out of funds, does not start working
 * mid-session. After a 401 or 402 the same endpoint and credentials are not
 * asked again for a while; every request
 * in that time fails at once with the same error. An expired key otherwise
 * met 140 requests from one small search (each listing read, fit batch and
 * full read failing in turn), and retried them on the next search.
 */
export const MODEL_AUTH_FAILURE_PAUSE_MS = 5 * 60_000;
type CredentialRejections = Map<
  string,
  { until: number; error: ModelRequestHttpError }
>;
// Per fetch implementation: the app has one; a test's own fetch mock starts
// with nothing remembered.
let rejectedCredentials = new WeakMap<typeof fetch, CredentialRejections>();
function rejectionsFor(fetchImpl: typeof fetch): CredentialRejections {
  let rejections = rejectedCredentials.get(fetchImpl);
  if (!rejections) {
    rejections = new Map();
    rejectedCredentials.set(fetchImpl, rejections);
  }
  return rejections;
}

function credentialKey(url: string, headers: Record<string, string>): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // An unparsable URL keys on itself.
  }
  const authorization = Object.entries(headers)
    .filter(([name]) => /^(authorization|x-api-key|api-key)$/i.test(name))
    .map(([, value]) => value)
    .join("|");
  return `${origin}|${authorization}`;
}

/** Test seam: forget remembered rejections. */
export function resetModelCredentialRejections(): void {
  rejectedCredentials = new WeakMap();
}

/**
 * Performs one logical model request with streaming liveness, idle and
 * total deadlines, and bounded retries. Resolves with the normalized
 * Chat Completions payload; rejects with the last error, a
 * `ModelRequestTimeoutError`, or an `AbortError` when the caller cancelled.
 */
export async function performModelRequest(
  input: PerformModelRequestInput,
): Promise<ChatCompletionsPayload> {
  const rejections = rejectionsFor(input.fetchImpl ?? fetch);
  const credentials = credentialKey(input.url, input.headers);
  const rejection = rejections.get(credentials);
  if (rejection && rejection.until > Date.now()) {
    throw new ModelRequestHttpError(
      rejection.error.message,
      rejection.error.status,
      null,
    );
  }
  try {
    return await performModelRequestAttempts(input);
  } catch (error) {
    if (
      error instanceof ModelRequestHttpError &&
      (error.status === 401 || error.status === 402)
    ) {
      rejections.set(credentials, {
        until: Date.now() + MODEL_AUTH_FAILURE_PAUSE_MS,
        error,
      });
    }
    throw error;
  }
}

async function performModelRequestAttempts(
  input: PerformModelRequestInput,
): Promise<ChatCompletionsPayload> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const idleTimeoutMs = input.idleTimeoutMs ?? DEFAULT_MODEL_IDLE_TIMEOUT_MS;
  const maxAttempts = Math.max(
    1,
    input.maxAttempts ?? DEFAULT_MODEL_MAX_ATTEMPTS,
  );
  const streaming = input.streaming ?? true;
  const baseDelayMs =
    input.retryBaseDelayMs ?? DEFAULT_MODEL_RETRY_BASE_DELAY_MS;
  const maxDelayMs = input.retryMaxDelayMs ?? DEFAULT_MODEL_RETRY_MAX_DELAY_MS;
  const startedAt = Date.now();
  const deadline = startedAt + input.totalTimeoutMs;
  const requestBody = JSON.stringify(
    streaming
      ? {
          ...input.body,
          stream: true,
          ...(input.apiMode === "chat_completions"
            ? { stream_options: { include_usage: true } }
            : {}),
        }
      : input.body,
  );
  const headers = {
    ...input.headers,
    ...(streaming ? { Accept: "text/event-stream, application/json" } : {}),
  };

  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (input.signal?.aborted) {
      throw createAbortError();
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw lastError
        ? toError(lastError)
        : new ModelRequestTimeoutError("total", input.totalTimeoutMs);
    }

    input.onEvent?.({ type: "attempt_started", attempt, maxAttempts });
    recordModelRequestAttempt();
    input.onStreamEvent?.({ type: "attempt_started", attempt });
    const usage = createModelRequestUsage(input, attempt);
    let outcome: ModelRequestUsage["outcome"] = "failed";

    const attemptController = new AbortController();
    let abortReason: "idle" | "total" | "caller" | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const totalTimer = setTimeout(() => {
      abortReason = abortReason ?? "total";
      attemptController.abort();
    }, remainingMs);
    const armIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        abortReason = abortReason ?? "idle";
        attemptController.abort();
      }, idleTimeoutMs);
    };
    const onCallerAbort = () => {
      abortReason = "caller";
      attemptController.abort();
    };
    input.signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      armIdle();
      const response = await fetchImpl(input.url, {
        method: "POST",
        headers,
        body: requestBody,
        signal: attemptController.signal,
      });
      armIdle();

      if (!response.ok) {
        const rawBody = await readTextWithActivity(
          response,
          armIdle,
          attemptController.signal,
        );
        let parsed: unknown = null;
        try {
          parsed = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          parsed = null;
        }
        usage.observe(parsed);
        throw new ModelRequestHttpError(
          readErrorMessage(parsed) ??
            `Model request failed with status ${response.status}`,
          response.status,
          parseRetryAfterMs(response.headers.get("retry-after")),
        );
      }

      const contentType = (
        response.headers.get("content-type") ?? ""
      ).toLowerCase();
      if (streaming && contentType.includes("text/event-stream")) {
        const payload = await readStreamedPayload(
          response,
          input.apiMode,
          armIdle,
          attemptController.signal,
          input.onStreamEvent,
          usage.observe,
        );
        outcome = "completed";
        return { ...payload, usage: usage.finish(outcome).payload };
      }

      const rawBody = await readTextWithActivity(
        response,
        armIdle,
        attemptController.signal,
      );
      let rawPayload: unknown = null;
      try {
        rawPayload = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        rawPayload = null;
      }
      usage.observe(rawPayload);
      if (!isRecord(rawPayload)) {
        throw new Error("Model returned a non-JSON response");
      }
      const payloadError = readErrorMessage(rawPayload);
      if (payloadError) {
        throw new Error(payloadError);
      }
      rejectIncompleteOutput(rawPayload, input.apiMode);
      const payload = normalizeModelPayload(
        rawPayload as ChatCompletionsPayload | ResponsesPayload,
        input.apiMode,
      );
      outcome = "completed";
      return { ...payload, usage: usage.finish(outcome).payload };
    } catch (error) {
      if (abortReason === "caller" || input.signal?.aborted) {
        outcome = "cancelled";
        throw createAbortError();
      }
      const normalized: unknown =
        abortReason === "total"
          ? new ModelRequestTimeoutError("total", input.totalTimeoutMs)
          : abortReason === "idle"
            ? new ModelRequestTimeoutError("idle", idleTimeoutMs)
            : error;
      lastError = normalized;

      const retry = classifyRetry(normalized);
      if (!retry || attempt === maxAttempts - 1) {
        throw toError(normalized);
      }
      const delayMs = computeRetryDelayMs({
        attempt,
        baseDelayMs,
        maxDelayMs,
        retryAfterMs: retry.retryAfterMs,
      });
      // Do not start a retry that cannot possibly finish inside the budget.
      if (Date.now() + delayMs + 1_000 >= deadline) {
        throw toError(normalized);
      }
      input.onEvent?.({
        type: "retry_scheduled",
        attempt,
        delayMs,
        reason: retry.reason,
        detail: describeError(normalized),
      });
      await sleepWithAbort(delayMs, input.signal);
    } finally {
      clearTimeout(totalTimer);
      if (idleTimer) {
        clearTimeout(idleTimer);
      }
      input.signal?.removeEventListener("abort", onCallerAbort);
      const { event } = usage.finish(outcome);
      recordModelRequestUsage(event);
      input.onUsage?.(event);
      console.info("[AI usage]", JSON.stringify(event));
    }
  }

  throw lastError
    ? toError(lastError)
    : new Error("Model request exhausted its retries.");
}

export function parseConfiguredBoolean(
  value: string | undefined,
): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function parseConfiguredPositiveInteger(
  value: string | undefined,
  minimum = 1,
): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : undefined;
}
