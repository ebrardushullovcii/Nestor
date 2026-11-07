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

test("shared visual tools return schema errors to the model without browser actions", async () => {
  const pageHands = hands({ current: rawPage() });
  const screenshot = vi.fn();
  const pointer = vi.fn();
  const pack = createPageTools({ ...pageHands, screenshot, pointer });
  const execute = (name: string, input: unknown) =>
    pack.tools
      .find((tool) => tool.definition.function.name === name)!
      .execute(JSON.stringify(input), { step: 1 });
  for (const [name, args, error] of [
    ["screenshot", { frame: 3 }, "string"],
    ["pointer", { action: "drag", x: 10, y: 20 }, "endX and endY"],
    ["pointer", { action: "hold", x: 10, y: 20 }, "durationMs"],
    ["pointer", { action: "click", x: "10", y: 20 }, "number"],
  ] as const) {
    const result = await execute(name, args);
    expect(result).toMatchObject({
      kind: "ok",
      status: "failed",
      content: expect.stringContaining(error) as string,
    });
  }
  expect(pointer).not.toHaveBeenCalled();
  expect(screenshot).not.toHaveBeenCalled();
});

function hands(pages: { current: RawApplyPage }): ApplyPageHands & {
  adoptOpenedTab: ReturnType<typeof vi.fn>;
} {
  const adoptOpenedTab = vi.fn(() => {
    pages.current = rawPage({
      url: "https://employer.example.test/apply",
      openedTabs: [],
    });
    return Promise.resolve({
      ok: true as const,
      url: "https://employer.example.test/apply",
    });
  });
  return {
    observe: () =>
      Promise.resolve(
        buildApplyFormObservation(pages.current, "2026-09-14T10:00:00.000Z"),
      ),
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
      return Promise.resolve({
        ok: true,
        url: "https://jobs.example.test/listing",
      });
    },
    readText: () => Promise.resolve("A job listing"),
    fillText: (_ref, value) =>
      Promise.resolve({ ok: true, observedValue: value }),
    chooseOption: (_ref, option) =>
      Promise.resolve({ ok: true, observedValue: option }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () =>
      Promise.resolve({ ok: true, url: "https://jobs.example.test/listing" }),
    adoptOpenedTab,
  };
}

async function run(
  tools: ReturnType<typeof createPageTools>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const tool = tools.tools.find(
    (entry) => entry.definition.function.name === name,
  )!;
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
        openedTabs: [
          {
            index: 0,
            url: "https://employer.example.test/apply",
            title: "Apply",
          },
        ],
      });
      return Promise.resolve({ ok: true, observedValue: "clicked" });
    };

    const outcome = await run(tools, "click", { ref: "a0" });

    expect(pageHands.adoptOpenedTab).toHaveBeenCalledWith(0);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.content).toContain('Pressed "Apply"');
      expect(outcome.content).toContain(
        "this link was followed in the current working tab",
      );
      expect(outcome.content).toContain("Use open_tab for an auxiliary page");
      expect(outcome.progress).toBe(true);
    }
    expect(tools.state.observation?.url).toBe(
      "https://employer.example.test/apply",
    );
    expect(tools.state.visitedUrls).toContain(
      "https://employer.example.test/apply",
    );
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

  test("page changes do not veto a click on a resolving ref", async () => {
    const pages = { current: rawPage({ controls: [] }) };
    const pageHands = hands(pages);
    const click = vi.spyOn(pageHands, "clickElement");
    const tools = createPageTools(pageHands);
    await tools.observe();
    pages.current = rawPage({
      url: "https://jobs.example.test/other",
      title: "Other",
    });

    const outcome = await run(tools, "click", { ref: "a0" });

    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(click).toHaveBeenCalledWith("a0");
      expect(outcome.content).toContain('Pressed "Apply"');
      expect(outcome.content).toContain("https://jobs.example.test/other");
    }
  });
});
