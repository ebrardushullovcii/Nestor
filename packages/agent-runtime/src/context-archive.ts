import { createHash } from "node:crypto";
import type { AgentLoopMessage } from "./agent-loop";

interface Prefix {
  previous: Prefix | null;
  chunk: string;
  length: number;
  key: string;
}
export interface ExactContextText {
  length: number;
  slice(start: number, end: number): string;
}
export const contextTextKey = (text: string): string =>
  createHash("sha256").update(text, "utf16le").digest("hex");

/** Immutable JSON snapshots share their prefixes, rather than serializing the
 * entire conversation again after every read. Only the requested part is joined. */
export function createContextArchive() {
  const prefixLength = (node: Prefix | null): number => node?.length ?? 0;
  const prefixes = new Map<string, Prefix>();
  const chunks = new WeakMap<
    AgentLoopMessage,
    { text: string; json: string; key: string }
  >();
  return (
    messages: readonly AgentLoopMessage[],
  ): ExactContextText & { key: string } => {
    let prefix: Prefix | null = null;
    for (const message of messages) {
      let chunk = chunks.get(message);
      if (chunk === undefined || chunk.text !== message.content) {
        const publicMessage =
          message.role === "assistant"
            ? {
                role: message.role,
                content: message.content,
                ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
              }
            : message;
        const json = JSON.stringify(publicMessage);
        chunk = { text: message.content, json, key: contextTextKey(json) };
        chunks.set(message, chunk);
      }
      const key = contextTextKey(`${prefix?.key ?? ""}:${chunk.key}`);
      let next: Prefix | undefined = prefixes.get(key);
      if (!next) {
        const text: string = `${prefix ? "," : "["}${chunk.json}`;
        next = {
          previous: prefix,
          chunk: text,
          length: prefixLength(prefix) + text.length,
          key,
        };
        prefixes.set(key, next);
      }
      prefix = next;
    }
    const saved = prefix;
    const length = (saved?.length ?? 1) + 1;
    return {
      key: saved?.key ?? "empty",
      length,
      slice(start, end) {
        const pieces: string[] = [];
        if (end > length - 1 && start < length) pieces.push("]");
        for (let node = saved; node && end > start; node = node.previous) {
          const from = node.length - node.chunk.length;
          if (start >= node.length) break;
          if (end > from)
            pieces.push(
              node.chunk.slice(
                Math.max(0, start - from),
                Math.min(node.chunk.length, end - from),
              ),
            );
        }
        if (!saved && start === 0 && end > 0) pieces.push("[");
        return pieces.reverse().join("");
      },
    };
  };
}
