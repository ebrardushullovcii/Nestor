import {
  JobPostingSchema,
  type JobPosting,
  type ReadDiscoveryPostingPage,
} from "@nestor/contracts";
import type { JobExtractor } from "../agent/contracts";
import {
  extractListingDetailFromHtml,
  listingPageLinks,
  listingPageText,
  LISTING_PAGE_OMISSION_MARKER,
} from "./listing-detail-extraction";

/** Read a new listing once before any fit judgment or persistence checkpoint. */
export async function readPostingDetail(input: {
  posting: JobPosting;
  readPage: ReadDiscoveryPostingPage;
  extractor: JobExtractor;
  signal?: AbortSignal;
}): Promise<JobPosting> {
  const { posting } = input;
  if (
    posting.listingDetailFetch?.outcome === "enriched" ||
    (posting.collectionMethod === "api" &&
      posting.detailQuality === "detail_enriched")
  )
    return posting;
  const attemptedAt = new Date().toISOString();
  try {
    input.signal?.throwIfAborted();
    let page = await input.readPage(posting.canonicalUrl, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const structured = extractListingDetailFromHtml({
      html: page.html,
      url: page.finalUrl,
      expectedTitle: posting.title,
    });
    if (structured) {
      return JobPostingSchema.parse({
        ...posting,
        title: structured.title ?? posting.title,
        company: structured.company ?? posting.company,
        location: structured.location ?? posting.location,
        description: structured.description,
        salaryText: structured.salaryText ?? posting.salaryText,
        employmentType: structured.employmentType ?? posting.employmentType,
        postedAt: structured.postedAt ?? posting.postedAt,
        applicationUrl: structured.directApplyUrl ?? posting.applicationUrl,
        workMode: structured.workModeHints.length
          ? structured.workModeHints
          : posting.workMode,
        detailQuality: structured.descriptionLikelyTruncated
          ? "partial_detail"
          : "detail_enriched",
        listingDetailFetch: {
          attemptedAt,
          outcome: structured.descriptionLikelyTruncated
            ? "partial"
            : "enriched",
          method: "json_ld",
          detail: "Read the complete published listing.",
        },
      });
    }
    const extract = () =>
      input.extractor.extractJobsFromPage({
        pageUrl: page.finalUrl,
        pageType: "job_detail",
        pageText: `Listing identity from the result card (page data): ${JSON.stringify({ title: posting.title, company: posting.company, url: posting.canonicalUrl })}\n\n${listingPageText(page.html)}\n\nPage links:\n${JSON.stringify(listingPageLinks(page.html, page.finalUrl))}`,
        maxJobs: 1,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    let detail = (await extract())[0];
    if (detail?.needsRenderedPage) {
      page = await input.readPage(posting.canonicalUrl, {
        rendered: true,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      detail = (await extract())[0];
    }
    if (!detail?.description.trim() || detail.needsRenderedPage)
      throw new Error("The full listing could not be read.");
    const partial = listingPageText(page.html).includes(
      LISTING_PAGE_OMISSION_MARKER,
    );
    return JobPostingSchema.parse({
      ...posting,
      ...detail,
      source: posting.source,
      sourceJobId: posting.sourceJobId,
      canonicalUrl: posting.canonicalUrl,
      company: detail.company || posting.company,
      detailQuality: partial ? "partial_detail" : "detail_enriched",
      listingDetailFetch: {
        attemptedAt,
        outcome: partial ? "partial" : "enriched",
        method: "page_text",
        detail: partial
          ? "Some listing text could not be captured."
          : "Read the complete listing page.",
      },
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      ...posting,
      description: "",
      summary: posting.summary ?? posting.description,
      listingDetailFetch: {
        attemptedAt,
        outcome: "fetch_failed",
        method: null,
        detail:
          error instanceof Error
            ? error.message
            : "The full listing could not be read.",
      },
    };
  }
}
