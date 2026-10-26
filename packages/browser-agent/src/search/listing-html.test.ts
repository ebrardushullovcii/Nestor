import { expect, test } from "vitest";

import { blockedByCheck } from "./bot-check";
import { readInventoryHtml } from "./listing-html";

const source = { id: "board", label: "Board" };
const url = "https://board.example.test/jobs";
const job = (title: string, path: string) =>
  JSON.stringify({
    title,
    internal_job_id: 1,
    absolute_url: path,
    content: `${title} builds the platform.`,
  });

test("reads embedded jobs and published postings from scripts it no longer parses", () => {
  const hydration = `window.__APP__ = "${"x".repeat(200_000)}";`;
  const html = `<!doctype html><html><head><title>Jobs</title>
    <script>${hydration}</script>
    <script>var jobs = [${job("Platform Engineer", "/jobs/1")}];</script>
    <SCRIPT type="application/ld+json">{"@type":"JobPosting","title":"Data Engineer","url":"/jobs/2"}</SCRIPT>
    </head><body><main><a href="/jobs/3">Backend Engineer</a></main></body></html>`;
  const inventory = readInventoryHtml(html, url, source);
  expect(inventory.cards.map((card) => card.title)).toContain(
    "Platform Engineer",
  );
});

test("leaves script-like text in comments and raw-text elements alone", () => {
  const html = `<html><body>
    <!-- <script>var jobs = [${job("Commented", "/jobs/c")}];</script> -->
    <noscript><script>var jobs = [${job("Noscript", "/jobs/n")}];</script></noscript>
    <textarea><script>var jobs = [${job("Textarea", "/jobs/t")}];</script></textarea>
    <script-x>not a script</script-x>
    <script>var jobs = [${job("Spaced end", "/jobs/s")}];</script >
    </body></html>`;
  const titles = readInventoryHtml(html, url, source).cards.map(
    (card) => card.title,
  );
  expect(titles).toContain("Spaced end");
  for (const title of ["Commented", "Noscript", "Textarea"])
    expect(titles).not.toContain(title);
});

test("a text-rich page is never a challenge page, and a sparse one still is", () => {
  expect(
    blockedByCheck(
      `<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>`,
    ),
  ).toBe(true);
  expect(
    blockedByCheck(
      `<html><body>Verify you are human${"   ".repeat(3_000)}</body></html>`,
    ),
  ).toBe(true);
  expect(
    blockedByCheck(
      `<html><head><title>Just a moment...</title></head><body>${"word ".repeat(400)}</body></html>`,
    ),
  ).toBe(false);
});
