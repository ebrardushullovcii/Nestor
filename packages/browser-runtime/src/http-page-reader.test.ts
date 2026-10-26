import { expect, test, vi } from "vitest";
import { createHttpPageReader } from "./http-page-reader";

test("honors server backoff and reads only with GET; browser work stays explicit", async () => {
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
