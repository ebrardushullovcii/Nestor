import { expect, test } from "vitest";
import { buildApplyFormObservation } from "../apply/page-hands";
import {
  describeSearchObservation,
  createSearchViewDescriber,
  UNCHANGED_VIEW_NOTE,
  searchObservationDelta,
  applySearchObservationDelta,
  type SearchObservationDelta,
} from "./search-observation";
import { createPageTools } from "../page-tools";
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
