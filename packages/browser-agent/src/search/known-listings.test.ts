import { expect, test, vi } from "vitest";
import {
  omitKnownListingItems,
  onlyNewJobs,
  postingUrlKey,
} from "./known-listings";

test("a saved result card is omitted before reading while a new card stays whole", async () => {
  const oldUrl = "https://jobs.example.test/opening?id=old";
  const newUrl = "https://jobs.example.test/opening?id=new";
  const lookup = vi.fn(() => Promise.resolve([oldUrl]));
  const result = await omitKnownListingItems(
    [
      "Jobs near Berlin",
      `[Page item 1]\nData Analyst → ${oldUrl}\nKnown employer\n[End page item 1]`,
      `[Page item 2]\nSenior Data Analyst → ${newUrl}\nNew employer\n[End page item 2]`,
      "Next page → https://jobs.example.test/?page=2",
    ].join("\n"),
    lookup,
  );
  expect(lookup).toHaveBeenCalledExactlyOnceWith([oldUrl, newUrl]);
  expect(result.skippedUrls).toEqual([oldUrl]);
  expect(result.text).not.toContain("Known employer");
  expect(result.text).toContain(
    `Senior Data Analyst → ${newUrl}\nNew employer`,
  );
  expect(result.text).toContain("Next page");
});

test("a saved link does not hide a mixed card or unstructured new listing", async () => {
  const text =
    "New Engineer → https://jobs.example.test/new\n[Page item 1]\nKnown → https://jobs.example.test/old\nNew → https://jobs.example.test/new\n[End page item 1]";
  expect(
    (
      await omitKnownListingItems(text, () =>
        Promise.resolve(["https://jobs.example.test/old"]),
      )
    ).text,
  ).toBe(text);
});

test("repeat feed results omit saved URLs without merging different query IDs or path case", async () => {
  const jobs = [
    { canonicalUrl: "https://jobs.example.test/opening?id=old#description" },
    { canonicalUrl: "https://jobs.example.test/opening?id=new" },
    { canonicalUrl: "https://jobs.example.test/Opening?id=old" },
  ];
  expect(
    await onlyNewJobs(jobs, () =>
      Promise.resolve(["https://jobs.example.test/opening?id=old"]),
    ),
  ).toEqual(jobs.slice(1));
  expect(postingUrlKey("https://jobs.example.test/job?b=2&a=1#top")).toBe(
    "https://jobs.example.test/job?a=1&b=2",
  );
});
