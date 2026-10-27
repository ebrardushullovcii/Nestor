import { expect, test, vi } from "vitest";
import { NeedsYouTaskSchema } from "@nestor/contracts";
import { createSourceHandoffs } from "./source-handoffs";
import type { EmbeddedBrowser } from "../browser/embedded-browser";

test("a source's task owns its handoff tab until recovery, cancellation or deletion", () => {
  const task = NeedsYouTaskSchema.parse({
    id: 12,
    kind: "sign_in",
    key: "source-access:4",
    scope: {},
    prompt: "Sign in",
    input: "text",
    options: [],
    openedAt: new Date().toISOString(),
    source: { id: 4, label: "Synthetic", url: "https://synthetic.test/jobs" },
  });
  let current: typeof task | null = task;
  const browser = {
    reopenParkedTab: vi.fn<EmbeddedBrowser["reopenParkedTab"]>(
      (_url, id) => id ?? "opened",
    ),
    closeParkedTab: vi.fn(),
  };
  const handoffs = createSourceHandoffs({ browser, task: () => current });
  handoffs.open(task);
  handoffs.open(task);
  expect(browser.reopenParkedTab.mock.calls.map((call) => call[1])).toEqual([
    "source-handoff-12-4",
    "source-handoff-12-4",
  ]);
  handoffs.reconcile();
  expect(browser.closeParkedTab).not.toHaveBeenCalled();
  current = null;
  handoffs.reconcile();
  expect(browser.closeParkedTab).toHaveBeenCalledExactlyOnceWith(
    "source-handoff-12-4",
  );
  current = task;
  handoffs.open(task);
  current = {
    ...task,
    source: { ...task.source!, url: "https://synthetic.test/new" },
  };
  handoffs.reconcile();
  expect(browser.closeParkedTab).toHaveBeenCalledTimes(2);
});
