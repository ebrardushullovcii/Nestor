import { expect, test } from "vitest";
import { buildApplyFormObservation } from "../apply/page-hands";
import {
  describeSearchObservation,
  createSearchViewDescriber,
  UNCHANGED_VIEW_NOTE,
} from "./search-observation";

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
  let answers = 0;
  const views = createSearchViewDescriber(() => answers);
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
  answers++;
  expect(views.describe(view)).toBe(UNCHANGED_VIEW_NOTE);
  answers += 3;
  expect(views.describe(view)).toBe(first);
});
