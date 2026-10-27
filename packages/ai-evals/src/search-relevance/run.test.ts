import { describe, expect, it } from "vitest";
import {
  coverageHonest,
  gradeRanking,
  recordedReader,
  tokenCostSummary,
  turnKey,
} from "./run";
import type { LabelledListing, RecordedBoard } from "./corpus";
import { loadCorpus } from "./corpus";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

describe("manual search relevance eval measurements", () => {
  it("reports cost per persona, includes empty boards, and does not double-count cached or reasoning tokens", () => {
    const boards = [
      {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
      {
        inputTokens: 20,
        outputTokens: 10,
        cachedInputTokens: 15,
        reasoningTokens: 6,
      },
      {
        inputTokens: 40,
        outputTokens: 30,
        cachedInputTokens: 20,
        reasoningTokens: 10,
      },
      {
        inputTokens: 80,
        outputTokens: 20,
        cachedInputTokens: 80,
        reasoningTokens: 20,
      },
    ].map((usage) => ({ usage }));
    expect(tokenCostSummary(boards)).toEqual({
      boards: 4,
      totalTokens: 200,
      medianTokensPerBoard: 50,
    });
    expect(tokenCostSummary([])).toEqual({
      boards: 0,
      totalTokens: 0,
      medianTokensPerBoard: null,
    });
  });
  it("keeps missing-usage estimates separate when totalling multiple boards", () => {
    const boards = [
      {
        usage: {
          inputTokens: 120,
          outputTokens: 40,
          cachedInputTokens: 80,
          reasoningTokens: 20,
        },
      },
      {
        usage: {
          inputTokens: 50,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          estimated: {
            calls: 1,
            inputTokens: 0,
            outputTokens: 3,
            method: "utf8_bytes_div_4_visible_only" as const,
          },
        },
      },
      {
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          estimated: {
            calls: 2,
            inputTokens: 70,
            outputTokens: 5,
            method: "utf8_bytes_div_4_visible_only" as const,
          },
        },
      },
    ];
    const original = JSON.stringify(boards);
    expect(tokenCostSummary(boards)).toEqual({
      boards: 3,
      totalTokens: 210,
      medianTokensPerBoard: 50,
      estimated: {
        calls: 3,
        inputTokens: 70,
        outputTokens: 8,
        method: "utf8_bytes_div_4_visible_only",
      },
    });
    expect(JSON.stringify(boards)).toBe(original);
  });
  it("ships a replay tape bound to the committed corpus", async () => {
    const directory = fileURLToPath(
      new URL("../../fixtures/search-relevance/", import.meta.url),
    );
    const corpus = await loadCorpus(directory);
    const tape = JSON.parse(
      gunzipSync(
        await readFile(
          new URL(
            "../../fixtures/search-relevance/fit-quality-tape.json.gz",
            import.meta.url,
          ),
        ),
      ).toString("utf8"),
    ) as { corpusDigest: string };
    expect(tape.corpusDigest).toBe(corpus.digest);
  });
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
