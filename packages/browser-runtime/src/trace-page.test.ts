import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { bindTracePage, tracePageHands } from "./trace-page";

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
        innerText: () => Promise.resolve("Visible application text"),
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
    expect(native).toHaveBeenCalledWith(page, {
      masks: [secretBox],
      viewport: { width: 800, height: 600 },
    });
    expect(screenshot).not.toHaveBeenCalled();
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    const raw = readFileSync(path.join(dir, file), "utf8");
    expect(raw).toContain('"applicationKey":"application_1_attempt_1"');
    expect(raw).toContain('"action":"fillText"');
    expect(raw).toContain("Visible application text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
