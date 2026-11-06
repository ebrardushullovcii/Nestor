import { expect, test, vi } from "vitest";
import { DiscoveryPageReadError, type ListingCard } from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import { screenCards } from "./listing-engine";
import { fingerprint } from "./listing-html";
import { professionEvidence } from "./listing-screening";

const card = (title: string, id = title): ListingCard => ({
  title,
  url: `https://jobs.example/${id}`,
  text: `${title}\nSynthetic Employer`,
  sourceId: "one",
  sourceLabel: "Synthetic",
  cardFingerprint: id,
});
const goals = {
  targetRoles: ["Frontend Engineer"],
  relatedRoles: [],
  strategy: "target_roles" as const,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("a proven match streams before an uncertain profession finishes and is emitted once", async () => {
  const response = deferred<Awaited<ReturnType<LLMClient["chatWithTools"]>>>();
  const match = card("Frontend Engineer");
  const onRelated = vi.fn<
    NonNullable<Parameters<typeof screenCards>[0]["onRelated"]>
  >(() => Promise.resolve());
  const work = screenCards({
    cards: [match, card("Landscape Architect")],
    goals,
    client: { chatWithTools: () => response.promise },
    onRelated,
  });
  await vi.waitFor(() => expect(onRelated).toHaveBeenCalledWith([match]));
  response.resolve({ content: '{"keep":{"0":0}}' });
  const result = await work;
  expect(result.related).toEqual([match]);
  expect(result.seen).toHaveLength(1);
  expect(onRelated).toHaveBeenCalledTimes(1);
});

test("completed model batches stream while another batch is still pending", async () => {
  const last = deferred<Awaited<ReturnType<LLMClient["chatWithTools"]>>>();
  const cards = Array.from({ length: 121 }, (_, i) =>
    card(`Interface Specialist ${i}`),
  );
  const onRelated = vi.fn<
    NonNullable<Parameters<typeof screenCards>[0]["onRelated"]>
  >(() => Promise.resolve());
  let calls = 0;
  const work = screenCards({
    cards,
    goals,
    onRelated,
    client: {
      chatWithTools: () =>
        ++calls === 1
          ? Promise.resolve({
              content: JSON.stringify({
                keep: Object.fromEntries(
                  Array.from({ length: 120 }, (_, i) => [i, 1]),
                ),
              }),
            })
          : last.promise,
    },
  });
  await vi.waitFor(() =>
    expect(onRelated).toHaveBeenCalledWith(cards.slice(0, 120)),
  );
  last.resolve({ content: '{"keep":{"0":1}}' });
  expect((await work).related).toEqual(cards);
  expect(onRelated).toHaveBeenCalledTimes(2);
});

test("an ambiguous title streams after one full-text judgment with its captured page", async () => {
  const listing = card("Interface Specialist");
  const body =
    "Build frontend components with React and TypeScript, collaborating with designers on accessible interfaces.";
  const onRelated = vi.fn<
    NonNullable<Parameters<typeof screenCards>[0]["onRelated"]>
  >(() => Promise.resolve());
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValueOnce({ content: '{"keep":{"0":1}}' });
  await screenCards({
    cards: [listing],
    goals,
    onRelated,
    client: { chatWithTools },
    readPage: (url) =>
      Promise.resolve({
        html: `<main><h1>${listing.title}</h1><p>${body}</p></main>`,
        finalUrl: url,
      }),
  });
  expect(onRelated).toHaveBeenCalledTimes(1);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
  expect(onRelated.mock.calls[0]?.[0]?.[0]?.listingText).toContain(body);
});

test("a streaming persistence error propagates rather than becoming a profession verdict", async () => {
  const failure = new Error("Could not save the listing");
  await expect(
    screenCards({
      cards: [card("Frontend Engineer")],
      goals,
      client: { chatWithTools: vi.fn() },
      onRelated: () => Promise.reject(failure),
    }),
  ).rejects.toBe(failure);
});

test("a proven match does not wait for another listing's full read", async () => {
  const detail = deferred<{ html: string; finalUrl: string }>();
  const match = card("Frontend Engineer"),
    uncertain = card("Interface Specialist");
  const onRelated = vi.fn<
    NonNullable<Parameters<typeof screenCards>[0]["onRelated"]>
  >(() => Promise.resolve());
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockImplementation((messages) => {
      expect(messages[1].content).toContain("Care for landscape gardens");
      return Promise.resolve({ content: '{"keep":{"0":0}}' });
    });
  const work = screenCards({
    cards: [match, uncertain],
    goals,
    onRelated,
    client: { chatWithTools },
    readPage: () => detail.promise,
  });
  await vi.waitFor(() => expect(onRelated).toHaveBeenCalledWith([match]));
  expect(chatWithTools).not.toHaveBeenCalled();
  detail.resolve({
    html: `<main><h1>${uncertain.title}</h1><p>Care for landscape gardens and maintain outdoor planting.</p></main>`,
    finalUrl: uncertain.url,
  });
  expect((await work).related).toEqual([match]);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});

test("an authenticated uncertain title is read through the browser before its one grounded judgment", async () => {
  const listing = card("Interface Specialist");
  const readPage = vi.fn<
    NonNullable<Parameters<typeof screenCards>[0]["readPage"]>
  >((url, options) =>
    options.rendered
      ? Promise.resolve({
          html: `<main><h1>${listing.title}</h1><p>Build accessible frontend components with React and TypeScript.</p></main>`,
          finalUrl: url,
        })
      : Promise.reject(new DiscoveryPageReadError(401)),
  );
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue({ content: '{"keep":{"0":1}}' });
  const result = await screenCards({
    cards: [listing],
    goals,
    readPage,
    client: { chatWithTools },
  });
  expect(result.failed).toEqual([]);
  expect(result.related[0]?.listingText).toContain("Build accessible frontend");
  expect(readPage).toHaveBeenCalledTimes(2);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});

test("old policy rejections are reconsidered rather than hiding newly ambiguous professions", async () => {
  const listing = card("Software Engineer");
  const legacyGoalsKey = fingerprint([
    7,
    ["frontend engineer"],
    [],
    "target_roles",
    "",
  ]);
  const legacyFingerprint = fingerprint([
    listing.cardFingerprint,
    professionEvidence(listing),
  ]);
  const chatWithTools = vi
    .fn<LLMClient["chatWithTools"]>()
    .mockResolvedValue({ content: '{"keep":{"0":1}}' });
  const result = await screenCards({
    cards: [listing],
    goals,
    client: { chatWithTools },
    lookupSeenCards: (_cards, key) =>
      Promise.resolve(
        key === legacyGoalsKey
          ? [
              {
                url: listing.url,
                cardFingerprint: legacyFingerprint,
                roleGoalsKey: legacyGoalsKey,
                verdict: "unrelated",
              },
            ]
          : [],
      ),
  });
  expect(result.related).toEqual([listing]);
  expect(chatWithTools).toHaveBeenCalledTimes(1);
});
