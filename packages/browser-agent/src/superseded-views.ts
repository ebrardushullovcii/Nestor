import type {
  AgentLoopMessage,
  SupersededRewrite,
} from "@nestor/agent-runtime";

interface WrittenView {
  id: string;
  text: string;
  /** A view this one is written against, which stays whole while it is newest. */
  baseId: string | null;
  url: string | null;
  title: string | null;
}

/**
 * The page views a browser agent has written into its conversation.
 *
 * The newest view (and the full view it is written against) is the page as
 * it is. Every earlier view is the page as it was before the model acted
 * again; it is superseded and can be folded to a one-line receipt. The agent
 * loop decides when to fold and keeps each folded message readable word for
 * word, so the model's action history and every fact stay available.
 */
export function createViewLedger() {
  const views = new Map<string, WrittenView>();
  // Views that may still be whole in the conversation, oldest first.
  const pending: string[] = [];
  let latestId: string | null = null;
  let sequence = 0;

  return {
    /** Records a view as written; returns its text unchanged. */
    write(
      text: string,
      page: { url: string | null; title: string | null } | null,
      options: { id?: string; baseId?: string | null } = {},
    ): string {
      const id = options.id ?? `view_${++sequence}`;
      views.set(id, {
        id,
        text,
        baseId: options.baseId ?? null,
        url: page?.url ?? null,
        title: page?.title ?? null,
      });
      pending.push(id);
      latestId = id;
      return text;
    },
    /** A view written again after compaction can be folded again later. */
    rewrite(id: string): void {
      if (views.has(id) && !pending.includes(id)) pending.push(id);
    },
    supersededContent(
      messages: readonly AgentLoopMessage[],
    ): SupersededRewrite[] {
      const latest = latestId ? views.get(latestId) : undefined;
      if (!latest) return [];
      const live = new Set([latest.id, latest.baseId]);
      // Where each live view is now. A page that looked the same earlier
      // has the same text; that earlier copy folds, this one never does.
      const kept = new Map<string, number>();
      for (const id of live) {
        const text = id ? views.get(id)?.text : undefined;
        if (!text) continue;
        messages.forEach((message, index) => {
          if (message.role !== "system" && message.content.includes(text))
            kept.set(text, index);
        });
      }
      // A view that never reached the conversation (a run's final output)
      // replaces nothing.
      if (!kept.has(latest.text)) return [];
      const rewrites = new Map<number, string>();
      for (const id of [...pending]) {
        const view = views.get(id)!;
        if (live.has(view.id) || !view.text) continue;
        let found = false;
        messages.forEach((message, index) => {
          if (message.role === "system") return;
          const content = rewrites.get(index) ?? message.content;
          if (!content.includes(view.text) || kept.get(view.text) === index)
            return;
          found = true;
          rewrites.set(
            index,
            content
              .split(view.text)
              .join(
                `[Page view ${view.id}: ${view.url ?? "no address"}${view.title ? ` ("${view.title}")` : ""}, since replaced by ${latest.id}.]`,
              ),
          );
        });
        // Folded or archived already; nothing left to look for.
        if (!found) pending.splice(pending.indexOf(id), 1);
      }
      // A screenshot taken before the newest view shows a page since replaced.
      let newest = -1;
      messages.forEach((message, index) => {
        if (
          message.role !== "system" &&
          (rewrites.get(index) ?? message.content).includes(latest.text)
        )
          newest = index;
      });
      const screenshots = new Set<number>();
      messages.forEach((message, index) => {
        if (
          index < newest &&
          message.role === "tool" &&
          message.images?.length
        ) {
          screenshots.add(index);
          rewrites.set(
            index,
            `${rewrites.get(index) ?? message.content}\n[Screenshot folded: later page view ${latest.id} replaced this page.]`,
          );
        }
      });
      return [...rewrites].map(([index, content]) => ({
        index,
        content,
        ...(screenshots.has(index) ? { dropImages: true } : {}),
      }));
    },
  };
}
