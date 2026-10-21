import { describe, expect, test, vi } from "vitest";

import { createSeed } from "../workspace-service.test-fixtures";
import {
  buildListingScreenContext,
  createListingScreenBatcher,
  listingScreenKey,
  screenListingsWithModel,
  type ListingScreenListing,
  type ListingScreenSelectivity,
  type ListingScreenVerdict,
} from "./listing-screen";

function listing(title: string, location = "Remote"): ListingScreenListing {
  return {
    title,
    company: "Acme",
    location,
    workMode: ["remote"],
    department: null,
    team: null,
  };
}

function context(
  roles: string[],
  selectivity: ListingScreenSelectivity = "balanced",
) {
  const preferences = createSeed().searchPreferences;
  return buildListingScreenContext({
    searchPreferences: { ...preferences, targetRoles: roles },
    selectivity,
    request: null,
  });
}

describe("listing screen keys", () => {
  test("change with the listing's title or place, or the person's goals", () => {
    const designer = context(["Product Designer"]);
    const key = listingScreenKey(designer, listing("Product Designer"));
    expect(listingScreenKey(designer, listing("Product  designer"))).toBe(key);
    expect(listingScreenKey(designer, listing("Sales Lead"))).not.toBe(key);
    expect(
      listingScreenKey(designer, listing("Product Designer", "Berlin")),
    ).not.toBe(key);
    expect(
      listingScreenKey(context(["Engineer"]), listing("Product Designer")),
    ).not.toBe(key);
    expect(
      listingScreenKey(
        context(["Product Designer"], "wide_net"),
        listing("Product Designer"),
      ),
    ).not.toBe(key);
  });
});

describe("screenListingsWithModel", () => {
  test("reads grouped rejections and keeps every listing the answer left out", async () => {
    const chatWithTools = vi.fn().mockResolvedValue({
      content:
        '```json\n{"keep":["1"],"reject":[{"ids":["2","9"],"category":"place","reason":"Office in a city the person cannot work from."}]}\n```',
    });
    const verdicts = await screenListingsWithModel({
      aiClient: { chatWithTools },
      context: context(["Product Designer"]),
      listings: [
        listing("Product Designer"),
        listing("Product Designer", "Tokyo"),
        listing("Design Lead"),
      ],
    });
    expect(verdicts).toEqual([
      { keep: true },
      {
        keep: false,
        category: "place",
        reason: "Office in a city the person cannot work from.",
      },
      { keep: true },
    ]);
    expect(chatWithTools.mock.calls[0]?.[2]).toMatchObject({
      reasoningTask: "listing_screen",
    });
  });

  test("an answer it cannot read is a failure, not a verdict", async () => {
    await expect(
      screenListingsWithModel({
        aiClient: {
          chatWithTools: vi.fn().mockResolvedValue({ content: "ok" }),
        },
        context: context(["Product Designer"]),
        listings: [listing("Product Designer")],
      }),
    ).rejects.toThrow();
  });
});

describe("createListingScreenBatcher", () => {
  test("feeds share a call, and a failed call leaves their listings undecided", async () => {
    const calls: number[] = [];
    let fail = false;
    const batcher = createListingScreenBatcher({
      batchSize: 4,
      waitMs: 10,
      screen: (listings) => {
        calls.push(listings.length);
        if (fail) return Promise.reject(new Error("busy"));
        return Promise.resolve(
          listings.map(
            (item): ListingScreenVerdict =>
              item.title.startsWith("Keep")
                ? { keep: true }
                : { keep: false, category: "role", reason: "Other work." },
          ),
        );
      },
    });
    const [first, second] = await Promise.all([
      batcher.screen([listing("Keep A"), listing("Drop B")]),
      batcher.screen([listing("Keep C")]),
    ]);
    expect(calls).toEqual([3]);
    expect(first.map((verdict) => verdict?.keep)).toEqual([true, false]);
    expect(second.map((verdict) => verdict?.keep)).toEqual([true]);

    fail = true;
    expect(await batcher.screen([listing("Keep D")])).toEqual([null]);
    batcher.stop();
    expect(await batcher.screen([listing("Keep E")])).toEqual([null]);
  });
});
