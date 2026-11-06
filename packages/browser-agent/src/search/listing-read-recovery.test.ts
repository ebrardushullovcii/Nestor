import { expect, test, vi } from "vitest";
import type { ListingCard } from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import {
  listingInventoryReady,
  readListings,
  screenCards,
} from "./listing-engine";

const card: ListingCard = {
  title: "Interface Engineer",
  url: "https://careers.example/security/1",
  text: "Interface Engineer at Synthetic Employer",
  cardFingerprint: "interface",
  sourceId: "source",
  sourceLabel: "Synthetic careers",
};
const goals = {
  targetRoles: ["Frontend Engineer"],
  relatedRoles: [],
  strategy: "target_roles" as const,
};
const interstitial = `<title>Just a moment...</title><main><h1>Just a moment...</h1><p>Performing security verification</p></main><aside role="dialog"><button>Reject cookies</button></aside><button>Chat with us</button><script src="/check.js"></script>`;
const listing = `<main><h1>Interface Engineer</h1><p>Synthetic Employer</p><h2>Responsibilities</h2><p>Build accessible TypeScript interfaces and frontend components with React. Collaborate with designers and engineers on reliable applications.</p></main>`;

test.each(["length", "max_output_tokens", "transport"])(
  "screening retries output truncation (%s) once with more room",
  async (kind) => {
    const chatWithTools = vi.fn<LLMClient["chatWithTools"]>();
    if (kind === "transport")
      chatWithTools.mockRejectedValueOnce(
        new Error(
          "The AI service returned an incomplete response: max_output_tokens",
        ),
      );
    else
      chatWithTools.mockResolvedValueOnce({
        // Even valid JSON must not become a remembered negative on truncation.
        content: '{"keep":{"0":0}}',
        finishReason: kind,
      });
    chatWithTools.mockResolvedValueOnce({ content: '{"keep":{"0":1}}' });
    const result = await screenCards({
      cards: [card],
      goals,
      client: { chatWithTools },
    });
    expect(result.related).toEqual([card]);
    expect(result.failed).toEqual([]);
    expect(result.seen).toEqual([]);
    expect(
      chatWithTools.mock.calls.map((call) => call[2]?.maxOutputTokens),
    ).toEqual([8000, 16000]);
  },
);

test("exhausted output retries report a failure without caching a negative or retrying smaller batches", async () => {
  const decisions = new Map<string, boolean>();
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
    content: '{"keep":{"0":0}}',
    finishReason: "length",
  });
  const result = await screenCards({
    cards: [card],
    goals,
    decisions,
    client: { chatWithTools },
  });
  expect(result.related).toEqual([]);
  expect(result.seen).toEqual([]);
  expect(result.failed.map((failure) => failure.url)).toEqual([card.url]);
  expect(result.failed[0]?.reason).toMatch(/output.*limit/iu);
  expect(decisions.size).toBe(0);
  expect(chatWithTools).toHaveBeenCalledTimes(2);
});

test("an unrelated provider failure is reported without an output-budget retry", async () => {
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockRejectedValue(
      new Error(
        "The AI service returned an incomplete response: content_filter",
      ),
    );
  const result = await screenCards({
    cards: [card],
    goals,
    client: { chatWithTools },
  });
  expect(result.failed).toHaveLength(1);
  expect(result.seen).toEqual([]);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});

test("Stop during a truncated model turn prevents the larger retry", async () => {
  const controller = new AbortController();
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockImplementation(() => {
      controller.abort();
      return Promise.resolve({ content: "", finishReason: "length" });
    });
  await expect(
    screenCards({
      cards: [card],
      goals,
      signal: controller.signal,
      client: { chatWithTools },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});

test("profession screening waits for a rendered listing through an interstitial and overlays", async () => {
  const signal = new AbortController().signal;
  const readPage = vi.fn<
    NonNullable<Parameters<typeof screenCards>[0]["readPage"]>
  >((url, options) => {
    if (!options.rendered)
      return Promise.resolve({ html: interstitial, finalUrl: url });
    expect(options.signal).toBe(signal);
    expect(options.ready?.(interstitial)).toBe(false);
    expect(options.ready?.(listing)).toBe(true);
    return Promise.resolve({
      html: listing,
      finalUrl: "https://careers.example/jobs/1",
    });
  });
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValueOnce({ content: '{"keep":{"0":1}}' });
  const result = await screenCards({
    cards: [card],
    goals,
    signal,
    readPage,
    client: { chatWithTools },
  });
  expect(result.failed).toEqual([]);
  expect(result.seen).toEqual([]);
  expect(result.related[0]?.listingText).toContain(
    "Build accessible TypeScript",
  );
  expect(readPage).toHaveBeenCalledTimes(2);
});

test("inventory waits through a temporary check rather than declaring it ready", () => {
  expect(listingInventoryReady(interstitial, card.url)).toBe(false);
  expect(
    listingInventoryReady(
      '<main><article><h2><a href="/jobs/1">Interface Engineer</a></h2><p>Synthetic Employer</p></article></main>',
      card.url,
    ),
  ).toBe(true);
});

test("a persistent check remains a retryable screening failure without remembering the negative", async () => {
  const readPage = vi.fn(() =>
    Promise.resolve({ html: interstitial, finalUrl: card.url }),
  );
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue({ content: '{"keep":{"0":0}}' });
  const result = await screenCards({
    cards: [card],
    goals,
    readPage,
    client: { chatWithTools },
  });
  expect(result.related).toEqual([]);
  expect(result.seen).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(readPage).toHaveBeenCalledTimes(2);
  expect(chatWithTools).not.toHaveBeenCalled();
});

test("listing metadata also retries truncation and accounts for both model turns", async () => {
  const usage = {
    inputTokens: 100,
    outputTokens: 8000,
    cachedInputTokens: 0,
    reasoningTokens: 7900,
  };
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValueOnce({
      content: "",
      finishReason: "max_output_tokens",
      usage,
    })
    .mockResolvedValueOnce({
      content: JSON.stringify({
        jobs: [
          {
            id: 0,
            title: card.title,
            company: "Synthetic Employer",
            location: "Berlin",
            workModes: [],
            sourceJobId: null,
            employmentType: null,
            seniority: null,
            salaryText: null,
          },
        ],
      }),
      usage,
    });
  const onUsage = vi.fn();
  const result = await readListings({
    cards: [card],
    client: { chatWithTools },
    onUsage,
    readPage: () => Promise.resolve({ html: listing, finalUrl: card.url }),
  });
  expect(result.failures).toEqual([]);
  expect(result.jobs[0]?.description).toContain("Build accessible TypeScript");
  expect(
    chatWithTools.mock.calls.map((call) => call[2]?.maxOutputTokens),
  ).toEqual([8000, 16000]);
  expect(onUsage).toHaveBeenCalledTimes(2);
});
