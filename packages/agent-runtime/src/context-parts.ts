import type {
  AgentLoopMessage,
  AgentLoopTool,
  AgentLoopToolOutcome,
} from "./agent-loop";
import { contextMessageChars } from "./context-history";
import {
  createContextArchive,
  contextTextKey,
  type ExactContextText,
} from "./context-archive";

/** Provider input rejection, including gateways that wrap the provider's error. */
export function isModelInputLimit(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let value = error; value && !seen.has(value); ) {
    seen.add(value);
    if (typeof value === "string")
      return /input too long|context_length_exceeded|maximum context length|context window.*exceed|prompt.*too (?:long|large)|too many input tokens/iu.test(
        value,
      );
    if (typeof value !== "object") return false;
    const detail = value as {
      message?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (
      [detail.message, detail.code].some(
        (text) => typeof text === "string" && isModelInputLimit(text),
      )
    )
      return true;
    value = detail.cause;
  }
  return false;
}

/** Exact, run-owned content. Part size is a representation of the route window,
 * never a limit on the amount of evidence the model can read. */
export function createContextParts() {
  const contents = new Map<string, ExactContextText>();
  const ids = new Map<string, string>();
  const archive = createContextArchive();
  const messageIds = new WeakMap<
    AgentLoopMessage,
    { text: string; id: string }
  >();
  let nextId = 0;
  let partChars = 1;
  let recoveryChars = Infinity;
  const remember = (text: string): string => {
    const key = contextTextKey(text);
    const existing = ids.get(key);
    if (existing) return existing;
    const id = `context-${++nextId}`;
    contents.set(id, text);
    ids.set(key, id);
    return id;
  };
  const part = (id: string, offset: number): AgentLoopToolOutcome => {
    const text = contents.get(id);
    if (text === undefined)
      return {
        kind: "ok",
        content:
          "Unknown context part id; use an id from the current context-part notice.",
      };
    if (offset > text.length)
      return {
        kind: "ok",
        content: `Offset exceeds ${text.length} UTF-16 characters.`,
      };
    const end = Math.min(text.length, offset + partChars);
    return {
      kind: "ok",
      content: JSON.stringify({
        id,
        offset,
        end,
        totalChars: text.length,
        nextOffset: end < text.length ? end : null,
        text: text.slice(offset, end),
      }),
    };
  };
  const tool: AgentLoopTool = {
    definition: {
      type: "function",
      function: {
        name: "read_context_part",
        description:
          "Read the next ordered part of an exact observation or conversation archive that does not fit inline. Use the notice's id and nextOffset (UTF-16 characters). Follow nextOffset until null to read every character. The saved snapshot does not change when the browser changes. Nothing is summarized or discarded.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            offset: { type: "integer", minimum: 0 },
          },
          required: ["id", "offset"],
        },
      },
    },
    execute: (raw) => {
      let args: { id?: unknown; offset?: unknown };
      try {
        args = JSON.parse(raw) as typeof args;
      } catch {
        args = {};
      }
      if (
        !args ||
        typeof args.id !== "string" ||
        !Number.isInteger(args.offset) ||
        Number(args.offset) < 0
      )
        return Promise.resolve({
          kind: "ok",
          content: "Expected a string id and nonnegative integer offset.",
        });
      return Promise.resolve(part(args.id, Number(args.offset)));
    },
  };
  const notice = (
    text: ExactContextText,
    previewChars: number,
    id: string,
  ): string => {
    const end = Math.min(text.length, previewChars);
    return `[Exact content in ordered parts: ${id}; totalChars=${text.length}. First part: characters 0..${end}. Read the rest with read_context_part({"id":"${id}","offset":${end}}); follow nextOffset until null. Every character remains available.]\n${text.slice(0, end)}`;
  };
  const messageId = (message: AgentLoopMessage) => {
    let saved = messageIds.get(message);
    if (!saved || saved.text !== message.content) {
      saved = { text: message.content, id: remember(message.content) };
      messageIds.set(message, saved);
    }
    return saved.id;
  };
  const size = (messages: readonly AgentLoopMessage[]) =>
    messages.reduce((n, message) => n + contextMessageChars(message) + 32, 0);
  return {
    tool,
    /** Called only after an actual provider rejection. No actions are replayed. */
    recover(maxChars: number): void {
      recoveryChars = Math.max(
        1,
        Math.floor(Math.min(maxChars, recoveryChars) / 2),
      );
    },
    prepare(
      messages: readonly AgentLoopMessage[],
      maxChars: number,
    ): AgentLoopMessage[] {
      const windowChars = Math.max(1, Math.min(maxChars, recoveryChars));
      partChars = Math.max(1, Math.floor(windowChars / 4));
      if (size(messages) <= windowChars) return [...messages];
      let active = [...messages];
      const partCalls = new Set(
        messages.flatMap((message) =>
          message.role === "assistant"
            ? (message.toolCalls ?? [])
                .filter((call) => call.function.name === "read_context_part")
                .map((call) => call.id)
            : [],
        ),
      );
      const represent = () =>
        active.map((message) => {
          if (message.role === "tool" && partCalls.has(message.toolCallId)) {
            // Re-size a reader response from its original snapshot, never put
            // a page of the reader inside another page of the reader.
            try {
              const saved = JSON.parse(message.content) as {
                id?: unknown;
                offset?: unknown;
              };
              if (
                typeof saved.id === "string" &&
                contents.has(saved.id) &&
                Number.isInteger(saved.offset)
              ) {
                const resized = part(saved.id, Number(saved.offset));
                if (resized.kind === "ok")
                  return { ...message, content: resized.content };
              }
            } catch {
              /* A schema error remains an ordinary exact tool result. */
            }
          }
          return message.role !== "system" && message.content.length > partChars
            ? {
                ...message,
                content: notice(message.content, partChars, messageId(message)),
              }
            : message;
        });
      // Archive older complete call/result batches. The newest batch stays
      // inline; the archive preserves message roles, call ids and exact text.
      // Keep the original input/goal visible under its stable part id. Paging
      // action history must never replace it with a growing archive of reads.
      const first = messages.findIndex(
        (message) => message.role === "assistant",
      );
      let cut = messages.length - 1;
      while (
        cut > first &&
        messages[cut]?.role !== "assistant" &&
        messages[cut]?.role !== "user"
      )
        cut--;
      // A user observation can follow tool results. Keep its complete batch.
      while (cut > first && messages[cut - 1]?.role === "tool") cut--;
      while (
        cut > first &&
        messages[cut]?.role !== "assistant" &&
        messages[cut]?.role !== "user"
      )
        cut--;
      if (first >= 0 && cut > first) {
        const exact = archive(messages.slice(first, cut));
        // The prefix key is stable for an unchanged snapshot. Its JSON is
        // read lazily; never materialize a cumulative multi-megabyte string.
        const key = `history:${exact.key}`;
        let id = ids.get(key);
        if (!id) {
          id = `context-${++nextId}`;
          ids.set(key, id);
          contents.set(id, exact);
        }
        active = [
          ...messages.slice(0, first),
          {
            role: "user",
            content: `Earlier action history (exact archive; read only if needed). The original input remains above; continue reading its original id, not copies of earlier reads:\n${notice(exact, 0, id)}`,
          },
          ...messages.slice(cut),
        ];
      }
      // Only materialize the active batches. Resizing every archived reader
      // result on every turn also creates quadratic transient allocations.
      let represented = represent();
      // A single batch can contain many independent observations. Divide the
      // inline representation further until the entire batch fits, keeping
      // every original result behind its own stable id.
      while (size(represented) > windowChars && partChars > 1) {
        partChars = Math.max(1, Math.floor(partChars / 2));
        represented = represent();
      }
      return represented;
    },
  };
}

export type ContextParts = ReturnType<typeof createContextParts>;
