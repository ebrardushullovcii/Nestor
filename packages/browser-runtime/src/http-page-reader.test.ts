import { expect, test, vi } from "vitest";
import { DiscoveryPageReadError } from "@nestor/contracts";
import { createHttpPageReader } from "./http-page-reader";

test("waits for Retry-After and reads only with GET", async () => {
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

test.each([429, 503])(
  "HTTP %s Retry-After waits without occupying an active host slot",
  async (status) => {
    vi.useFakeTimers();
    try {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("wait", { status, headers: { "retry-after": "120" } }),
        )
        .mockImplementation(() =>
          Promise.resolve(new Response("complete listing")),
        );
      const read = createHttpPageReader({ fetch: request });
      const waiting = read("https://busy.example/job", {});
      await vi.advanceTimersByTimeAsync(1);
      expect(request).toHaveBeenCalledOnce();
      expect(await read("https://healthy.example/job", {})).toMatchObject({
        html: "complete listing",
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await waiting).toMatchObject({ html: "complete listing" });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  },
);

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
    const stopped = expect(
      read("https://example.test/jobs", { signal: controller.signal }),
    ).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await stopped;
    expect(request).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("a 429 without Retry-After waits on the host, doubles while refused, and is never handed to a browser", async () => {
  vi.useFakeTimers();
  try {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockImplementation(() => Promise.resolve(new Response("listing")));
    const readRendered = vi.fn();
    const read = createHttpPageReader({ fetch: request, readRendered });
    const waiting = read("https://busy.example/job", {});
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(2);
    // The second refusal doubles the wait.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await waiting).toMatchObject({ html: "listing" });
    expect(request).toHaveBeenCalledTimes(3);
    expect(readRendered).not.toHaveBeenCalled();
    // An answer resets the wait: the next refusal waits one second again.
    request.mockResolvedValueOnce(new Response("slow down", { status: 429 }));
    const again = read("https://busy.example/other", {});
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await again).toMatchObject({ html: "listing" });
  } finally {
    vi.useRealTimers();
  }
});

test("a browser read that the site refuses with 429 paces the host for browser and HTTP reads", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("listing")),
    );
    const readRendered = vi
      .fn<
        NonNullable<
          Parameters<typeof createHttpPageReader>[0]
        >["readRendered"] & {}
      >()
      .mockRejectedValueOnce(new DiscoveryPageReadError(429))
      .mockResolvedValue({
        html: "rendered",
        finalUrl: "https://busy.example/job",
      });
    const read = createHttpPageReader({ fetch: request, readRendered });
    const rendered = read("https://busy.example/job", { rendered: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(readRendered).toHaveBeenCalledTimes(1);
    const plain = read("https://busy.example/other", {});
    await vi.advanceTimersByTimeAsync(500);
    expect(request).not.toHaveBeenCalled();
    expect(readRendered).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(await rendered).toMatchObject({ html: "rendered" });
    expect(await plain).toMatchObject({ html: "listing" });
    expect(readRendered).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test.each([404, 410])(
  "HTTP %s is returned to the caller as the site's answer without a retry",
  async (status) => {
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("gone", { status })),
    );
    await expect(
      createHttpPageReader({ fetch: request })("https://example.test/job", {}),
    ).rejects.toMatchObject({ status });
    expect(request).toHaveBeenCalledOnce();
  },
);

test("a landing read returns where a link's redirects end without reading the page", async () => {
  const landed = (status: number) => {
    const response = new Response("employer page", { status });
    Object.defineProperty(response, "url", {
      value: "https://jobs.employer.test/acme/123",
    });
    return response;
  };
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
    .mockResolvedValueOnce(landed(200))
    .mockResolvedValueOnce(landed(403))
    .mockResolvedValueOnce(landed(404))
    .mockResolvedValueOnce(new Response("board refused", { status: 403 }));
  const reader = createHttpPageReader({ fetch: request });
  expect(
    await reader("https://board.test/job/go/123/", { landingOnly: true }),
  ).toEqual({ html: "", finalUrl: "https://jobs.employer.test/acme/123" });
  // The board's request to slow down is honoured before it is asked again.
  expect(request).toHaveBeenCalledTimes(2);
  // The employer refusing the page does not hide where the link led.
  expect(
    await reader("https://board.test/job/go/124/", { landingOnly: true }),
  ).toEqual({ html: "", finalUrl: "https://jobs.employer.test/acme/123" });
  // An error page shared by removed postings cannot establish their identity.
  await expect(
    reader("https://board.test/job/go/125/", { landingOnly: true }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    reader("https://board.test/job/go/126/", { landingOnly: true }),
  ).rejects.toMatchObject({ status: 403 });
});
