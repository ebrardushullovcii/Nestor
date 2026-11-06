import { expect, test, vi } from "vitest";
import { createHttpPageReader } from "./http-page-reader";

test("retries temporary server failures and reads only with GET", async () => {
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
    redirect: "error",
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

test("retries beyond the old three-failure limit and returns the complete page", async () => {
  let calls = 0;
  const request = vi.fn<typeof fetch>(() =>
    Promise.resolve(
      ++calls <= 6
        ? new Response("temporary", {
            status: 503,
            headers: { "retry-after": "0" },
          })
        : new Response("last listing"),
    ),
  );
  expect(
    (
      await createHttpPageReader({ fetch: request })(
        "https://example.test/jobs",
        {},
      )
    ).html,
  ).toBe("last listing");
  expect(calls).toBe(7);
});

test("Stop ends reader retries and non-retryable failures retain their actual status", async () => {
  const controller = new AbortController();
  let calls = 0;
  const request = vi.fn<typeof fetch>(() => {
    if (++calls === 6) controller.abort(new Error("Stopped"));
    return Promise.resolve(
      new Response("temporary", {
        status: 429,
        headers: { "retry-after": "0" },
      }),
    );
  });
  await expect(
    createHttpPageReader({ fetch: request })("https://example.test/jobs", {
      signal: controller.signal,
    }),
  ).rejects.toThrow("Stopped");
  expect(calls).toBe(6);
  const refused = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response("missing", { status: 404 })),
  );
  await expect(
    createHttpPageReader({ fetch: refused })("https://example.test/jobs", {}),
  ).rejects.toMatchObject({ status: 404 });
  expect(refused).toHaveBeenCalledOnce();
});
