import {
  JobPostingSchema,
  SavedJobSchema,
  assessJobPostingDetailQuality,
  deriveListingDetailCapture,
  type JobPosting,
  type ListingDetailFetch,
  type ListingDetailFetchOutcome,
  type MatchAssessment,
  type SavedJob,
} from "@nestor/contracts";
import {
  extractListingDetailFromHtml,
  listingPageLinks,
  listingPageText,
  LISTING_PAGE_OMISSION_MARKER,
  normalizeListingText,
  stripPictographGlyphs,
  type ExtractedListingDetail,
} from "./listing-detail-extraction";
import {
  getAiProviderAccessFailure,
  isAiServiceBusy,
} from "@nestor/ai-providers";
import { collapseRepeatedLocationTokens } from "./listing-field-shapes";
import { enrichDiscoveredPosting } from "./matching";
import { listUnreadSightings } from "./listing-sightings";
import { normalizeText } from "./shared";
import { reconcileSalaryTextWithListingBody } from "./matching-compensation";

/**
 * Reads listing bodies for jobs a compact scan captured as cards only.
 *
 * A card carries a title, an employer and a link. Everything the product is
 * for — the fit score, the requirements it checks, the text a tailored resume
 * is written toward — needs the body. This stage fetches each retained job's
 * own page over plain HTTP (no browser, no session, no cookies), reads the
 * schema.org JobPosting record most job pages publish or, when a page has
 * none, has the model read the page's text (ADR 0041), and re-scores the job
 * with the same scorer the search used. It is source-generic (ADR 0007): it
 * knows HTML, not boards.
 *
 * Bounded on every axis: per-request timeout, capped concurrency, capped
 * count, one attempt per job per day. A failed read is
 * recorded on the job so the product can say "tried, no text" instead of
 * pretending the listing was never opened.
 */

export interface ListingHtmlFetchResult {
  status: number;
  html: string;
  finalUrl: string;
  /** Server-requested pause after a 429, already parsed and bounded. */
  retryAfterMs?: number;
}

export type ListingHtmlFetcher = (
  url: string,
  options: { signal: AbortSignal },
) => Promise<ListingHtmlFetchResult>;

/**
 * The model reading one listing page's text: the posting it found, or null
 * when the page is not a job listing.
 */
export type RenderedListingPageReader = (
  url: string,
  options: { signal?: AbortSignal },
) => Promise<{ html: string; finalUrl: string }>;

export type ListingPageReader = (input: {
  pageText: string;
  pageUrl: string;
  signal?: AbortSignal;
}) => Promise<JobPosting | null>;

/** The listing page reader backed by the model's job-page extraction. */
export function createModelListingPageReader(aiClient: {
  extractJobsFromPage(input: {
    pageText: string;
    pageUrl: string;
    pageType: "job_detail";
    maxJobs: number;
    signal?: AbortSignal;
  }): Promise<JobPosting[]>;
}): ListingPageReader {
  return async (input) => {
    const postings = await aiClient.extractJobsFromPage({
      pageText: input.pageText,
      pageUrl: input.pageUrl,
      pageType: "job_detail",
      maxJobs: 1,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return postings[0] ?? null;
  };
}

export interface ListingDetailEnrichmentSummary {
  attempted: number;
  enriched: number;
  partial: number;
  noDetail: number;
  failed: number;
  blocked: number;
  skipped: number;
  elapsedMs: number;
}

export interface EnrichSavedJobListingDetailsInput {
  onProgress?: (completed: number, total: number) => void;
  /** More jobs from the same bounded search pass, until its sources finish. */
  nextJob?: () => Promise<SavedJob | undefined>;
  /** Publish each completed read without waiting for the other pages. */
  onJobRead?: (original: SavedJob, updated: SavedJob) => Promise<void>;
  /**
   * Read again even inside the retry back-off after a failed attempt. Used
   * when the person acts on a job right now and the body matters at once.
   */
  ignoreRetryBackoff?: boolean;
  /** An explicit read requests fresh text even after a completed page read. */
  rereadComplete?: boolean;
  jobs: readonly SavedJob[];
  fetchHtml: ListingHtmlFetcher;
  /** Reads the full page with published facts and links as model inputs. */
  readPage?: ListingPageReader;
  readRenderedPage?: RenderedListingPageReader;
  /** Re-scores a posting; the discovery pipeline's assessment session. */
  assess: (posting: JobPosting) => MatchAssessment | Promise<MatchAssessment>;
  now?: () => string;
  signal?: AbortSignal;
  concurrency?: number;
  /** @deprecated Retained for callers; each listing now owns its timeout. */
  timeBudgetMs?: number;
  perRequestTimeoutMs?: number;
  /** Never read more than this many pages in one call. */
  maxJobs?: number;
}

export interface EnrichSavedJobListingDetailsResult {
  /** Input jobs followed by streamed jobs, updated where a read changed them. */
  jobs: SavedJob[];
  changedJobIds: string[];
  summary: ListingDetailEnrichmentSummary;
  /**
   * The first read the AI service itself refused (no funds, no access) or
   * turned away for load. The job records a failed read either way; a caller
   * that needs the body, such as the resume writer, rethrows this so the work
   * pauses instead of going ahead without the listing.
   */
  providerAccessError?: unknown;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PER_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 1_000;
const MAX_RATE_LIMIT_PAUSE_MS = 30_000;
const MAX_DEFERRED_RATE_LIMIT_MS = 24 * 60 * 60 * 1_000;
/** Each rate-limited page is asked again this many times after the pause. */
const RATE_LIMIT_RETRIES_PER_JOB = 2;
/** And the whole pass never asks again more often than this. */
const RATE_LIMIT_RETRIES_PER_PASS = 40;
/** Nor waits on rate limits for longer than this in total. */
const RATE_LIMIT_WAIT_BUDGET_MS = 90_000;
/** Exported so the run log can say how many of the candidates this pass reads. */
export const LISTING_DETAIL_READS_PER_RUN = 60;
const DEFAULT_MAX_JOBS = LISTING_DETAIL_READS_PER_RUN;
const RETRY_AFTER_SUCCESSFUL_ATTEMPT_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILED_ATTEMPT_MS = 60 * 60 * 1000;
const MAX_RESPONSE_CHARACTERS = 1_500_000;
const MAX_RESPONSE_BYTES = MAX_RESPONSE_CHARACTERS * 4;
const SUMMARY_MAX_LENGTH = 420;

const BROWSER_LIKE_HEADERS = {
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
};

/** Plain-HTTP page reader used outside tests. */
export function createDefaultListingHtmlFetcher(): ListingHtmlFetcher {
  return async (url, options) => {
    const response = await fetch(url, {
      headers: BROWSER_LIKE_HEADERS,
      redirect: "follow",
      signal: options.signal,
    });
    let text = "";
    const reader = response.body?.getReader();
    if (reader) {
      let bytesRead = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          options.signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) {
            text += decoder.decode();
            break;
          }
          const accepted = value.subarray(0, MAX_RESPONSE_BYTES - bytesRead);
          bytesRead += accepted.byteLength;
          text += decoder.decode(accepted, { stream: true });
          if (
            bytesRead >= MAX_RESPONSE_BYTES ||
            text.length >= MAX_RESPONSE_CHARACTERS
          ) {
            await reader.cancel();
            break;
          }
        }
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    return {
      status: response.status,
      html:
        text.length > MAX_RESPONSE_CHARACTERS
          ? text.slice(0, MAX_RESPONSE_CHARACTERS)
          : text,
      finalUrl: response.url || url,
      ...(response.status === 429
        ? {
            retryAfterMs: parseRetryAfterMs(
              response.headers.get("retry-after"),
            ),
          }
        : {}),
    };
  };
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) {
    return DEFAULT_RATE_LIMIT_PAUSE_MS;
  }
  const seconds = Number(value);
  const requestedMs = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(requestedMs)) {
    return DEFAULT_RATE_LIMIT_PAUSE_MS;
  }
  return Math.min(
    MAX_DEFERRED_RATE_LIMIT_MS,
    Math.max(0, Math.round(requestedMs)),
  );
}

async function waitForRateLimitPause(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("The listing read was cancelled.", "AbortError"),
        );
      },
      { once: true },
    );
  });
}

function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Whether a job is worth a read right now: it has a fetchable page, its body
 * is not already known, and it has not been tried too recently.
 */
export function jobNeedsListingDetail(
  job: Pick<SavedJob, "detailQuality" | "canonicalUrl" | "listingDetailFetch">,
  nowIso: string = new Date().toISOString(),
): boolean {
  // Browser-agent collection intentionally keeps its structured result small.
  // A long-enough excerpt can therefore qualify as detail_enriched while still
  // ending before the requirements section. Only a successful page-detail read
  // proves this enrichment stage already ran; otherwise read the job's own page
  // once so scoring and tailoring receive the complete body.
  if (
    job.detailQuality === "detail_enriched" &&
    job.listingDetailFetch?.outcome === "enriched"
  ) {
    return false;
  }
  if (!isHttpUrl(job.canonicalUrl)) {
    return false;
  }
  const attempt = job.listingDetailFetch;
  if (!attempt) {
    return true;
  }
  if (attempt.outcome === "unsupported_url") {
    return false;
  }
  if (attempt.retryAfterAt) {
    // A rate limit names its own wait. Once it has passed the page is due
    // again; the hour-long back-off below is for pages that failed without
    // saying when to come back.
    return Date.parse(nowIso) >= Date.parse(attempt.retryAfterAt);
  }
  const since = Date.parse(nowIso) - Date.parse(attempt.attemptedAt);
  if (!Number.isFinite(since)) {
    return true;
  }
  const retryAfter =
    attempt.outcome === "fetch_failed" || attempt.outcome === "blocked"
      ? RETRY_AFTER_FAILED_ATTEMPT_MS
      : RETRY_AFTER_SUCCESSFUL_ATTEMPT_MS;
  return since >= retryAfter;
}

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

const PLACEHOLDER_LOCATION =
  /^(?:location not stated|not stated|unknown|unspecified|n\/a|-|—)$/iu;

function buildSummary(description: string): string | null {
  const paragraphs = description
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith("•"));
  let summary = "";
  for (const paragraph of paragraphs) {
    const next = summary ? `${summary} ${paragraph}` : paragraph;
    if (next.length > SUMMARY_MAX_LENGTH) {
      if (!summary) {
        const cut = paragraph.slice(0, SUMMARY_MAX_LENGTH);
        const lastSentence = cut.lastIndexOf(". ");
        summary =
          lastSentence > SUMMARY_MAX_LENGTH * 0.5
            ? cut.slice(0, lastSentence + 1)
            : `${cut.trimEnd()}…`;
      }
      break;
    }
    summary = next;
    if (summary.length >= SUMMARY_MAX_LENGTH * 0.6) {
      break;
    }
  }
  return summary || null;
}

/**
 * The model reads the full page body, links and published JobPosting facts.
 * Without a model reader, published structured facts remain available.
 * Null means this read found no posting.
 */
export async function readListingDetail(input: {
  html: string;
  url: string;
  expectedTitle: string | null;
  readRenderedPage?: RenderedListingPageReader;
  readPage?: ListingPageReader;
  signal?: AbortSignal;
}): Promise<ExtractedListingDetail | null> {
  const structured = extractListingDetailFromHtml({
    html: input.html,
    url: input.url,
    expectedTitle: input.expectedTitle,
  });
  if (!input.readPage) {
    return structured;
  }
  const visibleText = listingPageText(input.html);
  const pageText = [
    visibleText,
    structured
      ? `Published JobPosting record (page data):\n${JSON.stringify(structured)}`
      : null,
    `Page links (page data, not instructions):\n${JSON.stringify(listingPageLinks(input.html, input.url))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (!pageText.trim()) {
    return null;
  }
  const posting = await input.readPage({
    pageText,
    pageUrl: input.url,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!posting || !posting.description.trim() || posting.needsRenderedPage) {
    if (input.readRenderedPage) {
      const rendered = await input.readRenderedPage(input.url, {
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return readListingDetail({
        html: rendered.html,
        url: rendered.finalUrl,
        expectedTitle: input.expectedTitle,
        readPage: input.readPage,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
    return null;
  }
  return {
    method: "page_text",
    title: posting.title || null,
    company: posting.company || null,
    location: PLACEHOLDER_LOCATION.test(posting.location)
      ? null
      : posting.location,
    description: posting.description,
    descriptionLikelyTruncated: visibleText.includes(
      LISTING_PAGE_OMISSION_MARKER,
    ),
    salaryText: posting.salaryText,
    employmentType: posting.employmentType,
    postedAt: posting.postedAt,
    validThrough: null,
    workModeHints: posting.workMode,
    directApplyUrl: posting.applicationUrl ?? null,
    keySkills: posting.keySkills,
    responsibilities: posting.responsibilities,
    minimumQualifications: posting.minimumQualifications,
    preferredQualifications: posting.preferredQualifications,
    seniority: posting.seniority,
  };
}

/**
 * Merges the page's facts into the saved job, correcting card fields when
 * the full page supplies them. The description replaces the card excerpt.
 */
export async function applyListingDetailToJob(input: {
  job: SavedJob;
  detail: ExtractedListingDetail;
  attemptedAt: string;
  assess: (posting: JobPosting) => MatchAssessment | Promise<MatchAssessment>;
}): Promise<{
  job: SavedJob;
  outcome: Extract<
    ListingDetailFetchOutcome,
    "enriched" | "partial" | "no_detail"
  >;
}> {
  const { job, detail } = input;
  // The site's own record or the model's reading of the page names the role;
  // page text is never parsed by rules for it (ADR 0041).
  const observedTitle = detail.title;
  if (observedTitle && namesDifferentRole(job.title, observedTitle)) {
    return {
      job: SavedJobSchema.parse({
        ...job,
        listingDetailFetch: {
          attemptedAt: input.attemptedAt,
          outcome: "no_detail",
          method: detail.method,
          detail:
            "The linked listing names a different role. Open the listing and choose the role you want.",
          identityConflict: {
            expectedTitle: job.title,
            observedTitle,
          },
        },
      }),
      outcome: "no_detail",
    };
  }
  const description = detail.description || job.description;
  const company = detail.company || job.company;
  const location = detail.location || job.location;
  // The full page is a better source for skills and requirements than the
  // results card the job was saved from.
  const fromPage = <T>(value: T[] | undefined, fallback: T[]): T[] =>
    value && value.length > 0 ? value : fallback;

  const candidate: JobPosting = JobPostingSchema.parse({
    ...job,
    // Entities and board decoration are settled once, here, on every value
    // this stage can write. A detail page storing "Transportation Partners
    // &amp;amp; Logistics" or a colour pin beside the city is what put both on
    // screen; the stored value is the readable one.
    company: stripPictographGlyphs(normalizeListingText(company)),
    location: collapseRepeatedLocationTokens(
      stripPictographGlyphs(normalizeListingText(location)),
    ),
    description: normalizeListingText(description),
    summary: buildSummary(description) ?? job.summary,
    salaryText: stripPictographGlyphs(
      normalizeListingText(
        reconcileSalaryTextWithListingBody(
          detail.salaryText ?? job.salaryText,
          description,
        ),
      ),
    ),
    postedAt: job.postedAt ?? detail.postedAt,
    employmentType: detail.employmentType ?? job.employmentType,
    workMode:
      detail.workModeHints.length > 0 ? detail.workModeHints : job.workMode,
    applicationUrl: detail.directApplyUrl,
    keySkills: fromPage(detail.keySkills, job.keySkills),
    responsibilities: fromPage(detail.responsibilities, job.responsibilities),
    minimumQualifications: fromPage(
      detail.minimumQualifications,
      job.minimumQualifications,
    ),
    preferredQualifications: fromPage(
      detail.preferredQualifications,
      job.preferredQualifications,
    ),
    seniority: detail.seniority ?? null,
  });
  const assessedQuality = assessJobPostingDetailQuality(candidate);
  const quality = detail.descriptionLikelyTruncated
    ? assessedQuality === "card_only"
      ? "card_only"
      : "partial_detail"
    : assessedQuality;
  // A page can publish a record whose body is a sentence; that is not a
  // listing to score against, and the job says so instead of claiming detail.
  const outcome =
    quality === "detail_enriched"
      ? "enriched"
      : quality === "partial_detail"
        ? "partial"
        : "no_detail";
  const fetchRecord: ListingDetailFetch = {
    attemptedAt: input.attemptedAt,
    outcome,
    method: detail.method,
    detail:
      outcome === "no_detail"
        ? "Only a short excerpt could be read. Open the listing to check the requirements."
        : detail.descriptionLikelyTruncated
          ? "Read partial listing text; some page text was omitted or the response was incomplete."
          : detail.method === "json_ld"
            ? "Read the listing's structured JobPosting record from its page."
            : "Read the listing page's text.",
  };
  const enrichedPosting = enrichDiscoveredPosting(
    { ...candidate, detailQuality: quality, listingDetailFetch: fetchRecord },
    job,
  );
  const nextJob = SavedJobSchema.parse({
    ...job,
    ...enrichedPosting,
    // A partial read can confirm identity and place without replacing the
    // richer stored body. Keep those newly read facts independently.
    company: candidate.company,
    location: candidate.location,
    workMode: candidate.workMode,
    employmentType: candidate.employmentType,
    // The page just read is this sighting's own listing: keep the apply link
    // it shows, so a job seen on several sources can be pointed at the
    // employer's own form (ADR 0030).
    provenance: recordSightingApplyLink(
      job.provenance,
      job.canonicalUrl,
      detail.directApplyUrl,
      input.attemptedAt,
      {
        ...enrichedPosting,
        company: candidate.company,
        location: candidate.location,
      },
    ),
    detailQuality: quality,
    applicationUrl: detail.directApplyUrl,
    listingDetailFetch: fetchRecord,
    listingDetailCapture: deriveListingDetailCapture({
      description: enrichedPosting.description,
      detailQuality: quality,
      listingDetailFetch: fetchRecord,
    }),
  });
  return {
    job: SavedJobSchema.parse({
      ...nextJob,
      matchAssessment: await input.assess(nextJob),
    }),
    outcome,
  };
}

function recordSightingApplyLink(
  provenance: SavedJob["provenance"],
  listingUrl: string,
  pageApplyUrl: string | null,
  readAt: string,
  listingFacts?: NonNullable<SavedJob["provenance"][number]["listingFacts"]>,
): SavedJob["provenance"] {
  return provenance.map((entry) =>
    entry.listingUrl === listingUrl
      ? {
          ...entry,
          ...(listingFacts ? { listingFacts } : {}),
          applicationUrl: pageApplyUrl ?? null,
          pageApplyUrl: pageApplyUrl ?? null,
          routeReadAt: readAt,
        }
      : entry,
  );
}

export interface SightingRouteReadSummary {
  read: number;
  rateLimited: boolean;
}

/**
 * Reads the other listings of jobs seen on several sources, once each, for
 * the apply link each page shows. Nothing else from those pages is used; the
 * job's content still comes from its own listing. Bounded like the body read
 * and polite about rate limits: the first 429 ends the pass, and the rest are
 * read on the next search.
 */
export async function readSightingApplyRoutes(input: {
  jobs: readonly SavedJob[];
  fetchHtml: ListingHtmlFetcher;
  /** A source handed to the person is not retried elsewhere in the same run. */
  canReadUrl?: (url: string) => boolean;
  readPage?: ListingPageReader;
  now?: () => string;
  signal?: AbortSignal;
  perRequestTimeoutMs?: number;
  maxReads?: number;
}): Promise<{
  jobs: SavedJob[];
  changedJobIds: string[];
  summary: SightingRouteReadSummary;
}> {
  const now = input.now ?? (() => new Date().toISOString());
  const perRequestTimeoutMs =
    input.perRequestTimeoutMs ?? DEFAULT_PER_REQUEST_TIMEOUT_MS;
  let budget = input.maxReads ?? LISTING_DETAIL_READS_PER_RUN;
  const summary: SightingRouteReadSummary = { read: 0, rateLimited: false };
  const changed = new Set<string>();
  const nextJobs: SavedJob[] = [];

  for (const job of input.jobs) {
    let current = job;
    for (const sighting of listUnreadSightings(job.provenance)) {
      if (budget <= 0 || summary.rateLimited || input.signal?.aborted) break;
      const listingUrl = sighting.listingUrl;
      if (!listingUrl || !isHttpUrl(listingUrl)) continue;
      if (input.canReadUrl && !input.canReadUrl(listingUrl)) continue;
      budget -= 1;
      let response: ListingHtmlFetchResult;
      try {
        response = await input.fetchHtml(listingUrl, {
          signal: combineSignals(input.signal, perRequestTimeoutMs),
        });
      } catch {
        // Unreachable this time; it stays unread and is tried next search.
        continue;
      }
      if (response.status === 429) {
        summary.rateLimited = true;
        break;
      }
      let pageApplyUrl: string | null = null;
      try {
        if (response.status >= 400) continue;
        const detail = await readListingDetail({
          html: response.html,
          url: response.finalUrl,
          expectedTitle: job.title,
          ...(input.readPage ? { readPage: input.readPage } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!detail) continue;
        pageApplyUrl = detail.directApplyUrl;
      } catch {
        // A failed model read stays unread so a later search can retry.
        continue;
      }
      summary.read += 1;
      current = SavedJobSchema.parse({
        ...current,
        provenance: recordSightingApplyLink(
          current.provenance,
          listingUrl,
          pageApplyUrl,
          now(),
        ),
      });
      changed.add(job.id);
    }
    nextJobs.push(current);
  }

  return { jobs: nextJobs, changedJobIds: [...changed], summary };
}

function recordFailedAttempt(
  job: SavedJob,
  attemptedAt: string,
  outcome: Exclude<ListingDetailFetchOutcome, "enriched" | "partial">,
  detail: string,
  retryAfterAt?: string,
): SavedJob {
  const listingDetailFetch = {
    attemptedAt,
    outcome,
    method: null,
    detail,
    ...(retryAfterAt ? { retryAfterAt } : {}),
  } as const;
  return SavedJobSchema.parse({
    ...job,
    listingDetailFetch,
    listingDetailCapture: deriveListingDetailCapture({
      description: job.description,
      detailQuality: job.detailQuality,
      listingDetailFetch,
    }),
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" || error.name === "TimeoutError"
      ? "The page did not respond in time."
      : error.message.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

function combineSignals(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parent) {
    return timeout;
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([parent, timeout]);
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/**
 * Reads listing bodies for every job that needs one, within the bounds above,
 * and returns the jobs with bodies, quality, provenance and scores updated.
 */
export async function enrichSavedJobListingDetails(
  input: EnrichSavedJobListingDetailsInput,
): Promise<EnrichSavedJobListingDetailsResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const startedAtMs = Date.now();
  const concurrency = Math.max(1, input.concurrency ?? DEFAULT_CONCURRENCY);
  const perRequestTimeoutMs =
    input.perRequestTimeoutMs ?? DEFAULT_PER_REQUEST_TIMEOUT_MS;
  const maxJobs = input.maxJobs ?? DEFAULT_MAX_JOBS;

  const summary: ListingDetailEnrichmentSummary = {
    attempted: 0,
    enriched: 0,
    partial: 0,
    noDetail: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    elapsedMs: 0,
  };
  const updated = new Map<string, SavedJob>();
  const streamedJobs: SavedJob[] = [];
  let providerAccessError: unknown;
  let rateLimitPauseUntilMs = 0;
  let rateLimitRetryAfterAtMs = 0;
  let rateLimitRetriesLeft = RATE_LIMIT_RETRIES_PER_PASS;
  let firstRateLimitAtMs: number | null = null;
  let deferRemainingForRateLimit = false;
  const registerRateLimit = (response: ListingHtmlFetchResult): number => {
    const pauseMs = Math.min(
      MAX_DEFERRED_RATE_LIMIT_MS,
      Math.max(0, response.retryAfterMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS),
    );
    rateLimitPauseUntilMs = Math.max(
      rateLimitPauseUntilMs,
      Date.now() + pauseMs,
    );
    const responseAtMs = Date.parse(now());
    rateLimitRetryAfterAtMs = Math.max(
      rateLimitRetryAfterAtMs,
      (Number.isFinite(responseAtMs) ? responseAtMs : Date.now()) + pauseMs,
    );
    if (pauseMs > MAX_RATE_LIMIT_PAUSE_MS) {
      deferRemainingForRateLimit = true;
    }
    return pauseMs;
  };
  const waitForSharedRateLimit = async (): Promise<boolean> => {
    while (!deferRemainingForRateLimit) {
      input.signal?.throwIfAborted();
      const delayMs = rateLimitPauseUntilMs - Date.now();
      if (delayMs <= 0) return true;
      await waitForRateLimitPause(delayMs, input.signal);
    }
    return false;
  };
  const queue = input.jobs.filter((job) => {
    const needs = input.rereadComplete
      ? isHttpUrl(job.canonicalUrl)
      : input.ignoreRetryBackoff
        ? !(
            job.detailQuality === "detail_enriched" &&
            job.listingDetailFetch?.outcome === "enriched"
          ) && job.listingDetailFetch?.outcome !== "unsupported_url"
        : jobNeedsListingDetail(job, now());
    if (!needs) {
      summary.skipped += 1;
    }
    return needs;
  });
  const capped = queue.slice(0, maxJobs);
  summary.skipped += queue.length - capped.length;

  let completed = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < (input.nextJob ? maxJobs : capped.length)) {
      if (input.signal?.aborted || deferRemainingForRateLimit) {
        return;
      }
      const position = cursor;
      cursor += 1;
      const job =
        position < capped.length ? capped[position] : await input.nextJob?.();
      if (!job) {
        return;
      }
      if (input.signal?.aborted) return;
      if (position >= capped.length) streamedJobs.push(job);
      let attemptedAt: string | null = null;
      try {
        if (!(await waitForSharedRateLimit())) return;
        summary.attempted += 1;
        attemptedAt = now();
        let response = await input.fetchHtml(job.canonicalUrl, {
          signal: combineSignals(input.signal, perRequestTimeoutMs),
        });
        // A short rate limit is waited out and the page asked again, a
        // bounded number of times per page and per pass, all sharing one
        // pause so the site sees one polite reader. A long one defers the
        // rest of the queue to the next search.
        let retriesForJob = 0;
        while (response.status === 429) {
          const pauseMs = registerRateLimit(response);
          firstRateLimitAtMs ??= Date.now();
          if (
            pauseMs > MAX_RATE_LIMIT_PAUSE_MS ||
            Date.now() + pauseMs - firstRateLimitAtMs >
              RATE_LIMIT_WAIT_BUDGET_MS ||
            retriesForJob >= RATE_LIMIT_RETRIES_PER_JOB ||
            rateLimitRetriesLeft <= 0 ||
            !(await waitForSharedRateLimit())
          ) {
            break;
          }
          retriesForJob += 1;
          rateLimitRetriesLeft -= 1;
          response = await input.fetchHtml(job.canonicalUrl, {
            signal: combineSignals(input.signal, perRequestTimeoutMs),
          });
        }
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 429
        ) {
          summary.blocked += 1;
          updated.set(
            job.id,
            recordFailedAttempt(
              job,
              attemptedAt,
              "blocked",
              response.status === 429
                ? "The site asked Job Finder to slow down (HTTP 429). The listing is read again on the next search."
                : `The page answered ${response.status}; it may require access or a signed-in visitor.`,
              response.status === 429
                ? new Date(rateLimitRetryAfterAtMs).toISOString()
                : undefined,
            ),
          );
          continue;
        }
        if (response.status >= 400) {
          summary.failed += 1;
          updated.set(
            job.id,
            recordFailedAttempt(
              job,
              attemptedAt,
              "fetch_failed",
              `The page answered ${response.status}.`,
            ),
          );
          continue;
        }
        let detail = await readListingDetail({
          ...(input.readRenderedPage
            ? { readRenderedPage: input.readRenderedPage }
            : {}),
          html: response.html,
          url: response.finalUrl,
          expectedTitle: job.title,
          ...(input.readPage ? { readPage: input.readPage } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (
          detail?.descriptionLikelyTruncated &&
          (await waitForSharedRateLimit())
        ) {
          const retryResponse = await input.fetchHtml(job.canonicalUrl, {
            signal: combineSignals(input.signal, perRequestTimeoutMs),
          });
          if (retryResponse.status === 429) {
            registerRateLimit(retryResponse);
          }
          if (retryResponse.status < 400) {
            const retryDetail = extractListingDetailFromHtml({
              html: retryResponse.html,
              url: retryResponse.finalUrl,
              expectedTitle: job.title,
            });
            if (
              retryDetail &&
              (!retryDetail.descriptionLikelyTruncated ||
                retryDetail.description.length > detail.description.length)
            ) {
              detail = retryDetail;
            }
          }
        }
        if (!detail) {
          summary.noDetail += 1;
          updated.set(
            job.id,
            recordFailedAttempt(
              job,
              attemptedAt,
              "no_detail",
              "The listing could not be read from this page. Open the listing and try again.",
            ),
          );
          continue;
        }
        const applied = await applyListingDetailToJob({
          job,
          detail,
          attemptedAt,
          assess: input.assess,
        });
        if (applied.outcome === "enriched") {
          summary.enriched += 1;
        } else if (applied.outcome === "partial") {
          summary.partial += 1;
        } else {
          summary.noDetail += 1;
        }
        updated.set(job.id, applied.job);
      } catch (error) {
        if (input.signal?.aborted) {
          return;
        }
        summary.failed += 1;
        if (
          providerAccessError === undefined &&
          (getAiProviderAccessFailure(error) || isAiServiceBusy(error))
        )
          providerAccessError = error;
        updated.set(
          job.id,
          recordFailedAttempt(
            job,
            attemptedAt ?? now(),
            "fetch_failed",
            describeError(error),
          ),
        );
      } finally {
        if (attemptedAt) {
          await input.onJobRead?.(job, updated.get(job.id) ?? job);
          completed += 1;
          input.onProgress?.(completed, capped.length);
        }
      }
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(concurrency, input.nextJob ? maxJobs : capped.length),
      },
      () => worker(),
    ),
  );

  summary.skipped += Math.max(0, capped.length - summary.attempted);

  summary.elapsedMs = Date.now() - startedAtMs;
  return {
    jobs: [...input.jobs, ...streamedJobs].map(
      (job) => updated.get(job.id) ?? job,
    ),
    changedJobIds: [...updated.keys()],
    summary,
    ...(providerAccessError === undefined ? {} : { providerAccessError }),
  };
}

/** One sentence for the run log and the Home status line. */
export function describeListingDetailEnrichment(
  summary: ListingDetailEnrichmentSummary,
): string {
  if (summary.attempted === 0) {
    return "No listing pages needed reading.";
  }
  const parts: string[] = [];
  const read = summary.enriched + summary.partial;
  parts.push(
    `Read ${read} of ${summary.attempted} listing ${summary.attempted === 1 ? "page" : "pages"}`,
  );
  if (summary.noDetail > 0) {
    parts.push(`${summary.noDetail} had no listing text`);
  }
  if (summary.blocked > 0) {
    parts.push(
      `${summary.blocked} ${summary.blocked === 1 ? "was" : "were"} blocked or rate-limited`,
    );
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed} could not be reached`);
  }
  return `${parts.join(" · ")}.`;
}
