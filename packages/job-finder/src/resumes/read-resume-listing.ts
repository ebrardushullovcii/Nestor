import type { JobDetail } from "@nestor/contracts";
import type { ResumeStore } from "@nestor/db/job-store";
import type { PostingReader } from "../internal/browser-listing-read";

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

/** The posting says it is closed; no resume is written for it. */
export class PostingClosedError extends Error {
  override name = "PostingClosedError";
}

/**
 * Queued writing and a retired draft on Apply both write from the posting.
 * Saved posting text is used as it is. Only a job whose saved text is its
 * heading alone, or a card marked as partial, has its posting read first, by
 * the model in Nestor's browser, the way search reads the listings it keeps.
 * Apply reads it first whenever it would write: a posting found closed gets
 * no resume written.
 */
export function createResumeListingReader(deps: {
  resumes: Pick<ResumeStore, "saveListing">;
  readPosting?: PostingReader;
}) {
  const resumes = deps.resumes;
  return async function withListing(
    job: JobDetail,
    signal: AbortSignal,
    options: {
      /** Read the posting even when its text is saved, to learn it is open. */
      readFirst?: boolean;
    } = {},
  ) {
    const saved = hasPostingText(job, job.description);
    if (!options.readFirst && saved && job.facts.fullListingRead !== false)
      return job;
    try {
      return await readListing(job, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof PostingClosedError || getRejectedModelRequest(error))
        throw error;
      // A failed read never blocks a job whose own text is saved; the
      // writer sees that this text may be partial.
      if (saved) return job;
      throw error;
    }
  };

  async function readListing(job: JobDetail, signal: AbortSignal) {
    if (!deps.readPosting) throw new Error("Browser reading is unavailable.");
    const posting = await deps.readPosting(job, signal);
    signal.throwIfAborted();
    if (posting.searchRejection?.category === "closed")
      throw new PostingClosedError(
        `The posting is closed: ${posting.searchRejection.reason}`,
      );
    if (!hasPostingText(job, posting.description)) {
      throw new Error(
        "The full listing could not be read. Try writing the resume again when the posting is available.",
      );
    }
    // The reading model was given this job's saved title and text and
    // answered whether the page is the same posting; its answer stands.
    if (posting.requestedListingMatch?.same === false)
      throw new Error(
        `The listing opened a different role: ${posting.requestedListingMatch.reason} Check the job link before writing its resume.`,
      );
    const fromPosting = (value: string[], fallback: string[]) =>
      value.length > 0 ? value : fallback;
    const facts = {
      ...job.facts,
      fullListingRead: true,
      keySkills: fromPosting(posting.keySkills, job.facts.keySkills),
      responsibilities: fromPosting(
        posting.responsibilities,
        job.facts.responsibilities,
      ),
      minimumQualifications: fromPosting(
        posting.minimumQualifications,
        job.facts.minimumQualifications,
      ),
      preferredQualifications: fromPosting(
        posting.preferredQualifications,
        job.facts.preferredQualifications,
      ),
    };
    resumes.saveListing(job.id, posting.description, facts);
    return { ...job, description: posting.description, facts };
  }
}
import { getRejectedModelRequest } from "@nestor/ai-providers";
