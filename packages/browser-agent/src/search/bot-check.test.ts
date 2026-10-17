import { describe, expect, test, vi } from "vitest";
import type { Page } from "playwright";
import { buildApplyFormObservation } from "../apply/page-hands";
import type { RawApplyPage } from "@nestor/contracts";
import {
  createBotCheckTracker,
  inspectBotCheckInterstitial,
  isBotCheckInterstitial,
} from "./bot-check";

function observation(overrides: Partial<RawApplyPage> = {}) {
  return buildApplyFormObservation(
    {
      url: "https://jobs.example.test/jobs/1",
      title: "Jobs",
      bodyText: "",
      controls: [],
      actions: [],
      links: [],
      headings: [],
      clickables: [],
      openedTabs: [],
      loading: false,
      validationErrors: [],
      stepLabel: null,
      ...overrides,
    },
    "2026-10-01T10:00:00.000Z",
  );
}

describe("bot-check interstitials", () => {
  test.each([
    {
      title: "Just a moment...",
      bodyText: "Enable JavaScript and cookies to continue.",
    },
    { title: "Just a moment…" },
    {
      title: "Verify you are human",
      bodyText: "Checking your browser before proceeding.",
    },
    { headings: [{ level: 1, text: "Security verification" }] },
    { bodyText: "Checking if the site connection is secure" },
  ])("recognizes a sparse challenge page %#", (page) => {
    expect(isBotCheckInterstitial(observation(page))).toBe(true);
  });

  test("recognizes a nearly empty structural challenge", () => {
    expect(isBotCheckInterstitial(observation(), true)).toBe(true);
    expect(isBotCheckInterstitial(observation())).toBe(false);
  });

  test("does not turn articles, job descriptions, or an inline widget into a wall", () => {
    expect(
      isBotCheckInterstitial(
        observation({
          title: "Platform Engineer",
          bodyText: "Platform Engineer at Example Company. Apply here.",
          headings: [{ level: 1, text: "Platform Engineer" }],
        }),
        true,
      ),
    ).toBe(false);
    expect(
      isBotCheckInterstitial(
        observation({
          title: "Engineer working on bot checks",
          bodyText:
            "Build tools that verify you are human, CAPTCHA and bot detection tools.",
        }),
      ),
    ).toBe(false);
    expect(
      isBotCheckInterstitial(
        observation({
          title: "Just a moment...",
          bodyText: "Engineering responsibilities and qualifications. ".repeat(
            100,
          ),
        }),
        true,
      ),
    ).toBe(false);
    expect(
      isBotCheckInterstitial(
        {
          ...observation({ bodyText: "Verify you are human" }),
          links: Array.from({ length: 10 }, () => ({ visible: true })),
        },
        true,
      ),
    ).toBe(false);
    expect(
      isBotCheckInterstitial(
        {
          ...observation({ bodyText: "Verify you are human" }),
          controls: [{ kind: "text", visible: true }],
        },
        true,
      ),
    ).toBe(false);
  });

  test("reads challenge structure and tolerates a replaced page", async () => {
    const evaluate = vi.fn().mockResolvedValue(true);
    const page = { evaluate } as unknown as Page;
    expect(await inspectBotCheckInterstitial(observation(), page)).toBe(true);
    expect(evaluate).toHaveBeenCalledOnce();
    evaluate.mockRejectedValueOnce(new Error("Page moved"));
    expect(await inspectBotCheckInterstitial(observation(), page)).toBe(false);
  });

  test("counts the same source across changing detail URLs and resets after real content", () => {
    const track = createBotCheckTracker();
    expect(track("https://jobs.example.test/1?ray=first", true)).toBeNull();
    expect(track("https://jobs.example.test/2?ray=second", true)).toBe(
      "jobs.example.test is showing a bot check. Open it in the browser, get past the check, then search again.",
    );
    expect(track("https://jobs.example.test/", false)).toBeNull();
    expect(track("https://jobs.example.test/3", true)).toBeNull();
    expect(track("https://other.example.test/", true)).toBeNull();
    expect(track(null, true)).toBeNull();
    expect(track("not a URL", true)).toBeNull();
  });
});
