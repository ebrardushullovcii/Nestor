import { describe, expect, it } from "vitest";
import { coverageHonest, gradeRanking, recordedReader, turnKey } from "./run";
import type { LabelledListing, RecordedBoard } from "./corpus";

describe("manual search relevance eval measurements", () => {
  it("counts a screened-out relevant listing as a recall miss and ranks across boards", () => {
    const labels: LabelledListing[] = Array.from({ length: 12 }, (_, i) => ({
      board: i < 6 ? "first" : "second",
      url: `https://example.com/${i}`,
      title: `Job ${i}`,
      labels: {
        person: { relevant: i < 10, reason: "Frozen independent label" },
      },
    }));
    const ranked = [11, 10, 0, 1, 2, 3, 4, 5, 6, 7].map((i) => labels[i]!.url);
    const result = gradeRanking(labels, "person", ranked, new Set(ranked));
    expect(result).toMatchObject({
      relevant: 10,
      found: 8,
      recall: 0.8,
      relevantInTop10: 8,
      targetsMet: false,
    });
    expect(result.missed.map((entry) => entry.title)).toEqual([
      "Job 8",
      "Job 9",
    ]);
  });
  it("rejects complete coverage with zero reads or zero vacancies", () => {
    expect(coverageHonest(true, 0, 10)).toBe(false);
    expect(coverageHonest(true, 2, 0)).toBe(false);
    expect(coverageHonest(false, 2, 0)).toBe(true);
    expect(coverageHonest(true, 2, 10)).toBe(true);
  });
  it("cannot reuse a recorded model answer after a prompt or route change", () => {
    const request = [{ role: "user" as const, content: "Original" }];
    const key = turnKey([request, [], { reasoningTask: "fit_batch" }], {
      model: "one",
    });
    expect(
      turnKey(
        [
          request,
          [],
          { reasoningTask: "fit_batch", signal: new AbortController().signal },
        ],
        { model: "one" },
      ),
    ).toBe(key);
    expect(
      turnKey(
        [
          [{ role: "user", content: "Changed" }],
          [],
          { reasoningTask: "fit_batch" },
        ],
        { model: "one" },
      ),
    ).not.toBe(key);
    expect(
      turnKey([request, [], { reasoningTask: "fit_batch" }], { model: "two" }),
    ).not.toBe(key);
  });
  it("fails closed on unrecorded pages and preserves HTTP errors", async () => {
    const board: RecordedBoard = {
      source: { id: "public", label: "Public", url: "https://example.com" },
      cards: [],
      responses: [
        {
          url: "https://example.com/missing",
          finalUrl: "https://example.com/missing",
          method: "GET",
          status: 404,
          html: "Page not found",
          capturedAt: "2026-10-26T00:00:00Z",
        },
      ],
    };
    const reader = recordedReader(board);
    await expect(
      reader.readPage("https://example.com/missing", {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      reader.readPage("https://example.com/new", {}),
    ).rejects.toThrow("network is disabled");
    expect(reader.reads).toHaveLength(1);
    expect(reader.missing).toEqual(["https://example.com/new"]);
  });
  it("matches recorded read-only feed queries regardless of JSON property order", async () => {
    const reader = recordedReader({
      source: { id: "public", label: "Public", url: "https://example.com" },
      cards: [],
      responses: [
        {
          url: "https://example.com/jobs",
          finalUrl: "https://example.com/jobs",
          method: "POST",
          status: 200,
          capturedAt: "2026-10-26T00:00:00Z",
          body: { offset: 0, facets: {} },
          html: '{"jobs":[]}',
        },
      ],
    });
    const options = { rendered: false, jsonQuery: { facets: {}, offset: 0 } };
    await expect(
      reader.readPage("https://example.com/jobs", options),
    ).resolves.toMatchObject({ html: '{"jobs":[]}' });
  });
});
