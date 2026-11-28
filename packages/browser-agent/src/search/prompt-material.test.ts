import { describe, expect, test } from "vitest";
import {
  shareDescriptionEndings,
  sharePageText,
  splitLinksOnEveryPage,
  textCoveredBy,
  withoutRepeatedBlocks,
} from "./prompt-material";

const paragraph = (label: string) =>
  `${label}: the synthetic team builds and runs the order service that venues use during every shift of the day.`;

test("shared description endings preserve the exact text and its own listing ids", () => {
  const footer = `\n\n${paragraph("Footer")}\nHours: 08:00–16:00\n`;
  const bodies = [
    `Own duties A${footer}`,
    "Own duties B\nHours: 09:00–16:00\n",
    `Own duties C${footer}`,
  ];
  const { descriptionEndings, listings } = shareDescriptionEndings(
    bodies.map((description, id) => ({ id, description })),
  );
  const descriptions = listings.map(({ description }) => description);
  expect(descriptionEndings).toEqual([{ ids: [0, 2], text: footer }]);
  expect(descriptions).toEqual(["Own duties A", bodies[1], "Own duties C"]);
  expect(
    descriptions.map(
      (text, id) =>
        text +
        (descriptionEndings.find((ending) => ending.ids.includes(id))?.text ??
          ""),
    ),
  ).toEqual(bodies);
});

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

  test("exact shared text can be reconstructed on each page, in order", () => {
    const header = "All jobs\n\nPost a job\n";
    const footer = "About\n\nContact support";
    const input = [
      `Role A\n\n${header}Responsibilities for role A\n${footer}`,
      `Role B\n${header}Responsibilities for role B\n${header}More B\n${footer}`,
      `Role C\n${header}Requirements unique to C\n${footer}`,
    ];
    const { shared, pages } = sharePageText(input);
    expect(shared).toEqual([header, footer]);
    expect(pages).toEqual([
      ["Role A\n\n", 0, "Responsibilities for role A\n", 1],
      ["Role B\n", 0, "Responsibilities for role B\n", 0, "More B\n", 1],
      ["Role C\n", 0, "Requirements unique to C\n", 1],
    ]);
    expect(
      pages.map((page) =>
        typeof page === "string"
          ? page
          : page
              .map((piece) =>
                typeof piece === "number" ? shared[piece] : piece,
              )
              .join(""),
      ),
    ).toEqual(input);
    expect(sharePageText([input[0]])).toEqual({
      shared: [],
      pages: [input[0]],
    });
  });
});
