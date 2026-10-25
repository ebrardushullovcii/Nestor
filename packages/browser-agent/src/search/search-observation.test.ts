import type { RawApplyPage } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { buildApplyFormObservation } from "../apply/page-hands";
import { describeObservation } from "../apply/apply-prompts";
import {
  UNCHANGED_VIEW_NOTE,
  createSearchViewDescriber,
  describeSearchObservation,
} from "./search-observation";

function page(overrides: Partial<RawApplyPage> = {}) {
  const raw: RawApplyPage = {
    url: "https://jobs.example.test/jobs",
    title: "Jobs",
    bodyText: "23 jobs on the board",
    controls: [],
    actions: [
      { index: 0, label: "Job Category\n▾", visible: true, disabled: false },
    ],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
    ...overrides,
  };
  return buildApplyFormObservation(raw, "2026-10-21T10:00:00.000Z");
}

function link(index: number, label: string, href: string) {
  return { index, label, href, target: "", visible: true, topOffset: index };
}

function boardPage() {
  const links = [
    link(0, "Skip to content", "https://jobs.example.test/jobs#content"),
  ];
  for (let job = 0; job < 30; job += 1) {
    links.push(
      link(
        links.length,
        `Engineer ${job}\nNorthwind\nRemote`,
        `https://jobs.example.test/jobs/${job}`,
      ),
      link(
        links.length + 1,
        "Back end",
        "https://jobs.example.test/jobs/type/back-end",
      ),
      link(
        links.length + 2,
        "Remote, Worldwide",
        "https://jobs.example.test/jobs/location/remote",
      ),
    );
  }
  return page({
    links,
    headings: Array.from({ length: 30 }, (_, job) => ({
      level: 2,
      text: `Engineer ${job}\nNorthwind\nRemote, Worldwide`,
    })),
    clickables: [
      {
        index: 0,
        label: "Engineer 0\nNorthwind\nRemote",
        role: "",
        tagName: "div",
        visible: true,
        topOffset: 0,
      },
      {
        index: 1,
        label: "Engineer 0\nNorthwind",
        role: "",
        tagName: "div",
        visible: true,
        topOffset: 0,
      },
    ],
  });
}

describe("the search agent's page view", () => {
  test("lists each link once, drops same-page jumps and keeps every posting in view", () => {
    const observation = boardPage();
    const full = describeObservation(observation);
    const lean = describeSearchObservation(observation);

    expect(lean.length).toBeLessThan(full.length * 0.6);
    // The default view stops at 80 links and never reaches the last postings.
    expect(full).not.toContain("https://jobs.example.test/jobs/29");
    for (let job = 0; job < 30; job += 1)
      expect(lean).toContain(
        `: Engineer ${job} → https://jobs.example.test/jobs/${job}`,
      );
    expect(lean.match(/type\/back-end/gu)).toHaveLength(1);
    expect(lean).not.toContain("#content");
    expect(lean).toContain("- Engineer 0\n- Engineer 1");
    expect(lean).toContain(": Job Category");
    expect(lean).not.toContain("▾");
    // Two cards that read the same are one entry.
    expect(lean.match(/: Engineer 0$/gmu)).toHaveLength(1);
  });

  test("a view the model still has in full is not sent again", () => {
    let answers = 0;
    const views = createSearchViewDescriber(() => answers);
    const observation = boardPage();
    const first = views.describe(observation);
    expect(first).toContain("Links:");
    answers += 1;
    expect(views.describe(observation)).toBe(UNCHANGED_VIEW_NOTE);
    answers += 3;
    // Four answers on, the full view may already be shortened in the history.
    expect(views.describe(observation)).toBe(first);
    answers += 1;
    expect(views.describe(observation)).toBe(UNCHANGED_VIEW_NOTE);
    expect(views.describe(page())).toContain(
      "Page: https://jobs.example.test/jobs",
    );
  });

  test("the opening view is never shortened, so it is never repeated", () => {
    let answers = 0;
    const views = createSearchViewDescriber(() => answers);
    const observation = boardPage();
    expect(views.pinView(observation)).toContain("Links:");
    answers = 40;
    expect(views.describe(observation)).toBe(UNCHANGED_VIEW_NOTE);
  });
});
