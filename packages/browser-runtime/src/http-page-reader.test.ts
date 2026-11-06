import { expect, test, vi } from "vitest";
import { createHttpPageReader } from "./http-page-reader";

test("preserves server refusals for browser continuation and reads only with GET", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    )
    .mockResolvedValueOnce(new Response("<main>Listing</main>"));
  const reader = createHttpPageReader({ fetch: request });
  await expect(reader("https://example.test/jobs", {})).rejects.toMatchObject({
    status: 429,
  });
  expect(await reader("https://example.test/jobs", {})).toEqual({
    html: "<main>Listing</main>",
    finalUrl: "https://example.test/jobs",
  });
  expect(request).toHaveBeenCalledTimes(2);
  expect(
    request.mock.calls.every(([, options]) => options?.method === "GET"),
  ).toBe(true);
  await expect(
    reader("https://example.test/jobs", { rendered: true }),
  ).rejects.toThrow("needs a browser read");
  expect(request).toHaveBeenCalledTimes(2);
});

test("an aborted read makes no request", async () => {
  const request = vi.fn<typeof fetch>();
  const reader = createHttpPageReader({ fetch: request });
  await expect(
    reader("https://example.test/jobs", { signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

test("provider search queries use JSON without navigation, credentials or redirects", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('{"total":0,"jobPostings":[]}'));
  const reader = createHttpPageReader({ fetch: request }),
    jsonQuery = { appliedFacets: {}, limit: 20, offset: 0, searchText: "" };
  await reader("https://example.test/listings", { jsonQuery });
  expect(request.mock.calls[0]?.[1]).toMatchObject({
    method: "POST",
    body: JSON.stringify(jsonQuery),
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
  });
  await expect(
    reader("https://example.test/listings", { jsonQuery, rendered: true }),
  ).rejects.toThrow("cannot navigate");
  expect(request).toHaveBeenCalledTimes(1);
});

test("a streaming HTTP page keeps working beyond the old 15-second deadline", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              let ticks = 0;
              const interval = setInterval(() => {
                controller.enqueue(new TextEncoder().encode("chunk"));
                if (++ticks === 6) {
                  clearInterval(interval);
                  controller.close();
                }
              }, 10_000);
            },
          }),
        ),
      ),
    );
    const pending = createHttpPageReader({ fetch: request })(
      "https://example.test/jobs",
      {},
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).html).toBe("chunk".repeat(6));
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  new TypeError("fetch failed", { cause: new Error("ENOTFOUND") }),
  new DOMException("Connection idle", "AbortError"),
])("returns connection failure to the deciding lane: %s", async (error) => {
  const request = vi.fn<typeof fetch>(() => Promise.reject(error));
  await expect(
    createHttpPageReader({ fetch: request })("https://example.test/jobs", {}),
  ).rejects.toBe(error);
  expect(request).toHaveBeenCalledOnce();
});

test("Stop interrupts a server-requested queue pause", async () => {
  vi.useFakeTimers();
  try {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response("busy", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
      ),
    );
    const read = createHttpPageReader({ fetch: request });
    await expect(read("https://example.test/jobs", {})).rejects.toMatchObject({
      status: 429,
    });
    const stopped = expect(
      read("https://example.test/next", { signal: controller.signal }),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await stopped;
    expect(request).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
