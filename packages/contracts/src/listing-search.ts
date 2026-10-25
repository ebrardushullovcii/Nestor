import type { CandidateProfile } from "./profile";
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
  cards: ListingCard[];
  pagesRead: number;
  complete: boolean;
  notes: string[];
  needsYou?: boolean;
}

export interface ListingSearchReader {
  readPage: ReadDiscoveryPostingPage;
  signal?: AbortSignal;
}

/** The runner merges these sightings before passing unscored jobs to fit. */
export interface ReadListingResult {
  jobs: FoundJob[];
  failures: Array<{ url: string; reason: string; needsYou?: boolean }>;
}

export interface SearchFitInput {
  request?: string;
  profile: CandidateProfile;
  goals: JobSearchGoals;
  jobs: readonly JobDetail[];
  signal?: AbortSignal;
  onBatch?: (fits: JobFitUpdate[]) => Promise<void> | void;
}
