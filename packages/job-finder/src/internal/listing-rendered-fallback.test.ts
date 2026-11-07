import { expect, it, vi } from "vitest";
import {
  readListingDetail,
  type ListingPageReader,
} from "./listing-detail-enrichment";
import { createSeed } from "../test-fixtures";
it("asks for the rendered page only when the model found no listing text in HTTP", async () => {
  const readPage = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      ...createSeed().savedJobs[0],
      description:
        "Lead design reviews. Variable hours. A portfolio is required.",
    });
  const readRenderedPage = vi.fn().mockResolvedValue({
    html: "<main>Lead design reviews. Variable hours. A portfolio is required.</main>",
    finalUrl: "https://example.test/job",
  });
  const detail = await readListingDetail({
    html: "<main></main><script>render()</script>",
    url: "https://example.test/job",
    expectedTitle: null,
    readPage,
    readRenderedPage,
  });
  expect(readRenderedPage).toHaveBeenCalledTimes(1);
  const secondRead = readPage.mock.calls[1]?.[0] as
    | { pageText: string }
    | undefined;
  expect(secondRead?.pageText).toContain("Variable hours");
  expect(detail?.description).toContain("portfolio");
});
it("leaves ordinary HTTP listing reads alone", async () => {
  const readPage = vi.fn().mockResolvedValue(createSeed().savedJobs[0]);
  const readRenderedPage = vi.fn();
  await readListingDetail({
    html: "<main>A posting</main>",
    url: "https://example.test/job",
    expectedTitle: null,
    readPage,
    readRenderedPage,
  });
  expect(readRenderedPage).not.toHaveBeenCalled();
});
it("uses rendered DOM text when the HTML snapshot still contains only an app shell", async () => {
  const body =
    "Complete rendered duties, qualifications and application facts. " +
    "Late listing fact. ".repeat(400);
  const readPage = vi
    .fn<ListingPageReader>()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      ...createSeed().savedJobs[0]!,
      description: body,
    });
  const detail = await readListingDetail({
    html: "<main>Loading</main>",
    url: "https://example.test/job",
    expectedTitle: null,
    readPage,
    readRenderedPage: () =>
      Promise.resolve({
        html: "<main>Loading</main>",
        finalUrl: "https://example.test/job",
        visibleText: body,
      }),
  });
  expect(readPage.mock.calls[1]?.[0].pageText).toContain(body);
  expect(detail?.description).toBe(body);
});
it("renders an HTTP card when the model says the listing body is still missing", async () => {
  const base = createSeed().savedJobs[0]!;
  const readPage = vi
    .fn()
    .mockResolvedValueOnce({
      ...base,
      description: "Designer card",
      needsRenderedPage: true,
    })
    .mockResolvedValueOnce({
      ...base,
      description: "Rendered duties and portfolio requirements",
      needsRenderedPage: false,
    });
  const readRenderedPage = vi.fn().mockResolvedValue({
    html: "<main>Rendered duties and portfolio requirements</main>",
    finalUrl: "https://example.test/job",
  });
  const result = await readListingDetail({
    html: "<main>Designer card</main>",
    url: "https://example.test/job",
    expectedTitle: null,
    readPage,
    readRenderedPage,
  });
  expect(result?.description).toBe(
    "Rendered duties and portfolio requirements",
  );
  expect(readRenderedPage).toHaveBeenCalledOnce();
});
