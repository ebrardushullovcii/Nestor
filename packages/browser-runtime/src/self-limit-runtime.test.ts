import { afterEach, expect, test, vi } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright";
import { createHostQueue } from "./host-queue";
import { createHttpPageReader } from "./http-page-reader";
import { readRenderedPageHtml } from "./rendered-page-reader";
import { choosePageOption } from "./choose-page-option";
import { watchPageSelfLimits } from "./self-limit-page";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function hits(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === "string" && line.startsWith("[self_limit_hit] ")
      ? [JSON.parse(line.slice(17)) as { limit: string; value: number }]
      : [],
  );
}
test("host queues report the active total and per-host boundaries and keep queued work", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {}),
    queue = createHostQueue({ limit: 2, perHost: 1 }),
    signal = new AbortController().signal;
  let release!: () => void;
  const first = queue.run(
    "a",
    signal,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await Promise.resolve();
  const second = queue.run("a", signal, () => Promise.resolve("second"));
  const third = queue.run("b", signal, () => Promise.resolve("third"));
  const fourth = queue.run("c", signal, () => Promise.resolve("fourth"));
  release();
  expect(await Promise.all([first, second, third, fourth])).toEqual([
    undefined,
    "second",
    "third",
    "fourth",
  ]);
  expect(hits(log).map((hit) => hit.limit)).toEqual(
    expect.arrayContaining(["host_queue_per_host", "host_queue_total"]),
  );
});
test("an HTTP refusal keeps its site status for browser continuation instead of spending a retry budget", async () => {
  const request = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response("busy", { status: 429 })),
  );
  await expect(
    createHttpPageReader({ fetch: request })("https://example.test/job", {}),
  ).rejects.toMatchObject({ status: 429 });
  expect(request).toHaveBeenCalledTimes(1);
});

test("rendered snapshots do not wait for semantic readiness on a continually changing page", async () => {
  const close = vi.fn(() => Promise.resolve()),
    ready = vi.fn(() => false);
  const page = {
    goto: vi.fn(() => Promise.resolve(null)),
    content: vi.fn(() =>
      Promise.resolve("<main>Changing animation, no recognized cards</main>"),
    ),
    url: () => "https://example.test",
    locator: () => ({
      evaluate: () =>
        Promise.resolve("Changing animation, no recognized cards"),
    }),
    frames: () => [],
    close,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Page;
  const result = await readRenderedPageHtml(
    { newPage: () => Promise.resolve(page) } as unknown as BrowserContext,
    page.url(),
    { ready },
  );
  expect(result.html).toContain("Changing animation");
  expect(ready).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test("active navigation can continue past 20 seconds with connection progress", async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>();
  let finish!: () => void;
  const close = vi.fn(() => Promise.resolve());
  const goto = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        finish = () => resolve(null);
      }),
  );
  const page = {
    goto,
    content: () => Promise.resolve("Complete"),
    locator: () => ({ evaluate: () => Promise.resolve("Complete") }),
    frames: () => [],
    url: () => "https://example.test",
    close,
    on: (name: string, listener: () => void) => listeners.set(name, listener),
    off: (name: string) => listeners.delete(name),
  } as unknown as Page;
  const pending = readRenderedPageHtml(
    { newPage: () => Promise.resolve(page) } as unknown as BrowserContext,
    page.url(),
  );
  await vi.advanceTimersByTimeAsync(10_000);
  listeners.get("response")?.();
  await vi.advanceTimersByTimeAsync(10_000);
  listeners.get("response")?.();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(close).not.toHaveBeenCalled();
  expect(goto).toHaveBeenCalledWith(page.url(), {
    waitUntil: "domcontentloaded",
    timeout: 0,
  });
  finish();
  expect(await pending).toEqual({
    html: "Complete",
    finalUrl: page.url(),
    visibleText: "Complete",
  });
  expect(close).toHaveBeenCalledOnce();
});
function pickerLocator(
  evaluate: () => Promise<unknown>,
  selectOption = vi.fn(() => Promise.resolve()),
): Locator {
  return {
    evaluate,
    selectOption,
    elementHandles: () =>
      Promise.resolve([
        {
          evaluate: vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockImplementation(evaluate),
          dispose: () => Promise.resolve(),
        },
      ]),
  } as unknown as Locator;
}

test("a silent native picker reports idle instead of inventing an absent option", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const evaluate = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValue({ disabled: false, busy: true, options: [] });
  const input = pickerLocator(evaluate);
  const pending = choosePageOption(
    { on: () => {} } as unknown as Page,
    input,
    "Not available yet",
  );
  await vi.advanceTimersByTimeAsync(5200);
  expect(await pending).toMatchObject({ ok: false });
  expect(hits(log).some((hit) => hit.limit === "native_option_idle")).toBe(
    true,
  );
});
test("page console forwarding attaches once and uses the shared structured event", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {}),
    on = vi.fn();
  const page = { on } as unknown as Page;
  watchPageSelfLimits(page);
  watchPageSelfLimits(page);
  expect(on).toHaveBeenCalledTimes(1);
  const listener = on.mock.calls[0]![1] as (message: {
    text: () => string;
  }) => void;
  listener({
    text: () =>
      '__nestor_self_limit__ {"limit":"test","kind":"count","value":1,"where":"page"}',
  });
  expect(hits(log)).toMatchObject([{ limit: "test", value: 1 }]);
});

test.each(["state", "connection"])(
  "a native picker keeps progressing through %s beyond its former total clock",
  async (kind) => {
    vi.useFakeTimers();
    const started = Date.now();
    const selected = vi.fn(() => Promise.resolve());
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementation(() =>
        Promise.resolve({
          disabled: false,
          busy: true,
          options: [
            {
              text:
                kind === "state"
                  ? `Loading page ${Math.floor((Date.now() - started) / 1000)}`
                  : "Loading",
              value: "",
              disabled: true,
            },
          ],
        }),
      );
    const input = pickerLocator(evaluate, selected);
    selected.mockImplementation(() => {
      evaluate.mockResolvedValue("Wanted");
      return Promise.resolve();
    });
    const listeners = new Map<string, () => void>();
    const page = {
      on: (name: string, listener: () => void) => {
        listeners.set(name, listener);
      },
      off: (name: string) => listeners.delete(name),
    } as unknown as Page;
    const pending = choosePageOption(page, input, "Wanted");
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(4_000);
      if (kind === "connection") listeners.get("response")?.();
    }
    expect(selected).not.toHaveBeenCalled();
    evaluate.mockResolvedValue({
      disabled: false,
      busy: false,
      options: [{ text: "Wanted", value: "wanted", disabled: false }],
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ ok: true, observedValue: "Wanted" });
    expect(selected).toHaveBeenCalledWith({ index: 0 }, { timeout: 0 });
  },
);
