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

const words = (value: string) =>
  value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Whether saved text says anything beyond the posting's own heading: its
 * title, employer and place. A results card often stores just that.
 */
export function hasPostingText(
  job: Pick<JobDetail, "title" | "company" | "location">,
  text: string,
): boolean {
  const heading = new Set(words(`${job.title} ${job.company} ${job.location}`));
  return words(text).some((word) => !heading.has(word));
}

/**
 * Queued writing and a retired draft on Apply both write from the posting.
 * Saved posting text is used as it is. Only a job whose saved text is its
 * heading alone, or a card marked as partial, has its posting read first.
 */
export function createResumeListingReader(deps: {
  aiClient: JobFinderAiClient;
  resumes: Pick<ResumeStore, "saveListing">;
  fetchListingHtml?: ListingHtmlFetcher;
  readRenderedPage?: RenderedListingPageReader;
}) {
  const resumes = deps.resumes;
  const fetchHtml = deps.fetchListingHtml ?? createDefaultListingHtmlFetcher();
  const readPage = createModelListingPageReader(deps.aiClient);
  return async function withListing(job: JobDetail, signal: AbortSignal) {
    const saved = hasPostingText(job, job.description);
    if (saved && job.facts.fullListingRead !== false) return job;
    try {
      return await readListing(job, signal);
    } catch (error) {
      signal.throwIfAborted();
      // A failed read never blocks a job whose own text is saved; the
      // writer sees that this text may be partial.
      if (saved) return job;
      throw error;
    }
  };

  async function readListing(job: JobDetail, signal: AbortSignal) {
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
      !hasPostingText(job, detail.description)
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
  }
}
