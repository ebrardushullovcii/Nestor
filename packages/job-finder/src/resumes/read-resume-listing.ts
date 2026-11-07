import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { JobDetail } from "@nestor/contracts";
import type { ResumeStore } from "@nestor/db/job-store";
import {
  createDefaultListingHtmlFetcher,
  createModelListingPageReader,
  readListingDetail,
  namesDifferentRole,
  type ListingHtmlFetcher,
  type RenderedListingPageReader,
} from "../internal/listing-detail-enrichment";

/** Both queued writing and a retired draft on Apply read the complete posting. */
export function createResumeListingReader(deps: {
  aiClient: JobFinderAiClient;
  resumes: Pick<ResumeStore, "saveListing">;
  fetchListingHtml?: ListingHtmlFetcher;
  readRenderedPage?: RenderedListingPageReader;
}) {
  const resumes = deps.resumes;
  const fetchHtml = deps.fetchListingHtml ?? createDefaultListingHtmlFetcher();
  const readPage = createModelListingPageReader(deps.aiClient);
  /** A card-only job gets its posting read once, with no fit check. */
  return async function withListing(job: JobDetail, signal: AbortSignal) {
    if (job.facts.fullListingRead === true && job.description.trim())
      return job;
    const page = await fetchHtml(job.url, {
      signal,
    });
    signal.throwIfAborted();
    if (page.status >= 400)
      throw new Error(
        `The full listing could not be read (HTTP ${page.status}). Try writing the resume again when the posting is available.`,
      );
    const detail =
      (await readListingDetail({
        html: page.html,
        url: page.finalUrl,
        expectedTitle: job.title,
        readPage,
        ...(deps.readRenderedPage
          ? { readRenderedPage: deps.readRenderedPage }
          : {}),
        signal,
      })) ?? null;
    if (
      !detail ||
      detail.descriptionLikelyTruncated ||
      !detail.description.trim()
    ) {
      throw new Error(
        "The full listing could not be read. Try writing the resume again when the posting is available.",
      );
    }
    if (detail.title && namesDifferentRole(job.title, detail.title))
      throw new Error(
        "The listing opened a different role. Check the job link before writing its resume.",
      );
    const facts = {
      ...job.facts,
      fullListingRead: true,
      keySkills: detail.keySkills ?? job.facts.keySkills,
      responsibilities: detail.responsibilities ?? job.facts.responsibilities,
      minimumQualifications:
        detail.minimumQualifications ?? job.facts.minimumQualifications,
      preferredQualifications:
        detail.preferredQualifications ?? job.facts.preferredQualifications,
    };
    resumes.saveListing(job.id, detail.description, facts);
    return { ...job, description: detail.description, facts };
  };
}
