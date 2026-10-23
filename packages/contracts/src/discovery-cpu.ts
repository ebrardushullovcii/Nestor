import type { JobSource } from "./base";
import type {
  DiscoveryListingFingerprints,
  JobDiscoveryTarget,
  JobPosting,
} from "./discovery";
import type { SourceIntelligenceArtifact } from "./source-debug";

/** Pure work only: no repositories, browser handles or execution authority. */
export type DiscoveryFeedTask = {
  text: string;
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

export type DiscoveryFeedResult = {
  jobs: JobPosting[];
  skippedMalformedCount: number;
  preparations: DiscoveryPostingPreparation[];
};

export type DiscoveryCpuRequest = { id: number; task: DiscoveryFeedTask };
export type DiscoveryCpuResponse =
  | { id: number; result: DiscoveryFeedResult; error?: never }
  | { id: number; error: string; result?: never };
