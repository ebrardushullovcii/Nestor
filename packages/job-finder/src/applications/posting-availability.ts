import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { JobDetail } from "@nestor/contracts";
import {
  listingClosedReason,
  listingPageText,
  extractListingDetailFromHtml,
} from "@nestor/browser-agent/listing-detail-extraction";
import {
  createModelListingPageReader,
  readListingDetail,
  namesDifferentRole,
  type ListingHtmlFetcher,
  type RenderedListingPageReader,
} from "../internal/listing-detail-enrichment";

export type PostingAvailability = {
  state: "open" | "closed" | "unknown";
  reason: string;
  checkedAt: number;
};

/** Read the posting afresh with the same detail reader used by resumes. */
export async function readPostingAvailability(input: {
  job: Pick<JobDetail, "url" | "title">;
  aiClient: Pick<JobFinderAiClient, "extractJobsFromPage">;
  fetchHtml: ListingHtmlFetcher;
  readRenderedPage?: RenderedListingPageReader;
  signal: AbortSignal;
}): Promise<PostingAvailability> {
  const result = (
    state: PostingAvailability["state"],
    reason: string,
  ): PostingAvailability => ({ state, reason, checkedAt: Date.now() });
  try {
    let page = await input.fetchHtml(input.job.url, { signal: input.signal });
    input.signal.throwIfAborted();
    if ([404, 410].includes(page.status))
      return result(
        "closed",
        `Closed: the posting was removed (HTTP ${page.status}).`,
      );
    if (page.status >= 400) {
      if (!input.readRenderedPage)
        return result(
          "unknown",
          `The posting could not be checked (HTTP ${page.status}).`,
        );
      const rendered = await input.readRenderedPage(input.job.url, {
        signal: input.signal,
      });
      page = { ...rendered, status: 200 };
    }
    const closedReason = (html: string, url: string) =>
      listingClosedReason(
        listingPageText(html),
        extractListingDetailFromHtml({
          html,
          url,
          expectedTitle: input.job.title,
        })?.validThrough,
      );
    const closed = closedReason(page.html, page.finalUrl);
    if (closed) return result("closed", closed);
    let renderedClosed: string | null = null;
    const detail = await readListingDetail({
      html: page.html,
      url: page.finalUrl,
      expectedTitle: input.job.title,
      readPage: createModelListingPageReader(input.aiClient),
      signal: input.signal,
      ...(input.readRenderedPage
        ? {
            readRenderedPage: async (url, options) => {
              const rendered = await input.readRenderedPage!(url, options);
              renderedClosed = closedReason(rendered.html, rendered.finalUrl);
              return rendered;
            },
          }
        : {}),
    });
    if (renderedClosed) return result("closed", renderedClosed);
    if (detail?.title && namesDifferentRole(input.job.title, detail.title))
      return result(
        "unknown",
        "The page shows a different role; this posting could not be confirmed open.",
      );
    const detailClosed =
      detail && listingClosedReason(detail.description, detail.validThrough);
    if (detailClosed) return result("closed", detailClosed);
    return detail
      ? result("open", "The posting was read and is still available.")
      : result(
          "unknown",
          "The page did not confirm an open posting. The application page must be checked before filling.",
        );
  } catch (error) {
    input.signal.throwIfAborted();
    return result(
      "unknown",
      error instanceof Error
        ? `The posting could not be checked: ${error.message}`
        : "The posting could not be checked.",
    );
  }
}
