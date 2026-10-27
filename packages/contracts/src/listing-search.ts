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
  /** Complete body from an authoritative provider feed; avoids a second GET. */
  listingText?: string;
  /** An already-read detail page, when a source URL itself was a vacancy. */
  listingPage?: { html: string; finalUrl: string };
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
  verdict: "unrelated";
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
  notes: string[];
  needsYou?: boolean;
  /** An observed HTTP 401/403 or explicit sign-in wall; browser reading may still resolve it. */
  accessBlocked?: boolean;
  /** The HTTP lane defers interaction to the separate browser queue. */
  requiresBrowser?: boolean;
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
}

export interface SearchFitInput {
  request?: string;
  profile: CandidateProfile;
  goals: JobSearchGoals;
  /** Confirmed global country-list rules, never a grant of work permission. */
  countryOptionFallbacks?: readonly SavedOptionFallback[];
  jobs: readonly JobDetail[];
  signal?: AbortSignal;
  onBatch?: (fits: JobFitUpdate[]) => Promise<void> | void;
}
