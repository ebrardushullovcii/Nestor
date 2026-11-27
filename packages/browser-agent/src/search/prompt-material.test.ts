import { describe, expect, test } from "vitest";
import {
  splitLinksOnEveryPage,
  textCoveredBy,
  withoutRepeatedBlocks,
} from "./prompt-material";

const paragraph = (label: string) =>
  `${label}: the synthetic team builds and runs the order service that venues use during every shift of the day.`;

describe("page material without its own copies", () => {
  test("a body is covered by its page text across different line breaks and spacing", () => {
    const page =
      "Site menu\nRole description and responsibilities\nDamia builds\nthings.\nFooter";
    expect(
      textCoveredBy(
        "Role description and responsibilitiesDamia builds things.",
        page,
      ),
    ).toBe(true);
    expect(textCoveredBy("A line the page never shows.", page)).toBe(false);
    expect(textCoveredBy("Anything", "")).toBe(false);
  });

  test("a block the page repeated verbatim is kept once, single repeated lines stay", () => {
    const body = [
      "Header",
      paragraph("One"),
      "",
      paragraph("Two"),
      paragraph("Three"),
      "Requirements",
      "TypeScript and React",
      "Nice to have",
      "TypeScript and React",
      paragraph("One"),
      "",
      paragraph("Two"),
      paragraph("Three"),
      "Apply now",
    ].join("\n");
    const once = withoutRepeatedBlocks(body);
    expect(once.split(paragraph("One"))).toHaveLength(2);
    expect(once.split(paragraph("Three"))).toHaveLength(2);
    expect(once.split("TypeScript and React")).toHaveLength(3);
    expect(once).toContain("Apply now");
    expect(withoutRepeatedBlocks("short\ntext")).toBe("short\ntext");
  });

  test("links on every page are listed once and each page keeps its own", () => {
    const nav = { label: "Jobs", url: "https://board.example.test/jobs" };
    const apply = (id: number) => ({
      label: "Apply",
      url: `https://board.example.test/apply/${id}`,
    });
    const split = splitLinksOnEveryPage([
      [nav, apply(1)],
      [apply(2), nav],
    ]);
    expect(split.shared).toEqual([nav]);
    expect(split.own).toEqual([[apply(1)], [apply(2)]]);
    expect(splitLinksOnEveryPage([[nav]])).toEqual({
      shared: [],
      own: [[nav]],
    });
  });
});
