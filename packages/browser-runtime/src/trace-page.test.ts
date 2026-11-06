import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { bindTracePage, tracePageHands, traceFinalPage } from "./trace-page";

afterEach(() => vi.unstubAllEnvs());
test("tracing off preserves the original hands and performs no browser work", () => {
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", "");
  const hands = { fillText: vi.fn() };
  expect(tracePageHands({} as Page, hands)).toBe(hands);
});
test("action capture uses the exact native-owned Page, masks secrets and never waits for Playwright screenshots", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nestor-page-trace-"));
  vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
  try {
    const secretBox = { x: 10, y: 20, width: 100, height: 25 };
    const native = vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3])));
    const screenshot = vi.fn(() => {
      throw Error("This screenshot path must never run");
    });
    const context = {};
    const page = {
      context: () => context,
      frames: () => [
        {
          locator: () => ({
            count: () => Promise.resolve(1),
            all: () =>
              Promise.resolve([
                { boundingBox: () => Promise.resolve(secretBox) },
              ]),
          }),
        },
      ],
      evaluate: () => Promise.resolve({ width: 800, height: 600 }),
      locator: () => ({
        evaluate: () => Promise.resolve("Visible application text"),
      }),
      url: () => "https://replica.invalid/application-1",
      screenshot,
    } as unknown as Page;
    bindTracePage(page, "application_1_attempt_1", native);
    const result = { ok: true, observedValue: "changed" };
    const hands = tracePageHands(page, {
      fillText: () => Promise.resolve(result),
    });
    expect(await hands.fillText()).toBe(result);
    await vi.waitFor(() =>
      expect(native).toHaveBeenCalledWith(page, {
        masks: [secretBox],
        viewport: { width: 800, height: 600 },
      }),
    );
    expect(screenshot).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(readdirSync(dir).some((f) => f.endsWith(".jsonl"))).toBe(true),
    );
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    const raw = readFileSync(path.join(dir, file), "utf8");
    expect(raw).toContain('"applicationKey":"application_1_attempt_1"');
    expect(raw).toContain('"action":"fillText"');
    expect(raw).toContain("Visible application text");
    await traceFinalPage(page);
    expect(readFileSync(path.join(dir, file), "utf8")).toContain(
      '"action":"final_outcome"',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["locator", "viewport", "capture"])(
  "a stalled %s capture never holds the browser action",
  async (stage) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nestor-detached-trace-"));
    vi.stubEnv("NESTOR_RUN_TRACE_DIR", dir);
    const never = () => new Promise<never>(() => {});
    const page = {
      context: () => context,
      frames: () => [
        {
          locator: () => ({
            count: stage === "locator" ? never : () => Promise.resolve(0),
            all: () => Promise.resolve([]),
          }),
        },
      ],
      evaluate:
        stage === "viewport"
          ? never
          : () => Promise.resolve({ width: 800, height: 600 }),
      url: () => "https://replica.invalid/form",
    } as unknown as Page;
    const context = {};
    bindTracePage(page, "application_stalled", never);
    const action = vi.fn(() => Promise.resolve("the action result"));
    const hands = tracePageHands(page, { readPage: action });
    try {
      expect(await hands.readPage()).toBe("the action result");
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
