import type { NeedsYouTask } from "@nestor/contracts";
import type { EmbeddedBrowser } from "../browser/embedded-browser";

/** Only tabs created for these exact tickets are released. Session cookies stay. */
export function createSourceHandoffs(input: {
  browser: Pick<EmbeddedBrowser, "reopenParkedTab" | "closeParkedTab">;
  task(id: number): NeedsYouTask | null;
}) {
  const tabs = new Map<
    number,
    { tabId: string; sourceId: number; url: string }
  >();
  const reconcile = () => {
    for (const [id, held] of tabs) {
      const source = input.task(id)?.source;
      if (source?.id === held.sourceId && source.url === held.url) continue;
      tabs.delete(id);
      input.browser.closeParkedTab(held.tabId);
    }
  };
  return {
    reconcile,
    open(task: NeedsYouTask): boolean {
      if (!task.source) return false;
      reconcile();
      const tabId = input.browser.reopenParkedTab(
        task.source.url,
        tabs.get(task.id)?.tabId ??
          `source-handoff-${task.id}-${task.source.id}`,
        {
          kind: "sign_in",
          title: `Sign in to continue: ${task.source.label}`.slice(0, 160),
          detail:
            "Finish sign-in or verification here, then Retry in Needs you.",
        },
      );
      tabs.set(task.id, {
        tabId,
        sourceId: task.source.id,
        url: task.source.url,
      });
      reconcile();
      return true;
    },
  };
}
