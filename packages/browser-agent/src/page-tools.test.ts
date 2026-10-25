import type { RawApplyPage } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import { buildApplyFormObservation } from "./apply/page-hands";
import type { ApplyPageHands } from "./apply/types";
import { createPageTools } from "./page-tools";

function rawPage(overrides: Partial<RawApplyPage> = {}): RawApplyPage {
  return {
    url: "https://jobs.example.test/listing",
    title: "Listing",
    bodyText: "A job listing",
    controls: [],
    actions: [{ index: 0, label: "Apply", visible: true, disabled: false }],
    links: [
      {
        index: 0,
        label: "Elsewhere",
        href: "https://other.example.test/",
        target: "_blank",
        visible: true,
        topOffset: 10,
      },
    ],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
    ...overrides,
  };
}

function hands(pages: { current: RawApplyPage }): ApplyPageHands & {
  adoptOpenedTab: ReturnType<typeof vi.fn>;
} {
  const adoptOpenedTab = vi.fn(() => {
    pages.current = rawPage({ url: "https://employer.example.test/apply", openedTabs: [] });
    return Promise.resolve({ ok: true as const, url: "https://employer.example.test/apply" });
  });
  return {
    observe: () =>
      Promise.resolve(buildApplyFormObservation(pages.current, "2026-09-14T10:00:00.000Z")),
    navigate: (url) => {
      pages.current = rawPage({ url });
      return Promise.resolve({ ok: true, url });
    },
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    pressKey: (_ref, key) => Promise.resolve({ ok: true, observedValue: key }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () => {
      pages.current = rawPage();
      return Promise.resolve({ ok: true, url: "https://jobs.example.test/listing" });
    },
    readText: () => Promise.resolve("A job listing"),
    fillText: (_ref, value) => Promise.resolve({ ok: true, observedValue: value }),
    chooseOption: (_ref, option) => Promise.resolve({ ok: true, observedValue: option }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) => Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () => Promise.resolve({ ok: true, url: "https://jobs.example.test/listing" }),
    adoptOpenedTab,
  };
}

async function run(tools: ReturnType<typeof createPageTools>, name: string, args: Record<string, unknown> = {}) {
  const tool = tools.tools.find((entry) => entry.definition.function.name === name)!;
  return tool.execute(JSON.stringify(args), { step: 1 });
}

describe("page tools", () => {
  test("a press that opens a new tab is brought into this tab and reported", async () => {
    const pages = { current: rawPage() };
    const pageHands = hands(pages);
    const tools = createPageTools(pageHands);
    await tools.observe();
    // The click makes the page report a tab it opened.
    pageHands.clickElement = () => {
      pages.current = rawPage({
        openedTabs: [{ index: 0, url: "https://employer.example.test/apply", title: "Apply" }],
      });
      return Promise.resolve({ ok: true, observedValue: "clicked" });
    };

    const outcome = await run(tools, "click", { ref: "a0" });

    expect(pageHands.adoptOpenedTab).toHaveBeenCalledWith(0);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.content).toContain('Pressed "Apply"');
      expect(outcome.content).toContain("opened that address here instead");
      expect(outcome.progress).toBe(true);
    }
    expect(tools.state.observation?.url).toBe("https://employer.example.test/apply");
    expect(tools.state.visitedUrls).toContain("https://employer.example.test/apply");
  });

  test("an address outside the allowed sites is refused with the reason", async () => {
    const pages = { current: rawPage() };
    const tools = createPageTools(hands(pages), {
      allowUrl: (url) =>
        url.startsWith("https://jobs.example.test") ? null : `${url} is outside the site this search is on.`,
    });
    await tools.observe();

    const outcome = await run(tools, "navigate", { url: "https://other.example.test/x" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.content).toContain("outside the site");
      expect(outcome.progress).toBe(false);
    }
    expect(tools.state.observation?.url).toBe("https://jobs.example.test/listing");
  });

  test("a press that changes nothing says so instead of counting as progress", async () => {
    const pages = { current: rawPage() };
    const tools = createPageTools(hands(pages));
    await tools.observe();

    const outcome = await run(tools, "click", { ref: "a0" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.content).toContain("the page did not change");
      expect(outcome.progress).toBe(false);
    }
  });

  test("presses a keyboard key on a named control", async () => {
    const pages = {
      current: rawPage({
        controls: [
          {
            index: 0,
            tagName: "input",
            inputType: "text",
            role: "",
            id: "city",
            name: "city",
            label: "City",
            groupLabel: "",
            placeholder: "",
            autocomplete: "",
            required: false,
            invalid: false,
            validationMessage: "",
            disabled: false,
            readOnly: false,
            visible: true,
            value: "",
            checked: false,
            multiple: false,
            options: [],
            selectedOptionLabel: "",
          },
        ],
      }),
    };
    const pageHands = hands(pages);
    const pressKey = vi.spyOn(pageHands, "pressKey");
    const tools = createPageTools(pageHands);
    await tools.observe();

    const outcome = await run(tools, "press_key", { ref: "c0", key: "Enter" });

    expect(pressKey).toHaveBeenCalledWith("c0", "Enter");
    expect(outcome.kind).toBe("ok");
  });

  test("a write against a page that moved on is refused once and the new page shown", async () => {
    const pages = { current: rawPage({ controls: [] }) };
    const tools = createPageTools(hands(pages));
    await tools.observe();
    pages.current = rawPage({ url: "https://jobs.example.test/other", title: "Other" });

    const outcome = await run(tools, "type", { ref: "c0", text: "hello" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.content).toContain("The page changed since you last looked");
      expect(outcome.content).toContain("https://jobs.example.test/other");
    }
  });
});

describe("leaving the home site", () => {
  function homeOnly(url: string): string | null {
    return url.startsWith("https://jobs.example.test") ? null : `${url} is outside the site this run is on.`;
  }

  test("without a reason the move is refused and the model is told what to give", async () => {
    const pages = { current: rawPage() };
    const review = vi.fn(() => Promise.resolve({ allowed: true, verdict: "fine" }));
    const tools = createPageTools(hands(pages), { allowUrl: homeOnly, reviewMove: review });
    await tools.observe();

    const outcome = await run(tools, "navigate", { url: "https://employer.example.test/apply" });

    expect(review).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") expect(outcome.content).toContain("call again with a reason");
  });

  test("a reasoned move the review allows goes ahead, and the origin stays allowed", async () => {
    const pages = { current: rawPage() };
    const review = vi.fn<
      (move: { url: string; reason: string; fromUrl: string | null }) => Promise<{ allowed: boolean; verdict: string }>
    >(() => Promise.resolve({ allowed: true, verdict: "The employer page holds the posting's details." }));
    const tools = createPageTools(hands(pages), { allowUrl: homeOnly, reviewMove: review });
    await tools.observe();

    const first = await run(tools, "navigate", {
      url: "https://employer.example.test/jobs/1",
      reason: "The card links here for the full description and apply button",
    });
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]?.[0]).toMatchObject({
      url: "https://employer.example.test/jobs/1",
      fromUrl: "https://jobs.example.test/listing",
    });
    expect(first.kind).toBe("ok");
    if (first.kind === "ok") {
      expect(first.content).toContain("allowed after review");
      expect(first.progress).toBe(true);
    }
    expect(tools.state.observation?.url).toBe("https://employer.example.test/jobs/1");

    const second = await run(tools, "navigate", { url: "https://employer.example.test/jobs/2" });
    expect(review).toHaveBeenCalledTimes(1);
    expect(tools.state.observation?.url).toBe("https://employer.example.test/jobs/2");
    if (second.kind === "ok") expect(second.progress).toBe(true);
  });

  test("a reasoned move the review refuses is refused with the verdict", async () => {
    const pages = { current: rawPage() };
    const tools = createPageTools(hands(pages), {
      allowUrl: homeOnly,
      reviewMove: () =>
        Promise.resolve({ allowed: false, verdict: "That address is a sign-in page, which stays with the person." }),
    });
    await tools.observe();

    const outcome = await run(tools, "follow_link", { ref: "l0", reason: "To sign in and see more" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.content).toContain("did not allow it: That address is a sign-in page");
      expect(outcome.progress).toBe(false);
    }
    expect(tools.state.observation?.url).toBe("https://jobs.example.test/listing");
  });

  test("a click that lands off-site is judged by the reason it was given, and goes back when refused", async () => {
    const pages = { current: rawPage() };
    const pageHands = hands(pages);
    pageHands.clickElement = () => {
      pages.current = rawPage({ url: "https://other.example.test/landing" });
      return Promise.resolve({ ok: true, observedValue: "clicked" });
    };
    const review = vi.fn(() => Promise.resolve({ allowed: false, verdict: "Unrelated to the goal." }));
    const tools = createPageTools(pageHands, { allowUrl: homeOnly, reviewMove: review });
    await tools.observe();

    const outcome = await run(tools, "click", { ref: "a0", reason: "Curious" });

    expect(review).toHaveBeenCalledTimes(1);
    if (outcome.kind === "ok") {
      expect(outcome.content).toContain("Job Finder went back");
      expect(outcome.progress).toBe(false);
    }
    expect(tools.state.observation?.url).toBe("https://jobs.example.test/listing");
  });
});
