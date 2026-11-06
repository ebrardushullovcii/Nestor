import { expect, test, vi } from "vitest";
import type { ListingCard } from "@nestor/contracts";
import { collectRenderedInventory } from "./rendered-inventory";
import { buildApplyFormObservation } from "../apply/page-hands";
import type { ApplyPageHands } from "../apply/types";

const card = (id: number) =>
  `<article class="job"><p class="company">Example Employer</p><h2><a href="/vacancy/${id}">Data Analyst ${id}</a></h2><p>Remote Germany</p></article>`;
function setup(kind: "append" | "replace", blocked = false) {
  let batch = 1;
  const html = () =>
    Array.from({ length: kind === "append" ? batch : 1 }, (_, i) =>
      card(kind === "append" ? i + 1 : batch),
    ).join("") +
    (batch < 3
      ? "<button>Show more roles</button>"
      : "<button disabled>Show more roles</button>");
  const page = {
    content: () => Promise.resolve(html()),
    url: () => "https://example.test/jobs",
  };
  const hands = {
    observe: () =>
      Promise.resolve(
        buildApplyFormObservation(
          {
            url: page.url(),
            title: "Jobs",
            bodyText: "Open jobs",
            headings: [],
            links: [],
            controls: [],
            clickables: [],
            openedTabs: [],
            loading: false,
            validationErrors: [],
            stepLabel: null,
            actions: [
              {
                index: 0,
                label: "Show more roles",
                visible: true,
                disabled: batch === 3,
              },
            ],
          },
          "2026-11-05T00:00:00Z",
        ),
      ),
    clickElement: vi.fn(() => {
      if (!blocked) batch++;
      return Promise.resolve({ ok: true });
    }),
    wait: vi.fn(() => Promise.resolve()),
  } as unknown as ApplyPageHands;
  return { page, hands };
}

test.each(["append", "replace"] as const)(
  "persists every %s batch before advancing and confirms final coverage",
  async (kind) => {
    const input = setup(kind),
      saved: number[][] = [];
    const result = await collectRenderedInventory({
      ...input,
      source: { id: "s", label: "Example" },
      maxPages: 8,
      allowUrl: () => true,
      onPage: (cards) => {
        saved.push(cards.map((c) => Number(c.url.split("/").at(-1))));
        return Promise.resolve();
      },
    });
    expect(saved).toEqual([[1], [2], [3]]);
    expect(result).toMatchObject({ complete: true, pagesRead: 3 });
    expect(result?.cards).toHaveLength(3);
    expect(input.hands.clickElement).toHaveBeenCalledTimes(2);
  },
);

test("a failed next-batch wait keeps early cards and an honest continuation", async () => {
  const result = await collectRenderedInventory({
    ...setup("append", true),
    source: { id: "s", label: "Example" },
    maxPages: 8,
    allowUrl: () => true,
    onPage: () => Promise.resolve(),
  });
  expect(result?.complete).toBe(false);
  expect(result?.cards).toHaveLength(1);
  expect(result?.notes.join(" ")).toContain("Nestor's wait");
  expect(result?.notes.join(" ")).toContain("Continue unfinished sites");
});

test("a temporarily disabled loading button is not completion evidence", async () => {
  const input = setup("append"),
    content = input.page.content,
    observe = input.hands.observe,
    advance = input.hands.clickElement;
  let pending = false,
    waits = 0;
  input.page.content = async () =>
    (await content()).replace(
      "<button>",
      pending ? "<button disabled>" : "<button>",
    );
  input.hands.observe = async () => {
    const view = await observe();
    if (pending) for (const action of view.actions) action.disabled = true;
    return view;
  };
  input.hands.clickElement = () => {
    pending = true;
    return Promise.resolve({ ok: true, observedValue: "clicked" });
  };
  input.hands.wait = async () => {
    if (++waits % 2 === 0) {
      pending = false;
      await advance("a0");
    }
  };
  const result = await collectRenderedInventory({
    ...input,
    source: { id: "s", label: "Example" },
    maxPages: 8,
    allowUrl: () => true,
    onPage: () => Promise.resolve(),
  });
  expect(result?.complete).toBe(true);
  expect(result?.cards).toHaveLength(3);
  expect(waits).toBe(4);
});

test("cancellation after a saved batch preserves the callback rather than transcribing", async () => {
  const controller = new AbortController(),
    saved = vi.fn<(cards: ListingCard[]) => Promise<void>>(() => {
      controller.abort();
      return Promise.resolve();
    });
  await expect(
    collectRenderedInventory({
      ...setup("append"),
      signal: controller.signal,
      source: { id: "s", label: "Example" },
      maxPages: 8,
      allowUrl: () => true,
      onPage: saved,
    }),
  ).rejects.toThrow();
  expect(saved).toHaveBeenCalledOnce();
  expect(saved.mock.calls[0]?.[0]).toHaveLength(1);
});
