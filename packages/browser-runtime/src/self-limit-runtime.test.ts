import { afterEach, expect, test, vi } from "vitest";
import type { BrowserContext, Locator, Page } from "playwright";
import { createHostQueue } from "./host-queue";
import { createHttpPageReader } from "./http-page-reader";
import { readRenderedPageHtml } from "./rendered-page-reader";
import { attachFile } from "./file-attachment";
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
test("a public HTTP read reports its final bounded retry", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const request = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response("busy", { status: 429, headers: { "retry-after": "0" } }),
    ),
  );
  await expect(
    createHttpPageReader({ fetch: request })("https://example.test/job", {}),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(4);
  expect(hits(log).some((hit) => hit.limit === "http_retries")).toBe(true);
});
test("rendered readiness and navigation deadlines report and close only the owned tab", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {}),
    close = vi.fn(async () => {});
  const page = {
    goto: () => Promise.resolve(null),
    content: () => Promise.resolve("<main>Still loading</main>"),
    url: () => "https://example.test/job",
    close,
    waitForTimeout: async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
  } as unknown as Page;
  const context = {
    newPage: () => Promise.resolve(page),
  } as unknown as BrowserContext;
  await readRenderedPageHtml(context, page.url(), { ready: () => false });
  expect(hits(log).some((hit) => hit.limit === "rendered_page_ready")).toBe(
    true,
  );
  expect(close).toHaveBeenCalledTimes(1);
  const timeout = Object.assign(Error("Timeout 20000ms exceeded"), {
    name: "TimeoutError",
  });
  page.goto = vi.fn().mockRejectedValue(timeout);
  await expect(readRenderedPageHtml(context, page.url())).rejects.toBe(timeout);
  expect(
    hits(log).some(
      (hit) => hit.limit === "operation_timeout" && hit.value === 20000,
    ),
  ).toBe(true);
  expect(close).toHaveBeenCalledTimes(2);
});
test("an attachment command timeout is reported at the real file tool boundary", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {}),
    timeout = Object.assign(Error("Timeout 15000ms exceeded"), {
      name: "TimeoutError",
    });
  const input = {
    getAttribute: () => Promise.resolve(null),
    setInputFiles: () => Promise.reject(timeout),
  } as unknown as Locator;
  await expect(
    attachFile({} as Page, input, {
      name: "synthetic.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([1]),
    }),
  ).rejects.toBe(timeout);
  expect(hits(log).some((hit) => hit.value === 15000)).toBe(true);
});
test("native picker settling reports its deadline instead of inventing an absent option", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const input = {
    evaluate: vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue({ disabled: false, busy: true, options: [] }),
  } as unknown as Locator;
  const pending = choosePageOption(
    { on: () => {} } as unknown as Page,
    input,
    "Not available yet",
  );
  await vi.advanceTimersByTimeAsync(5200);
  expect(await pending).toMatchObject({ ok: false });
  expect(hits(log).some((hit) => hit.limit === "native_option_settle")).toBe(
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
