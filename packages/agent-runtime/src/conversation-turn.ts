import { traceOurs, traceEvent, withTraceScope } from "@nestor/core/run-trace";
import { observeModel, observeTool, type RuntimeObservers } from "./observers";
import {
  ModelOutputLimitError,
  isModelOutputLimit,
} from "./model-output-error";
import {
  ModelTurnTimeoutError,
  runModelTurn,
  type ModelTurnStreamEvent,
} from "./model-turn";
import type {
  AgentLoopContinuation,
  AgentLoopMessage,
  AgentLoopTool,
  AgentLoopToolCall,
  AgentLoopToolDefinition,
  AgentLoopToolOutcome,
} from "./agent-loop";

/**
 * Conversation mode: one turn of a chat assistant.
 *
 * `runAgentLoop` drives a task to a finish tool and asks for a tool whenever
 * the model answers in plain words. A conversation is the other way round:
 * plain words are the reply, and the turn ends there. Everything else this
 * module adds exists for things a chat needs and a task run does not:
 *
 * - the model input is assembled by the caller before every call, so context
 *   and live state are fresh and the prompt stays inside its budget
 * - the answer streams, and each retry replaces the partial text
 * - messages the person sends while the turn works are read at every tool
 *   boundary, before the next action is dispatched
 * - every tool call has its own cancellation, so silence or a Stop reaches
 *   the work instead of only ending the wait
 * - a fence is checked before every dispatch, so a superseded turn never
 *   starts another action
 *
 * The loop stays product-neutral: it knows nothing of jobs or profiles.
 */

export interface ConversationTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export type ConversationStreamEvent = ModelTurnStreamEvent;

export interface ConversationModel {
  chatWithTools: (
    messages: AgentLoopMessage[],
    tools: AgentLoopToolDefinition[],
    options?: {
      signal?: AbortSignal;
      maxOutputTokens?: number;
      onStreamEvent?: (event: ConversationStreamEvent) => void;
    },
  ) => Promise<{
    content?: string;
    toolCalls?: AgentLoopToolCall[];
    usage?: ConversationTurnUsage;
    continuation?: AgentLoopContinuation;
    finishReason?: string;
  }>;
}

export interface ConversationTool extends AgentLoopTool {
  /** Host-owned words for the activity row: "Reading your profile". */
  label: (args: Record<string, unknown>) => string;
}

export type ConversationTurnEvent =
  | { type: "model_call_started"; call: number }
  | {
      type: "model_call_finished";
      call: number;
      usage: ConversationTurnUsage | null;
    }
  | { type: "stream"; call: number; event: ConversationStreamEvent }
  | { type: "commentary"; text: string }
  | {
      type: "tool_started";
      toolCallId: string;
      toolName: string;
      label: string;
      status: string | null;
    }
  | {
      type: "tool_finished";
      toolCallId: string;
      toolName: string;
      label: string;
      outcome: "done" | "failed" | "cancelled" | "refused";
      summary: string;
    }
  | { type: "steering_read"; count: number };

export interface ConversationTurnCeilings {
  /** Model calls in one turn. Safety only; far above an honest turn. */
  maxModelCalls?: number;
  maxOutputTokens?: number;
  /** Silence while a tool is running; progress restarts this clock. */
  toolIdleTimeoutMs?: number;
  /** Silence between model stream events, not elapsed reasoning time. */
  modelIdleTimeoutMs?: number;
  /** Repeated identical tool batches without progress before stopping. */
  noProgressStepLimit?: number;
}

export interface RunConversationTurnOptions extends RuntimeObservers {
  model: ConversationModel;
  tools: ConversationTool[];
  /** Optional lazy catalog; execution still uses the host's validated registry. */
  getToolDefinitions?: () => readonly AgentLoopToolDefinition[];
  /** Prepare one fresh-context retry after a response with no usable output. */
  onOutputLimitRetry?: () => void | Promise<void>;
  onEmptyReply?: (detail: {
    finishReason: string | null;
    usage: ConversationTurnUsage | null;
  }) => void | Promise<void>;
  /**
   * Builds the full model input before every call from the turn's own new
   * messages. The caller owns the system prompt, the context block, the
   * history and every budget decision.
   */
  assembleMessages: (
    turnMessages: readonly AgentLoopMessage[],
  ) => Promise<AgentLoopMessage[]>;
  /** Messages the person sent since the last look; each becomes a user message. */
  takeSteering?: () => Promise<string[]>;
  /** False once this turn was stopped or superseded. Checked before every dispatch. */
  isCurrent?: () => boolean;
  signal?: AbortSignal;
  onEvent?: (event: ConversationTurnEvent) => void | Promise<void>;
  ceilings?: ConversationTurnCeilings;
  /** Longest tool result handed back verbatim. */
  toolResultLimitChars?: number;
  /** Stores a result that is too long and returns the note that replaces its tail. */
  storeOverflow?: (toolName: string, content: string) => Promise<string>;
  now?: () => number;
}

export type ConversationTurnEnding =
  | "replied"
  | "stopped"
  | "aborted"
  | "superseded"
  | "ceiling"
  | "timed_out"
  | "model_failed";

export interface ConversationTurnResult {
  ending: ConversationTurnEnding;
  reply: string | null;
  /** New messages of this turn, in order, for the stored model tail. */
  turnMessages: AgentLoopMessage[];
  usage: ConversationTurnUsage;
  modelCalls: number;
  stop: { reason: string; data?: unknown } | null;
  error: unknown;
}

const DEFAULT_MAX_MODEL_CALLS = Infinity;
const DEFAULT_TOOL_RESULT_LIMIT_CHARS = 16_000;
const STATUS_ARGUMENT = "status";

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The optional `status` note the model may attach to any call. A missing or
 * overlong note never invalidates the call; the host label is the fallback.
 */
export function readStatusNote(args: Record<string, unknown>): string | null {
  const value = args[STATUS_ARGUMENT];
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const words = trimmed.split(" ");
  return words.length > 16 ? null : trimmed.slice(0, 160);
}

/** Adds the optional `status` property to a tool definition. */
export function withStatusArgument(
  definition: AgentLoopToolDefinition,
): AgentLoopToolDefinition {
  if (STATUS_ARGUMENT in definition.function.parameters.properties) {
    return definition;
  }
  return {
    ...definition,
    function: {
      ...definition.function,
      parameters: {
        ...definition.function.parameters,
        properties: {
          ...definition.function.parameters.properties,
          [STATUS_ARGUMENT]: {
            type: "string",
            description: "Optional activity note, at most 12 words.",
          },
        },
      },
    },
  };
}

function emptyUsage(): ConversationTurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
}

function addUsage(
  total: ConversationTurnUsage,
  next: ConversationTurnUsage | undefined,
): void {
  if (!next) return;
  total.inputTokens += next.inputTokens;
  total.outputTokens += next.outputTokens;
  total.cachedInputTokens += next.cachedInputTokens;
  total.reasoningTokens += next.reasoningTokens;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export async function runConversationTurn(
  options: RunConversationTurnOptions,
): Promise<ConversationTurnResult> {
  const maxModelCalls = Math.max(
    1,
    options.ceilings?.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS,
  );
  const resultLimit =
    options.toolResultLimitChars ?? DEFAULT_TOOL_RESULT_LIMIT_CHARS;
  const toolsByName = new Map(
    options.tools.map((tool) => [tool.definition.function.name, tool]),
  );
  const turnMessages: AgentLoopMessage[] = [];
  const usage = emptyUsage();
  let modelCalls = 0;
  let emptyReplies = 0;
  let step = 0;
  let lastBatch = "";
  let repeatedBatches = 0;

  const emit = async (event: ConversationTurnEvent) => {
    try {
      await options.onEvent?.(event);
    } catch {
      // Presentation never ends a turn.
    }
  };
  const current = () => options.isCurrent?.() ?? true;
  const result = (
    ending: ConversationTurnEnding,
    extra: {
      reply?: string | null;
      stop?: { reason: string; data?: unknown };
      error?: unknown;
    } = {},
  ): ConversationTurnResult => ({
    ending,
    reply: extra.reply ?? null,
    turnMessages,
    usage,
    modelCalls,
    stop: extra.stop ?? null,
    error: extra.error ?? null,
  });
  const readSteering = async (): Promise<number> => {
    const steering = (await options.takeSteering?.()) ?? [];
    for (const text of steering) {
      turnMessages.push({ role: "user", content: text });
    }
    if (steering.length > 0) {
      await emit({ type: "steering_read", count: steering.length });
    }
    return steering.length;
  };

  while (modelCalls < maxModelCalls) {
    if (options.signal?.aborted) return result("aborted");
    if (!current()) return result("superseded");
    await readSteering();

    const messages = await options.assembleMessages(turnMessages);
    const definitions = (
      options.getToolDefinitions?.() ??
      options.tools.map((tool) => tool.definition)
    ).map(withStatusArgument);
    modelCalls += 1;
    const call = modelCalls;
    await emit({ type: "model_call_started", call });
    let response: Awaited<ReturnType<ConversationModel["chatWithTools"]>>;
    let idleRetries = 0;
    let outputRetries = 0;
    let outputLimit = options.ceilings?.maxOutputTokens;
    for (;;) {
      try {
        response = await runModelTurn(
          (turnOptions) =>
            observeModel(
              options,
              { messages, tools: definitions, maxOutputTokens: outputLimit },
              () =>
                options.model.chatWithTools(messages, definitions, {
                  ...turnOptions,
                  ...(outputLimit ? { maxOutputTokens: outputLimit } : {}),
                }),
            ),
          {
            signal: options.signal,
            idleTimeoutMs: options.ceilings?.modelIdleTimeoutMs,
            onStreamEvent: (event) => {
              void emit({ type: "stream", call, event });
            },
          },
        );
        if (
          ["length", "max_output_tokens"].includes(response.finishReason ?? "")
        ) {
          addUsage(usage, response.usage);
          throw new ModelOutputLimitError(response.finishReason);
        }
        break;
      } catch (error) {
        if (options.signal?.aborted) return result("aborted");
        if (isModelOutputLimit(error) && outputRetries++ === 0) {
          // Existing explicit caps can grow. With no cap the route already
          // supplies its maximum; retry once without changing any history.
          if (outputLimit !== undefined) outputLimit *= 2;
          modelCalls += 1;
          await options.onOutputLimitRetry?.();
          continue;
        }
        if (
          error instanceof ModelTurnTimeoutError &&
          error.kind === "idle" &&
          idleRetries++ === 0
        ) {
          modelCalls += 1;
          await emit({
            type: "stream",
            call,
            event: { type: "attempt_started", attempt: 1 },
          });
          continue;
        }
        return result("model_failed", { error });
      }
    }
    addUsage(usage, response.usage);
    await emit({
      type: "model_call_finished",
      call,
      usage: response.usage ?? null,
    });

    const toolCalls = response.toolCalls ?? [];
    const content = response.content?.trim() ?? "";
    if (!toolCalls.length && !content) {
      if (++emptyReplies > 1)
        return result("model_failed", {
          error: new Error(
            "The model returned no reply or executable tool call.",
          ),
        });
      await options.onEmptyReply?.({
        finishReason: response.finishReason ?? null,
        usage: response.usage ?? null,
      });
      turnMessages.push({
        role: "user",
        content:
          "[System note] The last response had no text or executable tool call. Use an offered tool or answer plainly. Do not claim work completed without a result.",
      });
      continue;
    }
    emptyReplies = 0;
    if (toolCalls.length === 0) {
      // Conversation mode: plain words are the reply.
      turnMessages.push({
        role: "assistant",
        content: response.content ?? "",
        ...(response.continuation
          ? { continuation: response.continuation }
          : {}),
      });
      if (!current()) return result("superseded");
      return result("replied", { reply: content });
    }

    turnMessages.push({
      role: "assistant",
      content: response.content ?? "",
      toolCalls,
      ...(response.continuation ? { continuation: response.continuation } : {}),
    });
    if (content) {
      await emit({ type: "commentary", text: content });
    }

    const batchStart = turnMessages.length;
    let madeProgress = false;
    let redirected = false;
    let batchSucceeded = true;
    for (const [index, toolCall] of toolCalls.entries()) {
      const observedToolStart = Date.now();
      try {
        const tool = toolsByName.get(toolCall.function.name);
        if (redirected) {
          turnMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content:
              "Not run: the person sent a new message before this step. Read it and decide again.",
          });
          continue;
        }
        if (options.signal?.aborted || !current()) {
          turnMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: "Not run: the turn was stopped.",
          });
          continue;
        }
        // Steering is read at every tool boundary. A new message could change
        // what the pending action should be, so nothing further is dispatched
        // until the model has read it.
        if (index > 0 && (await readSteering()) > 0) {
          redirected = true;
          // The steering messages were appended after the assistant message;
          // move them after the answered calls so every call stays paired.
          const steering: AgentLoopMessage[] = [];
          while (turnMessages.at(-1)?.role === "user") {
            steering.unshift(turnMessages.pop()!);
          }
          turnMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content:
              "Not run: the person sent a new message before this step. Read it and decide again.",
          });
          for (const rest of toolCalls.slice(index + 1)) {
            turnMessages.push({
              role: "tool",
              toolCallId: rest.id,
              content:
                "Not run: the person sent a new message before this step. Read it and decide again.",
            });
          }
          turnMessages.push(...steering);
          break;
        }
        if (!tool) {
          batchSucceeded = false;
          turnMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: `There is no tool called ${toolCall.function.name}.`,
          });
          continue;
        }
        const args = parseArguments(toolCall.function.arguments);
        const label = tool.label(args);
        await emit({
          type: "tool_started",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          label,
          status: readStatusNote(args),
        });
        step += 1;
        traceEvent("tool_call_started", {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        });
        let outcome: AgentLoopToolOutcome;
        try {
          outcome = await runModelTurn(
            ({ signal, onStreamEvent }) =>
              withTraceScope({ toolCallId: toolCall.id }, () =>
                tool.execute(toolCall.function.arguments, {
                  step,
                  signal,
                  onProgress: () =>
                    onStreamEvent({ type: "tool_call_delta", index: 0 }),
                }),
              ),
            {
              signal: options.signal,
              idleTimeoutMs: options.ceilings?.toolIdleTimeoutMs,
            },
          );
        } catch (error) {
          batchSucceeded = false;
          if (options.signal?.aborted || isAbortError(error)) {
            turnMessages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: "Stopped during this step.",
            });
            await emit({
              type: "tool_finished",
              toolCallId: toolCall.id,
              toolName: toolCall.function.name,
              label,
              outcome: "cancelled",
              summary: "Stopped",
            });
            if (options.signal?.aborted) return result("aborted");
            continue;
          }
          const text =
            error instanceof ModelTurnTimeoutError
              ? "That step stopped reporting progress. Look again before deciding what to do next."
              : (tool.describeError?.(error) ??
                "That tool could not complete this step. Try a different approach, or say what remains.");
          turnMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: text,
          });
          await emit({
            type: "tool_finished",
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            label,
            outcome: "failed",
            summary: text.slice(0, 300),
          });
          continue;
        }

        if (outcome.kind === "stop") {
          turnMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: `Stopped: ${outcome.reason}`,
          });
          await emit({
            type: "tool_finished",
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            label,
            outcome: "refused",
            summary: outcome.reason.slice(0, 300),
          });
          return result("stopped", {
            stop: {
              reason: outcome.reason,
              ...(outcome.data !== undefined ? { data: outcome.data } : {}),
            },
          });
        }
        if (outcome.kind === "finish") {
          turnMessages.push({
            role: "tool",
            toolCallId: toolCall.id,
            content: outcome.finish.output ?? outcome.finish.reason,
          });
          await emit({
            type: "tool_finished",
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            label,
            outcome: "done",
            summary: outcome.finish.reason.slice(0, 300),
          });
          // A completion request never drops other calls or hides an earlier failure.
          if (batchSucceeded && index === toolCalls.length - 1) {
            turnMessages.push({
              role: "assistant",
              content: outcome.finish.reason,
            });
            return result("replied", { reply: outcome.finish.reason });
          }
          continue;
        }
        madeProgress ||= outcome.progress === true;
        if (outcome.status === "failed" || outcome.status === "refused")
          batchSucceeded = false;
        let content = outcome.content;
        if (content.length > resultLimit) {
          const note = options.storeOverflow
            ? await options.storeOverflow(toolCall.function.name, content)
            : "The rest was cut to save room.";
          traceOurs(
            "packages/agent-runtime/src/conversation-turn.ts:runConversationTurn",
            "rewritten",
            `Tool result shortened to ${resultLimit} characters`,
          );
          content = `${content.slice(0, resultLimit)}\n… ${note}`;
        }
        turnMessages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content,
        });
        await emit({
          type: "tool_finished",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          label,
          outcome: outcome.status ?? "done",
          summary: content.split("\n")[0]?.slice(0, 300) ?? "",
        });
      } finally {
        const message = [...turnMessages]
          .reverse()
          .find((m) => m.role === "tool" && m.toolCallId === toolCall.id);
        observeTool(
          options,
          toolCall,
          message?.content ?? null,
          observedToolStart,
        );
      }
    }
    const batch = JSON.stringify({
      calls: toolCalls.map(({ function: fn }) => fn),
      results: turnMessages
        .slice(batchStart)
        .filter((message) => message.role === "tool")
        .map((message) => message.content),
    });
    repeatedBatches =
      !madeProgress && batch === lastBatch ? repeatedBatches + 1 : 0;
    lastBatch = batch;
    if (repeatedBatches >= (options.ceilings?.noProgressStepLimit ?? 12))
      return result("model_failed", {
        error: new Error(
          "The assistant kept repeating the same step without progress. Try a different approach.",
        ),
      });
  }
  return result("ceiling");
}
