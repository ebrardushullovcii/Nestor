import { expect, test } from "vitest";
import { buildApplyFormObservation } from "../apply/page-hands";
import {
  describeSearchObservation,
  createSearchViewDescriber,
  UNCHANGED_VIEW_NOTE,
  searchObservationDelta,
  applySearchObservationDelta,
  searchViewOf,
  type SearchObservationDelta,
} from "./search-observation";
import { createPageTools } from "../page-tools";
import type { AgentLoopMessage } from "@nestor/agent-runtime";
import type { ApplyPageHands } from "../apply/types";

test("search observations preserve every link, multiline label, heading, action and full text", () => {
  const view = buildApplyFormObservation(
    {
      url: "https://example.test",
      title: "Jobs",
      bodyText: "text",
      controls: [],
      actions: [],
      links: [],
      headings: [],
      clickables: [],
      openedTabs: [],
      loading: false,
      validationErrors: [],
      stepLabel: null,
    },
    "2026-11-06T00:00:00Z",
  );
  view.bodyTextExcerpt = "evidence ".repeat(10000) + "End requirements";
  view.links = Array.from({ length: 250 }, (_, i) => ({
    ref: `l${i}`,
    label: `Inxhinier ${i}\nEmployer\nEurope`,
    href: `https://example.test/job/${i}`,
    visible: true,
    destination: "page" as const,
    opensNewWindow: false,
    origin: "https://example.test",
    topOffset: i,
  }));
  const output = describeSearchObservation(view);
  const decoded: unknown = JSON.parse(output.slice(output.indexOf("\n") + 1));
  expect(decoded).toEqual(view);
});

test("an unchanged view is reusable while the complete view stays in history", () => {
  const views = createSearchViewDescriber();
  const view = buildApplyFormObservation(
    {
      url: "https://example.test",
      title: "Jobs",
      bodyText: "Listing text\n".repeat(200),
      controls: [],
      actions: [],
      links: [],
      headings: [],
      clickables: [],
      openedTabs: [],
      loading: false,
      validationErrors: [],
      stepLabel: null,
    },
    "2026-11-06T00:00:00Z",
  );
  const first = views.describe(view);
  expect(first).toContain('"kind":"full"');
  const changed = {
    ...view,
    observedAt: "2026-11-07T00:00:00Z",
    networkMutationCount: 1234,
    signature: "fresh-signature",
  };
  const delta = views.describe(changed);
  expect(delta).toContain(UNCHANGED_VIEW_NOTE);
  const decoded = JSON.parse(
    delta.slice(delta.indexOf("\n") + 1),
  ) as SearchObservationDelta;
  expect(applySearchObservationDelta(view, decoded)).toEqual(changed);
  expect(views.describe(changed)).toContain('"kind":"delta"');
  const restored = views.restoreContext(
    [{ role: "tool", toolCallId: "action", content: delta }],
    changed,
  );
  expect(restored).toContain(first);
  expect(
    views.restoreContext(
      [
        { role: "user", content: first },
        { role: "tool", toolCallId: "action", content: delta },
      ],
      changed,
    ),
  ).toBeNull();
});

test("page deltas round-trip insertions, deletions, reordered and duplicate entries, empty arrays and removed optional fields", () => {
  const view = {
    url: "https://example.test",
    observedAt: "before",
    navigationNote: "old",
    links: Array.from({ length: 50 }, (_, i) => ({
      ref: `l${i}`,
      label: `Listing ${i}`,
      href: `https://example.test/${i}`,
    })),
    controls: [{ ref: "old", value: "old" }],
    bodyTextExcerpt: "all the text",
  } as unknown as Parameters<typeof searchObservationDelta>[0];
  const rest = structuredClone(view);
  delete rest.navigationNote;
  const current = {
    ...rest,
    observedAt: "after",
    links: [
      view.links[10],
      view.links[10],
      ...view.links.slice(20),
      { ...view.links[0], label: "changed" },
    ],
    controls: [],
    loading: false,
  };
  const delta = searchObservationDelta(view, current, "base", "next");
  expect(delta.unset).toContain("navigationNote");
  expect(delta.arrays.links).toBeDefined();
  expect(applySearchObservationDelta(view, delta)).toEqual(current);
});

test("observe explicitly returns the whole page even after a reusable action delta", async () => {
  const view = {
    observedAt: "now",
    links: [],
    controls: [],
    actions: [],
    clickables: [],
    headings: [],
    bodyTextExcerpt: "evidence".repeat(1000),
    openedTabs: [],
  } as unknown as Parameters<typeof searchObservationDelta>[0];
  const views = createSearchViewDescriber();
  views.pinView(view);
  expect(views.describe(view)).toContain('"kind":"delta"');
  const page = createPageTools(
    { observe: () => Promise.resolve(view) } as ApplyPageHands,
    {
      describe: (observation) => views.describe(observation),
      describeFull: (observation) => views.pinView(observation),
    },
  );
  const result = await page.tools
    .find((tool) => tool.definition.function.name === "observe")!
    .execute("{}", { step: 1 });
  expect(result.kind === "ok" && result.content).toContain('"kind":"full"');
  expect(result.kind === "ok" && result.content).toContain(
    view.bodyTextExcerpt,
  );
});

const listing = (i: number, ref = `l${i}`) => ({
  ref,
  label: `Software Engineer ${i}\nEmployer ${i}\nEurope`,
  href: `https://example.test/job/${i}`,
  visible: true,
  destination: "page" as const,
  opensNewWindow: false,
  origin: "https://example.test",
  topOffset: i * 40,
});
const resultsPage = (
  cards: number,
  refs: (i: number) => string = (i) => `l${i}`,
) =>
  ({
    url: "https://example.test/jobs",
    title: "Jobs",
    observedAt: "now",
    signature: "s",
    links: Array.from({ length: cards }, (_, i) => listing(i, refs(i))),
    controls: Array.from({ length: 80 }, (_, i) => ({
      ref: `c${i}`,
      kind: "checkbox",
      label: `Location ${i}`,
      visible: false,
      required: false,
      disabled: false,
      checked: false,
      options: [],
      visibility: {
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        inViewport: false,
        offCanvas: true,
        zeroSize: true,
        ariaHidden: false,
        cssHidden: true,
        viewportWidth: 1262,
        viewportHeight: 661,
      },
    })),
    actions: [],
    clickables: [],
    headings: [],
    openedTabs: [],
    bodyTextExcerpt: Array.from(
      { length: cards },
      (_, i) =>
        `[Page target {"clickRef":"${refs(i)}"}]\nSoftware Engineer ${i} → https://example.test/job/${i}\nEmployer ${i}\nEurope`,
    ).join("\n"),
    bodyTextForQuestions: Array.from(
      { length: cards },
      (_, i) => `  \n \n Software Engineer ${i} \n\t Employer ${i}`,
    ).join("\n \n"),
  }) as unknown as Parameters<typeof searchObservationDelta>[0];

const decode = (text: string) =>
  JSON.parse(text.slice(text.indexOf("\n") + 1)) as Record<string, unknown>;

test("a page that grows sends its new cards and line ranges of the text it already showed", () => {
  const views = createSearchViewDescriber();
  const first = resultsPage(60);
  const firstText = views.pinView(first);
  const more = resultsPage(70);
  const delta = views.describe(more);
  expect(delta).toContain('"kind":"delta"');
  // The ten new cards, not the sixty already shown.
  expect(delta.length).toBeLessThan(firstText.length / 4);
  const decoded = decode(delta) as unknown as SearchObservationDelta;
  expect(decoded.texts?.bodyTextExcerpt).toBeDefined();
  const base = (decode(firstText) as { observation: typeof first }).observation;
  const rebuilt = applySearchObservationDelta(base, decoded);
  expect(rebuilt.bodyTextExcerpt).toBe(more.bodyTextExcerpt);
  expect(rebuilt.links.slice(0, 60)).toEqual(base.links);
});

test("the same cards drawn again under new refs are copied with their new refs", () => {
  const before = resultsPage(50);
  const after = resultsPage(50, (i) => `l${500 + i}`);
  const delta = searchObservationDelta(before, after, "base", "next");
  expect(delta.arrays.links).toEqual([
    {
      copy: [0, 50],
      refs: Array.from({ length: 50 }, (_, i) => `l${500 + i}`),
    },
  ]);
  expect(applySearchObservationDelta(before, delta)).toEqual(after);
});

test("full views state default entry fields once and keep every other fact", () => {
  const page = resultsPage(5);
  const view = searchViewOf(page);
  const full = createSearchViewDescriber().pinView(page);
  expect(full).toContain("Entry fields left out have these values:");
  expect(view.controls[0]).toEqual({
    ref: "c0",
    kind: "checkbox",
    label: "Location 0",
    visibility: { viewportWidth: 1262, viewportHeight: 661 },
  });
  expect(view.links[0]).toEqual({
    ref: "l0",
    label: page.links[0].label,
    href: page.links[0].href,
    origin: "https://example.test",
    topOffset: 0,
  });
  // Raw page text keeps every word; only runs of blank space shrink.
  expect(view.bodyTextForQuestions!.split(/\s+/u)).toEqual(
    page.bodyTextForQuestions!.trim().split(/\s+/u),
  );
  expect(view.bodyTextForQuestions).not.toMatch(/\n\s*\n| {2}/u);
});

test("earlier views fold to receipts; the newest and its full base stay whole", () => {
  const views = createSearchViewDescriber();
  const landed = views.pinView(resultsPage(40));
  const scrolled = views.describe(resultsPage(42));
  const scrolledAgain = views.describe(resultsPage(44));
  const messages: AgentLoopMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: `The page you have landed on:\n\n${landed}` },
    {
      role: "tool",
      toolCallId: "a",
      content: `Scrolled. The page now:\n\n${scrolled}`,
    },
    {
      role: "tool",
      toolCallId: "shot",
      content: "Current page.",
      images: [
        { dataUrl: "data:image/png;base64,AAAA", label: "Current page." },
      ],
    },
    {
      role: "tool",
      toolCallId: "b",
      content: `Scrolled. The page now:\n\n${scrolledAgain}`,
    },
  ];
  const rewrites = views.supersededContent(messages);
  // The landed page is the base of the newest delta; only the first delta
  // and the screenshot before the newest view fold.
  expect(rewrites.map((rewrite) => rewrite.index).sort()).toEqual([2, 3]);
  expect(rewrites.find((r) => r.index === 2)!.content).toBe(
    'Scrolled. The page now:\n\n[Page view search_view_2: https://example.test/jobs ("Jobs"), since replaced by search_view_3.]',
  );
  expect(rewrites.find((r) => r.index === 3)).toMatchObject({
    dropImages: true,
  });

  const pinned = views.pinView(resultsPage(44));
  messages.push({ role: "tool", toolCallId: "c", content: pinned });
  expect(
    views
      .supersededContent(messages)
      .map((rewrite) => rewrite.index)
      .sort(),
  ).toEqual([1, 2, 3, 4]);
});
