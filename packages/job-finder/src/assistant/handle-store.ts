import type { AssistantHandleStore } from "./tool-kit";

/**
 * Long tool outputs kept for paging (`read_result` with a handle). Handles
 * live for the process; after a restart the tool is simply run again.
 */
export function createHandleStore(prefix: string): AssistantHandleStore {
  const values = new Map<string, { summary: string; items: unknown[] }>();
  let counter = 0;
  return {
    put(summary, items) {
      counter += 1;
      const handle = `${prefix}_h${counter}`;
      values.set(handle, { summary, items: [...items] });
      return { handle, total: items.length };
    },
    read(handle, cursor, limitCount) {
      const stored = values.get(handle);
      if (!stored) return null;
      const items = stored.items.slice(cursor, cursor + limitCount);
      const next = cursor + items.length;
      return {
        summary: stored.summary,
        items,
        total: stored.items.length,
        next: next < stored.items.length ? next : null,
      };
    },
  };
}
