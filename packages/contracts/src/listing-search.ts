import type { CandidateProfile, SavedOptionFallback } from "./profile";
import type { FoundJob, JobDetail, JobFitUpdate } from "./jobs";
import type {
  JobSearchGoals,
  ReadDiscoveryPostingPage,
} from "./job-search-engine";

/** Observed list-page evidence. No fit or preference filtering has happened. */
export interface ListingCard {
  url: string;
  title: string;
  text: string;
  /** Fingerprint of the title facts read by profession screening. */
  cardFingerprint: string;
  sourceId: string;
  sourceLabel: string;
  /** Stable own-card evidence, carried through the read to persistence. */
  evidenceFingerprint?: string;
  /** Complete body from an authoritative provider feed; avoids a second GET. */
  listingText?: string;
  /** An already-read detail page, when a source URL itself was a vacancy. */
  listingPage?: Awaited<ReturnType<ReadDiscoveryPostingPage>>;
  /** Visible card facts; detail reading must corroborate the employer. */
  companyHint?: string;
  locationHint?: string;
  sourceJobId?: string;
  postedAt?: string;
  closed?: boolean;
  /** Authoritative provider fields, mechanically read with its complete body. */
  providerFacts?: Pick<
    FoundJob,
    | "company"
    | "location"
    | "workModes"
    | "employmentType"
    | "salaryText"
    | "applyUrl"
    | "postedAt"
  >;
}

export interface SeenListingCard {
  url: string;
  cardFingerprint: string;
  roleGoalsKey: string;
  /** The model's profession verdict on this card; either is final. */
  verdict: "unrelated" | "related";
}

export interface RoleScreenGoals {
  targetRoles: readonly string[];
  relatedRoles: readonly string[];
  strategy: "target_roles" | "related_roles" | "wide_net";
  request?: string;
}

export interface SourceInventory {
  lane?: "http" | "browser";
  provider?: string;
  cards: ListingCard[];
  pagesRead: number;
  complete: boolean;
  /** An inventory page explicitly reported no open positions, rather than an empty/loading shell. */
  emptyConfirmed?: boolean;
  notes: string[];
  needsYou?: boolean;
  /** An observed HTTP 401/403 or explicit sign-in wall; browser reading may still resolve it. */
  accessBlocked?: boolean;
  /** The HTTP lane defers interaction to the separate browser queue. */
  requiresBrowser?: boolean;
  /**
   * Part of this inventory was collected earlier in the search, before a
   * restart; those cards were accepted then and are not repeated in cards.
   */
  resumed?: boolean;
  /**
   * The collection ended on an error or outage before it finished. Its
   * cards so far are kept; it is our failure, so the source is tried again.
   */
  cutShort?: boolean;
}

/**
 * Index pages a search has finished collecting on one source, kept across a
 * restart. A page in the log is not read again: its cards were accepted, and
 * the collection continues from the pages it led to.
 */
export interface IndexPageLog {
  /** The pages this finished page led to, or null when it is not in the log. */
  links(url: string): readonly string[] | null;
  /** Records a page once its cards are accepted. */
  record(url: string, finalUrl: string, links: readonly string[]): void;
}

/**
 * Where a browser collection of one source had got to, kept across a
 * restart so the next run continues from that page with these facts.
 */
export interface SourceNavigationProgress {
  /** The page the collection had reached. */
  currentUrl: string;
  /** Pages it had loaded, in order. */
  visitedUrls: string[];
  /** Listing cards it had collected; they are kept. */
  collected: number;
  stepCount: number;
  savedAt: string;
  /** Set when the collection ended: how it ended, for a restart to reuse. */
  outcome?: {
    complete: boolean;
    pagesRead: number;
    notes: string[];
  };
}

export interface ListingSearchReader {
  readPage: ReadDiscoveryPostingPage;
  signal?: AbortSignal;
}

/** The runner merges these sightings before passing unscored jobs to fit. */
export interface ReadListingResult {
  jobs: FoundJob[];
  failures: Array<{
    url: string;
    reason: string;
    needsYou?: boolean;
    requiresBrowser?: boolean;
  }>;
  /**
   * Supplied addresses the reader found to be an index of several vacancies
   * (a category, directory or results list). Their postings are collected
   * from the index; the index itself is neither a vacancy nor a failed read.
   */
  indexes?: string[];
  /**
   * Supplied addresses the site answered as removed (HTTP 404 or 410). They
   * are recorded closed without a model read; they are not failed reads.
   */
  closed?: string[];
}

/** One answer the person gave to an earlier application question. */
export interface SavedFitAnswer {
  question: string;
  answer: string;
  /** Set when the person gave it for applications in one country only. */
  country?: string;
  /** Set when the person gave it for one site only. */
  site?: string;
}

export interface SearchFitInput {
  request?: string;
  profile: CandidateProfile;
  goals: JobSearchGoals;
  /** Confirmed global country-list rules, never a grant of work permission. */
  countryOptionFallbacks?: readonly SavedOptionFallback[];
  /**
   * The person's confirmed saved answers, such as work authorization,
   * citizenship and sponsorship: facts for eligibility and requirements.
   */
  savedAnswers?: readonly SavedFitAnswer[];
  jobs: readonly JobDetail[];
  signal?: AbortSignal;
  onBatch?: (fits: JobFitUpdate[]) => Promise<void> | void;
}
