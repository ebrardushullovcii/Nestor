import type { JobDetail } from "@nestor/contracts";
import type { ResumeStore } from "@nestor/db/job-store";
import type { PostingReader } from "../internal/browser-listing-read";
import { normalizeText } from "../internal/shared";

const words = (value: string) =>
  value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * The listing page names another role, not the same role worded differently.
 * One title containing the other ("Data Analyst (m/w/d)", "Designer, Growth")
 * is the same role; a different level or mostly different words is not.
 */
export function namesDifferentRole(saved: string, observed: string): boolean {
  const left = normalizeText(saved);
  const right = normalizeText(observed);
  if (!left || !right || left.includes(right) || right.includes(left)) {
    return false;
  }
  const leftWords = left.split(" ");
  const rightWords = new Set(right.split(" "));
  const shared = new Set(leftWords.filter((word) => rightWords.has(word)));
  return shared.size / Math.min(leftWords.length, rightWords.size) < 0.75;
}

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
 * heading alone, or a card marked as partial, has its posting read first, by
 * the model in Nestor's browser, the way search reads the listings it keeps.
 */
export function createResumeListingReader(deps: {
  resumes: Pick<ResumeStore, "saveListing">;
  readPosting?: PostingReader;
}) {
  const resumes = deps.resumes;
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
    if (!deps.readPosting) throw new Error("Browser reading is unavailable.");
    const posting = await deps.readPosting(job, signal);
    signal.throwIfAborted();
    if (!hasPostingText(job, posting.description)) {
      throw new Error(
        "The full listing could not be read. Try writing the resume again when the posting is available.",
      );
    }
    if (posting.title && namesDifferentRole(job.title, posting.title))
      throw new Error(
        "The listing opened a different role. Check the job link before writing its resume.",
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
