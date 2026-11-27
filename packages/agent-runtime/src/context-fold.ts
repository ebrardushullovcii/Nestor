import type { AgentLoopMessage } from "./agent-loop";
import { contextMessageChars } from "./context-history";

/**
 * A rewrite of one earlier message the host has superseded: a page view the
 * model has since acted past, kept as a one-line receipt. `dropImages` also
 * folds a screenshot attached to that message.
 */
export interface SupersededRewrite {
  index: number;
  content: string;
  dropImages?: boolean;
}

function rewritten(
  message: AgentLoopMessage,
  rewrite: SupersededRewrite,
  note: string,
): AgentLoopMessage {
  const content = `${rewrite.content}${note}`;
  if (message.role === "tool" && rewrite.dropImages && message.images)
    return {
      role: "tool",
      toolCallId: message.toolCallId,
      content,
    };
  return { ...message, content };
}

function changes(message: AgentLoopMessage, rewrite: SupersededRewrite) {
  return (
    rewrite.content !== message.content ||
    (rewrite.dropImages === true &&
      message.role === "tool" &&
      Boolean(message.images?.length))
  );
}

/**
 * Folds superseded content in one batch, once that frees at least as many
 * characters as the fold makes the provider read again.
 *
 * A provider caches a request's leading prefix. Between folds the
 * conversation only grows at its end, so every request starts with the
 * previous request whole and is served from the cache. A fold rewrites
 * earlier messages, so whatever the previous request had already sent from
 * the first folded message on is read again, once. A fold that frees at
 * least that much is paid back by the next request, and every later request
 * stops resending what it freed.
 *
 * Nothing is lost: each folded message is kept word for word in an archive
 * the model reads with read_context_history, and its receipt names it.
 */
export function foldSupersededContent(
  messages: readonly AgentLoopMessage[],
  rewrites: readonly SupersededRewrite[],
  archive: (messages: AgentLoopMessage[]) => number,
  /** How many leading messages the previous model request sent. */
  sentBefore: number,
): AgentLoopMessage[] | null {
  const valid = rewrites.filter((rewrite) => {
    const message = messages[rewrite.index];
    return (
      message !== undefined &&
      message.role !== "system" &&
      changes(message, rewrite)
    );
  });
  if (!valid.length) return null;
  const preview = [...messages];
  let freed = 0;
  for (const rewrite of valid) {
    const message = messages[rewrite.index]!;
    const next = rewritten(message, rewrite, "");
    freed += contextMessageChars(message) - contextMessageChars(next);
    preview[rewrite.index] = next;
  }
  const first = Math.min(...valid.map((rewrite) => rewrite.index));
  const resent = preview
    .slice(first, Math.max(first, sentBefore))
    .reduce((sum, message) => sum + contextMessageChars(message), 0);
  if (freed < resent) return null;
  const folded = [...messages];
  for (const rewrite of valid) {
    const message = messages[rewrite.index]!;
    const id = archive([message]);
    folded[rewrite.index] = rewritten(
      message,
      rewrite,
      ` [Exact earlier message: read_context_history archive ${id}.]`,
    );
  }
  return folded;
}
