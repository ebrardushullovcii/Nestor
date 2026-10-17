import type { AgentLoopMessage } from "@nestor/agent-runtime";

/**
 * Closes a turn the person stopped, for the stored history the next turns
 * read. Every tool call gets a result, and an assistant line records that
 * the request ended there, so a later unrelated message is not answered
 * with the stopped work (the model would otherwise see an open request).
 */
export function closeStoppedTurn(
  turnMessages: readonly AgentLoopMessage[],
  note = "Stopped by the person before this was finished. That request is closed: do not continue it or report its results unless they ask again.",
): AgentLoopMessage[] {
  const answered = new Set(
    turnMessages.flatMap((message) =>
      message.role === "tool" ? [message.toolCallId] : [],
    ),
  );
  const closing: AgentLoopMessage[] = [];
  for (const message of turnMessages) {
    if (message.role !== "assistant") continue;
    for (const call of message.toolCalls ?? []) {
      if (answered.has(call.id)) continue;
      answered.add(call.id);
      closing.push({
        role: "tool",
        toolCallId: call.id,
        content: "Stopped before this finished.",
      });
    }
  }
  closing.push({ role: "assistant", content: `[${note}]` });
  return closing;
}
