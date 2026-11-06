import type { AgentLoopMessage } from "./agent-loop";
import { reportSelfLimitHit } from "@nestor/core";

/**
 * Keeping a long conversation inside a model's window.
 *
 * The budget is computed before every call: the route's limit, minus the
 * output reserved for the answer, the tool schemas and a margin. Provider
 * usage calibrates the estimate when it is reported; otherwise a character
 * estimate is used. Maintenance runs before the budget would be exceeded,
 * never on a message count.
 */

const CHARS_PER_TOKEN = 3.6;
const MESSAGE_OVERHEAD_TOKENS = 6;

function messageText(message: AgentLoopMessage): string {
  if (message.role === "assistant" && message.toolCalls) {
    return `${message.content}${JSON.stringify(message.toolCalls)}`;
  }
  return message.content;
}

/** Rough token count for one message, before calibration. */
export function estimateMessageTokens(message: AgentLoopMessage): number {
  return (
    Math.ceil(messageText(message).length / CHARS_PER_TOKEN) +
    MESSAGE_OVERHEAD_TOKENS
  );
}

export function estimateTokens(messages: readonly AgentLoopMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + estimateMessageTokens(message),
    0,
  );
}

export function estimateJsonTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_TOKEN);
}

/**
 * Learns how far the character estimate is from what the provider counted,
 * so later estimates use the route's own tokenizer as a reference.
 */
export interface TokenCalibrator {
  /** Records one call: what was estimated and what the provider reported. */
  observe(estimatedTokens: number, reportedInputTokens: number): void;
  /** Applies the learned ratio (never below 0.7 or above 2). */
  adjust(estimatedTokens: number): number;
  ratio(): number;
}

export function createTokenCalibrator(): TokenCalibrator {
  let ratio = 1;
  let observations = 0;
  return {
    observe(estimatedTokens, reportedInputTokens) {
      if (estimatedTokens <= 0 || reportedInputTokens <= 0) return;
      const observed = reportedInputTokens / estimatedTokens;
      observations += 1;
      // A running mean that settles quickly; one odd call cannot swing it.
      ratio = ratio + (observed - ratio) / Math.min(observations, 5);
      ratio = Math.min(2, Math.max(0.7, ratio));
    },
    adjust(estimatedTokens) {
      return Math.ceil(estimatedTokens * ratio);
    },
    ratio() {
      return ratio;
    },
  };
}

export interface PromptBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  toolSchemaTokens: number;
  /** Room for the next bounded tool result and anything unforeseen. */
  marginTokens: number;
}

export function availablePromptTokens(budget: PromptBudget): number {
  return Math.max(
    1_000,
    budget.contextWindowTokens -
      budget.reservedOutputTokens -
      budget.toolSchemaTokens -
      budget.marginTokens,
  );
}

/**
 * Layer 1: older tool output becomes a short receipt.
 *
 * A page snapshot or a long list read ten steps ago is rarely needed again,
 * and the tool can be asked again (or its handle read). Calls stay paired
 * with their results; only the content of results older than the most
 * recent `keepRecent` is replaced, in one batch, so the cached prefix is not
 * rewritten on every call.
 */
export function elideOldToolOutputs(
  messages: readonly AgentLoopMessage[],
  options: {
    keepRecent: number;
    /** Results at or below this size are left alone. */
    minCharsToElide?: number;
    describe?: (toolName: string | null, content: string) => string;
  },
): { messages: AgentLoopMessage[]; elided: number } {
  const minChars = options.minCharsToElide ?? 600;
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        toolNameById.set(call.id, call.function.name);
      }
    }
  }
  const toolIndexes = messages
    .map((message, index) => (message.role === "tool" ? index : -1))
    .filter((index) => index >= 0);
  const protectedFrom =
    toolIndexes.length > options.keepRecent
      ? (toolIndexes[toolIndexes.length - options.keepRecent] ?? 0)
      : 0;
  let elided = 0;
  const next = messages.map((message, index) => {
    if (
      message.role !== "tool" ||
      index >= protectedFrom ||
      message.content.length <= minChars ||
      message.content.startsWith("[Earlier result]")
    ) {
      return message;
    }
    elided += 1;
    reportSelfLimitHit({
      limit: "old_tool_outputs",
      kind: "context",
      value: options.keepRecent,
      where: "agent-runtime/elideOldToolOutputs",
    });
    const toolName = toolNameById.get(message.toolCallId) ?? null;
    const firstLine = message.content.split("\n")[0]?.slice(0, 240) ?? "";
    return {
      ...message,
      content:
        options.describe?.(toolName, message.content) ??
        `[Earlier result] ${toolName ?? "tool"}: ${firstLine} (shortened to save room; call the tool again if you need the details).`,
    };
  });
  return { messages: next, elided };
}

/**
 * Layer 2: the oldest exchanges leave the prompt until it fits.
 *
 * Cuts only where a new person message starts, so a tool result never loses
 * the call it answers. Returns what was dropped so the caller can summarize
 * it (layer 3) and keep the older text retrievable by search.
 */
export function trimOldestExchanges(
  messages: readonly AgentLoopMessage[],
  options: { budgetTokens: number; keepRecentMessages: number },
  estimate: (messages: readonly AgentLoopMessage[]) => number = estimateTokens,
): { kept: AgentLoopMessage[]; dropped: AgentLoopMessage[] } {
  if (estimate(messages) <= options.budgetTokens) {
    return { kept: [...messages], dropped: [] };
  }
  const boundaries = messages
    .map((message, index) =>
      message.role === "user" && index > 0 ? index : -1,
    )
    .filter((index) => index > 0);
  const latestAllowedCut = Math.max(
    0,
    messages.length - Math.max(2, options.keepRecentMessages),
  );
  let cut = 0;
  for (const boundary of boundaries) {
    if (boundary > latestAllowedCut) break;
    cut = boundary;
    if (estimate(messages.slice(cut)) <= options.budgetTokens) break;
  }
  if (cut > 0)
    reportSelfLimitHit({
      limit: "old_exchanges",
      kind: "context",
      value: options.budgetTokens,
      where: "agent-runtime/trimOldestExchanges",
    });
  return { kept: messages.slice(cut), dropped: messages.slice(0, cut) };
}
