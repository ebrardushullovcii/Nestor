import { afterEach, expect, test, vi } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { forwardPageSelfLimitHit } from "@nestor/core";
import {
  collectApplyDocumentSnapshot,
  readApplySummaryRows,
  readApplyPlacements,
  APPLY_PAGE_SELECTORS,
  installPageMessageRecorderInPage,
} from "./apply-page-mechanics";
import { collectVisibleAccessSignals } from "./source-access-probe";
import { readWholeList } from "./choose-page-option";
import type { Locator } from "playwright";

const windows: JSDOM[] = [];
afterEach(() => {
  windows.splice(0).forEach((dom) => dom.window.close());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function dom(html: string) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("debug", (message: unknown) => {
    if (typeof message === "string") forwardPageSelfLimitHit(message);
  });
  const page = new JSDOM(html, {
    url: "https://synthetic.example/apply",
    runScripts: "outside-only",
    virtualConsole,
  });
  windows.push(page);
  page.window.eval(
    `Object.defineProperty(HTMLElement.prototype, "innerText", { get() { return this.textContent || ""; } }); HTMLElement.prototype.getClientRects = function () { return [{width:100,height:20}]; }; HTMLElement.prototype.getBoundingClientRect = function () { return {x:0,y:0,top:0,bottom:20,left:0,right:100,width:100,height:20}; };`,
  );
  return page;
}
function hits(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === "string" && line.startsWith("[self_limit_hit] ")
      ? [
          JSON.parse(line.slice(17)) as {
            limit: string;
            value: number;
            where: string;
          },
        ]
      : [],
  );
}

test("the serialized snapshot preserves full body, headings, clickables, alerts, hints and options", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const page = dom(
    `<body>${"<h2>" + "H".repeat(350) + "</h2>"}`.repeat(65) +
      `<form><label for="answer">Answer</label><p id="hint">${"hint ".repeat(150)}</p><input id="answer" aria-describedby="hint" /></form>` +
      `<div><p id="file-hint">${"upload hint ".repeat(80)}</p><input type="file" aria-describedby="file-hint"></div>` +
      `<input role="combobox" aria-controls="choices"><div id="choices" role="listbox">${Array.from({ length: 205 }, (_, i) => `<span role="option">Choice ${i}</span>`).join("")}</div>` +
      `<select>${Array.from({ length: 205 }, (_, i) => `<option>${i}</option>`).join("")}</select>` +
      Array.from(
        { length: 305 },
        (_, i) => `<div onclick="void 0">${i} ${"choice ".repeat(60)}</div>`,
      ).join("") +
      "<div role=alert>Required</div>".repeat(15) +
      "</body>",
  );
  const snapshot = page.window.eval(
    `(${collectApplyDocumentSnapshot.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(Object.values(APPLY_PAGE_SELECTORS).join(", "))})),${JSON.stringify(APPLY_PAGE_SELECTORS)})`,
  ) as {
    bodyText: string;
    headings: unknown[];
    clickables: unknown[];
    validationErrors: unknown[];
  };
  expect(snapshot.bodyText.length).toBeGreaterThan(20000);
  expect(snapshot.headings.length).toBe(65);
  expect(snapshot.clickables.length).toBeGreaterThan(300);
  expect(snapshot.validationErrors.length).toBe(15);
  expect(hits(log), JSON.stringify(hits(log))).toEqual([]);
});

test("summary rows and access-signal scanning retain the whole page", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const page = dom(
    `<dl>${Array.from({ length: 205 }, () => `<dt>${"label".repeat(110)}</dt><dd>${"value ".repeat(2100)}</dd>`).join("")}</dl><fieldset><legend>${"section ".repeat(40)}</legend><input></fieldset>${"<button>Sign in</button>".repeat(1010)}`,
  );
  const rows = page.window.eval(
    `(${readApplySummaryRows.toString()})(Array.from(document.querySelectorAll("dl")))`,
  ) as { label: string; value: string }[];
  expect(rows).toHaveLength(205);
  expect(rows[0]!.label).toHaveLength(550);
  expect(rows[0]!.value).toHaveLength("value ".repeat(2100).trim().length);
  page.window.eval(
    `(${readApplyPlacements.toString()})(Array.from(document.querySelectorAll("input")))`,
  );
  page.window.eval(`(${collectVisibleAccessSignals.toString()})()`);
  expect(hits(log)).toEqual([]);
  expect(hits(log).some((hit) => hit.limit === "summary_rows")).toBe(false);
});

test("serialized page messages preserve full text and history while keeping dialogs dismissed", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const page = dom("<body>Form</body>");
  page.window.eval(`(${installPageMessageRecorderInPage.toString()})()`);
  for (let i = 0; i < 21; i++)
    page.window.alert("synthetic message ".repeat(40));
  const messages = page.window.eval("window.__nestorPageMessages") as {
    text: string;
  }[];
  expect(messages).toHaveLength(21);
  expect(
    messages.every(
      (entry) => entry.text === "synthetic message ".repeat(40).trim(),
    ),
  ).toBe(true);
  expect(hits(log)).toEqual([]);
  expect(page.window.confirm("continue?")).toBe(false);
  expect(page.window.prompt("value?")).toBeNull();
});

test("a small complete DOM does not report a self-limit", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const page = dom(
    '<body><h2>Application</h2><label for="name">Name</label><input id="name"></body>',
  );
  page.window.eval(
    `(${collectApplyDocumentSnapshot.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(Object.values(APPLY_PAGE_SELECTORS).join(", "))})),${JSON.stringify(APPLY_PAGE_SELECTORS)})`,
  );
  expect(hits(log), JSON.stringify(hits(log))).toEqual([]);
});

test.each(["options", "steps"] as const)(
  "serialized picker scanning passes its former %s ceiling without omitting choices",
  async (boundary) => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = dom(
      `<div id="choices" style="overflow-y:auto">${Array.from({ length: boundary === "options" ? 1510 : 3 }, (_, i) => `<div role="option">Choice ${i}</div>`).join("")}</div>`,
    );
    page.window.eval(
      `Object.defineProperty(HTMLElement.prototype,"scrollHeight",{get(){return 10000}});Object.defineProperty(HTMLElement.prototype,"clientHeight",{get(){return 100}});`,
    );
    const list = {
      evaluate: (read: (...args: unknown[]) => unknown, input: unknown) =>
        Promise.resolve(
          page.window.eval(
            `(${read.toString()})(document.getElementById("choices"),${JSON.stringify(input)})`,
          ),
        ),
    } as unknown as Locator;
    const pending = readWholeList(list, "Unlisted choice");
    await vi.advanceTimersByTimeAsync(20000);
    const result = await pending;
    expect(result.complete).toBe(true);
    expect(result.options).toHaveLength(boundary === "options" ? 1510 : 3);
    expect(
      hits(log).some(
        (hit) =>
          hit.limit ===
          (boundary === "options" ? "picker_options" : "picker_scroll_steps"),
      ),
    ).toBe(false);
  },
);

test("a list that refuses scrolling returns its observed choices as incomplete", async () => {
  vi.useFakeTimers();
  const page = dom(
    '<div id="choices" style="overflow-y:auto"><div role="option">One choice</div></div>',
  );
  page.window.eval(
    'Object.defineProperty(HTMLElement.prototype,"scrollHeight",{get(){return 10000}});Object.defineProperty(HTMLElement.prototype,"clientHeight",{get(){return 100}});Object.defineProperty(HTMLElement.prototype,"scrollTop",{get(){return 0},set(){}});',
  );
  const list = {
    evaluate: (read: (...args: unknown[]) => unknown, input: unknown) =>
      Promise.resolve(
        page.window.eval(
          `(${read.toString()})(document.getElementById("choices"),${JSON.stringify(input)})`,
        ),
      ),
  } as unknown as Locator;
  const pending = readWholeList(list, "Other choice");
  await vi.runAllTimersAsync();
  expect(await pending).toMatchObject({
    complete: false,
    options: ["One choice"],
  });
});
