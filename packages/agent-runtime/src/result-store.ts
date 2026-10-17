import type { AgentTaskResultReference } from "@nestor/contracts";

interface StoredResult {
  readonly summary: string;
  readonly items: readonly unknown[];
}

export class AgentTaskResultStore {
  readonly #values = new Map<string, StoredResult>();
  #counter = 0;

  put(input: { summary: string; value: unknown; inlineItemLimit?: number }): {
    reference: AgentTaskResultReference;
    inlineItems: readonly unknown[];
  } {
    const items = Array.isArray(input.value) ? input.value : [input.value];
    const handle = `result_${++this.#counter}`;
    const inlineItemLimit = Math.max(0, input.inlineItemLimit ?? 5);
    this.#values.set(handle, { summary: input.summary, items });
    const inlineItems = items.slice(0, inlineItemLimit);

    return {
      reference: {
        handle,
        summary: input.summary,
        itemCount: items.length,
        nextCursor:
          inlineItems.length < items.length ? String(inlineItems.length) : null,
      },
      inlineItems,
    };
  }

  read(input: { handle: string; cursor?: string | null; limit?: number }): {
    reference: AgentTaskResultReference;
    items: readonly unknown[];
  } | null {
    const stored = this.#values.get(input.handle);
    if (!stored) return null;
    const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
    const limit = Math.min(50, Math.max(1, input.limit ?? 10));
    const items = stored.items.slice(offset, offset + limit);
    const nextOffset = offset + items.length;

    return {
      reference: {
        handle: input.handle,
        summary: stored.summary,
        itemCount: stored.items.length,
        nextCursor:
          nextOffset < stored.items.length ? String(nextOffset) : null,
      },
      items,
    };
  }
}
