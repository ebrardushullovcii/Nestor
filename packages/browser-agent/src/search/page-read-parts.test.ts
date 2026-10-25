import { describe, expect, test } from "vitest";

import {
  linksInText,
  mapWithLimit,
  pagePartsForReading,
  splitPageText,
} from "./page-read-parts";

const pageUrl = "https://jobs.example.test/search";

function board(count: number) {
  const cards = Array.from({ length: count }, (_, index) =>
    [
      `Platform Engineer ${index}`,
      `Employer ${index}`,
      "Manchester, United Kingdom",
      "Posted 2 days ago",
      "Back end, Cloud, Developer tools, Observability",
    ].join("\n"),
  );
  const links = [
    { label: "Skip to content", href: `${pageUrl}#content` },
    { label: "Sign in", href: "https://jobs.example.test/login" },
    ...Array.from({ length: count }, (_, index) => ({
      label: `Platform Engineer ${index}`,
      href: `https://jobs.example.test/jobs/${index}`,
    })),
  ];
  return {
    text: ["Skip to content", "Sign in", "Jobs", ...cards, "About us"].join(
      "\n",
    ),
    links,
  };
}

describe("reading a long results page in parts", () => {
  test("keeps each semantic page item with its own text and inline URL without repeating a separate link list", () => {
    const items = Array.from({ length: 40 }, (_, index) => `[Page item ${index}]\nEmployer ${index}\nEngineer → https://jobs.example.test/jobs/${index}\n${"Visible card facts ".repeat(20)}\n[End page item ${index}]`);
    const parts = pagePartsForReading({ pageText: items.join("\n"), pageUrl, links: [], inlineLinks: true, size: 1000 });
    for (const item of items) expect(parts.some(part => part.window.includes(item))).toBe(true);
    expect(parts.every(part => !part.text.includes("Page links in this part"))).toBe(true);
  });
  test("every listing reaches some part with its own address", () => {
    const { text, links } = board(60);
    const parts = pagePartsForReading({ pageText: text, links, pageUrl });
    expect(parts.length).toBeGreaterThan(4);
    for (let index = 0; index < 60; index += 1) {
      const whole = parts.some(
        (part) =>
          part.text.includes(
            `- Platform Engineer ${index} → https://jobs.example.test/jobs/${index}`,
          ) &&
          part.window.includes(
            `Platform Engineer ${index}\nEmployer ${index}\nManchester`,
          ),
      );
      expect(whole).toBe(true);
    }
    for (const part of parts) {
      expect(part.text.length).toBeLessThan(8_000);
      expect(part.text).toContain("untrusted page evidence");
      expect(part.text).not.toContain("#content");
    }
  });

  test("windows overlap, so a listing cut at an edge is whole in the next one", () => {
    const windows = splitPageText(board(40).text, 1_000);
    expect(windows.length).toBeGreaterThan(4);
    for (let index = 1; index < windows.length; index += 1) {
      const previousEnd = windows[index - 1].split("\n").at(-1)!;
      expect(windows[index].startsWith(previousEnd) || windows[index].includes(previousEnd)).toBe(true);
    }
    expect(windows.join("\n")).toContain("About us");
  });

  test("a very long single line is still cut", () => {
    const windows = splitPageText("x".repeat(7_000), 3_000);
    expect(windows.length).toBe(3);
    expect(Math.max(...windows.map((window) => window.length))).toBeLessThanOrEqual(3_300);
  });

  test("keeps unlinked text alongside links and beyond the former 24-part limit", () => {
    const { text, links } = board(30);
    const parts = pagePartsForReading({
      pageText: `${"Menu line\n".repeat(400)}${text}`,
      links,
      pageUrl,
    });
    expect(parts[0]?.window).toContain("Menu line");
    expect(parts.some((part) => part.text.includes("→ https://jobs.example.test/jobs/"))).toBe(true);

    const bare = pagePartsForReading({
      pageText: "Engineer at Northwind. Analyst at Contoso.",
      links: [],
      pageUrl,
    });
    expect(bare).toHaveLength(1);
    expect(bare[0]?.text).toContain("Engineer at Northwind.");
    const unlinked = pagePartsForReading({
      pageText: `${"Vacancy card without an anchor\n".repeat(3000)}Last vacancy`,
      links: [], pageUrl,
    });
    expect(unlinked.length).toBeGreaterThan(24);
    expect(unlinked.at(-1)?.window).toContain("Last vacancy");
  });

  test("links are matched by their first label line and listed once", () => {
    const found = linksInText(
      "Senior Data Engineer\nNorthwind\nSenior Data Engineer",
      [
        { label: "Senior Data Engineer\nNorthwind\nRemote", href: "https://x.test/jobs/1" },
        { label: "Senior Data Engineer", href: "https://x.test/jobs/1" },
        { label: "Go", href: "https://x.test/go" },
        { label: "Unrelated", href: "https://x.test/u" },
      ],
      "https://x.test/",
    );
    expect(found).toEqual([
      { label: "Senior Data Engineer", href: "https://x.test/jobs/1" },
    ]);
  });

  test("runs a bounded number of reads at once and keeps their order", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithLimit([1, 2, 3, 4, 5], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (value === 3) throw new Error("part failed");
      return value * 10;
    });
    expect(peak).toBe(2);
    expect(results.map((entry) => entry.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
  });
});
