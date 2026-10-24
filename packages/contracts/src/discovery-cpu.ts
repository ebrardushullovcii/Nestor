import type { JobSource } from "./base";
import type {
  DiscoveryListingFingerprints,
  JobDiscoveryTarget,
  JobPosting,
} from "./discovery";
import type { SourceIntelligenceArtifact } from "./source-debug";

/**
 * A feed reader that crashed or exited took its transferred bytes with it;
 * the caller may read that one feed again on its own thread.
 */
export const DISCOVERY_READER_LOST_ERROR = "DiscoveryReaderLostError";

/** Pure work only: no repositories, browser handles or execution authority. */
export type DiscoveryFeedTask = {
  payload: string | Uint8Array;
  target: JobDiscoveryTarget;
  intelligence: SourceIntelligenceArtifact;
  source: JobSource;
  prepareForDiscovery: boolean;
};

export type DiscoveryPostingPreparation = {
  normalized: Partial<JobPosting>;
  fingerprints: DiscoveryListingFingerprints;
  content: { digest: string; packed: Uint8Array } | null;
  screeningContent: { digest: string; packed: Uint8Array } | null;
};

export type DiscoveryJobIdentityAlias = {
  key: string;
  kind:
    | "provider_posting_id"
    | "source_posting_id"
    | "employer_application_url"
    | "canonical_listing_url"
    | "exact_listing_content"
    | "cross_source_listing_facts"
    | "corroborated_listing_facts";
  confidence: "strong" | "corroborating" | "possible";
  priority: number;
};

export type DiscoveryFeedResult = {
  jobs: JobPosting[];
  skippedMalformedCount: number;
  preparations: DiscoveryPostingPreparation[];
};

export type DiscoveryCpuTask = { kind: "feed"; input: DiscoveryFeedTask };
export type DiscoveryCpuResult = { kind: "feed"; result: DiscoveryFeedResult };
export type DiscoveryCpuRequest = { id: number; task: DiscoveryCpuTask };
export type DiscoveryCpuResponse =
  | { id: number; result: DiscoveryCpuResult; error?: never }
  | { id: number; error: string; result?: never };
