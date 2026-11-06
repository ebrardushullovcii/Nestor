import type {
  AgentLoopMessage,
  AgentLoopTool,
  AgentLoopToolOutcome,
} from "./agent-loop";

export function contextMessageChars(message: AgentLoopMessage): number {
  return (
    message.content.length +
    (message.role === "assistant"
      ? (message.continuation?.text.length ?? 0) +
        JSON.stringify(message.toolCalls ?? []).length
      : 0)
  );
}

/** Model-window recovery, not a spending limit. Archived messages remain readable verbatim. */
export function createContextHistory(maxChars: number) {
  const archives: AgentLoopMessage[][] = [];
  const tool: AgentLoopTool = {
    definition: {
      type: "function",
      function: {
        name: "read_context_history",
        description:
          "Read exact earlier conversation messages moved out of the active context at the model's context window. Archive ids are in the context-recovery note. Optional start/end select a message range (zero-based, end exclusive); omit both to read the entire archive. Nothing is summarized or shortened in this tool.",
        parameters: {
          type: "object",
          properties: {
            archive: { type: "integer", minimum: 1 },
            start: { type: "integer", minimum: 0 },
            end: { type: "integer", minimum: 0 },
          },
          required: ["archive"],
        },
      },
    },
    execute: (raw) => Promise.resolve(readArchive(raw)),
  };
  function readArchive(raw: string): AgentLoopToolOutcome {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        kind: "ok",
        content:
          "Expected JSON with an integer archive id and optional integer start/end.",
      };
    }
    if (
      !args ||
      typeof args !== "object" ||
      Array.isArray(args) ||
      !Number.isInteger(args.archive) ||
      Number(args.archive) < 1 ||
      [args.start, args.end].some(
        (value) =>
          value !== undefined &&
          (!Number.isInteger(value) || Number(value) < 0),
      )
    )
      return {
        kind: "ok",
        content:
          "Expected a positive integer archive and optional nonnegative integer start/end.",
      };
    const archive = archives[Number(args.archive) - 1];
    if (!archive)
      return {
        kind: "ok",
        content: `No archive ${String(args.archive)}. Available archives: ${archives.length}.`,
      };
    // Private provider continuation is not public transcript data.
    const messages = archive
      .slice(
        Number(args.start ?? 0),
        args.end === undefined ? undefined : Number(args.end),
      )
      .map((message) => {
        if (message.role !== "assistant") return message;
        return {
          role: message.role,
          content: message.content,
          ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
        };
      });
    return {
      kind: "ok",
      content: JSON.stringify({
        archive: args.archive,
        totalMessages: archive.length,
        messages,
      }),
    };
  }

  return {
    tool,
    compact(
      messages: AgentLoopMessage[],
      openingCount: number,
      notes: readonly string[],
    ): AgentLoopMessage[] {
      const total = messages.reduce(
        (size, message) => size + contextMessageChars(message),
        0,
      );
      if (total <= maxChars) return messages;
      const opening = messages.slice(0, openingCount);
      const summary: AgentLoopMessage = {
        role: "user",
        content: [
          "Earlier turns were moved to exact context-history archives at the model's context window. Use read_context_history for their complete messages; no facts were discarded.",
          `Archives 1 through ${archives.length + 1} are available, including earlier recovery notes and their referenced page observations.`,
          "Action notes (the exact messages remain in the archives):",
          ...notes.map((note) => `- ${note}`),
        ].join("\n"),
      };
      // Recover to half the window in whole assistant/tool batches, then append
      // unchanged until the window fills again. Never slide a fixed turn window.
      let size =
        opening.reduce(
          (sum, message) => sum + contextMessageChars(message),
          0,
        ) + contextMessageChars(summary);
      let cut = messages.length;
      for (let index = messages.length - 1; index >= openingCount; index--) {
        size += contextMessageChars(messages[index]!);
        if (messages[index]?.role !== "assistant") continue;
        if (cut !== messages.length && size > maxChars / 2) break;
        cut = index;
      }
      if (cut <= openingCount || cut === messages.length) return messages;
      archives.push(messages.slice(openingCount, cut));
      return [...opening, summary, ...messages.slice(cut)];
    },
  };
}
